// Automatic recovery of expired online-exam attempts (P0-4 Phase 4).
//
// A sweep selects a bounded batch of attempts that look eligible, then finalizes each one
// through finalizeAttempt(mode: 'recovery') from onlineExamFinalization.ts. That function
// owns all locking, the database-clock decision and the scoring write:
//   - one connection and one transaction per attempt (never one transaction for the batch);
//   - FOR UPDATE SKIP LOCKED, so a row held by a candidate request or another sweep is skipped
//     and left untouched for a later sweep;
//   - eligibility is re-checked under the lock (grace window, recovery cutoff, already scored);
//   - only the last successfully saved answers are scored; submitted_at is set to expires_at;
//   - the "finalized" log line is written only after COMMIT.
// This module adds no second scoring or finalization path.
//
// Recovery is enabled only when ONLINE_EXAM_RECOVERY_SINCE is set (config.recoverySince).
// Attempts that expired before that cutoff are never selected and, if reached anyway, are
// excluded again under the lock, so they stay unscored and unchanged.

import {
  type FinalizationPool,
  finalizeAttempt,
  type OnlineExamConfig,
  OnlineExamInvariantError,
  type OnlineExamLogger,
} from './onlineExamFinalization.js';

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const ONLINE_EXAM_RECOVERY_SQL = Object.freeze({
  // Candidate selection only: no lock and no transaction. Every selected id is re-checked
  // under its own row lock by finalizeAttempt before anything is written.
  // $1 = recovery cutoff (expires_at >= cutoff is eligible, matching the finalize rule
  //      "excluded when expires_at < cutoff"); $2 = grace seconds (strictly past the grace
  //      window, matching "within grace when now <= expires_at + grace"); $3 = batch limit.
  selectCandidates: `SELECT id
  FROM online_exam_attempts
 WHERE submitted_at IS NULL
   AND score IS NULL
   AND expires_at >= $1::timestamptz
   AND expires_at + ($2::int * interval '1 second') < clock_timestamp()
 ORDER BY expires_at, id
 LIMIT $3::int`,
  // Candidate-facing attempt list with a state computed from one database-clock reading.
  // The original five columns are unchanged; `state` is an addition.
  // $1 = user id; $2 = grace seconds; $3 = recovery cutoff or NULL (recovery off).
  attemptStates: `WITH c AS MATERIALIZED (SELECT clock_timestamp() AS t)
SELECT a.exam_code, a.started_at, a.expires_at, a.submitted_at, a.score,
       CASE
         WHEN a.submitted_at IS NOT NULL THEN 'scored'
         WHEN c.t < a.expires_at THEN 'in_progress'
         WHEN c.t <= a.expires_at + ($2::int * interval '1 second') THEN 'final_submit_window'
         WHEN a.score IS NULL AND $3::timestamptz IS NOT NULL AND a.expires_at >= $3::timestamptz
           THEN 'expired_pending_scoring'
         ELSE 'expired_unscored'
       END AS state
  FROM online_exam_attempts a CROSS JOIN c
 WHERE a.user_id = $1`,
});

/**
 * Candidate-facing attempt states:
 * - `scored`: submitted_at is set; the stored score is returned as before.
 * - `in_progress`: before expires_at (database clock).
 * - `final_submit_window`: expires_at ≤ now ≤ expires_at + grace; only a final submit is accepted.
 * - `expired_pending_scoring`: past grace, unscored, and eligible for automatic recovery.
 * - `expired_unscored`: past grace and not going to be scored automatically (recovery off,
 *   expired before the cutoff, or an inconsistent record).
 */
export type OnlineExamAttemptState =
  | 'scored'
  | 'in_progress'
  | 'final_submit_window'
  | 'expired_pending_scoring'
  | 'expired_unscored';

export function attemptStateParams(userId: unknown, config: OnlineExamConfig): unknown[] {
  return [userId, config.submitGraceSeconds, config.recoverySince];
}

// ---------------------------------------------------------------------------
// Logging (event names, counts and attempt ids only)
// ---------------------------------------------------------------------------

export type RecoveryTrigger = 'startup' | 'interval' | 'manual';

export type RecoveryLogEntry =
  | { event: 'online_exam.recovery_disabled'; reason: 'cutoff_unset' | 'invalid_config'; setting?: string }
  // Status only. Configuration values (cutoff, grace, interval, batch) are never logged.
  | { event: 'online_exam.recovery_enabled'; status: 'enabled'; periodicSweep: boolean }
  | ({ event: 'online_exam.recovery_sweep'; trigger: RecoveryTrigger; durationMs: number } & RecoverySweepResult)
  | { event: 'online_exam.recovery_attempt_failed'; attemptId: string; errorClass: string; invariant?: string; sqlState?: string }
  | { event: 'online_exam.recovery_sweep_failed'; trigger: RecoveryTrigger; errorClass: string; sqlState?: string }
  | { event: 'online_exam.recovery_tick_skipped'; trigger: RecoveryTrigger; reason: 'sweep_running' };

export type RecoveryLogger = (entry: RecoveryLogEntry) => void;

const defaultRecoveryLogger: RecoveryLogger = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.event === 'online_exam.recovery_attempt_failed' || entry.event === 'online_exam.recovery_sweep_failed') {
    console.error(line);
  } else {
    console.info(line);
  }
};

function emit(log: RecoveryLogger, entry: RecoveryLogEntry): void {
  try {
    log(entry);
  } catch {
    // Logging must never affect recovery.
  }
}

/** Error class, invariant reason and SQLSTATE only. Never messages, details or row data. */
function safeErrorFields(error: unknown): { errorClass: string; invariant?: string; sqlState?: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  return {
    errorClass: error instanceof Error ? error.name : typeof error,
    invariant: error instanceof OnlineExamInvariantError ? error.reason : undefined,
    sqlState: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
  };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface RecoverySweepResult {
  selected: number;
  scored: number;
  alreadyScored: number;
  skipped: number;
  notEligible: number;
  expiredUnscored: number;
  failed: number;
  stoppedEarly: boolean;
}

export interface SweepOptions {
  trigger?: RecoveryTrigger;
  log?: RecoveryLogger;
  /** Passed to finalizeAttempt for its post-COMMIT "finalized" line. */
  finalizeLog?: OnlineExamLogger;
  /** Checked before each attempt; returning false ends the sweep early (used by stop()). */
  shouldContinue?: () => boolean;
}

function emptyResult(): RecoverySweepResult {
  return { selected: 0, scored: 0, alreadyScored: 0, skipped: 0, notEligible: 0, expiredUnscored: 0, failed: 0, stoppedEarly: false };
}

/** Selects at most `config.recoveryBatch` candidate ids on one short-lived connection. */
async function selectRecoveryCandidates(pool: FinalizationPool, config: OnlineExamConfig): Promise<string[]> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  try {
    const { rows } = await client.query(ONLINE_EXAM_RECOVERY_SQL.selectCandidates, [
      config.recoverySince,
      config.submitGraceSeconds,
      config.recoveryBatch,
    ]);
    // LIMIT bounds the query; the slice is a second guard on the work done per sweep.
    return rows.slice(0, config.recoveryBatch).map((row) => String(row.id));
  } catch (error) {
    brokenConnection = error instanceof Error ? error : new Error('Recovery selection failed.');
    throw error;
  } finally {
    client.release(brokenConnection);
  }
}

/**
 * One recovery sweep. Throws only if the candidate selection itself fails; a failure on an
 * individual attempt is logged safely, counted, and the sweep continues with the next one.
 * Failed attempts stay unscored and are selected again by a later sweep.
 */
export async function sweepExpiredAttempts(
  pool: FinalizationPool,
  config: OnlineExamConfig,
  options: SweepOptions = {},
): Promise<RecoverySweepResult> {
  const result = emptyResult();
  if (!config.recoveryEnabled || config.recoverySince === null) return result;
  const log = options.log ?? defaultRecoveryLogger;
  const startedAt = Date.now();

  const attemptIds = await selectRecoveryCandidates(pool, config);
  result.selected = attemptIds.length;

  for (const attemptId of attemptIds) {
    if (options.shouldContinue && !options.shouldContinue()) {
      result.stoppedEarly = true;
      break;
    }
    try {
      const outcome = await finalizeAttempt(pool, { mode: 'recovery', attemptId, config, log: options.finalizeLog });
      switch (outcome.kind) {
        case 'scored':
          result.scored += 1;
          break;
        case 'already_scored':
          result.alreadyScored += 1;
          break;
        case 'skipped':
          result.skipped += 1;
          break;
        case 'not_eligible':
          result.notEligible += 1;
          break;
        case 'expired_unscored':
          result.expiredUnscored += 1;
          break;
        default:
          // busy / missing / invalid_responses are candidate-mode outcomes; count as skipped.
          result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      emit(log, { event: 'online_exam.recovery_attempt_failed', attemptId, ...safeErrorFields(error) });
    }
  }

  if (result.selected > 0) {
    emit(log, {
      event: 'online_exam.recovery_sweep',
      trigger: options.trigger ?? 'manual',
      durationMs: Date.now() - startedAt,
      ...result,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scheduler (startup sweep + fixed interval, no overlap within this process)
// ---------------------------------------------------------------------------

export interface OnlineExamRecoveryHandle {
  readonly enabled: boolean;
  /** Runs a sweep now unless one is already running (then resolves null without work). */
  runNow(trigger?: RecoveryTrigger): Promise<RecoverySweepResult | null>;
  /** Resolves when the sweep in progress (if any) has finished. */
  idle(): Promise<void>;
  /** Stops the timer, stops the running sweep between attempts and waits for it. Never rejects. */
  stop(): Promise<void>;
}

export interface RecoverySchedulerOptions {
  log?: RecoveryLogger;
  finalizeLog?: OnlineExamLogger;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DISABLED_HANDLE: OnlineExamRecoveryHandle = Object.freeze({
  enabled: false,
  runNow: async () => null,
  idle: async () => undefined,
  stop: async () => undefined,
});

function settingNameFrom(error: unknown): string | undefined {
  // Config errors start with the setting name and never contain the configured value.
  const match = error instanceof Error ? /^(ONLINE_EXAM_[A-Z_]+)\b/.exec(error.message) : null;
  return match?.[1];
}

/**
 * Starts automatic recovery: one sweep immediately, then one every
 * `config.recoveryIntervalSeconds` (60 by default; 0 disables only the periodic sweep).
 * Returns a disabled handle, with no timer and no database work, when the cutoff is unset
 * or the settings are invalid. Never throws and never rejects.
 */
export function startOnlineExamRecovery(
  pool: FinalizationPool,
  readConfig: () => OnlineExamConfig,
  options: RecoverySchedulerOptions = {},
): OnlineExamRecoveryHandle {
  const log = options.log ?? defaultRecoveryLogger;
  let config: OnlineExamConfig;
  try {
    config = readConfig();
  } catch (error) {
    emit(log, { event: 'online_exam.recovery_disabled', reason: 'invalid_config', setting: settingNameFrom(error) });
    return DISABLED_HANDLE;
  }
  if (!config.recoveryEnabled || config.recoverySince === null) {
    emit(log, { event: 'online_exam.recovery_disabled', reason: 'cutoff_unset' });
    return DISABLED_HANDLE;
  }
  emit(log, {
    event: 'online_exam.recovery_enabled',
    status: 'enabled',
    periodicSweep: config.recoveryIntervalSeconds > 0,
  });

  const setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let running: Promise<RecoverySweepResult | null> | null = null;
  let stopped = false;
  let timer: unknown;

  const runSweep = (trigger: RecoveryTrigger): Promise<RecoverySweepResult | null> => {
    if (stopped) return Promise.resolve(null);
    if (running) {
      emit(log, { event: 'online_exam.recovery_tick_skipped', trigger, reason: 'sweep_running' });
      return Promise.resolve(null);
    }
    const sweep = sweepExpiredAttempts(pool, config, {
      trigger,
      log,
      finalizeLog: options.finalizeLog,
      shouldContinue: () => !stopped,
    })
      .catch((error: unknown): null => {
        emit(log, { event: 'online_exam.recovery_sweep_failed', trigger, ...safeErrorFields(error) });
        return null;
      })
      .finally(() => {
        running = null;
      });
    running = sweep;
    return sweep;
  };

  void runSweep('startup');
  if (config.recoveryIntervalSeconds > 0) {
    timer = setIntervalFn(() => {
      void runSweep('interval');
    }, config.recoveryIntervalSeconds * 1000);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  }

  return {
    enabled: true,
    runNow: (trigger = 'manual') => runSweep(trigger),
    idle: async () => {
      await running;
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) {
        clearIntervalFn(timer);
        timer = undefined;
      }
      await running;
    },
  };
}

// ---------------------------------------------------------------------------
// API lifecycle helpers (used by startApi in index.ts)
// ---------------------------------------------------------------------------

/** The part of an http.Server used here. */
export interface ListeningServer {
  readonly listening?: boolean;
  once(event: 'listening', listener: () => void): unknown;
}

export interface DeferredRecovery {
  /** The running scheduler handle, or null until the server is listening (or if never started). */
  handle(): OnlineExamRecoveryHandle | null;
  /** Prevents a later start and stops the scheduler if it was started. Never rejects. */
  stop(): Promise<void>;
}

/**
 * Starts recovery once, only after the server emits 'listening'. If the server never binds
 * (for example the port is in use), 'listening' never fires and recovery never starts.
 * No 'error' listener is added, so bind failures keep their existing behaviour.
 */
export function startOnlineExamRecoveryWhenListening(
  server: ListeningServer,
  start: () => OnlineExamRecoveryHandle,
): DeferredRecovery {
  let handle: OnlineExamRecoveryHandle | null = null;
  let stopped = false;
  const startOnce = () => {
    if (stopped || handle) return;
    handle = start();
  };
  if (server.listening === true) {
    startOnce();
  } else {
    server.once('listening', startOnce);
  }
  return {
    handle: () => handle,
    stop: async () => {
      stopped = true;
      await handle?.stop();
    },
  };
}

export type ShutdownStep = 'stop_recovery' | 'close_server' | 'end_pool';

export type ShutdownLogEntry =
  | { event: 'api.shutdown_started'; signal: string }
  | { event: 'api.shutdown_step_failed'; step: ShutdownStep; errorClass: string; code?: string };

export interface GracefulShutdownSteps {
  stopRecovery: () => Promise<void>;
  closeServer: () => Promise<void>;
  endPool: () => Promise<void>;
  exit: (code: number) => void;
  log?: (entry: ShutdownLogEntry) => void;
}

const defaultShutdownLogger = (entry: ShutdownLogEntry): void => {
  const line = JSON.stringify(entry);
  if (entry.event === 'api.shutdown_step_failed') console.error(line);
  else console.info(line);
};

/**
 * Returns an idempotent shutdown function. The first call runs, in order: stop recovery
 * (waiting for an in-flight sweep), close the HTTP server, end the pool, then exit
 * (0 on success, 1 if a step failed). Every later call returns the same promise, so repeated
 * SIGINT/SIGTERM never repeat a step. A failing step is logged safely and the remaining steps
 * still run; the returned promise never rejects.
 */
export function createGracefulShutdown(steps: GracefulShutdownSteps): (signal: string) => Promise<void> {
  const log = steps.log ?? defaultShutdownLogger;
  let shutdown: Promise<void> | null = null;

  const safeLog = (entry: ShutdownLogEntry) => {
    try {
      log(entry);
    } catch {
      // Logging must never interrupt shutdown.
    }
  };

  const run = async (signal: string): Promise<void> => {
    safeLog({ event: 'api.shutdown_started', signal });
    let failed = false;
    const sequence: Array<[ShutdownStep, () => Promise<void>]> = [
      ['stop_recovery', steps.stopRecovery],
      ['close_server', steps.closeServer],
      ['end_pool', steps.endPool],
    ];
    for (const [step, action] of sequence) {
      try {
        await action();
      } catch (error) {
        failed = true;
        const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
        safeLog({
          event: 'api.shutdown_step_failed',
          step,
          errorClass: error instanceof Error ? error.name : typeof error,
          code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined,
        });
      }
    }
    try {
      steps.exit(failed ? 1 : 0);
    } catch {
      // exit() does not return in production; in tests it may throw. Never reject.
    }
  };

  return (signal: string) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}

// ---------------------------------------------------------------------------
// Startup: validate online-exam settings before the server listens (P0-4 Phase 5)
// ---------------------------------------------------------------------------

export type StartupLogEntry = {
  event: 'online_exam.config_invalid';
  message: 'Invalid online exam setting. The API was not started.';
  setting?: string;
  /** The validation rule, e.g. "… must be a whole number from 1 to 200." Never the configured value. */
  rule?: string;
};

export interface ApiStartupSteps<S extends ListeningServer> {
  /** Parses and validates the ONLINE_EXAM_* settings; throws on any invalid value. */
  loadOnlineExamConfig: () => OnlineExamConfig;
  checkDatabase: () => Promise<void>;
  /** May return a promise (P1-B: resolves only once every listener is bound). */
  listen: () => S | Promise<S>;
  /** Receives the validated settings, so the scheduler uses the same object as the routes. */
  startRecovery: (config: OnlineExamConfig) => OnlineExamRecoveryHandle;
  log?: (entry: StartupLogEntry) => void;
}

export interface ApiStartupResult<S> {
  server: S;
  config: OnlineExamConfig;
  recovery: DeferredRecovery;
}

const defaultStartupLogger = (entry: StartupLogEntry): void => {
  console.error(JSON.stringify(entry));
};

/** Config errors start with the setting name and state the rule; they never contain the value. */
function configRuleFrom(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /^ONLINE_EXAM_[A-Z_]+ must /.test(error.message) ? error.message : undefined;
}

/**
 * Startup order: validate settings → check the database → listen → start recovery on
 * 'listening'. Invalid settings stop here, before the database is touched or the server
 * listens: one safe log line is written and null is returned (the caller exits non-zero).
 * An unset or empty cutoff is valid and leaves recovery disabled.
 * Database-check errors propagate unchanged to the caller's existing handler.
 */
export async function startApiWithOnlineExamRecovery<S extends ListeningServer>(
  steps: ApiStartupSteps<S>,
): Promise<ApiStartupResult<S> | null> {
  let config: OnlineExamConfig;
  try {
    config = steps.loadOnlineExamConfig();
  } catch (error) {
    const entry: StartupLogEntry = {
      event: 'online_exam.config_invalid',
      message: 'Invalid online exam setting. The API was not started.',
      setting: settingNameFrom(error),
      rule: configRuleFrom(error),
    };
    try {
      (steps.log ?? defaultStartupLogger)(entry);
    } catch {
      // Logging must never change the startup decision.
    }
    return null;
  }
  await steps.checkDatabase();
  const server = await steps.listen();
  const recovery = startOnlineExamRecoveryWhenListening(server, () => steps.startRecovery(config));
  return { server, config, recovery };
}
