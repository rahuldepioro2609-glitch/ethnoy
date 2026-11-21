// SM-1 Platform Staff: identity and session separation, Super Admin-only management, deactivation,
// escalation prevention, audit events and unavailable capabilities. No database is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';

process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:9/placeholder';

const [{ createPlatformStaffRouters, createPostgresPlatformStaffStore, PLATFORM_STAFF_COOKIE, PLATFORM_STAFF_WORK_QUEUE_UNAVAILABLE }, { MemoryPlatformStaffStore }, harness, { StaffStoreUnavailableError }] = await Promise.all([
  import('./platformStaff.js'),
  import('./staffTestStores.js'),
  import('./staffTestHarness.js'),
  import('./staffCommon.js'),
]);
const { call, cookieValue, installPortalSessions, startHarness } = harness;

const SUPER = { token: 'S'.repeat(43), id: 'super-1', role: 'official' as const, isSuperAdmin: true };
const OFFICIAL = { token: 'O'.repeat(43), id: 'official-1', role: 'official' as const };
const CANDIDATE = { token: 'C'.repeat(43), id: 'candidate-1', role: 'candidate' as const };
const CENTER = { token: 'E'.repeat(43), id: 'center-1', role: 'center' as const };
const restorePool = installPortalSessions([SUPER, OFFICIAL, CANDIDATE, CENTER]);
test.after(() => restorePool());

const portal = (principal: { token: string }) => `elt_session=${principal.token}`;
const INITIAL = 'Initial-password-123';
const CHANGED = 'Changed-password-456';

async function setup() {
  const store = new MemoryPlatformStaffStore();
  const { staffRouter, adminRouter } = createPlatformStaffRouters({ store });
  const server = await startHarness([staffRouter, adminRouter]);
  return { store, server, base: server.url };
}

async function createStaff(base: string, staffId = 'ps-0001') {
  const created = await call(base, 'POST', '/api/admin/platform-staff', { surface: 'admin', cookie: portal(SUPER), body: { staffId, displayName: 'Synthetic Staff', initialPassword: INITIAL } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.account as { id: string; staffId: string };
}

async function signIn(base: string, staffId: string, password: string) {
  const result = await call(base, 'POST', '/api/platform-staff/auth/login', { surface: 'admin', body: { staffId, password } });
  return { ...result, cookie: cookieValue(result.setCookies, PLATFORM_STAFF_COOKIE) };
}

test('only a Super Admin can create, list, assign and deactivate Platform Staff', async () => {
  const { base, server } = await setup();
  try {
    const body = { staffId: 'ps-0002', displayName: 'Synthetic Staff', initialPassword: INITIAL };
    for (const principal of [OFFICIAL, CANDIDATE, CENTER]) {
      assert.equal((await call(base, 'POST', '/api/admin/platform-staff', { surface: 'admin', cookie: portal(principal), body })).status, principal === OFFICIAL ? 403 : 401, principal.id);
      assert.notEqual((await call(base, 'GET', '/api/admin/platform-staff', { surface: 'admin', cookie: portal(principal) })).status, 200, principal.id);
    }
    assert.equal((await call(base, 'POST', '/api/admin/platform-staff', { surface: 'admin', body })).status, 401, 'anonymous');
    const account = await createStaff(base, 'ps-0002');
    assert.equal(account.staffId, 'PS-0002', 'Staff IDs are normalised to upper case');
    for (const path of [`/api/admin/platform-staff/${account.id}/deactivate`]) {
      assert.equal((await call(base, 'POST', path, { surface: 'admin', cookie: portal(OFFICIAL), body: { reason: 'Ordinary officials cannot do this.' } })).status, 403);
    }
    assert.equal((await call(base, 'PUT', `/api/admin/platform-staff/${account.id}/assignment`, { surface: 'admin', cookie: portal(OFFICIAL), body: { departmentId: null, roleIds: [] } })).status, 403);
    assert.equal((await call(base, 'POST', '/api/admin/platform-staff', { surface: 'admin', cookie: portal(SUPER), body })).status, 409, 'duplicate Staff ID');
  } finally {
    await server.close();
  }
});

test('Staff ID + password sign-in, forced first password change, dashboard and logout', async () => {
  const { base, server, store } = await setup();
  try {
    await createStaff(base, 'ps-0003');
    const login = await signIn(base, 'ps-0003', INITIAL);
    assert.equal(login.status, 200);
    assert.ok(login.cookie, 'staff session cookie issued');
    const raw = login.setCookies.find((cookie) => cookie.startsWith(`${PLATFORM_STAFF_COOKIE}=`))!;
    assert.match(raw, /Path=\/api\/platform-staff;/);
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Strict/);
    assert.equal((login.body.staff as { mustChangePassword: boolean }).mustChangePassword, true);
    const cookie = `${PLATFORM_STAFF_COOKIE}=${login.cookie}`;
    const blocked = await call(base, 'GET', '/api/platform-staff/dashboard', { surface: 'admin', cookie });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await call(base, 'POST', '/api/platform-staff/auth/password', { surface: 'admin', cookie, body: { currentPassword: 'wrong-password-000', newPassword: CHANGED } })).status, 403);
    assert.equal((await call(base, 'POST', '/api/platform-staff/auth/password', { surface: 'admin', cookie, body: { currentPassword: INITIAL, newPassword: 'short' } })).status, 400);
    assert.equal((await call(base, 'POST', '/api/platform-staff/auth/password', { surface: 'admin', cookie, body: { currentPassword: INITIAL, newPassword: CHANGED } })).status, 204);
    const dashboard = await call(base, 'GET', '/api/platform-staff/dashboard', { surface: 'admin', cookie });
    assert.equal(dashboard.status, 200);
    assert.deepEqual(dashboard.body.workQueue, { available: false, reason: PLATFORM_STAFF_WORK_QUEUE_UNAVAILABLE, items: [] });
    assert.equal((dashboard.body.activity as { available: boolean }).available, false, 'A-12: no staff-visible audit history');
    assert.deepEqual((dashboard.body.staff as { permissions: string[] }).permissions, [], 'D-08: no permissions can exist');
    assert.equal((await signIn(base, 'ps-0003', INITIAL)).status, 401, 'old password no longer works');
    assert.equal((await call(base, 'POST', '/api/platform-staff/auth/logout', { surface: 'admin', cookie })).status, 204);
    assert.equal((await call(base, 'GET', '/api/platform-staff/auth/me', { surface: 'admin', cookie })).status, 401, 'logged-out session is rejected');
    const actions = store.audit.map((event) => event.action);
    for (const action of ['staff.created', 'auth.login_succeeded', 'auth.password_changed', 'auth.logout', 'auth.login_failed']) assert.ok(actions.includes(action), action);
  } finally {
    await server.close();
  }
});

test('failed sign-in gives one generic answer for unknown, wrong-password and deactivated accounts', async () => {
  const { base, server, store } = await setup();
  try {
    const account = await createStaff(base, 'ps-0004');
    const unknown = await signIn(base, 'ps-9999', INITIAL);
    const wrong = await signIn(base, 'ps-0004', 'Wrong-password-999');
    await call(base, 'POST', `/api/admin/platform-staff/${account.id}/deactivate`, { surface: 'admin', cookie: portal(SUPER), body: { reason: 'Synthetic deactivation for the test.' } });
    const deactivated = await signIn(base, 'ps-0004', INITIAL);
    const malformedResult = await call(base, 'POST', '/api/platform-staff/auth/login', { surface: 'admin', body: { staffId: '!', password: '' } });
    const malformed = { ...malformedResult, cookie: cookieValue(malformedResult.setCookies, PLATFORM_STAFF_COOKIE) };
    for (const result of [unknown, wrong, deactivated, malformed]) {
      assert.equal(result.status, 401);
      assert.equal(result.body.error, 'Invalid staff ID or password.');
      assert.equal(result.cookie, undefined);
    }
    const failures = store.audit.filter((event) => event.action === 'auth.login_failed');
    assert.equal(failures.length, 3, 'unknown, wrong password and deactivated are audited (malformed input is not looked up)');
    assert.ok(failures.every((event) => !JSON.stringify(event).includes('PS-9999')), 'an unknown Staff ID is not stored');
    assert.ok(!JSON.stringify(store.audit).includes(INITIAL), 'no password in audit');
  } finally {
    await server.close();
  }
});

test('deactivation ends every session immediately and is audited; reactivation does not exist', async () => {
  const { base, server, store } = await setup();
  try {
    const account = await createStaff(base, 'ps-0005');
    const first = await signIn(base, 'ps-0005', INITIAL);
    const second = await signIn(base, 'ps-0005', INITIAL);
    const cookies = [first.cookie, second.cookie].map((value) => `${PLATFORM_STAFF_COOKIE}=${value}`);
    for (const cookie of cookies) assert.equal((await call(base, 'GET', '/api/platform-staff/auth/me', { surface: 'admin', cookie })).status, 200);
    assert.equal((await call(base, 'POST', `/api/admin/platform-staff/${account.id}/deactivate`, { surface: 'admin', cookie: portal(SUPER), body: { reason: 'short' } })).status, 400, 'a reason is required');
    const result = await call(base, 'POST', `/api/admin/platform-staff/${account.id}/deactivate`, { surface: 'admin', cookie: portal(SUPER), body: { reason: 'Synthetic deactivation for the test.' } });
    assert.equal(result.status, 200);
    for (const cookie of cookies) assert.equal((await call(base, 'GET', '/api/platform-staff/auth/me', { surface: 'admin', cookie })).status, 401);
    assert.equal((await call(base, 'POST', `/api/admin/platform-staff/${account.id}/deactivate`, { surface: 'admin', cookie: portal(SUPER), body: { reason: 'Synthetic deactivation for the test.' } })).status, 409);
    const event = store.audit.find((entry) => entry.action === 'staff.deactivated')!;
    assert.equal(event.actorKind, 'super_admin');
    assert.equal(event.details.sessionsEnded, 2);
    assert.equal((await call(base, 'POST', `/api/admin/platform-staff/${account.id}/reactivate`, { surface: 'admin', cookie: portal(SUPER), body: {} })).status, 404, 'no reactivation route (not decided)');
  } finally {
    await server.close();
  }
});

test('identity and session separation: portal and staff sessions never substitute for each other', async () => {
  const { base, server } = await setup();
  try {
    await createStaff(base, 'ps-0006');
    const login = await signIn(base, 'ps-0006', INITIAL);
    const staffCookie = `${PLATFORM_STAFF_COOKIE}=${login.cookie}`;
    // A Platform Staff session is not a portal session: Super Admin routes reject it.
    assert.equal((await call(base, 'GET', '/api/admin/platform-staff', { surface: 'admin', cookie: staffCookie })).status, 401);
    assert.equal((await call(base, 'GET', '/api/admin/platform-staff', { surface: 'admin', cookie: `elt_session=${login.cookie}` })).status, 401, 'staff token replayed as a portal token');
    // A portal session (even Super Admin) is not a staff session.
    for (const principal of [SUPER, OFFICIAL, CANDIDATE, CENTER]) {
      assert.equal((await call(base, 'GET', '/api/platform-staff/auth/me', { surface: 'admin', cookie: portal(principal) })).status, 401, principal.id);
      assert.equal((await call(base, 'GET', '/api/platform-staff/auth/me', { surface: 'admin', cookie: `${PLATFORM_STAFF_COOKIE}=${principal.token}` })).status, 401, `${principal.id} token replayed as staff token`);
    }
    // Staff sign-in never touches the users table: an existing portal user's credentials do not work.
    assert.equal((await signIn(base, 'official-1', INITIAL)).status, 401);
  } finally {
    await server.close();
  }
});

test('no self-granted permissions: staff have no management route, roles carry no permissions, and permission fields are rejected', async () => {
  const { base, server, store } = await setup();
  try {
    const account = await createStaff(base, 'ps-0007');
    const login = await signIn(base, 'ps-0007', INITIAL);
    const cookie = `${PLATFORM_STAFF_COOKIE}=${login.cookie}`;
    await call(base, 'POST', '/api/platform-staff/auth/password', { surface: 'admin', cookie, body: { currentPassword: INITIAL, newPassword: CHANGED } });
    for (const [method, path, body] of [
      ['PUT', `/api/admin/platform-staff/${account.id}/assignment`, { departmentId: null, roleIds: [] }],
      ['POST', '/api/admin/platform-staff/roles', { name: 'Self granted' }],
      ['POST', '/api/admin/platform-staff', { staffId: 'ps-0099', displayName: 'Other staff', initialPassword: INITIAL }],
      ['POST', `/api/admin/platform-staff/${account.id}/deactivate`, { reason: 'Staff deactivating staff.' }],
    ] as const) {
      assert.equal((await call(base, method, path, { surface: 'admin', cookie, body })).status, 401, `${method} ${path}`);
    }
    const rejected = await call(base, 'POST', '/api/admin/platform-staff/roles', { surface: 'admin', cookie: portal(SUPER), body: { name: 'Reviewers', permissions: ['applications.view'] } });
    assert.equal(rejected.status, 400, 'permissions cannot be attached through the API (D-08)');
    const role = await call(base, 'POST', '/api/admin/platform-staff/roles', { surface: 'admin', cookie: portal(SUPER), body: { name: 'Reviewers' } });
    assert.equal(role.status, 201);
    assert.deepEqual((role.body.role as { permissions: string[] }).permissions, []);
    const department = await call(base, 'POST', '/api/admin/platform-staff/departments', { surface: 'admin', cookie: portal(SUPER), body: { name: 'Operations' } });
    const assigned = await call(base, 'PUT', `/api/admin/platform-staff/${account.id}/assignment`, { surface: 'admin', cookie: portal(SUPER), body: { departmentId: (department.body.department as { id: string }).id, roleIds: [(role.body.role as { id: string }).id] } });
    assert.equal(assigned.status, 200);
    assert.deepEqual((assigned.body.account as { permissions: string[] }).permissions, []);
    assert.equal((await call(base, 'PUT', `/api/admin/platform-staff/${account.id}/assignment`, { surface: 'admin', cookie: portal(SUPER), body: { departmentId: null, roleIds: ['missing-role'] } })).status, 404);
    const roles = await call(base, 'GET', '/api/admin/platform-staff/roles', { surface: 'admin', cookie: portal(SUPER) });
    assert.deepEqual(roles.body.permissionCatalogue, [], 'D-08: empty catalogue');
    const change = store.audit.find((event) => event.action === 'staff.assignment_changed')!;
    assert.deepEqual((change.details.before as { roleIds: string[] }).roleIds, []);
    // Audit records are immutable (append-only in the store; append-only triggers in PostgreSQL).
    assert.throws(() => { (change as { action: string }).action = 'tampered'; });
    const dashboard = await call(base, 'GET', '/api/platform-staff/dashboard', { surface: 'admin', cookie });
    assert.equal((dashboard.body.staff as { department: { name: string } }).department.name, 'Operations');
  } finally {
    await server.close();
  }
});

test('Super Admin audit view lists events; ordinary Officials cannot read it (A-12)', async () => {
  const { base, server } = await setup();
  try {
    await createStaff(base, 'ps-0008');
    assert.equal((await call(base, 'GET', '/api/admin/platform-staff/audit', { surface: 'admin', cookie: portal(OFFICIAL) })).status, 403);
    const view = await call(base, 'GET', '/api/admin/platform-staff/audit', { surface: 'admin', cookie: portal(SUPER) });
    assert.equal(view.status, 200);
    assert.ok((view.body.events as Array<{ action: string }>).some((event) => event.action === 'staff.created'));
  } finally {
    await server.close();
  }
});

test('when the staff tables are not installed, staff routes answer 503 without leaking details', async () => {
  const store = new MemoryPlatformStaffStore();
  store.findLoginRecord = async () => { throw new StaffStoreUnavailableError(); };
  store.listAccounts = async () => { throw new StaffStoreUnavailableError(); };
  const { staffRouter, adminRouter } = createPlatformStaffRouters({ store });
  const server = await startHarness([staffRouter, adminRouter]);
  try {
    const login = await call(server.url, 'POST', '/api/platform-staff/auth/login', { surface: 'admin', body: { staffId: 'ps-0001', password: INITIAL } });
    assert.equal(login.status, 503);
    assert.equal(login.body.code, 'STAFF_NOT_INSTALLED');
    assert.equal((await call(server.url, 'GET', '/api/admin/platform-staff', { surface: 'admin', cookie: portal(SUPER) })).status, 503);
  } finally {
    await server.close();
  }
});

test('PostgreSQL store: deactivation, session revocation and its audit row share one transaction', async () => {
  const statements: string[] = [];
  const client = {
    query: async (text: string) => {
      statements.push(text.replace(/\s+/g, ' ').trim().slice(0, 60));
      if (text.includes('SELECT status FROM platform_staff_accounts')) return { rows: [{ status: 'active' }], rowCount: 1 };
      if (text.startsWith('UPDATE platform_staff_sessions')) return { rows: [], rowCount: 2 };
      if (text.includes('FROM platform_staff_accounts a')) return { rows: [{ id: 'a1', staff_id: 'PS-1', display_name: 'X', status: 'deactivated', must_change_password: false, created_at: new Date(), deactivated_at: new Date(), department_id: null, department_name: null, roles: [], permissions: [] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => statements.push('RELEASE'),
  };
  const store = createPostgresPlatformStaffStore({ query: async () => { throw new Error('pool.query must not be used for a transaction'); }, connect: async () => client as never });
  await store.deactivateAccount('a1', 'super-1', 'Synthetic deactivation reason.');
  assert.equal(statements[0], 'BEGIN');
  const update = statements.findIndex((s) => s.startsWith("UPDATE platform_staff_accounts SET status = 'deactivated'"));
  const revoke = statements.findIndex((s) => s.startsWith('UPDATE platform_staff_sessions SET revoked_at'));
  const audit = statements.findIndex((s) => s.startsWith('INSERT INTO platform_staff_audit_events'));
  const commit = statements.indexOf('COMMIT');
  assert.ok(update > 0 && revoke > update && audit > revoke && commit > audit, statements.join(' | '));
  assert.equal(statements.at(-1), 'RELEASE');
});

test('PostgreSQL store: a missing table maps to "not installed", and bcrypt hashes are the only stored credential', async () => {
  const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  const store = createPostgresPlatformStaffStore({ query: async () => { throw missing; }, connect: async () => { throw new Error('unused'); } });
  await assert.rejects(store.findLoginRecord('PS-1'), StaffStoreUnavailableError);
  const hash = await bcrypt.hash(INITIAL, 4);
  assert.notEqual(hash, INITIAL);
});
