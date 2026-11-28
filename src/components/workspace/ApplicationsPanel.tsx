// Institute Workspace: applications received by the Institute (GET/POST /api/center/applications,
// POST /api/center/applications/:id/review, GET /api/center/applications/:id/logs).
// - Payment is never confirmed here: an application is "unpaid" or "waived" (payments, F-6, deferred).
// - Verified applications are the ones that receive draft admit cards (Admit cards section).
// - The custom form builder (/api/center/app-forms) is not shown: it waits for decision D-11, and no
//   candidate page uses those forms yet.
import React, { useState } from 'react';
import { ApiError, apiRequest } from '../../api';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface ApplicationRow {
  id: string; application_number: string; candidate_name: string; candidate_email: string; candidate_mobile: string;
  exam_code: string | null; exam_title: string | null; stage: string; payment_status: string; review_status: string; review_reason: string; created_at: string;
}
interface Summary { total: number; awaiting_review: number; verified: number; flagged: number; correction_requested: number }
interface LogRow { id: string; action: string; target_field: string; reason: string; created_at: string }
interface ExamOption { id: string; exam_code: string; title: string }

export const REVIEW_LABEL: Readonly<Record<string, string>> = Object.freeze({
  pending: 'Awaiting review', verified: 'Verified', correction_requested: 'Correction requested', flagged: 'Flagged', rejected: 'Rejected',
});
export const REVIEW_ACTIONS = [
  { action: 'verified', label: 'Verify', needsReason: false },
  { action: 'correction_requested', label: 'Request correction', needsReason: true },
  { action: 'flagged', label: 'Flag', needsReason: true },
  { action: 'rejected', label: 'Reject', needsReason: true },
] as const;
type ReviewAction = (typeof REVIEW_ACTIONS)[number];

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');
const emptyForm = { examId: '', candidateName: '', candidateEmail: '', candidateMobile: '', paymentStatus: 'unpaid' };

export const ApplicationsPanel: React.FC = () => {
  const [filter, setFilter] = useState('all');
  const apps = useWorkspaceResource<{ applications: ApplicationRow[]; summary: Summary }>(`/api/center/applications?reviewStatus=${encodeURIComponent(filter)}`);
  const exams = useWorkspaceResource<{ exams: ExamOption[] }>('/api/center/exams');
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ row: ApplicationRow; review: ReviewAction; reason: string; targetField: string } | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ row: ApplicationRow; logs: LogRow[] | null; error: string | null } | null>(null);

  const field = (key: keyof typeof emptyForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      const created = await sendWorkspaceWrite<{ application: ApplicationRow }>('/api/center/applications', 'POST', {
        examId: form.examId || null, candidateName: form.candidateName.trim(), candidateEmail: form.candidateEmail.trim(),
        candidateMobile: form.candidateMobile.trim(), paymentStatus: form.paymentStatus,
      });
      setNotice(`Application ${created.application.application_number} recorded for ${created.application.candidate_name}.`);
      setForm({ ...emptyForm, examId: form.examId });
      setShowForm(false);
      apps.reload();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const review = async () => {
    if (!pending) return;
    setActing(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await sendWorkspaceWrite<{ application: ApplicationRow }>(`/api/center/applications/${encodeURIComponent(pending.row.id)}/review`, 'POST', {
        action: pending.review.action, reason: pending.reason.trim(), targetField: pending.targetField.trim(),
      });
      setNotice(`${result.application.application_number}: ${REVIEW_LABEL[result.application.review_status] ?? result.application.review_status}.`);
      setPending(null);
      apps.reload();
      if (history?.row.id === pending.row.id) void openHistory(pending.row);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setActing(false);
    }
  };

  const openHistory = async (row: ApplicationRow) => {
    setHistory({ row, logs: null, error: null });
    try {
      const data = await apiRequest<{ logs: LogRow[] }>(`/api/center/applications/${encodeURIComponent(row.id)}/logs`);
      setHistory({ row, logs: data.logs, error: null });
    } catch (error) {
      setHistory({ row, logs: null, error: errorText(error) });
    }
  };

  const formValid = form.candidateName.trim().length >= 2;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-applications-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="workspace-applications-heading" className="text-lg font-extrabold text-[#0B2E59]">Applications received</h2>
          <p className="mt-1 text-sm text-slate-600">Record applications your institute received and review them. Verified applications can receive draft admit cards. Fees are shown as unpaid or waived; payment confirmation is not available yet.</p>
        </div>
        <button type="button" onClick={() => { setShowForm(!showForm); setFormError(null); }} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-600">{showForm ? 'Close form' : 'Record an application'}</button>
      </div>

      {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      {showForm && (
        <form onSubmit={(event) => void add(event)} className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Examination
            <select className={inputClass} value={form.examId} onChange={field('examId')} disabled={exams.state.status !== 'success'}>
              <option value="">{exams.state.status === 'loading' ? 'Loading examinations…' : exams.state.status === 'error' ? 'Examinations could not be loaded' : 'No examination'}</option>
              {exams.state.status === 'success' && exams.state.data.exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.exam_code}: {exam.title}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700">Candidate name<input className={inputClass} value={form.candidateName} onChange={field('candidateName')} required minLength={2} maxLength={120} /></label>
          <label className="text-xs font-semibold text-slate-700">Fee<select className={inputClass} value={form.paymentStatus} onChange={field('paymentStatus')}><option value="unpaid">Unpaid</option><option value="waived">Waived by institute</option></select></label>
          <label className="text-xs font-semibold text-slate-700">Email (optional)<input type="email" className={inputClass} value={form.candidateEmail} onChange={field('candidateEmail')} maxLength={254} /></label>
          <label className="text-xs font-semibold text-slate-700">Mobile (optional)<input className={inputClass} value={form.candidateMobile} onChange={field('candidateMobile')} maxLength={20} /></label>
          {formError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-2">{formError}</p>}
          <div className="sm:col-span-2"><button type="submit" disabled={saving || !formValid} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save application'}</button></div>
        </form>
      )}

      {pending && (
        <div role="dialog" aria-label="Confirm application review" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">{pending.review.label}: {pending.row.application_number} ({pending.row.candidate_name})</p>
          {pending.review.needsReason && <>
            <label className="mt-2 block text-xs font-semibold text-amber-900">Reason (at least 5 characters)<input className={inputClass} value={pending.reason} onChange={(event) => setPending({ ...pending, reason: event.target.value })} maxLength={500} /></label>
            <label className="mt-2 block text-xs font-semibold text-amber-900">Field concerned (optional)<input className={inputClass} value={pending.targetField} onChange={(event) => setPending({ ...pending, targetField: event.target.value })} maxLength={100} /></label>
          </>}
          {actionError && <p role="alert" className="mt-2 text-rose-800">{actionError}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={acting || (pending.review.needsReason && pending.reason.trim().length < 5)} onClick={() => void review()} className="rounded-lg bg-[#0B2E59] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">{acting ? 'Saving…' : 'Confirm'}</button>
            <button type="button" onClick={() => { setPending(null); setActionError(null); }} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700">Cancel</button>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-slate-700">Show
          <select className="ml-2 rounded-lg border border-slate-300 px-2 py-1 text-sm" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All</option>
            {Object.entries(REVIEW_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      {apps.state.status === 'loading' && <p role="status" className="mt-4 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading applications…</p>}
      {apps.state.status === 'error' && <div role="alert" className="mt-4 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Applications could not be loaded: {apps.state.message}<button type="button" onClick={apps.reload} className="ml-3 font-bold underline">Try again</button></div>}
      {apps.state.status === 'success' && (
        <>
          <dl className="mt-4 grid gap-3 sm:grid-cols-5">
            {[['Total', apps.state.data.summary.total], ['Awaiting review', apps.state.data.summary.awaiting_review], ['Verified', apps.state.data.summary.verified],
              ['Correction requested', apps.state.data.summary.correction_requested], ['Flagged', apps.state.data.summary.flagged]].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 p-3"><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1 text-xl font-black text-[#0B2E59]">{value}</dd></div>
            ))}
          </dl>
          {apps.state.data.applications.length === 0
            ? <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No applications {filter === 'all' ? 'recorded yet' : 'with this status'}.</p>
            : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Application</th><th className="p-3">Candidate</th><th className="p-3">Exam</th><th className="p-3">Fee</th><th className="p-3">Review</th><th className="p-3">Actions</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {apps.state.data.applications.map((row) => (
                      <tr key={row.id}>
                        <td className="p-3 font-mono text-xs text-slate-900">{row.application_number}</td>
                        <td className="p-3"><p className="font-semibold text-slate-800">{row.candidate_name}</p><p className="text-xs text-slate-500">{[row.candidate_email, row.candidate_mobile].filter(Boolean).join(' · ')}</p></td>
                        <td className="p-3 text-xs text-slate-600">{row.exam_code ?? '—'}</td>
                        <td className="p-3 text-xs capitalize text-slate-600">{row.payment_status}</td>
                        <td className="p-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{REVIEW_LABEL[row.review_status] ?? row.review_status}</span>{row.review_reason ? <p className="mt-1 text-xs text-slate-500">{row.review_reason}</p> : null}</td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1">
                            {REVIEW_ACTIONS.filter((item) => item.action !== row.review_status).map((item) => (
                              <button key={item.action} type="button" onClick={() => { setPending({ row, review: item, reason: '', targetField: '' }); setActionError(null); }} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50">{item.label}</button>
                            ))}
                            <button type="button" onClick={() => void openHistory(row)} className="rounded-md px-2 py-1 text-xs font-bold text-blue-800 hover:underline">History</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </>
      )}

      {history && (
        <div className="mt-5 rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-bold text-slate-800">Review history: {history.row.application_number}</h3><button type="button" onClick={() => setHistory(null)} className="text-xs font-bold text-slate-600 hover:underline">Close</button></div>
          {history.error ? <p role="alert" className="mt-2 text-sm text-rose-800">{history.error}</p>
            : history.logs === null ? <p role="status" className="mt-2 text-sm text-slate-600">Loading history…</p>
              : history.logs.length === 0 ? <p className="mt-2 text-sm text-slate-600">No reviews yet.</p>
                : <ul className="mt-2 space-y-1 text-sm">{history.logs.map((log) => <li key={log.id}><span className="font-semibold">{REVIEW_LABEL[log.action] ?? log.action}</span> · {new Date(log.created_at).toLocaleString('en-IN')}{log.target_field ? ` · ${log.target_field}` : ''}{log.reason ? `: ${log.reason}` : ''}</li>)}</ul>}
        </div>
      )}
    </section>
  );
};
