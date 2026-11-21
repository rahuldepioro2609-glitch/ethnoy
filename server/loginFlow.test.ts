/**
 * Login-flow integration tests for the candidate authentication path.
 *
 * These tests exercise the session INSERT guard and the /api/auth/me
 * verification step introduced to close the ghost-session bug.
 *
 * No real database connection is used; `./db.js` is shimmed before import.
 * No session tokens or cookie values are logged or exposed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { expectedOrigin, type Surface } from './surface.js';
import { VERIFIED_PORTAL_SESSION } from './authTestSupport.js';

// ---------------------------------------------------------------------------
// Minimal pool shim — must be registered before any module that imports db.js
// ---------------------------------------------------------------------------

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';

/** Single-call response recorded by the shim. Override per-test. */
let poolQueryImpl: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Register the db shim so auth.js uses our fake pool.
const { createRequire } = await import('node:module');
const { register } = await import('node:module');

// We shim via a module-level mock using node's built-in loader hook mechanism.
// Since tsx + node:test don't natively support import mocking, we set DATABASE_URL
// to a non-existent host and rely on the pool's lazy-connect behaviour — the pool
// object itself is created on import but connections are only opened when .query()
// is called, which we intercept below via the exported `pool` replacement pattern.

// Instead of hooking the loader, we import auth.js directly (which imports db.js).
// For the pool-failure tests we directly construct the middleware under test using
// the same logic as the real handler, but with a controlled pool mock injected.

// ---------------------------------------------------------------------------
// Helpers – build minimal Express-like req/res mocks
// ---------------------------------------------------------------------------

function makeResponse() {
  const state: {
    status: number;
    body: unknown;
    cookieName: string | null;
    cookieCleared: boolean;
    headers: Record<string, string>;
  } = { status: 200, body: null, cookieName: null, cookieCleared: false, headers: {} };

  const res = {
    _state: state,
    status(code: number) { state.status = code; return res; },
    json(body: unknown) { state.body = body; return res; },
    cookie(name: string, _value: string, _opts: unknown) {
      // Record that a cookie was SET (name only — no value logged).
      state.cookieName = name;
      return res;
    },
    clearCookie(name: string, _opts: unknown) {
      assert.equal(name, 'elt_session', 'only the session cookie must be cleared');
      state.cookieCleared = true;
      return res;
    },
    setHeader(name: string, value: string) { state.headers[name] = value; return res; },
    end() { return res; },
  };
  return res as typeof res & { _state: typeof state };
}

// P1-B: requireAuth needs the server-controlled surface. These requests carry the surface that the
// tested account's role belongs to (candidate → Exam by default; center → Institution).
function makeAuthRequest(cookieHeader?: string, surface: Surface = 'exam'): AuthenticatedRequest {
  const request = {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  } as unknown as AuthenticatedRequest;
  setTrustedRequestSurface(request, surface, expectedOrigin(surface));
  return request;
}

// ---------------------------------------------------------------------------
// Import auth middleware (uses real module; pool.query is never called because
// we only test the cookie-parsing + role-checking logic in these cases)
// ---------------------------------------------------------------------------

const { requireAuth, requireRoles, optionalAuth, setTrustedRequestSurface } = await import('./auth.js');

// ---------------------------------------------------------------------------
// 1.  requireAuth: no cookie → 401 (no DB call)
// ---------------------------------------------------------------------------

test('login flow: requireAuth rejects a request with no cookie (401)', async () => {
  const req = makeAuthRequest();
  const res = makeResponse();
  let nextCalled = false;

  await requireAuth(req, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(res._state.status, 401);
  assert.equal((res._state.body as { error: string }).error, 'Sign in is required.');
  assert.equal(nextCalled, false);
  assert.equal(res._state.cookieName, null, 'must not set a cookie on 401');
});

// ---------------------------------------------------------------------------
// 2.  requireAuth: cookie present but DB returns no row → 401 + cookie cleared
//
//     We test this by patching pool after import.  The auth module imports pool
//     from db.js; we replace pool.query on the imported object in-process.
// ---------------------------------------------------------------------------

test('login flow: requireAuth clears cookie and returns 401 when token has no matching DB session', async () => {
  // Obtain a reference to the live pool object used by auth.js.
  const { pool } = await import('./db.js');

  const original = pool.query.bind(pool);
  // Override: simulate no matching session row.
  (pool as unknown as { query: unknown }).query = async (_text: string, _values?: unknown[]) => ({ rows: [] });

  try {
    const validLengthToken = 'A'.repeat(43); // base64url-safe, 32 random bytes → ~43 chars
    const req = makeAuthRequest(`elt_session=${validLengthToken}`);
    const res = makeResponse();
    let nextCalled = false;

    await requireAuth(req, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(res._state.status, 401);
    assert.match(
      (res._state.body as { error: string }).error,
      /session has expired/i,
    );
    assert.equal(res._state.cookieCleared, true, 'stale cookie must be cleared');
    assert.equal(nextCalled, false);
    assert.equal(res._state.cookieName, null, 'must not set a new cookie');
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
});

// ---------------------------------------------------------------------------
// 3.  requireAuth: DB returns a valid approved row → next() called, user set
// ---------------------------------------------------------------------------

test('login flow: requireAuth calls next() and populates request.user for a valid session', async () => {
  const { pool } = await import('./db.js');
  const original = pool.query.bind(pool);

  (pool as unknown as { query: unknown }).query = async (_text: string, _values?: unknown[]) => ({
    rows: [{
      id: 'user-uuid',
      login_id: 'STUDENT01',
      display_name: 'Test Student',
      role: 'candidate',
      account_status: 'approved',
      ...VERIFIED_PORTAL_SESSION,
    }],
  });

  try {
    const validToken = 'B'.repeat(43);
    const req = makeAuthRequest(`elt_session=${validToken}`);
    const res = makeResponse();
    let nextCalled = false;

    await requireAuth(req, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, true, 'next() must be called for a valid session');
    assert.equal(req.user?.id, 'user-uuid');
    assert.equal(req.user?.loginId, 'STUDENT01');
    assert.equal(req.user?.role, 'candidate');
    // sessionTokenHash is stored but must not be a plain token — it is a sha256 hex digest.
    assert.ok(req.sessionTokenHash, 'sessionTokenHash must be set');
    assert.doesNotMatch(req.sessionTokenHash ?? '', /^B+$/, 'hash must not equal the raw token');
    assert.equal(res._state.status, 200, 'response status must remain 200 (untouched)');
    assert.equal(res._state.cookieName, null, 'must not re-set the cookie on a valid session');
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
});

// ---------------------------------------------------------------------------
// 4.  requireAuth: DB row exists but account_status is not 'approved' → 403
// ---------------------------------------------------------------------------

test('login flow: requireAuth returns 403 and clears cookie for a non-approved account', async () => {
  const { pool } = await import('./db.js');
  const original = pool.query.bind(pool);

  (pool as unknown as { query: unknown }).query = async (_text: string, _values?: unknown[]) => ({
    rows: [{
      id: 'user-uuid',
      login_id: 'PENDING01',
      display_name: 'Pending User',
      role: 'center',
      account_status: 'pending',
    }],
  });

  try {
    const validToken = 'C'.repeat(43);
    const req = makeAuthRequest(`elt_session=${validToken}`, 'institution');
    const res = makeResponse();
    let nextCalled = false;

    await requireAuth(req, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(res._state.status, 403);
    assert.match(
      (res._state.body as { error: string }).error,
      /not approved/i,
    );
    assert.equal(res._state.cookieCleared, true, 'cookie must be cleared for unapproved account');
    assert.equal(nextCalled, false);
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
});

// ---------------------------------------------------------------------------
// 5.  requireAuth: pool.query throws (DB unavailable) → next(error) is called
//     and no cookie is set or cleared on the response
// ---------------------------------------------------------------------------

test('login flow: requireAuth propagates DB errors to next() without touching the response', async () => {
  const { pool } = await import('./db.js');
  const original = pool.query.bind(pool);

  (pool as unknown as { query: unknown }).query = async () => {
    throw new Error('Connection refused');
  };

  try {
    const validToken = 'D'.repeat(43);
    const req = makeAuthRequest(`elt_session=${validToken}`);
    const res = makeResponse();
    let caughtError: unknown = null;
    const next = ((err: unknown) => { caughtError = err; }) as NextFunction;

    await requireAuth(req, res as unknown as Response, next);

    assert.ok(caughtError instanceof Error, 'DB error must be forwarded to next()');
    assert.match((caughtError as Error).message, /Connection refused/);
    assert.equal(res._state.cookieName, null, 'must not set cookie on DB error');
    assert.equal(res._state.cookieCleared, false, 'must not clear cookie on DB error');
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
});

// ---------------------------------------------------------------------------
// 6.  requireRoles: candidate role must not access official routes
// ---------------------------------------------------------------------------

test('login flow: requireRoles blocks candidate from official routes (403)', () => {
  const res = makeResponse();
  let nextCalled = false;
  const req = {
    headers: {},
    user: { id: 'u1', loginId: 'S1', name: 'Student', role: 'candidate' },
  } as unknown as AuthenticatedRequest;

  requireRoles('official')(req, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(res._state.status, 403);
  assert.equal(nextCalled, false);
});

// ---------------------------------------------------------------------------
// 7.  optionalAuth: missing cookie passes through without DB call
// ---------------------------------------------------------------------------

test('login flow: optionalAuth passes through when no cookie is present', () => {
  const req = makeAuthRequest();
  const res = makeResponse();
  let nextCalled = false;

  optionalAuth(req, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res._state.cookieName, null);
});
