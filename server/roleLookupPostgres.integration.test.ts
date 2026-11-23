import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const TEST_DATABASE = 'eltnoy_security_test';
const integrationEnabled = process.env.ELTNOY_SECURITY_INTEGRATION === '1';

let closePool: (() => Promise<void>) | undefined;

after(async () => {
  await closePool?.();
});

interface ExpressRouteLayer {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
}

function routeHandlers(app: { _router: { stack: ExpressRouteLayer[] } }, path: string): RequestHandler[] {
  const route = app._router.stack
    .map((layer) => layer.route)
    .find((entry) => entry?.methods.post
      && (Array.isArray(entry.path) ? entry.path : [entry.path]).includes(path));
  assert.ok(route, `Expected POST route ${path} to be registered`);
  return route.stack.map((layer) => layer.handle);
}

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

test('PostgreSQL candidate lookups enforce cross-candidate ownership', {
  skip: !integrationEnabled,
}, async (t) => {
  const dockerTestMode = process.env.ELTNOY_SECURITY_DOCKER_TEST === '1';
  if (dockerTestMode) {
    assert.equal(process.env.DATABASE_SSL, 'true');
    assert.equal(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED, 'true');
  } else {
    assert.equal(process.env.DATABASE_SSL, 'false');
  }
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'The isolated integration runner must provide DATABASE_URL');
  const url = new URL(databaseUrl);
  assert.ok(dockerTestMode
    ? url.hostname === 'postgres'
    : ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname),
  'Integration tests may only connect to a local PostgreSQL server or explicitly enabled Docker postgres service');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), TEST_DATABASE);

  const [{ app }, { pool }, { hashSessionToken, newSessionToken }] = await Promise.all([
    import('./index.js'),
    import('./db.js'),
    import('./auth.js'),
  ]);
  closePool = () => pool.end();

  const fixtureClient = await pool.connect();
  let transactionOpen = false;
  const assertTestDatabase = async () => {
    const { rows } = await fixtureClient.query<{ database: string }>(
      'SELECT current_database() AS database',
    );
    assert.equal(rows[0]?.database, TEST_DATABASE, 'Refusing fixture writes outside the disposable database');
  };

  const suffix = randomUUID().toUpperCase();
  const examCode = 'SECURITY-TEST';
  const applicationExamCode = `SEC-APP-${suffix.slice(0, 8)}`;
  const candidateA = {
    id: randomUUID(),
    loginId: `SECURITY-A-${suffix}`,
    name: 'Synthetic Candidate A',
    token: newSessionToken(),
    applicationId: randomUUID(),
    applicationNumber: `SEC-A-${suffix}`,
    rollNumber: `SEC-ROLL-A-${suffix}`,
    email: `candidate-a-${suffix}@example.invalid`,
    privateMarker: `synthetic-private-a-${suffix}`,
  };
  const candidateB = {
    id: randomUUID(),
    loginId: `SECURITY-B-${suffix}`,
    name: 'Synthetic Candidate B',
    token: newSessionToken(),
    applicationId: randomUUID(),
    applicationNumber: `SEC-B-${suffix}`,
    rollNumber: `SEC-ROLL-B-${suffix}`,
    email: `candidate-b-${suffix}@example.invalid`,
    privateMarker: `synthetic-private-b-${suffix}`,
  };
  const center = {
    id: randomUUID(),
    loginId: `SECURITY-CENTER-${suffix}`,
    name: 'Synthetic Wrong-Role Center',
    token: newSessionToken(),
  };

  try {
    await assertTestDatabase();
    await fixtureClient.query('BEGIN');
    transactionOpen = true;

    for (const candidate of [candidateA, candidateB, center]) {
      await assertTestDatabase();
      await fixtureClient.query(
        `INSERT INTO users (id, login_id, display_name, role, password_hash, account_status)
         VALUES ($1, $2, $3, $4, $5, 'approved')`,
        [
          candidate.id,
          candidate.loginId,
          candidate.name,
          candidate === center ? 'center' : 'candidate',
          'unused-synthetic-test-password-hash',
        ],
      );
    }

    for (const candidate of [candidateA, candidateB, center]) {
      await assertTestDatabase();
      await fixtureClient.query(
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [hashSessionToken(candidate.token), candidate.id],
      );
    }

    await assertTestDatabase();
    await fixtureClient.query(
      `INSERT INTO exams
       (id, code, name, category, target_audience, registration_start, registration_end, exam_date,
        time_zone, fee, duration, mode, shifts, is_published)
       VALUES ($1, $2, 'Synthetic Application Security Exam', 'Professional', 'Synthetic audience',
               (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date - 1,
               (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date + 1,
               (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date + 30,
               'Asia/Kolkata', '0', '60 minutes', 'Online', 'Morning', true)`,
      [randomUUID(), applicationExamCode],
    );

    for (const candidate of [candidateA, candidateB]) {
      await assertTestDatabase();
      await fixtureClient.query(
        `INSERT INTO applications
         (id, user_id, application_number, exam_code, candidate_name, father_name, date_of_birth,
          gender, category, email, phone, first_city_preference, second_city_preference, language_medium)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Other', 'General', $8, $9, $10, $11, $12)`,
        [
          candidate.applicationId,
          candidate.id,
          candidate.applicationNumber,
          examCode,
          candidate.name,
          'Synthetic Parent',
          '2000-01-01',
          candidate.email,
          '0000000000',
          'Synthetic City A',
          'Synthetic City B',
          'English',
        ],
      );
    }

    for (const candidate of [candidateA, candidateB]) {
      await assertTestDatabase();
      await fixtureClient.query(
        `INSERT INTO admit_cards
         (application_id, roll_number, exam_date, reporting_time, gate_closing_time, exam_timing,
          center_code, center_name, center_address)
         VALUES ($1, $2, '2099-01-01', '09:00', '09:30', '10:00', 'SYNTHETIC-CENTER',
                 'Synthetic Test Center', 'Synthetic Test Address')`,
        [candidate.applicationId, candidate.rollNumber],
      );
    }

    for (const candidate of [candidateA, candidateB]) {
      await assertTestDatabase();
      const scorecard = {
        candidateName: candidate.name,
        applicationNumber: candidate.applicationNumber,
        rollNumber: candidate.rollNumber,
        examCode,
        dob: '2000-01-01',
        privateMarker: candidate.privateMarker,
      };
      await fixtureClient.query(
        `INSERT INTO published_results
         (id, application_number, roll_number, exam_code, date_of_birth, scorecard, is_published)
         VALUES ($1, $2, $3, $4, '2000-01-01', $5, true)`,
        [
          randomUUID(),
          candidate.applicationNumber,
          candidate.rollNumber,
          examCode,
          JSON.stringify(scorecard),
        ],
      );
    }

    await assertTestDatabase();
    await fixtureClient.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await fixtureClient.query('ROLLBACK');
    throw error;
  } finally {
    fixtureClient.release();
  }

  const admitHandlers = routeHandlers(app as unknown as { _router: { stack: ExpressRouteLayer[] } },
    '/api/candidate/admit-cards/lookup');
  const resultHandlers = routeHandlers(app as unknown as { _router: { stack: ExpressRouteLayer[] } },
    '/api/candidate/results/lookup');
  const applicationHandlers = routeHandlers(app as unknown as { _router: { stack: ExpressRouteLayer[] } },
    '/api/applications');
  const applicationTestHandlers = [
    applicationHandlers[0],
    applicationHandlers[1],
    applicationHandlers.at(-1)!,
  ];
  const sensitiveValues = [
    candidateA.name,
    candidateA.email,
    candidateA.privateMarker,
    candidateB.name,
    candidateB.email,
    candidateB.privateMarker,
    candidateA.applicationNumber,
    candidateA.rollNumber,
    candidateB.applicationNumber,
    candidateB.rollNumber,
  ];

  async function checkAdmitCard(candidate: typeof candidateA, token: string) {
    return invokePostRoute(admitHandlers, {
      applicationNumber: candidate.applicationNumber,
      examCode,
    }, token);
  }

  async function checkResult(candidate: typeof candidateA, token: string) {
    return invokePostRoute(resultHandlers, {
      identifier: candidate.applicationNumber,
      dateOfBirth: '2000-01-01',
      examCode,
    }, token);
  }

  function applicationBody(candidate: typeof candidateA): Record<string, string> {
    return {
      examCode: applicationExamCode,
      candidateName: candidate.name,
      fatherName: 'Synthetic Parent',
      dateOfBirth: '2000-01-01',
      gender: 'Other',
      category: 'General',
      email: candidate.email,
      phone: '0000000000',
      firstCityPreference: 'Synthetic City A',
      secondCityPreference: 'Synthetic City B',
      languageMedium: 'English',
    };
  }

  async function assertTestPoolDatabase() {
    const { rows } = await pool.query<{ database: string }>(
      'SELECT current_database() AS database',
    );
    assert.equal(rows[0]?.database, TEST_DATABASE, 'Refusing application fixture writes outside the disposable database');
  }

  function assertNoSensitiveData(body: unknown) {
    const serialized = JSON.stringify(body);
    for (const value of sensitiveValues) assert.ok(!serialized.includes(value));
    assert.ok(!serialized.includes('"scorecard"'));
  }

  await t.test('application submission rechecks current exam publication and registration dates', async () => {
    await assertTestPoolDatabase();
    await pool.query('UPDATE exams SET is_published = false WHERE code = $1', [applicationExamCode]);
    const unpublished = await invokePostRoute(
      applicationTestHandlers,
      applicationBody(candidateB),
      candidateB.token,
    );
    assert.equal(unpublished.status, 400);

    await assertTestPoolDatabase();
    await pool.query(
      `UPDATE exams
       SET is_published = true,
           registration_start = (clock_timestamp() AT TIME ZONE time_zone)::date + 1,
           registration_end = (clock_timestamp() AT TIME ZONE time_zone)::date + 2
       WHERE code = $1`,
      [applicationExamCode],
    );
    const beforeWindow = await invokePostRoute(
      applicationTestHandlers,
      applicationBody(candidateB),
      candidateB.token,
    );
    assert.equal(beforeWindow.status, 400);

    await assertTestPoolDatabase();
    await pool.query(
      `UPDATE exams
       SET registration_start = (clock_timestamp() AT TIME ZONE time_zone)::date - 2,
           registration_end = (clock_timestamp() AT TIME ZONE time_zone)::date - 1
       WHERE code = $1`,
      [applicationExamCode],
    );
    const afterWindow = await invokePostRoute(
      applicationTestHandlers,
      applicationBody(candidateB),
      candidateB.token,
    );
    assert.equal(afterWindow.status, 400);
  });

  await t.test('simultaneous duplicate application submissions create exactly one application', async () => {
    await assertTestPoolDatabase();
    await pool.query(
      `UPDATE exams
       SET is_published = true,
           registration_start = (clock_timestamp() AT TIME ZONE time_zone)::date - 1,
           registration_end = (clock_timestamp() AT TIME ZONE time_zone)::date + 1
       WHERE code = $1`,
      [applicationExamCode],
    );

    const responses = await Promise.all([
      invokePostRoute(applicationTestHandlers, applicationBody(candidateA), candidateA.token),
      invokePostRoute(applicationTestHandlers, applicationBody(candidateA), candidateA.token),
    ]);
    assert.deepEqual(responses.map((result) => result.status).sort(), [201, 409]);

    await assertTestPoolDatabase();
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM applications WHERE user_id = $1 AND exam_code = $2',
      [candidateA.id, applicationExamCode],
    );
    assert.equal(rows[0]?.count, '1');
  });

  await t.test('unauthenticated requests receive 401 without candidate data', async () => {
    const admitResponse = await invokePostRoute(admitHandlers, {
      applicationNumber: candidateB.applicationNumber,
      examCode,
    });
    const resultResponse = await invokePostRoute(resultHandlers, {
      identifier: candidateB.applicationNumber,
      dateOfBirth: '2000-01-01',
      examCode,
    });
    assert.equal(admitResponse.status, 401);
    assert.equal(resultResponse.status, 401);
    assertNoSensitiveData(admitResponse.body);
    assertNoSensitiveData(resultResponse.body);
  });

  await t.test('wrong-role requests receive 403 without candidate data', async () => {
    const admitResponse = await invokePostRoute(admitHandlers, {
      applicationNumber: candidateA.applicationNumber,
      examCode,
    }, center.token);
    const resultResponse = await invokePostRoute(resultHandlers, {
      identifier: candidateA.applicationNumber,
      dateOfBirth: '2000-01-01',
      examCode,
    }, center.token);
    assert.equal(admitResponse.status, 403);
    assert.equal(resultResponse.status, 403);
    assertNoSensitiveData(admitResponse.body);
    assertNoSensitiveData(resultResponse.body);
  });

  await t.test('Candidate A can access A records but not Candidate B records', async () => {
    const ownAdmit = await checkAdmitCard(candidateA, candidateA.token);
    const ownResult = await checkResult(candidateA, candidateA.token);
    assert.equal(ownAdmit.status, 200);
    assert.equal(ownResult.status, 200);
    assert.equal(
      (ownAdmit.body as { admitCard: { rollNumber: string } }).admitCard.rollNumber,
      candidateA.rollNumber,
    );
    assert.equal(
      (ownResult.body as { scorecard: { privateMarker: string } }).scorecard.privateMarker,
      candidateA.privateMarker,
    );

    const otherAdmit = await checkAdmitCard(candidateB, candidateA.token);
    const otherResult = await checkResult(candidateB, candidateA.token);
    assert.equal(otherAdmit.status, 404);
    assert.equal(otherResult.status, 404);
    assertNoSensitiveData(otherAdmit.body);
    assertNoSensitiveData(otherResult.body);
  });

  await t.test('Candidate B can access B records but not Candidate A records', async () => {
    const ownAdmit = await checkAdmitCard(candidateB, candidateB.token);
    const ownResult = await checkResult(candidateB, candidateB.token);
    assert.equal(ownAdmit.status, 200);
    assert.equal(ownResult.status, 200);
    assert.equal(
      (ownAdmit.body as { admitCard: { rollNumber: string } }).admitCard.rollNumber,
      candidateB.rollNumber,
    );
    assert.equal(
      (ownResult.body as { scorecard: { privateMarker: string } }).scorecard.privateMarker,
      candidateB.privateMarker,
    );

    const otherAdmit = await checkAdmitCard(candidateA, candidateB.token);
    const otherResult = await checkResult(candidateA, candidateB.token);
    assert.equal(otherAdmit.status, 404);
    assert.equal(otherResult.status, 404);
    assertNoSensitiveData(otherAdmit.body);
    assertNoSensitiveData(otherResult.body);
  });
});
