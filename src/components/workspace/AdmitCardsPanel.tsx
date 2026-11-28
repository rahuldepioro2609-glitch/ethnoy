// Institute Workspace: admit cards (GET /api/center/admit-cards, POST /api/center/admit-cards/generate).
// D-02 / A-06: the Institute generates DRAFT cards for verified applications; releasing them to
// candidates is an ELTNOY Super Admin decision, so there is no release control here.
import React, { useState } from 'react';
import { ApiError } from '../../api';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface TicketRow {
  id: string; exam_code: string; roll_number: string; candidate_name: string; center_code: string; center_name: string;
  seat_number: string; exam_date: string; exam_time: string; release_status: string;
}
interface ExamOption { id: string; exam_code: string; title: string }

export const TICKET_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  generated: 'Draft (awaiting ELTNOY release)', released: 'Released by ELTNOY', revoked: 'Revoked by ELTNOY',
});

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');

export const AdmitCardsPanel: React.FC = () => {
  const cards = useWorkspaceResource<{ tickets: TicketRow[]; eligibleCount: number }>('/api/center/admit-cards');
  const exams = useWorkspaceResource<{ exams: ExamOption[] }>('/api/center/exams');
  const [form, setForm] = useState({ examId: '', centerCode: '', centerName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendWorkspaceWrite<{ generated: number }>('/api/center/admit-cards/generate', 'POST', {
        examId: form.examId, centerCode: form.centerCode.trim(), centerName: form.centerName.trim(),
      });
      setNotice(result.generated === 0
        ? 'No new admit cards: every verified application for this examination already has one.'
        : `${result.generated} draft admit card${result.generated === 1 ? '' : 's'} generated. ELTNOY releases them to candidates.`);
      cards.reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const valid = form.examId && form.centerCode.trim().length >= 2 && form.centerName.trim().length >= 2;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-admit-heading">
      <h2 id="workspace-admit-heading" className="text-lg font-extrabold text-[#0B2E59]">Admit cards</h2>
      <p className="mt-1 text-sm text-slate-600">Generate draft admit cards for verified applications. ELTNOY reviews and releases them to candidates; your institute cannot release them directly.</p>

      <form onSubmit={(event) => void generate(event)} className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
        <label className="text-xs font-semibold text-slate-700">Examination
          <select className={inputClass} value={form.examId} onChange={(event) => setForm({ ...form, examId: event.target.value })} required disabled={exams.state.status !== 'success'}>
            <option value="">{exams.state.status === 'loading' ? 'Loading examinations…' : exams.state.status === 'error' ? 'Examinations could not be loaded' : 'Choose an examination'}</option>
            {exams.state.status === 'success' && exams.state.data.exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.exam_code}: {exam.title}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-700">Centre code<input className={inputClass} value={form.centerCode} onChange={(event) => setForm({ ...form, centerCode: event.target.value })} required minLength={2} maxLength={40} /></label>
        <label className="text-xs font-semibold text-slate-700">Centre name<input className={inputClass} value={form.centerName} onChange={(event) => setForm({ ...form, centerName: event.target.value })} required minLength={2} maxLength={150} /></label>
        <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy || !valid} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Generating…' : 'Generate draft admit cards'}</button>
          {cards.state.status === 'success' && <span className="text-xs text-slate-600">{cards.state.data.eligibleCount} verified application{cards.state.data.eligibleCount === 1 ? '' : 's'} in total</span>}
        </div>
      </form>

      {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

      {cards.state.status === 'loading' && <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading admit cards…</p>}
      {cards.state.status === 'error' && <div role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Admit cards could not be loaded: {cards.state.message}<button type="button" onClick={cards.reload} className="ml-3 font-bold underline">Try again</button></div>}
      {cards.state.status === 'success' && (cards.state.data.tickets.length === 0
        ? <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No admit cards generated yet.</p>
        : (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Exam</th><th className="p-3">Roll number</th><th className="p-3">Candidate</th><th className="p-3">Centre</th><th className="p-3">Seat</th><th className="p-3">Date and time</th><th className="p-3">Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {cards.state.data.tickets.map((row) => (
                  <tr key={row.id}>
                    <td className="p-3 text-xs text-slate-600">{row.exam_code}</td>
                    <td className="p-3 font-mono text-slate-900">{row.roll_number}</td>
                    <td className="p-3 text-slate-800">{row.candidate_name}</td>
                    <td className="p-3 text-slate-700">{row.center_code} · {row.center_name}</td>
                    <td className="p-3 text-slate-700">{row.seat_number}</td>
                    <td className="p-3 text-xs text-slate-600">{String(row.exam_date).slice(0, 10)} {row.exam_time}</td>
                    <td className="p-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{TICKET_STATUS_LABEL[row.release_status] ?? row.release_status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
};
