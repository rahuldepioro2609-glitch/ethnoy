// P1-A surface policy tests (specification P1 Surface Isolation v1.4).
//
// Pure policy tests for server/surface.ts, plus a route-inventory completeness check against the
// live Express route stack. Importing the application starts no listener; the shared pool's `query`
// and `connect` are trapped so that no database connection can be opened. No real data is used.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RequestHandler } from 'express';

process.env.DOTENV_CONFIG_PATH ??= '/dev/null';
process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:1/p1a_surface_tests';

const surfaceModule = await import('./surface.js');
const {
  SURFACES,
  PINNED_SURFACE_HOSTNAMES,
  SURFACE_SESSION_ROLES,
  ROUTE_POLICY,
  SPA_FALLBACK_ROUTE,
  SPA_SHELL_PATHS,
  MISSING_ORIGIN_POLICY,
  parseOriginalHost,
  surfaceForHostname,
  isOriginalHostValidForSurface,
  validateSurfaceHostnames,
  isSessionAllowedOnSurface,
  isLoginRoleAllowedOnSurface,
  expectedOrigin,
  evaluateOrigin,
  compileRoutePattern,
  parseRequestPath,
  matchRoutePolicy,
  decideRequest,
  isInternalHealthProbe,
  unresolvedPolicyRows,
  unresolvedAccess,
  decideForEntry,
  disclosedSurfaceHostnames,
  PUBLIC_SURFACES,
} = surfaceModule;
type Surface = (typeof SURFACES)[number];
type RoutePolicyEntry = (typeof ROUTE_POLICY)[number];

// The pool must be trapped before any handler could run; importing index.js itself opens nothing.
const [{ app }, { pool }] = await Promise.all([import('./index.js'), import('./db.js')]);
const mutablePool = pool as unknown as { query: (...args: unknown[]) => unknown; connect: (...args: unknown[]) => unknown };
let databaseAttempts = 0;
mutablePool.query = () => {
  databaseAttempts += 1;
  throw new Error('P1-A tests must not query the database');
};
mutablePool.connect = () => {
  databaseAttempts += 1;
  throw new Error('P1-A tests must not connect to the database');
};

const PORTAL_ROLES = ['candidate', 'center', 'official'] as const;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function find(method: string, routePath: string): RoutePolicyEntry {
  const policyEntry = ROUTE_POLICY.find((candidate) => candidate.method === method && candidate.path === routePath);
  assert.ok(policyEntry, `${method} ${routePath} must be in the policy table`);
  return policyEntry;
}

function outcomes(method: string, target: string): Record<Surface, string> {
  return Object.fromEntries(SURFACES.map((surface) => {
    const decision = decideRequest(surface, method, target);
    return [surface, decision.outcome === 'allow' ? `allow:${decision.auth}` : `${decision.outcome}:${decision.status}`];
  })) as Record<Surface, string>;
}

// ---------------------------------------------------------------------------
// 1-4. Hostnames
// ---------------------------------------------------------------------------

test('pinned hostnames map exactly to the four surfaces', () => {
  assert.deepEqual({ ...PINNED_SURFACE_HOSTNAMES }, {
    marketing: 'eltnoy.com',
    exam: 'exam.eltnoy.com',
    institution: 'institution.eltnoy.com',
    admin: 'admin.eltnoy.in',
  });
  assert.equal(surfaceForHostname('eltnoy.com'), 'marketing');
  assert.equal(surfaceForHostname('exam.eltnoy.com'), 'exam');
  assert.equal(surfaceForHostname('institution.eltnoy.com'), 'institution');
  assert.equal(surfaceForHostname('admin.eltnoy.in'), 'admin');
  assert.deepEqual(validateSurfaceHostnames(PINNED_SURFACE_HOSTNAMES), []);
  assert.ok(Object.isFrozen(PINNED_SURFACE_HOSTNAMES));
});

test('hostname case is normalised and nothing else is', () => {
  assert.equal(surfaceForHostname('ADMIN.ELTNOY.IN'), 'admin');
  assert.equal(surfaceForHostname('Exam.Eltnoy.Com'), 'exam');
  assert.deepEqual(parseOriginalHost('Institution.ELTNOY.com'), { ok: true, hostname: 'institution.eltnoy.com' });
  assert.equal(surfaceForHostname('admin.eltnoy.in.'), null, 'trailing dot is not normalised away');
  assert.equal(surfaceForHostname(' admin.eltnoy.in'), null, 'whitespace is not trimmed');
});

test('unknown hostnames fail closed (no suffix, prefix or wildcard matching)', () => {
  for (const hostname of [
    'www.eltnoy.com', 'eltnoy.org', 'admin.eltnoy.co', 'evil.com', 'admin.eltnoy.in.evil.com', 'evil-admin.eltnoy.in',
    'adminx.eltnoy.com', 'x.admin.eltnoy.in', 'exam-eltnoy.com', 'localhost', '127.0.0.1', 'eltnoy',
    // Admin moved from the public domain to the private eltnoy.in domain: the old name fails closed.
    'admin.eltnoy.com', 'eltnoy.in', 'www.eltnoy.in', 'exam.eltnoy.in', 'admin.eltnoy.co.in',
  ]) {
    assert.equal(surfaceForHostname(hostname), null, hostname);
    for (const surface of SURFACES) assert.equal(isOriginalHostValidForSurface(hostname, surface), false, `${hostname} on ${surface}`);
  }
});

test('malformed, missing, multi-valued and port-qualified original hosts are rejected', () => {
  const cases: Array<[unknown, string]> = [
    [undefined, 'missing'], [null, 'missing'], ['', 'empty'],
    [['admin.eltnoy.in'], 'multiple_values'], [['admin.eltnoy.in', 'exam.eltnoy.com'], 'multiple_values'],
    ['admin.eltnoy.in,exam.eltnoy.com', 'multiple_values'], ['admin.eltnoy.in, admin.eltnoy.in', 'multiple_values'],
    ['admin.eltnoy.in:443', 'port_not_allowed'], ['admin.eltnoy.in:4003', 'port_not_allowed'], ['eltnoy.com:80', 'port_not_allowed'],
    ['admin.eltnoy.in:', 'port_not_allowed'],
    ['[::1]', 'malformed'], ['[::1]:443', 'malformed'], ['user@admin.eltnoy.in', 'malformed'], ['admin.eltnoy.in/x', 'malformed'],
    ['admin.eltnoy.in\\x', 'malformed'], ['admin.eltnoy.in\r\nx: y', 'malformed'], ['admin eltnoy.com', 'malformed'],
    ['admin..eltnoy.com', 'malformed'], ['.admin.eltnoy.in', 'malformed'], ['admin.eltnoy.in.', 'malformed'],
    ['-admin.eltnoy.in', 'malformed'], ['admin_.eltnoy.com', 'malformed'], ['*.eltnoy.com', 'malformed'],
    ['admin.eltnoy.in\u0000', 'malformed'], [42, 'malformed'], [{}, 'malformed'],
  ];
  for (const [raw, reason] of cases) {
    assert.deepEqual(parseOriginalHost(raw), { ok: false, reason }, JSON.stringify(raw));
    assert.equal(isOriginalHostValidForSurface(raw, 'admin'), false, JSON.stringify(raw));
  }
});

test('original host must name exactly the surface of the receiving listener', () => {
  for (const surface of SURFACES) {
    for (const other of SURFACES) {
      assert.equal(isOriginalHostValidForSurface(PINNED_SURFACE_HOSTNAMES[other], surface), surface === other, `${other} host on ${surface}`);
    }
  }
  assert.equal(isOriginalHostValidForSurface('admin.eltnoy.in', 'nope' as Surface), false);
});

test('hostname configuration validation rejects unsafe configuration', () => {
  assert.notDeepEqual(validateSurfaceHostnames(null), []);
  assert.notDeepEqual(validateSurfaceHostnames({ ...PINNED_SURFACE_HOSTNAMES, admin: undefined }), []);
  assert.notDeepEqual(validateSurfaceHostnames({ ...PINNED_SURFACE_HOSTNAMES, admin: '*.eltnoy.com' }), []);
  assert.notDeepEqual(validateSurfaceHostnames({ ...PINNED_SURFACE_HOSTNAMES, admin: 'exam.eltnoy.com' }), []);
  assert.notDeepEqual(validateSurfaceHostnames({ ...PINNED_SURFACE_HOSTNAMES, admin: 'Admin.eltnoy.in' }), []);
  assert.notDeepEqual(validateSurfaceHostnames({ ...PINNED_SURFACE_HOSTNAMES, admin: 'admin.eltnoy.in:443' }), []);
  assert.notDeepEqual(validateSurfaceHostnames({ ...PINNED_SURFACE_HOSTNAMES, staff: 'staff.eltnoy.com' }), []);
});

// ---------------------------------------------------------------------------
// 5-6. Role matrix and login restrictions
// ---------------------------------------------------------------------------

test('session role matrix: one role family per surface, Marketing none', () => {
  assert.deepEqual(Object.fromEntries(SURFACES.map((surface) => [surface, [...SURFACE_SESSION_ROLES[surface]]])), {
    marketing: [], exam: ['candidate'], institution: ['center'], admin: ['official'],
  });
  const expected: Record<Surface, Record<string, boolean>> = {
    marketing: { candidate: false, center: false, official: false, superAdmin: false },
    exam: { candidate: true, center: false, official: false, superAdmin: false },
    institution: { candidate: false, center: true, official: false, superAdmin: false },
    admin: { candidate: false, center: false, official: true, superAdmin: true },
  };
  for (const surface of SURFACES) {
    for (const role of PORTAL_ROLES) {
      assert.equal(isSessionAllowedOnSurface(surface, { role, isSuperAdmin: false }), expected[surface][role], `${role} on ${surface}`);
    }
    assert.equal(isSessionAllowedOnSurface(surface, { role: 'official', isSuperAdmin: true }), expected[surface].superAdmin, `super admin on ${surface}`);
  }
});

test('unknown roles, missing sessions and inconsistent super-admin flags are denied', () => {
  for (const surface of SURFACES) {
    assert.equal(isSessionAllowedOnSurface(surface, null), false);
    assert.equal(isSessionAllowedOnSurface(surface, undefined), false);
    assert.equal(isSessionAllowedOnSurface(surface, { role: 'admin' }), false);
    assert.equal(isSessionAllowedOnSurface(surface, { role: 'OFFICIAL' }), false);
    assert.equal(isSessionAllowedOnSurface(surface, { role: undefined }), false);
    assert.equal(isSessionAllowedOnSurface(surface, { role: 'candidate', isSuperAdmin: true }), false);
    assert.equal(isSessionAllowedOnSurface(surface, { role: 'center', isSuperAdmin: true }), false);
  }
  assert.equal(isSessionAllowedOnSurface('staff' as Surface, { role: 'official' }), false);
});

test('login role is restricted per surface before any lookup; Marketing accepts no login', () => {
  const expected: Record<Surface, string[]> = { marketing: [], exam: ['candidate'], institution: ['center'], admin: ['official'] };
  for (const surface of SURFACES) {
    for (const role of [...PORTAL_ROLES, 'admin', 'super_admin', '', undefined, null, 'Candidate']) {
      assert.equal(isLoginRoleAllowedOnSurface(surface, role), expected[surface].includes(role as string), `${String(role)} on ${surface}`);
    }
  }
  assert.deepEqual(outcomes('POST', '/api/auth/login'), { marketing: 'deny:404', exam: 'allow:login', institution: 'allow:login', admin: 'allow:login' });
});

// ---------------------------------------------------------------------------
// 7-8. Origin
// ---------------------------------------------------------------------------

test('exact Origin per surface; cross-surface Origins rejected', () => {
  assert.equal(expectedOrigin('exam'), 'https://exam.eltnoy.com');
  assert.equal(expectedOrigin('institution'), 'https://institution.eltnoy.com');
  assert.equal(expectedOrigin('admin'), 'https://admin.eltnoy.in');
  for (const surface of ['exam', 'institution', 'admin'] as const) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      assert.deepEqual(evaluateOrigin({ surface, method, origin: expectedOrigin(surface) }), { allowed: true, reason: 'exact_match' });
      for (const other of SURFACES.filter((candidate) => candidate !== surface)) {
        assert.deepEqual(evaluateOrigin({ surface, method, origin: expectedOrigin(other) }), { allowed: false, reason: 'cross_surface' }, `${other} → ${surface}`);
      }
    }
  }
});

test('Origin variants that are not byte-exact are rejected', () => {
  for (const origin of [
    'http://admin.eltnoy.in', 'https://admin.eltnoy.in:443', 'https://admin.eltnoy.in/', 'https://ADMIN.eltnoy.in',
    'https://admin.eltnoy.in.evil.com', 'https://evil.com', 'https://www.eltnoy.com', 'admin.eltnoy.in', 'https://admin.eltnoy.in/path',
  ]) {
    assert.equal(evaluateOrigin({ surface: 'admin', method: 'POST', origin }).allowed, false, origin);
  }
  assert.deepEqual(evaluateOrigin({ surface: 'admin', method: 'POST', origin: 'https://admin.eltnoy.in, https://admin.eltnoy.in' }), { allowed: false, reason: 'multiple_values' });
  assert.deepEqual(evaluateOrigin({ surface: 'admin', method: 'POST', origin: ['https://admin.eltnoy.in'] }), { allowed: false, reason: 'multiple_values' });
});

test('null and missing Origin are rejected for state-changing requests on every surface', () => {
  assert.equal(MISSING_ORIGIN_POLICY, 'reject_state_changing_on_every_surface');
  for (const surface of SURFACES) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.deepEqual(evaluateOrigin({ surface, method, origin: 'null' }), { allowed: false, reason: 'null' });
      assert.deepEqual(evaluateOrigin({ surface, method, origin: undefined }), { allowed: false, reason: 'missing' });
      assert.deepEqual(evaluateOrigin({ surface, method, origin: '' }), { allowed: false, reason: 'missing' });
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.deepEqual(evaluateOrigin({ surface, method, origin: undefined }), { allowed: true, reason: 'not_state_changing' });
    }
  }
  assert.deepEqual(evaluateOrigin({ surface: 'marketing', method: 'POST', origin: 'https://eltnoy.com' }), { allowed: false, reason: 'marketing_is_not_a_portal' });
  assert.deepEqual(evaluateOrigin({ surface: 'staff' as Surface, method: 'POST', origin: 'https://admin.eltnoy.in' }), { allowed: false, reason: 'unknown_surface' });
});

// ---------------------------------------------------------------------------
// 9-12. Locked special routes
// ---------------------------------------------------------------------------

test('POST /api/feedback: Exam candidate, Institution center, Marketing and Admin denied', () => {
  assert.deepEqual(outcomes('POST', '/api/feedback'), {
    marketing: 'deny:404', exam: 'allow:candidate', institution: 'allow:center', admin: 'deny:404',
  });
  const policyEntry = find('POST', '/api/feedback');
  assert.equal(policyEntry.pendingAuthentication, undefined, 'P1-B: enforced by requireAuth + requireRoles(candidate, center) and centrally');
  assert.equal(policyEntry.authenticationVariesBySurface, true, 'candidate on Exam, center on Institution');
  for (const surface of SURFACES) {
    const access = policyEntry.access[surface];
    if (access.decision === 'allow') assert.notEqual(access.auth, 'anonymous', 'unauthenticated feedback is never allowed (401)');
  }
});

test('POST /api/mock-exams/submit: Exam candidate only', () => {
  assert.deepEqual(outcomes('POST', '/api/mock-exams/submit'), {
    marketing: 'deny:404', exam: 'allow:candidate', institution: 'deny:404', admin: 'deny:404',
  });
  assert.equal(find('POST', '/api/mock-exams/submit').pendingAuthentication, undefined, 'P1-B: enforced by requireAuth + requireRoles(candidate) and centrally');
});

// ---------------------------------------------------------------------------
// Amendment A-1: public content APIs (owner decisions U1-U6)
// ---------------------------------------------------------------------------

const A1_MATRIX: Record<string, Record<Surface, string>> = {
  '/api/surface-hostnames': { marketing: 'allow:anonymous', exam: 'allow:anonymous', institution: 'allow:anonymous', admin: 'allow:anonymous' },
  '/api/notices': { marketing: 'allow:anonymous', exam: 'allow:anonymous', institution: 'deny:404', admin: 'deny:404' },
  '/api/exams': { marketing: 'allow:anonymous', exam: 'allow:candidate', institution: 'deny:404', admin: 'deny:404' },
  '/api/institute-forms': { marketing: 'allow:anonymous', exam: 'allow:anonymous', institution: 'deny:404', admin: 'deny:404' },
  '/api/answer-keys/exams': { marketing: 'deny:404', exam: 'allow:candidate', institution: 'deny:404', admin: 'deny:404' },
  '/api/answer-keys': { marketing: 'deny:404', exam: 'allow:candidate', institution: 'deny:404', admin: 'deny:404' },
};

test('A-1: all endpoint/surface combinations match the approved matrix', () => {
  let cells = 0;
  for (const [routePath, expected] of Object.entries(A1_MATRIX)) {
    assert.deepEqual(outcomes('GET', routePath), expected, routePath);
    // Same decision for HEAD, case variants, a trailing slash and a query string.
    for (const [method, target] of [['HEAD', routePath], ['GET', routePath.toUpperCase()], ['GET', `${routePath}/`], ['GET', `${routePath}?examCode=X1`]]) {
      assert.deepEqual(outcomes(method, target), expected, `${method} ${target}`);
    }
    cells += SURFACES.length;
  }
  assert.equal(cells, 24);
});

test('A-1: Marketing and Exam serve public notices and institute forms; exams and answer keys follow their auth policy', () => {
  for (const routePath of ['/api/notices', '/api/exams', '/api/institute-forms']) {
    const decision = decideRequest('marketing', 'GET', routePath);
    assert.equal(decision.outcome, 'allow', routePath);
    assert.equal(decision.outcome === 'allow' && decision.auth, 'anonymous', routePath);
  }
  for (const routePath of ['/api/answer-keys/exams', '/api/answer-keys']) {
    assert.equal(decideRequest('marketing', 'GET', routePath).outcome, 'deny', routePath);
  }
  for (const routePath of ['/api/notices', '/api/institute-forms']) {
    const decision = decideRequest('exam', 'GET', routePath);
    assert.equal(decision.outcome, 'allow', routePath);
    if (decision.outcome === 'allow') assert.equal(decision.auth, 'anonymous', routePath);
  }
});

test('A-1: exams and both answer-key routes require a Candidate on Exam', () => {
  for (const routePath of ['/api/exams', '/api/answer-keys/exams', '/api/answer-keys']) {
    const access = find('GET', routePath).access.exam;
    assert.deepEqual(access, { decision: 'allow', auth: 'candidate' }, routePath);
    // Only a candidate session can satisfy the Exam surface; other roles are rejected there.
    assert.equal(isSessionAllowedOnSurface('exam', { role: 'candidate' }), true);
    for (const principal of [{ role: 'center' }, { role: 'official' }, { role: 'official', isSuperAdmin: true }]) {
      assert.equal(isSessionAllowedOnSurface('exam', principal), false, `${routePath} ${JSON.stringify(principal)}`);
    }
  }
  assert.equal(find('GET', '/api/answer-keys/exams').routeClass, 'candidate');
  assert.equal(find('GET', '/api/answer-keys').routeClass, 'candidate');
});

test('A-1: Institution and Admin receive only public hostname metadata, not Marketing content', () => {
  for (const routePath of Object.keys(A1_MATRIX).filter((path) => path !== '/api/surface-hostnames')) {
    for (const surface of ['institution', 'admin'] as const) {
      for (const method of ['GET', 'HEAD']) {
        const decision = decideRequest(surface, method, routePath);
        assert.equal(decision.outcome, 'deny', `${method} ${routePath} on ${surface}`);
        assert.equal(decision.status, 404);
      }
    }
  }
  for (const surface of ['institution', 'admin'] as const) {
    assert.equal(decideRequest(surface, 'GET', '/api/surface-hostnames').outcome, 'allow', surface);
  }
});

test('public surfaces never disclose the private Admin hostname; Admin may disclose all four', () => {
  assert.deepEqual([...PUBLIC_SURFACES], ['marketing', 'exam', 'institution']);
  for (const surface of PUBLIC_SURFACES) {
    const disclosed = disclosedSurfaceHostnames(surface, PINNED_SURFACE_HOSTNAMES);
    assert.deepEqual(Object.keys(disclosed).sort(), ['exam', 'institution', 'marketing'], surface);
    assert.equal(disclosed.admin, undefined, `${surface} must not disclose the Admin hostname`);
    assert.ok(!Object.values(disclosed).includes(PINNED_SURFACE_HOSTNAMES.admin), surface);
    assert.ok(Object.isFrozen(disclosed));
  }
  assert.deepEqual(disclosedSurfaceHostnames('admin', PINNED_SURFACE_HOSTNAMES), { ...PINNED_SURFACE_HOSTNAMES });
});

test('the hostname metadata route answers with the receiving surface\'s disclosed hostnames', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("app.get('/api/surface-hostnames'"), source.indexOf("app.get('/api/exams'"));
  assert.match(handler, /const surface = getTrustedRequestSurface\(request\);/);
  assert.match(handler, /hostnames: disclosedSurfaceHostnames\(surface, config\.hostnames\)/);
  assert.doesNotMatch(handler, /hostnames: config\.hostnames/, 'never the full hostname map');
});

test('A-1: /api/exams carries explicit mixed-authentication metadata and is enforced centrally only', () => {
  const policyEntry = find('GET', '/api/exams');
  assert.equal(policyEntry.authenticationVariesBySurface, true);
  assert.equal(policyEntry.centralAuthenticationOnly, true, 'P1-B central enforcement is the only control');
  assert.equal(policyEntry.pendingAuthentication, undefined);
  assert.equal(policyEntry.routeClass, 'public_content');
});

test('A-1: answer-key routes are Candidate-only with no pending record (P1-B route guards and central check)', () => {
  for (const routePath of ['/api/answer-keys/exams', '/api/answer-keys']) {
    const policyEntry = find('GET', routePath);
    assert.equal(policyEntry.pendingAuthentication, undefined, routePath);
    assert.equal(policyEntry.centralAuthenticationOnly, undefined, routePath);
    assert.equal(policyEntry.authenticationVariesBySurface, undefined, routePath);
  }
  for (const routePath of ['/api/notices', '/api/institute-forms']) {
    const policyEntry = find('GET', routePath);
    assert.equal(policyEntry.pendingAuthentication, undefined, `${routePath} needs no session`);
    assert.equal(policyEntry.authenticationVariesBySurface, undefined, routePath);
  }
});

test('mixed-authentication metadata is set exactly where allowed surfaces differ', () => {
  for (const policyEntry of ROUTE_POLICY) {
    const auths = new Set(SURFACES.flatMap((surface) => {
      const access = policyEntry.access[surface];
      return access.decision === 'allow' ? [access.auth] : [];
    }));
    assert.equal(policyEntry.authenticationVariesBySurface === true, auths.size > 1, `${policyEntry.method} ${policyEntry.path}`);
    const needsSession = [...auths].some((auth) => ['session', 'candidate', 'center', 'official', 'super_admin'].includes(auth));
    assert.equal(policyEntry.centralAuthenticationOnly === true, auths.has('anonymous') && needsSession, `${policyEntry.method} ${policyEntry.path}`);
  }
});

test('P1-B: no row still has pending authentication', () => {
  assert.deepEqual(ROUTE_POLICY.filter((policyEntry) => policyEntry.pendingAuthentication).map((policyEntry) => `${policyEntry.method} ${policyEntry.path}`), []);
});

test('GET /api/auth/me: Marketing 401 without lookup; each portal accepts only its own session', () => {
  assert.deepEqual(outcomes('GET', '/api/auth/me'), {
    marketing: 'unauthenticated:401', exam: 'allow:session', institution: 'allow:session', admin: 'allow:session',
  });
  assert.equal(decideRequest('marketing', 'HEAD', '/api/auth/me').status, 401);
  // Cross-surface sessions: the session requirement is evaluated with isSessionAllowedOnSurface.
  assert.equal(isSessionAllowedOnSurface('exam', { role: 'official', isSuperAdmin: true }), false);
  assert.equal(isSessionAllowedOnSurface('admin', { role: 'candidate' }), false);
  assert.equal(isSessionAllowedOnSurface('institution', { role: 'official' }), false);
});

test('POST /api/auth/logout: Marketing always 401; cross-surface logout rejected', () => {
  assert.deepEqual(outcomes('POST', '/api/auth/logout'), {
    marketing: 'unauthenticated:401', exam: 'allow:session', institution: 'allow:session', admin: 'allow:session',
  });
  assert.equal(decideRequest('marketing', 'GET', '/api/auth/logout').outcome, 'deny', 'no GET logout');
  for (const surface of ['exam', 'institution', 'admin'] as const) {
    for (const role of PORTAL_ROLES) {
      assert.equal(isSessionAllowedOnSurface(surface, { role }), SURFACE_SESSION_ROLES[surface].includes(role));
    }
  }
});

test('GET /api/institution-document-submission/admin/cycles is Admin (official) only', () => {
  assert.deepEqual(outcomes('GET', '/api/institution-document-submission/admin/cycles'), {
    marketing: 'deny:404', exam: 'deny:404', institution: 'deny:404', admin: 'allow:official',
  });
  // Its siblings in the same router are the Institution capability flow, never Admin.
  assert.deepEqual(outcomes('GET', '/api/institution-document-submission/status'), {
    marketing: 'deny:404', exam: 'deny:404', institution: 'allow:capability', admin: 'deny:404',
  });
});

test('every /api/admin route and every super-admin route is Admin only', () => {
  for (const policyEntry of ROUTE_POLICY) {
    const isAdminRoute = /^\/api\/admin\//.test(policyEntry.path) || policyEntry.routeClass === 'admin' || policyEntry.routeClass === 'super_admin';
    if (!isAdminRoute) continue;
    for (const surface of SURFACES) {
      const access = policyEntry.access[surface];
      if (surface === 'admin') assert.ok(access.decision === 'allow' && (access.auth === 'official' || access.auth === 'super_admin'), policyEntry.path);
      else assert.equal(access.decision, 'deny', `${policyEntry.method} ${policyEntry.path} on ${surface}`);
    }
  }
});

test('no route is allowed on Admin without an Official or Platform Staff session, except public config and sign-in', () => {
  // The public hostname map is non-sensitive routing metadata; Platform Staff uses its own
  // session, and all other Admin routes require an Official session or a login step.
  const staffSignIn = 'POST /api/platform-staff/auth/login';
  const publicConfig = 'GET /api/surface-hostnames';
  for (const policyEntry of ROUTE_POLICY) {
    const access = policyEntry.access.admin;
    if (access.decision !== 'allow') continue;
    const key = `${policyEntry.method} ${policyEntry.path}`;
    if (key === staffSignIn || key === publicConfig) {
      assert.equal(access.auth, 'anonymous', key);
      continue;
    }
    if (access.auth === 'platform_staff') {
      assert.ok(policyEntry.path.startsWith('/api/platform-staff/') && policyEntry.routeClass === 'platform_staff', key);
      continue;
    }
    assert.ok(['official', 'super_admin', 'login', 'session'].includes(access.auth), key);
  }
  assert.deepEqual(
    ROUTE_POLICY.filter((policyEntry) => policyEntry.access.admin.decision === 'allow' && (policyEntry.access.admin as { auth: string }).auth === 'anonymous')
      .map((policyEntry) => `${policyEntry.method} ${policyEntry.path}`).sort(),
    [publicConfig, staffSignIn].sort(),
  );
});

test('SM-1: staff session kinds are confined to their own module, surface and route guard', async () => {
  const routeByKey = new Map(ROUTES.map((route) => [`${route.method} ${route.path}`, route]));
  for (const policyEntry of ROUTE_POLICY) {
    const allowed = SURFACES.filter((surface) => policyEntry.access[surface].decision === 'allow');
    const auths = new Set(allowed.map((surface) => (policyEntry.access[surface] as { auth: string }).auth));
    const names = routeByKey.get(`${policyEntry.method} ${policyEntry.path}`)!.handlers.map((handler) => handler.name ?? '');
    const key = `${policyEntry.method} ${policyEntry.path}: ${names.join(',')}`;
    if (auths.has('platform_staff')) {
      assert.deepEqual(allowed, ['admin'], key);
      assert.ok(policyEntry.path.startsWith('/api/platform-staff/'), key);
      assert.ok(names.some((name) => name.startsWith('requirePlatformStaff')), key);
      assert.ok(!names.includes('requireAuth'), `${key}: never a portal session`);
    }
    if (auths.has('org_staff')) {
      assert.deepEqual(allowed, ['institution'], key);
      assert.ok(policyEntry.path.startsWith('/api/org-staff/'), key);
      assert.ok(names.includes('requireOrgStaff'), key);
      assert.ok(!names.includes('requireAuth'), `${key}: never a portal session`);
    }
    if (policyEntry.path.startsWith('/api/platform-staff/') || policyEntry.path.startsWith('/api/org-staff/')) {
      assert.ok(auths.has('platform_staff') || auths.has('org_staff') || auths.has('anonymous'), key);
    }
    if (policyEntry.path.startsWith('/api/admin/platform-staff') || policyEntry.path.startsWith('/api/admin/organization-staff')) {
      assert.deepEqual([...auths], ['super_admin'], `${key}: staff management is Super Admin only`);
    }
    if (policyEntry.path.startsWith('/api/center/staff')) {
      assert.deepEqual([...auths], ['center'], `${key}: organization staff management is the Organization Owner's`);
    }
  }
});

// ---------------------------------------------------------------------------
// 13-18. Express-compatible path matching
// ---------------------------------------------------------------------------

test('case variants, single trailing slash and HEAD→GET match like Express', () => {
  const target = find('PATCH', '/api/admin/notices/:id');
  assert.equal(matchRoutePolicy('PATCH', '/api/admin/notices/7'), target);
  assert.equal(matchRoutePolicy('patch', '/API/ADMIN/Notices/7'), target);
  assert.equal(matchRoutePolicy('PATCH', '/api/admin/notices/7/'), target);
  assert.equal(matchRoutePolicy('PATCH', '/api/admin/notices/7//'), null);
  assert.equal(matchRoutePolicy('PATCH', '/api/admin/notices/'), null, 'params need a non-empty segment');
  assert.equal(matchRoutePolicy('PATCH', '/api/admin/notices/7/extra'), null);
  assert.equal(matchRoutePolicy('HEAD', '/api/admin/notices'), find('GET', '/api/admin/notices'));
  assert.equal(matchRoutePolicy('HEAD', '/api/auth/logout'), null, 'HEAD inherits only GET');
  assert.deepEqual(outcomes('GET', '/API/Auth/ME/'), outcomes('GET', '/api/auth/me'));
  assert.deepEqual(outcomes('HEAD', '/api/institution-document-submission/admin/cycles'), outcomes('GET', '/api/institution-document-submission/admin/cycles'));
});

test('duplicate separators and dot segments are rejected, never normalised', () => {
  for (const target of ['//api/admin/notices', '/api//admin/notices', '/api/admin/notices//', '/api/admin/./notices', '/api/admin/../admin/notices', '/api/admin/%2e%2e/notices', '/api/admin/.%2E/notices', '/./', '/..']) {
    assert.equal(parseRequestPath(target).ok, false, target);
    for (const surface of SURFACES) {
      const decision = decideRequest(surface, 'GET', target);
      assert.equal(decision.outcome, 'deny', `${target} on ${surface}`);
      assert.equal(decision.category, 'malformed', target);
    }
  }
});

test('percent-encoded separators, backslashes and control characters are rejected', () => {
  for (const target of [
    '/api/admin%2Fnotices', '/api/admin%2fnotices', '/api/admin/notices/a%2Fb', '/api%5cadmin/notices', '/api\\admin\\notices',
    '/api/admin/notices%00', '/api/admin/notices\u0000', '/api/admin/notices\r\n', '/api/admin/ notices', 'api/admin/notices', '',
    '*', 'https://admin.eltnoy.in/api/admin/notices',
  ]) {
    assert.equal(parseRequestPath(target).ok, false, JSON.stringify(target));
    assert.equal(decideRequest('admin', 'GET', target).outcome, 'deny', JSON.stringify(target));
  }
  assert.equal(parseRequestPath(undefined).ok, false);
  assert.equal(parseRequestPath(42).ok, false);
  // Other percent-encodings inside a parameter are left to the route (Express decodes params).
  assert.deepEqual(parseRequestPath('/api/admin/notices/a%20b'), { ok: true, path: '/api/admin/notices/a%20b' });
});

test('query strings and fragments are ignored for matching', () => {
  assert.deepEqual(parseRequestPath('/api/auth/me?x=1'), { ok: true, path: '/api/auth/me' });
  assert.deepEqual(parseRequestPath('/api/auth/me#x'), { ok: true, path: '/api/auth/me' });
  assert.deepEqual(outcomes('GET', '/api/auth/me?redirect=//evil.com'), outcomes('GET', '/api/auth/me'));
  assert.deepEqual(outcomes('GET', '/api/institution-document-submission/admin/cycles?surface=institution'), outcomes('GET', '/api/institution-document-submission/admin/cycles'));
  assert.equal(parseRequestPath('?x=1').ok, false);
  assert.equal(decideRequest('admin', 'GET', '/api/admin/notices?a=%2F').outcome, 'allow', 'encoded separators in the query are not path separators');
});

test('compiled patterns are identical to Express path-to-regexp output', () => {
  const requireFromHere = createRequire(import.meta.url);
  const requireFromExpress = createRequire(requireFromHere.resolve('express/package.json'));
  const pathToRegexp = requireFromExpress('path-to-regexp') as (pattern: string, keys: unknown[], options: Record<string, boolean>) => RegExp;
  for (const policyEntry of ROUTE_POLICY) {
    const ours = compileRoutePattern(policyEntry.path);
    const express = pathToRegexp(policyEntry.path, [], { sensitive: false, strict: false, end: true });
    assert.equal(ours.source, express.source, policyEntry.path);
    assert.equal(ours.flags, express.flags, policyEntry.path);
  }
});

test('unsupported route patterns are refused instead of approximated', () => {
  for (const pattern of ['*', '/api/*', '/api/:id?', '/api/:id(\\d+)', '/api/(x)', '/api/a.b', '/api/', 'api/x', '/api//x', '/api/:', '/api/a+b']) {
    assert.throws(() => compileRoutePattern(pattern), /unsupported route pattern/, pattern);
  }
});

// ---------------------------------------------------------------------------
// 19-21. Static assets, SPA fallback, health, OPTIONS and unknown routes
// ---------------------------------------------------------------------------

test('static assets are anonymous GET/HEAD on every surface; directories and mutations are not', () => {
  for (const surface of SURFACES) {
    for (const target of ['/assets/index-abc123.js', '/fonts/inter.woff2', '/index.html', '/assets/x.css?v=1']) {
      for (const method of ['GET', 'HEAD']) {
        const decision = decideRequest(surface, method, target);
        assert.equal(decision.outcome, 'allow', `${method} ${target} on ${surface}`);
      }
      assert.equal(decideRequest(surface, 'POST', target).outcome, 'deny');
    }
    // Static prefixes are case-sensitive (serve-static on a case-sensitive filesystem): fail closed.
    for (const target of ['/assets/', '/assets', '/fonts/', '/assets/sub/', '/ASSETS/x.css', '/Index.html']) {
      assert.equal(decideRequest(surface, 'GET', target).outcome, 'deny', `${target} on ${surface}`);
    }
  }
});

test('SPA fallback serves the shell only for the surface\'s own client routes', () => {
  const expectations: Array<[string, Record<Surface, boolean>]> = [
    ['/', { marketing: true, exam: true, institution: true, admin: true }],
    ['/login/candidate', { marketing: false, exam: true, institution: false, admin: false }],
    ['/dashboard/candidate/', { marketing: false, exam: true, institution: false, admin: false }],
    ['/login/center', { marketing: false, exam: false, institution: true, admin: false }],
    ['/dashboard/center', { marketing: false, exam: false, institution: true, admin: false }],
    ['/login/official', { marketing: false, exam: false, institution: false, admin: true }],
    ['/Dashboard/Official', { marketing: false, exam: false, institution: false, admin: true }],
    ['/dashboard/official/settings', { marketing: false, exam: false, institution: false, admin: false }],
    ['/login', { marketing: true, exam: true, institution: true, admin: false }],
    ['/admin', { marketing: false, exam: false, institution: false, admin: false }],
  ];
  for (const [target, expected] of expectations) {
    for (const surface of SURFACES) {
      const decision = decideRequest(surface, 'GET', target);
      assert.equal(decision.outcome === 'allow' && decision.category === 'spa_shell', expected[surface], `${target} on ${surface}`);
    }
  }
  assert.equal(SPA_FALLBACK_ROUTE.path, '*');
  for (const surface of SURFACES) assert.ok(Object.isFrozen(SPA_SHELL_PATHS[surface]));
});

test('health is denied on every hostname surface; only the internal probe helper accepts it', () => {
  for (const target of ['/api/health', '/API/HEALTH/', '/api/health?full=1']) {
    for (const surface of SURFACES) assert.equal(decideRequest(surface, 'GET', target).outcome, 'deny', `${target} on ${surface}`);
    assert.equal(isInternalHealthProbe('GET', target), true);
    assert.equal(isInternalHealthProbe('HEAD', target), true);
  }
  assert.equal(isInternalHealthProbe('POST', '/api/health'), false);
  assert.equal(isInternalHealthProbe('GET', '//api/health'), false);
  assert.equal(isInternalHealthProbe('GET', '/api/notices'), false);
  assert.equal(find('GET', '/api/health').internalProbe, true);
});

test('OPTIONS is never served on any surface', () => {
  for (const surface of SURFACES) {
    for (const target of ['/api/auth/login', '/api/admin/notices', '/', '/assets/x.js', '*']) {
      assert.equal(decideRequest(surface, 'OPTIONS', target).outcome, 'deny', `${target} on ${surface}`);
    }
  }
});

test('unknown routes, methods and surfaces fail closed', () => {
  for (const surface of SURFACES) {
    for (const [method, target] of [
      ['GET', '/api'], ['GET', '/api/'], ['GET', '/api/unknown'], ['GET', '/api/admin'], ['DELETE', '/api/admin/notices/1'],
      ['GET', '/api/auth/login'], ['POST', '/api/notices'], ['PUT', '/api/feedback'], ['GET', '/apiadmin'],
      ['POST', '/'], ['GET', '/.env'], ['GET', '/server/index.ts'], ['GET', '/random'],
      ['GET', '/api/exams/1'], ['POST', '/api/exams'], ['GET', '/api/notices/1'], ['GET', '/api/institute-forms/1'],
      ['GET', '/api/answer-keys/x'], ['GET', '/api/answer-keys/exams/x'], ['POST', '/api/answer-keys'], ['GET', '/api/answer-key'],
    ] as const) {
      const decision = decideRequest(surface, method, target);
      assert.equal(decision.outcome, 'deny', `${method} ${target} on ${surface}`);
      assert.equal(decision.status, 404);
    }
    for (const method of ['TRACE', 'CONNECT', 'PROPFIND', '', undefined, 1]) {
      assert.equal(decideRequest(surface, method, '/api/auth/me').outcome, 'deny', String(method));
    }
  }
  for (const surface of ['', 'staff', 'Admin', undefined, null]) {
    assert.deepEqual(decideRequest(surface, 'GET', '/api/auth/me'), { outcome: 'deny', status: 421, category: 'unknown_surface', reason: 'unknown surface' });
  }
});

test('no route is unresolved after Amendment A-1', () => {
  assert.deepEqual(unresolvedPolicyRows(), []);
});

test('the unresolved mechanism remains available and fails closed for future routes', () => {
  const question = 'Synthetic future route: which surface owns it?';
  const synthetic = Object.freeze({
    method: 'GET' as const,
    path: '/api/future-route',
    routeClass: 'public_content' as const,
    access: Object.freeze({ marketing: unresolvedAccess(question), exam: unresolvedAccess(question), institution: { decision: 'deny' as const }, admin: { decision: 'deny' as const } }),
  });
  assert.deepEqual(unresolvedAccess(question), { decision: 'unresolved', question });
  assert.ok(Object.isFrozen(unresolvedAccess(question)));
  for (const surface of ['marketing', 'exam'] as const) {
    const decision = decideForEntry(surface, synthetic);
    assert.equal(decision.outcome, 'unresolved', surface);
    assert.equal(decision.status, 404);
    assert.equal(decision.outcome === 'unresolved' && decision.question, question);
  }
  for (const surface of ['institution', 'admin'] as const) assert.equal(decideForEntry(surface, synthetic).outcome, 'deny');
  assert.equal(decideForEntry('staff' as Surface, synthetic).outcome, 'deny', 'unknown surface fails closed');
  // decideRequest delegates matched entries to decideForEntry.
  for (const policyEntry of ROUTE_POLICY) {
    for (const surface of SURFACES) {
      const fromTable = decideRequest(surface, policyEntry.method, policyEntry.path.replace(/:[A-Za-z]+/g, 'X1'));
      assert.deepEqual(fromTable, decideForEntry(surface, policyEntry), `${policyEntry.method} ${policyEntry.path} on ${surface}`);
    }
  }
});

test('policy data is immutable', () => {
  assert.ok(Object.isFrozen(ROUTE_POLICY));
  for (const policyEntry of ROUTE_POLICY) {
    assert.ok(Object.isFrozen(policyEntry), policyEntry.path);
    assert.ok(Object.isFrozen(policyEntry.access), policyEntry.path);
  }
  assert.throws(() => { (ROUTE_POLICY as RoutePolicyEntry[]).push(ROUTE_POLICY[0]); });
});

// ---------------------------------------------------------------------------
// 22. Route-inventory completeness (live Express stack)
// ---------------------------------------------------------------------------

interface ExpressLayer {
  name?: string;
  regexp?: RegExp;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler; name?: string }> };
  handle?: { stack?: ExpressLayer[] };
}

interface RegisteredRoute {
  method: string;
  path: string;
  handlers: Array<{ handle: RequestHandler; name?: string }>;
}

function mountPrefix(layer: ExpressLayer): string {
  const source = layer.regexp?.source ?? '';
  return source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
}

function collectRoutes(stack: ExpressLayer[], prefix = ''): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const routePath of paths) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled && method !== '_all') routes.push({ method: method.toUpperCase(), path: prefix + routePath, handlers: layer.route.stack });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const mount = mountPrefix(layer);
      assert.match(mount, /^(?:\/[a-z0-9-]+)+$/, `mounted router prefix must be a literal path: ${layer.regexp?.source}`);
      routes.push(...collectRoutes(layer.handle.stack, prefix + mount));
    }
  }
  return routes;
}

const APP_STACK = (app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack;
const ROUTES = collectRoutes(APP_STACK);
const builtClientExists = existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'));

test('every registered route has exactly one policy entry, and every entry is registered', () => {
  assert.ok(ROUTES.length >= ROUTE_POLICY.length, 'the route stack was enumerated');
  const unclassified: string[] = [];
  const seen = new Set<string>();
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    assert.ok(!seen.has(key), `duplicate registration: ${key}`);
    seen.add(key);
    if (route.method === SPA_FALLBACK_ROUTE.method && route.path === SPA_FALLBACK_ROUTE.path) continue;
    const matches = ROUTE_POLICY.filter((policyEntry) => policyEntry.method === route.method && policyEntry.path === route.path);
    if (matches.length !== 1) unclassified.push(`${key} (${matches.length} entries)`);
  }
  assert.deepEqual(unclassified, [], `unclassified routes:\n${unclassified.join('\n')}`);
  const stale = ROUTE_POLICY.filter((policyEntry) => !seen.has(`${policyEntry.method} ${policyEntry.path}`)).map((policyEntry) => `${policyEntry.method} ${policyEntry.path}`);
  assert.deepEqual(stale, [], `policy entries without a registered route:\n${stale.join('\n')}`);
  assert.equal(seen.has('GET *'), builtClientExists, 'the SPA catch-all exists exactly when dist/ exists');
  assert.equal(ROUTES.length, ROUTE_POLICY.length + (builtClientExists ? 1 : 0));
});

test('inventory covers parameterised routes, mounted routers and routes outside /api/admin', () => {
  const paths = ROUTES.map((route) => route.path);
  assert.ok(paths.some((routePath) => routePath.includes('/:')), 'parameterised routes');
  assert.ok(paths.includes('/api/institution-document-submission/admin/cycles'), 'mounted router route');
  assert.ok(paths.includes('/api/institution-document-submission/documents/:documentId/versions'), 'mounted parameterised route');
  assert.ok(paths.filter((routePath) => !routePath.startsWith('/api/admin/') && routePath !== '*').length > 30, 'non-admin routes');
  for (const route of ROUTES) {
    if (route.path === '*') continue;
    assert.doesNotThrow(() => compileRoutePattern(route.path), `every registered pattern is representable: ${route.path}`);
  }
});

test('an unclassified route would fail the inventory check', () => {
  const fake: ExpressLayer[] = [{ route: { path: '/api/new-unreviewed', methods: { get: true }, stack: [] } }];
  const routes = collectRoutes(fake);
  const unclassified = routes.filter((route) => !ROUTE_POLICY.some((policyEntry) => policyEntry.method === route.method && policyEntry.path === route.path));
  assert.equal(unclassified.length, 1);
  assert.equal(decideRequest('admin', 'GET', '/api/new-unreviewed').outcome, 'deny');
});

test('Express route selection never disagrees with the policy matcher', () => {
  // For adversarial spellings of every registered path, the first Express route (stack order,
  // HEAD falling back to GET) must be the route the policy matcher selects, unless the policy
  // rejects the spelling as malformed. If Express matches nothing, the policy must match nothing.
  const liveRoutes = ROUTES.filter((route) => route.path !== '*').map((route) => ({ ...route, regexp: compileRoutePattern(route.path) }));
  const expressRoute = (method: string, requestPath: string) => {
    const lookup = (verb: string) => liveRoutes.find((route) => route.method === verb && route.regexp.test(requestPath));
    return lookup(method) ?? (method === 'HEAD' ? lookup('GET') : undefined);
  };
  const variants = (routePath: string) => {
    const concrete = routePath.replace(/:[A-Za-z]+/g, 'X1');
    return [
      concrete, concrete.toUpperCase(), `${concrete}/`, `${concrete}//`, `/${concrete}`, concrete.replace('/api/', '/api//'),
      concrete.replace(/\/([^/]+)$/, '%2F$1'), `${concrete}/extra`, concrete.replace(/X1/g, 'a%2Fb'), concrete.replace(/X1/g, '..'),
      concrete.replace(/X1/g, '.'), concrete.replace(/X1/g, 'admin'), concrete.replace(/X1/g, 'cycles'), `${concrete}?x=/api/admin/notices`,
      concrete.replace(/\/[^/]+$/, ''),
    ];
  };
  let compared = 0;
  for (const route of liveRoutes) {
    for (const target of variants(route.path)) {
      const parsed = parseRequestPath(target);
      for (const method of METHODS) {
        const pathOnly = target.split('?')[0];
        const live = expressRoute(method, pathOnly);
        if (!parsed.ok) continue;
        const policy = matchRoutePolicy(method, parsed.path);
        assert.equal(policy ? `${policy.method} ${policy.path}` : null, live ? `${live.method} ${live.path}` : null, `${method} ${target}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 1000, `compared ${compared} cases`);
});

test('policy role levels agree with the guards registered on each route', async () => {
  const routeByKey = new Map(ROUTES.map((route) => [`${route.method} ${route.path}`, route]));
  const probe = (handle: RequestHandler, role: string, isSuperAdmin: boolean) => new Promise<'next' | number>((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json() { resolve(this.statusCode); return this; },
    };
    const request = { user: { id: 'synthetic', role, isSuperAdmin }, headers: {}, body: {}, query: {}, params: {} };
    try {
      handle(request as never, response as never, (error?: unknown) => (error ? reject(error) : resolve('next')));
    } catch (error) {
      reject(error);
    }
  });
  const principals = [['candidate', false], ['center', false], ['official', false], ['official', true]] as const;

  for (const policyEntry of ROUTE_POLICY) {
    const route = routeByKey.get(`${policyEntry.method} ${policyEntry.path}`);
    assert.ok(route, `${policyEntry.method} ${policyEntry.path}`);
    const names = route.handlers.map((handler) => handler.name ?? '');
    const label = `${policyEntry.method} ${policyEntry.path}: ${names.join(',')}`;
    const auths = new Set(SURFACES.flatMap((surface) => {
      const access = policyEntry.access[surface];
      return access.decision === 'allow' ? [access.auth] : [];
    }));

    const sessionAuths = [...auths].filter((auth) => ['session', 'candidate', 'center', 'official', 'super_admin'].includes(auth));
    const pendingAuth = policyEntry.pendingAuthentication;
    if (pendingAuth) {
      // The record must describe the route as it is TODAY: authentication is not yet enforced.
      assert.ok(sessionAuths.length > 0, `${label}: pending authentication without a session requirement`);
      assert.equal(pendingAuth.phase, 'P1-B', label);
      if (pendingAuth.currentRouteGuard === 'optionalAuth') assert.equal(names[0], 'optionalAuth', label);
      else assert.ok(!names.includes('optionalAuth'), `${label}: currentRouteGuard says none`);
      assert.ok(!names.includes('requireAuth'), `${label}: requireAuth is registered; update or remove pendingAuthentication`);
      assert.ok(!names.includes('requireSuperAdmin'), label);
      assert.equal(pendingAuth.enforcement, auths.has('anonymous') ? 'central_only' : 'route_guard_or_central', label);
      continue;
    }
    assert.ok(!names.includes('optionalAuth'), label);
    assert.equal(names.includes('requireSuperAdmin'), auths.has('super_admin'), label);

    const roleAuths = [...auths].filter((auth) => ['candidate', 'center', 'official', 'super_admin'].includes(auth));
    if (policyEntry.centralAuthenticationOnly) {
      // Anonymous on one surface, a session on another: the route must carry no auth middleware;
      // the central surface enforcement (surfaceEnforcement.test.ts) is the control.
      assert.ok(!names.includes('requireAuth') && !names.includes('optionalAuth'), label);
      assert.ok(auths.has('anonymous') && roleAuths.length > 0, label);
    } else if (roleAuths.length > 0) {
      assert.ok(!auths.has('anonymous'), label);
      assert.equal(names[0], 'requireAuth', label);
      // The route's role guard admits exactly the policy's roles (Super Admin is an Official role).
      const allowed = new Set(roleAuths.map((auth) => (auth === 'super_admin' ? 'official' : auth)));
      for (const [role, isSuperAdmin] of principals) {
        const result = await probe(route.handlers[1].handle, role, isSuperAdmin);
        assert.equal(result, allowed.has(role) ? 'next' : 403, `${label} with ${role}${isSuperAdmin ? '+super' : ''}`);
      }
    } else if (auths.has('session')) {
      assert.equal(names[0], 'requireAuth', label);
    } else {
      // anonymous, login and capability rows (and deny-only health) carry no session guard.
      assert.ok(!names.includes('requireAuth'), label);
    }
  }
  assert.equal(databaseAttempts, 0, 'no database access during guard probes');
});

test('importing the application opened no listener and no database connection', () => {
  assert.equal(databaseAttempts, 0);
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  const servers = handles.filter((handle) => handle?.constructor?.name === 'Server');
  assert.equal(servers.length, 0, 'no listening server');
  assert.equal((pool as unknown as { totalCount: number }).totalCount, 0, 'no pool clients');
});

test('production domains: public eltnoy.com and private Admin eltnoy.in, matched by label, never by substring', () => {
  const { PRODUCTION_DOMAINS, isProductionDomainHostname } = surfaceModule;
  assert.deepEqual([...PRODUCTION_DOMAINS], ['eltnoy.com', 'eltnoy.in']);
  for (const host of [...Object.values(PINNED_SURFACE_HOSTNAMES), 'admin.eltnoy.com', 'EltNoy.In', 'staging.admin.eltnoy.in']) {
    assert.equal(isProductionDomainHostname(host), true, host);
  }
  for (const host of ['eltnoy.co.in', 'noteltnoy.in', 'eltnoy.in.example.test', 'eltnoy.com.evil.com', 'admin.example.test']) {
    assert.equal(isProductionDomainHostname(host), false, host);
  }
  // The Admin hostname is on a different registrable domain from every public surface.
  const registrable = (host: string) => host.split('.').slice(-2).join('.');
  for (const surface of PUBLIC_SURFACES) {
    assert.notEqual(registrable(PINNED_SURFACE_HOSTNAMES[surface]), registrable(PINNED_SURFACE_HOSTNAMES.admin), surface);
  }
});
