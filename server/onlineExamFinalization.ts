// Transactional online-exam finalization and autosave (P0-4 Phase 2).
//
// Every write follows the same order:
//   BEGIN → transaction-local lock_timeout (candidate paths) → SELECT … FOR UPDATE
//   → a SEPARATE clock_timestamp() statement, issued only once the lock is held
//   → decision while holding the lock → score and write → COMMIT (or ROLLBACK).
//
// All time comparisons run in PostgreSQL against the database clock. The scoring
// formula and score field order come unchanged from onlineExamScoring.ts; the only
// addition is a `completion` object appended as the last key of a new score.
//
// This module does not import the shared pool. Callers pass a pool, which keeps the
// module testable with a fake connection and lets each call own exactly one
// connection and one transaction.

import {
  type OnlineExamQuestionRow,
  type OnlineExamScore,
  sanitizeOnlineExamResponses,
  scoreOnlineExam,
} from './onlineExamScoring.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface OnlineExamConfig {
  /** Seconds after expires_at during which a final submit still scores the submitted answers. */
  readonly submitGraceSeconds: number;
  /** Exact cutoff text passed to PostgreSQL, or null when automatic recovery is off. */
  readonly recoverySince: string | null;
  readonly recoveryEnabled: boolean;
  readonly recoveryIntervalSeconds: number;
  readonly recoveryBatch: number;
  readonly lockTimeoutMs: number;
}

type OnlineExamEnvironment = Readonly<Record<string, string | undefined>>;

const RECOVERY_SINCE_MAX_FUTURE_MS = 5 * 60 * 1000;
const RECOVERY_SINCE_MIN_YEAR = 2000;
// Real-world UTC offsets run from -12:00 to +14:00 (both inclusive).
const RECOVERY_SINCE_MAX_NEGATIVE_OFFSET_MINUTES = 12 * 60;
const RECOVERY_SINCE_MAX_POSITIVE_OFFSET_MINUTES = 14 * 60;
const RECOVERY_SINCE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function readWholeNumber(
  env: OnlineExamEnvironment,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    // Name the setting and its allowed range, never the configured value.
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Returns epoch milliseconds for a strictly validated ISO-8601 time with an explicit offset, or null. */
function parseRecoverySince(raw: string): number | null {
  const match = RECOVERY_SINCE_PATTERN.exec(raw);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0', fraction = '', sign, oh = '0', om = '0'] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const offsetHours = Number(oh);
  const offsetMinutes = Number(om);
  if (year < RECOVERY_SINCE_MIN_YEAR) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59 || offsetMinutes > 59) return null;
  const offsetTotalMinutes = offsetHours * 60 + offsetMinutes;
  if (sign === '-' && offsetTotalMinutes > RECOVERY_SINCE_MAX_NEGATIVE_OFFSET_MINUTES) return null;
  if (sign === '+' && offsetTotalMinutes > RECOVERY_SINCE_MAX_POSITIVE_OFFSET_MINUTES) return null;
  const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3));
  const offsetMs = (sign === '-' ? -1 : 1) * offsetTotalMinutes * 60_000;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offsetMs;
  return Number.isFinite(utcMs) ? utcMs : null;
}

/**
 * Reads the online-exam settings. Throws an error naming the setting (never its value)
 * when a value is invalid. `now` is injectable for tests.
 */
export function readOnlineExamConfig(
  env: OnlineExamEnvironment = process.env,
  now: Date = new Date(),
): OnlineExamConfig {
  const submitGraceSeconds = readWholeNumber(env, 'ONLINE_EXAM_SUBMIT_GRACE_SECONDS', 30, 0, 120);
  const recoveryIntervalSeconds = readWholeNumber(env, 'ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS', 60, 0, 3600);
  const recoveryBatch = readWholeNumber(env, 'ONLINE_EXAM_RECOVERY_BATCH', 50, 1, 200);
  const lockTimeoutMs = readWholeNumber(env, 'ONLINE_EXAM_LOCK_TIMEOUT_MS', 5000, 100, 30000);

  const rawSince = env.ONLINE_EXAM_RECOVERY_SINCE;
  let recoverySince: string | null = null;
  if (rawSince !== undefined && rawSince !== '') {
    const sinceMs = parseRecoverySince(rawSince);
    if (sinceMs === null) {
      throw new Error(
        'ONLINE_EXAM_RECOVERY_SINCE must be a valid ISO-8601 date and time from the year 2000 onward with an explicit offset between -12:00 and +14:00, for example 2026-11-05T09:00:00Z.',
      );
    }
    if (sinceMs > now.getTime() + RECOVERY_SINCE_MAX_FUTURE_MS) {
      throw new Error('ONLINE_EXAM_RECOVERY_SINCE must not be more than 5 minutes in the future.');
    }
    // Keep the validated text exactly, so PostgreSQL compares at full precision.
    recoverySince = rawSince;
  }

  return Object.freeze({
    submitGraceSeconds,
    recoverySince,
    recoveryEnabled: recoverySince !== null,
    recoveryIntervalSeconds,
    recoveryBatch,
    lockTimeoutMs,
  });
}

// ---------------------------------------------------------------------------
// SQL (exported so tests can assert the exact statements and their order)
// ---------------------------------------------------------------------------

export const ONLINE_EXAM_SQL = Object.freeze({
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  // $1 = '<ms>ms'. The third argument `true` limits the setting to this transaction (SET LOCAL).
  lockTimeout: "SELECT set_config('lock_timeout', $1, true)",
  // Candidate paths: ownership checked in the locking statement; waits for the lock.
  lockOwnedAttempt: `SELECT id, exam_code, expires_at, submitted_at, responses, score
  FROM online_exam_attempts
 WHERE id = $1 AND user_id = $2 AND exam_code = $3
 FOR UPDATE`,
  // Recovery: never waits. A row locked elsewhere is skipped and left untouched.
  lockAttemptForRecovery: `SELECT id, exam_code, expires_at, submitted_at, responses, score
  FROM online_exam_attempts
 WHERE id = $1
 FOR UPDATE SKIP LOCKED`,
  // Issued only after the lock is held. One real-clock read decides everything.
  // $2 = grace seconds; $3 = recovery cutoff, or NULL when recovery is off (then excluded).
  // Eligible exactly when expires_at >= cutoff; excluded exactly when expires_at < cutoff.
  clock: `WITH c AS MATERIALIZED (SELECT clock_timestamp() AS t)
SELECT to_char(c.t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
       c.t < a.expires_at AS before_expiry,
       c.t <= a.expires_at + ($2::int * interval '1 second') AS within_grace,
       ($3::timestamptz IS NULL OR a.expires_at < $3::timestamptz) AS recovery_excluded
  FROM online_exam_attempts a CROSS JOIN c
 WHERE a.id = $1`,
  // Identical to the answer-key query used by the submit route today.
  questions: `SELECT question_number, correct_option, points, section
     FROM online_exam_questions WHERE exam_code = $1`,
  // $2 = decision time, or NULL to record expires_at (saved-answer scoring).
  // $3 = answers to store, or NULL to keep the saved answers exactly as they are.
  // `score IS NULL` is a second guard: an existing score is never overwritten.
  finalize: `UPDATE online_exam_attempts
   SET submitted_at = COALESCE($2::timestamptz, expires_at),
       responses = COALESCE($3::jsonb, responses),
       score = $4::jsonb
 WHERE id = $1 AND submitted_at IS NULL AND score IS NULL
RETURNING submitted_at`,
  saveResponses: `UPDATE online_exam_attempts
   SET responses = $2::jsonb
 WHERE id = $1 AND submitted_at IS NULL`,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DatabaseRow = Record<string, unknown>;

/** The subset of a pg PoolClient used here. pg's PoolClient satisfies it. */
export interface FinalizationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: DatabaseRow[]; rowCount: number | null }>;
  release(error?: Error): void;
}

/** The subset of a pg Pool used here. pg's Pool satisfies it. */
export interface FinalizationPool {
  connect(): Promise<FinalizationClient>;
}

export type CompletionReason = 'candidate_submit' | 'grace_submit' | 'expired_saved_answers';

export interface OnlineExamCompletion {
  version: 1;
  reason: CompletionReason;
  finalizedBy: 'candidate' | 'system';
  decidedAt: string;
  graceSeconds: number;
  ignoredResponses: number;
}

export type FinalizedOnlineExamScore = OnlineExamScore & { completion: OnlineExamCompletion };

/** Structured log line. Never contains answers, scores or user identifiers. */
export interface OnlineExamFinalizedLogEntry {
  event: 'online_exam.finalized';
  mode: 'candidate' | 'recovery';
  attemptId: string;
  examCode: string;
  reason: CompletionReason;
  finalizedBy: 'candidate' | 'system';
  ignoredResponses: number;
  savedAnswersMalformed: boolean;
}

export type OnlineExamLogger = (entry: OnlineExamFinalizedLogEntry) => void;

const defaultLogger: OnlineExamLogger = (entry) => {
  console.info(JSON.stringify(entry));
};

export type FinalizeInput =
  | {
      mode: 'candidate';
      attemptId: string;
      userId: string;
      examCode: string;
      /** The answers in the submit request body. Used only before expiry or within grace. */
      submittedResponses: unknown;
      config: OnlineExamConfig;
      log?: OnlineExamLogger;
    }
  | {
      mode: 'recovery';
      attemptId: string;
      config: OnlineExamConfig;
      log?: OnlineExamLogger;
    };

/**
 * Why a submitted or autosaved answer payload was refused. Nothing is written in either case.
 * - `malformed`: the payload is not a plain object (NULL, array, string, number, …).
 * - `no_valid_answers`: a non-empty payload in which every entry was removed by sanitization.
 * An intentionally empty object `{}` is valid.
 */
export type InvalidResponsesReason = 'malformed' | 'no_valid_answers';

export interface InvalidResponsesOutcome {
  kind: 'invalid_responses';
  reason: InvalidResponsesReason;
}

export type FinalizeOutcome =
  | { kind: 'scored'; reason: CompletionReason; score: FinalizedOnlineExamScore; submittedAt: unknown }
  | { kind: 'already_scored'; score: Record<string, unknown>; submittedAt: unknown }
  | InvalidResponsesOutcome
  | { kind: 'expired_unscored' }
  /** Candidate mode: no attempt with this id for this user and exam. */
  | { kind: 'missing' }
  /** Candidate mode: the attempt lock was not obtained within lock_timeout. Nothing was written. */
  | { kind: 'busy' }
  /** Recovery mode: still before expiry or inside the grace window. */
  | { kind: 'not_eligible' }
  /** Recovery mode: locked by another transaction (or gone). Left untouched for a later sweep. */
  | { kind: 'skipped' };

export interface SaveResponsesInput {
  attemptId: string;
  userId: string;
  examCode: string;
  responses: unknown;
  config: OnlineExamConfig;
}

export type SaveResponsesOutcome =
  | { kind: 'saved'; savedAt: string; ignoredResponses: number }
  | InvalidResponsesOutcome
  | { kind: 'finalized' }
  | { kind: 'answering_closed' }
  | { kind: 'missing' }
  | { kind: 'busy' };

export type OnlineExamInvariantReason =
  | 'submitted_without_score'
  | 'invalid_stored_score'
  | 'score_without_submission'
  | 'unexpected_update_count'
  | 'clock_unavailable';

const INVARIANT_MESSAGES: Record<OnlineExamInvariantReason, string> = {
  submitted_without_score:
    'Online exam attempt is marked as submitted but has no stored score. The record was not changed.',
  invalid_stored_score:
    'Online exam attempt is marked as submitted but its stored score is not a valid score. The record was not changed.',
  score_without_submission:
    'Online exam attempt has a stored score but is not marked as submitted. The record was not changed.',
  unexpected_update_count: 'Online exam attempt update did not change exactly one row. The transaction was rolled back.',
  clock_unavailable: 'Online exam decision time could not be read. The transaction was rolled back.',
};

/** A safe internal error: its message never contains identifiers, answers or scores. */
export class OnlineExamInvariantError extends Error {
  readonly code = 'ONLINE_EXAM_INVARIANT';
  readonly reason: OnlineExamInvariantReason;

  constructor(reason: OnlineExamInvariantReason) {
    super(INVARIANT_MESSAGES[reason]);
    this.name = 'OnlineExamInvariantError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True for PostgreSQL SQLSTATE 55P03 (lock_not_available), raised when lock_timeout expires. */
export function isLockTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === '55P03';
}

/** Appends completion metadata as the last key. The scoring fields are not changed. */
export function withCompletion(score: OnlineExamScore, completion: OnlineExamCompletion): FinalizedOnlineExamScore {
  return { ...score, completion };
}

export interface ClockFlags {
  beforeExpiry: unknown;
  withinGrace: unknown;
  recoveryExcluded: unknown;
}

export type FinalizationDecision =
  | { action: 'score'; reason: 'candidate_submit' | 'grace_submit'; source: 'submitted' }
  | { action: 'score'; reason: 'expired_saved_answers'; source: 'saved' }
  | { action: 'expired_unscored' }
  | { action: 'not_eligible' };

/**
 * The finalization decision, from flags computed by the database clock after the lock.
 * Fail-safe: only a literal `true` opens the answering or grace window, and anything
 * other than a literal `false` for recoveryExcluded is treated as excluded (not scored).
 */
export function decideFinalization(mode: 'candidate' | 'recovery', flags: ClockFlags): FinalizationDecision {
  const beforeExpiry = flags.beforeExpiry === true;
  const withinGrace = beforeExpiry || flags.withinGrace === true;
  const recoveryEligible = flags.recoveryExcluded === false;
  if (mode === 'candidate') {
    if (beforeExpiry) return { action: 'score', reason: 'candidate_submit', source: 'submitted' };
    if (withinGrace) return { action: 'score', reason: 'grace_submit', source: 'submitted' };
  } else if (withinGrace) {
    return { action: 'not_eligible' };
  }
  if (recoveryEligible) return { action: 'score', reason: 'expired_saved_answers', source: 'saved' };
  return { action: 'expired_unscored' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isScoreNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const SCORE_NUMBER_FIELDS = [
  'totalQuestions', 'attempted', 'correct', 'incorrect', 'unattempted', 'totalScore', 'maxScore', 'percentage',
] as const;
const SECTION_NUMBER_FIELDS = ['correct', 'total', 'score', 'maxScore'] as const;

/**
 * True when `value` is a complete stored score: every scoring field present as a finite,
 * non-negative number, and `sectionScores` an object whose entries carry the four section
 * numbers. Checked by field name and value only, so JSONB key order does not matter.
 * `completion` is optional (scores stored before P0-4 have none) but must be an object if present.
 */
export function isValidStoredScore(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  if (!SCORE_NUMBER_FIELDS.every((field) => isScoreNumber(value[field]))) return false;
  const sections = value.sectionScores;
  if (!isPlainObject(sections)) return false;
  for (const section of Object.values(sections)) {
    if (!isPlainObject(section)) return false;
    if (!SECTION_NUMBER_FIELDS.every((field) => isScoreNumber(section[field]))) return false;
  }
  if ('completion' in value && !isPlainObject(value.completion)) return false;
  return true;
}

/**
 * Throws OnlineExamInvariantError when the locked row's submitted_at and score disagree:
 * submitted without a valid score, or a score present on an unsubmitted attempt.
 * Returns true when the attempt is consistently submitted, false when consistently open.
 */
function assertConsistentAttempt(attempt: DatabaseRow): boolean {
  const submitted = attempt.submitted_at !== null && attempt.submitted_at !== undefined;
  const hasScore = attempt.score !== null && attempt.score !== undefined;
  if (submitted) {
    if (!hasScore) throw new OnlineExamInvariantError('submitted_without_score');
    if (!isValidStoredScore(attempt.score)) throw new OnlineExamInvariantError('invalid_stored_score');
    return true;
  }
  if (hasScore) throw new OnlineExamInvariantError('score_without_submission');
  return false;
}

/** Container check, done before any database access: only a plain object is accepted. */
function isAcceptableResponseContainer(raw: unknown): boolean {
  return isPlainObject(raw);
}

/** A non-empty payload whose every entry was dropped. An intentionally empty `{}` is valid. */
function lostAllAnswers(sanitized: { accepted: Record<string, unknown>; ignored: number }): boolean {
  return sanitized.ignored > 0 && Object.keys(sanitized.accepted).length === 0;
}

// ---------------------------------------------------------------------------
// Transaction plumbing
// ---------------------------------------------------------------------------

interface TransactionResult<T> {
  value: T;
  commit: boolean;
  logEntry?: OnlineExamFinalizedLogEntry;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Online exam transaction rollback failed.');
}

function emitLog(log: OnlineExamLogger, entry: OnlineExamFinalizedLogEntry): void {
  try {
    log(entry);
  } catch {
    // Logging must never change the outcome of a committed transaction.
  }
}

/**
 * Runs `body` in one transaction on one connection. COMMITs only when the body asks to,
 * ROLLBACKs otherwise and on any error, logs only after a successful COMMIT, and releases
 * the connection exactly once. If ROLLBACK fails the connection is discarded, not reused.
 */
async function withTransaction<T>(
  pool: FinalizationPool,
  log: OnlineExamLogger,
  body: (client: FinalizationClient) => Promise<TransactionResult<T>>,
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  try {
    let result: TransactionResult<T>;
    try {
      await client.query(ONLINE_EXAM_SQL.begin);
      result = await body(client);
      await client.query(result.commit ? ONLINE_EXAM_SQL.commit : ONLINE_EXAM_SQL.rollback);
    } catch (error) {
      try {
        await client.query(ONLINE_EXAM_SQL.rollback);
      } catch (rollbackError) {
        brokenConnection = toError(rollbackError);
      }
      throw error;
    }
    if (result.commit && result.logEntry) emitLog(log, result.logEntry);
    return result.value;
  } finally {
    client.release(brokenConnection);
  }
}

function rollbackWith<T>(value: T): TransactionResult<T> {
  return { value, commit: false };
}

interface DecisionClock extends ClockFlags {
  decidedAt: string;
}

async function readDecisionClock(
  client: FinalizationClient,
  attemptId: string,
  config: OnlineExamConfig,
): Promise<DecisionClock> {
  const { rows } = await client.query(ONLINE_EXAM_SQL.clock, [
    attemptId,
    config.submitGraceSeconds,
    config.recoverySince,
  ]);
  const row = rows[0];
  if (!row || typeof row.decided_at !== 'string') throw new OnlineExamInvariantError('clock_unavailable');
  return {
    decidedAt: row.decided_at,
    beforeExpiry: row.before_expiry,
    withinGrace: row.within_grace,
    recoveryExcluded: row.recovery_excluded,
  };
}

// ---------------------------------------------------------------------------
// Finalization (submit, grace submit, late submit, recovery)
// ---------------------------------------------------------------------------

export async function finalizeAttempt(pool: FinalizationPool, input: FinalizeInput): Promise<FinalizeOutcome> {
  const { config, attemptId, mode } = input;
  // A malformed submitted payload is refused before any database access, whatever the timing.
  if (input.mode === 'candidate' && !isAcceptableResponseContainer(input.submittedResponses)) {
    return { kind: 'invalid_responses', reason: 'malformed' };
  }
  try {
    return await withTransaction<FinalizeOutcome>(pool, input.log ?? defaultLogger, async (client) => {
      let lockRows: DatabaseRow[];
      if (input.mode === 'candidate') {
        await client.query(ONLINE_EXAM_SQL.lockTimeout, [`${config.lockTimeoutMs}ms`]);
        ({ rows: lockRows } = await client.query(ONLINE_EXAM_SQL.lockOwnedAttempt, [
          attemptId,
          input.userId,
          input.examCode,
        ]));
      } else {
        ({ rows: lockRows } = await client.query(ONLINE_EXAM_SQL.lockAttemptForRecovery, [attemptId]));
      }

      const attempt = lockRows[0];
      if (!attempt) return rollbackWith<FinalizeOutcome>({ kind: mode === 'candidate' ? 'missing' : 'skipped' });

      // Inconsistent records (submitted without a valid score, or scored but not submitted)
      // are never reported as success and never repaired here: the throw rolls back untouched.
      if (assertConsistentAttempt(attempt)) {
        return rollbackWith<FinalizeOutcome>({
          kind: 'already_scored',
          // assertConsistentAttempt returned true only after isValidStoredScore(attempt.score).
          score: attempt.score as Record<string, unknown>,
          submittedAt: attempt.submitted_at,
        });
      }

      const clock = await readDecisionClock(client, attemptId, config);
      const decision = decideFinalization(mode, clock);
      if (decision.action === 'expired_unscored') return rollbackWith<FinalizeOutcome>({ kind: 'expired_unscored' });
      if (decision.action === 'not_eligible') return rollbackWith<FinalizeOutcome>({ kind: 'not_eligible' });

      const { rows: questionRows } = await client.query(ONLINE_EXAM_SQL.questions, [attempt.exam_code]);
      const questions = questionRows as unknown as OnlineExamQuestionRow[];
      const useSubmitted = decision.source === 'submitted' && input.mode === 'candidate';
      const rawResponses = useSubmitted ? input.submittedResponses : attempt.responses;
      const sanitized = sanitizeOnlineExamResponses(rawResponses, questions);
      if (useSubmitted && lostAllAnswers(sanitized)) {
        // Never replace saved answers with an empty set produced by sanitization.
        return rollbackWith<FinalizeOutcome>({ kind: 'invalid_responses', reason: 'no_valid_answers' });
      }
      const finalizedBy = decision.source === 'submitted' ? 'candidate' : 'system';
      const score = withCompletion(scoreOnlineExam(questions, sanitized.accepted), {
        version: 1,
        reason: decision.reason,
        finalizedBy,
        decidedAt: clock.decidedAt,
        graceSeconds: config.submitGraceSeconds,
        ignoredResponses: sanitized.ignored,
      });

      const update = await client.query(ONLINE_EXAM_SQL.finalize, [
        attemptId,
        useSubmitted ? clock.decidedAt : null,
        useSubmitted ? sanitized.accepted : null,
        score,
      ]);
      if (update.rowCount !== 1 || !update.rows[0]) throw new OnlineExamInvariantError('unexpected_update_count');

      return {
        value: { kind: 'scored', reason: decision.reason, score, submittedAt: update.rows[0].submitted_at },
        commit: true,
        logEntry: {
          event: 'online_exam.finalized',
          mode,
          attemptId,
          examCode: String(attempt.exam_code),
          reason: decision.reason,
          finalizedBy,
          ignoredResponses: sanitized.ignored,
          savedAnswersMalformed: !useSubmitted && sanitized.malformed,
        },
      };
    });
  } catch (error) {
    if (isLockTimeout(error)) return { kind: 'busy' };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Autosave (accepted strictly before expiry)
// ---------------------------------------------------------------------------

export async function saveAttemptResponses(
  pool: FinalizationPool,
  input: SaveResponsesInput,
): Promise<SaveResponsesOutcome> {
  const { config, attemptId } = input;
  // A malformed payload is refused before any database access.
  if (!isAcceptableResponseContainer(input.responses)) return { kind: 'invalid_responses', reason: 'malformed' };
  try {
    return await withTransaction<SaveResponsesOutcome>(pool, defaultLogger, async (client) => {
      await client.query(ONLINE_EXAM_SQL.lockTimeout, [`${config.lockTimeoutMs}ms`]);
      const { rows } = await client.query(ONLINE_EXAM_SQL.lockOwnedAttempt, [
        attemptId,
        input.userId,
        input.examCode,
      ]);
      const attempt = rows[0];
      if (!attempt) return rollbackWith<SaveResponsesOutcome>({ kind: 'missing' });
      // Same consistency rule as finalization: an inconsistent record raises and rolls back.
      if (assertConsistentAttempt(attempt)) return rollbackWith<SaveResponsesOutcome>({ kind: 'finalized' });

      const clock = await readDecisionClock(client, attemptId, config);
      if (clock.beforeExpiry !== true) return rollbackWith<SaveResponsesOutcome>({ kind: 'answering_closed' });

      const { rows: questionRows } = await client.query(ONLINE_EXAM_SQL.questions, [attempt.exam_code]);
      const sanitized = sanitizeOnlineExamResponses(
        input.responses,
        questionRows as unknown as OnlineExamQuestionRow[],
      );
      if (lostAllAnswers(sanitized)) {
        // Never replace saved answers with an empty set produced by sanitization.
        return rollbackWith<SaveResponsesOutcome>({ kind: 'invalid_responses', reason: 'no_valid_answers' });
      }
      const update = await client.query(ONLINE_EXAM_SQL.saveResponses, [attemptId, sanitized.accepted]);
      if (update.rowCount !== 1) throw new OnlineExamInvariantError('unexpected_update_count');
      return {
        value: { kind: 'saved', savedAt: clock.decidedAt, ignoredResponses: sanitized.ignored },
        commit: true,
      };
    });
  } catch (error) {
    if (isLockTimeout(error)) return { kind: 'busy' };
    throw error;
  }
}
