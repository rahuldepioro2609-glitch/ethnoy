import { createHash, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRoles, type AuthenticatedRequest } from './auth.js';
import { pool } from './db.js';
import { auditActor, recordAuditEvent, recordRefusedAuditEvent, type AuditAction } from './audit.js';
import { providerStatus } from './verificationProviders.js';
import { questionShapeError } from '../src/utils/workspaceQuestions.js';
import { isValidTimeZone } from '../src/utils/examSchedule.js';
import { isInstituteEditableExam } from '../src/utils/workspaceExams.js';
import { examCategoryFor, examConfigDateIssues, examDbModeFor, examConfigSchema, examConfigTooLarge } from '../src/utils/examConfig.js';

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): express.RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function instituteIdOf(request: Request): string {
  return (request as AuthenticatedRequest).user!.id;
}

function sendValidationError(response: Response, error: z.ZodError): void {
  response.status(400).json({
    error: 'Invalid request.',
    details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  });
}

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '42P01';
}

/** JSON text with object keys sorted at every level, for comparing a request with a jsonb column. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505';
}

export const EXAM_LIFECYCLE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  draft: ['pending_approval', 'cancelled', 'archived'],
  pending_approval: ['approved', 'needs_changes', 'cancelled'],
  needs_changes: ['draft', 'pending_approval', 'cancelled'],
  approved: ['published', 'cancelled', 'archived'],
  published: ['registration_open', 'closed', 'cancelled', 'archived'],
  registration_open: ['closed', 'cancelled'],
  closed: ['archived', 'registration_open'],
  cancelled: ['archived'],
  archived: [],
});

export function isValidExamTransition(fromStatus: string, toStatus: string): boolean {
  const allowed = EXAM_LIFECYCLE_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

/**
 * Product Owner decision D-02 (Option B, 2026-11-27): Institutes prepare exams, admit cards, results
 * and merit-list drafts; the ELTNOY Super Admin reviews and officially publishes (A-04, A-06 preserved).
 *
 * The statuses below are official decisions and are therefore never set by an Institute route:
 * - exams: approved, needs_changes, published, registration_open, closed (reviewer and publication
 *   states), and any change to an exam once it has reached one of them;
 * - results: approved, published, and any change to a result in those states;
 * - admit cards (hall tickets): released, revoked.
 */
export const INSTITUTE_EXAM_TARGETS: ReadonlySet<string> = new Set(['draft', 'pending_approval', 'cancelled', 'archived']);
/** Exam states an Institute may still move out of (nothing official has happened yet). */
export const INSTITUTE_EXAM_EDITABLE_FROM: ReadonlySet<string> = new Set(['draft', 'pending_approval', 'needs_changes', 'cancelled']);
export const INSTITUTE_RESULT_STATUSES = ['evaluated', 'moderated'] as const;
export const OFFICIAL_RESULT_STATUSES: ReadonlySet<string> = new Set(['approved', 'published']);

/** Whether an Institute (not a Super Admin) may make this exam transition. */
export function isInstituteExamTransition(fromStatus: string, toStatus: string): boolean {
  return INSTITUTE_EXAM_EDITABLE_FROM.has(fromStatus) && INSTITUTE_EXAM_TARGETS.has(toStatus) && isValidExamTransition(fromStatus, toStatus);
}

/**
 * Question moderation inside an Institute's own bank. A question goes draft → in_review → approved or
 * rejected; any question not yet archived may be archived; nothing comes back from archived. There is no
 * route that edits a question, so a rejected question is not resubmitted unchanged: it is archived.
 */
export const QUESTION_MODERATION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  draft: ['in_review', 'archived'],
  in_review: ['approved', 'rejected', 'archived'],
  approved: ['archived'],
  rejected: ['archived'],
  archived: [],
});

export function isQuestionModerationTransition(fromStatus: string, toStatus: string): boolean {
  return QUESTION_MODERATION_TRANSITIONS[fromStatus]?.includes(toStatus) ?? false;
}

/** Shared with the question form (src/utils/workspaceQuestions.ts), so both apply the same rule. */
export { questionShapeError };

/**
 * Report datasets an Institute can view on screen. Every query is fixed (never built from input) and scoped
 * to the session Institute ($1). "fees" is left out: nothing records fee transactions yet (payments, F-6),
 * so it could only ever be empty. Export to a file is not offered: A-07 keeps full exports with the Super
 * Admin, and whether Institutes may export their applicant data is open (PERM-05).
 */
export const REPORT_DATASETS = ['applications', 'exams', 'attendance', 'results'] as const;
export const REPORT_ROW_LIMIT = 200;
export const REPORT_SQL: Readonly<Record<(typeof REPORT_DATASETS)[number], string>> = Object.freeze({
  applications: `SELECT a.application_number, a.candidate_name, e.exam_code, a.stage, a.payment_status, a.review_status, a.created_at
    FROM institute_candidate_applications a LEFT JOIN institute_exams e ON e.id = a.exam_id AND e.institute_id = a.institute_id
    WHERE a.institute_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
  exams: `SELECT exam_code, title, category, mode, exam_date, lifecycle_status, created_at
    FROM institute_exams WHERE institute_id = $1 ORDER BY created_at DESC LIMIT $2`,
  attendance: `SELECT l.roll_number, l.candidate_name, e.exam_code, l.center_name, l.session_name, l.status, l.reason, l.created_at
    FROM institute_attendance_logs l LEFT JOIN institute_exams e ON e.id = l.exam_id AND e.institute_id = l.institute_id
    WHERE l.institute_id = $1 ORDER BY l.created_at DESC LIMIT $2`,
  results: `SELECT e.exam_code, r.roll_number, r.candidate_name, r.raw_score, r.max_score, r.percentage, r.qualifying_status, r.evaluation_status
    FROM institute_exam_results r JOIN institute_exams e ON e.id = r.exam_id AND e.institute_id = r.institute_id
    WHERE r.institute_id = $1 ORDER BY e.created_at DESC, e.exam_code, r.percentage DESC, r.roll_number LIMIT $2`,
});

/** 24-hour HH:MM (00:00–23:59). */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Panelist names as compared for conflicts: comma-separated, trimmed, case-insensitive, de-duplicated. */
export function normalisePanelists(names: string): string[] {
  return [...new Set(names.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Interviews are scheduled in India time. A time zone may be sent; it must be a real zone, and only
 * Asia/Kolkata is supported, so a time is never silently read in the wrong zone.
 */
const interviewTimeZone = z.string().trim().min(1).max(64)
  .refine(isValidTimeZone, 'Choose a valid time zone.')
  .refine((zone) => zone === 'Asia/Kolkata', 'Interviews are scheduled in India time (Asia/Kolkata); other time zones are not supported.')
  .optional();

/** Today's calendar date in India (YYYY-MM-DD); interview dates are Indian calendar dates. */
export function indiaDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Interview queries. Fixed text; every one is scoped to the session Institute. */
const INTERVIEW_COLUMNS = `id, institute_id, exam_id, candidate_name, application_number, panel_name, panelist_names,
    to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date, start_time, end_time, mode, status, created_at, updated_at`;

export const INTERVIEW_SQL = Object.freeze({
  list: `SELECT ${INTERVIEW_COLUMNS} FROM institute_interviews WHERE institute_id = $1 ORDER BY scheduled_date DESC, start_time ASC LIMIT 100`,
  changes: `SELECT id, interview_id, action, reason, previous_json, new_json, created_at
    FROM institute_interview_changes WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 500`,
  // Overlap on the same day with the same panel (name) or any shared panelist; cancelled interviews never
  // count, so their slots are free again. $6: the requested panelists, normalised; $7: the interview being
  // rescheduled (excluded), or '' when booking a new one.
  conflict: `SELECT id, panel_name, panelist_names, candidate_name, start_time, end_time FROM institute_interviews
    WHERE institute_id = $1 AND scheduled_date = $3 AND status <> 'cancelled' AND id <> $7
      AND NOT (end_time <= $4 OR start_time >= $5)
      AND (lower(btrim(panel_name)) = lower(btrim($2))
        OR EXISTS (SELECT 1 FROM unnest(string_to_array(panelist_names, ',')) AS p(name) WHERE lower(btrim(p.name)) = ANY($6::text[])))
    ORDER BY start_time LIMIT 1`,
  current: `SELECT ${INTERVIEW_COLUMNS} FROM institute_interviews WHERE id = $1 AND institute_id = $2 FOR UPDATE`,
  hasScorecards: 'SELECT 1 FROM institute_interview_scorecards WHERE interview_id = $1 AND institute_id = $2 LIMIT 1',
  cancel: `UPDATE institute_interviews SET status = 'cancelled', updated_at = now()
    WHERE id = $1 AND institute_id = $2 AND status = 'scheduled' RETURNING ${INTERVIEW_COLUMNS}`,
  reschedule: `UPDATE institute_interviews
    SET scheduled_date = $3, start_time = $4, end_time = $5, panel_name = $6, panelist_names = $7, updated_at = now()
    WHERE id = $1 AND institute_id = $2 AND status = 'scheduled' RETURNING ${INTERVIEW_COLUMNS}`,
  insertChange: `INSERT INTO institute_interview_changes (id, institute_id, interview_id, action, reason, previous_json, new_json, actor_id)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$2) RETURNING id, interview_id, action, reason, previous_json, new_json, created_at`,
  insert: `INSERT INTO institute_interviews (id, institute_id, candidate_name, application_number, panel_name, panelist_names, scheduled_date, start_time, end_time, mode, consent_recorded, recording_enabled, meeting_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,'') RETURNING ${INTERVIEW_COLUMNS}`,
  forScorecard: "SELECT status, to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date FROM institute_interviews WHERE id = $1 AND institute_id = $2",
  panelistScorecard: 'SELECT 1 FROM institute_interview_scorecards WHERE interview_id = $1 AND institute_id = $2 AND lower(btrim(panelist_name)) = lower(btrim($3))',
  insertScorecard: `INSERT INTO institute_interview_scorecards (id, institute_id, interview_id, panelist_name, subject_score, communication_score, pedagogy_score, problem_solving_score, remarks)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
});

/** Training queries. Fixed text; every one is scoped to the session Institute. Dates are calendar dates. */
export const TRAINING_SQL = Object.freeze({
  courses: 'SELECT id, title, category, module_count, created_at FROM institute_training_courses WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 100',
  sessions: `SELECT id, course_id, title, to_char(session_date, 'YYYY-MM-DD') AS session_date, session_time, created_at
    FROM institute_training_sessions WHERE institute_id = $1 ORDER BY session_date ASC, session_time ASC LIMIT 100`,
  enrollments: 'SELECT id, course_id, learner_name, learner_email, created_at FROM institute_training_enrollments WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 200',
  insertCourse: 'INSERT INTO institute_training_courses (id, institute_id, title, category, module_count) VALUES ($1,$2,$3,$4,$5) RETURNING id, title, category, module_count, created_at',
  insertSession: `INSERT INTO institute_training_sessions (id, institute_id, course_id, title, session_date, session_time) VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, course_id, title, to_char(session_date, 'YYYY-MM-DD') AS session_date, session_time, created_at`,
  // A duplicate (same course and email, or same course and name without email) inserts nothing: the unique
  // indexes decide, so concurrent requests cannot both enrol the same learner.
  insertEnrollment: `INSERT INTO institute_training_enrollments (id, institute_id, course_id, learner_name, learner_email) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING
    RETURNING id, course_id, learner_name, learner_email, created_at`,
});

/** Exams that take no new admit cards or results. */
export const CLOSED_EXAM_STATES: ReadonlySet<string> = new Set(['cancelled', 'archived']);

function sendExamClosed(response: Response): void {
  response.status(409).json({ error: 'This examination is cancelled or archived; it takes no new admit cards or results.', code: 'EXAM_CLOSED' });
}

const REVIEW_WORDS: Readonly<Record<string, string>> = Object.freeze({ verified: 'verified', correction_requested: 'waiting for a correction', flagged: 'flagged', rejected: 'rejected', pending: 'pending' });

/** Application review queries. Fixed text; every one is scoped to the session Institute. */
export const APPLICATION_SQL = Object.freeze({
  current: 'SELECT review_status FROM institute_candidate_applications WHERE id = $1 AND institute_id = $2 FOR UPDATE',
  releasedCard: "SELECT 1 FROM institute_hall_tickets WHERE application_id = $1 AND institute_id = $2 AND release_status = 'released' LIMIT 1",
  review: `UPDATE institute_candidate_applications
    SET review_status = $3, review_reason = $4, reviewer_id = $2, updated_at = now()
    WHERE id = $1 AND institute_id = $2 AND review_status = $5
    RETURNING *`,
  log: `INSERT INTO institute_verification_logs (id, institute_id, application_id, reviewer_id, action, target_field, reason)
    VALUES ($1,$2,$3,$2,$4,$5,$6)`,
});

type InterviewRow = { id: string; status: string; scheduled_date: string; start_time: string; end_time: string; panel_name: string; panelist_names: string; candidate_name: string };
type InterviewSlot = { scheduledDate: string; startTime: string; endTime: string; panelName: string; panelistNames: string };
type InterviewConflict = { panel_name: string; panelist_names: string; candidate_name: string; start_time: string; end_time: string; shared: string[] };

/** The details a change preserves. */
function interviewSnapshot(row: InterviewRow): InterviewSlot & { status: string } {
  return { scheduledDate: row.scheduled_date, startTime: row.start_time, endTime: row.end_time, panelName: row.panel_name, panelistNames: row.panelist_names, status: row.status };
}

/** One lock per Institute and day: bookings and moves into that day cannot both pass the overlap check. */
async function lockInterviewDay(client: import('pg').PoolClient, instituteId: string, date: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`eltnoy.interviews:${instituteId}:${date}`]);
}

async function findInterviewConflict(client: import('pg').PoolClient, instituteId: string, slot: InterviewSlot, excludeId: string): Promise<InterviewConflict | null> {
  const wanted = normalisePanelists(slot.panelistNames);
  const { rows } = await client.query(INTERVIEW_SQL.conflict, [instituteId, slot.panelName, slot.scheduledDate, slot.startTime, slot.endTime, wanted, excludeId]);
  if (!rows[0]) return null;
  const row = rows[0] as Omit<InterviewConflict, 'shared'>;
  return { ...row, shared: normalisePanelists(String(row.panelist_names ?? '')).filter((name) => wanted.includes(name)) };
}

function sendPanelConflict(response: Response, conflict: InterviewConflict): void {
  const who = conflict.shared.length > 0 ? `Panelist ${conflict.shared.join(', ')}` : `Panel ${conflict.panel_name}`;
  response.status(409).json({
    error: `${who} already has an interview from ${conflict.start_time} to ${conflict.end_time} on that date.`,
    code: 'PANEL_CONFLICT',
  });
}

/** The interview, locked, if it may still be cancelled or rescheduled; otherwise the refusal. */
async function changeableInterview(client: import('pg').PoolClient, id: string, instituteId: string): Promise<{ interview: InterviewRow } | { status: 404 } | { status: 409; code: string; error: string }> {
  const { rows } = await client.query(INTERVIEW_SQL.current, [id, instituteId]);
  const interview = rows[0] as InterviewRow | undefined;
  if (!interview) return { status: 404 };
  if (interview.status === 'cancelled') return { status: 409, code: 'INTERVIEW_CANCELLED', error: 'This interview is already cancelled. Schedule a new interview instead.' };
  if (interview.status !== 'scheduled') return { status: 409, code: 'INTERVIEW_HELD', error: 'This interview has been held; it can no longer be cancelled or rescheduled.' };
  const scored = await client.query(INTERVIEW_SQL.hasScorecards, [id, instituteId]);
  if (scored.rows[0]) return { status: 409, code: 'INTERVIEW_HELD', error: 'This interview already has a scorecard, so it was held; it can no longer be cancelled or rescheduled.' };
  return { interview };
}

function sendInterviewOutcome(response: Response, outcome: { status: 404 } | { status: 409; code: string; error: string } | { status: 200; interview: unknown; change: unknown }): void {
  if (outcome.status === 404) { response.status(404).json({ error: 'Interview not found.' }); return; }
  if (outcome.status === 409) { response.status(409).json({ error: outcome.error, code: outcome.code }); return; }
  response.json({ interview: outcome.interview, change: outcome.change });
}

type Row = Record<string, unknown>;
/** An integer column for audit metadata, or nothing (the audit contract refuses anything else). */
const intOrNone = (value: unknown): number | undefined => (Number.isSafeInteger(Number(value)) && value !== null && value !== '' ? Number(value) : undefined);
type WorkspaceEvent = { action: AuditAction; resourceId: string | null; metadata?: Record<string, unknown> };

/** A-11: records a Workspace action on its own transaction client (server/audit.ts). The Institute is the organisation. */
async function auditWorkspace(client: import('pg').PoolClient, request: Request, event: WorkspaceEvent): Promise<void> {
  await recordAuditEvent(client, { action: event.action, actor: auditActor(request), organizationId: instituteIdOf(request), resourceId: event.resourceId, metadata: event.metadata ?? {} });
}

/** One write and its audit event in one transaction: the event is recorded only when the write returned a row. */
async function auditedQuery(request: Request, sql: string, values: unknown[], describe: (row: Row) => WorkspaceEvent): Promise<Row[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(sql, values);
    if (rows[0]) await auditWorkspace(client, request, describe(rows[0] as Row));
    return rows as Row[];
  });
}

/** D-02: an Institute's attempt to approve, publish or release, recorded as denied on its own transaction. */
async function auditPublicationRefused(request: Request, target: 'exam' | 'result' | 'admit_card', requestedStatus: string, resourceId: string | null): Promise<void> {
  await recordRefusedAuditEvent(pool, {
    action: 'workspace_publication.refused', actor: auditActor(request), outcome: 'denied', reasonCode: 'publication_requires_super_admin',
    organizationId: instituteIdOf(request), resourceId, metadata: { target, requested_status: requestedStatus },
  });
}

/** Runs `work` in one transaction on its own connection; rolls back on any error. */
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

/** Tables an Institute may reference by id from a request body. Fixed list: never built from input. */
const OWNED_TABLES = Object.freeze({ exam: 'institute_exams', form: 'institute_app_forms', course: 'institute_training_courses' } as const);

/**
 * Tenant isolation for ids taken from a request body: true only when the row exists AND belongs to this
 * Institute. Callers answer 404 otherwise, so another Institute's ids are indistinguishable from unknown ids.
 */
export async function ownsRow(kind: keyof typeof OWNED_TABLES, id: string | null | undefined, instituteId: string): Promise<boolean> {
  if (id === null || id === undefined) return true; // optional reference not given
  const { rows } = await pool.query(`SELECT 1 FROM ${OWNED_TABLES[kind]} WHERE id = $1 AND institute_id = $2`, [id, instituteId]);
  return rows.length === 1;
}

function sendNotFound(response: Response, what: string): void {
  response.status(404).json({ error: `${what} not found.` });
}

function sendPublicationForbidden(response: Response, what: string): void {
  response.status(403).json({
    error: `Official ${what} publication is done by the ELTNOY Super Admin. Institutes prepare drafts and submit them for review.`,
    code: 'PUBLICATION_REQUIRES_SUPER_ADMIN',
  });
}

export function createInstituteWorkspaceRouter(): Router {
  const router = express.Router();
  const guards = [requireAuth, requireRoles('center')] as const;

  // -------------------------------------------------------------------------
  // Section 01: Overview – Command Centre
  // -------------------------------------------------------------------------
  router.get('/center/overview', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const period = z.enum(['30d', '90d', '6m', '12m', 'all']).catch('6m').parse(request.query.period);
    const academicYear = typeof request.query.academicYear === 'string' && request.query.academicYear.trim()
      ? request.query.academicYear.trim()
      : null;

    const intervalSql = period === '30d' ? "interval '30 days'"
      : period === '90d' ? "interval '90 days'"
      : period === '6m' ? "interval '6 months'"
      : period === '12m' ? "interval '12 months'"
      : null;

    try {
      const [examsRes, appsRes, feesRes, recentExamsRes, activityRes, trendRes] = await Promise.all([
        pool.query(
          `SELECT
             count(*) FILTER (WHERE lifecycle_status IN ('published', 'registration_open'))::int AS active_exams,
             count(*) FILTER (WHERE exam_date >= CURRENT_DATE AND exam_date <= CURRENT_DATE + interval '30 days' AND lifecycle_status NOT IN ('cancelled', 'archived'))::int AS upcoming_exams,
             count(*)::int AS total_exams
           FROM institute_exams
           WHERE institute_id = $1
             AND ($2::text IS NULL OR academic_year = $2)`,
          [instituteId, academicYear],
        ),
        pool.query(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE review_status = 'verified')::int AS verified,
             count(*) FILTER (WHERE review_status IN ('pending', 'correction_requested'))::int AS pending,
             count(*) FILTER (WHERE review_status IN ('rejected', 'flagged'))::int AS rejected
           FROM institute_candidate_applications
           WHERE institute_id = $1
             ${intervalSql ? `AND created_at >= now() - ${intervalSql}` : ''}`,
          [instituteId],
        ),
        pool.query(
          `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'successful'), 0)::text AS collected_paise
           FROM institute_fee_transactions
           WHERE institute_id = $1
             ${intervalSql ? `AND created_at >= now() - ${intervalSql}` : ''}`,
          [instituteId],
        ),
        pool.query(
          `SELECT e.id, e.exam_code, e.title, e.exam_date, e.lifecycle_status, e.mode,
                  count(a.id)::int AS application_count
           FROM institute_exams e
           LEFT JOIN institute_candidate_applications a ON a.exam_id = e.id AND a.institute_id = e.institute_id
           WHERE e.institute_id = $1
             AND ($2::text IS NULL OR e.academic_year = $2)
           GROUP BY e.id
           ORDER BY e.exam_date DESC, e.created_at DESC
           LIMIT 6`,
          [instituteId, academicYear],
        ),
        pool.query(
          `(SELECT 'exam' AS kind, title AS title, lifecycle_status AS detail, updated_at AS occurred_at
            FROM institute_exams WHERE institute_id = $1 ORDER BY updated_at DESC LIMIT 4)
           UNION ALL
           (SELECT 'application' AS kind, candidate_name AS title, review_status AS detail, updated_at AS occurred_at
            FROM institute_candidate_applications WHERE institute_id = $1 ORDER BY updated_at DESC LIMIT 4)
           ORDER BY occurred_at DESC LIMIT 6`,
          [instituteId],
        ),
        pool.query(
          `SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month,
                  count(*)::int AS count
           FROM institute_candidate_applications
           WHERE institute_id = $1
             AND created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '5 months') AT TIME ZONE 'Asia/Kolkata'
           GROUP BY 1 ORDER BY 1`,
          [instituteId],
        ),
      ]);

      response.json({
        period,
        academicYear: academicYear ?? 'all',
        lastUpdatedAt: new Date().toISOString(),
        kpis: {
          activeExams: examsRes.rows[0]?.active_exams ?? 0,
          upcomingExams: examsRes.rows[0]?.upcoming_exams ?? 0,
          totalExams: examsRes.rows[0]?.total_exams ?? 0,
          applicationsTotal: appsRes.rows[0]?.total ?? 0,
          feesCollectedPaise: feesRes.rows[0]?.collected_paise ?? '0',
        },
        applicationStatus: {
          verified: appsRes.rows[0]?.verified ?? 0,
          pending: appsRes.rows[0]?.pending ?? 0,
          rejected: appsRes.rows[0]?.rejected ?? 0,
        },
        applicationsTrend: trendRes.rows,
        recentExams: recentExamsRes.rows,
        activityFeed: activityRes.rows,
      });
    } catch (error) {
      if (isUndefinedTableError(error)) {
        response.status(503).json({ error: 'Institute workspace tables are not migrated yet. Run npm run db:migrate.' });
        return;
      }
      throw error;
    }
  }));

  // -------------------------------------------------------------------------
  // Section 02: My Institute – Profile, Branches & Compliance
  // -------------------------------------------------------------------------
  router.get('/center/branches', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [branchesRes, profileRes, docsRes, staffRes, verifRes] = await Promise.all([
      pool.query('SELECT * FROM institute_branches WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 200', [instituteId]),
      pool.query('SELECT display_name, login_id, contact_email, registration_number, registered_address, website, account_status FROM users WHERE id = $1', [instituteId]),
      pool.query('SELECT count(*)::int AS doc_count FROM institution_documents WHERE institution_id = $1', [instituteId]).catch(() => ({ rows: [{ doc_count: 0 }] })),
      pool.query("SELECT count(*)::int AS staff_count FROM org_staff_members WHERE organization_id = $1 AND status <> 'removed'", [instituteId]).catch(() => ({ rows: [{ staff_count: 0 }] })),
      pool.query('SELECT institutional_status, mobile_verified_at, email_verified_at FROM institute_verifications WHERE institution_id = $1', [instituteId]).catch(() => ({ rows: [] })),
    ]);

    const profile = profileRes.rows[0] ?? {};
    const missingItems: string[] = [];
    if (!profile.display_name) missingItems.push('Institute name');
    if (!profile.contact_email) missingItems.push('Official email');
    if (!profile.registration_number) missingItems.push('Registration number');
    if (!profile.registered_address) missingItems.push('Registered address');
    if (!profile.website) missingItems.push('Official website');
    if ((branchesRes.rows.length ?? 0) === 0) missingItems.push('At least one branch/campus');
    if ((docsRes.rows[0]?.doc_count ?? 0) === 0) missingItems.push('Compliance document record');

    const totalChecks = 7;
    const completionPct = Math.round(((totalChecks - missingItems.length) / totalChecks) * 100);

    response.json({
      branches: branchesRes.rows,
      completionPct,
      missingItems,
      authorizedStaffCount: staffRes.rows[0]?.staff_count ?? 0,
      verification: verifRes.rows[0] ?? null,
    });
  }));

  router.post('/center/branches', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      name: z.string().trim().min(2).max(150),
      code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
      city: z.string().trim().min(2).max(100),
      state: z.string().trim().max(100).default(''),
      coordinatorName: z.string().trim().min(2).max(120),
      coordinatorEmail: z.string().trim().email().max(254).or(z.literal('')).default(''),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    try {
      const rows = await auditedQuery(request,
        `INSERT INTO institute_branches (id, institute_id, name, code, city, state, coordinator_name, coordinator_email, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
         RETURNING *`,
        [randomUUID(), instituteId, parsed.data.name, parsed.data.code.toUpperCase(), parsed.data.city, parsed.data.state, parsed.data.coordinatorName, parsed.data.coordinatorEmail],
        (row) => ({ action: 'workspace_branch.created', resourceId: String(row.id), metadata: { branch_code: String(row.code) } }),
      );
      response.status(201).json({ branch: rows[0] });
    } catch (error) {
      if (isUniqueViolation(error)) {
        response.status(409).json({ error: 'A branch with that code already exists in your institute.' });
        return;
      }
      throw error;
    }
  }));

  router.patch('/center/branches/:id', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      status: z.enum(['active', 'pending', 'inactive']).optional(),
      coordinatorName: z.string().trim().min(2).max(120).optional(),
      coordinatorEmail: z.string().trim().email().max(254).or(z.literal('')).optional(),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    const rows = await auditedQuery(request,
      `UPDATE institute_branches
       SET status = COALESCE($3, status),
           coordinator_name = COALESCE($4, coordinator_name),
           coordinator_email = COALESCE($5, coordinator_email),
           updated_at = now()
       WHERE id = $1 AND institute_id = $2
       RETURNING *`,
      [request.params.id, instituteId, parsed.data.status ?? null, parsed.data.coordinatorName ?? null, parsed.data.coordinatorEmail ?? null],
      (row) => ({ action: 'workspace_branch.updated', resourceId: String(row.id), metadata: { branch_code: String(row.code), changed_fields: Object.keys(parsed.data).filter((key) => parsed.data[key as keyof typeof parsed.data] !== undefined), new_status: parsed.data.status } }),
    );
    if (!rows[0]) {
      response.status(404).json({ error: 'Branch not found.' });
      return;
    }
    response.json({ branch: rows[0] });
  }));

  // -------------------------------------------------------------------------
  // Section 03 & 04: Create Examination & Exam Management
  // -------------------------------------------------------------------------
  router.get('/center/exams', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const status = typeof request.query.status === 'string' && request.query.status !== 'all' ? request.query.status : null;
    const mode = typeof request.query.mode === 'string' && request.query.mode !== 'all' ? request.query.mode : null;
    const category = typeof request.query.category === 'string' && request.query.category !== 'all' ? request.query.category : null;
    const search = typeof request.query.search === 'string' && request.query.search.trim() ? `%${request.query.search.trim()}%` : null;

    const [listRes, countsRes] = await Promise.all([
      pool.query(
        `SELECT e.*, count(a.id)::int AS application_count
         FROM institute_exams e
         LEFT JOIN institute_candidate_applications a ON a.exam_id = e.id AND a.institute_id = e.institute_id
         WHERE e.institute_id = $1
           AND ($2::text IS NULL OR e.lifecycle_status = $2)
           AND ($3::text IS NULL OR e.mode = $3)
           AND ($4::text IS NULL OR e.category = $4)
           AND ($5::text IS NULL OR e.title ILIKE $5 OR e.exam_code ILIKE $5)
         GROUP BY e.id
         ORDER BY e.created_at DESC
         LIMIT 200`,
        [instituteId, status, mode, category, search],
      ),
      pool.query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE lifecycle_status = 'registration_open')::int AS registration_open,
           count(*) FILTER (WHERE lifecycle_status IN ('approved', 'published'))::int AS scheduled_live,
           count(*) FILTER (WHERE lifecycle_status IN ('closed', 'cancelled', 'archived'))::int AS closed_archived
         FROM institute_exams WHERE institute_id = $1`,
        [instituteId],
      ),
    ]);
    response.json({ exams: listRes.rows, summary: countsRes.rows[0] });
  }));

  // Fields an Institute prepares for an examination. With a wizard configuration (`config`, validated by the
  // shared strict schema in src/utils/examConfig.ts), the existing category, mode and fee columns are derived
  // from it: the nearest existing category for the examination type, the nearest existing mode for the exact
  // mode, and the General / UR fee. The exact type and mode stay in the configuration. Unknown fields are refused.
  const examDetailsShape = {
    title: z.string().trim().min(3).max(160),
    category: z.enum(['Scholarship', 'Recruitment', 'Admission', 'Mock', 'Certification', 'Other']).optional(),
    mode: z.enum(['Online CBT', 'Offline', 'Hybrid']).optional(),
    eligibility: z.string().trim().min(2).max(300),
    academicYear: z.string().trim().min(4).max(20).default('2026-27'),
    appOpenDate: z.string().date(),
    appCloseDate: z.string().date(),
    examDate: z.string().date(),
    // Admit cards copy the exam time, so it must be a real 24-hour time; the time zone must be a real IANA zone.
    examTime: z.string().regex(CLOCK_TIME).default('10:00'),
    durationMinutes: z.coerce.number().int().min(10).max(600),
    feePaise: z.coerce.number().int().min(0).max(100_000_000).default(0),
    instructions: z.string().trim().max(4000).default(''),
    config: examConfigSchema.optional(),
    submitForApproval: z.boolean().optional(),
  };
  const createExamSchema = z.object({
    ...examDetailsShape,
    examCode: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
    timezone: z.string().trim().min(2).max(64).refine(isValidTimeZone, 'Choose a valid time zone, for example Asia/Kolkata.').default('Asia/Kolkata'),
    sessionsInfo: z.string().trim().max(300).default(''),
    refundPolicy: z.string().trim().max(500).default(''),
    approvalMode: z.enum(['single', 'dual']).default('single'),
  }).strict();
  // The exam code is fixed once created (admit cards, results and the audit trail refer to it).
  const updateExamSchema = z.object({
    ...examDetailsShape,
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  }).strict();

  type ExamDetails = z.infer<typeof updateExamSchema> | z.infer<typeof createExamSchema>;

  /** Category, mode and fee stored in the exam columns: derived from the configuration when there is one. */
  function examColumns(d: ExamDetails): { category: string; mode: string; feePaise: number } | null {
    if (d.config) {
      return { category: examCategoryFor(d.config.basics.examType), mode: examDbModeFor(d.config.basics.mode), feePaise: d.config.fees.categories.general.fee };
    }
    return d.category && d.mode ? { category: d.category, mode: d.mode, feePaise: d.feePaise } : null;
  }

  /** Date and size rules shared by create and edit; returns the first problem, or null. */
  function examDetailsProblem(d: ExamDetails): string | null {
    if (d.appCloseDate < d.appOpenDate) return 'Application closing date must be on or after the opening date.';
    if (d.examDate < d.appCloseDate) return 'Exam date must be on or after the application closing date.';
    if (!examColumns(d)) return 'Choose a category and a mode for the examination.';
    if (d.config) {
      if (examConfigTooLarge(d.config)) return 'The examination configuration is too large. Remove some text or entries.';
      const [issue] = examConfigDateIssues(d.config, { appOpenDate: d.appOpenDate, appCloseDate: d.appCloseDate, examDate: d.examDate });
      if (issue) return issue;
    }
    return null;
  }

  router.post('/center/exams', ...guards, asyncRoute(async (request, response) => {
    const parsed = createExamSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const d = parsed.data;
    const problem = examDetailsProblem(d);
    if (problem) {
      response.status(400).json({ error: problem });
      return;
    }
    const { category, mode, feePaise } = examColumns(d)!;
    const instituteId = instituteIdOf(request);
    const initialStatus = d.submitForApproval ? 'pending_approval' : 'draft';
    try {
      const rows = await auditedQuery(request,
        `INSERT INTO institute_exams
         (id, institute_id, exam_code, title, category, mode, eligibility, academic_year,
          app_open_date, app_close_date, exam_date, exam_time, duration_minutes, timezone,
          sessions_info, fee_paise, refund_policy, instructions, approval_mode, lifecycle_status, created_by, exam_config_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$2,$21::jsonb)
         RETURNING *`,
        [randomUUID(), instituteId, d.examCode.toUpperCase(), d.title, category, mode, d.eligibility,
          d.academicYear, d.appOpenDate, d.appCloseDate, d.examDate, d.examTime, d.durationMinutes,
          d.timezone, d.sessionsInfo, feePaise, d.refundPolicy, d.instructions, d.approvalMode, initialStatus,
          JSON.stringify(d.config ?? {})],
        (row) => ({ action: 'workspace_exam.created', resourceId: String(row.id), metadata: { exam_code: String(row.exam_code), new_status: initialStatus, exam_type: d.config?.basics.examType } }),
      );
      response.status(201).json({ exam: rows[0] });
    } catch (error) {
      if (isUniqueViolation(error)) {
        response.status(409).json({ error: 'An examination with that exam code already exists.' });
        return;
      }
      throw error;
    }
  }));

  // One examination with plain dates (YYYY-MM-DD) and its configuration, for editing in the wizard.
  const EXAM_FOR_EDIT_SQL = `SELECT id, exam_code, title, category, mode, eligibility, academic_year,
         to_char(app_open_date, 'YYYY-MM-DD') AS app_open_date, to_char(app_close_date, 'YYYY-MM-DD') AS app_close_date,
         to_char(exam_date, 'YYYY-MM-DD') AS exam_date, exam_time, duration_minutes, fee_paise::text AS fee_paise,
         instructions, lifecycle_status, status_reason, exam_config_json,
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
       FROM institute_exams WHERE id = $1 AND institute_id = $2`;

  router.get('/center/exams/:id', ...guards, asyncRoute(async (request, response) => {
    if (!z.string().uuid().safeParse(request.params.id).success) { sendNotFound(response, 'Examination'); return; }
    const { rows } = await pool.query(EXAM_FOR_EDIT_SQL, [request.params.id, instituteIdOf(request)]);
    if (!rows[0]) { sendNotFound(response, 'Examination'); return; }
    response.json({ exam: rows[0] });
  }));

  // Edit an examination while it is still the Institute's to change: a draft, or one ELTNOY returned for
  // changes. Saving can also submit it for review (D-02: never approval or publication). Compare-and-set on the
  // status and on the version the Institute loaded, so a concurrent edit or Super Admin decision is never
  // overwritten.
  router.patch('/center/exams/:id', ...guards, asyncRoute(async (request, response) => {
    if (!z.string().uuid().safeParse(request.params.id).success) { sendNotFound(response, 'Examination'); return; }
    const parsed = updateExamSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const d = parsed.data;
    const problem = examDetailsProblem(d);
    if (problem) {
      response.status(400).json({ error: problem });
      return;
    }
    const instituteId = instituteIdOf(request);
    const { rows: currentRows } = await pool.query(EXAM_FOR_EDIT_SQL, [request.params.id, instituteId]);
    const current = currentRows[0];
    if (!current) { sendNotFound(response, 'Examination'); return; }
    const currentStatus = String(current.lifecycle_status);
    if (!isInstituteEditableExam(currentStatus)) {
      response.status(409).json({ error: 'Only a draft, or an examination ELTNOY returned for changes, can be edited.', code: 'EXAM_NOT_EDITABLE' });
      return;
    }
    const { category, mode, feePaise } = examColumns(d)!;
    const next: Record<string, unknown> = {
      title: d.title, category, mode, eligibility: d.eligibility, academic_year: d.academicYear,
      app_open_date: d.appOpenDate, app_close_date: d.appCloseDate, exam_date: d.examDate, exam_time: d.examTime,
      duration_minutes: d.durationMinutes, fee_paise: String(feePaise), instructions: d.instructions,
    };
    const changedFields = Object.keys(next).filter((key) => String(current[key] ?? '') !== String(next[key]));
    const nextConfig = d.config ?? (current.exam_config_json as Record<string, unknown>);
    // jsonb returns object keys in its own order, so compare with sorted keys.
    if (canonicalJson(nextConfig) !== canonicalJson(current.exam_config_json)) changedFields.push('exam_config');
    const newStatus = d.submitForApproval ? 'pending_approval' : currentStatus;
    // D-02: submitting is the only status change an edit can make, through the same rule as the transition route.
    if (newStatus !== currentStatus && !isInstituteExamTransition(currentStatus, newStatus)) {
      await auditPublicationRefused(request, 'exam', newStatus, String(current.id));
      sendPublicationForbidden(response, 'examination approval and');
      return;
    }
    if (changedFields.length === 0 && newStatus === currentStatus) {
      response.json({ exam: current, unchanged: true });
      return;
    }
    const rows = await auditedQuery(request,
      `UPDATE institute_exams
       SET title = $5, category = $6, mode = $7, eligibility = $8, academic_year = $9, app_open_date = $10,
           app_close_date = $11, exam_date = $12, exam_time = $13, duration_minutes = $14, fee_paise = $15,
           instructions = $16, exam_config_json = $17::jsonb, lifecycle_status = $18, updated_at = now()
       WHERE id = $1 AND institute_id = $2 AND lifecycle_status = $3
         AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $4::timestamptz)
       RETURNING id, exam_code, lifecycle_status`,
      [current.id, instituteId, currentStatus, d.expectedUpdatedAt, d.title, category, mode, d.eligibility, d.academicYear,
        d.appOpenDate, d.appCloseDate, d.examDate, d.examTime, d.durationMinutes, feePaise, d.instructions,
        JSON.stringify(nextConfig), newStatus],
      () => ({
        action: 'workspace_exam.updated', resourceId: String(current.id),
        metadata: { exam_code: String(current.exam_code), changed_fields: changedFields, previous_status: currentStatus, new_status: newStatus, exam_type: d.config?.basics.examType },
      }),
    );
    if (!rows[0]) {
      response.status(409).json({ error: 'The examination changed since you opened it. Reload it and make your changes again.', code: 'EXAM_CHANGED' });
      return;
    }
    const { rows: fresh } = await pool.query(EXAM_FOR_EDIT_SQL, [current.id, instituteId]);
    response.json({ exam: fresh[0] ?? rows[0] });
  }));

  router.post('/center/exams/:id/transition', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      status: z.enum(['draft', 'pending_approval', 'needs_changes', 'approved', 'published', 'registration_open', 'closed', 'cancelled', 'archived']),
      reason: z.string().trim().max(500).default(''),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    const { rows: currentRows } = await pool.query('SELECT * FROM institute_exams WHERE id = $1 AND institute_id = $2', [request.params.id, instituteId]);
    const exam = currentRows[0];
    if (!exam) {
      response.status(404).json({ error: 'Examination not found.' });
      return;
    }
    if (!isValidExamTransition(String(exam.lifecycle_status), parsed.data.status)) {
      response.status(409).json({ error: `Cannot transition examination from ${String(exam.lifecycle_status)} to ${parsed.data.status}.` });
      return;
    }
    // D-02: approval, review outcomes and publication belong to the Super Admin.
    if (!isInstituteExamTransition(String(exam.lifecycle_status), parsed.data.status)) {
      await auditPublicationRefused(request, 'exam', parsed.data.status, String(exam.id));
      sendPublicationForbidden(response, 'examination approval and');
      return;
    }
    if (['cancelled', 'needs_changes'].includes(parsed.data.status) && parsed.data.reason.length < 5) {
      response.status(400).json({ error: 'A reason of at least 5 characters is required for this transition.' });
      return;
    }
    const rows = await auditedQuery(request,
      `UPDATE institute_exams
       SET lifecycle_status = $3,
           status_reason = CASE WHEN $4 <> '' THEN $4 ELSE status_reason END,
           updated_at = now()
       WHERE id = $1 AND institute_id = $2 AND lifecycle_status = $5
       RETURNING *`,
      [exam.id, instituteId, parsed.data.status, parsed.data.reason, String(exam.lifecycle_status)],
      () => ({ action: 'workspace_exam.status_changed', resourceId: String(exam.id), metadata: { exam_code: String(exam.exam_code), previous_status: String(exam.lifecycle_status), new_status: parsed.data.status, reason_text: parsed.data.reason || undefined } }),
    );
    // Compare-and-set: a concurrent change (for example a Super Admin decision) wins; nothing is overwritten.
    if (!rows[0]) {
      response.status(409).json({ error: 'The examination changed while your request was processed. Reload and try again.', code: 'EXAM_CHANGED' });
      return;
    }
    response.json({ exam: rows[0] });
  }));

  router.get('/center/exams/:id/broadcasts', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const { rows } = await pool.query(
      'SELECT * FROM institute_exam_broadcasts WHERE institute_id = $1 AND exam_id = $2 ORDER BY created_at DESC LIMIT 50',
      [instituteId, request.params.id],
    );
    response.json({ broadcasts: rows });
  }));

  // Messages to candidates are refused: nothing delivers them. There is no candidate inbox or notice page
  // for Institute examinations, and no email or SMS is sent from here, so storing one as "recorded" would
  // read as a sent message (review 2026-11-28). The list route stays for records made before.
  router.post('/center/exams/:id/broadcasts', ...guards, (_request: Request, response: Response) => {
    response.status(409).json({
      error: 'Messages to candidates are not available yet: no candidate notice page, email or SMS delivery exists for Institute examinations.',
      code: 'BROADCASTS_NOT_AVAILABLE',
    });
  });

  // -------------------------------------------------------------------------
  // Section 05 & 06: Online Applications & Candidate Verification Queue
  // -------------------------------------------------------------------------
  router.get('/center/app-forms', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const { rows } = await pool.query(
      `SELECT f.*, e.title AS exam_title, e.exam_code
       FROM institute_app_forms f
       LEFT JOIN institute_exams e ON e.id = f.exam_id
       WHERE f.institute_id = $1 ORDER BY f.created_at DESC LIMIT 100`,
      [instituteId],
    );
    response.json({ forms: rows });
  }));

  router.post('/center/app-forms', ...guards, asyncRoute(async (request, response) => {
    const fieldSchema = z.object({
      id: z.string().min(1).max(60),
      label: z.string().trim().min(1).max(120),
      type: z.enum(['text', 'date', 'select', 'radio', 'checkbox', 'file']),
      required: z.boolean().default(true),
      options: z.array(z.string().trim().max(100)).optional(),
    });
    const parsed = z.object({
      examId: z.string().uuid().optional().nullable(),
      title: z.string().trim().min(3).max(160),
      status: z.enum(['draft', 'published']).default('draft'),
      fields: z.array(fieldSchema).min(1).max(40),
      documentRules: z.array(z.string().trim().max(100)).max(10).default([]),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    if (!(await ownsRow('exam', parsed.data.examId, instituteId))) { sendNotFound(response, 'Examination'); return; }
    const verRes = await pool.query(
      'SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version FROM institute_app_forms WHERE institute_id = $1 AND title = $2',
      [instituteId, parsed.data.title],
    );
    const rows = await auditedQuery(request,
      `INSERT INTO institute_app_forms (id, institute_id, exam_id, title, version, status, fields_json, document_rules_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING *`,
      [randomUUID(), instituteId, parsed.data.examId ?? null, parsed.data.title, verRes.rows[0].next_version, parsed.data.status, JSON.stringify(parsed.data.fields), JSON.stringify(parsed.data.documentRules)],
      (row) => ({ action: 'workspace_app_form.created', resourceId: String(row.id), metadata: { version: intOrNone(row.version), new_status: String(row.status), field_count: parsed.data.fields.length } }),
    );
    response.status(201).json({ form: rows[0] });
  }));

  router.patch('/center/app-forms/:id', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({ status: z.enum(['draft', 'published', 'archived']) }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    const rows = await auditedQuery(request,
      'UPDATE institute_app_forms SET status = $3, updated_at = now() WHERE id = $1 AND institute_id = $2 RETURNING *',
      [request.params.id, instituteId, parsed.data.status],
      (row) => ({ action: 'workspace_app_form.status_changed', resourceId: String(row.id), metadata: { version: intOrNone(row.version), new_status: String(row.status) } }),
    );
    if (!rows[0]) {
      response.status(404).json({ error: 'Application form not found.' });
      return;
    }
    response.json({ form: rows[0] });
  }));

  router.get('/center/applications', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const reviewStatus = typeof request.query.reviewStatus === 'string' && request.query.reviewStatus !== 'all' ? request.query.reviewStatus : null;
    const search = typeof request.query.search === 'string' && request.query.search.trim() ? `%${request.query.search.trim()}%` : null;

    const [appsRes, funnelRes] = await Promise.all([
      pool.query(
        `SELECT a.*, e.title AS exam_title, e.exam_code
         FROM institute_candidate_applications a
         LEFT JOIN institute_exams e ON e.id = a.exam_id
         WHERE a.institute_id = $1
           AND ($2::text IS NULL OR a.review_status = $2)
           AND ($3::text IS NULL OR a.candidate_name ILIKE $3 OR a.application_number ILIKE $3)
         ORDER BY a.created_at DESC LIMIT 200`,
        [instituteId, reviewStatus, search],
      ),
      pool.query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE stage IN ('started', 'profile', 'documents', 'submitted'))::int AS started,
           count(*) FILTER (WHERE stage IN ('profile', 'documents', 'submitted'))::int AS profile,
           count(*) FILTER (WHERE stage IN ('documents', 'submitted'))::int AS documents,
           count(*) FILTER (WHERE stage = 'submitted')::int AS submitted,
           count(*) FILTER (WHERE review_status = 'pending')::int AS awaiting_review,
           count(*) FILTER (WHERE review_status = 'verified')::int AS verified,
           count(*) FILTER (WHERE review_status = 'flagged')::int AS flagged,
           count(*) FILTER (WHERE review_status = 'correction_requested')::int AS correction_requested
         FROM institute_candidate_applications WHERE institute_id = $1`,
        [instituteId],
      ),
    ]);
    response.json({ applications: appsRes.rows, summary: funnelRes.rows[0] });
  }));

  router.post('/center/applications', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      examId: z.string().uuid().optional().nullable(),
      formId: z.string().uuid().optional().nullable(),
      candidateName: z.string().trim().min(2).max(120),
      candidateEmail: z.string().trim().email().max(254).or(z.literal('')).default(''),
      candidateMobile: z.string().trim().max(20).default(''),
      stage: z.enum(['started', 'profile', 'documents', 'submitted']).default('submitted'),
      // 'paid' is never accepted from an Institute: no payment is verified here (payments, F-6, are
      // deferred). A fee is either still unpaid or waived by the Institute.
      paymentStatus: z.enum(['unpaid', 'waived']).default('unpaid'),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    if (!(await ownsRow('exam', parsed.data.examId, instituteId))) { sendNotFound(response, 'Examination'); return; }
    if (!(await ownsRow('form', parsed.data.formId, instituteId))) { sendNotFound(response, 'Application form'); return; }
    const appNo = `APP-${new Date().getFullYear()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const rows = await auditedQuery(request,
      `INSERT INTO institute_candidate_applications
       (id, institute_id, exam_id, form_id, application_number, candidate_name, candidate_email, candidate_mobile, stage, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [randomUUID(), instituteId, parsed.data.examId ?? null, parsed.data.formId ?? null, appNo,
        parsed.data.candidateName, parsed.data.candidateEmail, parsed.data.candidateMobile, parsed.data.stage, parsed.data.paymentStatus],
      // A-08: the application number and status only; never the candidate's name or contact details.
      (row) => ({ action: 'workspace_application.created', resourceId: String(row.id), metadata: { application_number: String(row.application_number), new_status: String(row.review_status) } }),
    );
    response.status(201).json({ application: rows[0] });
  }));

  router.post('/center/applications/:id/review', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      action: z.enum(['verified', 'correction_requested', 'flagged', 'rejected']),
      targetField: z.string().trim().max(100).default(''),
      reason: z.string().trim().max(500).default(''),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    if (parsed.data.action !== 'verified' && parsed.data.reason.length < 5) {
      response.status(400).json({ error: 'A clear reason (at least 5 characters) is required for correction, flagging, or rejection.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const outcome = await withTransaction(async (client) => {
      const current = await client.query(APPLICATION_SQL.current, [request.params.id, instituteId]);
      if (!current.rows[0]) return { status: 404 as const };
      const from = String(current.rows[0].review_status);
      if (from === parsed.data.action) return { status: 409 as const, code: 'NO_CHANGE', error: `This application is already ${REVIEW_WORDS[from] ?? from}.` };
      // An admit card ELTNOY already released stays valid until ELTNOY revokes it (A-06), so the application
      // cannot be un-verified underneath it. A draft card simply stops being releasable (the Super Admin release
      // only takes drafts of verified applications).
      if (from === 'verified') {
        const released = await client.query(APPLICATION_SQL.releasedCard, [request.params.id, instituteId]);
        if (released.rows[0]) return { status: 409 as const, code: 'ADMIT_CARD_RELEASED', error: 'ELTNOY has released an admit card for this application. Ask ELTNOY to revoke it before changing the review.' };
      }
      const { rows } = await client.query(APPLICATION_SQL.review, [request.params.id, instituteId, parsed.data.action, parsed.data.reason, from]);
      await client.query(APPLICATION_SQL.log, [randomUUID(), instituteId, request.params.id, parsed.data.action, parsed.data.targetField, parsed.data.reason]);
      await auditWorkspace(client, request, {
        action: 'workspace_application.reviewed', resourceId: request.params.id,
        metadata: { application_number: rows[0]?.application_number ? String(rows[0].application_number) : undefined, previous_status: from, new_status: parsed.data.action, reason_text: parsed.data.reason || undefined },
      });
      return { status: 200 as const, application: rows[0] };
    });
    if (outcome.status === 404) { sendNotFound(response, 'Application'); return; }
    if (outcome.status === 409) { response.status(409).json({ error: outcome.error, code: outcome.code }); return; }
    response.json({ application: outcome.application });
  }));

  router.get('/center/applications/:id/logs', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const { rows } = await pool.query(
      'SELECT * FROM institute_verification_logs WHERE institute_id = $1 AND application_id = $2 ORDER BY created_at DESC LIMIT 50',
      [instituteId, request.params.id],
    );
    response.json({ logs: rows });
  }));

  // -------------------------------------------------------------------------
  // Section 07: Payments & Fees – Financial Operations
  // -------------------------------------------------------------------------
  router.get('/center/payments', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [txnsRes, refundsRes, summaryRes] = await Promise.all([
      pool.query(
        `SELECT t.*, e.title AS exam_title
         FROM institute_fee_transactions t
         LEFT JOIN institute_exams e ON e.id = t.exam_id
         WHERE t.institute_id = $1 ORDER BY t.created_at DESC LIMIT 200`,
        [instituteId],
      ),
      pool.query(
        `SELECT r.*, t.txn_ref, t.candidate_name
         FROM institute_fee_refunds r
         JOIN institute_fee_transactions t ON t.id = r.transaction_id
         WHERE r.institute_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
        [instituteId],
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(amount_paise) FILTER (WHERE status = 'successful'), 0)::text AS gross_paise,
           count(*) FILTER (WHERE status = 'successful')::int AS successful_count,
           count(*) FILTER (WHERE status IN ('initiated', 'pending', 'failed'))::int AS exception_count,
           count(*)::int AS total_count
         FROM institute_fee_transactions WHERE institute_id = $1`,
        [instituteId],
      ),
    ]);
    response.json({
      transactions: txnsRes.rows,
      refunds: refundsRes.rows,
      summary: summaryRes.rows[0],
    });
  }));

  router.post('/center/payments/refunds', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      transactionId: z.string().uuid(),
      amountPaise: z.coerce.number().int().positive(),
      reason: z.string().trim().min(5).max(500),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    const txnRes = await pool.query(
      "SELECT id, amount_paise, status FROM institute_fee_transactions WHERE id = $1 AND institute_id = $2 AND status = 'successful'",
      [parsed.data.transactionId, instituteId],
    );
    if (!txnRes.rows[0]) {
      response.status(404).json({ error: 'Successful transaction not found.' });
      return;
    }
    if (BigInt(parsed.data.amountPaise) > BigInt(txnRes.rows[0].amount_paise)) {
      response.status(400).json({ error: 'Refund amount cannot exceed the original transaction amount.' });
      return;
    }
    const rows = await auditedQuery(request,
      `INSERT INTO institute_fee_refunds (id, institute_id, transaction_id, amount_paise, reason, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,'requested',$2) RETURNING *`,
      [randomUUID(), instituteId, parsed.data.transactionId, parsed.data.amountPaise, parsed.data.reason],
      (row) => ({ action: 'workspace_refund.requested', resourceId: String(row.id), metadata: { amount_paise: parsed.data.amountPaise } }),
    );
    response.status(201).json({ refund: rows[0] });
  }));

  router.patch('/center/payments/refunds/:id', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({ status: z.enum(['approved', 'rejected', 'processed']) }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    // No money moves here and nobody independent approves (payments, F-6, are deferred): an Institute may only
    // withdraw its own request ('rejected'). Approving or marking a refund processed would record a refund
    // that never happened (review 2026-11-28).
    if (parsed.data.status !== 'rejected') {
      response.status(403).json({ error: 'Refunds cannot be approved or marked processed yet: no payment system returns the money. You can only withdraw the request.', code: 'REFUND_DECISION_NOT_AVAILABLE' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const rows = await auditedQuery(request,
      `UPDATE institute_fee_refunds
       SET status = $3, approved_by = $2, updated_at = now()
       WHERE id = $1 AND institute_id = $2 AND status IN ('requested', 'approved')
       RETURNING *`,
      [request.params.id, instituteId, parsed.data.status],
      (row) => ({ action: 'workspace_refund.withdrawn', resourceId: String(row.id) }),
    );
    if (!rows[0]) {
      response.status(404).json({ error: 'Refund request not found or already finalized.' });
      return;
    }
    response.json({ refund: rows[0] });
  }));

  // -------------------------------------------------------------------------
  // Section 08: Admit Cards – Hall Ticket Operations
  // -------------------------------------------------------------------------
  router.get('/center/admit-cards', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [templatesRes, ticketsRes, eligibleRes] = await Promise.all([
      pool.query('SELECT * FROM institute_admit_card_templates WHERE institute_id = $1 ORDER BY updated_at DESC LIMIT 20', [instituteId]),
      pool.query(
        `SELECT h.*, e.title AS exam_title, e.exam_code
         FROM institute_hall_tickets h
         JOIN institute_exams e ON e.id = h.exam_id
         WHERE h.institute_id = $1 ORDER BY h.generated_at DESC LIMIT 200`,
        [instituteId],
      ),
      pool.query("SELECT count(*)::int AS eligible_count FROM institute_candidate_applications WHERE institute_id = $1 AND review_status = 'verified'", [instituteId]),
    ]);
    response.json({
      templates: templatesRes.rows,
      tickets: ticketsRes.rows,
      eligibleCount: eligibleRes.rows[0]?.eligible_count ?? 0,
    });
  }));

  router.post('/center/admit-cards/templates', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      examId: z.string().uuid().optional().nullable(),
      templateName: z.string().trim().min(2).max(120),
      headerTitle: z.string().trim().max(160).default(''),
      instructions: z.string().trim().max(2000).default(''),
      showPhoto: z.boolean().default(true),
      showQr: z.boolean().default(true),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    if (!(await ownsRow('exam', parsed.data.examId, instituteId))) { sendNotFound(response, 'Examination'); return; }
    const rows = await auditedQuery(request,
      `INSERT INTO institute_admit_card_templates (id, institute_id, exam_id, template_name, header_title, instructions, show_photo, show_qr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), instituteId, parsed.data.examId ?? null, parsed.data.templateName, parsed.data.headerTitle, parsed.data.instructions, parsed.data.showPhoto, parsed.data.showQr],
      (row) => ({ action: 'workspace_admit_card_template.created', resourceId: String(row.id), metadata: { show_photo: row.show_photo === true, show_qr: row.show_qr === true } }),
    );
    response.status(201).json({ template: rows[0] });
  }));

  router.post('/center/admit-cards/generate', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      examId: z.string().uuid(),
      centerCode: z.string().trim().min(2).max(40),
      centerName: z.string().trim().min(2).max(150),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    const examRes = await pool.query('SELECT id, exam_code, exam_date, exam_time, lifecycle_status FROM institute_exams WHERE id = $1 AND institute_id = $2', [parsed.data.examId, instituteId]);
    const exam = examRes.rows[0];
    if (!exam) {
      response.status(404).json({ error: 'Examination not found.' });
      return;
    }
    if (CLOSED_EXAM_STATES.has(String(exam.lifecycle_status))) {
      sendExamClosed(response);
      return;
    }
    // One transaction under a per-exam lock: concurrent requests cannot interleave, seat numbers
    // continue from the cards already generated, and only rows actually inserted are counted. The
    // unique (exam_id, application_id) index is the database-level guarantee. Cards stay drafts
    // ('generated'); release is a Super Admin decision (D-02).
    const generated = await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('eltnoy.hall_tickets:' || $1))", [exam.id]);
      const eligibleApps = await client.query(
        `SELECT a.id, a.candidate_name
         FROM institute_candidate_applications a
         WHERE a.institute_id = $1 AND a.exam_id = $2 AND a.review_status = 'verified'
           AND NOT EXISTS (SELECT 1 FROM institute_hall_tickets h WHERE h.application_id = a.id AND h.exam_id = $2)
         ORDER BY a.created_at, a.id`,
        [instituteId, exam.id],
      );
      const { rows: countRows } = await client.query('SELECT count(*)::int AS existing FROM institute_hall_tickets WHERE institute_id = $1 AND exam_id = $2', [instituteId, exam.id]);
      let seat = Number(countRows[0]?.existing ?? 0);
      let inserted = 0;
      for (const appRow of eligibleApps.rows) {
        const roll = `${String(exam.exam_code).slice(0, 6)}-${randomUUID().slice(0, 6).toUpperCase()}`;
        const qrHash = createHash('sha256').update(`${instituteId}:${exam.id}:${appRow.id}:${roll}`).digest('hex');
        const result = await client.query(
          `INSERT INTO institute_hall_tickets (id, institute_id, exam_id, application_id, roll_number, candidate_name, center_code, center_name, seat_number, exam_date, exam_time, qr_token_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), instituteId, exam.id, appRow.id, roll, appRow.candidate_name, parsed.data.centerCode.toUpperCase(), parsed.data.centerName, `S-${seat + 1}`, exam.exam_date, exam.exam_time, qrHash],
        );
        if (result.rowCount === 1) {
          seat += 1;
          inserted += 1;
        }
      }
      if (inserted > 0) await auditWorkspace(client, request, { action: 'workspace_admit_cards.generated', resourceId: String(exam.id), metadata: { exam_code: String(exam.exam_code), row_count: inserted } });
      return inserted;
    });
    response.status(201).json({ generated });
  }));

  // D-02 / A-06: releasing or revoking an admit card is an official publication decision. Institutes
  // generate drafts (release_status 'generated'); the Super Admin releases. Kept as a route so the
  // existing route policy stays valid; it always refuses and changes nothing.
  router.patch('/center/admit-cards/:id/release', ...guards, asyncRoute(async (request, response) => {
    await auditPublicationRefused(request, 'admit_card', 'released', z.string().uuid().safeParse(request.params.id).success ? request.params.id : null);
    sendPublicationForbidden(response, 'admit card');
  }));

  // -------------------------------------------------------------------------
  // Section 09: Question Bank – Assessment Content Studio
  // -------------------------------------------------------------------------
  router.get('/center/questions', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [qRes, bpRes] = await Promise.all([
      pool.query('SELECT * FROM institute_questions WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 300', [instituteId]),
      pool.query('SELECT * FROM institute_paper_blueprints WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 50', [instituteId]),
    ]);
    response.json({ questions: qRes.rows, blueprints: bpRes.rows });
  }));

  router.post('/center/questions', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      subject: z.string().trim().min(2).max(80),
      topic: z.string().trim().max(120).default(''),
      difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
      questionType: z.enum(['mcq', 'multi_select', 'true_false', 'descriptive']).default('mcq'),
      questionText: z.string().trim().min(3).max(4000),
      options: z.record(z.string().trim().min(1).max(10), z.string().trim().min(1).max(1000)).default({}),
      correctAnswer: z.string().trim().max(500).default(''),
      explanation: z.string().trim().max(2000).default(''),
      marks: z.coerce.number().positive().max(100).default(1),
      negativeMarks: z.coerce.number().min(0).max(100).default(0),
      tags: z.string().trim().max(200).default(''),
      submitForReview: z.boolean().optional(),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const d = parsed.data;
    const shapeError = questionShapeError(d.questionType, d.options, d.correctAnswer);
    if (shapeError) {
      response.status(400).json({ error: shapeError });
      return;
    }
    if (d.negativeMarks > d.marks) {
      response.status(400).json({ error: 'Negative marks cannot be more than the marks for the question.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const rows = await auditedQuery(request,
      `INSERT INTO institute_questions
       (id, institute_id, subject, topic, difficulty, question_type, question_text, options_json, correct_answer, explanation, marks, negative_marks, tags, moderation_status, authored_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$2) RETURNING *`,
      [randomUUID(), instituteId, d.subject, d.topic, d.difficulty, d.questionType, d.questionText, JSON.stringify(d.options), d.correctAnswer, d.explanation, d.marks, d.negativeMarks, d.tags, d.submitForReview ? 'in_review' : 'draft'],
      (row) => ({ action: 'workspace_question.created', resourceId: String(row.id), metadata: { question_type: String(row.question_type), new_status: String(row.moderation_status) } }),
    );
    response.status(201).json({ question: rows[0] });
  }));

  router.patch('/center/questions/:id/moderate', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({ status: z.enum(['in_review', 'approved', 'rejected', 'archived']) }).strict().safeParse(request.body);
    const id = z.string().uuid().safeParse(request.params.id);
    if (!parsed.success || !id.success) {
      if (!parsed.success) sendValidationError(response, parsed.error);
      else response.status(400).json({ error: 'Invalid question id.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const current = await pool.query('SELECT moderation_status FROM institute_questions WHERE id = $1 AND institute_id = $2', [id.data, instituteId]);
    if (!current.rows[0]) { sendNotFound(response, 'Question'); return; }
    const from = String(current.rows[0].moderation_status);
    if (!isQuestionModerationTransition(from, parsed.data.status)) {
      response.status(409).json({ error: `A question that is ${from.replace('_', ' ')} cannot be moved to ${parsed.data.status.replace('_', ' ')}.`, code: 'INVALID_TRANSITION' });
      return;
    }
    // Compare-and-set: a concurrent change between the read and this write is reported, not overwritten.
    const rows = await auditedQuery(request,
      `UPDATE institute_questions
       SET moderation_status = $3, reviewed_by = $2, updated_at = now()
       WHERE id = $1 AND institute_id = $2 AND moderation_status = $4 RETURNING *`,
      [id.data, instituteId, parsed.data.status, from],
      (row) => ({ action: 'workspace_question.moderated', resourceId: String(row.id), metadata: { previous_status: from, new_status: parsed.data.status } }),
    );
    if (!rows[0]) {
      response.status(409).json({ error: 'This question changed while you were working. Reload and try again.', code: 'QUESTION_CHANGED' });
      return;
    }
    response.json({ question: rows[0] });
  }));

  router.post('/center/paper-blueprints', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      examId: z.string().uuid().optional().nullable(),
      title: z.string().trim().min(3).max(160),
      durationMinutes: z.coerce.number().int().min(10).max(600),
      questionIds: z.array(z.string().uuid()).min(1).max(200)
        .refine((ids) => new Set(ids).size === ids.length, 'A question can appear only once in a paper.'),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    if (!(await ownsRow('exam', parsed.data.examId, instituteId))) { sendNotFound(response, 'Examination'); return; }
    const qRes = await pool.query(
      "SELECT id, marks FROM institute_questions WHERE institute_id = $1 AND id = ANY($2::text[]) AND moderation_status = 'approved'",
      [instituteId, parsed.data.questionIds],
    );
    if (qRes.rows.length !== parsed.data.questionIds.length) {
      response.status(400).json({ error: 'Only approved questions belonging to your institute can enter a paper blueprint.' });
      return;
    }
    const totalMarks = qRes.rows.reduce((sum, row) => sum + Number(row.marks), 0);
    const rows = await auditedQuery(request,
      `INSERT INTO institute_paper_blueprints (id, institute_id, exam_id, title, total_marks, duration_minutes, question_ids_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [randomUUID(), instituteId, parsed.data.examId ?? null, parsed.data.title, totalMarks, parsed.data.durationMinutes, JSON.stringify(parsed.data.questionIds)],
      (row) => ({ action: 'workspace_paper.created', resourceId: String(row.id), metadata: { question_count: parsed.data.questionIds.length, duration_minutes: intOrNone(row.duration_minutes) } }),
    );
    response.status(201).json({ blueprint: rows[0] });
  }));

  router.post('/center/paper-blueprints/:id/lock', ...guards, asyncRoute(async (request, response) => {
    if (!z.string().uuid().safeParse(request.params.id).success) {
      response.status(400).json({ error: 'Invalid blueprint id.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const rows = await auditedQuery(request,
      `UPDATE institute_paper_blueprints
       SET is_locked = true, locked_by = $2, locked_at = now()
       WHERE id = $1 AND institute_id = $2 AND is_locked = false RETURNING *`,
      [request.params.id, instituteId],
      (row) => ({ action: 'workspace_paper.locked', resourceId: String(row.id), metadata: { question_count: Array.isArray(row.question_ids_json) ? row.question_ids_json.length : undefined } }),
    );
    if (!rows[0]) {
      response.status(404).json({ error: 'Unlocked blueprint not found.' });
      return;
    }
    response.json({ blueprint: rows[0] });
  }));

  // -------------------------------------------------------------------------
  // Section 10: CBT Exam Center
  // No route writes CBT sessions or incidents yet: online delivery of Institute exams (candidate attempts,
  // heartbeats, incident reporting) does not exist and needs a product decision. These two routes only read
  // and review what would be recorded, so the CBT screen keeps its "not connected" view.
  // -------------------------------------------------------------------------
  router.get('/center/cbt-sessions', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [sessionsRes, incidentsRes] = await Promise.all([
      pool.query('SELECT * FROM institute_cbt_sessions WHERE institute_id = $1 ORDER BY updated_at DESC LIMIT 200', [instituteId]),
      pool.query(
        `SELECT i.*, s.candidate_name, s.roll_number
         FROM institute_cbt_incidents i
         JOIN institute_cbt_sessions s ON s.id = i.session_id AND s.institute_id = i.institute_id
         WHERE i.institute_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
        [instituteId],
      ),
    ]);
    // No "delivery health" figures: nothing measures CBT delivery, so none is reported.
    response.json({ sessions: sessionsRes.rows, incidents: incidentsRes.rows });
  }));

  router.post('/center/cbt-incidents/:id/review', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      reviewStatus: z.enum(['reviewed', 'escalated', 'dismissed']),
      reviewReason: z.string().trim().min(5).max(500),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    if (!z.string().uuid().safeParse(request.params.id).success) {
      response.status(400).json({ error: 'Invalid incident id.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    // Only an open incident is decided, once: a later review cannot overwrite the earlier decision and reason.
    const rows = await auditedQuery(request,
      `UPDATE institute_cbt_incidents
       SET review_status = $3, review_reason = $4, reviewed_by = $2
       WHERE id = $1 AND institute_id = $2 AND review_status = 'open' RETURNING *`,
      [request.params.id, instituteId, parsed.data.reviewStatus, parsed.data.reviewReason],
      (row) => ({ action: 'workspace_cbt_incident.reviewed', resourceId: String(row.id), metadata: { review_status: parsed.data.reviewStatus, reason_text: parsed.data.reviewReason } }),
    );
    if (!rows[0]) {
      response.status(404).json({ error: 'Open incident not found. It may already have been reviewed.' });
      return;
    }
    response.json({ incident: rows[0] });
  }));

  // -------------------------------------------------------------------------
  // Section 11: Results & Merit List – Evaluation & Publishing
  // -------------------------------------------------------------------------
  router.get('/center/results', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [resultsRes, appealsRes] = await Promise.all([
      pool.query(
        `SELECT r.*, e.title AS exam_title, e.exam_code
         FROM institute_exam_results r
         JOIN institute_exams e ON e.id = r.exam_id
         WHERE r.institute_id = $1 ORDER BY r.percentage DESC, r.updated_at DESC LIMIT 300`,
        [instituteId],
      ),
      pool.query('SELECT * FROM institute_result_appeals WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 100', [instituteId]),
    ]);
    response.json({ results: resultsRes.rows, appeals: appealsRes.rows });
  }));

  router.post('/center/results', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      examId: z.string().uuid(),
      rollNumber: z.string().trim().min(2).max(60),
      candidateName: z.string().trim().min(2).max(120),
      rawScore: z.coerce.number().min(-1000).max(10000),
      maxScore: z.coerce.number().positive().max(10000),
      qualifyingStatus: z.enum(['passed', 'failed', 'pending']).default('pending'),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const d = parsed.data;
    const instituteId = instituteIdOf(request);
    if (d.rawScore > d.maxScore) {
      response.status(400).json({ error: 'Marks obtained cannot be more than the maximum marks.' });
      return;
    }
    const pct = Math.round((d.rawScore / d.maxScore) * 10000) / 100;
    // Tenant isolation: the exam must belong to this Institute (the INSERT ... SELECT writes nothing otherwise).
    // D-02 / A-16: a result already approved or published is never overwritten from here.
    const rows = await auditedQuery(request,
      `INSERT INTO institute_exam_results (id, institute_id, exam_id, roll_number, candidate_name, raw_score, max_score, percentage, qualifying_status, evaluation_status)
       SELECT $1, e.institute_id, e.id, $4, $5, $6, $7, $8, $9, 'evaluated'
         FROM institute_exams e WHERE e.id = $3 AND e.institute_id = $2 AND e.lifecycle_status NOT IN ('cancelled', 'archived')
       ON CONFLICT (institute_id, exam_id, roll_number) DO UPDATE SET
         candidate_name = EXCLUDED.candidate_name,
         raw_score = EXCLUDED.raw_score, max_score = EXCLUDED.max_score, percentage = EXCLUDED.percentage,
         qualifying_status = EXCLUDED.qualifying_status, evaluation_status = 'evaluated', version = institute_exam_results.version + 1, updated_at = now()
         WHERE institute_exam_results.evaluation_status NOT IN ('approved', 'published')
       RETURNING *, (xmax = 0) AS inserted`,
      [randomUUID(), instituteId, d.examId, d.rollNumber.toUpperCase(), d.candidateName, d.rawScore, d.maxScore, pct, d.qualifyingStatus],
      (row) => ({ action: 'workspace_results.written', resourceId: String(row.id), metadata: { roll_number: String(row.roll_number), version: intOrNone(row.version), corrected: row.inserted === false } }),
    );
    if (!rows[0]) {
      const { rows: exists } = await pool.query('SELECT lifecycle_status FROM institute_exams WHERE id = $1 AND institute_id = $2', [d.examId, instituteId]);
      if (!exists[0]) {
        response.status(404).json({ error: 'Examination not found.' });
        return;
      }
      if (CLOSED_EXAM_STATES.has(String(exists[0].lifecycle_status))) {
        sendExamClosed(response);
        return;
      }
      response.status(409).json({ error: 'This result is already approved or published. Corrections go through the ELTNOY Super Admin.', code: 'RESULT_LOCKED' });
      return;
    }
    const { inserted, ...result } = rows[0] as Record<string, unknown> & { inserted: boolean };
    response.status(inserted ? 201 : 200).json({ result, corrected: !inserted });
  }));

  router.patch('/center/results/:id/status', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      evaluationStatus: z.enum(['moderated', 'approved', 'published']),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    // D-02 / A-04: approval and publication are Super Admin decisions.
    if (OFFICIAL_RESULT_STATUSES.has(parsed.data.evaluationStatus)) {
      await auditPublicationRefused(request, 'result', parsed.data.evaluationStatus, z.string().uuid().safeParse(request.params.id).success ? request.params.id : null);
      sendPublicationForbidden(response, 'result');
      return;
    }
    const instituteId = instituteIdOf(request);
    // An Institute may mark its own evaluated result as moderated (ready for review), never touch an
    // approved or published one.
    const rows = await auditedQuery(request,
      `UPDATE institute_exam_results
       SET evaluation_status = $3, updated_at = now()
       WHERE id = $1 AND institute_id = $2 AND evaluation_status IN ('pending', 'evaluated', 'moderated') RETURNING *`,
      [request.params.id, instituteId, parsed.data.evaluationStatus],
      (row) => ({ action: 'workspace_results.marked_ready', resourceId: String(row.id), metadata: { roll_number: String(row.roll_number), new_status: parsed.data.evaluationStatus } }),
    );
    if (!rows[0]) {
      response.status(404).json({ error: 'Result record not found, or it is already approved or published.' });
      return;
    }
    response.json({ result: rows[0] });
  }));

  // -------------------------------------------------------------------------
  // Section 12: Reports & Analytics – Business Intelligence
  // -------------------------------------------------------------------------
  router.get('/center/reports/saved', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const { rows } = await pool.query(
      'SELECT * FROM institute_saved_reports WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 50',
      [instituteId],
    );
    response.json({ reports: rows });
  }));

  router.post('/center/reports/preview', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({ dataset: z.enum(REPORT_DATASETS) }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    // One row more than shown tells the screen honestly that older rows were left out.
    const { rows } = await pool.query(REPORT_SQL[parsed.data.dataset], [instituteId, REPORT_ROW_LIMIT + 1]);
    response.json({
      dataset: parsed.data.dataset,
      generatedAt: new Date().toISOString(),
      rowCount: Math.min(rows.length, REPORT_ROW_LIMIT),
      truncated: rows.length > REPORT_ROW_LIMIT,
      rows: rows.slice(0, REPORT_ROW_LIMIT),
    });
  }));
  router.post('/center/reports/saved', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      name: z.string().trim().min(3).max(160),
      dataset: z.enum(REPORT_DATASETS),
      outputFormat: z.enum(['csv', 'json']).default('csv'),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    const rows = await auditedQuery(request,
      `INSERT INTO institute_saved_reports (id, institute_id, name, dataset, output_format, created_by)
       VALUES ($1,$2,$3,$4,$5,$2) RETURNING *`,
      [randomUUID(), instituteId, parsed.data.name, parsed.data.dataset, parsed.data.outputFormat],
      (row) => ({ action: 'workspace_report.saved', resourceId: String(row.id), metadata: { dataset: String(row.dataset), output_format: String(row.output_format) } }),
    );
    response.status(201).json({ report: rows[0] });
  }));

  // Section 13 (Staff & Roles audit log) has no Institute route: A-12 keeps audit reads with the Super Admin,
  // and whether an Institute may see its own activity log is open (C-03). Removed at integration (2026-11-28).

  // -------------------------------------------------------------------------
  // Section 14: Exam Attendance Management
  // -------------------------------------------------------------------------
  router.get('/center/attendance', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const { rows } = await pool.query(
      'SELECT * FROM institute_attendance_logs WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 300',
      [instituteId],
    );
    response.json({ records: rows });
  }));

  router.post('/center/attendance/mark', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      examId: z.string().uuid().optional().nullable(),
      rollNumber: z.string().trim().min(2).max(60),
      candidateName: z.string().trim().min(2).max(120),
      centerName: z.string().trim().max(150).default('Main Center'),
      sessionName: z.string().trim().max(60).default('Morning'),
      status: z.enum(['present', 'absent', 'late', 'exception']),
      // Only manual marks can come from an Institute: no QR scanner or import pipeline exists, so a
      // browser-supplied 'qr_scan' or 'import' would be false provenance (2026-11-28).
      source: z.literal('manual').default('manual'),
      reason: z.string().trim().max(500).default(''),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    if (parsed.data.reason.length < 3) {
      response.status(400).json({ error: 'A reason is required for manual attendance marking.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    if (!(await ownsRow('exam', parsed.data.examId, instituteId))) { sendNotFound(response, 'Examination'); return; }
    const rows = await auditedQuery(request,
      `INSERT INTO institute_attendance_logs (id, institute_id, exam_id, roll_number, candidate_name, center_name, session_name, status, source, reason, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$2) RETURNING *`,
      [randomUUID(), instituteId, parsed.data.examId ?? null, parsed.data.rollNumber.toUpperCase(), parsed.data.candidateName, parsed.data.centerName, parsed.data.sessionName, parsed.data.status, parsed.data.source, parsed.data.reason],
      (row) => ({ action: 'workspace_attendance.marked', resourceId: String(row.id), metadata: { status: String(row.status), reason_text: String(row.reason) } }),
    );
    response.status(201).json({ record: rows[0] });
  }));

  // -------------------------------------------------------------------------
  // Section 15: Online Interview – Virtual Interview Studio
  // -------------------------------------------------------------------------
  router.get('/center/interviews', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [interviewsRes, scorecardsRes, changesRes] = await Promise.all([
      pool.query(INTERVIEW_SQL.list, [instituteId]),
      pool.query('SELECT * FROM institute_interview_scorecards WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 200', [instituteId]),
      pool.query(INTERVIEW_SQL.changes, [instituteId]),
    ]);
    response.json({ interviews: interviewsRes.rows, scorecards: scorecardsRes.rows, changes: changesRes.rows });
  }));

  router.post('/center/interviews', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      candidateName: z.string().trim().min(2).max(120),
      applicationNumber: z.string().trim().max(60).default(''),
      panelName: z.string().trim().min(2).max(80),
      panelistNames: z.string().trim().max(300).default(''),
      scheduledDate: z.string().date(),
      startTime: z.string().regex(CLOCK_TIME),
      endTime: z.string().regex(CLOCK_TIME),
      mode: z.enum(['video', 'in_person']).default('video'),
      timezone: interviewTimeZone,
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const d = parsed.data;
    if (d.endTime <= d.startTime) {
      response.status(400).json({ error: 'Interview end time must be after start time.' });
      return;
    }
    if (d.scheduledDate < indiaDate(new Date())) {
      response.status(400).json({ error: 'An interview cannot be scheduled on a past date.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const outcome = await withTransaction(async (client) => {
      await lockInterviewDay(client, instituteId, d.scheduledDate);
      const conflict = await findInterviewConflict(client, instituteId, d, '');
      if (conflict) return { kind: 'conflict' as const, conflict };
      // No meeting link or reference is generated: ELTNOY hosts no video and records nothing (R-11).
      const { rows } = await client.query(INTERVIEW_SQL.insert, [randomUUID(), instituteId, d.candidateName, d.applicationNumber, d.panelName, d.panelistNames, d.scheduledDate, d.startTime, d.endTime, d.mode]);
      await auditWorkspace(client, request, { action: 'workspace_interview.scheduled', resourceId: String(rows[0].id), metadata: { scheduled_date: d.scheduledDate } });
      return { kind: 'created' as const, interview: rows[0] };
    });
    if (outcome.kind === 'conflict') {
      sendPanelConflict(response, outcome.conflict);
      return;
    }
    response.status(201).json({ interview: outcome.interview });
  }));
  router.post('/center/interviews/:id/scorecards', ...guards, asyncRoute(async (request, response) => {
    const score = z.coerce.number().min(0).max(10);
    const parsed = z.object({
      panelistName: z.string().trim().min(2).max(120),
      subjectScore: score,
      communicationScore: score,
      pedagogyScore: score,
      problemSolvingScore: score,
      remarks: z.string().trim().max(1000).default(''),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: 'Invalid interview id.' });
      return;
    }
    const d = parsed.data;
    const instituteId = instituteIdOf(request);
    const outcome = await withTransaction(async (client) => {
      // Serialises scorecards for one interview (the app role has no UPDATE here, so no row lock).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`eltnoy.interview_scorecards:${id.data}`]);
      const interview = await client.query(INTERVIEW_SQL.forScorecard, [id.data, instituteId]);
      if (!interview.rows[0]) return { status: 404 as const };
      const row = interview.rows[0] as { status: string; scheduled_date: string };
      if (row.status === 'cancelled') return { status: 409 as const, code: 'INTERVIEW_CANCELLED', error: 'This interview was cancelled.' };
      if (row.scheduled_date > indiaDate(new Date())) return { status: 409 as const, code: 'INTERVIEW_NOT_HELD', error: 'A scorecard can be entered on or after the interview date.' };
      const duplicate = await client.query(INTERVIEW_SQL.panelistScorecard, [id.data, instituteId, d.panelistName]);
      if (duplicate.rows[0]) return { status: 409 as const, code: 'SCORECARD_EXISTS', error: 'This panelist already has a scorecard for this interview.' };
      const { rows } = await client.query(INTERVIEW_SQL.insertScorecard, [randomUUID(), instituteId, id.data, d.panelistName, d.subjectScore, d.communicationScore, d.pedagogyScore, d.problemSolvingScore, d.remarks]);
      // Scores and the panelist's name stay in the scorecard table; the audit event records that one was submitted.
      await auditWorkspace(client, request, { action: 'workspace_scorecard.submitted', resourceId: id.data });
      return { status: 201 as const, scorecard: rows[0] };
    });
    if (outcome.status === 404) { sendNotFound(response, 'Interview'); return; }
    if (outcome.status === 409) { response.status(409).json({ error: outcome.error, code: outcome.code }); return; }
    response.status(201).json({ scorecard: outcome.scorecard });
  }));

  // Cancel or reschedule an interview that is still scheduled and has no scorecard (an interview with a
  // scorecard was held). Each change keeps the earlier details and the reason in institute_interview_changes,
  // in the same transaction. Locks: the interview's own lock (shared with scorecards), then the target day's.
  router.post('/center/interviews/:id/cancel', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({ reason: z.string().trim().min(5).max(500) }).strict().safeParse(request.body);
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) { response.status(400).json({ error: 'Invalid interview id.' }); return; }
    if (!parsed.success) {
      response.status(400).json({ error: 'A cancellation reason of at least 5 characters is required.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const outcome = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`eltnoy.interview_scorecards:${id.data}`]);
      const current = await changeableInterview(client, id.data, instituteId);
      if ('status' in current) return current;
      const { rows } = await client.query(INTERVIEW_SQL.cancel, [id.data, instituteId]);
      const change = await client.query(INTERVIEW_SQL.insertChange, [randomUUID(), instituteId, id.data, 'cancelled', parsed.data.reason, JSON.stringify(interviewSnapshot(current.interview)), null]);
      await auditWorkspace(client, request, { action: 'workspace_interview.cancelled', resourceId: id.data, metadata: { previous_date: current.interview.scheduled_date, reason_text: parsed.data.reason } });
      return { status: 200 as const, interview: rows[0], change: change.rows[0] };
    });
    sendInterviewOutcome(response, outcome);
  }));

  router.post('/center/interviews/:id/reschedule', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      scheduledDate: z.string().date(),
      startTime: z.string().regex(CLOCK_TIME),
      endTime: z.string().regex(CLOCK_TIME),
      panelName: z.string().trim().min(2).max(80).optional(),
      panelistNames: z.string().trim().max(300).optional(),
      timezone: interviewTimeZone,
      reason: z.string().trim().min(5).max(500),
    }).strict().safeParse(request.body);
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) { response.status(400).json({ error: 'Invalid interview id.' }); return; }
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const d = parsed.data;
    if (d.endTime <= d.startTime) {
      response.status(400).json({ error: 'Interview end time must be after start time.' });
      return;
    }
    if (d.scheduledDate < indiaDate(new Date())) {
      response.status(400).json({ error: 'An interview cannot be moved to a past date.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    const outcome = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`eltnoy.interview_scorecards:${id.data}`]);
      await lockInterviewDay(client, instituteId, d.scheduledDate);
      const current = await changeableInterview(client, id.data, instituteId);
      if ('status' in current) return current;
      const before = interviewSnapshot(current.interview);
      const after = {
        scheduledDate: d.scheduledDate, startTime: d.startTime, endTime: d.endTime,
        panelName: d.panelName ?? before.panelName, panelistNames: d.panelistNames ?? before.panelistNames,
      };
      if (after.scheduledDate === before.scheduledDate && after.startTime === before.startTime && after.endTime === before.endTime
        && after.panelName === before.panelName && after.panelistNames === before.panelistNames) {
        return { status: 409 as const, code: 'NO_CHANGE', error: 'The new date, time and panel are the same as the current ones.' };
      }
      const conflict = await findInterviewConflict(client, instituteId, after, id.data);
      if (conflict) return { status: 'conflict' as const, conflict };
      const { rows } = await client.query(INTERVIEW_SQL.reschedule, [id.data, instituteId, after.scheduledDate, after.startTime, after.endTime, after.panelName, after.panelistNames]);
      const change = await client.query(INTERVIEW_SQL.insertChange, [randomUUID(), instituteId, id.data, 'rescheduled', d.reason, JSON.stringify(before), JSON.stringify(after)]);
      await auditWorkspace(client, request, { action: 'workspace_interview.rescheduled', resourceId: id.data, metadata: { previous_date: before.scheduledDate, new_date: after.scheduledDate, reason_text: d.reason } });
      return { status: 200 as const, interview: rows[0], change: change.rows[0] };
    });
    if (outcome.status === 'conflict') {
      sendPanelConflict(response, outcome.conflict);
      return;
    }
    sendInterviewOutcome(response, outcome);
  }));

  // -------------------------------------------------------------------------
  // Section 16: Online Training – Learning & Certification
  // -------------------------------------------------------------------------
  // Training (R-12): the Institute's own records of courses, scheduled sessions and enrolled learners.
  // - No "published" state is accepted: there is no learner-facing page, so publishing would change nothing.
  // - No progress is accepted: completed modules could only be typed once, at enrolment, and never updated.
  // - ELTNOY hosts no live session; a session is a scheduled date and time.
  // - Certificates are refused: R-13 requires verifiable certificate IDs and nothing can verify them yet.
  router.get('/center/training', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const [coursesRes, sessionsRes, enrollmentsRes] = await Promise.all([
      pool.query(TRAINING_SQL.courses, [instituteId]),
      pool.query(TRAINING_SQL.sessions, [instituteId]),
      pool.query(TRAINING_SQL.enrollments, [instituteId]),
    ]);
    response.json({ courses: coursesRes.rows, sessions: sessionsRes.rows, enrollments: enrollmentsRes.rows });
  }));
  router.post('/center/training/courses', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      title: z.string().trim().min(3).max(160),
      category: z.string().trim().min(2).max(80).default('General'),
      moduleCount: z.coerce.number().int().min(1).max(100),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    const rows = await auditedQuery(request, TRAINING_SQL.insertCourse, [randomUUID(), instituteId, parsed.data.title, parsed.data.category, parsed.data.moduleCount],
      (row) => ({ action: 'workspace_training.course_created', resourceId: String(row.id), metadata: { module_count: intOrNone(row.module_count) } }));
    response.status(201).json({ course: rows[0] });
  }));
  router.post('/center/training/sessions', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      courseId: z.string().uuid().optional().nullable(),
      title: z.string().trim().min(3).max(160),
      sessionDate: z.string().date(),
      sessionTime: z.string().regex(CLOCK_TIME),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    if (parsed.data.sessionDate < indiaDate(new Date())) {
      response.status(400).json({ error: 'A session cannot be scheduled on a past date.' });
      return;
    }
    const instituteId = instituteIdOf(request);
    if (!(await ownsRow('course', parsed.data.courseId, instituteId))) { sendNotFound(response, 'Course'); return; }
    const rows = await auditedQuery(request, TRAINING_SQL.insertSession, [randomUUID(), instituteId, parsed.data.courseId ?? null, parsed.data.title, parsed.data.sessionDate, parsed.data.sessionTime],
      (row) => ({ action: 'workspace_training.session_scheduled', resourceId: String(row.id), metadata: { scheduled_date: String(row.session_date) } }));
    response.status(201).json({ session: rows[0] });
  }));
  router.post('/center/training/enrollments', ...guards, asyncRoute(async (request, response) => {
    const parsed = z.object({
      courseId: z.string().uuid(),
      learnerName: z.string().trim().min(2).max(120),
      learnerEmail: z.string().trim().email().max(254).or(z.literal('')).default(''),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const instituteId = instituteIdOf(request);
    if (!(await ownsRow('course', parsed.data.courseId, instituteId))) { sendNotFound(response, 'Course'); return; }
    // The learner's name and email stay in the enrolment; the audit event records the course only.
    const rows = await auditedQuery(request, TRAINING_SQL.insertEnrollment, [randomUUID(), instituteId, parsed.data.courseId, parsed.data.learnerName, parsed.data.learnerEmail.toLowerCase()],
      () => ({ action: 'workspace_training.learner_enrolled', resourceId: parsed.data.courseId }));
    if (!rows[0]) {
      response.status(409).json({
        error: parsed.data.learnerEmail
          ? 'This learner (same email) is already enrolled in this course.'
          : 'A learner with this name and no email is already enrolled in this course. Add the learner\'s email to enrol a different person with the same name.',
        code: 'ENROLLMENT_EXISTS',
      });
      return;
    }
    response.status(201).json({ enrollment: rows[0] });
  }));
  router.post('/center/training/enrollments/:id/certificate', ...guards, (_request: Request, response: Response) => {
    response.status(403).json({
      error: 'Training certificates are not available yet: certificates need IDs that anyone can verify, and verification does not exist.',
      code: 'CERTIFICATES_NOT_AVAILABLE',
    });
  });

  // -------------------------------------------------------------------------
  // Section 17: Settings & Support – Configuration & Helpdesk
  // -------------------------------------------------------------------------
  // Settings & Support: integration status read from the real provider configuration, and support
  // tickets. There are no stored Institute settings: the earlier toggles (staff MFA, candidate alerts,
  // payment webhook verification, bulk export restriction, audit retention, academic year) changed
  // nothing in the system, and audit retention contradicts A-13, so they were removed (2026-11-28).
  router.get('/center/settings', ...guards, asyncRoute(async (request, response) => {
    const instituteId = instituteIdOf(request);
    const ticketsRes = await pool.query('SELECT * FROM institute_support_tickets WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 100', [instituteId]);
    const providers = providerStatus();
    const integrations = [
      { name: 'Transactional Email', status: providers.email.available ? 'Healthy' : 'Not configured' },
      { name: 'SMS Provider', status: providers.sms.available ? 'Healthy' : 'Not configured' },
      { name: 'Google Sign-In', status: providers.google.available ? 'Healthy' : 'Not configured' },
      { name: 'Payment Gateway', status: 'Not configured' },
    ];
    response.json({ integrations, tickets: ticketsRes.rows });
  }));

  // Support tickets are refused: no ELTNOY queue or screen reads institute_support_tickets, so a ticket
  // would look accepted by support when nobody can see it, and an Institute could resolve its own ticket
  // (review 2026-11-28). Contact routes stay as they are elsewhere in the portal.
  router.post('/center/tickets', ...guards, (_request: Request, response: Response) => {
    response.status(409).json({ error: 'Support tickets are not available yet: no ELTNOY support queue reads them.', code: 'SUPPORT_TICKETS_NOT_AVAILABLE' });
  });
  router.patch('/center/tickets/:id', ...guards, (_request: Request, response: Response) => {
    response.status(403).json({ error: 'Support ticket status is set by ELTNOY support, not by the Institute.', code: 'SUPPORT_TICKETS_NOT_AVAILABLE' });
  });

  return router;
}
