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
import { hashSessionToken, setTrustedRequestSurface } from './auth.js';
import { expectedOrigin, type Surface } from './surface.js';
import { pool } from './db.js';
import { INSTITUTION_DOCUMENT_CATEGORIES } from '../src/utils/institutionDocuments.js';
import { MemoryAuthVerificationStore, MemoryEmailGuardStore, MemorySmsGuardStore, RecordingEmailProvider, RecordingSmsProvider, testAbuseProtection, testServices, VERIFIED_PORTAL_SESSION } from './authTestSupport.js';
import { configureVerificationServices, DISABLED_SERVICES } from './verificationProviders.js';
import { configureAbuseProtection, configureAuthVerificationStore, configureEmailSendGuardStore, configureSmsSendGuardStore, emailDestinationKey, smsDestinationKey } from './authVerification.js';

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

// P1-B: these route-stack tests bypass the app-level surface enforcement, so each fake request
// carries the server-controlled surface that its account's role belongs to (candidate → Exam,
// center → Institution, official → Admin), set through the same trusted setter the gate uses.
function trustSurface(request: object, surface: Surface): void {
  setTrustedRequestSurface(request, surface, expectedOrigin(surface));
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
    /** Server-controlled surface; defaults to Admin for /admin paths, otherwise Institution. */
    surface?: Surface;
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
    trustSurface(request, options.surface ?? (options.path.startsWith('/admin') ? 'admin' : 'institution'));
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
        headers[name] = headers[name] ? `${headers[name]}\n${value}` : value;
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
      // P1-B: the exact Institution surface origin (APP_ORIGIN is no longer consulted).
      origin: expectedOrigin('institution'),
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

// P1-B supersedes the APP_ORIGIN rule: capability mutations need the trusted Institution surface
// and exactly its Origin. A configured APP_ORIGIN no longer grants anything.
test('capability mutations require the exact Institution surface Origin', async () => {
  const previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://portal.example.test';
  try {
    const invokeOrigin = (origin: string | undefined, surface?: Surface) => new Promise<number>((resolve) => {
      const request = {
        method: 'POST',
        get: () => origin,
      } as unknown as Request;
      if (surface) trustSurface(request, surface);
      const response = {
        status(code: number) {
          resolve(code);
          return this;
        },
        json() { return this; },
      } as unknown as Response;
      requireCapabilityMutationOrigin(request, response, () => resolve(204));
    });
    const institutionOrigin = expectedOrigin('institution');
    assert.equal(await invokeOrigin(undefined, 'institution'), 403, 'missing Origin');
    assert.equal(await invokeOrigin('null', 'institution'), 403, 'null Origin');
    assert.equal(await invokeOrigin('https://attacker.example.test', 'institution'), 403);
    assert.equal(await invokeOrigin(expectedOrigin('exam'), 'institution'), 403, 'cross-surface Origin');
    assert.equal(await invokeOrigin('https://portal.example.test', 'institution'), 403, 'APP_ORIGIN is not trusted');
    assert.equal(await invokeOrigin(institutionOrigin), 403, 'no trusted surface');
    assert.equal(await invokeOrigin(expectedOrigin('admin'), 'admin'), 403, 'Admin surface cannot mutate capabilities');
    assert.equal(await invokeOrigin(institutionOrigin, 'institution'), 204);
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
  // AUTH-1: registration needs both verification providers (test doubles here; none in production).
  const sms = new RecordingSmsProvider();
  configureVerificationServices(testServices({ sms, email: new RecordingEmailProvider() }));
  configureAuthVerificationStore(new MemoryAuthVerificationStore());
  // AUTH C1.1-b: every SMS needs the (test-only) SMS limits; the registration SMS is reserved first.
  const smsGuard = new MemorySmsGuardStore();
  configureSmsSendGuardStore(smsGuard);
  // AUTH C1.4-B-1: the registration's later email is reserved through the (in-memory) email guard.
  const emailGuard = new MemoryEmailGuardStore();
  configureEmailSendGuardStore(emailGuard);
  configureAbuseProtection(testAbuseProtection());
  try {
    const response = await invoke(applicationRoute.stack.slice(1).map(({ handle }) => handle), {
      method: 'POST',
      path: '/api/center/register',
      body: {
        loginId: 'NEW-INSTITUTE',
        name: 'Synthetic New Institute',
        password: 'Synthetic-new-password-2026',
        contactEmail: 'new@example.test',
        contactMobile: '9876500001',
        registrationNumber: 'NEW-REG-123',
        registeredAddress: '123 Synthetic Street, Example District',
        website: '',
      },
    });
    assert.equal(response.status, 201);
    const verificationInsert = statements.find(({ text }) => text.includes('INSERT INTO institute_verifications'));
    assert.deepEqual(verificationInsert?.values, ['new-institution', '+919876500001', 'new@example.test'], 'contacts recorded unverified, in the same transaction');
    assert.ok(statements.findIndex(({ text }) => text.includes('INSERT INTO institute_verifications')) < statements.findIndex(({ text }) => text === 'COMMIT'));
    assert.deepEqual(sms.sent.map((entry) => [entry.destination, entry.purpose]), [['+919876500001', 'institute_mobile']]);
    assert.ok(!JSON.stringify(response.body).includes(sms.lastCode()!), 'the code is never returned');
    assert.deepEqual(smsGuard.reservations.map((r) => [r.purpose, r.bucket]), [['institute_mobile', 'unverified']], 'AUTH C1.1-b: reserved in the unverified bucket');
    assert.match(response.headers['Set-Cookie'], /elt_verification=/);
    assert.equal((response.body as { verification: { status: string } }).verification.status, 'verification_required');
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
    configureVerificationServices(DISABLED_SERVICES);
    configureAbuseProtection(undefined);
  }
});

test('AUTH-1: without verification providers, institute registration is closed before any write', async () => {
  const [{ app }] = await Promise.all([import('./index.js')]);
  const route = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } })._router.stack
    .map((item) => item.route).find((candidate) => candidate?.path === '/api/center/register' && candidate.methods.post);
  assert.ok(route);
  configureVerificationServices(DISABLED_SERVICES);
  const originalConnect = (pool as unknown as { connect: () => Promise<unknown> }).connect;
  let connections = 0;
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => { connections += 1; throw new Error('must not connect'); };
  try {
    for (const services of [DISABLED_SERVICES, testServices({ sms: new RecordingSmsProvider() }), testServices({ email: new RecordingEmailProvider() })]) {
      configureVerificationServices(services);
      const response = await invoke(route.stack.slice(1).map(({ handle }) => handle), {
        method: 'POST', path: '/api/center/register',
        body: { loginId: 'CLOSED-INSTITUTE', name: 'Closed Institute', password: 'Synthetic-new-password-2026', contactEmail: 'closed@example.test', contactMobile: '9876500002', registrationNumber: 'REG-1', registeredAddress: '1 Closed Street, Example', website: '' },
      });
      assert.equal(response.status, 503);
      assert.match(String((response.body as { code: string }).code), /^(OTP|EMAIL)_PROVIDER_NOT_CONFIGURED$/);
    }
    // AUTH C1.1-b: both providers present but the SMS limits unset (or the unverified budget used up):
    // still closed before any write.
    configureVerificationServices(testServices({ sms: new RecordingSmsProvider(), email: new RecordingEmailProvider() }));
    const smsGuard = new MemorySmsGuardStore();
    configureSmsSendGuardStore(smsGuard);
    const emailGuard = new MemoryEmailGuardStore();
    configureEmailSendGuardStore(emailGuard);
    const body = { loginId: 'CLOSED-INSTITUTE', name: 'Closed Institute', password: 'Synthetic-new-password-2026', contactEmail: 'closed@example.test', contactMobile: '9876500002', registrationNumber: 'REG-1', registeredAddress: '1 Closed Street, Example', website: '' };
    configureAbuseProtection({ ...testAbuseProtection(), sms: null, problems: ['test: unset'] });
    const unconfigured = await invoke(route.stack.slice(1).map(({ handle }) => handle), { method: 'POST', path: '/api/center/register', body });
    assert.deepEqual([unconfigured.status, (unconfigured.body as { code: string }).code], [503, 'SMS_PROTECTION_NOT_CONFIGURED']);
    configureAbuseProtection(testAbuseProtection({ dailyMaxSends: 1, dailyMaxUnverifiedSends: 1 }));
    smsGuard.reservations.push({ reservationId: 'r', destinationKey: 'k'.repeat(32), bucket: 'unverified', purpose: 'student_registration', at: Date.now() });
    const exhausted = await invoke(route.stack.slice(1).map(({ handle }) => handle), { method: 'POST', path: '/api/center/register', body });
    assert.deepEqual([exhausted.status, (exhausted.body as { code: string }).code], [503, 'SMS_DAILY_LIMIT_REACHED']);
    // AUTH C1.1-b C-2: contactMobile's unverified allowance already used up: 429 before ANY write
    // (account, submission cycle, capability, institute verification). The pool would count a connection.
    configureAbuseProtection(testAbuseProtection({ unverified: { windowMs: 3600_000, maxSends: 1 } }));
    smsGuard.reservations.length = 0;
    smsGuard.reservations.push({ reservationId: 'flood', destinationKey: smsDestinationKey(Buffer.alloc(32, 7), '+919876500002'), bucket: 'unverified', purpose: 'student_registration', at: Date.now() });
    const flooded = await invoke(route.stack.slice(1).map(({ handle }) => handle), { method: 'POST', path: '/api/center/register', body });
    assert.deepEqual([flooded.status, (flooded.body as { code: string }).code], [429, 'SMS_DESTINATION_LIMITED']);
    assert.equal(smsGuard.refusals.length, 0, 'answered by the early gate, before any reservation or write');
    // AUTH C1.4-B-1: email limits unset, email budget used up, or contactEmail's anonymous allowance used
    // up: refused BEFORE any write (the pool would count a connection), with no reservation.
    smsGuard.reservations.length = 0;
    configureAbuseProtection({ ...testAbuseProtection(), email: null });
    const emailUnset = await invoke(route.stack.slice(1).map(({ handle }) => handle), { method: 'POST', path: '/api/center/register', body });
    assert.deepEqual([emailUnset.status, (emailUnset.body as { code: string }).code], [503, 'EMAIL_PROTECTION_NOT_CONFIGURED']);
    configureAbuseProtection(testAbuseProtection({}, undefined, { dailyMaxSends: 1, dailyMaxUnverifiedSends: 1 }));
    emailGuard.reservations.push({ reservationId: 'e', destinationKey: 'x'.repeat(32), bucket: 'unverified', purpose: 'institute_email', at: Date.now() });
    const emailBudget = await invoke(route.stack.slice(1).map(({ handle }) => handle), { method: 'POST', path: '/api/center/register', body });
    assert.deepEqual([emailBudget.status, (emailBudget.body as { code: string }).code], [503, 'EMAIL_DAILY_LIMIT_REACHED']);
    configureAbuseProtection(testAbuseProtection({}, undefined, { unverified: { windowMs: 3600_000, maxSends: 1 } }));
    emailGuard.reservations.length = 0;
    emailGuard.reservations.push({ reservationId: 'f', destinationKey: emailDestinationKey(Buffer.alloc(32, 7), 'closed@example.test'), bucket: 'unverified', purpose: 'institute_email', at: Date.now() });
    const emailFlooded = await invoke(route.stack.slice(1).map(({ handle }) => handle), { method: 'POST', path: '/api/center/register', body });
    assert.deepEqual([emailFlooded.status, (emailFlooded.body as { code: string }).code], [429, 'EMAIL_DESTINATION_LIMITED']);
    assert.equal(emailGuard.refusals.length, 0, 'advisory only: no email reservation is made by the gate');
    assert.equal(connections, 0, 'nothing is written while verification is impossible');
  } finally {
    (pool as unknown as { connect: () => Promise<unknown> }).connect = originalConnect;
    configureVerificationServices(DISABLED_SERVICES);
    configureAbuseProtection(undefined);
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
          ? [{ id: 'official-a', login_id: 'OFFICIAL-A', display_name: 'Official', role: 'official', account_status: 'approved', is_super_admin: false, ...VERIFIED_PORTAL_SESSION }]
          : tokenHash === hashSessionToken(candidateToken)
            ? [{ id: 'candidate-a', login_id: 'CANDIDATE-A', display_name: 'Candidate', role: 'candidate', account_status: 'approved', is_super_admin: false, ...VERIFIED_PORTAL_SESSION }]
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
    // A candidate session on its own (Exam) surface reaches the role guard: 403.
    const wrongRole = await invoke(handlers, { method: 'GET', path: '/admin/cycles', sessionToken: candidateToken, surface: 'exam' });
    assert.equal(wrongRole.status, 403);
    // The same candidate session presented on the Admin surface is a cross-surface session: 401.
    const crossSurface = await invoke(handlers, { method: 'GET', path: '/admin/cycles', sessionToken: candidateToken, surface: 'admin' });
    assert.equal(crossSurface.status, 401);
    assert.equal(officialQueryCount, 0);
    const authorized = await invoke(handlers, { method: 'GET', path: '/admin/cycles', sessionToken: officialToken });
    assert.equal(authorized.status, 200);
    assert.equal(officialQueryCount, 1);
    assert.ok(queries.some((query) => query.includes('FROM auth_sessions s')));
  } finally {
    (pool as unknown as { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query = originalQuery;
  }
});
