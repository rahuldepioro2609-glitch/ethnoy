import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, X } from 'lucide-react';
import { apiRequest } from '../api';

interface OnlineExamQuestion {
  questionNumber: number;
  section: string;
  questionText: string;
  options: Record<'A' | 'B' | 'C' | 'D', string>;
  points: number;
}

interface ExamScore {
  totalQuestions: number;
  attempted: number;
  correct: number;
  incorrect: number;
  unattempted: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
}

interface OnlineExamRunnerProps {
  examCode: string;
  examName: string;
  onClose: () => void;
  onSubmitted: () => void;
}

function secondsUntil(value: string): number {
  return Math.max(0, Math.floor((new Date(value).getTime() - Date.now()) / 1000));
}

export const OnlineExamRunner: React.FC<OnlineExamRunnerProps> = ({ examCode, examName, onClose, onSubmitted }) => {
  const [attemptId, setAttemptId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [questions, setQuestions] = useState<OnlineExamQuestion[]>([]);
  const [responses, setResponses] = useState<Record<string, 'A' | 'B' | 'C' | 'D'>>({});
  const [score, setScore] = useState<ExamScore | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    apiRequest<{
      attempt: { id: string; expires_at: string };
      questions: OnlineExamQuestion[];
      responses: Record<string, 'A' | 'B' | 'C' | 'D'>;
    }>(`/api/online-exams/${encodeURIComponent(examCode)}/start`, { method: 'POST' })
      .then(({ attempt, questions: examQuestions, responses: savedResponses }) => {
        setAttemptId(attempt.id);
        setExpiresAt(attempt.expires_at);
        setSecondsLeft(secondsUntil(attempt.expires_at));
        setQuestions(examQuestions);
        setResponses(savedResponses);
      })
      .catch((startError: unknown) => setError(startError instanceof Error ? startError.message : 'Could not start this exam.'))
      .finally(() => setLoading(false));
  }, [examCode]);

  useEffect(() => {
    if (!attemptId || !Object.keys(responses).length || score || submitting) return;
    const timer = window.setTimeout(() => {
      const snapshot = responses;
      saveQueue.current = saveQueue.current
        .catch(() => undefined)
        .then(() => apiRequest(`/api/online-exams/${encodeURIComponent(examCode)}/attempt`, {
          method: 'PATCH',
          body: JSON.stringify({ attemptId, responses: snapshot }),
        }))
        .then(() => setSaveError(null))
        .catch((saveFailure: unknown) => setSaveError(saveFailure instanceof Error ? saveFailure.message : 'Could not save your exam answers.'));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [attemptId, examCode, responses, score, submitting]);

  const submitExam = async () => {
    if (submitting || score || !attemptId) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiRequest<{ score: ExamScore }>(`/api/online-exams/${encodeURIComponent(examCode)}/submit`, {
        method: 'POST',
        body: JSON.stringify({ attemptId, responses }),
      });
      setScore(result.score);
      onSubmitted();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit exam answers.');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!expiresAt || score || loading) return;
    const timer = window.setInterval(() => {
      const remaining = secondsUntil(expiresAt);
      setSecondsLeft(remaining);
      if (remaining === 0) void submitExam();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, score, loading, responses, attemptId, submitting]);

  const time = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-slate-950/70 p-3 sm:p-8">
      <main className="mx-auto my-4 max-w-4xl rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between gap-4 rounded-t-2xl bg-[#0B2E59] px-5 py-4 text-white">
          <div><p className="text-xs font-bold uppercase tracking-wider text-sky-200">{examCode}</p><h1 className="text-lg font-black sm:text-xl">{examName}</h1></div>
          <div className="flex items-center gap-3">
            {!score && attemptId && <span className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 font-mono font-bold"><Clock3 className="h-4 w-4" />{time}</span>}
            <button type="button" onClick={onClose} aria-label="Close exam" className="rounded-lg p-2 hover:bg-white/10"><X className="h-5 w-5" /></button>
          </div>
        </header>
        <div className="space-y-4 p-5 sm:p-7">
          {error && <div role="alert" className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><AlertCircle className="h-5 w-5 shrink-0" />{error}</div>}
          {saveError && <div role="status" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertCircle className="h-5 w-5 shrink-0" />{saveError} Your answers remain available on this screen; submit before leaving.</div>}
          {loading && <p className="py-12 text-center text-slate-500">Preparing your secure exam…</p>}
          {!loading && attemptId && !score && questions.map((question) => (
            <section key={question.questionNumber} className="rounded-xl border border-slate-200 p-4 sm:p-5">
              <div className="mb-3 flex justify-between gap-3 text-xs font-bold uppercase tracking-wide text-slate-500"><span>{question.section} · Question {question.questionNumber}</span><span>{question.points} mark(s)</span></div>
              <h2 className="font-semibold leading-6 text-slate-900">{question.questionText}</h2>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {(['A', 'B', 'C', 'D'] as const).map((option) => (
                  <label key={option} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${responses[String(question.questionNumber)] === option ? 'border-blue-700 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                    <input type="radio" name={`q-${question.questionNumber}`} checked={responses[String(question.questionNumber)] === option} onChange={() => setResponses((current) => ({ ...current, [String(question.questionNumber)]: option }))} />
                    <span><strong>{option}.</strong> {question.options[option]}</span>
                  </label>
                ))}
              </div>
            </section>
          ))}
          {score && (
            <section role="status" className="rounded-xl bg-emerald-50 p-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-700" />
              <h2 className="mt-3 text-xl font-black text-emerald-950">Exam submitted</h2>
              <p className="mt-2 text-slate-700">Score: <strong>{score.totalScore} / {score.maxScore}</strong> · {score.percentage}% · {score.correct} correct</p>
            </section>
          )}
          {!loading && attemptId && !score && (
            <div className="flex justify-end border-t border-slate-200 pt-4">
              <button type="button" onClick={() => void submitExam()} disabled={submitting || !attemptId} className="rounded-lg bg-blue-900 px-5 py-3 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-60">{submitting ? 'Submitting…' : 'Submit exam'}</button>
            </div>
          )}
          {score && <div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-lg bg-blue-900 px-5 py-2.5 text-sm font-bold text-white">Close</button></div>}
        </div>
      </main>
    </div>
  );
};
