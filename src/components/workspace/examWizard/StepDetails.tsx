// Step 1: examination type and basic details.
import React from 'react';
import { Award, BookOpen, Briefcase, Building2, ClipboardList, GraduationCap, HeartPulse, Landmark, Stethoscope } from 'lucide-react';
import {
  EXAM_LEVELS, EXAM_LEVEL_LABEL, EXAM_MODES, EXAM_MODE_INFO, EXAM_TYPES, EXAM_TYPE_INFO, type ExamType,
} from '../../../utils/examConfig';
import type { WizardDraft } from '../../../utils/examWizard';
import { InfoNote, Panel, Select, TextBox, TextInput } from './parts';

const TYPE_ICON: Readonly<Record<ExamType, React.ReactNode>> = {
  general: <BookOpen className="h-6 w-6" />, institution_admission: <Building2 className="h-6 w-6" />, recruitment: <Briefcase className="h-6 w-6" />,
  hospital_recruitment: <HeartPulse className="h-6 w-6" />, entrance: <GraduationCap className="h-6 w-6" />, university: <Landmark className="h-6 w-6" />,
  scholarship: <Award className="h-6 w-6" />, certification: <Stethoscope className="h-6 w-6" />, other: <ClipboardList className="h-6 w-6" />,
};

export const StepDetails: React.FC<{
  draft: WizardDraft;
  update: (change: Partial<WizardDraft>) => void;
  updateBasics: (change: Partial<WizardDraft['config']['basics']>) => void;
  onChooseType: (type: ExamType) => void;
}> = ({ draft, update, updateBasics, onChooseType }) => {
  const { basics } = draft.config;
  const example = EXAM_TYPE_INFO[basics.examType].example;
  return (
    <div className="space-y-4">
      <Panel title="Examination type" description="Choosing a type pre-fills a suggested application form. You can change every field in the next steps.">
        <div role="radiogroup" aria-label="Examination type" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {EXAM_TYPES.map((type) => {
            const selected = basics.examType === type;
            return (
              <button
                key={type} type="button" role="radio" aria-checked={selected} onClick={() => onChooseType(type)}
                className={`relative flex flex-col items-center gap-1 rounded-xl border p-3 text-center transition ${selected ? 'border-emerald-600 bg-emerald-50 ring-2 ring-emerald-200' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}
              >
                <span className={selected ? 'text-emerald-700' : 'text-[#0B2E59]'} aria-hidden="true">{TYPE_ICON[type]}</span>
                <span className={`text-xs font-bold ${selected ? 'text-emerald-800' : 'text-slate-800'}`}>{EXAM_TYPE_INFO[type].label}</span>
                <span className="text-[10px] leading-tight text-slate-500">{EXAM_TYPE_INFO[type].description}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="Examination details" description="Fields marked * are needed to save a draft.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TextInput className="sm:col-span-2" label="Examination title" required value={draft.title} onChange={(title) => update({ title })} maxLength={160} placeholder={`e.g. ${example}`} />
          <TextInput
            label="Examination code" required value={draft.examCode} onChange={(examCode) => update({ examCode: examCode.toUpperCase() })} maxLength={40}
            placeholder="e.g. SNR-2027" disabled={Boolean(draft.examId)}
            hint={draft.examId ? 'The code cannot change after the first save.' : 'Letters, digits, hyphens. Fixed after the first save.'}
          />
          <TextInput label="Conducting institute / department" value={basics.conductingUnit} onChange={(conductingUnit) => updateBasics({ conductingUnit })} maxLength={160} placeholder="e.g. Institute of Medical Sciences" />
          <TextInput label="Academic year" required value={draft.academicYear} onChange={(academicYear) => update({ academicYear })} maxLength={20} placeholder="2026-27" />
          <Select label="Examination level" value={basics.examLevel} onChange={(examLevel) => updateBasics({ examLevel: examLevel as typeof basics.examLevel })} options={EXAM_LEVELS.map((level) => ({ value: level, label: EXAM_LEVEL_LABEL[level] }))} />
        </div>
        <fieldset className="mt-4">
          <legend className="mb-1 text-xs font-bold text-slate-700">Examination mode<span className="ml-0.5 text-rose-600" aria-hidden="true">*</span></legend>
          <div className="flex flex-wrap gap-2">
            {EXAM_MODES.map((mode) => (
              <label key={mode} className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${basics.mode === mode ? 'border-emerald-600 bg-emerald-50 font-semibold text-emerald-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
                <input type="radio" name="exam-mode" className="accent-emerald-700" checked={basics.mode === mode} onChange={() => updateBasics({ mode })} />
                {EXAM_MODE_INFO[mode].label}
              </label>
            ))}
          </div>
        </fieldset>
      </Panel>

      <Panel title="Key dates" description="Application dates can also be changed in step 4. Correction window and admit card dates are in step 4.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TextInput type="date" label="Application start date" required value={draft.appOpenDate} onChange={(appOpenDate) => update({ appOpenDate })} />
          <TextInput type="date" label="Application end date" required value={draft.appCloseDate} onChange={(appCloseDate) => update({ appCloseDate })} min={draft.appOpenDate || undefined} />
          <TextInput type="date" label="Tentative examination date" required value={draft.examDate} onChange={(examDate) => update({ examDate })} min={draft.appCloseDate || undefined} />
          <TextInput type="time" label="Examination start time" required value={draft.examTime} onChange={(examTime) => update({ examTime })} />
          <TextInput type="number" label="Duration (minutes)" required value={draft.durationMinutes} onChange={(durationMinutes) => update({ durationMinutes })} min="10" max="600" />
          <TextInput
            type="date" label="Result declaration date (tentative)" value={draft.config.dates.resultDate ?? ''} min={draft.examDate || undefined}
            onChange={(value) => update({ config: { ...draft.config, dates: { ...draft.config.dates, resultDate: value || null } } })}
          />
        </div>
      </Panel>

      <Panel title="Description and instructions">
        <div className="grid gap-3 lg:grid-cols-2">
          <TextBox label="Examination description" value={basics.description} onChange={(description) => updateBasics({ description })} maxLength={2000} rows={4}
            placeholder={`e.g. Recruitment for the post of Staff Nurse at the Institute of Medical Sciences.`} hint="Shown at the top of the examination notice." />
          <TextBox label="Instructions for applicants" value={draft.instructions} onChange={(instructions) => update({ instructions })} maxLength={4000} rows={4}
            placeholder="e.g. Candidates must read the eligibility criteria and instructions carefully before applying." hint="Shown on the notice and the application form." />
        </div>
      </Panel>

      <InfoNote>
        You are preparing a notice and its application form. ELTNOY reviews it before anything is published; your institute cannot publish it directly.
      </InfoNote>
    </div>
  );
};
