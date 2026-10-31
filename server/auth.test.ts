import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
const { optionalAuth } = await import('./auth.js');

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
