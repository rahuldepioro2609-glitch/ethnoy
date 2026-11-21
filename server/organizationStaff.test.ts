// SM-1 Organization Staff: Owner-only management, Q116 invitations, the C-18 OTP gate, Q115
// activation refusal, strict tenant isolation, session separation and audit. No database is used.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:9/placeholder';

const [org, { MemoryOrgStaffStore }, platform, { MemoryPlatformStaffStore }, harness] = await Promise.all([
  import('./organizationStaff.js'),
  import('./staffTestStores.js'),
  import('./platformStaff.js'),
  import('./staffTestStores.js'),
  import('./staffTestHarness.js'),
]);
const { call, cookieValue, installPortalSessions, startHarness } = harness;
const { createOrgStaffRouters, hashInvitationCode, ORG_STAFF_COOKIE, ORG_STAFF_INVITATION_TTL_HOURS, ORG_STAFF_INVITATION_TTL_MS, ORG_STAFF_OTP_UNAVAILABLE } = org;

const OWNER_A = { token: 'A'.repeat(43), id: 'org-a', role: 'center' as const };
const OWNER_B = { token: 'B'.repeat(43), id: 'org-b', role: 'center' as const };
const SUPER = { token: 'S'.repeat(43), id: 'super-1', role: 'official' as const, isSuperAdmin: true };
const OFFICIAL = { token: 'O'.repeat(43), id: 'official-1', role: 'official' as const };
const CANDIDATE = { token: 'C'.repeat(43), id: 'candidate-1', role: 'candidate' as const };
const restorePool = installPortalSessions([OWNER_A, OWNER_B, SUPER, OFFICIAL, CANDIDATE]);
test.after(() => restorePool());
const portal = (principal: { token: string }) => `elt_session=${principal.token}`;
const PASSWORD = 'Member-password-123';

async function setup(options: { now?: () => Date } = {}) {
  const store = new MemoryOrgStaffStore();
  store.organizations.set('org-a', { id: 'org-a', loginId: 'ORG-A', name: 'Synthetic Institute A', approved: true });
  store.organizations.set('org-b', { id: 'org-b', loginId: 'ORG-B', name: 'Synthetic Institute B', approved: true });
  const { ownerRouter, staffRouter, adminRouter } = createOrgStaffRouters({ store, now: options.now });
  const server = await startHarness([ownerRouter, staffRouter, adminRouter]);
  return { store, server, base: server.url };
}

async function invite(base: string, owner: { token: string }, staffId: string) {
  const result = await call(base, 'POST', '/api/center/staff/invitations', { surface: 'institution', cookie: portal(owner), body: { staffId, displayName: 'Synthetic Member' } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { member: result.body.member as { id: string }, code: String(result.body.invitationCode) };
}

test('invitation codes expire after the fixed, approved 72 hours (SM2-P01); no environment setting is needed or honoured', async () => {
  assert.equal(ORG_STAFF_INVITATION_TTL_HOURS, 72);
  assert.equal(ORG_STAFF_INVITATION_TTL_MS, 72 * 60 * 60 * 1000);
  const previous = process.env.ORG_STAFF_INVITATION_TTL_HOURS;
  process.env.ORG_STAFF_INVITATION_TTL_HOURS = '1'; // the former override is ignored
  let clock = new Date('2026-11-14T10:00:00.000Z');
  const issuedAt = clock.getTime();
  const { base, server, store } = await setup({ now: () => clock });
  try {
    const listing = await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: portal(OWNER_A) });
    assert.equal(listing.status, 200);
    assert.equal(listing.body.invitationsAvailable, true);
    assert.equal(listing.body.invitationsUnavailableReason, null);
    assert.equal(listing.body.invitationExpiryHours, 72);
    assert.equal((listing.body.verification as { available: boolean }).available, false, 'OTP stays unavailable (C-18)');
    const first = await invite(base, OWNER_A, 'st-0001');
    const second = await invite(base, OWNER_A, 'st-0002');
    for (const invitation of store.invitations) assert.equal(invitation.expiresAt.getTime(), issuedAt + ORG_STAFF_INVITATION_TTL_MS);
    const accept = (staffId: string, invitationCode: string) => call(base, 'POST', '/api/org-staff/invitations/accept', { surface: 'institution', body: { organizationLoginId: 'org-a', staffId, invitationCode, password: PASSWORD } });
    clock = new Date(issuedAt + ORG_STAFF_INVITATION_TTL_MS - 1);
    assert.equal((await accept('st-0001', first.code)).status, 200, 'valid until the last millisecond of 72 hours');
    clock = new Date(issuedAt + ORG_STAFF_INVITATION_TTL_MS);
    const expired = await accept('st-0002', second.code);
    assert.deepEqual([expired.status, expired.body.error], [400, 'The invitation is invalid, already used or expired.'], 'expired at exactly 72 hours');
    const after = await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: portal(OWNER_A) });
    const states = Object.fromEntries((after.body.members as Array<{ staffId: string; invitation: { state: string } }>).map((m) => [m.staffId, m.invitation.state]));
    assert.deepEqual([states['ST-0001'], states['ST-0002']], ['used', 'expired']);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.ORG_STAFF_INVITATION_TTL_HOURS;
    else process.env.ORG_STAFF_INVITATION_TTL_HOURS = previous;
  }
});

test('only the Organization Owner manages its staff; other roles and staff sessions are refused', async () => {
  const { base, server } = await setup();
  try {
    // On the Institution surface, Official, Super Admin and candidate sessions are not valid at all
    // (P1-B surface binding answers 401 before any role check).
    for (const principal of [SUPER, OFFICIAL, CANDIDATE]) {
      assert.equal((await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: portal(principal) })).status, 401, principal.id);
      assert.equal((await call(base, 'POST', '/api/center/staff/invitations', { surface: 'institution', cookie: portal(principal), body: { staffId: 'st-0002', displayName: 'X Member' } })).status, 401, principal.id);
    }
    // Even on a surface where those sessions are valid, the Owner routes' role guard refuses them.
    assert.equal((await call(base, 'GET', '/api/center/staff', { surface: 'admin', cookie: portal(SUPER) })).status, 403);
    assert.equal((await call(base, 'GET', '/api/center/staff', { surface: 'institution' })).status, 401);
  } finally {
    await server.close();
  }
});

test('invitation codes are random, shown once, stored hashed, single-use, expiring and bound to one organization', async () => {
  const { base, server, store } = await setup();
  try {
    const { member, code } = await invite(base, OWNER_A, 'st-0003');
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(store.invitations[0].codeHash, hashInvitationCode(code));
    assert.ok(!JSON.stringify(store.invitations).includes(code), 'the code itself is never stored');
    const listing = await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: portal(OWNER_A) });
    assert.ok(!JSON.stringify(listing.body).includes(code), 'the code is not shown again');
    const accept = (body: Record<string, unknown>) => call(base, 'POST', '/api/org-staff/invitations/accept', { surface: 'institution', body });
    const good = { organizationLoginId: 'org-a', staffId: 'st-0003', invitationCode: code, password: PASSWORD };
    for (const wrong of [
      { ...good, organizationLoginId: 'org-b' },       // another organization
      { ...good, staffId: 'st-9999' },                  // another staff ID
      { ...good, invitationCode: `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}` },
      { ...good, password: 'short' },
    ]) {
      const result = await accept(wrong);
      assert.equal(result.status, 400, JSON.stringify(wrong));
      assert.equal(result.body.error, 'The invitation is invalid, already used or expired.');
    }
    const accepted = await accept(good);
    assert.equal(accepted.status, 200);
    assert.equal((accepted.body.verification as { reason: string }).reason, ORG_STAFF_OTP_UNAVAILABLE);
    assert.equal(cookieValue(accepted.setCookies, ORG_STAFF_COOKIE), undefined, 'acceptance creates no session');
    assert.equal((await accept(good)).status, 400, 'single use');
    const after = await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: portal(OWNER_A) });
    const view = (after.body.members as Array<{ id: string; accepted: boolean; verified: boolean; status: string; invitation: { state: string } }>).find((m) => m.id === member.id)!;
    assert.deepEqual([view.accepted, view.verified, view.status, view.invitation.state], [true, false, 'invited', 'used']);
    // Expiry: an invitation created by a clock in the past is rejected.
    const second = await invite(base, OWNER_A, 'st-0004');
    store.invitations.find((i) => i.memberId === second.member.id)!.expiresAt = new Date(Date.now() - 1000);
    assert.equal((await accept({ ...good, staffId: 'st-0004', invitationCode: second.code })).status, 400, 'expired');
  } finally {
    await server.close();
  }
});

test('C-18: OTP is unavailable, so an accepted member cannot sign in and Super Admin activation is refused', async () => {
  const { base, server, store } = await setup();
  try {
    const { member, code } = await invite(base, OWNER_A, 'st-0005');
    await call(base, 'POST', '/api/org-staff/invitations/accept', { surface: 'institution', body: { organizationLoginId: 'ORG-A', staffId: 'st-0005', invitationCode: code, password: PASSWORD } });
    for (const body of [{}, { code: '000000' }, { code: '123456', staffId: 'st-0005' }]) {
      const otp = await call(base, 'POST', '/api/org-staff/verification/otp', { surface: 'institution', body });
      assert.equal(otp.status, 503);
      assert.equal(otp.body.code, 'OTP_UNAVAILABLE');
    }
    assert.equal((await call(base, 'POST', '/api/org-staff/auth/login', { surface: 'institution', body: { organizationLoginId: 'ORG-A', staffId: 'st-0005', password: PASSWORD } })).status, 401);
    assert.equal((await call(base, 'POST', `/api/admin/organization-staff/${member.id}/activate`, { surface: 'admin', cookie: portal(OFFICIAL) })).status, 403, 'ordinary Official');
    const refused = await call(base, 'POST', `/api/admin/organization-staff/${member.id}/activate`, { surface: 'admin', cookie: portal(SUPER) });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'NOT_VERIFIED');
    assert.equal(store.members.get(member.id)!.status, 'invited');
    assert.ok(store.audit.some((event) => event.action === 'member.activation_refused'));
    const pending = await call(base, 'GET', '/api/admin/organization-staff', { surface: 'admin', cookie: portal(SUPER) });
    assert.equal(pending.status, 200);
    assert.equal((pending.body.members as Array<{ id: string; verified: boolean }>).find((m) => m.id === member.id)!.verified, false);
  } finally {
    await server.close();
  }
});

test('tenant isolation: an Owner can never see or change another organization\'s members', async () => {
  const { base, server, store } = await setup();
  try {
    const a = await invite(base, OWNER_A, 'st-0006');
    await invite(base, OWNER_B, 'st-0006'); // the same Staff ID is allowed in another organization
    const listB = await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: portal(OWNER_B) });
    assert.ok(!(listB.body.members as Array<{ id: string }>).some((m) => m.id === a.member.id));
    const crossRoles = await call(base, 'PUT', `/api/center/staff/${a.member.id}/roles`, { surface: 'institution', cookie: portal(OWNER_B), body: { roleCodes: ['viewer'] } });
    assert.equal(crossRoles.status, 404);
    assert.deepEqual(store.members.get(a.member.id)!.roles, []);
    assert.equal((await call(base, 'POST', '/api/center/staff/invitations', { surface: 'institution', cookie: portal(OWNER_A), body: { staffId: 'ST-0006', displayName: 'Duplicate' } })).status, 409, 'unique within the organization');
    // The organization always comes from the Owner's session, never from the request.
    const smuggled = await call(base, 'POST', '/api/center/staff/invitations', { surface: 'institution', cookie: portal(OWNER_B), body: { staffId: 'st-0007', displayName: 'X Member', organizationId: 'org-a' } });
    assert.equal(smuggled.status, 400, 'unknown fields are rejected');
  } finally {
    await server.close();
  }
});

test('Q117 roles: the Owner assigns only the six approved templates; custom roles are unavailable (D-08)', async () => {
  const { base, server, store } = await setup();
  try {
    const { member } = await invite(base, OWNER_A, 'st-0008');
    const set = await call(base, 'PUT', `/api/center/staff/${member.id}/roles`, { surface: 'institution', cookie: portal(OWNER_A), body: { roleCodes: ['viewer', 'finance_viewer'] } });
    assert.equal(set.status, 200);
    assert.deepEqual((set.body.member as { roles: string[] }).roles, ['finance_viewer', 'viewer']);
    for (const roleCodes of [['super_admin'], ['platform_staff'], ['viewer', 'viewer'], ['custom_role']]) {
      assert.equal((await call(base, 'PUT', `/api/center/staff/${member.id}/roles`, { surface: 'institution', cookie: portal(OWNER_A), body: { roleCodes } })).status, 400, roleCodes.join());
    }
    const listing = await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: portal(OWNER_A) });
    assert.deepEqual((listing.body.roleTemplates as Array<{ code: string }>).map((r) => r.code).sort(), ['application_manager', 'finance_viewer', 'invigilator', 'reviewer', 'verifier', 'viewer']);
    assert.equal((listing.body.customRoles as { available: boolean }).available, false);
    assert.equal((listing.body.suspensionAndRemoval as { available: boolean }).available, false, 'Q115 gap');
    const event = store.audit.find((entry) => entry.action === 'member.roles_changed')!;
    assert.deepEqual(event.details.after, ['viewer', 'finance_viewer']);
  } finally {
    await server.close();
  }
});

test('an active member (future verified state) signs in with an isolated, organization-scoped session', async () => {
  const { base, server, store } = await setup();
  try {
    const { member, code } = await invite(base, OWNER_A, 'st-0009');
    await call(base, 'POST', '/api/org-staff/invitations/accept', { surface: 'institution', body: { organizationLoginId: 'ORG-A', staffId: 'st-0009', invitationCode: code, password: PASSWORD } });
    store.markVerifiedForTest(member.id); // stands in for a FUTURE approved verification (C-18)
    assert.equal((await call(base, 'POST', `/api/admin/organization-staff/${member.id}/activate`, { surface: 'admin', cookie: portal(SUPER) })).status, 200);
    await call(base, 'PUT', `/api/center/staff/${member.id}/roles`, { surface: 'institution', cookie: portal(OWNER_A), body: { roleCodes: ['viewer'] } });
    const wrongOrg = await call(base, 'POST', '/api/org-staff/auth/login', { surface: 'institution', body: { organizationLoginId: 'ORG-B', staffId: 'st-0009', password: PASSWORD } });
    assert.equal(wrongOrg.status, 401);
    const login = await call(base, 'POST', '/api/org-staff/auth/login', { surface: 'institution', body: { organizationLoginId: 'org-a', staffId: 'st-0009', password: PASSWORD } });
    assert.equal(login.status, 200);
    const raw = login.setCookies.find((cookie) => cookie.startsWith(`${ORG_STAFF_COOKIE}=`))!;
    assert.match(raw, /Path=\/api\/org-staff;/);
    const token = cookieValue(login.setCookies, ORG_STAFF_COOKIE)!;
    const cookie = `${ORG_STAFF_COOKIE}=${token}`;
    const dashboard = await call(base, 'GET', '/api/org-staff/dashboard', { surface: 'institution', cookie });
    assert.equal(dashboard.status, 200);
    assert.deepEqual(dashboard.body.organization, { name: 'Synthetic Institute A' });
    assert.deepEqual((dashboard.body.staff as { roles: string[] }).roles, ['viewer']);
    assert.equal((dashboard.body.workQueue as { available: boolean }).available, false);
    // Session separation: an org-staff session is not an Owner session, and vice versa.
    assert.equal((await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie })).status, 401);
    assert.equal((await call(base, 'GET', '/api/center/staff', { surface: 'institution', cookie: `elt_session=${token}` })).status, 401);
    assert.equal((await call(base, 'GET', '/api/org-staff/auth/me', { surface: 'institution', cookie: portal(OWNER_A) })).status, 401);
    // An org-staff session never works as a Super Admin or management session.
    assert.equal((await call(base, 'POST', `/api/admin/organization-staff/${member.id}/activate`, { surface: 'admin', cookie })).status, 401);
    // Suspending the organization (not approved) ends staff access on the next request.
    store.organizations.get('org-a')!.approved = false;
    assert.equal((await call(base, 'GET', '/api/org-staff/auth/me', { surface: 'institution', cookie })).status, 401);
    store.organizations.get('org-a')!.approved = true;
    assert.equal((await call(base, 'POST', '/api/org-staff/auth/logout', { surface: 'institution', cookie })).status, 204);
    assert.equal((await call(base, 'GET', '/api/org-staff/auth/me', { surface: 'institution', cookie })).status, 401);
    assert.ok(store.audit.every((event) => event.organizationId === 'org-a'), 'every event is scoped to the organization');
  } finally {
    await server.close();
  }
});

test('Organization Staff can never gain Platform Staff access, and the reverse', async () => {
  const orgStore = new MemoryOrgStaffStore();
  orgStore.organizations.set('org-a', { id: 'org-a', loginId: 'ORG-A', name: 'Synthetic Institute A', approved: true });
  const orgRouters = createOrgStaffRouters({ store: orgStore });
  const platformStore = new MemoryPlatformStaffStore();
  const platformRouters = platform.createPlatformStaffRouters({ store: platformStore });
  const server = await startHarness([orgRouters.ownerRouter, orgRouters.staffRouter, orgRouters.adminRouter, platformRouters.staffRouter, platformRouters.adminRouter]);
  try {
    const invited = await call(server.url, 'POST', '/api/center/staff/invitations', { surface: 'institution', cookie: portal(OWNER_A), body: { staffId: 'shared-id', displayName: 'Org Member' } });
    const memberId = (invited.body.member as { id: string }).id;
    await call(server.url, 'POST', '/api/org-staff/invitations/accept', { surface: 'institution', body: { organizationLoginId: 'ORG-A', staffId: 'shared-id', invitationCode: invited.body.invitationCode, password: PASSWORD } });
    orgStore.markVerifiedForTest(memberId);
    await call(server.url, 'POST', `/api/admin/organization-staff/${memberId}/activate`, { surface: 'admin', cookie: portal(SUPER) });
    const orgLogin = await call(server.url, 'POST', '/api/org-staff/auth/login', { surface: 'institution', body: { organizationLoginId: 'ORG-A', staffId: 'shared-id', password: PASSWORD } });
    const orgToken = cookieValue(orgLogin.setCookies, ORG_STAFF_COOKIE)!;
    // The same Staff ID and password do not exist in the Platform Staff identity system.
    assert.equal((await call(server.url, 'POST', '/api/platform-staff/auth/login', { surface: 'admin', body: { staffId: 'shared-id', password: PASSWORD } })).status, 401);
    // An org-staff token replayed as a Platform Staff token is unknown there.
    assert.equal((await call(server.url, 'GET', '/api/platform-staff/auth/me', { surface: 'admin', cookie: `${platform.PLATFORM_STAFF_COOKIE}=${orgToken}` })).status, 401);
    assert.equal((await call(server.url, 'GET', '/api/admin/platform-staff', { surface: 'admin', cookie: `${ORG_STAFF_COOKIE}=${orgToken}` })).status, 401);
  } finally {
    await server.close();
  }
});
