// Institute Workspace: attendance marked by the Institute for its own examinations
// (GET /api/center/attendance, POST /api/center/attendance/mark). Every mark is a new, permanent
// record (the latest one for a roll number is the current status); a reason is always required.
// Marks are manual only: no QR scanner or import exists, so none is offered.
import React, { useMemo, useState } from 'react';
import { ApiError } from '../../api';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface AttendanceRow {
  id: string; exam_id: string | null; roll_number: string; candidate_name: string; center_name: string; session_name: string;
  status: string; source: string; reason: string; created_at: string;
}
interface ExamOption { id: string; exam_code: string; title: string }

export const ATTENDANCE_LABEL: Readonly<Record<string, string>> = Object.freeze({ present: 'Present', absent: 'Absent', late: 'Late', exception: 'Exception' });

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');
const timeLabel = (value: string) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time)
    ? new Date(time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
};
const emptyForm = { examId: '', rollNumber: '', candidateName: '', centerName: 'Main Center', sessionName: 'Morning', status: 'present', reason: '' };

/** The latest mark for each roll number (records arrive newest first). */
export function latestByRoll(records: readonly AttendanceRow[]): AttendanceRow[] {
  const seen = new Set<string>();
  return records.filter((row) => {
    const key = `${row.exam_id ?? ''}:${row.roll_number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const AttendancePanel: React.FC = () => {
  const records = useWorkspaceResource<{ records: AttendanceRow[] }>('/api/center/attendance');
  const exams = useWorkspaceResource<{ exams: ExamOption[] }>('/api/center/exams');
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const field = (key: keyof typeof emptyForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  const examCode = useMemo(() => new Map(exams.state.status === 'success' ? exams.state.data.exams.map((exam) => [exam.id, exam.exam_code]) : []), [exams.state]);

  const mark = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await sendWorkspaceWrite<{ record: AttendanceRow }>('/api/center/attendance/mark', 'POST', {
        examId: form.examId || null, rollNumber: form.rollNumber.trim(), candidateName: form.candidateName.trim(),
        centerName: form.centerName.trim(), sessionName: form.sessionName.trim(), status: form.status, reason: form.reason.trim(),
      });
      setNotice(`${saved.record.roll_number} marked ${ATTENDANCE_LABEL[saved.record.status] ?? saved.record.status}.`);
      setForm({ ...emptyForm, examId: form.examId, centerName: form.centerName, sessionName: form.sessionName });
      records.reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const valid = form.rollNumber.trim().length >= 2 && form.candidateName.trim().length >= 2 && form.reason.trim().length >= 3;
  const rows = records.state.status === 'success' ? (showAll ? records.state.data.records : latestByRoll(records.state.data.records)) : [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-attendance-heading">
      <h2 id="workspace-attendance-heading" className="text-lg font-extrabold text-[#0B2E59]">Attendance for your examinations</h2>
      <p className="mt-1 text-sm text-slate-600">Mark attendance for your own examinations. Every mark is kept permanently with its reason; a new mark replaces the current status but not the history.</p>

      <form onSubmit={(event) => void mark(event)} className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
        <label className="text-xs font-semibold text-slate-700 sm:col-span-3">Examination
          <select className={inputClass} value={form.examId} onChange={field('examId')} disabled={exams.state.status !== 'success'}>
            <option value="">{exams.state.status === 'loading' ? 'Loading examinations…' : exams.state.status === 'error' ? 'Examinations could not be loaded' : 'No examination'}</option>
            {exams.state.status === 'success' && exams.state.data.exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.exam_code}: {exam.title}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-700">Roll number<input className={inputClass} value={form.rollNumber} onChange={field('rollNumber')} required minLength={2} maxLength={60} /></label>
        <label className="text-xs font-semibold text-slate-700">Candidate name<input className={inputClass} value={form.candidateName} onChange={field('candidateName')} required minLength={2} maxLength={120} /></label>
        <label className="text-xs font-semibold text-slate-700">Status<select className={inputClass} value={form.status} onChange={field('status')}>{Object.entries(ATTENDANCE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-700">Centre<input className={inputClass} value={form.centerName} onChange={field('centerName')} maxLength={150} /></label>
        <label className="text-xs font-semibold text-slate-700">Session<input className={inputClass} value={form.sessionName} onChange={field('sessionName')} maxLength={60} /></label>
        <label className="text-xs font-semibold text-slate-700">Reason (at least 3 characters)<input className={inputClass} value={form.reason} onChange={field('reason')} required minLength={3} maxLength={500} /></label>
        <div className="sm:col-span-3"><button type="submit" disabled={saving || !valid} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save attendance mark'}</button></div>
      </form>

      {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

      {records.state.status === 'loading' && <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading attendance marks…</p>}
      {records.state.status === 'error' && <div role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Attendance marks could not be loaded: {records.state.message}<button type="button" onClick={records.reload} className="ml-3 font-bold underline">Try again</button></div>}
      {records.state.status === 'success' && (
        <>
          <label className="mt-5 flex items-center gap-2 text-xs font-semibold text-slate-700"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show every mark (history), not only the current status</label>
          {rows.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No attendance marked yet.</p> : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Roll number</th><th className="p-3">Candidate</th><th className="p-3">Exam</th><th className="p-3">Centre · session</th><th className="p-3">Status</th><th className="p-3">Reason</th><th className="p-3">Marked at</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="p-3 font-mono text-slate-900">{row.roll_number}</td>
                      <td className="p-3 text-slate-800">{row.candidate_name}</td>
                      <td className="p-3 text-xs text-slate-600">{row.exam_id ? (examCode.get(row.exam_id) ?? '—') : '—'}</td>
                      <td className="p-3 text-xs text-slate-600">{row.center_name} · {row.session_name}</td>
                      <td className="p-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{ATTENDANCE_LABEL[row.status] ?? row.status}</span></td>
                      <td className="p-3 text-xs text-slate-600">{row.reason}</td>
                      <td className="p-3 text-xs text-slate-600">{timeLabel(row.created_at)}</td>
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
