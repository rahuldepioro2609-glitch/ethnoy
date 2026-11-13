// P1-B.1 M-B / P1-D.2: behavioural tests of the real startApi() with injected dependencies.
//
// Fake servers (EventEmitters) replace http.Server: listen() schedules 'listening' or 'error' and
// close() records the call. No socket is bound, no database is used and no process handler is
// installed. These tests prove the startup wiring in code; they do NOT prove real Nginx, Docker or
// network behaviour (P1-F and the real-HTTP suite must).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

process.env.DOTENV_CONFIG_PATH ??= '/dev/null';
process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:1/p1b1_start_api_tests';

const [{ startApi, productionStartApiDependencies }, { createSurfaceGate, SURFACE_ENV, ORIGINAL_HOST_HEADER }, { ListenerStartupError, API_LISTENERS_SETTING }] = await Promise.all([
  import('./index.js'),
  import('./surfaceEnforcement.js'),
  import('./apiListeners.js'),
]);
type Deps = Parameters<typeof startApi>[0] & object;
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const PUBLIC_PROXY = '172.30.0.10';
const ADMIN_PROXY = '172.31.0.10';
const BASE = {
  [SURFACE_ENV.publicProxyCidrs]: PUBLIC_PROXY,
  [SURFACE_ENV.adminProxyCidrs]: ADMIN_PROXY,
  PORT: '4000',
  ADMIN_PORT: '4001',
};
// Production: one listener per instance, as in docker-compose.yml.
const PROD_PUBLIC = { ...BASE, [SURFACE_ENV.mode]: 'production', [API_LISTENERS_SETTING]: 'public' };
const PROD_ADMIN = { ...BASE, [SURFACE_ENV.mode]: 'production', [API_LISTENERS_SETTING]: 'admin' };
// Development: both listeners in one process only when explicitly selected.
const DEV_HOSTS = { marketing: 'eltnoy.localhost', exam: 'exam.localhost', institution: 'institution.localhost', admin: 'admin.localhost' };
const DEV_DUAL = {
  ...BASE,
  [SURFACE_ENV.mode]: 'development',
  [API_LISTENERS_SETTING]: 'public,admin',
  [SURFACE_ENV.hostnames.marketing]: DEV_HOSTS.marketing,
  [SURFACE_ENV.hostnames.exam]: DEV_HOSTS.exam,
  [SURFACE_ENV.hostnames.institution]: DEV_HOSTS.institution,
  [SURFACE_ENV.hostnames.admin]: DEV_HOSTS.admin,
};

class FakeServer extends EventEmitter {
  listenCalls: Array<{ port: number; host: string }> = [];
  closeCalls = 0;
  listening = false;
  constructor(readonly handler: Handler, readonly log: string[], readonly failWith?: string) {
    super();
  }
  listen(port: number, host: string) {
    this.listenCalls.push({ port, host });
    this.log.push(`listen:${port}`);
    setImmediate(() => {
      if (this.failWith) {
        this.emit('error', Object.assign(new Error('bind failed'), { code: this.failWith }));
        return;
      }
      this.listening = true;
      this.log.push(`listening:${port}`);
      this.emit('listening');
    });
    return this;
  }
  close(callback: (error?: Error) => void) {
    this.closeCalls += 1;
    this.listening = false;
    this.log.push(`close:${this.listenCalls[0]?.port}`);
    setImmediate(() => callback());
    return this;
  }
}

function harness(options: { env?: Record<string, string>; failAt?: number; onlineConfigError?: boolean } = {}) {
  const log: string[] = [];
  const servers: FakeServer[] = [];
  const signals = new Map<string, () => void>();
  const trusts: Array<(address: string, hop: number) => boolean> = [];
  const exitCodes: number[] = [];
  const exits: number[] = [];
  const readyAtCreate: boolean[] = [];
  const handled: Array<{ request: IncomingMessage; identify: { passed: boolean; status: number } }> = [];
  let recoveryStarts = 0;
  let recoveryStops = 0;
  const gate = createSurfaceGate();
  const deps: Deps = {
    env: options.env ?? DEV_DUAL,
    gate,
    handle: (request) => {
      // Inside the application: run the gate's identity check on the request the listener tagged.
      let status = 200;
      let passed = false;
      gate.identify(request as Request, {
        status(code: number) { status = code; return this; },
        json() { return this; },
      } as unknown as Response, (() => { passed = true; }) as NextFunction);
      handled.push({ request, identify: { passed, status: passed ? 200 : status } });
    },
    setTrustProxy: (trust) => {
      log.push('trust-proxy');
      trusts.push(trust);
    },
    createServer: (handler) => {
      readyAtCreate.push(gate.isReady());
      const server = new FakeServer(handler, log, servers.length === options.failAt ? 'EADDRINUSE' : undefined);
      servers.push(server);
      log.push(`create:${servers.length}`);
      return server;
    },
    loadOnlineExamConfig: () => {
      if (options.onlineConfigError) throw new Error('ONLINE_EXAM_RECOVERY_INTERVAL_SECONDS must be a whole number from 0 to 86400.');
      return {} as never;
    },
    checkDatabase: async () => {
      log.push('database:check');
    },
    startRecovery: () => {
      recoveryStarts += 1;
      log.push('recovery:start');
      return {
        enabled: true,
        stop: async () => {
          recoveryStops += 1;
          log.push('recovery:stop');
        },
      } as never;
    },
    endPool: async () => {
      log.push('pool:end');
    },
    exit: (code) => {
      exits.push(code);
      log.push(`exit:${code}`);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
    onSignal: (signal, handler) => {
      signals.set(signal, handler);
    },
    flushRejections: () => {
      log.push('rejections:flush');
    },
    log: () => undefined,
    logError: () => undefined,
  };
  return {
    deps, gate, log, servers, signals, trusts, exitCodes, exits, handled, readyAtCreate,
    recoveryStarts: () => recoveryStarts,
    recoveryStops: () => recoveryStops,
  };
}

function fakeIncoming(localPort: number, peer: string, host: string, headers: Record<string, string> = {}) {
  return {
    method: 'GET',
    url: '/api/auth/me',
    originalUrl: '/api/auth/me',
    headers: { [ORIGINAL_HOST_HEADER]: host, ...headers },
    socket: { localPort, remoteAddress: peer },
  } as unknown as IncomingMessage;
}
const fakeServerResponse = () => ({ statusCode: 200, end() { return this; } }) as unknown as ServerResponse;

const serverHandles = () => ((process as unknown as { _getActiveHandles?: () => Array<{ constructor?: { name?: string } }> })._getActiveHandles?.() ?? [])
  .filter((handle) => handle?.constructor?.name === 'Server').length;

// ---------------------------------------------------------------------------
// P1-D.2: one listener per production instance
// ---------------------------------------------------------------------------

test('production public-only instance: starts only port 4000, owns recovery, serves only public surfaces', async () => {
  const run = harness({ env: PROD_PUBLIC });
  const runtime = await startApi(run.deps);
  assert.ok(runtime);
  assert.equal(run.servers.length, 1, 'exactly one listener');
  assert.deepEqual(run.servers[0].listenCalls, [{ port: 4000, host: '0.0.0.0' }]);
  assert.deepEqual([...runtime.servers.keys()], ['public']);
  assert.deepEqual(run.log, ['trust-proxy', 'database:check', 'create:1', 'listen:4000', 'listening:4000', 'recovery:start']);
  assert.equal(run.gate.isReady(), true);
  assert.equal(run.recoveryStarts(), 1, 'the public instance owns recovery');
  run.servers[0].handler(fakeIncoming(4000, PUBLIC_PROXY, 'exam.eltnoy.com'), fakeServerResponse());
  run.servers[0].handler(fakeIncoming(4000, ADMIN_PROXY, 'admin.eltnoy.com'), fakeServerResponse());
  assert.deepEqual(run.handled.map((entry) => entry.identify), [{ passed: true, status: 200 }, { passed: false, status: 421 }]);
});

test('production Admin-only instance: starts only port 4001 and never starts recovery', async () => {
  const run = harness({ env: PROD_ADMIN });
  const runtime = await startApi(run.deps);
  assert.ok(runtime);
  assert.equal(run.servers.length, 1, 'exactly one listener');
  assert.deepEqual(run.servers[0].listenCalls, [{ port: 4001, host: '0.0.0.0' }]);
  assert.deepEqual([...runtime.servers.keys()], ['admin']);
  assert.deepEqual(run.log, ['trust-proxy', 'database:check', 'create:1', 'listen:4001', 'listening:4001']);
  assert.equal(run.recoveryStarts(), 0, 'the recovery dependency is never called');
  assert.equal(runtime.recovery.handle()?.enabled, false, 'a handle that never runs');
  run.servers[0].handler(fakeIncoming(4001, ADMIN_PROXY, 'admin.eltnoy.com'), fakeServerResponse());
  run.servers[0].handler(fakeIncoming(4001, PUBLIC_PROXY, 'exam.eltnoy.com'), fakeServerResponse());
  assert.deepEqual(run.handled.map((entry) => entry.identify), [{ passed: true, status: 200 }, { passed: false, status: 421 }]);
  // Shutdown closes only this instance's listener, then the pool.
  run.log.length = 0;
  await runtime.shutdown('SIGTERM');
  assert.deepEqual(run.log, ['close:4001', 'pool:end', 'rejections:flush', 'exit:0']);
});

test('listener selection: unset, empty, unknown, duplicate or malformed values fail startup with nothing bound', async () => {
  for (const value of [undefined, '', ' ', 'PUBLIC', 'Admin', 'both', 'public,', ',admin', 'public,,admin', 'public,public', 'public;admin', 'public admin', 'admin,admin']) {
    const env: Record<string, string> = { ...PROD_PUBLIC };
    if (value === undefined) delete env[API_LISTENERS_SETTING];
    else env[API_LISTENERS_SETTING] = value;
    const run = harness({ env });
    assert.equal(await startApi(run.deps), null, JSON.stringify(value));
    assert.equal(run.servers.length, 0);
    assert.deepEqual(run.exitCodes, [1]);
    assert.equal(run.gate.isConfigured(), false);
    assert.equal(run.trusts.length, 0);
  }
});

test('listener selection: both listeners are refused in production and staging (no silent fallback)', async () => {
  const STAGING = {
    ...BASE,
    [SURFACE_ENV.mode]: 'staging',
    [SURFACE_ENV.hostnames.marketing]: 'staging.example.test',
    [SURFACE_ENV.hostnames.exam]: 'exam.staging.example.test',
    [SURFACE_ENV.hostnames.institution]: 'institution.staging.example.test',
    [SURFACE_ENV.hostnames.admin]: 'admin.staging.example.test',
  };
  for (const env of [
    { ...PROD_PUBLIC, [API_LISTENERS_SETTING]: 'public,admin' },
    { ...PROD_PUBLIC, [API_LISTENERS_SETTING]: 'admin,public' },
    { ...STAGING, [API_LISTENERS_SETTING]: 'public,admin' },
  ]) {
    const run = harness({ env });
    assert.equal(await startApi(run.deps), null, env[SURFACE_ENV.mode]);
    assert.equal(run.servers.length, 0);
    assert.deepEqual(run.exitCodes, [1]);
  }
  // Staging with one listener is accepted.
  const staging = harness({ env: { ...STAGING, [API_LISTENERS_SETTING]: 'public' } });
  assert.ok(await startApi(staging.deps));
  assert.equal(staging.servers.length, 1);
});

test('recovery ownership: ONLINE_EXAM_RECOVERY_SINCE is rejected on an Admin-only instance, accepted on the public one', async () => {
  const since = '2026-11-05T09:00:00Z';
  const admin = harness({ env: { ...PROD_ADMIN, ONLINE_EXAM_RECOVERY_SINCE: since } });
  assert.equal(await startApi(admin.deps), null);
  assert.equal(admin.servers.length, 0, 'nothing bound');
  assert.equal(admin.recoveryStarts(), 0);
  assert.deepEqual(admin.exitCodes, [1]);
  // Whitespace-only counts as unset (as the P0-4 setting parser treats an empty cutoff).
  const blank = harness({ env: { ...PROD_ADMIN, ONLINE_EXAM_RECOVERY_SINCE: '   ' } });
  assert.ok(await startApi(blank.deps));
  // The public instance accepts it (the P0-4 parser itself is exercised by its own tests).
  const publicRun = harness({ env: { ...PROD_PUBLIC, ONLINE_EXAM_RECOVERY_SINCE: since } });
  assert.ok(await startApi(publicRun.deps));
  assert.equal(publicRun.recoveryStarts(), 1);
});

test('single-listener bind failure: not ready, no recovery, nothing left bound', async () => {
  const run = harness({ env: PROD_ADMIN, failAt: 0 });
  await assert.rejects(startApi(run.deps), (error: unknown) => error instanceof ListenerStartupError && error.listener === 'admin');
  assert.equal(run.gate.isReady(), false);
  assert.equal(run.recoveryStarts(), 0);
  assert.equal(run.signals.size, 0);
});

// ---------------------------------------------------------------------------
// Development dual-listener mode (explicitly selected)
// ---------------------------------------------------------------------------

test('development public,admin: binds public then Admin; readiness only after both; then recovery', async () => {
  const run = harness();
  const runtime = await startApi(run.deps);
  assert.ok(runtime, 'startApi returned a running runtime');
  assert.equal(run.servers.length, 2, 'the listener factory was invoked for both listeners');
  assert.deepEqual(run.servers[0].listenCalls, [{ port: 4000, host: '0.0.0.0' }]);
  assert.deepEqual(run.servers[1].listenCalls, [{ port: 4001, host: '0.0.0.0' }]);
  assert.deepEqual(run.log, [
    'trust-proxy', 'database:check', 'create:1', 'listen:4000', 'listening:4000', 'create:2', 'listen:4001', 'listening:4001', 'recovery:start',
  ]);
  assert.deepEqual(run.readyAtCreate, [false, false], 'not ready after the first listener alone');
  assert.equal(run.gate.isReady(), true);
  assert.equal(run.recoveryStarts(), 1);
  // The returned runtime holds exactly the two bound fake servers: no silent success.
  assert.deepEqual([...runtime.servers.keys()], ['public', 'admin']);
  assert.equal(runtime.servers.get('public'), run.servers[0]);
  assert.equal(runtime.servers.get('admin'), run.servers[1]);
  assert.ok(run.servers.every((server) => server.listening));
  assert.deepEqual([...run.signals.keys()].sort(), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(run.exitCodes, []);
});

test('development public,admin: each listener assigns its own server-side identity; headers cannot change it', async () => {
  const run = harness();
  await startApi(run.deps);
  const [publicServer, adminServer] = run.servers;
  publicServer.handler(fakeIncoming(4000, PUBLIC_PROXY, DEV_HOSTS.exam), fakeServerResponse());
  adminServer.handler(fakeIncoming(4001, ADMIN_PROXY, DEV_HOSTS.admin), fakeServerResponse());
  publicServer.handler(fakeIncoming(4000, ADMIN_PROXY, DEV_HOSTS.admin, { 'x-eltnoy-listener': 'admin' }), fakeServerResponse());
  adminServer.handler(fakeIncoming(4001, PUBLIC_PROXY, DEV_HOSTS.exam), fakeServerResponse());
  publicServer.handler(fakeIncoming(4001, PUBLIC_PROXY, DEV_HOSTS.exam), fakeServerResponse());
  assert.deepEqual(run.handled.map((entry) => entry.identify), [
    { passed: true, status: 200 },
    { passed: true, status: 200 },
    { passed: false, status: 421 },
    { passed: false, status: 421 },
    { passed: false, status: 421 },
  ]);
});

test('startApi: the Express trust adapter receives the validated per-listener configuration', async () => {
  const run = harness({ env: PROD_PUBLIC });
  await startApi(run.deps);
  assert.equal(run.trusts.length, 1);
  const [trust] = run.trusts;
  assert.equal(trust(PUBLIC_PROXY, 0), true);
  assert.equal(trust(ADMIN_PROXY, 0), true);
  assert.equal(trust(`::ffff:${PUBLIC_PROXY}`, 0), true);
  assert.equal(trust('172.30.0.11', 0), false);
  assert.equal(trust('203.0.113.7', 0), false);
  assert.equal(trust(PUBLIC_PROXY, 1), false, 'only the direct peer');
});

test('development public,admin: a second-listener bind failure closes the first; no readiness or recovery', async () => {
  const run = harness({ failAt: 1 });
  await assert.rejects(startApi(run.deps), (error: unknown) => error instanceof ListenerStartupError && error.listener === 'admin' && error.code === 'EADDRINUSE');
  assert.equal(run.servers.length, 2);
  assert.equal(run.servers[0].closeCalls, 1, 'the bound public listener was closed');
  assert.equal(run.servers[1].closeCalls, 0, 'the failed listener never bound');
  assert.equal(run.recoveryStarts(), 0);
  assert.equal(run.gate.isReady(), false);
  assert.equal(run.signals.size, 0, 'no shutdown handlers for a failed start');
});

test('development public,admin: shutdown order is recovery → public → Admin → pool → flush → exit; signals reuse it', async () => {
  const run = harness();
  const runtime = await startApi(run.deps);
  assert.ok(runtime);
  run.log.length = 0;
  run.signals.get('SIGTERM')!();
  run.signals.get('SIGINT')!();
  await runtime.shutdown('SIGTERM');
  assert.deepEqual(run.log, ['recovery:stop', 'close:4000', 'close:4001', 'pool:end', 'rejections:flush', 'exit:0']);
  assert.equal(run.recoveryStops(), 1);
  assert.deepEqual(run.exits, [0]);
  assert.equal(run.gate.isReady(), false);
});

// ---------------------------------------------------------------------------
// Configuration failures
// ---------------------------------------------------------------------------

test('startApi: invalid surface configuration binds nothing, ends the pool and sets exit code 1', async () => {
  for (const env of [
    {},
    { ...PROD_PUBLIC, [SURFACE_ENV.adminProxyCidrs]: PUBLIC_PROXY },
    { ...PROD_PUBLIC, [SURFACE_ENV.legacyTrustedProxyCidrs]: PUBLIC_PROXY },
    { ...PROD_PUBLIC, [SURFACE_ENV.publicProxyCidrs]: '172.30.0.0/24' },
  ]) {
    const run = harness({ env });
    assert.equal(await startApi(run.deps), null, JSON.stringify(Object.keys(env)));
    assert.equal(run.servers.length, 0, 'the listener factory was never invoked');
    assert.deepEqual(run.log, ['pool:end']);
    assert.deepEqual(run.exitCodes, [1]);
    assert.equal(run.trusts.length, 0);
    assert.equal(run.gate.isConfigured(), false);
  }
});

test('startApi: invalid online-exam settings stop before the database check and any bind', async () => {
  const run = harness({ env: PROD_PUBLIC, onlineConfigError: true });
  const originalError = console.error;
  console.error = () => undefined; // the existing P0-4 startup logger writes one safe line
  try {
    assert.equal(await startApi(run.deps), null);
  } finally {
    console.error = originalError;
  }
  assert.equal(run.servers.length, 0);
  assert.deepEqual(run.log, ['trust-proxy', 'pool:end']);
  assert.deepEqual(run.exitCodes, [1]);
  assert.equal(run.recoveryStarts(), 0);
});

test('startApi: production dependencies are built lazily and these tests opened no socket', () => {
  const before = process.listenerCount('SIGTERM');
  const deps = productionStartApiDependencies();
  assert.equal(typeof deps.createServer, 'function');
  assert.equal(process.listenerCount('SIGTERM'), before);
  assert.equal(serverHandles(), 0, 'no real listening server');
});
