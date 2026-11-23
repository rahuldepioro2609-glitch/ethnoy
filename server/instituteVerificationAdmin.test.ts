// AUTH-1 / SM-2: Super Admin institutional verification and suspension. No database is used: the
// HTTP tests use the in-memory store, and the PostgreSQL store is exercised against a scripted pool.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:9/placeholder';

const [admin, verification, store, auth, support, harness] = await Promise.all([
  import('./instituteVerificationAdmin.js'),
  import('./authVerification.js'),
  import('./authVerificationStore.js'),
  import('./auth.js'),
  import('./authTestSupport.js'),
  import('./staffTestHarness.js'),
]);
const { MemoryAuthVerificationStore } = support;
const { call, installPortalSessions, startHarness } = harness;

const SUPER = { token: 'S'.repeat(43), id: 'super-1', role: 'official' as const, isSuperAdmin: true };
const OFFICIAL = { token: 'O'.repeat(43), id: 'official-1', role: 'official' as const };
const OWNER = { token: 'C'.repeat(43), id: 'inst-1', role: 'center' as const };
const CANDIDATE = { token: 'D'.repeat(43), id: 'cand-1', role: 'candidate' as const };
const restorePool = installPortalSessions([SUPER, OFFICIAL, OWNER, CANDIDATE]);
test.after(() => restorePool());
const cookie = (principal: { token: string }) => `elt_session=${principal.token}`;
const REASON = 'Registration documents checked against the registry.';
const NOW = new Date('2026-11-14T12:00:00.000Z');

async function setup() {
  const memory = new MemoryAuthVerificationStore();
  memory.users.set('inst-1', { id: 'inst-1', loginId: 'INST-1', role: 'center', accountStatus: 'approved', contactEmail: null });
  memory.users.set('inst-2', { id: 'inst-2', loginId: 'INST-2', role: 'center', accountStatus: 'pending', contactEmail: null });
  memory.users.set('cand-1', { id: 'cand-1', loginId: 'CAND-1', role: 'candidate', accountStatus: 'approved', contactEmail: null });
  memory.institutes.set('inst-1', { mobileDestination: '+919876543210', mobileVerifiedAt: NOW, emailDestination: 'office@example.test', emailVerifiedAt: NOW, institutionalStatus: 'pending', suspendedAt: null });
  verification.configureAuthVerificationStore(memory);
  const server = await startHarness([admin.createInstituteVerificationAdminRouter({ now: () => NOW })]);
  return { memory, server, base: server.url };
}

const decide = (base: string, id: string, action: string, body: unknown = { reason: REASON }, who = SUPER) =>
  call(base, 'POST', `/api/admin/institute-verifications/${id}/${action}`, { surface: 'admin', cookie: cookie(who), body });

const ROUTES: Array<[string, string]> = [
  ['GET', '/api/admin/institute-verifications'],
  ['GET', '/api/admin/institute-verifications/decisions'],
  ...['verify', 'reject', 'suspend', 'restore'].map((action) => ['POST', `/api/admin/institute-verifications/inst-1/${action}`] as [string, string]),
];

test('only a Super Admin may use institutional verification; Officials, Institutes, Students and anonymous callers are refused', async () => {
  const { base, server, memory } = await setup();
  try {
    for (const [method, path] of ROUTES) {
      const body = method === 'POST' ? { reason: REASON } : undefined;
      assert.equal((await call(base, method, path, { surface: 'admin', body })).status, 401, `${path} anonymous`);
      assert.equal((await call(base, method, path, { surface: 'admin', cookie: cookie(OFFICIAL), body })).status, 403, `${path} ordinary Official`);
      // Institute and Student sessions are not admitted on the Admin surface at all (refused before the role check).
      for (const who of [OWNER, CANDIDATE]) {
        assert.ok([401, 403].includes((await call(base, method, path, { surface: 'admin', cookie: cookie(who), body })).status), `${path} ${who.id}`);
      }
    }
    assert.equal(memory.events.length, 0, 'refused callers change and audit nothing');
    assert.equal(memory.institutes.get('inst-1')!.institutionalStatus, 'pending');
  } finally {
    await server.close();
  }
});

test('verify, reject, suspend and restore update institutional state only, with actor, target, action and reason audited', async () => {
  const { base, server, memory } = await setup();
  try {
    const listing = await call(base, 'GET', '/api/admin/institute-verifications', { surface: 'admin', cookie: cookie(SUPER) });
    assert.equal(listing.status, 200);
    const inst1 = (listing.body.institutes as Array<Record<string, unknown>>).find((row) => row.institutionId === 'inst-1')!;
    assert.deepEqual([inst1.officialApproval, inst1.institutionalVerification, inst1.suspended], ['approved', 'pending', false]);
    assert.deepEqual(inst1.contacts, { mobile: { verified: true, destination: '+91******10' }, email: { verified: true, destination: 'o***@example.test' } }, 'contacts are masked');
    assert.equal((listing.body.institutes as unknown[]).length, 2, 'Institutes only, never Students');

    const verified = await decide(base, 'inst-1', 'verify');
    assert.deepEqual([verified.status, verified.body.institutionalVerification], [200, 'verified']);
    assert.equal((await decide(base, 'inst-1', 'verify')).body.code, 'INVALID_TRANSITION', 'no silent repeat');
    assert.deepEqual([(await decide(base, 'inst-1', 'restore')).status], [409], 'restore needs a suspension');
    const suspended = await decide(base, 'inst-1', 'suspend');
    assert.deepEqual([suspended.status, suspended.body.suspended], [200, true]);
    assert.equal((await decide(base, 'inst-1', 'suspend')).status, 409);
    const restored = await decide(base, 'inst-1', 'restore');
    assert.deepEqual([restored.status, restored.body.suspended, restored.body.institutionalVerification], [200, false, 'verified'], 'suspension is independent of verification');
    const rejected = await decide(base, 'inst-1', 'reject');
    assert.deepEqual([rejected.status, rejected.body.institutionalVerification], [200, 'rejected']);

    // Official approval is separate: never changed, and a pending institute can be verified institutionally.
    assert.equal(memory.users.get('inst-1')!.accountStatus, 'approved');
    assert.equal((await decide(base, 'inst-2', 'verify')).status, 200, 'an Institute without a state row gets one');
    assert.equal(memory.users.get('inst-2')!.accountStatus, 'pending', 'institutional verification never approves the account');

    const audit = memory.events.filter((event) => event.action.startsWith('institute.'));
    assert.deepEqual(audit.map((event) => event.action), [
      'institute.institutional_verified', 'institute.suspended', 'institute.suspension_lifted', 'institute.institutional_rejected', 'institute.institutional_verified',
    ], 'refused transitions write nothing');
    for (const event of audit) {
      assert.equal(event.details?.actorId, 'super-1');
      assert.equal(event.details?.actorKind, 'super_admin');
      assert.equal(event.userId, event.details?.targetInstitutionId);
      assert.equal(event.details?.reason, REASON);
    }
    assert.deepEqual(audit[1].details?.previous, { institutionalStatus: 'verified', suspended: false });
    const history = await call(base, 'GET', '/api/admin/institute-verifications/decisions', { surface: 'admin', cookie: cookie(SUPER) });
    const decisions = history.body.decisions as Array<{ action: string; institutionId: string; actorId: string; reason: string }>;
    assert.equal(decisions.length, 5);
    assert.deepEqual([decisions[0].action, decisions[0].institutionId, decisions[0].actorId, decisions[0].reason], ['institute.institutional_verified', 'inst-2', 'super-1', REASON], 'newest first');
  } finally {
    await server.close();
  }
});

test('a reason is mandatory, the body is strict, and only Institutes can be targeted', async () => {
  const { base, server, memory } = await setup();
  try {
    for (const body of [undefined, {}, { reason: 'too short' }, { reason: 'x'.repeat(501) }, { reason: REASON, accountStatus: 'approved' }]) {
      const result = await call(base, 'POST', '/api/admin/institute-verifications/inst-1/verify', { surface: 'admin', cookie: cookie(SUPER), body });
      assert.deepEqual([result.status, result.body.code], [400, 'INVALID_REQUEST'], String(JSON.stringify(body)));
    }
    assert.equal((await decide(base, 'cand-1', 'suspend')).status, 404, 'a Student is not an Institute');
    assert.equal((await decide(base, 'nobody', 'verify')).status, 404);
    assert.equal(memory.events.length, 0);
  } finally {
    await server.close();
  }
});

test('decisions take effect through the session gate: suspension and rejection lock the Institute out', () => {
  const gate = (state: Parameters<typeof store.nextInstitutionalState>[0]) => auth.portalVerificationGate('center', {
    sessionVerified: false,
    institute: { mobileVerified: true, emailVerified: true, institutionalStatus: state.institutionalStatus, suspended: state.suspendedAt !== null },
  });
  let state = { ...store.DEFAULT_INSTITUTE_STATE };
  assert.equal(gate(state).ok, false, 'pending');
  state = store.nextInstitutionalState(state, 'verify', NOW)!;
  assert.equal(gate(state).ok, true, 'verified');
  state = store.nextInstitutionalState(state, 'suspend', NOW)!;
  assert.deepEqual(gate(state), { ok: false, code: 'INSTITUTE_SUSPENDED', message: 'This institute account is suspended.' });
  state = store.nextInstitutionalState(state, 'restore', NOW)!;
  assert.equal(gate(state).ok, true, 'restored');
  state = store.nextInstitutionalState(state, 'reject', NOW)!;
  assert.equal(gate(state).ok, false, 'rejected');
});

test('fails closed when the AUTH-1 schema is absent: 503 and nothing written', async () => {
  const { base, server, memory } = await setup();
  memory.unavailable = true;
  try {
    for (const [method, path] of ROUTES) {
      const result = await call(base, method, path, { surface: 'admin', cookie: cookie(SUPER), body: method === 'POST' ? { reason: REASON } : undefined });
      assert.deepEqual([result.status, result.body.code], [503, 'VERIFICATION_NOT_INSTALLED'], path);
    }
    assert.equal(memory.events.length, 0);
    assert.equal(memory.institutes.get('inst-1')!.institutionalStatus, 'pending');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// PostgreSQL store against a scripted pool (no database)
// ---------------------------------------------------------------------------

function scriptedPool(answer: (text: string, values: unknown[]) => { rows?: Record<string, unknown>[]; rowCount?: number } | Error) {
  const log: string[] = [];
  const query = async (text: string, values: unknown[] = []) => {
    log.push(text.replace(/\s+/g, ' ').trim());
    const result = answer(text, values);
    if (result instanceof Error) throw result;
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? (result.rows ?? []).length };
  };
  return { log, pool: { query, connect: async () => ({ query, release: () => undefined }) } };
}
const undefinedTable = () => Object.assign(new Error('relation does not exist'), { code: '42P01' });
const ivRow = (over: Record<string, unknown> = {}) => ({ institution_id: 'inst-1', mobile_destination: null, mobile_verified_at: null, email_destination: null, email_verified_at: null, institutional_status: 'pending', suspended_at: null, ...over });

test('PostgreSQL store: one transaction updates only existing institute_verifications columns and appends the audit event', async () => {
  const { log, pool } = scriptedPool((text) => {
    if (text.includes('FROM users WHERE id = $1')) return { rows: [{ id: 'inst-1' }], rowCount: 1 };
    if (text.includes('SELECT * FROM institute_verifications')) return { rows: [ivRow()] };
    return { rowCount: 1 };
  });
  const pg = store.createPostgresAuthVerificationStore(pool as never);
  const result = await pg.decideInstitutional({ institutionId: 'inst-1', actorId: 'super-1', action: 'verify', reason: REASON, now: NOW });
  assert.equal(result.status, 'applied');
  assert.equal(log[0], 'BEGIN');
  assert.equal(log.at(-1), 'COMMIT');
  assert.ok(log.some((q) => q.startsWith('UPDATE institute_verifications SET institutional_status = $2, institutional_decided_at = $3, institutional_decided_by = $4')));
  assert.ok(log.some((q) => q.startsWith('INSERT INTO auth_verification_events')));
  assert.ok(log.some((q) => q.includes('FOR UPDATE')), 'the state row is locked');
  assert.ok(!log.some((q) => /account_status/.test(q) && /UPDATE/.test(q)), 'Official approval is never written');
  assert.ok(!log.some((q) => /CREATE|ALTER|institute_verification_decisions/.test(q)), 'no new schema');
});

test('PostgreSQL store: a refused transition rolls back (no row, no event); a missing table maps to "not installed"', async () => {
  const refused = scriptedPool((text) => {
    if (text.includes('FROM users WHERE id = $1')) return { rows: [{ id: 'inst-1' }], rowCount: 1 };
    if (text.includes('SELECT * FROM institute_verifications')) return { rows: [ivRow()] };
    return { rowCount: 1 };
  });
  const result = await store.createPostgresAuthVerificationStore(refused.pool as never).decideInstitutional({ institutionId: 'inst-1', actorId: 'super-1', action: 'restore', reason: REASON, now: NOW });
  assert.equal(result.status, 'invalid_transition');
  assert.equal(refused.log.at(-1), 'ROLLBACK');
  assert.ok(!refused.log.some((q) => q.startsWith('INSERT INTO auth_verification_events')));

  const missing = scriptedPool((text) => (/BEGIN|ROLLBACK/.test(text) ? {} : undefinedTable()));
  const pg = store.createPostgresAuthVerificationStore(missing.pool as never);
  await assert.rejects(pg.decideInstitutional({ institutionId: 'inst-1', actorId: 'super-1', action: 'verify', reason: REASON, now: NOW }), store.VerificationStoreUnavailableError);
  await assert.rejects(pg.listInstituteVerificationOverview(10), store.VerificationStoreUnavailableError);
  await assert.rejects(pg.listInstitutionalDecisions(10), store.VerificationStoreUnavailableError);
});

test('static: institutional verification never touches Official approval and adds no schema', async () => {
  const source = await readFile(new URL('./instituteVerificationAdmin.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/[^\n]*/g, ''), /account_status|accountStatus\s*=/);
  const migration = await readFile(new URL('./authVerificationMigration.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /institute_verification_decisions/);
  for (const column of ['institutional_status', 'institutional_decided_at', 'institutional_decided_by', 'suspended_at', 'suspended_by']) assert.match(migration, new RegExp(`\\b${column}\\b`));
});
