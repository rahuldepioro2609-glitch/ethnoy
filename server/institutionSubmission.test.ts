import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  createInstitutionSubmissionRouter,
  createSubmissionCycle,
  INSTITUTION_SUBMISSION_COOKIE,
  issueSubmissionCapability,
  requireCapabilityMutationOrigin,
  requireInstitutionSubmissionCapability,
  setInstitutionSubmissionCookie,
} from './institutionSubmission.js';
import { hashSessionToken } from './auth.js';
import { pool } from './db.js';
import { INSTITUTION_DOCUMENT_CATEGORIES } from '../src/utils/institutionDocuments.js';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
}

function routeHandlers(
  router: ReturnType<typeof createInstitutionSubmissionRouter>,
  method: 'get' | 'post',
  path: string,
): RequestHandler[] {
  const layer = (router as unknown as { stack: RouteLayer[] }).stack
    .map((item) => item.route)
    .find((route) => route?.path === path && route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
  return layer.stack.map((item) => item.handle);
}

function invoke(
  handlers: RequestHandler[],
  options: {
    method: string;
    path: string;
    token?: string;
    sessionToken?: string;
    origin?: string;
    body?: unknown;
  },
): Promise<{ status: number; body: unknown; headers: Record<string, string>; ended: boolean }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    let ended = false;
    const headers: Record<string, string> = {};
    const request = {
      headers: {
        ...(options.token ? { cookie: `${INSTITUTION_SUBMISSION_COOKIE}=${options.token}` } : {}),
        ...(options.sessionToken ? { cookie: `elt_session=${options.sessionToken}` } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      },
      method: options.method,
      path: options.path,
      url: options.path,
      body: options.body ?? {},
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      app: { get: () => false },
      get(name: string) {
        return name.toLowerCase() === 'origin' ? options.origin : undefined;
      },
    } as unknown as Request;
    const response = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      set(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      append(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      json(body: unknown) {
        if (!settled) {
          settled = true;
          resolve({ status, body, headers, ended });
        }
        return this;
      },
      end() {
        ended = true;
        if (!settled) {
          settled = true;
          resolve({ status, body: undefined, headers, ended });
        }
        return this;
      },
      clearCookie() {
        return this;
      },
      getHeader() {
        return undefined;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    } as unknown as Response;

    const next: NextFunction = (error?: unknown) => {
      if (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }
      const handler = handlers[handlerIndex++];
      if (!handler) return;
      try {
        const result = (handler as unknown as (
          request: Request,
          response: Response,
          next: NextFunction,
        ) => unknown)(request, response, next);
        if (result instanceof Promise) void result.catch(next);
      } catch (error) {
        next(error);
      }
    };
    next();
  });
}

test('submission capabilities store only SHA-256 hashes and issue a narrowly scoped cookie', async () => {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      return { rows: [] };
    },
  };
  const cycleId = await createSubmissionCycle(client, {
    institutionId: 'institution-a',
    submissionVersion: 1,
    sourceType: 'initial_registration',
  });
  const issue = await issueSubmissionCapability(client, 'institution-a', cycleId);

  assert.match(issue.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issue.maxAgeSeconds, 1800);
  const insert = statements.find(({ text }) => text.includes('INSERT INTO institution_submission_capabilities'));
  assert.ok(insert);
  const storedHash = String(insert.values?.[3]);
  assert.equal(storedHash, createHash('sha256').update(issue.token).digest('hex'));
  assert.match(storedHash, /^[0-9a-f]{64}$/);
  assert.ok(!insert.values?.includes(issue.token));

  const headers: Record<string, string> = {};
  const response = {
    append(name: string, value: string) { headers[name] = value; return this; },
    set(name: string, value: string) { headers[name] = value; return this; },
  } as unknown as Response;
  setInstitutionSubmissionCookie(response, issue);
  assert.match(headers['Set-Cookie'], /Path=\/api\/institution-document-submission/);
  assert.match(headers['Set-Cookie'], /HttpOnly; SameSite=Strict/);
  assert.match(headers['Set-Cookie'], /Max-Age=1800/);
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('unauthenticated or ineligible access cannot pass the capability middleware', async () => {
  let queryCount = 0;
  const router = createInstitutionSubmissionRouter({
    async query() {
      queryCount += 1;
      return { rows: [] };
    },
    async connect() {
      throw new Error('No database transaction expected.');
    },
  });
  const unauthenticated = await invoke(routeHandlers(router, 'get', '/status'), {
    method: 'GET',
    path: '/status',
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(queryCount, 0);

  const invalid = await invoke(routeHandlers(router, 'get', '/status'), {
    method: 'GET',
    path: '/status',
    token: 'A'.repeat(43),
  });
  assert.equal(invalid.status, 401);
  assert.equal(queryCount, 1);
});

test('capability access is pending-institution and current-cycle scoped', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const token = 'B'.repeat(43);
  const router = createInstitutionSubmissionRouter({
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('SELECT c.institution_id')) {
        return {
          rows: [{
            institution_id: 'institution-a',
            submission_cycle_id: 'cycle-a',
            submission_version: 2,
            source_type: 'resubmission',
            expires_at: '2026-11-01T10:30:00.000Z',
          }],
        };
      }
      if (text.includes('unnest($2::text[])')) {
        return {
          rows: INSTITUTION_DOCUMENT_CATEGORIES.map((category) => ({
            category,
            document_count: 0,
          })),
        };
      }
      return { rows: [] };
    },
    async connect() {
      throw new Error('No database transaction expected.');
    },
  });
  const result = await invoke(routeHandlers(router, 'get', '/status'), {
    method: 'GET',
    path: '/status',
    token,
  });
  assert.equal(result.status, 200);
  const capabilityQuery = queries[0];
  assert.ok(capabilityQuery.text.includes("u.role = 'center'"));
  assert.ok(capabilityQuery.text.includes("u.account_status = 'pending'"));
  assert.ok(capabilityQuery.text.includes("c.revoked_at IS NULL"));
  assert.ok(capabilityQuery.text.includes('c.expires_at > now()'));
  assert.ok(capabilityQuery.text.includes('MAX(current_cycle.submission_version)'));
  assert.equal(capabilityQuery.values?.[0], createHash('sha256').update(token).digest('hex'));
  assert.deepEqual(queries[1].values, ['cycle-a', INSTITUTION_DOCUMENT_CATEGORIES, 'institution-a']);
  assert.deepEqual((result.body as { categories: Array<{ name: string }> }).categories.map((item) => item.name), INSTITUTION_DOCUMENT_CATEGORIES);
  assert.equal((result.body as { uploadEnabled: boolean }).uploadEnabled, false);
  assert.equal((result.body as { completenessPolicyEnabled: boolean }).completenessPolicyEnabled, false);
});

test('document-list queries are bound to the capability institution and cycle', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const router = createInstitutionSubmissionRouter({
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('SELECT c.institution_id')) {
        return {
          rows: [{
            institution_id: 'institution-a',
            submission_cycle_id: 'cycle-a',
            submission_version: 1,
            source_type: 'initial_registration',
            expires_at: '2026-11-01T10:30:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
    async connect() {
      throw new Error('No database transaction expected.');
    },
  });
  const result = await invoke(routeHandlers(router, 'get', '/documents'), {
    method: 'GET',
    path: '/documents',
    token: 'C'.repeat(43),
  });
  assert.equal(result.status, 200);
  const listing = queries[1];
  assert.match(listing.text, /WHERE d\.institution_id = \$1 AND d\.submission_cycle_id = \$2/);
  assert.deepEqual(listing.values, ['institution-a', 'cycle-a']);
});

test('capability uploads remain disabled and make no document writes', async () => {
  const statements: string[] = [];
  const router = createInstitutionSubmissionRouter({
    async query(text) {
      statements.push(text);
      if (text.includes('SELECT c.institution_id')) {
        return {
          rows: [{
            institution_id: 'institution-a',
            submission_cycle_id: 'cycle-a',
            submission_version: 1,
            source_type: 'initial_registration',
            expires_at: '2026-11-01T10:30:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
    async connect() {
      throw new Error('Disabled upload must not open a database transaction.');
    },
  });
  const result = await invoke(routeHandlers(router, 'post', '/documents'), {
    method: 'POST',
    path: '/documents',
    token: 'D'.repeat(43),
  });
  assert.equal(result.status, 503);
  assert.match(JSON.stringify(result.body), /not enabled/i);
  assert.ok(!statements.some((statement) => statement.includes('INSERT INTO institution_documents')));
  assert.ok(!statements.some((statement) => statement.includes('INSERT INTO institution_document_versions')));
});

test('a pending institution can explicitly revoke its capability', async () => {
  const token = 'E'.repeat(43);
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const router = createInstitutionSubmissionRouter({
    async query(text, values) {
      statements.push({ text, values });
      if (text.includes('SELECT c.institution_id')) {
        return {
          rows: [{
            institution_id: 'institution-a',
            submission_cycle_id: 'cycle-a',
            submission_version: 1,
            source_type: 'initial_registration',
            expires_at: '2026-11-01T10:30:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
    async connect() {
      throw new Error('No transaction expected.');
    },
  });
  const previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://portal.example.test';
  try {
    const result = await invoke([
      requireCapabilityMutationOrigin,
      ...routeHandlers(router, 'post', '/revoke'),
    ], {
      method: 'POST',
      path: '/revoke',
      token,
      origin: 'https://portal.example.test',
    });
    assert.equal(result.status, 204);
    assert.equal(result.ended, true);
    assert.match(result.headers['Set-Cookie'], /Max-Age=0/);
    const revokeQuery = statements.find(({ text }) => text.includes('SET revoked_at'));
    assert.ok(revokeQuery);
    assert.deepEqual(revokeQuery.values, [createHash('sha256').update(token).digest('hex')]);
  } finally {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
  }
});

test('middleware implementation requires an opaque capability cookie rather than request parameters', async () => {
  let queries = 0;
  const middleware = requireInstitutionSubmissionCapability({
    async query() {
      queries += 1;
      return { rows: [] };
    },
  });
  const result = await invoke([middleware], {
    method: 'GET',
    path: '/status',
    token: 'invalid',
  });
  assert.equal(result.status, 401);
  assert.equal(queries, 0);
});

test('capability mutations require an exact configured Origin', async () => {
  const previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://portal.example.test';
  try {
    const invokeOrigin = (origin?: string) => new Promise<number>((resolve) => {
      const request = {
        method: 'POST',
        get: () => origin,
      } as unknown as Request;
      const response = {
        status(code: number) {
          resolve(code);
          return this;
        },
        json() { return this; },
      } as unknown as Response;
      requireCapabilityMutationOrigin(request, response, () => resolve(204));
    });
    assert.equal(await invokeOrigin(), 403);
    assert.equal(await invokeOrigin('https://attacker.example.test'), 403);
    assert.equal(await invokeOrigin('https://portal.example.test'), 204);
  } finally {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
  }
});

test('pending credentials can reissue a hash-only capability without creating a session', async () => {
  const passwordHash = await (await import('bcryptjs')).default.hash('Existing synthetic password', 4);
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const router = createInstitutionSubmissionRouter({
    async query(text, values) {
      statements.push({ text, values });
      if (text.includes('SELECT id, password_hash FROM users')) {
        return { rows: [{ id: 'institution-a', password_hash: passwordHash }] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          statements.push({ text, values });
          if (text.includes('SELECT id, account_status FROM users')) {
            return { rows: [{ id: 'institution-a', account_status: 'pending' }] };
          }
          if (text.includes('SELECT id FROM institution_submission_cycles')) return { rows: [] };
          if (text.includes('MAX(submission_version)')) return { rows: [{ next_version: 1 }] };
          return { rows: [] };
        },
        release() {},
      } as never;
    },
  });
  const response = await invoke(routeHandlers(router, 'post', '/reissue').slice(1), {
    method: 'POST',
    path: '/reissue',
    body: { loginId: 'SYNTHETIC-INSTITUTE', password: 'Existing synthetic password' },
  });
  assert.equal(response.status, 202);
  assert.match(response.headers['Set-Cookie'], /HttpOnly; SameSite=Strict/);
  const capabilityInsert = statements.find(({ text }) => text.includes('INSERT INTO institution_submission_capabilities'));
  assert.ok(capabilityInsert);
  assert.match(String(capabilityInsert.values?.[3]), /^[0-9a-f]{64}$/);
  assert.ok(!statements.some(({ text }) => text.includes('auth_sessions')));
  assert.ok(!JSON.stringify(response.body).includes(response.headers['Set-Cookie'].split(';')[0].split('=').slice(1).join('=')));
});

test('registration creates a submission cycle and capability in its transaction without a normal session', async () => {
  const [{ app }] = await Promise.all([import('./index.js')]);
  const applicationRoute = (app as unknown as { _router: { stack: Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> };
  }> } })._router.stack
    .map((item) => item.route)
    .find((route) => route?.path === '/api/center/register' && route.methods.post);
  assert.ok(applicationRoute);
  const originalConnect = (pool as unknown as { connect: () => Promise<unknown> }).connect;
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      if (text.includes('INSERT INTO users')) return { rows: [{ id: 'new-institution' }] };
      return { rows: [] };
    },
    release() {},
  });
  try {
    const response = await invoke(applicationRoute.stack.slice(1).map(({ handle }) => handle), {
      method: 'POST',
      path: '/api/center/register',
      body: {
        loginId: 'NEW-INSTITUTE',
        name: 'Synthetic New Institute',
        password: 'Synthetic-new-password-2026',
        contactEmail: 'new@example.test',
        registrationNumber: 'NEW-REG-123',
        registeredAddress: '123 Synthetic Street, Example District',
        website: '',
      },
    });
    assert.equal(response.status, 201);
    assert.match(response.headers['Set-Cookie'], /elt_institution_submission=/);
    assert.match(response.headers['Set-Cookie'], /Path=\/api\/institution-document-submission/);
    assert.ok(statements.some(({ text, values }) => text.includes('INSERT INTO institution_submission_cycles')
      && values?.[3] === 'initial_registration'));
    const capabilityInsert = statements.find(({ text }) => text.includes('INSERT INTO institution_submission_capabilities'));
    assert.ok(capabilityInsert);
    assert.match(String(capabilityInsert.values?.[3]), /^[0-9a-f]{64}$/);
    assert.ok(!statements.some(({ text }) => text.includes('auth_sessions')));
    assert.ok(!JSON.stringify(response.body).includes(String(capabilityInsert.values?.[3])));
  } finally {
    (pool as unknown as { connect: () => Promise<unknown> }).connect = originalConnect;
  }
});

test('Official cycle summary remains role restricted', async () => {
  const originalQuery = (pool as unknown as { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query;
  const officialToken = 'OFFICIAL-SESSION-TOKEN-123456789';
  const candidateToken = 'CANDIDATE-SESSION-TOKEN-12345678';
  const queries: string[] = [];
  (pool as unknown as { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query = async (text, values) => {
    queries.push(text);
    if (text.includes('FROM auth_sessions s')) {
      const tokenHash = values?.[0];
      return {
        rows: tokenHash === hashSessionToken(officialToken)
          ? [{ id: 'official-a', login_id: 'OFFICIAL-A', display_name: 'Official', role: 'official', account_status: 'approved', is_super_admin: false }]
          : tokenHash === hashSessionToken(candidateToken)
            ? [{ id: 'candidate-a', login_id: 'CANDIDATE-A', display_name: 'Candidate', role: 'candidate', account_status: 'approved', is_super_admin: false }]
            : [],
      };
    }
    return { rows: [] };
  };
  try {
    let officialQueryCount = 0;
    const router = createInstitutionSubmissionRouter({
      async query() {
        officialQueryCount += 1;
        return { rows: [] };
      },
      async connect() {
        throw new Error('No transaction expected.');
      },
    });
    const handlers = routeHandlers(router, 'get', '/admin/cycles');
    const unauthenticated = await invoke(handlers, { method: 'GET', path: '/admin/cycles' });
    assert.equal(unauthenticated.status, 401);
    const wrongRole = await invoke(handlers, { method: 'GET', path: '/admin/cycles', sessionToken: candidateToken });
    assert.equal(wrongRole.status, 403);
    assert.equal(officialQueryCount, 0);
    const authorized = await invoke(handlers, { method: 'GET', path: '/admin/cycles', sessionToken: officialToken });
    assert.equal(authorized.status, 200);
    assert.equal(officialQueryCount, 1);
    assert.ok(queries.some((query) => query.includes('FROM auth_sessions s')));
  } finally {
    (pool as unknown as { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query = originalQuery;
  }
});
