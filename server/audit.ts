// A-11 / A-12 / A-13: the single writer and reader for the platform audit trail (`audit_events`,
// server/auditEventsMigration.sql). Design: docs/architecture/audit-infrastructure-proposal.md.
//
// Rules enforced here:
// - Every action has a contract: its category, resource type, retention class and an allow-list of
//   metadata keys with types. Unknown keys, wrong types and secret-like keys are refused, so a
//   password, one-time code, token, cookie, answer or file content can never be recorded by mistake.
// - A successful action is recorded on the SAME transaction client as the action itself (A-11): the
//   caller passes its transaction client, and a failed audit insert throws, which rolls the action
//   back. Passing the shared pool is refused.
// - Actor names and contact details are never copied into a row; the viewer looks names up at read
//   time (data minimisation, proposal OD-4).
// - Nothing here exposes a read path: the viewer routes (server/auditRoutes.ts) are Super Admin only
//   (A-12).
//
// This module imports no database pool, so database-free stores (authVerificationStore) can use it.
import type { Request } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { AuthenticatedRequest } from './auth.js';

type MetadataType = 'string' | 'integer' | 'boolean' | 'string[]';

interface AuditContract {
  readonly category: 'auth' | 'account' | 'organization' | 'permission' | 'application' | 'review' | 'publishing'
    | 'document' | 'exam' | 'finance' | 'payment' | 'admin' | 'security' | 'audit' | 'operations';
  readonly resourceType: string;
  readonly retention: 'security' | 'financial' | 'governance' | 'access' | 'operational';
  readonly metadata: Readonly<Record<string, MetadataType>>;
  /** Metadata keys that must be present. */
  readonly required?: readonly string[];
}

/** Free text typed by a person (for example a rejection reason): optional and length-limited. */
const REASON_TEXT_MAX = 500;
const STRING_MAX = 200;
const LIST_MAX = 50;

export const AUDIT_CONTRACTS = Object.freeze({
  // Publishing (A-04, A-05, A-06, A-17)
  'notice.created': { category: 'publishing', resourceType: 'notice', retention: 'governance', metadata: { category: 'string', reference_number: 'string', is_published: 'boolean' } },
  'notice.publication_changed': { category: 'publishing', resourceType: 'notice', retention: 'governance', metadata: { is_published: 'boolean' }, required: ['is_published'] },
  'admit_cards.imported': { category: 'publishing', resourceType: 'admit_card_batch', retention: 'governance', metadata: { row_count: 'integer', exam_codes: 'string[]' }, required: ['row_count'] },
  'admit_card.assigned': { category: 'publishing', resourceType: 'application', retention: 'governance', metadata: { exam_code: 'string', center_code: 'string' } },
  'answer_keys.imported': { category: 'publishing', resourceType: 'answer_key_batch', retention: 'governance', metadata: { row_count: 'integer', exam_codes: 'string[]', returned_to_draft: 'integer' }, required: ['row_count'] },
  'answer_key.publication_changed': { category: 'publishing', resourceType: 'answer_key', retention: 'governance', metadata: { is_published: 'boolean', question_count: 'integer' }, required: ['is_published'] },
  'online_exams.imported': { category: 'publishing', resourceType: 'online_exam_batch', retention: 'governance', metadata: { row_count: 'integer', exam_codes: 'string[]', returned_to_draft: 'integer' }, required: ['row_count'] },
  'online_exam.publication_changed': { category: 'publishing', resourceType: 'online_exam', retention: 'governance', metadata: { is_published: 'boolean', question_count: 'integer' }, required: ['is_published'] },
  'results.imported': { category: 'publishing', resourceType: 'result_batch', retention: 'governance', metadata: { row_count: 'integer', exam_codes: 'string[]', returned_to_draft: 'integer' }, required: ['row_count'] },
  'result.written': { category: 'publishing', resourceType: 'result', retention: 'governance', metadata: { exam_code: 'string', returned_to_draft: 'boolean' } },
  'result.publication_changed': { category: 'publishing', resourceType: 'result', retention: 'governance', metadata: { is_published: 'boolean', exam_code: 'string' }, required: ['is_published'] },
  // Exams (A-18: any Official may create; publishing is recorded as a field change)
  'exam.created': { category: 'exam', resourceType: 'exam', retention: 'governance', metadata: { exam_code: 'string', is_published: 'boolean' } },
  'exam.updated': { category: 'exam', resourceType: 'exam', retention: 'governance', metadata: { exam_code: 'string', is_published: 'boolean' } },
  'checkin.recorded': { category: 'exam', resourceType: 'center_checkin', retention: 'governance', metadata: { status: 'string', exam_code: 'string' } },
  // Institutions (A-01 and the Institute workspace)
  'institution.status_changed': { category: 'organization', resourceType: 'institution', retention: 'governance', metadata: { previous_status: 'string', new_status: 'string', reason_text: 'string' }, required: ['new_status'] },
  'institution.resubmitted': { category: 'organization', resourceType: 'institution', retention: 'governance', metadata: {} },
  'institution.form_submitted': { category: 'organization', resourceType: 'institute_form', retention: 'governance', metadata: { form_type: 'string' } },
  'institution.form_decided': { category: 'review', resourceType: 'institute_form', retention: 'governance', metadata: { decision: 'string' }, required: ['decision'] },
  'institution.profile_change_requested': { category: 'organization', resourceType: 'profile_change', retention: 'governance', metadata: { changed_fields: 'string[]' } },
  'institution.profile_change_decided': { category: 'review', resourceType: 'profile_change', retention: 'governance', metadata: { decision: 'string', changed_fields: 'string[]' }, required: ['decision'] },
  'institution.verification_decided': { category: 'review', resourceType: 'institution', retention: 'governance', metadata: { decision: 'string', previous_status: 'string', reason_text: 'string' }, required: ['decision'] },
  // Applications (A-08 keeps contact details out; only statuses are recorded)
  'application.status_changed': { category: 'application', resourceType: 'application', retention: 'governance', metadata: { previous_status: 'string', new_status: 'string' }, required: ['new_status'] },
  'application.ownership_linked': { category: 'application', resourceType: 'application', retention: 'governance', metadata: { verification_method: 'string' } },
  // Merit List Engine foundation: draft versions and exports (no publication route exists, ML-6).
  'merit_list.snapshot_created': { category: 'publishing', resourceType: 'merit_list_snapshot', retention: 'governance', metadata: { exam_code: 'string', version: 'integer', entry_count: 'integer', excluded_count: 'integer', tie_group_count: 'integer', issue_count: 'integer' }, required: ['exam_code', 'version'] },
  'merit_list.exported': { category: 'publishing', resourceType: 'merit_list_snapshot', retention: 'access', metadata: { exam_code: 'string', version: 'integer', row_count: 'integer' }, required: ['exam_code', 'version'] },
  // Finance (A-02, A-03). The ledger stays authoritative; these rows are never summed.
  'wallet.credited': { category: 'finance', resourceType: 'wallet_entry', retention: 'financial', metadata: { amount_paise: 'integer', payment_reference: 'string' }, required: ['amount_paise'] },
  'withdrawal.requested': { category: 'finance', resourceType: 'withdrawal', retention: 'financial', metadata: { amount_paise: 'integer' }, required: ['amount_paise'] },
  'withdrawal.approved': { category: 'finance', resourceType: 'withdrawal', retention: 'financial', metadata: { amount_paise: 'integer', previous_status: 'string' } },
  'withdrawal.rejected': { category: 'finance', resourceType: 'withdrawal', retention: 'financial', metadata: { amount_paise: 'integer', previous_status: 'string' } },
  // AL-4.8: a refused payment (maker-checker and related rules), recorded outside the rolled-back transaction.
  'withdrawal.payment_refused': { category: 'finance', resourceType: 'withdrawal', retention: 'financial', metadata: { amount_paise: 'integer', approver_user_id: 'string' } },
  // Proposal §7 failure contracts: recorded after the rollback through recordRefusedAuditEvent.
  'wallet.credit_failed': { category: 'finance', resourceType: 'wallet_entry', retention: 'financial', metadata: { amount_paise: 'integer', payment_reference: 'string' } },
  'withdrawal.payment_failed': { category: 'finance', resourceType: 'withdrawal', retention: 'financial', metadata: {} },
  'withdrawal.paid': { category: 'finance', resourceType: 'withdrawal', retention: 'financial', metadata: { amount_paise: 'integer', approver_user_id: 'string', transfer_reference: 'string' }, required: ['approver_user_id'] },
  // Administration
  'helpdesk.ticket_updated': { category: 'admin', resourceType: 'feedback', retention: 'operational', metadata: { new_status: 'string' } },
  'data_export.generated': { category: 'admin', resourceType: 'data_export', retention: 'access', metadata: { sheet_count: 'integer', row_count: 'integer' }, required: ['row_count'] },
  // Documents (A-09)
  'document.review_recorded': { category: 'document', resourceType: 'document_version', retention: 'governance', metadata: { decision_code: 'string', document_id: 'string' } },
  // Sessions (sign-in events live in auth_verification_events; sign-out is recorded here)
  'session.logged_out': { category: 'auth', resourceType: 'session', retention: 'security', metadata: {} },
  // The viewer records its own use (no recursion: reads never trigger reads)
  'audit.searched': { category: 'audit', resourceType: 'audit_log', retention: 'access', metadata: { result_count: 'integer', filter_keys: 'string[]' }, required: ['result_count'] },
  // Institute Workspace (D-02; documentation/WORKSPACE_STATUS.md). organizationId is the Institute. Codes,
  // counts, statuses and reasons only: never candidate names, contact details, scores with names, or
  // question content.
  'workspace_exam.created': { category: 'exam', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', new_status: 'string', exam_type: 'string' }, required: ['exam_code'] },
  // Edits to a draft or returned examination: the names of the changed columns ('exam_config' for the wizard
  // configuration), never their values.
  'workspace_exam.updated': { category: 'exam', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', changed_fields: 'string[]', previous_status: 'string', new_status: 'string', exam_type: 'string' }, required: ['changed_fields', 'new_status'] },
  'workspace_exam.status_changed': { category: 'exam', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', previous_status: 'string', new_status: 'string', reason_text: 'string' }, required: ['new_status'] },
  'workspace_exam.approved': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', previous_status: 'string', new_status: 'string' }, required: ['exam_code'] },
  'workspace_exam.changes_requested': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', previous_status: 'string', new_status: 'string', reason_text: 'string' }, required: ['exam_code'] },
  'workspace_exam.published': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', previous_status: 'string', new_status: 'string' }, required: ['exam_code'] },
  'workspace_results.written': { category: 'exam', resourceType: 'institute_result', retention: 'governance', metadata: { exam_code: 'string', roll_number: 'string', version: 'integer', corrected: 'boolean' }, required: ['roll_number'] },
  'workspace_results.marked_ready': { category: 'exam', resourceType: 'institute_result', retention: 'governance', metadata: { roll_number: 'string', previous_status: 'string', new_status: 'string' }, required: ['new_status'] },
  'workspace_results.approved': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', row_count: 'integer' }, required: ['exam_code'] },
  'workspace_results.published': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', row_count: 'integer' }, required: ['exam_code'] },
  'workspace_results.returned': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', row_count: 'integer' }, required: ['exam_code'] },
  'workspace_admit_cards.generated': { category: 'exam', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', row_count: 'integer' }, required: ['row_count'] },
  'workspace_admit_cards.released': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', row_count: 'integer' }, required: ['exam_code'] },
  'workspace_admit_cards.revoked': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { exam_code: 'string', row_count: 'integer' }, required: ['exam_code'] },
  // D-02 refusals of an Institute's attempt to approve, publish or release (recorded with outcome 'denied').
  'workspace_publication.refused': { category: 'publishing', resourceType: 'institute_exam', retention: 'governance', metadata: { target: 'string', requested_status: 'string' }, required: ['target'] },
  'workspace_application.created': { category: 'application', resourceType: 'institute_application', retention: 'governance', metadata: { application_number: 'string', new_status: 'string' }, required: ['application_number'] },
  'workspace_application.reviewed': { category: 'review', resourceType: 'institute_application', retention: 'governance', metadata: { application_number: 'string', previous_status: 'string', new_status: 'string', reason_text: 'string' }, required: ['new_status'] },
  'workspace_question.created': { category: 'exam', resourceType: 'institute_question', retention: 'governance', metadata: { question_type: 'string', new_status: 'string' }, required: ['new_status'] },
  'workspace_question.moderated': { category: 'review', resourceType: 'institute_question', retention: 'governance', metadata: { previous_status: 'string', new_status: 'string' }, required: ['new_status'] },
  'workspace_paper.locked': { category: 'exam', resourceType: 'institute_paper', retention: 'governance', metadata: { question_count: 'integer' } },
  'workspace_attendance.marked': { category: 'exam', resourceType: 'institute_attendance_mark', retention: 'governance', metadata: { exam_code: 'string', status: 'string', reason_text: 'string' }, required: ['status'] },
  'workspace_interview.scheduled': { category: 'review', resourceType: 'institute_interview', retention: 'governance', metadata: { scheduled_date: 'string' }, required: ['scheduled_date'] },
  'workspace_interview.cancelled': { category: 'review', resourceType: 'institute_interview', retention: 'governance', metadata: { previous_date: 'string', reason_text: 'string' }, required: ['reason_text'] },
  'workspace_interview.rescheduled': { category: 'review', resourceType: 'institute_interview', retention: 'governance', metadata: { previous_date: 'string', new_date: 'string', reason_text: 'string' }, required: ['new_date', 'reason_text'] },
  'workspace_scorecard.submitted': { category: 'review', resourceType: 'institute_interview', retention: 'governance', metadata: {} },
  'workspace_training.course_created': { category: 'operations', resourceType: 'institute_training_course', retention: 'operational', metadata: { module_count: 'integer' } },
  'workspace_training.learner_enrolled': { category: 'operations', resourceType: 'institute_training_course', retention: 'operational', metadata: {} },
  'workspace_training.session_scheduled': { category: 'operations', resourceType: 'institute_training_session', retention: 'operational', metadata: { scheduled_date: 'string' }, required: ['scheduled_date'] },
  'workspace_cbt_incident.reviewed': { category: 'review', resourceType: 'institute_cbt_incident', retention: 'governance', metadata: { review_status: 'string', reason_text: 'string' }, required: ['review_status'] },
  'workspace_refund.withdrawn': { category: 'finance', resourceType: 'institute_refund', retention: 'financial', metadata: {} },
  'workspace_refund.requested': { category: 'finance', resourceType: 'institute_refund', retention: 'financial', metadata: { amount_paise: 'integer' }, required: ['amount_paise'] },
  // Coordinator names and contact details stay in the branch row; the event records the code and what changed.
  'workspace_branch.created': { category: 'organization', resourceType: 'institute_branch', retention: 'governance', metadata: { branch_code: 'string' }, required: ['branch_code'] },
  'workspace_branch.updated': { category: 'organization', resourceType: 'institute_branch', retention: 'governance', metadata: { branch_code: 'string', changed_fields: 'string[]', new_status: 'string' }, required: ['changed_fields'] },
  'workspace_app_form.created': { category: 'application', resourceType: 'institute_app_form', retention: 'governance', metadata: { version: 'integer', new_status: 'string', field_count: 'integer' }, required: ['new_status'] },
  'workspace_app_form.status_changed': { category: 'application', resourceType: 'institute_app_form', retention: 'governance', metadata: { version: 'integer', new_status: 'string' }, required: ['new_status'] },
  'workspace_admit_card_template.created': { category: 'exam', resourceType: 'institute_admit_card_template', retention: 'governance', metadata: { show_photo: 'boolean', show_qr: 'boolean' } },
  'workspace_paper.created': { category: 'exam', resourceType: 'institute_paper', retention: 'governance', metadata: { question_count: 'integer', duration_minutes: 'integer' }, required: ['question_count'] },
  'workspace_report.saved': { category: 'operations', resourceType: 'institute_saved_report', retention: 'operational', metadata: { dataset: 'string', output_format: 'string' }, required: ['dataset'] },
} satisfies Record<string, AuditContract>);

export type AuditAction = keyof typeof AUDIT_CONTRACTS;

export type AuditActor =
  | { type: 'user'; userId: string; role: 'candidate' | 'center' | 'official' | 'super_admin' | 'staff' }
  | { type: 'system' }
  | { type: 'operator'; userId?: string };

export interface AuditEventInput {
  action: AuditAction;
  actor: AuditActor;
  outcome?: 'succeeded' | 'denied' | 'failed';
  reasonCode?: string;
  /** The institution the event belongs to (users.id of the institute). */
  organizationId?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditContractError extends Error {
  constructor(message: string) {
    super(`audit contract violation: ${message}`);
    this.name = 'AuditContractError';
  }
}

/** Key names that must never be recorded, whatever an action's contract says. */
const SECRET_KEY = /(pass(word)?|otp|code_hash|token|secret|cookie|api_?key|card|cvv|upi_?pin|session|answer|response|file_content|date_of_birth|dob|email|mobile|phone)/i;

function checkValue(action: string, key: string, type: MetadataType, value: unknown): unknown {
  const fail = () => { throw new AuditContractError(`${action}.${key} must be ${type}`); };
  switch (type) {
    case 'string': {
      if (typeof value !== 'string') return fail();
      const max = key === 'reason_text' ? REASON_TEXT_MAX : STRING_MAX;
      return value.length > max ? value.slice(0, max) : value;
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail();
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') return fail();
      return value;
    case 'string[]':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return fail();
      return (value as string[]).slice(0, LIST_MAX).map((item) => item.slice(0, STRING_MAX));
  }
}

export interface ValidatedAuditEvent {
  category: string;
  action: string;
  outcome: 'succeeded' | 'denied' | 'failed';
  reasonCode: string | null;
  actorType: 'user' | 'system' | 'operator';
  actorUserId: string | null;
  actorRole: string;
  organizationId: string | null;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  retentionClass: string;
}

/** Validates an event against its contract. Throws AuditContractError; never writes. */
export function validateAuditEvent(input: AuditEventInput): ValidatedAuditEvent {
  const contract = (AUDIT_CONTRACTS as Record<string, AuditContract>)[input.action];
  if (!contract) throw new AuditContractError(`unknown action ${String(input.action)}`);
  const outcome = input.outcome ?? 'succeeded';
  if (outcome !== 'succeeded' && !(input.reasonCode && /^[a-z][a-z0-9_]{0,63}$/.test(input.reasonCode))) {
    throw new AuditContractError(`${input.action}: a refused or failed event needs a reason code`);
  }
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (value === undefined || value === null) continue;
    if (SECRET_KEY.test(key)) throw new AuditContractError(`${input.action}: key ${key} looks sensitive and is never recorded`);
    const type = contract.metadata[key];
    if (!type) throw new AuditContractError(`${input.action}: key ${key} is not in the contract`);
    metadata[key] = checkValue(input.action, key, type, value);
  }
  for (const key of contract.required ?? []) {
    if (!(key in metadata)) throw new AuditContractError(`${input.action}: ${key} is required`);
  }
  const actor = input.actor;
  if (actor.type === 'user' && !actor.userId) throw new AuditContractError(`${input.action}: user actor without an id`);
  return {
    category: contract.category,
    action: input.action,
    outcome,
    reasonCode: outcome === 'succeeded' ? null : input.reasonCode!,
    actorType: actor.type,
    actorUserId: actor.type === 'system' ? null : actor.userId ?? null,
    actorRole: actor.type === 'user' ? actor.role : actor.type,
    organizationId: input.organizationId ? String(input.organizationId).slice(0, 200) : null,
    resourceType: contract.resourceType,
    resourceId: input.resourceId ? String(input.resourceId).slice(0, 200) : null,
    metadata,
    retentionClass: contract.retention,
  };
}

export const AUDIT_INSERT_SQL = `INSERT INTO audit_events
  (category, action, outcome, reason_code, actor_type, actor_user_id, actor_role, organization_id,
   resource_type, resource_id, metadata, retention_class)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`;

/** Anything with a text query method: a pg PoolClient, or the narrower clients some modules type. */
type QueryClient = { query(text: string, values?: unknown[]): Promise<unknown> };

/**
 * Records an event on the caller's TRANSACTION client (A-11). Any failure throws, so the caller's
 * transaction (and with it the action) rolls back. The shared pool is refused: a write there would
 * commit separately from the action.
 */
export async function recordAuditEvent(client: QueryClient, input: AuditEventInput): Promise<void> {
  // A pg Pool exposes totalCount; a checked-out transaction client does not.
  if (typeof (client as { totalCount?: unknown }).totalCount === 'number') {
    throw new AuditContractError('recordAuditEvent needs the action\'s transaction client, not the pool');
  }
  const event = validateAuditEvent(input);
  await client.query(AUDIT_INSERT_SQL, [
    event.category, event.action, event.outcome, event.reasonCode, event.actorType, event.actorUserId,
    event.actorRole, event.organizationId, event.resourceType, event.resourceId,
    JSON.stringify(event.metadata), event.retentionClass,
  ]);
}

/**
 * Runs `work` in one transaction on its own connection and commits only if it returns normally.
 * Use it for actions that used a single pool.query before, so the action and its audit event commit
 * together.
 */
export async function runAuditedTransaction<T>(pool: Pick<Pool, 'connect'>, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * AL-4.8 (proposal §9.3): records a REFUSED or FAILED action. That action rolled back, so there is no
 * business transaction to join: the event gets its own short transaction. It never throws and never
 * changes the response: if the write fails, a structured log line with the same allow-listed fields
 * (never values such as amounts or IDs beyond the action and reason) is written instead. Successful
 * actions must use recordAuditEvent inside their own transaction.
 */
export async function recordRefusedAuditEvent(pool: Pick<Pool, 'connect'>, input: AuditEventInput): Promise<boolean> {
  const outcome = input.outcome ?? 'succeeded';
  if (outcome === 'succeeded') throw new AuditContractError('recordRefusedAuditEvent is only for denied or failed actions');
  validateAuditEvent(input); // contract errors are programming errors: surface them
  try {
    await runAuditedTransaction(pool, (client) => recordAuditEvent(client, input));
    return true;
  } catch {
    console.error(JSON.stringify({ event: 'audit.write_failed', action: input.action, outcome, reason_code: input.reasonCode }));
    return false;
  }
}

/** The acting account of an authenticated request. Super Admin is recorded as its own role. */
export function auditActor(request: Request): AuditActor {
  const user = (request as AuthenticatedRequest).user;
  if (!user) throw new AuditContractError('audited action without an authenticated user');
  const role = user.role === 'official' && user.isSuperAdmin ? 'super_admin' : user.role;
  return { type: 'user', userId: user.id, role };
}
