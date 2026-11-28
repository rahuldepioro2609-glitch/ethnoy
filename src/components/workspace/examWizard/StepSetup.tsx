// Step 4: application dates, category-wise fees (configuration only), required documents and form settings.
import React, { useState } from 'react';
import { CalendarDays, FileText, IndianRupee, Plus, Settings2, Trash2 } from 'lucide-react';
import {
  DOCUMENT_FORMATS, DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, RESERVATION_CATEGORIES, RESERVATION_LABEL, type DocumentRule, type ExamConfig,
} from '../../../utils/examConfig';
import { paiseFromRupees, type WizardDraft } from '../../../utils/examWizard';
import { CheckOption, InfoNote, NumberInput, Panel, Select, Tabs, TextBox, TextInput, inputClass, toggleInList } from './parts';

type Tab = 'dates' | 'fees' | 'documents' | 'settings';

const RupeeInput: React.FC<{ label: string; paise: number; onChange: (paise: number) => void }> = ({ label, paise, onChange }) => (
  <label className="block">
    <span className="sr-only">{label}</span>
    <span className="relative block">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">₹</span>
      <input type="number" min={0} step="1" inputMode="numeric" className={`${inputClass} pl-6`} value={paise / 100} onChange={(event) => onChange(paiseFromRupees(event.target.value))} aria-label={label} />
    </span>
  </label>
);

export const StepSetup: React.FC<{ draft: WizardDraft; update: (change: Partial<WizardDraft>) => void; onChange: (config: ExamConfig) => void }> = ({ draft, update, onChange }) => {
  const [tab, setTab] = useState<Tab>('dates');
  const [newKind, setNewKind] = useState<DocumentRule['kind']>('other');
  const config = draft.config;
  const d = config.dates;
  const setDates = (patch: Partial<ExamConfig['dates']>) => onChange({ ...config, dates: { ...d, ...patch } });
  const setFee = (category: (typeof RESERVATION_CATEGORIES)[number], patch: Partial<{ fee: number; lateFee: number }>) =>
    onChange({ ...config, fees: { ...config.fees, categories: { ...config.fees.categories, [category]: { ...config.fees.categories[category], ...patch } } } });
  const setDocument = (index: number, patch: Partial<DocumentRule>) => onChange({ ...config, documents: config.documents.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  const setForm = (patch: Partial<ExamConfig['form']>) => onChange({ ...config, form: { ...config.form, ...patch } });

  return (
    <div className="space-y-4">
      <Tabs<Tab> label="Application setup sections" current={tab} onChange={setTab} tabs={[
        { key: 'dates', label: 'Application dates', icon: <CalendarDays className="h-4 w-4" /> },
        { key: 'fees', label: 'Application fee', icon: <IndianRupee className="h-4 w-4" /> },
        { key: 'documents', label: 'Documents', icon: <FileText className="h-4 w-4" /> },
        { key: 'settings', label: 'Form settings', icon: <Settings2 className="h-4 w-4" /> },
      ]} />

      {tab === 'dates' && (
        <Panel title="Application dates" description="All dates are in India time (IST).">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TextInput type="date" label="Application start date" required value={draft.appOpenDate} onChange={(appOpenDate) => update({ appOpenDate })} />
            <TextInput type="date" label="Application end date" required value={draft.appCloseDate} onChange={(appCloseDate) => update({ appCloseDate })} min={draft.appOpenDate || undefined} />
            <TextInput type="date" label="Late application end date" value={d.lateDeadline ?? ''} onChange={(value) => setDates({ lateDeadline: value || null })} min={draft.appCloseDate || undefined} hint="Optional. Needed for late fees." />
            <TextInput type="date" label="Correction window start" value={d.correctionStart ?? ''} onChange={(value) => setDates({ correctionStart: value || null })} />
            <TextInput type="date" label="Correction window end" value={d.correctionEnd ?? ''} onChange={(value) => setDates({ correctionEnd: value || null })} min={d.correctionStart ?? undefined} />
            <TextInput type="date" label="Admit card release date" value={d.admitCardDate ?? ''} onChange={(value) => setDates({ admitCardDate: value || null })} hint="Admit cards are released only after ELTNOY approval." />
            <TextInput type="date" label="Examination date" required value={draft.examDate} onChange={(examDate) => update({ examDate })} min={draft.appCloseDate || undefined} />
            <TextInput type="date" label="Result declaration date" value={d.resultDate ?? ''} onChange={(value) => setDates({ resultDate: value || null })} min={draft.examDate || undefined} />
          </div>
        </Panel>
      )}

      {tab === 'fees' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Panel title="Application fee (category-wise)" description="Enter 0 for a category that is exempt.">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-sm">
                <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Category</th><th className="py-2 pr-3">Application fee (₹)</th><th className="py-2">Late fee (₹)</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {RESERVATION_CATEGORIES.map((category) => (
                    <tr key={category}>
                      <th scope="row" className="py-2 pr-3 font-semibold text-slate-800">{RESERVATION_LABEL[category]}{config.fees.categories[category].fee === 0 && <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800">Exempt</span>}</th>
                      <td className="py-2 pr-3"><RupeeInput label={`${RESERVATION_LABEL[category]} application fee in rupees`} paise={config.fees.categories[category].fee} onChange={(fee) => setFee(category, { fee })} /></td>
                      <td className="py-2"><RupeeInput label={`${RESERVATION_LABEL[category]} late fee in rupees`} paise={config.fees.categories[category].lateFee} onChange={(lateFee) => setFee(category, { lateFee })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <NumberInput label="Correction fee (₹, optional)" value={config.fees.correctionFee === null ? null : config.fees.correctionFee / 100} onChange={(value) => onChange({ ...config, fees: { ...config.fees, correctionFee: value === null ? null : paiseFromRupees(String(value)) } })} min={0} hint="Needs a correction window." />
              <TextBox label="Fee exemption notes" value={config.fees.exemptionNotes} onChange={(exemptionNotes) => onChange({ ...config, fees: { ...config.fees, exemptionNotes } })} maxLength={1000} rows={2} placeholder="e.g. Female candidates of Madhya Pradesh domicile are exempt." />
            </div>
          </Panel>
          <InfoNote tone="warning">
            <p className="font-bold">Fee configuration only</p>
            <p className="mt-1">These amounts appear on the notice. ELTNOY does not collect or verify application fees for Institute examinations yet: no payment gateway is connected and no application is marked paid. Payment collection needs a separate, approved integration.</p>
          </InfoNote>
        </div>
      )}

      {tab === 'documents' && (
        <Panel title="Documents applicants must upload" description="Settings for the future applicant form. ELTNOY does not store applicant documents for Institute examinations yet.">
          <ul className="space-y-3">
            {config.documents.map((item, index) => (
              <li key={index} className="rounded-xl border border-slate-200 p-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)_minmax(0,0.8fr)_auto] lg:items-end">
                  <TextInput label={`${DOCUMENT_KIND_LABEL[item.kind]}: name shown`} required value={item.label} onChange={(label) => setDocument(index, { label })} maxLength={80} />
                  <div className="pb-2"><CheckOption label="Required" checked={item.required} onChange={(required) => setDocument(index, { required })} /></div>
                  <div>
                    <p className="mb-1 text-xs font-bold text-slate-700">Formats</p>
                    <div className="flex gap-3 pb-2">{DOCUMENT_FORMATS.map((format) => <CheckOption key={format} label={format.toUpperCase()} checked={item.formats.includes(format)} onChange={(on) => setDocument(index, { formats: toggleInList(item.formats, format, on) })} />)}</div>
                  </div>
                  <NumberInput label="Maximum size" value={item.maxSizeKb} onChange={(value) => setDocument(index, { maxSizeKb: value === null ? 10 : Math.min(5120, Math.max(10, Math.round(value))) })} min={10} max={5120} suffix="KB" />
                  <button type="button" onClick={() => onChange({ ...config, documents: config.documents.filter((_, i) => i !== index) })} className="inline-flex items-center gap-1 self-end rounded-lg px-2 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Remove
                  </button>
                </div>
                <TextInput className="mt-2" label="Description for applicants" value={item.description} onChange={(description) => setDocument(index, { description })} maxLength={300} />
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
            <Select className="min-w-[220px]" label="Add document" value={newKind} onChange={(value) => setNewKind(value as DocumentRule['kind'])} options={DOCUMENT_KINDS.map((kind) => ({ value: kind, label: DOCUMENT_KIND_LABEL[kind] }))} />
            <button type="button" disabled={config.documents.length >= 20} onClick={() => {
              const used = new Set(config.documents.map((item) => item.label.toLowerCase()));
              let label = DOCUMENT_KIND_LABEL[newKind];
              for (let n = 2; used.has(label.toLowerCase()); n += 1) label = `${DOCUMENT_KIND_LABEL[newKind]} ${n}`;
              onChange({ ...config, documents: [...config.documents, { kind: newKind, label, required: false, formats: ['pdf', 'jpg', 'png'], maxSizeKb: 1024, description: '' }] });
            }} className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
              <Plus className="h-4 w-4" aria-hidden="true" />Add document
            </button>
          </div>
        </Panel>
      )}

      {tab === 'settings' && (
        <Panel title="Form settings">
          <div className="space-y-3">
            <CheckOption label="Applicants must accept a declaration before submitting" checked={config.form.consentRequired} onChange={(consentRequired) => setForm({ consentRequired })} />
            <TextBox label="Declaration text" required={config.form.consentRequired} value={config.form.declaration} onChange={(declaration) => setForm({ declaration })} maxLength={2000} rows={4} />
            <TextBox label="Short eligibility summary (shown in examination lists)" value={draft.eligibilitySummary} onChange={(eligibilitySummary) => update({ eligibilitySummary })} maxLength={300} rows={2}
              hint="Leave empty to generate it from your eligibility rules." />
          </div>
        </Panel>
      )}
    </div>
  );
};
