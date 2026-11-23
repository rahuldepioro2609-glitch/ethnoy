import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import {
  buildInstitutionIntegrationSchemaUrl,
  validateInstitutionIntegrationDatabaseUrl,
} from './institutionSubmission.integrationTestSafety.js';

const integrationOptIn = process.env.ELTNOY_INSTITUTION_INTEGRATION;
if (integrationOptIn !== '1') {
  throw new Error('Institution integration worker requires explicit opt-in.');
}

const target = validateInstitutionIntegrationDatabaseUrl(
  process.env.ELTNOY_INSTITUTION_TEST_DATABASE_URL,
);
const schemaName = `it_${randomUUID().replaceAll('-', '')}`;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));

const baselineSql = `
  CREATE TABLE users (
    id text PRIMARY KEY,
    login_id text NOT NULL UNIQUE,
    display_name text NOT NULL,
    role text NOT NULL CHECK (role IN ('candidate', 'center', 'official')),
    password_hash text NOT NULL,
    contact_email text,
    registration_number text,
    registered_address text,
    website text,
    is_super_admin boolean NOT NULL DEFAULT false,
    account_status text NOT NULL DEFAULT 'approved'
      CHECK (account_status IN ('pending', 'approved', 'rejected')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE institute_status_history (
    id text PRIMARY KEY,
    institution_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    previous_status text NOT NULL CHECK (previous_status IN ('pending', 'approved', 'rejected')),
    new_status text NOT NULL CHECK (new_status IN ('pending', 'approved', 'rejected')),
    reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    decision_at timestamptz NOT NULL DEFAULT now(),
    decision_reason text NOT NULL CHECK (char_length(btrim(decision_reason)) BETWEEN 10 AND 1000),
    CHECK (previous_status <> new_status)
  );
  CREATE TABLE institute_resubmissions (
    id text PRIMARY KEY,
    institution_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    submission_version integer NOT NULL CHECK (submission_version > 0),
    submission_reference text NOT NULL UNIQUE,
    submitted_data jsonb NOT NULL,
    previous_status text NOT NULL DEFAULT 'rejected' CHECK (previous_status = 'rejected'),
    new_status text NOT NULL DEFAULT 'pending' CHECK (new_status = 'pending'),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (institution_id, submission_version)
  );
  CREATE TABLE auth_sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  );
`;

const password = 'Synthetic-institution-password-2026';
const officialPassword = 'Synthetic-official-password-2026';
let setupClient: import('pg').Client | undefined;
let databasePool: Pool | undefined;
let httpServer: Server | undefined;
let schemaCreated = false;

interface HttpResult {
  status: number;
  bodyText: string;
  headers: Headers;
}

function capabilityToken(headers: Headers): string {
  const setCookie = headers.get('set-cookie') ?? '';
  const match = setCookie.match(/(?:^|,\s*)elt_institution_submission=([A-Za-z0-9_-]{43});/);
  assert.ok(match, 'Expected a pending submission capability cookie.');
  return match[1];
}

function sessionToken(headers: Headers): string {
  const setCookie = headers.get('set-cookie') ?? '';
  const match = setCookie.match(/(?:^|,\s*)elt_session=([A-Za-z0-9_-]{43});/);
  assert.ok(match, 'Expected an Official session cookie.');
  return match[1];
}

function decodeJson<T>(result: HttpResult): T {
  return JSON.parse(result.bodyText) as T;
}

async function request(
  origin: string,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; includeOrigin?: boolean } = {},
): Promise<HttpResult> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.includeOrigin !== false) headers.set('origin', origin);
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, bodyText: await response.text(), headers: response.headers };
}

async function registerInstitution(
  origin: string,
  suffix: string,
): Promise<{ id: string; loginId: string; token: string }> {
  const loginId = `IT-${suffix}`;
  const response = await request(origin, 'POST', '/api/center/register', {
    body: {
      loginId,
      name: `Synthetic Institution ${suffix}`,
      password,
      contactEmail: `${suffix.toLowerCase()}@example.test`,
      registrationNumber: `REG-${suffix}`,
      registeredAddress: `Synthetic test address for ${suffix}`,
      website: '',
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.bodyText.includes('elt_institution_submission='), false);
  const token = capabilityToken(response.headers);
  const result = await databasePool!.query(
    `SELECT id, account_status FROM users WHERE login_id = $1 AND role = 'center'`,
    [loginId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].account_status, 'pending');
  return { id: String(result.rows[0].id), loginId, token };
}

async function assertCapabilityStatus(
  origin: string,
  token: string,
  expectedStatus: number,
): Promise<HttpResult> {
  const response = await request(origin, 'GET', '/api/institution-document-submission/status', {
    cookie: `elt_institution_submission=${token}`,
    includeOrigin: false,
  });
  assert.equal(response.status, expectedStatus);
  assert.equal(response.bodyText.includes(token), false);
  return response;
}

async function runHttpWorkflow(app: import('express').Express, pool: Pool): Promise<void> {
  databasePool = pool;
  httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.APP_ORIGIN = origin;

  const officialId = randomUUID();
  const officialLoginId = `OFFICIAL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const bcrypt = (await import('bcryptjs')).default;
  await pool.query(
    `INSERT INTO users (id, login_id, display_name, role, password_hash, account_status, is_super_admin)
     VALUES ($1, $2, 'Synthetic Official', 'official', $3, 'approved', true)`,
    [officialId, officialLoginId, await bcrypt.hash(officialPassword, 4)],
  );
  const login = await request(origin, 'POST', '/api/auth/login', {
    body: { loginId: officialLoginId, password: officialPassword, role: 'official' },
  });
  assert.equal(login.status, 200);
  const officialSession = sessionToken(login.headers);
  assert.equal(login.bodyText.includes(officialSession), false);
  const officialCookie = `elt_session=${officialSession}`;

  const first = await registerInstitution(origin, randomUUID().slice(0, 8).toUpperCase());
  const unauthenticatedStatus = await request(
    origin,
    'GET',
    '/api/institution-document-submission/status',
    { includeOrigin: false },
  );
  assert.equal(unauthenticatedStatus.status, 401);
  assert.ok(unauthenticatedStatus.bodyText.includes('required'));
  const pendingLogin = await request(origin, 'POST', '/api/auth/login', {
    body: { loginId: first.loginId, password, role: 'center' },
  });
  assert.equal(pendingLogin.status, 403);
  assert.equal(pendingLogin.headers.get('set-cookie'), null);
  const firstStatus = await assertCapabilityStatus(origin, first.token, 200);
  const firstStatusBody = decodeJson<{
    cycle: { version: number; source: string };
    categories: Array<{ name: string }>;
    uploadEnabled: boolean;
    completenessPolicyEnabled: boolean;
  }>(firstStatus);
  assert.equal(firstStatusBody.cycle.version, 1);
  assert.equal(firstStatusBody.cycle.source, 'initial_registration');
  assert.deepEqual(firstStatusBody.categories.map(({ name }) => name), [
    'Registration Certificate',
    'PAN Card',
    'Address Proof',
    'Affiliation / Recognition Certificate',
    'Authorized Person’s ID Proof',
  ]);
  assert.equal(firstStatusBody.uploadEnabled, false);
  assert.equal(firstStatusBody.completenessPolicyEnabled, false);

  const firstHash = createHash('sha256').update(first.token).digest('hex');
  const capabilityRows = await pool.query(
    `SELECT token_hash FROM institution_submission_capabilities WHERE institution_id = $1`,
    [first.id],
  );
  assert.deepEqual(capabilityRows.rows.map(({ token_hash }) => token_hash), [firstHash]);
  const pendingSessions = await pool.query(
    'SELECT token_hash FROM auth_sessions WHERE user_id = $1',
    [first.id],
  );
  assert.equal(pendingSessions.rows.length, 0);

  const reissue = await request(origin, 'POST', '/api/institution-document-submission/reissue', {
    body: { loginId: first.loginId, password },
  });
  assert.equal(reissue.status, 202);
  const replacementToken = capabilityToken(reissue.headers);
  assert.notEqual(replacementToken, first.token);
  await assertCapabilityStatus(origin, first.token, 401);
  const reissuedStatus = await assertCapabilityStatus(origin, replacementToken, 200);
  assert.equal(
    decodeJson<{ cycle: { version: number } }>(reissuedStatus).cycle.version,
    1,
  );

  const explicitRevocation = await request(origin, 'POST', '/api/institution-document-submission/revoke', {
    cookie: `elt_institution_submission=${replacementToken}`,
  });
  assert.equal(explicitRevocation.status, 204);
  await assertCapabilityStatus(origin, replacementToken, 401);

  const officialCycles = await request(
    origin,
    'GET',
    '/api/institution-document-submission/admin/cycles',
    { cookie: officialCookie, includeOrigin: false },
  );
  assert.equal(officialCycles.status, 200);
  const officialCyclesBody = decodeJson<{
    completenessPolicyEnabled: boolean;
    submissions: Array<{ institution_id: string; missing_categories: string[] }>;
  }>(officialCycles);
  assert.equal(officialCyclesBody.completenessPolicyEnabled, false);
  const firstOfficialCycle = officialCyclesBody.submissions.find(
    ({ institution_id }) => institution_id === first.id,
  );
  assert.ok(firstOfficialCycle);
  assert.deepEqual(firstOfficialCycle.missing_categories, [
    'Registration Certificate',
    'PAN Card',
    'Address Proof',
    'Affiliation / Recognition Certificate',
    'Authorized Person’s ID Proof',
  ]);

  const rejected = await registerInstitution(origin, randomUUID().slice(0, 8).toUpperCase());
  const reject = await request(origin, 'PATCH', `/api/admin/institutes/${rejected.id}`, {
    cookie: officialCookie,
    body: { status: 'rejected', reason: 'Synthetic rejection for integration test.' },
  });
  assert.equal(reject.status, 200);
  await assertCapabilityStatus(origin, rejected.token, 401);
  const rejectedState = await pool.query(
    `SELECT u.account_status, c.status AS cycle_status, cap.revoked_at
     FROM users u
     JOIN institution_submission_cycles c ON c.institution_id = u.id
     JOIN institution_submission_capabilities cap
       ON cap.institution_id = u.id AND cap.submission_cycle_id = c.id
     WHERE u.id = $1`,
    [rejected.id],
  );
  assert.equal(rejectedState.rows[0]?.account_status, 'rejected');
  assert.equal(rejectedState.rows[0]?.cycle_status, 'closed');
  assert.ok(rejectedState.rows[0]?.revoked_at);

  const resubmission = await request(origin, 'POST', '/api/center/resubmit', {
    body: {
      loginId: rejected.loginId,
      name: `Corrected Synthetic Institution ${rejected.loginId}`,
      password,
      contactEmail: `corrected-${rejected.loginId.toLowerCase()}@example.test`,
      registrationNumber: `CORRECTED-${rejected.loginId}`,
      registeredAddress: `Corrected synthetic test address for ${rejected.loginId}`,
      website: '',
    },
  });
  assert.equal(resubmission.status, 200);
  const resubmittedToken = capabilityToken(resubmission.headers);
  await assertCapabilityStatus(origin, rejected.token, 401);
  const resubmittedStatus = await assertCapabilityStatus(origin, resubmittedToken, 200);
  const resubmittedCycle = decodeJson<{ cycle: { version: number; source: string } }>(resubmittedStatus).cycle;
  assert.equal(resubmittedCycle.version, 2);
  assert.equal(resubmittedCycle.source, 'resubmission');
  const resubmittedSessions = await pool.query(
    'SELECT token_hash FROM auth_sessions WHERE user_id = $1',
    [rejected.id],
  );
  assert.equal(resubmittedSessions.rows.length, 0);

  const approved = await registerInstitution(origin, randomUUID().slice(0, 8).toUpperCase());
  const approval = await request(origin, 'PATCH', `/api/admin/institutes/${approved.id}`, {
    cookie: officialCookie,
    body: { status: 'approved', reason: 'Synthetic approval for integration test.' },
  });
  assert.equal(approval.status, 200);
  await assertCapabilityStatus(origin, approved.token, 401);
  const approvedState = await pool.query(
    `SELECT u.account_status, c.status AS cycle_status, cap.revoked_at
     FROM users u
     JOIN institution_submission_cycles c ON c.institution_id = u.id
     JOIN institution_submission_capabilities cap
       ON cap.institution_id = u.id AND cap.submission_cycle_id = c.id
     WHERE u.id = $1`,
    [approved.id],
  );
  assert.equal(approvedState.rows[0]?.account_status, 'approved');
  assert.equal(approvedState.rows[0]?.cycle_status, 'closed');
  assert.ok(approvedState.rows[0]?.revoked_at);
}

async function run(): Promise<void> {
  if (integrationOptIn !== '1') {
    throw new Error('Institution integration worker requires explicit opt-in.');
  }
  const { Client } = await import('pg');
  setupClient = new Client({ connectionString: target.toString() });
  await setupClient.connect();
  await setupClient.query(`CREATE SCHEMA "${schemaName}"`);
  schemaCreated = true;
  await setupClient.query(`SET search_path TO "${schemaName}"`);
  await setupClient.query(baselineSql);

  const milestoneOne = await readFile(resolve(sourceDirectory, 'institutionDocumentsMigration.sql'), 'utf8');
  const milestoneTwo = await readFile(
    resolve(sourceDirectory, 'institutionDocumentSubmissionMigration.sql'),
    'utf8',
  );
  await setupClient.query(milestoneOne);
  await setupClient.query(milestoneTwo);
  await setupClient.end();
  setupClient = undefined;

  process.env.DATABASE_URL = buildInstitutionIntegrationSchemaUrl(target, schemaName);
  process.env.DATABASE_SSL = 'false';
  process.env.DATABASE_POOL_SIZE = '4';
  process.env.PORT = '0';
  process.env.APP_ORIGIN = 'http://127.0.0.1';

  const { pool } = await import('./db.js');
  databasePool = pool;
  const { app } = await import('./index.js');
  await runHttpWorkflow(app, pool);
}

async function cleanup(): Promise<void> {
  if (httpServer?.listening) {
    await new Promise<void>((resolveClose, reject) => {
      httpServer!.close((error) => error ? reject(error) : resolveClose());
    });
  }
  if (databasePool) {
    await databasePool.end();
    databasePool = undefined;
  }
  if (setupClient) {
    await setupClient.end();
    setupClient = undefined;
  }
  if (schemaCreated) {
    const { Client } = await import('pg');
    const cleanupClient = new Client({ connectionString: target.toString() });
    await cleanupClient.connect();
    try {
      await cleanupClient.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      schemaCreated = false;
    } finally {
      await cleanupClient.end();
    }
  }
}

void run()
  .then(cleanup)
  .catch(async () => {
    try {
      await cleanup();
    } catch {
      process.stderr.write('Institution integration worker cleanup failed.\n');
    }
    process.stderr.write('Institution submission HTTP integration checks failed; sensitive details were withheld.\n');
    process.exitCode = 1;
  });
