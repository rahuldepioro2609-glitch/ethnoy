import 'dotenv/config';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { AuthenticatedRequest, SESSION_TTL_MS, hashSessionToken, newSessionToken, optionalAuth, requireAuth, requireRoles, setSessionCookie } from './auth.js';
import { addWorkbookSheet, readWorkbookSheet, WORKBOOK_MIME_TYPE } from './adminWorkbook.js';
import { pool } from './db.js';
import { scoreMockResponses } from './mockScoring.js';
import { DEFAULT_EXAM_TIME_ZONE, isValidTimeZone } from '../src/utils/examSchedule.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const sessionSeconds = Math.floor(SESSION_TTL_MS / 1000);

app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      styleSrc: ["'self'", "'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
    },
  },
}));
app.use(express.json({ limit: '32kb' }));
app.use((request, response, next) => {
  const origin = request.get('origin');
  const allowedOrigin = process.env.APP_ORIGIN;
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (isMutation && origin && allowedOrigin && origin !== allowedOrigin) {
    response.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }
  next();
});

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
  const { rows } = await pool.query(
    `INSERT INTO portal_notices
     (id, title, category, summary, full_content, reference_number, is_published, created_by, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, now())
     RETURNING id, title, category, summary, full_content, reference_number,
               is_published, created_at, published_at`,
    [randomUUID(), parsed.data.title, parsed.data.category, parsed.data.summary,
      parsed.data.fullContent, parsed.data.referenceNumber.toUpperCase(), user?.id],
  );
  response.status(201).json({ notice: rows[0] });
}));

app.patch('/api/admin/notices/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { rows } = await pool.query(
    `UPDATE portal_notices
     SET is_published = $2, published_at = CASE WHEN $2 THEN now() ELSE published_at END
     WHERE id = $1
     RETURNING id, title, category, summary, full_content, reference_number,
               is_published, created_at, published_at`,
    [request.params.id, parsed.data.isPublished],
  );
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

app.get('/api/admin/data-export', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
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
  response.type(WORKBOOK_MIME_TYPE);
  response.setHeader('Content-Disposition', 'attachment; filename="eltnoy-admin-data.xlsx"');
  response.send(Buffer.from(buffer));
}));

app.post('/api/admin/admit-cards/import', requireAuth, requireRoles('official'), workbookUpload, asyncRoute(async (request, response) => {
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const examCode of new Set(parsed.flatMap((item) => item.success ? [item.data.examCode.toUpperCase()] : []))) {
      await client.query('UPDATE answer_key_questions SET is_published = false WHERE exam_code = $1', [examCode]);
    }
    for (const item of parsed) {
      if (!item.success) continue;
      const key = item.data;
      await client.query(
        `INSERT INTO answer_key_questions
         (id, exam_code, question_number, subject, question_text, options, official_key, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (exam_code, question_number) DO UPDATE SET
           subject = EXCLUDED.subject, question_text = EXCLUDED.question_text, options = EXCLUDED.options,
           official_key = EXCLUDED.official_key, explanation = EXCLUDED.explanation, is_published = false`,
        [randomUUID(), key.examCode.toUpperCase(), key.questionNumber, key.subject, key.questionText,
          { A: key.optionA, B: key.optionB, C: key.optionC, D: key.optionD }, key.officialKey, key.explanation ?? ''],
      );
    }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const activeAttempts = await client.query(
      'SELECT 1 FROM online_exam_attempts WHERE exam_code = $1 LIMIT 1',
      [[...exams][0]],
    );
    if (activeAttempts.rows[0]) {
      await client.query('ROLLBACK');
      response.status(409).json({ error: 'This exam already has attempts. Create a new exam code to preserve its question and scoring history.' });
      return;
    }
    await client.query('UPDATE online_exam_questions SET is_published = false WHERE exam_code = $1', [[...exams][0]]);
    for (const item of parsed) {
      if (!item.success) continue;
      const question = item.data;
      await client.query(
        `INSERT INTO online_exam_questions
         (id, exam_code, exam_name, duration_minutes, question_number, section, question_text, options, correct_option, points)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (exam_code, question_number) DO UPDATE SET
           exam_name = EXCLUDED.exam_name, duration_minutes = EXCLUDED.duration_minutes, section = EXCLUDED.section,
           question_text = EXCLUDED.question_text, options = EXCLUDED.options,
           correct_option = EXCLUDED.correct_option, points = EXCLUDED.points, is_published = false`,
        [randomUUID(), question.examCode.toUpperCase(), question.examName, question.durationMinutes,
          question.questionNumber, question.section, question.questionText,
          { A: question.optionA, B: question.optionB, C: question.optionC, D: question.optionD },
          question.correctOption, question.points],
      );
    }
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
      await client.query(
        `INSERT INTO published_results (id, application_number, roll_number, exam_code, date_of_birth, scorecard, is_published)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (exam_code, roll_number) DO UPDATE SET
           application_number = EXCLUDED.application_number, date_of_birth = EXCLUDED.date_of_birth,
           scorecard = EXCLUDED.scorecard, is_published = false, published_at = now()`,
        [randomUUID(), result.applicationNumber.toUpperCase(), result.rollNumber.toUpperCase(),
          result.examCode.toUpperCase(), result.dateOfBirth, result.scorecard],
      );
    }
    await client.query('COMMIT');
    response.status(201).json({ imported: normalizedRows.length, published: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.patch('/api/admin/answer-keys/:examCode', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { rowCount } = await pool.query(
    'UPDATE answer_key_questions SET is_published = $2 WHERE exam_code = $1',
    [request.params.examCode.toUpperCase(), parsed.data.isPublished],
  );
  if (!rowCount) {
    response.status(404).json({ error: 'No answer key questions found for this exam.' });
    return;
  }
  response.json({ examCode: request.params.examCode.toUpperCase(), updated: rowCount, isPublished: parsed.data.isPublished });
}));

app.patch('/api/admin/online-exams/:examCode', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { rowCount } = await pool.query(
    'UPDATE online_exam_questions SET is_published = $2 WHERE exam_code = $1',
    [request.params.examCode.toUpperCase(), parsed.data.isPublished],
  );
  if (!rowCount) {
    response.status(404).json({ error: 'No online exam questions found for this exam.' });
    return;
  }
  response.json({ examCode: request.params.examCode.toUpperCase(), updated: rowCount, isPublished: parsed.data.isPublished });
}));

app.get('/api/answer-keys/exams', asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    'SELECT DISTINCT exam_code FROM answer_key_questions WHERE is_published = true ORDER BY exam_code',
  );
  response.json({ examCodes: rows.map((row) => row.exam_code) });
}));

app.get('/api/answer-keys', asyncRoute(async (request, response) => {
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
  const attempts = await pool.query(
    `SELECT exam_code, started_at, expires_at, submitted_at, score
     FROM online_exam_attempts WHERE user_id = $1`,
    [user?.id],
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
    response.status(409).json({ error: 'An attempt has already been started or submitted for this exam.' });
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

app.patch('/api/online-exams/:examCode/attempt', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    attemptId: z.string().uuid(),
    responses: z.record(z.string(), z.enum(['A', 'B', 'C', 'D'])),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const examCode = request.params.examCode.toUpperCase();
  const { rows: questions } = await pool.query(
    'SELECT question_number FROM online_exam_questions WHERE exam_code = $1',
    [examCode],
  );
  const questionNumbers = new Set(questions.map((question) => String(question.question_number)));
  const responses = Object.fromEntries(
    Object.entries(parsed.data.responses).filter(([questionNumber]) => questionNumbers.has(questionNumber)),
  );
  const { rowCount } = await pool.query(
    `UPDATE online_exam_attempts SET responses = $4
     WHERE id = $1 AND user_id = $2 AND exam_code = $3
       AND submitted_at IS NULL AND expires_at > now()`,
    [parsed.data.attemptId, user?.id, examCode, responses],
  );
  if (!rowCount) {
    response.status(409).json({ error: 'This exam attempt is missing, expired, or already submitted.' });
    return;
  }
  response.json({ saved: true });
}));

app.post('/api/online-exams/:examCode/submit', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    attemptId: z.string().uuid(),
    responses: z.record(z.string(), z.enum(['A', 'B', 'C', 'D'])),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const user = getUser(request);
  const examCode = request.params.examCode.toUpperCase();
  const attempt = await pool.query(
    `SELECT id FROM online_exam_attempts
     WHERE id = $1 AND user_id = $2 AND exam_code = $3
       AND submitted_at IS NULL AND expires_at > now()`,
    [parsed.data.attemptId, user?.id, examCode],
  );
  if (!attempt.rows[0]) {
    response.status(409).json({ error: 'This exam attempt is missing, expired, or already submitted.' });
    return;
  }
  const { rows: questions } = await pool.query(
    `SELECT question_number, correct_option, points, section
     FROM online_exam_questions WHERE exam_code = $1`,
    [examCode],
  );
  const questionNumbers = new Set(questions.map((question) => String(question.question_number)));
  const responses = Object.fromEntries(
    Object.entries(parsed.data.responses).filter(([questionNumber]) => questionNumbers.has(questionNumber)),
  );
  let correct = 0;
  let totalScore = 0;
  let maxScore = 0;
  const sectionScores: Record<string, { correct: number; total: number; score: number; maxScore: number }> = {};
  for (const question of questions) {
    const section = String(question.section);
    sectionScores[section] ??= { correct: 0, total: 0, score: 0, maxScore: 0 };
    const points = Number(question.points);
    maxScore += points;
    sectionScores[section].total += 1;
    sectionScores[section].maxScore += points;
    if (responses[String(question.question_number)] === question.correct_option) {
      correct += 1;
      totalScore += points;
      sectionScores[section].correct += 1;
      sectionScores[section].score += points;
    }
  }
  const score = {
    totalQuestions: questions.length,
    attempted: Object.keys(responses).length,
    correct,
    incorrect: Math.max(0, Object.keys(responses).length - correct),
    unattempted: Math.max(0, questions.length - Object.keys(responses).length),
    totalScore,
    maxScore,
    percentage: maxScore ? Math.round((totalScore / maxScore) * 100) : 0,
    sectionScores,
  };
  const { rows } = await pool.query(
    `UPDATE online_exam_attempts SET submitted_at = now(), responses = $3, score = $4
     WHERE id = $1 AND user_id = $2 AND submitted_at IS NULL AND expires_at > now()
     RETURNING submitted_at`,
    [parsed.data.attemptId, user?.id, responses, score],
  );
  if (!rows[0]) {
    response.status(409).json({ error: 'This exam attempt has expired or was already submitted.' });
    return;
  }
  response.json({ submittedAt: rows[0].submitted_at, score });
}));


app.get('/api/health', asyncRoute(async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ status: 'ok', database: 'connected' });
}));

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
  const parsed = z.object({ status: z.enum(['approved', 'rejected']) }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { rows } = await pool.query(
    `UPDATE users SET account_status = $2
     WHERE id = $1 AND role = 'center' AND account_status = 'pending'
     RETURNING id, login_id, display_name, contact_email, registration_number,
               registered_address, website, account_status, created_at`,
    [request.params.id, parsed.data.status],
  );
  if (!rows[0]) {
    response.status(404).json({ error: 'Pending institute request not found.' });
    return;
  }
  response.json({ institute: rows[0] });
}));

app.get('/api/institute-forms', asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.form_type, f.title, f.description, f.eligibility,
            f.application_deadline, f.external_url, f.created_at,
            u.display_name AS institute_name, u.contact_email
     FROM institute_forms f
     JOIN users u ON u.id = f.institute_id
     WHERE f.status = 'approved' AND u.account_status = 'approved'
     ORDER BY f.created_at DESC LIMIT 200`,
  );
  response.json({ forms: rows });
}));

app.get('/api/center/workspace', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const [profile, forms, profileChanges, entries, withdrawals, balance] = await Promise.all([
    pool.query(
      `SELECT display_name, contact_email, registration_number, registered_address, website
       FROM users WHERE id = $1 AND role = 'center'`,
      [user?.id],
    ),
    pool.query(
      `SELECT id, form_type, title, description, eligibility, application_deadline,
              external_url, status, created_at
       FROM institute_forms WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [user?.id],
    ),
    pool.query(
      `SELECT id, display_name, contact_email, registration_number, registered_address,
              website, status, created_at
       FROM institute_profile_changes WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [user?.id],
    ),
    pool.query(
      `SELECT id, entry_type, amount_paise, description, payment_reference,
              transfer_reference, created_at
       FROM institute_wallet_entries WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [user?.id],
    ),
    pool.query(
      `SELECT id, amount_paise, status, transfer_reference, created_at, reviewed_at
       FROM institute_withdrawals WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [user?.id],
    ),
    pool.query(
      `SELECT
         COALESCE((SELECT SUM(CASE WHEN entry_type = 'credit' THEN amount_paise ELSE -amount_paise END)
                   FROM institute_wallet_entries WHERE institute_id = $1), 0)::text AS balance_paise,
         COALESCE((SELECT SUM(amount_paise) FROM institute_withdrawals
                   WHERE institute_id = $1 AND status IN ('pending', 'approved')), 0)::text AS reserved_paise`,
      [user?.id],
    ),
  ]);
  const wallet = balance.rows[0];
  response.json({
    profile: profile.rows[0],
    forms: forms.rows,
    profileChanges: profileChanges.rows,
    entries: entries.rows,
    withdrawals: withdrawals.rows,
    balancePaise: wallet.balance_paise,
    availablePaise: (BigInt(wallet.balance_paise) - BigInt(wallet.reserved_paise)).toString(),
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
  const { rows } = await pool.query(
    `INSERT INTO institute_forms
     (id, institute_id, form_type, title, description, eligibility, application_deadline, external_url)
     VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::date, NULLIF($8, ''))
     RETURNING id, form_type, title, description, eligibility, application_deadline,
               external_url, status, created_at`,
    [randomUUID(), user?.id, parsed.data.formType, parsed.data.title, parsed.data.description,
      parsed.data.eligibility, parsed.data.applicationDeadline || '', parsed.data.externalUrl || ''],
  );
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
    const { rows } = await pool.query(
      `INSERT INTO institute_profile_changes
       (id, institute_id, display_name, contact_email, registration_number, registered_address, website)
       VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''))
       RETURNING id, display_name, contact_email, registration_number, registered_address,
                 website, status, created_at`,
      [randomUUID(), user?.id, parsed.data.displayName, parsed.data.contactEmail.toLowerCase(),
        parsed.data.registrationNumber, parsed.data.registeredAddress, parsed.data.website || ''],
    );
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
    await client.query('COMMIT');
    response.status(201).json({ withdrawal: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/admin/institute-management', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
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
    pool.query(
      `SELECT w.id, w.institute_id, w.amount_paise, w.status, w.transfer_reference, w.created_at,
              u.display_name AS institute_name, u.login_id
       FROM institute_withdrawals w JOIN users u ON u.id = w.institute_id
       ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, w.created_at DESC LIMIT 500`,
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
  const { rows } = await pool.query(
    `UPDATE institute_forms SET status = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING id, status`,
    [request.params.id, parsed.data.status, user?.id],
  );
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
    await client.query('COMMIT');
    response.json({ profileChange: { id: change.id, status: parsed.data.status } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/admin/institutes/:id/credits', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
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
  const { rows } = await pool.query(
    `INSERT INTO institute_wallet_entries
     (id, institute_id, entry_type, amount_paise, description, payment_reference, created_by)
     SELECT $1, id, 'credit', $3, $4, $5, $6 FROM users
     WHERE id = $2 AND role = 'center' AND account_status = 'approved'
     ON CONFLICT (payment_reference) DO NOTHING
     RETURNING id, institute_id, amount_paise, description, payment_reference, created_at`,
    [randomUUID(), request.params.id, parsed.data.amountPaise, parsed.data.description,
      parsed.data.paymentReference, user?.id],
  );
  if (!rows[0]) {
    response.status(409).json({ error: 'Institute was not found or this payment reference has already been credited.' });
    return;
  }
  response.status(201).json({ entry: rows[0] });
}));

app.patch('/api/admin/institute-withdrawals/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT w.* FROM institute_withdrawals w
       JOIN users u ON u.id = w.institute_id
       WHERE w.id = $1 AND u.role = 'center'
       FOR UPDATE OF u, w`,
      [request.params.id],
    );
    const withdrawal = rows[0];
    if (!withdrawal || withdrawal.status === 'paid' ||
        (parsed.data.status === 'approved' && withdrawal.status !== 'pending') ||
        (parsed.data.status === 'rejected' && !['pending', 'approved'].includes(withdrawal.status)) ||
        (parsed.data.status === 'paid' && withdrawal.status !== 'approved')) {
      await client.query('ROLLBACK');
      response.status(409).json({ error: 'This withdrawal cannot be moved to the requested status.' });
      return;
    }
    if (parsed.data.status === 'paid') {
      await client.query(
        `INSERT INTO institute_wallet_entries
         (id, institute_id, entry_type, amount_paise, description, transfer_reference, withdrawal_id, created_by)
         VALUES ($1, $2, 'debit', $3, $4, $5, $6, $7)`,
        [randomUUID(), withdrawal.institute_id, withdrawal.amount_paise,
          `Withdrawal ${withdrawal.id}`, parsed.data.transferReference, withdrawal.id, user?.id],
      );
    }
    const { rows: updated } = await client.query(
      `UPDATE institute_withdrawals
       SET status = $2, transfer_reference = CASE WHEN $2 = 'paid' THEN $3 ELSE NULL END,
           reviewed_by = $4, reviewed_at = now()
       WHERE id = $1
       RETURNING id, status, amount_paise, transfer_reference`,
      [withdrawal.id, parsed.data.status, parsed.data.transferReference || null, user?.id],
    );
    await client.query('COMMIT');
    response.json({ withdrawal: updated[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
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
  const { rows } = await pool.query(
    `INSERT INTO exams
     (id, code, name, category, target_audience, registration_start, registration_end, exam_date,
      time_zone, fee, duration, mode, shifts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, code, name, category, target_audience, registration_start, registration_end,
               exam_date, time_zone, fee, duration, mode, shifts, is_published`,
    [randomUUID(), exam.code.toUpperCase(), exam.name, exam.category, exam.targetAudience,
      exam.regStart, exam.regEnd, exam.examDate, exam.timeZone, exam.fee, exam.duration, exam.mode, exam.shifts],
  );
  response.status(201).json({ exam: toExam(rows[0]) });
}));

app.patch('/api/admin/exams/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { rows } = await pool.query(
    `UPDATE exams SET is_published = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, code, name, category, target_audience, registration_start, registration_end,
               exam_date, time_zone, fee, duration, mode, shifts, is_published`,
    [request.params.id, parsed.data.isPublished],
  );
  if (!rows[0]) {
    response.status(404).json({ error: 'Exam form not found.' });
    return;
  }
  response.json({ exam: toExam(rows[0]) });
}));

const accountRegistrationSchema = z.object({
  loginId: z.string().trim().min(4).max(50).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(128),
});

app.post('/api/auth/register', authLimiter, asyncRoute(async (request, response) => {
  const parsed = accountRegistrationSchema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { loginId, name, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO users (id, login_id, display_name, role, password_hash, account_status)
     VALUES ($1, $2, $3, 'candidate', $4, 'approved')
     ON CONFLICT (login_id) DO NOTHING
     RETURNING id, login_id, display_name, role`,
    [randomUUID(), loginId.toUpperCase(), name, passwordHash],
  );
  if (!rows[0]) {
    response.status(409).json({ error: 'That student login ID is already registered. Choose another.' });
    return;
  }
  const token = newSessionToken();
  await pool.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
    [hashSessionToken(token), rows[0].id, sessionSeconds],
  );
  setSessionCookie(response, token);
  response.status(201).json({
    user: { id: rows[0].id, loginId: rows[0].login_id, name: rows[0].display_name, role: rows[0].role },
  });
}));

app.post('/api/center/register', authLimiter, asyncRoute(async (request, response) => {
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
  const { loginId, name, password, contactEmail, registrationNumber, registeredAddress, website } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
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
    response.status(409).json({ error: 'That institute login ID is already in use. Choose another.' });
    return;
  }
  response.status(201).json({
    message: 'Institute request submitted. Super Admin will verify the registration details before approval.',
  });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (request, response) => {
  const schema = z.object({
    loginId: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(128),
    role: z.enum(['candidate', 'center', 'official']),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }

  const { loginId, password, role } = parsed.data;
  const { rows } = await pool.query(
    'SELECT id, login_id, display_name, role, password_hash, account_status FROM users WHERE login_id = $1 AND role = $2',
    [loginId.toUpperCase(), role],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    response.status(401).json({ error: 'Invalid login ID, password, or account type.' });
    return;
  }
  if (user.account_status !== 'approved') {
    response.status(403).json({
      error: user.account_status === 'pending'
        ? 'Institute registration is awaiting Super Admin approval.'
        : 'This account was not approved. Contact the portal administrator.',
    });
    return;
  }

  const token = newSessionToken();
  const tokenHash = hashSessionToken(token);
  await pool.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
    [tokenHash, user.id, sessionSeconds],
  );
  setSessionCookie(response, token);
  response.json({
    user: { id: user.id, loginId: user.login_id, name: user.display_name, role: user.role },
  });
}));

app.get('/api/auth/me', requireAuth, asyncRoute(async (request, response) => {
  const user = getUser(request);
  response.json({ user: { id: user?.id, loginId: user?.loginId, name: user?.name, role: user?.role } });
}));

app.post('/api/auth/logout', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthenticatedRequest;
  await pool.query(
    'UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [authRequest.sessionTokenHash],
  );
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

app.post('/api/feedback', optionalAuth, publicWriteLimiter, asyncRoute(async (request, response) => {
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

app.get('/api/admin/feedback', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const { rows } = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 500');
  response.json({ entries: rows.map(toFeedback) });
}));

app.patch('/api/admin/feedback/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    status: z.enum(['under_review', 'in_progress', 'resolved']),
    resolutionNote: z.string().trim().max(1000).optional(),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { rows } = await pool.query(
    `UPDATE feedback SET status = $2, resolution_note = $3
     WHERE id = $1 RETURNING *`,
    [request.params.id, parsed.data.status, parsed.data.resolutionNote ?? null],
  );
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
  const existingApplication = await pool.query(
    'SELECT application_number FROM applications WHERE user_id = $1 AND exam_code = $2',
    [user?.id, input.examCode.toUpperCase()],
  );
  if (existingApplication.rows[0]) {
    response.status(409).json({ error: 'You have already submitted an application for this exam.' });
    return;
  }
  const exam = await pool.query(
    `SELECT code, time_zone,
            extract(year FROM now() AT TIME ZONE time_zone)::int AS application_year
     FROM exams
     WHERE code = $1 AND is_published = true
       AND (now() AT TIME ZONE time_zone)::date BETWEEN registration_start AND registration_end`,
    [input.examCode.toUpperCase()],
  );
  if (!exam.rows[0]) {
    response.status(400).json({ error: 'Applications are not open for this exam.' });
    return;
  }
  const applicationId = randomUUID();
  let applicationNumber = '';
  let rows: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    applicationNumber = `APP-${exam.rows[0].application_year}-${randomInt(100000, 1_000_000)}`;
    const result = await pool.query(
      `INSERT INTO applications
       (id, user_id, application_number, exam_code, candidate_name, father_name, date_of_birth, gender, category, email, phone,
        first_city_preference, second_city_preference, language_medium)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT DO NOTHING RETURNING *`,
      [applicationId, user?.id, applicationNumber, input.examCode.toUpperCase(), input.candidateName,
        input.fatherName, input.dateOfBirth, input.gender, input.category, input.email.toLowerCase(),
        input.phone, input.firstCityPreference, input.secondCityPreference, input.languageMedium],
    );
    rows = result.rows;
    if (rows[0]) break;
  }
  if (!rows[0]) {
    response.status(409).json({ error: 'An application for this exam may already exist on your account.' });
    return;
  }
  response.status(201).json({
    application: {
      id: rows[0].id,
      applicationNumber: rows[0].application_number,
      examCode: rows[0].exam_code,
      status: rows[0].status,
      createdAt: rows[0].created_at,
    },
  });
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
  const { rows } = await pool.query(
    'UPDATE applications SET status = $2 WHERE id = $1 RETURNING id, application_number, status',
    [request.params.id, parsed.data.status],
  );
  if (!rows[0]) {
    response.status(404).json({ error: 'Application not found.' });
    return;
  }
  response.json({ application: rows[0] });
}));

app.get('/api/candidate/portal', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const { rows } = await pool.query(
    `SELECT a.application_number, a.exam_code, a.candidate_name, a.status, a.created_at,
            c.roll_number, c.exam_date, c.center_name, c.center_address
     FROM applications a
     LEFT JOIN admit_cards c ON c.application_id = a.id
     WHERE a.user_id = $1 OR (a.user_id IS NULL AND (a.application_number = $2 OR c.roll_number = $2))
     ORDER BY a.created_at DESC`,
    [user?.id, user?.loginId.toUpperCase()],
  );
  const attempts = await pool.query(
    `SELECT id, total_questions, attempted, correct, incorrect, unattempted,
            total_score, max_score, percentage, submitted_at
     FROM mock_exam_attempts WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 20`,
    [user?.id],
  );
  const results = await pool.query(
    `SELECT r.application_number, r.roll_number, r.exam_code, r.published_at
     FROM published_results r
     WHERE r.application_number IN (SELECT a.application_number FROM applications a WHERE a.user_id = $1)
        OR r.application_number = $2 OR r.roll_number = $2
        OR r.application_number IN (
          SELECT a.application_number FROM applications a
          JOIN admit_cards c ON c.application_id = a.id WHERE c.roll_number = $2
        )
     ORDER BY r.published_at DESC`,
    [user?.id, user?.loginId.toUpperCase()],
  );
  response.json({ applications: rows, attempts: attempts.rows, results: results.rows });
}));

app.put('/api/admin/applications/:id/admit-card', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
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
  const { rows } = await pool.query(
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
  if (!rows[0]) {
    response.status(404).json({ error: 'Application not found.' });
    return;
  }
  response.json({ admitCard: rows[0] });
}));

app.get('/api/center/checkins', requireAuth, requireRoles('center'), asyncRoute(async (request, response) => {
  const user = getUser(request);
  const { rows } = await pool.query(
    `SELECT c.id, c.status, c.note, c.updated_at, a.application_number, a.candidate_name,
            a.exam_code, card.roll_number
     FROM center_checkins c
     JOIN applications a ON a.id = c.application_id
     JOIN admit_cards card ON card.application_id = a.id
     WHERE c.center_code = $1
     ORDER BY c.updated_at DESC LIMIT 500`,
    [user?.loginId.toUpperCase()],
  );
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
  const { rows } = await pool.query(
    `INSERT INTO center_checkins (id, application_id, center_code, status, note, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (application_id, center_code) DO UPDATE SET
       status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id, status, note, updated_at`,
    [randomUUID(), application.rows[0].id, centerCode, parsed.data.status,
      parsed.data.note || null, user?.id],
  );
  response.status(200).json({ checkin: rows[0] });
}));

app.post('/api/admit-cards/lookup', publicWriteLimiter, asyncRoute(async (request, response) => {
  const parsed = z.object({
    applicationNumber: z.string().trim().min(4).max(100),
    dateOfBirth: z.string().date(),
    examCode: z.string().trim().min(2).max(30),
  }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { applicationNumber, dateOfBirth, examCode } = parsed.data;
  const { rows } = await pool.query(
    `SELECT a.application_number, a.candidate_name, a.father_name, a.date_of_birth,
            a.gender, a.category, a.exam_code,
            c.roll_number, c.exam_date, c.reporting_time, c.gate_closing_time,
            c.exam_timing, c.center_code, c.center_name, c.center_address
     FROM applications a JOIN admit_cards c ON c.application_id = a.id
     WHERE a.application_number = $1 AND a.date_of_birth = $2 AND a.exam_code = $3`,
    [applicationNumber.toUpperCase(), dateOfBirth, examCode.toUpperCase()],
  );
  if (!rows[0]) {
    response.status(404).json({ error: 'No published admit card matches those details.' });
    return;
  }
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
}));

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
  const { rows } = await pool.query(
    `INSERT INTO published_results (id, application_number, roll_number, exam_code, date_of_birth, scorecard, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     ON CONFLICT (exam_code, roll_number) DO UPDATE SET
       application_number = EXCLUDED.application_number, date_of_birth = EXCLUDED.date_of_birth,
       scorecard = EXCLUDED.scorecard, is_published = true, published_at = now()
     RETURNING id, application_number, roll_number, exam_code, published_at`,
    [randomUUID(), result.applicationNumber.toUpperCase(), result.rollNumber.toUpperCase(),
      result.examCode.toUpperCase(), result.dateOfBirth, result.scorecard],
  );
  response.status(201).json({ result: rows[0] });
}));

app.patch('/api/admin/results/:id', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
  const parsed = z.object({ isPublished: z.boolean() }).safeParse(request.body);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return;
  }
  const { rows } = await pool.query(
    `UPDATE published_results SET is_published = $2
     WHERE id = $1 RETURNING id, application_number, roll_number, exam_code, published_at, is_published`,
    [request.params.id, parsed.data.isPublished],
  );
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

app.post('/api/results/lookup', publicWriteLimiter, asyncRoute(async (request, response) => {
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
  const { rows } = await pool.query(
    `SELECT scorecard FROM published_results
     WHERE (roll_number = $1 OR application_number = $1)
       AND date_of_birth = $2 AND exam_code = $3 AND is_published = true
     LIMIT 1`,
    [identifier.toUpperCase(), dateOfBirth, examCode.toUpperCase()],
  );
  if (!rows[0]) {
    response.status(404).json({ error: 'No published result matches those details.' });
    return;
  }
  response.json({ scorecard: rows[0].scorecard });
}));

app.post('/api/mock-exams/submit', optionalAuth, publicWriteLimiter, asyncRoute(async (request, response) => {
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
  const { rows } = await pool.query(
    `SELECT id, total_questions, attempted, correct, incorrect, unattempted, total_score,
            max_score, percentage, section_scores, submitted_at
     FROM mock_exam_attempts WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 100`,
    [user?.id],
  );
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

async function startApi(): Promise<void> {
  await pool.query('SELECT 1');
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`ELTNOY API listening on port ${port}.`);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void pool.end().then(() => process.exit(0));
      });
    });
  }
}

void startApi().catch(async (error: unknown) => {
  console.error('API startup failed. Check DATABASE_URL, database availability, and network access:', error);
  await pool.end();
  process.exitCode = 1;
});
