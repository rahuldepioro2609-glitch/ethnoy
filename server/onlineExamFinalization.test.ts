import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  type FinalizationClient,
  type FinalizationPool,
  type FinalizeInput,
  type OnlineExamConfig,
  type OnlineExamFinalizedLogEntry,
  ONLINE_EXAM_SQL,
  OnlineExamInvariantError,
  decideFinalization,
  finalizeAttempt,
  isLockTimeout,
  isValidStoredScore,
  readOnlineExamConfig,
  saveAttemptResponses,
  withCompletion,
} from './onlineExamFinalization.js';
import { type OnlineExamQuestionRow, scoreOnlineExam } from './onlineExamScoring.js';

// Compile-time check: the real pg Pool satisfies the minimal interface used by the module.
const acceptsPgPool = (pool: Pool): FinalizationPool => pool;
void acceptsPgPool;

// ---------------------------------------------------------------------------
// Fake connection
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type SqlName = keyof typeof ONLINE_EXAM_SQL;

const SQL_NAMES = new Map<string, SqlName>(
  (Object.entries(ONLINE_EXAM_SQL) as Array<[SqlName, string]>).map(([name, text]) => [text, name]),
);

const ATTEMPT_ID = '8d0f6a2e-6f7d-4a43-9a7e-2a1f3c5b7d90';
const USER_ID = 'user-secret-id-123';
const EXAM_CODE = 'EXAM1';
const EXPIRES_AT = new Date('2026-11-03T10:00:00.000Z');
const DECIDED_AT = '2026-11-03T09:59:58.123456Z';
const CUTOFF = '2026-11-01T00:00:00.000001Z';
const NOW = new Date('2026-11-03T12:00:00Z');

const QUESTIONS: OnlineExamQuestionRow[] = [
  { question_number: 1, correct_option: 'A', points: 1, section: 'Mathematics' },
  { question_number: 2, correct_option: 'B', points: 2, section: 'Physics' },
  { question_number: 3, correct_option: 'C', points: 3, section: 'Mathematics' },
];

const SAVED_ANSWERS = { 1: 'A', 2: 'C' };
const SUBMITTED_ANSWERS = { 1: 'A', 2: 'B', 3: 'C' };

interface FakeOptions {
  attempt?: Row | null;
  clock?: Row | null;
  questions?: Row[];
  updateRowCount?: number;
  failOn?: { sql: SqlName; error: unknown };
  rollbackError?: unknown;
  connectError?: unknown;
}

function baseAttempt(overrides: Row = {}): Row {
  return {
    id: ATTEMPT_ID,
    exam_code: EXAM_CODE,
    expires_at: EXPIRES_AT,
    submitted_at: null,
    responses: { ...SAVED_ANSWERS },
    score: null,
    ...overrides,
  };
}

function clockRow(overrides: Row = {}): Row {
  return {
    decided_at: DECIDED_AT,
    before_expiry: true,
    within_grace: true,
    recovery_excluded: false,
    ...overrides,
  };
}

const NO_PENDING_WRITE = Symbol('no pending write');

function createFake(options: FakeOptions = {}) {
  const calls: Array<{ name: SqlName; text: string; values: unknown[] }> = [];
  const releases: unknown[][] = [];
  let connects = 0;
  // Simulated stored `responses` column: an UPDATE is only applied on COMMIT, and ROLLBACK
  // discards it, so tests can check what would actually remain stored.
  const initialAttempt = options.attempt === undefined ? baseAttempt() : options.attempt;
  let storedResponses: unknown = initialAttempt ? structuredClone(initialAttempt.responses) : undefined;
  let pendingResponses: unknown = NO_PENDING_WRITE;

  const client: FinalizationClient = {
    async query(text, values = []) {
      const name = SQL_NAMES.get(text);
      if (!name) throw new Error(`Unexpected SQL in fake connection: ${text}`);
      calls.push({ name, text, values });
      if (options.failOn?.sql === name) throw options.failOn.error;
      if (name === 'rollback' && options.rollbackError) throw options.rollbackError;
      if (name === 'commit' && pendingResponses !== NO_PENDING_WRITE) storedResponses = pendingResponses;
      if (name === 'commit' || name === 'rollback') pendingResponses = NO_PENDING_WRITE;
      if (name === 'saveResponses' && (options.updateRowCount ?? 1) === 1) pendingResponses = structuredClone(values[1]);
      if (name === 'finalize' && (options.updateRowCount ?? 1) === 1) {
        // COALESCE($3::jsonb, responses): NULL keeps the stored value, an object replaces it.
        pendingResponses = values[2] === null || values[2] === undefined ? storedResponses : structuredClone(values[2]);
      }
      switch (name) {
        case 'begin':
        case 'commit':
        case 'rollback':
          return { rows: [], rowCount: null };
        case 'lockTimeout':
          return { rows: [{ set_config: values[0] }], rowCount: 1 };
        case 'lockOwnedAttempt':
        case 'lockAttemptForRecovery':
          return initialAttempt ? { rows: [initialAttempt], rowCount: 1 } : { rows: [], rowCount: 0 };
        case 'clock': {
          const row = options.clock === undefined ? clockRow() : options.clock;
          return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        case 'questions': {
          const rows = options.questions ?? (QUESTIONS as unknown as Row[]);
          return { rows, rowCount: rows.length };
        }
        case 'finalize': {
          const count = options.updateRowCount ?? 1;
          return count ? { rows: [{ submitted_at: values[1] ?? EXPIRES_AT }], rowCount: count } : { rows: [], rowCount: 0 };
        }
        case 'saveResponses':
          return { rows: [], rowCount: options.updateRowCount ?? 1 };
        default:
          throw new Error(`Unhandled SQL ${name}`);
      }
    },
    release(...args: unknown[]) {
      releases.push(args);
    },
  };

  const pool: FinalizationPool = {
    async connect() {
      connects += 1;
      if (options.connectError) throw options.connectError;
      return client;
    },
  };

  return {
    pool,
    calls,
    releases,
    connects: () => connects,
    storedResponses: () => storedResponses,
    order: () => calls.map((call) => call.name),
    valuesOf: (name: SqlName) => calls.find((call) => call.name === name)?.values,
  };
}

function createLog() {
  const entries: OnlineExamFinalizedLogEntry[] = [];
  return { entries, log: (entry: OnlineExamFinalizedLogEntry) => { entries.push(entry); } };
}

const RECOVERY_OFF: OnlineExamConfig = readOnlineExamConfig({}, NOW);
const RECOVERY_ON: OnlineExamConfig = readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: CUTOFF }, NOW);

function candidateInput(config: OnlineExamConfig, log = createLog().log, overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    mode: 'candidate',
    attemptId: ATTEMPT_ID,
    userId: USER_ID,
    examCode: EXAM_CODE,
    submittedResponses: { ...SUBMITTED_ANSWERS },
    config,
    log,
    ...overrides,
  } as FinalizeInput;
}

function recoveryInput(config: OnlineExamConfig, log = createLog().log): FinalizeInput {
  return { mode: 'recovery', attemptId: ATTEMPT_ID, config, log };
}

/** Exactly one release, with no error (connection returned to the pool). */
function assertReleasedCleanly(fake: ReturnType<typeof createFake>) {
  assert.equal(fake.releases.length, 1, 'connection released exactly once');
  assert.deepEqual(fake.releases[0], [undefined], 'connection returned to the pool, not discarded');
}

function assertNoWrites(fake: ReturnType<typeof createFake>) {
  const order = fake.order();
  assert.equal(order.includes('finalize'), false, 'no finalize UPDATE');
  assert.equal(order.includes('saveResponses'), false, 'no autosave UPDATE');
  assert.equal(order.includes('commit'), false, 'no COMMIT');
  assert.equal(order.at(-1), 'rollback', 'ends with ROLLBACK');
}

const LOG_KEYS = [
  'event', 'mode', 'attemptId', 'examCode', 'reason', 'finalizedBy', 'ignoredResponses', 'savedAnswersMalformed',
];
const SCORE_KEYS = [
  'totalQuestions', 'attempted', 'correct', 'incorrect', 'unattempted',
  'totalScore', 'maxScore', 'percentage', 'sectionScores', 'completion',
];
const COMPLETION_KEYS = ['version', 'reason', 'finalizedBy', 'decidedAt', 'graceSeconds', 'ignoredResponses'];

const LEGACY_STORED_SCORE = {
  totalQuestions: 3, attempted: 2, correct: 1, incorrect: 1, unattempted: 1,
  totalScore: 1, maxScore: 6, percentage: 17,
  sectionScores: {
    Mathematics: { correct: 1, total: 2, score: 1, maxScore: 4 },
    Physics: { correct: 0, total: 1, score: 0, maxScore: 2 },
  },
};
const VALID_STORED_SCORE = {
  ...LEGACY_STORED_SCORE,
  completion: {
    version: 1, reason: 'candidate_submit', finalizedBy: 'candidate',
    decidedAt: DECIDED_AT, graceSeconds: 30, ignoredResponses: 0,
  },
};

/** Reorders keys the way PostgreSQL jsonb returns them: shorter keys first, then bytewise. */
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, inner]) => [key, jsonbOrder(inner)]));
}

const MALFORMED_PAYLOADS: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['string', 'A'],
  ['number', 42],
  ['boolean', true],
  ['array', ['A', 'B']],
  ['array of pairs', [['1', 'A']]],
  ['Date', new Date(0)],
  ['Map', new Map([['1', 'A']])],
  ['class instance', new (class Answers { 1 = 'A'; })()],
];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('config: defaults (30-second grace, recovery off)', () => {
  assert.deepEqual({ ...readOnlineExamConfig({}, NOW) }, {
    submitGraceSeconds: 30,
    recoverySince: null,
    recoveryEnabled: false,
    recoveryIntervalSeconds: 60,
    recoveryBatch: 50,
    lockTimeoutMs: 5000,
  });
  assert.equal(readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: '' }, NOW).recoveryEnabled, false);
  assert.equal(Object.isFrozen(readOnlineExamConfig({}, NOW)), true);
});

test('config: every whole-number setting accepts its bounds and rejects values outside them', () => {
  const settings: Array<[string, keyof OnlineExamConfig, number, number]> = [
    ['ONLINE_EXAM_SUBMIT_GRACE_SECONDS', 'submitGraceSeconds', 0, 120],
    ['ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS', 'recoveryIntervalSeconds', 0, 3600],
    ['ONLINE_EXAM_RECOVERY_BATCH', 'recoveryBatch', 1, 200],
    ['ONLINE_EXAM_LOCK_TIMEOUT_MS', 'lockTimeoutMs', 100, 30000],
  ];
  for (const [name, key, min, max] of settings) {
    assert.equal(readOnlineExamConfig({ [name]: String(min) }, NOW)[key], min, `${name} min`);
    assert.equal(readOnlineExamConfig({ [name]: String(max) }, NOW)[key], max, `${name} max`);
    const invalid = [String(max + 1), '1.5', 'abc', ' 30', '30 ', '-1', '1e2', '0x10', '+5'];
    if (min > 0) invalid.push(String(min - 1));
    for (const value of invalid) {
      assert.throws(
        () => readOnlineExamConfig({ [name]: value }, NOW),
        (error: Error) => error.message.startsWith(`${name} must be a whole number from ${min} to ${max}.`),
        `${name}=${JSON.stringify(value)}`,
      );
    }
  }
});

test('config: error messages never repeat the configured value', () => {
  const secretLooking = '987654321';
  assert.throws(
    () => readOnlineExamConfig({ ONLINE_EXAM_LOCK_TIMEOUT_MS: secretLooking }, NOW),
    (error: Error) => !error.message.includes(secretLooking),
  );
  const badCutoff = '2026-13-45T99:99:99Z';
  assert.throws(
    () => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: badCutoff }, NOW),
    (error: Error) => error.message.startsWith('ONLINE_EXAM_RECOVERY_SINCE') && !error.message.includes(badCutoff),
  );
});

test('config: recovery cutoff must be a valid ISO-8601 time with an explicit offset, kept exactly', () => {
  const accepted = [
    '2026-11-01T00:00Z',
    '2026-11-01T00:00:00Z',
    '2026-11-01T00:00:00.000001Z',
    '2026-11-01T05:30:00+05:30',
    '2026-11-01T00:00:00-08:00',
    '2024-02-29T00:00:00Z',
  ];
  for (const value of accepted) {
    const config = readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: value }, NOW);
    assert.equal(config.recoverySince, value, value);
    assert.equal(config.recoveryEnabled, true, value);
  }
  const rejected = [
    '2026-11-01T00:00:00', // no offset
    '2026-11-01',
    '2026-11-01 00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-11-01T24:00:00Z',
    '2026-11-01T00:60:00Z',
    '2026-11-01T00:00:60Z',
    '2026-11-01T00:00:00.1234567Z',
    '2026-11-01T00:00:00+0530',
    'yesterday',
  ];
  for (const value of rejected) {
    assert.throws(() => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: value }, NOW), /ONLINE_EXAM_RECOVERY_SINCE/, value);
  }
});

test('F3: recovery cutoff offsets are limited to -12:00 … +14:00 (inclusive)', () => {
  const accepted = [
    '2026-11-01T00:00:00-12:00',
    '2026-11-01T00:00:00+14:00',
    '2026-11-01T00:00:00-11:59',
    '2026-11-01T00:00:00+13:59',
    '2026-11-01T00:00:00+00:00',
    '2026-11-01T00:00:00-00:00',
    '2026-11-01T00:00:00+05:45',
    '2026-11-01T00:00:00-09:30',
  ];
  for (const value of accepted) {
    assert.equal(readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: value }, NOW).recoverySince, value, value);
  }
  const rejected = [
    '2026-11-01T00:00:00-12:01',
    '2026-11-01T00:00:00+14:01',
    '2026-11-01T00:00:00-13:00',
    '2026-11-01T00:00:00+15:00',
    '2026-11-01T00:00:00+15:59',
    '2026-11-01T00:00:00+16:00',
    '2026-11-01T00:00:00-23:59',
    '2026-11-01T00:00:00+23:59',
    '2026-11-01T00:00:00+05:60',
    '2026-11-01T00:00:00+5:30',
  ];
  for (const value of rejected) {
    assert.throws(() => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: value }, NOW), /ONLINE_EXAM_RECOVERY_SINCE/, value);
  }
});

test('F4: recovery cutoff year must be 2000 or later; invalid dates and times are rejected', () => {
  for (const value of ['2000-01-01T00:00:00Z', '2000-01-01T00:00:00+14:00', '2000-02-29T00:00:00Z', '2026-11-03T11:59:59.999999Z']) {
    assert.equal(readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: value }, NOW).recoverySince, value, value);
  }
  const rejected = [
    '1999-12-31T23:59:59.999999Z',
    '1999-12-31T23:59:59-12:00',
    '0000-01-01T00:00:00Z',
    '0050-06-01T00:00:00Z',
    '0099-12-31T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-11-01T23:59:60Z',
    '2026-11-01T25:00:00Z',
    '20261-11-01T00:00:00Z',
  ];
  for (const value of rejected) {
    assert.throws(() => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: value }, NOW), /ONLINE_EXAM_RECOVERY_SINCE/, value);
  }
});

test('config: recovery cutoff may be at most 5 minutes in the future', () => {
  const fiveMinutesAhead = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  const justOver = new Date(NOW.getTime() + 5 * 60_000 + 1).toISOString();
  assert.equal(readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: fiveMinutesAhead }, NOW).recoverySince, fiveMinutesAhead);
  assert.throws(
    () => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: justOver }, NOW),
    /must not be more than 5 minutes in the future/,
  );
  // The offset is applied: 12:04+00:00 is fine, 17:36+05:30 (= 12:06Z) is not.
  assert.doesNotThrow(() => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: '2026-11-03T17:34:00+05:30' }, NOW));
  assert.throws(() => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: '2026-11-03T17:36:00+05:30' }, NOW));
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('withCompletion appends completion last and leaves the score untouched', () => {
  const score = scoreOnlineExam(QUESTIONS, { 1: 'A' });
  const before = JSON.stringify(score);
  const completion = {
    version: 1 as const, reason: 'candidate_submit' as const, finalizedBy: 'candidate' as const,
    decidedAt: DECIDED_AT, graceSeconds: 30, ignoredResponses: 0,
  };
  const finalized = withCompletion(score, completion);
  assert.deepEqual(Object.keys(finalized), SCORE_KEYS);
  assert.equal(JSON.stringify(score), before, 'input not mutated');
  assert.equal(JSON.stringify({ ...finalized, completion: undefined }), before, 'scoring fields identical');
});

test('F5: isValidStoredScore accepts complete scores (with or without completion, any key order)', () => {
  assert.equal(isValidStoredScore(VALID_STORED_SCORE), true);
  assert.equal(isValidStoredScore(LEGACY_STORED_SCORE), true);
  assert.equal(isValidStoredScore(jsonbOrder(VALID_STORED_SCORE)), true);
  assert.equal(isValidStoredScore({ ...LEGACY_STORED_SCORE, sectionScores: {} }), true, 'exam with no questions');
  assert.equal(isValidStoredScore(scoreOnlineExam(QUESTIONS, { 1: 'A' })), true, 'fresh score');
  assert.equal(isValidStoredScore(withCompletion(scoreOnlineExam([], {}), {
    version: 1, reason: 'grace_submit', finalizedBy: 'candidate', decidedAt: DECIDED_AT, graceSeconds: 30, ignoredResponses: 0,
  })), true);
});

test('F5: isValidStoredScore rejects empty, partial or malformed scores', () => {
  const invalid: Array<[string, unknown]> = [
    ['null', null], ['array', []], ['string', 'x'], ['empty object', {}],
    ['completion not an object', { ...VALID_STORED_SCORE, completion: 'done' }],
    ['completion null', { ...VALID_STORED_SCORE, completion: null }],
    ['sectionScores missing', { ...LEGACY_STORED_SCORE, sectionScores: undefined }],
    ['sectionScores array', { ...LEGACY_STORED_SCORE, sectionScores: [] }],
    ['section not an object', { ...LEGACY_STORED_SCORE, sectionScores: { S: 3 } }],
    ['section field missing', { ...LEGACY_STORED_SCORE, sectionScores: { S: { correct: 1, total: 1, score: 1 } } }],
    ['section field string', { ...LEGACY_STORED_SCORE, sectionScores: { S: { correct: 1, total: 1, score: '1', maxScore: 1 } } }],
  ];
  for (const field of ['totalQuestions', 'attempted', 'correct', 'incorrect', 'unattempted', 'totalScore', 'maxScore', 'percentage']) {
    const without = { ...LEGACY_STORED_SCORE } as Record<string, unknown>;
    delete without[field];
    invalid.push([`${field} missing`, without]);
    for (const bad of ['5', null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      invalid.push([`${field}=${String(bad)}`, { ...LEGACY_STORED_SCORE, [field]: bad }]);
    }
  }
  for (const [label, value] of invalid) assert.equal(isValidStoredScore(value), false, label);
});

test('isLockTimeout recognises only SQLSTATE 55P03', () => {
  assert.equal(isLockTimeout({ code: '55P03' }), true);
  assert.equal(isLockTimeout(Object.assign(new Error('x'), { code: '55P03' })), true);
  for (const value of [{ code: '40P01' }, { code: '57014' }, new Error('55P03'), null, undefined, '55P03']) {
    assert.equal(isLockTimeout(value), false);
  }
});

test('decision table: candidate mode', () => {
  const cases: Array<[boolean, boolean, boolean, string]> = [
    // beforeExpiry, withinGrace, recoveryExcluded → outcome
    [true, true, false, 'candidate_submit'],
    [true, true, true, 'candidate_submit'],
    [false, true, false, 'grace_submit'], // exactly at expiry up to expires_at + grace (inclusive)
    [false, true, true, 'grace_submit'],
    [false, false, false, 'expired_saved_answers'],
    [false, false, true, 'expired_unscored'],
  ];
  for (const [beforeExpiry, withinGrace, recoveryExcluded, expected] of cases) {
    const decision = decideFinalization('candidate', { beforeExpiry, withinGrace, recoveryExcluded });
    const actual = decision.action === 'score' ? decision.reason : decision.action;
    assert.equal(actual, expected, JSON.stringify({ beforeExpiry, withinGrace, recoveryExcluded }));
  }
  assert.deepEqual(decideFinalization('candidate', { beforeExpiry: false, withinGrace: true, recoveryExcluded: false }), {
    action: 'score', reason: 'grace_submit', source: 'submitted',
  });
  assert.deepEqual(decideFinalization('candidate', { beforeExpiry: false, withinGrace: false, recoveryExcluded: false }), {
    action: 'score', reason: 'expired_saved_answers', source: 'saved',
  });
});

test('decision table: recovery mode', () => {
  const cases: Array<[boolean, boolean, boolean, string]> = [
    [true, true, false, 'not_eligible'],
    [false, true, false, 'not_eligible'],
    [false, true, true, 'not_eligible'],
    [false, false, false, 'expired_saved_answers'],
    [false, false, true, 'expired_unscored'],
  ];
  for (const [beforeExpiry, withinGrace, recoveryExcluded, expected] of cases) {
    const decision = decideFinalization('recovery', { beforeExpiry, withinGrace, recoveryExcluded });
    const actual = decision.action === 'score' ? decision.reason : decision.action;
    assert.equal(actual, expected, JSON.stringify({ beforeExpiry, withinGrace, recoveryExcluded }));
  }
});

test('decision table: unexpected flag values fail safe (no window opened, never auto-scored)', () => {
  for (const odd of [null, undefined, 't', 1, 'true']) {
    assert.equal(decideFinalization('candidate', { beforeExpiry: odd, withinGrace: odd, recoveryExcluded: false }).action, 'score');
    assert.deepEqual(
      decideFinalization('candidate', { beforeExpiry: odd, withinGrace: odd, recoveryExcluded: false }),
      { action: 'score', reason: 'expired_saved_answers', source: 'saved' },
    );
    assert.deepEqual(
      decideFinalization('candidate', { beforeExpiry: false, withinGrace: false, recoveryExcluded: odd }),
      { action: 'expired_unscored' },
    );
    assert.deepEqual(
      decideFinalization('recovery', { beforeExpiry: false, withinGrace: false, recoveryExcluded: odd }),
      { action: 'expired_unscored' },
    );
  }
});

// ---------------------------------------------------------------------------
// SQL shape
// ---------------------------------------------------------------------------

test('SQL: lock statements never read the clock; the clock statement is separate', () => {
  for (const name of ['lockOwnedAttempt', 'lockAttemptForRecovery'] as const) {
    assert.doesNotMatch(ONLINE_EXAM_SQL[name], /clock_timestamp|now\(\)/);
  }
  assert.match(ONLINE_EXAM_SQL.lockOwnedAttempt, /WHERE id = \$1 AND user_id = \$2 AND exam_code = \$3\s+FOR UPDATE$/);
  assert.match(ONLINE_EXAM_SQL.lockAttemptForRecovery, /WHERE id = \$1\s+FOR UPDATE SKIP LOCKED$/);
  assert.match(ONLINE_EXAM_SQL.clock, /^WITH c AS MATERIALIZED \(SELECT clock_timestamp\(\) AS t\)/);
  assert.match(ONLINE_EXAM_SQL.lockTimeout, /set_config\('lock_timeout', \$1, true\)/);
});

test('SQL: exact boundaries — answering before expiry, grace inclusive, recovery eligible at expires_at >= cutoff', () => {
  assert.match(ONLINE_EXAM_SQL.clock, /c\.t < a\.expires_at AS before_expiry/);
  assert.match(ONLINE_EXAM_SQL.clock, /c\.t <= a\.expires_at \+ \(\$2::int \* interval '1 second'\) AS within_grace/);
  // Excluded exactly when expires_at < cutoff (or recovery off), so eligible exactly when expires_at >= cutoff.
  assert.match(ONLINE_EXAM_SQL.clock, /\(\$3::timestamptz IS NULL OR a\.expires_at < \$3::timestamptz\) AS recovery_excluded/);
});

test('SQL: writes are conditional on the attempt still being unsubmitted', () => {
  assert.match(ONLINE_EXAM_SQL.finalize, /WHERE id = \$1 AND submitted_at IS NULL AND score IS NULL\s+RETURNING submitted_at$/);
  assert.match(ONLINE_EXAM_SQL.finalize, /submitted_at = COALESCE\(\$2::timestamptz, expires_at\)/);
  assert.match(ONLINE_EXAM_SQL.finalize, /responses = COALESCE\(\$3::jsonb, responses\)/);
  assert.match(ONLINE_EXAM_SQL.saveResponses, /WHERE id = \$1 AND submitted_at IS NULL$/);
});

// ---------------------------------------------------------------------------
// finalizeAttempt — candidate mode
// ---------------------------------------------------------------------------

test('candidate: normal submit runs lock → clock → score → update → commit, in that order', async () => {
  const fake = createFake();
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, log));

  assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'clock', 'questions', 'finalize', 'commit']);
  assert.deepEqual(fake.valuesOf('lockTimeout'), ['5000ms']);
  assert.deepEqual(fake.valuesOf('lockOwnedAttempt'), [ATTEMPT_ID, USER_ID, EXAM_CODE]);
  assert.deepEqual(fake.valuesOf('clock'), [ATTEMPT_ID, 30, null]);
  assert.deepEqual(fake.valuesOf('questions'), [EXAM_CODE]);

  const expectedScore = withCompletion(scoreOnlineExam(QUESTIONS, SUBMITTED_ANSWERS as never), {
    version: 1, reason: 'candidate_submit', finalizedBy: 'candidate',
    decidedAt: DECIDED_AT, graceSeconds: 30, ignoredResponses: 0,
  });
  const [id, submittedAt, responses, score] = fake.valuesOf('finalize') ?? [];
  assert.equal(id, ATTEMPT_ID);
  assert.equal(submittedAt, DECIDED_AT, 'submitted_at = decision time');
  assert.deepEqual(responses, SUBMITTED_ANSWERS, 'submitted answers stored');
  assert.equal(JSON.stringify(score), JSON.stringify(expectedScore), 'stored score: same values and key order');

  assert.equal(outcome.kind, 'scored');
  if (outcome.kind !== 'scored') return;
  assert.equal(outcome.reason, 'candidate_submit');
  assert.equal(outcome.submittedAt, DECIDED_AT);
  assert.deepEqual(Object.keys(outcome.score), SCORE_KEYS);
  assert.deepEqual(Object.keys(outcome.score.completion), COMPLETION_KEYS);
  assert.equal(outcome.score, score, 'returned score is exactly the stored object');
  assert.equal(outcome.score.totalScore, 6);
  assert.equal(outcome.score.percentage, 100);

  assertReleasedCleanly(fake);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]), LOG_KEYS);
  assert.deepEqual(entries[0], {
    event: 'online_exam.finalized', mode: 'candidate', attemptId: ATTEMPT_ID, examCode: EXAM_CODE,
    reason: 'candidate_submit', finalizedBy: 'candidate', ignoredResponses: 0, savedAnswersMalformed: false,
  });
});

test('candidate: the log line never contains answers, scores or user identifiers', async () => {
  const fake = createFake();
  const { entries, log } = createLog();
  await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, log));
  const text = JSON.stringify(entries);
  assert.equal(text.includes(USER_ID), false);
  for (const forbidden of ['userId', 'user_id', 'responses', 'score', 'totalScore', 'percentage', '"A"', '"B"', '"C"']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('candidate: lock timeout and grace come from settings', async () => {
  const fake = createFake();
  const config = readOnlineExamConfig({ ONLINE_EXAM_LOCK_TIMEOUT_MS: '250', ONLINE_EXAM_SUBMIT_GRACE_SECONDS: '45' }, NOW);
  const outcome = await finalizeAttempt(fake.pool, candidateInput(config));
  assert.deepEqual(fake.valuesOf('lockTimeout'), ['250ms']);
  assert.deepEqual(fake.valuesOf('clock'), [ATTEMPT_ID, 45, null]);
  assert.equal(outcome.kind === 'scored' && outcome.score.completion.graceSeconds, 45);
});

test('candidate: submit inside the grace window scores the submitted (in-memory) answers', async () => {
  const fake = createFake({ clock: clockRow({ before_expiry: false, within_grace: true }) });
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF));
  assert.equal(outcome.kind, 'scored');
  if (outcome.kind !== 'scored') return;
  assert.equal(outcome.reason, 'grace_submit');
  assert.equal(outcome.score.completion.finalizedBy, 'candidate');
  assert.equal(outcome.score.totalScore, 6, 'submitted answers, not the saved ones');
  const [, submittedAt, responses] = fake.valuesOf('finalize') ?? [];
  assert.equal(submittedAt, DECIDED_AT);
  assert.deepEqual(responses, SUBMITTED_ANSWERS);
  assert.deepEqual(fake.order().slice(-2), ['finalize', 'commit']);
  assertReleasedCleanly(fake);
});

test('candidate: submit after grace with recovery on scores the SAVED answers and records expires_at', async () => {
  const fake = createFake({ clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: false }) });
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON, log));
  assert.deepEqual(fake.valuesOf('clock'), [ATTEMPT_ID, 30, CUTOFF], 'cutoff text passed exactly');
  assert.equal(outcome.kind, 'scored');
  if (outcome.kind !== 'scored') return;
  assert.equal(outcome.reason, 'expired_saved_answers');
  assert.equal(outcome.score.completion.finalizedBy, 'system');
  const expected = scoreOnlineExam(QUESTIONS, SAVED_ANSWERS as never);
  assert.equal(outcome.score.totalScore, expected.totalScore, 'saved answers scored; submitted answers ignored');
  assert.equal(outcome.score.attempted, 2);
  const [, submittedAt, responses] = fake.valuesOf('finalize') ?? [];
  assert.equal(submittedAt, null, 'NULL → submitted_at = expires_at');
  assert.equal(responses, null, 'NULL → saved answers kept exactly as stored');
  assert.equal(outcome.submittedAt, EXPIRES_AT);
  assert.equal(entries[0].finalizedBy, 'system');
  assertReleasedCleanly(fake);
});

test('candidate: submit after grace with recovery off is expired_unscored and writes nothing', async () => {
  const fake = createFake({ clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: true }) });
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, log));
  assert.deepEqual(outcome, { kind: 'expired_unscored' });
  assert.deepEqual(fake.valuesOf('clock'), [ATTEMPT_ID, 30, null], 'NULL cutoff means recovery off');
  assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'clock', 'rollback']);
  assertNoWrites(fake);
  assertReleasedCleanly(fake);
  assert.equal(entries.length, 0);
});

test('candidate: attempt that expired before the cutoff is expired_unscored and unchanged', async () => {
  const fake = createFake({ clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: true }) });
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON));
  assert.deepEqual(outcome, { kind: 'expired_unscored' });
  assert.deepEqual(fake.valuesOf('clock'), [ATTEMPT_ID, 30, CUTOFF]);
  assertNoWrites(fake);
  assertReleasedCleanly(fake);
});

test('candidate: unknown attempt (or another user\'s) is missing; no clock read, no write', async () => {
  const fake = createFake({ attempt: null });
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON));
  assert.deepEqual(outcome, { kind: 'missing' });
  assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'rollback']);
  assertReleasedCleanly(fake);
});

test('candidate: already-scored attempt returns the stored score and time unchanged (idempotent)', async () => {
  const storedScore = structuredClone(VALID_STORED_SCORE);
  const storedAt = new Date('2026-11-03T09:58:00Z');
  const fake = createFake({ attempt: baseAttempt({ submitted_at: storedAt, score: storedScore }) });
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON, log));
  assert.deepEqual(outcome, { kind: 'already_scored', score: storedScore, submittedAt: storedAt });
  assert.equal(outcome.kind === 'already_scored' && outcome.score, storedScore, 'exactly the stored object');
  assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'rollback'], 'no clock, no write');
  assertReleasedCleanly(fake);
  assert.equal(entries.length, 0);
});

test('candidate: already-scored legacy score without completion is returned as stored', async () => {
  const legacyScore = structuredClone(LEGACY_STORED_SCORE);
  const fake = createFake({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: legacyScore }) });
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF));
  assert.equal(outcome.kind, 'already_scored');
  assert.equal(outcome.kind === 'already_scored' && outcome.score, legacyScore, 'exactly the stored object');
  assert.deepStrictEqual(outcome.kind === 'already_scored' && outcome.score, LEGACY_STORED_SCORE);
});

test('F8: already-scored score read back in JSONB key order is accepted and compared by value', async () => {
  const reordered = jsonbOrder(VALID_STORED_SCORE) as Record<string, unknown>;
  assert.notDeepEqual(Object.keys(reordered), Object.keys(VALID_STORED_SCORE), 'fixture really is reordered');
  const fake = createFake({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: reordered }) });
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF));
  assert.equal(outcome.kind, 'already_scored');
  if (outcome.kind !== 'already_scored') return;
  assert.deepStrictEqual(outcome.score, VALID_STORED_SCORE, 'same field names and values');
  assert.deepEqual([...Object.keys(outcome.score)].sort(), [...SCORE_KEYS].sort());
});

const INVALID_STORED_SCORES: Array<[string, unknown, 'submitted_without_score' | 'invalid_stored_score']> = [
  ['NULL', null, 'submitted_without_score'],
  ['undefined', undefined, 'submitted_without_score'],
  ['number', 42, 'invalid_stored_score'],
  ['string', 'x', 'invalid_stored_score'],
  ['array', [], 'invalid_stored_score'],
  ['boolean', true, 'invalid_stored_score'],
  ['empty object', {}, 'invalid_stored_score'],
  ['partial score', { totalScore: 4, maxScore: 6 }, 'invalid_stored_score'],
];

test('safeguard: submitted attempt with NULL or invalid stored score raises a safe invariant error and is not modified', async () => {
  for (const mode of ['candidate', 'recovery'] as const) {
    for (const [label, badScore, reason] of INVALID_STORED_SCORES) {
      const fake = createFake({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: badScore }) });
      const { entries, log } = createLog();
      const input = mode === 'candidate' ? candidateInput(RECOVERY_ON, log) : recoveryInput(RECOVERY_ON, log);
      await assert.rejects(
        finalizeAttempt(fake.pool, input),
        (error: unknown) => {
          assert.ok(error instanceof OnlineExamInvariantError);
          assert.equal(error.reason, reason);
          assert.equal(error.code, 'ONLINE_EXAM_INVARIANT');
          assert.equal(error.message.includes(ATTEMPT_ID), false, 'no identifiers in the message');
          assert.equal(error.message.includes(USER_ID), false);
          return true;
        },
        `${mode} ${label}`,
      );
      assert.equal(fake.order().includes('clock'), false);
      assertNoWrites(fake);
      assertReleasedCleanly(fake);
      assert.equal(entries.length, 0);
      assert.deepEqual(fake.storedResponses(), SAVED_ANSWERS, 'stored answers unchanged');
    }
  }
});

test('F7: unsubmitted attempt that already has a score is never overwritten (invariant, rollback)', async () => {
  for (const mode of ['candidate', 'recovery'] as const) {
    for (const presentScore of [structuredClone(VALID_STORED_SCORE), { totalScore: 1 }, {}]) {
      const fake = createFake({
        attempt: baseAttempt({ submitted_at: null, score: presentScore }),
        clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: false }),
      });
      const { entries, log } = createLog();
      const input = mode === 'candidate' ? candidateInput(RECOVERY_ON, log) : recoveryInput(RECOVERY_ON, log);
      await assert.rejects(
        finalizeAttempt(fake.pool, input),
        (error: unknown) => error instanceof OnlineExamInvariantError && error.reason === 'score_without_submission',
        mode,
      );
      assert.equal(fake.order().includes('clock'), false, 'decided before reading the clock');
      assertNoWrites(fake);
      assertReleasedCleanly(fake);
      assert.equal(entries.length, 0);
    }
  }
});

test('candidate: submitted answers are sanitized; ignored entries are counted in completion', async () => {
  const fake = createFake();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, undefined, {
    submittedResponses: { 1: 'A', 99: 'B', 2: 'E', 3: 'C' },
  } as Partial<FinalizeInput>));
  assert.equal(outcome.kind, 'scored');
  if (outcome.kind !== 'scored') return;
  assert.equal(outcome.score.completion.ignoredResponses, 2);
  assert.equal(outcome.score.attempted, 2);
  assert.deepEqual(fake.valuesOf('finalize')?.[2], { 1: 'A', 3: 'C' });
});

test('F2 candidate: malformed submitted payloads are refused before any database access, at any time', async () => {
  for (const [label, payload] of MALFORMED_PAYLOADS) {
    for (const config of [RECOVERY_OFF, RECOVERY_ON]) {
      const fake = createFake();
      const { entries, log } = createLog();
      const outcome = await finalizeAttempt(fake.pool, candidateInput(config, log, {
        submittedResponses: payload,
      } as Partial<FinalizeInput>));
      assert.deepEqual(outcome, { kind: 'invalid_responses', reason: 'malformed' }, label);
      assert.equal(fake.connects(), 0, `${label}: no connection taken`);
      assert.equal(fake.calls.length, 0, `${label}: no SQL, no scoring, no write`);
      assert.equal(entries.length, 0);
      assert.deepEqual(fake.storedResponses(), SAVED_ANSWERS, `${label}: saved answers unchanged`);
    }
  }
});

test('F1 candidate: a non-empty payload whose answers are all dropped is refused (before expiry and in grace)', async () => {
  const windows = [clockRow(), clockRow({ before_expiry: false, within_grace: true })];
  for (const clock of windows) {
    for (const payload of [{ 999: 'A' }, { 1: 'E', 2: 'b' }, { toPostgres: 'A' }]) {
      const fake = createFake({ clock });
      const { entries, log } = createLog();
      const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON, log, {
        submittedResponses: payload,
      } as Partial<FinalizeInput>));
      assert.deepEqual(outcome, { kind: 'invalid_responses', reason: 'no_valid_answers' }, JSON.stringify(payload));
      assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'clock', 'questions', 'rollback']);
      assertReleasedCleanly(fake);
      assert.equal(entries.length, 0);
      assert.deepEqual(fake.storedResponses(), SAVED_ANSWERS, 'saved answers never replaced by {}');
    }
  }
});

test('F1 candidate: after grace the submitted payload is ignored, so saved answers are still scored', async () => {
  const fake = createFake({ clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: false }) });
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON, undefined, {
    submittedResponses: { 999: 'A' },
  } as Partial<FinalizeInput>));
  assert.equal(outcome.kind, 'scored');
  assert.equal(outcome.kind === 'scored' && outcome.reason, 'expired_saved_answers');
  assert.deepEqual(fake.storedResponses(), SAVED_ANSWERS);
});

test('F1 candidate: an intentionally empty {} is valid; it is stored as {} (not NULL) and scores zero', async () => {
  const fake = createFake();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, undefined, {
    submittedResponses: {},
  } as Partial<FinalizeInput>));
  assert.equal(outcome.kind, 'scored');
  if (outcome.kind !== 'scored') return;
  assert.equal(outcome.score.attempted, 0);
  assert.equal(outcome.score.totalScore, 0);
  const stored = fake.valuesOf('finalize')?.[2];
  assert.notEqual(stored, null, '{} is passed as an object, never as NULL');
  assert.deepEqual(stored, {});
  assert.deepEqual(fake.storedResponses(), {}, 'the empty submission replaces the saved answers, as before');
});

test('invalid payloads never overwrite saved responses (every invalid kind, both operations)', async () => {
  const invalidPayloads: unknown[] = [...MALFORMED_PAYLOADS.map(([, payload]) => payload), { 999: 'A' }, { 1: 'Z' }];
  for (const payload of invalidPayloads) {
    const submit = createFake();
    const submitOutcome = await finalizeAttempt(submit.pool, candidateInput(RECOVERY_ON, undefined, {
      submittedResponses: payload,
    } as Partial<FinalizeInput>));
    assert.equal(submitOutcome.kind, 'invalid_responses');
    assert.deepEqual(submit.storedResponses(), SAVED_ANSWERS);
    assert.equal(submit.order().includes('finalize'), false);

    const save = createFake();
    const saveOutcome = await saveAttemptResponses(save.pool, saveInput(RECOVERY_ON, payload));
    assert.equal(saveOutcome.kind, 'invalid_responses');
    assert.deepEqual(save.storedResponses(), SAVED_ANSWERS);
    assert.equal(save.order().includes('saveResponses'), false);
    assert.ok(save.releases.length <= 1 && submit.releases.length <= 1);
  }
});

test('candidate: lock timeout with a failed ROLLBACK returns busy and discards the connection', async () => {
  const rollbackFailure = new Error('connection terminated');
  const fake = createFake({
    failOn: { sql: 'lockOwnedAttempt', error: { code: '55P03' } },
    rollbackError: rollbackFailure,
  });
  assert.deepEqual(await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF)), { kind: 'busy' });
  assert.equal(fake.releases.length, 1);
  assert.deepEqual(fake.releases[0], [rollbackFailure]);
});

test('candidate: malformed or invalid saved answers score as no answers and never throw', async () => {
  const cases: Array<[unknown, number, number, boolean]> = [
    // saved responses, attempted, ignoredResponses, savedAnswersMalformed
    [null, 0, 0, false],
    ['garbage', 0, 0, true],
    [['A', 'B'], 0, 0, true],
    [42, 0, 0, true],
    [{ 1: 'E', 2: 'B', 77: 'A' }, 1, 2, false],
  ];
  for (const [saved, attempted, ignored, malformed] of cases) {
    const fake = createFake({
      attempt: baseAttempt({ responses: saved }),
      clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: false }),
    });
    const { entries, log } = createLog();
    const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON, log));
    assert.equal(outcome.kind, 'scored', JSON.stringify(saved));
    if (outcome.kind !== 'scored') continue;
    assert.equal(outcome.score.attempted, attempted, JSON.stringify(saved));
    assert.equal(outcome.score.completion.ignoredResponses, ignored, JSON.stringify(saved));
    assert.equal(entries[0].savedAnswersMalformed, malformed, JSON.stringify(saved));
    assert.equal(fake.valuesOf('finalize')?.[2], null, 'stored answers left exactly as they were');
  }
});

test('candidate: lock timeout (55P03) returns busy after ROLLBACK; nothing written', async () => {
  const fake = createFake({ failOn: { sql: 'lockOwnedAttempt', error: Object.assign(new Error('lock timeout'), { code: '55P03' }) } });
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_ON, log));
  assert.deepEqual(outcome, { kind: 'busy' });
  assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'rollback']);
  assertReleasedCleanly(fake);
  assert.equal(entries.length, 0);
});

test('candidate: any other error rolls back and is re-thrown', async () => {
  for (const sql of ['questions', 'clock', 'finalize', 'lockTimeout', 'begin'] as const) {
    const failure = new Error(`boom at ${sql}`);
    const fake = createFake({ failOn: { sql, error: failure } });
    const { entries, log } = createLog();
    await assert.rejects(finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, log)), failure);
    assert.equal(fake.order().at(-1), 'rollback', sql);
    assert.equal(fake.order().includes('commit'), false, sql);
    assertReleasedCleanly(fake);
    assert.equal(entries.length, 0, sql);
  }
});

test('candidate: an UPDATE that does not change exactly one row rolls back with an invariant error', async () => {
  for (const updateRowCount of [0, 2]) {
    const fake = createFake({ updateRowCount });
    const { entries, log } = createLog();
    await assert.rejects(
      finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, log)),
      (error: unknown) => error instanceof OnlineExamInvariantError && error.reason === 'unexpected_update_count',
    );
    assert.deepEqual(fake.order().slice(-2), ['finalize', 'rollback']);
    assert.equal(fake.order().includes('commit'), false);
    assertReleasedCleanly(fake);
    assert.equal(entries.length, 0);
  }
});

test('candidate: missing clock row rolls back with an invariant error', async () => {
  const fake = createFake({ clock: null });
  await assert.rejects(
    finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF)),
    (error: unknown) => error instanceof OnlineExamInvariantError && error.reason === 'clock_unavailable',
  );
  assertNoWrites(fake);
  assertReleasedCleanly(fake);
});

test('candidate: failed ROLLBACK discards the connection and re-throws the original error', async () => {
  const failure = new Error('query failed');
  const rollbackFailure = new Error('connection terminated');
  const fake = createFake({ failOn: { sql: 'questions', error: failure }, rollbackError: rollbackFailure });
  await assert.rejects(finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF)), failure);
  assert.equal(fake.releases.length, 1, 'released exactly once');
  assert.deepEqual(fake.releases[0], [rollbackFailure], 'connection discarded');
});

test('candidate: failed ROLLBACK on a no-write exit also discards the connection', async () => {
  const rollbackFailure = new Error('connection terminated');
  const fake = createFake({ attempt: null, rollbackError: rollbackFailure });
  await assert.rejects(finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF)), rollbackFailure);
  assert.equal(fake.releases.length, 1);
  assert.deepEqual(fake.releases[0], [rollbackFailure]);
});

test('candidate: failed COMMIT is re-thrown, rolled back and not logged', async () => {
  const failure = new Error('commit failed');
  const fake = createFake({ failOn: { sql: 'commit', error: failure } });
  const { entries, log } = createLog();
  await assert.rejects(finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, log)), failure);
  assert.deepEqual(fake.order().slice(-2), ['commit', 'rollback']);
  assertReleasedCleanly(fake);
  assert.equal(entries.length, 0);
});

test('candidate: connection failure is re-thrown with no queries and no release', async () => {
  const failure = new Error('timeout exceeded when trying to connect');
  const fake = createFake({ connectError: failure });
  await assert.rejects(finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF)), failure);
  assert.equal(fake.connects(), 1);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.releases.length, 0);
});

test('candidate: a throwing logger does not change a committed outcome', async () => {
  const fake = createFake();
  const outcome = await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF, () => { throw new Error('log down'); }));
  assert.equal(outcome.kind, 'scored');
  assert.equal(fake.order().at(-1), 'commit');
  assertReleasedCleanly(fake);
});

test('candidate: each call uses exactly one connection', async () => {
  const fake = createFake();
  await finalizeAttempt(fake.pool, candidateInput(RECOVERY_OFF));
  assert.equal(fake.connects(), 1);
  assert.equal(fake.order().filter((name) => name === 'begin').length, 1);
});

// ---------------------------------------------------------------------------
// finalizeAttempt — recovery mode (dedicated tests)
// ---------------------------------------------------------------------------

const EXPIRED = clockRow({ before_expiry: false, within_grace: false, recovery_excluded: false });

test('recovery: eligible attempt (expires_at >= cutoff) is scored from saved answers', async () => {
  const fake = createFake({ clock: EXPIRED });
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, recoveryInput(RECOVERY_ON, log));
  assert.deepEqual(fake.order(), ['begin', 'lockAttemptForRecovery', 'clock', 'questions', 'finalize', 'commit']);
  assert.deepEqual(fake.valuesOf('lockAttemptForRecovery'), [ATTEMPT_ID], 'no ownership filter');
  assert.deepEqual(fake.valuesOf('clock'), [ATTEMPT_ID, 30, CUTOFF]);
  assert.equal(fake.order().includes('lockTimeout'), false, 'SKIP LOCKED never waits');
  assert.equal(outcome.kind, 'scored');
  if (outcome.kind !== 'scored') return;
  assert.equal(outcome.reason, 'expired_saved_answers');
  assert.equal(outcome.score.completion.finalizedBy, 'system');
  assert.equal(JSON.stringify(outcome.score), JSON.stringify(withCompletion(scoreOnlineExam(QUESTIONS, SAVED_ANSWERS as never), {
    version: 1, reason: 'expired_saved_answers', finalizedBy: 'system',
    decidedAt: DECIDED_AT, graceSeconds: 30, ignoredResponses: 0,
  })));
  const [, submittedAt, responses] = fake.valuesOf('finalize') ?? [];
  assert.equal(submittedAt, null, 'submitted_at = expires_at');
  assert.equal(responses, null, 'saved answers kept as stored');
  assert.equal(entries[0].mode, 'recovery');
  assert.deepEqual(Object.keys(entries[0]), LOG_KEYS);
  assertReleasedCleanly(fake);
});

test('recovery: attempt that expired before the cutoff (expires_at < cutoff) is excluded and unchanged', async () => {
  const fake = createFake({ clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: true }) });
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, recoveryInput(RECOVERY_ON, log));
  assert.deepEqual(outcome, { kind: 'expired_unscored' });
  assert.deepEqual(fake.order(), ['begin', 'lockAttemptForRecovery', 'clock', 'rollback']);
  assertNoWrites(fake);
  assertReleasedCleanly(fake);
  assert.equal(entries.length, 0);
});

test('recovery: recovery off (NULL cutoff) is never auto-scored', async () => {
  const fake = createFake({ clock: clockRow({ before_expiry: false, within_grace: false, recovery_excluded: true }) });
  const outcome = await finalizeAttempt(fake.pool, recoveryInput(RECOVERY_OFF));
  assert.deepEqual(fake.valuesOf('clock'), [ATTEMPT_ID, 30, null]);
  assert.deepEqual(outcome, { kind: 'expired_unscored' });
  assertNoWrites(fake);
});

test('recovery: row locked elsewhere (SKIP LOCKED returns nothing) is skipped untouched, still eligible later', async () => {
  const fake = createFake({ attempt: null });
  const { entries, log } = createLog();
  const outcome = await finalizeAttempt(fake.pool, recoveryInput(RECOVERY_ON, log));
  assert.deepEqual(outcome, { kind: 'skipped' });
  assert.deepEqual(fake.order(), ['begin', 'lockAttemptForRecovery', 'rollback'], 'no clock read, no write of any kind');
  assertReleasedCleanly(fake);
  assert.equal(entries.length, 0);

  // A later sweep, once the lock is free, sees the same unsubmitted row and scores it.
  const later = createFake({ clock: EXPIRED });
  const laterOutcome = await finalizeAttempt(later.pool, recoveryInput(RECOVERY_ON));
  assert.equal(laterOutcome.kind, 'scored');
});

test('recovery: still before expiry or inside grace is not_eligible and unchanged', async () => {
  for (const clock of [clockRow(), clockRow({ before_expiry: false, within_grace: true })]) {
    const fake = createFake({ clock });
    const outcome = await finalizeAttempt(fake.pool, recoveryInput(RECOVERY_ON));
    assert.deepEqual(outcome, { kind: 'not_eligible' });
    assertNoWrites(fake);
    assertReleasedCleanly(fake);
  }
});

test('recovery: already-scored attempt is returned as stored without a clock read or write', async () => {
  const storedScore = structuredClone(LEGACY_STORED_SCORE);
  const fake = createFake({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: storedScore }) });
  const outcome = await finalizeAttempt(fake.pool, recoveryInput(RECOVERY_ON));
  assert.deepEqual(outcome, { kind: 'already_scored', score: storedScore, submittedAt: EXPIRES_AT });
  assert.deepEqual(fake.order(), ['begin', 'lockAttemptForRecovery', 'rollback']);
  assertReleasedCleanly(fake);
});

test('recovery: an error on one attempt rolls back only that attempt', async () => {
  const failure = new Error('scoring query failed');
  const fake = createFake({ clock: EXPIRED, failOn: { sql: 'finalize', error: failure } });
  await assert.rejects(finalizeAttempt(fake.pool, recoveryInput(RECOVERY_ON)), failure);
  assert.equal(fake.order().at(-1), 'rollback');
  assert.equal(fake.order().includes('commit'), false);
  assertReleasedCleanly(fake);
});

// ---------------------------------------------------------------------------
// saveAttemptResponses (autosave strictly before expiry)
// ---------------------------------------------------------------------------

// Uses the argument count (not a default parameter) so an explicit `undefined` payload is passed through.
function saveInput(config: OnlineExamConfig, ...payload: unknown[]) {
  const responses = payload.length > 0 ? payload[0] : { 1: 'A', 2: 'B' };
  return { attemptId: ATTEMPT_ID, userId: USER_ID, examCode: EXAM_CODE, responses, config };
}

test('autosave: before expiry writes the sanitized answers and returns the server time', async () => {
  const fake = createFake();
  const outcome = await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF, { 1: 'A', 99: 'B', 2: 'E', 3: 'C' }));
  assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'clock', 'questions', 'saveResponses', 'commit']);
  assert.deepEqual(fake.valuesOf('lockOwnedAttempt'), [ATTEMPT_ID, USER_ID, EXAM_CODE]);
  assert.deepEqual(fake.valuesOf('saveResponses'), [ATTEMPT_ID, { 1: 'A', 3: 'C' }]);
  assert.deepEqual(outcome, { kind: 'saved', savedAt: DECIDED_AT, ignoredResponses: 2 });
  assertReleasedCleanly(fake);
});

test('autosave: at or after expiry (even inside grace) is answering_closed and writes nothing', async () => {
  for (const clock of [
    clockRow({ before_expiry: false, within_grace: true }),
    clockRow({ before_expiry: false, within_grace: false }),
    clockRow({ before_expiry: null }),
  ]) {
    const fake = createFake({ clock });
    const outcome = await saveAttemptResponses(fake.pool, saveInput(RECOVERY_ON));
    assert.deepEqual(outcome, { kind: 'answering_closed' });
    assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'clock', 'rollback']);
    assertReleasedCleanly(fake);
  }
});

test('autosave: a finalized attempt is never overwritten', async () => {
  const fake = createFake({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: structuredClone(VALID_STORED_SCORE) }) });
  const outcome = await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF));
  assert.deepEqual(outcome, { kind: 'finalized' });
  assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'rollback']);
  assertReleasedCleanly(fake);
});

test('autosave: unknown or other user\'s attempt is missing', async () => {
  const fake = createFake({ attempt: null });
  assert.deepEqual(await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF)), { kind: 'missing' });
  assertNoWrites(fake);
  assertReleasedCleanly(fake);
});

test('autosave: lock timeout returns busy after ROLLBACK', async () => {
  const fake = createFake({ failOn: { sql: 'lockOwnedAttempt', error: { code: '55P03' } } });
  assert.deepEqual(await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF)), { kind: 'busy' });
  assertNoWrites(fake);
  assertReleasedCleanly(fake);
});

test('autosave: an UPDATE that does not change exactly one row rolls back with an invariant error', async () => {
  const fake = createFake({ updateRowCount: 0 });
  await assert.rejects(
    saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF)),
    (error: unknown) => error instanceof OnlineExamInvariantError && error.reason === 'unexpected_update_count',
  );
  assert.deepEqual(fake.order().slice(-2), ['saveResponses', 'rollback']);
  assertReleasedCleanly(fake);
});

test('F2 autosave: malformed payloads are refused before any database access', async () => {
  for (const [label, payload] of MALFORMED_PAYLOADS) {
    const fake = createFake();
    const outcome = await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF, payload));
    assert.deepEqual(outcome, { kind: 'invalid_responses', reason: 'malformed' }, label);
    assert.equal(fake.connects(), 0, `${label}: no connection taken`);
    assert.equal(fake.calls.length, 0, `${label}: no SQL`);
    assert.deepEqual(fake.storedResponses(), SAVED_ANSWERS, `${label}: saved answers unchanged`);
  }
});

test('F1 autosave: a non-empty payload whose answers are all dropped is refused; saved answers kept', async () => {
  for (const payload of [{ 999: 'A' }, { 1: 'E', 2: 'b' }, { toPostgres: 'A', x: 'B' }, { 1: null, 2: ['A'] }]) {
    const fake = createFake();
    const outcome = await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF, payload));
    assert.deepEqual(outcome, { kind: 'invalid_responses', reason: 'no_valid_answers' }, JSON.stringify(payload));
    assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'clock', 'questions', 'rollback']);
    assertReleasedCleanly(fake);
    assert.deepEqual(fake.storedResponses(), SAVED_ANSWERS);
  }
});

test('F1 autosave: an intentionally empty {} is valid and saved', async () => {
  const fake = createFake();
  const outcome = await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF, {}));
  assert.deepEqual(outcome, { kind: 'saved', savedAt: DECIDED_AT, ignoredResponses: 0 });
  assert.deepEqual(fake.valuesOf('saveResponses'), [ATTEMPT_ID, {}]);
  assert.equal(fake.order().at(-1), 'commit');
  assert.deepEqual(fake.storedResponses(), {});
  assertReleasedCleanly(fake);
});

test('F1 autosave: a valid partial payload still saves its valid answers', async () => {
  const fake = createFake();
  const outcome = await saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF, { 1: 'B', 999: 'A' }));
  assert.deepEqual(outcome, { kind: 'saved', savedAt: DECIDED_AT, ignoredResponses: 1 });
  assert.deepEqual(fake.storedResponses(), { 1: 'B' });
});

test('F6 autosave: submitted attempt with NULL or invalid score raises an invariant error, not finalized', async () => {
  for (const [label, badScore, reason] of INVALID_STORED_SCORES) {
    const fake = createFake({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: badScore }) });
    await assert.rejects(
      saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF)),
      (error: unknown) => error instanceof OnlineExamInvariantError && error.reason === reason,
      label,
    );
    assert.deepEqual(fake.order(), ['begin', 'lockTimeout', 'lockOwnedAttempt', 'rollback'], label);
    assertReleasedCleanly(fake);
    assert.deepEqual(fake.storedResponses(), SAVED_ANSWERS);
  }
});

test('F7 autosave: unsubmitted attempt with a stored score raises an invariant error and writes nothing', async () => {
  const fake = createFake({ attempt: baseAttempt({ score: structuredClone(VALID_STORED_SCORE) }) });
  await assert.rejects(
    saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF)),
    (error: unknown) => error instanceof OnlineExamInvariantError && error.reason === 'score_without_submission',
  );
  assertNoWrites(fake);
  assertReleasedCleanly(fake);
});

test('autosave: failed ROLLBACK discards the connection', async () => {
  const failure = new Error('query failed');
  const rollbackFailure = new Error('connection terminated');
  const fake = createFake({ failOn: { sql: 'clock', error: failure }, rollbackError: rollbackFailure });
  await assert.rejects(saveAttemptResponses(fake.pool, saveInput(RECOVERY_OFF)), failure);
  assert.equal(fake.releases.length, 1);
  assert.deepEqual(fake.releases[0], [rollbackFailure]);
});
