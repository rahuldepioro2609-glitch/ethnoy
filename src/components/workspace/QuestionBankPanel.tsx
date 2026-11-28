// Institute Workspace: the Institute's own question bank and paper blueprints
// (GET /api/center/questions, POST /api/center/questions, PATCH /api/center/questions/:id/moderate,
// POST /api/center/paper-blueprints, POST /api/center/paper-blueprints/:id/lock).
// - Questions start as drafts (or in review); only approved questions can enter a paper.
// - Moderation follows the server's state machine; archiving and locking cannot be undone, so both ask first.
// - Sending papers to ELTNOY for review (paper tender) waits for decision F-5 and is not offered.
// Questions and answer keys are confidential: they are only ever shown to the signed-in Institute.
import React, { useMemo, useState } from 'react';
import { ApiError } from '../../api';
import {
  DIFFICULTY_LABEL, MODERATION_LABEL, QUESTION_TYPE_LABEL, isChoiceQuestion, questionActions, questionShapeError,
  type ModerationStatus, type QuestionAction, type QuestionType,
} from '../../utils/workspaceQuestions';
import { sendWorkspaceWrite, useWorkspaceResource } from './useWorkspaceResource';

interface QuestionRow {
  id: string; subject: string; topic: string; difficulty: string; question_type: string; question_text: string;
  options_json: Record<string, string> | null; correct_answer: string; explanation: string; marks: string | number;
  negative_marks: string | number; tags: string; moderation_status: string; created_at: string;
}
interface BlueprintRow {
  id: string; exam_id: string | null; title: string; total_marks: string | number; duration_minutes: number;
  question_ids_json: string[] | null; is_locked: boolean; locked_at: string | null; created_at: string;
}
interface ExamOption { id: string; exam_code: string; title: string }

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');
const marksLabel = (value: string | number) => {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : '—';
};
const marksText = (value: string | number) => `${marksLabel(value)} ${Number(value) === 1 ? 'mark' : 'marks'}`;
const timeLabel = (value: string | null) => {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
};

const emptyQuestion = {
  subject: '', topic: '', difficulty: 'medium', questionType: 'mcq' as QuestionType, questionText: '',
  options: ['', '', '', ''], answerKeys: [] as string[], answerText: '', explanation: '', marks: '1', negativeMarks: '0', tags: '',
};
type QuestionForm = typeof emptyQuestion;

/** The request body the form sends; the same shape rule as the server is applied before sending. */
export function questionPayload(form: QuestionForm, submitForReview: boolean) {
  const choice = isChoiceQuestion(form.questionType);
  const options = choice ? Object.fromEntries(form.options.map((text, index) => [OPTION_KEYS[index], text.trim()])) : {};
  const correctAnswer = choice ? form.answerKeys.filter((key) => key in options).sort().join(',') : form.answerText.trim();
  return {
    subject: form.subject.trim(), topic: form.topic.trim(), difficulty: form.difficulty, questionType: form.questionType,
    questionText: form.questionText.trim(), options, correctAnswer, explanation: form.explanation.trim(),
    marks: Number(form.marks), negativeMarks: Number(form.negativeMarks), tags: form.tags.trim(), submitForReview,
  };
}

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const tone = status === 'approved' ? 'bg-emerald-50 text-emerald-800' : status === 'rejected' ? 'bg-rose-50 text-rose-800' : status === 'in_review' ? 'bg-amber-50 text-amber-900' : 'bg-slate-100 text-slate-700';
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${tone}`}>{MODERATION_LABEL[status as ModerationStatus] ?? status}</span>;
};

export const QuestionBankPanel: React.FC = () => {
  const bank = useWorkspaceResource<{ questions: QuestionRow[]; blueprints: BlueprintRow[] }>('/api/center/questions');
  const exams = useWorkspaceResource<{ exams: ExamOption[] }>('/api/center/exams');
  const [form, setForm] = useState<QuestionForm>(emptyQuestion);
  const [saving, setSaving] = useState<'draft' | 'review' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: QuestionAction } | null>(null);
  const [filter, setFilter] = useState<'all' | ModerationStatus>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [paper, setPaper] = useState({ title: '', durationMinutes: '60', examId: '', questionIds: [] as string[] });
  const [paperSaving, setPaperSaving] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [lockConfirm, setLockConfirm] = useState<string | null>(null);

  const questions = bank.state.status === 'success' ? bank.state.data.questions : [];
  const blueprints = bank.state.status === 'success' ? bank.state.data.blueprints : [];
  const approved = useMemo(() => questions.filter((q) => q.moderation_status === 'approved'), [questions]);
  const counts = useMemo(() => questions.reduce<Record<string, number>>((acc, q) => ({ ...acc, [q.moderation_status]: (acc[q.moderation_status] ?? 0) + 1 }), {}), [questions]);
  const shown = filter === 'all' ? questions : questions.filter((q) => q.moderation_status === filter);
  const examLabel = useMemo(() => new Map(exams.state.status === 'success' ? exams.state.data.exams.map((exam) => [exam.id, `${exam.exam_code}: ${exam.title}`]) : []), [exams.state]);
  const marksById = useMemo(() => new Map(questions.map((q) => [q.id, Number(q.marks)])), [questions]);
  const paperMarks = paper.questionIds.reduce((sum, id) => sum + (marksById.get(id) ?? 0), 0);

  const set = <K extends keyof QuestionForm>(key: K, value: QuestionForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const choice = isChoiceQuestion(form.questionType);
  const payload = questionPayload(form, false);
  const shapeError = questionShapeError(payload.questionType, payload.options, payload.correctAnswer)
    ?? (choice && form.options.some((text) => !text.trim()) ? 'Fill in every option or remove the empty ones.' : null)
    ?? (!(payload.marks > 0) ? 'Marks must be more than 0.' : payload.negativeMarks > payload.marks || payload.negativeMarks < 0 ? 'Negative marks must be between 0 and the marks.' : null);
  const formReady = payload.subject.length >= 2 && payload.questionText.length >= 3 && !shapeError;

  const changeType = (questionType: QuestionType) => setForm((current) => ({
    ...current, questionType, answerKeys: [], answerText: questionType === 'true_false' ? 'true' : '',
    options: isChoiceQuestion(questionType) ? (current.options.length >= 2 ? current.options : ['', '', '', '']) : current.options,
  }));
  const toggleAnswer = (key: string) => setForm((current) => ({
    ...current,
    answerKeys: current.questionType === 'mcq' ? [key] : current.answerKeys.includes(key) ? current.answerKeys.filter((k) => k !== key) : [...current.answerKeys, key],
  }));
  const removeOption = (index: number) => setForm((current) => {
    // Keys are positional (A, B, C…): the removed option's answer goes, and later answers shift down a letter.
    const answerKeys = current.answerKeys
      .filter((key) => key !== OPTION_KEYS[index])
      .map((key) => (OPTION_KEYS.indexOf(key) > index ? OPTION_KEYS[OPTION_KEYS.indexOf(key) - 1] : key));
    return { ...current, options: current.options.filter((_, i) => i !== index), answerKeys };
  });

  const saveQuestion = async (submitForReview: boolean) => {
    setSaving(submitForReview ? 'review' : 'draft');
    setFormError(null);
    setNotice(null);
    try {
      const saved = await sendWorkspaceWrite<{ question: QuestionRow }>('/api/center/questions', 'POST', questionPayload(form, submitForReview));
      setNotice(`Question saved as ${MODERATION_LABEL[saved.question.moderation_status as ModerationStatus]?.toLowerCase() ?? saved.question.moderation_status}.`);
      setForm({ ...emptyQuestion, subject: form.subject, topic: form.topic, difficulty: form.difficulty, questionType: form.questionType, answerText: form.questionType === 'true_false' ? 'true' : '' });
      bank.reload();
    } catch (caught) {
      setFormError(errorText(caught));
    } finally {
      setSaving(null);
    }
  };

  const moderate = async (question: QuestionRow, action: QuestionAction) => {
    setBusyId(question.id);
    setActionError(null);
    setNotice(null);
    setConfirming(null);
    try {
      await sendWorkspaceWrite(`/api/center/questions/${encodeURIComponent(question.id)}/moderate`, 'PATCH', { status: action.to });
      setNotice(`Question moved to ${MODERATION_LABEL[action.to].toLowerCase()}.`);
      if (action.to !== 'approved') setPaper((current) => ({ ...current, questionIds: current.questionIds.filter((id) => id !== question.id) }));
      bank.reload();
    } catch (caught) {
      setActionError(errorText(caught));
      bank.reload();
    } finally {
      setBusyId(null);
    }
  };

  const createPaper = async (event: React.FormEvent) => {
    event.preventDefault();
    setPaperSaving(true);
    setPaperError(null);
    setNotice(null);
    try {
      const saved = await sendWorkspaceWrite<{ blueprint: BlueprintRow }>('/api/center/paper-blueprints', 'POST', {
        title: paper.title.trim(), durationMinutes: Number(paper.durationMinutes), examId: paper.examId || null, questionIds: paper.questionIds,
      });
      setNotice(`Paper "${saved.blueprint.title}" saved with ${marksText(saved.blueprint.total_marks)}. It is not locked yet.`);
      setPaper({ title: '', durationMinutes: paper.durationMinutes, examId: paper.examId, questionIds: [] });
      bank.reload();
    } catch (caught) {
      setPaperError(errorText(caught));
    } finally {
      setPaperSaving(false);
    }
  };

  const lockPaper = async (blueprint: BlueprintRow) => {
    setBusyId(blueprint.id);
    setActionError(null);
    setNotice(null);
    setLockConfirm(null);
    try {
      await sendWorkspaceWrite(`/api/center/paper-blueprints/${encodeURIComponent(blueprint.id)}/lock`, 'POST', {});
      setNotice(`Paper "${blueprint.title}" is locked. It can no longer be changed.`);
      bank.reload();
    } catch (caught) {
      setActionError(errorText(caught));
      bank.reload();
    } finally {
      setBusyId(null);
    }
  };

  const durationOk = Number.isInteger(Number(paper.durationMinutes)) && Number(paper.durationMinutes) >= 10 && Number(paper.durationMinutes) <= 600;
  const paperReady = paper.title.trim().length >= 3 && durationOk && paper.questionIds.length > 0 && paper.questionIds.length <= 200;

  return (
    <section className="space-y-5" aria-labelledby="workspace-questions-heading">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 id="workspace-questions-heading" className="text-lg font-extrabold text-[#0B2E59]">Question bank</h2>
        <p className="mt-1 text-sm text-slate-600">Write questions for your own examinations, review them, and build papers from approved questions. Questions and answer keys are visible only to your institute account.</p>
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">Sending papers to ELTNOY for review is not available yet.</p>

        <form onSubmit={(event) => { event.preventDefault(); void saveQuestion(false); }} className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4">
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Subject<input className={inputClass} value={form.subject} onChange={(e) => set('subject', e.target.value)} required minLength={2} maxLength={80} /></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Topic (optional)<input className={inputClass} value={form.topic} onChange={(e) => set('topic', e.target.value)} maxLength={120} /></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Question type
            <select className={inputClass} value={form.questionType} onChange={(e) => changeType(e.target.value as QuestionType)}>
              {Object.entries(QUESTION_TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Difficulty
            <select className={inputClass} value={form.difficulty} onChange={(e) => set('difficulty', e.target.value)}>
              {Object.entries(DIFFICULTY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-4">Question<textarea className={`${inputClass} min-h-[88px]`} value={form.questionText} onChange={(e) => set('questionText', e.target.value)} required minLength={3} maxLength={4000} /></label>

          {choice && (
            <fieldset className="sm:col-span-4">
              <legend className="text-xs font-semibold text-slate-700">Options: tick the correct {form.questionType === 'mcq' ? 'one' : 'ones'}</legend>
              <div className="mt-2 space-y-2">
                {form.options.map((text, index) => (
                  <div key={OPTION_KEYS[index]} className="flex items-center gap-2">
                    <input
                      type={form.questionType === 'mcq' ? 'radio' : 'checkbox'} name="correct-option" aria-label={`Option ${OPTION_KEYS[index]} is correct`}
                      checked={form.answerKeys.includes(OPTION_KEYS[index])} onChange={() => toggleAnswer(OPTION_KEYS[index])}
                    />
                    <span className="w-5 text-sm font-bold text-slate-700">{OPTION_KEYS[index]}</span>
                    <input className={inputClass} aria-label={`Option ${OPTION_KEYS[index]}`} value={text} maxLength={1000} onChange={(e) => set('options', form.options.map((value, i) => (i === index ? e.target.value : value)))} />
                    <button type="button" onClick={() => removeOption(index)} disabled={form.options.length <= 2} className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-40" aria-label={`Remove option ${OPTION_KEYS[index]}`}>Remove</button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => set('options', [...form.options, ''])} disabled={form.options.length >= OPTION_KEYS.length} className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-40">Add option</button>
            </fieldset>
          )}
          {form.questionType === 'true_false' && (
            <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Correct answer
              <select className={inputClass} value={form.answerText} onChange={(e) => set('answerText', e.target.value)}><option value="true">True</option><option value="false">False</option></select>
            </label>
          )}
          {form.questionType === 'descriptive' && (
            <label className="text-xs font-semibold text-slate-700 sm:col-span-4">Model answer (optional)<textarea className={inputClass} value={form.answerText} onChange={(e) => set('answerText', e.target.value)} maxLength={500} /></label>
          )}

          <label className="text-xs font-semibold text-slate-700 sm:col-span-4">Explanation (optional)<textarea className={inputClass} value={form.explanation} onChange={(e) => set('explanation', e.target.value)} maxLength={2000} /></label>
          <label className="text-xs font-semibold text-slate-700">Marks<input type="number" min={0.25} max={100} step={0.25} className={inputClass} value={form.marks} onChange={(e) => set('marks', e.target.value)} /></label>
          <label className="text-xs font-semibold text-slate-700">Negative marks<input type="number" min={0} max={100} step={0.25} className={inputClass} value={form.negativeMarks} onChange={(e) => set('negativeMarks', e.target.value)} /></label>
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Tags (optional)<input className={inputClass} value={form.tags} onChange={(e) => set('tags', e.target.value)} maxLength={200} /></label>

          {shapeError && payload.questionText.length >= 3 && <p className="text-xs text-amber-800 sm:col-span-4">{shapeError}</p>}
          <div className="flex flex-wrap gap-2 sm:col-span-4">
            <button type="submit" disabled={saving !== null || !formReady} className="rounded-lg border border-[#0B2E59] bg-white px-4 py-2 text-sm font-bold text-[#0B2E59] disabled:opacity-50">{saving === 'draft' ? 'Saving…' : 'Save as draft'}</button>
            <button type="button" onClick={() => void saveQuestion(true)} disabled={saving !== null || !formReady} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving === 'review' ? 'Saving…' : 'Save and send for review'}</button>
          </div>
          {formError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-4">{formError}</p>}
        </form>

        {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
        {actionError && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{actionError}</p>}

        {bank.state.status === 'loading' && <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading questions…</p>}
        {bank.state.status === 'error' && <div role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Questions could not be loaded: {bank.state.message}<button type="button" onClick={bank.reload} className="ml-3 font-bold underline">Try again</button></div>}
        {bank.state.status === 'success' && (
          <>
            <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter questions by status">
              {(['all', 'draft', 'in_review', 'approved', 'rejected', 'archived'] as const).map((value) => (
                <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={`rounded-full px-3 py-1.5 text-xs font-bold ${filter === value ? 'bg-[#0B2E59] text-white' : 'bg-slate-100 text-slate-700'}`}>
                  {value === 'all' ? 'All' : MODERATION_LABEL[value]} ({value === 'all' ? questions.length : counts[value] ?? 0})
                </button>
              ))}
            </div>
            {shown.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">{questions.length === 0 ? 'No questions yet.' : 'No questions with this status.'}</p> : (
              <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {shown.map((question) => (
                  <li key={question.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-slate-500">{question.subject}{question.topic ? ` · ${question.topic}` : ''} · {QUESTION_TYPE_LABEL[question.question_type as QuestionType] ?? question.question_type} · {DIFFICULTY_LABEL[question.difficulty] ?? question.difficulty} · {marksText(question.marks)}{Number(question.negative_marks) > 0 ? ` (−${marksLabel(question.negative_marks)})` : ''}</p>
                        <p className="mt-1 line-clamp-2 break-words text-sm font-semibold text-slate-900">{question.question_text}</p>
                      </div>
                      <StatusBadge status={question.moderation_status} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => setOpenId(openId === question.id ? null : question.id)} aria-expanded={openId === question.id} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700">{openId === question.id ? 'Hide answer key' : 'Show answer key'}</button>
                      {questionActions(question.moderation_status).map((action) => (
                        <button
                          key={action.to} type="button" disabled={busyId !== null}
                          onClick={() => (action.confirm ? setConfirming({ id: question.id, action }) : void moderate(question, action))}
                          className={`rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50 ${action.to === 'approved' ? 'bg-emerald-700 text-white' : action.to === 'rejected' || action.to === 'archived' ? 'border border-rose-300 text-rose-800' : 'bg-[#0B2E59] text-white'}`}
                        >{busyId === question.id ? 'Saving…' : action.label}</button>
                      ))}
                    </div>
                    {confirming?.id === question.id && (
                      <div role="alertdialog" aria-label="Confirm archive" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                        Archive this question? An archived question cannot be restored or used in new papers.
                        <div className="mt-2 flex gap-2">
                          <button type="button" onClick={() => void moderate(question, confirming.action)} className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-bold text-white">Archive</button>
                          <button type="button" onClick={() => setConfirming(null)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">Keep it</button>
                        </div>
                      </div>
                    )}
                    {openId === question.id && (
                      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
                        <p className="whitespace-pre-wrap break-words">{question.question_text}</p>
                        {question.options_json && Object.keys(question.options_json).length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {Object.entries(question.options_json).map(([key, text]) => {
                              const correct = question.correct_answer.split(',').map((k) => k.trim()).includes(key);
                              return <li key={key} className={correct ? 'font-bold text-emerald-800' : ''}>{key}. {text}{correct ? ' (correct)' : ''}</li>;
                            })}
                          </ul>
                        )}
                        {question.question_type === 'true_false' && <p className="mt-2 font-bold text-emerald-800">Answer: {question.correct_answer === 'true' ? 'True' : 'False'}</p>}
                        {question.question_type === 'descriptive' && <p className="mt-2 text-slate-700">Model answer: {question.correct_answer || 'none given'}</p>}
                        {question.explanation && <p className="mt-2 text-slate-600">Explanation: {question.explanation}</p>}
                        {question.tags && <p className="mt-2 text-xs text-slate-500">Tags: {question.tags}</p>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h3 className="text-base font-extrabold text-[#0B2E59]">Papers</h3>
        <p className="mt-1 text-sm text-slate-600">Build a paper from approved questions. Total marks are calculated by the server. Locking a paper is permanent.</p>

        <form onSubmit={(event) => void createPaper(event)} className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4">
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">Paper title<input className={inputClass} value={paper.title} onChange={(e) => setPaper({ ...paper, title: e.target.value })} required minLength={3} maxLength={160} /></label>
          <label className="text-xs font-semibold text-slate-700">Duration (minutes)<input type="number" min={10} max={600} step={1} className={inputClass} value={paper.durationMinutes} onChange={(e) => setPaper({ ...paper, durationMinutes: e.target.value })} /></label>
          <label className="text-xs font-semibold text-slate-700">Examination (optional)
            <select className={inputClass} value={paper.examId} onChange={(e) => setPaper({ ...paper, examId: e.target.value })} disabled={exams.state.status !== 'success'}>
              <option value="">{exams.state.status === 'loading' ? 'Loading…' : exams.state.status === 'error' ? 'Could not be loaded' : 'No examination'}</option>
              {exams.state.status === 'success' && exams.state.data.exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.exam_code}: {exam.title}</option>)}
            </select>
          </label>
          <fieldset className="sm:col-span-4">
            <legend className="text-xs font-semibold text-slate-700">Approved questions ({paper.questionIds.length} chosen, {marksText(paperMarks)})</legend>
            {bank.state.status !== 'success' ? <p className="mt-2 text-xs text-slate-500">Questions are not loaded.</p> : approved.length === 0 ? <p className="mt-2 text-xs text-slate-500">No approved questions yet. Approve questions above to use them in a paper.</p> : (
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2">
                {approved.map((question) => (
                  <li key={question.id}>
                    <label className="flex items-start gap-2 text-sm text-slate-800">
                      <input type="checkbox" className="mt-1" checked={paper.questionIds.includes(question.id)} onChange={(e) => setPaper({ ...paper, questionIds: e.target.checked ? [...paper.questionIds, question.id] : paper.questionIds.filter((id) => id !== question.id) })} />
                      <span className="min-w-0 break-words"><span className="text-xs text-slate-500">{question.subject} · {marksText(question.marks)} · </span>{question.question_text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <div className="sm:col-span-4"><button type="submit" disabled={paperSaving || !paperReady} className="rounded-lg bg-[#0B2E59] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{paperSaving ? 'Saving…' : 'Save paper'}</button></div>
          {paperError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 sm:col-span-4">{paperError}</p>}
        </form>

        {bank.state.status === 'success' && (blueprints.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No papers yet.</p> : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Paper</th><th className="p-3">Examination</th><th className="p-3">Questions</th><th className="p-3">Marks</th><th className="p-3">Duration</th><th className="p-3">Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {blueprints.map((blueprint) => (
                  <tr key={blueprint.id} className="align-top">
                    <td className="p-3 font-semibold text-slate-900">{blueprint.title}</td>
                    <td className="p-3 text-xs text-slate-600">{blueprint.exam_id ? (examLabel.get(blueprint.exam_id) ?? '—') : '—'}</td>
                    <td className="p-3 text-slate-700">{Array.isArray(blueprint.question_ids_json) ? blueprint.question_ids_json.length : '—'}</td>
                    <td className="p-3 text-slate-700">{marksLabel(blueprint.total_marks)}</td>
                    <td className="p-3 text-slate-700">{blueprint.duration_minutes} min</td>
                    <td className="p-3">
                      {blueprint.is_locked ? <span className="text-xs font-bold text-slate-700">Locked {timeLabel(blueprint.locked_at)}</span> : lockConfirm === blueprint.id ? (
                        <div role="alertdialog" aria-label="Confirm lock" className="text-xs text-slate-800">
                          Lock this paper? It cannot be unlocked.
                          <div className="mt-2 flex gap-2">
                            <button type="button" onClick={() => void lockPaper(blueprint)} className="rounded-lg bg-[#0B2E59] px-3 py-1.5 font-bold text-white">Lock</button>
                            <button type="button" onClick={() => setLockConfirm(null)} className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-slate-700">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" disabled={busyId !== null} onClick={() => setLockConfirm(blueprint.id)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50">{busyId === blueprint.id ? 'Locking…' : 'Lock paper'}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
};
