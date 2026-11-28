// D-02 (2026-11-27): Super Admin tab — review and officially publish Institute-prepared examinations,
// results and admit cards (routes in server/instituteWorkspaceAdmin.ts). The server authorizes every
// action (Super Admin only) and only moves records that are still in the expected state; this panel
// shows the server's answer and never assumes success.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, apiRequestWithMeta } from '../../api';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingState, StatusBadge, TextField } from '../ui';
import { examStatusLabel, isOfficialExamState } from '../../utils/workspaceExams';

interface QueueExam { id: string; institute_name: string; exam_code: string; title: string; category: string; mode: string; lifecycle_status: string; exam_date: string; updated_at: string }
interface QueueResultGroup { exam_id: string; exam_code: string; title: string; institute_name: string; ready_for_review: number; approved: number; published: number; exam_status: string }
interface QueueAdmitGroup { exam_id: string; exam_code: string; title: string; institute_name: string; drafts: number; held_drafts: number; released: number; exam_status: string }
interface Queue { exams: QueueExam[]; results: QueueResultGroup[]; admitCards: QueueAdmitGroup[] }
interface ResultRow { id: string; roll_number: string; candidate_name: string; raw_score: string | number; max_score: string | number; percentage: string | number; qualifying_status: string; evaluation_status: string; version: number }

type PendingAction =
  | { kind: 'exam'; exam: QueueExam; decision: 'approve' | 'request_changes' | 'publish'; reason: string }
  | { kind: 'results'; group: QueueResultGroup; decision: 'approve' | 'publish' | 'return'; reviewed?: Array<{ id: string; version: number }> }
  | { kind: 'admit'; group: QueueAdmitGroup; decision: 'release' | 'revoke' };

const EXAM_DECISION_LABEL = { approve: 'Approve', request_changes: 'Request changes', publish: 'Publish' } as const;
const RESULT_DECISION_LABEL = { approve: 'Approve results', publish: 'Publish results', return: 'Return to institute' } as const;
const ADMIT_DECISION_LABEL = { release: 'Release admit cards', revoke: 'Revoke released cards' } as const;

const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');
const dateOnly = (value: unknown) => (typeof value === 'string' ? value.slice(0, 10) : '—');

/** The confirmation text for each action (publication and release are official and visible). */
export function describeAction(action: PendingAction): string {
  if (action.kind === 'exam') {
    return action.decision === 'publish'
      ? `Publish ${action.exam.exam_code} officially on behalf of ${action.exam.institute_name}?`
      : `${EXAM_DECISION_LABEL[action.decision]} ${action.exam.exam_code} (${action.exam.institute_name})?`;
  }
  if (action.kind === 'results') {
    const count = action.decision === 'approve' ? (action.reviewed?.length ?? 0) : action.decision === 'publish' ? action.group.approved : action.group.ready_for_review;
    return `${RESULT_DECISION_LABEL[action.decision]}: ${count} result${count === 1 ? '' : 's'} of ${action.group.exam_code} (${action.group.institute_name})?`;
  }
  const count = action.decision === 'release' ? action.group.drafts : action.group.released;
  return `${ADMIT_DECISION_LABEL[action.decision]}: ${count} admit card${count === 1 ? '' : 's'} of ${action.group.exam_code} (${action.group.institute_name})?`;
}

/** The exam's state, and whether results and admit cards may be made official for it. */
const ExamStateNote: React.FC<{ status: string }> = ({ status }) => (
  <div>
    <div className="text-sm">{examStatusLabel(status)}</div>
    {!isOfficialExamState(status) && <div className="text-xs text-amber-800">Nothing can be approved, published or released for this examination.</div>}
  </div>
);

export const InstituteWorkspaceReviewPanel: React.FC = () => {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ group: QueueResultGroup; rows: ResultRow[] | null; error: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setQueue(await apiRequest<Queue>('/api/admin/institute-workspace/review-queue'));
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Only the latest request may fill the view, so a slow answer for another exam never shows under this one.
  const viewRequest = useRef(0);
  const viewResults = async (group: QueueResultGroup) => {
    const request = ++viewRequest.current;
    setViewing({ group, rows: null, error: null });
    try {
      const data = await apiRequest<{ results: ResultRow[] }>(`/api/admin/institute-workspace/exams/${encodeURIComponent(group.exam_id)}/results`);
      if (request === viewRequest.current) setViewing({ group, rows: data.results, error: null });
    } catch (error) {
      if (request === viewRequest.current) setViewing({ group, rows: null, error: errorText(error) });
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      if (pending.kind === 'exam') {
        const result = await apiRequest<{ exam: { exam_code: string; lifecycle_status: string } }>(`/api/admin/institute-workspace/exams/${encodeURIComponent(pending.exam.id)}/decision`, {
          method: 'POST', body: JSON.stringify(pending.decision === 'request_changes' ? { decision: pending.decision, reason: pending.reason.trim() } : { decision: pending.decision }),
        });
        setNotice(`${result.exam.exam_code} is now ${result.exam.lifecycle_status.replace(/_/g, ' ')}.`);
      } else {
        const examId = pending.kind === 'results' ? pending.group.exam_id : pending.group.exam_id;
        const path = pending.kind === 'results' ? 'results/decision' : 'admit-cards/decision';
        // apiRequestWithMeta puts the server's error code on ApiError (RESULTS_CHANGED is handled below).
        const { data: result } = await apiRequestWithMeta<{ updated: number }>(`/api/admin/institute-workspace/exams/${encodeURIComponent(examId)}/${path}`, {
          method: 'POST', body: JSON.stringify(pending.kind === 'results' && pending.decision === 'approve' ? { decision: 'approve', reviewed: pending.reviewed ?? [] } : { decision: pending.decision }),
        });
        setNotice(`${pending.group.exam_code}: ${result.updated} record${result.updated === 1 ? '' : 's'} updated.`);
        if (viewing && pending.kind === 'results' && viewing.group.exam_id === pending.group.exam_id) void viewResults(pending.group);
      }
      setPending(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RESULTS_CHANGED' && pending.kind === 'results') {
        // The reviewed versions are stale: close the decision and reload the results to review them again.
        setPending(null);
        setNotice(null);
        void viewResults(pending.group);
        await load();
        setLoadError(error.message); // after load(), which clears it when it starts
        return;
      }
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !queue) return <LoadingState label="Loading the institute review queue…" />;
  if (loadError && !queue) return <ErrorState description={loadError} onRetry={() => void load()} />;
  if (!queue) return null;

  const needsReason = pending?.kind === 'exam' && pending.decision === 'request_changes';
  return (
    <div className="space-y-5">
      <Card
        title="Institute reviews"
        headingLevel={3}
        description="Institutes prepare examinations, results and admit cards as drafts. Approving and publishing them is your decision (D-02). Every action only changes records that are still waiting for it."
        actions={<Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void load()}>Refresh</Button>}
      >
        {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
        {loadError && <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{loadError}</p>}
        {pending && (
          <div role="dialog" aria-label="Confirm review decision" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
            <p className="font-semibold text-amber-900">{describeAction(pending)}</p>
            {needsReason && pending.kind === 'exam' && (
              <TextField label="What should the institute change?" required value={pending.reason} onChange={(event) => setPending({ ...pending, reason: event.target.value })} hint="At least 5 characters. The institute sees this." maxLength={500} />
            )}
            {actionError && <p role="alert" className="mt-2 text-rose-800">{actionError}</p>}
            <div className="mt-3 flex gap-2">
              <Button type="button" size="sm" loading={busy} disabled={needsReason && pending.kind === 'exam' && pending.reason.trim().length < 5} onClick={() => void confirm()}>Confirm</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setPending(null); setActionError(null); }}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Examinations" headingLevel={3} description="Awaiting review, or approved and waiting for publication." padded={false}>
        {queue.exams.length === 0 ? <EmptyState title="No examinations waiting" /> : (
          <DataTable
            caption="Institute examinations waiting for a decision"
            captionHidden
            rows={queue.exams}
            rowKey={(row) => row.id}
            columns={[
              { key: 'exam', header: 'Examination', isRowHeader: true, render: (row) => <div><div className="font-semibold">{row.title}</div><div className="text-xs text-slate-500">{row.exam_code} · {row.category} · {row.mode}</div></div> },
              { key: 'institute', header: 'Institute', render: (row) => row.institute_name },
              { key: 'date', header: 'Exam date', render: (row) => dateOnly(row.exam_date) },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.lifecycle_status === 'approved' ? 'approved' : 'pending'} label={row.lifecycle_status === 'approved' ? 'Approved, not published' : 'Awaiting review'} /> },
              { key: 'actions', header: 'Decision', render: (row) => (
                <div className="flex flex-wrap gap-1">
                  {row.lifecycle_status === 'pending_approval' && <>
                    <Button type="button" size="sm" onClick={() => setPending({ kind: 'exam', exam: row, decision: 'approve', reason: '' })}>Approve</Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setPending({ kind: 'exam', exam: row, decision: 'request_changes', reason: '' })}>Request changes</Button>
                  </>}
                  {row.lifecycle_status === 'approved' && <Button type="button" size="sm" onClick={() => setPending({ kind: 'exam', exam: row, decision: 'publish', reason: '' })}>Publish</Button>}
                </div>
              ) },
            ]}
          />
        )}
      </Card>

      <Card title="Results" headingLevel={3} description="Results an institute marked ready for review, or that you approved and have not yet published. Open the results to approve them: only the versions you see are approved." padded={false}>
        {queue.results.length === 0 ? <EmptyState title="No results waiting" /> : (
          <DataTable
            caption="Institute results waiting for a decision"
            captionHidden
            rows={queue.results}
            rowKey={(row) => row.exam_id}
            columns={[
              { key: 'exam', header: 'Examination', isRowHeader: true, render: (row) => <div><div className="font-semibold">{row.title}</div><div className="text-xs text-slate-500">{row.exam_code}</div></div> },
              { key: 'institute', header: 'Institute', render: (row) => row.institute_name },
              { key: 'counts', header: 'Ready / approved / published', render: (row) => `${row.ready_for_review} / ${row.approved} / ${row.published}` },
              { key: 'exam-status', header: 'Exam status', render: (row) => <ExamStateNote status={row.exam_status} /> },
              { key: 'actions', header: 'Decision', render: (row) => (
                <div className="flex flex-wrap gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => void viewResults(row)}>{row.ready_for_review > 0 ? 'Open to review' : 'View'}</Button>
                  {row.ready_for_review > 0 && <Button type="button" size="sm" variant="secondary" onClick={() => setPending({ kind: 'results', group: row, decision: 'return' })}>Return</Button>}
                  {row.approved > 0 && isOfficialExamState(row.exam_status) && <Button type="button" size="sm" onClick={() => setPending({ kind: 'results', group: row, decision: 'publish' })}>Publish</Button>}
                </div>
              ) },
            ]}
          />
        )}
        {viewing && (
          <div className="border-t border-slate-200 p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-bold text-slate-800">{viewing.group.exam_code}: results</h4>
              <div className="flex gap-1">
                {viewing.rows && (() => {
                  const ready = viewing.rows.filter((row) => row.evaluation_status === 'moderated');
                  if (ready.length === 0) return null;
                  return isOfficialExamState(viewing.group.exam_status)
                    ? <Button type="button" size="sm" onClick={() => setPending({ kind: 'results', group: viewing.group, decision: 'approve', reviewed: ready.map((row) => ({ id: row.id, version: row.version })) })}>Approve the {ready.length} shown</Button>
                    : <span className="text-xs text-amber-800">Approve the examination first</span>;
                })()}
                <Button type="button" size="sm" variant="ghost" onClick={() => { viewRequest.current += 1; setViewing(null); }}>Close</Button>
              </div>
            </div>
            {viewing.error ? <p role="alert" className="text-sm text-rose-800">{viewing.error}</p> : viewing.rows === null ? <p role="status" className="text-sm text-slate-600">Loading results…</p> : (
              <DataTable
                caption={`Results of ${viewing.group.exam_code}`}
                captionHidden
                rows={viewing.rows}
                rowKey={(row) => row.id}
                emptyTitle="No results"
                columns={[
                  { key: 'roll', header: 'Roll number', isRowHeader: true, render: (row) => row.roll_number },
                  { key: 'name', header: 'Candidate', render: (row) => row.candidate_name },
                  { key: 'marks', header: 'Marks', render: (row) => `${Number(row.raw_score)} / ${Number(row.max_score)} (${Number(row.percentage)}%)` },
                  { key: 'result', header: 'Result', render: (row) => row.qualifying_status },
                  { key: 'status', header: 'Status', render: (row) => row.evaluation_status },
                ]}
              />
            )}
          </div>
        )}
      </Card>

      <Card title="Admit cards" headingLevel={3} description="Draft admit cards an institute generated. Releasing makes them official." padded={false}>
        {queue.admitCards.length === 0 ? <EmptyState title="No admit cards waiting" /> : (
          <DataTable
            caption="Draft admit cards waiting for release"
            captionHidden
            rows={queue.admitCards}
            rowKey={(row) => row.exam_id}
            columns={[
              { key: 'exam', header: 'Examination', isRowHeader: true, render: (row) => <div><div className="font-semibold">{row.title}</div><div className="text-xs text-slate-500">{row.exam_code}</div></div> },
              { key: 'institute', header: 'Institute', render: (row) => row.institute_name },
              { key: 'counts', header: 'Drafts / released', render: (row) => <div>{row.drafts} / {row.released}{row.held_drafts > 0 && <div className="text-xs text-amber-800">{row.held_drafts} held: application no longer verified</div>}</div> },
              { key: 'exam-status', header: 'Exam status', render: (row) => <ExamStateNote status={row.exam_status} /> },
              { key: 'actions', header: 'Decision', render: (row) => (
                <div className="flex flex-wrap gap-1">
                  {row.drafts > 0 && isOfficialExamState(row.exam_status) && <Button type="button" size="sm" onClick={() => setPending({ kind: 'admit', group: row, decision: 'release' })}>Release</Button>}
                  {row.released > 0 && <Button type="button" size="sm" variant="danger" onClick={() => setPending({ kind: 'admit', group: row, decision: 'revoke' })}>Revoke</Button>}
                </div>
              ) },
            ]}
          />
        )}
      </Card>
    </div>
  );
};
