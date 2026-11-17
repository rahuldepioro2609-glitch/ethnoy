import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileText, Gavel, Loader2, X } from 'lucide-react';
import { apiRequest } from '../api';
import type { AnswerOption, CandidateObjection } from '../utils/answerKeyLogic';
import { proposedKeyLabel } from '../utils/answerKeyLogic';

interface AdminObjection extends CandidateObjection {
  candidateLoginId: string;
  candidateName: string;
}

interface AdminQuestion {
  question_number: number;
  subject: string;
  question_text: string;
  options: Record<AnswerOption, string>;
  official_key: AnswerOption;
  original_key: AnswerOption | null;
  is_dropped: boolean;
}

interface PanelData {
  objectionWindow: { isOpen: boolean; closesAt: string | null };
  questions: AdminQuestion[];
  objections: AdminObjection[];
}

type Decision = 'no_change' | 'key_changed' | 'question_dropped';

interface AdminObjectionsPanelProps {
  examCode: string;
  onClose: () => void;
  onChanged: (message: string) => void;
}

/** Converts an ISO timestamp to the value format of <input type="datetime-local"> in local time. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export const AdminObjectionsPanel: React.FC<AdminObjectionsPanelProps> = ({ examCode, onClose, onChanged }) => {
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closesAt, setClosesAt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [decisions, setDecisions] = useState<Record<number, { decision: Decision; newKey: AnswerOption | ''; remarks: string }>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await apiRequest<PanelData>(`/api/admin/objections?examCode=${encodeURIComponent(examCode)}`);
      setData(result);
      setClosesAt(toLocalInputValue(result.objectionWindow.closesAt));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load objections.');
    }
  }, [examCode]);

  useEffect(() => { void load(); }, [load]);

  const byQuestion = useMemo(() => {
    const map = new Map<number, AdminObjection[]>();
    for (const objection of data?.objections ?? []) {
      map.set(objection.questionNumber, [...(map.get(objection.questionNumber) ?? []), objection]);
    }
    return map;
  }, [data]);

  const setWindow = async (isOpen: boolean) => {
    setBusy('window');
    setError(null);
    try {
      await apiRequest(`/api/admin/objection-windows/${encodeURIComponent(examCode)}`, {
        method: 'PUT',
        body: JSON.stringify({ isOpen, closesAt: isOpen && closesAt ? new Date(closesAt).toISOString() : null }),
      });
      onChanged(isOpen ? `Objection window for ${examCode} is open.` : `Objection window for ${examCode} is closed.`);
      await load();
    } catch (windowError) {
      setError(windowError instanceof Error ? windowError.message : 'Could not update the objection window.');
    } finally {
      setBusy(null);
    }
  };

  const decide = async (question: AdminQuestion, pendingCount: number) => {
    const draft = decisions[question.question_number] ?? { decision: 'no_change', newKey: '', remarks: '' };
    if (draft.decision === 'key_changed' && !draft.newKey) {
      setError('Choose the revised key.');
      return;
    }
    if (draft.remarks.trim().length < 5) {
      setError('Enter panel remarks (at least 5 characters). Candidates will see them.');
      return;
    }
    const summary = draft.decision === 'key_changed'
      ? `change the key for Q${question.question_number} from ${question.official_key} to ${draft.newKey}`
      : draft.decision === 'question_dropped'
        ? `drop Q${question.question_number} from evaluation`
        : `keep the key for Q${question.question_number}`;
    if (!window.confirm(`This will ${summary} and close ${pendingCount} pending objection(s). Continue?`)) return;
    setBusy(`q${question.question_number}`);
    setError(null);
    try {
      await apiRequest(`/api/admin/answer-keys/${encodeURIComponent(examCode)}/questions/${question.question_number}/decision`, {
        method: 'POST',
        body: JSON.stringify({
          decision: draft.decision,
          remarks: draft.remarks.trim(),
          ...(draft.decision === 'key_changed' ? { newKey: draft.newKey } : {}),
        }),
      });
      onChanged(`Decision recorded for ${examCode} Q${question.question_number}.`);
      setDecisions((current) => {
        const next = { ...current };
        delete next[question.question_number];
        return next;
      });
      await load();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Could not record the decision.');
    } finally {
      setBusy(null);
    }
  };

  const questions = (data?.questions ?? []).filter((question) => showAll || byQuestion.has(question.question_number));
  const pendingTotal = (data?.objections ?? []).filter((objection) => objection.status === 'pending').length;

  return (
    <section className="rounded-xl border border-purple-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><Gavel className="h-5 w-5 text-purple-700" /> Objections · {examCode}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {data ? `${data.objections.length} filed · ${pendingTotal} awaiting a decision` : 'Loading…'}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close objection review" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      {data && (
        <>
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-bold text-slate-800">
              Objection window: {' '}
              <span className={data.objectionWindow.isOpen ? 'text-emerald-700' : 'text-slate-600'}>
                {data.objectionWindow.isOpen
                  ? data.objectionWindow.closesAt ? `open until ${new Date(data.objectionWindow.closesAt).toLocaleString()}` : 'open (no closing time)'
                  : 'closed'}
              </span>
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-xs font-semibold text-slate-700">Closes at (your local time, optional)
                <input type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
              </label>
              <button type="button" disabled={busy !== null} onClick={() => void setWindow(true)} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">
                {data.objectionWindow.isOpen ? 'Update closing time' : 'Open objections'}
              </button>
              {data.objectionWindow.isOpen && (
                <button type="button" disabled={busy !== null} onClick={() => void setWindow(false)} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 disabled:opacity-60">Close now</button>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">Candidates who applied for this exam can file one objection per question while the window is open. Objections are free; no fee is collected.</p>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <h3 className="font-bold text-slate-800">Questions</h3>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show questions without objections
            </label>
          </div>

          {!questions.length && <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-500">No objections have been filed for this exam.</p>}

          <div className="mt-3 space-y-4">
            {questions.map((question) => {
              const items = byQuestion.get(question.question_number) ?? [];
              const pending = items.filter((item) => item.status === 'pending');
              const tally = items.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.proposedKey]: (counts[item.proposedKey] ?? 0) + 1 }), {});
              const draft = decisions[question.question_number] ?? { decision: 'no_change' as Decision, newKey: '' as const, remarks: '' };
              const updateDraft = (patch: Partial<typeof draft>) => setDecisions((current) => ({ ...current, [question.question_number]: { ...draft, ...patch } }));
              return (
                <article key={question.question_number} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-[#0B2E59] px-2 py-0.5 text-xs font-bold text-white">Q{question.question_number}</span>
                    <span className="text-xs font-semibold text-slate-500">{question.subject}</span>
                    {question.is_dropped && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700">Dropped</span>}
                    {question.original_key && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800">Revised from {question.original_key}</span>}
                    {pending.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">{pending.length} pending</span>}
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{question.question_text}</p>
                  <div className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
                    {(['A', 'B', 'C', 'D'] as const).map((option) => (
                      <div key={option} className={`flex items-center justify-between rounded border px-2 py-1.5 ${question.official_key === option ? 'border-emerald-300 bg-emerald-50 font-bold' : 'border-slate-200'}`}>
                        <span>{option}. {question.options[option]}</span>
                        {tally[option] ? <span className="rounded bg-purple-100 px-1.5 text-[10px] font-bold text-purple-800">{tally[option]} claim{tally[option] > 1 ? 's' : ''}</span> : null}
                      </div>
                    ))}
                  </div>
                  {tally.NONE ? <p className="mt-1 text-xs font-semibold text-purple-800">{tally.NONE} candidate(s) say no option is correct.</p> : null}

                  {items.length > 0 && (
                    <details className="mt-3 rounded-lg bg-slate-50 p-3" open={pending.length > 0 && pending.length <= 3}>
                      <summary className="cursor-pointer text-xs font-bold text-slate-700">{items.length} objection(s)</summary>
                      <ul className="mt-2 space-y-2">
                        {items.map((item) => (
                          <li key={item.id} className="rounded border border-slate-200 bg-white p-3 text-xs">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-bold text-slate-800">{item.candidateName} <span className="font-mono font-normal text-slate-500">({item.candidateLoginId})</span></span>
                              <span className="font-mono text-slate-500">{item.referenceNumber} · <span className="capitalize">{item.status}</span></span>
                            </div>
                            <p className="mt-1 text-slate-600">Claims <strong>{proposedKeyLabel(item.proposedKey)}</strong> · {item.category}</p>
                            <p className="mt-1 whitespace-pre-line text-slate-800">{item.justification}</p>
                            <p className="mt-1 text-slate-500">Reference: {item.referenceSource}</p>
                            {item.documentFileId && (
                              <a href={`/api/files/${encodeURIComponent(item.documentFileId)}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-semibold text-blue-800 underline">
                                <FileText className="h-3.5 w-3.5" /> {item.documentName ?? 'Supporting document'}
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {pending.length > 0 && (
                    <div className="mt-3 grid gap-2 rounded-lg border border-purple-200 bg-purple-50/50 p-3 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
                      <label className="text-xs font-semibold text-slate-700">Panel decision
                        <select value={draft.decision} onChange={(event) => updateDraft({ decision: event.target.value as Decision })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm">
                          <option value="no_change">Keep key ({question.official_key})</option>
                          <option value="key_changed">Change key</option>
                          <option value="question_dropped">Drop question</option>
                        </select>
                      </label>
                      {draft.decision === 'key_changed' ? (
                        <label className="text-xs font-semibold text-slate-700">New key
                          <select value={draft.newKey} onChange={(event) => updateDraft({ newKey: event.target.value as AnswerOption })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm">
                            <option value="">Select</option>
                            {(['A', 'B', 'C', 'D'] as const).filter((option) => option !== question.official_key).map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </label>
                      ) : <span className="hidden sm:block" />}
                      <label className="text-xs font-semibold text-slate-700">Remarks shown to candidates
                        <input value={draft.remarks} onChange={(event) => updateDraft({ remarks: event.target.value })} maxLength={1000} placeholder="e.g. Subject experts verified option C using NCERT XI p.346." className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
                      </label>
                      <button type="button" disabled={busy !== null} onClick={() => void decide(question, pending.length)} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-purple-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">
                        {busy === `q${question.question_number}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Record decision
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Key changes update the published answer key immediately. Results are uploaded separately, so re-import any affected results after revising keys.</p>
        </>
      )}
    </section>
  );
};
