// P0-4 Phase 5: startup validation of online-exam settings and the Docker Compose wiring of
// ONLINE_EXAM_RECOVERY_SINCE. No database, no server socket and no Docker: startup steps are
// fakes, the scheduler gets a counting fake pool, and Compose is checked statically as text.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  type FinalizationPool,
  type OnlineExamConfig,
  readOnlineExamConfig,
} from './onlineExamFinalization.js';
import {
  attemptStateParams,
  createGracefulShutdown,
  ONLINE_EXAM_RECOVERY_SQL,
  type RecoveryLogEntry,
  type StartupLogEntry,
  startApiWithOnlineExamRecovery,
  startOnlineExamRecovery,
} from './onlineExamRecovery.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A pool that records connections; the selection query returns no candidates. */
function countingPool() {
  const stats = { connects: 0, selections: [] as unknown[][] };
  const pool: FinalizationPool = {
    async connect() {
      stats.connects += 1;
      return {
        async query(text: string, values: unknown[] = []) {
          if (text === ONLINE_EXAM_RECOVERY_SQL.selectCandidates) stats.selections.push(values);
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  return { pool, stats };
}

function fakeServer() {
  const emitter = new EventEmitter() as EventEmitter & { listening: boolean };
  emitter.listening = false;
  return emitter;
}

interface StartupRun {
  result: Awaited<ReturnType<typeof startApiWithOnlineExamRecovery<ReturnType<typeof fakeServer>>>>;
  order: string[];
  startupLogs: StartupLogEntry[];
  recoveryLogs: RecoveryLogEntry[];
  timers: Array<{ ms: number; cleared: boolean }>;
  server: ReturnType<typeof fakeServer>;
  pool: ReturnType<typeof countingPool>;
  configsSeen: OnlineExamConfig[];
}

/** Runs the real startup helper with the real settings reader against the given environment. */
async function runStartup(env: Record<string, string | undefined>, emitListening = true): Promise<StartupRun> {
  const order: string[] = [];
  const startupLogs: StartupLogEntry[] = [];
  const recoveryLogs: RecoveryLogEntry[] = [];
  const timers: Array<{ ms: number; cleared: boolean }> = [];
  const configsSeen: OnlineExamConfig[] = [];
  const server = fakeServer();
  const pool = countingPool();
  const result = await startApiWithOnlineExamRecovery({
    loadOnlineExamConfig: () => {
      order.push('loadConfig');
      return readOnlineExamConfig(env, NOW);
    },
    checkDatabase: async () => {
      order.push('checkDatabase');
    },
    listen: () => {
      order.push('listen');
      return server;
    },
    startRecovery: (config) => {
      order.push('startRecovery');
      configsSeen.push(config);
      return startOnlineExamRecovery(pool.pool, () => config, {
        log: (entry) => { recoveryLogs.push(entry); },
        finalizeLog: () => {},
        setInterval: (_callback, ms) => {
          const timer = { ms, cleared: false };
          timers.push(timer);
          return timer;
        },
        clearInterval: (handle) => { (handle as { cleared: boolean }).cleared = true; },
      });
    },
    log: (entry) => { startupLogs.push(entry); },
  });
  if (emitListening && result) {
    server.listening = true;
    server.emit('listening');
    await result.recovery.handle()?.idle();
  }
  return { result, order, startupLogs, recoveryLogs, timers, server, pool, configsSeen };
}

async function expectStartedWithoutRecovery(env: Record<string, string | undefined>) {
  const run = await runStartup(env);
  assert.ok(run.result, 'API starts');
  assert.deepEqual(run.order, ['loadConfig', 'checkDatabase', 'listen', 'startRecovery']);
  assert.equal(run.result.config.recoveryEnabled, false);
  assert.equal(run.result.recovery.handle()?.enabled, false);
  assert.equal(run.timers.length, 0, 'no periodic timer');
  assert.equal(run.pool.stats.connects, 0, 'no recovery database work');
  assert.deepEqual(run.recoveryLogs, [{ event: 'online_exam.recovery_disabled', reason: 'cutoff_unset' }]);
  assert.deepEqual(run.startupLogs, []);
  await run.result.recovery.stop();
}

async function expectStartedWithRecovery(env: Record<string, string | undefined>, cutoff: string) {
  const run = await runStartup(env);
  assert.ok(run.result, 'API starts');
  assert.equal(run.result.config.recoveryEnabled, true);
  assert.equal(run.result.config.recoverySince, cutoff, 'cutoff text kept exactly');
  assert.equal(run.result.recovery.handle()?.enabled, true);
  assert.equal(run.pool.stats.selections.length, 1, 'one startup sweep after listening');
  assert.deepEqual(run.pool.stats.selections[0], [cutoff, 30, 50]);
  assert.deepEqual(run.recoveryLogs[0], { event: 'online_exam.recovery_enabled', status: 'enabled', periodicSweep: true });
  assert.equal(JSON.stringify([...run.recoveryLogs, ...run.startupLogs]).includes(cutoff), false, 'cutoff never logged');
  await run.result.recovery.stop();
  return run;
}

/** Every rule text a setting can produce, obtained from canonical invalid values unrelated to the tests. */
function fixedRules(setting: string): string[] {
  const canonical = setting === 'ONLINE_EXAM_RECOVERY_SINCE' ? ['#invalid#', '2099-01-01T00:00:00Z'] : ['#invalid#'];
  return canonical.map((value) => {
    try {
      readOnlineExamConfig({ [setting]: value }, NOW);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  });
}

async function expectRejected(env: Record<string, string | undefined>, setting: string, rawValue: string) {
  const run = await runStartup(env);
  assert.equal(run.result, null, `${setting}=${rawValue} must stop startup`);
  assert.deepEqual(run.order, ['loadConfig'], 'no database check, no listen, no recovery');
  assert.equal(run.pool.stats.connects, 0);
  assert.equal(run.startupLogs.length, 1);
  const entry = run.startupLogs[0];
  assert.equal(entry.event, 'online_exam.config_invalid');
  assert.equal(entry.message, 'Invalid online exam setting. The API was not started.');
  assert.equal(entry.setting, setting);
  assert.ok(entry.rule?.startsWith(`${setting} must `), 'the rule is stated');
  assert.deepEqual(Object.keys(entry).sort(), ['event', 'message', 'rule', 'setting']);
  // The rule is one of the setting's fixed rule texts (generated from canonical invalid values), so the
  // configured value cannot be in it. Short values such as "0" may still occur inside a rule's own
  // numbers (e.g. "200"), which is why the substring check below excludes the rule.
  assert.ok(fixedRules(setting).includes(entry.rule ?? ''), `rule is a fixed text: ${entry.rule}`);
  const { rule: _rule, ...rest } = entry;
  assert.equal(JSON.stringify(rest).includes(rawValue), false, 'the configured value is never logged');
}

// ---------------------------------------------------------------------------
// 1–4: unset, empty and valid cutoffs
// ---------------------------------------------------------------------------

test('1. cutoff unset → API starts, recovery disabled, no timer, no recovery database work', async () => {
  await expectStartedWithoutRecovery({});
});

test('2. cutoff empty string → same as unset (recovery disabled)', async () => {
  await expectStartedWithoutRecovery({ ONLINE_EXAM_RECOVERY_SINCE: '' });
});

test('3. valid UTC cutoff → recovery enabled with the exact cutoff', async () => {
  await expectStartedWithRecovery({ ONLINE_EXAM_RECOVERY_SINCE: '2026-11-01T00:00:00Z' }, '2026-11-01T00:00:00Z');
});

test('4. valid non-UTC offsets (+05:30, -08:00, +14:00, -12:00) → recovery enabled', async () => {
  for (const cutoff of ['2026-11-01T05:30:00+05:30', '2026-10-31T16:00:00-08:00', '2026-11-01T14:00:00+14:00', '2026-10-31T12:00:00-12:00']) {
    await expectStartedWithRecovery({ ONLINE_EXAM_RECOVERY_SINCE: cutoff }, cutoff);
  }
});

// ---------------------------------------------------------------------------
// 5–8: invalid cutoffs stop startup before listening
// ---------------------------------------------------------------------------

const SINCE = 'ONLINE_EXAM_RECOVERY_SINCE';

test('5. invalid date text → startup rejected before the database check and listen', async () => {
  for (const value of ['not-a-date', '2026-11-01', '2026/11/01T00:00:00Z', ' 2026-11-01T00:00:00Z', 'yesterday']) {
    await expectRejected({ [SINCE]: value }, SINCE, value);
  }
});

test('6. missing or out-of-range timezone offset → startup rejected', async () => {
  for (const value of ['2026-11-01T00:00:00', '2026-11-01T00:00:00+14:01', '2026-11-01T00:00:00-12:01', '2026-11-01T00:00:00+16:00', '2026-11-01T00:00:00+0530', '2026-11-01T00:00:00+05:60']) {
    await expectRejected({ [SINCE]: value }, SINCE, value);
  }
});

test('7. invalid calendar date or time → startup rejected', async () => {
  for (const value of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-04-31T00:00:00Z', '2026-11-01T24:00:00Z', '2026-11-01T00:00:60Z']) {
    await expectRejected({ [SINCE]: value }, SINCE, value);
  }
});

test('8. invalid year, fractional precision or a cutoff too far in the future → startup rejected', async () => {
  for (const value of ['1999-12-31T23:59:59Z', '0050-01-01T00:00:00Z', '2026-11-01T00:00:00.1234567Z', '2026-11-03T12:05:01Z']) {
    await expectRejected({ [SINCE]: value }, SINCE, value);
  }
  // Boundaries that remain valid: year 2000, six fractional digits, exactly 5 minutes ahead.
  for (const value of ['2000-01-01T00:00:00Z', '2026-11-01T00:00:00.123456Z', '2026-11-03T12:05:00Z']) {
    await expectStartedWithRecovery({ [SINCE]: value }, value);
  }
});

// ---------------------------------------------------------------------------
// 9–11: numeric settings
// ---------------------------------------------------------------------------

test('9. invalid recovery interval → startup rejected (malformed, fractional, negative, out of range)', async () => {
  const name = 'ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS';
  for (const value of ['1.5', '-1', '3601', '60s', ' 60', '1e2', 'sixty']) {
    await expectRejected({ [SINCE]: '2026-11-01T00:00:00Z', [name]: value }, name, value);
  }
  for (const value of ['3601']) await expectRejected({ [name]: value }, name, value);
});

test('10. interval 0 → startup-only recovery: one startup sweep, no periodic timer', async () => {
  const run = await runStartup({ [SINCE]: '2026-11-01T00:00:00Z', ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS: '0' });
  assert.ok(run.result);
  assert.equal(run.result.config.recoveryIntervalSeconds, 0);
  assert.equal(run.pool.stats.selections.length, 1, 'startup sweep ran');
  assert.equal(run.timers.length, 0, 'no periodic timer');
  assert.deepEqual(run.recoveryLogs[0], { event: 'online_exam.recovery_enabled', status: 'enabled', periodicSweep: false });
  await run.result.recovery.stop();
});

test('11. invalid batch size → startup rejected; defaults and bounds preserved', async () => {
  const name = 'ONLINE_EXAM_RECOVERY_BATCH';
  for (const value of ['0', '201', '2.5', '-5', '1e1', '50 ']) {
    await expectRejected({ [SINCE]: '2026-11-01T00:00:00Z', [name]: value }, name, value);
  }
  const defaults = readOnlineExamConfig({}, NOW);
  assert.deepEqual(
    [defaults.submitGraceSeconds, defaults.recoveryIntervalSeconds, defaults.recoveryBatch, defaults.lockTimeoutMs],
    [30, 60, 50, 5000],
    'accepted defaults unchanged (30 s grace, 60 s interval, batch 50, 5 s lock timeout)',
  );
  for (const [settingName, value] of [['ONLINE_EXAM_SUBMIT_GRACE_SECONDS', '121'], ['ONLINE_EXAM_LOCK_TIMEOUT_MS', '99']] as const) {
    await expectRejected({ [settingName]: value }, settingName, value);
  }
});

// ---------------------------------------------------------------------------
// 12–13: Docker Compose wiring (static; no Docker command is run)
// ---------------------------------------------------------------------------

const composeText = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');

function serviceBlock(name: string): string {
  const start = composeText.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} exists`);
  const rest = composeText.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n|\n[a-z]/);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
}

/** Compose-style interpolation for the forms used in this file: ${V}, ${V:-default}, ${V:?message}. */
function interpolate(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::([-?])([^}]*))?\}/g, (_match, name: string, operator?: string, operand?: string) => {
    const current = env[name];
    if (operator === '-') return current === undefined || current === '' ? (operand ?? '') : current;
    if (operator === '?' && (current === undefined || current === '')) throw new Error(`required: ${name}`);
    return current ?? '';
  });
}

test('12. Compose: api_public (the recovery owner) passes ONLINE_EXAM_RECOVERY_SINCE with an empty default; unset → recovery disabled', async () => {
  // P1-D.2: recovery is owned by the public instance; api_admin must never receive the setting.
  assert.doesNotMatch(serviceBlock('api_admin').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n'), /ONLINE_EXAM_RECOVERY_SINCE/);
  const app = serviceBlock('api_public');
  const line = app.split('\n').find((entry) => entry.trim().startsWith('ONLINE_EXAM_RECOVERY_SINCE:'));
  assert.equal(line?.trim(), 'ONLINE_EXAM_RECOVERY_SINCE: ${ONLINE_EXAM_RECOVERY_SINCE:-}');
  assert.ok(app.indexOf('ONLINE_EXAM_RECOVERY_SINCE:') > app.indexOf('environment:'), 'inside the app environment');
  assert.ok(app.indexOf('ONLINE_EXAM_RECOVERY_SINCE:') < app.indexOf('command:'), 'inside the app environment');
  const value = (line ?? '').split(': ').slice(1).join(': ');
  // Host variable unset → the container receives an empty string → recovery disabled.
  const containerValue = interpolate(value, {});
  assert.equal(containerValue, '');
  await expectStartedWithoutRecovery({ ONLINE_EXAM_RECOVERY_SINCE: containerValue });
  // Host variable set → passed through unchanged.
  assert.equal(interpolate(value, { ONLINE_EXAM_RECOVERY_SINCE: '2026-11-01T05:30:00+05:30' }), '2026-11-01T05:30:00+05:30');
});

test('13. Compose: no hardcoded cutoff, no other online-exam overrides, other services untouched', () => {
  const settingLines = composeText.split('\n').filter((line) => line.includes('ONLINE_EXAM_'));
  assert.deepEqual(settingLines.map((line) => line.trim()).filter((line) => !line.startsWith('#')), [
    'ONLINE_EXAM_RECOVERY_SINCE: ${ONLINE_EXAM_RECOVERY_SINCE:-}',
  ], 'exactly one online-exam setting; grace, interval, batch and lock timeout keep their built-in defaults');
  const nonComment = composeText.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(nonComment, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no hardcoded date-time outside comments');
  for (const service of ['postgres', 'nginx_public', 'nginx_admin', 'api_admin', 'migrate']) {
    const active = serviceBlock(service).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(active, /ONLINE_EXAM_/, `${service} receives no online-exam setting`);
  }
});

// ---------------------------------------------------------------------------
// 14–17: startup ordering, consistency and Phase 4 lifecycle
// ---------------------------------------------------------------------------

test('14. invalid settings are rejected before the database is checked or the server listens', async () => {
  let listened = false;
  let checkedDatabase = false;
  const logs: StartupLogEntry[] = [];
  const result = await startApiWithOnlineExamRecovery({
    loadOnlineExamConfig: () => readOnlineExamConfig({ ONLINE_EXAM_RECOVERY_SINCE: 'SECRET-LOOKING-VALUE' }, NOW),
    checkDatabase: async () => { checkedDatabase = true; },
    listen: () => { listened = true; return fakeServer(); },
    startRecovery: () => { throw new Error('must not start'); },
    log: (entry) => { logs.push(entry); },
  });
  assert.equal(result, null);
  assert.equal(checkedDatabase, false);
  assert.equal(listened, false);
  assert.equal(JSON.stringify(logs).includes('SECRET-LOOKING-VALUE'), false);
  assert.equal(logs[0].setting, 'ONLINE_EXAM_RECOVERY_SINCE');
});

test('14b. a database-check failure still propagates (existing startup error path) and nothing listens', async () => {
  let listened = false;
  await assert.rejects(startApiWithOnlineExamRecovery({
    loadOnlineExamConfig: () => readOnlineExamConfig({}, NOW),
    checkDatabase: async () => { throw new Error('connect ECONNREFUSED'); },
    listen: () => { listened = true; return fakeServer(); },
    startRecovery: () => { throw new Error('must not start'); },
    log: () => {},
  }), /ECONNREFUSED/);
  assert.equal(listened, false);
});

test('15. cutoff unset → the API starts and serves, with no recovery timer or database work', async () => {
  const run = await runStartup({ ONLINE_EXAM_RECOVERY_SINCE: undefined });
  assert.ok(run.result);
  assert.deepEqual(run.order, ['loadConfig', 'checkDatabase', 'listen', 'startRecovery']);
  assert.equal(run.timers.length, 0);
  assert.equal(run.pool.stats.connects, 0);
  await run.result.recovery.stop();
});

test('16. the scheduler, the attempt list and the routes use the same validated settings object', async () => {
  const run = await runStartup({ [SINCE]: '2026-11-01T05:30:00+05:30', ONLINE_EXAM_RECOVERY_BATCH: '25' });
  assert.ok(run.result);
  assert.equal(run.configsSeen.length, 1);
  assert.equal(run.configsSeen[0], run.result.config, 'scheduler receives the exact validated object');
  // The list query and the recovery selection use the same cutoff and grace.
  const [, listGrace, listCutoff] = attemptStateParams('user-1', run.result.config);
  const [selectionCutoff, selectionGrace, selectionBatch] = run.pool.stats.selections[0];
  assert.deepEqual([listCutoff, listGrace], [selectionCutoff, selectionGrace]);
  assert.deepEqual([selectionCutoff, selectionGrace, selectionBatch], ['2026-11-01T05:30:00+05:30', 30, 25]);
  // Recovery off → the list never shows "pending", matching the disabled scheduler.
  const off = await runStartup({});
  assert.ok(off.result);
  assert.equal(attemptStateParams('user-1', off.result.config)[2], null);
  await run.result.recovery.stop();
  await off.result.recovery.stop();
});

test('17. Phase 4 lifecycle intact: recovery waits for listening; shutdown stops it once, before server and pool', async () => {
  const run = await runStartup({ [SINCE]: '2026-11-01T00:00:00Z' }, false);
  assert.ok(run.result);
  assert.deepEqual(run.order, ['loadConfig', 'checkDatabase', 'listen'], 'not started before listening');
  assert.equal(run.result.recovery.handle(), null);
  run.server.listening = true;
  run.server.emit('listening');
  run.server.emit('listening');
  await run.result.recovery.handle()?.idle();
  assert.equal(run.order.filter((step) => step === 'startRecovery').length, 1, 'started exactly once');
  assert.equal(run.timers.length, 1);

  const steps: string[] = [];
  const exits: number[] = [];
  const result = run.result;
  const shutdown = createGracefulShutdown({
    stopRecovery: async () => { await result.recovery.stop(); steps.push('stopRecovery'); },
    closeServer: async () => { steps.push('closeServer'); },
    endPool: async () => { steps.push('endPool'); },
    exit: (code) => { exits.push(code); },
    log: () => {},
  });
  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);
  assert.deepEqual(steps, ['stopRecovery', 'closeServer', 'endPool']);
  assert.deepEqual(exits, [0]);
  assert.equal(run.timers[0].cleared, true, 'periodic timer cleared');
});
