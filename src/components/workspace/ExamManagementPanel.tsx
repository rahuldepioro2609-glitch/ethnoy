// Institute Workspace: examinations prepared by the Institute (GET/POST /api/center/exams,
// POST /api/center/exams/:id/transition). D-02: the Institute drafts and submits; the ELTNOY Super
// Admin approves and publishes. Every value shown comes from the server; nothing is simulated.
import React, { useState } from 'react';
import { ApiError } from '../../api';
import {
  EXAM_CATEGORIES, EXAM_MODES, examStatusLabel, formatPaise, instituteExamActions, type InstituteExamAction,
} from '../../utils/workspaceExams';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface ExamRow {
  id: string; exam_code: string; title: string; category: string; mode: string; lifecycle_status: string;
  app_open_date: string; app_close_date: string; exam_date: string; fee_paise: number | string; application_count: number;
  status_reason?: string;
}
interface ExamsResponse {
  exams: ExamRow[];
  summary: { total: number; registration_open: number; scheduled_live: number; closed_archived: number };
}

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const dateOnly = (value: unknown) => (typeof value === 'string' ? value.slice(0, 10) : '—');
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');

const emptyForm = {
  examCode: '', title: '', category: 'Scholarship', mode: 'Online CBT', eligibility: '',
  appOpenDate: '', appCloseDate: '', examDate: '', examTime: '10:00', durationMinutes: '60', feeRupees: '0', instructions: '',
};

export const ExamManagementPanel: React.FC = () => {
  const { state, reload } = useWorkspaceResource<ExamsResponse>('/api/center/exams');
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ exam: ExamRow; action: InstituteExamAction; reason: string } | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const field = (key: keyof typeof emptyForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [key]: event.target.value });

  const create = async (submitForApproval: boolean) => {
    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      const created = await sendWorkspaceWrite<{ exam: ExamRow }>('/api/center/exams', 'POST', {
        examCode: form.examCode.trim(), title: form.title.trim(), category: form.category, mode: form.mode, eligibility: form.eligibility.trim(),
        appOpenDate: form.appOpenDate, appCloseDate: form.appCloseDate, examDate: form.examDate, examTime: form.examTime,
        durationMinutes: Number(form.durationMinutes), feePaise: Math.round(Number(form.feeRupees || '0') * 100), instructions: form.instructions.trim(),
        submitForApproval,
      });
      setForm(emptyForm);
      setShowForm(false);
      setNotice(`${created.exam.exam_code} saved: ${examStatusLabel(created.exam.lifecycle_status)}.`);
      reload();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const runAction = async () => {
    if (!pending) return;
    setActing(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await sendWorkspaceWrite<{ exam: ExamRow }>(`/api/center/exams/${encodeURIComponent(pending.exam.id)}/transition`, 'POST', {
        status: pending.action.to, reason: pending.reason.trim(),
      });
      setNotice(`${result.exam.exam_code}: ${examStatusLabel(result.exam.lifecycle_status)}.`);
      setPending(null);
      reload();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setActing(false);
    }
  };

  const formValid = form.examCode.trim().length >= 2 && form.title.trim().length >= 3 && form.eligibility.trim().length >= 2
    && form.appOpenDate && form.appCloseDate && form.examDate && Number(form.durationMinutes) >= 10;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-exams-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="workspace-exams-heading" className="text-lg font-extrabold text-[#0B2E59]">Examinations</h2>
          <p className="mt-1 text-sm text-slate-600">Prepare an examination and submit it for review. ELTNOY approves and publishes it; your institute cannot publish directly.</p>
        </div>
        <button type="button" onClick={() => { setShowForm(!showForm); setFormError(null); }} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-600">
          {showForm ? 'Close form' : 'New examination'}
        </button>
      </div>

      {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      {showForm && (
        <form className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void create(false); }}>
          <label className="text-xs font-semibold text-slate-700">Exam code<input className={inputClass} value={form.examCode} onChange={field('examCode')} required minLength={2} maxLength={40} pattern="[A-Za-z0-9_-]+" /></label>
          <label className="text-xs font-semibold text-slate-700">Title<input className={inputClass} value={form.title} onChange={field('title')} required minLength={3} maxLength={160} /></label>
          <label className="text-xs font-semibold text-slate-700">Category<select className={inputClass} value={form.category} onChange={field('category')}>{EXAM_CATEGORIES.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-700">Mode<select className={inputClass} value={form.mode} onChange={field('mode')}>{EXAM_MODES.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Eligibility<input className={inputClass} value={form.eligibility} onChange={field('eligibility')} required minLength={2} maxLength={300} /></label>
          <label className="text-xs font-semibold text-slate-700">Applications open<input type="date" className={inputClass} value={form.appOpenDate} onChange={field('appOpenDate')} required /></label>
          <label className="text-xs font-semibold text-slate-700">Applications close<input type="date" className={inputClass} value={form.appCloseDate} onChange={field('appCloseDate')} required /></label>
          <label className="text-xs font-semibold text-slate-700">Exam date<input type="date" className={inputClass} value={form.examDate} onChange={field('examDate')} required /></label>
          <label className="text-xs font-semibold text-slate-700">Start time<input type="time" className={inputClass} value={form.examTime} onChange={field('examTime')} required /></label>
          <label className="text-xs font-semibold text-slate-700">Duration (minutes)<input type="number" min={10} max={600} className={inputClass} value={form.durationMinutes} onChange={field('durationMinutes')} required /></label>
          <label className="text-xs font-semibold text-slate-700">Fee (₹)<input type="number" min={0} step="0.01" className={inputClass} value={form.feeRupees} onChange={field('feeRupees')} /></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Instructions (optional)<textarea className={inputClass} rows={3} maxLength={4000} value={form.instructions} onChange={field('instructions')} /></label>
          {formError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-2">{formError}</p>}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" disabled={saving || !formValid} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800 disabled:opacity-50">{saving ? 'Saving…' : 'Save as draft'}</button>
            <button type="button" disabled={saving || !formValid} onClick={() => void create(true)} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save and submit for ELTNOY review'}</button>
          </div>
        </form>
      )}

      {pending && (
        <div role="dialog" aria-label="Confirm examination action" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">{pending.action.label}: {pending.exam.exam_code}</p>
          {pending.action.needsReason && (
            <label className="mt-2 block text-xs font-semibold text-amber-900">Reason (at least 5 characters)
              <input className={inputClass} value={pending.reason} onChange={(event) => setPending({ ...pending, reason: event.target.value })} maxLength={500} />
            </label>
          )}
          {actionError && <p role="alert" className="mt-2 text-rose-800">{actionError}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={acting || (pending.action.needsReason && pending.reason.trim().length < 5)} onClick={() => void runAction()} className="rounded-lg bg-[#0B2E59] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">{acting ? 'Working…' : 'Confirm'}</button>
            <button type="button" onClick={() => { setPending(null); setActionError(null); }} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700">Cancel</button>
          </div>
        </div>
      )}

      {state.status === 'loading' && <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading examinations…</p>}
      {state.status === 'error' && (
        <div role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">
          Examinations could not be loaded: {state.message}
          <button type="button" onClick={reload} className="ml-3 font-bold underline">Try again</button>
        </div>
      )}
      {state.status === 'success' && (
        <>
          <dl className="mt-5 grid gap-3 sm:grid-cols-4">
            {[
              ['Total', state.data.summary.total], ['Approved or published', state.data.summary.scheduled_live],
              ['Registration open', state.data.summary.registration_open], ['Closed or archived', state.data.summary.closed_archived],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 p-3"><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1 text-xl font-black text-[#0B2E59]">{value}</dd></div>
            ))}
          </dl>
          {state.data.exams.length === 0 ? (
            <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No examinations yet. Use “New examination” to prepare one.</p>
          ) : (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Exam</th><th className="p-3">Dates</th><th className="p-3">Fee</th><th className="p-3">Applications</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {state.data.exams.map((exam) => (
                    <tr key={exam.id}>
                      <td className="p-3"><p className="font-bold text-slate-900">{exam.title}</p><p className="text-xs text-slate-500">{exam.exam_code} · {exam.category} · {exam.mode}</p></td>
                      <td className="p-3 text-xs text-slate-600">Applications {dateOnly(exam.app_open_date)} to {dateOnly(exam.app_close_date)}<br />Exam {dateOnly(exam.exam_date)}</td>
                      <td className="p-3 text-slate-700">{formatPaise(exam.fee_paise)}</td>
                      <td className="p-3 text-slate-700">{exam.application_count}</td>
                      <td className="p-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{examStatusLabel(exam.lifecycle_status)}</span>{exam.status_reason ? <p className="mt-1 text-xs text-slate-500">{exam.status_reason}</p> : null}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {instituteExamActions(exam.lifecycle_status).map((action) => (
                            <button key={action.to} type="button" onClick={() => { setPending({ exam, action, reason: '' }); setActionError(null); }} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50">{action.label}</button>
                          ))}
                          {instituteExamActions(exam.lifecycle_status).length === 0 && <span className="text-xs text-slate-500">No institute action</span>}
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
    </section>
  );
};
