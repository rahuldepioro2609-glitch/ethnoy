// Tests for automatic recovery (P0-4 Phase 4). No database is used: an in-memory simulator
// implements the statements the sweep and finalizeAttempt send, including row locks with
// SKIP LOCKED, COMMIT/ROLLBACK, and the selection and decision predicates (mirrored from the
// SQL text, which is asserted separately). Real PostgreSQL behaviour is validated in Phase 7.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type FinalizationClient,
  type FinalizationPool,
  ONLINE_EXAM_SQL,
  type OnlineExamConfig,
  type OnlineExamFinalizedLogEntry,
  readOnlineExamConfig,
} from './onlineExamFinalization.js';
import { EventEmitter } from 'node:events';
import {
  attemptStateParams,
  createGracefulShutdown,
  ONLINE_EXAM_RECOVERY_SQL,
  type OnlineExamRecoveryHandle,
  type RecoveryLogEntry,
  type ShutdownLogEntry,
  startOnlineExamRecovery,
  startOnlineExamRecoveryWhenListening,
  sweepExpiredAttempts,
} from './onlineExamRecovery.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-03T12:00:00.000Z');
const CUTOFF = '2026-11-01T00:00:00.000Z';
const CUTOFF_MS = Date.parse(CUTOFF);
const GRACE_MS = 30_000;

const QUESTIONS = [
  { question_number: 1, correct_option: 'A', points: 1, section: 'Mathematics' },
  { question_number: 2, correct_option: 'B', points: 2, section: 'Physics' },
];
const SAVED = { 1: 'A', 2: 'C' };
const STORED_SCORE = {
  totalQuestions: 2, attempted: 2, correct: 2, incorrect: 0, unattempted: 0,
  totalScore: 3, maxScore: 3, percentage: 100,
  sectionScores: { Mathematics: { correct: 1, total: 1, score: 1, maxScore: 1 }, Physics: { correct: 1, total: 1, score: 2, maxScore: 2 } },
};

function config(env: Record<string, string> = {}): OnlineExamConfig {
  return readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: CUTOFF, ...env }, NOW);
}
const RECOVERY_ON = config();
const RECOVERY_OFF = readOnlineExamConfig({}, NOW);

interface SimAttempt {
  id: string;
  user_id: string;
  exam_code: string;
  expires_at: Date;
  submitted_at: Date | string | null;
  responses: unknown;
  score: unknown;
}

let idCounter = 0;
function attempt(expiresAt: Date | number, overrides: Partial<SimAttempt> = {}): SimAttempt {
  idCounter += 1;
  return {
    id: `attempt-${String(idCounter).padStart(3, '0')}`,
    user_id: `user-secret-${idCounter}`,
    exam_code: 'EXAM1',
    expires_at: expiresAt instanceof Date ? expiresAt : new Date(expiresAt),
    submitted_at: null,
    responses: structuredClone(SAVED),
    score: null,
    ...overrides,
  };
}

/** Expired well past grace and after the cutoff: eligible. */
const eligibleAt = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

// ---------------------------------------------------------------------------
// In-memory database simulator
// ---------------------------------------------------------------------------

type SqlName = keyof typeof ONLINE_EXAM_SQL | keyof typeof ONLINE_EXAM_RECOVERY_SQL;
const SQL_NAMES = new Map<string, SqlName>([
  ...(Object.entries(ONLINE_EXAM_SQL) as Array<[SqlName, string]>).map(([n, t]) => [t, n] as [string, SqlName]),
  ...(Object.entries(ONLINE_EXAM_RECOVERY_SQL) as Array<[SqlName, string]>).map(([n, t]) => [t, n] as [string, SqlName]),
]);

interface SimOptions {
  now?: Date;
  /** Ids locked by "another transaction" (a candidate request or another process). */
  externallyLocked?: Set<string>;
  /** Throw a database error at this statement for these attempt ids (transient by default). */
  failFinalizeFor?: Map<string, number>;
  failCommitFor?: Set<string>;
  selectionError?: unknown;
  connectError?: unknown;
  /** Simulates a database that ignores LIMIT, to prove the in-code batch cap. */
  ignoreLimit?: boolean;
  /** Resolves before the selection query returns, to hold a sweep "in flight". */
  selectionGate?: Promise<void>;
}

function createSimulator(attempts: SimAttempt[], options: SimOptions = {}) {
  const now = options.now ?? NOW;
  const rows = new Map(attempts.map((row) => [row.id, row]));
  const locks = new Set<string>(options.externallyLocked ?? []);
  const stats = { connects: 0, releases: [] as unknown[][], finalizeWrites: new Map<string, number>(), selections: [] as unknown[][] };

  function makeClient(): FinalizationClient {
    let locked: string | null = null;
    let pending: Partial<SimAttempt> | null = null;
    const unlock = () => {
      if (locked) locks.delete(locked);
      locked = null;
      pending = null;
    };
    return {
      async query(text: string, values: unknown[] = []) {
        await Promise.resolve(); // yield, so concurrent sweeps interleave
        const name = SQL_NAMES.get(text);
        if (!name) throw new Error(`Unexpected SQL: ${text.slice(0, 50)}`);
        switch (name) {
          case 'selectCandidates': {
            stats.selections.push(values);
            if (options.selectionGate) await options.selectionGate;
            if (options.selectionError) throw options.selectionError;
            const [since, grace, limit] = values as [string, number, number];
            const sinceMs = Date.parse(since);
            const found = [...rows.values()]
              .filter((row) => row.submitted_at === null && row.score === null)
              .filter((row) => row.expires_at.getTime() >= sinceMs)
              .filter((row) => row.expires_at.getTime() + grace * 1000 < now.getTime())
              .sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime() || (a.id < b.id ? -1 : 1));
            return { rows: (options.ignoreLimit ? found : found.slice(0, limit)).map((row) => ({ id: row.id })), rowCount: found.length };
          }
          case 'begin':
            return { rows: [], rowCount: null };
          case 'lockAttemptForRecovery': {
            const id = String(values[0]);
            const row = rows.get(id);
            if (!row || locks.has(id)) return { rows: [], rowCount: 0 }; // SKIP LOCKED
            locks.add(id);
            locked = id;
            return { rows: [{ ...row }], rowCount: 1 };
          }
          case 'clock': {
            const row = rows.get(String(values[0]));
            if (!row) return { rows: [], rowCount: 0 };
            const grace = Number(values[1]);
            const since = values[2] as string | null;
            const expires = row.expires_at.getTime();
            return {
              rows: [{
                decided_at: now.toISOString(),
                before_expiry: now.getTime() < expires,
                within_grace: now.getTime() <= expires + grace * 1000,
                recovery_excluded: since === null || expires < Date.parse(since),
              }],
              rowCount: 1,
            };
          }
          case 'questions':
            return { rows: QUESTIONS, rowCount: QUESTIONS.length };
          case 'finalize': {
            const id = String(values[0]);
            const remaining = options.failFinalizeFor?.get(id) ?? 0;
            if (remaining > 0) {
              options.failFinalizeFor?.set(id, remaining - 1);
              throw Object.assign(new Error('SECRET-DETAIL write failed'), {
                code: '40001',
                detail: 'Failing row contains ({"1":"A"}) SECRET-DETAIL',
              });
            }
            const row = rows.get(id);
            if (!row || row.submitted_at !== null || row.score !== null) return { rows: [], rowCount: 0 };
            const submittedAt = values[1] ?? row.expires_at;
            pending = {
              submitted_at: submittedAt as Date | string,
              responses: values[2] === null ? row.responses : structuredClone(values[2]),
              score: JSON.parse(JSON.stringify(values[3])),
            };
            return { rows: [{ submitted_at: submittedAt }], rowCount: 1 };
          }
          case 'commit': {
            if (locked && options.failCommitFor?.has(locked)) {
              throw Object.assign(new Error('SECRET-DETAIL commit failed'), { code: '08006' });
            }
            if (locked && pending) {
              Object.assign(rows.get(locked) as SimAttempt, pending);
              stats.finalizeWrites.set(locked, (stats.finalizeWrites.get(locked) ?? 0) + 1);
            }
            unlock();
            return { rows: [], rowCount: null };
          }
          case 'rollback':
            unlock();
            return { rows: [], rowCount: null };
          default:
            throw new Error(`Statement not expected in recovery: ${name}`);
        }
      },
      release(...args: unknown[]) {
        stats.releases.push(args);
      },
    };
  }

  const pool: FinalizationPool = {
    async connect() {
      stats.connects += 1;
      if (options.connectError) throw options.connectError;
      return makeClient();
    },
  };
  return { pool, rows, locks, stats };
}

function createLogs() {
  const recovery: RecoveryLogEntry[] = [];
  const finalized: OnlineExamFinalizedLogEntry[] = [];
  return {
    recovery,
    finalized,
    log: (entry: RecoveryLogEntry) => { recovery.push(entry); },
    finalizeLog: (entry: OnlineExamFinalizedLogEntry) => { finalized.push(entry); },
  };
}

function assertSafeLogs(logs: ReturnType<typeof createLogs>) {
  const text = JSON.stringify([...logs.recovery, ...logs.finalized]);
  for (const forbidden of ['user-secret', 'SECRET-DETAIL', 'Failing row', '"responses"', '"score"', 'totalScore', 'sectionScores', '"A"', '"C"']) {
    assert.equal(text.includes(forbidden), false, `logs must not contain ${forbidden}`);
  }
}

function assertConnectionsReleased(sim: ReturnType<typeof createSimulator>) {
  assert.equal(sim.stats.releases.length, sim.stats.connects, 'every connection released exactly once');
  assert.equal(sim.locks.size, 0, 'no lock left held');
}

// ---------------------------------------------------------------------------
// SQL shape
// ---------------------------------------------------------------------------

test('SQL: candidate selection is lock-free, bounded and mirrors the finalize eligibility rules', () => {
  const sql = ONLINE_EXAM_RECOVERY_SQL.selectCandidates;
  assert.doesNotMatch(sql, /FOR UPDATE/);
  assert.match(sql, /submitted_at IS NULL/);
  assert.match(sql, /score IS NULL/);
  assert.match(sql, /expires_at >= \$1::timestamptz/, 'exact cutoff is eligible');
  assert.match(sql, /expires_at \+ \(\$2::int \* interval '1 second'\) < clock_timestamp\(\)/, 'strictly past grace');
  assert.match(sql, /ORDER BY expires_at, id\s+LIMIT \$3::int$/);
  // The finalize rule it mirrors (accepted Phase 2): excluded when expires_at < cutoff; within grace when now <= expires + grace.
  assert.match(ONLINE_EXAM_SQL.clock, /a\.expires_at < \$3::timestamptz\) AS recovery_excluded/);
  assert.match(ONLINE_EXAM_SQL.clock, /c\.t <= a\.expires_at \+ \(\$2::int \* interval '1 second'\) AS within_grace/);
  assert.match(ONLINE_EXAM_SQL.lockAttemptForRecovery, /FOR UPDATE SKIP LOCKED$/);
});

test('SQL: attempt list keeps the five original columns and adds a database-clock state', () => {
  const sql = ONLINE_EXAM_RECOVERY_SQL.attemptStates;
  assert.match(sql, /SELECT a\.exam_code, a\.started_at, a\.expires_at, a\.submitted_at, a\.score,/);
  assert.match(sql, /WITH c AS MATERIALIZED \(SELECT clock_timestamp\(\) AS t\)/);
  const order = ['scored', 'in_progress', 'final_submit_window', 'expired_pending_scoring', 'expired_unscored'];
  const positions = order.map((state) => sql.indexOf(`'${state}'`));
  assert.ok(positions.every((position, index) => position > 0 && (index === 0 || position > positions[index - 1])), 'CASE order');
  assert.match(sql, /WHEN a\.submitted_at IS NOT NULL THEN 'scored'/);
  assert.match(sql, /WHEN a\.score IS NULL AND \$3::timestamptz IS NOT NULL AND a\.expires_at >= \$3::timestamptz\s+THEN 'expired_pending_scoring'/);
  assert.match(sql, /WHERE a\.user_id = \$1$/);
  assert.deepEqual(attemptStateParams('user-1', RECOVERY_ON), ['user-1', 30, CUTOFF]);
  assert.deepEqual(attemptStateParams('user-1', RECOVERY_OFF), ['user-1', 30, null], 'recovery off → never pending');
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

test('sweep: recovery disabled (cutoff unset) does no database work at all', async () => {
  const sim = createSimulator([attempt(eligibleAt(10))]);
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_OFF);
  assert.equal(result.selected, 0);
  assert.equal(sim.stats.connects, 0);
});

test('sweep: eligible expired attempts are scored from saved answers, submitted_at = expires_at', async () => {
  const rows = [attempt(eligibleAt(10)), attempt(eligibleAt(5))];
  const sim = createSimulator(rows);
  const logs = createLogs();
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON, { log: logs.log, finalizeLog: logs.finalizeLog, trigger: 'interval' });
  assert.deepEqual({ ...result }, { selected: 2, scored: 2, alreadyScored: 0, skipped: 0, notEligible: 0, expiredUnscored: 0, failed: 0, stoppedEarly: false });
  for (const row of rows) {
    const stored = sim.rows.get(row.id) as SimAttempt;
    assert.equal(stored.submitted_at, row.expires_at, 'submitted_at = expires_at');
    assert.deepEqual(stored.responses, SAVED, 'saved answers kept exactly');
    const score = stored.score as Record<string, unknown>;
    assert.equal(score.totalScore, 1, 'only saved answers scored (1 correct of 2)');
    assert.equal((score.completion as Record<string, unknown>).reason, 'expired_saved_answers');
    assert.equal((score.completion as Record<string, unknown>).finalizedBy, 'system');
  }
  assert.deepEqual(sim.stats.selections[0], [CUTOFF, 30, 50]);
  assert.equal(logs.finalized.length, 2);
  assert.ok(logs.finalized.every((entry) => entry.mode === 'recovery'));
  const summary = logs.recovery.find((entry) => entry.event === 'online_exam.recovery_sweep');
  assert.ok(summary && summary.event === 'online_exam.recovery_sweep' && summary.scored === 2 && summary.trigger === 'interval');
  assertConnectionsReleased(sim);
  assertSafeLogs(logs);
});

test('sweep: attempts that expired before the cutoff stay untouched (not selected, excluded under lock)', async () => {
  const historical = attempt(CUTOFF_MS - 60_000);
  const sim = createSimulator([historical]);
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.equal(result.selected, 0);
  assert.equal(sim.rows.get(historical.id)?.submitted_at, null);
  assert.equal(sim.rows.get(historical.id)?.score, null);
  assert.deepEqual(sim.rows.get(historical.id)?.responses, SAVED);
});

test('sweep: exact cutoff boundary — expires_at == cutoff is recovered; 1 ms earlier is not', async () => {
  const atCutoff = attempt(CUTOFF_MS);
  const justBefore = attempt(CUTOFF_MS - 1);
  const sim = createSimulator([atCutoff, justBefore]);
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.equal(result.scored, 1);
  assert.notEqual(sim.rows.get(atCutoff.id)?.submitted_at, null, 'boundary is eligible');
  assert.equal(sim.rows.get(justBefore.id)?.submitted_at, null, 'before cutoff stays unscored');
});

test('sweep: grace boundary — not selected until strictly after expires_at + 30 s', async () => {
  const inProgress = attempt(NOW.getTime() + 60_000);
  const inGrace = attempt(NOW.getTime() - 10_000);
  const atGraceEnd = attempt(NOW.getTime() - GRACE_MS);
  const justPast = attempt(NOW.getTime() - GRACE_MS - 1);
  const sim = createSimulator([inProgress, inGrace, atGraceEnd, justPast]);
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.equal(result.selected, 1);
  assert.equal(result.scored, 1);
  assert.notEqual(sim.rows.get(justPast.id)?.submitted_at, null);
  for (const row of [inProgress, inGrace, atGraceEnd]) assert.equal(sim.rows.get(row.id)?.submitted_at, null, row.id);
});

test('sweep: already-scored attempts are never selected or changed', async () => {
  const scored = attempt(eligibleAt(10), { submitted_at: eligibleAt(10), score: structuredClone(STORED_SCORE) });
  const sim = createSimulator([scored]);
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.equal(result.selected, 0);
  assert.deepEqual(sim.rows.get(scored.id)?.score, STORED_SCORE);
});

test('sweep: an attempt scored between selection and lock is re-checked under the lock (already_scored, no write)', async () => {
  const row = attempt(eligibleAt(10));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sim = createSimulator([row], { selectionGate: gate });
  const sweep = sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  await Promise.resolve();
  // Selection is in flight; a candidate submit commits a score meanwhile.
  await new Promise((resolve) => setImmediate(resolve));
  Object.assign(sim.rows.get(row.id) as SimAttempt, { submitted_at: row.expires_at, score: structuredClone(STORED_SCORE) });
  release();
  const result = await sweep;
  assert.equal(result.selected, 0, 'the simulator selects after the gate, so it already sees the score');
  // Force the race explicitly: selection returned the id, then the score appears before the lock.
  const raced = attempt(eligibleAt(10));
  const sim2 = createSimulator([raced]);
  const originalConnect = sim2.pool.connect.bind(sim2.pool);
  let connectCount = 0;
  sim2.pool.connect = async () => {
    connectCount += 1;
    if (connectCount === 2) Object.assign(sim2.rows.get(raced.id) as SimAttempt, { submitted_at: raced.expires_at, score: structuredClone(STORED_SCORE) });
    return originalConnect();
  };
  const racedResult = await sweepExpiredAttempts(sim2.pool, RECOVERY_ON);
  assert.equal(racedResult.selected, 1);
  assert.equal(racedResult.alreadyScored, 1);
  assert.equal(sim2.stats.finalizeWrites.size, 0, 'no write');
  assert.deepEqual(sim2.rows.get(raced.id)?.score, STORED_SCORE);
});

test('sweep: batch limit bounds the work per sweep; later sweeps continue oldest-first', async () => {
  const rows = Array.from({ length: 7 }, (_, index) => attempt(eligibleAt(100 - index)));
  const sim = createSimulator(rows);
  const small = config({ ONLINE_EXAM_RECOVERY_BATCH: '3' });
  const first = await sweepExpiredAttempts(sim.pool, small);
  assert.equal(first.selected, 3);
  assert.equal(first.scored, 3);
  assert.deepEqual(sim.stats.selections[0], [CUTOFF, 30, 3], 'LIMIT parameter = batch');
  assert.deepEqual(rows.slice(0, 3).map((row) => sim.rows.get(row.id)?.submitted_at !== null), [true, true, true], 'oldest first');
  assert.equal(rows.slice(3).every((row) => sim.rows.get(row.id)?.submitted_at === null), true);
  const second = await sweepExpiredAttempts(sim.pool, small);
  const third = await sweepExpiredAttempts(sim.pool, small);
  assert.deepEqual([second.scored, third.scored], [3, 1]);
  assert.equal((await sweepExpiredAttempts(sim.pool, small)).selected, 0);
  assertConnectionsReleased(sim);
});

test('sweep: the batch cap holds even if the database ignored LIMIT', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => attempt(eligibleAt(50 - index)));
  const sim = createSimulator(rows, { ignoreLimit: true });
  const result = await sweepExpiredAttempts(sim.pool, config({ ONLINE_EXAM_RECOVERY_BATCH: '2' }));
  assert.equal(result.selected, 2);
  assert.equal(result.scored, 2);
});

test('sweep: a row locked by a candidate request or another sweep is skipped untouched, then recovered later', async () => {
  const busy = attempt(eligibleAt(10));
  const free = attempt(eligibleAt(5));
  const sim = createSimulator([busy, free], { externallyLocked: new Set([busy.id]) });
  const first = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.deepEqual([first.selected, first.skipped, first.scored], [2, 1, 1]);
  assert.equal(sim.rows.get(busy.id)?.submitted_at, null, 'skipped row unchanged');
  sim.locks.delete(busy.id); // the other transaction finishes without scoring
  const second = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.equal(second.scored, 1);
  assert.notEqual(sim.rows.get(busy.id)?.submitted_at, null);
});

test('sweep: concurrent sweeps (e.g. two API processes) never score an attempt twice', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => attempt(eligibleAt(30 - index)));
  const sim = createSimulator(rows);
  const results = await Promise.all([
    sweepExpiredAttempts(sim.pool, RECOVERY_ON),
    sweepExpiredAttempts(sim.pool, RECOVERY_ON),
    sweepExpiredAttempts(sim.pool, RECOVERY_ON),
  ]);
  const totalScored = results.reduce((sum, result) => sum + result.scored, 0);
  assert.equal(totalScored, 6, 'each attempt scored exactly once across all sweeps');
  for (const row of rows) assert.equal(sim.stats.finalizeWrites.get(row.id), 1, row.id);
  const accounted = results.reduce((sum, result) => sum + result.scored + result.skipped + result.alreadyScored, 0);
  assert.equal(accounted, results.reduce((sum, result) => sum + result.selected, 0));
  assertConnectionsReleased(sim);
});

test('sweep: one failing attempt does not stop the others; it rolls back and is logged safely', async () => {
  const rows = [attempt(eligibleAt(30)), attempt(eligibleAt(20)), attempt(eligibleAt(10))];
  const sim = createSimulator(rows, { failFinalizeFor: new Map([[rows[1].id, 1]]) });
  const logs = createLogs();
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON, { log: logs.log, finalizeLog: logs.finalizeLog });
  assert.deepEqual([result.selected, result.scored, result.failed], [3, 2, 1]);
  assert.notEqual(sim.rows.get(rows[0].id)?.submitted_at, null);
  assert.equal(sim.rows.get(rows[1].id)?.submitted_at, null, 'failed attempt not marked scored');
  assert.equal(sim.rows.get(rows[1].id)?.score, null);
  assert.notEqual(sim.rows.get(rows[2].id)?.submitted_at, null);
  const failure = logs.recovery.find((entry) => entry.event === 'online_exam.recovery_attempt_failed');
  assert.deepEqual(failure, { event: 'online_exam.recovery_attempt_failed', attemptId: rows[1].id, errorClass: 'Error', invariant: undefined, sqlState: '40001' });
  assert.equal(logs.finalized.some((entry) => entry.attemptId === rows[1].id), false, 'no success log for the failure');
  assertConnectionsReleased(sim);
  assertSafeLogs(logs);
});

test('sweep: a transiently failed attempt is retried and recovered by a later sweep', async () => {
  const row = attempt(eligibleAt(10));
  const sim = createSimulator([row], { failFinalizeFor: new Map([[row.id, 1]]) });
  const first = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.equal(first.failed, 1);
  assert.equal(sim.rows.get(row.id)?.submitted_at, null);
  const second = await sweepExpiredAttempts(sim.pool, RECOVERY_ON);
  assert.equal(second.scored, 1);
  assert.equal(sim.stats.finalizeWrites.get(row.id), 1);
});

test('sweep: COMMIT failure is never reported or logged as success', async () => {
  const row = attempt(eligibleAt(10));
  const sim = createSimulator([row], { failCommitFor: new Set([row.id]) });
  const logs = createLogs();
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON, { log: logs.log, finalizeLog: logs.finalizeLog });
  assert.deepEqual([result.scored, result.failed], [0, 1]);
  assert.equal(logs.finalized.length, 0, 'no finalized log without a COMMIT');
  assert.equal(sim.rows.get(row.id)?.submitted_at, null);
  assert.equal(sim.rows.get(row.id)?.score, null);
  assertConnectionsReleased(sim);
  assertSafeLogs(logs);
});

test('sweep: inconsistent record raises under the lock, is counted as failed and left unchanged', async () => {
  // submitted_at set but no score: never selected (submitted_at IS NULL filter), so force the lock path.
  const row = attempt(eligibleAt(10));
  const sim = createSimulator([row]);
  const originalConnect = sim.pool.connect.bind(sim.pool);
  let connects = 0;
  sim.pool.connect = async () => {
    connects += 1;
    if (connects === 2) (sim.rows.get(row.id) as SimAttempt).submitted_at = row.expires_at;
    return originalConnect();
  };
  const logs = createLogs();
  const result = await sweepExpiredAttempts(sim.pool, RECOVERY_ON, { log: logs.log });
  assert.equal(result.failed, 1);
  const failure = logs.recovery.find((entry) => entry.event === 'online_exam.recovery_attempt_failed');
  assert.ok(failure && failure.event === 'online_exam.recovery_attempt_failed' && failure.invariant === 'submitted_without_score');
  assert.equal(sim.rows.get(row.id)?.score, null);
});

test('sweep: selection failure throws (for the scheduler to log) and still releases its connection', async () => {
  const sim = createSimulator([attempt(eligibleAt(10))], { selectionError: Object.assign(new Error('SECRET-DETAIL'), { code: '57014' }) });
  await assert.rejects(sweepExpiredAttempts(sim.pool, RECOVERY_ON));
  assert.equal(sim.stats.releases.length, 1);
  assert.ok(sim.stats.releases[0][0] instanceof Error, 'connection discarded after a failed query');
});

test('sweep: no summary log when nothing was selected', async () => {
  const sim = createSimulator([]);
  const logs = createLogs();
  await sweepExpiredAttempts(sim.pool, RECOVERY_ON, { log: logs.log });
  assert.equal(logs.recovery.length, 0);
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function fakeTimers() {
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean; unrefCalled: boolean }> = [];
  return {
    timers,
    setInterval: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false, unrefCalled: false, unref() { timer.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearInterval: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    tick() {
      for (const timer of timers) if (!timer.cleared) timer.callback();
    },
  };
}

test('scheduler: cutoff unset → disabled, no timer, no database work', async () => {
  const sim = createSimulator([attempt(eligibleAt(10))]);
  const timers = fakeTimers();
  const logs = createLogs();
  const handle = startOnlineExamRecovery(sim.pool, () => RECOVERY_OFF, { log: logs.log, ...timers });
  assert.equal(handle.enabled, false);
  assert.equal(timers.timers.length, 0);
  assert.equal(await handle.runNow(), null);
  await handle.stop();
  assert.equal(sim.stats.connects, 0);
  assert.deepEqual(logs.recovery, [{ event: 'online_exam.recovery_disabled', reason: 'cutoff_unset' }]);
});

test('scheduler: invalid settings → disabled; the log names the setting but never its value', async () => {
  const sim = createSimulator([attempt(eligibleAt(10))]);
  const timers = fakeTimers();
  const logs = createLogs();
  const handle = startOnlineExamRecovery(
    sim.pool,
    () => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: 'not-a-date-SECRET-VALUE' }, NOW),
    { log: logs.log, ...timers },
  );
  assert.equal(handle.enabled, false);
  assert.equal(timers.timers.length, 0);
  assert.equal(sim.stats.connects, 0);
  assert.deepEqual(logs.recovery, [{ event: 'online_exam.recovery_disabled', reason: 'invalid_config', setting: 'ONLINE_EXAM_RECOVERY_SINCE' }]);
  assert.equal(JSON.stringify(logs.recovery).includes('SECRET-VALUE'), false);
});

test('scheduler: enabled → one startup sweep immediately, then every 60 s (timer unref\'d)', async () => {
  const row = attempt(eligibleAt(10));
  const sim = createSimulator([row]);
  const timers = fakeTimers();
  const logs = createLogs();
  const handle = startOnlineExamRecovery(sim.pool, () => RECOVERY_ON, { log: logs.log, finalizeLog: logs.finalizeLog, ...timers });
  assert.equal(handle.enabled, true);
  assert.equal(logs.recovery[0].event, 'online_exam.recovery_enabled');
  assert.deepEqual(logs.recovery[0], { event: 'online_exam.recovery_enabled', status: 'enabled', periodicSweep: true });
  await handle.idle();
  assert.equal(sim.stats.selections.length, 1, 'startup sweep ran');
  assert.notEqual(sim.rows.get(row.id)?.submitted_at, null);
  const startup = logs.recovery.find((entry) => entry.event === 'online_exam.recovery_sweep');
  assert.ok(startup && startup.event === 'online_exam.recovery_sweep' && startup.trigger === 'startup');
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 60_000);
  assert.equal(timers.timers[0].unrefCalled, true);

  sim.rows.set('late', attempt(eligibleAt(1), { id: 'late' }));
  timers.tick();
  await handle.idle();
  assert.equal(sim.stats.selections.length, 2, 'periodic sweep ran');
  assert.notEqual(sim.rows.get('late')?.submitted_at, null);
  await handle.stop();
  assert.equal(timers.timers[0].cleared, true);
  assertConnectionsReleased(sim);
});

test('scheduler: interval 0 → startup sweep only, no periodic timer', async () => {
  const sim = createSimulator([attempt(eligibleAt(10))]);
  const timers = fakeTimers();
  const handle = startOnlineExamRecovery(sim.pool, () => config({ ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS: '0' }), { log: () => {}, finalizeLog: () => {}, ...timers });
  await handle.idle();
  assert.equal(sim.stats.selections.length, 1);
  assert.equal(timers.timers.length, 0);
  await handle.stop();
});

test('scheduler: ticks while a sweep is running are skipped (no overlap)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sim = createSimulator([attempt(eligibleAt(10))], { selectionGate: gate });
  const timers = fakeTimers();
  const logs = createLogs();
  const handle = startOnlineExamRecovery(sim.pool, () => RECOVERY_ON, { log: logs.log, finalizeLog: () => {}, ...timers });
  await new Promise((resolve) => setImmediate(resolve));
  timers.tick();
  timers.tick();
  assert.equal(await handle.runNow(), null, 'manual run also refused while running');
  assert.equal(sim.stats.selections.length, 1, 'only the startup sweep is running');
  assert.equal(logs.recovery.filter((entry) => entry.event === 'online_exam.recovery_tick_skipped').length, 3);
  release();
  await handle.idle();
  timers.tick();
  await handle.idle();
  assert.equal(sim.stats.selections.length, 2, 'next tick runs once the previous sweep finished');
  await handle.stop();
});

test('scheduler: a failed sweep is logged safely, never throws, and the next tick still runs', async () => {
  const sim = createSimulator([attempt(eligibleAt(10))], { connectError: Object.assign(new Error('SECRET-DETAIL'), { code: '08001' }) });
  const timers = fakeTimers();
  const logs = createLogs();
  const handle = startOnlineExamRecovery(sim.pool, () => RECOVERY_ON, { log: logs.log, ...timers });
  await handle.idle();
  const failure = logs.recovery.find((entry) => entry.event === 'online_exam.recovery_sweep_failed');
  assert.deepEqual(failure, { event: 'online_exam.recovery_sweep_failed', trigger: 'startup', errorClass: 'Error', invariant: undefined, sqlState: '08001' });
  timers.tick();
  await handle.idle();
  assert.equal(logs.recovery.filter((entry) => entry.event === 'online_exam.recovery_sweep_failed').length, 2);
  assertSafeLogs(logs);
  await handle.stop();
});

test('scheduler: stop() clears the timer, ends the running sweep between attempts and waits for it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rows = [attempt(eligibleAt(30)), attempt(eligibleAt(20)), attempt(eligibleAt(10))];
  const sim = createSimulator(rows, { selectionGate: gate });
  const timers = fakeTimers();
  const logs = createLogs();
  const handle = startOnlineExamRecovery(sim.pool, () => RECOVERY_ON, { log: logs.log, finalizeLog: () => {}, ...timers });
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = handle.stop();
  release();
  await stopping;
  assert.equal(timers.timers[0].cleared, true);
  const summary = logs.recovery.find((entry) => entry.event === 'online_exam.recovery_sweep');
  assert.ok(summary && summary.event === 'online_exam.recovery_sweep' && summary.stoppedEarly === true && summary.scored === 0);
  assert.equal(rows.every((row) => sim.rows.get(row.id)?.submitted_at === null), true, 'nothing half-done');
  assert.equal(await handle.runNow(), null, 'no sweeps after stop');
  timers.tick();
  assert.equal(sim.stats.selections.length, 1);
  assertConnectionsReleased(sim);
});

// ---------------------------------------------------------------------------
// Log safety: configuration values never logged
// ---------------------------------------------------------------------------

test('logs: no recovery log ever contains configuration values (cutoff, grace, interval, batch)', async () => {
  const distinctive = readOnlineExamConfig({
    ONLINE_EXAM_RECOVERY_SINCE: '2026-10-31T23:59:59.987654+05:30',
    ONLINE_EXAM_SUBMIT_GRACE_SECONDS: '117',
    ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS: '3517',
    ONLINE_EXAM_RECOVERY_BATCH: '193',
  }, NOW);
  const rows = [attempt(eligibleAt(10)), attempt(eligibleAt(5))];
  const sim = createSimulator(rows, { failFinalizeFor: new Map([[rows[0].id, 1]]) });
  const timers = fakeTimers();
  const logs = createLogs();
  const handle = startOnlineExamRecovery(sim.pool, () => distinctive, { log: logs.log, finalizeLog: logs.finalizeLog, ...timers });
  await handle.idle();
  timers.tick();
  await handle.idle();
  await handle.stop();
  const disabledLogs = createLogs();
  startOnlineExamRecovery(sim.pool, () => { throw new Error('ONLINE_EXAM_RECOVERY_SINCE must be valid.'); }, { log: disabledLogs.log });

  const entries = [...logs.recovery, ...logs.finalized, ...disabledLogs.recovery];
  assert.ok(entries.some((entry) => entry.event === 'online_exam.recovery_enabled'));
  assert.ok(entries.some((entry) => entry.event === 'online_exam.recovery_sweep'));
  assert.ok(entries.some((entry) => entry.event === 'online_exam.recovery_attempt_failed'));
  const text = JSON.stringify(entries);
  for (const forbidden of ['2026-10-31', '987654', '+05:30', 'recoverySince', 'graceSeconds', 'intervalSeconds', '"batch"']) {
    assert.equal(text.includes(forbidden), false, `logs must not contain ${forbidden}`);
  }
  // Numeric settings: no logged value equals grace (117), interval (3517 s / 3517000 ms) or batch (193).
  // Compared as values, so durations and counts cannot cause false matches.
  const loggedNumbers = entries.flatMap((entry) => Object.entries(entry))
    .filter(([key, value]) => key !== 'durationMs' && typeof value === 'number')
    .map(([, value]) => value as number);
  for (const value of [117, 3517, 3_517_000, 193]) {
    assert.equal(loggedNumbers.includes(value), false, `logs must not contain the configured value ${value}`);
  }
  assert.deepEqual(logs.recovery[0], { event: 'online_exam.recovery_enabled', status: 'enabled', periodicSweep: true });
});

// ---------------------------------------------------------------------------
// Lifecycle: start only after 'listening'
// ---------------------------------------------------------------------------

function fakeServer(listening = false) {
  const emitter = new EventEmitter() as EventEmitter & { listening: boolean };
  emitter.listening = listening;
  return emitter;
}

function countingStart() {
  const calls = { start: 0, stop: 0 };
  const handle: OnlineExamRecoveryHandle = {
    enabled: true,
    runNow: async () => null,
    idle: async () => undefined,
    stop: async () => { calls.stop += 1; },
  };
  return { calls, start: () => { calls.start += 1; return handle; } };
}

test('lifecycle: recovery starts only after the server emits listening, exactly once', async () => {
  const server = fakeServer();
  const { calls, start } = countingStart();
  const deferred = startOnlineExamRecoveryWhenListening(server, start);
  assert.equal(calls.start, 0, 'not started before listening');
  assert.equal(deferred.handle(), null);
  server.listening = true;
  server.emit('listening');
  server.emit('listening');
  assert.equal(calls.start, 1, 'started once');
  assert.notEqual(deferred.handle(), null);
  await deferred.stop();
  await deferred.stop();
  assert.equal(calls.stop >= 1, true, 'scheduler stopped');
});

test('lifecycle: recovery never starts when the server fails to bind', async () => {
  const server = fakeServer();
  const { calls, start } = countingStart();
  const deferred = startOnlineExamRecoveryWhenListening(server, start);
  // The test owns this listener only to observe the error; the helper adds none.
  assert.equal(server.listenerCount('error'), 0, 'helper adds no error listener (bind failures keep their behaviour)');
  server.on('error', () => {});
  server.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
  assert.equal(calls.start, 0);
  assert.equal(deferred.handle(), null);
  await deferred.stop();
  assert.equal(calls.stop, 0);
});

test('lifecycle: a shutdown before listening prevents a later start', async () => {
  const server = fakeServer();
  const { calls, start } = countingStart();
  const deferred = startOnlineExamRecoveryWhenListening(server, start);
  await deferred.stop();
  server.emit('listening');
  assert.equal(calls.start, 0);
});

test('lifecycle: an already-listening server starts recovery immediately', () => {
  const { calls, start } = countingStart();
  startOnlineExamRecoveryWhenListening(fakeServer(true), start);
  assert.equal(calls.start, 1);
});

test('lifecycle: the real scheduler stays disabled with the cutoff unset, even after listening', async () => {
  const server = fakeServer();
  const sim = createSimulator([attempt(eligibleAt(10))]);
  const timers = fakeTimers();
  const logs = createLogs();
  const deferred = startOnlineExamRecoveryWhenListening(server, () => startOnlineExamRecovery(sim.pool, () => RECOVERY_OFF, { log: logs.log, ...timers }));
  server.emit('listening');
  assert.equal(deferred.handle()?.enabled, false);
  assert.equal(timers.timers.length, 0);
  assert.equal(sim.stats.connects, 0);
  await deferred.stop();
});

// ---------------------------------------------------------------------------
// Lifecycle: idempotent graceful shutdown
// ---------------------------------------------------------------------------

function shutdownHarness(overrides: Partial<Record<'stopRecovery' | 'closeServer' | 'endPool', () => Promise<void>>> = {}) {
  const order: string[] = [];
  const exits: number[] = [];
  const logs: ShutdownLogEntry[] = [];
  const step = (name: string) => async () => {
    order.push(name);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const shutdown = createGracefulShutdown({
    stopRecovery: overrides.stopRecovery ?? step('stopRecovery'),
    closeServer: overrides.closeServer ?? step('closeServer'),
    endPool: overrides.endPool ?? step('endPool'),
    exit: (code) => { exits.push(code); },
    log: (entry) => { logs.push(entry); },
  });
  return { shutdown, order, exits, logs };
}

test('shutdown: stops recovery, then closes the server, then ends the pool, then exits 0', async () => {
  const { shutdown, order, exits, logs } = shutdownHarness();
  await shutdown('SIGTERM');
  assert.deepEqual(order, ['stopRecovery', 'closeServer', 'endPool']);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(logs, [{ event: 'api.shutdown_started', signal: 'SIGTERM' }]);
});

test('shutdown: repeated SIGINT/SIGTERM run every step at most once (pool.end called once)', async () => {
  const { shutdown, order, exits, logs } = shutdownHarness();
  const first = shutdown('SIGINT');
  const second = shutdown('SIGTERM');
  const third = shutdown('SIGINT');
  assert.equal(first, second, 'same promise reused');
  assert.equal(first, third);
  await Promise.all([first, second, third]);
  await shutdown('SIGTERM');
  assert.deepEqual(order, ['stopRecovery', 'closeServer', 'endPool']);
  assert.deepEqual(exits, [0]);
  assert.equal(logs.filter((entry) => entry.event === 'api.shutdown_started').length, 1);
});

test('shutdown: the pool is ended only after the server has closed', async () => {
  let serverClosed = false;
  let poolEndedAfterClose: boolean | null = null;
  const { shutdown } = shutdownHarness({
    closeServer: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      serverClosed = true;
    },
    endPool: async () => { poolEndedAfterClose = serverClosed; },
  });
  await shutdown('SIGTERM');
  assert.equal(poolEndedAfterClose, true);
});

test('shutdown: a failing step is logged safely, later steps still run, exit 1, and nothing rejects', async () => {
  const notRunning = Object.assign(new Error('Server is not running. SECRET-DETAIL'), { code: 'ERR_SERVER_NOT_RUNNING' });
  const poolFailure = Object.assign(new Error('Called end on pool more than once SECRET-DETAIL'), { code: 'whatever lowercase' });
  const { shutdown, order, exits, logs } = shutdownHarness({
    closeServer: async () => { order.push('closeServer'); throw notRunning; },
    endPool: async () => { order.push('endPool'); throw poolFailure; },
  });
  await shutdown('SIGTERM'); // must resolve, never reject
  await shutdown('SIGINT');
  assert.deepEqual(order, ['stopRecovery', 'closeServer', 'endPool']);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(logs.slice(1), [
    { event: 'api.shutdown_step_failed', step: 'close_server', errorClass: 'Error', code: 'ERR_SERVER_NOT_RUNNING' },
    { event: 'api.shutdown_step_failed', step: 'end_pool', errorClass: 'Error', code: undefined },
  ]);
  assert.equal(JSON.stringify(logs).includes('SECRET-DETAIL'), false);
});

test('shutdown: an in-flight sweep finishes before the server closes; no timer or sweep survives', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sim = createSimulator([attempt(eligibleAt(10))], { selectionGate: gate });
  const timers = fakeTimers();
  const server = fakeServer();
  const order: string[] = [];
  const deferred = startOnlineExamRecoveryWhenListening(server, () => startOnlineExamRecovery(sim.pool, () => RECOVERY_ON, { log: () => {}, finalizeLog: () => {}, ...timers }));
  server.emit('listening');
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = createGracefulShutdown({
    stopRecovery: async () => { await deferred.stop(); order.push('recoveryStopped'); },
    closeServer: async () => { order.push('serverClosed'); },
    endPool: async () => { order.push('poolEnded'); },
    exit: () => {},
    log: () => {},
  });
  const done = shutdown('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'waits for the in-flight sweep');
  release();
  await done;
  assert.deepEqual(order, ['recoveryStopped', 'serverClosed', 'poolEnded']);
  assert.equal(timers.timers[0].cleared, true, 'timer cleared');
  timers.tick();
  assert.equal(sim.stats.selections.length, 1, 'no sweep after shutdown');
  assertConnectionsReleased(sim);
});
