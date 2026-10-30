import 'dotenv/config';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { AuthenticatedRequest, SESSION_TTL_MS, hashSessionToken, newSessionToken, requireAuth, requireRoles, setSessionCookie } from './auth.js';
import { pool } from './db.js';
import { scoreMockResponses } from './mockScoring.js';

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
    fee: row.fee,
    duration: row.duration,
    mode: row.mode,
    shifts: row.shifts,
    isPublished: row.is_published,
  };
}

app.get('/api/health', asyncRoute(async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ status: 'ok', database: 'connected' });
}));

app.get('/api/exams', asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, code, name, category, target_audience, registration_start, registration_end,
            exam_date, fee, duration, mode, shifts, is_published
     FROM exams WHERE is_published = true
     ORDER BY exam_date ASC LIMIT 100`,
  );
  response.json({ exams: rows.map(toExam) });
}));

app.get('/api/admin/exams', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, code, name, category, target_audience, registration_start, registration_end,
            exam_date, fee, duration, mode, shifts, is_published, created_at, updated_at
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

const examSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(3).max(160),
  category: z.enum(['Undergraduate', 'Scholarship', 'Teacher', 'Professional']),
  targetAudience: z.string().trim().min(3).max(200),
  regStart: z.string().date(),
  regEnd: z.string().date(),
  examDate: z.string().date(),
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
      fee, duration, mode, shifts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, code, name, category, target_audience, registration_start, registration_end,
               exam_date, fee, duration, mode, shifts, is_published`,
    [randomUUID(), exam.code.toUpperCase(), exam.name, exam.category, exam.targetAudience,
      exam.regStart, exam.regEnd, exam.examDate, exam.fee, exam.duration, exam.mode, exam.shifts],
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
               exam_date, fee, duration, mode, shifts, is_published`,
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

app.post('/api/feedback', publicWriteLimiter, asyncRoute(async (request, response) => {
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
    `SELECT code FROM exams
     WHERE code = $1 AND is_published = true
       AND CURRENT_DATE BETWEEN registration_start AND registration_end`,
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
    applicationNumber = `APP-${new Date().getFullYear()}-${randomInt(100000, 1_000_000)}`;
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
    `INSERT INTO published_results (id, application_number, roll_number, exam_code, date_of_birth, scorecard)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (exam_code, roll_number) DO UPDATE SET
       application_number = EXCLUDED.application_number, date_of_birth = EXCLUDED.date_of_birth,
       scorecard = EXCLUDED.scorecard, published_at = now()
     RETURNING id, application_number, roll_number, exam_code, published_at`,
    [randomUUID(), result.applicationNumber.toUpperCase(), result.rollNumber.toUpperCase(),
      result.examCode.toUpperCase(), result.dateOfBirth, result.scorecard],
  );
  response.status(201).json({ result: rows[0] });
}));

app.get('/api/admin/results', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT id, application_number, roll_number, exam_code, published_at
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
       AND date_of_birth = $2 AND exam_code = $3
     LIMIT 1`,
    [identifier.toUpperCase(), dateOfBirth, examCode.toUpperCase()],
  );
  if (!rows[0]) {
    response.status(404).json({ error: 'No published result matches those details.' });
    return;
  }
  response.json({ scorecard: rows[0].scorecard });
}));

app.post('/api/mock-exams/submit', publicWriteLimiter, asyncRoute(async (request, response) => {
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
  const { rows } = await pool.query(
    `INSERT INTO mock_exam_attempts
     (id, user_id, responses, total_questions, attempted, correct, incorrect, unattempted,
      total_score, max_score, percentage, section_scores)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, submitted_at`,
    [randomUUID(), user?.id ?? null, parsed.data.responses, score.totalQuestions, score.attempted,
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
