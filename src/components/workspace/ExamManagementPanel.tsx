// Institute Workspace: examinations prepared by the Institute (GET /api/center/exams, the Create Examination
// wizard for creating and editing drafts, POST /api/center/exams/:id/transition). D-02: the Institute drafts and submits; the ELTNOY Super
// Admin approves and publishes. Every value shown comes from the server; nothing is simulated.
import React, { useState } from 'react';
import { ApiError } from '../../api';
import { EXAM_MODE_INFO, EXAM_TYPE_INFO } from '../../utils/examConfig';
import {
  examStatusLabel, formatPaise, instituteExamActions, isInstituteEditableExam, type InstituteExamAction,
} from '../../utils/workspaceExams';
import { CreateExamWizard } from './CreateExamWizard';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface ExamRow {
  id: string; exam_code: string; title: string; category: string; mode: string; lifecycle_status: string;
  app_open_date: string; app_close_date: string; exam_date: string; fee_paise: number | string; application_count: number;
  status_reason?: string; exam_config_json?: unknown;
}
interface ExamsResponse {
  exams: ExamRow[];
  summary: { total: number; registration_open: number; scheduled_live: number; closed_archived: number };
}

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const dateOnly = (value: unknown) => (typeof value === 'string' ? value.slice(0, 10) : '—');
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');

/** The exact examination type and mode chosen in the wizard, when the examination has a configuration. */
function configLabels(config: unknown): { type: string; mode: string } | null {
  if (!config || typeof config !== 'object' || !('basics' in config)) return null;
  const basics = (config as { basics?: { examType?: string; mode?: string } }).basics;
  const type = basics?.examType && basics.examType in EXAM_TYPE_INFO ? EXAM_TYPE_INFO[basics.examType as keyof typeof EXAM_TYPE_INFO].label : null;
  const mode = basics?.mode && basics.mode in EXAM_MODE_INFO ? EXAM_MODE_INFO[basics.mode as keyof typeof EXAM_MODE_INFO].label : null;
  return type && mode ? { type, mode } : null;
}

export const ExamManagementPanel: React.FC = () => {
  const { state, reload } = useWorkspaceResource<ExamsResponse>('/api/center/exams');
  // The Create Examination wizard: null = closed; 'new' = a new examination; otherwise the exam id being edited.
  const [wizard, setWizard] = useState<null | 'new' | string>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ exam: ExamRow; action: InstituteExamAction; reason: string } | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  if (wizard !== null) {
    return (
      <CreateExamWizard
        key={wizard}
        examId={wizard === 'new' ? null : wizard}
        onClose={() => { setWizard(null); reload(); }}
        onSaved={(message, closed) => { setNotice(message); if (closed) { setWizard(null); reload(); } }}
      />
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-exams-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="workspace-exams-heading" className="text-lg font-extrabold text-[#0B2E59]">Examinations</h2>
          <p className="mt-1 text-sm text-slate-600">Prepare an examination, admission or recruitment notice and configure its application form, then submit it for review. ELTNOY approves and publishes it; your institute cannot publish directly.</p>
        </div>
        <button type="button" onClick={() => { setNotice(null); setWizard('new'); }} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-600">
          Create examination
        </button>
      </div>

      {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

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
            <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No examinations yet. Use “Create examination” to prepare one.</p>
          ) : (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Exam</th><th className="p-3">Dates</th><th className="p-3">Fee</th><th className="p-3">Applications</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {state.data.exams.map((exam) => (
                    <tr key={exam.id}>
                      <td className="p-3"><p className="font-bold text-slate-900">{exam.title}</p><p className="text-xs text-slate-500">{exam.exam_code} · {configLabels(exam.exam_config_json)?.type ?? exam.category} · {configLabels(exam.exam_config_json)?.mode ?? exam.mode}</p></td>
                      <td className="p-3 text-xs text-slate-600">Applications {dateOnly(exam.app_open_date)} to {dateOnly(exam.app_close_date)}<br />Exam {dateOnly(exam.exam_date)}</td>
                      <td className="p-3 text-slate-700">{formatPaise(exam.fee_paise)}</td>
                      <td className="p-3 text-slate-700">{exam.application_count}</td>
                      <td className="p-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{examStatusLabel(exam.lifecycle_status)}</span>{exam.status_reason ? <p className="mt-1 text-xs text-slate-500">{exam.status_reason}</p> : null}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {isInstituteEditableExam(exam.lifecycle_status) && (
                            <button type="button" onClick={() => { setNotice(null); setWizard(exam.id); }} className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-bold text-white hover:bg-emerald-600">Edit</button>
                          )}
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
