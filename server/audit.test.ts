// A-11 / A-12 / A-13: tests for the audit writer (server/audit.ts), the Super Admin viewer
// (server/auditRoutes.ts) and the migration's static shape. Route authorization for the viewer
// (401, 403 for candidates, centers and ordinary Officials, 200 for Super Admin) is covered by the
// route matrix in server/adminAuthorization.test.ts; the append-only triggers on a real database by
// server/databaseGrants.postgres.integration.test.ts. Synthetic data only; no database is used here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:9/audit_unit_tests';

const {
  AUDIT_CONTRACTS, AUDIT_INSERT_SQL, AuditContractError, auditActor, recordAuditEvent, runAuditedTransaction, validateAuditEvent,
} = await import('./audit.js');
const { AUDIT_WINDOW_MAX_DAYS, auditQuerySchema, buildAuditQuery, createAuditRouter } = await import('./auditRoutes.js');
const { ROUTE_POLICY } = await import('./surface.js');

const readServerFile = (name: string) => readFile(new URL(name, import.meta.url), 'utf8');
const superAdmin = { type: 'user', userId: 'synthetic-super-admin', role: 'super_admin' } as const;

// ---------------------------------------------------------------------------
// Writer: contracts and redaction
// ---------------------------------------------------------------------------

test('every contract is well formed and matches the database CHECKs', async () => {
  const sql = await readServerFile('auditEventsMigration.sql');
  const categories = /category\s+text\s+NOT NULL CHECK \(category IN \(([^)]*)\)\)/.exec(sql)?.[1].match(/'([a-z]+)'/g)?.map((v) => v.slice(1, -1)) ?? [];
  const retention = /retention_class text\s+NOT NULL CHECK \(retention_class IN \(([^)]*)\)\)/.exec(sql)?.[1].match(/'([a-z]+)'/g)?.map((v) => v.slice(1, -1)) ?? [];
  assert.ok(categories.length >= 10 && retention.length === 5);
  for (const [action, contract] of Object.entries(AUDIT_CONTRACTS)) {
    assert.match(action, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, action);
    assert.ok(action.length <= 80, action);
    assert.ok(categories.includes(contract.category), `${action}: category ${contract.category}`);
    assert.ok(retention.includes(contract.retention), `${action}: retention ${contract.retention}`);
    assert.match(contract.resourceType, /^[a-z][a-z0-9_]{0,63}$/, action);
    for (const required of (contract as { required?: readonly string[] }).required ?? []) {
      assert.ok(required in contract.metadata, `${action}: required ${required} is in the allow-list`);
    }
  }
  // Financial actions are kept in the financial retention class.
  for (const action of ['wallet.credited', 'withdrawal.requested', 'withdrawal.approved', 'withdrawal.rejected', 'withdrawal.paid'] as const) {
    assert.equal(AUDIT_CONTRACTS[action].retention, 'financial', action);
  }
});

test('no contract allows a key that looks like a secret or contact detail', () => {
  const forbidden = /(pass(word)?|otp|code_hash|token|secret|cookie|api_?key|card|cvv|upi_?pin|session|answer|response|file_content|date_of_birth|dob|email|mobile|phone)/i;
  for (const [action, contract] of Object.entries(AUDIT_CONTRACTS)) {
    for (const key of Object.keys(contract.metadata)) assert.doesNotMatch(key, forbidden, `${action}.${key}`);
  }
});

test('the writer refuses unknown actions, unknown keys, wrong types and missing required keys', () => {
  assert.throws(() => validateAuditEvent({ action: 'notice.deleted' as never, actor: superAdmin }), AuditContractError);
  assert.throws(() => validateAuditEvent({ action: 'notice.publication_changed', actor: superAdmin, metadata: { is_published: true, title: 'x' } }), /not in the contract/);
  assert.throws(() => validateAuditEvent({ action: 'notice.publication_changed', actor: superAdmin, metadata: { is_published: 'yes' } }), /must be boolean/);
  assert.throws(() => validateAuditEvent({ action: 'notice.publication_changed', actor: superAdmin }), /is_published is required/);
  assert.throws(() => validateAuditEvent({ action: 'wallet.credited', actor: superAdmin, metadata: { amount_paise: 1.5 } }), /must be integer/);
  assert.throws(() => validateAuditEvent({ action: 'admit_cards.imported', actor: superAdmin, metadata: { row_count: 1, exam_codes: [1] } }), /must be string\[\]/);
  assert.throws(() => validateAuditEvent({ action: 'notice.created', actor: { type: 'user', userId: '', role: 'official' } }), /user actor without an id/);
});

test('secret-looking keys are refused even before the contract is consulted', () => {
  for (const key of ['password', 'passwordHash', 'otp', 'otp_code', 'token', 'session_token', 'cookie', 'api_key', 'secret', 'card_number', 'cvv', 'upi_pin', 'answers', 'responses', 'file_content', 'date_of_birth', 'email', 'mobile', 'phone']) {
    assert.throws(
      () => validateAuditEvent({ action: 'notice.created', actor: superAdmin, metadata: { [key]: 'x' } }),
      /looks sensitive/, key,
    );
  }
});

test('refused or failed events need a machine reason code; succeeded events never carry one', () => {
  assert.throws(() => validateAuditEvent({ action: 'notice.created', actor: superAdmin, outcome: 'denied' }), /reason code/);
  assert.throws(() => validateAuditEvent({ action: 'notice.created', actor: superAdmin, outcome: 'failed', reasonCode: 'Not Allowed!' }), /reason code/);
  assert.equal(validateAuditEvent({ action: 'notice.created', actor: superAdmin, outcome: 'denied', reasonCode: 'maker_checker' }).reasonCode, 'maker_checker');
  assert.equal(validateAuditEvent({ action: 'notice.created', actor: superAdmin, reasonCode: 'ignored' }).reasonCode, null);
});

test('long free text and lists are bounded; null and undefined values are dropped', () => {
  const event = validateAuditEvent({
    action: 'institution.status_changed', actor: superAdmin,
    metadata: { new_status: 'approved', reason_text: 'r'.repeat(5000), previous_status: undefined },
  });
  assert.equal((event.metadata.reason_text as string).length, 500);
  assert.equal('previous_status' in event.metadata, false);
  const list = validateAuditEvent({ action: 'admit_cards.imported', actor: superAdmin, metadata: { row_count: 1, exam_codes: Array.from({ length: 80 }, (_, i) => `E${i}`) } });
  assert.equal((list.metadata.exam_codes as string[]).length, 50);
});

test('actors: Super Admin is its own role; system and operator actors match the database CHECK', () => {
  const request = (user: unknown) => ({ user }) as unknown as Request;
  assert.deepEqual(auditActor(request({ id: 'o1', role: 'official', isSuperAdmin: false })), { type: 'user', userId: 'o1', role: 'official' });
  assert.deepEqual(auditActor(request({ id: 's1', role: 'official', isSuperAdmin: true })), { type: 'user', userId: 's1', role: 'super_admin' });
  assert.deepEqual(auditActor(request({ id: 'c1', role: 'center', isSuperAdmin: false })), { type: 'user', userId: 'c1', role: 'center' });
  assert.throws(() => auditActor(request(undefined)), /without an authenticated user/);
  const system = validateAuditEvent({ action: 'notice.created', actor: { type: 'system' } });
  assert.deepEqual([system.actorType, system.actorUserId, system.actorRole], ['system', null, 'system']);
  const operator = validateAuditEvent({ action: 'notice.created', actor: { type: 'operator' } });
  assert.deepEqual([operator.actorType, operator.actorRole], ['operator', 'operator']);
});

test('recordAuditEvent writes one parameterised insert on the given client and refuses the shared pool', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = { query: async (text: string, values: unknown[] = []) => { calls.push({ text, values }); return { rows: [] }; } };
  await recordAuditEvent(client, {
    action: 'withdrawal.paid', actor: superAdmin, organizationId: 'institute-7', resourceId: 'withdrawal-9',
    metadata: { amount_paise: 150000, approver_user_id: 'synthetic-approver', transfer_reference: 'UTR-1' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, AUDIT_INSERT_SQL);
  assert.deepEqual(calls[0].values, [
    'finance', 'withdrawal.paid', 'succeeded', null, 'user', 'synthetic-super-admin', 'super_admin', 'institute-7',
    'withdrawal', 'withdrawal-9', JSON.stringify({ amount_paise: 150000, approver_user_id: 'synthetic-approver', transfer_reference: 'UTR-1' }), 'financial',
  ]);
  assert.doesNotMatch(AUDIT_INSERT_SQL, /row_hash|occurred_at|\bid\b/, 'id, time and hash are assigned by the database');
  const poolLike = { totalCount: 0, query: client.query };
  await assert.rejects(recordAuditEvent(poolLike, { action: 'notice.created', actor: superAdmin }), /transaction client, not the pool/);
  // A contract violation never reaches the database.
  await assert.rejects(recordAuditEvent(client, { action: 'notice.created', actor: superAdmin, metadata: { token: 'x' } }), AuditContractError);
  assert.equal(calls.length, 1);
});

test('runAuditedTransaction commits only when the action and its audit row both succeed (A-11)', async () => {
  const log: string[] = [];
  let released = 0;
  const pool = {
    connect: async () => ({
      query: async (text: string) => { log.push(text === AUDIT_INSERT_SQL ? 'INSERT audit' : text); if (text === AUDIT_INSERT_SQL && failAudit) throw new Error('audit insert failed'); return { rows: [] }; },
      release: () => { released += 1; },
    }),
  };
  let failAudit = false;
  await runAuditedTransaction(pool as never, async (client) => {
    await client.query('UPDATE something');
    await recordAuditEvent(client, { action: 'notice.publication_changed', actor: superAdmin, metadata: { is_published: true } });
  });
  assert.deepEqual(log, ['BEGIN', 'UPDATE something', 'INSERT audit', 'COMMIT']);
  log.length = 0;
  failAudit = true;
  await assert.rejects(runAuditedTransaction(pool as never, async (client) => {
    await client.query('UPDATE something');
    await recordAuditEvent(client, { action: 'notice.publication_changed', actor: superAdmin, metadata: { is_published: true } });
  }), /audit insert failed/);
  assert.deepEqual(log, ['BEGIN', 'UPDATE something', 'INSERT audit', 'ROLLBACK'], 'a failed audit write rolls the action back');
  assert.equal(released, 2);
});

// ---------------------------------------------------------------------------
// Migration and grants (static)
// ---------------------------------------------------------------------------

test('the migration is append-only, re-runnable, has no foreign keys or sequences, and collects no IP or user agent', async () => {
  const sql = (await readServerFile('auditEventsMigration.sql')).replace(/--[^\n]*/g, '');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS audit_events/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON audit_events\s+FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation/);
  assert.match(sql, /BEFORE TRUNCATE ON audit_events\s+FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation/);
  assert.match(sql, /BEFORE INSERT ON audit_events\s+FOR EACH ROW EXECUTE FUNCTION audit_events_set_row_hash/);
  assert.doesNotMatch(sql, /REFERENCES/i, 'no foreign keys: a cascade would modify audit rows');
  assert.doesNotMatch(sql, /IDENTITY|SERIAL|CREATE SEQUENCE/i, 'the grants manifest has no sequences');
  assert.doesNotMatch(sql, /source_ip|user_agent|\binet\b/i, 'OD-3: IP and user agent are not collected');
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE audit_events\b/i);
  for (const statement of sql.match(/CREATE (?:TABLE|INDEX|TRIGGER|OR REPLACE FUNCTION)[^;]*/g) ?? []) {
    assert.ok(/IF NOT EXISTS|OR REPLACE|CREATE TRIGGER/.test(statement), statement.slice(0, 60));
  }
  for (const trigger of sql.match(/CREATE TRIGGER (\w+)/g) ?? []) {
    const name = trigger.split(' ')[2];
    assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${name} ON audit_events`), `${name} is re-runnable`);
  }
  for (const index of ['audit_events_recent', 'audit_events_actor', 'audit_events_organization', 'audit_events_resource', 'audit_events_action']) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`), index);
  }
  const grants = await readServerFile('databaseGrantsMigration.sql');
  assert.match(grants, /\('audit_events',\s+'SELECT, INSERT',\s+NULL\)/, 'the API role may only read and append');
});

// ---------------------------------------------------------------------------
// Viewer: query building, authorization surface and self-audit
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-27T12:00:00.000Z');

test('viewer queries are parameterised, date-bounded and keyset-paginated', () => {
  const built = buildAuditQuery(auditQuerySchema.parse({ category: 'finance', organizationId: "x' OR '1'='1".replace(/[^A-Za-z0-9._:-]/g, '_'), limit: '20' }), NOW);
  assert.ok(!('error' in built));
  if ('error' in built) return;
  assert.equal(built.from.toISOString(), '2026-11-20T12:00:00.000Z', 'default window is 7 days');
  assert.match(built.text, /e\.category = \$3/);
  assert.match(built.text, /e\.organization_id = \$4/);
  assert.match(built.text, /ORDER BY e\.occurred_at DESC, e\.id DESC/);
  assert.match(built.text, /LIMIT \$5$/);
  assert.equal(built.values.at(-1), 21, 'one extra row tells whether a next page exists');
  assert.doesNotMatch(built.text, /finance|OR '1'/, 'values are never interpolated');

  const page2 = buildAuditQuery(auditQuerySchema.parse({ cursor: '2026-11-26T10:00:00.123456Z|00000000-0000-4000-8000-000000000001' }), NOW);
  assert.ok(!('error' in page2) && /\(e\.occurred_at, e\.id\) < \(\$3::timestamptz, \$4::uuid\)/.test(page2.text));

  const tooLong = buildAuditQuery(auditQuerySchema.parse({ from: '2026-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }), NOW);
  assert.deepEqual(tooLong, { error: `Choose a date range of at most ${AUDIT_WINDOW_MAX_DAYS} days.` });
  assert.ok('error' in buildAuditQuery(auditQuerySchema.parse({ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }), NOW));
});

test('viewer filters are strictly allow-listed', () => {
  for (const bad of [{ sort: 'actor' }, { limit: '1000' }, { action: 'notice.deleted' }, { category: 'everything' }, { cursor: "1' OR 1=1" }, { resourceType: 'Notice;DROP' }, { actorUserId: "a' --" }]) {
    assert.equal(auditQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('the viewer is reachable only on the private Admin host, only for Super Admin; no Institute or Student route exists (A-12, C-03)', () => {
  const viewer = ROUTE_POLICY.filter((entry) => entry.path.includes('audit-events'));
  assert.deepEqual(viewer.map((entry) => `${entry.method} ${entry.path}`), ['GET /api/admin/audit-events'], 'one read-only route');
  // Every audit-reading route (this viewer and the Platform Staff audit) is Admin-host, Super Admin only.
  for (const entry of ROUTE_POLICY.filter((item) => /audit/i.test(item.path))) {
    assert.equal(entry.routeClass, 'super_admin', entry.path);
    assert.deepEqual(entry.access.admin, { decision: 'allow', auth: 'super_admin' }, entry.path);
    for (const surface of ['marketing', 'exam', 'institution'] as const) assert.deepEqual(entry.access[surface], { decision: 'deny' }, `${entry.path} on ${surface}`);
    assert.equal(entry.method, 'GET', `${entry.path}: no write route`);
  }
});

interface FakeResponse { statusCode: number; body: unknown; headers: Record<string, string> }

async function callViewer(query: Record<string, string>, database: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; connect: () => Promise<unknown> }) {
  const router = createAuditRouter({ database: database as never, now: () => NOW });
  const layer = (router.stack as Array<{ route?: { path: string; stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => unknown }> } }>)
    .find((item) => item.route?.path === '/admin/audit-events')!;
  const handler = layer.route!.stack.at(-1)!.handle; // the guards are covered by the route matrix
  const result: FakeResponse = { statusCode: 200, body: undefined, headers: {} };
  let failure: unknown;
  await new Promise<void>((resolve) => {
    const res = {
      set(name: string, value: string) { result.headers[name] = value; return res; },
      status(code: number) { result.statusCode = code; return res; },
      json(body: unknown) { result.body = body; resolve(); return res; },
    } as unknown as Response;
    const req = { query, user: { id: 'synthetic-super-admin', role: 'official', isSuperAdmin: true } } as unknown as Request;
    handler(req, res, (error?: unknown) => { failure = error; resolve(); });
  });
  return { ...result, failure };
}

test('the viewer returns events with names looked up at read time, and records the search before answering', async () => {
  const order: string[] = [];
  const rows = Array.from({ length: 3 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`, occurred_at: new Date(Date.UTC(2026, 10, 26, 10, 0, i)), occurred_at_cursor: `2026-11-26T10:00:0${i}.000123Z`,
    category: 'finance', action: 'wallet.credited', outcome: 'succeeded', reason_code: null, actor_type: 'user',
    actor_user_id: 'synthetic-super-admin', actor_role: 'super_admin', organization_id: 'institute-1', resource_type: 'wallet_entry',
    resource_id: `entry-${i}`, metadata: { amount_paise: 100 }, actor_name: 'Synthetic Super Admin', actor_login_id: 'SA-1', organization_name: 'Demo Institute',
  }));
  const audits: unknown[][] = [];
  const database = {
    query: async (text: string) => { order.push('select'); assert.match(text, /FROM audit_events e/); return { rows }; },
    connect: async () => ({
      query: async (text: string, values: unknown[] = []) => { if (text === AUDIT_INSERT_SQL) { order.push('audit'); audits.push(values); } return { rows: [] }; },
      release() {},
    }),
  };
  const result = await callViewer({ limit: '2', category: 'finance' }, database);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  const body = result.body as { events: Array<Record<string, any>>; nextCursor: string | null };
  assert.equal(body.events.length, 2);
  assert.deepEqual(body.events[0].actor, { type: 'user', userId: 'synthetic-super-admin', role: 'super_admin', name: 'Synthetic Super Admin', loginId: 'SA-1' });
  assert.deepEqual(body.events[0].organization, { id: 'institute-1', name: 'Demo Institute' });
  assert.equal(body.nextCursor, '2026-11-26T10:00:01.000123Z|00000000-0000-4000-8000-000000000001', 'cursor keeps microseconds');
  assert.deepEqual(order, ['select', 'audit'], 'the search is recorded before the response');
  assert.deepEqual([audits[0][1], audits[0][5], JSON.parse(String(audits[0][10]))], ['audit.searched', 'synthetic-super-admin', { result_count: 2, filter_keys: ['category'] }],
    'only filter names and the count are recorded, never the rows');
});

test('if the search cannot be recorded, no audit data is sent (fail closed)', async () => {
  const database = {
    query: async () => ({ rows: [{ id: 'x', occurred_at: NOW, occurred_at_cursor: '2026-11-27T12:00:00.000000Z', metadata: {} }] }),
    connect: async () => ({
      query: async (text: string) => { if (text === AUDIT_INSERT_SQL) throw new Error('audit unavailable'); return { rows: [] }; },
      release() {},
    }),
  };
  const result = await callViewer({}, database);
  assert.equal(result.body, undefined, 'nothing was sent');
  assert.match(String(result.failure), /audit unavailable/);
});

test('invalid searches are refused before any query', async () => {
  let queried = false;
  const database = { query: async () => { queried = true; return { rows: [] }; }, connect: async () => { throw new Error('unexpected'); } };
  const invalid = await callViewer({ from: '2026-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }, database);
  assert.equal(invalid.statusCode, 400);
  const unknown = await callViewer({ sort: 'x' }, database);
  assert.equal(unknown.statusCode, 400);
  assert.equal(queried, false);
});

test('every query the Super Admin panel builds is accepted by the server schema', async () => {
  const { auditSearchParams, initialAuditFilters } = await import('../src/utils/auditLogSearch.js');
  const params = auditSearchParams({ ...initialAuditFilters(NOW), category: 'finance', action: 'wallet.credited', outcome: 'denied', organizationId: 'inst-1', actorUserId: 'sa-1' }, '2026-11-26T10:00:00.000123Z|00000000-0000-4000-8000-000000000001');
  const parsed = auditQuerySchema.safeParse(Object.fromEntries(params));
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  const built = buildAuditQuery(parsed.data!, NOW);
  assert.ok(!('error' in built), 'the default seven-day window is within the limit');
});

test('AL-4.8: refused actions are recorded on their own transaction and never break the response', async () => {
  const { recordRefusedAuditEvent } = await import('./audit.js');
  const log: string[] = [];
  let fail = false;
  const pool = { connect: async () => ({ query: async (text: string) => { log.push(text === AUDIT_INSERT_SQL ? 'INSERT audit' : text); if (fail && text === AUDIT_INSERT_SQL) throw new Error('down'); return { rows: [] }; }, release() {} }) };
  const event = { action: 'withdrawal.payment_refused' as const, outcome: 'denied' as const, reasonCode: 'maker_checker', actor: superAdmin, resourceId: 'w-1', metadata: { amount_paise: 100 } };
  assert.equal(await recordRefusedAuditEvent(pool as never, event), true);
  assert.deepEqual(log, ['BEGIN', 'INSERT audit', 'COMMIT']);
  fail = true;
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    assert.equal(await recordRefusedAuditEvent(pool as never, event), false, 'a failed write does not throw');
  } finally {
    console.error = original;
  }
  assert.deepEqual(JSON.parse(errors[0]), { event: 'audit.write_failed', action: 'withdrawal.payment_refused', outcome: 'denied', reason_code: 'maker_checker' }, 'the log line carries no amounts or IDs');
  await assert.rejects(recordRefusedAuditEvent(pool as never, { ...event, outcome: 'succeeded' }), /only for denied or failed/);
  await assert.rejects(recordRefusedAuditEvent(pool as never, { ...event, reasonCode: undefined }), /reason code/);
});
