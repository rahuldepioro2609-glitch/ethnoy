// Institute Workspace: interview scheduling and panel scorecards (GET/POST /api/center/interviews,
// POST /api/center/interviews/:id/scorecards).
// - ELTNOY hosts no video call and records nothing: "video" only says how the Institute will hold it.
// - A panel cannot be double-booked; the server checks overlaps under a lock.
// - Scorecards are entered on or after the interview date, one per panelist.
// - A scheduled interview without a scorecard can be cancelled or rescheduled (POST .../:id/cancel and
//   .../:id/reschedule), always with a reason and a confirmation. The server keeps the earlier details in the
//   interview's history; a held (scored) or cancelled interview offers neither action.
import React, { useMemo, useState } from 'react';
import { ApiError } from '../../api';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface InterviewRow {
  id: string; candidate_name: string; application_number: string; panel_name: string; panelist_names: string;
  scheduled_date: string; start_time: string; end_time: string; mode: string; status: string;
}
interface InterviewSlot { scheduledDate: string; startTime: string; endTime: string; panelName: string; panelistNames: string }
interface ChangeRow { id: string; interview_id: string; action: 'cancelled' | 'rescheduled'; reason: string; previous_json: InterviewSlot; new_json: InterviewSlot | null; created_at: string }
interface ScorecardRow {
  id: string; interview_id: string; panelist_name: string; subject_score: string | number; communication_score: string | number;
  pedagogy_score: string | number; problem_solving_score: string | number; remarks: string; created_at: string;
}

export const INTERVIEW_MODE_LABEL: Readonly<Record<string, string>> = Object.freeze({ video: 'Video call (arranged by your institute)', in_person: 'In person' });
const STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({ scheduled: 'Scheduled', live: 'In progress', completed: 'Completed', cancelled: 'Cancelled' });
const SCORE_FIELDS = [
  ['subjectScore', 'subject_score', 'Subject knowledge'],
  ['communicationScore', 'communication_score', 'Communication'],
  ['pedagogyScore', 'pedagogy_score', 'Teaching approach'],
  ['problemSolvingScore', 'problem_solving_score', 'Problem solving'],
] as const;

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');
/** Today's date in India, YYYY-MM-DD (the server uses the same calendar). */
export const indiaToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const dateLabel = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : value;
};
const score = (value: string | number) => Math.round(Number(value) * 100) / 100;
export const scorecardAverage = (card: ScorecardRow) => Math.round((SCORE_FIELDS.reduce((sum, [, column]) => sum + Number(card[column]), 0) / SCORE_FIELDS.length) * 100) / 100;

const slotLabel = (slot: InterviewSlot) => `${dateLabel(slot.scheduledDate)}, ${slot.startTime}–${slot.endTime} IST, ${slot.panelName}${slot.panelistNames ? ` (${slot.panelistNames})` : ''}`;
const changedAt = (value: string) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
};

/** Cancel or reschedule one interview: a reason, then an explicit confirmation; shows the server's answer. */
const ChangeForm: React.FC<{ interview: InterviewRow; mode: 'cancel' | 'reschedule'; onDone: (message: string) => void; onClose: () => void }> = ({ interview, mode, onDone, onClose }) => {
  const today = indiaToday();
  const [slot, setSlot] = useState({ scheduledDate: interview.scheduled_date >= today ? interview.scheduled_date : '', startTime: interview.start_time, endTime: interview.end_time, panelName: interview.panel_name, panelistNames: interview.panelist_names });
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unchanged = slot.scheduledDate === interview.scheduled_date && slot.startTime === interview.start_time && slot.endTime === interview.end_time
    && slot.panelName.trim() === interview.panel_name && slot.panelistNames.trim() === interview.panelist_names;
  const slotProblem = mode !== 'reschedule' ? null
    : !slot.scheduledDate ? 'Choose the new date.'
      : slot.scheduledDate < today ? 'The new date cannot be in the past.'
        : !(slot.endTime > slot.startTime) ? 'The end time must be after the start time.'
          : slot.panelName.trim().length < 2 ? 'Enter the panel.'
            : unchanged ? 'Change the date, time or panel.' : null;
  const ready = reason.trim().length >= 5 && !slotProblem;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'cancel') {
        await sendWorkspaceWrite(`/api/center/interviews/${encodeURIComponent(interview.id)}/cancel`, 'POST', { reason: reason.trim() });
        onDone(`${interview.candidate_name}: interview cancelled. Its time slot is free again.`);
      } else {
        const saved = await sendWorkspaceWrite<{ interview: InterviewRow }>(`/api/center/interviews/${encodeURIComponent(interview.id)}/reschedule`, 'POST', {
          scheduledDate: slot.scheduledDate, startTime: slot.startTime, endTime: slot.endTime, panelName: slot.panelName.trim(), panelistNames: slot.panelistNames.trim(), reason: reason.trim(),
        });
        onDone(`${interview.candidate_name}: moved to ${dateLabel(saved.interview.scheduled_date)}, ${saved.interview.start_time}–${saved.interview.end_time} IST. The earlier time is kept in the history.`);
      }
    } catch (caught) {
      setError(errorText(caught));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-4" role="group" aria-label={`${mode === 'cancel' ? 'Cancel' : 'Reschedule'} the interview of ${interview.candidate_name}`}>
      {mode === 'reschedule' && (
        <>
          <label className="text-xs font-semibold text-slate-700">New date<input type="date" min={today} className={inputClass} value={slot.scheduledDate} onChange={(e) => { setSlot({ ...slot, scheduledDate: e.target.value }); setConfirming(false); }} required /></label>
          <label className="text-xs font-semibold text-slate-700">Start (IST)<input type="time" className={inputClass} value={slot.startTime} onChange={(e) => { setSlot({ ...slot, startTime: e.target.value }); setConfirming(false); }} required /></label>
          <label className="text-xs font-semibold text-slate-700">End (IST)<input type="time" className={inputClass} value={slot.endTime} onChange={(e) => { setSlot({ ...slot, endTime: e.target.value }); setConfirming(false); }} required /></label>
          <label className="text-xs font-semibold text-slate-700">Panel<input className={inputClass} value={slot.panelName} onChange={(e) => { setSlot({ ...slot, panelName: e.target.value }); setConfirming(false); }} required minLength={2} maxLength={80} /></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-4">Panelists (optional)<input className={inputClass} value={slot.panelistNames} onChange={(e) => { setSlot({ ...slot, panelistNames: e.target.value }); setConfirming(false); }} maxLength={300} /></label>
        </>
      )}
      <label className="text-xs font-semibold text-slate-700 sm:col-span-4">{mode === 'cancel' ? 'Reason for cancelling' : 'Reason for rescheduling'} (at least 5 characters)
        <textarea className={inputClass} value={reason} onChange={(e) => { setReason(e.target.value); setConfirming(false); }} required minLength={5} maxLength={500} />
      </label>
      {slotProblem && reason.trim().length > 0 && <p className="text-xs text-amber-800 sm:col-span-4">{slotProblem}</p>}
      {confirming ? (
        <div role="alertdialog" aria-label={mode === 'cancel' ? 'Confirm cancellation' : 'Confirm new time'} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 sm:col-span-4">
          {mode === 'cancel'
            ? <p>Cancel the interview of <strong>{interview.candidate_name}</strong> on {dateLabel(interview.scheduled_date)}, {interview.start_time}–{interview.end_time} IST? This cannot be undone; to meet the candidate later, schedule a new interview.</p>
            : <p>Move the interview of <strong>{interview.candidate_name}</strong> from {slotLabel({ scheduledDate: interview.scheduled_date, startTime: interview.start_time, endTime: interview.end_time, panelName: interview.panel_name, panelistNames: interview.panelist_names })} to <strong>{slotLabel({ ...slot, panelName: slot.panelName.trim(), panelistNames: slot.panelistNames.trim() })}</strong>?</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void submit()} disabled={saving} className={`rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 ${mode === 'cancel' ? 'bg-rose-700' : 'bg-[#0B2E59]'}`}>{saving ? 'Saving…' : mode === 'cancel' ? 'Yes, cancel the interview' : 'Yes, reschedule'}</button>
            <button type="button" onClick={() => setConfirming(false)} disabled={saving} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">Go back</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 sm:col-span-4">
          <button type="button" onClick={() => setConfirming(true)} disabled={!ready} className={`rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 ${mode === 'cancel' ? 'bg-rose-700' : 'bg-[#0B2E59]'}`}>{mode === 'cancel' ? 'Cancel interview…' : 'Review new time…'}</button>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">Close</button>
        </div>
      )}
      {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-4">{error}</p>}
    </div>
  );
};

const emptySchedule = { candidateName: '', applicationNumber: '', panelName: '', panelistNames: '', scheduledDate: '', startTime: '10:00', endTime: '10:30', mode: 'video' };
const emptyScorecard = { panelistName: '', subjectScore: '', communicationScore: '', pedagogyScore: '', problemSolvingScore: '', remarks: '' };

const ScorecardForm: React.FC<{ interview: InterviewRow; onSaved: (message: string) => void }> = ({ interview, onSaved }) => {
  const [form, setForm] = useState(emptyScorecard);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scoresOk = SCORE_FIELDS.every(([key]) => form[key] !== '' && Number(form[key]) >= 0 && Number(form[key]) <= 10);
  const ready = form.panelistName.trim().length >= 2 && scoresOk;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await sendWorkspaceWrite(`/api/center/interviews/${encodeURIComponent(interview.id)}/scorecards`, 'POST', {
        panelistName: form.panelistName.trim(), remarks: form.remarks.trim(),
        ...Object.fromEntries(SCORE_FIELDS.map(([key]) => [key, Number(form[key])])),
      });
      setForm(emptyScorecard);
      onSaved(`Scorecard from ${form.panelistName.trim()} saved for ${interview.candidate_name}.`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-4" aria-label={`Scorecard for ${interview.candidate_name}`}>
      <label className="text-xs font-semibold text-slate-700 sm:col-span-4">Panelist<input className={inputClass} value={form.panelistName} onChange={(e) => setForm({ ...form, panelistName: e.target.value })} required minLength={2} maxLength={120} /></label>
      {SCORE_FIELDS.map(([key, , label]) => (
        <label key={key} className="text-xs font-semibold text-slate-700">{label} (0–10)
          <input type="number" min={0} max={10} step={0.25} className={inputClass} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required />
        </label>
      ))}
      <label className="text-xs font-semibold text-slate-700 sm:col-span-4">Remarks (optional)<textarea className={inputClass} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} maxLength={1000} /></label>
      <div className="sm:col-span-4"><button type="submit" disabled={saving || !ready} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save scorecard'}</button></div>
      {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-4">{error}</p>}
    </form>
  );
};

export const InterviewsPanel: React.FC = () => {
  const data = useWorkspaceResource<{ interviews: InterviewRow[]; scorecards: ScorecardRow[]; changes?: ChangeRow[] }>('/api/center/interviews');
  const [form, setForm] = useState(emptySchedule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const [changing, setChanging] = useState<{ id: string; mode: 'cancel' | 'reschedule' } | null>(null);
  const today = indiaToday();

  const field = (key: keyof typeof emptySchedule) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  const interviews = data.state.status === 'success' ? data.state.data.interviews : [];
  const cardsByInterview = useMemo(() => {
    const map = new Map<string, ScorecardRow[]>();
    if (data.state.status === 'success') for (const card of data.state.data.scorecards) map.set(card.interview_id, [...(map.get(card.interview_id) ?? []), card]);
    return map;
  }, [data.state]);
  const changesByInterview = useMemo(() => {
    const map = new Map<string, ChangeRow[]>();
    if (data.state.status === 'success') for (const change of data.state.data.changes ?? []) map.set(change.interview_id, [...(map.get(change.interview_id) ?? []), change]);
    return map;
  }, [data.state]);
  const upcoming = interviews.filter((row) => row.scheduled_date >= today).sort((a, b) => `${a.scheduled_date} ${a.start_time}`.localeCompare(`${b.scheduled_date} ${b.start_time}`));
  const past = interviews.filter((row) => row.scheduled_date < today);

  const ready = form.candidateName.trim().length >= 2 && form.panelName.trim().length >= 2 && form.scheduledDate >= today && /^\d{2}:\d{2}$/.test(form.startTime) && /^\d{2}:\d{2}$/.test(form.endTime) && form.endTime > form.startTime;

  const schedule = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await sendWorkspaceWrite<{ interview: InterviewRow }>('/api/center/interviews', 'POST', {
        candidateName: form.candidateName.trim(), applicationNumber: form.applicationNumber.trim(), panelName: form.panelName.trim(),
        panelistNames: form.panelistNames.trim(), scheduledDate: form.scheduledDate, startTime: form.startTime, endTime: form.endTime, mode: form.mode,
      });
      setNotice(`${saved.interview.candidate_name}: interview scheduled on ${dateLabel(saved.interview.scheduled_date)}, ${saved.interview.start_time}–${saved.interview.end_time} with ${saved.interview.panel_name}.`);
      setForm({ ...emptySchedule, panelName: form.panelName, panelistNames: form.panelistNames, scheduledDate: form.scheduledDate, mode: form.mode });
      data.reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const renderInterview = (row: InterviewRow) => {
    const cards = cardsByInterview.get(row.id) ?? [];
    const changes = changesByInterview.get(row.id) ?? [];
    const canScore = row.status !== 'cancelled' && row.scheduled_date <= today;
    const canChange = row.status === 'scheduled' && cards.length === 0;
    return (
      <li key={row.id} className={`p-4 ${row.status === 'cancelled' ? 'bg-slate-50' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">{row.candidate_name}{row.application_number ? <span className="ml-2 font-mono text-xs text-slate-500">{row.application_number}</span> : null}</p>
            <p className="mt-1 text-xs text-slate-600">{dateLabel(row.scheduled_date)} · {row.start_time}–{row.end_time} IST · {row.panel_name}{row.panelist_names ? ` (${row.panelist_names})` : ''} · {INTERVIEW_MODE_LABEL[row.mode] ?? row.mode}</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${row.status === 'cancelled' ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-700'}`}>{row.status === 'scheduled' && cards.length > 0 ? 'Held (scorecard entered)' : STATUS_LABEL[row.status] ?? row.status}</span>
        </div>
        {changes.length > 0 && (
          <ul className="mt-2 space-y-1 border-l-2 border-slate-200 pl-3 text-xs text-slate-600" aria-label="Changes to this interview">
            {changes.map((change) => (
              <li key={change.id}>
                <span className="font-semibold text-slate-800">{change.action === 'cancelled' ? 'Cancelled' : 'Rescheduled'}</span> on {changedAt(change.created_at)}
                {change.action === 'rescheduled' && change.new_json ? <> from {slotLabel(change.previous_json)} to {slotLabel(change.new_json)}</> : <> (was {slotLabel(change.previous_json)})</>}
                : {change.reason}
              </li>
            ))}
          </ul>
        )}
        {cards.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-slate-500"><tr><th className="py-1 pr-3">Panelist</th>{SCORE_FIELDS.map(([, , label]) => <th key={label} className="py-1 pr-3">{label}</th>)}<th className="py-1 pr-3">Average</th><th className="py-1">Remarks</th></tr></thead>
              <tbody className="text-slate-700">
                {cards.map((card) => (
                  <tr key={card.id}><td className="py-1 pr-3 font-semibold">{card.panelist_name}</td>{SCORE_FIELDS.map(([, column]) => <td key={column} className="py-1 pr-3">{score(card[column])}</td>)}<td className="py-1 pr-3 font-bold">{scorecardAverage(card)}</td><td className="py-1">{card.remarks || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canScore ? (
          <button type="button" onClick={() => setScoringId(scoringId === row.id ? null : row.id)} aria-expanded={scoringId === row.id} className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700">{scoringId === row.id ? 'Close scorecard' : 'Add a panelist scorecard'}</button>
        ) : row.status !== 'cancelled' && <p className="mt-2 text-xs text-slate-500">Scorecards can be added on or after the interview date.</p>}
        {scoringId === row.id && canScore && <ScorecardForm interview={row} onSaved={(message) => { setNotice(message); setScoringId(null); data.reload(); }} />}
        {canChange && (
          <div className="mt-2 flex flex-wrap gap-2">
            {(['reschedule', 'cancel'] as const).map((mode) => (
              <button key={mode} type="button" onClick={() => setChanging(changing?.id === row.id && changing.mode === mode ? null : { id: row.id, mode })} aria-expanded={changing?.id === row.id && changing.mode === mode}
                className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${mode === 'cancel' ? 'border-rose-300 text-rose-800' : 'border-slate-300 text-slate-700'}`}>{mode === 'cancel' ? 'Cancel interview' : 'Reschedule'}</button>
            ))}
          </div>
        )}
        {changing?.id === row.id && canChange && (
          <ChangeForm key={changing.mode} interview={row} mode={changing.mode} onClose={() => setChanging(null)} onDone={(message) => { setNotice(message); setError(null); setChanging(null); data.reload(); }} />
        )}
      </li>
    );
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-interviews-heading">
      <h2 id="workspace-interviews-heading" className="text-lg font-extrabold text-[#0B2E59]">Interviews</h2>
      <p className="mt-1 text-sm text-slate-600">Schedule interviews with your panels and record each panelist's scorecard. A panel or panelist cannot be booked twice for overlapping times. Interviews not yet held can be rescheduled or cancelled with a reason; earlier times stay in the history.</p>
      <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">ELTNOY does not host video calls or record interviews; arrange the call yourself.</p>

      <form onSubmit={(event) => void schedule(event)} className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4">
        <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Candidate name<input className={inputClass} value={form.candidateName} onChange={field('candidateName')} required minLength={2} maxLength={120} /></label>
        <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Application number (optional)<input className={inputClass} value={form.applicationNumber} onChange={field('applicationNumber')} maxLength={60} /></label>
        <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Panel<input className={inputClass} value={form.panelName} onChange={field('panelName')} required minLength={2} maxLength={80} /></label>
        <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Panelists (optional)<input className={inputClass} value={form.panelistNames} onChange={field('panelistNames')} maxLength={300} /></label>
        <label className="text-xs font-semibold text-slate-700">Date<input type="date" min={today} className={inputClass} value={form.scheduledDate} onChange={field('scheduledDate')} required /></label>
        <label className="text-xs font-semibold text-slate-700">Start (IST)<input type="time" className={inputClass} value={form.startTime} onChange={field('startTime')} required /></label>
        <label className="text-xs font-semibold text-slate-700">End (IST)<input type="time" className={inputClass} value={form.endTime} onChange={field('endTime')} required /></label>
        <label className="text-xs font-semibold text-slate-700">How it is held
          <select className={inputClass} value={form.mode} onChange={field('mode')}>{Object.entries(INTERVIEW_MODE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </label>
        {form.endTime <= form.startTime && <p className="text-xs text-amber-800 sm:col-span-4">The end time must be after the start time.</p>}
        <div className="sm:col-span-4"><button type="submit" disabled={saving || !ready} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Scheduling…' : 'Schedule interview'}</button></div>
        {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-4">{error}</p>}
      </form>

      {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      {data.state.status === 'loading' && <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading interviews…</p>}
      {data.state.status === 'error' && <div role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Interviews could not be loaded: {data.state.message}<button type="button" onClick={data.reload} className="ml-3 font-bold underline">Try again</button></div>}
      {data.state.status === 'success' && (interviews.length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No interviews scheduled yet.</p> : (
        <div className="mt-5 space-y-5">
          <div>
            <h3 className="text-sm font-extrabold text-slate-900">Today and upcoming ({upcoming.length})</h3>
            {upcoming.length === 0 ? <p className="mt-2 text-sm text-slate-600">None.</p> : <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">{upcoming.map(renderInterview)}</ul>}
          </div>
          <div>
            <h3 className="text-sm font-extrabold text-slate-900">Past ({past.length})</h3>
            {past.length === 0 ? <p className="mt-2 text-sm text-slate-600">None.</p> : <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">{past.map(renderInterview)}</ul>}
          </div>
        </div>
      ))}
    </section>
  );
};
