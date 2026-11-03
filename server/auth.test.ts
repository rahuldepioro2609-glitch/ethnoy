import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
const {
  optionalAuth,
  registrationPasswordSchema,
  requireAuth,
  requireRoles,
  requireSuperAdmin,
  requireTrustedMutationOrigin,
} = await import('./auth.js');

test('registration passwords are capped at bcrypt’s 72 UTF-8 byte limit', () => {
  assert.equal(registrationPasswordSchema.safeParse('a'.repeat(72)).success, true);
  assert.equal(registrationPasswordSchema.safeParse('a'.repeat(73)).success, false);
  assert.equal(registrationPasswordSchema.safeParse('😀'.repeat(18)).success, true);
  assert.equal(registrationPasswordSchema.safeParse('😀'.repeat(19)).success, false);
});

function checkMutationOrigin(
  origin: string | undefined,
  cookie: string | undefined,
  configuredOrigin = 'https://portal.example',
) {
  process.env.APP_ORIGIN = configuredOrigin;
  const state: { status?: number; body?: { error: string } } = {};
  const response = {
    status(status: number) {
      state.status = status;
      return this;
    },
    json(body: { error: string }) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  let nextCalled = false;
  const request = {
    method: 'POST',
    headers: {
      ...(origin === undefined ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    get(name: string) {
      return name.toLowerCase() === 'origin' ? origin : undefined;
    },
  } as unknown as AuthenticatedRequest;

  requireTrustedMutationOrigin(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);
  return { ...state, nextCalled };
}

test('mutation origin guard accepts the configured trusted origin', () => {
  const result = checkMutationOrigin('https://portal.example', 'elt_session=token');

  assert.equal(result.nextCalled, true);
  assert.equal(result.status, undefined);
});

test('mutation origin guard rejects an untrusted origin', () => {
  const result = checkMutationOrigin('https://attacker.example', 'elt_session=token');

  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 403);
  assert.equal(result.body?.error, 'Request origin is not allowed.');
});

test('mutation origin guard permits missing Origin only without a session cookie', () => {
  const anonymousResult = checkMutationOrigin(undefined, undefined);
  const sessionResult = checkMutationOrigin(undefined, 'elt_session=token');

  assert.equal(anonymousResult.nextCalled, true);
  assert.equal(anonymousResult.status, undefined);
  assert.equal(sessionResult.nextCalled, false);
  assert.equal(sessionResult.status, 403);
});

test('mutation origin guard rejects malformed or non-origin Origin values', () => {
  for (const origin of ['null', 'https://portal.example/path', 'not an origin']) {
    const result = checkMutationOrigin(origin, 'elt_session=token');

    assert.equal(result.nextCalled, false, `${origin} must be rejected`);
    assert.equal(result.status, 403, `${origin} must be rejected`);
  }
});

test('mutation origin guard rejects a malformed configured APP_ORIGIN', () => {
  const result = checkMutationOrigin('https://portal.example', 'elt_session=token', 'not an origin');

  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 403);
});

test('optional authentication permits requests without a session cookie', () => {
  let nextCalled = false;
  const request = { headers: {} } as AuthenticatedRequest;
  const response = {} as Response;
  const next = (() => {
    nextCalled = true;
  }) as NextFunction;

  optionalAuth(request, response, next);

  assert.equal(nextCalled, true);
});

test('required authentication rejects requests without a session cookie', async () => {
  const responseState: { status?: number; body?: { error: string } } = {};
  const response = {
    status(status: number) {
      responseState.status = status;
      return this;
    },
    json(body: { error: string }) {
      responseState.body = body;
      return this;
    },
  } as unknown as Response;
  const request = { headers: {} } as AuthenticatedRequest;
  let nextCalled = false;

  await requireAuth(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(responseState.status, 401);
  assert.equal(responseState.body?.error, 'Sign in is required.');
  assert.equal(nextCalled, false);
});

test('optional authentication rejects a malformed session cookie', async () => {
  const responseState: { status?: number; body?: { error: string } } = {};
  const response = {
    status(status: number) {
      responseState.status = status;
      return this;
    },
    json(body: { error: string }) {
      responseState.body = body;
      return this;
    },
  } as unknown as Response;
  const request = { headers: { cookie: 'elt_session=short' } } as AuthenticatedRequest;
  let nextCalled = false;
  const next = (() => {
    nextCalled = true;
  }) as NextFunction;

  optionalAuth(request, response, next);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(responseState.status, 401);
  assert.equal(responseState.body?.error, 'Sign in is required.');
  assert.equal(nextCalled, false);
});

test('role guard denies cross-role access with HTTP 403', () => {
  for (const [actualRole, requiredRole] of [
    ['candidate', 'official'],
    ['candidate', 'center'],
    ['center', 'official'],
    ['center', 'candidate'],
    ['official', 'candidate'],
    ['official', 'center'],
  ] as const) {
    const responseState: { status?: number; body?: { error: string } } = {};
    const response = {
      status(status: number) {
        responseState.status = status;
        return this;
      },
      json(body: { error: string }) {
        responseState.body = body;
        return this;
      },
    } as unknown as Response;
    let nextCalled = false;
    const request = {
      headers: {},
      user: { id: 'user-id', loginId: 'LOGIN', name: 'Test', role: actualRole },
    } as AuthenticatedRequest;

    requireRoles(requiredRole)(request, response, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(responseState.status, 403, `${actualRole} must not access ${requiredRole} routes`);
    assert.equal(responseState.body?.error, 'You do not have permission to perform this action.');
    assert.equal(nextCalled, false);
  }
});

test('super-admin guard allows only explicitly authorized officials', () => {
  for (const [role, isSuperAdmin, expectedStatus, expectedNext] of [
    ['official', true, undefined, true],
    ['official', false, 403, false],
    ['candidate', true, 403, false],
  ] as const) {
    const responseState: { status?: number; body?: { error: string } } = {};
    const response = {
      status(status: number) {
        responseState.status = status;
        return this;
      },
      json(body: { error: string }) {
        responseState.body = body;
        return this;
      },
    } as unknown as Response;
    let nextCalled = false;
    const request = {
      headers: {},
      user: {
        id: 'user-id',
        loginId: 'LOGIN',
        name: 'Test',
        role,
        isSuperAdmin,
      },
    } as AuthenticatedRequest;

    requireSuperAdmin(request, response, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(responseState.status, expectedStatus);
    assert.equal(nextCalled, expectedNext);
    if (expectedStatus === 403) {
      assert.equal(responseState.body?.error, 'You do not have permission to perform this action.');
    }
  }
});
