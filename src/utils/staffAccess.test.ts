import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlatformStaffPath, ORGANIZATION_STAFF_ROLE_LABELS, STAFF_LOGIN_OPTIONS } from './staffAccess.ts';
import { ORG_STAFF_ROLE_CODES } from '../../server/organizationStaff.ts';
import { SPA_SHELL_PATHS } from '../../server/surface.ts';

test('the chooser offers both staff options; only Platform Staff is active (C-18 blocks Organization Staff)', () => {
  assert.deepEqual(STAFF_LOGIN_OPTIONS.map((option) => option.id), ['platform-staff', 'organization-staff']);
  const [platform, organization] = STAFF_LOGIN_OPTIONS;
  assert.equal(platform.available, true);
  assert.equal(platform.path, '/login/platform-staff');
  assert.equal(organization.available, false);
  assert.equal(organization.path, null, 'an unavailable option links nowhere');
  assert.match(organization.unavailableReason ?? '', /C-18/);
});

test('Platform Staff pages are served only on the Admin surface', () => {
  assert.ok(SPA_SHELL_PATHS.admin.includes('/login/platform-staff'));
  assert.ok(SPA_SHELL_PATHS.admin.includes('/dashboard/platform-staff'));
  for (const surface of ['marketing', 'exam', 'institution'] as const) {
    assert.ok(!SPA_SHELL_PATHS[surface].some((path) => path.includes('platform-staff')), surface);
  }
  assert.ok(!Object.values(SPA_SHELL_PATHS).flat().some((path) => path.includes('org-staff')), 'no Organization Staff page is served yet');
});

test('path matching and role labels', () => {
  assert.equal(isPlatformStaffPath('/login/platform-staff'), true);
  assert.equal(isPlatformStaffPath('/dashboard/platform-staff/'), true);
  assert.equal(isPlatformStaffPath('/login/official'), false);
  assert.equal(isPlatformStaffPath('/login/platform-staff/extra'), false);
  assert.deepEqual(Object.keys(ORGANIZATION_STAFF_ROLE_LABELS).sort(), [...ORG_STAFF_ROLE_CODES].sort());
});
