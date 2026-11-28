// P0-3 authorization enforcement tests (code-only scope).
//
// 1. A route-authorization matrix for every /api/admin/* route (and every mounted /admin/ route):
//    unauthenticated, candidate, center, ordinary Official and Super Admin, asserting that a
//    rejected request runs no query other than the session lookup and opens no connection.
// 2. A registry check: every registered admin route must have a matrix entry with a documented
//    policy, and every matrix entry must exist. Deliberately non-admin routes that serve the same
//    content are documented separately with their expected policy.
// 3. Behaviour tests: withdrawal maker-checker (legacy approvers, NULL approvers, duplicate and
//    concurrent payments, Super Admin count), result conditional upserts with atomic rollback and
//    import/publish races, answer-key and online-exam locking, helpdesk count hiding.
//
// No real database is used: the shared pool's `query` and `connect` are replaced with scripted
// fakes and restored after each test. Synthetic accounts and data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import ExcelJS from 'exceljs';
import { expectedOrigin, type Surface } from './surface.js';
import { VERIFIED_PORTAL_SESSION } from './authTestSupport.js';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:1/p03_route_tests';

const [
  { app, RESULT_UPSERT_SQL, ANSWER_KEY_IMPORT_SQL, ONLINE_EXAM_IMPORT_SQL, WITHDRAWAL_SQL, MIN_ACTIVE_SUPER_ADMINS_FOR_PAYMENT },
  { pool },
  { hashSessionToken, setTrustedRequestSurface },
  { addWorkbookSheet },
] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
  import('./adminWorkbook.js'),
]);

// ---------------------------------------------------------------------------
// Synthetic accounts
// ---------------------------------------------------------------------------

type AccountName = 'candidate' | 'center' | 'official' | 'superA' | 'superB';

const ACCOUNTS: Record<AccountName, { token: string; row: Record<string, unknown> }> = {
  candidate: { token: 'P'.repeat(43), row: { id: 'synthetic-candidate', role: 'candidate', is_super_admin: false, ...VERIFIED_PORTAL_SESSION } },
  center: { token: 'Q'.repeat(43), row: { id: 'synthetic-center', role: 'center', is_super_admin: false, ...VERIFIED_PORTAL_SESSION } },
  official: { token: 'R'.repeat(43), row: { id: 'synthetic-official', role: 'official', is_super_admin: false, ...VERIFIED_PORTAL_SESSION } },
  superA: { token: 'S'.repeat(43), row: { id: 'synthetic-super-a', role: 'official', is_super_admin: true, ...VERIFIED_PORTAL_SESSION } },
  superB: { token: 'T'.repeat(43), row: { id: 'synthetic-super-b', role: 'official', is_super_admin: true, ...VERIFIED_PORTAL_SESSION } },
};

const SESSIONS = new Map(Object.values(ACCOUNTS).map(({ token, row }) => [hashSessionToken(token), {
  login_id: String(row.id).toUpperCase(),
  display_name: `Synthetic ${String(row.id)}`,
  account_status: 'approved',
  ...row,
}]));

const SESSION_SQL_MARKER = 'FROM auth_sessions s';

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface RecordedCall {
  text: string;
  values: unknown[];
  via: 'pool' | 'client';
}

type ScriptedHandler = (text: string, values: unknown[], via: 'pool' | 'client', clientId: number) => Promise<QueryResult | undefined> | QueryResult | undefined;

const mutablePool = pool as unknown as {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
  connect: () => Promise<unknown>;
};
const originalQuery = mutablePool.query;
const originalConnect = mutablePool.connect;

function installDatabase(handler?: ScriptedHandler) {
  const calls: RecordedCall[] = [];
  let connects = 0;
  let releases = 0;
  const run = async (text: string, values: unknown[], via: 'pool' | 'client', clientId: number): Promise<QueryResult> => {
    if (text.includes(SESSION_SQL_MARKER)) {
      const session = SESSIONS.get(String(values[0]));
      return { rows: session ? [session] : [], rowCount: session ? 1 : 0 };
    }
    calls.push({ text, values, via });
    const result = await handler?.(text, values, via, clientId);
    return result ?? { rows: [], rowCount: 0 };
  };
  mutablePool.query = async (text: string, values: unknown[] = []) => run(text, values, 'pool', 0);
  mutablePool.connect = async () => {
    connects += 1;
    const clientId = connects;
    return {
      query: (text: string, values: unknown[] = []) => run(text, values, 'client', clientId),
      release: () => {
        releases += 1;
      },
    };
  };
  return {
    calls,
    connects: () => connects,
    releases: () => releases,
    statements: () => calls.map((call) => call.text),
    restore() {
      mutablePool.query = originalQuery;
      mutablePool.connect = originalConnect;
    },
  };
}

type Database = ReturnType<typeof installDatabase>;

async function withDatabase<T>(handler: ScriptedHandler | undefined, run: (db: Database) => Promise<T>): Promise<T> {
  const db = installDatabase(handler);
  const originals = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const level of ['info', 'warn', 'error', 'log'] as const) console[level] = () => undefined;
  try {
    return await run(db);
  } finally {
    Object.assign(console, originals);
    db.restore();
  }
}

// ---------------------------------------------------------------------------
// Route registry (walks the Express 4 router, including mounted routers)
// ---------------------------------------------------------------------------

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RegisteredRoute {
  method: Method;
  path: string;
  stack: Array<{ handle: RequestHandler; name?: string }>;
}

interface ExpressLayer {
  name?: string;
  regexp?: RegExp;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler; name?: string }> };
  handle?: { stack?: ExpressLayer[] };
}

function mountPrefix(layer: ExpressLayer): string {
  const source = layer.regexp?.source ?? '';
  return source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
}

function collectRoutes(stack: ExpressLayer[], prefix = ''): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled && method !== '_all') routes.push({ method: method as Method, path: `${prefix}${path}`, stack: layer.route.stack });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(...collectRoutes(layer.handle.stack, `${prefix}${mountPrefix(layer)}`));
    }
  }
  return routes;
}

const ROUTES = collectRoutes((app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack);

function findRoute(method: Method, path: string): RegisteredRoute {
  const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
  assert.ok(route, `Expected ${method.toUpperCase()} ${path} to be registered`);
  return route;
}

function handlerNames(route: RegisteredRoute): string[] {
  return route.stack.map((layer) => layer.handle.name || layer.name || '<anonymous>');
}

// ---------------------------------------------------------------------------
// Route invocation
// ---------------------------------------------------------------------------

interface RouteOutcome {
  status: number;
  body: Record<string, unknown>;
  /** Set when the handler chain passed an error to next() (it got past the guards). */
  error?: unknown;
}

// P1-B: these route-stack calls bypass the app-level surface enforcement, so each fake request
// carries the server-controlled surface of its account's role (candidate → Exam, center →
// Institution, officials → Admin). Unauthenticated calls default to Admin (the matrix routes).
const SURFACE_OF_ROLE: Record<string, Surface> = { candidate: 'exam', center: 'institution', official: 'admin' };

function invoke(
  method: Method,
  path: string,
  options: { account?: AccountName; params?: Record<string, string>; body?: unknown; surface?: Surface } = {},
): Promise<RouteOutcome> {
  const handlers = findRoute(method, path).stack.map((layer) => layer.handle);
  return new Promise((resolve) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    const finish = (outcome: RouteOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const token = options.account ? ACCOUNTS[options.account].token : undefined;
    const request = {
      method: method.toUpperCase(),
      url: path,
      originalUrl: path,
      path,
      headers: token ? { cookie: `elt_session=${token}` } : {},
      params: options.params ?? {},
      query: {},
      body: options.body,
      get: () => undefined,
      header: () => undefined,
    } as unknown as Request;
    const surface = options.surface
      ?? (options.account ? SURFACE_OF_ROLE[String(ACCOUNTS[options.account].row.role)] : 'admin');
    setTrustedRequestSurface(request, surface, expectedOrigin(surface));
    const response = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      set() {
        return this;
      },
      setHeader() {
        return this;
      },
      type() {
        return this;
      },
      json(body: Record<string, unknown>) {
        finish({ status, body: JSON.parse(JSON.stringify(body ?? {})) });
        return this;
      },
      send() {
        finish({ status, body: {} });
        return this;
      },
      end() {
        finish({ status, body: {} });
        return this;
      },
      clearCookie() {
        return this;
      },
    } as unknown as Response;
    const next: NextFunction = (error?: unknown) => {
      if (error) {
        finish({ status: 500, body: {}, error });
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

// ---------------------------------------------------------------------------
// 1. Authorization matrix
// ---------------------------------------------------------------------------

/**
 * super_admin: requireSuperAdmin on the route (403 for ordinary Officials before the handler).
 * official: every approved Official (unchanged by P0-3).
 * official_conditional: every Official reaches the handler; the handler refuses corrections of
 *   published content for ordinary Officials inside its transaction (behaviour tests below).
 */
type Policy = 'super_admin' | 'official' | 'official_conditional';

interface MatrixEntry {
  method: Method;
  path: string;
  policy: Policy;
  ref: string;
  params?: Record<string, string>;
}

const OPAQUE_ID = '00000000-0000-4000-8000-000000000001';

const MATRIX: MatrixEntry[] = [
  // SM-1: Platform Staff management and Organization Staff activation — Super Admin only.
  { method: 'get', path: '/api/admin/platform-staff', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only)' },
  { method: 'post', path: '/api/admin/platform-staff', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only)' },
  { method: 'post', path: '/api/admin/platform-staff/:id/deactivate', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only)', params: { id: OPAQUE_ID } },
  { method: 'put', path: '/api/admin/platform-staff/:id/assignment', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only)', params: { id: OPAQUE_ID } },
  { method: 'get', path: '/api/admin/platform-staff/departments', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only)' },
  { method: 'post', path: '/api/admin/platform-staff/departments', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only)' },
  { method: 'get', path: '/api/admin/platform-staff/roles', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only; D-08 catalogue empty)' },
  { method: 'post', path: '/api/admin/platform-staff/roles', policy: 'super_admin', ref: 'SM-1 Platform Staff (Super Admin only; D-08 catalogue empty)' },
  { method: 'get', path: '/api/admin/platform-staff/audit', policy: 'super_admin', ref: 'SM-1 / A-12 (audit read: Super Admin only)' },
  { method: 'get', path: '/api/admin/organization-staff', policy: 'super_admin', ref: 'SM-1 / Q115 (Super Admin activation)' },
  { method: 'post', path: '/api/admin/organization-staff/:id/activate', policy: 'super_admin', ref: 'SM-1 / Q115 (Super Admin activation)', params: { id: OPAQUE_ID } },
  { method: 'get', path: '/api/admin/institute-verifications', policy: 'super_admin', ref: 'AUTH-1 / SM-2 institutional verification (Super Admin only)' },
  { method: 'get', path: '/api/admin/institute-verifications/decisions', policy: 'super_admin', ref: 'AUTH-1 / SM-2 / A-12 (decision audit read: Super Admin only)' },
  { method: 'post', path: '/api/admin/institute-verifications/:institutionId/verify', policy: 'super_admin', ref: 'AUTH-1 / SM-2 institutional verification (Super Admin only)', params: { institutionId: OPAQUE_ID } },
  { method: 'post', path: '/api/admin/institute-verifications/:institutionId/reject', policy: 'super_admin', ref: 'AUTH-1 / SM-2 institutional verification (Super Admin only)', params: { institutionId: OPAQUE_ID } },
  { method: 'post', path: '/api/admin/institute-verifications/:institutionId/suspend', policy: 'super_admin', ref: 'AUTH-1 / SM-2 institute suspension (Super Admin only)', params: { institutionId: OPAQUE_ID } },
  { method: 'post', path: '/api/admin/institute-verifications/:institutionId/restore', policy: 'super_admin', ref: 'AUTH-1 / SM-2 institute suspension (Super Admin only)', params: { institutionId: OPAQUE_ID } },
  // Super Admin only
  { method: 'get', path: '/api/admin/data-export', policy: 'super_admin', ref: 'A-07 (preserved)' },
  { method: 'get', path: '/api/admin/institute-workspace/review-queue', policy: 'super_admin', ref: 'D-02 (Super Admin reviews Institute drafts)' },
  { method: 'post', path: '/api/admin/institute-workspace/exams/:id/decision', policy: 'super_admin', ref: 'D-02 (exam approval and publication)', params: { id: OPAQUE_ID } },
  { method: 'get', path: '/api/admin/institute-workspace/exams/:id/results', policy: 'super_admin', ref: 'D-02 / A-04', params: { id: OPAQUE_ID } },
  { method: 'post', path: '/api/admin/institute-workspace/exams/:id/results/decision', policy: 'super_admin', ref: 'D-02 / A-04 (result publication)', params: { id: OPAQUE_ID } },
  { method: 'post', path: '/api/admin/institute-workspace/exams/:id/admit-cards/decision', policy: 'super_admin', ref: 'D-02 / A-06 (admit-card release)', params: { id: OPAQUE_ID } },
  { method: 'post', path: '/api/admin/admit-cards/import', policy: 'super_admin', ref: 'A-06 / P3-D1 (interim)' },
  { method: 'put', path: '/api/admin/applications/:id/admit-card', policy: 'super_admin', ref: 'A-06 / P3-D1 (interim)', params: { id: 'app-1' } },
  { method: 'patch', path: '/api/admin/answer-keys/:examCode', policy: 'super_admin', ref: 'A-05', params: { examCode: 'EXAM1' } },
  { method: 'patch', path: '/api/admin/online-exams/:examCode', policy: 'super_admin', ref: 'A-05', params: { examCode: 'EXAM1' } },
  { method: 'post', path: '/api/admin/institutes/:id/credits', policy: 'super_admin', ref: 'A-02', params: { id: 'center-1' } },
  { method: 'patch', path: '/api/admin/institute-withdrawals/:id', policy: 'super_admin', ref: 'A-03', params: { id: 'withdrawal-1' } },
  { method: 'get', path: '/api/admin/feedback', policy: 'super_admin', ref: 'A-14' },
  { method: 'patch', path: '/api/admin/feedback/:id', policy: 'super_admin', ref: 'A-14', params: { id: 'ticket-1' } },
  { method: 'post', path: '/api/admin/applications/:id/verify-ownership', policy: 'super_admin', ref: 'A-15', params: { id: 'app-1' } },
  { method: 'patch', path: '/api/admin/results/:id', policy: 'super_admin', ref: 'A-04', params: { id: 'result-1' } },
  { method: 'get', path: '/api/admin/institution-documents/versions/:versionId/content', policy: 'super_admin', ref: 'A-09 / P3-D10 (preview and download)', params: { versionId: OPAQUE_ID } },
  { method: 'post', path: '/api/admin/institution-documents/versions/:versionId/reviews', policy: 'super_admin', ref: 'A-09', params: { versionId: OPAQUE_ID } },
  // Every Official; corrections of published content refused for ordinary Officials in the handler
  { method: 'post', path: '/api/admin/results', policy: 'official_conditional', ref: 'A-04 / A-16 (never publishes)' },
  { method: 'post', path: '/api/admin/results/import', policy: 'official_conditional', ref: 'A-04 / A-16 / A-18' },
  { method: 'post', path: '/api/admin/answer-keys/import', policy: 'official_conditional', ref: 'A-05 / A-16 / A-18' },
  { method: 'post', path: '/api/admin/online-exams/import', policy: 'official_conditional', ref: 'A-05 / A-16 / A-18 (P0-4 attempts guard first)' },
  // Every Official (unchanged)
  { method: 'get', path: '/api/admin/dashboard-stats', policy: 'official', ref: 'P3-D4 (helpdesk count hidden for ordinary Officials)' },
  { method: 'get', path: '/api/admin/institute-management', policy: 'official', ref: 'A-03 support (read-only)' },
  { method: 'patch', path: '/api/admin/institutes/:id', policy: 'official', ref: 'A-01 (preserved)', params: { id: 'center-1' } },
  { method: 'post', path: '/api/admin/exams', policy: 'official', ref: 'A-18 (preserved)' },
  { method: 'patch', path: '/api/admin/exams/:id', policy: 'official', ref: 'P3-D6 (excluded from this batch)', params: { id: 'exam-1' } },
  { method: 'post', path: '/api/admin/notices', policy: 'official', ref: 'A-17 (all Officials create drafts)' },
  { method: 'patch', path: '/api/admin/notices/:id', policy: 'super_admin', ref: 'A-17 (Super Admin publication only)', params: { id: 'notice-1' } },
  { method: 'get', path: '/api/admin/applications', policy: 'official', ref: 'P3-D6 (A-08 excluded from this batch)' },
  { method: 'patch', path: '/api/admin/applications/:id', policy: 'official', ref: 'A-08 status workflow (preserved)', params: { id: 'app-1' } },
  { method: 'patch', path: '/api/admin/institute-forms/:id', policy: 'official', ref: 'not covered by P0-3 (PERM gap)', params: { id: 'form-1' } },
  { method: 'patch', path: '/api/admin/institute-profile-changes/:id', policy: 'official', ref: 'not covered by P0-3 (PERM gap)', params: { id: 'change-1' } },
  { method: 'get', path: '/api/admin/notices', policy: 'official', ref: 'read-only' },
  { method: 'get', path: '/api/admin/workbook-template', policy: 'official', ref: 'read-only (blank templates)' },
  { method: 'get', path: '/api/admin/answer-keys', policy: 'official', ref: 'read-only' },
  { method: 'get', path: '/api/admin/online-exams', policy: 'official', ref: 'read-only' },
  { method: 'get', path: '/api/admin/exams', policy: 'official', ref: 'read-only' },
  { method: 'get', path: '/api/admin/institutes', policy: 'official', ref: 'read-only (A-01 support)' },
  { method: 'get', path: '/api/admin/results', policy: 'official', ref: 'read-only' },
  { method: 'get', path: '/api/admin/mock-exams/attempts', policy: 'official', ref: 'read-only' },
  { method: 'get', path: '/api/admin/institution-documents', policy: 'official', ref: 'A-09 metadata list (P3-D5 pending)' },
  { method: 'get', path: '/api/admin/institution-documents/policy', policy: 'official', ref: 'A-09 policy metadata' },
  { method: 'get', path: '/api/institution-document-submission/admin/cycles', policy: 'official', ref: 'A-01 support (read-only)' },
];

/**
 * Deliberately non-admin routes that expose the same content to applicants or institutions.
 * They are not admin routes, so they are outside the matrix, but their expected policy is fixed
 * here and checked structurally.
 */
const DOCUMENTED_NON_ADMIN_ROUTES: Array<{ method: Method; path: string; policy: 'public' | 'candidate' | 'center' | 'authenticated'; note: string }> = [
  { method: 'get', path: '/api/answer-keys/exams', policy: 'candidate', note: 'Candidate on Exam only (P1-A A-1/U3, enforced P1-B); published answer keys only' },
  { method: 'get', path: '/api/answer-keys', policy: 'candidate', note: 'Candidate on Exam only (P1-A A-1/U3, enforced P1-B); published answer keys only' },
  { method: 'get', path: '/api/notices', policy: 'public', note: 'published notices only' },
  { method: 'post', path: '/api/feedback', policy: 'authenticated', note: 'Candidate on Exam, Institution (center) on Institution (P1 v1.4 §8, enforced P1-B); A-14 covers reading tickets' },
  { method: 'get', path: '/api/online-exams', policy: 'candidate', note: 'P0-4 candidate list (published papers only)' },
  { method: 'get', path: '/api/candidate/portal', policy: 'candidate', note: "the candidate's own applications and published results" },
  { method: 'post', path: '/api/center/withdrawals', policy: 'center', note: 'an institute requests a withdrawal; approval and payment are A-03' },
  { method: 'get', path: '/api/center/documents/versions/:versionId/content', policy: 'center', note: "an institution's own documents only" },
];

function isAdminPath(path: string): boolean {
  return path.startsWith('/api/admin/') || path.includes('/admin/');
}

const protectedCalls = (db: Database) => db.calls.length;

function guardPassed(outcome: RouteOutcome, db: Database): boolean {
  return (outcome.status !== 401 && outcome.status !== 403) || outcome.error !== undefined || protectedCalls(db) > 0 || db.connects() > 0;
}

test('registry: every admin route has exactly one matrix entry with a documented policy, and every entry exists', () => {
  const registered = ROUTES.filter((route) => isAdminPath(route.path)).map((route) => `${route.method.toUpperCase()} ${route.path}`).sort();
  const declared = MATRIX.map((entry) => `${entry.method.toUpperCase()} ${entry.path}`).sort();
  assert.equal(new Set(declared).size, declared.length, 'duplicate matrix entries');
  const missing = registered.filter((route) => !declared.includes(route));
  const stale = declared.filter((route) => !registered.includes(route));
  assert.deepEqual(missing, [], `admin routes without a policy entry: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `matrix entries for routes that do not exist: ${stale.join(', ')}`);
  for (const entry of MATRIX) assert.ok(entry.ref.length > 0, `${entry.path} must document its policy reference`);
});

test('registry: guard structure matches each documented policy', () => {
  for (const entry of MATRIX) {
    const names = handlerNames(findRoute(entry.method, entry.path));
    const label = `${entry.method.toUpperCase()} ${entry.path}`;
    assert.equal(names[0], 'requireAuth', `${label} must authenticate first`);
    const superAdminIndex = names.indexOf('requireSuperAdmin');
    if (entry.policy === 'super_admin') {
      assert.ok(superAdminIndex > 0, `${label} must use requireSuperAdmin`);
      // The guard runs before any body parsing or handler work.
      const parserIndex = names.findIndex((name) => /parser/i.test(name));
      if (parserIndex !== -1) assert.ok(superAdminIndex < parserIndex, `${label}: requireSuperAdmin must run before the upload parser`);
      assert.ok(superAdminIndex < names.length - 1, `${label}: requireSuperAdmin must run before the handler`);
    } else {
      assert.equal(superAdminIndex, -1, `${label} is documented as open to every Official`);
    }
  }
});

test('registry: documented non-admin routes keep their expected policy', () => {
  for (const entry of DOCUMENTED_NON_ADMIN_ROUTES) {
    const names = handlerNames(findRoute(entry.method, entry.path));
    const label = `${entry.method.toUpperCase()} ${entry.path}`;
    assert.ok(!names.includes('requireSuperAdmin'), `${label} must not be Super Admin-only`);
    if (entry.policy === 'public') assert.ok(!names.includes('requireAuth'), `${label} is documented as public`);
    else assert.equal(names[0], 'requireAuth', `${label} is documented as ${entry.policy}`);
  }
});

for (const entry of MATRIX) {
  const label = `${entry.method.toUpperCase()} ${entry.path} [${entry.policy}; ${entry.ref}]`;

  test(`matrix: ${label}`, async () => {
    const run = (account?: AccountName) => withDatabase(undefined, async (db) => {
      const outcome = await invoke(entry.method, entry.path, { account, params: entry.params, body: {} });
      return { outcome, db };
    });

    // No session: 401, nothing else runs.
    {
      const { outcome, db } = await run(undefined);
      assert.equal(outcome.status, 401, `${label}: unauthenticated`);
      assert.equal(protectedCalls(db), 0);
      assert.equal(db.connects(), 0);
    }
    // Candidate and center: 403, no protected query, no connection.
    for (const account of ['candidate', 'center'] as const) {
      const { outcome, db } = await run(account);
      assert.equal(outcome.status, 403, `${label}: ${account}`);
      assert.equal(protectedCalls(db), 0, `${label}: ${account} must not reach the database`);
      assert.equal(db.connects(), 0);
    }
    // Ordinary Official.
    {
      const { outcome, db } = await run('official');
      if (entry.policy === 'super_admin') {
        assert.equal(outcome.status, 403, `${label}: ordinary Official`);
        assert.equal(outcome.error, undefined);
        assert.equal(protectedCalls(db), 0, `${label}: refused request must not run protected queries or read files`);
        assert.equal(db.connects(), 0);
      } else {
        assert.ok(guardPassed(outcome, db), `${label}: ordinary Official must pass the route guards`);
      }
    }
    // Super Admin.
    {
      const { outcome, db } = await run('superA');
      assert.ok(guardPassed(outcome, db), `${label}: Super Admin must pass the route guards`);
    }
  });
}

const validNoticeDraft = {
  title: 'Synthetic examination schedule update',
  category: 'Circular',
  summary: 'Synthetic notice draft summary for an authorization test.',
  fullContent: 'Synthetic notice content. No real candidate or production information.',
  referenceNumber: 'SYNTHETIC/NOTICE/2026/001',
};

test('A-17: every Official creates notices as unpublished drafts', async () => {
  for (const account of ['official', 'superA'] as const) {
    const { outcome, db } = await withDatabase((text, values) => {
      if (!text.includes('INSERT INTO portal_notices')) return undefined;
      assert.match(text, /VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6,\s*false,\s*\$7,\s*NULL\)/);
      assert.equal(values[6], ACCOUNTS[account].row.id);
      return {
        rows: [{
          id: 'synthetic-notice',
          title: validNoticeDraft.title,
          is_published: false,
          published_at: null,
        }],
        rowCount: 1,
      };
    }, async (db) => ({
      outcome: await invoke('post', '/api/admin/notices', { account, body: validNoticeDraft }),
      db,
    }));

    assert.equal(outcome.status, 201);
    assert.equal((outcome.body.notice as Record<string, unknown>).is_published, false);
    assert.equal(db.calls.length, 1);
  }
});

test('A-17: Super Admin can publish a notice', async () => {
  const { outcome, db } = await withDatabase((text, values) => {
    if (!text.includes('UPDATE portal_notices')) return undefined;
    assert.equal(values[1], true);
    return {
      rows: [{ id: 'synthetic-notice', is_published: true }],
      rowCount: 1,
    };
  }, async (db) => ({
    outcome: await invoke('patch', '/api/admin/notices/:id', {
      account: 'superA',
      params: { id: 'synthetic-notice' },
      body: { isPublished: true },
    }),
    db,
  }));

  assert.equal(outcome.status, 200);
  assert.equal((outcome.body.notice as Record<string, unknown>).is_published, true);
  assert.equal(db.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 2. Withdrawals: maker-checker (A-03, P3-D2, P3-D3)
// ---------------------------------------------------------------------------

interface WithdrawalRow {
  id: string;
  institute_id: string;
  amount_paise: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  transfer_reference: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

/**
 * Models one withdrawal row with PostgreSQL-like semantics: FOR UPDATE serializes transactions,
 * writes become visible on COMMIT and are discarded on ROLLBACK, and wallet entries enforce the
 * unique withdrawal_id and transfer_reference constraints.
 */
function withdrawalSimulator(initial: WithdrawalRow, options: { activeSuperAdmins?: number; existingTransferReferences?: string[] } = {}) {
  let committed: WithdrawalRow = { ...initial };
  const committedDebits: Array<Record<string, unknown>> = [];
  const transferReferences = new Set(options.existingTransferReferences ?? []);
  let lockTail: Promise<void> = Promise.resolve();
  const transactions = new Map<number, { release?: () => void; row?: WithdrawalRow; debits: Array<Record<string, unknown>> }>();
  const log: string[] = [];

  const finish = (clientId: number, commit: boolean) => {
    const txn = transactions.get(clientId);
    if (!txn) return;
    if (commit) {
      if (txn.row) committed = txn.row;
      committedDebits.push(...txn.debits);
      for (const debit of txn.debits) transferReferences.add(String(debit.transfer_reference));
    }
    txn.release?.();
    transactions.delete(clientId);
  };

  const handler: ScriptedHandler = async (text, values, _via, clientId) => {
    if (text === 'BEGIN') {
      transactions.set(clientId, { debits: [] });
      return undefined;
    }
    if (text === 'COMMIT') {
      log.push(`commit:${clientId}`);
      finish(clientId, true);
      return undefined;
    }
    if (text === 'ROLLBACK') {
      log.push(`rollback:${clientId}`);
      finish(clientId, false);
      return undefined;
    }
    const txn = transactions.get(clientId);
    assert.ok(txn, `query outside a transaction: ${text}`);
    if (text === WITHDRAWAL_SQL.lock) {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      txn.release = release;
      await previous;
      log.push(`locked:${clientId}`);
      return values[0] === committed.id ? { rows: [{ ...committed }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text === WITHDRAWAL_SQL.activeSuperAdmins) {
      return { rows: [{ active_super_admins: options.activeSuperAdmins ?? 2 }], rowCount: 1 };
    }
    if (text === WITHDRAWAL_SQL.insertDebit) {
      const [, , , , transferReference, withdrawalId, createdBy] = values;
      if (transferReferences.has(String(transferReference))
          || committedDebits.some((debit) => debit.withdrawal_id === withdrawalId)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      txn.debits.push({ transfer_reference: transferReference, withdrawal_id: withdrawalId, created_by: createdBy, amount_paise: values[2] });
      return { rows: [], rowCount: 1 };
    }
    if (text === WITHDRAWAL_SQL.markPaid) {
      const current = txn.row ?? committed;
      if (values[0] !== current.id || current.status !== 'approved') return { rows: [], rowCount: 0 };
      txn.row = { ...current, status: 'paid', transfer_reference: String(values[1]) };
      return { rows: [{ id: current.id, status: 'paid', amount_paise: current.amount_paise, transfer_reference: values[1] }], rowCount: 1 };
    }
    if (text === WITHDRAWAL_SQL.review) {
      const current = txn.row ?? committed;
      if (values[0] !== current.id || current.status !== values[3]) return { rows: [], rowCount: 0 };
      txn.row = { ...current, status: values[1] as WithdrawalRow['status'], transfer_reference: null, reviewed_by: String(values[2]), reviewed_at: 'now' };
      return { rows: [{ id: current.id, status: values[1], amount_paise: current.amount_paise, transfer_reference: null }], rowCount: 1 };
    }
    throw new Error(`Unexpected withdrawal SQL: ${text}`);
  };

  return { handler, state: () => committed, debits: () => committedDebits, log };
}

function withdrawal(overrides: Partial<WithdrawalRow> = {}): WithdrawalRow {
  return {
    id: 'withdrawal-1',
    institute_id: 'synthetic-institute',
    amount_paise: '150000',
    status: 'approved',
    transfer_reference: null,
    reviewed_by: ACCOUNTS.superA.row.id as string,
    reviewed_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

const WITHDRAWAL_PATH = '/api/admin/institute-withdrawals/:id';
const pay = (account: AccountName, reference = 'UTR-SYNTHETIC-001') => invoke('patch', WITHDRAWAL_PATH, {
  account, params: { id: 'withdrawal-1' }, body: { status: 'paid', transferReference: reference },
});

test('withdrawals: the approver cannot pay their own approval; no debit is written', async () => {
  const sim = withdrawalSimulator(withdrawal());
  await withDatabase(sim.handler, async (db) => {
    const outcome = await pay('superA');
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.code, 'maker_checker');
    assert.equal(sim.debits().length, 0);
    assert.equal(sim.state().status, 'approved');
    assert.ok(!db.statements().includes(WITHDRAWAL_SQL.insertDebit));
    assert.ok(db.statements().includes('ROLLBACK'));
    assert.ok(!db.statements().includes('COMMIT'));
    assert.equal(db.releases(), 1);
  });
});

test('withdrawals: a different Super Admin pays; the payer is on the debit and the approver is preserved', async () => {
  const sim = withdrawalSimulator(withdrawal());
  await withDatabase(sim.handler, async () => {
    const outcome = await pay('superB');
    assert.equal(outcome.status, 200);
    assert.equal((outcome.body.withdrawal as Record<string, unknown>).status, 'paid');
    assert.equal(sim.debits().length, 1);
    assert.equal(sim.debits()[0].created_by, ACCOUNTS.superB.row.id);
    assert.equal(sim.state().reviewed_by, ACCOUNTS.superA.row.id, 'approver must be preserved');
    assert.equal(sim.state().reviewed_at, '2026-11-01T00:00:00Z', 'approval time must be preserved');
  });
  assert.doesNotMatch(WITHDRAWAL_SQL.markPaid, /reviewed_by|reviewed_at/);
});

test('withdrawals: a legacy approved row keeps its recorded approver for maker-checker', async () => {
  const legacy = withdrawal({ reviewed_by: ACCOUNTS.superB.row.id as string, reviewed_at: '2025-01-01T00:00:00Z' });
  const blocked = withdrawalSimulator(legacy);
  await withDatabase(blocked.handler, async () => {
    const outcome = await pay('superB');
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.code, 'maker_checker');
    assert.equal(blocked.debits().length, 0);
  });
  const allowed = withdrawalSimulator(legacy);
  await withDatabase(allowed.handler, async () => {
    assert.equal((await pay('superA')).status, 200);
    assert.equal(allowed.state().reviewed_by, ACCOUNTS.superB.row.id);
  });
});

test('withdrawals: an approved row with a NULL approver cannot be paid (P3-D2)', async () => {
  const sim = withdrawalSimulator(withdrawal({ reviewed_by: null }));
  await withDatabase(sim.handler, async (db) => {
    const outcome = await pay('superB');
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.code, 'approver_unknown');
    assert.equal(sim.debits().length, 0);
    assert.ok(!db.statements().includes(WITHDRAWAL_SQL.insertDebit));
  });
});

test('withdrawals: payment needs at least two active Super Admins (P3-D3)', async () => {
  assert.equal(MIN_ACTIVE_SUPER_ADMINS_FOR_PAYMENT, 2);
  assert.match(WITHDRAWAL_SQL.activeSuperAdmins, /role = 'official'/);
  assert.match(WITHDRAWAL_SQL.activeSuperAdmins, /is_super_admin = true/);
  assert.match(WITHDRAWAL_SQL.activeSuperAdmins, /account_status = 'approved'/);
  for (const count of [0, 1]) {
    const sim = withdrawalSimulator(withdrawal(), { activeSuperAdmins: count });
    await withDatabase(sim.handler, async () => {
      const outcome = await pay('superB');
      assert.equal(outcome.status, 409);
      assert.equal(outcome.body.code, 'insufficient_super_admins');
      assert.equal(sim.debits().length, 0);
      assert.equal(sim.state().status, 'approved');
    });
  }
});

test('withdrawals: any Super Admin, including the approver, may reject before payment', async () => {
  const sim = withdrawalSimulator(withdrawal());
  await withDatabase(sim.handler, async () => {
    const outcome = await invoke('patch', WITHDRAWAL_PATH, { account: 'superA', params: { id: 'withdrawal-1' }, body: { status: 'rejected' } });
    assert.equal(outcome.status, 200);
    assert.equal(sim.state().status, 'rejected');
    assert.equal(sim.debits().length, 0);
  });
});

test('withdrawals: approving a pending request records the approver', async () => {
  const sim = withdrawalSimulator(withdrawal({ status: 'pending', reviewed_by: null, reviewed_at: null }));
  await withDatabase(sim.handler, async () => {
    const outcome = await invoke('patch', WITHDRAWAL_PATH, { account: 'superA', params: { id: 'withdrawal-1' }, body: { status: 'approved' } });
    assert.equal(outcome.status, 200);
    assert.equal(sim.state().status, 'approved');
    assert.equal(sim.state().reviewed_by, ACCOUNTS.superA.row.id);
  });
});

test('withdrawals: an already paid withdrawal cannot be paid again', async () => {
  const sim = withdrawalSimulator(withdrawal({ status: 'paid', transfer_reference: 'UTR-OLD' }));
  await withDatabase(sim.handler, async (db) => {
    const outcome = await pay('superB', 'UTR-SYNTHETIC-002');
    assert.equal(outcome.status, 409);
    assert.equal(sim.debits().length, 0);
    assert.ok(!db.statements().includes(WITHDRAWAL_SQL.insertDebit));
  });
});

test('withdrawals: a reused transfer reference is refused with 409 and rolled back', async () => {
  const sim = withdrawalSimulator(withdrawal(), { existingTransferReferences: ['UTR-DUPLICATE'] });
  await withDatabase(sim.handler, async (db) => {
    const outcome = await pay('superB', 'UTR-DUPLICATE');
    assert.equal(outcome.status, 409);
    assert.equal(sim.debits().length, 0);
    assert.equal(sim.state().status, 'approved');
    assert.ok(db.statements().includes('ROLLBACK'));
  });
});

test('withdrawals: two concurrent payments produce exactly one debit', async () => {
  const sim = withdrawalSimulator(withdrawal({ reviewed_by: 'synthetic-approver' }));
  await withDatabase(sim.handler, async () => {
    const [first, second] = await Promise.all([pay('superA', 'UTR-CONCURRENT-A'), pay('superB', 'UTR-CONCURRENT-B')]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(sim.debits().length, 1);
    assert.equal(sim.state().status, 'paid');
    // The second transaction acquired the lock only after the first had committed.
    const firstCommit = sim.log.findIndex((entry) => entry.startsWith('commit:'));
    const secondLock = sim.log.findIndex((entry, index) => entry.startsWith('locked:') && index > 0);
    assert.ok(firstCommit !== -1 && secondLock > firstCommit, `lock order: ${sim.log.join(', ')}`);
  });
});

test('withdrawals: ordinary Officials are refused before any connection is opened', async () => {
  await withDatabase(undefined, async (db) => {
    const outcome = await pay('official');
    assert.equal(outcome.status, 403);
    assert.equal(db.connects(), 0);
    assert.equal(protectedCalls(db), 0);
  });
});

test('institute-management returns maker-checker flags without exposing approver identities', async () => {
  let withdrawalSql = '';
  let withdrawalValues: unknown[] = [];
  await withDatabase((text, values) => {
    if (text.includes('FROM institute_withdrawals w')) {
      withdrawalSql = text;
      withdrawalValues = values;
      return { rows: [{ id: 'withdrawal-1', status: 'approved', approver_recorded: true, reviewed_by_current_user: true }], rowCount: 1 };
    }
    return undefined;
  }, async () => {
    const outcome = await invoke('get', '/api/admin/institute-management', { account: 'superA' });
    assert.equal(outcome.status, 200);
    const [row] = outcome.body.withdrawals as Array<Record<string, unknown>>;
    assert.equal(row.reviewed_by_current_user, true);
    assert.equal(row.approver_recorded, true);
  });
  assert.match(withdrawalSql, /\(w\.reviewed_by IS NOT NULL\) AS approver_recorded/);
  assert.match(withdrawalSql, /w\.reviewed_by = \$1/);
  assert.doesNotMatch(withdrawalSql, /w\.reviewed_by,|w\.reviewed_by AS/);
  assert.deepEqual(withdrawalValues, [ACCOUNTS.superA.row.id]);
});

// ---------------------------------------------------------------------------
// Workbooks for import tests
// ---------------------------------------------------------------------------

async function workbook(sheet: string, headers: string[], rows: Array<Record<string, unknown>>): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  addWorkbookSheet(book, sheet, headers, rows);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function scorecard(applicationNumber: string, rollNumber: string) {
  return {
    rollNumber,
    applicationNumber,
    candidateName: 'Synthetic Candidate',
    fatherName: '',
    motherName: '',
    dob: '2005-01-01',
    gender: 'Other',
    category: 'General',
    pwdStatus: false,
    examCode: 'EXAM1',
    examName: 'Synthetic Exam',
    examDate: '2026-11-01',
    centerName: 'Synthetic Center',
    sectionScores: [{ sectionName: 'Section A', maxMarks: 100, marksObtained: 50, percentile: 50 }],
    totalMaxMarks: 100,
    totalMarksObtained: 50,
    aggregatePercentile: 50,
    allIndiaRank: 1,
    categoryRank: 1,
    qualifyingStatus: 'QUALIFIED',
    cutoffMarks: { general: 40, obc: 35, ews: 35, scSt: 30 },
    digitalVerificationCode: 'SYNTHETIC',
    counselingStream: 'Synthetic',
    issueDate: '2026-11-02',
  };
}

const RESULT_HEADERS = ['applicationNumber', 'rollNumber', 'examCode', 'dateOfBirth', 'scorecardJson'];
function resultRow(index: number) {
  const applicationNumber = `APP-000${index}`;
  const rollNumber = `ROLL-00${index}`;
  return { applicationNumber, rollNumber, examCode: 'EXAM1', dateOfBirth: '2005-01-01', scorecardJson: JSON.stringify(scorecard(applicationNumber, rollNumber)) };
}

// ---------------------------------------------------------------------------
// 3. Results: conditional upserts, row counts and atomic rollback (A-04, A-16, P3-D11)
// ---------------------------------------------------------------------------

/**
 * Models published_results keyed by (exam_code, roll_number). The draft-only statement's
 * conflict condition is evaluated against the latest committed row at write time, as
 * PostgreSQL does for ON CONFLICT DO UPDATE ... WHERE on the locked row.
 */
function resultsSimulator(published: Record<string, boolean>, hooks: { beforeUpsert?: (index: number) => void } = {}) {
  const committed = new Map(Object.entries(published).map(([key, isPublished]) => [key, { is_published: isPublished }]));
  let pending = new Map<string, { is_published: boolean }>();
  let upserts = 0;
  const handler: ScriptedHandler = (text, values) => {
    if (text === 'BEGIN') {
      pending = new Map();
      return undefined;
    }
    if (text === 'COMMIT') {
      for (const [key, row] of pending) committed.set(key, row);
      pending = new Map();
      return undefined;
    }
    if (text === 'ROLLBACK') {
      pending = new Map();
      return undefined;
    }
    if (text.includes('FROM applications')) {
      return { rows: [{ id: `application-${String(values[0])}`, assigned_roll_number: null }], rowCount: 1 };
    }
    if (text === RESULT_UPSERT_SQL.draft || text === RESULT_UPSERT_SQL.draftOnlyOverDrafts) {
      hooks.beforeUpsert?.(upserts);
      upserts += 1;
      const key = `${String(values[3])}:${String(values[2])}`;
      const existing = pending.get(key) ?? committed.get(key);
      if (existing && text === RESULT_UPSERT_SQL.draftOnlyOverDrafts && existing.is_published) return { rows: [], rowCount: 0 };
      pending.set(key, { is_published: false });
      return { rows: [{ id: `result-${key}`, roll_number: values[2], exam_code: values[3], is_published: false }], rowCount: 1 };
    }
    throw new Error(`Unexpected results SQL: ${text.slice(0, 80)}`);
  };
  return { handler, committed, upserts: () => upserts };
}

const directResultBody = (index: number) => {
  const row = resultRow(index);
  return { applicationNumber: row.applicationNumber, rollNumber: row.rollNumber, examCode: 'EXAM1', dateOfBirth: '2005-01-01', scorecard: scorecard(row.applicationNumber, row.rollNumber) };
};

test('results: the direct POST always writes a draft, for every Official', async () => {
  for (const account of ['official', 'superA'] as const) {
    const sim = resultsSimulator({});
    await withDatabase(sim.handler, async (db) => {
      const outcome = await invoke('post', '/api/admin/results', { account, body: directResultBody(1) });
      assert.equal(outcome.status, 201, account);
      assert.equal((outcome.body.result as Record<string, unknown>).is_published, false);
      assert.equal(sim.committed.get('EXAM1:ROLL-001')?.is_published ?? false, false);
      assert.ok(db.statements().every((sql) => !/is_published\s*=\s*true|VALUES[^;]*true\)/i.test(sql)), 'must never publish');
    });
  }
  assert.doesNotMatch(RESULT_UPSERT_SQL.draft, /true/);
  assert.doesNotMatch(RESULT_UPSERT_SQL.draftOnlyOverDrafts, /true/);
});

test('results: an ordinary Official cannot overwrite a published result through the direct POST', async () => {
  const sim = resultsSimulator({ 'EXAM1:ROLL-001': true });
  await withDatabase(sim.handler, async (db) => {
    const outcome = await invoke('post', '/api/admin/results', { account: 'official', body: directResultBody(1) });
    assert.equal(outcome.status, 403);
    assert.equal(outcome.body.code, 'published_content_super_admin_only');
    assert.equal(sim.committed.get('EXAM1:ROLL-001')?.is_published, true, 'published row unchanged');
    assert.ok(db.statements().includes(RESULT_UPSERT_SQL.draftOnlyOverDrafts));
  });
});

test('results: a Super Admin correction through the direct POST returns the result to draft', async () => {
  const sim = resultsSimulator({ 'EXAM1:ROLL-001': true });
  await withDatabase(sim.handler, async (db) => {
    const outcome = await invoke('post', '/api/admin/results', { account: 'superA', body: directResultBody(1) });
    assert.equal(outcome.status, 201);
    assert.ok(db.statements().includes(RESULT_UPSERT_SQL.draft));
  });
});

test('results import: one published row makes an ordinary Official import write nothing', async () => {
  const sim = resultsSimulator({ 'EXAM1:ROLL-002': true });
  const body = await workbook('Results', RESULT_HEADERS, [resultRow(1), resultRow(2), resultRow(3)]);
  await withDatabase(sim.handler, async (db) => {
    const outcome = await invoke('post', '/api/admin/results/import', { account: 'official', body });
    assert.equal(outcome.status, 403);
    assert.equal(outcome.body.code, 'published_content_super_admin_only');
    assert.ok(db.statements().includes('ROLLBACK'));
    assert.ok(!db.statements().includes('COMMIT'));
    assert.equal(sim.committed.has('EXAM1:ROLL-001'), false, 'the earlier row in the import was rolled back');
    assert.equal(sim.committed.get('EXAM1:ROLL-002')?.is_published, true);
    assert.equal(sim.upserts(), 2, 'processing stops at the first refused row');
    assert.equal(db.releases(), 1);
  });
});

test('results import: a result published concurrently during the import is never overwritten', async () => {
  // The row is a draft when the import starts; a Super Admin publishes it while the import runs.
  const published: Record<string, boolean> = { 'EXAM1:ROLL-002': false };
  let sim!: ReturnType<typeof resultsSimulator>;
  sim = resultsSimulator(published, {
    beforeUpsert: (index) => {
      if (index === 1) sim.committed.set('EXAM1:ROLL-002', { is_published: true });
    },
  });
  const body = await workbook('Results', RESULT_HEADERS, [resultRow(1), resultRow(2)]);
  await withDatabase(sim.handler, async (db) => {
    const outcome = await invoke('post', '/api/admin/results/import', { account: 'official', body });
    assert.equal(outcome.status, 403);
    assert.ok(db.statements().includes('ROLLBACK'));
    assert.equal(sim.committed.get('EXAM1:ROLL-002')?.is_published, true, 'the concurrent publication survives');
    assert.equal(sim.committed.has('EXAM1:ROLL-001'), false);
  });
  assert.match(RESULT_UPSERT_SQL.draftOnlyOverDrafts, /WHERE published_results\.is_published = false/);
});

test('results import: ordinary Officials import new drafts; Super Admin corrections return to draft', async () => {
  const fresh = resultsSimulator({});
  await withDatabase(fresh.handler, async (db) => {
    const outcome = await invoke('post', '/api/admin/results/import', { account: 'official', body: await workbook('Results', RESULT_HEADERS, [resultRow(1), resultRow(2)]) });
    assert.equal(outcome.status, 201);
    assert.equal(outcome.body.published, false);
    assert.ok(db.statements().includes('COMMIT'));
    assert.equal(fresh.committed.get('EXAM1:ROLL-001')?.is_published, false);
  });
  const correction = resultsSimulator({ 'EXAM1:ROLL-001': true });
  await withDatabase(correction.handler, async () => {
    const outcome = await invoke('post', '/api/admin/results/import', { account: 'superA', body: await workbook('Results', RESULT_HEADERS, [resultRow(1)]) });
    assert.equal(outcome.status, 201);
    assert.equal(correction.committed.get('EXAM1:ROLL-001')?.is_published, false, 'correction returns to draft');
  });
});

test('results import: an unexpected row count rolls back a Super Admin import', async () => {
  await withDatabase((text) => {
    if (text.includes('FROM applications')) return { rows: [{ id: 'application-1', assigned_roll_number: null }], rowCount: 1 };
    if (text === RESULT_UPSERT_SQL.draft) return { rows: [], rowCount: 2 };
    return undefined;
  }, async (db) => {
    const outcome = await invoke('post', '/api/admin/results/import', { account: 'superA', body: await workbook('Results', RESULT_HEADERS, [resultRow(1)]) });
    assert.ok(outcome.error instanceof Error);
    assert.ok(db.statements().includes('ROLLBACK'));
    assert.ok(!db.statements().includes('COMMIT'));
  });
});

// ---------------------------------------------------------------------------
// 4. Answer keys and online exams: lock before checking publication (A-05, A-16, P3-D11)
// ---------------------------------------------------------------------------

const ANSWER_KEY_HEADERS = ['examCode', 'questionNumber', 'subject', 'questionText', 'optionA', 'optionB', 'optionC', 'optionD', 'officialKey', 'explanation'];
const answerKeyRows = (examCode = 'EXAM1') => [1, 2].map((questionNumber) => ({
  examCode, questionNumber, subject: 'Physics', questionText: `Synthetic question ${questionNumber}`,
  optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', officialKey: 'A', explanation: '',
}));

const ONLINE_HEADERS = ['examCode', 'examName', 'durationMinutes', 'questionNumber', 'section', 'questionText', 'optionA', 'optionB', 'optionC', 'optionD', 'correctOption', 'points'];
const onlineRows = () => [1, 2].map((questionNumber) => ({
  examCode: 'EXAM1', examName: 'Synthetic Online Exam', durationMinutes: 30, questionNumber, section: 'Section A',
  questionText: `Synthetic question ${questionNumber}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctOption: 'A', points: 1,
}));

function questionSimulator(
  sql: { lockExam: string; upsert: string; upsertDraftOnly: string },
  table: 'answer_key_questions' | 'online_exam_questions',
  options: { lockedRows?: Array<{ question_number: number; is_published: boolean }>; publishedAtWrite?: boolean; attempts?: boolean } = {},
) {
  const handler: ScriptedHandler = (text) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return undefined;
    if (text.includes('FROM online_exam_attempts')) return options.attempts ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (text === sql.lockExam) return { rows: options.lockedRows ?? [], rowCount: options.lockedRows?.length ?? 0 };
    if (text.startsWith(`UPDATE ${table} SET is_published = false`)) return { rows: [], rowCount: options.lockedRows?.length ?? 0 };
    if (text === sql.upsertDraftOnly) return options.publishedAtWrite ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    if (text === sql.upsert) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected ${table} SQL: ${text.slice(0, 80)}`);
  };
  return handler;
}

const published = [{ question_number: 1, is_published: true }, { question_number: 2, is_published: true }];
const drafts = [{ question_number: 1, is_published: false }];

for (const kind of ['answer-keys', 'online-exams'] as const) {
  const sql = kind === 'answer-keys' ? ANSWER_KEY_IMPORT_SQL : ONLINE_EXAM_IMPORT_SQL;
  const table = kind === 'answer-keys' ? 'answer_key_questions' : 'online_exam_questions';
  const body = () => kind === 'answer-keys'
    ? workbook('AnswerKeys', ANSWER_KEY_HEADERS, answerKeyRows())
    : workbook('OnlineExam', ONLINE_HEADERS, onlineRows());
  const path = `/api/admin/${kind}/import`;

  test(`${kind} import: the exam rows are locked before publication is checked or anything is written`, async () => {
    await withDatabase(questionSimulator(sql, table, { lockedRows: drafts }), async (db) => {
      const outcome = await invoke('post', path, { account: 'official', body: await body() });
      assert.equal(outcome.status, 201);
      const statements = db.statements();
      const lockIndex = statements.indexOf(sql.lockExam);
      assert.ok(lockIndex > statements.indexOf('BEGIN'));
      const firstWrite = statements.findIndex((text) => /^(UPDATE|INSERT)/.test(text.trim()));
      assert.ok(lockIndex < firstWrite, 'lock must precede every write');
      assert.match(sql.lockExam, /FOR UPDATE$/);
      assert.ok(statements.includes(sql.upsertDraftOnly), 'ordinary Officials use the draft-only upsert');
      assert.ok(statements.includes('COMMIT'));
    });
  });

  test(`${kind} import: an ordinary Official import into a published exam is refused and writes nothing`, async () => {
    await withDatabase(questionSimulator(sql, table, { lockedRows: published }), async (db) => {
      const outcome = await invoke('post', path, { account: 'official', body: await body() });
      assert.equal(outcome.status, 403);
      assert.equal(outcome.body.code, 'published_content_super_admin_only');
      assert.ok(db.statements().includes('ROLLBACK'));
      assert.ok(!db.statements().includes('COMMIT'));
      assert.ok(!db.statements().some((text) => /^(UPDATE|INSERT)/.test(text.trim())), 'no write before the refusal');
    });
  });

  test(`${kind} import: the draft-only upsert still refuses if a published row is met at write time`, async () => {
    await withDatabase(questionSimulator(sql, table, { lockedRows: drafts, publishedAtWrite: true }), async (db) => {
      const outcome = await invoke('post', path, { account: 'official', body: await body() });
      assert.equal(outcome.status, 403);
      assert.ok(db.statements().includes('ROLLBACK'));
      assert.ok(!db.statements().includes('COMMIT'));
    });
    assert.match(sql.upsertDraftOnly, new RegExp(`WHERE ${table}\\.is_published = false$`));
  });

  test(`${kind} import: a Super Admin correction returns the published exam to draft`, async () => {
    await withDatabase(questionSimulator(sql, table, { lockedRows: published }), async (db) => {
      const outcome = await invoke('post', path, { account: 'superA', body: await body() });
      assert.equal(outcome.status, 201);
      const statements = db.statements();
      assert.ok(statements.indexOf(sql.lockExam) < statements.findIndex((text) => text.startsWith(`UPDATE ${table} SET is_published = false`)));
      assert.ok(statements.includes(sql.upsert));
      assert.ok(!statements.includes(sql.upsertDraftOnly));
      assert.ok(statements.includes('COMMIT'));
    });
  });
}

test('online-exams import: the P0-4 attempts guard stays first and applies to every Official', async () => {
  for (const account of ['official', 'superA'] as const) {
    await withDatabase(questionSimulator(ONLINE_EXAM_IMPORT_SQL, 'online_exam_questions', { attempts: true, lockedRows: published }), async (db) => {
      const outcome = await invoke('post', '/api/admin/online-exams/import', { account, body: await workbook('OnlineExam', ONLINE_HEADERS, onlineRows()) });
      assert.equal(outcome.status, 409, account);
      const statements = db.statements();
      assert.equal(statements[0], 'BEGIN');
      assert.match(statements[1], /FROM online_exam_attempts/);
      assert.ok(!statements.includes(ONLINE_EXAM_IMPORT_SQL.lockExam), 'attempts guard runs before the publication lock');
      assert.ok(statements.includes('ROLLBACK'));
    });
  }
});

test('answer-keys import: several exams are locked in a fixed order', async () => {
  const rows = [...answerKeyRows('EXAMB'), ...answerKeyRows('EXAMA')];
  const lockedCodes: unknown[] = [];
  await withDatabase((text, values) => {
    if (text === ANSWER_KEY_IMPORT_SQL.lockExam) lockedCodes.push(values[0]);
    if (text === ANSWER_KEY_IMPORT_SQL.upsertDraftOnly) return { rows: [], rowCount: 1 };
    return undefined;
  }, async () => {
    const outcome = await invoke('post', '/api/admin/answer-keys/import', { account: 'official', body: await workbook('AnswerKeys', ANSWER_KEY_HEADERS, rows) });
    assert.equal(outcome.status, 201);
  });
  assert.deepEqual(lockedCodes, ['EXAMA', 'EXAMB']);
});

// ---------------------------------------------------------------------------
// 5. Helpdesk count (A-14, P3-D4) and published-only public routes
// ---------------------------------------------------------------------------

test('dashboard stats: ordinary Officials get no helpdesk count and the feedback table is not read', async () => {
  let sql = '';
  await withDatabase((text) => {
    sql = text;
    return { rows: [{ applications: '3', open_helpdesk: null, mock_exam_attempts: '4', published_results: '5' }], rowCount: 1 };
  }, async () => {
    const outcome = await invoke('get', '/api/admin/dashboard-stats', { account: 'official' });
    assert.equal(outcome.status, 200);
    assert.equal((outcome.body.stats as Record<string, unknown>).openHelpdesk, null);
  });
  assert.doesNotMatch(sql, /feedback/i);
});

test('dashboard stats: Super Admins get the open helpdesk count', async () => {
  let sql = '';
  await withDatabase((text) => {
    sql = text;
    return { rows: [{ applications: '3', open_helpdesk: '7', mock_exam_attempts: '4', published_results: '5' }], rowCount: 1 };
  }, async () => {
    const outcome = await invoke('get', '/api/admin/dashboard-stats', { account: 'superA' });
    assert.equal((outcome.body.stats as Record<string, unknown>).openHelpdesk, 7);
  });
  assert.match(sql, /FROM feedback WHERE status <> 'resolved'/);
});

test('candidate answer-key routes still return published keys only', async () => {
  const seen: string[] = [];
  await withDatabase((text) => {
    seen.push(text);
    return { rows: [], rowCount: 0 };
  }, async () => {
    assert.equal((await invoke('get', '/api/answer-keys/exams', { account: 'candidate' })).status, 200);
  });
  assert.ok(seen.length > 0 && seen.every((text) => /is_published = true/.test(text)));
});

test('answer-key routes reject unauthenticated and non-candidate requests before any business query', async () => {
  for (const path of ['/api/answer-keys/exams', '/api/answer-keys']) {
    await withDatabase(undefined, async (db) => {
      const unauthenticated = await invoke('get', path, { surface: 'exam' });
      assert.equal(unauthenticated.status, 401, `${path} unauthenticated`);
      // Officials and institutions on their own surfaces reach the role guard and are refused.
      for (const account of ['official', 'superA', 'center'] as const) {
        assert.equal((await invoke('get', path, { account })).status, 403, `${path} as ${account}`);
      }
      assert.equal(db.calls.length, 0, `${path}: no business query before the guards pass`);
    });
  }
});
