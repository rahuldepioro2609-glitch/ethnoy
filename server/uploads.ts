import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { requireAuth, requireRoles } from './auth.js';
import { pool } from './db.js';
import { MAX_FILES_PER_USER, UPLOAD_RULES, isUploadKind, sanitizeFileName, validateUpload, type UploadKind } from './fileRules.js';
import { asyncRoute, getUser, uploadLimiter } from './http.js';

const rawUpload = express.raw({
  type: ['image/jpeg', 'image/png', 'application/pdf', 'application/octet-stream'],
  limit: '2mb',
});

/** Confirms a file belongs to the user and has the expected kind. */
export async function assertOwnedFile(
  db: Pick<PoolClient, 'query'>,
  fileId: string,
  userId: string,
  kind: UploadKind,
): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM uploaded_files WHERE id = $1 AND user_id = $2 AND kind = $3',
    [fileId, userId, kind],
  );
  return Boolean(rows[0]);
}

/** Returns a data: URL for embedding a small image (e.g. on a printable admit card). */
export async function fileAsDataUrl(fileId: unknown): Promise<string> {
  if (typeof fileId !== 'string' || !fileId) return '';
  const { rows } = await pool.query(
    `SELECT mime_type, data FROM uploaded_files
     WHERE id = $1 AND mime_type IN ('image/jpeg', 'image/png')`,
    [fileId],
  );
  if (!rows[0]) return '';
  return `data:${rows[0].mime_type};base64,${Buffer.from(rows[0].data).toString('base64')}`;
}

export function registerUploadRoutes(app: Express): void {
  app.post('/api/uploads/:kind', requireAuth, requireRoles('candidate'), uploadLimiter, rawUpload, asyncRoute(async (request, response) => {
    const { kind } = request.params;
    if (!isUploadKind(kind)) {
      response.status(404).json({ error: 'Unknown upload type.' });
      return;
    }
    if (!Buffer.isBuffer(request.body)) {
      response.status(400).json({ error: `Upload a ${UPLOAD_RULES[kind].mimeTypes.map((type) => type.split('/')[1].toUpperCase()).join(' or ')} file.` });
      return;
    }
    const checked = validateUpload(kind, request.body);
    if ('error' in checked) {
      response.status(400).json({ error: checked.error });
      return;
    }
    const user = getUser(request);
    const { rows: countRows } = await pool.query(
      'SELECT count(*)::int AS total FROM uploaded_files WHERE user_id = $1',
      [user?.id],
    );
    if (countRows[0].total >= MAX_FILES_PER_USER) {
      response.status(429).json({ error: 'Upload limit reached for this account. Contact the helpdesk.' });
      return;
    }
    const { rows } = await pool.query(
      `INSERT INTO uploaded_files (id, user_id, kind, mime_type, original_name, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, kind, mime_type, original_name, size_bytes, created_at`,
      [randomUUID(), user?.id, kind, checked.mimeType, sanitizeFileName(request.get('x-file-name')),
        request.body.length, request.body],
    );
    response.status(201).json({
      file: {
        id: rows[0].id,
        kind: rows[0].kind,
        mimeType: rows[0].mime_type,
        originalName: rows[0].original_name,
        sizeBytes: rows[0].size_bytes,
      },
    });
  }));

  app.get('/api/files/:id', requireAuth, asyncRoute(async (request, response) => {
    const user = getUser(request);
    const { rows } = await pool.query(
      `SELECT mime_type, original_name, data FROM uploaded_files
       WHERE id = $1 AND (user_id = $2 OR $3)`,
      [request.params.id, user?.id, user?.role === 'official'],
    );
    if (!rows[0]) {
      response.status(404).json({ error: 'File not found.' });
      return;
    }
    const extension = rows[0].mime_type === 'application/pdf' ? 'pdf' : rows[0].mime_type === 'image/png' ? 'png' : 'jpg';
    const fallbackName = `eltnoy-file.${extension}`;
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(rows[0].original_name || fallbackName)}`,
    );
    response.type(rows[0].mime_type);
    response.send(Buffer.from(rows[0].data));
  }));
}
