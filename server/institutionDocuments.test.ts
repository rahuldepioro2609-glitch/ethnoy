import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  createInstitutionDocumentsRouter,
  detectDocumentMediaType,
  getInstitutionDocumentPolicy,
} from './institutionDocuments.js';
import { hashSessionToken, setTrustedRequestSurface } from './auth.js';
import { expectedOrigin, type Surface } from './surface.js';
import { pool } from './db.js';
import { INSTITUTION_DOCUMENT_CATEGORIES } from '../src/utils/institutionDocuments.js';

const tokens = {
  center: 'C'.repeat(43),
  otherCenter: 'D'.repeat(43),
  official: 'O'.repeat(43),
  // P0-3 (A-09): document content and review decisions are Super Admin-only.
  superAdmin: 'S'.repeat(43),
  candidate: 'A'.repeat(43),
};

const documentVariables = [
  'INSTITUTION_DOCUMENT_STORAGE_DIR',
  'INSTITUTION_DOCUMENT_MAX_BYTES',
  'INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES',
  'INSTITUTION_DOCUMENT_CARDINALITY',
  'INSTITUTION_DOCUMENT_MAX_DOCUMENTS_PER_CATEGORY',
  'INSTITUTION_DOCUMENT_REPLACEMENT_ENABLED',
  'INSTITUTION_DOCUMENT_MAX_VERSIONS_PER_DOCUMENT',
  'INSTITUTION_DOCUMENT_REVIEW_DECISION_CODES',
] as const;

type DocumentVariable = typeof documentVariables[number];

function routeHandlers(
  router: ReturnType<typeof createInstitutionDocumentsRouter>,
  method: 'get' | 'post' | 'put',
  path: string,
): RequestHandler[] {
  const layer = (router as unknown as { stack: Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> };
  }> }).stack
    .map((item) => item.route)
    .find((route) => route?.path === path && route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
  return layer.stack.map((item) => item.handle);
}

// P1-B: these route-stack tests bypass the app-level surface enforcement, so each fake request
// carries the server-controlled surface that its account's role belongs to (candidate → Exam,
// center → Institution, official → Admin), set through the same trusted setter the gate uses.
function trustSurface(request: object, surface: Surface): void {
  setTrustedRequestSurface(request, surface, expectedOrigin(surface));
}

function surfaceForToken(token: string | undefined, path: string): Surface {
  if (token === tokens.candidate) return 'exam';
  if (token === tokens.official || token === tokens.superAdmin) return 'admin';
  if (token === tokens.center || token === tokens.otherCenter) return 'institution';
  return path.startsWith('/admin') ? 'admin' : 'institution';
}

function invoke(
  handlers: RequestHandler[],
  options: {
    method: string;
    path: string;
    token?: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    bytes?: Buffer;
    contentType?: string;
  },
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolvePromise, reject) => {
    let status = 200;
    let settled = false;
    let handlerIndex = 0;
    const headers: Record<string, string> = {};
    const bodyChunks: Buffer[] = [];
    const readable = Readable.from(options.bytes ? [options.bytes] : []);
    const request = Object.assign(readable, {
      headers: {
        ...(options.token ? { cookie: `elt_session=${options.token}` } : {}),
        ...(options.contentType ? { 'content-type': options.contentType } : {}),
      },
      method: options.method,
      path: options.path,
      url: options.path,
      params: options.params || {},
      query: options.query || {},
      body: options.body,
      app: { get: () => false },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as Request;
    trustSurface(request, surfaceForToken(options.token, options.path));
    const response = Object.assign(new Writable({
      write(chunk, _encoding, callback) {
        bodyChunks.push(Buffer.from(chunk));
        response.headersSent = true;
        callback();
      },
    }), {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        if (!settled) {
          settled = true;
          resolvePromise({ status, body, headers });
        }
        return this;
      },
      set(nameOrHeaders: string | Record<string, string>, value?: string) {
        if (typeof nameOrHeaders === 'string') headers[nameOrHeaders] = value || '';
        else Object.assign(headers, nameOrHeaders);
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      append(name: string, value: string) {
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
        return this;
      },
      getHeader(name: string) {
        return headers[name];
      },
      clearCookie() {
        return this;
      },
    }) as unknown as Response;
    response.on('finish', () => {
      if (!settled) {
        settled = true;
        resolvePromise({ status, body: Buffer.concat(bodyChunks), headers });
      }
    });
    response.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    const next: NextFunction = (error?: unknown) => {
      if (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }
      const handler = handlers[handlerIndex++];
      if (!handler) return;
      try {
        const result = (handler as unknown as (
          request: Request,
          response: Response,
          next: NextFunction,
        ) => unknown)(request, response, next);
        if (result instanceof Promise) void result.catch(next);
      } catch (error) {
        next(error);
      }
    };
    next();
  });
}

function installAuthenticationRows() {
  const mutablePool = pool as unknown as {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  const originalQuery = mutablePool.query.bind(pool);
  mutablePool.query = async (text, values = []) => {
    if (!text.includes('FROM auth_sessions s')) {
      throw new Error(`Unexpected authentication query: ${text}`);
    }
    const sessionTokenHash = values[0];
    const session = Object.entries(tokens).find(([, token]) => hashSessionToken(token) === sessionTokenHash);
    if (!session) return { rows: [] };
    const [roleName] = session;
    const role = roleName === 'official' || roleName === 'superAdmin' ? 'official'
      : roleName === 'candidate' ? 'candidate'
        : 'center';
    const id = roleName === 'otherCenter' ? 'center-b' : roleName === 'center' ? 'center-a'
      : roleName === 'superAdmin' ? 'super-admin' : roleName;
    return {
      rows: [{
        id,
        login_id: id.toUpperCase(),
        display_name: `Synthetic ${role}`,
        role,
        account_status: 'approved',
        is_super_admin: roleName === 'superAdmin',
      }],
    };
  };
  return () => { mutablePool.query = originalQuery; };
}

function setDocumentEnvironment(values: Partial<Record<DocumentVariable, string>>) {
  const previous = new Map<DocumentVariable, string | undefined>();
  for (const key of documentVariables) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return () => {
    for (const key of documentVariables) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const pdfBytes = Buffer.from('%PDF-1.7\nSynthetic test document\n%%EOF\n');

test('exposes exactly the five client-confirmed institution document categories', () => {
  assert.deepEqual(INSTITUTION_DOCUMENT_CATEGORIES, [
    'Registration Certificate',
    'PAN Card',
    'Address Proof',
    'Affiliation / Recognition Certificate',
    'Authorized Person’s ID Proof',
  ]);
});

test('Milestone 2 preserves legacy null cycles and requires cycles for new document rows', async () => {
  const migration = await readFile(new URL('./institutionDocumentSubmissionMigration.sql', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE institution_documents\s+ADD COLUMN (?:IF NOT EXISTS )?submission_cycle_id text;/);
  assert.match(migration, /FOREIGN KEY \(submission_cycle_id, institution_id\)\s+REFERENCES institution_submission_cycles\(id, institution_id\)/);
  assert.match(migration, /IF NEW\.submission_cycle_id IS NULL THEN\s+RAISE EXCEPTION/);
  assert.match(migration, /CREATE TRIGGER institution_documents_require_cycle_on_insert\s+BEFORE INSERT ON institution_documents/);
  assert.doesNotMatch(migration, /UPDATE institution_documents\s+SET submission_cycle_id/i);
  assert.doesNotMatch(migration, /ALTER COLUMN submission_cycle_id SET NOT NULL/i);
});

test('keeps uploads disabled until all required policies and private storage are configured', () => {
  const policy = getInstitutionDocumentPolicy({});
  assert.equal(policy.uploadEnabled, false);
  assert.equal(policy.categoryCardinality, null);
  assert.equal(policy.maxDocumentsPerCategory, null);
  assert.equal(policy.replacementEnabled, false);
  assert.equal(policy.maxVersionsPerDocument, null);
  assert.deepEqual(policy.reviewDecisionCodes, []);
  const missingMultipleLimit = getInstitutionDocumentPolicy({
    INSTITUTION_DOCUMENT_STORAGE_DIR: '/private/documents',
    INSTITUTION_DOCUMENT_MAX_BYTES: '1000',
    INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES: 'application/pdf',
    INSTITUTION_DOCUMENT_CARDINALITY: 'multiple',
  });
  assert.equal(missingMultipleLimit.uploadEnabled, false);
  const missingVersionLimit = getInstitutionDocumentPolicy({
    INSTITUTION_DOCUMENT_STORAGE_DIR: '/private/documents',
    INSTITUTION_DOCUMENT_MAX_BYTES: '1000',
    INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES: 'application/pdf',
    INSTITUTION_DOCUMENT_CARDINALITY: 'single',
    INSTITUTION_DOCUMENT_REPLACEMENT_ENABLED: 'true',
  });
  assert.equal(missingVersionLimit.uploadEnabled, false);
  assert.equal(missingVersionLimit.replacementEnabled, false);
});

test('validates content signatures rather than filenames or browser MIME values', () => {
  assert.equal(
    detectDocumentMediaType(Buffer.from('not-a-pdf.pdf'), Buffer.from('not-a-pdf.pdf')),
    null,
  );
  assert.equal(detectDocumentMediaType(pdfBytes.subarray(0, 16), pdfBytes.subarray(-1024)), 'application/pdf');
  assert.throws(() => getInstitutionDocumentPolicy({
    INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES: 'application/x-executable',
  }), /unsupported media type/);
});

test('requires authentication and rejects candidates from institution document APIs', async () => {
  const restore = installAuthenticationRows();
  try {
    const router = createInstitutionDocumentsRouter({ query: async () => ({ rows: [] }), connect: async () => { throw new Error('unexpected'); } });
    const handlers = routeHandlers(router, 'get', '/center/documents');
    const unauthenticated = await invoke(handlers, { method: 'GET', path: '/center/documents' });
    assert.equal(unauthenticated.status, 401);
    const wrongRole = await invoke(handlers, {
      method: 'GET',
      path: '/center/documents',
      token: tokens.candidate,
    });
    assert.equal(wrongRole.status, 403);
  } finally {
    restore();
  }
});

test('candidate cannot access official document review APIs', async () => {
  const restore = installAuthenticationRows();
  try {
    const router = createInstitutionDocumentsRouter({ query: async () => ({ rows: [] }), connect: async () => { throw new Error('unexpected'); } });
    const result = await invoke(routeHandlers(router, 'get', '/admin/institution-documents'), {
      method: 'GET',
      path: '/admin/institution-documents',
      token: tokens.candidate,
    });
    assert.equal(result.status, 403);
  } finally {
    restore();
  }
});

test('reports pending document migration as unavailable instead of a generic server error', async () => {
  const restore = installAuthenticationRows();
  try {
    const router = createInstitutionDocumentsRouter({
      async query() {
        throw Object.assign(new Error('relation "institution_document_versions" does not exist'), { code: '42P01' });
      },
      async connect() {
        throw new Error('unexpected');
      },
    });
    const result = await invoke(routeHandlers(router, 'get', '/center/documents'), {
      method: 'GET',
      path: '/center/documents',
      token: tokens.center,
    });
    assert.equal(result.status, 503);
    assert.match(JSON.stringify(result.body), /separate migration/);
  } finally {
    restore();
  }
});

test('institution document listing and retrieval queries are scoped to the authenticated institution', async () => {
  const restore = installAuthenticationRows();
  const storage = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'eltnoy-document-ownership-'));
  const restoreEnvironment = setDocumentEnvironment({
    INSTITUTION_DOCUMENT_STORAGE_DIR: storage,
  });
  const storageKey = '00000000-0000-4000-8000-000000000010';
  await mkdir(resolve(storage, 'objects'), { mode: 0o700 });
  await mkdir(resolve(storage, 'quarantine'), { mode: 0o700 });
  await writeFile(resolve(storage, 'objects', storageKey), pdfBytes, { mode: 0o600 });
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const database = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes('SELECT v.storage_key')) {
        return {
          rows: values?.[1] === 'center-a'
            ? [{ storage_key: storageKey, detected_media_type: 'application/pdf' }]
            : [],
        };
      }
      if (text.includes('FROM institution_document_versions v')) return { rows: [] };
      return { rows: [] };
    },
    async connect() {
      throw new Error('unexpected');
    },
  };
  try {
    const router = createInstitutionDocumentsRouter(database);
    const list = await invoke(routeHandlers(router, 'get', '/center/documents'), {
      method: 'GET',
      path: '/center/documents',
      token: tokens.center,
    });
    assert.equal(list.status, 200);
    assert.match(queries[0].text, /WHERE d\.institution_id = \$1/);
    assert.deepEqual(queries[0].values, ['center-a']);

    const content = await invoke(routeHandlers(router, 'get', '/center/documents/versions/:versionId/content'), {
      method: 'GET',
      path: '/center/documents/versions/version/content',
      params: { versionId: '00000000-0000-4000-8000-000000000001' },
      token: tokens.center,
    });
    assert.equal(content.status, 200);
    assert.equal((content.body as Buffer).toString('utf8'), pdfBytes.toString('utf8'));
    assert.equal(content.headers['Content-Type'], 'application/pdf');
    assert.match(queries[1].text, /AND d\.institution_id = \$2/);
    assert.deepEqual(queries[1].values, [
      '00000000-0000-4000-8000-000000000001',
      'center-a',
    ]);

    queries.length = 0;
    const otherCenterContent = await invoke(routeHandlers(router, 'get', '/center/documents/versions/:versionId/content'), {
      method: 'GET',
      path: '/center/documents/versions/00000000-0000-4000-8000-000000000001/content',
      params: { versionId: '00000000-0000-4000-8000-000000000001' },
      token: tokens.otherCenter,
    });
    assert.equal(otherCenterContent.status, 404);
    assert.deepEqual(queries[0].values, [
      '00000000-0000-4000-8000-000000000001',
      'center-b',
    ]);
  } finally {
    restore();
    restoreEnvironment();
    await rm(storage, { recursive: true, force: true });
  }
});

test('does not accept an upload even when local file policies are configured', async () => {
  const storage = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'eltnoy-document-test-'));
  const restoreEnvironment = setDocumentEnvironment({
    INSTITUTION_DOCUMENT_STORAGE_DIR: storage,
    INSTITUTION_DOCUMENT_MAX_BYTES: String(pdfBytes.length + 10),
    INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES: 'application/pdf',
    INSTITUTION_DOCUMENT_CARDINALITY: 'multiple',
    INSTITUTION_DOCUMENT_MAX_DOCUMENTS_PER_CATEGORY: '5',
  });
  const restoreAuthentication = installAuthenticationRows();
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const database = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          statements.push({ text, values });
          if (text.includes('FROM users WHERE id = $1')) return { rows: [{ id: 'center-a' }] };
          if (text.includes('COALESCE(MAX(version_number)')) return { rows: [{ latest_version: 0 }] };
          if (text.includes('RETURNING')) return { rows: [{ id: 'synthetic' }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  try {
    const router = createInstitutionDocumentsRouter(database);
    const result = await invoke(routeHandlers(router, 'post', '/center/documents'), {
      method: 'POST',
      path: '/center/documents',
      query: { category: 'PAN Card' },
      token: tokens.center,
      contentType: 'application/octet-stream',
      bytes: pdfBytes,
    });
    assert.equal(result.status, 503);
    assert.match(JSON.stringify(result.body), /uploads are unavailable/i);
    assert.deepEqual(statements, []);
  } finally {
    restoreAuthentication();
    restoreEnvironment();
    await rm(storage, { recursive: true, force: true });
  }
});

test('keeps invalid-content upload requests disabled before touching storage or database', async () => {
  const storage = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'eltnoy-document-invalid-'));
  const restoreEnvironment = setDocumentEnvironment({
    INSTITUTION_DOCUMENT_STORAGE_DIR: storage,
    INSTITUTION_DOCUMENT_MAX_BYTES: '2048',
    INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES: 'application/pdf',
    INSTITUTION_DOCUMENT_CARDINALITY: 'single',
  });
  const restoreAuthentication = installAuthenticationRows();
  try {
    const router = createInstitutionDocumentsRouter({
      async query() { return { rows: [] }; },
      async connect() { throw new Error('invalid content must not write database records'); },
    });
    const result = await invoke(routeHandlers(router, 'post', '/center/documents'), {
      method: 'POST',
      path: '/center/documents',
      query: { category: 'PAN Card' },
      token: tokens.center,
      contentType: 'application/octet-stream',
      bytes: Buffer.from('This is not a PDF, despite a .pdf name.'),
    });
    assert.equal(result.status, 503);
  } finally {
    restoreAuthentication();
    restoreEnvironment();
    await rm(storage, { recursive: true, force: true });
  }
});

test('keeps oversized upload requests disabled before touching storage or database', async () => {
  const storage = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'eltnoy-document-size-'));
  const restoreEnvironment = setDocumentEnvironment({
    INSTITUTION_DOCUMENT_STORAGE_DIR: storage,
    INSTITUTION_DOCUMENT_MAX_BYTES: '8',
    INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES: 'application/pdf',
    INSTITUTION_DOCUMENT_CARDINALITY: 'single',
  });
  const restoreAuthentication = installAuthenticationRows();
  try {
    const router = createInstitutionDocumentsRouter({
      async query() { return { rows: [] }; },
      async connect() { throw new Error('oversize content must not write database records'); },
    });
    const result = await invoke(routeHandlers(router, 'post', '/center/documents'), {
      method: 'POST',
      path: '/center/documents',
      query: { category: 'PAN Card' },
      token: tokens.center,
      contentType: 'application/octet-stream',
      bytes: pdfBytes,
    });
    assert.equal(result.status, 503);
  } finally {
    restoreAuthentication();
    restoreEnvironment();
    await rm(storage, { recursive: true, force: true });
  }
});

test('records official remarks as append-only history without inventing a decision', async () => {
  const restoreEnvironment = setDocumentEnvironment({});
  const restoreAuthentication = installAuthenticationRows();
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const database = {
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      if (text.startsWith('SELECT id FROM institution_document_versions')) {
        return { rows: [{ id: values?.[0] }] };
      }
      if (text.includes('INSERT INTO institution_document_review_history')) {
        return { rows: [{
          id: 'review-id',
          version_id: values?.[1],
          decision_code: values?.[3],
          reviewer_remarks: values?.[4],
          reviewed_at: '2026-11-01T00:00:00Z',
        }] };
      }
      throw new Error(`Unexpected review-history query: ${text}`);
    },
    async connect() {
      throw new Error('unexpected');
    },
  };
  try {
    const router = createInstitutionDocumentsRouter(database);
    const result = await invoke(routeHandlers(router, 'post', '/admin/institution-documents/versions/:versionId/reviews'), {
      method: 'POST',
      path: '/admin/institution-documents/versions/00000000-0000-4000-8000-000000000001/reviews',
      params: { versionId: '00000000-0000-4000-8000-000000000001' },
      token: tokens.superAdmin,
      body: { remarks: 'Synthetic verification note.' },
    });
    assert.equal(result.status, 201);
    const insert = statements.find(({ text }) => text.includes('INSERT INTO institution_document_review_history'));
    assert.ok(insert);
    assert.equal(insert.values?.[2], 'super-admin');
    assert.equal(insert.values?.[3], null);
    assert.equal(insert.values?.[4], 'Synthetic verification note.');
  } finally {
    restoreAuthentication();
    restoreEnvironment();
  }
});

test('does not accept an unconfigured review decision', async () => {
  const restoreEnvironment = setDocumentEnvironment({});
  const restoreAuthentication = installAuthenticationRows();
  let inserted = false;
  const database = {
    async query(text: string) {
      if (text.startsWith('SELECT id FROM institution_document_versions')) return { rows: [{ id: 'version' }] };
      if (text.includes('INSERT INTO institution_document_review_history')) inserted = true;
      return { rows: [] };
    },
    async connect() {
      throw new Error('unexpected');
    },
  };
  try {
    const router = createInstitutionDocumentsRouter(database);
    const result = await invoke(routeHandlers(router, 'post', '/admin/institution-documents/versions/:versionId/reviews'), {
      method: 'POST',
      path: '/admin/institution-document-versions/version/reviews',
      params: { versionId: '00000000-0000-4000-8000-000000000001' },
      token: tokens.superAdmin,
      body: { decisionCode: 'approved', remarks: 'Synthetic review note.' },
    });
    assert.equal(result.status, 400);
    assert.equal(inserted, false);
  } finally {
    restoreAuthentication();
    restoreEnvironment();
  }
});

test('ordinary Officials cannot open document content or record reviews, before any database access (A-09, P3-D10)', async () => {
  const restoreEnvironment = setDocumentEnvironment({});
  const restoreAuthentication = installAuthenticationRows();
  const statements: string[] = [];
  const database = {
    async query(text: string) {
      statements.push(text);
      return { rows: [] };
    },
    async connect() {
      statements.push('connect');
      throw new Error('unexpected');
    },
  };
  try {
    const router = createInstitutionDocumentsRouter(database);
    const versionId = '00000000-0000-4000-8000-000000000001';
    const content = await invoke(routeHandlers(router, 'get', '/admin/institution-documents/versions/:versionId/content'), {
      method: 'GET',
      path: `/admin/institution-documents/versions/${versionId}/content`,
      params: { versionId },
      token: tokens.official,
    });
    assert.equal(content.status, 403);
    const review = await invoke(routeHandlers(router, 'post', '/admin/institution-documents/versions/:versionId/reviews'), {
      method: 'POST',
      path: `/admin/institution-documents/versions/${versionId}/reviews`,
      params: { versionId },
      token: tokens.official,
      body: { remarks: 'Synthetic review note.' },
    });
    assert.equal(review.status, 403);
    assert.deepEqual(statements, [], 'no document query, file read or connection for a refused request');
    // The metadata list stays available to ordinary Officials.
    const list = await invoke(routeHandlers(router, 'get', '/admin/institution-documents'), {
      method: 'GET',
      path: '/admin/institution-documents',
      token: tokens.official,
    });
    assert.equal(list.status, 200);
  } finally {
    restoreAuthentication();
    restoreEnvironment();
  }
});

test('does not accept document replacement while upload policies are disabled', async () => {
  const storage = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'eltnoy-document-version-'));
  const restoreEnvironment = setDocumentEnvironment({
    INSTITUTION_DOCUMENT_STORAGE_DIR: storage,
    INSTITUTION_DOCUMENT_MAX_BYTES: '2048',
    INSTITUTION_DOCUMENT_ALLOWED_MIME_TYPES: 'application/pdf',
    INSTITUTION_DOCUMENT_CARDINALITY: 'single',
    INSTITUTION_DOCUMENT_REPLACEMENT_ENABLED: 'true',
    INSTITUTION_DOCUMENT_MAX_VERSIONS_PER_DOCUMENT: '5',
  });
  const restoreAuthentication = installAuthenticationRows();
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const database = {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          statements.push({ text, values });
          if (text.includes('FROM institution_documents') && text.includes('FOR UPDATE')) {
            return { rows: [{ id: values?.[0], category: 'PAN Card' }] };
          }
          if (text === 'SELECT category FROM institution_documents WHERE id = $1 AND institution_id = $2') {
            return { rows: [{ category: 'PAN Card' }] };
          }
          if (text.includes('COALESCE(MAX(version_number)')) return { rows: [{ latest_version: 2 }] };
          if (text.includes('INSERT INTO institution_document_versions')) return { rows: [{ id: 'new-version' }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  try {
    const router = createInstitutionDocumentsRouter(database);
    const result = await invoke(routeHandlers(router, 'put', '/center/documents/:documentId/versions'), {
      method: 'PUT',
      path: '/center/documents/00000000-0000-4000-8000-000000000002/versions',
      params: { documentId: '00000000-0000-4000-8000-000000000002' },
      token: tokens.center,
      contentType: 'application/octet-stream',
      bytes: pdfBytes,
    });
    assert.equal(result.status, 503);
    assert.match(JSON.stringify(result.body), /uploads are unavailable/i);
    assert.deepEqual(statements, []);
  } finally {
    restoreAuthentication();
    restoreEnvironment();
    await rm(storage, { recursive: true, force: true });
  }
});
