// Institute Workspace: examination statuses and the actions an Institute may take (D-02).
// The server (server/instituteWorkspace.ts, isInstituteExamTransition) is the authority; this only decides
// which buttons to show. server/instituteWorkspace.test.ts checks that both agree.

export type ExamLifecycleStatus =
  | 'draft' | 'pending_approval' | 'needs_changes' | 'approved' | 'published'
  | 'registration_open' | 'closed' | 'cancelled' | 'archived';

export const EXAM_STATUS_LABEL: Readonly<Record<ExamLifecycleStatus, string>> = Object.freeze({
  draft: 'Draft',
  pending_approval: 'Awaiting ELTNOY review',
  needs_changes: 'Changes requested by ELTNOY',
  approved: 'Approved by ELTNOY',
  published: 'Published by ELTNOY',
  registration_open: 'Registration open',
  closed: 'Closed',
  cancelled: 'Cancelled',
  archived: 'Archived',
});

export interface InstituteExamAction {
  to: ExamLifecycleStatus;
  label: string;
  /** The server requires a reason of at least 5 characters. */
  needsReason: boolean;
}

/** D-02: preparation only. Approval, review outcomes and publication are ELTNOY Super Admin actions. */
const ACTIONS: Readonly<Partial<Record<ExamLifecycleStatus, readonly InstituteExamAction[]>>> = Object.freeze({
  draft: [
    { to: 'pending_approval', label: 'Submit for ELTNOY review', needsReason: false },
    { to: 'cancelled', label: 'Cancel', needsReason: true },
    { to: 'archived', label: 'Archive', needsReason: false },
  ],
  pending_approval: [{ to: 'cancelled', label: 'Withdraw and cancel', needsReason: true }],
  needs_changes: [
    { to: 'draft', label: 'Move back to draft', needsReason: false },
    { to: 'pending_approval', label: 'Resubmit for review', needsReason: false },
    { to: 'cancelled', label: 'Cancel', needsReason: true },
  ],
  cancelled: [{ to: 'archived', label: 'Archive', needsReason: false }],
});

export function instituteExamActions(status: string): readonly InstituteExamAction[] {
  return ACTIONS[status as ExamLifecycleStatus] ?? [];
}

/**
 * Exam states in which ELTNOY may approve or publish results and release admit cards (the exam itself was
 * approved by a Super Admin). Shared with server/instituteWorkspaceAdmin.ts, which enforces it.
 */
export const OFFICIAL_EXAM_STATES = Object.freeze(['approved', 'published', 'registration_open', 'closed'] as const);

export function isOfficialExamState(status: string): boolean {
  return (OFFICIAL_EXAM_STATES as readonly string[]).includes(status);
}

export function examStatusLabel(status: unknown): string {
  return typeof status === 'string' && status in EXAM_STATUS_LABEL ? EXAM_STATUS_LABEL[status as ExamLifecycleStatus] : 'Unknown';
}

/** ₹ amount from paise, for display only. */
export function formatPaise(value: unknown): string {
  const paise = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(paise)) return '—';
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export const EXAM_CATEGORIES = ['Scholarship', 'Recruitment', 'Admission', 'Mock', 'Certification', 'Other'] as const;
export const EXAM_MODES = ['Online CBT', 'Offline', 'Hybrid'] as const;
