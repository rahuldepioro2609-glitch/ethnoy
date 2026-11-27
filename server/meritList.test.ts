// Merit List Engine foundation: computation, CSV, routes (transaction, duplicates, audit) and the
// migration's static shape. Route authorization (401/403 for everyone but Super Admin) is in the
// route matrix of server/adminAuthorization.test.ts; append-only behaviour on a real database in
// server/databaseGrants.postgres.integration.test.ts. Synthetic data only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:9/merit_unit_tests';

const { analyseMeritResults, meritEntriesToCsv, MERIT_CSV_HEADER } = await import('./meritList.js');
const { createMeritListRouter, MERIT_SQL } = await import('./meritListRoutes.js');
const { AUDIT_INSERT_SQL } = await import('./audit.js');
type MeritResultRecord = import('./meritList.js').MeritResultRecord;

function card(roll: string, total: number, options: { max?: number; sections?: Array<[number, number]>; rank?: number; app?: string; exam?: string } = {}) {
  const sections = options.sections ?? [[total, options.max ?? 300]];
  return {
    rollNumber: roll, applicationNumber: options.app ?? `APP-${roll}`, examCode: options.exam ?? 'DEMO-1',
    candidateName: `Synthetic ${roll}`, dob: '2008-01-01', category: 'General',
    sectionScores: sections.map(([marksObtained, maxMarks], i) => ({ sectionName: `S${i}`, marksObtained, maxMarks, percentile: 50 })),
    totalMarksObtained: total, totalMaxMarks: options.max ?? 300, allIndiaRank: options.rank ?? 0,
  };
}
const record = (roll: string, total: number, options: Parameters<typeof card>[2] & { published?: boolean } = {}): MeritResultRecord => ({
  resultId: `result-${roll}`, applicationNumber: `APP-${roll}`, rollNumber: roll, examCode: 'DEMO-1', isPublished: options.published ?? false, scorecard: card(roll, total, options),
});

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

test('orders by total marks, highest first, with shared position ranges for unresolved ties', () => {
  const analysis = analyseMeritResults('demo-1', [record('R3', 250), record('R1', 280), record('R4', 250), record('R2', 250), record('R5', 100)]);
  assert.equal(analysis.examCode, 'DEMO-1');
  assert.deepEqual(analysis.entries.map((e) => [e.rollNumber, e.positionFrom, e.positionTo, e.tieGroup]), [
    ['R1', 1, 1, null], ['R2', 2, 4, 1], ['R3', 2, 4, 1], ['R4', 2, 4, 1], ['R5', 5, 5, null],
  ], 'no tie-break and no rank numbering convention is applied (ML-1, ML-2)');
  assert.deepEqual(analysis.tieGroups, [{ tieGroup: 1, totalMarks: 250, positionFrom: 2, positionTo: 4, size: 3 }]);
  assert.equal(analysis.summary.tieGroupCount, 1);
});

test('decimal totals that differ only by floating-point noise are one tie group', () => {
  const analysis = analyseMeritResults('DEMO-1', [record('A', 0.1 + 0.2, { sections: [[0.1, 150], [0.2, 150]] }), record('B', 0.3, { sections: [[0.3, 300]] })]);
  assert.equal(analysis.tieGroups.length, 1);
  assert.deepEqual(analysis.entries.map((e) => e.issues), [[], []]);
});

test('arithmetic checks flag inconsistent scorecards without changing them', () => {
  const records = [
    record('OK', 200, { sections: [[120, 150], [80, 150]] }),
    record('SUM', 200, { sections: [[120, 150], [70, 150]] }),
    record('MAX', 200, { sections: [[120, 100], [80, 100]], max: 300 }),
    record('OVER', 320, { sections: [[320, 300]] }),
    record('ID', 150, { app: 'SOMEONE-ELSE' }),
  ];
  const before = JSON.stringify(records);
  const analysis = analyseMeritResults('DEMO-1', records);
  assert.equal(JSON.stringify(records), before, 'inputs are never mutated');
  const issues = Object.fromEntries(analysis.entries.map((e) => [e.rollNumber, e.issues]));
  assert.deepEqual(issues.OK, []);
  assert.deepEqual(issues.SUM, ['section_sum_mismatch']);
  assert.deepEqual(issues.MAX, ['maximum_sum_mismatch', 'section_above_maximum']);
  assert.deepEqual(issues.OVER, ['total_above_maximum', 'section_above_maximum']);
  assert.deepEqual(issues.ID, ['identity_mismatch']);
  assert.equal(analysis.summary.entriesWithIssues, 4);
});

test('unreadable scorecards are excluded from the order and reported', () => {
  const broken: MeritResultRecord = { resultId: 'bad', applicationNumber: 'APP-X', rollNumber: 'X', examCode: 'DEMO-1', isPublished: false, scorecard: { totalMarksObtained: 'ninety' } };
  const analysis = analyseMeritResults('DEMO-1', [record('A', 10), broken, { ...broken, resultId: 'null', scorecard: null }]);
  assert.equal(analysis.entries.length, 1);
  assert.deepEqual(analysis.excluded.map((e) => [e.resultId, e.issues]), [['bad', ['scorecard_unreadable']], ['null', ['scorecard_unreadable']]]);
  assert.equal(analysis.summary.excludedCount, 2);
});

test('imported ranks that contradict the marks order are flagged; ranks inside a tie group are not', () => {
  const analysis = analyseMeritResults('DEMO-1', [
    record('TOP', 290, { rank: 2 }), record('SECOND', 280, { rank: 1 }), // fewer marks, better rank
    record('T1', 250, { rank: 4 }), record('T2', 250, { rank: 3 }), // a tie: any order is fine
    record('NORANK', 100),
  ]);
  const flagged = analysis.entries.filter((e) => e.issues.includes('imported_rank_conflict')).map((e) => e.rollNumber);
  assert.deepEqual(flagged, ['SECOND']);
});

test('the fingerprint is stable for equal inputs and changes when any input changes', () => {
  const base = [record('A', 10), record('B', 20)];
  const a = analyseMeritResults('DEMO-1', base).fingerprint;
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(analyseMeritResults('DEMO-1', [...base].reverse()).fingerprint, a, 'input order does not matter');
  assert.notEqual(analyseMeritResults('DEMO-1', [record('A', 11), record('B', 20)]).fingerprint, a, 'a mark change');
  assert.notEqual(analyseMeritResults('DEMO-1', [record('A', 10), record('B', 20, { published: true })]).fingerprint, a, 'a publication change');
  assert.notEqual(analyseMeritResults('DEMO-2', base).fingerprint, a, 'another exam');
});

test('entries never carry names, dates of birth, categories or section marks', () => {
  const [entry] = analyseMeritResults('DEMO-1', [record('A', 10)]).entries;
  assert.deepEqual(Object.keys(entry).sort(), ['applicationNumber', 'importedRank', 'isPublished', 'issues', 'maxMarks', 'positionFrom', 'positionTo', 'resultId', 'rollNumber', 'tieGroup', 'totalMarks']);
  assert.doesNotMatch(JSON.stringify(analyseMeritResults('DEMO-1', [record('A', 10)])), /Synthetic|2008-01-01|General/);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test('CSV export shows shared ranges, keeps numbers numeric and neutralises formulas', () => {
  const entries = analyseMeritResults('DEMO-1', [record('=HYPERLINK("x")', -5, { sections: [[-5, 300]] }), record('B,1', 10)]).entries;
  const lines = meritEntriesToCsv(entries).trimEnd().split('\r\n');
  assert.equal(lines[0], MERIT_CSV_HEADER.join(','));
  assert.equal(lines[1], '1,1,,"APP-B,1","B,1",10,300,,draft,', 'commas are quoted');
  assert.equal(lines[2], `2,2,,"APP-=HYPERLINK(""x"")","'=HYPERLINK(""x"")",-5,300,,draft,`, 'a formula-like text cell is prefixed; a negative number is not');
});

// ---------------------------------------------------------------------------
// Routes (fake database; guards are covered by the route matrix)
// ---------------------------------------------------------------------------

interface Call { text: string; values: unknown[]; via: 'pool' | 'client' }

function fakeDatabase(options: { results?: MeritResultRecord[]; existing?: { id: string; version: number } | null; nextVersion?: number; failAudit?: boolean; snapshot?: Record<string, unknown> | null; missingTable?: boolean } = {}) {
  const calls: Call[] = [];
  const rowsOf = (records: MeritResultRecord[]) => records.map((r) => ({ id: r.resultId, application_number: r.applicationNumber, roll_number: r.rollNumber, exam_code: r.examCode, is_published: r.isPublished, scorecard: r.scorecard }));
  const run = async (text: string, values: unknown[] = [], via: 'pool' | 'client') => {
    calls.push({ text, values, via });
    if (options.missingTable && text.includes('merit_list_snapshots')) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    if (text === MERIT_SQL.results) return { rows: rowsOf(options.results ?? []) };
    if (text === MERIT_SQL.existingFingerprint) return { rows: options.existing ? [options.existing] : [] };
    if (text === MERIT_SQL.nextVersion) return { rows: [{ next_version: options.nextVersion ?? 1 }] };
    if (text === MERIT_SQL.insert) return { rows: [{ id: values[0], exam_code: values[1], version: values[2], status: 'draft', created_at: '2026-11-27T12:00:00Z' }] };
    if (text === MERIT_SQL.one) return { rows: options.snapshot ? [options.snapshot] : [] };
    if (text === MERIT_SQL.list) return { rows: [] };
    if (text === AUDIT_INSERT_SQL && options.failAudit) throw new Error('audit unavailable');
    return { rows: [] };
  };
  return {
    calls,
    database: {
      query: (text: string, values?: unknown[]) => run(text, values, 'pool'),
      connect: async () => ({ query: (text: string, values?: unknown[]) => run(text, values, 'client'), release() {} }),
    },
    statements: () => calls.map(({ text }) => {
      const named = Object.entries(MERIT_SQL).find(([, sql]) => sql === text)?.[0];
      return named ?? (text === AUDIT_INSERT_SQL ? 'audit' : text);
    }),
  };
}

async function call(db: ReturnType<typeof fakeDatabase>, method: 'get' | 'post', path: string, params: Record<string, string>, body?: unknown) {
  const router = createMeritListRouter({ database: db.database as never });
  const layer = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => unknown }> } }>)
    .find((item) => item.route?.path === path && item.route.methods[method])!;
  const handler = layer.route!.stack.at(-1)!.handle;
  const result: { status: number; body: unknown; headers: Record<string, string>; sent?: string; failure?: unknown } = { status: 200, body: undefined, headers: {} };
  await new Promise<void>((resolve) => {
    const res = {
      set(name: string, value: string) { result.headers[name] = value; return res; },
      setHeader(name: string, value: string) { result.headers[name] = value; return res; },
      type(value: string) { result.headers['Content-Type'] = value; return res; },
      status(code: number) { result.status = code; return res; },
      json(value: unknown) { result.body = value; resolve(); return res; },
      send(value: string) { result.sent = value; resolve(); return res; },
    } as unknown as Response;
    const req = { params, body, user: { id: 'synthetic-super-admin', role: 'official', isSuperAdmin: true } } as unknown as Request;
    handler(req, res, (error?: unknown) => { result.failure = error; resolve(); });
  });
  return result;
}

const RESULTS = [record('R1', 280), record('R2', 250), record('R3', 250)];

test('preview: read-only, no names, ties and blocked rules listed', async () => {
  const db = fakeDatabase({ results: RESULTS });
  const result = await call(db, 'get', '/admin/merit-lists/:examCode/preview', { examCode: 'demo-1' });
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  const body = result.body as { entries: unknown[]; tieGroups: unknown[]; fingerprint: string; blockedRules: string[] };
  assert.equal(body.entries.length, 3);
  assert.equal(body.tieGroups.length, 1);
  assert.ok(body.blockedRules.some((rule) => /Tie-breaking/.test(rule)));
  assert.doesNotMatch(JSON.stringify(body), /Synthetic R|2008-01-01/);
  assert.deepEqual(db.statements(), ['results'], 'one read, no write');
  assert.equal(db.calls[0].values[0], 'DEMO-1', 'exam codes are normalised to upper case');
});

test('saving a version: one transaction, exam lock, insert and audit row; it must match the reviewed preview', async () => {
  const fingerprint = analyseMeritResults('DEMO-1', RESULTS).fingerprint;
  const db = fakeDatabase({ results: RESULTS, nextVersion: 3 });
  const result = await call(db, 'post', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' }, { expectedFingerprint: fingerprint });
  assert.equal(result.status, 201);
  assert.deepEqual(db.statements(), ['BEGIN', 'lockExam', 'results', 'existingFingerprint', 'nextVersion', 'insert', 'audit', 'COMMIT']);
  assert.ok(db.calls.every((c) => c.via === 'client'), 'everything runs on the one transaction client');
  const insert = db.calls.find((c) => c.text === MERIT_SQL.insert)!;
  assert.deepEqual([insert.values[1], insert.values[2], insert.values[4], insert.values[12]], ['DEMO-1', 3, fingerprint, 'synthetic-super-admin']);
  assert.doesNotMatch(String(insert.values[10]), /Synthetic R|2008-01-01|General/, 'stored entries carry no personal details');
  const audit = db.calls.find((c) => c.text === AUDIT_INSERT_SQL)!;
  assert.equal(audit.values[1], 'merit_list.snapshot_created');
  assert.deepEqual(JSON.parse(String(audit.values[10])), { exam_code: 'DEMO-1', version: 3, entry_count: 3, excluded_count: 0, tie_group_count: 1, issue_count: 0 });
});

test('results changed since the preview: refused, nothing written', async () => {
  const db = fakeDatabase({ results: RESULTS });
  const result = await call(db, 'post', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' }, { expectedFingerprint: 'a'.repeat(64) });
  assert.equal(result.status, 409);
  assert.equal((result.body as { code: string }).code, 'RESULTS_CHANGED');
  assert.deepEqual(db.statements(), ['BEGIN', 'lockExam', 'results', 'ROLLBACK']);
});

test('the same inputs cannot create a second version (duplicate processing)', async () => {
  const fingerprint = analyseMeritResults('DEMO-1', RESULTS).fingerprint;
  const db = fakeDatabase({ results: RESULTS, existing: { id: 'snap-1', version: 2 } });
  const result = await call(db, 'post', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' }, { expectedFingerprint: fingerprint });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: 'These exact results are already saved as version 2.', code: 'DUPLICATE_SNAPSHOT', snapshotId: 'snap-1', version: 2 });
  assert.ok(!db.statements().includes('insert'));
  assert.equal(db.statements().at(-1), 'ROLLBACK');
});

test('a failed audit write rolls the version back (A-11)', async () => {
  const fingerprint = analyseMeritResults('DEMO-1', RESULTS).fingerprint;
  const db = fakeDatabase({ results: RESULTS, failAudit: true });
  const result = await call(db, 'post', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' }, { expectedFingerprint: fingerprint });
  assert.match(String(result.failure), /audit unavailable/);
  assert.equal(db.statements().at(-1), 'ROLLBACK');
  assert.ok(!db.statements().includes('COMMIT'));
});

test('saving needs the reviewed fingerprint, a valid exam code and existing results', async () => {
  const db = fakeDatabase({ results: [] });
  assert.equal((await call(db, 'post', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' }, {})).status, 400);
  assert.equal((await call(db, 'post', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' }, { expectedFingerprint: 'a'.repeat(64), publish: true })).status, 400, 'unknown fields (for example a publish flag) are refused');
  assert.equal((await call(db, 'get', '/admin/merit-lists/:examCode/preview', { examCode: "x'; DROP" })).status, 400);
  assert.deepEqual(db.statements(), [], 'refused before any query');
  const empty = analyseMeritResults('DEMO-1', []).fingerprint;
  const none = await call(db, 'post', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' }, { expectedFingerprint: empty });
  assert.equal(none.status, 404);
});

const SNAPSHOT_ROW = {
  id: '00000000-0000-4000-8000-000000000009', exam_code: 'DEMO-1', version: 2, status: 'draft', engine_version: 'merit-foundation-v1',
  input_fingerprint: 'b'.repeat(64), result_count: 2, entry_count: 2, excluded_count: 0, tie_group_count: 0, issue_count: 0,
  entries: analyseMeritResults('DEMO-1', [record('R1', 280), record('R2', 250)]).entries, excluded: [], created_by: 'synthetic-super-admin', created_at: '2026-11-27T12:00:00Z',
};

test('export: audited before the CSV is sent; file name and content carry no personal details', async () => {
  const db = fakeDatabase({ snapshot: SNAPSHOT_ROW });
  const result = await call(db, 'get', '/admin/merit-lists/snapshots/:snapshotId/export', { snapshotId: SNAPSHOT_ROW.id });
  assert.match(String(result.sent), /^Position from,Position to,/);
  assert.match(result.headers['Content-Disposition'], /filename="merit-list-DEMO-1-v2-draft\.csv"/);
  assert.deepEqual(db.statements(), ['one', 'BEGIN', 'audit', 'COMMIT']);
  const audit = db.calls.find((c) => c.text === AUDIT_INSERT_SQL)!;
  assert.deepEqual([audit.values[1], JSON.parse(String(audit.values[10]))], ['merit_list.exported', { exam_code: 'DEMO-1', version: 2, row_count: 2 }]);

  const failing = fakeDatabase({ snapshot: SNAPSHOT_ROW, failAudit: true });
  const refused = await call(failing, 'get', '/admin/merit-lists/snapshots/:snapshotId/export', { snapshotId: SNAPSHOT_ROW.id });
  assert.equal(refused.sent, undefined, 'nothing is sent when the export cannot be recorded');
  assert.match(String(refused.failure), /audit unavailable/);
});

test('version detail and history; invalid or unknown versions; migration not installed', async () => {
  const db = fakeDatabase({ snapshot: SNAPSHOT_ROW });
  const detail = await call(db, 'get', '/admin/merit-lists/snapshots/:snapshotId', { snapshotId: SNAPSHOT_ROW.id });
  assert.equal((detail.body as { snapshot: { version: number; status: string } }).snapshot.version, 2);
  assert.equal((detail.body as { snapshot: { status: string } }).snapshot.status, 'draft');
  assert.equal((await call(db, 'get', '/admin/merit-lists/snapshots/:snapshotId', { snapshotId: 'not-a-uuid' })).status, 400);
  assert.equal((await call(fakeDatabase({ snapshot: null }), 'get', '/admin/merit-lists/snapshots/:snapshotId', { snapshotId: SNAPSHOT_ROW.id })).status, 404);
  const missing = await call(fakeDatabase({ missingTable: true }), 'get', '/admin/merit-lists/:examCode/snapshots', { examCode: 'DEMO-1' });
  assert.equal(missing.status, 503);
});

test('no route approves, publishes, finalises, breaks ties, applies cut-offs or ranks by category (ML-1 to ML-6)', () => {
  const router = createMeritListRouter({ database: fakeDatabase().database as never });
  const paths = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>).flatMap((item) => item.route ? Object.keys(item.route.methods).map((m) => `${m.toUpperCase()} ${item.route!.path}`) : []);
  assert.deepEqual(paths.sort(), [
    'GET /admin/merit-lists/:examCode/preview', 'GET /admin/merit-lists/:examCode/snapshots', 'GET /admin/merit-lists/snapshots/:snapshotId',
    'GET /admin/merit-lists/snapshots/:snapshotId/export', 'POST /admin/merit-lists/:examCode/snapshots',
  ]);
  for (const path of paths) assert.doesNotMatch(path, /publish|approve|final|cutoff|cut-off|category|tie/i);
});

test('the migration is append-only, draft-only, duplicate-proof and stores no personal columns', async () => {
  const sql = (await readFile(new URL('./meritListMigration.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
  assert.match(sql, /status\s+text\s+NOT NULL DEFAULT 'draft' CHECK \(status = 'draft'\)/, 'no published state until ML-6 is approved');
  assert.match(sql, /UNIQUE \(exam_code, version\)/);
  assert.match(sql, /UNIQUE \(exam_code, input_fingerprint\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON merit_list_snapshots/);
  assert.match(sql, /BEFORE TRUNCATE ON merit_list_snapshots/);
  assert.doesNotMatch(sql, /REFERENCES|IDENTITY|SERIAL|SEQUENCE/i);
  assert.doesNotMatch(sql, /candidate_name|date_of_birth|\bdob\b|category|email|phone|mobile/i);
  const grants = await readFile(new URL('./databaseGrantsMigration.sql', import.meta.url), 'utf8');
  assert.match(grants, /\('merit_list_snapshots',\s+'SELECT, INSERT',\s+NULL\)/);
});
