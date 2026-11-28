// Read-only preview of the application form applicants will see later. Nothing here can be typed into or
// submitted: the Institute is configuring the form, not filling it in, and no applicant form exists on ELTNOY
// for Institute examinations yet.
import React from 'react';
import {
  ALTERNATIVE_ID_LABEL, FIXED_FORMAT_RULE, QUALIFICATION_DETAIL_LABEL, type ExamConfig, type FormField,
} from '../../../utils/examConfig';
import { fieldOptionsForPreview } from '../../../utils/examWizard';

const controlShell = 'mt-1 block w-full rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-400';

const PreviewField: React.FC<{ config: ExamConfig; field: FormField }> = ({ config, field }) => {
  const options = fieldOptionsForPreview(config, field);
  const rule = FIXED_FORMAT_RULE[field.type];
  const limits = [
    field.validation.minLength !== null ? `min ${field.validation.minLength} characters` : '',
    field.validation.maxLength !== null ? `max ${field.validation.maxLength} characters` : '',
    field.validation.min !== null ? `minimum ${field.validation.min}` : '',
    field.validation.max !== null ? `maximum ${field.validation.max}` : '',
  ].filter(Boolean).join(', ');
  return (
    <div className={field.type === 'textarea' ? 'sm:col-span-2' : ''}>
      <p className="text-xs font-semibold text-slate-800">
        {field.label}{field.required ? <span className="ml-0.5 text-rose-600">*</span> : <span className="ml-1 font-normal text-slate-400">(optional)</span>}
      </p>
      {field.type === 'radio' || field.type === 'checkbox' ? (
        <div className="mt-1 flex flex-wrap gap-3">
          {options.map((option) => (
            <span key={option} className="inline-flex items-center gap-1 text-xs text-slate-600">
              <span className={`inline-block h-3 w-3 border border-slate-400 ${field.type === 'radio' ? 'rounded-full' : 'rounded-sm'}`} aria-hidden="true" />{option}
            </span>
          ))}
        </div>
      ) : (
        <div className={`${controlShell} ${field.type === 'textarea' ? 'h-12' : ''}`} aria-hidden="true">
          {field.type === 'aadhaar' ? 'XXXX XXXX 1234'
            : field.type === 'select' || field.type === 'state' ? (options.length > 0 ? `Select (${options.length} options) ▾` : 'Select ▾')
              : field.type === 'date' ? 'dd/mm/yyyy'
                : field.placeholder || ' '}
        </div>
      )}
      {(field.helpText || rule || limits) && (
        <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{[field.helpText, rule, limits].filter(Boolean).join(' · ')}</p>
      )}
    </div>
  );
};

export const ApplicantFormPreview: React.FC<{ config: ExamConfig; title: string; compact?: boolean }> = ({ config, title, compact }) => {
  const sections = config.form.sections.filter((section) => section.enabled);
  const aadhaar = config.form.sections.flatMap((section) => section.fields).find((field) => field.key === 'aadhaar_number' && field.enabled);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label="Applicant form preview">
      <div className="rounded-t-2xl bg-[#0B2E59] px-4 py-3 text-white">
        <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-200">Applicant view · preview only</p>
        <p className="text-sm font-extrabold">{title || 'Examination application form'}</p>
      </div>
      <div className={`space-y-4 p-4 ${compact ? 'max-h-[70vh] overflow-y-auto' : ''}`}>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          This is how the form will be laid out for applicants. Applicants cannot apply through ELTNOY for Institute examinations yet, so nothing can be entered here.
        </p>
        {sections.length === 0 && <p className="text-xs text-slate-500">No sections are switched on.</p>}
        {sections.map((section, index) => (
          <fieldset key={section.key} disabled className="rounded-xl border border-slate-200 p-3">
            <legend className="px-1 text-xs font-extrabold text-[#0B2E59]">{index + 1}. {section.title}</legend>
            {section.kind === 'fields' && (
              section.fields.some((field) => field.enabled) ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {section.fields.filter((field) => field.enabled).map((field) => <PreviewField key={field.key} config={config} field={field} />)}
                </div>
              ) : <p className="text-xs text-slate-500">No fields switched on in this section.</p>
            )}
            {section.kind === 'academic' && (
              config.qualifications.length === 0 ? <p className="text-xs text-slate-500">No qualifications configured (step 3).</p> : (
                <ul className="space-y-2">
                  {config.qualifications.map((item, qIndex) => (
                    <li key={`${item.level}-${qIndex}`} className="rounded-lg bg-slate-50 p-2 text-xs">
                      <p className="font-semibold text-slate-800">{item.label}{item.required ? <span className="ml-0.5 text-rose-600">*</span> : <span className="ml-1 font-normal text-slate-400">(optional)</span>}</p>
                      <p className="mt-0.5 text-[11px] text-slate-600">Asks for: {item.details.map((detail) => QUALIFICATION_DETAIL_LABEL[detail]).join(', ') || 'no details'}</p>
                      {(item.minPercentage !== null || item.minCgpa !== null || item.subjects) && (
                        <p className="text-[11px] text-slate-500">{[item.minPercentage !== null ? `Minimum ${item.minPercentage}%` : '', item.minCgpa !== null ? `Minimum CGPA ${item.minCgpa}` : '', item.subjects ? `Subjects: ${item.subjects}` : ''].filter(Boolean).join(' · ')}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )
            )}
            {section.kind === 'documents' && (
              config.documents.length === 0 ? <p className="text-xs text-slate-500">No documents configured (step 4).</p> : (
                <ul className="divide-y divide-slate-100">
                  {config.documents.map((item) => (
                    <li key={item.label} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
                      <span className="font-semibold text-slate-800">{item.label}{item.required ? <span className="ml-0.5 text-rose-600">*</span> : <span className="ml-1 font-normal text-slate-400">(optional)</span>}</span>
                      <span className="text-[11px] text-slate-500">{item.formats.map((format) => format.toUpperCase()).join(', ')} · up to {item.maxSizeKb >= 1024 ? `${(item.maxSizeKb / 1024).toFixed(item.maxSizeKb % 1024 ? 1 : 0)} MB` : `${item.maxSizeKb} KB`}</span>
                    </li>
                  ))}
                </ul>
              )
            )}
          </fieldset>
        ))}
        {aadhaar && config.form.alternativeIds.length > 0 && (
          <p className="text-[11px] text-slate-600">Instead of Aadhaar, applicants may give: {config.form.alternativeIds.map((id) => ALTERNATIVE_ID_LABEL[id]).join(', ')}.</p>
        )}
        {config.form.consentRequired && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-700">
            <p className="font-bold text-slate-800">Declaration</p>
            <p className="mt-1">☐ {config.form.declaration}</p>
          </div>
        )}
      </div>
    </div>
  );
};
