import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { link, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { type AuthenticatedRequest, requireAuth, requireRoles, requireSuperAdmin } from './auth.js';
import { pool } from './db.js';
import { auditActor, recordAuditEvent } from './audit.js';
import { INSTITUTION_DOCUMENT_CATEGORIES, type InstitutionDocumentCategory } from '../src/utils/institutionDocuments.js';

export const SUPPORTED_DOCUMENT_MEDIA_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

type SupportedDocumentMediaType = typeof SUPPORTED_DOCUMENT_MEDIA_TYPES[number];
type CategoryCardinality = 'single' | 'multiple';

export interface InstitutionDocumentPolicy {
  uploadEnabled: boolean;
  maxBytes: number | null;
  maxDocumentsPerCategory: number | null;
  allowedMediaTypes: SupportedDocumentMediaType[];
  categoryCardinality: CategoryCardinality | null;
  replacementEnabled: boolean;
  maxVersionsPerDocument: number | null;
  reviewDecisionCodes: string[];
}

interface DocumentEnvironment {
  INSTITUTION_DOCUMENT_STORAGE_DIR?: string;
  INSTITUTION_DOCUMENT_MAX_BYTES?: string;
  INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES?: string;
  INSTITUTION_DOCUMENT_CARDINALITY?: string;
  INSTITUTION_DOCUMENT_MAX_DOCUMENTS_PER_CATEGORY?: string;
  INSTITUTION_DOCUMENT_REPLACEMENT_ENABLED?: string;
  INSTITUTION_DOCUMENT_MAX_VERSIONS_PER_DOCUMENT?: string;
  INSTITUTION_DOCUMENT_REVIEW_DECISION_CODES?: string;
}

interface StagedDocument {
  quarantinePath: string;
  fileSizeBytes: number;
  contentSha256: string;
  detectedMediaType: SupportedDocumentMediaType;
}

interface DocumentPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
    release(): void;
  }>;
}

class DocumentHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentHttpError';
  }
}

const publicDirectory = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many document uploads. Try again later.' },
});

function isSupportedMediaType(value: string): value is SupportedDocumentMediaType {
  return SUPPORTED_DOCUMENT_MEDIA_TYPES.includes(value as SupportedDocumentMediaType);
}

export function getInstitutionDocumentPolicy(
  env: DocumentEnvironment = process.env,
): InstitutionDocumentPolicy {
  let maxBytes: number | null = null;
  if (env.INSTITUTION_DOCUMENT_MAX_BYTES) {
    const parsed = Number(env.INSTITUTION_DOCUMENT_MAX_BYTES);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error('INSTITUTION_DOCUMENT_MAX_BYTES must be a positive safe integer.');
    }
    maxBytes = parsed;
  }

  const allowedMediaTypes = (env.INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedMediaTypes.some((type) => !isSupportedMediaType(type))) {
    throw new Error('INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES contains an unsupported media type.');
  }

  const cardinality = env.INSTITUTION_DOCUMENT_CARDINALITY;
  if (cardinality && cardinality !== 'single' && cardinality !== 'multiple') {
    throw new Error('INSTITUTION_DOCUMENT_CARDINALITY must be single or multiple.');
  }

  let maxDocumentsPerCategory: number | null = null;
  if (env.INSTITUTION_DOCUMENT_MAX_DOCUMENTS_PER_CATEGORY) {
    const parsed = Number(env.INSTITUTION_DOCUMENT_MAX_DOCUMENTS_PER_CATEGORY);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error('INSTITUTION_DOCUMENT_MAX_DOCUMENTS_PER_CATEGORY must be a positive safe integer.');
    }
    maxDocumentsPerCategory = parsed;
  }
  if (cardinality === 'single') {
    if (maxDocumentsPerCategory !== null && maxDocumentsPerCategory !== 1) {
      throw new Error('Single-document category policy requires a maximum of one document per category.');
    }
    maxDocumentsPerCategory = 1;
  } else if (cardinality === 'multiple' && maxDocumentsPerCategory === null) {
    maxDocumentsPerCategory = null;
  }

  const replacement = env.INSTITUTION_DOCUMENT_REPLACEMENT_ENABLED;
  if (replacement && replacement !== 'true' && replacement !== 'false') {
    throw new Error('INSTITUTION_DOCUMENT_REPLACEMENT_ENABLED must be true or false.');
  }

  let maxVersionsPerDocument: number | null = null;
  if (env.INSTITUTION_DOCUMENT_MAX_VERSIONS_PER_DOCUMENT) {
    const parsed = Number(env.INSTITUTION_DOCUMENT_MAX_VERSIONS_PER_DOCUMENT);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error('INSTITUTION_DOCUMENT_MAX_VERSIONS_PER_DOCUMENT must be a positive safe integer.');
    }
    maxVersionsPerDocument = parsed;
  }

  const reviewDecisionCodes = (env.INSTITUTION_DOCUMENT_REVIEW_DECISION_CODES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (reviewDecisionCodes.some((code) => !/^[a-z][a-z0-9_]{0,39}$/.test(code))
      || new Set(reviewDecisionCodes).size !== reviewDecisionCodes.length) {
    throw new Error('INSTITUTION_DOCUMENT_REVIEW_DECISION_CODES must contain unique lowercase identifiers.');
  }

  const storageDirectory = env.INSTITUTION_DOCUMENT_STORAGE_DIR;
  if (storageDirectory && !isAbsolute(storageDirectory)) {
    throw new Error('INSTITUTION_DOCUMENT_STORAGE_DIR must be an absolute private path.');
  }

  return {
    uploadEnabled: false,
    maxBytes,
    maxDocumentsPerCategory,
    allowedMediaTypes: allowedMediaTypes as SupportedDocumentMediaType[],
    categoryCardinality: cardinality as CategoryCardinality | undefined ?? null,
    replacementEnabled: replacement === 'true' && maxVersionsPerDocument !== null,
    maxVersionsPerDocument,
    reviewDecisionCodes,
  };
}

export function detectDocumentMediaType(
  prefix: Uint8Array,
  tail: Uint8Array,
): SupportedDocumentMediaType | null {
  const start = Buffer.from(prefix);
  const end = Buffer.from(tail);

  if (
    start.subarray(0, 5).toString('ascii') === '%PDF-'
    && end.includes(Buffer.from('%%EOF', 'ascii'))
  ) {
    return 'application/pdf';
  }
  if (
    start.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && end.includes(Buffer.from([0x49, 0x45, 0x4e, 0x44]))
  ) {
    return 'image/png';
  }
  if (
    start.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    && end.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 0
  ) {
    return 'image/jpeg';
  }
  return null;
}

function inside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ''
    || (pathFromParent !== '..'
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent));
}

async function ensurePrivateDirectories(storageDirectory: string): Promise<{
  root: string;
  quarantine: string;
  objects: string;
}> {
  const configuredRoot = resolve(storageDirectory);
  const resolvedPublicDirectory = existsSync(publicDirectory)
    ? await realpath(publicDirectory)
    : publicDirectory;
  if (inside(resolvedPublicDirectory, configuredRoot)) {
    throw new Error('Institution document storage must be outside the public web directory.');
  }

  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(configuredRoot);
  if (inside(resolvedPublicDirectory, root)) {
    throw new Error('Institution document storage resolves inside the public web directory.');
  }
  const rootInfo = await stat(root);
  if ((rootInfo.mode & 0o077) !== 0) {
    throw new Error('Institution document storage must not grant group or other access.');
  }

  const quarantine = resolve(root, 'quarantine');
  const objects = resolve(root, 'objects');
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  await mkdir(objects, { recursive: true, mode: 0o700 });
  const [realQuarantine, realObjects] = await Promise.all([realpath(quarantine), realpath(objects)]);
  if (!inside(root, realQuarantine) || !inside(root, realObjects)) {
    throw new Error('Institution document storage directories must remain inside the configured private root.');
  }
  for (const directory of [realQuarantine, realObjects]) {
    if ((await stat(directory)).mode & 0o077) {
      throw new Error('Institution document storage directories must not grant group or other access.');
    }
  }
  return { root, quarantine: realQuarantine, objects: realObjects };
}

async function writeChunk(file: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

async function removeGeneratedFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) return;
    throw error;
  }
}

async function stageUpload(
  request: Request,
  policy: InstitutionDocumentPolicy,
): Promise<StagedDocument> {
  if (!policy.maxBytes || !policy.allowedMediaTypes.length || !process.env.INSTITUTION_DOCUMENT_STORAGE_DIR) {
    throw new DocumentHttpError(503, 'Document uploads are unavailable until the document policy is configured.');
  }

  const directories = await ensurePrivateDirectories(process.env.INSTITUTION_DOCUMENT_STORAGE_DIR);
  const quarantinePath = resolve(directories.quarantine, `${randomUUID()}.part`);
  const file = await open(quarantinePath, 'wx', 0o600);
  let totalBytes = 0;
  let tooLarge = false;
  let prefix = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  const hash = createHash('sha256');
  try {
    for await (const incoming of request) {
      const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming as Uint8Array);
      totalBytes += chunk.byteLength;
      if (totalBytes > policy.maxBytes) {
        tooLarge = true;
        continue;
      }
      hash.update(chunk);
      if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk]).subarray(0, 16);
      tail = Buffer.concat([tail, chunk]).subarray(-1024);
      await writeChunk(file, chunk);
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await removeGeneratedFile(quarantinePath);
    throw error;
  }
  await file.close();

  if (tooLarge) {
    await removeGeneratedFile(quarantinePath);
    throw new DocumentHttpError(413, 'The document exceeds the configured file-size limit.');
  }
  if (totalBytes === 0) {
    await removeGeneratedFile(quarantinePath);
    throw new DocumentHttpError(400, 'Choose a non-empty document to upload.');
  }

  const detectedMediaType = detectDocumentMediaType(prefix, tail);
  if (!detectedMediaType || !policy.allowedMediaTypes.includes(detectedMediaType)) {
    await removeGeneratedFile(quarantinePath);
    throw new DocumentHttpError(415, 'The document content is not a configured supported file type.');
  }
  return {
    quarantinePath,
    fileSizeBytes: totalBytes,
    contentSha256: hash.digest('hex'),
    detectedMediaType,
  };
}

async function finalizeStagedFile(
  quarantinePath: string,
  storageKey: string,
): Promise<string> {
  const storageDirectory = process.env.INSTITUTION_DOCUMENT_STORAGE_DIR;
  if (!storageDirectory || !/^[0-9a-f-]{36}$/.test(storageKey)) {
    throw new Error('Invalid private document storage configuration or key.');
  }
  const directories = await ensurePrivateDirectories(storageDirectory);
  const finalPath = resolve(directories.objects, storageKey);
  if (!inside(directories.objects, finalPath)) {
    throw new Error('Document storage key resolves outside the private object directory.');
  }
  await link(quarantinePath, finalPath);
  await unlink(quarantinePath);
  return finalPath;
}

async function cleanupUpload(staged: StagedDocument | undefined, finalPath: string | undefined) {
  if (staged) await removeGeneratedFile(staged.quarantinePath);
  if (finalPath) await removeGeneratedFile(finalPath);
}

function currentUser(request: Request) {
  return (request as AuthenticatedRequest).user!;
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request, response, next: NextFunction) => {
    void handler(request, response).catch((error: unknown) => {
      if (error instanceof DocumentHttpError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === '42P01'
        && 'message' in error
        && typeof error.message === 'string'
        && error.message.includes('institution_document')
      ) {
        response.status(503).json({
          error: 'Institution document schema is not installed. Review and apply the separate migration before using document records.',
        });
        return;
      }
      next(error);
    });
  };
}

function policyResponse(policy: InstitutionDocumentPolicy) {
  return {
    categories: INSTITUTION_DOCUMENT_CATEGORIES,
    uploadEnabled: policy.uploadEnabled,
    maxBytes: policy.maxBytes,
    maxDocumentsPerCategory: policy.maxDocumentsPerCategory,
    allowedMediaTypes: policy.allowedMediaTypes,
    categoryCardinality: policy.categoryCardinality,
    replacementEnabled: policy.replacementEnabled,
    maxVersionsPerDocument: policy.maxVersionsPerDocument,
    reviewDecisionCodes: policy.reviewDecisionCodes,
  };
}

async function loadVersions(
  database: DocumentPool,
  institutionId?: string,
): Promise<Array<Record<string, unknown>>> {
  const values = institutionId ? [institutionId] : [];
  const scope = institutionId ? 'WHERE d.institution_id = $1' : '';
  const { rows } = await database.query(
    `SELECT v.id AS version_id, d.id AS document_id, d.institution_id,
            d.category, v.version_number, v.detected_media_type, v.file_size_bytes,
            v.content_sha256, v.uploaded_by, v.uploaded_at,
            i.display_name AS institution_name, i.login_id AS institution_login_id
     FROM institution_document_versions v
     JOIN institution_documents d ON d.id = v.document_id
     JOIN users i ON i.id = d.institution_id
     ${scope}
     ORDER BY v.uploaded_at DESC, v.version_number DESC`,
    values,
  );
  if (rows.length === 0) return [];

  const versionIds = rows.map((row) => String(row.version_id));
  const reviews = await database.query(
    `SELECT h.id, h.version_id, h.decision_code, h.reviewer_remarks,
            h.reviewed_at, reviewer.display_name AS reviewer_name
     FROM institution_document_review_history h
     JOIN users reviewer ON reviewer.id = h.reviewer_user_id
     WHERE h.version_id = ANY($1::text[])
     ORDER BY h.reviewed_at DESC`,
    [versionIds],
  );
  const reviewMap = new Map<string, Record<string, unknown>[]>();
  for (const review of reviews.rows) {
    const versionId = String(review.version_id);
    reviewMap.set(versionId, [...(reviewMap.get(versionId) || []), review]);
  }
  return rows.map(({ content_sha256: _contentHash, uploaded_by: _uploaderId, institution_id, ...row }) => ({
    ...row,
    institutionId: institution_id,
    reviews: reviewMap.get(String(row.version_id)) || [],
  }));
}

function validOpaqueId(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

async function sendDocumentContent(
  request: Request,
  response: Response,
  database: DocumentPool,
  institutionId?: string,
): Promise<void> {
  const versionId = String(request.params.versionId || '');
  if (!validOpaqueId(versionId)) {
    response.status(404).json({ error: 'Institution document version not found.' });
    return;
  }
  const values: unknown[] = [versionId];
  const ownership = institutionId ? 'AND d.institution_id = $2' : '';
  if (institutionId) values.push(institutionId);
  const { rows } = await database.query(
    `SELECT v.storage_key, v.detected_media_type
     FROM institution_document_versions v
     JOIN institution_documents d ON d.id = v.document_id
     WHERE v.id = $1 ${ownership}`,
    values,
  );
  const row = rows[0];
  if (!row) {
    response.status(404).json({ error: 'Institution document version not found.' });
    return;
  }
  const storageKey = String(row.storage_key);
  const mediaType = String(row.detected_media_type);
  if (!validOpaqueId(storageKey) || !isSupportedMediaType(mediaType)) {
    throw new Error('Stored institution document metadata is invalid.');
  }
  const storageDirectory = process.env.INSTITUTION_DOCUMENT_STORAGE_DIR;
  if (!storageDirectory) {
    throw new DocumentHttpError(503, 'Private document storage is not configured.');
  }
  const directories = await ensurePrivateDirectories(storageDirectory);
  const filePath = resolve(directories.objects, storageKey);
  if (!inside(directories.objects, filePath)) {
    throw new Error('Stored institution document key resolves outside private storage.');
  }

  response.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Type': mediaType,
    'Content-Disposition': 'inline',
  });
  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    console.error('Institution document retrieval failed:', error);
    if (!response.headersSent) {
      response.status(500).json({ error: 'The institution document could not be retrieved.' });
    } else response.destroy(error);
  });
  stream.pipe(response);
}

function appendUploadVersion(
  database: DocumentPool,
  options: {
    institutionId: string;
    documentId?: string;
    category?: InstitutionDocumentCategory;
    staged: StagedDocument;
    policy: InstitutionDocumentPolicy;
  },
) {
  return async (request: Request, response: Response): Promise<void> => {
    const { institutionId, documentId, category, staged, policy } = options;
    let client: Awaited<ReturnType<DocumentPool['connect']>> | undefined;
    let finalPath: string | undefined;
    let committed = false;
    let commitAttempted = false;
    let transactionStarted = false;
    try {
      client = await database.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      if (documentId) {
        const { rows } = await client.query(
          `SELECT id, category FROM institution_documents
           WHERE id = $1 AND institution_id = $2 FOR UPDATE`,
          [documentId, institutionId],
        );
        if (!rows[0]) throw new DocumentHttpError(404, 'Institution document not found.');
        if (!policy.replacementEnabled) {
          throw new DocumentHttpError(403, 'Document replacement is disabled pending policy confirmation.');
        }
      } else {
        await client.query(
          `SELECT id FROM users WHERE id = $1 AND role = 'center' FOR UPDATE`,
          [institutionId],
        );
        const { rows } = await client.query(
          `SELECT COUNT(*) AS document_count FROM institution_documents
           WHERE institution_id = $1 AND category = $2`,
          [institutionId, category],
        );
        if (Number(rows[0]?.document_count || 0) >= Number(policy.maxDocumentsPerCategory)) {
          throw new DocumentHttpError(409, 'The configured document count for this category has been reached.');
        }
      }

      const selectedCategory = documentId
        ? String((await client.query(
          'SELECT category FROM institution_documents WHERE id = $1 AND institution_id = $2',
          [documentId, institutionId],
        )).rows[0]?.category)
        : category!;
      const { rows: previousVersions } = await client.query(
        `SELECT COALESCE(MAX(version_number), 0) AS latest_version
         FROM institution_document_versions WHERE document_id = $1`,
        [documentId || ''],
      );
      if (
        documentId
        && policy.maxVersionsPerDocument !== null
        && Number(previousVersions[0]?.latest_version || 0) >= policy.maxVersionsPerDocument
      ) {
        throw new DocumentHttpError(409, 'The configured document version limit has been reached.');
      }
      let documentIdForVersion = documentId;
      if (!documentIdForVersion) {
        documentIdForVersion = randomUUID();
        await client.query(
          `INSERT INTO institution_documents (id, institution_id, category)
           VALUES ($1, $2, $3)`,
          [documentIdForVersion, institutionId, selectedCategory],
        );
      }

      const versionId = randomUUID();
      const storageKey = randomUUID();
      finalPath = await finalizeStagedFile(staged.quarantinePath, storageKey);
      await client.query(
        `INSERT INTO institution_document_versions
         (id, document_id, institution_id, category, version_number, storage_key,
          detected_media_type, file_size_bytes, content_sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [versionId, documentIdForVersion, institutionId, selectedCategory,
          Number(previousVersions[0]?.latest_version || 0) + 1, storageKey,
          staged.detectedMediaType, staged.fileSizeBytes, staged.contentSha256, institutionId],
      );
      commitAttempted = true;
      await client.query('COMMIT');
      committed = true;
      response.status(201).json({
        documentId: documentIdForVersion,
        versionId,
        category: selectedCategory,
        version: Number(previousVersions[0]?.latest_version || 0) + 1,
        detectedMediaType: staged.detectedMediaType,
        fileSizeBytes: staged.fileSizeBytes,
      });
    } catch (error) {
      if (client && transactionStarted && !commitAttempted) await client.query('ROLLBACK');
      throw error;
    } finally {
      await cleanupUpload(staged, committed || commitAttempted ? undefined : finalPath);
      client?.release();
    }
  };
}

export function createInstitutionDocumentsRouter(
  database: DocumentPool = pool,
): express.Router {
  const router = express.Router();
  const centerAccess = [requireAuth, requireRoles('center')];
  const officialAccess = [requireAuth, requireRoles('official')];
  // P0-3 (A-09, P3-D10): document content (preview and download share one route) and review
  // decisions are Super Admin-only. Ordinary Officials keep the metadata list and the policy.
  // P3-D5 (controlled read-only access for institution-approval Officials) is NOT implemented:
  // it is blocked pending a separately approved mechanism, and no alternative content path exists.
  const superAdminAccess = [requireAuth, requireRoles('official'), requireSuperAdmin];

  router.get('/center/documents/policy', ...centerAccess, (_request, response) => {
    response.set('Cache-Control', 'no-store').json(policyResponse(getInstitutionDocumentPolicy()));
  });
  router.get('/admin/institution-documents/policy', ...officialAccess, (_request, response) => {
    response.set('Cache-Control', 'no-store').json(policyResponse(getInstitutionDocumentPolicy()));
  });

  router.get('/center/documents', ...centerAccess, asyncRoute(async (request, response) => {
    const user = currentUser(request);
    response.set('Cache-Control', 'no-store').json({
      documents: await loadVersions(database, user.id),
    });
  }));

  router.post('/center/documents', ...centerAccess, uploadLimiter, asyncRoute(async (request, response) => {
    const policy = getInstitutionDocumentPolicy();
    if (!policy.uploadEnabled) {
      throw new DocumentHttpError(503, 'Document uploads are unavailable until storage, file, and category policies are configured.');
    }
    const category = request.query.category;
    if (typeof category !== 'string'
        || !INSTITUTION_DOCUMENT_CATEGORIES.includes(category as InstitutionDocumentCategory)) {
      throw new DocumentHttpError(400, 'Choose one of the five configured institution document categories.');
    }
    if (request.headers['content-type'] !== 'application/octet-stream') {
      throw new DocumentHttpError(415, 'Upload the file as application/octet-stream.');
    }
    const staged = await stageUpload(request, policy);
    if (!policy.allowedMediaTypes.includes(staged.detectedMediaType)) {
      await cleanupUpload(staged, undefined);
      throw new DocumentHttpError(415, 'The detected document type is not allowed.');
    }
    await appendUploadVersion(database, {
      institutionId: currentUser(request).id,
      category: category as InstitutionDocumentCategory,
      staged,
      policy,
    })(request, response);
  }));

  router.put('/center/documents/:documentId/versions', ...centerAccess, uploadLimiter, asyncRoute(async (request, response) => {
    const policy = getInstitutionDocumentPolicy();
    if (!policy.uploadEnabled) {
      throw new DocumentHttpError(503, 'Document uploads are unavailable until storage, file, and category policies are configured.');
    }
    if (!policy.replacementEnabled) {
      throw new DocumentHttpError(403, 'Document replacement is disabled pending policy confirmation.');
    }
    if (!validOpaqueId(request.params.documentId)
        || request.headers['content-type'] !== 'application/octet-stream') {
      throw new DocumentHttpError(400, 'A valid document ID and application/octet-stream body are required.');
    }
    const staged = await stageUpload(request, policy);
    await appendUploadVersion(database, {
      institutionId: currentUser(request).id,
      documentId: request.params.documentId,
      staged,
      policy,
    })(request, response);
  }));

  router.get('/center/documents/versions/:versionId/content', ...centerAccess, asyncRoute(async (request, response) => {
    await sendDocumentContent(request, response, database, currentUser(request).id);
  }));

  router.get('/admin/institution-documents', ...officialAccess, asyncRoute(async (_request, response) => {
    response.set('Cache-Control', 'no-store').json({
      documents: await loadVersions(database),
    });
  }));

  router.get('/admin/institution-documents/versions/:versionId/content', ...superAdminAccess, asyncRoute(async (request, response) => {
    await sendDocumentContent(request, response, database);
  }));

  router.post('/admin/institution-documents/versions/:versionId/reviews', ...superAdminAccess, asyncRoute(async (request, response) => {
    const body = request.body as { decisionCode?: unknown; remarks?: unknown };
    const policy = getInstitutionDocumentPolicy();
    const remarks = typeof body?.remarks === 'string' ? body.remarks.trim() : '';
    const decisionCode = body?.decisionCode;
    if (!validOpaqueId(request.params.versionId) || remarks.length < 1 || remarks.length > 2000) {
      throw new DocumentHttpError(400, 'A valid version ID and reviewer remarks between 1 and 2,000 characters are required.');
    }
    if (decisionCode !== undefined && decisionCode !== null
        && (typeof decisionCode !== 'string' || !policy.reviewDecisionCodes.includes(decisionCode))) {
      throw new DocumentHttpError(400, 'That review decision is not currently configured.');
    }

    const reviewer = currentUser(request);
    const { rows: versionRows } = await database.query(
      'SELECT id FROM institution_document_versions WHERE id = $1',
      [request.params.versionId],
    );
    if (!versionRows[0]) {
      response.status(404).json({ error: 'Institution document version not found.' });
      return;
    }
    // A-11: the review and its audit event commit together. Remarks stay in the review history only.
    const client = await database.connect();
    let rows: Record<string, unknown>[];
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(
        `INSERT INTO institution_document_review_history
         (id, version_id, institution_id, reviewer_user_id, decision_code, reviewer_remarks)
         SELECT $1, v.id, v.institution_id, $3, $4, $5
         FROM institution_document_versions v WHERE v.id = $2
         RETURNING id, version_id, decision_code, reviewer_remarks, reviewed_at, institution_id`,
        [randomUUID(), request.params.versionId, reviewer.id,
          decisionCode ?? null, remarks],
      ));
      if (rows[0]) {
        await recordAuditEvent(client, {
          action: 'document.review_recorded', actor: auditActor(request), organizationId: String(rows[0].institution_id),
          resourceId: String(rows[0].version_id), metadata: typeof decisionCode === 'string' ? { decision_code: decisionCode } : {},
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (rows[0]) {
      const { institution_id: _institutionId, ...review } = rows[0];
      rows = [review];
    }
    if (!rows[0]) {
      response.status(404).json({ error: 'Institution document version not found.' });
      return;
    }
    response.status(201).json({ review: rows[0] });
  }));

  return router;
}
