// Institute Workspace server routes: D-02 publication rules, tenant isolation, validation and guards.
// No real database: the shared pool's query is replaced with a scripted fake. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:9/workspace_unit_tests';

const [{ createInstituteWorkspaceRouter, isInstituteExamTransition, isValidExamTransition, EXAM_LIFECYCLE_TRANSITIONS, QUESTION_MODERATION_TRANSITIONS, questionShapeError }, { pool }, { requireAuth }, { AUDIT_INSERT_SQL }] = await Promise.all([
  import('./instituteWorkspace.js'), import('./db.js'), import('./auth.js'), import('./audit.js'),
]);

/** An audit_events row as written by server/audit.ts (AUDIT_INSERT_SQL parameter order). */
interface AuditRow { action: string; outcome: string; reasonCode: string | null; actorRole: string; organizationId: string | null; resourceId: string | null; metadata: Record<string, unknown> }
const auditRow = (values: unknown[]): AuditRow => ({
  action: String(values[1]), outcome: String(values[2]), reasonCode: values[3] as string | null, actorRole: String(values[6]),
  organizationId: values[7] as string | null, resourceId: values[9] as string | null, metadata: JSON.parse(String(values[10])),
});

const INSTITUTE = 'synthetic-institute-a';
const EXAM = '00000000-0000-4000-8000-0000000000e1';
const FOREIGN = '00000000-0000-4000-8000-0000000000f9';

type Handler = (text: string, values: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number } | undefined;
const mutable = pool as unknown as { query: (text: string, values?: unknown[]) => Promise<unknown>; connect: () => Promise<unknown> };
const original = mutable.query;
const originalConnect = mutable.connect;

async function call(method: 'get' | 'post' | 'patch' | 'put', path: string, options: { params?: Record<string, string>; body?: unknown; handler?: Handler } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  // Audit rows count only once their transaction commits; a ROLLBACK discards them, as PostgreSQL would.
  const audits: AuditRow[] = [];
  mutable.query = async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });
    return options.handler?.(text, values) ?? { rows: [], rowCount: 0 };
  };
  // Transaction clients answer like the pool; BEGIN/COMMIT/ROLLBACK and audit inserts stay out of `queries`
  // so business-statement assertions stay exact. A test that installs its own client keeps it.
  const ownConnect = mutable.connect === originalConnect;
  if (ownConnect) {
    mutable.connect = async () => {
      const pending: AuditRow[] = [];
      return {
        query: async (text: string, values: unknown[] = []) => {
          if (text === AUDIT_INSERT_SQL) { pending.push(auditRow(values)); return { rows: [], rowCount: 1 }; }
          if (text === 'COMMIT') audits.push(...pending.splice(0));
          if (text === 'ROLLBACK') pending.length = 0;
          if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
          queries.push({ text, values });
          return options.handler?.(text, values) ?? { rows: [], rowCount: 0 };
        },
        release() {},
      };
    };
  }
  try {
    const router = createInstituteWorkspaceRouter();
    const layer = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => unknown }> } }>)
      .find((item) => item.route?.path === path && item.route.methods[method]);
    assert.ok(layer, `${method} ${path} exists`);
    const handler = layer.route!.stack.at(-1)!.handle; // the guards are checked separately below
    const result: { status: number; body: Record<string, unknown> | undefined } = { status: 200, body: undefined };
    await new Promise<void>((resolve, reject) => {
      const res = {
        status(code: number) { result.status = code; return res; },
        json(value: Record<string, unknown>) { result.body = value; resolve(); return res; },
        set() { return res; },
      } as unknown as Response;
      const req = { params: options.params ?? {}, body: options.body ?? {}, query: {}, user: { id: INSTITUTE, role: 'center', isSuperAdmin: false } } as unknown as Request;
      Promise.resolve(handler(req, res, (error?: unknown) => (error ? reject(error) : resolve()))).catch(reject);
    });
    return { ...result, queries, audits };
  } finally {
    mutable.query = original;
    if (ownConnect) mutable.connect = originalConnect;
  }
}

// ---------------------------------------------------------------------------
// Guards: every Workspace route needs a signed-in Institute owner
// ---------------------------------------------------------------------------

test('every Workspace route runs requireAuth and requireRoles(center) before its handler', () => {
  const router = createInstituteWorkspaceRouter();
  const routes = (router.stack as Array<{ route?: { path: string; stack: Array<{ handle: unknown; name: string }> } }>).filter((item) => item.route);
  assert.ok(routes.length >= 50, `found ${routes.length} routes`);
  for (const { route } of routes) {
    assert.equal(route!.stack[0].handle, requireAuth, `${route!.path}: requireAuth first`);
    assert.ok(route!.stack.length >= 3, `${route!.path}: a role guard before the handler`);
    assert.match(route!.path, /^\/center\//, `${route!.path}: Institute namespace only`);
  }
});

// ---------------------------------------------------------------------------
// D-02: Institutes prepare; the Super Admin approves and publishes
// ---------------------------------------------------------------------------

test('D-02: Institutes may only make preparation transitions', () => {
  const allowed: Array<[string, string]> = [];
  for (const [from, targets] of Object.entries(EXAM_LIFECYCLE_TRANSITIONS)) {
    for (const to of targets) if (isInstituteExamTransition(from, to)) allowed.push([from, to]);
  }
  assert.deepEqual(allowed.sort(), [
    ['cancelled', 'archived'], ['draft', 'archived'], ['draft', 'cancelled'], ['draft', 'pending_approval'],
    ['needs_changes', 'cancelled'], ['needs_changes', 'draft'], ['needs_changes', 'pending_approval'], ['pending_approval', 'cancelled'],
  ].sort());
  for (const official of ['approved', 'needs_changes', 'published', 'registration_open', 'closed']) {
    for (const from of Object.keys(EXAM_LIFECYCLE_TRANSITIONS)) assert.equal(isInstituteExamTransition(from, official), false, `${from} -> ${official}`);
  }
  assert.equal(isValidExamTransition('pending_approval', 'approved'), true, 'the lifecycle itself still allows a Super Admin approval');
});

const examRow = (status: string) => ({ id: EXAM, institute_id: INSTITUTE, lifecycle_status: status });

test('D-02: an Institute cannot approve or publish an exam; nothing is written', async () => {
  for (const [from, to] of [['pending_approval', 'approved'], ['approved', 'published'], ['published', 'registration_open'], ['pending_approval', 'needs_changes'], ['approved', 'cancelled']]) {
    const result = await call('post', '/center/exams/:id/transition', {
      params: { id: EXAM }, body: { status: to, reason: 'Synthetic reason' },
      handler: (text) => (text.startsWith('SELECT * FROM institute_exams') ? { rows: [examRow(from)] } : undefined),
    });
    assert.equal(result.status, 403, `${from} -> ${to}`);
    assert.equal(result.body?.code, 'PUBLICATION_REQUIRES_SUPER_ADMIN');
    assert.ok(!result.queries.some((q) => q.text.includes('UPDATE')), 'no update');
  }
});

test('D-02: submitting for review is a compare-and-set; a concurrent change is reported, not overwritten', async () => {
  const ok = await call('post', '/center/exams/:id/transition', {
    params: { id: EXAM }, body: { status: 'pending_approval' },
    handler: (text) => (text.startsWith('SELECT * FROM institute_exams') ? { rows: [examRow('draft')] } : text.includes('UPDATE institute_exams') ? { rows: [examRow('pending_approval')] } : undefined),
  });
  assert.equal(ok.status, 200);
  const update = ok.queries.find((q) => q.text.includes('UPDATE institute_exams'))!;
  assert.match(update.text, /AND institute_id = \$2 AND lifecycle_status = \$5/);
  assert.deepEqual([update.values[1], update.values[4]], [INSTITUTE, 'draft']);
  assert.doesNotMatch(update.text, /approved_by/, 'an Institute never records an approval');

  const raced = await call('post', '/center/exams/:id/transition', {
    params: { id: EXAM }, body: { status: 'pending_approval' },
    handler: (text) => (text.startsWith('SELECT * FROM institute_exams') ? { rows: [examRow('draft')] } : undefined),
  });
  assert.deepEqual([raced.status, raced.body?.code], [409, 'EXAM_CHANGED']);
});

test('D-02 / A-04: an Institute cannot approve or publish a result, or change an approved one', async () => {
  for (const status of ['approved', 'published']) {
    const result = await call('patch', '/center/results/:id/status', { params: { id: 'r1' }, body: { evaluationStatus: status } });
    assert.deepEqual([result.status, result.body?.code], [403, 'PUBLICATION_REQUIRES_SUPER_ADMIN'], status);
    assert.equal(result.queries.length, 0, 'refused before any query');
  }
  const moderated = await call('patch', '/center/results/:id/status', {
    params: { id: 'r1' }, body: { evaluationStatus: 'moderated' },
    handler: (text) => (text.includes('UPDATE institute_exam_results') ? { rows: [{ id: 'r1', evaluation_status: 'moderated' }] } : undefined),
  });
  assert.equal(moderated.status, 200);
  const update = moderated.queries[0];
  assert.match(update.text, /evaluation_status IN \('pending', 'evaluated', 'moderated'\)/, 'approved or published rows are untouchable');
  assert.doesNotMatch(update.text, /published_at|final_approved_by/);
});

test('D-02 / A-06: an Institute can never release or revoke an admit card', async () => {
  for (const releaseStatus of ['released', 'revoked']) {
    const result = await call('patch', '/center/admit-cards/:id/release', { params: { id: 'h1' }, body: { releaseStatus } });
    assert.deepEqual([result.status, result.body?.code], [403, 'PUBLICATION_REQUIRES_SUPER_ADMIN']);
    assert.equal(result.queries.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Results: tenant isolation, lock and validation
// ---------------------------------------------------------------------------

const resultBody = { examId: EXAM, rollNumber: 'r-100', candidateName: 'Synthetic Candidate', rawScore: 80, maxScore: 100 };

test('results: written only for this Institute\'s own exam, never over an approved or published result', async () => {
  const ok = await call('post', '/center/results', {
    body: resultBody,
    handler: (text) => (text.includes('INSERT INTO institute_exam_results') ? { rows: [{ id: 'r1', inserted: true }] } : undefined),
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body?.corrected, false);
  assert.equal((ok.body?.result as Record<string, unknown>).inserted, undefined, 'the insert flag is not leaked');
  const insert = ok.queries[0];
  assert.match(insert.text, /FROM institute_exams e WHERE e\.id = \$3 AND e\.institute_id = \$2 AND e\.lifecycle_status NOT IN \('cancelled', 'archived'\)/);
  assert.match(insert.text, /DO UPDATE SET\s+candidate_name = EXCLUDED\.candidate_name,/, 'a corrected name is saved');

  const corrected = await call('post', '/center/results', {
    body: { ...resultBody, candidateName: 'Synthetic Corrected' },
    handler: (text) => (text.includes('INSERT INTO institute_exam_results') ? { rows: [{ id: 'r1', candidate_name: 'Synthetic Corrected', inserted: false }] } : undefined),
  });
  assert.deepEqual([corrected.status, corrected.body?.corrected], [200, true], 'a correction is reported as one, not as a new result');
  assert.match(insert.text, /WHERE institute_exam_results\.evaluation_status NOT IN \('approved', 'published'\)/);
  assert.deepEqual([insert.values[1], insert.values[2], insert.values[3]], [INSTITUTE, EXAM, 'R-100']);

  const foreign = await call('post', '/center/results', { body: { ...resultBody, examId: FOREIGN } });
  assert.deepEqual([foreign.status, foreign.body?.error], [404, 'Examination not found.'], "another Institute's exam looks unknown");

  const locked = await call('post', '/center/results', {
    body: resultBody, handler: (text) => (text.startsWith('SELECT lifecycle_status FROM institute_exams') ? { rows: [{ lifecycle_status: 'closed' }] } : undefined),
  });
  assert.deepEqual([locked.status, locked.body?.code], [409, 'RESULT_LOCKED']);
  const closed = await call('post', '/center/results', {
    body: resultBody, handler: (text) => (text.startsWith('SELECT lifecycle_status FROM institute_exams') ? { rows: [{ lifecycle_status: 'cancelled' }] } : undefined),
  });
  assert.deepEqual([closed.status, closed.body?.code], [409, 'EXAM_CLOSED'], 'a cancelled exam takes no results');

  const over = await call('post', '/center/results', { body: { ...resultBody, rawScore: 101 } });
  assert.equal(over.status, 400);
  assert.equal(over.queries.length, 0);
});

// ---------------------------------------------------------------------------
// Tenant isolation for ids in request bodies
// ---------------------------------------------------------------------------

const ownership = (owned: boolean): Handler => (text) => {
  if (/^SELECT 1 FROM institute_(exams|app_forms|training_courses) WHERE id = \$1 AND institute_id = \$2$/.test(text)) return { rows: owned ? [{ '?column?': 1 }] : [] };
  if (text.includes('INSERT INTO') || text.includes('COALESCE(MAX(version)')) return { rows: [{ id: 'new', next_version: 1 }] };
  return undefined;
};

for (const [label, method, path, body, what] of [
  ['application form', 'post', '/center/app-forms', { title: 'Synthetic form', examId: FOREIGN, fields: [{ id: 'name', key: 'name', label: 'Name', type: 'text', required: true }] }, 'Examination'],
  ['application (exam)', 'post', '/center/applications', { candidateName: 'Synthetic Candidate', examId: FOREIGN }, 'Examination'],
  ['admit-card template', 'post', '/center/admit-cards/templates', { templateName: 'Synthetic template', headerTitle: 'Synthetic header', examId: FOREIGN }, 'Examination'],
  ['paper blueprint', 'post', '/center/paper-blueprints', { title: 'Synthetic blueprint', durationMinutes: 60, questionIds: ['00000000-0000-4000-8000-0000000000a1'], examId: FOREIGN }, 'Examination'],
  ['attendance mark', 'post', '/center/attendance/mark', { rollNumber: 'R-1', candidateName: 'Synthetic Candidate', status: 'present', reason: 'Synthetic manual mark', examId: FOREIGN }, 'Examination'],
  ['training session', 'post', '/center/training/sessions', { title: 'Synthetic session', sessionDate: '2026-12-01', sessionTime: '10:00', courseId: FOREIGN }, 'Course'],
  ['training enrollment', 'post', '/center/training/enrollments', { courseId: FOREIGN, learnerName: 'Synthetic Learner' }, 'Course'],
] as const) {
  test(`tenant isolation: a ${label} cannot reference another Institute's ${what.toLowerCase()}`, async () => {
    const result = await call(method, path, { body, handler: ownership(false) });
    assert.deepEqual([result.status, result.body?.error], [404, `${what} not found.`]);
    assert.ok(!result.queries.some((q) => q.text.includes('INSERT INTO')), 'nothing written');
    const check = result.queries.find((q) => q.text.startsWith('SELECT 1 FROM institute_'))!;
    assert.deepEqual(check.values, [FOREIGN, INSTITUTE], 'checked against the session Institute, not the request');
  });
}

test('tenant isolation: an application form referencing another Institute\'s form is refused', async () => {
  const result = await call('post', '/center/applications', {
    body: { candidateName: 'Synthetic Candidate', formId: FOREIGN },
    handler: (text) => (text.startsWith('SELECT 1 FROM institute_app_forms') ? { rows: [] } : ownership(true)(text, [])),
  });
  assert.deepEqual([result.status, result.body?.error], [404, 'Application form not found.']);
  assert.ok(!result.queries.some((q) => q.text.includes('INSERT INTO')));
});

test('the Workspace screen offers exactly the exam actions the server allows an Institute (D-02)', async () => {
  const { instituteExamActions } = await import('../src/utils/workspaceExams.js');
  for (const [from, targets] of Object.entries(EXAM_LIFECYCLE_TRANSITIONS)) {
    const offered = instituteExamActions(from).map((action) => action.to).sort();
    const allowed = targets.filter((to) => isInstituteExamTransition(from, to)).sort();
    assert.deepEqual(offered, allowed, `actions offered from ${from}`);
  }
});

test('admit cards: generated in one locked transaction; only inserted rows count; seats continue; drafts only', async () => {
  const log: string[] = [];
  const mutableConnect = pool as unknown as { connect: () => Promise<unknown> };
  const originalConnect = mutableConnect.connect;
  let insertCalls = 0;
  const cardAudits: AuditRow[] = [];
  mutableConnect.connect = async () => ({
    query: async (text: string, values: unknown[] = []) => {
      if (text === AUDIT_INSERT_SQL) { cardAudits.push(auditRow(values)); log.push('AUDIT'); return { rows: [], rowCount: 1 }; }
      log.push(text.startsWith('INSERT INTO institute_hall_tickets') ? `INSERT seat=${String(values[8])}` : text.replace(/\s+/g, ' ').slice(0, 40));
      if (text.includes('FROM institute_candidate_applications a')) return { rows: [{ id: 'app-1', candidate_name: 'Synthetic One' }, { id: 'app-2', candidate_name: 'Synthetic Two' }] };
      if (text.includes('AS existing')) return { rows: [{ existing: 3 }] };
      if (text.startsWith('INSERT INTO institute_hall_tickets')) { insertCalls += 1; return { rowCount: insertCalls === 1 ? 1 : 0, rows: [] }; } // the 2nd was inserted concurrently elsewhere
      return { rows: [], rowCount: 0 };
    },
    release() {},
  });
  try {
    const result = await call('post', '/center/admit-cards/generate', {
      body: { examId: EXAM, centerCode: 'c-1', centerName: 'Synthetic Centre' },
      handler: (text) => (text.startsWith('SELECT id, exam_code, exam_date') ? { rows: [{ id: EXAM, exam_code: 'DEMO-1', exam_date: '2027-01-10', exam_time: '10:00' }] } : undefined),
    });
    assert.deepEqual([result.status, result.body?.generated], [201, 1], 'a skipped insert is not counted');
    assert.equal(log[0], 'BEGIN');
    assert.match(log[1], /pg_advisory_xact_lock/);
    assert.deepEqual(log.filter((line) => line.startsWith('INSERT')), ['INSERT seat=S-4', 'INSERT seat=S-5'], 'seats continue after the 3 existing cards');
    assert.deepEqual(log.slice(-2), ['AUDIT', 'COMMIT'], 'the generation and its audit event commit together');
    assert.deepEqual(cardAudits.map((a) => [a.action, a.organizationId, a.resourceId, a.metadata.row_count, a.metadata.exam_code]), [['workspace_admit_cards.generated', INSTITUTE, EXAM, 1, 'DEMO-1']]);
    assert.ok(!log.some((line) => /release_status/.test(line)), 'never released here');
  } finally {
    mutableConnect.connect = originalConnect;
  }
});

test('admit cards: another Institute\'s exam is refused before any write', async () => {
  const result = await call('post', '/center/admit-cards/generate', { body: { examId: FOREIGN, centerCode: 'C-1', centerName: 'Synthetic Centre' } });
  assert.deepEqual([result.status, result.body?.error], [404, 'Examination not found.']);
});

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

test('applications: an Institute can never mark a fee as paid (no payment is verified here)', async () => {
  const paid = await call('post', '/center/applications', { body: { candidateName: 'Synthetic Candidate', paymentStatus: 'paid' } });
  assert.equal(paid.status, 400);
  assert.equal(paid.queries.length, 0, 'refused before any query');
  const extra = await call('post', '/center/applications', { body: { candidateName: 'Synthetic Candidate', reviewStatus: 'verified' } });
  assert.equal(extra.status, 400, 'unknown fields (for example a review status) are refused');
  const waived = await call('post', '/center/applications', {
    body: { candidateName: 'Synthetic Candidate', paymentStatus: 'waived' },
    handler: (text) => (text.includes('INSERT INTO institute_candidate_applications') ? { rows: [{ id: 'a1', payment_status: 'waived' }] } : undefined),
  });
  assert.equal(waived.status, 201);
  const insert = waived.queries.find((q) => q.text.includes('INSERT INTO institute_candidate_applications'))!;
  assert.equal(insert.values[1], INSTITUTE, 'stored under the session Institute');
  assert.equal(insert.values[9], 'waived');
});

test('applications: a review is scoped, changes the status, keeps a released card valid, and writes its history in one transaction', async () => {
  const { APPLICATION_SQL } = await import('./instituteWorkspace.js');
  const noReason = await call('post', '/center/applications/:id/review', { params: { id: 'a1' }, body: { action: 'rejected' } });
  assert.deepEqual([noReason.status, noReason.queries.length], [400, 0]);
  const extra = await call('post', '/center/applications/:id/review', { params: { id: 'a1' }, body: { action: 'verified', reviewerId: 'x' } });
  assert.deepEqual([extra.status, extra.queries.length], [400, 0], 'unknown fields are refused');

  const review = (current: string | null, releasedCard = false) => withFakeClient((text) => (
    text === APPLICATION_SQL.current ? { rows: current ? [{ review_status: current }] : [] }
      : text === APPLICATION_SQL.releasedCard ? { rows: releasedCard ? [{ '?column?': 1 }] : [] }
        : text === APPLICATION_SQL.review ? { rows: [{ id: 'a1', review_status: 'rejected' }] } : undefined
  ), () => call('post', '/center/applications/:id/review', { params: { id: 'a1' }, body: { action: 'rejected', reason: 'Synthetic reason text' } }));
  const step = (text: string) => (text === APPLICATION_SQL.current ? 'READ' : text === APPLICATION_SQL.releasedCard ? 'CARD' : text === APPLICATION_SQL.review ? 'UPDATE' : text === APPLICATION_SQL.log ? 'LOG' : text);

  const fromPending = await review('pending');
  assert.equal(fromPending.result.status, 200);
  assert.deepEqual(fromPending.log.map((q) => step(q.text)), ['BEGIN', 'READ', 'UPDATE', 'LOG', 'COMMIT']);
  assert.deepEqual(fromPending.log[1].values, ['a1', INSTITUTE], 'read scoped to the session Institute');
  assert.deepEqual(fromPending.log[2].values.slice(1), [INSTITUTE, 'rejected', 'Synthetic reason text', 'pending'], 'compare-and-set on the status read');
  assert.match(APPLICATION_SQL.current, /FOR UPDATE/);

  const unverifyDraftOnly = await review('verified');
  assert.equal(unverifyDraftOnly.result.status, 200, 'a draft card does not block: the Super Admin release skips it');
  assert.deepEqual(unverifyDraftOnly.log.map((q) => step(q.text)), ['BEGIN', 'READ', 'CARD', 'UPDATE', 'LOG', 'COMMIT']);

  const released = await review('verified', true);
  assert.deepEqual([released.result.status, released.result.body?.code], [409, 'ADMIT_CARD_RELEASED']);
  assert.ok(!released.log.some((q) => step(q.text) === 'UPDATE' || step(q.text) === 'LOG'), 'nothing written');

  const same = await review('rejected');
  assert.deepEqual([same.result.status, same.result.body?.code], [409, 'NO_CHANGE']);
  const foreign = await review(null);
  assert.equal(foreign.result.status, 404, "another Institute's application looks unknown");
  assert.ok(!foreign.log.some((q) => step(q.text) === 'UPDATE'));
});

// ---------------------------------------------------------------------------
// Settings & Support: no controls for features that do not exist
// ---------------------------------------------------------------------------

test('settings: only real integration status and support tickets; no stored toggles and no update route', async () => {
  const result = await call('get', '/center/settings', { handler: (text) => (text.includes('institute_support_tickets') ? { rows: [{ id: 't1' }] } : undefined) });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body!).sort(), ['integrations', 'tickets']);
  const names = (result.body!.integrations as Array<{ name: string; status: string }>).map((item) => item.name);
  assert.deepEqual(names, ['Transactional Email', 'SMS Provider', 'Google Sign-In', 'Payment Gateway']);
  assert.equal((result.body!.integrations as Array<{ name: string; status: string }>).find((item) => item.name === 'Payment Gateway')!.status, 'Not configured');
  assert.ok(result.queries.every((q) => !q.text.includes('institute_settings')));

  const router = createInstituteWorkspaceRouter();
  const putSettings = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>).some((item) => item.route?.path === '/center/settings' && item.route.methods.put);
  assert.equal(putSettings, false, 'no route stores settings');
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('./instituteWorkspaceMigration.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /institute_settings|webhook|audit_retention/i, 'no table for unimplemented settings');
});

// ---------------------------------------------------------------------------
// Attendance marking
// ---------------------------------------------------------------------------

test('attendance: manual marks only, always with a reason; each mark is a new row under the session Institute', async () => {
  const base = { rollNumber: 'r-1', candidateName: 'Synthetic Candidate', status: 'present', reason: 'Seen at gate' };
  for (const source of ['qr_scan', 'import']) {
    const refused = await call('post', '/center/attendance/mark', { body: { ...base, source } });
    assert.equal(refused.status, 400, `${source} cannot be claimed from a browser`);
    assert.equal(refused.queries.length, 0);
  }
  const noReason = await call('post', '/center/attendance/mark', { body: { ...base, reason: '' } });
  assert.deepEqual([noReason.status, noReason.body?.error], [400, 'A reason is required for manual attendance marking.']);
  const extra = await call('post', '/center/attendance/mark', { body: { ...base, actorId: 'someone-else' } });
  assert.equal(extra.status, 400, 'unknown fields are refused');

  const ok = await call('post', '/center/attendance/mark', {
    body: base, handler: (text) => (text.includes('INSERT INTO institute_attendance_logs') ? { rows: [{ id: 'm1', roll_number: 'R-1', status: 'present' }] } : undefined),
  });
  assert.equal(ok.status, 201);
  const insert = ok.queries.find((q) => q.text.includes('INSERT INTO institute_attendance_logs'))!;
  assert.match(insert.text, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$2\)/, 'the actor is the session Institute');
  assert.deepEqual([insert.values[1], insert.values[3], insert.values[8]], [INSTITUTE, 'R-1', 'manual']);
  assert.ok(!ok.queries.some((q) => /UPDATE|DELETE/.test(q.text)), 'marks are never edited or deleted');
});

// ---------------------------------------------------------------------------
// Question Bank: well-formed questions, a moderation state machine, approved-only papers
// ---------------------------------------------------------------------------

const QUESTION = '00000000-0000-4000-8000-0000000000a1';
const QUESTION_B = '00000000-0000-4000-8000-0000000000a2';
const mcq = { subject: 'Synthetic Maths', questionText: 'Synthetic question?', questionType: 'mcq', options: { A: 'One', B: 'Two' }, correctAnswer: 'B' };

test('questions: the answer key must fit the question type; unknown fields are refused; nothing is written otherwise', async () => {
  assert.equal(questionShapeError('mcq', { A: 'x', B: 'y' }, 'A'), null);
  assert.equal(questionShapeError('multi_select', { A: 'x', B: 'y', C: 'z' }, 'A, C'), null);
  assert.equal(questionShapeError('true_false', {}, 'false'), null);
  assert.equal(questionShapeError('descriptive', {}, ''), null);
  for (const [type, options, answer] of [
    ['mcq', { A: 'x' }, 'A'], ['mcq', { A: 'x', B: 'y' }, 'C'], ['mcq', { A: 'x', B: 'y' }, 'A,B'], ['mcq', { A: 'x', B: 'y' }, ''],
    ['multi_select', { A: 'x', B: 'y' }, 'A,A'], ['true_false', {}, 'yes'], ['true_false', { A: 'x' }, 'true'], ['descriptive', { A: 'x' }, ''],
  ] as Array<[string, Record<string, string>, string]>) {
    assert.notEqual(questionShapeError(type, options, answer), null, `${type} ${JSON.stringify(options)} ${answer}`);
  }

  for (const body of [{ ...mcq, correctAnswer: 'C' }, { ...mcq, moderationStatus: 'approved' }, { ...mcq, marks: 1, negativeMarks: 2 }, { ...mcq, options: { A: '', B: 'Two' } }]) {
    const refused = await call('post', '/center/questions', { body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.queries.length, 0, 'refused before any query');
  }

  const draft = await call('post', '/center/questions', { body: mcq, handler: (text) => (/^\s*INSERT INTO institute_questions/.test(text) ? { rows: [{ id: QUESTION }] } : undefined) });
  assert.equal(draft.status, 201);
  const insert = draft.queries[0];
  assert.equal(insert.values[1], INSTITUTE, 'stored under the session Institute');
  assert.equal(insert.values.at(-1), 'draft', 'a new question is a draft unless submitted for review');
  const submitted = await call('post', '/center/questions', { body: { ...mcq, submitForReview: true }, handler: () => ({ rows: [{ id: QUESTION }] }) });
  assert.equal(submitted.queries[0].values.at(-1), 'in_review', 'never created approved');
});

test('questions: moderation follows the state machine, is compare-and-set, and is scoped to the Institute', async () => {
  const allowed = Object.entries(QUESTION_MODERATION_TRANSITIONS).flatMap(([from, targets]) => targets.map((to) => `${from}->${to}`)).sort();
  assert.deepEqual(allowed, ['approved->archived', 'draft->archived', 'draft->in_review', 'in_review->approved', 'in_review->archived', 'in_review->rejected', 'rejected->archived']);

  const at = (status: string): Handler => (text) => (/^SELECT moderation_status FROM institute_questions/.test(text) ? { rows: [{ moderation_status: status }] } : undefined);
  for (const [from, to] of [['draft', 'approved'], ['archived', 'approved'], ['rejected', 'approved'], ['approved', 'in_review'], ['draft', 'rejected']]) {
    const refused = await call('patch', '/center/questions/:id/moderate', { params: { id: QUESTION }, body: { status: to }, handler: at(from) });
    assert.deepEqual([refused.status, refused.body?.code], [409, 'INVALID_TRANSITION'], `${from} -> ${to}`);
    assert.ok(!refused.queries.some((q) => /UPDATE/.test(q.text)), 'nothing written');
  }

  const ok = await call('patch', '/center/questions/:id/moderate', {
    params: { id: QUESTION }, body: { status: 'approved' },
    handler: (text, values) => at('in_review')(text, values) ?? (/UPDATE institute_questions/.test(text) ? { rows: [{ id: QUESTION, moderation_status: 'approved' }] } : undefined),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.queries[0].values, [QUESTION, INSTITUTE], 'read scoped to the session Institute');
  const update = ok.queries.find((q) => /UPDATE/.test(q.text))!;
  assert.match(update.text, /WHERE id = \$1 AND institute_id = \$2 AND moderation_status = \$4/);
  assert.deepEqual(update.values, [QUESTION, INSTITUTE, 'approved', 'in_review']);

  const raced = await call('patch', '/center/questions/:id/moderate', { params: { id: QUESTION }, body: { status: 'approved' }, handler: at('in_review') });
  assert.deepEqual([raced.status, raced.body?.code], [409, 'QUESTION_CHANGED']);
  const foreign = await call('patch', '/center/questions/:id/moderate', { params: { id: FOREIGN }, body: { status: 'archived' } });
  assert.equal(foreign.status, 404, 'another Institute\'s question looks like an unknown one');
  const badId = await call('patch', '/center/questions/:id/moderate', { params: { id: 'nope' }, body: { status: 'archived' } });
  assert.deepEqual([badId.status, badId.queries.length], [400, 0]);
  const extra = await call('patch', '/center/questions/:id/moderate', { params: { id: QUESTION }, body: { status: 'archived', reviewedBy: 'x' } });
  assert.deepEqual([extra.status, extra.queries.length], [400, 0]);
});

test('paper blueprints: approved questions of this Institute only, each once; locking is one-way', async () => {
  const dup = await call('post', '/center/paper-blueprints', { body: { title: 'Synthetic paper', durationMinutes: 60, questionIds: [QUESTION, QUESTION] } });
  assert.deepEqual([dup.status, dup.queries.length], [400, 0], 'duplicates refused before any query');
  const extra = await call('post', '/center/paper-blueprints', { body: { title: 'Synthetic paper', durationMinutes: 60, questionIds: [QUESTION], isLocked: true } });
  assert.deepEqual([extra.status, extra.queries.length], [400, 0]);

  const notApproved = await call('post', '/center/paper-blueprints', {
    body: { title: 'Synthetic paper', durationMinutes: 60, questionIds: [QUESTION, QUESTION_B] },
    handler: (text) => (/FROM institute_questions/.test(text) ? { rows: [{ id: QUESTION, marks: '2' }] } : undefined),
  });
  assert.equal(notApproved.status, 400);
  const select = notApproved.queries.find((q) => /FROM institute_questions/.test(q.text))!;
  assert.match(select.text, /institute_id = \$1 .*moderation_status = 'approved'/);
  assert.equal(select.values[0], INSTITUTE);
  assert.ok(!notApproved.queries.some((q) => /INSERT/.test(q.text)));

  const made = await call('post', '/center/paper-blueprints', {
    body: { title: 'Synthetic paper', durationMinutes: 60, questionIds: [QUESTION, QUESTION_B] },
    handler: (text) => (/FROM institute_questions/.test(text) ? { rows: [{ id: QUESTION, marks: '2' }, { id: QUESTION_B, marks: '1.5' }] } : /INSERT/.test(text) ? { rows: [{ id: 'bp' }] } : undefined),
  });
  assert.equal(made.status, 201);
  assert.equal(made.queries.find((q) => /INSERT/.test(q.text))!.values[4], 3.5, 'total marks computed on the server');

  const foreignExam = await call('post', '/center/paper-blueprints', { body: { examId: FOREIGN, title: 'Synthetic paper', durationMinutes: 60, questionIds: [QUESTION] } });
  assert.equal(foreignExam.status, 404);
  assert.ok(!foreignExam.queries.some((q) => /institute_questions|INSERT/.test(q.text)));

  const lock = await call('post', '/center/paper-blueprints/:id/lock', { params: { id: QUESTION } });
  assert.equal(lock.status, 404, 'already locked or not this Institute\'s');
  assert.match(lock.queries[0].text, /AND institute_id = \$2 AND is_locked = false/);
  const badLock = await call('post', '/center/paper-blueprints/:id/lock', { params: { id: 'nope' } });
  assert.deepEqual([badLock.status, badLock.queries.length], [400, 0]);
});

test('the Question Bank screen offers exactly the moderation actions the server allows', async () => {
  const { questionActions } = await import('../src/utils/workspaceQuestions.js');
  for (const [from, targets] of Object.entries(QUESTION_MODERATION_TRANSITIONS)) {
    assert.deepEqual(questionActions(from).map((action) => action.to).sort(), [...targets].sort(), `actions offered from ${from}`);
  }
});

// ---------------------------------------------------------------------------
// CBT centre: read and review only (no delivery exists); no invented health figures
// ---------------------------------------------------------------------------

test('CBT: the list is scoped to the Institute and reports no made-up delivery health', async () => {
  const result = await call('get', '/center/cbt-sessions');
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body!).sort(), ['incidents', 'sessions']);
  assert.ok(result.queries.every((q) => q.values[0] === INSTITUTE && /^\s*SELECT/.test(q.text)));
  assert.match(result.queries[1].text, /s\.institute_id = i\.institute_id/);
});

test('CBT: an incident is reviewed once, from open, with a reason; nothing else is accepted', async () => {
  const INCIDENT = '00000000-0000-4000-8000-0000000000c1';
  const ok = await call('post', '/center/cbt-incidents/:id/review', {
    params: { id: INCIDENT }, body: { reviewStatus: 'dismissed', reviewReason: 'Synthetic network blip' },
    handler: (text) => (/UPDATE institute_cbt_incidents/.test(text) ? { rows: [{ id: INCIDENT, review_status: 'dismissed' }] } : undefined),
  });
  assert.equal(ok.status, 200);
  assert.match(ok.queries[0].text, /WHERE id = \$1 AND institute_id = \$2 AND review_status = 'open'/);
  assert.deepEqual(ok.queries[0].values, [INCIDENT, INSTITUTE, 'dismissed', 'Synthetic network blip']);

  const again = await call('post', '/center/cbt-incidents/:id/review', { params: { id: INCIDENT }, body: { reviewStatus: 'escalated', reviewReason: 'Synthetic second look' } });
  assert.equal(again.status, 404, 'an already reviewed (or foreign) incident is not overwritten');
  for (const body of [{ reviewStatus: 'open', reviewReason: 'Synthetic reopen' }, { reviewStatus: 'reviewed', reviewReason: 'no' }, { reviewStatus: 'reviewed', reviewReason: 'Synthetic reason', reviewedBy: 'x' }]) {
    const refused = await call('post', '/center/cbt-incidents/:id/review', { params: { id: INCIDENT }, body });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], JSON.stringify(body));
  }
  const badId = await call('post', '/center/cbt-incidents/:id/review', { params: { id: 'nope' }, body: { reviewStatus: 'reviewed', reviewReason: 'Synthetic reason' } });
  assert.deepEqual([badId.status, badId.queries.length], [400, 0]);
});

// ---------------------------------------------------------------------------
// Reports: on-screen datasets only, fixed queries scoped to the Institute, honest about truncation
// ---------------------------------------------------------------------------

test('reports: fixed Institute-scoped queries; no fees dataset; extra rows are reported as truncated', async () => {
  const { REPORT_DATASETS, REPORT_SQL, REPORT_ROW_LIMIT } = await import('./instituteWorkspace.js');
  assert.deepEqual([...REPORT_DATASETS], ['applications', 'exams', 'attendance', 'results']);
  for (const dataset of REPORT_DATASETS) {
    assert.match(REPORT_SQL[dataset], /WHERE \w+\.?institute_id = \$1 ORDER BY .* LIMIT \$2$|WHERE institute_id = \$1 ORDER BY .* LIMIT \$2$/s, dataset);
    assert.doesNotMatch(REPORT_SQL[dataset], /\$3/);
    const joins = [...REPORT_SQL[dataset].matchAll(/JOIN institute_exams e ON ([^\n]+)/g)];
    for (const [, on] of joins) assert.match(on, /e\.institute_id = \w\.institute_id/, `${dataset}: joined exam belongs to the same Institute`);
  }

  const many = Array.from({ length: REPORT_ROW_LIMIT + 1 }, (_, i) => ({ exam_code: `DEMO-${i}` }));
  const full = await call('post', '/center/reports/preview', { body: { dataset: 'exams' }, handler: () => ({ rows: many }) });
  assert.equal(full.status, 200);
  assert.deepEqual([full.body?.rowCount, full.body?.truncated, (full.body?.rows as unknown[]).length], [REPORT_ROW_LIMIT, true, REPORT_ROW_LIMIT]);
  assert.deepEqual(full.queries[0].values, [INSTITUTE, REPORT_ROW_LIMIT + 1]);
  const few = await call('post', '/center/reports/preview', { body: { dataset: 'results' }, handler: () => ({ rows: [{ roll_number: 'R1' }] }) });
  assert.deepEqual([few.body?.rowCount, few.body?.truncated], [1, false]);

  for (const body of [{ dataset: 'fees' }, { dataset: 'exams', limit: 5000 }, { dataset: 'users' }]) {
    const refused = await call('post', '/center/reports/preview', { body });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], JSON.stringify(body));
  }
});

test('the Reports screen offers exactly the datasets the server serves', async () => {
  const [{ REPORT_DATASETS }, { REPORTS }] = await Promise.all([import('./instituteWorkspace.js'), import('../src/components/workspace/ReportsPanel.js')]);
  assert.deepEqual(Object.keys(REPORTS).sort(), [...REPORT_DATASETS].sort());
});

// ---------------------------------------------------------------------------
// Interviews: scheduling without fake meeting data, no double-booked panel, one scorecard per panelist
// ---------------------------------------------------------------------------

/** Runs `work` with pool.connect replaced by a scripted transaction client; returns the client's statements. */
async function withFakeClient<T>(reply: (text: string, values: unknown[]) => { rows?: Record<string, unknown>[]; rowCount?: number } | undefined, work: () => Promise<T>): Promise<{ result: T; log: Array<{ text: string; values: unknown[] }>; audits: AuditRow[] }> {
  // `log` keeps every business statement and BEGIN/COMMIT/ROLLBACK; audit inserts go to `audits` instead.
  const log: Array<{ text: string; values: unknown[] }> = [];
  const audits: AuditRow[] = [];
  const mutableConnect = pool as unknown as { connect: () => Promise<unknown> };
  const originalConnect = mutableConnect.connect;
  mutableConnect.connect = async () => ({
    query: async (text: string, values: unknown[] = []) => {
      if (text === AUDIT_INSERT_SQL) { audits.push(auditRow(values)); return { rows: [], rowCount: 1 }; }
      log.push({ text, values }); const r = reply(text, values); return { rows: r?.rows ?? [], rowCount: r?.rowCount ?? r?.rows?.length ?? 0 };
    },
    release() {},
  });
  try {
    return { result: await work(), log, audits };
  } finally {
    mutableConnect.connect = originalConnect;
  }
}

test('interviews: booked under a per-day lock, panel names compared case-insensitively, no meeting reference or recording', async () => {
  const { INTERVIEW_SQL, indiaDate, CLOCK_TIME } = await import('./instituteWorkspace.js');
  const future = '2099-01-15';
  const body = { candidateName: 'Synthetic Candidate', panelName: 'Panel A', scheduledDate: future, startTime: '10:00', endTime: '10:30', mode: 'video' };

  const booked = await withFakeClient((text) => (text === INTERVIEW_SQL.insert ? { rows: [{ id: 'iv1', scheduled_date: future }] } : undefined), () => call('post', '/center/interviews', { body }));
  assert.equal(booked.result.status, 201);
  const texts = booked.log.map((q) => q.text);
  assert.deepEqual([texts[0], texts.at(-1)], ['BEGIN', 'COMMIT']);
  assert.match(texts[1], /pg_advisory_xact_lock/);
  assert.equal(booked.log[1].values[0], `eltnoy.interviews:${INSTITUTE}:${future}`, 'one lock per Institute and day, so shared panelists across panels are covered too');
  assert.ok(texts.indexOf(INTERVIEW_SQL.conflict) < texts.indexOf(INTERVIEW_SQL.insert), 'overlap checked inside the lock, before the insert');
  assert.match(INTERVIEW_SQL.conflict, /lower\(btrim\(panel_name\)\) = lower\(btrim\(\$2\)\)/);
  assert.match(INTERVIEW_SQL.insert, /false,false,''\)/, 'no consent, recording or meeting reference is stored');
  assert.doesNotMatch(INTERVIEW_SQL.list, /meeting_ref|recording_enabled|consent_recorded/);
  assert.match(INTERVIEW_SQL.list, /to_char\(scheduled_date, 'YYYY-MM-DD'\)/, 'dates are calendar dates, not shifted timestamps');

  const clash = await withFakeClient((text) => (text === INTERVIEW_SQL.conflict ? { rows: [{ id: 'other' }] } : undefined), () => call('post', '/center/interviews', { body }));
  assert.deepEqual([clash.result.status, clash.result.body?.code], [409, 'PANEL_CONFLICT']);
  assert.ok(!clash.log.some((q) => q.text === INTERVIEW_SQL.insert));

  assert.equal(indiaDate(new Date('2026-11-27T19:00:00Z')), '2026-11-28', 'the date is the Indian calendar date');
  assert.ok(CLOCK_TIME.test('23:59') && !CLOCK_TIME.test('24:00') && !CLOCK_TIME.test('09:60'));
  for (const bad of [{ ...body, startTime: '99:99' }, { ...body, endTime: '09:00' }, { ...body, scheduledDate: '2000-01-01' }, { ...body, consentRecorded: true }, { ...body, meetingRef: 'X' }]) {
    const refused = await call('post', '/center/interviews', { body: bad });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], JSON.stringify(bad));
  }
});

test('interviews: a scorecard only for this Institute\'s held, not-cancelled interview, once per panelist', async () => {
  const { INTERVIEW_SQL } = await import('./instituteWorkspace.js');
  const INTERVIEW = '00000000-0000-4000-8000-0000000000b1';
  const card = { panelistName: 'Synthetic Panelist', subjectScore: 7, communicationScore: 8, pedagogyScore: 6.75, problemSolvingScore: 9 };
  const at = (status: string, date: string, duplicate = false) => (text: string) => (text === INTERVIEW_SQL.forScorecard ? { rows: [{ status, scheduled_date: date }] }
    : text === INTERVIEW_SQL.panelistScorecard ? { rows: duplicate ? [{ '?column?': 1 }] : [] }
      : text === INTERVIEW_SQL.insertScorecard ? { rows: [{ id: 'sc1' }] } : undefined);

  const ok = await withFakeClient(at('scheduled', '2020-01-01'), () => call('post', '/center/interviews/:id/scorecards', { params: { id: INTERVIEW }, body: card }));
  assert.equal(ok.result.status, 201);
  assert.deepEqual(ok.log.find((q) => q.text === INTERVIEW_SQL.forScorecard)!.values, [INTERVIEW, INSTITUTE]);
  assert.match(ok.log[1].text, /pg_advisory_xact_lock/, 'concurrent scorecards for one interview are serialised');
  assert.deepEqual(ok.log[1].values, [`eltnoy.interview_scorecards:${INTERVIEW}`]);
  assert.doesNotMatch(INTERVIEW_SQL.forScorecard, /FOR UPDATE/, 'no row lock: the app role has no UPDATE on interviews');

  for (const [reply, code] of [[at('scheduled', '2099-01-01'), 'INTERVIEW_NOT_HELD'], [at('cancelled', '2020-01-01'), 'INTERVIEW_CANCELLED'], [at('completed', '2020-01-01', true), 'SCORECARD_EXISTS']] as const) {
    const refused = await withFakeClient(reply, () => call('post', '/center/interviews/:id/scorecards', { params: { id: INTERVIEW }, body: card }));
    assert.deepEqual([refused.result.status, refused.result.body?.code], [409, code]);
    assert.ok(!refused.log.some((q) => q.text === INTERVIEW_SQL.insertScorecard));
  }
  const foreign = await withFakeClient(() => undefined, () => call('post', '/center/interviews/:id/scorecards', { params: { id: FOREIGN }, body: card }));
  assert.equal(foreign.result.status, 404);
  for (const [params, bad] of [[{ id: 'nope' }, card], [{ id: INTERVIEW }, { ...card, subjectScore: 11 }], [{ id: INTERVIEW }, { ...card, status: 'approved' }]] as const) {
    const refused = await call('post', '/center/interviews/:id/scorecards', { params, body: bad });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], JSON.stringify(bad));
  }
});

test('the Interviews screen uses the same Indian calendar date as the server', async () => {
  const [{ indiaDate }, { indiaToday }] = await Promise.all([import('./instituteWorkspace.js'), import('../src/components/workspace/InterviewsPanel.js')]);
  for (const iso of ['2026-11-27T18:29:00Z', '2026-11-27T18:31:00Z', '2026-12-31T23:00:00Z']) assert.equal(indiaToday(new Date(iso)), indiaDate(new Date(iso)), iso);
});

// ---------------------------------------------------------------------------
// Training (R-12): records only; no publishing that changes nothing, no typed-in progress, no unverifiable certificates
// ---------------------------------------------------------------------------

test('training: no publish flag, no typed-in progress, real times and dates, Institute-scoped writes', async () => {
  const { TRAINING_SQL } = await import('./instituteWorkspace.js');
  const COURSE = '00000000-0000-4000-8000-0000000000d1';
  const course = await call('post', '/center/training/courses', { body: { title: 'Synthetic Course', moduleCount: 4 }, handler: () => ({ rows: [{ id: COURSE }] }) });
  assert.equal(course.status, 201);
  assert.deepEqual(course.queries[0].values.slice(1), [INSTITUTE, 'Synthetic Course', 'General', 4]);

  const owns: Handler = (text) => (/FROM institute_training_courses WHERE id = \$1 AND institute_id = \$2/.test(text) ? { rows: [{ '?column?': 1 }] } : /^INSERT/.test(text) ? { rows: [{ id: 'x' }] } : undefined);
  const session = await call('post', '/center/training/sessions', { body: { courseId: COURSE, title: 'Synthetic Session', sessionDate: '2099-02-01', sessionTime: '14:30' }, handler: owns });
  assert.equal(session.status, 201);
  assert.equal(session.queries.at(-1)!.text, TRAINING_SQL.insertSession);
  const learner = await call('post', '/center/training/enrollments', { body: { courseId: COURSE, learnerName: 'Synthetic Learner', learnerEmail: 'Learner@Example.test' }, handler: owns });
  assert.equal(learner.status, 201);
  assert.deepEqual(learner.queries.at(-1)!.values.slice(1), [INSTITUTE, COURSE, 'Synthetic Learner', 'learner@example.test']);

  for (const sql of [TRAINING_SQL.insertCourse, TRAINING_SQL.insertSession, TRAINING_SQL.insertEnrollment]) {
    assert.doesNotMatch(sql, /status|visibility|completed_modules|certificate_code/, 'nothing published, no progress, no certificate');
  }
  assert.match(TRAINING_SQL.sessions, /to_char\(session_date, 'YYYY-MM-DD'\)/);

  for (const [path, body] of [
    ['/center/training/courses', { title: 'Synthetic Course', moduleCount: 4, status: 'published' }],
    ['/center/training/sessions', { title: 'Synthetic Session', sessionDate: '2099-02-01', sessionTime: '14:30', visibility: 'published' }],
    ['/center/training/sessions', { title: 'Synthetic Session', sessionDate: '2099-02-01', sessionTime: 'morning' }],
    ['/center/training/sessions', { title: 'Synthetic Session', sessionDate: '2000-02-01', sessionTime: '14:30' }],
    ['/center/training/enrollments', { courseId: COURSE, learnerName: 'Synthetic Learner', completedModules: 4 }],
  ] as const) {
    const refused = await call('post', path, { body });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], `${path} ${JSON.stringify(body)}`);
  }
});

test('training: certificates are refused until certificate IDs can be verified (R-13)', async () => {
  const result = await call('post', '/center/training/enrollments/:id/certificate', { params: { id: '00000000-0000-4000-8000-0000000000d2' } });
  assert.deepEqual([result.status, result.body?.code, result.queries.length], [403, 'CERTIFICATES_NOT_AVAILABLE', 0]);
});

// ---------------------------------------------------------------------------
// Review fixes (2026-11-28): nothing recorded as sent or handled when nothing acts on it
// ---------------------------------------------------------------------------

test('admit cards: a cancelled or archived exam takes no new draft cards', async () => {
  for (const status of ['cancelled', 'archived']) {
    const result = await call('post', '/center/admit-cards/generate', {
      body: { examId: EXAM, centerCode: 'C-1', centerName: 'Synthetic Centre' },
      handler: (text) => (text.startsWith('SELECT id, exam_code, exam_date') ? { rows: [{ id: EXAM, exam_code: 'DEMO-1', lifecycle_status: status }] } : undefined),
    });
    assert.deepEqual([result.status, result.body?.code], [409, 'EXAM_CLOSED'], status);
  }
});

test('broadcasts and support tickets are refused: nothing delivers or reads them', async () => {
  const broadcast = await call('post', '/center/exams/:id/broadcasts', { params: { id: EXAM }, body: { audience: 'all_registered', subject: 'Synthetic', message: 'Synthetic message', channel: 'sms' } });
  assert.deepEqual([broadcast.status, broadcast.body?.code, broadcast.queries.length], [409, 'BROADCASTS_NOT_AVAILABLE', 0]);
  const ticket = await call('post', '/center/tickets', { body: { category: 'Payment', subject: 'Synthetic', description: 'Synthetic description text', priority: 'critical' } });
  assert.deepEqual([ticket.status, ticket.body?.code, ticket.queries.length], [409, 'SUPPORT_TICKETS_NOT_AVAILABLE', 0]);
  const resolve = await call('patch', '/center/tickets/:id', { params: { id: 't1' }, body: { status: 'resolved' } });
  assert.deepEqual([resolve.status, resolve.queries.length], [403, 0], 'an Institute cannot resolve a ticket');
});

test('refunds: an Institute may only withdraw its request; approving or marking processed is refused (no money moves)', async () => {
  for (const status of ['approved', 'processed']) {
    const refused = await call('patch', '/center/payments/refunds/:id', { params: { id: 'rf1' }, body: { status } });
    assert.deepEqual([refused.status, refused.body?.code, refused.queries.length], [403, 'REFUND_DECISION_NOT_AVAILABLE', 0], status);
  }
  const withdrawn = await call('patch', '/center/payments/refunds/:id', { params: { id: 'rf1' }, body: { status: 'rejected' }, handler: (text) => (/UPDATE institute_fee_refunds/.test(text) ? { rows: [{ id: 'rf1', status: 'rejected' }] } : undefined) });
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(withdrawn.queries[0].values.slice(1), [INSTITUTE, 'rejected']);
});

test('exams: the start time is a real 24-hour time and the time zone a real one (admit cards copy them)', async () => {
  const exam = { examCode: 'DEMO-T1', title: 'Synthetic Exam', category: 'Mock', mode: 'Offline', eligibility: 'Synthetic', appOpenDate: '2099-01-01', appCloseDate: '2099-01-10', examDate: '2099-01-20', durationMinutes: 60 };
  const ok = await call('post', '/center/exams', { body: { ...exam, examTime: '09:30', timezone: 'Asia/Kolkata' }, handler: (text) => (/INSERT INTO institute_exams/.test(text) ? { rows: [{ id: 'x' }] } : undefined) });
  assert.equal(ok.status, 201);
  for (const bad of [{ examTime: 'after lunch' }, { examTime: '25:00' }, { timezone: 'Mars/Base' }]) {
    const refused = await call('post', '/center/exams', { body: { ...exam, ...bad } });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], JSON.stringify(bad));
  }
});

test('training: a duplicate enrolment is refused by the database (ON CONFLICT), not by a read-then-write check', async () => {
  const { TRAINING_SQL } = await import('./instituteWorkspace.js');
  const COURSE = '00000000-0000-4000-8000-0000000000d1';
  const owns: Handler = (text) => (/FROM institute_training_courses WHERE id = \$1 AND institute_id = \$2/.test(text) ? { rows: [{ '?column?': 1 }] } : undefined);
  assert.match(TRAINING_SQL.insertEnrollment, /ON CONFLICT DO NOTHING/);
  for (const [email, hint] of [['learner@example.test', /same email/], ['', /Add the learner's email/]] as const) {
    const duplicate = await call('post', '/center/training/enrollments', { body: { courseId: COURSE, learnerName: 'Synthetic Learner', learnerEmail: email }, handler: owns });
    assert.deepEqual([duplicate.status, duplicate.body?.code], [409, 'ENROLLMENT_EXISTS']);
    assert.match(String(duplicate.body?.error), hint);
    assert.equal(duplicate.queries.filter((q) => /INSERT INTO institute_training_enrollments/.test(q.text)).length, 1, 'one atomic statement, no prior SELECT');
  }
});

// ---------------------------------------------------------------------------
// Interviews: cancellation and rescheduling (client-approved scope, 2026-11-28)
// ---------------------------------------------------------------------------

const IV = '00000000-0000-4000-8000-0000000000b9';
const ivRow = (over: Record<string, unknown> = {}) => ({ id: IV, status: 'scheduled', scheduled_date: '2099-03-01', start_time: '10:00', end_time: '10:30', panel_name: 'Panel A', panelist_names: 'Demo X, Demo Y', candidate_name: 'Synthetic Candidate', ...over });

async function interviewChange(path: 'cancel' | 'reschedule', body: unknown, state: { row?: Record<string, unknown> | null; scored?: boolean; conflict?: Record<string, unknown> | null } = {}, id = IV) {
  const { INTERVIEW_SQL } = await import('./instituteWorkspace.js');
  return withFakeClient((text) => {
    if (text === INTERVIEW_SQL.current) return { rows: state.row === null ? [] : [state.row ?? ivRow()] };
    if (text === INTERVIEW_SQL.hasScorecards) return { rows: state.scored ? [{ '?column?': 1 }] : [] };
    if (text === INTERVIEW_SQL.conflict) return { rows: state.conflict ? [state.conflict] : [] };
    if (text === INTERVIEW_SQL.cancel || text === INTERVIEW_SQL.reschedule) return { rows: [{ id }] };
    if (text === INTERVIEW_SQL.insertChange) return { rows: [{ id: 'change-1' }] };
    return undefined;
  }, () => call('post', `/center/interviews/:id/${path}`, { params: { id }, body }));
}

test('interviews: cancelling needs a reason, keeps the earlier details in history, and frees the slot', async () => {
  const { INTERVIEW_SQL } = await import('./instituteWorkspace.js');
  const ok = await interviewChange('cancel', { reason: 'Synthetic candidate withdrew' });
  assert.equal(ok.result.status, 200);
  const step = (t: string) => (t === INTERVIEW_SQL.current ? 'READ' : t === INTERVIEW_SQL.hasScorecards ? 'SCORED?' : t === INTERVIEW_SQL.cancel ? 'CANCEL' : t === INTERVIEW_SQL.insertChange ? 'HISTORY' : /advisory/.test(t) ? 'LOCK' : t);
  assert.deepEqual(ok.log.map((q) => step(q.text)), ['BEGIN', 'LOCK', 'READ', 'SCORED?', 'CANCEL', 'HISTORY', 'COMMIT'], 'one transaction; the change and its history together');
  assert.deepEqual(ok.log[1].values, [`eltnoy.interview_scorecards:${IV}`], 'the same lock scorecards take, so a scorecard cannot race a cancellation');
  assert.deepEqual(ok.log[2].values, [IV, INSTITUTE], 'ownership: read scoped to the session Institute');
  assert.match(INTERVIEW_SQL.current, /FOR UPDATE/);
  assert.match(INTERVIEW_SQL.cancel, /WHERE id = \$1 AND institute_id = \$2 AND status = 'scheduled'/);
  const history = ok.log.find((q) => q.text === INTERVIEW_SQL.insertChange)!;
  assert.deepEqual(history.values.slice(1, 5), [INSTITUTE, IV, 'cancelled', 'Synthetic candidate withdrew']);
  assert.deepEqual(JSON.parse(String(history.values[5])), { scheduledDate: '2099-03-01', startTime: '10:00', endTime: '10:30', panelName: 'Panel A', panelistNames: 'Demo X, Demo Y', status: 'scheduled' });
  assert.equal(history.values[6], null);
  assert.match(INTERVIEW_SQL.conflict, /status <> 'cancelled'/, 'a cancelled interview never blocks a slot');

  for (const [body, label] of [[{}, 'no reason'], [{ reason: 'no' }, 'short reason'], [{ reason: 'Synthetic reason', status: 'cancelled' }, 'unknown field']] as const) {
    const refused = await call('post', '/center/interviews/:id/cancel', { params: { id: IV }, body });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], label);
  }
  const badId = await call('post', '/center/interviews/:id/cancel', { params: { id: 'nope' }, body: { reason: 'Synthetic reason' } });
  assert.deepEqual([badId.status, badId.queries.length], [400, 0]);
});

test('interviews: a held, already cancelled or foreign interview cannot be cancelled or rescheduled', async () => {
  const { INTERVIEW_SQL } = await import('./instituteWorkspace.js');
  const move = { scheduledDate: '2099-03-02', startTime: '11:00', endTime: '11:30', reason: 'Synthetic panel unavailable' };
  for (const path of ['cancel', 'reschedule'] as const) {
    const body = path === 'cancel' ? { reason: 'Synthetic reason' } : move;
    for (const [state, expected] of [
      [{ scored: true }, [409, 'INTERVIEW_HELD']],
      [{ row: ivRow({ status: 'completed' }) }, [409, 'INTERVIEW_HELD']],
      [{ row: ivRow({ status: 'cancelled' }) }, [409, 'INTERVIEW_CANCELLED']],
      [{ row: null }, [404, undefined]],
    ] as const) {
      const refused = await interviewChange(path, body, state);
      assert.deepEqual([refused.result.status, refused.result.body?.code], expected, `${path} ${JSON.stringify(state)}`);
      assert.ok(!refused.log.some((q) => q.text === INTERVIEW_SQL.cancel || q.text === INTERVIEW_SQL.reschedule || q.text === INTERVIEW_SQL.insertChange), 'nothing written');
      assert.equal(refused.log.at(-1)!.text, 'COMMIT');
    }
  }
});

test('interviews: rescheduling validates the slot, checks shared panelists, and keeps the earlier details', async () => {
  const { INTERVIEW_SQL, normalisePanelists } = await import('./instituteWorkspace.js');
  assert.deepEqual(normalisePanelists(' Demo X, demo x ,,Demo Y '), ['demo x', 'demo y']);
  const move = { scheduledDate: '2099-03-02', startTime: '11:00', endTime: '11:30', panelistNames: 'Demo Y, Demo Z', reason: 'Synthetic panel unavailable' };

  const ok = await interviewChange('reschedule', move);
  assert.equal(ok.result.status, 200);
  const locks = ok.log.filter((q) => /advisory/.test(q.text)).map((q) => q.values[0]);
  assert.deepEqual(locks, [`eltnoy.interview_scorecards:${IV}`, `eltnoy.interviews:${INSTITUTE}:2099-03-02`], 'the interview, then the target day');
  const conflict = ok.log.find((q) => q.text === INTERVIEW_SQL.conflict)!;
  assert.deepEqual(conflict.values, [INSTITUTE, 'Panel A', '2099-03-02', '11:00', '11:30', ['demo y', 'demo z'], IV], 'its own slot is excluded; panel kept when not changed');
  const update = ok.log.find((q) => q.text === INTERVIEW_SQL.reschedule)!;
  assert.deepEqual(update.values, [IV, INSTITUTE, '2099-03-02', '11:00', '11:30', 'Panel A', 'Demo Y, Demo Z']);
  const history = ok.log.find((q) => q.text === INTERVIEW_SQL.insertChange)!;
  assert.equal(history.values[3], 'rescheduled');
  assert.deepEqual(JSON.parse(String(history.values[5])), { scheduledDate: '2099-03-01', startTime: '10:00', endTime: '10:30', panelName: 'Panel A', panelistNames: 'Demo X, Demo Y', status: 'scheduled' }, 'the earlier slot is preserved');
  assert.deepEqual(JSON.parse(String(history.values[6])), { scheduledDate: '2099-03-02', startTime: '11:00', endTime: '11:30', panelName: 'Panel A', panelistNames: 'Demo Y, Demo Z' });
  assert.ok(ok.log.findIndex((q) => q.text === INTERVIEW_SQL.reschedule) < ok.log.findIndex((q) => q.text === INTERVIEW_SQL.insertChange));

  const clash = await interviewChange('reschedule', move, { conflict: { panel_name: 'Panel B', panelist_names: 'Demo Z', candidate_name: 'Other', start_time: '11:15', end_time: '11:45' } });
  assert.deepEqual([clash.result.status, clash.result.body?.code], [409, 'PANEL_CONFLICT']);
  assert.match(String(clash.result.body?.error), /Panelist demo z already has an interview from 11:15 to 11:45/);
  assert.ok(!clash.log.some((q) => q.text === INTERVIEW_SQL.reschedule || q.text === INTERVIEW_SQL.insertChange));

  const same = await interviewChange('reschedule', { scheduledDate: '2099-03-01', startTime: '10:00', endTime: '10:30', reason: 'Synthetic no-op' });
  assert.deepEqual([same.result.status, same.result.body?.code], [409, 'NO_CHANGE']);

  for (const [bad, label] of [
    [{ ...move, reason: undefined }, 'no reason'], [{ ...move, endTime: '10:59' }, 'end before start'], [{ ...move, startTime: '24:00' }, 'bad time'],
    [{ ...move, scheduledDate: '2000-01-01' }, 'past date'], [{ ...move, scheduledDate: '2099-02-30' }, 'impossible date'],
    [{ ...move, timezone: 'Mars/Base' }, 'invalid zone'], [{ ...move, timezone: 'Europe/London' }, 'unsupported zone'],
    [{ ...move, status: 'scheduled' }, 'unknown field'], [{ ...move, panelName: 'X' }, 'panel too short'],
  ] as const) {
    const refused = await call('post', '/center/interviews/:id/reschedule', { params: { id: IV }, body: bad });
    assert.deepEqual([refused.status, refused.queries.length], [400, 0], label);
  }
  const zoned = await interviewChange('reschedule', { ...move, timezone: 'Asia/Kolkata' });
  assert.equal(zoned.result.status, 200, 'India time is accepted explicitly');
  const badId = await call('post', '/center/interviews/:id/reschedule', { params: { id: 'nope' }, body: move });
  assert.deepEqual([badId.status, badId.queries.length], [400, 0]);
});

test('interviews: booking checks shared panelists across panels, not only the panel name', async () => {
  const { INTERVIEW_SQL } = await import('./instituteWorkspace.js');
  const body = { candidateName: 'Synthetic Candidate', panelName: 'Panel C', panelistNames: 'Demo X', scheduledDate: '2099-03-01', startTime: '10:15', endTime: '10:45' };
  const clash = await withFakeClient((text) => (text === INTERVIEW_SQL.conflict ? { rows: [{ panel_name: 'Panel A', panelist_names: 'Demo X, Demo Y', candidate_name: 'Other', start_time: '10:00', end_time: '10:30' }] } : undefined),
    () => call('post', '/center/interviews', { body }));
  assert.deepEqual([clash.result.status, clash.result.body?.code], [409, 'PANEL_CONFLICT']);
  assert.match(String(clash.result.body?.error), /Panelist demo x/);
  assert.deepEqual(clash.log.find((q) => q.text === INTERVIEW_SQL.conflict)!.values.slice(5), [['demo x'], ''], 'a new booking excludes nothing');
  assert.match(INTERVIEW_SQL.conflict, /unnest\(string_to_array\(panelist_names, ','\)\)/);
});

// ---------------------------------------------------------------------------
// A-11: Workspace actions write audit events in the same transaction (server/audit.ts)
// ---------------------------------------------------------------------------

test('A-11: each audited Institute action writes one event, for this Institute, with no personal data', async () => {
  const ID = '00000000-0000-4000-8000-0000000000aa';
  const owns: Handler = (text) => (/^SELECT 1 FROM institute_(exams|app_forms|training_courses) WHERE id = \$1 AND institute_id = \$2$/.test(text) ? { rows: [{ '?column?': 1 }] } : undefined);
  const returning = (row: Record<string, unknown>): Handler => (text, values) => owns(text, values) ?? (/^\s*(INSERT|UPDATE)/.test(text) ? { rows: [{ id: ID, ...row }] } : undefined);
  const cases: Array<[string, 'post' | 'patch', string, Record<string, string>, unknown, Handler, string, Record<string, unknown>]> = [
    ['exam created', 'post', '/center/exams', {}, { examCode: 'DEMO-A1', title: 'Synthetic Exam', category: 'Mock', mode: 'Offline', eligibility: 'Synthetic', appOpenDate: '2099-01-01', appCloseDate: '2099-01-10', examDate: '2099-01-20', durationMinutes: 60 }, returning({ exam_code: 'DEMO-A1' }), 'workspace_exam.created', { exam_code: 'DEMO-A1', new_status: 'draft' }],
    ['application created', 'post', '/center/applications', {}, { candidateName: 'Synthetic Person', candidateEmail: 'person@example.test', candidateMobile: '+910000000000' }, returning({ application_number: 'APP-2099-AB12CD', review_status: 'pending' }), 'workspace_application.created', { application_number: 'APP-2099-AB12CD', new_status: 'pending' }],
    ['question created', 'post', '/center/questions', {}, { subject: 'Synthetic', questionText: 'Synthetic question?', questionType: 'true_false', correctAnswer: 'true' }, returning({ question_type: 'true_false', moderation_status: 'draft' }), 'workspace_question.created', { question_type: 'true_false', new_status: 'draft' }],
    ['paper locked', 'post', '/center/paper-blueprints/:id/lock', { id: ID }, {}, returning({ question_ids_json: ['a', 'b', 'c'] }), 'workspace_paper.locked', { question_count: 3 }],
    ['CBT incident reviewed', 'post', '/center/cbt-incidents/:id/review', { id: ID }, { reviewStatus: 'dismissed', reviewReason: 'Synthetic blip' }, returning({}), 'workspace_cbt_incident.reviewed', { review_status: 'dismissed', reason_text: 'Synthetic blip' }],
    ['result written', 'post', '/center/results', {}, { examId: EXAM, rollNumber: 'r-9', candidateName: 'Synthetic Person', rawScore: 40, maxScore: 100 }, returning({ roll_number: 'R-9', version: 1, inserted: true }), 'workspace_results.written', { roll_number: 'R-9', version: 1, corrected: false }],
    ['result marked ready', 'patch', '/center/results/:id/status', { id: ID }, { evaluationStatus: 'moderated' }, returning({ roll_number: 'R-9' }), 'workspace_results.marked_ready', { roll_number: 'R-9', new_status: 'moderated' }],
    ['attendance marked', 'post', '/center/attendance/mark', {}, { rollNumber: 'R-9', candidateName: 'Synthetic Person', status: 'absent', reason: 'Synthetic absence' }, returning({ status: 'absent', reason: 'Synthetic absence' }), 'workspace_attendance.marked', { status: 'absent', reason_text: 'Synthetic absence' }],
    ['course created', 'post', '/center/training/courses', {}, { title: 'Synthetic Course', moduleCount: 4 }, returning({ module_count: 4 }), 'workspace_training.course_created', { module_count: 4 }],
    ['session scheduled', 'post', '/center/training/sessions', {}, { title: 'Synthetic Session', sessionDate: '2099-02-01', sessionTime: '10:00' }, returning({ session_date: '2099-02-01' }), 'workspace_training.session_scheduled', { scheduled_date: '2099-02-01' }],
    ['learner enrolled', 'post', '/center/training/enrollments', {}, { courseId: ID, learnerName: 'Synthetic Learner', learnerEmail: 'learner@example.test' }, returning({}), 'workspace_training.learner_enrolled', {}],
    ['refund withdrawn', 'patch', '/center/payments/refunds/:id', { id: ID }, { status: 'rejected' }, returning({}), 'workspace_refund.withdrawn', {}],
  ];
  for (const [label, method, path, params, body, handler, action, metadata] of cases) {
    const result = await call(method, path, { params, body, handler });
    assert.ok(result.status === 200 || result.status === 201, `${label}: ${result.status} ${JSON.stringify(result.body)}`);
    assert.equal(result.audits.length, 1, `${label}: one event`);
    const [event] = result.audits;
    assert.deepEqual([event.action, event.outcome, event.actorRole, event.organizationId], [action, 'succeeded', 'center', INSTITUTE], label);
    assert.deepEqual(event.metadata, metadata, `${label}: metadata`);
    assert.doesNotMatch(JSON.stringify(event.metadata), /Synthetic Person|Synthetic Learner|example\.test|\+91/, `${label}: no names or contact details`);
  }
});

test('A-11: D-02 refusals are recorded as denied; nothing changed is recorded as nothing; a failed audit insert rolls the action back', async () => {
  const ID = '00000000-0000-4000-8000-0000000000ab';
  const exam: Handler = (text) => (text.startsWith('SELECT * FROM institute_exams') ? { rows: [{ id: EXAM, exam_code: 'DEMO-1', lifecycle_status: 'pending_approval' }] } : undefined);
  for (const [path, method, params, body, handler, target, requested] of [
    ['/center/exams/:id/transition', 'post', { id: EXAM }, { status: 'approved' }, exam, 'exam', 'approved'],
    ['/center/results/:id/status', 'patch', { id: ID }, { evaluationStatus: 'published' }, undefined, 'result', 'published'],
    ['/center/admit-cards/:id/release', 'patch', { id: ID }, {}, undefined, 'admit_card', 'released'],
  ] as const) {
    const refused = await call(method, path, { params, body, handler });
    assert.deepEqual([refused.status, refused.body?.code], [403, 'PUBLICATION_REQUIRES_SUPER_ADMIN'], path);
    assert.deepEqual(refused.audits.map((a) => [a.action, a.outcome, a.reasonCode, a.organizationId, a.metadata.target, a.metadata.requested_status]),
      [['workspace_publication.refused', 'denied', 'publication_requires_super_admin', INSTITUTE, target, requested]], path);
  }

  const lostRace = await call('post', '/center/paper-blueprints/:id/lock', { params: { id: ID } });
  assert.deepEqual([lostRace.status, lostRace.audits.length], [404, 0], 'no row changed, no event');

  const statements: string[] = [];
  await assert.rejects(withFakeClient(() => undefined, async () => {
    const mutableConnect = pool as unknown as { connect: () => Promise<unknown> };
    mutableConnect.connect = async () => ({
      query: async (text: string) => {
        statements.push(text === AUDIT_INSERT_SQL ? 'AUDIT' : /^\s*INSERT INTO institute_attendance_logs/.test(text) ? 'MARK' : text);
        if (text === AUDIT_INSERT_SQL) throw new Error('synthetic audit failure');
        return { rows: /INSERT INTO institute_attendance_logs/.test(text) ? [{ id: ID, status: 'present', reason: 'Synthetic' }] : [], rowCount: 1 };
      },
      release() {},
    });
    return call('post', '/center/attendance/mark', { body: { rollNumber: 'R-1', candidateName: 'Synthetic Person', status: 'present', reason: 'Synthetic' } });
  }), /synthetic audit failure/);
  assert.deepEqual(statements, ['BEGIN', 'MARK', 'AUDIT', 'ROLLBACK'], 'no attendance mark without its audit event');
});

test('A-11: interview scheduling, cancelling and rescheduling, and scorecards are audited with dates and reasons only', async () => {
  const { INTERVIEW_SQL } = await import('./instituteWorkspace.js');
  const IV2 = '00000000-0000-4000-8000-0000000000ba';
  const booked = await withFakeClient((text) => (text === INTERVIEW_SQL.insert ? { rows: [{ id: IV2 }] } : undefined),
    () => call('post', '/center/interviews', { body: { candidateName: 'Synthetic Person', panelName: 'Panel A', scheduledDate: '2099-03-05', startTime: '10:00', endTime: '10:30' } }));
  assert.deepEqual(booked.audits.map((a) => [a.action, a.resourceId, a.metadata]), [['workspace_interview.scheduled', IV2, { scheduled_date: '2099-03-05' }]]);

  const row = { id: IV2, status: 'scheduled', scheduled_date: '2099-03-05', start_time: '10:00', end_time: '10:30', panel_name: 'Panel A', panelist_names: '', candidate_name: 'Synthetic Person' };
  const state = (text: string) => (text === INTERVIEW_SQL.current ? { rows: [row] } : text === INTERVIEW_SQL.cancel || text === INTERVIEW_SQL.reschedule ? { rows: [{ id: IV2 }] } : text === INTERVIEW_SQL.insertChange ? { rows: [{ id: 'c1' }] } : undefined);
  const cancelled = await withFakeClient(state, () => call('post', '/center/interviews/:id/cancel', { params: { id: IV2 }, body: { reason: 'Synthetic withdrawal' } }));
  assert.deepEqual(cancelled.audits.map((a) => [a.action, a.metadata]), [['workspace_interview.cancelled', { previous_date: '2099-03-05', reason_text: 'Synthetic withdrawal' }]]);
  const moved = await withFakeClient(state, () => call('post', '/center/interviews/:id/reschedule', { params: { id: IV2 }, body: { scheduledDate: '2099-03-06', startTime: '11:00', endTime: '11:30', reason: 'Synthetic move' } }));
  assert.deepEqual(moved.audits.map((a) => [a.action, a.metadata]), [['workspace_interview.rescheduled', { previous_date: '2099-03-05', new_date: '2099-03-06', reason_text: 'Synthetic move' }]]);

  const scored = await withFakeClient((text) => (text === INTERVIEW_SQL.forScorecard ? { rows: [{ status: 'scheduled', scheduled_date: '2020-01-01' }] } : text === INTERVIEW_SQL.insertScorecard ? { rows: [{ id: 's1' }] } : undefined),
    () => call('post', '/center/interviews/:id/scorecards', { params: { id: IV2 }, body: { panelistName: 'Synthetic Panelist', subjectScore: 7, communicationScore: 7, pedagogyScore: 7, problemSolvingScore: 7 } }));
  assert.deepEqual(scored.audits.map((a) => [a.action, a.resourceId, a.metadata]), [['workspace_scorecard.submitted', IV2, {}]], 'no scores or panelist names in the event');
});

test('A-11: an application review records the statuses and reason in the same transaction, never the candidate', async () => {
  const { APPLICATION_SQL } = await import('./instituteWorkspace.js');
  const reviewed = await withFakeClient((text) => (
    text === APPLICATION_SQL.current ? { rows: [{ review_status: 'pending' }] }
      : text === APPLICATION_SQL.review ? { rows: [{ id: 'a1', application_number: 'APP-2099-XY', candidate_name: 'Synthetic Person' }] } : undefined
  ), () => call('post', '/center/applications/:id/review', { params: { id: 'a1' }, body: { action: 'flagged', reason: 'Synthetic mismatch' } }));
  assert.equal(reviewed.result.status, 200);
  assert.deepEqual(reviewed.audits.map((a) => [a.action, a.organizationId, a.resourceId, a.metadata]),
    [['workspace_application.reviewed', INSTITUTE, 'a1', { application_number: 'APP-2099-XY', previous_status: 'pending', new_status: 'flagged', reason_text: 'Synthetic mismatch' }]]);
  assert.equal(reviewed.log.at(-1)!.text, 'COMMIT');
});

test('A-11: the remaining Institute writes are audited too, without names, contacts or content', async () => {
  const ID = '00000000-0000-4000-8000-0000000000ac';
  const owns: Handler = (text) => (/^SELECT 1 FROM institute_(exams|app_forms|training_courses) WHERE id = \$1 AND institute_id = \$2$/.test(text) ? { rows: [{ '?column?': 1 }] } : undefined);
  const returning = (row: Record<string, unknown>, extra?: Handler): Handler => (text, values) => owns(text, values) ?? extra?.(text, values) ?? (/^\s*(INSERT|UPDATE)/.test(text) ? { rows: [{ id: ID, ...row }] } : undefined);
  const cases: Array<[string, 'post' | 'patch', string, Record<string, string>, unknown, Handler, string, Record<string, unknown>]> = [
    ['branch created', 'post', '/center/branches', {}, { name: 'Synthetic Branch', code: 'syn-1', city: 'Synthetic City', coordinatorName: 'Synthetic Coordinator', coordinatorEmail: 'coord@example.test' }, returning({ code: 'SYN-1' }), 'workspace_branch.created', { branch_code: 'SYN-1' }],
    ['branch updated', 'patch', '/center/branches/:id', { id: ID }, { status: 'inactive', coordinatorEmail: 'new@example.test' }, returning({ code: 'SYN-1' }), 'workspace_branch.updated', { branch_code: 'SYN-1', changed_fields: ['status', 'coordinatorEmail'], new_status: 'inactive' }],
    ['form created', 'post', '/center/app-forms', {}, { title: 'Synthetic Form', fields: [{ id: 'name', label: 'Name', type: 'text' }, { id: 'city', label: 'City', type: 'text' }] }, returning({ version: 1, status: 'draft' }, (text) => (/COALESCE\(MAX\(version\)/.test(text) ? { rows: [{ next_version: 1 }] } : undefined)), 'workspace_app_form.created', { version: 1, new_status: 'draft', field_count: 2 }],
    ['form status changed', 'patch', '/center/app-forms/:id', { id: ID }, { status: 'archived' }, returning({ version: 2, status: 'archived' }), 'workspace_app_form.status_changed', { version: 2, new_status: 'archived' }],
    ['admit-card template created', 'post', '/center/admit-cards/templates', {}, { templateName: 'Synthetic Template', instructions: 'Synthetic instructions' }, returning({ show_photo: true, show_qr: false }), 'workspace_admit_card_template.created', { show_photo: true, show_qr: false }],
    ['paper created', 'post', '/center/paper-blueprints', {}, { title: 'Synthetic Paper', durationMinutes: 90, questionIds: [ID] }, returning({ duration_minutes: 90 }, (text) => (/FROM institute_questions/.test(text) ? { rows: [{ id: ID, marks: '2' }] } : undefined)), 'workspace_paper.created', { question_count: 1, duration_minutes: 90 }],
    ['report saved', 'post', '/center/reports/saved', {}, { name: 'Synthetic Report', dataset: 'results' }, returning({ dataset: 'results', output_format: 'csv' }), 'workspace_report.saved', { dataset: 'results', output_format: 'csv' }],
    ['refund requested', 'post', '/center/payments/refunds', {}, { transactionId: ID, amountPaise: 1500, reason: 'Synthetic duplicate fee' }, returning({}, (text) => (/FROM institute_fee_transactions WHERE id/.test(text) ? { rows: [{ id: ID, amount_paise: '5000', status: 'successful' }] } : undefined)), 'workspace_refund.requested', { amount_paise: 1500 }],
  ];
  for (const [label, method, path, params, body, handler, action, metadata] of cases) {
    const result = await call(method, path, { params, body, handler });
    assert.ok(result.status === 200 || result.status === 201, `${label}: ${result.status} ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.audits.map((a) => [a.action, a.outcome, a.actorRole, a.organizationId, a.resourceId]), [[action, 'succeeded', 'center', INSTITUTE, ID]], label);
    assert.deepEqual(result.audits[0].metadata, metadata, `${label}: metadata`);
    assert.doesNotMatch(JSON.stringify(result.audits[0].metadata), /Synthetic (Coordinator|Branch|Form|Template|Paper|Report)|example\.test|Synthetic (instructions|duplicate)/, `${label}: no names, contacts or content`);
  }
  const missing = await call('patch', '/center/branches/:id', { params: { id: ID }, body: { status: 'inactive' } });
  assert.deepEqual([missing.status, missing.audits.length], [404, 0], 'no branch changed, no event');
});

test('A-11 coverage: every Institute write route is either audited or refused outright', () => {
  const writes = (createInstituteWorkspaceRouter().stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
    .filter((layer) => layer.route && (layer.route.methods.post || layer.route.methods.patch || layer.route.methods.put || layer.route.methods.delete))
    .map((layer) => `${Object.keys(layer.route!.methods).find((m) => m !== '_all')!.toUpperCase()} ${layer.route!.path}`).sort();
  // Refused before any write (nothing to record, or recorded as a D-02 refusal).
  const REFUSED = ['PATCH /center/admit-cards/:id/release', 'POST /center/exams/:id/broadcasts', 'POST /center/tickets', 'PATCH /center/tickets/:id', 'POST /center/training/enrollments/:id/certificate'];
  const AUDITED = [
    'POST /center/branches', 'PATCH /center/branches/:id', 'POST /center/exams', 'POST /center/exams/:id/transition', 'POST /center/app-forms', 'PATCH /center/app-forms/:id',
    'POST /center/applications', 'POST /center/applications/:id/review', 'POST /center/payments/refunds', 'PATCH /center/payments/refunds/:id',
    'POST /center/admit-cards/templates', 'POST /center/admit-cards/generate', 'POST /center/questions', 'PATCH /center/questions/:id/moderate',
    'POST /center/paper-blueprints', 'POST /center/paper-blueprints/:id/lock', 'POST /center/cbt-incidents/:id/review', 'POST /center/results',
    'PATCH /center/results/:id/status', 'POST /center/reports/saved', 'POST /center/attendance/mark', 'POST /center/interviews',
    'POST /center/interviews/:id/scorecards', 'POST /center/interviews/:id/cancel', 'POST /center/interviews/:id/reschedule',
    'POST /center/training/courses', 'POST /center/training/sessions', 'POST /center/training/enrollments',
  ];
  // POST /center/reports/preview only reads; it is listed so a new write route cannot slip past this check.
  assert.deepEqual(writes, [...REFUSED, ...AUDITED, 'POST /center/reports/preview'].sort(), 'a new write route must be audited (or refused) and listed here');
});
