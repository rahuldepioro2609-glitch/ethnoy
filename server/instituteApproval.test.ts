import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { expectedOrigin, type Surface } from './surface.js';
import { VERIFIED_PORTAL_SESSION } from './authTestSupport.js';
import { AUDIT_INSERT_SQL } from './audit.js';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:5432/test';

const [{ app }, { pool }, { hashSessionToken, setTrustedRequestSurface }] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
]);

const officialToken = 'O'.repeat(43);
const candidateToken = 'C'.repeat(43);
const fixedDecisionAt = new Date('2026-11-01T10:00:00.000Z');

interface ExpressRouteLayer {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
}

function findPatchRouteHandlers(path: string): RequestHandler[] {
  const router = (app as unknown as { _router: { stack: ExpressRouteLayer[] } })._router;
  const route = router.stack
    .map((layer) => layer.route)
    .find((entry) => entry?.methods.patch
      && (Array.isArray(entry.path) ? entry.path : [entry.path]).includes(path));
  assert.ok(route, `Expected PATCH route ${path} to be registered`);
  return route.stack.map((layer) => layer.handle);
}

// P1-B: these route-stack tests bypass the app-level surface enforcement, so each fake request
// carries the server-controlled surface that its account's role belongs to (candidate → Exam,
// center → Institution, official → Admin), set through the same trusted setter the gate uses.
function trustSurface(request: object, surface: Surface): void {
  setTrustedRequestSurface(request, surface, expectedOrigin(surface));
}

function invokePatchRoute(
  handlers: RequestHandler[],
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    const request = {
      headers: token ? { cookie: `elt_session=${token}` } : {},
      params: { id: 'synthetic-institute' },
      body,
    } as unknown as Request;
    trustSurface(request, token === candidateToken ? 'exam' : 'admin');
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(responseBody: unknown) {
        settled = true;
        resolve({ status, body: responseBody });
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

function installSyntheticDatabase(options: {
  failHistoryInsert?: boolean;
  failCapabilityRevocation?: boolean;
  submissionSchemaInstalled?: boolean;
} = {}) {
  const sessions = new Map([
    [hashSessionToken(officialToken), {
      id: 'synthetic-official',
      login_id: 'SYNTHETIC-OFFICIAL',
      display_name: 'Synthetic Official',
      role: 'official',
      account_status: 'approved',
      is_super_admin: false, ...VERIFIED_PORTAL_SESSION,
    }],
    [hashSessionToken(candidateToken), {
      id: 'synthetic-candidate',
      login_id: 'SYNTHETIC-CANDIDATE',
      display_name: 'Synthetic Candidate',
      role: 'candidate',
      account_status: 'approved',
      is_super_admin: false, ...VERIFIED_PORTAL_SESSION,
    }],
  ]);
  const institution = {
    id: 'synthetic-institute',
    account_status: 'pending',
    login_id: 'SYNTHETIC-INSTITUTE',
    display_name: 'Synthetic Institute',
    contact_email: 'institute@example.test',
    registration_number: 'SYNTHETIC-REG-1',
    registered_address: 'Synthetic address for test institute',
    website: null,
    created_at: fixedDecisionAt,
  };
  const history: Array<Record<string, unknown>> = [];
  // A-11 audit rows written in the decision transaction (rolled back with it).
  const audits: Array<{ action: string; organizationId: unknown; metadata: Record<string, unknown> }> = [];
  const capabilities = [{
    institution_id: institution.id,
    revoked_at: null as Date | null,
  }];
  const cycles = [{
    institution_id: institution.id,
    status: 'open',
    closed_at: null as Date | null,
  }];
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

  poolWithMock.query = async (text, values = []) => {
    if (text.includes('FROM auth_sessions s')) {
      const session = sessions.get(String(values[0]));
      return { rows: session ? [session] : [] };
    }
    throw new Error(`Unexpected pool query in synthetic test: ${text}`);
  };
  poolWithMock.connect = async () => {
    connectionCount += 1;
    let locked = false;
    let releaseLock: (() => void) | undefined;
    let previousStatus: string | undefined;
    let historyLengthBefore = 0;
    let auditsLengthBefore = 0;
    let capabilitiesBefore: typeof capabilities = [];
    let cyclesBefore: typeof cycles = [];

    return {
      async query(text, values = []) {
        if (text === 'BEGIN') return { rows: [] };
        if (text === 'ROLLBACK') {
          if (locked) {
            if (previousStatus !== undefined) institution.account_status = previousStatus;
            history.splice(historyLengthBefore);
            audits.splice(auditsLengthBefore);
            capabilities.splice(0, capabilities.length, ...capabilitiesBefore.map((entry) => ({ ...entry })));
            cycles.splice(0, cycles.length, ...cyclesBefore.map((entry) => ({ ...entry })));
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
          historyLengthBefore = history.length;
          auditsLengthBefore = audits.length;
          capabilitiesBefore = capabilities.map((entry) => ({ ...entry }));
          cyclesBefore = cycles.map((entry) => ({ ...entry }));
          return {
            rows: values[0] === institution.id
              ? [{ id: institution.id, account_status: institution.account_status }]
              : [],
          };
        }
        if (text.includes('UPDATE users SET account_status')) {
          if (institution.account_status !== 'pending' || values[0] !== institution.id) return { rows: [] };
          institution.account_status = String(values[1]);
          return { rows: [{ ...institution }] };
        }
        if (text.includes('INSERT INTO institute_status_history')) {
          if (options.failHistoryInsert) throw new Error('Synthetic audit insert failure.');
          history.push({
            id: values[0],
            institution_id: values[1],
            previous_status: values[2],
            new_status: values[3],
            reviewer_user_id: values[4],
            decision_reason: values[5],
            decision_at: fixedDecisionAt,
          });
          return { rows: [] };
        }
        if (text === AUDIT_INSERT_SQL) {
          audits.push({ action: String(values[1]), organizationId: values[7], metadata: JSON.parse(String(values[10])) });
          return { rows: [] };
        }
        if (text.includes('to_regclass')) {
          return {
            rows: [{
              capabilities_table: options.submissionSchemaInstalled === false ? null : 'institution_submission_capabilities',
              cycles_table: options.submissionSchemaInstalled === false ? null : 'institution_submission_cycles',
            }],
          };
        }
        if (text.includes('UPDATE institution_submission_capabilities')) {
          if (options.failCapabilityRevocation) throw new Error('Synthetic capability revocation failure.');
          for (const capability of capabilities) {
            if (capability.institution_id === values[0] && capability.revoked_at === null) {
              capability.revoked_at = fixedDecisionAt;
            }
          }
          return { rows: [] };
        }
        if (text.includes('UPDATE institution_submission_cycles')) {
          for (const cycle of cycles) {
            if (cycle.institution_id === values[0] && cycle.status === 'open') {
              cycle.status = 'closed';
              cycle.closed_at = fixedDecisionAt;
            }
          }
          return { rows: [] };
        }
        throw new Error(`Unexpected transaction query in synthetic test: ${text}`);
      },
      release() {},
    };
  };

  return {
    institution,
    history,
    audits,
    capabilities,
    cycles,
    get connectionCount() { return connectionCount; },
    restore() {
      poolWithMock.query = originalQuery;
      poolWithMock.connect = originalConnect;
    },
  };
}

test('official approval and rejection record the complete decision history transactionally', async (t) => {
  const handlers = findPatchRouteHandlers('/api/admin/institutes/:id');

  for (const decision of ['approved', 'rejected'] as const) {
    await t.test(`records ${decision}`, async () => {
      const database = installSyntheticDatabase();
      try {
        const reason = `Synthetic ${decision} reason for audit`;
        const response = await invokePatchRoute(handlers, { status: decision, reason }, officialToken);
        assert.equal(response.status, 200);
        assert.deepEqual(database.history, [{
          id: database.history[0].id,
          institution_id: 'synthetic-institute',
          previous_status: 'pending',
          new_status: decision,
          reviewer_user_id: 'synthetic-official',
          decision_reason: reason,
          decision_at: fixedDecisionAt,
        }]);
        assert.equal(database.institution.account_status, decision);
        assert.deepEqual(database.audits, [{
          action: 'institution.status_changed', organizationId: 'synthetic-institute',
          metadata: { previous_status: 'pending', new_status: decision, reason_text: reason },
        }], 'one A-11 audit row, in the same transaction');
        assert.ok(database.capabilities[0].revoked_at instanceof Date);
        assert.equal(database.cycles[0].status, 'closed');
        assert.ok(database.cycles[0].closed_at instanceof Date);
        assert.deepEqual(Object.keys(response.body as object), ['institute']);
        assert.equal(database.connectionCount, 1);
      } finally {
        database.restore();
      }
    });
  }
});

test('approval remains available before optional submission migrations are installed', async () => {
  const database = installSyntheticDatabase({ submissionSchemaInstalled: false });
  try {
    const response = await invokePatchRoute(
      findPatchRouteHandlers('/api/admin/institutes/:id'),
      { status: 'approved', reason: 'Synthetic approval without optional schema' },
      officialToken,
    );
    assert.equal(response.status, 200);
    assert.equal(database.institution.account_status, 'approved');
    assert.equal(database.capabilities[0].revoked_at, null);
    assert.equal(database.cycles[0].status, 'open');
  } finally {
    database.restore();
  }
});

test('capability revocation failure rolls back the institution decision and audit history', async () => {
  const database = installSyntheticDatabase({ failCapabilityRevocation: true });
  try {
    await assert.rejects(
      invokePatchRoute(
        findPatchRouteHandlers('/api/admin/institutes/:id'),
        { status: 'approved', reason: 'Synthetic approval requires transaction rollback' },
        officialToken,
      ),
      /Synthetic capability revocation failure/,
    );
    assert.equal(database.institution.account_status, 'pending');
    assert.equal(database.history.length, 0);
    assert.equal(database.audits.length, 0, 'the A-11 audit row rolls back with the decision');
    assert.equal(database.capabilities[0].revoked_at, null);
    assert.equal(database.cycles[0].status, 'open');
  } finally {
    database.restore();
  }
});

test('concurrent official decisions produce one decision and one audit row', async () => {
  const database = installSyntheticDatabase();
  try {
    const handlers = findPatchRouteHandlers('/api/admin/institutes/:id');
    const [first, second] = await Promise.all([
      invokePatchRoute(handlers, { status: 'approved', reason: 'First synthetic approval decision' }, officialToken),
      invokePatchRoute(handlers, { status: 'rejected', reason: 'Second synthetic rejection decision' }, officialToken),
    ]);

    assert.deepEqual([first.status, second.status].sort(), [200, 404]);
    assert.equal(database.history.length, 1);
    assert.equal(database.institution.account_status, database.history[0].new_status);
  } finally {
    database.restore();
  }
});

test('audit insert failure rolls back the institution status update', async () => {
  const database = installSyntheticDatabase({ failHistoryInsert: true });
  try {
    const handlers = findPatchRouteHandlers('/api/admin/institutes/:id');
    await assert.rejects(
      invokePatchRoute(
        handlers,
        { status: 'approved', reason: 'Synthetic approval with audit failure' },
        officialToken,
      ),
      /Synthetic audit insert failure/,
    );
    assert.equal(database.institution.account_status, 'pending');
    assert.deepEqual(database.history, []);
  } finally {
    database.restore();
  }
});

test('unauthenticated and wrong-role requests cannot decide an institution request', async () => {
  const database = installSyntheticDatabase();
  try {
    const handlers = findPatchRouteHandlers('/api/admin/institutes/:id');
    const body = { status: 'approved', reason: 'Synthetic valid approval reason' };
    const unauthenticated = await invokePatchRoute(handlers, body);
    const wrongRole = await invokePatchRoute(handlers, body, candidateToken);

    assert.equal(unauthenticated.status, 401);
    assert.equal(wrongRole.status, 403);
    assert.equal(database.connectionCount, 0);
    assert.deepEqual(database.history, []);
    assert.equal(database.institution.account_status, 'pending');
  } finally {
    database.restore();
  }
});

test('decision reason is required and public routes do not expose internal history', async () => {
  const database = installSyntheticDatabase();
  try {
    const handlers = findPatchRouteHandlers('/api/admin/institutes/:id');
    const invalid = await invokePatchRoute(handlers, { status: 'approved', reason: 'short' }, officialToken);
    assert.equal(invalid.status, 400);
    assert.equal(database.connectionCount, 0);

    const router = (app as unknown as { _router: { stack: ExpressRouteLayer[] } })._router;
    const exposedHistoryRoute = router.stack
      .map((layer) => layer.route)
      .some((route) => route && (Array.isArray(route.path) ? route.path : [route.path])
        .some((path) => String(path).includes('institute-status-history')));
    assert.equal(exposedHistoryRoute, false);

    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS institute_status_history/);
    assert.match(schema, /BEFORE UPDATE OR DELETE ON institute_status_history/);
    assert.match(schema, /BEFORE TRUNCATE ON institute_status_history/);
    assert.match(schema, /decision_reason text NOT NULL CHECK \(char_length\(btrim\(decision_reason\)\) BETWEEN 10 AND 1000\)/);
    assert.deepEqual(database.history, []);
  } finally {
    database.restore();
  }
});
