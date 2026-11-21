import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { expectedOrigin, type Surface } from './surface.js';
import { VERIFIED_PORTAL_SESSION } from './authTestSupport.js';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';

const [{ app }, { pool }, { hashSessionToken, requireSuperAdmin, setTrustedRequestSurface }] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
]);

const candidateAToken = 'A'.repeat(43);
const candidateBToken = 'B'.repeat(43);
const centerToken = 'C'.repeat(43);
const ordinaryOfficialToken = 'D'.repeat(43);
const superAdminToken = 'E'.repeat(43);
const scorecard = {
  candidateName: 'Candidate B private record',
  digitalVerificationCode: 'PRIVATE-SCORECARD-CODE',
};

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

function findGetRouteHandlers(path: string): RequestHandler[] {
  const router = (app as unknown as { _router: { stack: ExpressRouteLayer[] } })._router;
  const route = router.stack
    .map((layer) => layer.route)
    .find((entry) => entry?.methods.get
      && (Array.isArray(entry.path) ? entry.path : [entry.path]).includes(path));
  assert.ok(route, `Expected GET route ${path} to be registered`);
  return route.stack.map((layer) => layer.handle);
}

test('sensitive data export requires the Super Admin permission middleware', () => {
  const handlers = findGetRouteHandlers('/api/admin/data-export');

  assert.equal(handlers[2], requireSuperAdmin);
});

// P1-B: these route-stack tests bypass the app-level surface enforcement, so each fake request
// carries the server-controlled surface that its account's role belongs to (candidate → Exam,
// center → Institution, official → Admin), set through the same trusted setter the gate uses.
function trustSurface(request: object, surface: Surface): void {
  setTrustedRequestSurface(request, surface, expectedOrigin(surface));
}

function surfaceForToken(token: string | undefined, fallback: Surface): Surface {
  if (token === candidateAToken || token === candidateBToken) return 'exam';
  if (token === centerToken) return 'institution';
  if (token === ordinaryOfficialToken || token === superAdminToken) return 'admin';
  return fallback;
}

function invokeGetRoute(
  handlers: RequestHandler[],
  token?: string,
): Promise<{ status: number; contentType?: string; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let contentType: string | undefined;
    let settled = false;
    let handlerIndex = 0;
    const request = {
      headers: token ? { cookie: `elt_session=${token}` } : {},
    } as unknown as Request;
    trustSurface(request, surfaceForToken(token, 'admin'));
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        settled = true;
        resolve({ status, contentType, body });
        return this;
      },
      type(value: string) {
        contentType = value;
        return this;
      },
      set(name: string, value: string) {
        if (name.toLowerCase() === 'content-type') contentType = value;
        return this;
      },
      setHeader(name: string, value: string) {
        if (name.toLowerCase() === 'content-type') contentType = value;
        return this;
      },
      send(body: unknown) {
        settled = true;
        resolve({ status, contentType, body });
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

test('sensitive data export enforces authentication and Super Admin permission', async (t) => {
  const handlers = findGetRouteHandlers('/api/admin/data-export');
  const sessions = new Map([
    [hashSessionToken(ordinaryOfficialToken), {
      id: 'ordinary-official',
      login_id: 'OFFICIAL-TEST',
      display_name: 'Synthetic Official',
      role: 'official',
      account_status: 'approved',
      is_super_admin: false, ...VERIFIED_PORTAL_SESSION,
    }],
    [hashSessionToken(superAdminToken), {
      id: 'approved-super-admin',
      login_id: 'SUPER-ADMIN-TEST',
      display_name: 'Synthetic Super Admin',
      role: 'official',
      account_status: 'approved',
      is_super_admin: true, ...VERIFIED_PORTAL_SESSION,
    }],
  ]);
  const poolWithMock = pool as unknown as {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  const originalQuery = poolWithMock.query.bind(pool);
  const exportQueries: string[] = [];
  poolWithMock.query = async (text, values = []) => {
    if (text.includes('FROM auth_sessions s')) {
      const session = sessions.get(String(values[0]));
      return { rows: session ? [session] : [] };
    }

    exportQueries.push(text);
    return { rows: [] };
  };

  try {
    await t.test('unauthenticated requests return 401 without running export queries', async () => {
      exportQueries.length = 0;
      const response = await invokeGetRoute(handlers);

      assert.equal(response.status, 401);
      assert.equal(exportQueries.length, 0);
    });

    await t.test('ordinary approved officials return 403 without running export queries', async () => {
      exportQueries.length = 0;
      const response = await invokeGetRoute(handlers, ordinaryOfficialToken);

      assert.equal(response.status, 403);
      assert.equal(exportQueries.length, 0);
    });

    await t.test('approved Super Admins receive an XLSX export', async () => {
      exportQueries.length = 0;
      const response = await invokeGetRoute(handlers, superAdminToken);

      assert.equal(response.status, 200);
      assert.equal(
        response.contentType,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      assert.ok(Buffer.isBuffer(response.body));
      assert.equal((response.body as Buffer).subarray(0, 2).toString(), 'PK');
      assert.equal(exportQueries.length, 12);
    });
  } finally {
    poolWithMock.query = originalQuery;
  }
});

function invokePostRoute(
  handlers: RequestHandler[],
  body: Record<string, string>,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    const request = {
      headers: token ? { cookie: `elt_session=${token}` } : {},
      body,
    } as unknown as Request;
    trustSurface(request, surfaceForToken(token, 'exam'));
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
      set() {
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
      if (!handler) {
        return;
      }

      try {
        const result = (handler as unknown as (
          request: Request,
          response: Response,
          next: NextFunction,
        ) => unknown)(request, response, next);
        if (result instanceof Promise) {
          void result.catch(next);
        }
      } catch (handlerError) {
        next(handlerError);
      }
    };

    next();
  });
}

test('candidate admit-card and result lookups enforce session role and ownership', async (t) => {
  const sessions = new Map([
    [hashSessionToken(candidateAToken), {
      id: 'candidate-a',
      login_id: 'CANDIDATE-A',
      display_name: 'Candidate A',
      role: 'candidate',
      account_status: 'approved',
      ...VERIFIED_PORTAL_SESSION,
    }],
    [hashSessionToken(candidateBToken), {
      id: 'candidate-b',
      login_id: 'CANDIDATE-B',
      display_name: 'Candidate B',
      role: 'candidate',
      account_status: 'approved',
      ...VERIFIED_PORTAL_SESSION,
    }],
    [hashSessionToken(centerToken), {
      id: 'center-a',
      login_id: 'CENTER-A',
      display_name: 'Center A',
      role: 'center',
      account_status: 'approved',
      ...VERIFIED_PORTAL_SESSION,
    }],
  ]);
  const poolWithMock = pool as unknown as {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  const originalQuery = poolWithMock.query.bind(pool);
  poolWithMock.query = async (text, values = []) => {
    if (text.includes('FROM auth_sessions s')) {
      const session = sessions.get(String(values[0]));
      return { rows: session ? [session] : [] };
    }

    if (text.includes('JOIN admit_cards c ON c.application_id = a.id')) {
      const [userId, applicationNumber, examCode] = values;
      if (userId === 'candidate-b' && applicationNumber === 'APP-B' && examCode === 'ENT-2025') {
        return {
          rows: [{
            application_number: 'APP-B',
            candidate_name: 'Candidate B',
            father_name: 'Parent B',
            date_of_birth: '2000-01-02',
            gender: 'Other',
            category: 'General',
            exam_code: 'ENT-2025',
            roll_number: 'ROLL-B',
            exam_date: '2025-11-01',
            reporting_time: '09:00',
            gate_closing_time: '09:30',
            exam_timing: '10:00',
            center_code: 'CENTER-B',
            center_name: 'Center B',
            center_address: 'Address B',
          }],
        };
      }
      return { rows: [] };
    }

    if (text.includes('FROM published_results r')) {
      const [userId, identifier, dateOfBirth, examCode] = values;
      if (
        userId === 'candidate-b'
        && (identifier === 'APP-B' || identifier === 'ROLL-B')
        && dateOfBirth === '2000-01-02'
        && examCode === 'ENT-2025'
      ) {
        return { rows: [{ scorecard }] };
      }
      return { rows: [] };
    }

    throw new Error(`Unexpected query in lookup security test: ${text}`);
  };

  const admitHandlers = findPostRouteHandlers('/api/candidate/admit-cards/lookup');
  const legacyAdmitHandlers = findPostRouteHandlers('/api/admit-cards/lookup');
  const resultHandlers = findPostRouteHandlers('/api/candidate/results/lookup');
  const legacyResultHandlers = findPostRouteHandlers('/api/results/lookup');

  try {
    await t.test('unauthenticated legacy and candidate lookup routes return 401 without data', async () => {
      for (const [handlers, body] of [
        [legacyAdmitHandlers, { applicationNumber: 'APP-B', examCode: 'ENT-2025' }],
        [admitHandlers, { applicationNumber: 'APP-B', examCode: 'ENT-2025' }],
        [legacyResultHandlers, { identifier: 'APP-B', dateOfBirth: '2000-01-02', examCode: 'ENT-2025' }],
        [resultHandlers, { identifier: 'APP-B', dateOfBirth: '2000-01-02', examCode: 'ENT-2025' }],
      ] as const) {
        const response = await invokePostRoute(handlers, body);
        const responseBody = JSON.stringify(response.body);
        assert.equal(response.status, 401);
        assert.doesNotMatch(responseBody, /Candidate B private record|PRIVATE-SCORECARD-CODE|ROLL-B/);
      }
    });

    await t.test('wrong-role requests return 403 without sensitive data', async () => {
      const admitResponse = await invokePostRoute(
        admitHandlers,
        { applicationNumber: 'APP-B', examCode: 'ENT-2025' },
        centerToken,
      );
      assert.equal(admitResponse.status, 403);
      assert.doesNotMatch(JSON.stringify(admitResponse.body), /Candidate B|ROLL-B/);

      const resultResponse = await invokePostRoute(
        resultHandlers,
        { identifier: 'APP-B', dateOfBirth: '2000-01-02', examCode: 'ENT-2025' },
        centerToken,
      );
      assert.equal(resultResponse.status, 403);
      assert.doesNotMatch(JSON.stringify(resultResponse.body), /Candidate B private record|PRIVATE-SCORECARD-CODE/);
    });

    await t.test('candidate A cannot retrieve candidate B admit card or scorecard', async () => {
      const admitResponse = await invokePostRoute(
        admitHandlers,
        { applicationNumber: 'APP-B', examCode: 'ENT-2025' },
        candidateAToken,
      );
      assert.equal(admitResponse.status, 404);
      assert.doesNotMatch(JSON.stringify(admitResponse.body), /Candidate B|ROLL-B/);

      const resultResponse = await invokePostRoute(
        resultHandlers,
        { identifier: 'APP-B', dateOfBirth: '2000-01-02', examCode: 'ENT-2025' },
        candidateAToken,
      );
      assert.equal(resultResponse.status, 404);
      assert.doesNotMatch(JSON.stringify(resultResponse.body), /Candidate B private record|PRIVATE-SCORECARD-CODE/);
    });

    await t.test('candidate can retrieve their own admit card and published result', async () => {
      const admitResponse = await invokePostRoute(
        admitHandlers,
        { applicationNumber: 'APP-B', examCode: 'ENT-2025' },
        candidateBToken,
      );
      assert.equal(admitResponse.status, 200);
      assert.deepEqual(
        (admitResponse.body as { admitCard: { rollNumber: string } }).admitCard.rollNumber,
        'ROLL-B',
      );

      const resultResponse = await invokePostRoute(
        resultHandlers,
        { identifier: 'ROLL-B', dateOfBirth: '2000-01-02', examCode: 'ENT-2025' },
        candidateBToken,
      );
      assert.equal(resultResponse.status, 200);
      assert.deepEqual(
        (resultResponse.body as { scorecard: typeof scorecard }).scorecard,
        scorecard,
      );
    });
  } finally {
    poolWithMock.query = originalQuery;
  }
});
