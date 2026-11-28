// Step 5: summary, the examination notice preview and the applicant form preview. Submitting sends the
// examination to ELTNOY review (D-02); nothing is published from here.
import React, { useState } from 'react';
import { CheckCircle2, Circle, ClipboardList, FileText, Info, Pencil } from 'lucide-react';
import {
  ALTERNATIVE_ID_LABEL, EMPLOYMENT_TYPE_LABEL, EXAM_LEVEL_LABEL, EXAM_MODE_INFO, EXAM_TYPE_INFO, GENDER_LABEL, RESERVATION_CATEGORIES,
  RESERVATION_LABEL, formFieldCounts, type ExamConfig,
} from '../../../utils/examConfig';
import { eligibilitySummary, rupees, stepIssues, type WizardDraft, type WizardStepKey } from '../../../utils/examWizard';
import { examStatusLabel } from '../../../utils/workspaceExams';
import { ApplicantFormPreview } from './ApplicantFormPreview';
import { InfoNote, IssueList, Panel, Tabs } from './parts';

const dateLabel = (value: string | null) => {
  if (!value) return '—';
  const [year, month, day] = value.split('-').map(Number);
  return year && month && day ? new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : value;
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-2 py-1.5 text-sm sm:grid-cols-[180px_minmax(0,1fr)]">
    <dt className="text-slate-500">{label}</dt><dd className="font-semibold text-slate-900">{children}</dd>
  </div>
);

function feeLine(config: ExamConfig): string {
  const groups = new Map<number, string[]>();
  for (const category of RESERVATION_CATEGORIES) {
    const fee = config.fees.categories[category].fee;
    groups.set(fee, [...(groups.get(fee) ?? []), RESERVATION_LABEL[category]]);
  }
  return [...groups.entries()].map(([fee, names]) => `${fee === 0 ? 'Exempt' : rupees(fee)} (${names.join('/')})`).join(', ');
}

export const NoticePreview: React.FC<{ draft: WizardDraft }> = ({ draft }) => {
  const { config } = draft;
  const e = config.eligibility;
  const d = config.dates;
  return (
    <article className="rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label="Examination notice preview">
      <header className="rounded-t-2xl border-b-4 border-emerald-600 bg-[#0B2E59] px-5 py-4 text-white">
        <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-200">Examination notice · preview only</p>
        <h3 className="mt-1 text-lg font-black">{draft.title || 'Examination title'}</h3>
        <p className="text-xs text-slate-200">{[config.basics.conductingUnit, EXAM_TYPE_INFO[config.basics.examType].label, `Code ${draft.examCode || '—'}`, `Academic year ${draft.academicYear}`].filter(Boolean).join(' · ')}</p>
      </header>
      <div className="space-y-4 p-5 text-sm text-slate-700">
        {config.basics.description && <p className="whitespace-pre-line">{config.basics.description}</p>}
        <section>
          <h4 className="font-extrabold text-[#0B2E59]">Important dates</h4>
          <dl className="mt-1 grid gap-x-6 sm:grid-cols-2">
            <Row label="Applications open">{dateLabel(draft.appOpenDate)}</Row>
            <Row label="Last date to apply">{dateLabel(draft.appCloseDate)}</Row>
            {d.lateDeadline && <Row label="Late applications until">{dateLabel(d.lateDeadline)}</Row>}
            {d.correctionStart && <Row label="Correction window">{dateLabel(d.correctionStart)} to {dateLabel(d.correctionEnd)}</Row>}
            {d.admitCardDate && <Row label="Admit cards (expected)">{dateLabel(d.admitCardDate)}</Row>}
            <Row label="Examination">{dateLabel(draft.examDate)}, {draft.examTime} IST, {draft.durationMinutes} minutes · {EXAM_MODE_INFO[config.basics.mode].label}</Row>
            {d.resultDate && <Row label="Result (tentative)">{dateLabel(d.resultDate)}</Row>}
          </dl>
        </section>
        {config.hospitalPosts.length > 0 && (
          <section>
            <h4 className="font-extrabold text-[#0B2E59]">Posts</h4>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {config.hospitalPosts.map((post, index) => (
                <li key={index}><span className="font-semibold">{post.title}</span>{post.vacancies !== null ? ` · ${post.vacancies} vacancies` : ''}{post.department ? ` · ${post.department}` : ''}{post.qualifications.length > 0 ? ` · ${post.qualifications.join(' / ')}` : ''}{post.registrationRequired ? ` · registration with ${post.registrationCouncil}` : ''}{post.minExperienceYears !== null ? ` · ${post.minExperienceYears}+ years experience` : ''}</li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h4 className="font-extrabold text-[#0B2E59]">Eligibility</h4>
          <p className="mt-1">{eligibilitySummary(config)}.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {e.ageRelaxation.length > 0 && <li>Upper age relaxation: {e.ageRelaxation.map((item) => `${RESERVATION_LABEL[item.category]} ${item.years} years`).join(', ')}.</li>}
            {e.categories.length > 0 && <li>Open to: {e.categories.map((item) => RESERVATION_LABEL[item]).join(', ')}.</li>}
            {e.genders.length > 0 && <li>Gender: {e.genders.map((item) => GENDER_LABEL[item]).join(', ')}.</li>}
            {e.domicile && <li>Domicile: {e.domicile}.</li>}
            {e.districts && <li>Districts: {e.districts}.</li>}
            {e.minCgpa !== null && <li>Minimum CGPA {e.minCgpa}.</li>}
            {e.experienceRequired && <li>Experience: {e.minExperienceYears !== null ? `${e.minExperienceYears}+ years. ` : ''}{e.experienceDetails}</li>}
            {e.medicalFitnessRequired && <li>A medical fitness certificate is required.</li>}
            {e.employmentType !== 'not_applicable' && <li>Employment type: {EMPLOYMENT_TYPE_LABEL[e.employmentType]}.</li>}
            <li>PwD applicants {e.pwdEligible ? 'are' : 'are not'} eligible. Ex-servicemen {e.exServicemanEligible ? 'are' : 'are not'} eligible.</li>
            {e.otherCriteria && <li className="whitespace-pre-line">{e.otherCriteria}</li>}
          </ul>
        </section>
        <section>
          <h4 className="font-extrabold text-[#0B2E59]">Application fee</h4>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[320px] text-left text-xs">
              <thead className="text-slate-500"><tr><th className="py-1 pr-3">Category</th><th className="py-1 pr-3">Fee</th><th className="py-1">Late fee</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {RESERVATION_CATEGORIES.map((category) => (
                  <tr key={category}><td className="py-1 pr-3 font-semibold">{RESERVATION_LABEL[category]}</td><td className="py-1 pr-3">{config.fees.categories[category].fee === 0 ? 'Exempt' : rupees(config.fees.categories[category].fee)}</td><td className="py-1">{config.fees.categories[category].lateFee ? rupees(config.fees.categories[category].lateFee) : '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {config.fees.correctionFee !== null && <p className="mt-1 text-xs">Correction fee: {rupees(config.fees.correctionFee)}.</p>}
          {config.fees.exemptionNotes && <p className="mt-1 text-xs">{config.fees.exemptionNotes}</p>}
          <p className="mt-1 text-[11px] text-amber-800">Payment collection is not available on ELTNOY for this examination yet.</p>
        </section>
        <section>
          <h4 className="font-extrabold text-[#0B2E59]">Documents required</h4>
          <p className="mt-1 text-xs">{config.documents.length === 0 ? 'None.' : config.documents.map((item) => `${item.label}${item.required ? '' : ' (if applicable)'}`).join(', ')}.</p>
        </section>
        {draft.instructions && (
          <section>
            <h4 className="font-extrabold text-[#0B2E59]">Instructions</h4>
            <p className="mt-1 whitespace-pre-line">{draft.instructions}</p>
          </section>
        )}
      </div>
    </article>
  );
};

export const StepPreview: React.FC<{ draft: WizardDraft; goTo: (step: WizardStepKey) => void }> = ({ draft, goTo }) => {
  const [view, setView] = useState<'summary' | 'notice' | 'form'>('summary');
  const { config } = draft;
  const counts = formFieldCounts(config);
  const issues = stepIssues(draft, 'preview');
  const sectionStatus: Array<{ step: WizardStepKey; label: string; detail: string }> = [
    { step: 'details', label: 'Exam details', detail: `${EXAM_TYPE_INFO[config.basics.examType].label}, ${EXAM_MODE_INFO[config.basics.mode].label}` },
    { step: 'form', label: 'Form configuration', detail: `${config.form.sections.filter((section) => section.enabled).length} sections, ${counts.enabled} fields (${counts.required} required)` },
    { step: 'eligibility', label: 'Eligibility & academic', detail: `${config.qualifications.length} qualification${config.qualifications.length === 1 ? '' : 's'}${config.hospitalPosts.length ? `, ${config.hospitalPosts.length} posts` : ''}` },
    { step: 'setup', label: 'Application setup', detail: `${config.documents.length} documents; fees ${feeLine(config)}` },
  ];
  const aadhaar = config.form.sections.flatMap((section) => section.fields).find((field) => field.key === 'aadhaar_number');
  return (
    <div className="space-y-4">
      <Tabs label="Preview" current={view} onChange={setView} tabs={[
        { key: 'summary', label: 'Summary', icon: <ClipboardList className="h-4 w-4" /> },
        { key: 'notice', label: 'Examination notice', icon: <FileText className="h-4 w-4" /> },
        { key: 'form', label: 'Applicant form', icon: <Info className="h-4 w-4" /> },
      ]} />

      {view === 'summary' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Panel title="Examination summary" actions={<button type="button" onClick={() => goTo('details')} className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 hover:underline"><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>}>
            <dl className="divide-y divide-slate-100">
              <Row label="Examination title">{draft.title || '—'}</Row>
              <Row label="Examination type">{EXAM_TYPE_INFO[config.basics.examType].label}</Row>
              <Row label="Examination code">{draft.examCode || '—'}</Row>
              <Row label="Conducting unit">{config.basics.conductingUnit || '—'}</Row>
              <Row label="Level">{EXAM_LEVEL_LABEL[config.basics.examLevel]}</Row>
              <Row label="Mode">{EXAM_MODE_INFO[config.basics.mode].label}</Row>
              <Row label="Application period">{dateLabel(draft.appOpenDate)} – {dateLabel(draft.appCloseDate)}</Row>
              {config.dates.lateDeadline && <Row label="Late application">Until {dateLabel(config.dates.lateDeadline)}</Row>}
              <Row label="Examination date">{dateLabel(draft.examDate)} at {draft.examTime} IST</Row>
              <Row label="Academic year">{draft.academicYear}</Row>
              <Row label="Application fee">{feeLine(config)}</Row>
              <Row label="Aadhaar">{aadhaar?.enabled ? `${aadhaar.required ? 'Required' : 'Optional'}; alternatives: ${config.form.alternativeIds.map((id) => ALTERNATIVE_ID_LABEL[id]).join(', ') || 'none'}` : 'Not asked'}</Row>
              <Row label="Status"><span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-700">{draft.status ? examStatusLabel(draft.status) : 'Not saved yet'}</span></Row>
            </dl>
          </Panel>
          <Panel title="Configured sections">
            <ul className="space-y-2">
              {sectionStatus.map((item) => {
                const ok = stepIssues(draft, item.step).length === 0;
                return (
                  <li key={item.step} className="flex items-start gap-2 rounded-xl border border-slate-100 p-2.5">
                    {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Complete" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-label="Needs attention" />}
                    <div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-800">{item.label}</p><p className="text-xs text-slate-500">{item.detail}</p></div>
                    <button type="button" onClick={() => goTo(item.step)} className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 hover:underline"><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      )}
      {view === 'notice' && <NoticePreview draft={draft} />}
      {view === 'form' && <ApplicantFormPreview config={config} title={draft.title} />}

      <IssueList issues={issues} title="Before submitting, fix:" />
      <InfoNote>
        After submission, this examination goes to the ELTNOY Super Admin for review (D-02). You can edit it only while it is a draft or after ELTNOY returns it for changes. Your institute cannot publish it directly.
      </InfoNote>
    </div>
  );
};
