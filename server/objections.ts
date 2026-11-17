import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { requireAuth, requireRoles } from './auth.js';
import { pool } from './db.js';
import { asyncRoute, getUser, isUniqueViolation, publicWriteLimiter, sendValidationError } from './http.js';
import { OBJECTION_CATEGORIES, isWindowOpen, objectionOutcome, questionStatus } from './objectionRules.js';
import { assertOwnedFile } from './uploads.js';

const examCodeSchema = z.string().trim().min(2).max(30).transform((value) => value.toUpperCase());

function toWindow(row: Record<string, unknown> | undefined) {
  return {
    isOpen: isWindowOpen(row as { is_open?: boolean; closes_at?: string | null } | undefined),
    closesAt: row?.closes_at ?? null,
  };
}

function toObjection(row: Record<string, unknown>) {
  return {
    id: row.id,
    referenceNumber: row.reference_number,
    examCode: row.exam_code,
    questionNumber: row.question_number,
    officialKey: row.official_key,
    proposedKey: row.proposed_key,
    category: row.category,
    justification: row.justification,
    referenceSource: row.reference_source,
    documentFileId: row.document_file_id,
    documentName: row.document_name ?? null,
    status: row.status,
    resolution: row.resolution,
    reviewerRemarks: row.reviewer_remarks,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

export function registerObjectionRoutes(app: Express): void {
  // Public answer key, with per-question challenge status and the objection window.
  app.get('/api/answer-keys', asyncRoute(async (request, response) => {
    const parsed = examCodeSchema.safeParse(request.query.examCode);
    if (!parsed.success) {
      sendValidationError(response, new z.ZodError([{ code: 'custom', path: ['examCode'], message: 'A valid examCode query is required.' }]));
      return;
    }
    const [questions, window] = await Promise.all([
      pool.query(
        `SELECT q.question_number, q.subject, q.question_text, q.options, q.official_key, q.explanation,
                q.original_key, q.is_dropped,
                (SELECT count(*)::int FROM answer_key_objections o
                 WHERE o.exam_code = q.exam_code AND o.question_number = q.question_number AND o.status = 'pending') AS pending_objections
         FROM answer_key_questions q
         WHERE q.exam_code = $1 AND q.is_published = true ORDER BY q.question_number`,
        [parsed.data],
      ),
      pool.query('SELECT is_open, closes_at FROM answer_key_objection_windows WHERE exam_code = $1', [parsed.data]),
    ]);
    response.json({
      questions: questions.rows.map((row) => ({
        question_number: row.question_number,
        subject: row.subject,
        question_text: row.question_text,
        options: row.options,
        official_key: row.official_key,
        original_key: row.original_key,
        explanation: row.explanation,
        status: questionStatus(row),
      })),
      objectionWindow: toWindow(window.rows[0]),
    });
  }));

  app.get('/api/answer-keys/objections/mine', requireAuth, requireRoles('candidate'), asyncRoute(async (request, response) => {
    const user = getUser(request);
    const { rows } = await pool.query(
      `SELECT o.*, f.original_name AS document_name
       FROM answer_key_objections o LEFT JOIN uploaded_files f ON f.id = o.document_file_id
       WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 200`,
      [user?.id],
    );
    response.json({ objections: rows.map(toObjection) });
  }));

  app.post('/api/answer-keys/objections', requireAuth, requireRoles('candidate'), publicWriteLimiter, asyncRoute(async (request, response) => {
    const parsed = z.object({
      examCode: examCodeSchema,
      questionNumber: z.number().int().positive(),
      proposedKey: z.enum(['A', 'B', 'C', 'D', 'NONE']),
      category: z.enum(OBJECTION_CATEGORIES),
      justification: z.string().trim().min(15, 'Justification must be at least 15 characters.').max(3000),
      referenceSource: z.string().trim().min(5, 'Cite a reference of at least 5 characters.').max(500),
      documentFileId: z.string().uuid().optional(),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const input = parsed.data;
    const user = getUser(request)!;

    const [window, question, application] = await Promise.all([
      pool.query('SELECT is_open, closes_at FROM answer_key_objection_windows WHERE exam_code = $1', [input.examCode]),
      pool.query(
        `SELECT official_key, is_dropped FROM answer_key_questions
         WHERE exam_code = $1 AND question_number = $2 AND is_published = true`,
        [input.examCode, input.questionNumber],
      ),
      pool.query('SELECT 1 FROM applications WHERE user_id = $1 AND exam_code = $2', [user.id, input.examCode]),
    ]);
    if (!isWindowOpen(window.rows[0])) {
      response.status(409).json({ error: 'The objection window for this exam is closed.' });
      return;
    }
    if (!question.rows[0]) {
      response.status(404).json({ error: 'That question is not in the published answer key.' });
      return;
    }
    if (question.rows[0].is_dropped) {
      response.status(409).json({ error: 'This question has already been dropped from evaluation.' });
      return;
    }
    if (!application.rows[0]) {
      response.status(403).json({ error: 'Only candidates who applied for this exam can file objections.' });
      return;
    }
    if (input.proposedKey === question.rows[0].official_key) {
      response.status(400).json({ error: 'Your proposed answer is the same as the official key.' });
      return;
    }
    if (input.documentFileId && !(await assertOwnedFile(pool, input.documentFileId, user.id, 'objection_document'))) {
      response.status(400).json({ error: 'Upload the supporting document again, then resubmit.' });
      return;
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO answer_key_objections
         (id, reference_number, user_id, exam_code, question_number, official_key, proposed_key, category,
          justification, reference_source, document_file_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [randomUUID(), `OBJ-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, user.id,
          input.examCode, input.questionNumber, question.rows[0].official_key, input.proposedKey, input.category,
          input.justification, input.referenceSource, input.documentFileId ?? null],
      );
      response.status(201).json({ objection: toObjection(rows[0]) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        response.status(409).json({ error: 'You have already filed an objection for this question.' });
        return;
      }
      throw error;
    }
  }));

  app.get('/api/admin/objections', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
    const parsed = examCodeSchema.safeParse(request.query.examCode);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const [objections, questions, window] = await Promise.all([
      pool.query(
        `SELECT o.*, u.login_id, u.display_name, f.original_name AS document_name
         FROM answer_key_objections o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN uploaded_files f ON f.id = o.document_file_id
         WHERE o.exam_code = $1
         ORDER BY o.question_number, o.created_at`,
        [parsed.data],
      ),
      pool.query(
        `SELECT question_number, subject, question_text, options, official_key, original_key, is_dropped
         FROM answer_key_questions WHERE exam_code = $1 ORDER BY question_number`,
        [parsed.data],
      ),
      pool.query('SELECT is_open, closes_at FROM answer_key_objection_windows WHERE exam_code = $1', [parsed.data]),
    ]);
    response.json({
      objectionWindow: toWindow(window.rows[0]),
      questions: questions.rows,
      objections: objections.rows.map((row) => ({
        ...toObjection(row),
        candidateLoginId: row.login_id,
        candidateName: row.display_name,
      })),
    });
  }));

  app.put('/api/admin/objection-windows/:examCode', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
    const examCode = examCodeSchema.safeParse(request.params.examCode);
    const parsed = z.object({
      isOpen: z.boolean(),
      closesAt: z.string().datetime({ offset: true }).nullable().optional(),
    }).safeParse(request.body);
    if (!examCode.success || !parsed.success) {
      sendValidationError(response, (examCode.error ?? parsed.error)!);
      return;
    }
    if (parsed.data.isOpen && parsed.data.closesAt && new Date(parsed.data.closesAt).getTime() <= Date.now()) {
      response.status(400).json({ error: 'The closing time must be in the future.' });
      return;
    }
    const published = await pool.query(
      'SELECT 1 FROM answer_key_questions WHERE exam_code = $1 AND is_published = true LIMIT 1',
      [examCode.data],
    );
    if (parsed.data.isOpen && !published.rows[0]) {
      response.status(409).json({ error: 'Publish the answer key before opening objections.' });
      return;
    }
    const user = getUser(request);
    const { rows } = await pool.query(
      `INSERT INTO answer_key_objection_windows (exam_code, is_open, closes_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (exam_code) DO UPDATE SET
         is_open = EXCLUDED.is_open, closes_at = EXCLUDED.closes_at,
         updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING is_open, closes_at`,
      [examCode.data, parsed.data.isOpen, parsed.data.closesAt ?? null, user?.id],
    );
    response.json({ examCode: examCode.data, objectionWindow: toWindow(rows[0]) });
  }));

  app.post('/api/admin/answer-keys/:examCode/questions/:questionNumber/decision', requireAuth, requireRoles('official'), asyncRoute(async (request, response) => {
    const examCode = examCodeSchema.safeParse(request.params.examCode);
    const questionNumber = z.coerce.number().int().positive().safeParse(request.params.questionNumber);
    const parsed = z.discriminatedUnion('decision', [
      z.object({ decision: z.literal('key_changed'), newKey: z.enum(['A', 'B', 'C', 'D']), remarks: z.string().trim().min(5).max(1000) }),
      z.object({ decision: z.literal('question_dropped'), remarks: z.string().trim().min(5).max(1000) }),
      z.object({ decision: z.literal('no_change'), remarks: z.string().trim().min(5).max(1000) }),
    ]).safeParse(request.body);
    if (!examCode.success || !questionNumber.success || !parsed.success) {
      sendValidationError(response, (examCode.error ?? questionNumber.error ?? parsed.error)!);
      return;
    }
    const decision = parsed.data;
    const user = getUser(request);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT official_key, original_key, is_dropped FROM answer_key_questions
         WHERE exam_code = $1 AND question_number = $2 FOR UPDATE`,
        [examCode.data, questionNumber.data],
      );
      const question = rows[0];
      if (!question) {
        await client.query('ROLLBACK');
        response.status(404).json({ error: 'Question not found in this answer key.' });
        return;
      }
      if (decision.decision === 'key_changed' && decision.newKey === question.official_key) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: 'Choose a key different from the current official key.' });
        return;
      }
      if (decision.decision === 'key_changed') {
        await client.query(
          `UPDATE answer_key_questions SET official_key = $3, original_key = COALESCE(original_key, official_key)
           WHERE exam_code = $1 AND question_number = $2`,
          [examCode.data, questionNumber.data, decision.newKey],
        );
      } else if (decision.decision === 'question_dropped') {
        await client.query(
          'UPDATE answer_key_questions SET is_dropped = true WHERE exam_code = $1 AND question_number = $2',
          [examCode.data, questionNumber.data],
        );
      }
      const pending = await client.query(
        `SELECT id, proposed_key FROM answer_key_objections
         WHERE exam_code = $1 AND question_number = $2 AND status = 'pending' FOR UPDATE`,
        [examCode.data, questionNumber.data],
      );
      for (const objection of pending.rows) {
        await client.query(
          `UPDATE answer_key_objections
           SET status = $2, resolution = $3, reviewer_remarks = $4, reviewed_by = $5, reviewed_at = now()
           WHERE id = $1`,
          [objection.id, objectionOutcome(decision.decision, objection.proposed_key, 'newKey' in decision ? decision.newKey : undefined),
            decision.decision, decision.remarks, user?.id],
        );
      }
      await client.query('COMMIT');
      response.json({ examCode: examCode.data, questionNumber: questionNumber.data, decision: decision.decision, resolved: pending.rows.length });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }));
}
