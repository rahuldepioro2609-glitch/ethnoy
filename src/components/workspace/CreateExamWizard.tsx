// Institute Workspace: the "Create Examination" wizard. The Institute prepares an examination / admission /
// recruitment notice and configures the application form applicants will fill in later. Everything is saved
// through the real API: POST /api/center/exams (first save) and PATCH /api/center/exams/:id (later saves, only
// while the exam is a draft or returned for changes). Submitting sends it to ELTNOY review (D-02); the
// Institute never publishes. No applicant data is entered or stored here.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Save, Send, X } from 'lucide-react';
import { ApiError, apiRequest } from '../../api';
import { EXAM_TYPE_INFO, examConfigPreset, type ExamConfig, type ExamType } from '../../utils/examConfig';
import {
  WIZARD_STEPS, applyExamType, canSaveDraft, clearLocalDraft, draftFromExam, loadLocalDraft, newDraft, requestBody, saveLocalDraft,
  stepIssues, type ExamForEdit, type WizardDraft, type WizardStepKey,
} from '../../utils/examWizard';
import { examStatusLabel, isInstituteEditableExam } from '../../utils/workspaceExams';
import { InfoNote, IssueList, Stepper } from './examWizard/parts';
import { StepDetails } from './examWizard/StepDetails';
import { StepEligibility } from './examWizard/StepEligibility';
import { StepForm } from './examWizard/StepForm';
import { StepPreview } from './examWizard/StepPreview';
import { StepSetup } from './examWizard/StepSetup';
import { sendWorkspaceWrite } from './useWorkspaceResource';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

const errorText = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.');

export const CreateExamWizard: React.FC<{ examId: string | null; onClose: () => void; onSaved: (message: string, closed: boolean) => void }> = ({ examId, onClose, onSaved }) => {
  const [draft, setDraft] = useState<WizardDraft>(() => newDraft());
  const [load, setLoad] = useState<LoadState>(examId ? { status: 'loading' } : { status: 'ready' });
  const [step, setStep] = useState<WizardStepKey>('details');
  const [visited, setVisited] = useState<Set<WizardStepKey>>(new Set(['details']));
  const [saving, setSaving] = useState<null | 'draft' | 'next' | 'submit'>(null);
  const [error, setError] = useState<{ message: string; changed: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string[]>([]);
  const [pendingType, setPendingType] = useState<ExamType | null>(null);
  const [restorable, setRestorable] = useState<{ savedAt: number; draft: WizardDraft } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const topRef = useRef<HTMLDivElement>(null);

  // Load the saved examination (editing), and offer any unsaved work kept in this browser tab.
  useEffect(() => {
    let cancelled = false;
    if (!examId) {
      const local = loadLocalDraft(null);
      if (local) setRestorable(local);
      return () => { cancelled = true; };
    }
    setLoad({ status: 'loading' });
    apiRequest<{ exam: ExamForEdit }>(`/api/center/exams/${encodeURIComponent(examId)}`)
      .then(({ exam }) => {
        if (cancelled) return;
        if (!isInstituteEditableExam(exam.lifecycle_status)) {
          setLoad({ status: 'error', message: `${exam.exam_code} is ${examStatusLabel(exam.lifecycle_status).toLowerCase()}. Only a draft, or an examination ELTNOY returned for changes, can be edited.` });
          return;
        }
        setDraft(draftFromExam(exam));
        setDirty(false);
        const local = loadLocalDraft(exam.id);
        if (local && local.draft.expectedUpdatedAt === exam.updated_at) setRestorable(local);
        setLoad({ status: 'ready' });
      })
      .catch((loadError: unknown) => { if (!cancelled) setLoad({ status: 'error', message: errorText(loadError) }); });
    return () => { cancelled = true; };
  }, [examId, attempt]);

  // Keep unsaved changes in this tab (sessionStorage) so a refresh does not lose them.
  useEffect(() => {
    if (!dirty || load.status !== 'ready') return undefined;
    const timer = window.setTimeout(() => saveLocalDraft(draft), 600);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, load.status]);

  const change = (next: WizardDraft) => { setDraft(next); setDirty(true); setNotice(null); };
  const update = (patch: Partial<WizardDraft>) => change({ ...draft, ...patch });
  const setConfig = (config: ExamConfig) => change({ ...draft, config });
  const updateBasics = (patch: Partial<ExamConfig['basics']>) => setConfig({ ...draft.config, basics: { ...draft.config.basics, ...patch } });

  const goTo = (next: WizardStepKey) => {
    setStep(next);
    setVisited((current) => new Set(current).add(next));
    setBlocking([]);
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const stepIndex = WIZARD_STEPS.findIndex((item) => item.key === step);
  const done = useMemo(() => new Set(WIZARD_STEPS.filter((item) => visited.has(item.key) && item.key !== 'preview' && stepIssues(draft, item.key).length === 0).map((item) => item.key)), [draft, visited]);

  const chooseType = (type: ExamType) => {
    if (type === draft.config.basics.examType) return;
    const untouched = JSON.stringify(draft.config.form) === JSON.stringify(examConfigPreset(draft.config.basics.examType).form);
    if (untouched) change(applyExamType(draft, type));
    else setPendingType(type);
  };

  /** Saves to the server. Returns true on success. */
  const save = async (mode: 'draft' | 'next' | 'submit'): Promise<boolean> => {
    setError(null);
    setNotice(null);
    const issues = mode === 'submit' ? stepIssues(draft, 'preview') : canSaveDraft(draft) ? [] : stepIssues(draft, 'details');
    if (issues.length > 0) {
      setBlocking(issues);
      if (mode !== 'submit') goTo('details');
      setBlocking(issues);
      return false;
    }
    setSaving(mode);
    try {
      const submit = mode === 'submit';
      const body = requestBody(draft, submit);
      const result = draft.examId
        ? await sendWorkspaceWrite<{ exam: ExamForEdit; unchanged?: boolean }>(`/api/center/exams/${encodeURIComponent(draft.examId)}`, 'PATCH', body)
        : await sendWorkspaceWrite<{ exam: ExamForEdit }>('/api/center/exams', 'POST', body);
      const saved = result.exam;
      clearLocalDraft(draft.examId);
      clearLocalDraft(saved.id);
      const next: WizardDraft = { ...draft, examId: saved.id, examCode: saved.exam_code, status: saved.lifecycle_status, expectedUpdatedAt: typeof saved.updated_at === 'string' ? saved.updated_at : draft.expectedUpdatedAt };
      setDraft(next);
      setDirty(false);
      if (submit) {
        onSaved(`${saved.exam_code} was submitted for ELTNOY review.`, true);
        return true;
      }
      setNotice(`Draft saved${'unchanged' in result && result.unchanged ? ' (no changes)' : ''}: ${saved.exam_code}, ${examStatusLabel(saved.lifecycle_status)}.`);
      onSaved(`${saved.exam_code} saved as ${examStatusLabel(saved.lifecycle_status).toLowerCase()}.`, false);
      return true;
    } catch (saveError) {
      setError({ message: errorText(saveError), changed: saveError instanceof ApiError && (saveError.code === 'EXAM_CHANGED' || saveError.code === 'EXAM_NOT_EDITABLE') });
      return false;
    } finally {
      setSaving(null);
    }
  };

  const saveAndNext = async () => {
    const issues = stepIssues(draft, step);
    if (issues.length > 0) { setBlocking(issues); return; }
    if (await save('next')) goTo(WIZARD_STEPS[Math.min(stepIndex + 1, WIZARD_STEPS.length - 1)].key);
  };

  if (load.status === 'loading') return <p role="status" className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">Loading the examination…</p>;
  if (load.status === 'error') {
    return (
      <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-900">
        <p>{load.message}</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-bold">Try again</button>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-bold underline">Back to examinations</button>
        </div>
      </div>
    );
  }

  const busy = saving !== null;
  return (
    <div ref={topRef} className="space-y-4 scroll-mt-4" aria-labelledby="create-exam-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500">Examinations › {draft.examId ? 'Edit examination' : 'Create examination'}</p>
          <h2 id="create-exam-heading" className="text-2xl font-black text-[#0B2E59]">{draft.examId ? 'Edit Examination' : 'Create Examination'}</h2>
          <p className="text-sm text-slate-600">Configure a new examination / admission / recruitment and design the application form.</p>
        </div>
        <div className="flex items-center gap-2">
          {draft.status && <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{examStatusLabel(draft.status)}</span>}
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-700 hover:bg-slate-50">
            <X className="h-4 w-4" aria-hidden="true" />Close
          </button>
        </div>
      </div>

      {draft.status === 'needs_changes' && draft.statusReason && <InfoNote tone="warning"><span className="font-bold">ELTNOY asked for changes:</span> {draft.statusReason}</InfoNote>}
      {draft.legacy && <InfoNote tone="warning">This examination was created before the form designer. A suggested form for its category has been filled in; review every step before saving.</InfoNote>}
      {restorable && (
        <InfoNote>
          Unsaved changes from {new Date(restorable.savedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })} were kept in this browser tab.
          <button type="button" className="ml-2 font-bold underline" onClick={() => { setDraft({ ...restorable.draft, examId: draft.examId, expectedUpdatedAt: draft.expectedUpdatedAt, status: draft.status }); setDirty(true); setRestorable(null); }}>Restore them</button>
          <button type="button" className="ml-2 underline" onClick={() => { clearLocalDraft(draft.examId); setRestorable(null); }}>Discard</button>
        </InfoNote>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        <Stepper current={step} done={done} onSelect={goTo} />
      </div>

      {pendingType && (
        <div role="alertdialog" aria-label="Change examination type" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-bold">Switch to {EXAM_TYPE_INFO[pendingType].label}?</p>
          <p className="mt-1">The suggested form, eligibility, qualifications and documents for that type will replace your current settings in steps 2–4. Your title, code, dates, fees and description are kept.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => { change(applyExamType(draft, pendingType)); setPendingType(null); }} className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-bold text-white">Switch and replace</button>
            <button type="button" onClick={() => setPendingType(null)} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold">Keep current settings</button>
          </div>
        </div>
      )}

      {step === 'details' && <StepDetails draft={draft} update={update} updateBasics={updateBasics} onChooseType={chooseType} />}
      {step === 'form' && <StepForm config={draft.config} title={draft.title} onChange={setConfig} />}
      {step === 'eligibility' && <StepEligibility config={draft.config} onChange={setConfig} />}
      {step === 'setup' && <StepSetup draft={draft} update={update} onChange={setConfig} />}
      {step === 'preview' && <StepPreview draft={draft} goTo={goTo} />}

      <IssueList issues={blocking} />
      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          {error.message}
          {error.changed && draft.examId && (
            <button type="button" className="ml-2 font-bold underline" onClick={() => { saveLocalDraft(draft); setError(null); setAttempt((value) => value + 1); }}>
              Reload the saved version (your changes stay available to restore)
            </button>
          )}
        </div>
      )}
      {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur sm:p-3">
        <button type="button" aria-label="Previous step" disabled={stepIndex === 0 || busy} onClick={() => goTo(WIZARD_STEPS[stepIndex - 1].key)} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 sm:px-4">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Previous</span>
        </button>
        <div className="flex min-w-0 items-center gap-2">
          {dirty && <span className="hidden text-xs text-slate-500 md:inline">Unsaved changes</span>}
          <button type="button" disabled={busy} onClick={() => void save('draft')} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-800 hover:bg-slate-50 disabled:opacity-50 sm:px-4">
            <Save className="h-4 w-4" aria-hidden="true" />{saving === 'draft' ? 'Saving…' : <><span className="sm:hidden">Save</span><span className="hidden sm:inline">Save as draft</span></>}
          </button>
          {step !== 'preview' ? (
            <button type="button" disabled={busy} onClick={() => void saveAndNext()} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50 sm:px-4">
              {saving === 'next' ? 'Saving…' : 'Save & next'}<ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void save('submit')} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50 sm:px-4">
              <Send className="h-4 w-4" aria-hidden="true" />{saving === 'submit' ? 'Submitting…' : <><span className="sm:hidden">Submit</span><span className="hidden sm:inline">Submit for ELTNOY review</span></>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
