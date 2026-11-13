// P1-B surface enforcement unit tests.
//
// Fake requests/responses only: no listener is bound, no socket is opened and no database is used
// (the shared pool's query/connect are replaced by a counting fake). These tests exercise the gate
// middleware and the shared session path directly; they are not proof of real HTTP, proxy, Docker
// or PostgreSQL behaviour, which staging (P1-F) must verify.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

process.env.DOTENV_CONFIG_PATH ??= '/dev/null';
process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:1/p1b_surface_enforcement_tests';

const [
  { app, surfaceGate },
  { pool },
  { hashSessionToken, requireAuth, getTrustedRequestSurface, setTrustedRequestSurface },
  {
    createSurfaceGate, loadSurfaceRuntimeConfig, SURFACE_ENV, ORIGINAL_HOST_HEADER, createExpressProxyTrust, createRejectionLog,
    REJECTION_GROUPS, REJECTION_REASONS, validateTrustedProxies,
  },
  {
    LISTENER_SURFACES, PINNED_SURFACE_HOSTNAMES, SURFACES, expectedOrigin, isPeerInRanges, normalizePeerAddress,
    parseProxyRange, surfaceForListenerAndHost, isLoopbackPeer,
  },
] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
  import('./surfaceEnforcement.js'),
  import('./surface.js'),
]);
type Surface = (typeof SURFACES)[number];
type Gate = ReturnType<typeof createSurfaceGate>;

// ---------------------------------------------------------------------------
// Synthetic sessions and a counting fake database
// ---------------------------------------------------------------------------

const ACCOUNTS = {
  candidate: { token: 'K'.repeat(43), row: { id: 'syn-candidate', login_id: 'C1', display_name: 'Candidate', role: 'candidate', account_status: 'approved', is_super_admin: false } },
  center: { token: 'L'.repeat(43), row: { id: 'syn-center', login_id: 'I1', display_name: 'Center', role: 'center', account_status: 'approved', is_super_admin: false } },
  official: { token: 'M'.repeat(43), row: { id: 'syn-official', login_id: 'O1', display_name: 'Official', role: 'official', account_status: 'approved', is_super_admin: false } },
  superAdmin: { token: 'N'.repeat(43), row: { id: 'syn-super', login_id: 'S1', display_name: 'Super', role: 'official', account_status: 'approved', is_super_admin: true } },
  pendingCenter: { token: 'P'.repeat(43), row: { id: 'syn-pending', login_id: 'I2', display_name: 'Pending', role: 'center', account_status: 'pending', is_super_admin: false } },
} as const;
type AccountName = keyof typeof ACCOUNTS;
const SESSIONS = new Map(Object.values(ACCOUNTS).map(({ token, row }) => [hashSessionToken(token), row]));

const db = { sessionQueries: 0, businessQueries: [] as string[] };
const mutablePool = pool as unknown as { query: (text: string, values?: unknown[]) => Promise<unknown>; connect: () => Promise<unknown> };
mutablePool.query = async (text: string, values: unknown[] = []) => {
  if (text.includes('FROM auth_sessions s')) {
    db.sessionQueries += 1;
    const row = SESSIONS.get(String(values[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  db.businessQueries.push(text);
  return { rows: [], rowCount: 0 };
};
mutablePool.connect = async () => {
  db.businessQueries.push('connect');
  throw new Error('No connection expected in surface enforcement unit tests.');
};
const resetDb = () => {
  db.sessionQueries = 0;
  db.businessQueries = [];
};

// ---------------------------------------------------------------------------
// Configuration and fake request plumbing
// ---------------------------------------------------------------------------

// Synthetic single proxy addresses (H-1/M-1): one per listener, never overlapping.
const PUBLIC_PROXY = '172.30.0.10';
const ADMIN_PROXY = '172.31.0.10';
const PRODUCTION_ENV = {
  [SURFACE_ENV.mode]: 'production',
  [SURFACE_ENV.publicProxyCidrs]: PUBLIC_PROXY,
  [SURFACE_ENV.adminProxyCidrs]: ADMIN_PROXY,
};
const productionConfig = (() => {
  const result = loadSurfaceRuntimeConfig(PRODUCTION_ENV);
  assert.ok(result.ok);
  return result.config;
})();

function configuredGate(): Gate {
  const gate = createSurfaceGate();
  gate.configure(productionConfig);
  return gate;
}

interface FakeOptions {
  listener?: 'public' | 'admin' | null;
  localPort?: number;
  peer?: string;
  host?: string | string[] | null;
  method?: string;
  url?: string;
  origin?: string;
  account?: AccountName;
  headers?: Record<string, string | string[]>;
}

function fakeRequest(gate: Gate, options: FakeOptions = {}): Request {
  const listener = options.listener === undefined ? 'public' : options.listener;
  const headers: Record<string, string | string[]> = { ...(options.headers ?? {}) };
  if (options.host !== null) headers[ORIGINAL_HOST_HEADER] = options.host ?? 'exam.eltnoy.com';
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.account) headers.cookie = `elt_session=${ACCOUNTS[options.account].token}`;
  const url = options.url ?? '/api/auth/me';
  const request = {
    method: options.method ?? 'GET',
    url,
    originalUrl: url,
    headers,
    socket: {
      localPort: options.localPort ?? (listener === 'admin' ? 4001 : 4000),
      remoteAddress: options.peer ?? (listener === 'admin' ? ADMIN_PROXY : PUBLIC_PROXY),
    },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
  if (listener) gate.tagListener(request as never, listener);
  return request;
}

interface Outcome {
  status: number;
  body: unknown;
  reached: boolean;
  clearedCookie: boolean;
}

function fakeResponse(done: (status: number, body: unknown) => void, cleared: { value: boolean }): Response {
  let status = 200;
  return {
    status(code: number) {
      status = code;
      return this;
    },
    json(body: unknown) {
      done(status, body);
      return this;
    },
    clearCookie() {
      cleared.value = true;
      return this;
    },
  } as unknown as Response;
}

/** identify → enforceOrigin → enforceRoutePolicy (helmet and body parsing are not involved). */
function runGate(gate: Gate, request: Request): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const cleared = { value: false };
    const response = fakeResponse((status, body) => resolve({ status, body, reached: false, clearedCookie: cleared.value }), cleared);
    const chain = [gate.identify, gate.enforceOrigin, gate.enforceRoutePolicy];
    const step = (index: number) => {
      const next: NextFunction = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        if (index + 1 < chain.length) step(index + 1);
        else resolve({ status: 200, body: null, reached: true, clearedCookie: cleared.value });
      };
      try {
        chain[index](request, response, next);
      } catch (error) {
        reject(error);
      }
    };
    step(0);
  });
}

const HOST_OF: Record<Surface, string> = { ...PINNED_SURFACE_HOSTNAMES };
const LISTENER_OF: Record<Surface, 'public' | 'admin'> = { marketing: 'public', exam: 'public', institution: 'public', admin: 'admin' };
const SURFACE_OF_ACCOUNT: Record<AccountName, Surface> = { candidate: 'exam', center: 'institution', official: 'admin', superAdmin: 'admin', pendingCenter: 'institution' };

function onSurface(gate: Gate, surface: Surface, options: FakeOptions = {}): Request {
  return fakeRequest(gate, { listener: LISTENER_OF[surface], host: HOST_OF[surface], ...options });
}

// ---------------------------------------------------------------------------
// Configuration (D4, D5, D7)
// ---------------------------------------------------------------------------

test('config: production pins hostnames and https origins, with per-listener proxies and default ports', () => {
  assert.deepEqual({ ...productionConfig.hostnames }, { ...PINNED_SURFACE_HOSTNAMES });
  assert.deepEqual({ ...productionConfig.expectedOrigins }, {
    marketing: 'https://eltnoy.com', exam: 'https://exam.eltnoy.com', institution: 'https://institution.eltnoy.com', admin: 'https://admin.eltnoy.com',
  });
  assert.deepEqual({ public: [...productionConfig.trustedProxies.public], admin: [...productionConfig.trustedProxies.admin] }, {
    public: ['172.30.0.10/32'], admin: ['172.31.0.10/32'],
  });
  assert.deepEqual({ ...productionConfig.listenerPorts }, { public: 4000, admin: 4001 });
  assert.equal(productionConfig.mode, 'production');
});

const WITH = (publicList: string | undefined, adminList: string | undefined, extra: Record<string, string> = {}) => ({
  [SURFACE_ENV.mode]: 'production',
  ...(publicList === undefined ? {} : { [SURFACE_ENV.publicProxyCidrs]: publicList }),
  ...(adminList === undefined ? {} : { [SURFACE_ENV.adminProxyCidrs]: adminList }),
  ...extra,
});

test('config (H-1): both per-listener proxy lists are required in production; the shared list is rejected', () => {
  for (const env of [
    {},
    { [SURFACE_ENV.mode]: 'prod', [SURFACE_ENV.publicProxyCidrs]: PUBLIC_PROXY, [SURFACE_ENV.adminProxyCidrs]: ADMIN_PROXY },
    WITH(undefined, undefined),
    WITH(PUBLIC_PROXY, undefined),
    WITH(undefined, ADMIN_PROXY),
    WITH('', ADMIN_PROXY),
    WITH(PUBLIC_PROXY, '   '),
    WITH(PUBLIC_PROXY, ADMIN_PROXY, { [SURFACE_ENV.legacyTrustedProxyCidrs]: '172.30.0.10' }),
    { [SURFACE_ENV.mode]: 'production', [SURFACE_ENV.legacyTrustedProxyCidrs]: '172.30.0.10' },
  ]) {
    assert.equal(loadSurfaceRuntimeConfig(env).ok, false, JSON.stringify(env));
  }
});

test('config (H-1/M-1): public and Admin lists must not overlap', () => {
  for (const [publicList, adminList] of [
    ['172.30.0.10', '172.30.0.10'],
    ['172.30.0.10/32', '172.30.0.10'],
    ['172.30.0.10,172.30.0.11', '172.30.0.11'],
    ['fd00::10', 'FD00:0:0:0:0:0:0:10'],
  ]) {
    const result = loadSurfaceRuntimeConfig(WITH(publicList, adminList));
    assert.equal(result.ok, false, `${publicList} / ${adminList}`);
    assert.ok(!result.ok && result.errors.some((error) => /trusted by one listener only/.test(error)));
  }
});

test('config (M-1): only individual proxy addresses are trusted — no subnets, broad or any-address ranges', () => {
  const rejected = [
    '0.0.0.0/1,128.0.0.0/1', // together: every IPv4 address
    '0.0.0.0/0', '::/0',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', // broad RFC 1918
    '172.30.0.0/24', '172.30.0.8/29', '172.30.0.10/31', // subnets, however small
    'fd00::/8', 'fd00:abcd::/64', 'fd00::10/127', // broad and small IPv6 ranges
    '172.30.0.10/24', 'fd00::10/64', // host bits
    '172.30.0.10/33', '172.30.0.10/', '172.30.0.10/032', 'proxy.internal', '172.30.0', '172.30.0.256', 'fe80::10%eth0',
    '172.30.0.10,', ',172.30.0.10', '172.30.0.10,,172.30.0.11', // empty entries
    '172.30.0.10,172.30.0.10', '172.30.0.10,172.30.0.10/32', // duplicates
  ];
  for (const list of rejected) {
    assert.equal(loadSurfaceRuntimeConfig(WITH(list, ADMIN_PROXY)).ok, false, `public ${list}`);
    assert.equal(loadSurfaceRuntimeConfig(WITH(PUBLIC_PROXY, list)).ok, false, `admin ${list}`);
  }
  // Exact single addresses are accepted, IPv4 /32 and IPv6 /128, with or without the prefix.
  for (const [publicList, adminList] of [
    ['172.30.0.10', '172.31.0.10'],
    ['172.30.0.10/32', '172.31.0.10/32'],
    ['fd00:1::10', 'fd00:2::10/128'],
    ['172.30.0.10,172.30.0.11', 'fd00:2::10'],
  ]) {
    const result = loadSurfaceRuntimeConfig(WITH(publicList, adminList));
    assert.ok(result.ok, `${publicList} / ${adminList}: ${result.ok ? '' : result.errors.join('; ')}`);
  }
});

test('config (M-1): loopback, link-local, multicast, reserved and unspecified addresses are rejected', () => {
  for (const address of [
    '127.0.0.1', '127.0.0.53', '::1', // loopback outside development
    '169.254.10.10', 'fe80::10', // link-local
    '224.0.0.10', '239.1.2.3', '255.255.255.255', 'ff02::10', // multicast / broadcast
    '0.0.0.0', '0.1.2.3', '::', // unspecified / reserved
  ]) {
    assert.equal(loadSurfaceRuntimeConfig(WITH(address, ADMIN_PROXY)).ok, false, address);
  }
  // Staging applies the same strict rules.
  const STAGING = {
    [SURFACE_ENV.mode]: 'staging',
    [SURFACE_ENV.hostnames.marketing]: 'staging.example.test',
    [SURFACE_ENV.hostnames.exam]: 'exam.staging.example.test',
    [SURFACE_ENV.hostnames.institution]: 'institution.staging.example.test',
    [SURFACE_ENV.hostnames.admin]: 'admin.staging.example.test',
  };
  assert.equal(loadSurfaceRuntimeConfig({ ...STAGING, [SURFACE_ENV.publicProxyCidrs]: '10.20.0.0/16', [SURFACE_ENV.adminProxyCidrs]: '10.21.0.10' }).ok, false);
  assert.equal(loadSurfaceRuntimeConfig({ ...STAGING, [SURFACE_ENV.publicProxyCidrs]: '127.0.0.1', [SURFACE_ENV.adminProxyCidrs]: '10.21.0.10' }).ok, false);
});

test('config (L-A): individual addresses ending in .0, .1 or .255 are accepted when otherwise valid', () => {
  // Whether a /32 is a network, gateway or broadcast address depends on the real subnet (e.g. in a
  // /16 these are ordinary host addresses). No rule is inferred from the suffix; P1-F verifies each
  // configured address against the proxy container's own address and network configuration.
  for (const [publicList, adminList] of [
    ['172.30.1.0', '172.31.1.0'],
    ['172.30.5.1', '172.31.5.1'],
    ['172.30.0.255', '172.31.0.255'],
    ['10.20.0.1/32', '10.21.0.255/32'],
    ['172.30.1.0,172.30.0.255', 'fd00:2::1'],
  ]) {
    const result = loadSurfaceRuntimeConfig(WITH(publicList, adminList));
    assert.ok(result.ok, `${publicList} / ${adminList}: ${result.ok ? '' : result.errors.join('; ')}`);
  }
  // Suffix acceptance does not relax anything else.
  for (const [publicList, adminList] of [
    ['172.30.0.1', '172.30.0.1'], // overlap across listeners
    ['172.30.0.1,172.30.0.1', ADMIN_PROXY], // duplicate
    ['172.30.0.0/24', ADMIN_PROXY], // subnet
    ['172.30.0.1/24', ADMIN_PROXY], // host bits
    ['255.255.255.255', ADMIN_PROXY], // limited broadcast stays special-purpose
    ['0.0.0.0', ADMIN_PROXY], ['224.0.0.1', ADMIN_PROXY], ['169.254.0.1', ADMIN_PROXY], ['127.0.0.1', ADMIN_PROXY],
    ['::ffff:172.30.0.1', ADMIN_PROXY],
  ]) {
    assert.equal(loadSurfaceRuntimeConfig(WITH(publicList, adminList)).ok, false, `${publicList} / ${adminList}`);
  }
});

// ---------------------------------------------------------------------------
// I-6: one canonical proxy validator for the loader, configure() and the Express adapter
// ---------------------------------------------------------------------------

test('validator (I-6): validateTrustedProxies accepts a valid configuration and rejects every unsafe shape', () => {
  const valid = validateTrustedProxies({ public: ['172.30.0.10/32'], admin: ['172.31.0.10'] }, 'production');
  assert.equal(valid.ok, true);
  assert.deepEqual({ public: [...valid.texts.public], admin: [...valid.texts.admin] }, { public: ['172.30.0.10/32'], admin: ['172.31.0.10/32'] });
  const rejected: Array<[unknown, unknown, string]> = [
    [{ public: ['172.30.0.10'] }, 'production', 'missing Admin list'],
    [{ admin: ['172.31.0.10'] }, 'production', 'missing public list'],
    [{ public: [], admin: ['172.31.0.10'] }, 'production', 'empty list'],
    [null, 'production', 'no lists'],
    [{ public: '172.30.0.10', admin: 42 }, 'production', 'non-list value'],
    [{ public: ['172.30.0.10', 7], admin: ['172.31.0.10'] }, 'production', 'non-string entry'],
    [{ public: ['not-an-address'], admin: ['172.31.0.10'] }, 'production', 'invalid address'],
    [{ public: ['172.30.0.0/24'], admin: ['172.31.0.10'] }, 'production', 'subnet'],
    [{ public: ['172.30.0.10', '172.30.0.10/32'], admin: ['172.31.0.10'] }, 'production', 'duplicate'],
    [{ public: ['172.30.0.10'], admin: ['172.30.0.10'] }, 'production', 'overlap'],
    [{ public: ['127.0.0.1'], admin: ['172.31.0.10'] }, 'production', 'production loopback'],
    [{ public: ['::1'], admin: ['172.31.0.10'] }, 'staging', 'staging loopback'],
    [{ public: ['::ffff:172.30.0.10'], admin: ['172.31.0.10'] }, 'production', 'mapped IPv6'],
    [{ public: ['172.30.0.10'], admin: ['172.31.0.10'] }, 'prod', 'unknown mode'],
    [{ public: ['172.30.0.10'], admin: ['172.31.0.10'] }, undefined, 'missing mode'],
  ];
  for (const [lists, mode, label] of rejected) {
    const result = validateTrustedProxies(lists, mode);
    assert.equal(result.ok, false, label);
    assert.deepEqual([...result.texts.public, ...result.texts.admin], [], `${label}: no partial output`);
    assert.ok(!JSON.stringify(result.errors).match(/172\.3[01]|127\.0|::1|not-an-address/), `${label}: no values in errors`);
  }
  // Development-only exception: distinct loopback addresses.
  assert.equal(validateTrustedProxies({ public: ['127.0.0.1'], admin: ['::1'] }, 'development').ok, true);
  assert.equal(validateTrustedProxies({ public: ['127.0.0.1'], admin: ['127.0.0.1'] }, 'development').ok, false, 'still no overlap');
});

test('validator (I-6): configure() rejects unsafe hand-built configurations', () => {
  // The mode is passed explicitly (a default parameter would turn `undefined` into a valid mode).
  const build = (trustedProxies: unknown, mode: unknown) => () => createSurfaceGate().configure({ ...productionConfig, mode, trustedProxies } as never);
  assert.doesNotThrow(build({ public: ['172.30.0.10/32'], admin: ['172.31.0.10/32'] }, 'production'));
  for (const [trustedProxies, mode] of [
    [{ public: ['127.0.0.1/32'], admin: ['172.31.0.10/32'] }, 'production'], // production loopback
    [{ public: ['169.254.0.10/32'], admin: ['172.31.0.10/32'] }, 'production'], // link-local
    [{ public: ['172.30.0.10/32', '172.30.0.10/32'], admin: ['172.31.0.10/32'] }, 'production'], // duplicate
    [{ public: ['::ffff:172.30.0.10/128'], admin: ['172.31.0.10/32'] }, 'production'], // mapped
    [{ public: ['172.30.0.10/32'], admin: ['172.31.0.10/32'] }, 'unknown'], // mode
    [{ public: ['172.30.0.10/32'], admin: ['172.31.0.10/32'] }, undefined], // mode missing
    [{ public: '172.30.0.0/24', admin: ['172.31.0.10/32'] }, 'production'], // a string list is validated the same way
    [undefined, 'production'],
  ] as Array<[unknown, unknown]>) {
    assert.throws(build(trustedProxies, mode), /Invalid trusted proxy configuration/, JSON.stringify([trustedProxies, mode]));
  }
  assert.doesNotThrow(build({ public: ['127.0.0.1/32'], admin: ['::1/128'] }, 'development'), 'development loopback exception');
});

test('validator (I-6): the Express trust adapter refuses unsafe hand-built configurations', () => {
  assert.throws(() => createExpressProxyTrust({ mode: 'production', trustedProxies: { public: ['172.30.0.0/24'], admin: ['172.31.0.10/32'] } }), /Invalid/);
  assert.throws(() => createExpressProxyTrust({ mode: 'production', trustedProxies: { public: ['127.0.0.1/32'], admin: ['172.31.0.10/32'] } }), /Invalid/);
  assert.throws(() => createExpressProxyTrust({ mode: 'production', trustedProxies: { public: ['172.30.0.10/32'], admin: ['172.30.0.10/32'] } }), /Invalid/);
  assert.throws(() => createExpressProxyTrust({ trustedProxies: { public: ['172.30.0.10/32'], admin: ['172.31.0.10/32'] } } as never), /Invalid/, 'mode required');
  const trust = createExpressProxyTrust(productionConfig);
  assert.equal(trust(PUBLIC_PROXY, 0), true);
  assert.equal(trust(ADMIN_PROXY, 0), true);
  assert.equal(trust('172.30.0.11', 0), false);
  assert.equal(trust(PUBLIC_PROXY, 1), false);
});

test('config (L-2): IPv4-mapped IPv6 proxy entries are rejected in every form', () => {
  for (const address of ['::ffff:172.30.0.10', '::ffff:172.30.0.10/128', '::ffff:127.0.0.1/128', '::ffff:ac1e:a', '0:0:0:0:0:ffff:ac1e:a/128', '::ffff:0:0/96', '::/80']) {
    assert.equal(parseProxyRange(address), null, address);
    assert.equal(loadSurfaceRuntimeConfig(WITH(address, ADMIN_PROXY)).ok, false, address);
  }
});

test('config: production fails closed for invalid mode, hostname overrides, dev settings and ports', () => {
  for (const env of [
    { ...PRODUCTION_ENV, [SURFACE_ENV.hostnames.admin]: 'admin.example.test' },
    { ...PRODUCTION_ENV, [SURFACE_ENV.devOriginScheme]: 'http' },
    { ...PRODUCTION_ENV, [SURFACE_ENV.devOriginPort]: '5173' },
    { ...PRODUCTION_ENV, PORT: '4001' },
    { ...PRODUCTION_ENV, ADMIN_PORT: '70000' },
    { ...PRODUCTION_ENV, PORT: 'abc' },
  ]) {
    assert.equal(loadSurfaceRuntimeConfig(env).ok, false, JSON.stringify(env));
  }
  // Setting a hostname to the pinned value is harmless in production.
  assert.equal(loadSurfaceRuntimeConfig({ ...PRODUCTION_ENV, [SURFACE_ENV.hostnames.admin]: 'admin.eltnoy.com' }).ok, true);
});

test('config: staging and development require explicit, valid, non-production hostnames', () => {
  const STAGING_HOSTS = {
    [SURFACE_ENV.hostnames.marketing]: 'staging.example.test',
    [SURFACE_ENV.hostnames.exam]: 'exam.staging.example.test',
    [SURFACE_ENV.hostnames.institution]: 'institution.staging.example.test',
    [SURFACE_ENV.hostnames.admin]: 'admin.staging.example.test',
  };
  const PROXIES = { [SURFACE_ENV.publicProxyCidrs]: '10.20.0.10', [SURFACE_ENV.adminProxyCidrs]: '10.21.0.10' };
  const staging = loadSurfaceRuntimeConfig({ [SURFACE_ENV.mode]: 'staging', ...PROXIES, ...STAGING_HOSTS });
  assert.ok(staging.ok);
  assert.equal(staging.config.expectedOrigins.exam, 'https://exam.staging.example.test');
  for (const env of [
    { [SURFACE_ENV.mode]: 'staging', ...PROXIES },
    { [SURFACE_ENV.mode]: 'staging', ...PROXIES, ...STAGING_HOSTS, [SURFACE_ENV.hostnames.exam]: 'exam.eltnoy.com' },
    { [SURFACE_ENV.mode]: 'staging', ...PROXIES, ...STAGING_HOSTS, [SURFACE_ENV.hostnames.exam]: 'staging.example.test' },
    { [SURFACE_ENV.mode]: 'staging', ...PROXIES, ...STAGING_HOSTS, [SURFACE_ENV.hostnames.exam]: 'Exam.Staging.Example.Test' },
    { [SURFACE_ENV.mode]: 'staging', ...PROXIES, ...STAGING_HOSTS, [SURFACE_ENV.hostnames.exam]: 'exam.staging.example.test:443' },
    { [SURFACE_ENV.mode]: 'staging', ...STAGING_HOSTS, [SURFACE_ENV.publicProxyCidrs]: '127.0.0.1', [SURFACE_ENV.adminProxyCidrs]: '10.21.0.10' },
  ]) {
    assert.equal(loadSurfaceRuntimeConfig(env).ok, false, JSON.stringify(env));
  }
});

test('config: development allows distinct loopback proxies and an explicit dev origin, never under NODE_ENV=production', () => {
  const DEV = {
    [SURFACE_ENV.mode]: 'development',
    [SURFACE_ENV.publicProxyCidrs]: '127.0.0.1',
    [SURFACE_ENV.adminProxyCidrs]: '::1',
    [SURFACE_ENV.hostnames.marketing]: 'eltnoy.localhost',
    [SURFACE_ENV.hostnames.exam]: 'exam.localhost',
    [SURFACE_ENV.hostnames.institution]: 'institution.localhost',
    [SURFACE_ENV.hostnames.admin]: 'admin.localhost',
    [SURFACE_ENV.devOriginScheme]: 'http',
    [SURFACE_ENV.devOriginPort]: '5173',
  };
  const dev = loadSurfaceRuntimeConfig(DEV);
  assert.ok(dev.ok);
  assert.equal(dev.config.expectedOrigins.exam, 'http://exam.localhost:5173');
  assert.deepEqual({ public: [...dev.config.trustedProxies.public], admin: [...dev.config.trustedProxies.admin] }, { public: ['127.0.0.1/32'], admin: ['::1/128'] });
  assert.equal(loadSurfaceRuntimeConfig({ ...DEV, NODE_ENV: 'production' }).ok, false);
  assert.equal(loadSurfaceRuntimeConfig({ ...DEV, [SURFACE_ENV.devOriginScheme]: 'ftp' }).ok, false);
  assert.equal(loadSurfaceRuntimeConfig({ ...DEV, [SURFACE_ENV.adminProxyCidrs]: '127.0.0.1' }).ok, false, 'overlap is rejected in development too');
  assert.equal(loadSurfaceRuntimeConfig({ ...DEV, [SURFACE_ENV.publicProxyCidrs]: '127.0.0.0/8' }).ok, false, 'subnets are rejected in development too');
});

test('config: error messages name settings and rules, never configured values', () => {
  const secretish = 'value-that-must-not-be-echoed';
  const result = loadSurfaceRuntimeConfig({
    [SURFACE_ENV.mode]: 'staging',
    [SURFACE_ENV.publicProxyCidrs]: `${secretish},10.0.0.0/8`,
    [SURFACE_ENV.adminProxyCidrs]: secretish,
    [SURFACE_ENV.legacyTrustedProxyCidrs]: secretish,
    [SURFACE_ENV.hostnames.admin]: secretish,
    PORT: secretish,
    [SURFACE_ENV.devOriginPort]: secretish,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.length >= 3);
  assert.ok(!JSON.stringify(result).includes(secretish));
  assert.ok(!JSON.stringify(result).includes('10.0.0.0'));
});

// ---------------------------------------------------------------------------
// Listener mapping, peers and proxy ranges (pure functions)
// ---------------------------------------------------------------------------

test('listener map: public serves Marketing/Exam/Institution, admin serves Admin only', () => {
  assert.deepEqual({ public: [...LISTENER_SURFACES.public], admin: [...LISTENER_SURFACES.admin] }, {
    public: ['marketing', 'exam', 'institution'], admin: ['admin'],
  });
  for (const surface of SURFACES) {
    for (const listener of ['public', 'admin'] as const) {
      const expected = LISTENER_OF[surface] === listener ? surface : null;
      assert.equal(surfaceForListenerAndHost(listener, HOST_OF[surface]), expected, `${surface} host on ${listener}`);
      assert.equal(surfaceForListenerAndHost(listener, HOST_OF[surface].toUpperCase()), expected, 'case normalised');
    }
  }
  for (const raw of [undefined, '', 'exam.eltnoy.com:443', 'exam.eltnoy.com,admin.eltnoy.com', ['exam.eltnoy.com'], 'evil.com']) {
    assert.equal(surfaceForListenerAndHost('public', raw), null, JSON.stringify(raw));
  }
  assert.equal(surfaceForListenerAndHost('staff', 'exam.eltnoy.com'), null);
});

test('peers: IPv4-mapped IPv6 normalises to IPv4; malformed and zoned addresses are rejected', () => {
  assert.equal(normalizePeerAddress('::ffff:172.30.0.10')?.address, '172.30.0.10');
  assert.equal(normalizePeerAddress('::FFFF:172.30.0.10')?.family, 4);
  assert.equal(normalizePeerAddress('0:0:0:0:0:ffff:172.30.0.10')?.address, '172.30.0.10');
  assert.equal(normalizePeerAddress('172.30.0.10')?.family, 4);
  assert.equal(normalizePeerAddress('fd00::5')?.family, 6);
  for (const raw of [undefined, '', 'localhost', '172.30.0.256', '172.30.0', '::ffff:172.30.0.999', 'fe80::1%eth0', ':ffff:172.30.0.10', '1:2:3:4:5:6:7:8:9', 42]) {
    assert.equal(normalizePeerAddress(raw), null, String(raw));
  }
  const ranges = [parseProxyRange('172.30.0.0/24')!, parseProxyRange('fd00:abcd::/32')!];
  assert.equal(isPeerInRanges(normalizePeerAddress('::ffff:172.30.0.200'), ranges), true);
  assert.equal(isPeerInRanges(normalizePeerAddress('172.30.1.1'), ranges), false);
  assert.equal(isPeerInRanges(normalizePeerAddress('fd00:abcd:1::9'), ranges), true);
  assert.equal(isPeerInRanges(normalizePeerAddress('fd00:abce::9'), ranges), false);
  assert.equal(isPeerInRanges(null, ranges), false);
  assert.equal(isLoopbackPeer(normalizePeerAddress('::ffff:127.0.0.1')), true);
  assert.equal(isLoopbackPeer(normalizePeerAddress('::1')), true);
  assert.equal(isLoopbackPeer(normalizePeerAddress('127.0.0.2')), false);
  assert.equal(parseProxyRange('172.30.0.0/24')?.text, '172.30.0.0/24');
  assert.equal(parseProxyRange('10.1.2.3')?.text, '10.1.2.3/32');
  for (const raw of ['0.0.0.0/0', '::/0', '10.0.0.1/8', 'fd00::1/64', '10.0.0.0/', '10.0.0.0/08', '10.0.0.0/8/1', 'x', '', 7]) {
    assert.equal(parseProxyRange(raw), null, String(raw));
  }
});

// ---------------------------------------------------------------------------
// Gate: listener identity, peer and original host (421)
// ---------------------------------------------------------------------------

test('gate: unconfigured gate fails closed (503) and configuration is validated once', async () => {
  const gate = createSurfaceGate();
  const outcome = await runGate(gate, fakeRequest(gate));
  assert.equal(outcome.status, 503);
  gate.configure(productionConfig);
  assert.throws(() => gate.configure(productionConfig));
  assert.throws(() => createSurfaceGate().configure({ ...productionConfig, trustedProxies: { public: [], admin: ['172.31.0.10/32'] } }));
  assert.throws(() => createSurfaceGate().configure({ ...productionConfig, trustedProxies: { public: ['172.30.0.0/24'], admin: ['172.31.0.10/32'] } }), /Invalid/, 'subnets refused by the gate too');
  assert.throws(() => createSurfaceGate().configure({ ...productionConfig, trustedProxies: { public: ['172.30.0.10/32'], admin: ['172.30.0.10/32'] } }), /one listener only/);
});

test('gate: listener identity is server-assigned and must match socket.localPort', async () => {
  const gate = configuredGate();
  assert.equal((await runGate(gate, fakeRequest(gate, { listener: null }))).status, 421, 'untagged request');
  assert.equal((await runGate(gate, fakeRequest(gate, { localPort: 4001 }))).status, 421, 'public tag on the admin port');
  assert.equal((await runGate(gate, fakeRequest(gate, { listener: 'admin', localPort: 4000, host: 'admin.eltnoy.com' }))).status, 421);
  const request = fakeRequest(gate);
  assert.throws(() => gate.tagListener(request as never, 'admin'), /already set/);
  // Client-controlled values cannot set or change the listener or surface.
  const spoof = fakeRequest(gate, { listener: null, headers: { 'x-eltnoy-listener': 'admin', 'x-eltnoy-surface': 'admin' } });
  Object.assign(spoof, { surface: 'admin', listener: 'admin', body: { surface: 'admin' }, query: { surface: 'admin' } });
  assert.equal((await runGate(gate, spoof)).status, 421);
  assert.equal(getTrustedRequestSurface(spoof), undefined);
});

test('gate: only configured proxy peers are trusted; direct clients and other peers get 421', async () => {
  const gate = configuredGate();
  for (const peer of ['203.0.113.7', '172.30.1.10', '127.0.0.1', '::1', '::ffff:203.0.113.7', 'garbage', '']) {
    resetDb();
    const outcome = await runGate(gate, fakeRequest(gate, { peer, account: 'candidate' }));
    assert.equal(outcome.status, 421, peer);
    assert.deepEqual(outcome.body, { error: 'Misdirected request.' });
    assert.equal(db.sessionQueries + db.businessQueries.length, 0);
  }
  assert.equal((await runGate(gate, fakeRequest(gate, { peer: '::ffff:172.30.0.10', account: 'candidate' }))).reached, true, 'IPv4-mapped trusted peer');
});

// ---------------------------------------------------------------------------
// H-1: proxy trust is per listener
// ---------------------------------------------------------------------------

test('gate (H-1): the public proxy is trusted only by the public listener, the Admin proxy only by the Admin listener', async () => {
  const gate = configuredGate();
  const exam = { host: 'exam.eltnoy.com', account: 'candidate' as const };
  const admin = { listener: 'admin' as const, host: 'admin.eltnoy.com', account: 'official' as const };
  assert.equal((await runGate(gate, fakeRequest(gate, { ...exam, peer: PUBLIC_PROXY }))).reached, true, 'public proxy → public listener');
  assert.equal((await runGate(gate, fakeRequest(gate, { ...admin, peer: ADMIN_PROXY }))).reached, true, 'Admin proxy → Admin listener');
  resetDb();
  assert.equal((await runGate(gate, fakeRequest(gate, { ...admin, peer: PUBLIC_PROXY }))).status, 421, 'public proxy → Admin listener');
  assert.equal((await runGate(gate, fakeRequest(gate, { ...exam, peer: ADMIN_PROXY }))).status, 421, 'Admin proxy → public listener');
  assert.equal((await runGate(gate, fakeRequest(gate, { ...admin, peer: `::ffff:${PUBLIC_PROXY}` }))).status, 421, 'mapped form of the public proxy');
  assert.equal(db.sessionQueries + db.businessQueries.length, 0, 'rejected before any query');
  // Exact addresses only: a neighbouring address in the same subnet is not trusted.
  assert.equal((await runGate(gate, fakeRequest(gate, { ...exam, peer: '172.30.0.11' }))).status, 421);
});

test('gate (H-1): request headers cannot choose the listener or its trusted proxies', async () => {
  const gate = configuredGate();
  // Accepted by the public listener (server-assigned), from the Admin proxy, claiming Admin.
  const forged = fakeRequest(gate, {
    peer: ADMIN_PROXY,
    host: 'admin.eltnoy.com',
    account: 'official',
    headers: { 'x-eltnoy-listener': 'admin', 'x-forwarded-port': '4001', 'x-forwarded-host': 'admin.eltnoy.com' },
  });
  assert.equal((await runGate(gate, forged)).status, 421);
  assert.equal(getTrustedRequestSurface(forged), undefined);
});

// ---------------------------------------------------------------------------
// L-2: gate trust and Express proxy-addr trust agree
// ---------------------------------------------------------------------------

const requireFromHere = createRequire(import.meta.url);
const proxyaddr = createRequire(requireFromHere.resolve('express/package.json'))('proxy-addr') as ((req: unknown, trust: (address: string, hop: number) => boolean) => string) & {
  compile: (value: string[]) => (address: string, hop: number) => boolean;
};

const PEER_SAMPLES = [
  '172.30.0.10', '::ffff:172.30.0.10', '::FFFF:172.30.0.10', '::ffff:ac1e:a', '0:0:0:0:0:ffff:ac1e:a', '172.30.0.11',
  '172.31.0.10', '::ffff:172.31.0.10', '127.0.0.1', '::ffff:127.0.0.1', '::1', 'fd00:1::10', 'fd00:1::11', 'fd00:2::10',
  '203.0.113.7', '::',
];

test('trust (L-2): for every configured list, the gate and Express proxy-addr decide hop 0 identically', () => {
  const configs = [
    productionConfig,
    (() => { const r = loadSurfaceRuntimeConfig(WITH('fd00:1::10,172.30.0.10', 'fd00:2::10')); assert.ok(r.ok); return r.config; })(),
  ];
  for (const config of configs) {
    const all = [...config.trustedProxies.public, ...config.trustedProxies.admin];
    const express = proxyaddr.compile(all);
    const ours = createExpressProxyTrust(config);
    const gateRanges = all.map((text) => parseProxyRange(text)!);
    for (const address of PEER_SAMPLES) {
      const expected = express(address, 0);
      assert.equal(ours(address, 0), expected, `express trust adapter vs proxy-addr: ${address}`);
      assert.equal(isPeerInRanges(normalizePeerAddress(address), gateRanges), expected, `gate vs proxy-addr: ${address}`);
    }
    // Only the direct peer is ever trusted; client-supplied hops never are.
    for (const address of all.map((text) => text.split('/')[0])) assert.equal(ours(address, 1), false);
  }
});

test('trust (L-2/M-1): req.ip is the address the proxy appended; spoofed X-Forwarded-For entries are ignored', () => {
  const trust = createExpressProxyTrust(productionConfig);
  const ip = (peer: string, xff?: string) => proxyaddr({
    connection: { remoteAddress: peer },
    socket: { remoteAddress: peer },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  }, trust);
  assert.equal(ip(PUBLIC_PROXY, '198.51.100.7'), '198.51.100.7');
  assert.equal(ip(PUBLIC_PROXY, '1.2.3.4, 9.9.9.9, 198.51.100.7'), '198.51.100.7', 'leftmost spoofed entries ignored');
  assert.equal(ip(PUBLIC_PROXY, `${ADMIN_PROXY}, 198.51.100.7`), '198.51.100.7');
  assert.equal(ip(PUBLIC_PROXY, `1.2.3.4, ${ADMIN_PROXY}`), ADMIN_PROXY, 'a client using a proxy address is still not walked past');
  assert.equal(ip('203.0.113.7', '198.51.100.7'), '203.0.113.7', 'an untrusted peer cannot set req.ip');
});

// ---------------------------------------------------------------------------
// L-3: bounded, aggregated rejection logging
// ---------------------------------------------------------------------------

test('rejection log (L-C): first-seen lines are written once per reason for the whole process', () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = createRejectionLog((entry) => lines.push(entry), { summaryEvery: 100 });
  for (let i = 0; i < 250; i += 1) log.record(i % 2 === 0 ? 'untrusted_peer' : 'origin_rejected');
  // One automatic summary at 100 pending; the next interval doubles (200), so 150 stay pending.
  assert.equal(lines.filter((line) => line.event === 'surface.rejection_first_seen').length, 2);
  assert.equal(lines.filter((line) => line.event === 'surface.rejection_summary').length, 1);
  assert.deepEqual(log.snapshot(), { total: 150, reasons: { untrusted_peer: 75, origin_rejected: 75 }, groups: { proxy_host: 75, origin: 75 } });
  const summary = log.flush();
  assert.deepEqual(summary, { total: 150, reasons: { untrusted_peer: 75, origin_rejected: 75 }, groups: { proxy_host: 75, origin: 75 } });
  // After summaries, the same reasons never produce another first-seen line.
  for (let i = 0; i < 500; i += 1) log.record('untrusted_peer');
  assert.equal(lines.filter((line) => line.event === 'surface.rejection_first_seen').length, 2);
  assert.deepEqual(log.stats().announcedReasons, ['untrusted_peer', 'origin_rejected']);
});

test('rejection log (L-C): high volume produces logarithmic, capped output and bounded state', () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = createRejectionLog((entry) => lines.push(entry), { summaryEvery: 10, maxAutomaticSummaries: 5 });
  for (let i = 0; i < 1_000_000; i += 1) log.record(REJECTION_REASONS[i % REJECTION_REASONS.length]);
  const firstSeen = lines.filter((line) => line.event === 'surface.rejection_first_seen').length;
  const summaries = lines.filter((line) => line.event === 'surface.rejection_summary').length;
  assert.equal(firstSeen, REJECTION_REASONS.length, 'one per fixed reason');
  assert.equal(summaries, 5, 'automatic summaries stop at the cap');
  assert.ok(lines.length <= REJECTION_REASONS.length + 5);
  const stats = log.stats();
  assert.equal(stats.lifetimeTotal, 1_000_000);
  assert.equal(stats.automaticSummaries, 5);
  assert.equal(stats.automaticSummariesCapped, true);
  // Retained state: at most one counter per fixed reason.
  assert.ok(Object.keys(log.snapshot().reasons).length <= REJECTION_REASONS.length);
  // Default schedule: 1000, then doubling, at most 32 automatic summaries per process.
  const defaults: unknown[] = [];
  const defaultLog = createRejectionLog((entry) => defaults.push(entry));
  for (let i = 0; i < 100_000; i += 1) defaultLog.record('untrusted_peer');
  assert.equal(defaults.filter((entry) => (entry as { event: string }).event === 'surface.rejection_summary').length, 6, 'at 1k, 2k, 4k, 8k, 16k and 32k pending');
});

test('rejection log (L-C): shutdown flush writes pending counts once and never recurses', () => {
  const lines: Array<Record<string, unknown>> = [];
  let reentered = false;
  // A writer that records and flushes from inside a write (e.g. a logger failing back into the gate).
  const log: ReturnType<typeof createRejectionLog> = createRejectionLog((entry) => {
    lines.push(entry);
    if (!reentered) {
      reentered = true;
      log.record('route_denied');
      assert.equal(log.flush(), null, 'no summary from inside a write');
    }
  }, { summaryEvery: 1000 });
  for (let i = 0; i < 3; i += 1) log.record('origin_rejected');
  assert.equal(lines.length, 1, 'only the origin_rejected first-seen line; no recursive write');
  const summary = log.flush();
  assert.deepEqual(summary, { total: 4, reasons: { origin_rejected: 3, route_denied: 1 }, groups: { origin: 3, route: 1 } });
  assert.equal(lines.filter((line) => line.event === 'surface.rejection_summary').length, 1);
  assert.equal(log.flush(), null, 'a second shutdown flush writes nothing (no duplicate)');
  // A reason first seen during a write is announced at its next record instead of being lost.
  log.record('route_denied');
  assert.equal(lines.filter((line) => line.event === 'surface.rejection_first_seen' && line.reason === 'route_denied').length, 1);
});

test('rejection log (L-3): only fixed reason keys are counted; authentication stays distinct from proxy/host', () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = createRejectionLog((entry) => lines.push(entry));
  for (const reason of ['x-attacker-value', '__proto__', 'constructor', 'admin.eltnoy.com', '203.0.113.7']) log.record(reason as never);
  assert.deepEqual(log.snapshot(), { total: 0, reasons: {}, groups: {} });
  assert.equal(lines.length, 0);
  for (const reason of REJECTION_REASONS) log.record(reason);
  assert.equal(log.snapshot().total, REJECTION_REASONS.length);
  assert.deepEqual(new Set(Object.values(REJECTION_GROUPS)), new Set(['proxy_host', 'origin', 'route', 'authentication']));
  assert.equal(REJECTION_GROUPS.authentication_failed, 'authentication');
  assert.equal(REJECTION_GROUPS.untrusted_peer, 'proxy_host');
});

test('rejection log (L-3): the gate reports fixed reasons only and never sensitive request values', async () => {
  const lines: string[] = [];
  const log = createRejectionLog((entry) => lines.push(JSON.stringify(entry)), { summaryEvery: 5 });
  const gate = createSurfaceGate({ onReject: (reason) => log.record(reason) });
  gate.configure(productionConfig);
  const secret = 'S3cr3t-Token-Value';
  const headers = { cookie: `elt_session=${secret}`, 'user-agent': secret, 'x-forwarded-for': secret };
  await runGate(gate, fakeRequest(gate, { peer: '203.0.113.7', headers }));
  await runGate(gate, fakeRequest(gate, { host: `${secret}.eltnoy.com`, headers }));
  await runGate(gate, fakeRequest(gate, { method: 'POST', url: '/api/feedback', origin: `https://${secret}.example`, headers }));
  await runGate(gate, fakeRequest(gate, { url: `/api/${secret}`, headers }));
  await runGate(gate, fakeRequest(gate, { url: '/api/answer-keys/exams', headers }));
  // authentication_failed is recorded when the session check settles, after its 401 was written.
  await new Promise((resolve) => setImmediate(resolve));
  log.flush();
  const output = lines.join('\n');
  assert.ok(!output.includes(secret), 'no cookie, token, header, host, origin or path values');
  assert.ok(!output.includes('203.0.113.7') && !output.includes('eltnoy.com'));
  for (const reason of ['untrusted_peer', 'invalid_original_host', 'origin_rejected', 'route_denied', 'authentication_failed']) {
    assert.ok(output.includes(reason), reason);
  }
});

test('rejection log (L-C): the routine anonymous Marketing /api/auth/me 401 is not counted; genuine failures are', async () => {
  const reasons: string[] = [];
  const gate = createSurfaceGate({ onReject: (reason) => reasons.push(reason) });
  gate.configure(productionConfig);
  // Routine: Marketing page-load session check, with or without a stale cookie, GET or HEAD.
  for (const options of [{}, { account: 'candidate' as const }, { method: 'HEAD' }, { url: '/API/Auth/Me/' }]) {
    const outcome = await runGate(gate, onSurface(gate, 'marketing', { url: '/api/auth/me', ...options }));
    assert.equal(outcome.status, 401, JSON.stringify(options));
  }
  assert.deepEqual(reasons, [], 'no security rejection recorded for the routine check');
  // Genuine: invalid session token, cross-surface session, anonymous protected route, wrong role.
  const genuine: Array<[Surface, FakeOptions]> = [
    ['exam', { url: '/api/answer-keys/exams', headers: { cookie: `elt_session=${'Z'.repeat(43)}` } }],
    ['exam', { url: '/api/auth/me', account: 'official' }],
    ['exam', { url: '/api/answer-keys/exams' }],
    ['admin', { url: '/api/admin/data-export', account: 'official' }],
  ];
  for (const [surface, options] of genuine) {
    reasons.length = 0;
    const outcome = await runGate(gate, onSurface(gate, surface, options));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok([401, 403].includes(outcome.status), `${surface} ${JSON.stringify(options)}`);
    assert.deepEqual(reasons, ['authentication_failed'], `${surface} ${JSON.stringify(options)}`);
  }
  // Marketing logout is not the routine check: it is refused by Origin (403) and counted.
  reasons.length = 0;
  await runGate(gate, onSurface(gate, 'marketing', { method: 'POST', url: '/api/auth/logout', origin: 'https://eltnoy.com' }));
  assert.deepEqual(reasons, ['origin_rejected']);
});

test('rejection log (L-3): a failing log writer never changes the rejection response', async () => {
  const log = createRejectionLog(() => {
    throw new Error('log sink down');
  }, { summaryEvery: 1 });
  const gate = createSurfaceGate({ onReject: (reason) => log.record(reason) });
  gate.configure(productionConfig);
  const outcome = await runGate(gate, fakeRequest(gate, { peer: '203.0.113.7' }));
  assert.equal(outcome.status, 421);
  assert.deepEqual(outcome.body, { error: 'Misdirected request.' });
  const throwingReporter = createSurfaceGate({ onReject: () => { throw new Error('reporter down'); } });
  throwingReporter.configure(productionConfig);
  assert.equal((await runGate(throwingReporter, fakeRequest(throwingReporter, { url: '/api/unknown' }))).status, 404);
});

test('gate: original host must be valid, single, port-free and belong to the receiving listener', async () => {
  const gate = configuredGate();
  for (const host of [null, '', 'exam.eltnoy.com:443', 'exam.eltnoy.com,admin.eltnoy.com', ['exam.eltnoy.com', 'exam.eltnoy.com'], 'evil.com', 'exam.eltnoy.com.', 'admin.eltnoy.com']) {
    assert.equal((await runGate(gate, fakeRequest(gate, { host, account: 'candidate' }))).status, 421, JSON.stringify(host));
  }
  assert.equal((await runGate(gate, fakeRequest(gate, { listener: 'admin', host: 'exam.eltnoy.com', account: 'candidate' }))).status, 421, 'public host on the admin listener');
  assert.equal((await runGate(gate, fakeRequest(gate, { host: 'EXAM.ELTNOY.COM', account: 'candidate' }))).reached, true, 'case is normalised');
});

test('gate: forged Host and X-Forwarded-Host never select the surface', async () => {
  const gate = configuredGate();
  // Host is ignored entirely: the surface comes from the trusted original host.
  const forgedHost = fakeRequest(gate, { account: 'candidate', headers: { host: 'admin.eltnoy.com' } });
  assert.equal((await runGate(gate, forgedHost)).reached, true);
  assert.equal(getTrustedRequestSurface(forgedHost), 'exam');
  // X-Forwarded-Host alone (no original host) is rejected; a mismatching one is rejected.
  assert.equal((await runGate(gate, fakeRequest(gate, { host: null, headers: { 'x-forwarded-host': 'exam.eltnoy.com' } }))).status, 421);
  assert.equal((await runGate(gate, fakeRequest(gate, { headers: { 'x-forwarded-host': 'admin.eltnoy.com' } }))).status, 421);
  assert.equal((await runGate(gate, fakeRequest(gate, { headers: { 'x-forwarded-host': 'exam.eltnoy.com:8443' } }))).status, 421);
  const consistent = fakeRequest(gate, { account: 'candidate', headers: { 'x-forwarded-host': 'exam.eltnoy.com' } });
  assert.equal((await runGate(gate, consistent)).reached, true);
});

// ---------------------------------------------------------------------------
// Gate: Origin (403)
// ---------------------------------------------------------------------------

test('gate: state-changing requests need the exact Origin of their surface', async () => {
  const gate = configuredGate();
  const post = (surface: Surface, origin: string | undefined) => runGate(gate, onSurface(gate, surface, {
    method: 'POST', url: '/api/feedback', origin, account: surface === 'exam' ? 'candidate' : 'center',
  }));
  assert.equal((await post('exam', 'https://exam.eltnoy.com')).reached, true);
  assert.equal((await post('institution', 'https://institution.eltnoy.com')).reached, true);
  for (const origin of [undefined, 'null', 'https://institution.eltnoy.com', 'https://eltnoy.com', 'https://admin.eltnoy.com', 'http://exam.eltnoy.com', 'https://exam.eltnoy.com:443', 'https://exam.eltnoy.com, https://exam.eltnoy.com']) {
    resetDb();
    const outcome = await post('exam', origin);
    assert.equal(outcome.status, 403, String(origin));
    assert.deepEqual(outcome.body, { error: 'Request origin is not allowed.' });
    assert.equal(db.sessionQueries + db.businessQueries.length, 0, 'rejected before any query');
  }
  // GET needs no Origin.
  assert.equal((await runGate(gate, onSurface(gate, 'exam', { url: '/api/auth/me', account: 'candidate' }))).reached, true);
});

// ---------------------------------------------------------------------------
// Gate: route policy and session binding for every locked endpoint
// ---------------------------------------------------------------------------

const LOCKED: Array<{ method: string; url: string; access: Record<Surface, 'deny' | 'anonymous' | 'candidate' | 'center'> }> = [
  { method: 'GET', url: '/api/notices', access: { marketing: 'anonymous', exam: 'deny', institution: 'deny', admin: 'deny' } },
  { method: 'GET', url: '/api/exams', access: { marketing: 'anonymous', exam: 'candidate', institution: 'deny', admin: 'deny' } },
  { method: 'GET', url: '/api/institute-forms', access: { marketing: 'anonymous', exam: 'deny', institution: 'deny', admin: 'deny' } },
  { method: 'GET', url: '/api/answer-keys/exams', access: { marketing: 'deny', exam: 'candidate', institution: 'deny', admin: 'deny' } },
  { method: 'GET', url: '/api/answer-keys?examCode=EXAM1', access: { marketing: 'deny', exam: 'candidate', institution: 'deny', admin: 'deny' } },
  { method: 'POST', url: '/api/feedback', access: { marketing: 'deny', exam: 'candidate', institution: 'center', admin: 'deny' } },
  { method: 'POST', url: '/api/mock-exams/submit', access: { marketing: 'deny', exam: 'candidate', institution: 'deny', admin: 'deny' } },
];

test('gate: every locked endpoint × surface × session state', async () => {
  const gate = configuredGate();
  let cases = 0;
  for (const row of LOCKED) {
    for (const surface of SURFACES) {
      for (const account of [undefined, 'candidate', 'center', 'official', 'superAdmin'] as const) {
        resetDb();
        const label = `${row.method} ${row.url} on ${surface} as ${account ?? 'anonymous'}`;
        const origin = row.method === 'POST' ? expectedOrigin(surface) : undefined;
        const outcome = await runGate(gate, onSurface(gate, surface, { method: row.method, url: row.url, origin, account }));
        const access = row.access[surface];
        assert.equal(db.businessQueries.length, 0, `${label}: no business query in the gate`);
        if (access === 'deny') {
          // Marketing state changes are refused by the Origin check (403) before route policy (404).
          assert.equal(outcome.status, surface === 'marketing' && row.method === 'POST' ? 403 : 404, label);
          assert.equal(db.sessionQueries, 0, `${label}: no session lookup`);
        } else if (access === 'anonymous') {
          assert.equal(outcome.reached, true, label);
          assert.equal(db.sessionQueries, 0, `${label}: public read never looks up a session, even with a cookie`);
        } else if (!account) {
          assert.equal(outcome.status, 401, label);
          assert.equal(db.sessionQueries, 0, `${label}: no token, no query`);
        } else if (SURFACE_OF_ACCOUNT[account] !== surface) {
          assert.equal(outcome.status, 401, `${label}: cross-surface session`);
          assert.equal(outcome.clearedCookie, false, `${label}: cross-surface cookie is not cleared`);
        } else {
          assert.equal(outcome.reached, true, label);
          assert.equal(db.sessionQueries, 1, `${label}: exactly one session lookup`);
        }
        cases += 1;
      }
    }
  }
  assert.equal(cases, LOCKED.length * 4 * 5);
});

test('gate: Marketing /api/auth/me and /api/auth/logout answer 401 without any session lookup', async () => {
  const gate = configuredGate();
  for (const account of [undefined, 'candidate', 'official'] as const) {
    resetDb();
    assert.equal((await runGate(gate, onSurface(gate, 'marketing', { url: '/api/auth/me', account }))).status, 401);
    // Marketing logout is a state change on a non-portal surface: the Origin check refuses it (403)
    // before route policy (which would answer 401) — and never with a session lookup.
    assert.equal((await runGate(gate, onSurface(gate, 'marketing', { method: 'POST', url: '/api/auth/logout', origin: 'https://eltnoy.com', account }))).status, 403);
    assert.equal((await runGate(gate, onSurface(gate, 'marketing', { method: 'POST', url: '/api/auth/logout', account }))).status, 403, 'missing Origin');
    assert.equal(db.sessionQueries + db.businessQueries.length, 0);
  }
});

test('gate: me/logout accept only the surface\'s own session; cross-surface is 401 and not revoked', async () => {
  const gate = configuredGate();
  for (const surface of ['exam', 'institution', 'admin'] as const) {
    for (const account of ['candidate', 'center', 'official', 'superAdmin'] as const) {
      resetDb();
      const outcome = await runGate(gate, onSurface(gate, surface, { method: 'POST', url: '/api/auth/logout', origin: expectedOrigin(surface), account }));
      if (SURFACE_OF_ACCOUNT[account] === surface) {
        assert.equal(outcome.reached, true, `${account} on ${surface}`);
      } else {
        assert.equal(outcome.status, 401, `${account} on ${surface}`);
        assert.equal(outcome.clearedCookie, false);
        assert.ok(!db.businessQueries.some((text) => /UPDATE auth_sessions/.test(text)), 'never revoked');
      }
    }
  }
});

test('gate: correct surface but wrong role is 403 before the handler (Super Admin route)', async () => {
  const gate = configuredGate();
  resetDb();
  const ordinary = await runGate(gate, onSurface(gate, 'admin', { url: '/api/admin/data-export', account: 'official' }));
  assert.equal(ordinary.status, 403);
  assert.deepEqual(ordinary.body, { error: 'You do not have permission to perform this action.' });
  assert.equal(db.businessQueries.length, 0);
  assert.equal((await runGate(gate, onSurface(gate, 'admin', { url: '/api/admin/data-export', account: 'superAdmin' }))).reached, true);
});

test('gate: a non-approved account on its own surface keeps the existing 403 and cookie clearing', async () => {
  const gate = configuredGate();
  const outcome = await runGate(gate, onSurface(gate, 'institution', { url: '/api/auth/me', account: 'pendingCenter' }));
  assert.equal(outcome.status, 403);
  assert.equal(outcome.clearedCookie, true);
});

test('gate: unknown routes, OPTIONS and unlisted paths fail closed with 404', async () => {
  const gate = configuredGate();
  for (const [method, url] of [['GET', '/api/unknown'], ['OPTIONS', '/api/auth/me'], ['GET', '/admin'], ['GET', '//api/auth/me'], ['GET', '/api/admin%2Fnotices']] as const) {
    resetDb();
    const outcome = await runGate(gate, onSurface(gate, 'exam', { method, url, account: 'candidate' }));
    assert.equal(outcome.status, 404, `${method} ${url}`);
    assert.deepEqual(outcome.body, { error: 'Route not found.' });
    assert.equal(db.sessionQueries, 0);
  }
});

test('session: central enforcement and route-level requireAuth share one lookup', async () => {
  const gate = configuredGate();
  resetDb();
  const request = onSurface(gate, 'exam', { url: '/api/answer-keys/exams', account: 'candidate' });
  assert.equal((await runGate(gate, request)).reached, true);
  const nextCalled = await new Promise<boolean>((resolve) => {
    const cleared = { value: false };
    void requireAuth(request as never, fakeResponse(() => resolve(false), cleared), () => resolve(true));
  });
  assert.equal(nextCalled, true);
  assert.equal(db.sessionQueries, 1, 'the second guard reused the first lookup');
});

test('session: requireAuth fails closed without a trusted surface; the surface cannot be changed', async () => {
  resetDb();
  const request = { headers: { cookie: `elt_session=${ACCOUNTS.candidate.token}` } } as unknown as Request;
  const status = await new Promise<number>((resolve) => {
    let code = 200;
    void requireAuth(request as never, {
      status(value: number) { code = value; return this; },
      json() { resolve(code); return this; },
      clearCookie() { return this; },
    } as unknown as Response, () => resolve(0));
  });
  assert.equal(status, 401);
  assert.equal(db.sessionQueries, 0, 'no lookup without a trusted surface');
  setTrustedRequestSurface(request, 'exam', expectedOrigin('exam'));
  assert.throws(() => setTrustedRequestSurface(request, 'admin', expectedOrigin('admin')), /cannot change/);
  assert.throws(() => setTrustedRequestSurface({}, 'staff' as Surface, 'https://x'), /Invalid/);
});

// ---------------------------------------------------------------------------
// Health exception (narrow, readiness-aware)
// ---------------------------------------------------------------------------

test('health: only a loopback peer with no proxy header and exact GET/HEAD /api/health is a probe', async () => {
  const gate = configuredGate();
  const probe = (options: FakeOptions) => {
    const request = fakeRequest(gate, { peer: '127.0.0.1', host: null, url: '/api/health', ...options });
    return runGate(gate, request).then((outcome) => ({ outcome, probe: gate.isInternalProbe(request) }));
  };
  for (const options of [{}, { method: 'HEAD' }, { peer: '::1' }, { peer: '::ffff:127.0.0.1' }, { listener: 'admin' as const }]) {
    const { outcome, probe: isProbe } = await probe(options);
    assert.equal(outcome.reached, true, JSON.stringify(options));
    assert.equal(isProbe, true);
  }
  for (const options of [
    { method: 'POST' }, { url: '/api/health/extra' }, { url: '//api/health' }, { url: '/api/notices' },
    { host: 'exam.eltnoy.com' }, { peer: '172.30.0.10' }, { peer: '203.0.113.9' }, { localPort: 4001 }, { listener: null },
  ] as FakeOptions[]) {
    const { outcome, probe: isProbe } = await probe(options);
    assert.equal(isProbe, false, JSON.stringify(options));
    assert.notEqual(outcome.status, 200, JSON.stringify(options));
  }
  // Through a trusted proxy on any hostname surface, /api/health is denied by route policy.
  for (const surface of SURFACES) {
    assert.equal((await runGate(gate, onSurface(gate, surface, { url: '/api/health' }))).status, 404, surface);
  }
});

test('health: the application route returns 503 until both listeners are ready, then checks the database', async () => {
  surfaceGate.configure(productionConfig);
  const route = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } })
    ._router.stack.find((layer) => layer.route?.path === '/api/health' && layer.route.methods.get)?.route;
  assert.ok(route);
  const call = (request: Request) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let status = 200;
    route.stack[0].handle(request, {
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body }); return this; },
    } as unknown as Response, (error?: unknown) => (error ? reject(error) : resolve({ status: -1, body: null })));
  });
  const probeRequest = () => {
    const request = fakeRequest(surfaceGate, { peer: '127.0.0.1', host: null, url: '/api/health' });
    surfaceGate.identify(request, {} as Response, () => undefined);
    assert.equal(surfaceGate.isInternalProbe(request), true);
    return request;
  };
  resetDb();
  assert.deepEqual(await call(probeRequest()), { status: 503, body: { status: 'starting' } });
  assert.equal(db.businessQueries.length, 0, 'no database check before readiness');
  const notProbe = fakeRequest(surfaceGate, { url: '/api/health' });
  assert.equal((await call(notProbe)).status, 404, 'a request the gate did not accept as a probe');
  surfaceGate.markReady();
  const ready = await call(probeRequest());
  assert.equal(ready.status, 200);
  assert.deepEqual(db.businessQueries, ['SELECT 1'], 'existing database health check after readiness');
});

// ---------------------------------------------------------------------------
// Login: role checked against the surface before any user lookup
// ---------------------------------------------------------------------------

test('login: a role not allowed on the surface gets the generic 401 before any user lookup', async () => {
  const route = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } })
    ._router.stack.find((layer) => layer.route?.path === '/api/auth/login' && layer.route.methods.post)?.route;
  assert.ok(route);
  const handler = route.stack[route.stack.length - 1].handle;
  const login = (surface: Surface | undefined, role: string) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = { body: { loginId: 'SYNTHETIC-1', password: 'synthetic-password', role }, headers: {} } as unknown as Request;
    if (surface) setTrustedRequestSurface(request, surface, expectedOrigin(surface));
    let status = 200;
    handler(request, {
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body }); return this; },
      cookie() { return this; },
    } as unknown as Response, (error?: unknown) => (error ? reject(error) : resolve({ status: -1, body: null })));
  });
  const generic = { error: 'Invalid login ID, password, or account type.' };
  const allowed: Record<Surface, string | null> = { marketing: null, exam: 'candidate', institution: 'center', admin: 'official' };
  for (const surface of [...SURFACES, undefined]) {
    for (const role of ['candidate', 'center', 'official']) {
      resetDb();
      const outcome = await login(surface, role);
      if (surface && allowed[surface] === role) {
        assert.equal(db.businessQueries.length, 1, `${role} on ${surface}: the user lookup runs`);
        assert.deepEqual(outcome, { status: 401, body: generic }, 'unknown synthetic user');
      } else {
        assert.deepEqual(outcome, { status: 401, body: generic }, `${role} on ${surface}`);
        assert.equal(db.businessQueries.length, 0, `${role} on ${surface}: no user lookup`);
      }
    }
  }
});
