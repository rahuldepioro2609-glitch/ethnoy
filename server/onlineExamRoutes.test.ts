// Route tests for the online-exam autosave and submit routes (P0-4 Phase 3), plus
// regression checks for the list and start routes. No real database is used: the shared
// pool's `query` and `connect` are replaced with scripted fakes and restored after each test.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { expectedOrigin, type Surface } from './surface.js';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:5432/test';
// Recovery enabled for this test process, so the "scored from saved answers" path is reachable.
// Each test file runs in its own process, so this does not affect other suites.
const RECOVERY_SINCE = '2026-01-01T00:00:00Z';
process.env.ONLINE_EXAM_RECOVERY_SINCE = RECOVERY_SINCE;
delete process.env.ONLINE_EXAM_SUBMIT_GRACE_SECONDS;
delete process.env.ONLINE_EXAM_LOCK_TIMEOUT_MS;

const [{ app }, { pool }, { hashSessionToken, setTrustedRequestSurface }, { ONLINE_EXAM_SQL }, { ONLINE_EXAM_RECOVERY_SQL }] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
  import('./onlineExamFinalization.js'),
  import('./onlineExamRecovery.js'),
]);

// ---------------------------------------------------------------------------
// Route invocation (same approach as instituteApproval.test.ts)
// ---------------------------------------------------------------------------

type Method = 'get' | 'post' | 'patch';

interface ExpressRouteLayer {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler; name?: string }>;
  };
}

function findRoute(method: Method, path: string) {
  const router = (app as unknown as { _router: { stack: ExpressRouteLayer[] } })._router;
  const route = router.stack
    .map((layer) => layer.route)
    .find((entry) => entry?.methods[method] && (Array.isArray(entry.path) ? entry.path : [entry.path]).includes(path));
  assert.ok(route, `Expected ${method.toUpperCase()} ${path} to be registered`);
  return route;
}

interface RouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

// P1-B: these route-stack tests bypass the app-level surface enforcement, so each fake request
// carries the server-controlled surface that its account's role belongs to (candidate → Exam,
// center → Institution, official → Admin), set through the same trusted setter the gate uses.
function trustSurface(request: object, surface: Surface): void {
  setTrustedRequestSurface(request, surface, expectedOrigin(surface));
}

function invokeRoute(
  method: Method,
  path: string,
  options: { token?: string; params?: Record<string, string>; body?: unknown } = {},
): Promise<RouteResult> {
  const handlers = findRoute(method, path).stack.map((layer) => layer.handle);
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    const headers: Record<string, string> = {};
    const request = {
      method: method.toUpperCase(),
      headers: options.token ? { cookie: `elt_session=${options.token}` } : {},
      params: options.params ?? {},
      body: options.body,
      get: () => undefined,
    } as unknown as Request;
    trustSurface(request, options.token === officialToken ? 'admin' : options.token === centerToken ? 'institution' : 'exam');
    const response = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      set(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return this;
      },
      json(responseBody: Record<string, unknown>) {
        settled = true;
        resolve({ status, body: JSON.parse(JSON.stringify(responseBody)), headers });
        return this;
      },
      clearCookie() {
        return this;
      },
    } as unknown as Response;

    const next: NextFunction = (error?: unknown) => {
      if (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }
      const handler = handlers[handlerIndex++];
      if (!handler) return;
      try {
        const result = (handler as unknown as (req: Request, res: Response, nxt: NextFunction) => unknown)(request, response, next);
        if (result instanceof Promise) void result.catch(next);
      } catch (handlerError) {
        next(handlerError);
      }
    };
    next();
  });
}

const SUBMIT = '/api/online-exams/:examCode/submit';
const AUTOSAVE = '/api/online-exams/:examCode/attempt';

// ---------------------------------------------------------------------------
// Synthetic database
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type SqlName = keyof typeof ONLINE_EXAM_SQL;
const SQL_NAMES = new Map<string, SqlName>(
  (Object.entries(ONLINE_EXAM_SQL) as Array<[SqlName, string]>).map(([name, text]) => [text, name]),
);

const CANDIDATE_ID = 'synthetic-candidate';
const OTHER_CANDIDATE_ID = 'synthetic-other-candidate';
const candidateToken = 'C'.repeat(43);
const otherCandidateToken = 'Q'.repeat(43);
const officialToken = 'O'.repeat(43);
const centerToken = 'I'.repeat(43);
const pendingCandidateToken = 'P'.repeat(43);
const unknownToken = 'U'.repeat(43);

const SESSIONS = new Map<string, Row>([
  [hashSessionToken(candidateToken), { id: CANDIDATE_ID, login_id: 'CAND-1', display_name: 'Candidate', role: 'candidate', account_status: 'approved', is_super_admin: false }],
  [hashSessionToken(otherCandidateToken), { id: OTHER_CANDIDATE_ID, login_id: 'CAND-2', display_name: 'Other', role: 'candidate', account_status: 'approved', is_super_admin: false }],
  [hashSessionToken(officialToken), { id: 'synthetic-official', login_id: 'OFF-1', display_name: 'Official', role: 'official', account_status: 'approved', is_super_admin: true }],
  [hashSessionToken(centerToken), { id: 'synthetic-center', login_id: 'CTR-1', display_name: 'Center', role: 'center', account_status: 'approved', is_super_admin: false }],
  [hashSessionToken(pendingCandidateToken), { id: 'synthetic-pending', login_id: 'CAND-3', display_name: 'Pending', role: 'candidate', account_status: 'pending', is_super_admin: false }],
]);

const ATTEMPT_ID = '8d0f6a2e-6f7d-4a43-9a7e-2a1f3c5b7d90';
const EXAM_CODE = 'EXAM1';
const EXPIRES_AT = new Date('2026-11-03T10:00:00.000Z');
const DECIDED_AT = '2026-11-03T09:59:58.123456Z';
const QUESTIONS: Row[] = [
  { question_number: 1, correct_option: 'A', points: 1, section: 'Mathematics' },
  { question_number: 2, correct_option: 'B', points: 2, section: 'Physics' },
  { question_number: 3, correct_option: 'C', points: 3, section: 'Mathematics' },
];
const SAVED_ANSWERS = { 1: 'A', 2: 'C' };
const SUBMITTED_ANSWERS = { 1: 'A', 2: 'B', 3: 'C' };
const STORED_SCORE = {
  totalQuestions: 3, attempted: 2, correct: 1, incorrect: 1, unattempted: 1,
  totalScore: 1, maxScore: 6, percentage: 17,
  sectionScores: {
    Mathematics: { correct: 1, total: 2, score: 1, maxScore: 4 },
    Physics: { correct: 0, total: 1, score: 0, maxScore: 2 },
  },
};

function baseAttempt(overrides: Row = {}): Row {
  return {
    id: ATTEMPT_ID,
    user_id: CANDIDATE_ID,
    exam_code: EXAM_CODE,
    expires_at: EXPIRES_AT,
    submitted_at: null,
    responses: structuredClone(SAVED_ANSWERS),
    score: null,
    ...overrides,
  };
}

interface Scenario {
  attempt?: Row | null;
  clock?: Row;
  failOn?: { sql: SqlName; error: unknown };
  connectError?: unknown;
  /** Extra pool.query handler for the list and start routes. */
  poolQuery?: (text: string, values: unknown[]) => { rows: Row[]; rowCount?: number } | undefined;
}

function installDatabase(scenario: Scenario = {}) {
  const poolWithMock = pool as unknown as {
    query: (text: string, values?: unknown[]) => Promise<unknown>;
    connect: () => Promise<unknown>;
  };
  const originalQuery = poolWithMock.query;
  const originalConnect = poolWithMock.connect;
  const attempt = scenario.attempt === undefined ? baseAttempt() : scenario.attempt;
  const calls: Array<{ name: SqlName; values: unknown[] }> = [];
  const releases: unknown[][] = [];
  const poolQueries: Array<{ text: string; values: unknown[] }> = [];
  let connects = 0;
  let pending: Row | null = null;

  poolWithMock.query = async (text: string, values: unknown[] = []) => {
    if (text.includes('FROM auth_sessions s')) {
      const session = SESSIONS.get(String(values[0]));
      return { rows: session ? [session] : [] };
    }
    poolQueries.push({ text, values });
    const scripted = scenario.poolQuery?.(text, values);
    if (scripted) return { rowCount: scripted.rows.length, ...scripted };
    throw new Error(`Unexpected pool query in synthetic test: ${text.slice(0, 60)}`);
  };

  poolWithMock.connect = async () => {
    connects += 1;
    if (scenario.connectError) throw scenario.connectError;
    return {
      async query(text: string, values: unknown[] = []) {
        const name = SQL_NAMES.get(text);
        if (!name) throw new Error(`Unexpected SQL in synthetic connection: ${text.slice(0, 60)}`);
        calls.push({ name, values });
        if (scenario.failOn?.sql === name) throw scenario.failOn.error;
        switch (name) {
          case 'begin':
            pending = null;
            return { rows: [], rowCount: null };
          case 'commit':
            if (pending && attempt) Object.assign(attempt, pending);
            pending = null;
            return { rows: [], rowCount: null };
          case 'rollback':
            pending = null;
            return { rows: [], rowCount: null };
          case 'lockTimeout':
            return { rows: [{ set_config: values[0] }], rowCount: 1 };
          case 'lockOwnedAttempt': {
            const owned = attempt && attempt.id === values[0] && attempt.user_id === values[1] && attempt.exam_code === values[2];
            return owned ? { rows: [{ ...attempt }], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          case 'clock':
            return {
              rows: [{ decided_at: DECIDED_AT, before_expiry: true, within_grace: true, recovery_excluded: false, ...scenario.clock }],
              rowCount: 1,
            };
          case 'questions':
            return { rows: QUESTIONS, rowCount: QUESTIONS.length };
          case 'finalize': {
            if (!attempt || attempt.submitted_at !== null || attempt.score !== null) return { rows: [], rowCount: 0 };
            const submittedAt = values[1] ?? attempt.expires_at;
            pending = {
              submitted_at: submittedAt,
              responses: values[2] === null ? attempt.responses : structuredClone(values[2]),
              score: JSON.parse(JSON.stringify(values[3])),
            };
            return { rows: [{ submitted_at: submittedAt }], rowCount: 1 };
          }
          case 'saveResponses':
            if (!attempt || attempt.submitted_at !== null) return { rows: [], rowCount: 0 };
            pending = { responses: structuredClone(values[1]) };
            return { rows: [], rowCount: 1 };
          default:
            throw new Error(`Unhandled SQL ${name}`);
        }
      },
      release(...args: unknown[]) {
        releases.push(args);
      },
    };
  };

  return {
    attempt,
    calls,
    releases,
    poolQueries,
    connects: () => connects,
    order: () => calls.map((call) => call.name),
    valuesOf: (name: SqlName) => calls.find((call) => call.name === name)?.values,
    restore() {
      poolWithMock.query = originalQuery;
      poolWithMock.connect = originalConnect;
    },
  };
}

type Database = ReturnType<typeof installDatabase>;

/** Captures console output so tests can check that logs never contain sensitive data. */
function captureConsole() {
  const lines: string[] = [];
  const originals = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const level of ['info', 'warn', 'error', 'log'] as const) {
    console[level] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
    };
  }
  return {
    lines,
    restore() {
      Object.assign(console, originals);
    },
  };
}

async function withDatabase(scenario: Scenario, run: (db: Database, logs: string[]) => Promise<void>) {
  const db = installDatabase(scenario);
  const logs = captureConsole();
  try {
    await run(db, logs.lines);
  } finally {
    logs.restore();
    db.restore();
  }
}

function submit(token: string | undefined, body: unknown, examCode = 'exam1') {
  return invokeRoute('post', SUBMIT, { token, params: { examCode }, body });
}

function autosave(token: string | undefined, body: unknown, examCode = 'exam1') {
  return invokeRoute('patch', AUTOSAVE, { token, params: { examCode }, body });
}

const validBody = (responses: unknown = SUBMITTED_ANSWERS) => ({ attemptId: ATTEMPT_ID, responses });

/** Every connection taken was released exactly once, and returned to the pool (not discarded). */
function assertReleasedOnce(db: Database) {
  assert.equal(db.releases.length, db.connects(), 'one release per connection');
  for (const args of db.releases) assert.deepEqual(args, [undefined], 'returned to the pool');
}

/** Logs must never contain answers, score contents, user identifiers, tokens or error details. */
function assertSafeLogs(lines: string[]) {
  const text = lines.join('\n');
  for (const forbidden of [CANDIDATE_ID, candidateToken, hashSessionToken(candidateToken), '"responses"', '"score"', 'totalScore', 'sectionScores', 'Failing row', 'SECRET-DETAIL']) {
    assert.equal(text.includes(forbidden), false, `log must not contain ${forbidden}`);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

test('routes: submit and autosave keep requireAuth → requireRoles(candidate) → handler', () => {
  for (const [method, path] of [['post', SUBMIT], ['patch', AUTOSAVE]] as const) {
    const names = findRoute(method, path).stack.map((layer) => layer.handle.name);
    assert.equal(names.length, 3, `${path} middleware count`);
    assert.equal(names[0], 'requireAuth', path);
  }
});

// ---------------------------------------------------------------------------
// Authentication and authorization (both routes)
// ---------------------------------------------------------------------------

test('auth: no session → 401, and the database is never touched', async () => {
  await withDatabase({}, async (db) => {
    for (const call of [submit, autosave]) {
      const result = await call(undefined, validBody());
      assert.equal(result.status, 401);
    }
    assert.equal(db.connects(), 0);
  });
});

test('auth: unknown or expired session → 401', async () => {
  await withDatabase({}, async (db) => {
    for (const call of [submit, autosave]) assert.equal((await call(unknownToken, validBody())).status, 401);
    assert.equal(db.connects(), 0);
  });
});

test('auth: account not approved → 403', async () => {
  await withDatabase({}, async (db) => {
    for (const call of [submit, autosave]) assert.equal((await call(pendingCandidateToken, validBody())).status, 403);
    assert.equal(db.connects(), 0);
  });
});

test('roles: official and institution users are refused with 403', async () => {
  await withDatabase({}, async (db) => {
    for (const token of [officialToken, centerToken]) {
      for (const call of [submit, autosave]) {
        const result = await call(token, validBody());
        assert.equal(result.status, 403);
        assert.equal(result.body.error, 'You do not have permission to perform this action.');
      }
    }
    assert.equal(db.connects(), 0);
  });
});

// ---------------------------------------------------------------------------
// Validation, identity and normalization
// ---------------------------------------------------------------------------

const INVALID_BODIES: Array<[string, unknown]> = [
  ['no body', undefined],
  ['null body', null],
  ['array body', [ATTEMPT_ID]],
  ['missing attemptId', { responses: {} }],
  ['non-uuid attemptId', { attemptId: 'attempt-1', responses: {} }],
  ['missing responses', { attemptId: ATTEMPT_ID }],
  ['responses null', { attemptId: ATTEMPT_ID, responses: null }],
  ['responses array', { attemptId: ATTEMPT_ID, responses: ['A'] }],
  ['responses string', { attemptId: ATTEMPT_ID, responses: 'A' }],
  ['lowercase option', { attemptId: ATTEMPT_ID, responses: { 1: 'a' } }],
  ['option E', { attemptId: ATTEMPT_ID, responses: { 1: 'E' } }],
  ['nested option', { attemptId: ATTEMPT_ID, responses: { 1: { option: 'A' } } }],
];

test('validation: malformed bodies → 400 before any database access; saved answers unchanged', async () => {
  await withDatabase({}, async (db) => {
    for (const [label, body] of INVALID_BODIES) {
      for (const call of [submit, autosave]) {
        const result = await call(candidateToken, body);
        assert.equal(result.status, 400, label);
        assert.equal(result.body.error, 'Invalid request.', label);
        assert.ok(Array.isArray(result.body.details), label);
      }
    }
    assert.equal(db.connects(), 0, 'no connection, no lock, no write');
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
  });
});

test('identity: userId comes from the session and examCode from the URL, upper-cased; body extras ignored', async () => {
  await withDatabase({}, async (db) => {
    const body = { ...validBody(), userId: OTHER_CANDIDATE_ID, user_id: OTHER_CANDIDATE_ID, examCode: 'OTHER' };
    const result = await submit(candidateToken, body, 'exam1');
    assert.equal(result.status, 200);
    assert.deepEqual(db.valuesOf('lockOwnedAttempt'), [ATTEMPT_ID, CANDIDATE_ID, 'EXAM1']);
  });
  await withDatabase({}, async (db) => {
    const body = { ...validBody({ 1: 'B' }), userId: OTHER_CANDIDATE_ID, examCode: 'OTHER' };
    const result = await autosave(candidateToken, body, 'Exam1');
    assert.equal(result.status, 200);
    assert.deepEqual(db.valuesOf('lockOwnedAttempt'), [ATTEMPT_ID, CANDIDATE_ID, 'EXAM1']);
  });
});

test('identity: another candidate\'s attempt id → 404 and nothing is changed', async () => {
  await withDatabase({}, async (db) => {
    for (const call of [submit, autosave]) {
      const result = await call(otherCandidateToken, validBody());
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'This exam attempt was not found.', code: 'attempt_not_found' });
    }
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
    assert.equal(db.attempt?.submitted_at, null);
    assert.equal(db.connects(), 2);
    assertReleasedOnce(db);
  });
});

test('settings: lock timeout and grace defaults, and the recovery cutoff, reach the module', async () => {
  await withDatabase({}, async (db) => {
    await submit(candidateToken, validBody());
    assert.deepEqual(db.valuesOf('lockTimeout'), ['5000ms']);
    assert.deepEqual(db.valuesOf('clock'), [ATTEMPT_ID, 30, RECOVERY_SINCE]);
  });
});

// ---------------------------------------------------------------------------
// Submit outcomes
// ---------------------------------------------------------------------------

test('submit: on time → 200 { submittedAt, score, alreadyScored: false } after COMMIT', async () => {
  await withDatabase({}, async (db, logs) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ['submittedAt', 'score', 'alreadyScored']);
    assert.equal(result.body.submittedAt, DECIDED_AT);
    assert.equal(result.body.alreadyScored, false);
    const score = result.body.score as Record<string, unknown>;
    for (const field of ['totalQuestions', 'attempted', 'correct', 'incorrect', 'unattempted', 'totalScore', 'maxScore', 'percentage', 'sectionScores']) {
      assert.ok(field in score, field);
    }
    assert.equal(score.totalScore, 6);
    assert.equal(score.percentage, 100);
    assert.equal((score.completion as Record<string, unknown>).reason, 'candidate_submit');
    assert.equal(db.order().at(-1), 'commit');
    assert.deepEqual(db.attempt?.responses, SUBMITTED_ANSWERS);
    assertReleasedOnce(db);
    assertSafeLogs(logs);
    assert.ok(logs.some((line) => line.includes('"event":"online_exam.finalized"')), 'finalized log written');
  });
});

test('submit: inside the grace window → 200 with grace_submit, submitted answers scored', async () => {
  await withDatabase({ clock: { before_expiry: false, within_grace: true } }, async (db) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 200);
    const score = result.body.score as Record<string, unknown>;
    assert.equal((score.completion as Record<string, unknown>).reason, 'grace_submit');
    assert.equal(score.totalScore, 6);
    assert.deepEqual(db.attempt?.responses, SUBMITTED_ANSWERS);
  });
});

test('submit: after grace (recovery eligible) → 200 scored from SAVED answers; submitted answers ignored', async () => {
  await withDatabase({ clock: { before_expiry: false, within_grace: false, recovery_excluded: false } }, async (db) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 200);
    assert.equal(new Date(String(result.body.submittedAt)).toISOString(), EXPIRES_AT.toISOString());
    const score = result.body.score as Record<string, unknown>;
    assert.equal((score.completion as Record<string, unknown>).reason, 'expired_saved_answers');
    assert.equal(score.attempted, 2);
    assert.equal(score.totalScore, 1);
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS, 'saved answers kept exactly');
  });
});

test('submit: after grace and excluded from recovery → 409 expired_unscored; nothing written', async () => {
  await withDatabase({ clock: { before_expiry: false, within_grace: false, recovery_excluded: true } }, async (db) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'expired_unscored');
    assert.equal(typeof result.body.error, 'string');
    assert.equal(db.order().includes('finalize'), false);
    assert.equal(db.attempt?.submitted_at, null);
    assertReleasedOnce(db);
  });
});

test('submit: repeat submission is idempotent — same stored score, alreadyScored: true, no second write', async () => {
  await withDatabase({}, async (db) => {
    const first = await submit(candidateToken, validBody());
    assert.equal(first.status, 200);
    const second = await submit(candidateToken, validBody({ 1: 'D', 2: 'D', 3: 'D' }));
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyScored, true);
    assert.deepEqual(second.body.score, first.body.score, 'same score by value');
    assert.equal(second.body.submittedAt, first.body.submittedAt);
    assert.equal(db.order().filter((name) => name === 'finalize').length, 1, 'scored exactly once');
    assert.deepEqual(db.attempt?.responses, SUBMITTED_ANSWERS, 'later answers ignored');
  });
});

test('submit: already scored before this request → 200 with the stored score unchanged', async () => {
  await withDatabase({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: structuredClone(STORED_SCORE) }) }, async (db) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 200);
    assert.equal(result.body.alreadyScored, true);
    assert.deepEqual(result.body.score, STORED_SCORE);
    assert.equal(db.order().includes('finalize'), false);
  });
});

test('submit: non-empty answers that all belong to no question → 400 invalid_responses; saved answers kept', async () => {
  await withDatabase({}, async (db) => {
    const result = await submit(candidateToken, validBody({ 99: 'A', 100: 'B' }));
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: 'None of the submitted answers belong to this exam. Your saved answers were not changed.',
      code: 'invalid_responses',
      reason: 'no_valid_answers',
    });
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
    assert.equal(db.attempt?.submitted_at, null);
    assertReleasedOnce(db);
  });
});

test('submit: intentionally empty {} is valid, scores zero and replaces saved answers', async () => {
  await withDatabase({}, async (db) => {
    const result = await submit(candidateToken, validBody({}));
    assert.equal(result.status, 200);
    assert.equal((result.body.score as Record<string, unknown>).attempted, 0);
    assert.deepEqual(db.attempt?.responses, {});
  });
});

test('submit: lock timeout → 503 busy with Retry-After; nothing written; never reported as submitted', async () => {
  const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  await withDatabase({ failOn: { sql: 'lockOwnedAttempt', error: lockTimeout } }, async (db, logs) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      error: 'The exam service is busy. Your request was not applied. Please try again in a moment.',
      code: 'busy',
      retryable: true,
    });
    assert.equal(result.headers['retry-after'], '1');
    assert.equal(db.attempt?.submitted_at, null);
    assertReleasedOnce(db);
    assertSafeLogs(logs);
  });
});

test('submit: connection pool exhausted → 503 busy; no query issued', async () => {
  await withDatabase({ connectError: new Error('timeout exceeded when trying to connect') }, async (db, logs) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'busy');
    assert.equal(db.calls.length, 0);
    assert.ok(logs.some((line) => line.includes('"cause":"pool_timeout"')));
  });
});

test('submit: inconsistent stored record (submitted without score) → 500 generic; nothing changed', async () => {
  await withDatabase({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: null }) }, async (db, logs) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'An unexpected server error occurred.' });
    assert.equal(db.order().at(-1), 'rollback');
    assertReleasedOnce(db);
    assertSafeLogs(logs);
    assert.ok(logs.some((line) => line.includes('"invariant":"submitted_without_score"')));
  });
});

test('submit: unexpected database error → 500 generic; error detail and answers never logged or returned', async () => {
  const dbError = Object.assign(new Error('SECRET-DETAIL failure'), {
    code: '23514',
    detail: 'Failing row contains ({"1":"A","2":"B"}) SECRET-DETAIL',
  });
  await withDatabase({ failOn: { sql: 'finalize', error: dbError } }, async (db, logs) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'An unexpected server error occurred.' });
    assert.equal(db.attempt?.submitted_at, null, 'nothing committed');
    assert.equal(db.order().at(-1), 'rollback');
    assertReleasedOnce(db);
    assertSafeLogs(logs);
    assert.ok(logs.some((line) => line.includes('"sqlState":"23514"')));
  });
});

test('submit: database unreachable → 500 generic (not reported as busy)', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  await withDatabase({ connectError: refused }, async (_db, logs) => {
    const result = await submit(candidateToken, validBody());
    assert.equal(result.status, 500);
    assertSafeLogs(logs);
  });
});

// ---------------------------------------------------------------------------
// Autosave outcomes
// ---------------------------------------------------------------------------

test('autosave: before expiry → 200 { saved: true, savedAt } and the answers are stored', async () => {
  await withDatabase({}, async (db, logs) => {
    const result = await autosave(candidateToken, validBody({ 1: 'B', 3: 'C' }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { saved: true, savedAt: DECIDED_AT });
    assert.deepEqual(db.attempt?.responses, { 1: 'B', 3: 'C' });
    assertReleasedOnce(db);
    assertSafeLogs(logs);
  });
});

test('autosave: at or after expiry (even inside grace) → 409 answering_closed; nothing written', async () => {
  await withDatabase({ clock: { before_expiry: false, within_grace: true } }, async (db) => {
    const result = await autosave(candidateToken, validBody({ 1: 'B' }));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'answering_closed');
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
  });
});

test('autosave: already submitted → 409 finalized; never overwritten', async () => {
  await withDatabase({ attempt: baseAttempt({ submitted_at: EXPIRES_AT, score: structuredClone(STORED_SCORE) }) }, async (db) => {
    const result = await autosave(candidateToken, validBody({ 1: 'B' }));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'finalized');
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
  });
});

test('autosave: unknown attempt → 404', async () => {
  await withDatabase({ attempt: null }, async () => {
    const result = await autosave(candidateToken, validBody({ 1: 'B' }));
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'attempt_not_found');
  });
});

test('autosave: non-empty answers that all belong to no question → 400; saved answers kept', async () => {
  await withDatabase({}, async (db) => {
    const result = await autosave(candidateToken, validBody({ 99: 'A' }));
    assert.equal(result.status, 400);
    assert.equal(result.body.reason, 'no_valid_answers');
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
  });
});

test('autosave: intentionally empty {} is valid and replaces saved answers', async () => {
  await withDatabase({}, async (db) => {
    const result = await autosave(candidateToken, validBody({}));
    assert.equal(result.status, 200);
    assert.deepEqual(db.attempt?.responses, {});
  });
});

test('autosave: lock timeout → 503 busy; pool exhausted → 503 busy', async () => {
  await withDatabase({ failOn: { sql: 'lockOwnedAttempt', error: { code: '55P03' } } }, async (db) => {
    const result = await autosave(candidateToken, validBody({ 1: 'B' }));
    assert.equal(result.status, 503);
    assert.equal(result.headers['retry-after'], '1');
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
  });
  await withDatabase({ connectError: new Error('timeout exceeded when trying to connect') }, async () => {
    assert.equal((await autosave(candidateToken, validBody({ 1: 'B' }))).status, 503);
  });
});

test('autosave: inconsistent record (score on an unsubmitted attempt) → 500 generic; nothing written', async () => {
  await withDatabase({ attempt: baseAttempt({ score: structuredClone(STORED_SCORE) }) }, async (db, logs) => {
    const result = await autosave(candidateToken, validBody({ 1: 'B' }));
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'An unexpected server error occurred.' });
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
    assertSafeLogs(logs);
    assert.ok(logs.some((line) => line.includes('"invariant":"score_without_submission"')));
  });
});

test('malformed payloads can never overwrite saved answers (both routes, every malformed kind)', async () => {
  await withDatabase({}, async (db) => {
    for (const [, body] of INVALID_BODIES) {
      await submit(candidateToken, body);
      await autosave(candidateToken, body);
    }
    await submit(candidateToken, validBody({ 99: 'A' }));
    await autosave(candidateToken, validBody({ 99: 'A' }));
    assert.deepEqual(db.attempt?.responses, SAVED_ANSWERS);
    assert.equal(db.attempt?.submitted_at, null);
    assert.equal(db.order().includes('finalize'), false);
    assert.equal(db.order().includes('saveResponses'), false);
  });
});

// ---------------------------------------------------------------------------
// Regression: list and start routes are unchanged
// ---------------------------------------------------------------------------

// P0-4 Phase 4: the attempt query now also returns a database-clock `state`. The exams query,
// the five original attempt fields and the response shape are unchanged.
function listQueries(attemptRows: Row[]) {
  return (text: string) => {
    if (text.includes('FROM online_exam_questions q')) {
      return {
        rows: [
          { exam_code: EXAM_CODE, exam_name: 'Exam One', duration_minutes: 60, question_count: 3 },
          { exam_code: 'EXAM2', exam_name: 'Exam Two', duration_minutes: 60, question_count: 3 },
          { exam_code: 'EXAM3', exam_name: 'Exam Three', duration_minutes: 60, question_count: 3 },
          { exam_code: 'EXAM4', exam_name: 'Exam Four', duration_minutes: 60, question_count: 3 },
        ],
      };
    }
    if (text === ONLINE_EXAM_RECOVERY_SQL.attemptStates) return { rows: attemptRows };
    return undefined;
  };
}

test('list: lists published exams with the candidate\'s attempt; original fields kept, state added', async () => {
  const attemptRow = { exam_code: EXAM_CODE, started_at: EXPIRES_AT, expires_at: EXPIRES_AT, submitted_at: null, score: null, state: 'in_progress' };
  await withDatabase({ poolQuery: listQueries([attemptRow]) }, async (db) => {
    const result = await invokeRoute('get', '/api/online-exams', { token: candidateToken });
    assert.equal(result.status, 200);
    const exams = result.body.exams as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(exams[0]), ['exam_code', 'exam_name', 'duration_minutes', 'question_count', 'attempt']);
    assert.deepEqual(exams[0].attempt, JSON.parse(JSON.stringify(attemptRow)));
    assert.equal(exams[1].attempt, null, 'exam without an attempt still has attempt: null');
    // Session user id, grace seconds and the recovery cutoff from settings; read-only queries, no transaction.
    assert.deepEqual(db.poolQueries.map((entry) => entry.values), [[CANDIDATE_ID], [CANDIDATE_ID, 30, RECOVERY_SINCE]]);
    assert.equal(db.connects(), 0);
  });
});

test('list: pending recovery, historical expired-unscored and already-scored attempts are reported honestly', async () => {
  const pending = { exam_code: EXAM_CODE, started_at: EXPIRES_AT, expires_at: EXPIRES_AT, submitted_at: null, score: null, state: 'expired_pending_scoring' };
  const historical = { exam_code: 'EXAM2', started_at: EXPIRES_AT, expires_at: new Date('2025-06-01T00:00:00Z'), submitted_at: null, score: null, state: 'expired_unscored' };
  const scored = { exam_code: 'EXAM3', started_at: EXPIRES_AT, expires_at: EXPIRES_AT, submitted_at: EXPIRES_AT, score: STORED_SCORE, state: 'scored' };
  const finalWindow = { exam_code: 'EXAM4', started_at: EXPIRES_AT, expires_at: EXPIRES_AT, submitted_at: null, score: null, state: 'final_submit_window' };
  await withDatabase({ poolQuery: listQueries([pending, historical, scored, finalWindow]) }, async () => {
    const result = await invokeRoute('get', '/api/online-exams', { token: candidateToken });
    const byCode = new Map((result.body.exams as Array<Record<string, Record<string, unknown>>>).map((exam) => [exam.exam_code as unknown as string, exam.attempt]));
    // Pending recovery is never shown as scored: no submitted_at, no score.
    assert.deepEqual([byCode.get(EXAM_CODE)?.state, byCode.get(EXAM_CODE)?.submitted_at, byCode.get(EXAM_CODE)?.score], ['expired_pending_scoring', null, null]);
    assert.deepEqual([byCode.get('EXAM2')?.state, byCode.get('EXAM2')?.score], ['expired_unscored', null]);
    assert.equal(byCode.get('EXAM3')?.state, 'scored');
    assert.deepEqual(byCode.get('EXAM3')?.score, STORED_SCORE, 'existing score returned unchanged');
    assert.equal(byCode.get('EXAM4')?.state, 'final_submit_window');
  });
});

test('list: reading the list never finalizes, locks or writes anything', async () => {
  const pending = { exam_code: EXAM_CODE, started_at: EXPIRES_AT, expires_at: EXPIRES_AT, submitted_at: null, score: null, state: 'expired_pending_scoring' };
  await withDatabase({ poolQuery: listQueries([pending]) }, async (db) => {
    await invokeRoute('get', '/api/online-exams', { token: candidateToken });
    assert.equal(db.connects(), 0);
    assert.equal(db.poolQueries.some((entry) => /UPDATE|INSERT|DELETE|FOR UPDATE/.test(entry.text)), false);
  });
});

const PUBLISHED_QUESTION_ROWS = [
  { question_number: 1, section: 'Mathematics', question_text: 'Q1', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, points: 1, duration_minutes: 60 },
];

function startQueries(existingAttempt: Row | null) {
  return (text: string) => {
    if (text.includes('FROM applications')) return { rows: [{ '?column?': 1 }] };
    if (text.includes('GROUP BY question_number')) return { rows: PUBLISHED_QUESTION_ROWS };
    if (text.includes('FROM online_exam_attempts WHERE user_id = $1 AND exam_code = $2')) {
      return { rows: existingAttempt ? [existingAttempt] : [] };
    }
    if (text.includes('INSERT INTO online_exam_attempts')) {
      return { rows: [{ id: 'new-attempt', started_at: EXPIRES_AT, expires_at: EXPIRES_AT }] };
    }
    return undefined;
  };
}

test('regression: POST start still creates a new attempt (201) and resumes an active one (200)', async () => {
  await withDatabase({ poolQuery: startQueries(null) }, async (db) => {
    const result = await invokeRoute('post', '/api/online-exams/:examCode/start', { token: candidateToken, params: { examCode: 'exam1' } });
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.responses, {});
    assert.equal((result.body.questions as unknown[]).length, 1);
    assert.ok(db.poolQueries.some((entry) => entry.text.includes('INSERT INTO online_exam_attempts')));
  });
  const future = new Date(Date.now() + 30 * 60_000);
  const active = { id: ATTEMPT_ID, started_at: EXPIRES_AT, expires_at: future, submitted_at: null, responses: SAVED_ANSWERS };
  await withDatabase({ poolQuery: startQueries(active) }, async () => {
    const result = await invokeRoute('post', '/api/online-exams/:examCode/start', { token: candidateToken, params: { examCode: 'exam1' } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.responses, SAVED_ANSWERS);
  });
});

test('regression: POST start still refuses a submitted attempt with 409', async () => {
  const submitted = { id: ATTEMPT_ID, started_at: EXPIRES_AT, expires_at: EXPIRES_AT, submitted_at: EXPIRES_AT, responses: SAVED_ANSWERS };
  await withDatabase({ poolQuery: startQueries(submitted) }, async () => {
    const result = await invokeRoute('post', '/api/online-exams/:examCode/start', { token: candidateToken, params: { examCode: 'exam1' } });
    assert.equal(result.status, 409);
  });
});
