import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRoles } from './auth.js';
import { pool } from './db.js';
import { INSTITUTION_DOCUMENT_CATEGORIES } from '../src/utils/institutionDocuments.js';

export const INSTITUTION_SUBMISSION_COOKIE = 'elt_institution_submission';
export const INSTITUTION_SUBMISSION_PATH = '/api/institution-document-submission';
export const DEFAULT_SUBMISSION_CAPABILITY_TTL_SECONDS = 30 * 60;

interface SubmissionDatabase {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<PoolClient>;
}

interface SubmissionQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface SubmissionContext {
  institutionId: string;
  cycleId: string;
  submissionVersion: number;
  sourceType: string;
  expiresAt: string;
}

interface SubmissionRequest extends Request {
  submission?: SubmissionContext;
}

export interface CapabilityIssue {
  token: string;
  maxAgeSeconds: number;
}

function capabilityTtlSeconds(): number {
  const configured = process.env.INSTITUTION_SUBMISSION_CAPABILITY_TTL_SECONDS;
  if (!configured) return DEFAULT_SUBMISSION_CAPABILITY_TTL_SECONDS;
  const ttl = Number(configured);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 60 * 60) {
    throw new Error('INSTITUTION_SUBMISSION_CAPABILITY_TTL_SECONDS must be between 60 and 3600.');
  }
  return ttl;
}

function hashCapability(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function setInstitutionSubmissionCookie(
  response: Response,
  issue: CapabilityIssue,
): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.append(
    'Set-Cookie',
    `${INSTITUTION_SUBMISSION_COOKIE}=${issue.token}; Path=${INSTITUTION_SUBMISSION_PATH}; Max-Age=${issue.maxAgeSeconds}; HttpOnly; SameSite=Strict${secure}`,
  );
  response.set('Cache-Control', 'no-store');
}

export function clearInstitutionSubmissionCookie(response: Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.append(
    'Set-Cookie',
    `${INSTITUTION_SUBMISSION_COOKIE}=; Path=${INSTITUTION_SUBMISSION_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
  );
}

export async function createSubmissionCycle(
  client: SubmissionQueryClient,
  options: {
    institutionId: string;
    submissionVersion: number;
    sourceType: 'initial_registration' | 'resubmission' | 'recovery';
    sourceReference?: string | null;
  },
): Promise<string> {
  const cycleId = randomUUID();
  await client.query(
    `INSERT INTO institution_submission_cycles
     (id, institution_id, submission_version, source_type, source_reference)
     VALUES ($1, $2, $3, $4, $5)`,
    [cycleId, options.institutionId, options.submissionVersion, options.sourceType, options.sourceReference ?? null],
  );
  return cycleId;
}

export async function issueSubmissionCapability(
  client: SubmissionQueryClient,
  institutionId: string,
  cycleId: string,
): Promise<CapabilityIssue> {
  const ttl = capabilityTtlSeconds();
  const token = randomBytes(32).toString('base64url');
  await client.query(
    `UPDATE institution_submission_capabilities
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE institution_id = $1 AND revoked_at IS NULL`,
    [institutionId],
  );
  await client.query(
    `INSERT INTO institution_submission_capabilities
     (id, institution_id, submission_cycle_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
    [randomUUID(), institutionId, cycleId, hashCapability(token), ttl],
  );
  return { token, maxAgeSeconds: ttl };
}

function capabilityFromRequest(request: Request): string | undefined {
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${INSTITUTION_SUBMISSION_COOKIE}=`))
    ?.slice(INSTITUTION_SUBMISSION_COOKIE.length + 1);
  return cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie) ? cookie : undefined;
}

export function requireInstitutionSubmissionCapability(
  database: Pick<SubmissionDatabase, 'query'> = pool,
): RequestHandler {
  return (request: SubmissionRequest, response: Response, next: NextFunction) => {
    const token = capabilityFromRequest(request);
    if (!token) {
      response.status(401).json({ error: 'Secure document-submission access is required.' });
      return;
    }

    void database.query(
      `SELECT c.institution_id, c.submission_cycle_id, s.submission_version,
              s.source_type, c.expires_at
       FROM institution_submission_capabilities c
       JOIN institution_submission_cycles s
         ON s.id = c.submission_cycle_id AND s.institution_id = c.institution_id
       JOIN users u ON u.id = c.institution_id
       WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND c.expires_at > now()
         AND s.status = 'open' AND u.role = 'center' AND u.account_status = 'pending'
         AND s.submission_version = (
           SELECT MAX(current_cycle.submission_version)
           FROM institution_submission_cycles current_cycle
           WHERE current_cycle.institution_id = c.institution_id AND current_cycle.status = 'open'
         )`,
      [hashCapability(token)],
    ).then(({ rows }) => {
      if (!rows[0]) {
        clearInstitutionSubmissionCookie(response);
        response.status(401).json({ error: 'Secure document-submission access has expired or been revoked.' });
        return;
      }
      request.submission = {
        institutionId: String(rows[0].institution_id),
        cycleId: String(rows[0].submission_cycle_id),
        submissionVersion: Number(rows[0].submission_version),
        sourceType: String(rows[0].source_type),
        expiresAt: new Date(String(rows[0].expires_at)).toISOString(),
      };
      response.set('Cache-Control', 'no-store');
      next();
    }).catch((error: unknown) => {
      if (isSubmissionSchemaUnavailable(error)) {
        response.status(503).json({
          error: 'Institution document submission schema is not installed. Review and apply the separate migration before using this feature.',
        });
        return;
      }
      next(error);
    });
  };
}

export function requireCapabilityMutationOrigin(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    next();
    return;
  }
  const configured = process.env.APP_ORIGIN;
  const origin = request.get('origin');
  try {
    if (!configured || !origin || new URL(configured).origin !== configured
        || origin !== configured || new URL(origin).origin !== origin) {
      response.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
  } catch {
    response.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }
  next();
}

const capabilityRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many document-submission requests. Try again later.' },
});
const reissueRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many access-recovery requests. Try again later.' },
});
const dummyPasswordHash = bcrypt.hash('submission-account-does-not-exist', 12);

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch((error: unknown) => {
      if (isSubmissionSchemaUnavailable(error)) {
        response.status(503).json({
          error: 'Institution document submission schema is not installed. Review and apply the separate migration before using this feature.',
        });
        return;
      }
      next(error);
    });
  };
}

function isSubmissionSchemaUnavailable(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '42P01'
    && 'message' in error
    && typeof error.message === 'string'
    && /institution_submission|institution_document/.test(error.message);
}

function submissionContext(request: SubmissionRequest): SubmissionContext {
  if (!request.submission) throw new Error('Submission capability middleware did not run.');
  return request.submission;
}

function getCapabilityTokenHash(request: Request): string | undefined {
  const token = capabilityFromRequest(request);
  return token ? hashCapability(token) : undefined;
}

export function createInstitutionSubmissionRouter(
  database: SubmissionDatabase = pool,
): express.Router {
  const router = express.Router();
  const capability = requireInstitutionSubmissionCapability(database);
  const capabilityAccess = [capabilityRateLimit, capability];
  router.use(requireCapabilityMutationOrigin);

  router.post('/reissue', reissueRateLimit, asyncRoute(async (request, response) => {
    const body = request.body as { loginId?: unknown; password?: unknown };
    const loginId = typeof body?.loginId === 'string' ? body.loginId.trim().toUpperCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!/^[A-Z0-9._-]{4,50}$/.test(loginId) || password.length < 1 || password.length > 128) {
      response.status(202).set('Cache-Control', 'no-store').json({
        message: 'If the credentials match an eligible pending institution, secure submission access has been issued.',
      });
      return;
    }

    const { rows } = await database.query(
      `SELECT id, password_hash FROM users WHERE login_id = $1 AND role = 'center'`,
      [loginId],
    );
    const account = rows[0];
    const matches = await bcrypt.compare(password, String(account?.password_hash ?? await dummyPasswordHash));
    if (!account || !matches) {
      response.status(202).set('Cache-Control', 'no-store').json({
        message: 'If the credentials match an eligible pending institution, secure submission access has been issued.',
      });
      return;
    }

    const client = await database.connect();
    let issue: CapabilityIssue | undefined;
    try {
      await client.query('BEGIN');
      const { rows: lockedRows } = await client.query(
        `SELECT id, account_status FROM users
         WHERE id = $1 AND role = 'center' FOR UPDATE`,
        [account.id],
      );
      if (lockedRows[0]?.account_status !== 'pending') {
        await client.query('ROLLBACK');
      } else {
        const { rows: cycles } = await client.query(
          `SELECT id FROM institution_submission_cycles
           WHERE institution_id = $1 AND status = 'open'
           ORDER BY submission_version DESC LIMIT 1 FOR UPDATE`,
          [account.id],
        );
        let cycleId = cycles[0]?.id ? String(cycles[0].id) : '';
        if (!cycleId) {
          const { rows: versionRows } = await client.query(
            `SELECT COALESCE(MAX(submission_version), 0) + 1 AS next_version
             FROM institution_submission_cycles WHERE institution_id = $1`,
            [account.id],
          );
          cycleId = await createSubmissionCycle(client, {
            institutionId: String(account.id),
            submissionVersion: Number(versionRows[0].next_version),
            sourceType: 'recovery',
          });
        }
        issue = await issueSubmissionCapability(client, String(account.id), cycleId);
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (issue) setInstitutionSubmissionCookie(response, issue);
    response.status(202).set('Cache-Control', 'no-store').json({
      message: 'If the credentials match an eligible pending institution, secure submission access has been issued.',
    });
  }));

  router.get('/status', ...capabilityAccess, asyncRoute(async (request, response) => {
    const submission = submissionContext(request as SubmissionRequest);
    const { rows } = await database.query(
      `SELECT expected.category, COUNT(d.id)::integer AS document_count
       FROM unnest($2::text[]) AS expected(category)
       LEFT JOIN institution_documents d
         ON d.submission_cycle_id = $1 AND d.institution_id = $3
        AND d.category = expected.category
       GROUP BY expected.category
       ORDER BY array_position($2::text[], expected.category)`,
      [submission.cycleId, INSTITUTION_DOCUMENT_CATEGORIES, submission.institutionId],
    );
    response.json({
      cycle: {
        version: submission.submissionVersion,
        source: submission.sourceType,
        expiresAt: submission.expiresAt,
      },
      categories: rows.map((row) => ({
        name: row.category,
        documentCount: Number(row.document_count),
      })),
      uploadEnabled: false,
      completenessPolicyEnabled: false,
    });
  }));

  router.get('/documents', ...capabilityAccess, asyncRoute(async (request, response) => {
    const submission = submissionContext(request as SubmissionRequest);
    const { rows } = await database.query(
      `SELECT d.id AS document_id, d.category, v.id AS version_id, v.version_number,
              v.detected_media_type, v.file_size_bytes, v.uploaded_at
       FROM institution_documents d
       JOIN institution_document_versions v ON v.document_id = d.id
       WHERE d.institution_id = $1 AND d.submission_cycle_id = $2
       ORDER BY d.category, v.version_number DESC`,
      [submission.institutionId, submission.cycleId],
    );
    response.json({ documents: rows });
  }));

  router.post('/documents', ...capabilityAccess, (_request, response) => {
    response.status(503).json({
      error: 'Document uploads are not enabled. Upload, file-type, size, and category-cardinality policies are not configured.',
    });
  });
  router.put('/documents/:documentId/versions', ...capabilityAccess, (_request, response) => {
    response.status(503).json({
      error: 'Document replacement is not enabled. Upload and replacement policies are not configured.',
    });
  });

  router.post('/revoke', ...capabilityAccess, asyncRoute(async (request, response) => {
    const tokenHash = getCapabilityTokenHash(request);
    if (tokenHash) {
      await database.query(
        `UPDATE institution_submission_capabilities
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE token_hash = $1`,
        [tokenHash],
      );
    }
    clearInstitutionSubmissionCookie(response);
    response.status(204).end();
  }));

  router.get('/admin/cycles', requireAuth, requireRoles('official'), asyncRoute(async (_request, response) => {
    const { rows } = await database.query(
      `SELECT u.id AS institution_id, u.login_id, u.display_name, u.account_status,
              c.id AS cycle_id, c.submission_version, c.source_type, c.status AS cycle_status,
              c.created_at AS cycle_created_at,
              COALESCE(summary.category_counts, '{}'::jsonb) AS category_counts,
              COALESCE(summary.missing_categories, $1::text[]) AS missing_categories
       FROM users u
       LEFT JOIN LATERAL (
         SELECT cycle.*
         FROM institution_submission_cycles cycle
         WHERE cycle.institution_id = u.id
         ORDER BY cycle.submission_version DESC
         LIMIT 1
       ) c ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(categories.category, categories.document_count) AS category_counts,
                array_agg(categories.category ORDER BY categories.position)
                  FILTER (WHERE categories.document_count = 0) AS missing_categories
         FROM (
           SELECT expected.category, expected.position, COUNT(d.id)::integer AS document_count
           FROM unnest($1::text[]) WITH ORDINALITY AS expected(category, position)
           LEFT JOIN institution_documents d
             ON d.submission_cycle_id = c.id AND d.institution_id = u.id
            AND d.category = expected.category
           GROUP BY expected.category, expected.position
         ) categories
       ) summary ON c.id IS NOT NULL
       WHERE u.role = 'center' AND u.account_status = 'pending'
       ORDER BY u.created_at DESC`,
      [INSTITUTION_DOCUMENT_CATEGORIES],
    );
    response.set('Cache-Control', 'no-store').json({
      completenessPolicyEnabled: false,
      submissions: rows,
    });
  }));

  return router;
}
