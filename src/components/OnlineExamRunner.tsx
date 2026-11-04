import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Loader2, X } from 'lucide-react';
import { onlineExamTransport } from '../api';
import { type ExamSessionState, OnlineExamSession } from '../utils/onlineExamSession';
import { formatCountdown } from '../utils/onlineExamTimer';

// The exam logic (server-synchronized countdown, answer locking, autosave, single final
// submission with bounded retries, status check) lives in OnlineExamSession and is unit-tested
// there. This component only renders its state and forwards user actions.

interface OnlineExamRunnerProps {
  examCode: string;
  examName: string;
  onClose: () => void;
  onSubmitted: () => void;
}

function formatServerTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString();
}

function saveStatusText(state: ExamSessionState): string | null {
  if (state.locked || state.loadState !== 'ready') return null;
  switch (state.saveStatus) {
    case 'unsaved':
    case 'saving':
      return 'Saving…';
    case 'saved': {
      const at = formatServerTime(state.lastSavedAt);
      return at ? `All answers saved at ${at}.` : 'All answers saved.';
    }
    case 'save_failed':
      return state.saveMessage ?? 'Your latest answers are not saved yet.';
    default:
      return null;
  }
}

export const OnlineExamRunner: React.FC<OnlineExamRunnerProps> = ({ examCode, examName, onClose, onSubmitted }) => {
  const sessionRef = useRef<OnlineExamSession | null>(null);
  const [state, setState] = useState<ExamSessionState | null>(null);
  const notifiedSubmitted = useRef(false);

  useEffect(() => {
    const session = new OnlineExamSession({ examCode, transport: onlineExamTransport, onChange: setState });
    sessionRef.current = session;
    setState(session.getState());
    void session.load();
    // After the page was hidden (tab switch, sleep) or the network returned, re-read server time.
    const resync = () => {
      if (document.visibilityState === 'visible') void session.resync();
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('online', resync);
    window.addEventListener('pageshow', resync);
    return () => {
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('online', resync);
      window.removeEventListener('pageshow', resync);
      session.dispose();
      sessionRef.current = null;
    };
  }, [examCode]);

  useEffect(() => {
    if (state?.phase === 'submitted' && !notifiedSubmitted.current) {
      notifiedSubmitted.current = true;
      onSubmitted();
    }
  }, [state?.phase, onSubmitted]);

  // Warn before leaving while answers are unsaved or the final submission is still in flight.
  const leavingIsRisky = Boolean(state && state.loadState === 'ready' && state.phase !== 'submitted'
    && (state.saveStatus === 'unsaved' || state.saveStatus === 'saving' || state.saveStatus === 'save_failed'
      || state.phase === 'submitting' || state.phase === 'retrying'));
  useEffect(() => {
    if (!leavingIsRisky) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [leavingIsRisky]);

  const session = sessionRef.current;
  const ready = state?.loadState === 'ready';
  const submissionStarted = Boolean(state && (state.phase !== 'in_progress' || session?.getSubmittedAnswers()));
  const inFlight = state?.phase === 'submitting' || state?.phase === 'retrying';
  const showQuestions = Boolean(ready && state && !state.score && state.phase !== 'awaiting_recovery' && state.phase !== 'expired_unscored');
  const canCheckStatus = Boolean(state && ['submit_unconfirmed', 'submit_rejected', 'awaiting_recovery'].includes(state.phase));

  const close = () => {
    if (inFlight && !window.confirm('Your submission is still being sent. Close anyway? If it does not arrive, your last saved answers may be scored automatically.')) return;
    onClose();
  };

  const timerClass = state?.warning === 'critical' || state?.warning === 'expired'
    ? 'bg-rose-600 text-white'
    : state?.warning === 'low' ? 'bg-amber-400 text-slate-950' : 'bg-white/10';
  const saveText = state ? saveStatusText(state) : null;

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-slate-950/70 p-3 sm:p-8">
      <main className="mx-auto my-4 max-w-4xl rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between gap-4 rounded-t-2xl bg-[#0B2E59] px-5 py-4 text-white">
          <div><p className="text-xs font-bold uppercase tracking-wider text-sky-200">{examCode}</p><h1 className="text-lg font-black sm:text-xl">{examName}</h1></div>
          <div className="flex items-center gap-3">
            {ready && state && !state.score && (
              <span role="timer" aria-live="off" className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 font-mono font-bold ${timerClass}`}>
                <Clock3 className="h-4 w-4" />{state.timeExpired ? '00:00' : formatCountdown(state.remainingSeconds)}
              </span>
            )}
            <button type="button" onClick={close} aria-label="Close exam" className="rounded-lg p-2 hover:bg-white/10"><X className="h-5 w-5" /></button>
          </div>
        </header>
        <div className="space-y-4 p-5 sm:p-7">
          {state?.loadState === 'loading' && <p className="py-12 text-center text-slate-500">Preparing your secure exam…</p>}
          {state?.loadState === 'failed' && <div role="alert" className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><AlertCircle className="h-5 w-5 shrink-0" />{state.loadError}</div>}

          {ready && state && !state.timeExpired && state.warning === 'low' && !submissionStarted && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">Less than 5 minutes remaining.</div>}
          {ready && state && !state.timeExpired && state.warning === 'critical' && !submissionStarted && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-800">Less than 1 minute remaining. Your answers will be submitted automatically when time runs out.</div>}
          {ready && state && !state.clockSynchronized && !state.timeExpired && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The timer could not be synchronized with the server. Answers are saved as you go; submit before your exam time ends.</div>}

          {state?.message && (
            <div role={state.phase === 'submitted' ? 'status' : 'alert'} className={`flex gap-2 rounded-lg border p-3 text-sm ${state.phase === 'submitted' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : inFlight ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              {inFlight ? <Loader2 className="h-5 w-5 shrink-0 animate-spin" /> : <AlertCircle className="h-5 w-5 shrink-0" />}{state.message}
            </div>
          )}
          {saveText && <p role="status" className={`text-sm ${state?.saveStatus === 'save_failed' ? 'font-semibold text-amber-800' : 'text-slate-500'}`}>{saveText}</p>}

          {showQuestions && state && state.questions.map((question) => (
            <section key={question.questionNumber} className="rounded-xl border border-slate-200 p-4 sm:p-5">
              <div className="mb-3 flex justify-between gap-3 text-xs font-bold uppercase tracking-wide text-slate-500"><span>{question.section} · Question {question.questionNumber}</span><span>{question.points} mark(s)</span></div>
              <h2 className="font-semibold leading-6 text-slate-900">{question.questionText}</h2>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {(['A', 'B', 'C', 'D'] as const).map((option) => {
                  const selected = state.answers[String(question.questionNumber)] === option;
                  return (
                    <label key={option} className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${state.locked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'} ${selected ? 'border-blue-700 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <input type="radio" name={`q-${question.questionNumber}`} checked={selected} disabled={state.locked} onChange={() => session?.selectAnswer(question.questionNumber, option)} />
                      <span><strong>{option}.</strong> {question.options[option]}</span>
                    </label>
                  );
                })}
              </div>
            </section>
          ))}

          {state?.score && (
            <section role="status" className="rounded-xl bg-emerald-50 p-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-700" />
              <h2 className="mt-3 text-xl font-black text-emerald-950">{state.alreadyScored ? 'Exam already submitted' : 'Exam submitted'}</h2>
              <p className="mt-2 text-slate-700">Score: <strong>{String(state.score.totalScore)} / {String(state.score.maxScore)}</strong> · {String(state.score.percentage)}% · {String(state.score.correct)} correct</p>
            </section>
          )}

          {ready && state && !state.score && (
            <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-4">
              {canCheckStatus && <button type="button" onClick={() => void session?.checkStatus()} disabled={state.checkingStatus} className="rounded-lg border border-blue-900 px-5 py-3 text-sm font-bold text-blue-900 hover:bg-blue-50 disabled:opacity-60">{state.checkingStatus ? 'Checking…' : 'Check status'}</button>}
              {state.phase === 'submit_unconfirmed' && <button type="button" onClick={() => session?.retrySubmission()} className="rounded-lg bg-blue-900 px-5 py-3 text-sm font-bold text-white hover:bg-blue-800">Retry submission</button>}
              {!submissionStarted && <button type="button" onClick={() => session?.submit()} className="rounded-lg bg-blue-900 px-5 py-3 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-60">Submit exam</button>}
              {inFlight && <button type="button" disabled className="rounded-lg bg-blue-900 px-5 py-3 text-sm font-bold text-white opacity-60">{state.phase === 'retrying' ? `Retrying (${state.submitAttempt}/${state.maxSubmitAttempts})…` : 'Submitting…'}</button>}
            </div>
          )}
          {(state?.score || state?.loadState === 'failed') && <div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-lg bg-blue-900 px-5 py-2.5 text-sm font-bold text-white">Close</button></div>}
        </div>
      </main>
    </div>
  );
};
