import 'dotenv/config';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { AuthenticatedRequest, getTrustedRequestSurface, registrationPasswordSchema, SESSION_TTL_MS, hashSessionToken, newSessionToken, requireAuth, requireRoles, requireSuperAdmin, setSessionCookie } from './auth.js';
import { createListenerRequestHandler, ListenerStartupError, NO_RECOVERY_HANDLE, resolveActiveListeners, startApiRuntime, type ApiRuntime, type ListenerServer, type ListenerSpec } from './apiListeners.js';
import { disclosedSurfaceHostnames, isLoginRoleAllowedOnSurface, type Surface } from './surface.js';
import { createExpressProxyTrust, createRejectionLog, createSurfaceGate, loadSurfaceRuntimeConfig, type SurfaceGate } from './surfaceEnforcement.js';
import { addWorkbookSheet, readWorkbookSheet, WORKBOOK_MIME_TYPE } from './adminWorkbook.js';
import {
  candidateApplicationsQuery,
  candidateAdmitCardQuery,
  candidatePracticeHistoryQuery,
  candidateResultLookupQuery,
  candidateResultsQuery,
  centerCheckinsQuery,
  centerWorkspaceQueries,
  linkLegacyApplicationQuery,
} from './authorizationQueries.js';
import { pool } from './db.js';
import { scoreMockResponses } from './mockScoring.js';
import {
  finalizeAttempt,
  type FinalizeOutcome,
  type OnlineExamConfig,
  OnlineExamInvariantError,
  readOnlineExamConfig,
  saveAttemptResponses,
  type SaveResponsesOutcome,
} from './onlineExamFinalization.js';
import {
  attemptStateParams,
  ONLINE_EXAM_RECOVERY_SQL,
  startOnlineExamRecovery,
  type OnlineExamRecoveryHandle,
} from './onlineExamRecovery.js';
import { DEFAULT_EXAM_TIME_ZONE, isValidTimeZone } from '../src/utils/examSchedule.js';
import { createInstitutionDocumentsRouter } from './institutionDocuments.js';
import { createPlatformStaffRouters, createPostgresPlatformStaffStore } from './platformStaff.js';
import {
  authVerificationStore,
  createAuthVerificationRouter,
  nextInstituteChannel,
  abuseProtectionReadiness,
  emailProtectionGate,
  emailProtectionReadiness,
  initializeAbuseProtection,
  smsProtectionGate,
  sendFlowError,
  startInstituteVerification,
  startStudentRegistration,
  startVerification,
  VerificationFlowError,
} from './authVerification.js';
import {
  configureVerificationServices,
  EMAIL_PROVIDER_NOT_CONFIGURED,
  OTP_PROVIDER_NOT_CONFIGURED,
  mobileVerificationMode,
  normaliseEmail,
  normaliseMobile,
  providerStatus,
  resolveVerificationServices,
  studentLoginIdForMobile,
  verificationServices,
} from './verificationProviders.js';
// Registers the owner-selected Resend email and Twilio SMS adapters. Channels still fail closed
// unless each provider's secret/configuration and the independent abuse limits are present.
import './verificationProviderAdapters.js';
import { compareAgainstDummyHash } from './staffCommon.js';
import { beginAdminMfaSignIn, createAdminMfaEnrolConfirmHandler, createAdminMfaEnrolStartHandler, createAdminMfaVerifyHandler, sendAdminMfaError } from './adminMfa.js';
import { createOrgStaffRouters, createPostgresOrgStaffStore } from './organizationStaff.js';
import { createInstituteVerificationAdminRouter } from './instituteVerificationAdmin.js';
import { auditActor, recordAuditEvent, recordRefusedAuditEvent, runAuditedTransaction } from './audit.js';
import { createAuditRouter } from './auditRoutes.js';
import { createMeritListRouter } from './meritListRoutes.js';
import {
  createInstitutionSubmissionRouter,
  createSubmissionCycle,
  issueSubmissionCapability,
  setInstitutionSubmissionCookie,
} from './institutionSubmission.js';

export const app = express();
const sessionSeconds = Math.floor(SESSION_TTL_MS / 1000);

// P1-B surface enforcement. Proxy trust is set at startup from the validated per-listener proxy
// addresses; until then (and in tests) nothing is trusted. The gate fails closed until startApi()
// configures it. Rejections are counted in a bounded, aggregated log (L-3): fixed reason keys only,
// one "first seen" line per reason and one summary per 1000 rejections (and at shutdown); no timers.
export const surfaceRejectionLog = createRejectionLog((entry) => console.warn(JSON.stringify(entry)));
export const surfaceGate = createSurfaceGate({
  onReject: (reason) => surfaceRejectionLog.record(reason),
});
app.set('trust proxy', false);
app.use(surfaceGate.identify);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      styleSrc: ["'self'", "'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
    },
  },
}));
app.use(express.json({ limit: '32kb' }));
app.use(surfaceGate.enforceOrigin);
app.use(surfaceGate.enforceRoutePolicy);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});
const publicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function sendValidationError(response: Response, error: z.ZodError): void {
  response.status(400).json({
    error: 'Invalid request.',
    details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  });
}

/** A-11: one transaction for an action and its audit event (server/audit.ts). */
function inAuditedTransaction<T>(work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return runAuditedTransaction(pool, work);
}

function getUser(request: Request) {
  return (request as AuthenticatedRequest).user;
}

function toFeedback(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    module: row.module,
    candidateName: row.candidate_name,
    email: row.email,
    applicationNumber: row.application_number,
    priority: row.priority,
    rating: row.rating,
    status: row.status,
    createdAt: row.created_at,
    attachmentName: row.attachment_name,
    resolutionNote: row.resolution_note,
  };
}

function toExam(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    targetAudience: row.target_audience,
    regStart: row.registration_start,
    regEnd: row.registration_end,
    examDate: row.exam_date,
    timeZone: row.time_zone,
    fee: row.fee,
    duration: row.duration,
    mode: row.mode,
    shifts: row.shifts,
    isPublished: row.is_published,
  };
}

const workbookUpload = express.raw({ type: WORKBOOK_MIME_TYPE, limit: '5mb' });

app.get('/api/notices', asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, title, category, summary, full_content, reference_number, published_at
     FROM portal_notices WHERE is_published = true
     ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 100`,
  );
  response.json({ notices: rows });
}));

app.get('/api/admin/notices', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, title, category, summary, full_content, reference_number,
            is_published, created_at, published_at
     FROM portal_notices ORDER BY created_at DESC LIMIT 500`,
  );
  response.json({ notices: rows });
}));

app.post('/api/admin/notices', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    title: z.string().trim().min(8).max(180),
    category: z.enum(['Registration', 'Admit Card', 'Answer Key', 'Result', 'Circular']),
    summary: z.string().trim().min(10).max(500),
    fullContent: z.string().trim().min(10).max(10000),
    referenceNumber: z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9._/-]+$/),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const rows = await inAuditedTransaction(async (client) => {
    const inserted = await client.query(
    `INSERT INTO portal_notices
     (id, title, category, summary, full_content, reference_number, is_published, created_by, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7, NULL)
     RETURNING id, title, category, summary, full_content, reference_number,
               is_published, created_at, published_at`,
    [randomUUID(), parsed.data.title, parsed.data.category, parsed.data.summary,
      parsed.data.fullContent, parsed.data.referenceNumber.toUpperCase(), user?.id],
    );
    await recordAuditEvent(client, {
      action: 'notice.created', actor: auditActor(request), resourceId: String(inserted.rows[0].id),
      metadata: { category: parsed.data.category, reference_number: parsed.data.referenceNumber.toUpperCase(), is_published: false },
    });
    return inserted.rows;
  });
  response.status(201).json({ notice: rows[0] });
}));

app.patch('/api/admin/notices/:id', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
    `UPDATE portal_notices
     SET is_published = $2, published_at = CASE WHEN $2 THEN now() ELSE published_at END
     WHERE id = $1
     RETURNING id, title, category, summary, full_content, reference_number,
               is_published, created_at, published_at`,
    [request.params.id, parsed.data.isPublished],
    );
    if (updated.rows[0]) {
      await recordAuditEvent(client, {
        action: 'notice.publication_changed', actor: auditActor(request), resourceId: String(updated.rows[0].id),
        metadata: { is_published: parsed.data.isPublished },
      });
    }
    return updated.rows;
  });
  if (!rows[0]) {
    response.status(404).json({ error: 'Notice not found.' });
    return;
  }
  response.json({ notice: rows[0] });
}));

async function getUploadRows(request: Request, response: Response, sheetName: string) {
  if (!Buffer.isBuffer(request.body)) {
    response.status(400).json({ error: `Upload an Excel workbook containing the "${sheetName}" worksheet.` });
    return undefined;
  }
  try {
    const rows = await readWorkbookSheet(request.body, sheetName);
    if (!rows.length) {
      response.status(400).json({ error: `The "${sheetName}" worksheet has no data rows.` });
      return undefined;
    }
    return rows;
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Could not read the uploaded workbook.',
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// P0-3 publication guards (A-04, A-05, A-16, P3-D11)
//
// Ordinary Officials may create and replace DRAFT content only. Super Admins may also correct
// published content, which always returns it to draft. Every guarded write verifies its row
// count and rolls back the whole transaction on any miss, so an import is all-or-nothing.
// ---------------------------------------------------------------------------

function sendPublishedContentForbidden(response: Response, content: 'result' | 'answer key' | 'online exam'): void {
  response.status(403).json({
    error: `Only a Super Admin can correct a published ${content}. Nothing was imported or changed.`,
    code: 'published_content_super_admin_only',
  });
}

export const RESULT_UPSERT_SQL = Object.freeze({
  // Super Admin: new rows and corrections are written as drafts (A-16).
  draft: `INSERT INTO published_results (id, application_number, roll_number, exam_code, date_of_birth, scorecard, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     ON CONFLICT (exam_code, roll_number) DO UPDATE SET
       application_number = EXCLUDED.application_number, date_of_birth = EXCLUDED.date_of_birth,
       scorecard = EXCLUDED.scorecard, is_published = false, published_at = now()
     RETURNING id, application_number, roll_number, exam_code, published_at, is_published`,
  // Ordinary Official: a conflicting row is replaced only while it is still a draft.
  // A published conflicting row makes this statement affect 0 rows.
  draftOnlyOverDrafts: `INSERT INTO published_results (id, application_number, roll_number, exam_code, date_of_birth, scorecard, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     ON CONFLICT (exam_code, roll_number) DO UPDATE SET
       application_number = EXCLUDED.application_number, date_of_birth = EXCLUDED.date_of_birth,
       scorecard = EXCLUDED.scorecard, is_published = false, published_at = now()
     WHERE published_results.is_published = false
     RETURNING id, application_number, roll_number, exam_code, published_at, is_published`,
});

const ANSWER_KEY_UPSERT = `INSERT INTO answer_key_questions
         (id, exam_code, question_number, subject, question_text, options, official_key, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (exam_code, question_number) DO UPDATE SET
           subject = EXCLUDED.subject, question_text = EXCLUDED.question_text, options = EXCLUDED.options,
           official_key = EXCLUDED.official_key, explanation = EXCLUDED.explanation, is_published = false`;

export const ANSWER_KEY_IMPORT_SQL = Object.freeze({
  lockExam: `SELECT question_number, is_published FROM answer_key_questions
     WHERE exam_code = $1 ORDER BY question_number FOR UPDATE`,
  upsert: ANSWER_KEY_UPSERT,
  upsertDraftOnly: `${ANSWER_KEY_UPSERT}
         WHERE answer_key_questions.is_published = false`,
});

const ONLINE_EXAM_UPSERT = `INSERT INTO online_exam_questions
         (id, exam_code, exam_name, duration_minutes, question_number, section, question_text, options, correct_option, points)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (exam_code, question_number) DO UPDATE SET
           exam_name = EXCLUDED.exam_name, duration_minutes = EXCLUDED.duration_minutes, section = EXCLUDED.section,
           question_text = EXCLUDED.question_text, options = EXCLUDED.options,
           correct_option = EXCLUDED.correct_option, points = EXCLUDED.points, is_published = false`;

export const ONLINE_EXAM_IMPORT_SQL = Object.freeze({
  lockExam: `SELECT question_number, is_published FROM online_exam_questions
     WHERE exam_code = $1 ORDER BY question_number FOR UPDATE`,
  upsert: ONLINE_EXAM_UPSERT,
  upsertDraftOnly: `${ONLINE_EXAM_UPSERT}
         WHERE online_exam_questions.is_published = false`,
});

app.get('/api/admin/workbook-template', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const workbook = new ExcelJS.Workbook();
  addWorkbookSheet(workbook, 'AdmitCards', [
    'applicationNumber', 'examCode', 'rollNumber', 'examDate', 'reportingTime',
    'gateClosingTime', 'examTiming', 'centerCode', 'centerName', 'centerAddress',
  ]);
  addWorkbookSheet(workbook, 'AnswerKeys', [
    'examCode', 'questionNumber', 'subject', 'questionText',
    'optionA', 'optionB', 'optionC', 'optionD', 'officialKey', 'explanation',
  ]);
  addWorkbookSheet(workbook, 'Results', [
    'applicationNumber', 'rollNumber', 'examCode', 'dateOfBirth', 'scorecardJson',
  ]);
  addWorkbookSheet(workbook, 'OnlineExam', [
    'examCode', 'examName', 'durationMinutes', 'questionNumber', 'section', 'questionText',
    'optionA', 'optionB', 'optionC', 'optionD', 'correctOption', 'points',
  ]);
  const buffer = await workbook.xlsx.writeBuffer();
  response.type(WORKBOOK_MIME_TYPE);
  response.setHeader('Content-Disposition', 'attachment; filename="eltnoy-admin-upload-templates.xlsx"');
  response.send(Buffer.from(buffer));
}));

// P0-3 (A-14, P3-D4): the open-helpdesk count is Super Admin-only. For ordinary Officials the
// feedback table is not queried at all and `openHelpdesk` is null.
app.get('/api/admin/dashboard-stats', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const includeHelpdesk = getUser(request)?.isSuperAdmin === true;
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM applications) AS applications,
       ${includeHelpdesk ? "(SELECT count(*) FROM feedback WHERE status <> 'resolved')" : 'NULL'} AS open_helpdesk,
       (SELECT count(*) FROM mock_exam_attempts) AS mock_exam_attempts,
       (SELECT count(*) FROM published_results WHERE is_published = true) AS published_results`,
  );
  response.json({
    stats: {
      applications: Number(rows[0].applications),
      openHelpdesk: includeHelpdesk ? Number(rows[0].open_helpdesk) : null,
      mockExamAttempts: Number(rows[0].mock_exam_attempts),
      publishedResults: Number(rows[0].published_results),
    },
  });
}));

app.get('/api/admin/data-export', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const workbook = new ExcelJS.Workbook();
  const [
    users, applications, exams, admitCards, checkins, feedback, attempts, results, answerKeys, onlineQuestions, onlineAttempts, notices,
  ] = await Promise.all([
    pool.query(`SELECT id, login_id, display_name, role, contact_email, registration_number,
                       registered_address, website, account_status, created_at
                FROM users ORDER BY created_at`),
    pool.query('SELECT * FROM applications ORDER BY created_at'),
    pool.query('SELECT * FROM exams ORDER BY created_at'),
    pool.query(`SELECT c.*, a.application_number, a.exam_code
                FROM admit_cards c JOIN applications a ON a.id = c.application_id
                ORDER BY c.published_at`),
    pool.query('SELECT * FROM center_checkins ORDER BY updated_at'),
    pool.query('SELECT * FROM feedback ORDER BY created_at'),
    pool.query(`SELECT a.id, u.login_id, u.display_name, a.responses, a.total_questions, a.attempted,
                       a.correct, a.incorrect, a.unattempted, a.total_score, a.max_score,
                       a.percentage, a.section_scores, a.submitted_at
                FROM mock_exam_attempts a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.submitted_at`),
    pool.query('SELECT * FROM published_results ORDER BY published_at'),
    pool.query('SELECT * FROM answer_key_questions ORDER BY exam_code, question_number'),
    pool.query('SELECT * FROM online_exam_questions ORDER BY exam_code, question_number'),
    pool.query(`SELECT a.id, u.login_id, u.display_name, a.exam_code, a.started_at, a.expires_at,
                       a.submitted_at, a.responses, a.score
                FROM online_exam_attempts a JOIN users u ON u.id = a.user_id ORDER BY a.started_at`),
    pool.query(`SELECT id, title, category, summary, full_content, reference_number,
                       is_published, created_at, published_at
                FROM portal_notices ORDER BY created_at DESC`),
  ]);
  const sheets = [
    ['Accounts', users.rows],
    ['Applications', applications.rows],
    ['ExamForms', exams.rows],
    ['AdmitCards', admitCards.rows],
    ['CenterCheckins', checkins.rows],
    ['Helpdesk', feedback.rows],
    ['MockAttempts', attempts.rows],
    ['Results', results.rows],
    ['AnswerKeys', answerKeys.rows],
    ['OnlineExamQuestions', onlineQuestions.rows],
    ['OnlineExamAttempts', onlineAttempts.rows],
    ['Notices', notices.rows],
  ] as const;
  for (const [name, rows] of sheets) {
    const headers = rows[0] ? Object.keys(rows[0]) : ['No records'];
    addWorkbookSheet(workbook, name, headers, rows as Array<Record<string, unknown>>);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  // A-07/A-11: the export is recorded before any data leaves; if the record fails, nothing is sent.
  await inAuditedTransaction((client) => recordAuditEvent(client, {
    action: 'data_export.generated', actor: auditActor(request),
    metadata: { sheet_count: sheets.length, row_count: sheets.reduce((total, [, rows]) => total + rows.length, 0) },
  }));
  response.type(WORKBOOK_MIME_TYPE);
  response.setHeader('Content-Disposition', 'attachment; filename="eltnoy-admin-data.xlsx"');
  response.send(Buffer.from(buffer));
}));

// P0-3 (A-06, P3-D1): admit cards have no draft state yet, so every write publishes; interim
// Super Admin-only. The guard runs before the upload is parsed.
app.post('/api/admin/admit-cards/import', requireAuth, requireRoles('official'), requireSuperAdmin, workbookUpload, asyncRoute(async (request, response) => {
  const rows = await getUploadRows(request, response, 'AdmitCards');
  if (!rows) return;
  const schema = z.object({
    applicationNumber: z.string().trim().min(4).max(100),
    examCode: z.string().trim().min(2).max(30),
    rollNumber: z.string().trim().min(3).max(50),
    examDate: z.string().date(),
    reportingTime: z.string().trim().min(3).max(50),
    gateClosingTime: z.string().trim().min(3).max(50),
    examTiming: z.string().trim().min(3).max(100),
    centerCode: z.string().trim().min(2).max(40),
    centerName: z.string().trim().min(2).max(150),
    centerAddress: z.string().trim().min(5).max(300),
  });
  const parsed = rows.map((row) => schema.safeParse(row));
  const invalidRow = parsed.findIndex((item) => !item.success);
  if (invalidRow !== -1) {
    const issue = parsed[invalidRow];
    response.status(400).json({ error: `Invalid AdmitCards row ${invalidRow + 2}: ${issue.success ? '' : issue.error.issues[0]?.message}` });
    return;
  }
  const applicationKeys = parsed.flatMap((item) => item.success ? [`${item.data.examCode.toUpperCase()}:${item.data.applicationNumber.toUpperCase()}`] : []);
  if (new Set(applicationKeys).size !== applicationKeys.length) {
    response.status(400).json({ error: 'The AdmitCards worksheet contains duplicate application/exam rows.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of parsed) {
      if (!item.success) continue;
      const card = item.data;
      const application = await client.query(
        'SELECT id FROM applications WHERE application_number = $1 AND exam_code = $2',
        [card.applicationNumber.toUpperCase(), card.examCode.toUpperCase()],
      );
      if (!application.rows[0]) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: `No application matches ${card.applicationNumber} (${card.examCode}); no admit cards were imported.` });
        return;
      }
      await client.query(
        `INSERT INTO admit_cards
         (application_id, roll_number, exam_date, reporting_time, gate_closing_time, exam_timing, center_code, center_name, center_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (application_id) DO UPDATE SET
           roll_number = EXCLUDED.roll_number, exam_date = EXCLUDED.exam_date,
           reporting_time = EXCLUDED.reporting_time, gate_closing_time = EXCLUDED.gate_closing_time,
           exam_timing = EXCLUDED.exam_timing, center_code = EXCLUDED.center_code,
           center_name = EXCLUDED.center_name, center_address = EXCLUDED.center_address,
           published_at = now()`,
        [application.rows[0].id, card.rollNumber.toUpperCase(), card.examDate, card.reportingTime,
          card.gateClosingTime, card.examTiming, card.centerCode.toUpperCase(), card.centerName, card.centerAddress],
      );
    }
    await recordAuditEvent(client, {
      action: 'admit_cards.imported', actor: auditActor(request),
      metadata: { row_count: parsed.length, exam_codes: [...new Set(parsed.flatMap((item) => item.success ? [item.data.examCode.toUpperCase()] : []))].sort() },
    });
    await client.query('COMMIT');
    response.status(201).json({ imported: parsed.length });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/admin/answer-keys/import', requireAuth, requireRoles('official'), workbookUpload, asyncRoute(async (request, response) => {
  const rows = await getUploadRows(request, response, 'AnswerKeys');
  if (!rows) return;
  const schema = z.object({
    examCode: z.string().trim().min(2).max(30),
    questionNumber: z.coerce.number().int().positive(),
    subject: z.enum(['Mathematics', 'Physics', 'Chemistry', 'Logical Reasoning']),
    questionText: z.string().trim().min(1).max(2000),
    optionA: z.string().trim().min(1).max(1000),
    optionB: z.string().trim().min(1).max(1000),
    optionC: z.string().trim().min(1).max(1000),
    optionD: z.string().trim().min(1).max(1000),
    officialKey: z.enum(['A', 'B', 'C', 'D']),
    explanation: z.string().max(4000).optional(),
  });
  const parsed = rows.map((row) => schema.safeParse(row));
  const invalidRow = parsed.findIndex((item) => !item.success);
  if (invalidRow !== -1) {
    const issue = parsed[invalidRow];
    response.status(400).json({ error: `Invalid AnswerKeys row ${invalidRow + 2}: ${issue.success ? '' : issue.error.issues[0]?.message}` });
    return;
  }
  const answerKeyKeys = parsed.flatMap((item) => item.success ? [`${item.data.examCode.toUpperCase()}:${item.data.questionNumber}`] : []);
  if (new Set(answerKeyKeys).size !== answerKeyKeys.length) {
    response.status(400).json({ error: 'The AnswerKeys worksheet contains duplicate exam/question numbers.' });
    return;
  }
  const superAdmin = getUser(request)?.isSuperAdmin === true;
  const examCodes = [...new Set(parsed.flatMap((item) => item.success ? [item.data.examCode.toUpperCase()] : []))].sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // P0-3 (A-05, A-16, P3-D11): lock every existing row of each exam before reading its
    // publication state, so a concurrent publish either finishes first (and is seen here) or
    // waits for this import. Exams are locked in a fixed order to avoid lock-order deadlocks.
    for (const examCode of examCodes) {
      const { rows: locked } = await client.query(ANSWER_KEY_IMPORT_SQL.lockExam, [examCode]);
      if (!superAdmin && locked.some((row) => row.is_published === true)) {
        await client.query('ROLLBACK');
        sendPublishedContentForbidden(response, 'answer key');
        return;
      }
    }
    // Super Admin correction of published content returns the whole exam to draft (A-16).
    for (const examCode of examCodes) {
      await client.query('UPDATE answer_key_questions SET is_published = false WHERE exam_code = $1', [examCode]);
    }
    for (const item of parsed) {
      if (!item.success) continue;
      const key = item.data;
      const { rowCount } = await client.query(
        superAdmin ? ANSWER_KEY_IMPORT_SQL.upsert : ANSWER_KEY_IMPORT_SQL.upsertDraftOnly,
        [randomUUID(), key.examCode.toUpperCase(), key.questionNumber, key.subject, key.questionText,
          { A: key.optionA, B: key.optionB, C: key.optionC, D: key.optionD }, key.officialKey, key.explanation ?? ''],
      );
      if (rowCount !== 1) {
        // Unexpected for a Super Admin: the catch block rolls back the whole import.
        if (superAdmin) throw new Error('Answer-key import did not write exactly one row.');
        // The draft-only guard matched a published row; nothing from this import is kept.
        await client.query('ROLLBACK');
        sendPublishedContentForbidden(response, 'answer key');
        return;
      }
    }
    await recordAuditEvent(client, {
      action: 'answer_keys.imported', actor: auditActor(request),
      metadata: { row_count: parsed.length, exam_codes: examCodes },
    });
    await client.query('COMMIT');
    response.status(201).json({ imported: parsed.length });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/admin/online-exams/import', requireAuth, requireRoles('official'), workbookUpload, asyncRoute(async (request, response) => {
  const rows = await getUploadRows(request, response, 'OnlineExam');
  if (!rows) return;
  const schema = z.object({
    examCode: z.string().trim().min(2).max(30),
    examName: z.string().trim().min(2).max(160),
    durationMinutes: z.coerce.number().int().min(1).max(600),
    questionNumber: z.coerce.number().int().positive(),
    section: z.string().trim().min(1).max(100),
    questionText: z.string().trim().min(1).max(3000),
    optionA: z.string().trim().min(1).max(1000),
    optionB: z.string().trim().min(1).max(1000),
    optionC: z.string().trim().min(1).max(1000),
    optionD: z.string().trim().min(1).max(1000),
    correctOption: z.enum(['A', 'B', 'C', 'D']),
    points: z.preprocess(
      (value) => value === '' || value === undefined ? 1 : value,
      z.coerce.number().int().min(1).max(100),
    ),
  });
  const parsed = rows.map((row) => schema.safeParse(row));
  const invalidRow = parsed.findIndex((item) => !item.success);
  if (invalidRow !== -1) {
    const issue = parsed[invalidRow];
    response.status(400).json({ error: `Invalid OnlineExam row ${invalidRow + 2}: ${issue.success ? '' : issue.error.issues[0]?.message}` });
    return;
  }
  const exams = new Set(parsed.flatMap((item) => item.success ? [item.data.examCode.toUpperCase()] : []));
  if (exams.size !== 1) {
    response.status(400).json({ error: 'Upload one exam code per OnlineExam worksheet.' });
    return;
  }
  const examVersions = new Set(parsed.flatMap((item) => item.success ? [`${item.data.examName}:${item.data.durationMinutes}`] : []));
  if (examVersions.size !== 1) {
    response.status(400).json({ error: 'All OnlineExam rows must use the same exam name and duration.' });
    return;
  }
  const questionNumbers = parsed.flatMap((item) => item.success ? [item.data.questionNumber] : []);
  if (new Set(questionNumbers).size !== questionNumbers.length) {
    response.status(400).json({ error: 'The OnlineExam worksheet contains duplicate question numbers.' });
    return;
  }
  const superAdmin = getUser(request)?.isSuperAdmin === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // P0-4 history protection: unchanged and still the first check, for every Official.
    const activeAttempts = await client.query(
      'SELECT 1 FROM online_exam_attempts WHERE exam_code = $1 LIMIT 1',
      [[...exams][0]],
    );
    if (activeAttempts.rows[0]) {
      await client.query('ROLLBACK');
      response.status(409).json({ error: 'This exam already has attempts. Create a new exam code to preserve its question and scoring history.' });
      return;
    }
    // P0-3 (A-05, A-16, P3-D11): lock the exam's rows before reading its publication state.
    const { rows: locked } = await client.query(ONLINE_EXAM_IMPORT_SQL.lockExam, [[...exams][0]]);
    if (!superAdmin && locked.some((row) => row.is_published === true)) {
      await client.query('ROLLBACK');
      sendPublishedContentForbidden(response, 'online exam');
      return;
    }
    // Super Admin correction of a published paper returns it to draft (A-16).
    await client.query('UPDATE online_exam_questions SET is_published = false WHERE exam_code = $1', [[...exams][0]]);
    for (const item of parsed) {
      if (!item.success) continue;
      const question = item.data;
      const { rowCount } = await client.query(
        superAdmin ? ONLINE_EXAM_IMPORT_SQL.upsert : ONLINE_EXAM_IMPORT_SQL.upsertDraftOnly,
        [randomUUID(), question.examCode.toUpperCase(), question.examName, question.durationMinutes,
          question.questionNumber, question.section, question.questionText,
          { A: question.optionA, B: question.optionB, C: question.optionC, D: question.optionD },
          question.correctOption, question.points],
      );
      if (rowCount !== 1) {
        if (superAdmin) throw new Error('Online-exam import did not write exactly one row.');
        await client.query('ROLLBACK');
        sendPublishedContentForbidden(response, 'online exam');
        return;
      }
    }
    await recordAuditEvent(client, {
      action: 'online_exams.imported', actor: auditActor(request),
      metadata: { row_count: parsed.length, exam_codes: [...exams].sort() },
    });
    await client.query('COMMIT');
    response.status(201).json({ examCode: [...exams][0], imported: parsed.length, published: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/admin/results/import', requireAuth, requireRoles('official'), workbookUpload, asyncRoute(async (request, response) => {
  const rows = await getUploadRows(request, response, 'Results');
  if (!rows) return;
  const normalizedRows: Array<z.infer<typeof resultSchema>> = [];
  for (const [index, row] of rows.entries()) {
    let scorecard: unknown;
    try {
      scorecard = JSON.parse(row.scorecardJson);
    } catch {
      response.status(400).json({ error: `Invalid Results row ${index + 2}: scorecardJson must contain valid JSON.` });
      return;
    }
    const parsed = resultSchema.safeParse({
      applicationNumber: row.applicationNumber,
      rollNumber: row.rollNumber,
      examCode: row.examCode,
      dateOfBirth: row.dateOfBirth,
      scorecard,
    });
    if (!parsed.success) {
      response.status(400).json({ error: `Invalid Results row ${index + 2}: ${parsed.error.issues[0]?.message}` });
      return;
    }
    if (
      parsed.data.scorecard.rollNumber.toUpperCase() !== parsed.data.rollNumber.toUpperCase()
      || parsed.data.scorecard.applicationNumber.toUpperCase() !== parsed.data.applicationNumber.toUpperCase()
      || parsed.data.scorecard.examCode.toUpperCase() !== parsed.data.examCode.toUpperCase()
      || parsed.data.scorecard.dob !== parsed.data.dateOfBirth
    ) {
      response.status(400).json({ error: `Results row ${index + 2} has mismatched scorecard identity fields.` });
      return;
    }
    normalizedRows.push(parsed.data);
  }
  const resultKeys = normalizedRows.map((result) => `${result.examCode.toUpperCase()}:${result.rollNumber.toUpperCase()}`);
  if (new Set(resultKeys).size !== resultKeys.length) {
    response.status(400).json({ error: 'The Results worksheet contains duplicate exam/roll-number rows.' });
    return;
  }
  const superAdmin = getUser(request)?.isSuperAdmin === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const result of normalizedRows) {
      const application = await client.query(
        `SELECT a.id, c.roll_number AS assigned_roll_number
         FROM applications a
         LEFT JOIN admit_cards c ON c.application_id = a.id
         WHERE a.application_number = $1 AND a.date_of_birth = $2 AND a.exam_code = $3`,
        [result.applicationNumber.toUpperCase(), result.dateOfBirth, result.examCode.toUpperCase()],
      );
      if (!application.rows[0]) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: `No application matches ${result.applicationNumber} (${result.examCode}); no results were imported.` });
        return;
      }
      if (
        application.rows[0].assigned_roll_number
        && String(application.rows[0].assigned_roll_number).toUpperCase() !== result.rollNumber.toUpperCase()
      ) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: `Roll number for ${result.applicationNumber} does not match its assigned admit card; no results were imported.` });
        return;
      }
      // P0-3 (A-04, A-16, P3-D11): conditional upsert plus row-count check. For an ordinary
      // Official the conflict branch only fires on a draft row; PostgreSQL evaluates that
      // condition on the locked, latest row version, so a row published concurrently is never
      // overwritten. Any miss rolls back the whole import.
      const { rowCount } = await client.query(
        superAdmin ? RESULT_UPSERT_SQL.draft : RESULT_UPSERT_SQL.draftOnlyOverDrafts,
        [randomUUID(), result.applicationNumber.toUpperCase(), result.rollNumber.toUpperCase(),
          result.examCode.toUpperCase(), result.dateOfBirth, result.scorecard],
      );
      if (rowCount !== 1) {
        if (superAdmin) throw new Error('Result import did not write exactly one row.');
        await client.query('ROLLBACK');
        sendPublishedContentForbidden(response, 'result');
        return;
      }
    }
    await recordAuditEvent(client, {
      action: 'results.imported', actor: auditActor(request),
      metadata: { row_count: normalizedRows.length, exam_codes: [...new Set(normalizedRows.map((row) => row.examCode.toUpperCase()))].sort() },
    });
    await client.query('COMMIT');
    response.status(201).json({ imported: normalizedRows.length, published: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// P0-3 (A-05): publishing and unpublishing answer keys is Super Admin-only.
app.patch('/api/admin/answer-keys/:examCode', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const examCode = request.params.examCode.toUpperCase();
  const rowCount = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
      'UPDATE answer_key_questions SET is_published = $2 WHERE exam_code = $1',
      [examCode, parsed.data.isPublished],
    );
    if (updated.rowCount) {
      await recordAuditEvent(client, {
        action: 'answer_key.publication_changed', actor: auditActor(request), resourceId: examCode,
        metadata: { is_published: parsed.data.isPublished, question_count: updated.rowCount },
      });
    }
    return updated.rowCount;
  });
  if (!rowCount) {
    response.status(404).json({ error: 'No answer key questions found for this exam.' });
    return;
  }
  response.json({ examCode: request.params.examCode.toUpperCase(), updated: rowCount, isPublished: parsed.data.isPublished });
}));

// P0-3 (A-05): publishing and unpublishing online exam papers is Super Admin-only.
app.patch('/api/admin/online-exams/:examCode', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const examCode = request.params.examCode.toUpperCase();
  const rowCount = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
      'UPDATE online_exam_questions SET is_published = $2 WHERE exam_code = $1',
      [examCode, parsed.data.isPublished],
    );
    if (updated.rowCount) {
      await recordAuditEvent(client, {
        action: 'online_exam.publication_changed', actor: auditActor(request), resourceId: examCode,
        metadata: { is_published: parsed.data.isPublished, question_count: updated.rowCount },
      });
    }
    return updated.rowCount;
  });
  if (!rowCount) {
    response.status(404).json({ error: 'No online exam questions found for this exam.' });
    return;
  }
  response.json({ examCode: request.params.examCode.toUpperCase(), updated: rowCount, isPublished: parsed.data.isPublished });
}));

app.get('/api/answer-keys/exams', requireAuth, requireRoles('candidate'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    'SELECT DISTINCT exam_code FROM answer_key_questions WHERE is_published = true ORDER BY exam_code',
  );
  response.json({ examCodes: rows.map((row) => row.exam_code) });
}));

app.get('/api/answer-keys', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const parsed = z.string().trim().min(2).max(30).safeParse(request.query.examCode);
  if (!parsed.success) {
    sendValidationError(response, new z.ZodError([{ code: 'custom', path: ['examCode'], message: 'A valid examCode query is required.' }]));
    return;
  }
  const { rows } = await pool.query(
    `SELECT question_number, subject, question_text, options, official_key, explanation
     FROM answer_key_questions WHERE exam_code = $1 AND is_published = true ORDER BY question_number`,
    [parsed.data.toUpperCase()],
  );
  response.json({ questions: rows });
}));

app.get('/api/admin/answer-keys', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT exam_code, count(*)::int AS question_count, bool_and(is_published) AS is_published,
            max(created_at) AS updated_at
     FROM answer_key_questions GROUP BY exam_code ORDER BY exam_code`,
  );
  response.json({ exams: rows });
}));

app.get('/api/admin/online-exams', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT exam_code, max(exam_name) AS exam_name, max(duration_minutes)::int AS duration_minutes,
            count(*)::int AS question_count, bool_and(is_published) AS is_published
     FROM online_exam_questions GROUP BY exam_code ORDER BY exam_code`,
  );
  response.json({ exams: rows });
}));

app.get('/api/online-exams', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const { rows } = await pool.query(
    `SELECT q.exam_code, max(q.exam_name) AS exam_name, max(q.duration_minutes)::int AS duration_minutes,
            count(*)::int AS question_count
     FROM online_exam_questions q
     JOIN applications a ON a.exam_code = q.exam_code AND a.user_id = $1 AND a.status = 'approved'
     WHERE q.is_published = true
     GROUP BY q.exam_code ORDER BY q.exam_code`,
    [user?.id],
  );
  // Same five attempt columns as before, plus a database-clock `state`
  // (see OnlineExamAttemptState in onlineExamRecovery.ts).
  const attempts = await pool.query(
    ONLINE_EXAM_RECOVERY_SQL.attemptStates,
    attemptStateParams(user?.id, getOnlineExamDisplayConfig()),
  );
  response.json({
    exams: rows.map((exam) => ({
      ...exam,
      attempt: attempts.rows.find((attempt) => attempt.exam_code === exam.exam_code) ?? null,
    })),
  });
}));

app.post('/api/online-exams/:examCode/start', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const examCode = z.string().trim().min(2).max(30).safeParse(request.params.examCode);
  if (!examCode.success) {
    sendValidationError(response, examCode.error);
    return;
  }
  const user = getUser(request);
  const application = await pool.query(
    `SELECT 1 FROM applications
     WHERE user_id = $1 AND exam_code = $2 AND status = 'approved'`,
    [user?.id, examCode.data.toUpperCase()],
  );
  if (!application.rows[0]) {
    response.status(403).json({ error: 'An approved application is required to start this online exam.' });
    return;
  }
  const questions = await pool.query(
    `SELECT question_number, section, question_text, options, points, max(duration_minutes)::int AS duration_minutes
     FROM online_exam_questions
     WHERE exam_code = $1 AND is_published = true
     GROUP BY question_number, section, question_text, options, points
     ORDER BY question_number`,
    [examCode.data.toUpperCase()],
  );
  if (!questions.rows.length) {
    response.status(404).json({ error: 'This online exam is not currently published.' });
    return;
  }
  const existingAttempt = await pool.query(
    `SELECT id, started_at, expires_at, submitted_at, responses
     FROM online_exam_attempts WHERE user_id = $1 AND exam_code = $2`,
    [user?.id, examCode.data.toUpperCase()],
  );
  if (existingAttempt.rows[0]) {
    const active = existingAttempt.rows[0];
    if (active.submitted_at || new Date(active.expires_at).getTime() <= Date.now()) {
      response.status(409).json({ error: 'An attempt has already been completed or expired for this exam.' });
      return;
    }
    response.json({
      attempt: active,
      responses: active.responses ?? {},
      questions: questions.rows.map(({ question_number, section, question_text, options, points }) => ({
        questionNumber: question_number,
        section,
        questionText: question_text,
        options,
        points,
      })),
    });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO online_exam_attempts (id, user_id, exam_code, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 minute'))
     ON CONFLICT (user_id, exam_code) DO NOTHING
     RETURNING id, started_at, expires_at`,
    [randomUUID(), user?.id, examCode.data.toUpperCase(), questions.rows[0].duration_minutes],
  );
  if (!rows[0]) {
    const concurrentAttempt = await pool.query(
      `SELECT id, started_at, expires_at, submitted_at, responses
       FROM online_exam_attempts WHERE user_id = $1 AND exam_code = $2`,
      [user?.id, examCode.data.toUpperCase()],
    );
    const active = concurrentAttempt.rows[0];
    if (!active || active.submitted_at || new Date(active.expires_at).getTime() <= Date.now()) {
      response.status(409).json({ error: 'An attempt has already been started or submitted for this exam.' });
      return;
    }
    response.json({
      attempt: active,
      responses: active.responses ?? {},
      questions: questions.rows.map(({ question_number, section, question_text, options, points }) => ({
        questionNumber: question_number,
        section,
        questionText: question_text,
        options,
        points,
      })),
    });
    return;
  }
  response.status(201).json({
    attempt: rows[0],
    responses: {},
    questions: questions.rows.map(({ question_number, section, question_text, options, points }) => ({
      questionNumber: question_number,
      section,
      questionText: question_text,
      options,
      points,
    })),
  });
}));

// ---------------------------------------------------------------------------
// Online exam autosave and submit (P0-4). Both delegate to onlineExamFinalization.ts,
// which locks the attempt row, reads the database clock after the lock, and decides
// and writes inside one transaction.
//
// Shared rules for both routes:
// - Authentication and the candidate role are required (401 / 403 from the middleware).
// - The body is validated with Zod before any database access (400). Only `attemptId`
//   and `responses` are read from it; unknown fields are dropped.
// - The candidate is always the signed-in session user, never a value from the body.
// - The exam code comes from the URL, upper-cased as before.
// - An intentionally empty `{}` is a valid answer set: it is saved (autosave) or scored
//   as no answers (submit), and it REPLACES any previously saved answers.
// - A non-empty answer set in which every entry is unknown to this exam is refused
//   with 400 `invalid_responses`, and the saved answers are left unchanged.
// - Failures never claim success. Errors are logged as safe structured lines without
//   answers, scores, user identifiers, session tokens or database error details.
// ---------------------------------------------------------------------------

const onlineExamResponsesBodySchema = z.object({
  attemptId: z.string().uuid(),
  responses: z.record(z.string(), z.enum(['A', 'B', 'C', 'D'])),
});

// Settings are read once, on first use by these routes. Failing fast at process
// startup is wired separately (P0-4 Phase 5).
let onlineExamConfig: OnlineExamConfig | undefined;
function getOnlineExamConfig(): OnlineExamConfig {
  onlineExamConfig ??= readOnlineExamConfig();
  return onlineExamConfig;
}

// For the attempt list only: if a setting is invalid, show states as if automatic recovery
// were off (the recovery scheduler is also off then) instead of failing the dashboard.
const ONLINE_EXAM_DISPLAY_FALLBACK_CONFIG = readOnlineExamConfig({});
function getOnlineExamDisplayConfig(): OnlineExamConfig {
  try {
    return getOnlineExamConfig();
  } catch {
    return ONLINE_EXAM_DISPLAY_FALLBACK_CONFIG;
  }
}

type OnlineExamOperation = 'submit' | 'autosave';

/** pg-pool raises exactly this message when no connection frees up within connectionTimeoutMillis. */
function isPoolConnectTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout exceeded when trying to connect';
}

function sendOnlineExamBusy(
  response: Response,
  operation: OnlineExamOperation,
  attemptId: string,
  cause: 'lock_timeout' | 'pool_timeout',
): void {
  console.warn(JSON.stringify({ event: 'online_exam.busy', operation, attemptId, cause }));
  response.set('Retry-After', '1');
  response.status(503).json({
    error: 'The exam service is busy. Your request was not applied. Please try again in a moment.',
    code: 'busy',
    retryable: true,
  });
}

/** 500 with a generic message. Logs only the error class, invariant reason and SQLSTATE. */
function sendOnlineExamFailure(
  response: Response,
  operation: OnlineExamOperation,
  attemptId: string,
  error: unknown,
): void {
  const sqlState = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  console.error(JSON.stringify({
    event: 'online_exam.request_failed',
    operation,
    attemptId,
    errorClass: error instanceof Error ? error.name : typeof error,
    invariant: error instanceof OnlineExamInvariantError ? error.reason : undefined,
    sqlState: typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : undefined,
  }));
  response.status(500).json({ error: 'An unexpected server error occurred.' });
}

function handleOnlineExamError(
  response: Response,
  operation: OnlineExamOperation,
  attemptId: string,
  error: unknown,
): void {
  if (isPoolConnectTimeout(error)) {
    sendOnlineExamBusy(response, operation, attemptId, 'pool_timeout');
    return;
  }
  sendOnlineExamFailure(response, operation, attemptId, error);
}

function sendInvalidResponses(response: Response, reason: 'malformed' | 'no_valid_answers'): void {
  response.status(400).json({
    error: reason === 'no_valid_answers'
      ? 'None of the submitted answers belong to this exam. Your saved answers were not changed.'
      : 'Invalid request.',
    code: 'invalid_responses',
    reason,
  });
}

const ATTEMPT_NOT_FOUND = { error: 'This exam attempt was not found.', code: 'attempt_not_found' } as const;

// Autosave. HTTP mapping of SaveResponsesOutcome:
//   200 saved              { saved: true, savedAt }   savedAt = database decision time
//   400 Zod failure        { error, details }          (unchanged validation response)
//   400 invalid_responses  { error, code, reason }     nothing written
//   404 missing            { error, code }             no attempt with this id for this candidate and exam
//   409 finalized          { error, code }             already submitted; never overwritten
//   409 answering_closed   { error, code }             at or after expires_at; nothing written
//   503 busy / pool full   { error, code, retryable }  Retry-After: 1; nothing written
//   500 anything else      { error }                   generic message; safe log only
app.patch('/api/online-exams/:examCode/attempt', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const parsed = onlineExamResponsesBodySchema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  if (!user) {
    response.status(401).json({ error: 'Sign in is required.' });
    return;
  }
  const examCode = request.params.examCode.toUpperCase();
  const config = getOnlineExamConfig();
  let outcome: SaveResponsesOutcome;
  try {
    outcome = await saveAttemptResponses(pool, {
      attemptId: parsed.data.attemptId,
      userId: user.id,
      examCode,
      responses: parsed.data.responses,
      config,
    });
  } catch (error) {
    handleOnlineExamError(response, 'autosave', parsed.data.attemptId, error);
    return;
  }
  switch (outcome.kind) {
    case 'saved':
      response.json({ saved: true, savedAt: outcome.savedAt });
      return;
    case 'invalid_responses':
      sendInvalidResponses(response, outcome.reason);
      return;
    case 'missing':
      response.status(404).json(ATTEMPT_NOT_FOUND);
      return;
    case 'finalized':
      response.status(409).json({ error: 'This exam has already been submitted. Answers can no longer be changed.', code: 'finalized' });
      return;
    case 'answering_closed':
      response.status(409).json({ error: 'Time is up for this exam. Answers can no longer be changed.', code: 'answering_closed' });
      return;
    case 'busy':
      sendOnlineExamBusy(response, 'autosave', parsed.data.attemptId, 'lock_timeout');
      return;
    default: {
      const unexpected: never = outcome;
      sendOnlineExamFailure(response, 'autosave', parsed.data.attemptId, new Error(`Unexpected outcome ${String(unexpected)}`));
    }
  }
}));

// Submit. HTTP mapping of FinalizeOutcome (candidate mode):
//   200 scored             { submittedAt, score, alreadyScored: false }  committed; score includes `completion`
//   200 already_scored     { submittedAt, score, alreadyScored: true }   stored score returned unchanged (idempotent)
//   400 Zod failure        { error, details }                            (unchanged validation response)
//   400 invalid_responses  { error, code, reason }                       nothing written; saved answers unchanged
//   404 missing            { error, code }                               no attempt with this id for this candidate and exam
//   409 expired_unscored   { error, code }                               past expiry + grace and not eligible for automatic scoring
//   503 busy / pool full   { error, code, retryable }                    Retry-After: 1; nothing written
//   500 invariant, unexpected outcome or error  { error }                generic message; safe log only
// `submittedAt` and `score` keep their existing names and meaning; `alreadyScored` is new.
// A 200 is sent only after finalizeAttempt has committed (or found an already-committed score).
app.post('/api/online-exams/:examCode/submit', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const parsed = onlineExamResponsesBodySchema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  if (!user) {
    response.status(401).json({ error: 'Sign in is required.' });
    return;
  }
  const examCode = request.params.examCode.toUpperCase();
  const config = getOnlineExamConfig();
  let outcome: FinalizeOutcome;
  try {
    outcome = await finalizeAttempt(pool, {
      mode: 'candidate',
      attemptId: parsed.data.attemptId,
      userId: user.id,
      examCode,
      submittedResponses: parsed.data.responses,
      config,
    });
  } catch (error) {
    handleOnlineExamError(response, 'submit', parsed.data.attemptId, error);
    return;
  }
  switch (outcome.kind) {
    case 'scored':
      response.json({ submittedAt: outcome.submittedAt, score: outcome.score, alreadyScored: false });
      return;
    case 'already_scored':
      response.json({ submittedAt: outcome.submittedAt, score: outcome.score, alreadyScored: true });
      return;
    case 'invalid_responses':
      sendInvalidResponses(response, outcome.reason);
      return;
    case 'missing':
      response.status(404).json(ATTEMPT_NOT_FOUND);
      return;
    case 'expired_unscored':
      response.status(409).json({
        error: 'This exam attempt has expired and was not scored automatically. Please contact the exam office.',
        code: 'expired_unscored',
      });
      return;
    case 'busy':
      sendOnlineExamBusy(response, 'submit', parsed.data.attemptId, 'lock_timeout');
      return;
    case 'not_eligible':
    case 'skipped':
      // Recovery-only outcomes; candidate mode never produces them.
      sendOnlineExamFailure(response, 'submit', parsed.data.attemptId, new Error(`Unexpected outcome ${outcome.kind}`));
      return;
    default: {
      const unexpected: never = outcome;
      sendOnlineExamFailure(response, 'submit', parsed.data.attemptId, new Error(`Unexpected outcome ${String(unexpected)}`));
    }
  }
}));


// Internal probe only (loopback peer, accepted by surfaceGate.identify). 503 until both listeners
// are ready (D9); then the existing database check.
app.get('/api/health', asyncRoute(async (request, response) => {
  if (!surfaceGate.isInternalProbe(request)) {
    response.status(404).json({ error: 'Route not found.' });
    return;
  }
  if (!surfaceGate.isReady()) {
    response.status(503).json({ status: 'starting' });
    return;
  }
  await pool.query('SELECT 1');
  response.json({ status: 'ok', database: 'connected' });
}));

// Routing metadata for the SPA, used to move a role flow to the surface that owns its session cookie.
// Public surfaces (Marketing, Exam, Institution) answer with the public hostnames only: the private
// Admin hostname is never disclosed to the public site. The Admin surface answers with all four.
app.get('/api/surface-hostnames', (request, response) => {
  const config = surfaceGate.getConfig();
  const surface = getTrustedRequestSurface(request);
  if (!config || !surface) {
    response.status(503).json({ error: 'Surface configuration is unavailable.' });
    return;
  }
  response.set('Cache-Control', 'private, max-age=300');
  response.json({ hostnames: disclosedSurfaceHostnames(surface, config.hostnames) });
});

app.get('/api/exams', asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, code, name, category, target_audience, registration_start, registration_end,
            exam_date, time_zone, fee, duration, mode, shifts, is_published
     FROM exams WHERE is_published = true
     ORDER BY exam_date ASC LIMIT 100`,
  );
  response.json({ exams: rows.map(toExam) });
}));

app.get('/api/admin/exams', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, code, name, category, target_audience, registration_start, registration_end,
            exam_date, time_zone, fee, duration, mode, shifts, is_published, created_at, updated_at
     FROM exams ORDER BY created_at DESC LIMIT 500`,
  );
  response.json({ exams: rows.map((row) => ({ ...toExam(row), createdAt: row.created_at, updatedAt: row.updated_at })) });
}));

app.get('/api/admin/institutes', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, login_id, display_name, contact_email, registration_number,
            registered_address, website, account_status, created_at
     FROM users WHERE role = 'center'
     ORDER BY CASE account_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
              created_at DESC LIMIT 500`,
  );
  response.json({ institutes: rows });
}));

app.patch('/api/admin/institutes/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    status: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(10).max(1000),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const reviewer = getUser(request);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: currentRows } = await client.query(
      `SELECT id, account_status FROM users
       WHERE id = $1 AND role = 'center' FOR UPDATE`,
      [request.params.id],
    );
    const current = currentRows[0];
    if (!current || current.account_status !== 'pending') {
      await client.query('ROLLBACK');
      response.status(404).json({ error: 'Pending institute request not found.' });
      return;
    }

    const { rows } = await client.query(
      `UPDATE users SET account_status = $2
       WHERE id = $1 AND role = 'center' AND account_status = 'pending'
       RETURNING id, login_id, display_name, contact_email, registration_number,
                 registered_address, website, account_status, created_at`,
      [request.params.id, parsed.data.status],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      response.status(404).json({ error: 'Pending institute request not found.' });
      return;
    }
    await client.query(
      `INSERT INTO institute_status_history
       (id, institution_id, previous_status, new_status, reviewer_user_id, decision_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), current.id, current.account_status, parsed.data.status, reviewer?.id, parsed.data.reason],
    );
    await recordAuditEvent(client, {
      action: 'institution.status_changed', actor: auditActor(request), organizationId: String(current.id), resourceId: String(current.id),
      metadata: { previous_status: String(current.account_status), new_status: parsed.data.status, reason_text: parsed.data.reason },
    });
    const { rows: submissionSchemaRows } = await client.query(
      `SELECT to_regclass('institution_submission_capabilities') AS capabilities_table,
              to_regclass('institution_submission_cycles') AS cycles_table`,
    );
    const hasCapabilities = Boolean(submissionSchemaRows[0]?.capabilities_table);
    const hasCycles = Boolean(submissionSchemaRows[0]?.cycles_table);
    if (hasCapabilities !== hasCycles) {
      throw new Error('Institution submission schema is only partially installed.');
    }
    if (hasCapabilities && hasCycles) {
      await client.query(
        `UPDATE institution_submission_capabilities
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE institution_id = $1 AND revoked_at IS NULL`,
        [current.id],
      );
      await client.query(
        `UPDATE institution_submission_cycles
         SET status = 'closed', closed_at = COALESCE(closed_at, now())
         WHERE institution_id = $1 AND status = 'open'`,
        [current.id],
      );
    }
    await client.query('COMMIT');
    response.json({ institute: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// Public institute forms (A-1/U2, U6): approved forms of approved institutions whose deadline has
// not passed (inclusive, India date) or that have no deadline. No account contact data.
export const PUBLIC_INSTITUTE_FORMS_SQL = `SELECT f.id, f.form_type, f.title, f.description, f.eligibility,
            f.application_deadline, f.external_url, f.created_at,
            u.display_name AS institute_name
     FROM institute_forms f
     JOIN users u ON u.id = f.institute_id
     WHERE f.status = 'approved' AND u.account_status = 'approved'
       AND (f.application_deadline IS NULL
            OR f.application_deadline >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
     ORDER BY f.created_at DESC LIMIT 200`;

/** Explicit allow-list for the public forms response (keys as the existing frontend reads them). */
export const PUBLIC_INSTITUTE_FORM_FIELDS = Object.freeze([
  'id', 'form_type', 'title', 'description', 'eligibility', 'application_deadline', 'external_url', 'created_at', 'institute_name',
] as const);

export function toPublicInstituteForm(row: Record<string, unknown>): Record<(typeof PUBLIC_INSTITUTE_FORM_FIELDS)[number], unknown> {
  return Object.fromEntries(PUBLIC_INSTITUTE_FORM_FIELDS.map((field) => [field, row[field] ?? null])) as Record<(typeof PUBLIC_INSTITUTE_FORM_FIELDS)[number], unknown>;
}

app.get('/api/institute-forms', asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(PUBLIC_INSTITUTE_FORMS_SQL);
  response.json({ forms: rows.map(toPublicInstituteForm) });
}));

app.get('/api/center/workspace', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const [profile, forms, profileChanges, entries, withdrawals, balance] = await Promise.all(
    centerWorkspaceQueries(user!.id).map(({ text, values }) => pool.query(text, values)),
  );
  const wallet = balance.rows[0];
  response.json({
    profile: profile.rows[0],
    forms: forms.rows,
    profileChanges: profileChanges.rows,
    entries: entries.rows,
    withdrawals: withdrawals.rows,
    balancePaise: wallet.balance_paise,
    availablePaise: (BigInt(wallet.balance_paise) - BigInt(wallet.reserved_paise)).toString(),
    dashboardSummary: {
      totalCheckins: wallet.total_checkins,
      checkinStatuses: {
        verified: wallet.verified_checkins,
        admitted: wallet.admitted_checkins,
        flagged: wallet.flagged_checkins,
        rejected: wallet.rejected_checkins,
      },
      approvedForms: wallet.approved_forms,
      pendingForms: wallet.pending_forms,
      monthlyCheckins: wallet.monthly_checkins,
    },
  });
}));

app.post('/api/center/forms', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    formType: z.enum(['exam_application', 'teacher_recruitment']),
    title: z.string().trim().min(5).max(160),
    description: z.string().trim().min(10).max(3000),
    eligibility: z.string().trim().min(3).max(1000),
    applicationDeadline: z.union([z.string().date(), z.literal('')]).optional(),
    externalUrl: z.union([
      z.string().trim().url().max(500).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
      z.literal(''),
    ]).optional(),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const rows = await inAuditedTransaction(async (client) => {
    const inserted = await client.query(
    `INSERT INTO institute_forms
     (id, institute_id, form_type, title, description, eligibility, application_deadline, external_url)
     VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::date, NULLIF($8, ''))
     RETURNING id, form_type, title, description, eligibility, application_deadline,
               external_url, status, created_at`,
    [randomUUID(), user?.id, parsed.data.formType, parsed.data.title, parsed.data.description,
      parsed.data.eligibility, parsed.data.applicationDeadline || '', parsed.data.externalUrl || ''],
    );
    await recordAuditEvent(client, {
      action: 'institution.form_submitted', actor: auditActor(request), organizationId: user?.id ?? null,
      resourceId: String(inserted.rows[0].id), metadata: { form_type: parsed.data.formType },
    });
    return inserted.rows;
  });
  response.status(201).json({ form: rows[0] });
}));

app.post('/api/center/profile-changes', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    displayName: z.string().trim().min(2).max(150),
    contactEmail: z.string().trim().email().max(254),
    registrationNumber: z.string().trim().min(3).max(100),
    registeredAddress: z.string().trim().min(10).max(500),
    website: z.union([
      z.string().trim().url().max(200).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
      z.literal(''),
    ]).optional(),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  try {
    const rows = await inAuditedTransaction(async (client) => {
      const inserted = await client.query(
      `INSERT INTO institute_profile_changes
       (id, institute_id, display_name, contact_email, registration_number, registered_address, website)
       VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''))
       RETURNING id, display_name, contact_email, registration_number, registered_address,
                 website, status, created_at`,
      [randomUUID(), user?.id, parsed.data.displayName, parsed.data.contactEmail.toLowerCase(),
        parsed.data.registrationNumber, parsed.data.registeredAddress, parsed.data.website || ''],
      );
      // Field names only: the requested values stay in institute_profile_changes.
      await recordAuditEvent(client, {
        action: 'institution.profile_change_requested', actor: auditActor(request), organizationId: user?.id ?? null,
        resourceId: String(inserted.rows[0].id),
        metadata: { changed_fields: ['display_name', 'contact_email', 'registration_number', 'registered_address', 'website'] },
      });
      return inserted.rows;
    });
    response.status(201).json({ profileChange: rows[0] });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      response.status(409).json({ error: 'You already have a profile change awaiting review.' });
      return;
    }
    throw error;
  }
}));

app.post('/api/center/withdrawals', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    amountPaise: z.number().int().positive().max(1_000_000_000_000),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user?.id]);
    const { rows: balanceRows } = await client.query(
      `SELECT
         COALESCE((SELECT SUM(CASE WHEN entry_type = 'credit' THEN amount_paise ELSE -amount_paise END)
                   FROM institute_wallet_entries WHERE institute_id = $1), 0)::text AS balance_paise,
         COALESCE((SELECT SUM(amount_paise) FROM institute_withdrawals
                   WHERE institute_id = $1 AND status IN ('pending', 'approved')), 0)::text AS reserved_paise`,
      [user?.id],
    );
    const available = BigInt(balanceRows[0].balance_paise) - BigInt(balanceRows[0].reserved_paise);
    if (BigInt(parsed.data.amountPaise) > available) {
      await client.query('ROLLBACK');
      response.status(400).json({ error: 'Withdrawal amount exceeds the available wallet balance.' });
      return;
    }
    const { rows } = await client.query(
      `INSERT INTO institute_withdrawals (id, institute_id, amount_paise)
       VALUES ($1, $2, $3)
       RETURNING id, amount_paise, status, transfer_reference, created_at`,
      [randomUUID(), user?.id, parsed.data.amountPaise],
    );
    await recordAuditEvent(client, {
      action: 'withdrawal.requested', actor: auditActor(request), organizationId: user?.id ?? null,
      resourceId: String(rows[0].id), metadata: { amount_paise: parsed.data.amountPaise },
    });
    await client.query('COMMIT');
    response.status(201).json({ withdrawal: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/admin/institute-management', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const [forms, profileChanges, withdrawals, walletBalances] = await Promise.all([
    pool.query(
      `SELECT f.id, f.institute_id, f.form_type, f.title, f.description, f.eligibility,
              f.application_deadline, f.external_url, f.status, f.created_at,
              u.display_name AS institute_name, u.login_id
       FROM institute_forms f JOIN users u ON u.id = f.institute_id
       ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END, f.created_at DESC LIMIT 500`,
    ),
    pool.query(
      `SELECT p.id, p.institute_id, p.display_name, p.contact_email, p.registration_number,
              p.registered_address, p.website, p.status, p.created_at,
              u.display_name AS current_name, u.login_id
       FROM institute_profile_changes p JOIN users u ON u.id = p.institute_id
       ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC LIMIT 500`,
    ),
    // P0-3 (A-03): two booleans for the maker-checker UI. The approver's identity is not exposed.
    pool.query(
      `SELECT w.id, w.institute_id, w.amount_paise, w.status, w.transfer_reference, w.created_at,
              u.display_name AS institute_name, u.login_id,
              (w.reviewed_by IS NOT NULL) AS approver_recorded,
              COALESCE(w.reviewed_by = $1, false) AS reviewed_by_current_user
       FROM institute_withdrawals w JOIN users u ON u.id = w.institute_id
       ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, w.created_at DESC LIMIT 500`,
      [getUser(request)?.id ?? null],
    ),
    pool.query(
      `SELECT u.id AS institute_id, u.display_name AS institute_name, u.login_id,
              COALESCE(SUM(CASE WHEN e.entry_type = 'credit' THEN e.amount_paise ELSE -e.amount_paise END), 0)::text AS balance_paise
       FROM users u LEFT JOIN institute_wallet_entries e ON e.institute_id = u.id
       WHERE u.role = 'center' GROUP BY u.id ORDER BY u.display_name LIMIT 500`,
    ),
  ]);
  response.json({
    forms: forms.rows,
    profileChanges: profileChanges.rows,
    withdrawals: withdrawals.rows,
    walletBalances: walletBalances.rows,
  });
}));

app.patch('/api/admin/institute-forms/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ status: z.enum(['approved', 'rejected']) }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const rows = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE institute_forms SET status = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING id, status, institute_id`,
      [request.params.id, parsed.data.status, user?.id],
    );
    if (updated.rows[0]) {
      await recordAuditEvent(client, {
        action: 'institution.form_decided', actor: auditActor(request), organizationId: String(updated.rows[0].institute_id),
        resourceId: String(updated.rows[0].id), metadata: { decision: parsed.data.status },
      });
    }
    return updated.rows.map((row: Record<string, unknown>) => ({ id: row.id, status: row.status }));
  });
  if (!rows[0]) {
    response.status(404).json({ error: 'Pending institute form not found.' });
    return;
  }
  response.json({ form: rows[0] });
}));

app.patch('/api/admin/institute-profile-changes/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ status: z.enum(['approved', 'rejected']) }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM institute_profile_changes WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [request.params.id],
    );
    const change = rows[0];
    if (!change) {
      await client.query('ROLLBACK');
      response.status(404).json({ error: 'Pending institute profile change not found.' });
      return;
    }
    if (parsed.data.status === 'approved') {
      await client.query(
        `UPDATE users SET display_name = $2, contact_email = $3, registration_number = $4,
                          registered_address = $5, website = $6
         WHERE id = $1 AND role = 'center'`,
        [change.institute_id, change.display_name, change.contact_email, change.registration_number,
          change.registered_address, change.website],
      );
    }
    await client.query(
      `UPDATE institute_profile_changes SET status = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1`,
      [change.id, parsed.data.status, user?.id],
    );
    await recordAuditEvent(client, {
      action: 'institution.profile_change_decided', actor: auditActor(request), organizationId: String(change.institute_id),
      resourceId: String(change.id),
      metadata: { decision: parsed.data.status, changed_fields: ['display_name', 'contact_email', 'registration_number', 'registered_address', 'website'] },
    });
    await client.query('COMMIT');
    response.json({ profileChange: { id: change.id, status: parsed.data.status } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// P0-3 (A-02): wallet credits are Super Admin-only.
/** Read-only: whether a payment reference is already in the ledger (explains a refused credit). */
export const CREDIT_REFERENCE_EXISTS_SQL = 'SELECT EXISTS (SELECT 1 FROM institute_wallet_entries WHERE payment_reference = $1) AS exists';

app.post('/api/admin/institutes/:id/credits', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({
    amountPaise: z.number().int().positive().max(1_000_000_000_000),
    description: z.string().trim().min(3).max(300),
    paymentReference: z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9._/-]+$/),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  let failureReason: 'duplicate_payment_reference' | 'institute_not_eligible' | null = null;
  const rows = await inAuditedTransaction(async (client) => {
    const inserted = await client.query(
    `INSERT INTO institute_wallet_entries
     (id, institute_id, entry_type, amount_paise, description, payment_reference, created_by)
     SELECT $1, id, 'credit', $3, $4, $5, $6 FROM users
     WHERE id = $2 AND role = 'center' AND account_status = 'approved'
     ON CONFLICT (payment_reference) DO NOTHING
     RETURNING id, institute_id, amount_paise, description, payment_reference, created_at`,
    [randomUUID(), request.params.id, parsed.data.amountPaise, parsed.data.description,
      parsed.data.paymentReference, user?.id],
    );
    const entry = inserted.rows[0];
    if (entry) {
      await recordAuditEvent(client, {
        action: 'wallet.credited', actor: auditActor(request), organizationId: String(entry.institute_id), resourceId: String(entry.id),
        metadata: { amount_paise: parsed.data.amountPaise, payment_reference: parsed.data.paymentReference },
      });
    }
    else {
      // Nothing was written: find out why, for the audit record only (the answer stays the same).
      const duplicate = await client.query(CREDIT_REFERENCE_EXISTS_SQL, [parsed.data.paymentReference]);
      failureReason = duplicate.rows[0]?.exists === true ? 'duplicate_payment_reference' : 'institute_not_eligible';
    }
    return inserted.rows;
  });
  if (!rows[0]) {
    // Proposal §7: wallet.credit_failed, recorded after the transaction; never changes the answer.
    await recordRefusedAuditEvent(pool, {
      action: 'wallet.credit_failed', outcome: 'failed', reasonCode: failureReason ?? 'institute_not_eligible', actor: auditActor(request),
      organizationId: request.params.id, metadata: { amount_paise: parsed.data.amountPaise, payment_reference: parsed.data.paymentReference },
    });
    response.status(409).json({ error: 'Institute was not found or this payment reference has already been credited.' });
    return;
  }
  response.status(201).json({ entry: rows[0] });
}));

// P0-3 (A-03, P3-D2, P3-D3): withdrawals are Super Admin-only, with maker-checker on payment.
// All checks run inside one transaction while the withdrawal row is locked:
// - the approver (reviewed_by while the row is `approved`, legacy rows included) can't pay it;
// - an approved row with no recorded approver (NULL) can't be paid;
// - payment needs at least two active Super Admins (role official, is_super_admin,
//   account_status approved: the same rule requireAuth applies);
// - paying keeps the original reviewed_by and reviewed_at; the payer is recorded as created_by
//   on the debit entry written in the same transaction;
// - any Super Admin, the approver included, may still reject before payment.
// The row lock plus the status-guarded UPDATE prevent double payment; the unique withdrawal_id and
// transfer_reference on wallet entries are a second guard.
export const WITHDRAWAL_SQL = Object.freeze({
  lock: `SELECT w.* FROM institute_withdrawals w
       JOIN users u ON u.id = w.institute_id
       WHERE w.id = $1 AND u.role = 'center'
       FOR UPDATE OF u, w`,
  activeSuperAdmins: `SELECT count(*)::int AS active_super_admins FROM users
       WHERE role = 'official' AND is_super_admin = true AND account_status = 'approved'`,
  insertDebit: `INSERT INTO institute_wallet_entries
         (id, institute_id, entry_type, amount_paise, description, transfer_reference, withdrawal_id, created_by)
         VALUES ($1, $2, 'debit', $3, $4, $5, $6, $7)`,
  // Payment: reviewed_by and reviewed_at are deliberately not assigned (approver preserved).
  markPaid: `UPDATE institute_withdrawals
       SET status = 'paid', transfer_reference = $2
       WHERE id = $1 AND status = 'approved'
       RETURNING id, status, amount_paise, transfer_reference`,
  // Approve or reject: records the reviewing Super Admin. $4 = the status the row was locked in.
  review: `UPDATE institute_withdrawals
       SET status = $2, transfer_reference = NULL, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 AND status = $4
       RETURNING id, status, amount_paise, transfer_reference`,
});

export const MIN_ACTIVE_SUPER_ADMINS_FOR_PAYMENT = 2;

function sendWithdrawalConflict(response: Response, code: string, error: string): void {
  response.status(409).json({ error, code });
}

/** AL-4.8: a refused withdrawal payment is recorded after its rollback (never blocks the answer). */
async function recordPaymentRefusal(request: Request, withdrawal: Record<string, unknown>, reasonCode: string): Promise<void> {
  await recordRefusedAuditEvent(pool, {
    action: 'withdrawal.payment_refused', outcome: 'denied', reasonCode, actor: auditActor(request),
    organizationId: String(withdrawal.institute_id), resourceId: String(withdrawal.id),
    metadata: {
      amount_paise: Number(withdrawal.amount_paise),
      approver_user_id: withdrawal.reviewed_by === null || withdrawal.reviewed_by === undefined ? undefined : String(withdrawal.reviewed_by),
    },
  });
}

app.patch('/api/admin/institute-withdrawals/:id', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({
    status: z.enum(['approved', 'rejected', 'paid']),
    transferReference: z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  if (parsed.data.status === 'paid' && !parsed.data.transferReference) {
    response.status(400).json({ error: 'Enter the manual bank transfer reference before marking a withdrawal paid.' });
    return;
  }
  const user = getUser(request);
  if (!user) {
    response.status(401).json({ error: 'Sign in is required.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(WITHDRAWAL_SQL.lock, [request.params.id]);
    const withdrawal = rows[0];
    if (!withdrawal || withdrawal.status === 'paid' ||
        (parsed.data.status === 'approved' && withdrawal.status !== 'pending') ||
        (parsed.data.status === 'rejected' && !['pending', 'approved'].includes(withdrawal.status)) ||
        (parsed.data.status === 'paid' && withdrawal.status !== 'approved')) {
      await client.query('ROLLBACK');
      response.status(409).json({ error: 'This withdrawal cannot be moved to the requested status.' });
      return;
    }
    let updated: Record<string, unknown>[];
    if (parsed.data.status === 'paid') {
      if (withdrawal.reviewed_by === null || withdrawal.reviewed_by === undefined) {
        await client.query('ROLLBACK');
        await recordPaymentRefusal(request, withdrawal, 'approver_unknown');
        sendWithdrawalConflict(response, 'approver_unknown',
          'This withdrawal has no recorded approver, so it cannot be paid. Reject it and ask the institute to request it again.');
        return;
      }
      if (withdrawal.reviewed_by === user.id) {
        await client.query('ROLLBACK');
        await recordPaymentRefusal(request, withdrawal, 'maker_checker');
        sendWithdrawalConflict(response, 'maker_checker',
          'You approved this withdrawal, so a different Super Admin must mark it paid.');
        return;
      }
      const { rows: admins } = await client.query(WITHDRAWAL_SQL.activeSuperAdmins);
      if (!(Number(admins[0]?.active_super_admins) >= MIN_ACTIVE_SUPER_ADMINS_FOR_PAYMENT)) {
        await client.query('ROLLBACK');
        await recordPaymentRefusal(request, withdrawal, 'insufficient_super_admins');
        sendWithdrawalConflict(response, 'insufficient_super_admins',
          'Withdrawal payments need at least two active Super Admin accounts.');
        return;
      }
      await client.query(WITHDRAWAL_SQL.insertDebit,
        [randomUUID(), withdrawal.institute_id, withdrawal.amount_paise,
          `Withdrawal ${withdrawal.id}`, parsed.data.transferReference, withdrawal.id, user.id]);
      ({ rows: updated } = await client.query(WITHDRAWAL_SQL.markPaid,
        [withdrawal.id, parsed.data.transferReference]));
    } else {
      ({ rows: updated } = await client.query(WITHDRAWAL_SQL.review,
        [withdrawal.id, parsed.data.status, user.id, withdrawal.status]));
    }
    if (updated.length !== 1) throw new Error('Withdrawal update did not affect exactly one row.');
    await recordAuditEvent(client, parsed.data.status === 'paid'
      ? {
        action: 'withdrawal.paid', actor: auditActor(request), organizationId: String(withdrawal.institute_id), resourceId: String(withdrawal.id),
        metadata: { amount_paise: Number(withdrawal.amount_paise), approver_user_id: String(withdrawal.reviewed_by), transfer_reference: parsed.data.transferReference },
      }
      : {
        action: parsed.data.status === 'approved' ? 'withdrawal.approved' : 'withdrawal.rejected', actor: auditActor(request),
        organizationId: String(withdrawal.institute_id), resourceId: String(withdrawal.id),
        metadata: { amount_paise: Number(withdrawal.amount_paise), previous_status: String(withdrawal.status) },
      });
    await client.query('COMMIT');
    response.json({ withdrawal: updated[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      // Proposal §7: the payment rolled back on a duplicate transfer reference.
      await recordRefusedAuditEvent(pool, {
        action: 'withdrawal.payment_failed', outcome: 'failed', reasonCode: 'duplicate_transfer_reference', actor: auditActor(request),
        resourceId: request.params.id,
      });
      response.status(409).json({ error: 'This transfer reference has already been recorded.' });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

const examSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(3).max(160),
  category: z.enum(['Undergraduate', 'Scholarship', 'Teacher', 'Professional']),
  targetAudience: z.string().trim().min(3).max(200),
  regStart: z.string().date(),
  regEnd: z.string().date(),
  examDate: z.string().date(),
  timeZone: z.string().trim().min(1).max(64).default(DEFAULT_EXAM_TIME_ZONE)
    .refine(isValidTimeZone, 'Use a valid IANA time zone, such as Asia/Kolkata.'),
  fee: z.string().trim().min(1).max(80),
  duration: z.string().trim().min(2).max(80),
  mode: z.string().trim().min(2).max(100),
  shifts: z.string().trim().min(2).max(200),
});

app.post('/api/admin/exams', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = examSchema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const exam = parsed.data;
  if (exam.regEnd < exam.regStart) {
    response.status(400).json({ error: 'Registration closing date must be on or after the opening date.' });
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const inserted = await client.query(
    `INSERT INTO exams
     (id, code, name, category, target_audience, registration_start, registration_end, exam_date,
      time_zone, fee, duration, mode, shifts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, code, name, category, target_audience, registration_start, registration_end,
               exam_date, time_zone, fee, duration, mode, shifts, is_published`,
    [randomUUID(), exam.code.toUpperCase(), exam.name, exam.category, exam.targetAudience,
      exam.regStart, exam.regEnd, exam.examDate, exam.timeZone, exam.fee, exam.duration, exam.mode, exam.shifts],
    );
    await recordAuditEvent(client, {
      action: 'exam.created', actor: auditActor(request), resourceId: String(inserted.rows[0].id),
      metadata: { exam_code: exam.code.toUpperCase(), is_published: Boolean(inserted.rows[0].is_published) },
    });
    return inserted.rows;
  });
  response.status(201).json({ exam: toExam(rows[0]) });
}));

app.patch('/api/admin/exams/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
    `UPDATE exams SET is_published = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, code, name, category, target_audience, registration_start, registration_end,
               exam_date, time_zone, fee, duration, mode, shifts, is_published`,
    [request.params.id, parsed.data.isPublished],
    );
    if (updated.rows[0]) {
      await recordAuditEvent(client, {
        action: 'exam.updated', actor: auditActor(request), resourceId: String(updated.rows[0].id),
        metadata: { exam_code: String(updated.rows[0].code), is_published: parsed.data.isPublished },
      });
    }
    return updated.rows;
  });
  if (!rows[0]) {
    response.status(404).json({ error: 'Exam form not found.' });
    return;
  }
  response.json({ exam: toExam(rows[0]) });
}));

const accountRegistrationSchema = z.object({
  loginId: z.string().trim().min(4).max(50).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(2).max(120),
  password: registrationPasswordSchema,
});

app.post('/api/auth/register', authLimiter, asyncRoute(async (request, response) => {
  // AUTH-1 (strict): registration is closed, before any write, until mobile OTP is available (email
  // OTP while AUTH_MOBILE_VERIFICATION is off).
  const mobileRequired = mobileVerificationMode() !== 'off';
  const providers = providerStatus();
  if (mobileRequired ? !providers.sms.available : !providers.email.available) {
    response.status(503).json(mobileRequired
      ? { error: 'Student registration is unavailable: mobile verification is not configured.', code: OTP_PROVIDER_NOT_CONFIGURED }
      : { error: 'Student registration is unavailable: email verification is not configured.', code: EMAIL_PROVIDER_NOT_CONFIGURED });
    return;
  }
  const parsed = z.object({
    name: accountRegistrationSchema.shape.name,
    password: registrationPasswordSchema,
    mobile: z.string().trim().max(20),
    email: z.string().trim().max(254).optional(),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const mobile = normaliseMobile(parsed.data.mobile);
  if (!mobile) {
    response.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.', code: 'INVALID_MOBILE' });
    return;
  }
  // While mobile verification is off the code goes to this email; the mobile stays the sign-in identifier.
  const email = mobileRequired ? null : normaliseEmail(parsed.data.email);
  if (!mobileRequired && !email) {
    response.status(400).json({ error: 'Enter a valid email address.', code: parsed.data.email ? 'INVALID_EMAIL' : 'EMAIL_REQUIRED' });
    return;
  }
  const { name, password } = parsed.data;
  // AUTH C1: the account is created only after the code is verified.
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    response.status(202).json(await startStudentRegistration(response, { mobile, email, displayName: name, passwordHash }));
  } catch (error) {
    if (!sendFlowError(response, error)) throw error;
  }
}));

app.post('/api/center/register', authLimiter, asyncRoute(async (request, response) => {
  // AUTH-1 (strict): closed, before any write, until both mobile and email verification exist (email
  // alone while AUTH_MOBILE_VERIFICATION is off).
  const providers = providerStatus();
  const mobileRequired = mobileVerificationMode() !== 'off';
  if ((mobileRequired && !providers.sms.available) || !providers.email.available) {
    response.status(503).json({
      error: mobileRequired
        ? 'Institute registration is unavailable: mobile and email verification are not configured.'
        : 'Institute registration is unavailable: email verification is not configured.',
      code: mobileRequired && !providers.sms.available ? OTP_PROVIDER_NOT_CONFIGURED : EMAIL_PROVIDER_NOT_CONFIGURED,
    });
    return;
  }
  if (mobileRequired) {
    try {
      const gate = await smsProtectionGate('unverified');
      if (gate) throw gate;
    } catch (error) {
      if (!sendFlowError(response, error)) throw error;
      return;
    }
  }
  const parsed = accountRegistrationSchema.extend({
    contactEmail: z.string().trim().email().max(254),
    contactMobile: z.string().trim().max(20),
    registrationNumber: z.string().trim().min(3).max(100),
    registeredAddress: z.string().trim().min(10).max(500),
    website: z.string().trim().max(200).optional().or(z.literal('')),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const contactMobile = normaliseMobile(parsed.data.contactMobile);
  const normalisedEmail = normaliseEmail(parsed.data.contactEmail);
  if (!contactMobile || !normalisedEmail) {
    response.status(400).json({ error: 'Enter a valid 10-digit Indian contact number and email address.', code: 'INVALID_CONTACT' });
    return;
  }
  try {
    if (mobileRequired) {
      const mobileGate = await smsProtectionGate('unverified', contactMobile);
      if (mobileGate) throw mobileGate;
    }
    const emailGate = await emailProtectionGate('unverified', normalisedEmail);
    if (emailGate) throw emailGate;
  } catch (error) {
    if (!sendFlowError(response, error)) throw error;
    return;
  }
  let createdInstitutionId: string | undefined;
  const { loginId, name, password, contactEmail, registrationNumber, registeredAddress, website } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  let issue: Awaited<ReturnType<typeof issueSubmissionCapability>> | undefined;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users
       (id, login_id, display_name, role, password_hash, contact_email,
        registration_number, registered_address, website, account_status)
       VALUES ($1, $2, $3, 'center', $4, $5, $6, $7, $8, 'pending')
       ON CONFLICT (login_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), loginId.toUpperCase(), name, passwordHash, contactEmail.toLowerCase(),
        registrationNumber, registeredAddress, website || null],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      response.status(409).json({ error: 'That institute login ID is already in use. Choose another.' });
      return;
    }
    const institutionId = String(rows[0].id);
    const cycleId = await createSubmissionCycle(client, {
      institutionId,
      submissionVersion: 1,
      sourceType: 'initial_registration',
    });
    issue = await issueSubmissionCapability(client, institutionId, cycleId);
    // AUTH-1: unverified contact destinations, recorded with the registration (verified separately).
    await client.query(
      'INSERT INTO institute_verifications (institution_id, mobile_destination, email_destination) VALUES ($1, $2, $3)',
      [institutionId, contactMobile, normalisedEmail],
    );
    createdInstitutionId = institutionId;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01') {
      response.status(503).json({
        error: 'Institution document submission is not configured. Review and apply the separate submission migration before registering institutions.',
      });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
  if (issue) setInstitutionSubmissionCookie(response, issue);
  // Institute mobile is verified first, then email (email only while mobile verification is off).
  // No portal session is created yet.
  let verification: Awaited<ReturnType<typeof startInstituteVerification>> | { error: string; code: string } | null = null;
  try {
    verification = await startInstituteVerification(response, createdInstitutionId!, normalisedEmail, {
      mobileDestination: contactMobile, mobileVerifiedAt: null, emailDestination: normalisedEmail, emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null,
    });
  } catch (error) {
    if (!(error instanceof VerificationFlowError)) throw error;
    verification = { error: error.message, code: error.code };
  }
  response.status(201).json({
    message: mobileRequired
      ? 'Institute request submitted. Verify your mobile number and email; Super Admin will verify the registration details before approval.'
      : 'Institute request submitted. Verify your email; Super Admin will verify the registration details before approval.',
    verification,
  });
}));

app.post('/api/center/resubmit', authLimiter, asyncRoute(async (request, response) => {
  const parsed = accountRegistrationSchema.extend({
    contactEmail: z.string().trim().email().max(254),
    registrationNumber: z.string().trim().min(3).max(100),
    registeredAddress: z.string().trim().min(10).max(500),
    website: z.string().trim().max(200).optional().or(z.literal('')),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const {
    loginId, name, password, contactEmail, registrationNumber, registeredAddress, website,
  } = parsed.data;
  const { rows: accountRows } = await pool.query(
    `SELECT id, password_hash FROM users WHERE login_id = $1 AND role = 'center'`,
    [loginId.toUpperCase()],
  );
  const account = accountRows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) {
    response.status(401).json({ error: 'Invalid institute login ID or password.' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lockedRows } = await client.query(
      `SELECT id, account_status FROM users
       WHERE id = $1 AND role = 'center' FOR UPDATE`,
      [account.id],
    );
    const lockedAccount = lockedRows[0];
    if (!lockedAccount || lockedAccount.account_status !== 'rejected') {
      await client.query('ROLLBACK');
      response.status(409).json({ error: 'Only a rejected institute application can be resubmitted.' });
      return;
    }

    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX(submission_version), 0) + 1 AS next_version
       FROM institute_resubmissions WHERE institution_id = $1`,
      [account.id],
    );
    const version = Number(versionRows[0].next_version);
    const submissionReference = randomUUID();
    const submittedData = {
      displayName: name,
      contactEmail: contactEmail.toLowerCase(),
      registrationNumber,
      registeredAddress,
      website: website || null,
    };
    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET display_name = $2, contact_email = $3, registration_number = $4,
           registered_address = $5, website = $6, account_status = 'pending'
       WHERE id = $1 AND role = 'center' AND account_status = 'rejected'
       RETURNING id, login_id, display_name, contact_email, registration_number,
                 registered_address, website, account_status, created_at`,
      [account.id, name, contactEmail.toLowerCase(), registrationNumber, registeredAddress, website || null],
    );
    if (!updatedRows[0]) {
      await client.query('ROLLBACK');
      response.status(409).json({ error: 'Only a rejected institute application can be resubmitted.' });
      return;
    }
    await client.query(
      `INSERT INTO institute_resubmissions
       (id, institution_id, submission_version, submission_reference, submitted_data,
        previous_status, new_status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'rejected', 'pending')`,
      [randomUUID(), account.id, version, submissionReference, JSON.stringify(submittedData)],
    );
    await client.query(
      `UPDATE institution_submission_cycles
       SET status = 'closed', closed_at = now()
       WHERE institution_id = $1 AND status = 'open'`,
      [account.id],
    );
    await client.query(
      `UPDATE institution_submission_capabilities
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE institution_id = $1 AND revoked_at IS NULL`,
      [account.id],
    );
    const cycleId = await createSubmissionCycle(client, {
      institutionId: String(account.id),
      submissionVersion: version + 1,
      sourceType: 'resubmission',
      sourceReference: submissionReference,
    });
    const capabilityIssue = await issueSubmissionCapability(client, String(account.id), cycleId);
    // The institute proved its password on this request (no session exists for a rejected account).
    await recordAuditEvent(client, {
      action: 'institution.resubmitted', actor: { type: 'user', userId: String(account.id), role: 'center' },
      organizationId: String(account.id), resourceId: String(account.id),
    });
    await client.query('COMMIT');
    setInstitutionSubmissionCookie(response, capabilityIssue);
    response.status(200).json({
      message: 'Corrected institute details submitted for review. Portal access remains unavailable until approval.',
      submissionReference,
      submissionVersion: version,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01') {
      response.status(503).json({
        error: 'Institution document submission is not configured. Review and apply the separate submission migration before resubmitting.',
      });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (request, response) => {
  // Students use mobile + password, then SMS OTP. While AUTH_MOBILE_VERIFICATION is off (owner
  // decision, 2026-11-24) an existing Student signs in with email, mobile or Student ID + password
  // alone. Institutes and Officials keep loginId + password.
  const schema = z.object({
    loginId: z.string().trim().min(1).max(254).optional(),
    mobile: z.string().trim().min(1).max(20).optional(),
    email: z.string().trim().min(1).max(254).optional(),
    password: z.string().min(1).max(128),
    role: z.enum(['candidate', 'center', 'official']),
  }).refine((body) => (body.role === 'candidate'
    ? [body.loginId, body.mobile, body.email].filter((value) => value !== undefined).length === 1
    : body.loginId !== undefined && body.mobile === undefined && body.email === undefined), { message: 'Provide exactly one sign-in identifier.', path: ['loginId'] });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }

  const { loginId, mobile: mobileInput, email: emailInput, password, role } = parsed.data;
  // P1-B: the role must belong to this surface; checked before any user lookup, with the same
  // generic response as invalid credentials.
  if (!isLoginRoleAllowedOnSurface(getTrustedRequestSurface(request) as Surface, role)) {
    response.status(401).json({ error: 'Invalid login ID, password, or account type.' });
    return;
  }
  // AUTH-1 (strict): Student and Institute sign-in stays closed until real verification providers are
  // configured. Checked BEFORE any lookup, so the answer reveals nothing about the account.
  const providers = providerStatus();
  // AUTH_MOBILE_VERIFICATION=off: Students receive the code by email and Institutes verify email only.
  const mobileRequired = mobileVerificationMode() !== 'off';
  // Password-only Student sign-in (switch off) sends nothing, so it needs no delivery provider.
  if (role === 'candidate' && mobileRequired && !providers.sms.available) {
    response.status(503).json({ error: 'Student sign-in is unavailable: mobile verification is not configured.', code: OTP_PROVIDER_NOT_CONFIGURED });
    return;
  }
  if (role === 'center' && !providers.email.available) {
    response.status(503).json({
      error: 'Institute sign-in is unavailable: email verification is not configured.',
      code: EMAIL_PROVIDER_NOT_CONFIGURED,
    });
    return;
  }
  if (role === 'candidate' || role === 'center') {
    try {
      // Candidate sign-in always needs an SMS provider when mobile verification is required.
      // An Institute with its mobile already verified needs no SMS delivery at login; if it still
      // needs a mobile challenge, startVerification below refuses it when SMS is unavailable.
      if (mobileRequired) {
        const smsGate = await smsProtectionGate(role === 'candidate' ? 'any' : 'config');
        if (smsGate) throw smsGate;
      }
      if (role === 'center') {
        const emailGate = await emailProtectionGate('config');
        if (emailGate) throw emailGate;
      }
    } catch (error) {
      if (!sendFlowError(response, error)) throw error;
      return;
    }
  }
  const USER_COLUMNS = 'id, login_id, display_name, role, password_hash, account_status, is_super_admin, contact_email';
  let user: Record<string, any> | undefined;
  // For mobile input, candidates are the account whose login ID derives from that mobile plus any
  // Student whose VERIFIED contact is that mobile. Exactly one match proceeds; none or several fail
  // generically. One bcrypt comparison runs either way.
  let signInMobile: string | null = null;
  if (role === 'candidate' && (mobileInput !== undefined || emailInput !== undefined)) {
    const MOBILE_FAILURE = mobileRequired
      ? { error: 'Invalid mobile number or password. If you signed up earlier with a Student ID, use "Existing account?".', code: 'INVALID_MOBILE_CREDENTIALS' }
      : { error: 'Invalid email, mobile number or password. If you signed up earlier with a Student ID, use "Existing account?".', code: 'INVALID_SIGN_IN_CREDENTIALS' };
    let match: Record<string, any> | undefined;
    try {
      if (mobileInput !== undefined) {
        signInMobile = normaliseMobile(mobileInput);
        if (signInMobile) {
          const derived = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE login_id = $1 AND role = 'candidate'`, [studentLoginIdForMobile(verificationServices().otpKey!, signInMobile)]);
          const viaContact = await authVerificationStore().findCandidateIdsByVerifiedMobile(signInMobile, 3);
          const ids = new Set<string>([...derived.rows.map((row) => String(row.id)), ...viaContact]);
          if (ids.size === 1) {
            match = derived.rows[0] ?? (await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND role = 'candidate'`, [[...ids][0]])).rows[0];
          }
        }
      } else {
        // Email sign-in exists only while the switch is off: the account's VERIFIED email, exactly one.
        const signInEmail = mobileRequired ? null : normaliseEmail(emailInput);
        const ids = signInEmail ? await authVerificationStore().findCandidateIdsByVerifiedEmail(signInEmail, 2) : [];
        if (ids.length === 1) {
          match = (await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND role = 'candidate'`, [ids[0]])).rows[0];
        }
      }
    } catch (error) {
      if (!sendFlowError(response, error)) throw error;
      return;
    }
    const valid = match ? await bcrypt.compare(password, match.password_hash) : await compareAgainstDummyHash(password);
    if (!match || !valid) {
      response.status(401).json(MOBILE_FAILURE);
      return;
    }
    user = match;
  } else {
    const { rows } = role === 'center' && loginId!.includes('@')
      ? await pool.query(
        `SELECT u.id, u.login_id, u.display_name, u.role, u.password_hash, u.account_status, u.is_super_admin, u.contact_email
           FROM users u
           JOIN institute_verifications iv ON iv.institution_id = u.id
          WHERE u.role = 'center'
            AND iv.email_verified_at IS NOT NULL
            AND lower(iv.email_destination) = lower($1)
          LIMIT 2`,
        [loginId!.trim()],
      )
      : await pool.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE login_id = $1 AND role = $2`,
        [loginId!.toUpperCase(), role],
      );
    // An Institute email is a login alias only when it is the account's verified address and maps
    // to exactly one account. Ambiguous or unverified addresses fail generically, like unknown IDs.
    const uniqueInstituteEmailMatch = role !== 'center' || !loginId!.includes('@') || rows.length === 1;
    user = uniqueInstituteEmailMatch ? rows[0] : undefined;
    // AUTH C1.9.1 (D-11): an unknown login ID costs one bcrypt comparison too (against the fixed,
    // once-per-process dummy hash), so the answer time does not reveal whether the account exists.
    const valid = user ? await bcrypt.compare(password, user.password_hash) : await compareAgainstDummyHash(password);
    if (!user || !valid) {
      response.status(401).json({ error: 'Invalid login ID, password, or account type.' });
      return;
    }
  }
  if (user.account_status !== 'approved') {
    response.status(403).json({
      error: user.account_status === 'pending'
        ? 'Institute registration is awaiting Super Admin approval.'
        : 'This account was not approved. Contact the portal administrator.',
      code: user.account_status === 'pending' ? 'APPROVAL_PENDING' : 'ACCOUNT_REJECTED',
    });
    return;
  }
  // A correct password never yields a Student session by itself; a one-time code is required (to the
  // mobile, or to the verified email while AUTH_MOBILE_VERIFICATION is off).
  if (user.role === 'candidate') {
    try {
      if (!mobileRequired) {
        // Owner decision (2026-11-24): password alone while the switch is off. The session is recorded
        // as method 'password' and stops counting when AUTH_MOBILE_VERIFICATION is back to required.
        const token = newSessionToken();
        const now = new Date();
        await authVerificationStore().issueStudentPasswordSession({
          userId: String(user.id), sessionTokenHash: hashSessionToken(token), sessionExpiresAt: new Date(now.getTime() + SESSION_TTL_MS), now,
        });
        setSessionCookie(response, token);
        response.json({ user: { id: user.id, loginId: user.login_id, name: user.display_name, role: user.role, isSuperAdmin: false } });
        return;
      }
      const verifiedMobile = await authVerificationStore().findVerifiedContact(String(user.id), 'sms');
      const destination = signInMobile ?? verifiedMobile;
      const challenge = await startVerification(response, {
        purpose: verifiedMobile ? 'student_login' : 'student_mobile_capture', userId: String(user.id), channel: 'sms', destination,
      });
      response.status(202).json(challenge);
    } catch (error) {
      if (!sendFlowError(response, error)) throw error;
    }
    return;
  }
  // AUTH C1.9.1 (MFA P3a-1): a correct password NEVER yields an Official or Super Admin session by
  // itself. The answer is 202 with only a status (no role or Super Admin information): mfa_required
  // (challenge cookie set; complete at POST /api/auth/mfa/verify) or mfa_enrolment_required (Phase 4).
  if (user.role === 'official') {
    try {
      response.status(202).json(await beginAdminMfaSignIn(response, String(user.id)));
    } catch (error) {
      if (!sendAdminMfaError(response, error)) throw error;
    }
    return;
  }
  // Institute access needs verified mobile (unless mobile verification is off) and email, institutional
  // verification, Official approval (above) and no suspension before any session. A missing SMS provider
  // does not block accounts that completed mobile verification earlier.
  if (user.role === 'center') {
    try {
      const state = await authVerificationStore().getInstituteVerification(String(user.id));
      if (state?.suspendedAt) {
        response.status(403).json({ error: 'This institute account is suspended.', code: 'INSTITUTE_SUSPENDED' });
        return;
      }
      if (nextInstituteChannel(state)) {
        response.status(202).json(await startInstituteVerification(response, String(user.id), user.contact_email ?? null, state));
        return;
      }
      if (state!.institutionalStatus !== 'verified') {
        response.status(403).json(state!.institutionalStatus === 'rejected'
          ? { error: 'Institutional verification was not successful. Contact the portal administrator.', code: 'INSTITUTIONAL_VERIFICATION_REJECTED' }
          : { error: 'Institutional verification is pending.', code: 'INSTITUTIONAL_VERIFICATION_PENDING' });
        return;
      }
    } catch (error) {
      if (!sendFlowError(response, error)) throw error;
      return;
    }
  }

  const token = newSessionToken();
  const tokenHash = hashSessionToken(token);
  try {
    await pool.query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
      [tokenHash, user.id, sessionSeconds],
    );
  } catch {
    // Session row could not be persisted — do not issue a cookie.
    response.status(503).json({ error: 'Sign in failed: session could not be created. Please try again.' });
    return;
  }
  setSessionCookie(response, token);
  response.json({
    user: {
      id: user.id,
      loginId: user.login_id,
      name: user.display_name,
      role: user.role,
      isSuperAdmin: user.is_super_admin === true,
    },
  });
}));

// AUTH C1.9.1 (MFA P3a-1): second step of Official sign-in (Admin surface only; see server/surface.ts).
app.post('/api/auth/mfa/verify', authLimiter, createAdminMfaVerifyHandler());
// AUTH C1.9.1 (MFA P4): enrollment remains unauthenticated at the application-session layer; both
// endpoints require the short-lived enrollment-purpose challenge cookie created after password success.
app.post('/api/auth/mfa/enrol/start', authLimiter, createAdminMfaEnrolStartHandler());
app.post('/api/auth/mfa/enrol/confirm', authLimiter, createAdminMfaEnrolConfirmHandler());

app.get('/api/auth/me', requireAuth, asyncRoute(async (request, response) => {
  const user = getUser(request);
  response.json({
    user: {
      id: user?.id,
      loginId: user?.loginId,
      name: user?.name,
      role: user?.role,
      isSuperAdmin: user?.isSuperAdmin ?? false,
    },
  });
}));

app.post('/api/auth/logout', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthenticatedRequest;
  await inAuditedTransaction(async (client) => {
    const revoked = await client.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [authRequest.sessionTokenHash],
    );
    // The session token (or its hash) is never recorded; the actor and time are enough.
    if (revoked.rowCount) {
      await recordAuditEvent(client, {
        action: 'session.logged_out', actor: auditActor(request),
        organizationId: authRequest.user?.role === 'center' ? authRequest.user.id : null,
      });
    }
  });
  response.clearCookie('elt_session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
  response.status(204).end();
}));

const feedbackSchema = z.object({
  type: z.enum(['bug', 'suggestion', 'cbt_issue', 'admit_card', 'performance', 'other']),
  title: z.string().trim().min(4).max(100),
  description: z.string().trim().min(10).max(1000),
  module: z.string().trim().min(1).max(100),
  candidateName: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
  applicationNumber: z.string().trim().max(100).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  rating: z.number().int().min(1).max(5).optional(),
  attachmentName: z.string().trim().max(255).optional(),
});

app.post('/api/feedback', requireAuth, requireRoles('candidate', 'center'), publicWriteLimiter, asyncRoute(async (request, response) => {
  const parsed = feedbackSchema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const input = parsed.data;
  const id = `FB-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const user = getUser(request);
  const { rows } = await pool.query(
    `INSERT INTO feedback
     (id, user_id, type, title, description, module, candidate_name, email, application_number, priority, rating, attachment_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, ''), $9, $10, $11, $12)
     RETURNING *`,
    [id, user?.id ?? null, input.type, input.title, input.description, input.module,
      input.candidateName || null, input.email || '', input.applicationNumber || null,
      input.priority, input.rating ?? null, input.attachmentName || null],
  );
  response.status(201).json({ entry: toFeedback(rows[0]) });
}));

// P0-3 (A-14): helpdesk tickets (which contain applicant contact details) are Super Admin-only.
app.get('/api/admin/feedback', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const { rows } = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 500');
  response.json({ entries: rows.map(toFeedback) });
}));

app.patch('/api/admin/feedback/:id', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({
    status: z.enum(['under_review', 'in_progress', 'resolved']),
    resolutionNote: z.string().trim().max(1000).optional(),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE feedback SET status = $2, resolution_note = $3
       WHERE id = $1 RETURNING *`,
      [request.params.id, parsed.data.status, parsed.data.resolutionNote ?? null],
    );
    if (updated.rows[0]) {
      // The ticket text and resolution note stay in `feedback`; only the status is recorded.
      await recordAuditEvent(client, {
        action: 'helpdesk.ticket_updated', actor: auditActor(request), resourceId: String(updated.rows[0].id),
        metadata: { new_status: parsed.data.status },
      });
    }
    return updated.rows;
  });
  if (!rows[0]) {
    response.status(404).json({ error: 'Feedback ticket not found.' });
    return;
  }
  response.json({ entry: toFeedback(rows[0]) });
}));

const applicationSchema = z.object({
  examCode: z.string().trim().min(2).max(30),
  candidateName: z.string().trim().min(2).max(120),
  fatherName: z.string().trim().min(2).max(120),
  dateOfBirth: z.string().date(),
  gender: z.enum(['Male', 'Female', 'Other']),
  category: z.enum(['General', 'OBC-NCL', 'SC', 'ST', 'Gen-EWS']),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(24),
  firstCityPreference: z.string().trim().min(2).max(100),
  secondCityPreference: z.string().trim().min(2).max(100),
  languageMedium: z.string().trim().min(2).max(60),
});

app.post('/api/applications', requireAuth, requireRoles('candidate'), publicWriteLimiter, asyncRoute(async (request, response) => {
  const parsed = applicationSchema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }

  const input = parsed.data;
  const user = getUser(request);
  const examCode = input.examCode.toUpperCase();
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const existingApplication = await client.query(
      'SELECT application_number FROM applications WHERE user_id = $1 AND exam_code = $2',
      [user?.id, examCode],
    );
    if (existingApplication.rows[0]) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      response.status(409).json({ error: 'You have already submitted an application for this exam.' });
      return;
    }

    const exam = await client.query(
      'SELECT code FROM exams WHERE code = $1 FOR SHARE',
      [examCode],
    );
    if (!exam.rows[0]) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      response.status(400).json({ error: 'Applications are not open for this exam.' });
      return;
    }

    const applicationId = randomUUID();
    let rows: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await client.query(
        `WITH acceptance_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS accepted_at
         )
         INSERT INTO applications
         (id, user_id, application_number, exam_code, candidate_name, father_name, date_of_birth, gender, category, email, phone,
          first_city_preference, second_city_preference, language_medium)
         SELECT $1, $2,
                'APP-' || extract(year FROM acceptance_clock.accepted_at AT TIME ZONE e.time_zone)::int::text || '-' || $3::text,
                e.code, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         FROM exams e CROSS JOIN acceptance_clock
         WHERE e.code = $4 AND e.is_published = true
           AND (acceptance_clock.accepted_at AT TIME ZONE e.time_zone)::date
             BETWEEN e.registration_start AND e.registration_end
         ON CONFLICT DO NOTHING RETURNING *`,
        [applicationId, user?.id, randomInt(100000, 1_000_000), examCode, input.candidateName,
          input.fatherName, input.dateOfBirth, input.gender, input.category, input.email.toLowerCase(),
          input.phone, input.firstCityPreference, input.secondCityPreference, input.languageMedium],
      );
      rows = result.rows;
      if (rows[0]) break;

      const duplicate = await client.query(
        'SELECT application_number FROM applications WHERE user_id = $1 AND exam_code = $2',
        [user?.id, examCode],
      );
      if (duplicate.rows[0]) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        response.status(409).json({ error: 'You have already submitted an application for this exam.' });
        return;
      }

      const stillOpen = await client.query(
        `SELECT is_published
           AND (clock_timestamp() AT TIME ZONE time_zone)::date BETWEEN registration_start AND registration_end AS is_open
         FROM exams WHERE code = $1`,
        [examCode],
      );
      if (!stillOpen.rows[0]?.is_open) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        response.status(400).json({ error: 'Applications are not open for this exam.' });
        return;
      }
    }
    if (!rows[0]) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      response.status(409).json({ error: 'An application for this exam may already exist on your account.' });
      return;
    }

    await client.query('COMMIT');
    transactionOpen = false;
    response.status(201).json({
      application: {
        id: rows[0].id,
        applicationNumber: rows[0].application_number,
        examCode: rows[0].exam_code,
        status: rows[0].status,
        createdAt: rows[0].created_at,
      },
    });
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/admin/applications', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.application_number, a.exam_code, a.candidate_name, a.email, a.phone,
            a.first_city_preference, a.second_city_preference, a.language_medium,
            a.status, a.created_at, (c.application_id IS NOT NULL) AS admit_card_published
     FROM applications a LEFT JOIN admit_cards c ON c.application_id = a.id
     ORDER BY a.created_at DESC LIMIT 500`,
  );
  response.json({ applications: rows });
}));

app.patch('/api/admin/applications/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    status: z.enum(['submitted', 'under_review', 'approved', 'rejected']),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
      'UPDATE applications SET status = $2 WHERE id = $1 RETURNING id, application_number, status',
      [request.params.id, parsed.data.status],
    );
    if (updated.rows[0]) {
      await recordAuditEvent(client, {
        action: 'application.status_changed', actor: auditActor(request), resourceId: String(updated.rows[0].id),
        metadata: { new_status: parsed.data.status },
      });
    }
    return updated.rows;
  });
  if (!rows[0]) {
    response.status(404).json({ error: 'Application not found.' });
    return;
  }
  response.json({ application: rows[0] });
}));

// P0-3 (A-15): linking a legacy application to a candidate account is Super Admin-only.
app.post('/api/admin/applications/:id/verify-ownership', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({
    applicationNumber: z.string().trim().min(4).max(100),
    dateOfBirth: z.string().date(),
    candidateLoginId: z.string().trim().min(4).max(50).regex(/^[A-Za-z0-9._-]+$/),
    verificationMethod: z.enum([
      'identity_document_review',
      'registered_contact_confirmation',
      'institution_confirmation',
    ]),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }

  const verifier = getUser(request);
  const query = linkLegacyApplicationQuery({
    applicationId: request.params.id,
    ...parsed.data,
    verifierId: verifier!.id,
  });
  const rows = await inAuditedTransaction(async (client) => {
    const linked = await client.query(query.text, query.values);
    if (linked.rows[0]) {
      // The candidate's login ID and date of birth are never recorded (A-08, E-07).
      await recordAuditEvent(client, {
        action: 'application.ownership_linked', actor: auditActor(request), resourceId: request.params.id,
        metadata: { verification_method: parsed.data.verificationMethod },
      });
    }
    return linked.rows;
  });
  if (!rows[0]) {
    response.status(404).json({
      error: 'Legacy application was not found, is already linked, or candidate verification did not match.',
    });
    return;
  }
  response.json({ application: rows[0] });
}));

app.get('/api/candidate/portal', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const applicationsQuery = candidateApplicationsQuery(user!.id);
  const { rows } = await pool.query(applicationsQuery.text, applicationsQuery.values);
  const attempts = await pool.query(
    `SELECT id, total_questions, attempted, correct, incorrect, unattempted,
            total_score, max_score, percentage, submitted_at
     FROM mock_exam_attempts WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 20`,
    [user?.id],
  );
  const resultsQuery = candidateResultsQuery(user!.id);
  const results = await pool.query(resultsQuery.text, resultsQuery.values);
  response.json({ applications: rows, attempts: attempts.rows, results: results.rows });
}));

// P0-3 (A-06, P3-D1): interim Super Admin-only (this write publishes immediately).
app.put('/api/admin/applications/:id/admit-card', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({
    rollNumber: z.string().trim().min(3).max(50),
    examDate: z.string().trim().min(3).max(100),
    reportingTime: z.string().trim().min(3).max(50),
    gateClosingTime: z.string().trim().min(3).max(50),
    examTiming: z.string().trim().min(3).max(100),
    centerCode: z.string().trim().min(2).max(40),
    centerName: z.string().trim().min(2).max(150),
    centerAddress: z.string().trim().min(5).max(300),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const data = parsed.data;
  const application = await pool.query('SELECT id FROM applications WHERE id = $1', [request.params.id]);
  if (!application.rows[0]) {
    response.status(404).json({ error: 'Application not found.' });
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const written = await client.query(
    `INSERT INTO admit_cards
     (application_id, roll_number, exam_date, reporting_time, gate_closing_time, exam_timing, center_code, center_name, center_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (application_id) DO UPDATE SET
       roll_number = EXCLUDED.roll_number, exam_date = EXCLUDED.exam_date,
       reporting_time = EXCLUDED.reporting_time, gate_closing_time = EXCLUDED.gate_closing_time,
       exam_timing = EXCLUDED.exam_timing, center_code = EXCLUDED.center_code,
       center_name = EXCLUDED.center_name, center_address = EXCLUDED.center_address,
       published_at = now()
     RETURNING *`,
    [request.params.id, data.rollNumber.toUpperCase(), data.examDate, data.reportingTime,
      data.gateClosingTime, data.examTiming, data.centerCode.toUpperCase(), data.centerName, data.centerAddress],
    );
    if (written.rows[0]) {
      await recordAuditEvent(client, {
        action: 'admit_card.assigned', actor: auditActor(request), resourceId: request.params.id,
        metadata: { center_code: data.centerCode.toUpperCase() },
      });
    }
    return written.rows;
  });
  if (!rows[0]) {
    response.status(404).json({ error: 'Application not found.' });
    return;
  }
  response.json({ admitCard: rows[0] });
}));

app.get('/api/center/checkins', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const checkinsQuery = centerCheckinsQuery(user!.loginId.toUpperCase());
  const { rows } = await pool.query(checkinsQuery.text, checkinsQuery.values);
  response.json({ checkins: rows });
}));

app.post('/api/center/checkins', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    applicationNumber: z.string().trim().min(4).max(100),
    dateOfBirth: z.string().date(),
    status: z.enum(['verified', 'admitted', 'flagged', 'rejected']),
    note: z.string().trim().max(500).optional(),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const centerCode = user?.loginId.toUpperCase();
  const application = await pool.query(
    `SELECT a.id FROM applications a
     JOIN admit_cards c ON c.application_id = a.id
     WHERE a.application_number = $1 AND a.date_of_birth = $2 AND c.center_code = $3`,
    [parsed.data.applicationNumber.toUpperCase(), parsed.data.dateOfBirth, centerCode],
  );
  if (!application.rows[0]) {
    response.status(404).json({ error: 'No candidate assigned to this center matches those details.' });
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const written = await client.query(
    `INSERT INTO center_checkins (id, application_id, center_code, status, note, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (application_id, center_code) DO UPDATE SET
       status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id, status, note, updated_at`,
    [randomUUID(), application.rows[0].id, centerCode, parsed.data.status,
      parsed.data.note || null, user?.id],
    );
    // The note and candidate details stay in center_checkins; only the status is recorded.
    await recordAuditEvent(client, {
      action: 'checkin.recorded', actor: auditActor(request), organizationId: user?.id ?? null,
      resourceId: String(written.rows[0].id), metadata: { status: parsed.data.status },
    });
    return written.rows;
  });
  response.status(200).json({ checkin: rows[0] });
}));

const candidateAdmitCardLookupHandler = asyncRoute(async (request, response) => {
  const parsed = z.object({
    applicationNumber: z.string().trim().min(4).max(100),
    examCode: z.string().trim().min(2).max(30),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const query = candidateAdmitCardQuery(
    user!.id,
    parsed.data.applicationNumber.toUpperCase(),
    parsed.data.examCode.toUpperCase(),
  );
  const { rows } = await pool.query(query.text, query.values);
  if (!rows[0]) {
    response.status(404).json({ error: 'No admit card is available for that application on your account.' });
    return;
  }
  response.set('Cache-Control', 'no-store');
  response.json({
    admitCard: {
      applicationNumber: rows[0].application_number,
      candidateName: rows[0].candidate_name,
      fatherName: rows[0].father_name,
      dob: rows[0].date_of_birth,
      gender: rows[0].gender.toUpperCase(),
      category: rows[0].category,
      rollNumber: rows[0].roll_number,
      examName: rows[0].exam_code,
      examCode: rows[0].exam_code,
      examDate: rows[0].exam_date,
      reportingTime: rows[0].reporting_time,
      gateClosingTime: rows[0].gate_closing_time,
      examTiming: rows[0].exam_timing,
      centerCode: rows[0].center_code,
      centerName: rows[0].center_name,
      centerAddress: rows[0].center_address,
      photoUrl: '',
    },
  });
});

app.post(
  ['/api/candidate/admit-cards/lookup', '/api/admit-cards/lookup'],
  requireAuth,
  requireRoles('candidate'),
  candidateAdmitCardLookupHandler,
);

const scorecardSchema = z.object({
  rollNumber: z.string().trim().min(3).max(50),
  applicationNumber: z.string().trim().min(4).max(100),
  candidateName: z.string().trim().min(1).max(120),
  fatherName: z.string().max(120),
  motherName: z.string().max(120),
  dob: z.string().date(),
  gender: z.enum(['Male', 'Female', 'Other']),
  category: z.enum(['General', 'OBC-NCL', 'SC', 'ST', 'Gen-EWS']),
  pwdStatus: z.boolean(),
  examCode: z.string().trim().min(2).max(30),
  examName: z.string().trim().min(2).max(160),
  examDate: z.string().trim().min(3).max(100),
  centerName: z.string().trim().min(2).max(200),
  sectionScores: z.array(z.object({
    sectionName: z.string().trim().min(1).max(120),
    maxMarks: z.number().finite().min(0),
    marksObtained: z.number().finite(),
    percentile: z.number().finite().min(0).max(100),
  })).min(1).max(20),
  totalMaxMarks: z.number().finite().positive(),
  totalMarksObtained: z.number().finite(),
  aggregatePercentile: z.number().finite().min(0).max(100),
  allIndiaRank: z.number().int().min(0),
  categoryRank: z.number().int().min(0),
  qualifyingStatus: z.enum(['QUALIFIED', 'NOT_QUALIFIED']),
  cutoffMarks: z.object({
    general: z.number().finite(),
    obc: z.number().finite(),
    ews: z.number().finite(),
    scSt: z.number().finite(),
  }),
  digitalVerificationCode: z.string().trim().min(1).max(100),
  counselingStream: z.string().trim().min(1).max(300),
  issueDate: z.string().trim().min(3).max(100),
});

const resultSchema = z.object({
  applicationNumber: z.string().trim().min(4).max(100),
  rollNumber: z.string().trim().min(3).max(50),
  examCode: z.string().trim().min(2).max(30),
  dateOfBirth: z.string().date(),
  scorecard: scorecardSchema,
});

app.post('/api/admin/results', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = resultSchema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const result = parsed.data;
  const scorecard = result.scorecard;
  if (
    scorecard.rollNumber.toUpperCase() !== result.rollNumber.toUpperCase()
    || scorecard.applicationNumber.toUpperCase() !== result.applicationNumber.toUpperCase()
    || scorecard.examCode.toUpperCase() !== result.examCode.toUpperCase()
    || scorecard.dob !== result.dateOfBirth
  ) {
    response.status(400).json({ error: 'Scorecard identity fields must match the publication request.' });
    return;
  }
  const application = await pool.query(
    `SELECT id FROM applications
     WHERE application_number = $1 AND date_of_birth = $2 AND exam_code = $3`,
    [result.applicationNumber.toUpperCase(), result.dateOfBirth, result.examCode.toUpperCase()],
  );
  if (!application.rows[0]) {
    response.status(404).json({ error: 'A matching application was not found.' });
    return;
  }
  // P0-3 (A-04, A-16, P3-D11): this route never publishes. It writes a draft for everyone;
  // replacing a published row (a correction) is Super Admin-only and returns it to draft.
  // Publishing is a separate Super Admin action (PATCH /api/admin/results/:id).
  const superAdmin = getUser(request)?.isSuperAdmin === true;
  const rows = await inAuditedTransaction(async (client) => {
    const written = await client.query(
      superAdmin ? RESULT_UPSERT_SQL.draft : RESULT_UPSERT_SQL.draftOnlyOverDrafts,
      [randomUUID(), result.applicationNumber.toUpperCase(), result.rollNumber.toUpperCase(),
        result.examCode.toUpperCase(), result.dateOfBirth, result.scorecard],
    );
    if (written.rowCount !== 1 || !written.rows[0]) {
      if (superAdmin) throw new Error('Result write did not affect exactly one row.');
      // A 0-row outcome means nothing was written; nothing is recorded either.
      return null;
    }
    // Scores and the scorecard are never copied into the audit trail.
    await recordAuditEvent(client, {
      action: 'result.written', actor: auditActor(request), resourceId: String(written.rows[0].id),
      metadata: { exam_code: result.examCode.toUpperCase() },
    });
    return written.rows;
  });
  if (!rows) {
    sendPublishedContentForbidden(response, 'result');
    return;
  }
  response.status(201).json({ result: rows[0] });
}));

// P0-3 (A-04): publishing and unpublishing results is Super Admin-only.
app.patch('/api/admin/results/:id', requireAuth, requireRoles('official'), requireSuperAdmin, asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const rows = await inAuditedTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE published_results SET is_published = $2
       WHERE id = $1 RETURNING id, application_number, roll_number, exam_code, published_at, is_published`,
      [request.params.id, parsed.data.isPublished],
    );
    if (updated.rows[0]) {
      await recordAuditEvent(client, {
        action: 'result.publication_changed', actor: auditActor(request), resourceId: String(updated.rows[0].id),
        metadata: { is_published: parsed.data.isPublished, exam_code: String(updated.rows[0].exam_code) },
      });
    }
    return updated.rows;
  });
  if (!rows[0]) {
    response.status(404).json({ error: 'Result record not found.' });
    return;
  }
  response.json({ result: rows[0] });
}));

app.get('/api/admin/results', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, application_number, roll_number, exam_code, published_at, is_published
     FROM published_results ORDER BY published_at DESC LIMIT 500`,
  );
  response.json({ results: rows });
}));

const candidateResultLookupHandler = asyncRoute(async (request, response) => {
  const parsed = z.object({
    identifier: z.string().trim().min(3).max(100),
    dateOfBirth: z.string().date(),
    examCode: z.string().trim().min(2).max(30),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { identifier, dateOfBirth, examCode } = parsed.data;
  const user = getUser(request);
  const query = candidateResultLookupQuery(
    user!.id,
    identifier.toUpperCase(),
    dateOfBirth,
    examCode.toUpperCase(),
  );
  const { rows } = await pool.query(query.text, query.values);
  if (!rows[0]) {
    response.status(404).json({ error: 'No published result matches those details on your account.' });
    return;
  }
  response.set('Cache-Control', 'no-store');
  response.json({ scorecard: rows[0].scorecard });
});

app.post(
  ['/api/candidate/results/lookup', '/api/results/lookup'],
  requireAuth,
  requireRoles('candidate'),
  candidateResultLookupHandler,
);

app.post('/api/mock-exams/submit', requireAuth, requireRoles('candidate'), publicWriteLimiter, asyncRoute(async (request, response) => {
  const parsed = z.object({
    responses: z.record(z.string(), z.object({
      selectedOptionId: z.string().max(20).optional(),
      isMarkedForReview: z.boolean().optional(),
      visited: z.boolean().optional(),
    })),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }

  const score = scoreMockResponses(parsed.data.responses);
  const user = getUser(request);
  const userId = user?.role === 'candidate' ? user.id : null;
  const { rows } = await pool.query(
    `INSERT INTO mock_exam_attempts
     (id, user_id, responses, total_questions, attempted, correct, incorrect, unattempted,
      total_score, max_score, percentage, section_scores)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, submitted_at`,
    [randomUUID(), userId, parsed.data.responses, score.totalQuestions, score.attempted,
      score.correct, score.incorrect, score.unattempted, score.totalScore, score.maxScore,
      score.percentage, score.sectionScores],
  );
  response.status(201).json({ attemptId: rows[0].id, submittedAt: rows[0].submitted_at, score });
}));

app.get('/api/mock-exams/mine', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const query = candidatePracticeHistoryQuery(user!.id);
  const { rows } = await pool.query(query.text, query.values);
  response.json({ attempts: rows });
}));

app.get('/api/admin/mock-exams/attempts', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.total_questions, a.attempted, a.correct, a.incorrect, a.unattempted,
            a.total_score, a.max_score, a.percentage, a.submitted_at, u.login_id, u.display_name
     FROM mock_exam_attempts a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.submitted_at DESC LIMIT 500`,
  );
  response.json({ attempts: rows });
}));

const serverDirectory = fileURLToPath(new URL('.', import.meta.url));
const builtClient = resolve(serverDirectory, '../dist');
app.use('/api', createInstitutionDocumentsRouter());
app.use('/api/institution-document-submission', createInstitutionSubmissionRouter());
// SM-1: the two independent staff modules. Their tables are installed by the supported migration
// runner; missing tables still fail closed with STAFF_NOT_INSTALLED until that runner is applied.
const platformStaff = createPlatformStaffRouters({ store: createPostgresPlatformStaffStore(pool) });
app.use('/api', platformStaff.staffRouter);
app.use('/api', platformStaff.adminRouter);
// AUTH-1: Student and Institute verification and Google sign-in (all providers disabled unless configured).
app.use('/api', createAuthVerificationRouter());
// AUTH-1 / SM-2: Super Admin institutional verification and suspension (separate from Official approval).
app.use('/api', createInstituteVerificationAdminRouter());
// A-12: Super Admin-only audit-log viewer (server/auditRoutes.ts).
app.use('/api', createAuditRouter());
// Merit List Engine foundation: Super Admin-only draft merit lists (server/meritListRoutes.ts).
app.use('/api', createMeritListRouter());
const organizationStaff = createOrgStaffRouters({ store: createPostgresOrgStaffStore(pool) });
app.use('/api', organizationStaff.ownerRouter);
app.use('/api', organizationStaff.staffRouter);
app.use('/api', organizationStaff.adminRouter);
if (existsSync(builtClient)) {
  app.use(express.static(builtClient));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }
    response.sendFile(resolve(builtClient, 'index.html'));
  });
}

app.use((_request, response) => {
  response.status(404).json({ error: 'Route not found.' });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error('API request failed:', error);
  if (response.headersSent) return;
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    response.status(400).json({ error: 'Request body contains invalid JSON.' });
    return;
  }
  response.status(500).json({ error: 'An unexpected server error occurred.' });
});

/**
 * Everything startApi() touches outside this module (M-B). Production uses
 * productionStartApiDependencies(); unit tests inject fakes so the real startApi() runs without
 * sockets, a database or process side effects. The default is built only when startApi() is called,
 * never at import.
 */
export interface StartApiDependencies {
  env: Readonly<Record<string, string | undefined>>;
  /** Must be the gate mounted on `handle` (production: surfaceGate on app). */
  gate: SurfaceGate;
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  setTrustProxy: (trust: (address: string, hop: number) => boolean) => void;
  createServer: (handler: (request: IncomingMessage, response: ServerResponse) => void) => ListenerServer;
  loadOnlineExamConfig: () => OnlineExamConfig;
  checkDatabase: () => Promise<void>;
  startRecovery: (config: OnlineExamConfig) => OnlineExamRecoveryHandle;
  endPool: () => Promise<void>;
  exit: (code: number) => void;
  setExitCode: (code: number) => void;
  onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  flushRejections: () => void;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export function productionStartApiDependencies(): StartApiDependencies {
  return {
    env: process.env,
    gate: surfaceGate,
    handle: app,
    setTrustProxy: (trust) => {
      app.set('trust proxy', trust);
    },
    createServer: (handler) => createHttpServer(handler),
    loadOnlineExamConfig: getOnlineExamConfig,
    checkDatabase: async () => {
      await pool.query('SELECT 1');
    },
    startRecovery: (examConfig) => startOnlineExamRecovery(pool, () => examConfig),
    endPool: () => pool.end(),
    exit: (code) => process.exit(code),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    flushRejections: () => {
      surfaceRejectionLog.flush();
    },
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  };
}

/**
 * Starts the API. Returns the running runtime, or null (exit code 1) when the surface or
 * online-exam configuration is invalid; rejects — with every bound listener closed — if the
 * database check or a listener fails during startup.
 */
export async function startApi(deps: StartApiDependencies = productionStartApiDependencies()): Promise<ApiRuntime<ListenerServer> | null> {
  // P1-B: surface configuration is validated first (no import-time environment reads). Invalid or
  // missing settings stop startup before the database or any port is touched; only setting names
  // and rules are logged, never values. Production has no permissive defaults.
  const surfaceConfig = loadSurfaceRuntimeConfig(deps.env);
  // P1-D.2: ELTNOY_API_LISTENERS selects the listener(s) this instance runs (no default; both only
  // in development) and enforces recovery ownership by the public instance.
  const listenerSelection = surfaceConfig.ok ? resolveActiveListeners(deps.env, surfaceConfig.config.mode) : null;
  if (!surfaceConfig.ok || !listenerSelection?.ok) {
    const errors = [...(surfaceConfig.ok ? [] : surfaceConfig.errors), ...(listenerSelection && !listenerSelection.ok ? listenerSelection.errors : [])];
    deps.logError(JSON.stringify({ event: 'surface.config_invalid', errors }));
    await deps.endPool();
    deps.setExitCode(1);
    return null;
  }
  const { config } = surfaceConfig;
  const activeListeners = listenerSelection.listeners;
  // AUTH-1: verification providers. Missing or incomplete configuration leaves a channel DISABLED
  // (Student and Institute sign-in then answer 503). Only availability is logged, never values.
  // Google sign-in is enabled only if its redirect URI is on exactly the configured Exam hostname.
  const verification = resolveVerificationServices(deps.env, config.hostnames.exam);
  configureVerificationServices(verification);
  const availability = providerStatus(verification);
  deps.log(JSON.stringify({ event: 'auth.verification_providers', sms: availability.sms.available, email: availability.email.available, google: availability.google.available }));
  // C1.3-A: SMS abuse-protection settings, validated now by the same resolver requests use and
  // installed for them (one source of truth). Statuses only: no value, path or secret is logged.
  // Limits alone never enable SMS: delivery also needs a registered provider (separate flag).
  // An invalid configuration does not stop startup; every SMS simply stays refused.
  const smsProtection = initializeAbuseProtection(deps.env);
  deps.log(JSON.stringify({
    event: 'auth.sms_protection',
    ...abuseProtectionReadiness(smsProtection),
    smsProviderAvailable: availability.sms.available,
    smsDeliveryEnabled: availability.sms.available && smsProtection.sms !== null,
  }));
  // AUTH C1.4-B-1: email limits, statuses only; limits alone never enable email (provider is separate).
  deps.log(JSON.stringify({
    event: 'auth.email_protection',
    ...emailProtectionReadiness(smsProtection),
    emailProviderAvailable: availability.email.available,
    emailDeliveryEnabled: availability.email.available && smsProtection.email !== null,
  }));
  deps.gate.configure(config);
  // Express trusts only the direct peer, and only if it is a configured proxy (same matching as
  // the gate, which has already required a proxy of the receiving listener).
  deps.setTrustProxy(createExpressProxyTrust(config));

  // Only the configured listener(s); an instance never opens a listener it was not assigned.
  // The all-in-one local process (public,admin, accepted only in development) binds loopback so it is
  // never reachable from the LAN; public via 127.0.0.1 and Admin via ::1 keep the two proxy peers
  // distinct. A single-listener instance (one per container under Compose) binds the container
  // interface so its own Nginx can reach it; the trusted-proxy gate still applies.
  const developmentListenerHosts = { public: '127.0.0.1', admin: '::1' } as const;
  const localAllInOne = config.mode === 'development' && activeListeners.includes('public') && activeListeners.includes('admin');
  const specs: ListenerSpec[] = activeListeners.map((name) => ({
    name,
    port: config.listenerPorts[name],
    host: localAllInOne ? developmentListenerHosts[name] : '0.0.0.0',
  }));
  // Recovery is owned by the public instance; an Admin-only instance gets a handle that never runs.
  const ownsRecovery = activeListeners.includes('public');

  // Online-exam settings are validated once, before the database check and before listen().
  // Invalid settings stop startup (exit code 1); only the setting name and rule are logged.
  // The validated object is cached by getOnlineExamConfig, so the routes, the attempt list
  // and the recovery scheduler all use the same settings.
  // Automatic recovery (P0-4) starts exactly once, only after ALL configured listeners are
  // listening (never on partial startup), only on the instance that runs the public listener, and
  // is disabled, with no timer and no database work, unless ONLINE_EXAM_RECOVERY_SINCE is set. Each listener tags its requests server-side
  // (createListenerRequestHandler); the surface gate checks that tag against socket.localPort.
  // A listener error after binding marks the API not ready and runs the shared shutdown (exit 1).
  const runtime = await startApiRuntime({
    specs,
    createServer: (spec) => deps.createServer(createListenerRequestHandler<IncomingMessage, ServerResponse>(spec.name, deps.gate.tagListener, deps.handle)),
    loadOnlineExamConfig: deps.loadOnlineExamConfig,
    checkDatabase: deps.checkDatabase,
    startRecovery: ownsRecovery ? deps.startRecovery : () => NO_RECOVERY_HANDLE,
    markReady: () => {
      deps.gate.markReady();
      deps.log(`ELTNOY API listening: ${specs.map((spec) => `${spec.name} on port ${spec.port}`).join(', ')}.`);
    },
    markNotReady: () => deps.gate.markNotReady(),
    onFatalListenerError: (entry) => deps.logError(JSON.stringify(entry)),
    endPool: deps.endPool,
    exit: (code) => {
      deps.flushRejections();
      deps.exit(code);
    },
  });
  if (!runtime) {
    await deps.endPool();
    deps.setExitCode(1);
    return null;
  }

  // Idempotent: repeated SIGINT/SIGTERM (and fatal listener errors) reuse the first shutdown.
  // Order: mark not ready, stop recovery (waits for an in-flight sweep), close this instance's listener(s),
  // end the pool, flush the rejection summary, exit.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    deps.onSignal(signal, () => {
      void runtime.shutdown(signal);
    });
  }
  return runtime;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startApi().catch(async (error: unknown) => {
    if (error instanceof ListenerStartupError) {
      console.error(JSON.stringify({ event: 'api.listener_start_failed', listener: error.listener, code: error.code }));
    } else {
      console.error('API startup failed. Check DATABASE_URL, database availability, and network access:', error);
    }
    await pool.end();
    process.exitCode = 1;
  });
}
