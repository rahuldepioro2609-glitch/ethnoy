// P1-B M-2: production wiring unit tests — the real Express middleware stack order and the
// server-side listener tagging factory.
//
// No socket is bound and no database is used. These tests prove how the application is wired in
// code; they do NOT prove real Nginx, Docker or network peer behaviour (staging P1-F and the
// real-HTTP suite must verify that).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

process.env.DOTENV_CONFIG_PATH ??= '/dev/null';
process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:1/p1b_wiring_tests';

type Handle = { constructor?: { name?: string } };
const activeHandles = () => ((process as unknown as { _getActiveHandles?: () => Handle[] })._getActiveHandles?.() ?? []);
const serverHandles = () => activeHandles().filter((handle) => handle?.constructor?.name === 'Server').length;

// Import the wiring modules first and record that importing them creates nothing.
const handlesBefore = activeHandles().length;
const serversBefore = serverHandles();
const listenersModule = await import('./apiListeners.js');
const enforcementModule = await import('./surfaceEnforcement.js');
const handlesAfterWiringImports = activeHandles().length;
const serversAfterWiringImports = serverHandles();

const [{ app, surfaceGate }, { pool }] = await Promise.all([import('./index.js'), import('./db.js')]);
const { createListenerRequestHandler } = listenersModule;
const { createSurfaceGate, loadSurfaceRuntimeConfig, SURFACE_ENV, ORIGINAL_HOST_HEADER } = enforcementModule;

const PUBLIC_PROXY = '172.30.0.10';
const ADMIN_PROXY = '172.31.0.10';
const config = (() => {
  const result = loadSurfaceRuntimeConfig({
    [SURFACE_ENV.mode]: 'production',
    [SURFACE_ENV.publicProxyCidrs]: PUBLIC_PROXY,
    [SURFACE_ENV.adminProxyCidrs]: ADMIN_PROXY,
  });
  assert.ok(result.ok);
  return result.config;
})();

interface Layer {
  name?: string;
  handle?: unknown;
  route?: { path: string };
  regexp?: RegExp;
}
const STACK = (app as unknown as { _router: { stack: Layer[]; params: Record<string, unknown> } })._router;

// ---------------------------------------------------------------------------
// Middleware order (actual Express stack)
// ---------------------------------------------------------------------------

test('wiring: the surface gate layers are registered once, in the required order, before everything else', () => {
  const index = (predicate: (layer: Layer) => boolean) => STACK.stack.findIndex(predicate);
  const count = (predicate: (layer: Layer) => boolean) => STACK.stack.filter(predicate).length;
  const identify = index((layer) => layer.handle === surfaceGate.identify);
  const helmetLayer = index((layer) => layer.name === 'helmetMiddleware');
  const json = index((layer) => layer.name === 'jsonParser');
  const origin = index((layer) => layer.handle === surfaceGate.enforceOrigin);
  const policy = index((layer) => layer.handle === surfaceGate.enforceRoutePolicy);
  for (const [name, position] of Object.entries({ identify, helmetLayer, json, origin, policy })) assert.ok(position >= 0, `${name} registered`);
  assert.equal(count((layer) => layer.handle === surfaceGate.identify), 1);
  assert.equal(count((layer) => layer.handle === surfaceGate.enforceOrigin), 1);
  assert.equal(count((layer) => layer.handle === surfaceGate.enforceRoutePolicy), 1);
  // Spec §9: identify (listener/peer/host) → security headers and body parsing → Origin → route policy.
  assert.ok(identify < helmetLayer && helmetLayer < json && json < origin && origin < policy, `order: ${[identify, helmetLayer, json, origin, policy]}`);
  // Only Express internals run before the gate's first layer.
  assert.deepEqual(STACK.stack.slice(0, identify).map((layer) => layer.name), ['query', 'expressInit']);
  // Nothing that can answer a request sits between the gate layers.
  assert.deepEqual(STACK.stack.slice(0, policy + 1).map((layer) => layer.name), ['query', 'expressInit', 'identify', 'helmetMiddleware', 'jsonParser', 'enforceOrigin', 'enforceRoutePolicy']);
});

test('wiring: every route, router, static and SPA fallback layer comes after route-policy enforcement', () => {
  const policy = STACK.stack.findIndex((layer) => layer.handle === surfaceGate.enforceRoutePolicy);
  const handlers = STACK.stack
    .map((layer, position) => ({ layer, position }))
    .filter(({ layer }) => layer.route || layer.name === 'router' || layer.name === 'serveStatic' || layer.name === 'bound dispatch');
  // 63 top-level routes (+ the SPA fallback when dist/ exists) and 11 mounted routers: the 2
  // institution-document routers, since SM-1 2 Platform Staff and 3 Organization Staff routers, since
  // AUTH-1 the verification router, since SM-2 the institutional-verification admin router, and the
  // Institute Workspace router and its D-02 Super Admin review router.
  assert.ok(handlers.filter(({ layer }) => layer.route && layer.route.path !== '*').length >= 63, 'top-level routes found');
  assert.equal(handlers.filter(({ layer }) => layer.name === 'router').length, 11, 'all mounted routers found');
  for (const { layer, position } of handlers) {
    assert.ok(position > policy, `${layer.route?.path ?? layer.name} registered before the gate`);
  }
  const staticLayer = STACK.stack.findIndex((layer) => layer.name === 'serveStatic');
  const spa = STACK.stack.findIndex((layer) => layer.route?.path === '*');
  if (staticLayer !== -1) assert.ok(staticLayer > policy, 'static serving after the gate');
  if (spa !== -1) assert.ok(spa > policy, 'SPA fallback after the gate');
  // No app.param() handlers (they run during routing) and no mounted sub-application.
  assert.deepEqual(Object.keys(STACK.params), []);
  assert.ok(!STACK.stack.some((layer) => layer.name === 'mounted_app'), 'no sub-application');
});

// ---------------------------------------------------------------------------
// Listener tagging factory
// ---------------------------------------------------------------------------

function fakeRequest(localPort: number, headers: Record<string, string> = {}) {
  return {
    method: 'GET',
    url: '/api/auth/me',
    originalUrl: '/api/auth/me',
    headers: { [ORIGINAL_HOST_HEADER]: 'exam.eltnoy.com', ...headers },
    socket: { localPort, remoteAddress: PUBLIC_PROXY },
  } as unknown as Request;
}

function fakeResponse() {
  const state = { status: 200, body: undefined as unknown, statusCode: 200, ended: false };
  const response = {
    get statusCode() { return state.statusCode; },
    set statusCode(value: number) { state.statusCode = value; },
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    end() { state.ended = true; return this; },
  };
  return { response: response as unknown as Response & { statusCode: number; end(): unknown }, state };
}

function identify(gate: ReturnType<typeof createSurfaceGate>, request: Request) {
  const { response, state } = fakeResponse();
  let passed = false;
  gate.identify(request, response, (() => { passed = true; }) as NextFunction);
  return { passed, status: passed ? 200 : state.status };
}

test('tagging: listener identity is attached by server-side wiring, before the application runs', () => {
  const gate = createSurfaceGate();
  gate.configure(config);
  const seen: Request[] = [];
  const handler = createListenerRequestHandler<Request, Response & { statusCode: number; end(): unknown }>('public', gate.tagListener, (request) => {
    seen.push(request);
    // The tag is already present when the application is invoked.
    assert.equal(identify(gate, request).passed, true);
  });
  const request = fakeRequest(4000);
  handler(request, fakeResponse().response);
  assert.deepEqual(seen, [request]);
});

test('tagging: client headers cannot choose the listener', () => {
  const gate = createSurfaceGate();
  gate.configure(config);
  const headerClaims = { 'x-eltnoy-listener': 'admin', 'x-listener': 'admin', 'x-forwarded-port': '4001', [ORIGINAL_HOST_HEADER]: 'admin.eltnoy.in' };
  // Without server-side tagging, header claims achieve nothing.
  assert.equal(identify(gate, fakeRequest(4001, headerClaims)).status, 421);
  // Tagged as public by the public listener's handler: the admin claims are ignored and the
  // Admin hostname is refused on the public listener.
  const handler = createListenerRequestHandler<Request, Response & { statusCode: number; end(): unknown }>('public', gate.tagListener, () => undefined);
  const request = fakeRequest(4000, headerClaims);
  handler(request, fakeResponse().response);
  assert.equal(identify(gate, request).status, 421);
});

test('tagging: the assigned listener must match the actual local port; a mismatch fails closed', () => {
  const gate = createSurfaceGate();
  gate.configure(config);
  const cases: Array<['public' | 'admin', number, boolean]> = [
    ['public', 4000, true],
    ['public', 4001, false],
    ['admin', 4000, false],
    ['public', 8080, false],
  ];
  for (const [listener, localPort, expected] of cases) {
    const handler = createListenerRequestHandler<Request, Response & { statusCode: number; end(): unknown }>(listener, gate.tagListener, () => undefined);
    const request = fakeRequest(localPort);
    handler(request, fakeResponse().response);
    const outcome = identify(gate, request);
    assert.equal(outcome.passed, expected, `${listener} on ${localPort}`);
    if (!expected) assert.equal(outcome.status, 421);
  }
});

test('tagging: a request cannot be tagged twice, and a tagging failure never reaches the application', () => {
  const gate = createSurfaceGate();
  gate.configure(config);
  let appCalls = 0;
  const publicHandler = createListenerRequestHandler<Request, Response & { statusCode: number; end(): unknown }>('public', gate.tagListener, () => { appCalls += 1; });
  const adminHandler = createListenerRequestHandler<Request, Response & { statusCode: number; end(): unknown }>('admin', gate.tagListener, () => { appCalls += 1; });
  const request = fakeRequest(4000);
  publicHandler(request, fakeResponse().response);
  const { response, state } = fakeResponse();
  adminHandler(request, response);
  assert.equal(appCalls, 1);
  assert.equal(state.statusCode, 500);
  assert.equal(state.ended, true);
  assert.throws(() => createListenerRequestHandler('staff' as never, gate.tagListener, () => undefined), /Unknown listener/);
});

// M-B (P1-B.1): the former source-text assertion on startApi was replaced by behavioural tests of
// the real startApi() with injected fake servers in server/startApi.test.ts.

test('wiring: importing the listener and enforcement modules (and the app) binds nothing and opens no connection', () => {
  assert.equal(handlesAfterWiringImports, handlesBefore, 'no handle created by importing the wiring modules');
  assert.equal(serversAfterWiringImports, serversBefore);
  assert.equal(serverHandles(), 0, 'no listening server after importing the application');
  assert.equal((pool as unknown as { totalCount: number }).totalCount, 0, 'no pool clients');
});
