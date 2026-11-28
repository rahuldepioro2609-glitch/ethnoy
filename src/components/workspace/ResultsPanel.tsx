// Institute Workspace: results prepared by the Institute (GET/POST /api/center/results,
// PATCH /api/center/results/:id/status). D-02 / A-04: the Institute enters marks and marks them ready
// for review; ELTNOY approves and publishes. Approved or published results cannot be changed here.
import React, { useState } from 'react';
import { ApiError } from '../../api';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface ResultRow {
  id: string; exam_code: string; exam_title: string; roll_number: string; candidate_name: string;
  raw_score: string | number; max_score: string | number; percentage: string | number;
  qualifying_status: string; evaluation_status: string; version: number;
}
interface ExamOption { id: string; exam_code: string; title: string }

export const RESULT_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  pending: 'Pending', evaluated: 'Evaluated (draft)', moderated: 'Ready for ELTNOY review', approved: 'Approved by ELTNOY', published: 'Published by ELTNOY',
});
/** Rows an Institute may still change (D-02). */
export const instituteCanEditResult = (status: string) => status === 'pending' || status === 'evaluated' || status === 'moderated';

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');
const emptyForm = { examId: '', rollNumber: '', candidateName: '', rawScore: '', maxScore: '100', qualifyingStatus: 'pending' };

export const ResultsPanel: React.FC = () => {
  const results = useWorkspaceResource<{ results: ResultRow[] }>('/api/center/results');
  const exams = useWorkspaceResource<{ exams: ExamOption[] }>('/api/center/exams');
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const field = (key: keyof typeof emptyForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await sendWorkspaceWrite<{ result: ResultRow; corrected?: boolean }>('/api/center/results', 'POST', {
        examId: form.examId, rollNumber: form.rollNumber.trim(), candidateName: form.candidateName.trim(),
        rawScore: Number(form.rawScore), maxScore: Number(form.maxScore), qualifyingStatus: form.qualifyingStatus,
      });
      setNotice(saved.corrected
        ? `Corrected ${saved.result.roll_number} (${saved.result.candidate_name}); it is a draft again (version ${saved.result.version}) and needs to be marked ready for review again.`
        : `Saved ${saved.result.roll_number} as a draft (version ${saved.result.version}).`);
      setForm({ ...emptyForm, examId: form.examId, maxScore: form.maxScore });
      results.reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const markReady = async (row: ResultRow) => {
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      await sendWorkspaceWrite(`/api/center/results/${encodeURIComponent(row.id)}/status`, 'PATCH', { evaluationStatus: 'moderated' });
      setNotice(`${row.roll_number} is ready for ELTNOY review.`);
      results.reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyId(null);
    }
  };

  const valid = form.examId && form.rollNumber.trim().length >= 2 && form.candidateName.trim().length >= 2 && form.rawScore !== ''
    && Number(form.maxScore) > 0 && Number(form.rawScore) <= Number(form.maxScore);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-results-heading">
      <h2 id="workspace-results-heading" className="text-lg font-extrabold text-[#0B2E59]">Results</h2>
      <p className="mt-1 text-sm text-slate-600">Enter marks for your examinations and mark them ready for review. ELTNOY approves and publishes results; approved or published results can only be corrected by ELTNOY.</p>

      <form onSubmit={(event) => void save(event)} className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
        <label className="text-xs font-semibold text-slate-700 sm:col-span-3">Examination
          <select className={inputClass} value={form.examId} onChange={field('examId')} required disabled={exams.state.status !== 'success'}>
            <option value="">{exams.state.status === 'loading' ? 'Loading examinations…' : exams.state.status === 'error' ? 'Examinations could not be loaded' : 'Choose an examination'}</option>
            {exams.state.status === 'success' && exams.state.data.exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.exam_code}: {exam.title}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-700">Roll number<input className={inputClass} value={form.rollNumber} onChange={field('rollNumber')} required minLength={2} maxLength={60} /></label>
        <label className="text-xs font-semibold text-slate-700">Candidate name<input className={inputClass} value={form.candidateName} onChange={field('candidateName')} required minLength={2} maxLength={120} /></label>
        <label className="text-xs font-semibold text-slate-700">Result<select className={inputClass} value={form.qualifyingStatus} onChange={field('qualifyingStatus')}><option value="pending">Pending</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label>
        <label className="text-xs font-semibold text-slate-700">Marks obtained<input type="number" step="0.01" className={inputClass} value={form.rawScore} onChange={field('rawScore')} required /></label>
        <label className="text-xs font-semibold text-slate-700">Maximum marks<input type="number" step="0.01" min={0.01} className={inputClass} value={form.maxScore} onChange={field('maxScore')} required /></label>
        <div className="flex items-end"><button type="submit" disabled={saving || !valid} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save result (draft)'}</button></div>
      </form>

      {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

      {results.state.status === 'loading' && <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading results…</p>}
      {results.state.status === 'error' && <div role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Results could not be loaded: {results.state.message}<button type="button" onClick={results.reload} className="ml-3 font-bold underline">Try again</button></div>}
      {results.state.status === 'success' && (results.state.data.results.length === 0
        ? <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No results entered yet.</p>
        : (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Exam</th><th className="p-3">Roll number</th><th className="p-3">Candidate</th><th className="p-3">Marks</th><th className="p-3">Result</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {results.state.data.results.map((row) => (
                  <tr key={row.id}>
                    <td className="p-3 text-xs text-slate-600">{row.exam_code}</td>
                    <td className="p-3 font-mono text-slate-900">{row.roll_number}</td>
                    <td className="p-3 text-slate-800">{row.candidate_name}</td>
                    <td className="p-3 text-slate-700">{Number(row.raw_score)} / {Number(row.max_score)} ({Number(row.percentage)}%)</td>
                    <td className="p-3 capitalize text-slate-700">{row.qualifying_status}</td>
                    <td className="p-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{RESULT_STATUS_LABEL[row.evaluation_status] ?? row.evaluation_status}</span></td>
                    <td className="p-3">
                      {row.evaluation_status === 'evaluated' || row.evaluation_status === 'pending'
                        ? <button type="button" disabled={busyId === row.id} onClick={() => void markReady(row)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-bold text-slate-700 disabled:opacity-50">{busyId === row.id ? 'Working…' : 'Mark ready for review'}</button>
                        : <span className="text-xs text-slate-500">{instituteCanEditResult(row.evaluation_status) ? 'Awaiting ELTNOY' : 'Locked'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
};
