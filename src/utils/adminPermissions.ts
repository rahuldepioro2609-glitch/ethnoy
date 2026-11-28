// Frontend visibility rules for the P0-3 authorization policy.
//
// These decide only what the dashboard shows and requests. Every rule is also enforced by the
// backend (A-19), which returns 403 regardless of what the UI does. Pure functions, no React,
// so they are unit-tested under src/utils.

export interface PermissionSubject {
  role: string;
  isSuperAdmin?: boolean | null;
}

/** True only for an Official account flagged as Super Admin (mirrors the backend guard). */
export function isSuperAdminOfficial(user: PermissionSubject | null | undefined): boolean {
  return Boolean(user) && user!.role === 'official' && user!.isSuperAdmin === true;
}

export interface AdminPermissions {
  /** A-02: record wallet credits. */
  canCreditWallets: boolean;
  /** A-03: approve, reject or mark withdrawals paid. */
  canManageWithdrawals: boolean;
  /** A-04: publish or unpublish results; correct published results. */
  canPublishResults: boolean;
  /** A-05: publish or unpublish answer keys. */
  canPublishAnswerKeys: boolean;
  /** A-05: publish or unpublish online exam papers. */
  canPublishOnlineExams: boolean;
  /** A-17: publish or unpublish public notices. */
  canPublishNotices: boolean;
  /** A-16: import corrections over published content (returns it to draft). */
  canCorrectPublishedContent: boolean;
  /** A-06 / P3-D1: interim admit-card imports and assignments. */
  canWriteAdmitCards: boolean;
  /** A-14: helpdesk tickets, including the admin view in the feedback slide-out. */
  canAccessHelpdesk: boolean;
  /** P3-D4: the open-helpdesk ticket count. */
  canSeeHelpdeskCount: boolean;
  /** A-09 / P3-D10: preview or download institution document content. */
  canOpenInstitutionDocuments: boolean;
  /** A-09: record document review decisions. */
  canReviewInstitutionDocuments: boolean;
  /** A-07: full Excel data export. */
  canExportData: boolean;
  /** A-18: draft imports of unpublished content stay open to every Official. */
  canImportDrafts: boolean;
}

export function adminPermissions(user: PermissionSubject | null | undefined): AdminPermissions {
  const official = Boolean(user) && user!.role === 'official';
  const superAdmin = isSuperAdminOfficial(user);
  return {
    canCreditWallets: superAdmin,
    canManageWithdrawals: superAdmin,
    canPublishResults: superAdmin,
    canPublishAnswerKeys: superAdmin,
    canPublishOnlineExams: superAdmin,
    canPublishNotices: superAdmin,
    canCorrectPublishedContent: superAdmin,
    canWriteAdmitCards: superAdmin,
    canAccessHelpdesk: superAdmin,
    canSeeHelpdeskCount: superAdmin,
    canOpenInstitutionDocuments: superAdmin,
    canReviewInstitutionDocuments: superAdmin,
    canExportData: superAdmin,
    canImportDrafts: official,
  };
}

/** Explanatory text shown in place of a hidden control. */
export const SUPER_ADMIN_ONLY_TEXT = {
  wallet: 'Recording wallet credits and handling withdrawals is limited to Super Admins. Balances are shown read-only.',
  publishing: 'Publishing and unpublishing is limited to Super Admins.',
  noticePublishing: 'Notice publishing and unpublishing is limited to Super Admins. All Officials may save drafts.',
  draftImports: 'You can import new drafts. Correcting content that is already published needs a Super Admin, and returns it to draft.',
  admitCards: 'Admit-card uploads publish cards immediately, so they are limited to Super Admins until a draft step is available.',
  helpdesk: 'Helpdesk tickets are limited to Super Admins.',
  institutionDocuments: 'Document preview, download and review decisions are limited to Super Admins. You can see the document list.',
  makerChecker: 'You approved this withdrawal, so a different Super Admin must mark it paid.',
  approverUnknown: 'No approver is recorded for this withdrawal, so it cannot be paid. Reject it and ask the institute to request it again.',
} as const;

export const ADMIN_DASHBOARD_TABS = [
  'overview', 'institutes', 'institution-documents', 'exams', 'notices', 'admit-cards', 'online-exams',
  'answer-keys', 'applications', 'feedback', 'attempts', 'results', 'data-export', 'platform-staff',
  'institute-verification', 'audit-log', 'merit-lists',
] as const;

export type AdminDashboardTab = (typeof ADMIN_DASHBOARD_TABS)[number];

/** Whether an Official dashboard tab is shown. Hidden tabs are also never loaded. */
export function canSeeAdminTab(user: PermissionSubject | null | undefined, tab: AdminDashboardTab): boolean {
  const permissions = adminPermissions(user);
  if (tab === 'feedback') return permissions.canAccessHelpdesk;
  if (tab === 'data-export') return permissions.canExportData;
  // SM-1: Platform Staff management and Organization Staff activation (Q115) are Super Admin only.
  if (tab === 'platform-staff') return isSuperAdminOfficial(user);
  // AUTH-1 / SM-2: institutional verification and suspension of Institutes are Super Admin only.
  if (tab === 'institute-verification') return isSuperAdminOfficial(user);
  // A-12: reading the audit log is Super Admin only (the server enforces it too).
  if (tab === 'audit-log') return isSuperAdminOfficial(user);
  // Merit lists show marks, which ordinary Officials do not see (A-04): Super Admin only.
  if (tab === 'merit-lists') return isSuperAdminOfficial(user);
  return true;
}

/** Whether the Official dashboard may request a data section (P3-D4: never helpdesk data for ordinary Officials). */
export function canLoadAdminSection(user: PermissionSubject | null | undefined, section: string): boolean {
  if (section === 'feedback') return adminPermissions(user).canAccessHelpdesk;
  return true;
}

export interface WithdrawalView {
  status?: unknown;
  approver_recorded?: unknown;
  reviewed_by_current_user?: unknown;
}

export type WithdrawalPaymentState = 'allowed' | 'not_allowed' | 'maker_checker' | 'approver_unknown' | 'not_approved';

/**
 * Whether "Mark paid" is offered. Mirrors the backend checks; the backend also requires at least
 * two active Super Admins, which the UI cannot see and reports through the 409 message.
 */
export function withdrawalPaymentState(
  user: PermissionSubject | null | undefined,
  withdrawal: WithdrawalView,
): WithdrawalPaymentState {
  if (!adminPermissions(user).canManageWithdrawals) return 'not_allowed';
  if (withdrawal.status !== 'approved') return 'not_approved';
  if (withdrawal.approver_recorded !== true) return 'approver_unknown';
  if (withdrawal.reviewed_by_current_user === true) return 'maker_checker';
  return 'allowed';
}

/**
 * The feedback slide-out receives the display label ("Assessment Official") plus the account role.
 * Only a Super Admin Official sees its admin view.
 */
export function canAdministerHelpdeskFromSlideOut(
  user: { role?: string; accountRole?: string; isSuperAdmin?: boolean | null } | null | undefined,
): boolean {
  if (!user) return false;
  const role = user.accountRole ?? (user.role === 'Assessment Official' ? 'official' : user.role ?? '');
  return adminPermissions({ role, isSuperAdmin: user.isSuperAdmin }).canAccessHelpdesk;
}
