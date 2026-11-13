// P1-B public institute forms privacy and expiry (A-1 decisions U2 and U6).
//
// Unit tests only: the SQL text is checked statically and the route runs against a fake pool. They
// do not prove PostgreSQL date semantics; the inclusive Asia/Kolkata boundary needs a disposable
// PostgreSQL test (not run in this phase).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestHandler, Response } from 'express';

process.env.DOTENV_CONFIG_PATH ??= '/dev/null';
process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:1/p1b_public_forms_tests';

const [{ app, PUBLIC_INSTITUTE_FORMS_SQL, PUBLIC_INSTITUTE_FORM_FIELDS, toPublicInstituteForm }, { pool }] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
]);

const normalized = PUBLIC_INSTITUTE_FORMS_SQL.replace(/\s+/g, ' ');

test('SQL: no contact email or other account contact data is selected', () => {
  assert.doesNotMatch(PUBLIC_INSTITUTE_FORMS_SQL, /contact_email/i);
  for (const column of ['registration_number', 'registered_address', 'website', 'login_id', 'password_hash', 'u\\.id', 'reviewed_by', 'f\\.status', 'institute_id']) {
    assert.doesNotMatch(normalized.split(' FROM ')[0], new RegExp(column, 'i'), `${column} is not selected`);
  }
});

test('SQL: approved forms of approved institutions only (existing filters preserved)', () => {
  assert.match(normalized, /WHERE f\.status = 'approved' AND u\.account_status = 'approved'/);
  assert.match(normalized, /JOIN users u ON u\.id = f\.institute_id/);
  assert.match(normalized, /ORDER BY f\.created_at DESC LIMIT 200/);
});

test('SQL: expired forms excluded; deadline day inclusive in Asia/Kolkata; NULL deadline eligible', () => {
  assert.match(normalized, /AND \(f\.application_deadline IS NULL OR f\.application_deadline >= \(now\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date\)/);
  assert.doesNotMatch(normalized, /application_deadline > \(/, 'not an exclusive comparison');
  assert.doesNotMatch(normalized, /CURRENT_DATE/i, 'not the database session time zone');
});

test('allow-list: exactly the fields the existing frontend reads', () => {
  assert.deepEqual([...PUBLIC_INSTITUTE_FORM_FIELDS], [
    'id', 'form_type', 'title', 'description', 'eligibility', 'application_deadline', 'external_url', 'created_at', 'institute_name',
  ]);
  assert.ok(Object.isFrozen(PUBLIC_INSTITUTE_FORM_FIELDS));
});

const FAKE_ROW = {
  id: 'form-1',
  form_type: 'exam_application',
  title: 'Synthetic form',
  description: 'Synthetic description',
  eligibility: 'Synthetic eligibility',
  application_deadline: '2026-12-01',
  external_url: 'https://forms.example.test/apply',
  created_at: '2026-11-01T00:00:00.000Z',
  institute_name: 'Synthetic Institute',
  contact_email: 'contact@institute.example.test',
  registration_number: 'REG-1',
  login_id: 'INST-1',
  status: 'approved',
  institute_id: 'institution-1',
};

test('mapper: a row with contact_email and other fields returns only allow-listed keys', () => {
  const mapped = toPublicInstituteForm(FAKE_ROW);
  assert.deepEqual(Object.keys(mapped), [...PUBLIC_INSTITUTE_FORM_FIELDS]);
  assert.equal('contact_email' in mapped, false);
  assert.ok(!JSON.stringify(mapped).includes('contact@institute.example.test'));
  assert.equal(mapped.application_deadline, '2026-12-01');
  // Missing optional values become null rather than disappearing.
  assert.equal(toPublicInstituteForm({ id: 'form-2' }).external_url, null);
});

test('route: the public response never contains contact_email, even if the database returned it', async () => {
  const route = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } })
    ._router.stack.find((layer) => layer.route?.path === '/api/institute-forms' && layer.route.methods.get)?.route;
  assert.ok(route);
  const mutablePool = pool as unknown as { query: (text: string, values?: unknown[]) => Promise<unknown> };
  const original = mutablePool.query;
  const seen: string[] = [];
  mutablePool.query = async (text: string) => {
    seen.push(text);
    return { rows: [FAKE_ROW], rowCount: 1 };
  };
  try {
    const body = await new Promise<unknown>((resolve, reject) => {
      route.stack[0].handle({} as never, {
        status() { return this; },
        json(value: unknown) { resolve(value); return this; },
      } as unknown as Response, (error?: unknown) => (error ? reject(error) : resolve(undefined)));
    });
    assert.deepEqual(seen, [PUBLIC_INSTITUTE_FORMS_SQL]);
    const forms = (body as { forms: Array<Record<string, unknown>> }).forms;
    assert.equal(forms.length, 1);
    assert.deepEqual(Object.keys(forms[0]), [...PUBLIC_INSTITUTE_FORM_FIELDS]);
    assert.ok(!JSON.stringify(body).includes('contact_email'));
    assert.ok(!JSON.stringify(body).includes('contact@institute.example.test'));
  } finally {
    mutablePool.query = original;
  }
});
