// P1-B two-listener lifecycle unit tests.
//
// Servers are EventEmitter fakes: listen() schedules a 'listening' or 'error' event and close()
// records the call. No socket is bound and no database is used. These tests prove the startup and
// shutdown ordering of the code, not real network behaviour.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  closeListeners,
  createTwoListenerShutdown,
  ListenerRuntimeError,
  ListenerStartupError,
  NO_RECOVERY_HANDLE,
  resolveActiveListeners,
  startApiListeners,
  startApiRuntime,
  startListeners,
  type ListenerSpec,
} from './apiListeners.js';
import type { OnlineExamConfig } from './onlineExamFinalization.js';
import type { OnlineExamRecoveryHandle } from './onlineExamRecovery.js';

const SPECS: ListenerSpec[] = [
  { name: 'public', port: 4000, host: '0.0.0.0' },
  { name: 'admin', port: 4001, host: '0.0.0.0' },
];

class FakeServer extends EventEmitter {
  listenCalls: Array<{ port: number; host: string }> = [];
  closeCalls = 0;
  bound = false;
  constructor(readonly name: string, readonly log: string[], readonly failWith?: string, readonly closeError?: Error, readonly errorAfterListen?: string) {
    super();
  }
  listen(port: number, host: string) {
    this.listenCalls.push({ port, host });
    this.log.push(`listen:${this.name}`);
    setImmediate(() => {
      if (this.failWith) {
        this.emit('error', Object.assign(new Error('bind failed'), { code: this.failWith }));
      } else {
        this.bound = true;
        this.log.push(`listening:${this.name}`);
        this.emit('listening');
        if (this.errorAfterListen) {
          setImmediate(() => this.emit('error', Object.assign(new Error('runtime failure'), { code: this.errorAfterListen })));
        }
      }
    });
    return this;
  }
  close(callback: (error?: Error) => void) {
    this.closeCalls += 1;
    this.log.push(`close:${this.name}`);
    setImmediate(() => callback(this.closeError));
    return this;
  }
}

function harness(options: {
  fail?: Partial<Record<'public' | 'admin', string>>;
  closeError?: Partial<Record<'public' | 'admin', Error>>;
  errorAfterListen?: Partial<Record<'public' | 'admin', string>>;
} = {}) {
  const log: string[] = [];
  const servers = new Map<string, FakeServer>();
  const createServer = (spec: ListenerSpec) => {
    const server = new FakeServer(spec.name, log, options.fail?.[spec.name], options.closeError?.[spec.name], options.errorAfterListen?.[spec.name]);
    servers.set(spec.name, server);
    return server;
  };
  return { log, servers, createServer };
}

const EXAM_CONFIG = Object.freeze({}) as OnlineExamConfig;

function recoveryHarness(log: string[]) {
  let starts = 0;
  let stops = 0;
  const handle: OnlineExamRecoveryHandle = {
    stop: async () => {
      stops += 1;
      log.push('recovery:stop');
    },
  } as unknown as OnlineExamRecoveryHandle;
  return {
    startRecovery: (config: OnlineExamConfig) => {
      assert.equal(config, EXAM_CONFIG, 'recovery receives the validated settings object');
      starts += 1;
      log.push('recovery:start');
      return handle;
    },
    starts: () => starts,
    stops: () => stops,
  };
}

test('both listeners bind in order and are returned by name', async () => {
  const { log, servers, createServer } = harness();
  const result = await startListeners(SPECS, createServer);
  assert.deepEqual([...result.keys()], ['public', 'admin']);
  assert.deepEqual(servers.get('public')!.listenCalls, [{ port: 4000, host: '0.0.0.0' }]);
  assert.deepEqual(servers.get('admin')!.listenCalls, [{ port: 4001, host: '0.0.0.0' }]);
  assert.deepEqual(log, ['listen:public', 'listening:public', 'listen:admin', 'listening:admin']);
});

test('first listener bind failure: startup fails and the second listener is never attempted', async () => {
  const { log, servers, createServer } = harness({ fail: { public: 'EADDRINUSE' } });
  await assert.rejects(startListeners(SPECS, createServer), (error: unknown) => {
    assert.ok(error instanceof ListenerStartupError);
    assert.equal(error.listener, 'public');
    assert.equal(error.code, 'EADDRINUSE');
    return true;
  });
  assert.equal(servers.has('admin'), false);
  assert.deepEqual(log, ['listen:public']);
});

test('second listener bind failure: the first (bound) listener is closed and startup fails', async () => {
  const { log, servers, createServer } = harness({ fail: { admin: 'EACCES' } });
  await assert.rejects(startListeners(SPECS, createServer), (error: unknown) => error instanceof ListenerStartupError && error.listener === 'admin' && error.code === 'EACCES');
  assert.equal(servers.get('public')!.closeCalls, 1, 'the bound public listener is closed');
  assert.equal(servers.get('admin')!.closeCalls, 0, 'the failed listener never bound');
  assert.deepEqual(log, ['listen:public', 'listening:public', 'listen:admin', 'close:public']);
});

test('listener specs must have unique names and ports', async () => {
  const { createServer } = harness();
  await assert.rejects(startListeners([SPECS[0], { ...SPECS[1], port: 4000 }], createServer), /unique/);
  await assert.rejects(startListeners([SPECS[0], { ...SPECS[1], name: 'public' }], createServer), /unique/);
});

test('startup: readiness and recovery happen exactly once, only after both listeners are bound', async () => {
  const { log, servers, createServer } = harness();
  const recovery = recoveryHarness(log);
  let readyCalls = 0;
  const result = await startApiListeners({
    specs: SPECS,
    createServer,
    loadOnlineExamConfig: () => EXAM_CONFIG,
    checkDatabase: async () => {
      log.push('database:check');
    },
    startRecovery: recovery.startRecovery,
    markNotReady: () => undefined,
    markReady: () => {
      readyCalls += 1;
      log.push('ready');
    },
  });
  assert.ok(result);
  assert.equal(readyCalls, 1);
  assert.equal(recovery.starts(), 1);
  assert.deepEqual(log, ['database:check', 'listen:public', 'listening:public', 'listen:admin', 'listening:admin', 'ready', 'recovery:start']);
  assert.equal(result.servers.get('public'), servers.get('public'));
  assert.equal(result.servers.get('admin'), servers.get('admin'));
  assert.equal(result.config, EXAM_CONFIG);
  assert.notEqual(result.recovery.handle(), null);
  // Nothing re-triggers recovery later.
  servers.get('public')!.emit('listening');
  servers.get('admin')!.emit('listening');
  assert.equal(recovery.starts(), 1);
});

for (const failing of ['public', 'admin'] as const) {
  test(`startup: ${failing} bind failure → no readiness, no recovery, every bound listener closed`, async () => {
    const { log, servers, createServer } = harness({ fail: { [failing]: 'EADDRINUSE' } });
    const recovery = recoveryHarness(log);
    let readyCalls = 0;
    await assert.rejects(startApiListeners({
      specs: SPECS,
      createServer,
      loadOnlineExamConfig: () => EXAM_CONFIG,
      checkDatabase: async () => undefined,
      startRecovery: recovery.startRecovery,
      markNotReady: () => undefined,
      markReady: () => {
        readyCalls += 1;
      },
    }), ListenerStartupError);
    assert.equal(readyCalls, 0, 'health stays 503: readiness is never reported');
    assert.equal(recovery.starts(), 0, 'recovery never starts on partial startup');
    for (const server of servers.values()) {
      if (server.bound) assert.equal(server.closeCalls, 1, `${server.name} closed`);
    }
    assert.ok(!log.includes('recovery:start'));
  });
}

test('startup: invalid online-exam settings stop before the database check and any bind', async () => {
  const { log, servers, createServer } = harness();
  const recovery = recoveryHarness(log);
  const entries: unknown[] = [];
  const result = await startApiListeners({
    specs: SPECS,
    createServer,
    loadOnlineExamConfig: () => {
      throw new Error('ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS must be a whole number from 0 to 86400.');
    },
    checkDatabase: async () => {
      log.push('database:check');
    },
    startRecovery: recovery.startRecovery,
    markNotReady: () => undefined,
    markReady: () => log.push('ready'),
    log: (entry) => entries.push(entry),
  });
  assert.equal(result, null);
  assert.equal(servers.size, 0);
  assert.deepEqual(log, []);
  assert.equal(entries.length, 1);
});

test('startup: a failed database check binds nothing', async () => {
  const { servers, createServer } = harness();
  const recovery = recoveryHarness([]);
  await assert.rejects(startApiListeners({
    specs: SPECS,
    createServer,
    loadOnlineExamConfig: () => EXAM_CONFIG,
    checkDatabase: async () => {
      throw new Error('database unavailable');
    },
    startRecovery: recovery.startRecovery,
    markNotReady: () => undefined,
    markReady: () => undefined,
  }), /database unavailable/);
  assert.equal(servers.size, 0);
  assert.equal(recovery.starts(), 0);
});

test('shutdown: recovery stops, then both listeners close, then the pool ends; repeated signals reuse it', async () => {
  const { log, createServer } = harness();
  const recovery = recoveryHarness(log);
  const started = await startApiListeners({
    specs: SPECS,
    createServer,
    loadOnlineExamConfig: () => EXAM_CONFIG,
    checkDatabase: async () => undefined,
    startRecovery: recovery.startRecovery,
    markNotReady: () => undefined,
    markReady: () => undefined,
  });
  assert.ok(started);
  log.length = 0;
  const exits: number[] = [];
  let poolEnds = 0;
  const shutdown = createTwoListenerShutdown({
    recovery: started.recovery,
    servers: started.servers,
    endPool: async () => {
      poolEnds += 1;
      log.push('pool:end');
    },
    exit: (code) => {
      exits.push(code);
    },
    log: () => undefined,
  });
  const first = shutdown('SIGTERM');
  const second = shutdown('SIGINT');
  assert.equal(first, second, 'one shutdown promise');
  await Promise.all([first, second, shutdown('SIGTERM')]);
  assert.deepEqual(log, ['recovery:stop', 'close:public', 'close:admin', 'pool:end']);
  assert.equal(recovery.stops(), 1);
  assert.equal(poolEnds, 1);
  assert.deepEqual(exits, [0]);
});

test('shutdown: a listener close failure still closes the other listener and ends the pool (exit 1)', async () => {
  const { log, createServer } = harness({ closeError: { public: Object.assign(new Error('close failed'), { code: 'ERR_SERVER_NOT_RUNNING' }) } });
  const recovery = recoveryHarness(log);
  const started = await startApiListeners({
    specs: SPECS,
    createServer,
    loadOnlineExamConfig: () => EXAM_CONFIG,
    checkDatabase: async () => undefined,
    startRecovery: recovery.startRecovery,
    markNotReady: () => undefined,
    markReady: () => undefined,
  });
  assert.ok(started);
  log.length = 0;
  const exits: number[] = [];
  const logged: unknown[] = [];
  await createTwoListenerShutdown({
    recovery: started.recovery,
    servers: started.servers,
    endPool: async () => {
      log.push('pool:end');
    },
    exit: (code) => {
      exits.push(code);
    },
    log: (entry) => logged.push(entry),
  })('SIGTERM');
  assert.deepEqual(log, ['recovery:stop', 'close:public', 'close:admin', 'pool:end']);
  assert.deepEqual(exits, [1]);
  assert.ok(logged.some((entry) => JSON.stringify(entry).includes('close_server')));
});

test('closeListeners attempts every listener before reporting the first error', async () => {
  const log: string[] = [];
  const failing = new FakeServer('public', log, undefined, new Error('first'));
  const healthy = new FakeServer('admin', log);
  await assert.rejects(closeListeners([failing, healthy]), /first/);
  assert.equal(healthy.closeCalls, 1);
});

// ---------------------------------------------------------------------------
// L-1: persistent listener error handling, cleanup and readiness
// ---------------------------------------------------------------------------

function readiness() {
  const states: boolean[] = [];
  return {
    markReady: () => { states.push(true); },
    markNotReady: () => { states.push(false); },
    current: () => states.at(-1) ?? false,
    states,
  };
}

test('L-1: a persistent error handler stays attached after each successful bind', async () => {
  const { servers, createServer } = harness();
  const reported: ListenerRuntimeError[] = [];
  await startListeners(SPECS, createServer, (error) => reported.push(error));
  for (const name of ['public', 'admin']) {
    assert.equal(servers.get(name)!.listenerCount('error'), 1, `${name}: one persistent handler`);
    assert.equal(servers.get(name)!.listenerCount('listening'), 0, `${name}: startup listeners removed`);
  }
  assert.doesNotThrow(() => servers.get('admin')!.emit('error', Object.assign(new Error('x'), { code: 'ECONNRESET' })));
  assert.equal(reported.length, 1);
  assert.ok(reported[0] instanceof ListenerRuntimeError);
  assert.equal(reported[0].listener, 'admin');
  assert.equal(reported[0].code, 'ECONNRESET');
  // A throwing reporter cannot turn an 'error' event into an exception.
  const second = harness();
  await startListeners(SPECS, second.createServer, () => { throw new Error('reporter failed'); });
  assert.doesNotThrow(() => second.servers.get('public')!.emit('error', new Error('y')));
});

test('L-1: error before the first bind → no readiness, nothing to close', async () => {
  const { servers, createServer } = harness({ fail: { public: 'EADDRINUSE' } });
  const ready = readiness();
  const recovery = recoveryHarness([]);
  await assert.rejects(startApiListeners({
    specs: SPECS, createServer, loadOnlineExamConfig: () => EXAM_CONFIG, checkDatabase: async () => undefined,
    startRecovery: recovery.startRecovery, markReady: ready.markReady, markNotReady: ready.markNotReady,
  }), ListenerStartupError);
  assert.equal(ready.current(), false);
  assert.deepEqual(ready.states, [false]);
  assert.equal(servers.get('public')!.closeCalls, 0);
  assert.equal(servers.has('admin'), false);
  assert.equal(recovery.starts(), 0);
});

test('L-1: a listener error after its bind but during startup aborts startup; both listeners are closed', async () => {
  const { log, servers, createServer } = harness({ errorAfterListen: { public: 'ECONNABORTED' } });
  const ready = readiness();
  const recovery = recoveryHarness(log);
  await assert.rejects(startApiListeners({
    specs: SPECS, createServer, loadOnlineExamConfig: () => EXAM_CONFIG, checkDatabase: async () => undefined,
    startRecovery: recovery.startRecovery, markReady: ready.markReady, markNotReady: ready.markNotReady,
  }), (error: unknown) => error instanceof ListenerRuntimeError && error.listener === 'public');
  assert.equal(recovery.starts(), 0, 'recovery never starts on partial startup');
  assert.ok(!ready.states.includes(true), 'never reported ready');
  assert.equal(ready.current(), false);
  for (const name of ['public', 'admin']) assert.equal(servers.get(name)!.closeCalls, 1, `${name} closed`);
});

test('L-1: a failure after both binds but before startup completes closes both listeners and resets readiness', async () => {
  const { log, servers, createServer } = harness();
  const ready = readiness();
  await assert.rejects(startApiListeners({
    specs: SPECS, createServer, loadOnlineExamConfig: () => EXAM_CONFIG, checkDatabase: async () => undefined,
    startRecovery: () => { throw new Error('recovery could not start'); },
    markReady: ready.markReady, markNotReady: ready.markNotReady,
  }), /recovery could not start/);
  assert.deepEqual(ready.states, [true, false], 'ready after both binds, then reset on the failure');
  assert.equal(ready.current(), false);
  assert.equal(servers.get('public')!.closeCalls, 1);
  assert.equal(servers.get('admin')!.closeCalls, 1);
  assert.deepEqual(log.slice(-2).sort(), ['close:admin', 'close:public']);
});

test('L-1: second bind failure (via the runtime) → first listener closed, not ready, no recovery, no shutdown', async () => {
  const { servers, createServer } = harness({ fail: { admin: 'EADDRINUSE' } });
  const ready = readiness();
  const recovery = recoveryHarness([]);
  let exits = 0;
  await assert.rejects(startApiRuntime({
    specs: SPECS, createServer, loadOnlineExamConfig: () => EXAM_CONFIG, checkDatabase: async () => undefined,
    startRecovery: recovery.startRecovery, markReady: ready.markReady, markNotReady: ready.markNotReady,
    endPool: async () => undefined, exit: () => { exits += 1; },
  }), ListenerStartupError);
  assert.equal(servers.get('public')!.closeCalls, 1);
  assert.equal(ready.current(), false);
  assert.equal(recovery.starts(), 0);
  assert.equal(exits, 0, 'startup failure is reported by the caller, not by the shutdown path');
});

test('L-1: a listener error after both are ready triggers the graceful shutdown exactly once (exit 1)', async () => {
  const { log, servers, createServer } = harness();
  const ready = readiness();
  const recovery = recoveryHarness(log);
  const exits: number[] = [];
  let poolEnds = 0;
  const fatalLogs: unknown[] = [];
  const runtime = await startApiRuntime({
    specs: SPECS, createServer, loadOnlineExamConfig: () => EXAM_CONFIG, checkDatabase: async () => undefined,
    startRecovery: recovery.startRecovery, markReady: ready.markReady, markNotReady: ready.markNotReady,
    endPool: async () => { poolEnds += 1; log.push('pool:end'); },
    exit: (code) => { exits.push(code); },
    shutdownLog: () => undefined,
    onFatalListenerError: (entry) => fatalLogs.push(entry),
  });
  assert.ok(runtime);
  assert.equal(ready.current(), true);
  assert.equal(recovery.starts(), 1);
  log.length = 0;
  const failure = Object.assign(new Error('socket failure'), { code: 'EMFILE' });
  servers.get('admin')!.emit('error', failure);
  servers.get('public')!.emit('error', failure); // a second failure must not start a second shutdown
  assert.equal(ready.current(), false, 'not ready immediately after the failure');
  const signalled = runtime.shutdown('SIGTERM'); // a signal during the failure shutdown reuses it
  await signalled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['recovery:stop', 'close:public', 'close:admin', 'pool:end'], 'order preserved');
  assert.equal(recovery.stops(), 1);
  assert.equal(poolEnds, 1);
  assert.deepEqual(exits, [1], 'one exit, non-zero after a listener failure');
  assert.deepEqual(fatalLogs, [{ event: 'api.listener_failed', listener: 'admin', code: 'EMFILE' }], 'logged once, code only');
  assert.equal(runtime.shutdown('SIGINT'), signalled, 'repeated calls reuse one shutdown operation');
});

test('L-1: a normal signal shutdown exits 0, resets readiness and keeps the order', async () => {
  const { log, createServer } = harness();
  const ready = readiness();
  const recovery = recoveryHarness(log);
  const exits: number[] = [];
  const runtime = await startApiRuntime({
    specs: SPECS, createServer, loadOnlineExamConfig: () => EXAM_CONFIG, checkDatabase: async () => undefined,
    startRecovery: recovery.startRecovery, markReady: ready.markReady, markNotReady: ready.markNotReady,
    endPool: async () => { log.push('pool:end'); },
    exit: (code) => { exits.push(code); },
    shutdownLog: () => undefined,
  });
  assert.ok(runtime);
  log.length = 0;
  const first = runtime.shutdown('SIGTERM');
  assert.equal(runtime.shutdown('SIGINT'), first);
  await first;
  assert.equal(ready.current(), false);
  assert.deepEqual(log, ['recovery:stop', 'close:public', 'close:admin', 'pool:end']);
  assert.deepEqual(exits, [0]);
});

// ---------------------------------------------------------------------------
// P1-D.2: listener selection and recovery ownership (pure validation)
// ---------------------------------------------------------------------------

test('listener selection: exactly public or admin per instance; both only in development; canonical order', () => {
  assert.deepEqual(resolveActiveListeners({ ELTNOY_API_LISTENERS: 'public' }, 'production'), { ok: true, listeners: ['public'] });
  assert.deepEqual(resolveActiveListeners({ ELTNOY_API_LISTENERS: 'admin' }, 'staging'), { ok: true, listeners: ['admin'] });
  assert.deepEqual(resolveActiveListeners({ ELTNOY_API_LISTENERS: ' admin , public ' }, 'development'), { ok: true, listeners: ['public', 'admin'] });
  for (const mode of ['production', 'staging'] as const) {
    assert.equal(resolveActiveListeners({ ELTNOY_API_LISTENERS: 'public,admin' }, mode).ok, false, mode);
  }
  for (const value of [undefined, '', '  ', 'PUBLIC', 'both', 'public,', ',admin', 'public,public', 'public;admin', 'public admin', 'admin,admin,public']) {
    const result = resolveActiveListeners(value === undefined ? {} : { ELTNOY_API_LISTENERS: value }, 'development');
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.ok(!result.ok && !JSON.stringify(result.errors).includes('PUBLIC') && !JSON.stringify(result.errors).includes(';'), 'no configured values echoed');
  }
});

test('recovery ownership: a cutoff is rejected on any instance without the public listener', () => {
  const since = '2026-11-05T09:00:00Z';
  assert.equal(resolveActiveListeners({ ELTNOY_API_LISTENERS: 'admin', ONLINE_EXAM_RECOVERY_SINCE: since }, 'production').ok, false);
  assert.equal(resolveActiveListeners({ ELTNOY_API_LISTENERS: 'admin', ONLINE_EXAM_RECOVERY_SINCE: '' }, 'production').ok, true);
  assert.equal(resolveActiveListeners({ ELTNOY_API_LISTENERS: 'public', ONLINE_EXAM_RECOVERY_SINCE: since }, 'production').ok, true);
  assert.equal(resolveActiveListeners({ ELTNOY_API_LISTENERS: 'public,admin', ONLINE_EXAM_RECOVERY_SINCE: since }, 'development').ok, true);
  // The non-owner handle never runs and never touches the database.
  assert.equal(NO_RECOVERY_HANDLE.enabled, false);
  assert.ok(Object.isFrozen(NO_RECOVERY_HANDLE));
});

test('startup with a single configured listener: ready only after it binds; failure leaves nothing bound', async () => {
  const { log, servers, createServer } = harness();
  const recovery = recoveryHarness(log);
  const states: boolean[] = [];
  const result = await startApiListeners({
    specs: [SPECS[1]],
    createServer,
    loadOnlineExamConfig: () => EXAM_CONFIG,
    checkDatabase: async () => undefined,
    startRecovery: () => NO_RECOVERY_HANDLE,
    markNotReady: () => states.push(false),
    markReady: () => states.push(true),
  });
  assert.ok(result);
  assert.deepEqual([...result.servers.keys()], ['admin']);
  assert.equal(servers.has('public'), false, 'the unselected listener is never created');
  assert.deepEqual(states, [true]);
  assert.equal(recovery.starts(), 0);
  const failing = harness({ fail: { admin: 'EADDRINUSE' } });
  const failStates: boolean[] = [];
  await assert.rejects(startApiListeners({
    specs: [SPECS[1]],
    createServer: failing.createServer,
    loadOnlineExamConfig: () => EXAM_CONFIG,
    checkDatabase: async () => undefined,
    startRecovery: () => NO_RECOVERY_HANDLE,
    markNotReady: () => failStates.push(false),
    markReady: () => failStates.push(true),
  }), ListenerStartupError);
  assert.deepEqual(failStates, [false], 'never ready; reset on failure');
});
