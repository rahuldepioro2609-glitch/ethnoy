import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { expectedOrigin, type Surface } from './surface.js';
import { RecordingEmailProvider, RecordingSmsProvider, testServices, VERIFIED_PORTAL_SESSION } from './authTestSupport.js';
import { configureVerificationServices, DISABLED_SERVICES } from './verificationProviders.js';
import { AUDIT_INSERT_SQL } from './audit.js';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:5432/test';

const [{ app }, { pool }, { hashSessionToken, requireAuth, setTrustedRequestSurface }] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
]);

const institutionToken = 'I'.repeat(43);
const password = 'Synthetic-institute-password-2026';
const fixedSubmissionAt = new Date('2026-11-01T10:00:00.000Z');

interface ExpressRouteLayer {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
}

function findPostRouteHandlers(path: string): RequestHandler[] {
  const router = (app as unknown as { _router: { stack: ExpressRouteLayer[] } })._router;
  const route = router.stack
    .map((layer) => layer.route)
    .find((entry) => entry?.methods.post
      && (Array.isArray(entry.path) ? entry.path : [entry.path]).includes(path));
  assert.ok(route, `Expected POST route ${path} to be registered`);
  return route.stack.map((layer) => layer.handle);
}

// P1-B: these route-stack tests bypass the app-level surface enforcement, so each fake request
// carries the server-controlled surface that its account's role belongs to (candidate → Exam,
// center → Institution, official → Admin), set through the same trusted setter the gate uses.
function trustSurface(request: object, surface: Surface): void {
  setTrustedRequestSurface(request, surface, expectedOrigin(surface));
}

function invokePostRoute(
  handlers: RequestHandler[],
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: unknown; cookieSet: boolean }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    let cookieSet = false;
    const request = {
      headers: token ? { cookie: `elt_session=${token}` } : {},
      body,
      app: { get: () => false },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      method: 'POST',
      path: '/api/center/resubmit',
      url: '/api/center/resubmit',
    } as unknown as Request;
    trustSurface(request, 'institution');
    const response = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      setHeader() {
        return this;
      },
      getHeader() {
        return undefined;
      },
      json(responseBody: unknown) {
        settled = true;
        resolve({ status, body: responseBody, cookieSet });
        return this;
      },
      append(name: string, value: string) {
        if (name.toLowerCase() === 'set-cookie' && value.includes('elt_institution_submission=')) {
          cookieSet = true;
        }
        return this;
      },
      set() {
        return this;
      },
      cookie() {
        cookieSet = true;
        return this;
      },
      clearCookie() {
        return this;
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
      } catch (handlerError) {
        next(handlerError);
      }
    };

    next();
  });
}

function invokeAuthMiddleware(token: string): Promise<{ status: number; nextCalled: boolean }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let nextCalled = false;
    const request = {
      headers: { cookie: `elt_session=${token}` },
    } as unknown as import('./auth.js').AuthenticatedRequest;
    trustSurface(request, 'institution');
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        resolve({ status, nextCalled });
        return this;
      },
      clearCookie() {
        return this;
      },
    } as unknown as Response;
    const next: NextFunction = (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      nextCalled = true;
      resolve({ status, nextCalled });
    };
    void requireAuth(request, response, next);
  });
}

function installSyntheticDatabase(options: { status?: string; rejectSubmissionInsert?: boolean } = {}) {
  const passwordHashPromise = bcrypt.hash(password, 4);
  const institution = {
    id: 'synthetic-institute',
    login_id: 'SYNTHETIC-INSTITUTE',
    display_name: 'Rejected Institute',
    contact_email: 'old@example.test',
    registration_number: 'OLD-REGISTRATION',
    registered_address: 'Old synthetic address for the institute',
    website: null as string | null,
    account_status: options.status ?? 'rejected',
    password_hash: '',
    created_at: fixedSubmissionAt,
  };
  const resubmissions: Array<Record<string, unknown>> = [];
  const audits: Array<{ action: string; actorUserId: unknown; organizationId: unknown }> = [];
  const cycles: Array<Record<string, unknown>> = [];
  const capabilities: Array<Record<string, unknown>> = [];
  const priorDecisionHistory = [{
    institution_id: institution.id,
    previous_status: 'pending',
    new_status: 'rejected',
    reviewer_user_id: 'synthetic-official',
    decision_reason: 'Synthetic prior rejection reason',
  }];
  const authSession = {
    id: institution.id,
    login_id: institution.login_id,
    display_name: institution.display_name,
    role: 'center',
    account_status: institution.account_status,
    is_super_admin: false, ...VERIFIED_PORTAL_SESSION,
  };
  let connectionCount = 0;
  let lockTail = Promise.resolve();

  const poolWithMock = pool as unknown as {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    connect: () => Promise<{
      query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      release: () => void;
    }>;
  };
  const originalQuery = poolWithMock.query.bind(pool);
  const originalConnect = poolWithMock.connect.bind(pool);

  const ready = passwordHashPromise.then((hash) => {
    institution.password_hash = hash;
    poolWithMock.query = async (text, values = []) => {
      if (text.includes('FROM auth_sessions s')) {
        return {
          rows: values[0] === hashSessionToken(institutionToken) ? [{
            id: institution.id,
            login_id: institution.login_id,
            display_name: institution.display_name,
            role: 'center',
            account_status: institution.account_status,
            is_super_admin: false, ...VERIFIED_PORTAL_SESSION,
          }] : [],
        };
      }
      if (text.includes('FROM users WHERE login_id = $1')) {
        if (values[0] !== institution.login_id) return { rows: [] };
        if (text.includes('role = $2')) {
          return {
            rows: values[1] === 'center'
              ? [{
                id: institution.id,
                login_id: institution.login_id,
                display_name: institution.display_name,
                role: 'center',
                password_hash: institution.password_hash,
                account_status: institution.account_status,
                is_super_admin: false, ...VERIFIED_PORTAL_SESSION,
              }]
              : [],
          };
        }
        return { rows: [{ id: institution.id, password_hash: institution.password_hash }] };
      }
      throw new Error(`Unexpected pool query in synthetic test: ${text}`);
    };
    poolWithMock.connect = async () => {
      connectionCount += 1;
      let releaseLock: (() => void) | undefined;
      let previousStatus: string | undefined;
      let institutionSnapshot: typeof institution | undefined;
      let resubmissionCountBefore = 0;
      let auditCountBefore = 0;
      let locked = false;

      return {
        async query(text, values = []) {
          if (text === 'BEGIN') return { rows: [] };
          if (text === 'ROLLBACK') {
            if (locked) {
              if (institutionSnapshot) Object.assign(institution, institutionSnapshot);
              institution.account_status = previousStatus ?? institution.account_status;
              resubmissions.splice(resubmissionCountBefore);
              audits.splice(auditCountBefore);
              releaseLock?.();
              locked = false;
            }
            return { rows: [] };
          }
          if (text === 'COMMIT') {
            releaseLock?.();
            locked = false;
            return { rows: [] };
          }
          if (text.includes('FROM users') && text.includes('FOR UPDATE')) {
            let release!: () => void;
            const previous = lockTail;
            lockTail = new Promise<void>((resolve) => { release = resolve; });
            await previous;
            releaseLock = release;
            locked = true;
            previousStatus = institution.account_status;
            institutionSnapshot = { ...institution };
            resubmissionCountBefore = resubmissions.length;
            auditCountBefore = audits.length;
            return { rows: values[0] === institution.id
              ? [{ id: institution.id, account_status: institution.account_status }]
              : [] };
          }
          if (text.includes('MAX(submission_version)')) {
            const version = resubmissions.reduce(
              (max, row) => Math.max(max, Number(row.submission_version)),
              0,
            ) + 1;
            return { rows: [{ next_version: version }] };
          }
          if (text.includes('UPDATE users') && text.includes("account_status = 'pending'")) {
            if (institution.account_status !== 'rejected' || values[0] !== institution.id) return { rows: [] };
            institution.display_name = String(values[1]);
            institution.contact_email = String(values[2]);
            institution.registration_number = String(values[3]);
            institution.registered_address = String(values[4]);
            institution.website = values[5] === null ? null : String(values[5]);
            institution.account_status = 'pending';
            return { rows: [{ ...institution }] };
          }
          if (text.includes('INSERT INTO institute_resubmissions')) {
            if (options.rejectSubmissionInsert) throw new Error('Synthetic resubmission insert failure.');
            resubmissions.push({
              id: values[0],
              institution_id: values[1],
              submission_version: values[2],
              submission_reference: values[3],
              submitted_data: JSON.parse(String(values[4])) as Record<string, unknown>,
              previous_status: 'rejected',
              new_status: 'pending',
              submitted_at: fixedSubmissionAt,
            });
            return { rows: [] };
          }
          if (text === AUDIT_INSERT_SQL) {
            audits.push({ action: String(values[1]), actorUserId: values[5], organizationId: values[7] });
            return { rows: [] };
          }
          if (text.includes('UPDATE institution_submission_cycles')) {
            for (const cycle of cycles) {
              if (cycle.institution_id === values[0] && cycle.status === 'open') {
                cycle.status = 'closed';
              }
            }
            return { rows: [] };
          }
          if (text.includes('UPDATE institution_submission_capabilities')) {
            for (const capability of capabilities) {
              if (capability.institution_id === values[0] && capability.revoked_at === null) {
                capability.revoked_at = fixedSubmissionAt;
              }
            }
            return { rows: [] };
          }
          if (text.includes('INSERT INTO institution_submission_cycles')) {
            cycles.push({
              id: values[0],
              institution_id: values[1],
              submission_version: values[2],
              source_type: values[3],
              source_reference: values[4],
              status: 'open',
            });
            return { rows: [] };
          }
          if (text.includes('INSERT INTO institution_submission_capabilities')) {
            assert.match(String(values[3]), /^[0-9a-f]{64}$/);
            capabilities.push({
              id: values[0],
              institution_id: values[1],
              submission_cycle_id: values[2],
              token_hash: values[3],
              expires_at: values[4],
              revoked_at: null,
            });
            return { rows: [] };
          }
          throw new Error(`Unexpected transaction query in synthetic test: ${text}`);
        },
        release() {},
      };
    };
  });

  return {
    ready,
    institution,
    resubmissions,
    audits,
    cycles,
    capabilities,
    priorDecisionHistory,
    get connectionCount() { return connectionCount; },
    restore() {
      poolWithMock.query = originalQuery;
      poolWithMock.connect = originalConnect;
    },
  };
}

const correctedDetails = {
  loginId: 'synthetic-institute',
  password,
  name: 'Corrected Synthetic Institute',
  contactEmail: 'corrected@example.test',
  registrationNumber: 'NEW-REGISTRATION',
  registeredAddress: 'Corrected synthetic address for this institute',
  website: 'https://institute.example.test',
};

test('rejected institution corrects details and resubmits using the existing account', async () => {
  const database = installSyntheticDatabase();
  await database.ready;
  try {
    const handlers = findPostRouteHandlers('/api/center/resubmit').slice(1);
    const response = await invokePostRoute(handlers, correctedDetails);
    assert.equal(response.status, 200);
    assert.equal(response.cookieSet, true);
    assert.equal(database.institution.id, 'synthetic-institute');
    assert.equal(database.institution.login_id, 'SYNTHETIC-INSTITUTE');
    assert.equal(database.institution.account_status, 'pending');
    assert.equal(database.institution.display_name, correctedDetails.name);
    assert.equal(database.institution.contact_email, correctedDetails.contactEmail);
    assert.equal(database.institution.registration_number, correctedDetails.registrationNumber);
    assert.deepEqual(database.resubmissions, [{
      id: database.resubmissions[0].id,
      institution_id: 'synthetic-institute',
      submission_version: 1,
      submission_reference: (response.body as { submissionReference: string }).submissionReference,
      previous_status: 'rejected',
      new_status: 'pending',
      submitted_data: {
        displayName: correctedDetails.name,
        contactEmail: correctedDetails.contactEmail,
        registrationNumber: correctedDetails.registrationNumber,
        registeredAddress: correctedDetails.registeredAddress,
        website: correctedDetails.website,
      },
      submitted_at: fixedSubmissionAt,
    }]);
    assert.equal(database.priorDecisionHistory.length, 1);
    assert.equal(database.cycles.length, 1);
    assert.equal(database.cycles[0].submission_version, 2);
    assert.equal(database.cycles[0].source_type, 'resubmission');
    assert.equal(database.cycles[0].source_reference, (response.body as { submissionReference: string }).submissionReference);
    assert.equal(database.capabilities.length, 1);
    assert.equal(typeof database.capabilities[0].token, 'undefined');
    assert.equal(database.priorDecisionHistory[0].new_status, 'rejected');
    assert.equal(database.connectionCount, 1);
    assert.deepEqual(database.audits, [{ action: 'institution.resubmitted', actorUserId: 'synthetic-institute', organizationId: 'synthetic-institute' }]);
  } finally {
    database.restore();
  }
});

test('resubmission requires the existing institute credentials and never creates a session', async () => {
  const database = installSyntheticDatabase();
  await database.ready;
  try {
    const handlers = findPostRouteHandlers('/api/center/resubmit').slice(1);
    const invalid = await invokePostRoute(handlers, { ...correctedDetails, password: 'wrong-password' });
    assert.equal(invalid.status, 401);
    assert.equal(database.connectionCount, 0);
    assert.deepEqual(database.resubmissions, []);
    assert.equal(database.institution.account_status, 'rejected');

    const loginHandlers = findPostRouteHandlers('/api/auth/login').slice(1);
    // AUTH-1: without providers, institute sign-in is closed (503) before any lookup.
    const closed = await invokePostRoute(loginHandlers, { loginId: correctedDetails.loginId, password, role: 'center' });
    assert.equal(closed.status, 503);
    assert.equal(closed.cookieSet, false);
    // With (test-double) providers, the rejected account is still refused with 403 and no session.
    configureVerificationServices(testServices({ sms: new RecordingSmsProvider(), email: new RecordingEmailProvider() }));
    // AUTH C1.1-b: sign-in also needs the (test-only) SMS limits, checked before any lookup. Imported
    // here, after this file has set its environment, so the shared pool is configured as before.
    const { configureAbuseProtection } = await import('./authVerification.js');
    const { testAbuseProtection } = await import('./authTestSupport.js');
    configureAbuseProtection(testAbuseProtection());
    const login = await invokePostRoute(loginHandlers, {
      loginId: correctedDetails.loginId,
      password,
      role: 'center',
    });
    assert.equal(login.status, 403);
    assert.equal(login.cookieSet, false);
    assert.equal(database.institution.account_status, 'rejected');
  } finally {
    configureVerificationServices(DISABLED_SERVICES);
    (await import('./authVerification.js')).configureAbuseProtection(undefined);
    database.restore();
  }
});

test('resubmitting with valid credentials cannot bypass approved-only session authorization', async () => {
  const database = installSyntheticDatabase({ status: 'pending' });
  await database.ready;
  try {
    const result = await invokeAuthMiddleware(institutionToken);
    assert.equal(result.status, 403);
    assert.equal(result.nextCalled, false);
  } finally {
    database.restore();
  }
});

test('only rejected institute accounts can be resubmitted', async () => {
  const database = installSyntheticDatabase({ status: 'approved' });
  await database.ready;
  try {
    const handlers = findPostRouteHandlers('/api/center/resubmit').slice(1);
    const response = await invokePostRoute(handlers, correctedDetails);
    assert.equal(response.status, 409);
    assert.equal(database.institution.account_status, 'approved');
    assert.equal(database.institution.display_name, 'Rejected Institute');
    assert.deepEqual(database.resubmissions, []);
  } finally {
    database.restore();
  }
});

test('a concurrent second resubmission cannot create a duplicate or overwrite the first', async () => {
  const database = installSyntheticDatabase();
  await database.ready;
  try {
    const handlers = findPostRouteHandlers('/api/center/resubmit').slice(1);
    const firstDetails = { ...correctedDetails, name: 'First corrected institute name' };
    const secondDetails = { ...correctedDetails, name: 'Second corrected institute name' };
    const [first, second] = await Promise.all([
      invokePostRoute(handlers, firstDetails),
      invokePostRoute(handlers, secondDetails),
    ]);

    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(database.institution.account_status, 'pending');
    assert.equal(database.resubmissions.length, 1);
    assert.equal(database.resubmissions[0].submission_version, 1);
    assert.equal(database.institution.display_name, first.status === 200 ? firstDetails.name : secondDetails.name);
    assert.equal(database.priorDecisionHistory.length, 1);
  } finally {
    database.restore();
  }
});

test('resubmission snapshots are append-only and have unique per-institute versions', async () => {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS institute_resubmissions/);
  assert.match(schema, /UNIQUE \(institution_id, submission_version\)/);
  assert.match(schema, /submission_reference text NOT NULL UNIQUE/);
  assert.match(schema, /submitted_data jsonb NOT NULL/);
  assert.match(schema, /previous_status text NOT NULL DEFAULT 'rejected'/);
  assert.match(schema, /new_status text NOT NULL DEFAULT 'pending'/);
  assert.match(schema, /BEFORE UPDATE OR DELETE ON institute_resubmissions/);
  assert.match(schema, /BEFORE TRUNCATE ON institute_resubmissions/);
});

test('resubmission history insert failure rolls corrected details and status back', async () => {
  const database = installSyntheticDatabase({ rejectSubmissionInsert: true });
  await database.ready;
  try {
    const handlers = findPostRouteHandlers('/api/center/resubmit').slice(1);
    await assert.rejects(invokePostRoute(handlers, correctedDetails), /Synthetic resubmission insert failure/);
    assert.equal(database.institution.account_status, 'rejected');
    assert.equal(database.institution.display_name, 'Rejected Institute');
    assert.equal(database.resubmissions.length, 0);
    assert.equal(database.priorDecisionHistory.length, 1);
  } finally {
    database.restore();
  }
});
