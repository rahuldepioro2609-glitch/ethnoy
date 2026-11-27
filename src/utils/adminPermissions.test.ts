import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_DASHBOARD_TABS,
  adminPermissions,
  canAdministerHelpdeskFromSlideOut,
  canLoadAdminSection,
  canSeeAdminTab,
  isSuperAdminOfficial,
  SUPER_ADMIN_ONLY_TEXT,
  withdrawalPaymentState,
} from './adminPermissions';

const superAdmin = { role: 'official', isSuperAdmin: true };
const ordinaryOfficial = { role: 'official', isSuperAdmin: false };
const candidate = { role: 'candidate', isSuperAdmin: false };
const center = { role: 'center', isSuperAdmin: false };
// A non-Official account can never be treated as Super Admin, even if the flag were set.
const flaggedCenter = { role: 'center', isSuperAdmin: true };

const SUPER_ADMIN_ONLY_KEYS = [
  'canCreditWallets', 'canManageWithdrawals', 'canPublishResults', 'canPublishAnswerKeys',
  'canPublishOnlineExams', 'canPublishNotices', 'canCorrectPublishedContent', 'canWriteAdmitCards', 'canAccessHelpdesk',
  'canSeeHelpdeskCount', 'canOpenInstitutionDocuments', 'canReviewInstitutionDocuments', 'canExportData',
] as const;

test('Super Admin is an Official flagged as Super Admin, nothing else', () => {
  assert.equal(isSuperAdminOfficial(superAdmin), true);
  for (const user of [ordinaryOfficial, candidate, center, flaggedCenter, null, undefined, { role: 'official' }, { role: 'official', isSuperAdmin: null }]) {
    assert.equal(isSuperAdminOfficial(user), false, JSON.stringify(user));
  }
});

test('every P0-3 Super Admin-only control is granted to Super Admins only', () => {
  const granted = adminPermissions(superAdmin);
  for (const key of SUPER_ADMIN_ONLY_KEYS) assert.equal(granted[key], true, key);
  for (const user of [ordinaryOfficial, candidate, center, flaggedCenter, null]) {
    const permissions = adminPermissions(user);
    for (const key of SUPER_ADMIN_ONLY_KEYS) assert.equal(permissions[key], false, `${key} for ${JSON.stringify(user)}`);
  }
});

test('draft imports stay open to every Official (A-18)', () => {
  assert.equal(adminPermissions(ordinaryOfficial).canImportDrafts, true);
  assert.equal(adminPermissions(superAdmin).canImportDrafts, true);
  assert.equal(adminPermissions(candidate).canImportDrafts, false);
  assert.equal(adminPermissions(center).canImportDrafts, false);
});

test('ordinary Officials never see the helpdesk tab or request helpdesk data (P3-D4)', () => {
  assert.equal(canSeeAdminTab(ordinaryOfficial, 'feedback'), false);
  assert.equal(canLoadAdminSection(ordinaryOfficial, 'feedback'), false);
  assert.equal(canSeeAdminTab(superAdmin, 'feedback'), true);
  assert.equal(canLoadAdminSection(superAdmin, 'feedback'), true);
});

test('only the helpdesk and data-export tabs are hidden from ordinary Officials', () => {
  const hidden = ADMIN_DASHBOARD_TABS.filter((tab) => !canSeeAdminTab(ordinaryOfficial, tab));
  assert.deepEqual(hidden, ['feedback', 'data-export', 'platform-staff', 'institute-verification', 'audit-log', 'merit-lists']);
  assert.deepEqual(ADMIN_DASHBOARD_TABS.filter((tab) => !canSeeAdminTab(superAdmin, tab)), []);
  for (const section of ['applications', 'attempts', 'results', 'stats', 'institutes', 'institute-management']) {
    assert.equal(canLoadAdminSection(ordinaryOfficial, section), true, section);
  }
});

test('"Mark paid" is offered only to a Super Admin who did not approve the withdrawal', () => {
  const approved = { status: 'approved', approver_recorded: true, reviewed_by_current_user: false };
  assert.equal(withdrawalPaymentState(superAdmin, approved), 'allowed');
  assert.equal(withdrawalPaymentState(superAdmin, { ...approved, reviewed_by_current_user: true }), 'maker_checker');
  assert.equal(withdrawalPaymentState(superAdmin, { ...approved, approver_recorded: false }), 'approver_unknown');
  assert.equal(withdrawalPaymentState(superAdmin, { ...approved, status: 'pending' }), 'not_approved');
  assert.equal(withdrawalPaymentState(ordinaryOfficial, approved), 'not_allowed');
  // Missing flags (an older API) fail closed.
  assert.equal(withdrawalPaymentState(superAdmin, { status: 'approved' }), 'approver_unknown');
});

test('feedback slide-out admin view is limited to Super Admin Officials', () => {
  assert.equal(canAdministerHelpdeskFromSlideOut({ role: 'Assessment Official', accountRole: 'official', isSuperAdmin: true }), true);
  assert.equal(canAdministerHelpdeskFromSlideOut({ role: 'Assessment Official', isSuperAdmin: true }), true);
  assert.equal(canAdministerHelpdeskFromSlideOut({ role: 'Assessment Official', accountRole: 'official', isSuperAdmin: false }), false);
  assert.equal(canAdministerHelpdeskFromSlideOut({ role: 'Assessment Official' }), false);
  assert.equal(canAdministerHelpdeskFromSlideOut({ role: 'Test Center Admin', accountRole: 'center', isSuperAdmin: true }), false);
  assert.equal(canAdministerHelpdeskFromSlideOut({ role: 'Registered Candidate', accountRole: 'candidate' }), false);
  assert.equal(canAdministerHelpdeskFromSlideOut(null), false);
});

test('every hidden control has explanatory text', () => {
  for (const [key, text] of Object.entries(SUPER_ADMIN_ONLY_TEXT)) {
    assert.ok(text.length > 20, key);
  }
  assert.match(SUPER_ADMIN_ONLY_TEXT.institutionDocuments, /preview, download and review/i);
});
