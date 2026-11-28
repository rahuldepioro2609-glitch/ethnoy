// D-02 Super Admin review routes for Institute Workspace drafts. Guards (401/403 for everyone but
// Super Admin, before any query) are covered by the route matrix in server/adminAuthorization.test.ts.
// No real database: the shared pool's query is scripted. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:9/workspace_admin_unit_tests';

const [{ createInstituteWorkspaceAdminRouter, WORKSPACE_ADMIN_SQL, EXAM_DECISIONS, RESULT_DECISIONS, ADMIT_CARD_DECISIONS, WORKSPACE_AUDIT_POINTS }, { pool }, { requireAuth, requireSuperAdmin }, { isValidExamTransition }, { AUDIT_INSERT_SQL }] = await Promise.all([
  import('./instituteWorkspaceAdmin.js'), import('./db.js'), import('./auth.js'), import('./instituteWorkspace.js'), import('./audit.js'),
]);

/** An audit_events row as written by server/audit.ts (AUDIT_INSERT_SQL parameter order). */
interface AuditRow { action: string; outcome: string; reasonCode: string | null; actorRole: string; organizationId: string | null; resourceId: string | null; metadata: Record<string, unknown> }
const auditRow = (values: unknown[]): AuditRow => ({
  action: String(values[1]), outcome: String(values[2]), reasonCode: values[3] as string | null, actorRole: String(values[6]),
  organizationId: values[7] as string | null, resourceId: values[9] as string | null, metadata: JSON.parse(String(values[10])),
});
const CONTROL = /^(BEGIN|COMMIT|ROLLBACK)$/;

const EXAM = '00000000-0000-4000-8000-0000000000e1';
const SUPER_ADMIN = 'synthetic-super-admin';
type Handler = (text: string, values: unknown[]) => { rows?: Record<string, unknown>[]; rowCount?: number } | undefined;
const mutable = pool as unknown as { query: (text: string, values?: unknown[]) => Promise<unknown>; connect: () => Promise<unknown> };
const original = mutable.query;
const originalConnect = mutable.connect;

async function call(method: 'get' | 'post', path: string, options: { params?: Record<string, string>; body?: unknown; handler?: Handler } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  // Audit rows count only once their transaction commits; a ROLLBACK discards them, as PostgreSQL would.
  const audits: AuditRow[] = [];
  const answer = (text: string, values: unknown[]) => {
    const result = options.handler?.(text, values);
    return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? result?.rows?.length ?? 0 };
  };
  mutable.query = async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });
    return answer(text, values);
  };
  // Transaction clients answer like the pool; BEGIN/COMMIT/ROLLBACK and audit inserts are kept out of
  // `queries` so business-statement assertions stay exact. A test that installs its own client keeps it.
  const ownConnect = mutable.connect === originalConnect;
  if (ownConnect) {
    mutable.connect = async () => {
      const pending: AuditRow[] = [];
      return {
        query: async (text: string, values: unknown[] = []) => {
          if (text === AUDIT_INSERT_SQL) { pending.push(auditRow(values)); return { rows: [], rowCount: 1 }; }
          if (text === 'COMMIT') audits.push(...pending.splice(0));
          if (text === 'ROLLBACK') pending.length = 0;
          if (CONTROL.test(text)) return { rows: [], rowCount: 0 };
          queries.push({ text, values });
          return answer(text, values);
        },
        release() {},
      };
    };
  }
  try {
    const router = createInstituteWorkspaceAdminRouter();
    const layer = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => unknown }> } }>)
      .find((item) => item.route?.path === path && item.route.methods[method]);
    assert.ok(layer, `${method} ${path}`);
    const handler = layer.route!.stack.at(-1)!.handle;
    const result: { status: number; body: Record<string, unknown> | undefined } = { status: 200, body: undefined };
    await new Promise<void>((resolve, reject) => {
      const res = {
        set() { return res; },
        status(code: number) { result.status = code; return res; },
        json(value: Record<string, unknown>) { result.body = value; resolve(); return res; },
      } as unknown as Response;
      const req = { params: options.params ?? {}, body: options.body, user: { id: SUPER_ADMIN, role: 'official', isSuperAdmin: true } } as unknown as Request;
      handler(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
    });
    return { ...result, queries, audits };
  } finally {
    mutable.query = original;
    if (ownConnect) mutable.connect = originalConnect;
  }
}

const exam = (status: string): Handler => (text) => (text === WORKSPACE_ADMIN_SQL.exam ? { rows: [{ id: EXAM, institute_id: 'inst-a', exam_code: 'DEMO-1', lifecycle_status: status }] } : undefined);

test('every route is Super Admin only and under /admin/institute-workspace', () => {
  const routes = (createInstituteWorkspaceAdminRouter().stack as Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>).filter((item) => item.route);
  assert.equal(routes.length, 5);
  for (const { route } of routes) {
    assert.match(route!.path, /^\/admin\/institute-workspace\//);
    assert.equal(route!.stack[0].handle, requireAuth);
    assert.equal(route!.stack[2].handle, requireSuperAdmin, `${route!.path}: requireSuperAdmin`);
  }
});

test('the decision tables only use transitions the exam lifecycle allows', () => {
  for (const [from, to] of Object.values(EXAM_DECISIONS)) assert.equal(isValidExamTransition(from, to), true, `${from} -> ${to}`);
  assert.deepEqual(Object.values(RESULT_DECISIONS), [['moderated', 'approved'], ['approved', 'published'], ['moderated', 'evaluated']]);
  assert.deepEqual(Object.values(ADMIT_CARD_DECISIONS), [['generated', 'released'], ['released', 'revoked']]);
  assert.equal(Object.keys(WORKSPACE_AUDIT_POINTS).length, 8, 'every decision has an audit integration point');
});

test('review queue: three read-only queries across all Institutes', async () => {
  const result = await call('get', '/admin/institute-workspace/review-queue');
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body!), ['exams', 'results', 'admitCards']);
  assert.ok(result.queries.every((q) => /^SELECT/.test(q.text.trim())), 'no writes');
});

test('exam approval: compare-and-set from pending_approval, records the approving Super Admin', async () => {
  const ok = await call('post', '/admin/institute-workspace/exams/:id/decision', {
    params: { id: EXAM }, body: { decision: 'approve' },
    handler: (text, values) => exam('pending_approval')(text, values) ?? (text === WORKSPACE_ADMIN_SQL.decideExam ? { rows: [{ id: EXAM, lifecycle_status: 'approved' }] } : undefined),
  });
  assert.equal(ok.status, 200);
  const update = ok.queries.find((q) => q.text === WORKSPACE_ADMIN_SQL.decideExam)!;
  assert.deepEqual(update.values, [EXAM, 'pending_approval', 'approved', '', SUPER_ADMIN]);
  assert.match(WORKSPACE_ADMIN_SQL.decideExam, /WHERE id = \$1 AND lifecycle_status = \$2/);

  const raced = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision: 'approve' }, handler: exam('pending_approval') });
  assert.deepEqual([raced.status, raced.body?.code], [409, 'EXAM_CHANGED']);
});

test('exam decisions are refused from the wrong state, and request_changes needs a reason', async () => {
  for (const [decision, status] of [['publish', 'pending_approval'], ['approve', 'draft'], ['approve', 'published'], ['request_changes', 'approved']]) {
    const result = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision, reason: 'Synthetic reason' }, handler: exam(status) });
    assert.deepEqual([result.status, result.body?.code], [409, 'INVALID_TRANSITION'], `${decision} from ${status}`);
    assert.ok(!result.queries.some((q) => q.text === WORKSPACE_ADMIN_SQL.decideExam));
  }
  const noReason = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision: 'request_changes' }, handler: exam('pending_approval') });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.queries.length, 0, 'refused before any query');
  const unknown = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision: 'registration_open' } });
  assert.equal(unknown.status, 400);
  const badId = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: 'not-a-uuid' }, body: { decision: 'approve' } });
  assert.equal(badId.status, 400);
  const missing = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision: 'approve' } });
  assert.equal(missing.status, 404);
});

/** pool.connect replaced by a scripted transaction client; returns the client's statements. */
async function withClient<T>(reply: Handler, work: () => Promise<T>): Promise<{ result: T; log: Array<{ text: string; values: unknown[] }> }> {
  const log: Array<{ text: string; values: unknown[] }> = [];
  const mutableConnect = pool as unknown as { connect: () => Promise<unknown> };
  const originalConnect = mutableConnect.connect;
  mutableConnect.connect = async () => ({
    query: async (text: string, values: unknown[] = []) => { log.push({ text, values }); const r = reply(text, values); return { rows: r?.rows ?? [], rowCount: r?.rowCount ?? r?.rows?.length ?? 0 }; },
    release() {},
  });
  try { return { result: await work(), log }; } finally { mutableConnect.connect = originalConnect; }
}

const REVIEWED = [{ id: 'r1', version: 2 }, { id: 'r2', version: 1 }];

test('results: approval takes only the reviewed versions, all or nothing; publish and return move rows in the expected state', async () => {
  const approve = await withClient((text) => (text === WORKSPACE_ADMIN_SQL.approveResults ? { rowCount: 2 } : undefined),
    () => call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision: 'approve', reviewed: REVIEWED }, handler: exam('approved') }));
  assert.deepEqual([approve.result.status, approve.result.body?.updated], [200, 2]);
  const update = approve.log.find((q) => q.text === WORKSPACE_ADMIN_SQL.approveResults)!;
  assert.deepEqual(update.values, [EXAM, 'moderated', 'approved', SUPER_ADMIN, ['r1:2', 'r2:1']]);
  assert.match(WORKSPACE_ADMIN_SQL.approveResults, /\(id \|\| ':' \|\| version\) = ANY\(\$5::text\[\]\)/);
  assert.equal(approve.log.at(-1)!.text, 'COMMIT');

  const changed = await withClient((text) => (text === WORKSPACE_ADMIN_SQL.approveResults ? { rowCount: 1 } : undefined),
    () => call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision: 'approve', reviewed: REVIEWED }, handler: exam('approved') }));
  assert.deepEqual([changed.result.status, changed.result.body?.code], [409, 'RESULTS_CHANGED'], 'one result rewritten since review');
  const steps = changed.log.map((q) => (q.text === WORKSPACE_ADMIN_SQL.approveResults ? 'APPROVE' : q.text === AUDIT_INSERT_SQL ? 'AUDIT' : q.text));
  assert.deepEqual(steps, ['BEGIN', 'APPROVE', 'ROLLBACK', 'BEGIN', 'AUDIT', 'COMMIT'], 'nothing approved; the refusal is recorded on its own transaction');
  const refused = auditRow(changed.log.find((q) => q.text === AUDIT_INSERT_SQL)!.values);
  assert.deepEqual([refused.action, refused.outcome, refused.reasonCode, refused.organizationId], ['workspace_results.approved', 'denied', 'results_changed', 'inst-a']);

  const unreviewed = await call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision: 'approve' } });
  assert.deepEqual([unreviewed.status, unreviewed.body?.code, unreviewed.queries.length], [400, 'REVIEW_REQUIRED', 0]);

  for (const [decision, from, to, sql] of [['publish', 'approved', 'published', WORKSPACE_ADMIN_SQL.publishResults], ['return', 'moderated', 'evaluated', WORKSPACE_ADMIN_SQL.returnResults]] as const) {
    const result = await withClient((text) => (text === sql ? { rowCount: 7 } : undefined),
      () => call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision }, handler: exam('published') }));
    assert.deepEqual([result.result.status, result.result.body?.updated], [200, 7], decision);
    assert.deepEqual(result.log.find((q) => q.text === sql)!.values.slice(0, 3), [EXAM, from, to]);
  }
  assert.match(WORKSPACE_ADMIN_SQL.publishResults, /published_at = now\(\)/);
  const none = await withClient(() => undefined, () => call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision: 'publish' }, handler: exam('published') }));
  assert.deepEqual([none.result.status, none.result.body?.code], [409, 'NOTHING_TO_DECIDE']);
  const extra = await call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision: 'publish', examId: 'other' } });
  assert.equal(extra.status, 400, 'unknown fields are refused');
});

test('results and admit cards are approved, published or released only for an exam ELTNOY approved; revoke and return always work', async () => {
  for (const status of ['draft', 'pending_approval', 'needs_changes', 'cancelled', 'archived']) {
    for (const [path, body] of [['results/decision', { decision: 'approve', reviewed: REVIEWED }], ['results/decision', { decision: 'publish' }], ['admit-cards/decision', { decision: 'release' }]] as const) {
      const refused = await call('post', `/admin/institute-workspace/exams/:id/${path}`, { params: { id: EXAM }, body, handler: exam(status) });
      assert.deepEqual([refused.status, refused.body?.code], [409, 'EXAM_NOT_APPROVED'], `${path} ${body.decision} on ${status}`);
      assert.ok(!refused.queries.some((q) => /^\s*UPDATE/.test(q.text)), 'nothing written');
    }
  }
  for (const sql of [WORKSPACE_ADMIN_SQL.approveResults, WORKSPACE_ADMIN_SQL.publishResults, WORKSPACE_ADMIN_SQL.releaseAdmitCards]) {
    assert.match(sql, /e\.lifecycle_status IN \('approved', 'published', 'registration_open', 'closed'\)/, 'the state is re-checked atomically');
  }
  const revoke = await call('post', '/admin/institute-workspace/exams/:id/admit-cards/decision', {
    params: { id: EXAM }, body: { decision: 'revoke' },
    handler: (text, values) => exam('cancelled')(text, values) ?? (text === WORKSPACE_ADMIN_SQL.revokeAdmitCards ? { rowCount: 3 } : undefined),
  });
  assert.deepEqual([revoke.status, revoke.body?.updated], [200, 3], 'cards of a cancelled exam can still be revoked');
  const returned = await withClient((text) => (text === WORKSPACE_ADMIN_SQL.returnResults ? { rowCount: 2 } : undefined),
    () => call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision: 'return' }, handler: exam('cancelled') }));
  assert.equal(returned.result.status, 200);
});

test('admit cards: release takes only drafts of still-verified applications; revoke only released cards', async () => {
  const release = await call('post', '/admin/institute-workspace/exams/:id/admit-cards/decision', {
    params: { id: EXAM }, body: { decision: 'release' },
    handler: (text, values) => exam('published')(text, values) ?? (text === WORKSPACE_ADMIN_SQL.releaseAdmitCards ? { rowCount: 3 } : undefined),
  });
  assert.deepEqual([release.status, release.body?.updated], [200, 3]);
  assert.deepEqual(release.queries.find((q) => q.text === WORKSPACE_ADMIN_SQL.releaseAdmitCards)!.values, [EXAM, 'generated', 'released']);
  assert.match(WORKSPACE_ADMIN_SQL.releaseAdmitCards, /a\.review_status = 'verified'/, "a rejected application's draft card is not released");
  assert.match(WORKSPACE_ADMIN_SQL.queueAdmitCards, /held_drafts/, 'the queue shows drafts held back by un-verified applications');
  const none = await call('post', '/admin/institute-workspace/exams/:id/admit-cards/decision', { params: { id: EXAM }, body: { decision: 'release' }, handler: exam('published') });
  assert.deepEqual([none.status, none.body?.code], [409, 'NOTHING_TO_DECIDE']);
});

test('result review list: one exam, no write', async () => {
  const result = await call('get', '/admin/institute-workspace/exams/:id/results', {
    params: { id: EXAM }, handler: (text, values) => exam('approved')(text, values) ?? (text === WORKSPACE_ADMIN_SQL.examResults ? { rows: [{ id: 'r1' }] } : undefined),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body?.results, [{ id: 'r1' }]);
  assert.ok(result.queries.every((q) => /^SELECT/.test(q.text.trim())));
});

test('the review screen confirms exactly the results it will approve, and shares the official exam states', async () => {
  const [{ describeAction }, { OFFICIAL_EXAM_STATES }] = await Promise.all([import('../src/components/admin/InstituteWorkspaceReviewPanel.js'), import('./instituteWorkspaceAdmin.js')]);
  const group = { exam_id: EXAM, exam_code: 'DEMO-1', title: 'Demo', institute_name: 'Demo Institute', ready_for_review: 9, approved: 0, published: 0, exam_status: 'approved' };
  assert.equal(describeAction({ kind: 'results', group, decision: 'approve', reviewed: [{ id: 'r1', version: 1 }, { id: 'r2', version: 3 }] }), 'Approve results: 2 results of DEMO-1 (Demo Institute)?', 'the reviewed count, not the queue count');
  assert.deepEqual([...OFFICIAL_EXAM_STATES], ['approved', 'published', 'registration_open', 'closed']);
});

test('A-11: every Super Admin decision writes its audit event in the same transaction; refusals are recorded as denied', async () => {
  const decided = (sql: string, count: number): Handler => (text, values) => exam('approved')(text, values) ?? (text === sql ? { rowCount: count, rows: [{ id: EXAM, lifecycle_status: 'published' }] } : undefined);

  const publish = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision: 'publish' }, handler: decided(WORKSPACE_ADMIN_SQL.decideExam, 1) });
  assert.equal(publish.status, 200);
  assert.deepEqual(publish.audits.map((a) => [a.action, a.outcome, a.actorRole, a.organizationId, a.resourceId]), [['workspace_exam.published', 'succeeded', 'super_admin', 'inst-a', EXAM]]);
  assert.deepEqual(publish.audits[0].metadata, { exam_code: 'DEMO-1', previous_status: 'approved', new_status: 'published' });

  const changes = await call('post', '/admin/institute-workspace/exams/:id/decision', {
    params: { id: EXAM }, body: { decision: 'request_changes', reason: 'Synthetic fee missing' },
    handler: (text, values) => exam('pending_approval')(text, values) ?? (text === WORKSPACE_ADMIN_SQL.decideExam ? { rows: [{ id: EXAM }] } : undefined),
  });
  assert.deepEqual([changes.audits[0].action, changes.audits[0].metadata.reason_text], ['workspace_exam.changes_requested', 'Synthetic fee missing']);

  const raced = await call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision: 'approve' }, handler: exam('pending_approval') });
  assert.deepEqual([raced.status, raced.audits.length], [409, 0], 'nothing changed, nothing recorded');

  for (const [decision, sql, action] of [['publish', WORKSPACE_ADMIN_SQL.publishResults, 'workspace_results.published'], ['return', WORKSPACE_ADMIN_SQL.returnResults, 'workspace_results.returned']] as const) {
    const result = await call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision }, handler: decided(sql, 4) });
    assert.deepEqual(result.audits.map((a) => [a.action, a.metadata.row_count, a.metadata.exam_code]), [[action, 4, 'DEMO-1']], decision);
  }
  const none = await call('post', '/admin/institute-workspace/exams/:id/results/decision', { params: { id: EXAM }, body: { decision: 'publish' }, handler: exam('approved') });
  assert.deepEqual([none.status, none.audits.length], [409, 0], 'NOTHING_TO_DECIDE records nothing');

  for (const [decision, action] of [['release', 'workspace_admit_cards.released'], ['revoke', 'workspace_admit_cards.revoked']] as const) {
    const sql = decision === 'release' ? WORKSPACE_ADMIN_SQL.releaseAdmitCards : WORKSPACE_ADMIN_SQL.revokeAdmitCards;
    const result = await call('post', '/admin/institute-workspace/exams/:id/admit-cards/decision', { params: { id: EXAM }, body: { decision }, handler: decided(sql, 3) });
    assert.deepEqual(result.audits.map((a) => [a.action, a.metadata.row_count]), [[action, 3]], decision);
  }

  // EXAM_NOT_APPROVED: refused before any business write, and recorded as denied.
  for (const [path, body, action] of [['results/decision', { decision: 'publish' }, 'workspace_results.published'], ['admit-cards/decision', { decision: 'release' }, 'workspace_admit_cards.released']] as const) {
    const refused = await call('post', `/admin/institute-workspace/exams/:id/${path}`, { params: { id: EXAM }, body, handler: exam('cancelled') });
    assert.equal(refused.body?.code, 'EXAM_NOT_APPROVED');
    assert.deepEqual(refused.audits.map((a) => [a.action, a.outcome, a.reasonCode]), [[action, 'denied', 'exam_not_approved']]);
  }

  // A-11: if the audit insert fails, the decision itself rolls back.
  const statements: string[] = [];
  await assert.rejects(withClient((text) => {
    statements.push(text === AUDIT_INSERT_SQL ? 'AUDIT' : text === WORKSPACE_ADMIN_SQL.decideExam ? 'DECIDE' : text);
    if (text === AUDIT_INSERT_SQL) throw new Error('synthetic audit failure');
    return text === WORKSPACE_ADMIN_SQL.decideExam ? { rows: [{ id: EXAM }] } : undefined;
  }, () => call('post', '/admin/institute-workspace/exams/:id/decision', { params: { id: EXAM }, body: { decision: 'publish' }, handler: exam('approved') })), /synthetic audit failure/);
  assert.deepEqual(statements, ['BEGIN', 'DECIDE', 'AUDIT', 'ROLLBACK'], 'no publication without its audit event');
});
