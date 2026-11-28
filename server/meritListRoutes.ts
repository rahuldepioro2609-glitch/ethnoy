// Merit List Engine foundation: Super Admin routes (documentation/MERIT_LIST_GAP_ANALYSIS.md).
//
// Authorization: every route is Super Admin only on the Admin host (A-04 results and A-07 exports
// are Super Admin; ordinary Officials do not see marks today, so this never widens access).
// Institutes and Students have no route (F-4 / ML-8).
//
// - GET  /api/admin/merit-lists/:examCode/preview            computed order, ties, issues (read-only)
// - GET  /api/admin/merit-lists/:examCode/snapshots          version history (metadata)
// - POST /api/admin/merit-lists/:examCode/snapshots          save the CURRENT order as a new draft version
// - GET  /api/admin/merit-lists/snapshots/:snapshotId        one version with its entries
// - GET  /api/admin/merit-lists/snapshots/:snapshotId/export CSV, audited before it is sent
//
// There is deliberately no approve, publish, finalize, tie-break, cut-off or category route: those
// rules are not approved (ML-1 to ML-9). Results are never changed here.
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { auditActor, recordAuditEvent, runAuditedTransaction } from './audit.js';
import { requireAuth, requireRoles, requireSuperAdmin } from './auth.js';
import { pool as sharedPool } from './db.js';
import {
  analyseMeritResults, MERIT_ENGINE_VERSION, MERIT_ISSUE_TEXT, meritEntriesToCsv,
  type MeritAnalysis, type MeritEntry, type MeritResultRecord,
} from './meritList.js';

/** Larger exams are refused rather than computed in one request (a batch job is future work). */
export const MERIT_MAX_RESULTS = 20_000;

export const MERIT_SQL = Object.freeze({
  results: `SELECT id, application_number, roll_number, exam_code, is_published, scorecard
     FROM published_results WHERE exam_code = $1 ORDER BY id LIMIT $2`,
  // One creation at a time per exam; released at commit or rollback.
  lockExam: "SELECT pg_advisory_xact_lock(hashtext('eltnoy.merit_list:' || $1))",
  existingFingerprint: 'SELECT id, version FROM merit_list_snapshots WHERE exam_code = $1 AND input_fingerprint = $2',
  nextVersion: 'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM merit_list_snapshots WHERE exam_code = $1',
  insert: `INSERT INTO merit_list_snapshots
     (id, exam_code, version, engine_version, input_fingerprint, result_count, entry_count, excluded_count,
      tie_group_count, issue_count, entries, excluded, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
     RETURNING id, exam_code, version, status, created_at`,
  list: `SELECT id, exam_code, version, status, engine_version, input_fingerprint, result_count, entry_count,
            excluded_count, tie_group_count, issue_count, created_by, created_at
     FROM merit_list_snapshots WHERE exam_code = $1 ORDER BY version DESC LIMIT 100`,
  one: `SELECT id, exam_code, version, status, engine_version, input_fingerprint, result_count, entry_count,
            excluded_count, tie_group_count, issue_count, entries, excluded, created_by, created_at
     FROM merit_list_snapshots WHERE id = $1`,
});

const examCodeSchema = z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9._/-]+$/).transform((value) => value.toUpperCase());
const snapshotIdSchema = z.string().uuid();
const createSchema = z.object({
  /** The fingerprint of the preview the Super Admin reviewed: the saved version must be exactly that. */
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const GUARDS = [requireAuth, requireRoles('official'), requireSuperAdmin] as const;
type Database = Pick<Pool, 'query' | 'connect'>;

class MeritHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    response.set('Cache-Control', 'no-store');
    handler(request, response).catch((error: unknown) => {
      if (error instanceof MeritHttpError) {
        response.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
        return;
      }
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '42P01') {
        response.status(503).json({ error: 'Merit lists are not installed yet. Apply the merit-list migration.', code: 'MERIT_LIST_NOT_INSTALLED' });
        return;
      }
      next(error);
    });
  };
}

function examCodeOf(request: Request): string {
  const parsed = examCodeSchema.safeParse(request.params.examCode);
  if (!parsed.success) throw new MeritHttpError(400, 'Enter a valid exam code.', 'INVALID_EXAM_CODE');
  return parsed.data;
}

async function loadAnalysis(database: Pick<Pool, 'query'> | PoolClient, examCode: string): Promise<MeritAnalysis> {
  const { rows } = await database.query(MERIT_SQL.results, [examCode, MERIT_MAX_RESULTS + 1]);
  if (rows.length > MERIT_MAX_RESULTS) {
    throw new MeritHttpError(413, `This exam has more than ${MERIT_MAX_RESULTS} results; merit lists of this size are not supported yet.`, 'MERIT_LIST_TOO_LARGE');
  }
  const records: MeritResultRecord[] = rows.map((row: Record<string, unknown>) => ({
    resultId: String(row.id), applicationNumber: String(row.application_number), rollNumber: String(row.roll_number),
    examCode: String(row.exam_code), isPublished: row.is_published === true, scorecard: row.scorecard,
  }));
  return analyseMeritResults(examCode, records);
}

/** The stored form of an entry: no names, dates of birth, categories or section marks. */
function storedEntry(entry: MeritEntry) {
  return {
    resultId: entry.resultId, applicationNumber: entry.applicationNumber, rollNumber: entry.rollNumber, isPublished: entry.isPublished,
    totalMarks: entry.totalMarks, maxMarks: entry.maxMarks, positionFrom: entry.positionFrom, positionTo: entry.positionTo,
    tieGroup: entry.tieGroup, importedRank: entry.importedRank, issues: entry.issues,
  };
}

function snapshotView(row: Record<string, unknown>) {
  return {
    id: String(row.id), examCode: String(row.exam_code), version: Number(row.version), status: String(row.status),
    engineVersion: String(row.engine_version), fingerprint: String(row.input_fingerprint),
    resultCount: Number(row.result_count), entryCount: Number(row.entry_count), excludedCount: Number(row.excluded_count),
    tieGroupCount: Number(row.tie_group_count), issueCount: Number(row.issue_count),
    createdBy: String(row.created_by), createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

const BLOCKED_RULES = Object.freeze([
  'Tie-breaking (ML-1) and tied-rank numbering (ML-2)',
  'Qualification criteria (ML-3) and cut-offs (ML-4)',
  'Category-wise merit (ML-5)',
  'Approval and publication of merit lists (ML-6)',
]);

export function createMeritListRouter(options: { database?: Database } = {}): Router {
  const database = options.database ?? sharedPool;
  const router = express.Router();

  router.get('/admin/merit-lists/:examCode/preview', ...GUARDS, route(async (request, response) => {
    const analysis = await loadAnalysis(database, examCodeOf(request));
    response.json({ ...analysis, entries: analysis.entries.map(storedEntry), issueText: MERIT_ISSUE_TEXT, blockedRules: BLOCKED_RULES });
  }));

  router.get('/admin/merit-lists/:examCode/snapshots', ...GUARDS, route(async (request, response) => {
    const { rows } = await database.query(MERIT_SQL.list, [examCodeOf(request)]);
    response.json({ snapshots: rows.map(snapshotView) });
  }));

  router.post('/admin/merit-lists/:examCode/snapshots', ...GUARDS, route(async (request, response) => {
    const examCode = examCodeOf(request);
    const body = createSchema.safeParse(request.body ?? {});
    if (!body.success) throw new MeritHttpError(400, 'Preview the merit list first, then save the version you reviewed.', 'FINGERPRINT_REQUIRED');
    const actor = auditActor(request);
    const created = await runAuditedTransaction(database, async (client) => {
      await client.query(MERIT_SQL.lockExam, [examCode]);
      // Computed inside the lock and transaction, so the saved version is exactly what is stored now.
      const analysis = await loadAnalysis(client, examCode);
      if (analysis.fingerprint !== body.data.expectedFingerprint) {
        throw new MeritHttpError(409, 'The results changed after your preview. Preview again before saving.', 'RESULTS_CHANGED', { fingerprint: analysis.fingerprint });
      }
      const existing = await client.query(MERIT_SQL.existingFingerprint, [examCode, analysis.fingerprint]);
      if (existing.rows[0]) {
        throw new MeritHttpError(409, `These exact results are already saved as version ${existing.rows[0].version}.`, 'DUPLICATE_SNAPSHOT', {
          snapshotId: String(existing.rows[0].id), version: Number(existing.rows[0].version),
        });
      }
      if (analysis.entries.length === 0 && analysis.excluded.length === 0) throw new MeritHttpError(404, 'This exam has no result records.', 'NO_RESULTS');
      const version = Number((await client.query(MERIT_SQL.nextVersion, [examCode])).rows[0].next_version);
      const issueCount = analysis.summary.entriesWithIssues;
      const { rows } = await client.query(MERIT_SQL.insert, [
        randomUUID(), examCode, version, MERIT_ENGINE_VERSION, analysis.fingerprint, analysis.summary.resultCount,
        analysis.entries.length, analysis.excluded.length, analysis.tieGroups.length, issueCount,
        JSON.stringify(analysis.entries.map(storedEntry)), JSON.stringify(analysis.excluded), actor.type === 'user' ? actor.userId : 'operator',
      ]);
      await recordAuditEvent(client, {
        action: 'merit_list.snapshot_created', actor, resourceId: String(rows[0].id),
        metadata: {
          exam_code: examCode, version, entry_count: analysis.entries.length, excluded_count: analysis.excluded.length,
          tie_group_count: analysis.tieGroups.length, issue_count: issueCount,
        },
      });
      return { row: rows[0], analysis };
    });
    response.status(201).json({
      snapshot: { id: String(created.row.id), examCode, version: Number(created.row.version), status: String(created.row.status), createdAt: new Date(String(created.row.created_at)).toISOString() },
      summary: created.analysis.summary,
    });
  }));

  router.get('/admin/merit-lists/snapshots/:snapshotId', ...GUARDS, route(async (request, response) => {
    const id = snapshotIdSchema.safeParse(request.params.snapshotId);
    if (!id.success) throw new MeritHttpError(400, 'Invalid merit-list version.', 'INVALID_SNAPSHOT_ID');
    const { rows } = await database.query(MERIT_SQL.one, [id.data]);
    if (!rows[0]) throw new MeritHttpError(404, 'Merit-list version not found.', 'SNAPSHOT_NOT_FOUND');
    response.json({ snapshot: snapshotView(rows[0]), entries: rows[0].entries, excluded: rows[0].excluded, issueText: MERIT_ISSUE_TEXT, blockedRules: BLOCKED_RULES });
  }));

  router.get('/admin/merit-lists/snapshots/:snapshotId/export', ...GUARDS, route(async (request, response) => {
    const id = snapshotIdSchema.safeParse(request.params.snapshotId);
    if (!id.success) throw new MeritHttpError(400, 'Invalid merit-list version.', 'INVALID_SNAPSHOT_ID');
    const { rows } = await database.query(MERIT_SQL.one, [id.data]);
    if (!rows[0]) throw new MeritHttpError(404, 'Merit-list version not found.', 'SNAPSHOT_NOT_FOUND');
    const entries = rows[0].entries as MeritEntry[];
    const csv = meritEntriesToCsv(entries);
    // A-07/A-11: recorded before anything is sent; if the record fails, nothing is sent.
    await runAuditedTransaction(database, (client) => recordAuditEvent(client, {
      action: 'merit_list.exported', actor: auditActor(request), resourceId: id.data,
      metadata: { exam_code: String(rows[0].exam_code), version: Number(rows[0].version), row_count: entries.length },
    }));
    const name = `merit-list-${String(rows[0].exam_code).replace(/[^A-Za-z0-9-]/g, '_')}-v${Number(rows[0].version)}-draft.csv`;
    response.type('text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    response.send(csv);
  }));

  return router;
}
