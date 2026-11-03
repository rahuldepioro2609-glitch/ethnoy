import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:5432/test';

const [{ app }, { pool }, { hashSessionToken }] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
]);

const officialToken = 'O'.repeat(43);

interface ExpressRouteLayer {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
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

function invokeGetRoute(handlers: RequestHandler[], token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    const request = {
      headers: { cookie: `elt_session=${token}` },
    } as unknown as Request;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        settled = true;
        resolve({ status, body });
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
      const result = (handler as unknown as (
        request: Request,
        response: Response,
        next: NextFunction,
      ) => unknown)(request, response, next);
      if (result instanceof Promise) void result.catch(next);
    };

    next();
  });
}

test('official dashboard totals count only published results and are not list-limited', async () => {
  const handlers = findGetRouteHandlers('/api/admin/dashboard-stats');
  const sessions = new Map([
    [hashSessionToken(officialToken), {
      id: 'synthetic-official',
      login_id: 'SYNTHETIC-OFFICIAL',
      display_name: 'Synthetic Official',
      role: 'official',
      account_status: 'approved',
      is_super_admin: false,
    }],
  ]);
  const publishedResults = [
    { is_published: true },
    { is_published: false },
    { is_published: true },
  ];
  const poolWithMock = pool as unknown as {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  const originalQuery = poolWithMock.query.bind(pool);
  let aggregateSql = '';
  poolWithMock.query = async (text, values = []) => {
    if (text.includes('FROM auth_sessions s')) {
      const session = sessions.get(String(values[0]));
      return { rows: session ? [session] : [] };
    }

    aggregateSql = text;
    return {
      rows: [{
        applications: '812',
        open_helpdesk: '7',
        mock_exam_attempts: '1201',
        published_results: String(publishedResults.filter((result) => result.is_published).length),
      }],
    };
  };

  try {
    const response = await invokeGetRoute(handlers, officialToken);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      stats: {
        applications: 812,
        openHelpdesk: 7,
        mockExamAttempts: 1201,
        publishedResults: 2,
      },
    });
    assert.match(aggregateSql, /count\(\*\) FROM published_results WHERE is_published = true/i);
    assert.doesNotMatch(aggregateSql, /LIMIT\s+500/i);
  } finally {
    poolWithMock.query = originalQuery;
  }
});
