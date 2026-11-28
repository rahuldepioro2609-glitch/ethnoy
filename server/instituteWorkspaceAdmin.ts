// Institute Workspace: ELTNOY Super Admin review and official publication (Product Owner decision
// D-02, Option B, 2026-11-27; A-04 and A-06 preserved).
//
// Institutes prepare exams, results and admit cards as drafts (server/instituteWorkspace.ts). Only a
// Super Admin, on the private Admin host, approves and publishes them here. Every route:
// - requires requireAuth + requireRoles('official') + requireSuperAdmin (and a ROUTE_POLICY entry);
// - changes rows only from the expected state (compare-and-set), so a concurrent Institute edit or a
//   second Super Admin decision is reported (409) instead of overwritten;
// - never creates content: it only moves Institute-prepared records between review states.
//
// AUDIT (A-11): every decision below writes its audit event (WORKSPACE_AUDIT_POINTS) through
// server/audit.ts in the same transaction; refusals (EXAM_NOT_APPROVED, RESULTS_CHANGED) are recorded as
// denied on their own transaction. There is no second audit system here.
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRoles, requireSuperAdmin, type AuthenticatedRequest } from './auth.js';
import { auditActor, recordAuditEvent, recordRefusedAuditEvent, type AuditAction } from './audit.js';
import { pool } from './db.js';
import { isValidExamTransition } from './instituteWorkspace.js';
import { OFFICIAL_EXAM_STATES, isOfficialExamState } from '../src/utils/workspaceExams.js';

const GUARDS = [requireAuth, requireRoles('official'), requireSuperAdmin] as const;

/** Audit events the integration must add (action name → when it is written). */
export const WORKSPACE_AUDIT_POINTS = Object.freeze({
  'workspace_exam.approved': 'POST /api/admin/institute-workspace/exams/:id/decision (approve)',
  'workspace_exam.changes_requested': 'POST /api/admin/institute-workspace/exams/:id/decision (request_changes)',
  'workspace_exam.published': 'POST /api/admin/institute-workspace/exams/:id/decision (publish)',
  'workspace_results.approved': 'POST /api/admin/institute-workspace/exams/:id/results/decision (approve)',
  'workspace_results.published': 'POST /api/admin/institute-workspace/exams/:id/results/decision (publish)',
  'workspace_results.returned': 'POST /api/admin/institute-workspace/exams/:id/results/decision (return)',
  'workspace_admit_cards.released': 'POST /api/admin/institute-workspace/exams/:id/admit-cards/decision (release)',
  'workspace_admit_cards.revoked': 'POST /api/admin/institute-workspace/exams/:id/admit-cards/decision (revoke)',
});

/** Exam decisions a Super Admin may take: decision → [required current status, new status]. */
export const EXAM_DECISIONS = Object.freeze({
  approve: ['pending_approval', 'approved'],
  request_changes: ['pending_approval', 'needs_changes'],
  publish: ['approved', 'published'],
} as const);

/** Result decisions for one exam: decision → [current status, new status]. */
export const RESULT_DECISIONS = Object.freeze({
  approve: ['moderated', 'approved'],
  publish: ['approved', 'published'],
  return: ['moderated', 'evaluated'],
} as const);

/** Admit-card decisions for one exam: decision → [current status, new status]. */
export const ADMIT_CARD_DECISIONS = Object.freeze({
  release: ['generated', 'released'],
  revoke: ['released', 'revoked'],
} as const);

const OFFICIAL_EXAM_GUARD = `EXISTS (SELECT 1 FROM institute_exams e WHERE e.id = $1 AND e.lifecycle_status IN (${OFFICIAL_EXAM_STATES.map((state) => `'${state}'`).join(', ')}))`;

export const WORKSPACE_ADMIN_SQL = Object.freeze({
  queueExams: `SELECT e.id, e.institute_id, u.display_name AS institute_name, e.exam_code, e.title, e.category, e.mode,
            e.lifecycle_status, e.exam_date, e.app_open_date, e.app_close_date, e.fee_paise, e.status_reason, e.updated_at
       FROM institute_exams e JOIN users u ON u.id = e.institute_id
      WHERE e.lifecycle_status IN ('pending_approval', 'approved')
      ORDER BY e.updated_at ASC LIMIT 200`,
  queueResults: `SELECT r.exam_id, e.exam_code, e.title, e.institute_id, u.display_name AS institute_name,
            count(*) FILTER (WHERE r.evaluation_status = 'moderated')::int AS ready_for_review,
            count(*) FILTER (WHERE r.evaluation_status = 'approved')::int AS approved,
            count(*) FILTER (WHERE r.evaluation_status = 'published')::int AS published,
            e.lifecycle_status AS exam_status
       FROM institute_exam_results r JOIN institute_exams e ON e.id = r.exam_id JOIN users u ON u.id = e.institute_id
      GROUP BY r.exam_id, e.exam_code, e.title, e.institute_id, u.display_name, e.lifecycle_status
     HAVING count(*) FILTER (WHERE r.evaluation_status IN ('moderated', 'approved')) > 0
      ORDER BY e.exam_code LIMIT 200`,
  queueAdmitCards: `SELECT h.exam_id, e.exam_code, e.title, e.institute_id, u.display_name AS institute_name,
            count(*) FILTER (WHERE h.release_status = 'generated' AND (h.application_id IS NULL OR a.review_status = 'verified'))::int AS drafts,
            count(*) FILTER (WHERE h.release_status = 'generated' AND h.application_id IS NOT NULL AND a.review_status IS DISTINCT FROM 'verified')::int AS held_drafts,
            e.lifecycle_status AS exam_status,
            count(*) FILTER (WHERE h.release_status = 'released')::int AS released
       FROM institute_hall_tickets h JOIN institute_exams e ON e.id = h.exam_id JOIN users u ON u.id = e.institute_id
       LEFT JOIN institute_candidate_applications a ON a.id = h.application_id
      GROUP BY h.exam_id, e.exam_code, e.title, e.institute_id, u.display_name, e.lifecycle_status
     HAVING count(*) FILTER (WHERE h.release_status IN ('generated', 'released')) > 0
      ORDER BY e.exam_code LIMIT 200`,
  exam: 'SELECT id, institute_id, exam_code, lifecycle_status FROM institute_exams WHERE id = $1',
  examResults: `SELECT id, roll_number, candidate_name, raw_score, max_score, percentage, qualifying_status, evaluation_status, version, updated_at
       FROM institute_exam_results WHERE exam_id = $1 ORDER BY roll_number LIMIT 2000`,
  decideExam: `UPDATE institute_exams
       SET lifecycle_status = $3,
           status_reason = CASE WHEN $4 <> '' THEN $4 ELSE status_reason END,
           approved_by = CASE WHEN $3 = 'approved' THEN $5 ELSE approved_by END,
           updated_at = now()
     WHERE id = $1 AND lifecycle_status = $2
     RETURNING id, institute_id, exam_code, lifecycle_status, status_reason`,
  // Approve: only the result versions the Super Admin reviewed ($5: 'id:version' strings), and only while the
  // exam is in an official state. A result the Institute rewrote since then has a new version and is skipped,
  // so the route rolls back and reports it.
  approveResults: `UPDATE institute_exam_results
       SET evaluation_status = 'approved', final_approved_by = $4, updated_at = now()
     WHERE exam_id = $1 AND evaluation_status = $2 AND $3 = 'approved'
       AND (id || ':' || version) = ANY($5::text[])
       AND ${OFFICIAL_EXAM_GUARD}`,
  publishResults: `UPDATE institute_exam_results
       SET evaluation_status = $3, final_approved_by = $4, published_at = now(), updated_at = now()
     WHERE exam_id = $1 AND evaluation_status = $2 AND $3 = 'published'
       AND ${OFFICIAL_EXAM_GUARD}`,
  returnResults: `UPDATE institute_exam_results
       SET evaluation_status = $3, updated_at = now()
     WHERE exam_id = $1 AND evaluation_status = $2 AND $3 = 'evaluated'`,
  // Release: only drafts whose application is still verified (or that have no application), while the exam is
  // in an official state. Revoke: any released card, in any exam state.
  releaseAdmitCards: `UPDATE institute_hall_tickets h
       SET release_status = $3, released_at = now()
     WHERE h.exam_id = $1 AND h.release_status = $2 AND $3 = 'released'
       AND (h.application_id IS NULL OR EXISTS (SELECT 1 FROM institute_candidate_applications a WHERE a.id = h.application_id AND a.review_status = 'verified'))
       AND ${OFFICIAL_EXAM_GUARD}`,
  revokeAdmitCards: `UPDATE institute_hall_tickets
       SET release_status = $3
     WHERE exam_id = $1 AND release_status = $2 AND $3 = 'revoked'`,
});

const idSchema = z.string().uuid();

// Results are approved or published, and admit cards released, only while the exam is in an official state
// (OFFICIAL_EXAM_STATES, shared with the screen): never for a draft, an exam awaiting review, or a cancelled or
// archived one. Revoking cards and returning results stay possible in any state.
export { OFFICIAL_EXAM_STATES };


function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    response.set('Cache-Control', 'no-store');
    handler(request, response).catch(next);
  };
}

function superAdminId(request: Request): string {
  return (request as AuthenticatedRequest).user!.id;
}

async function findExam(request: Request, response: Response) {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: 'Invalid examination id.' });
    return null;
  }
  const { rows } = await pool.query(WORKSPACE_ADMIN_SQL.exam, [id.data]);
  if (!rows[0]) {
    response.status(404).json({ error: 'Examination not found.' });
    return null;
  }
  return rows[0] as { id: string; institute_id: string; exam_code: string; lifecycle_status: string };
}

/** Audit events for each Super Admin decision (A-11), written in the decision's transaction. */
const EXAM_DECISION_EVENT: Readonly<Record<keyof typeof EXAM_DECISIONS, AuditAction>> = Object.freeze({
  approve: 'workspace_exam.approved', request_changes: 'workspace_exam.changes_requested', publish: 'workspace_exam.published',
});
const RESULT_DECISION_EVENT: Readonly<Record<keyof typeof RESULT_DECISIONS, AuditAction>> = Object.freeze({
  approve: 'workspace_results.approved', publish: 'workspace_results.published', return: 'workspace_results.returned',
});
const ADMIT_CARD_DECISION_EVENT: Readonly<Record<keyof typeof ADMIT_CARD_DECISIONS, AuditAction>> = Object.freeze({
  release: 'workspace_admit_cards.released', revoke: 'workspace_admit_cards.revoked',
});

/**
 * 409 unless the exam was approved by ELTNOY; the SQL repeats the check atomically. Returns true when allowed.
 * A refusal is recorded as a denied event on its own transaction (never changes the response).
 */
async function refuseUnlessOfficial(request: Request, exam: { id: string; institute_id: string; exam_code: string; lifecycle_status: string }, response: Response, what: string, action: AuditAction): Promise<boolean> {
  if (isOfficialExamState(exam.lifecycle_status)) return true;
  await recordRefusedAuditEvent(pool, {
    action, actor: auditActor(request), outcome: 'denied', reasonCode: 'exam_not_approved',
    organizationId: exam.institute_id, resourceId: exam.id, metadata: { exam_code: exam.exam_code },
  });
  response.status(409).json({
    error: `This examination is ${exam.lifecycle_status.replace(/_/g, ' ')}. Its ${what} can only be released or published after ELTNOY approves the examination, and never once it is cancelled or archived.`,
    code: 'EXAM_NOT_APPROVED',
  });
  return false;
}

class ResultsChangedError extends Error {}

/** One transaction on its own connection; rolls back on any error. */
async function withTransaction<T>(work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
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

export function createInstituteWorkspaceAdminRouter(): Router {
  const router = express.Router();

  router.get('/admin/institute-workspace/review-queue', ...GUARDS, route(async (_request, response) => {
    const [exams, results, admitCards] = await Promise.all([
      pool.query(WORKSPACE_ADMIN_SQL.queueExams),
      pool.query(WORKSPACE_ADMIN_SQL.queueResults),
      pool.query(WORKSPACE_ADMIN_SQL.queueAdmitCards),
    ]);
    response.json({ exams: exams.rows, results: results.rows, admitCards: admitCards.rows });
  }));

  router.post('/admin/institute-workspace/exams/:id/decision', ...GUARDS, route(async (request, response) => {
    const parsed = z.object({
      decision: z.enum(['approve', 'request_changes', 'publish']),
      reason: z.string().trim().max(500).default(''),
    }).strict().safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ error: 'Choose approve, request_changes or publish.' });
      return;
    }
    if (parsed.data.decision === 'request_changes' && parsed.data.reason.length < 5) {
      response.status(400).json({ error: 'Tell the institute what to change (at least 5 characters).' });
      return;
    }
    const exam = await findExam(request, response);
    if (!exam) return;
    const [from, to] = EXAM_DECISIONS[parsed.data.decision];
    if (exam.lifecycle_status !== from || !isValidExamTransition(from, to)) {
      response.status(409).json({ error: `This examination is ${exam.lifecycle_status.replace(/_/g, ' ')}; it cannot be ${parsed.data.decision.replace(/_/g, ' ')}d now.`, code: 'INVALID_TRANSITION' });
      return;
    }
    // A-11: the decision and its audit event commit together.
    const rows = await withTransaction(async (client) => {
      const result = await client.query(WORKSPACE_ADMIN_SQL.decideExam, [exam.id, from, to, parsed.data.reason, superAdminId(request)]);
      if (result.rows[0]) {
        await recordAuditEvent(client, {
          action: EXAM_DECISION_EVENT[parsed.data.decision], actor: auditActor(request), organizationId: exam.institute_id, resourceId: exam.id,
          metadata: { exam_code: exam.exam_code, previous_status: from, new_status: to, ...(parsed.data.decision === 'request_changes' ? { reason_text: parsed.data.reason } : {}) },
        });
      }
      return result.rows;
    });
    if (!rows[0]) {
      response.status(409).json({ error: 'The examination changed while your request was processed. Reload and try again.', code: 'EXAM_CHANGED' });
      return;
    }
    response.json({ exam: rows[0] });
  }));

  router.get('/admin/institute-workspace/exams/:id/results', ...GUARDS, route(async (request, response) => {
    const exam = await findExam(request, response);
    if (!exam) return;
    const { rows } = await pool.query(WORKSPACE_ADMIN_SQL.examResults, [exam.id]);
    response.json({ exam, results: rows });
  }));

  router.post('/admin/institute-workspace/exams/:id/results/decision', ...GUARDS, route(async (request, response) => {
    const parsed = z.object({
      decision: z.enum(['approve', 'publish', 'return']),
      // For approve: the results the Super Admin reviewed, each with the version that was shown.
      reviewed: z.array(z.object({ id: z.string().min(1).max(64), version: z.coerce.number().int().positive() }).strict()).max(2000).optional(),
    }).strict().safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ error: 'Choose approve, publish or return.' });
      return;
    }
    const reviewed = parsed.data.reviewed ?? [];
    if (parsed.data.decision === 'approve' && reviewed.length === 0) {
      response.status(400).json({ error: 'Open the results and approve the ones you reviewed.', code: 'REVIEW_REQUIRED' });
      return;
    }
    const exam = await findExam(request, response);
    if (!exam) return;
    const event = RESULT_DECISION_EVENT[parsed.data.decision];
    if (parsed.data.decision !== 'return' && !(await refuseUnlessOfficial(request, exam, response, 'results', event))) return;
    const [from, to] = RESULT_DECISIONS[parsed.data.decision];
    let updated: number;
    try {
      updated = await withTransaction(async (client) => {
        let rowCount: number;
        if (parsed.data.decision === 'return') rowCount = (await client.query(WORKSPACE_ADMIN_SQL.returnResults, [exam.id, from, to])).rowCount ?? 0;
        else if (parsed.data.decision === 'publish') rowCount = (await client.query(WORKSPACE_ADMIN_SQL.publishResults, [exam.id, from, to, superAdminId(request)])).rowCount ?? 0;
        else {
          rowCount = (await client.query(WORKSPACE_ADMIN_SQL.approveResults, [exam.id, from, to, superAdminId(request), reviewed.map((row) => `${row.id}:${row.version}`)])).rowCount ?? 0;
          // All or nothing: one reviewed result that changed (new version), moved on, or is missing rolls back the rest.
          if (rowCount !== reviewed.length) throw new ResultsChangedError();
        }
        // A-11: recorded in the same transaction, only when something changed.
        if (rowCount > 0) {
          await recordAuditEvent(client, { action: event, actor: auditActor(request), organizationId: exam.institute_id, resourceId: exam.id, metadata: { exam_code: exam.exam_code, row_count: rowCount } });
        }
        return rowCount;
      });
    } catch (error) {
      if (!(error instanceof ResultsChangedError)) throw error;
      await recordRefusedAuditEvent(pool, {
        action: event, actor: auditActor(request), outcome: 'denied', reasonCode: 'results_changed',
        organizationId: exam.institute_id, resourceId: exam.id, metadata: { exam_code: exam.exam_code },
      });
      response.status(409).json({ error: 'Some of these results changed after you reviewed them, or are no longer ready. Nothing was approved; open the results again.', code: 'RESULTS_CHANGED' });
      return;
    }
    if (!updated) {
      response.status(409).json({ error: `No results of this examination are ${from === 'moderated' ? 'ready for review' : 'approved'}.`, code: 'NOTHING_TO_DECIDE' });
      return;
    }
    response.json({ examId: exam.id, decision: parsed.data.decision, updated });
  }));

  router.post('/admin/institute-workspace/exams/:id/admit-cards/decision', ...GUARDS, route(async (request, response) => {
    const parsed = z.object({ decision: z.enum(['release', 'revoke']) }).strict().safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ error: 'Choose release or revoke.' });
      return;
    }
    const exam = await findExam(request, response);
    if (!exam) return;
    const event = ADMIT_CARD_DECISION_EVENT[parsed.data.decision];
    if (parsed.data.decision === 'release' && !(await refuseUnlessOfficial(request, exam, response, 'admit cards', event))) return;
    const [from, to] = ADMIT_CARD_DECISIONS[parsed.data.decision];
    const sql = parsed.data.decision === 'release' ? WORKSPACE_ADMIN_SQL.releaseAdmitCards : WORKSPACE_ADMIN_SQL.revokeAdmitCards;
    // A-11: the release or revocation and its audit event commit together.
    const rowCount = await withTransaction(async (client) => {
      const count = (await client.query(sql, [exam.id, from, to])).rowCount ?? 0;
      if (count > 0) await recordAuditEvent(client, { action: event, actor: auditActor(request), organizationId: exam.institute_id, resourceId: exam.id, metadata: { exam_code: exam.exam_code, row_count: count } });
      return count;
    });
    if (!rowCount) {
      response.status(409).json({ error: `No admit cards of this examination can be ${parsed.data.decision === 'release' ? 'released (drafts of verified applications)' : 'revoked'}.`, code: 'NOTHING_TO_DECIDE' });
      return;
    }
    response.json({ examId: exam.id, decision: parsed.data.decision, updated: rowCount });
  }));

  return router;
}
