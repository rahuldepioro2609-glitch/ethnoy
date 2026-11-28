// Step 2: configure the applicant form (sections and fields). The Institute decides what applicants will be
// asked; it never enters an applicant's answers here.
import React, { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Eye, EyeOff, Lock, Plus, Trash2 } from 'lucide-react';
import {
  ALTERNATIVE_IDS, ALTERNATIVE_ID_LABEL, CUSTOM_FIELD_TYPES, FIELD_CATALOG, FIELD_TYPE_LABEL, FIXED_FORMAT_RULE, OPTION_TYPES,
  type ExamConfig, type FieldType, type FormField,
} from '../../../utils/examConfig';
import {
  addCustomField, addCustomSection, moveItem, removeCustomField, removeSection, retypeCustomField, updateField, updateSection,
} from '../../../utils/examWizard';
import { ApplicantFormPreview } from './ApplicantFormPreview';
import { CheckOption, InfoNote, NumberInput, Panel, Select, TextInput, Toggle, inputClass, toggleInList } from './parts';

const FieldEditor: React.FC<{ field: FormField; onChange: (change: (field: FormField) => FormField) => void }> = ({ field, onChange }) => {
  const set = (patch: Partial<FormField>) => onChange((current) => ({ ...current, ...patch }));
  const setValidation = (patch: Partial<FormField['validation']>) => onChange((current) => ({ ...current, validation: { ...current.validation, ...patch } }));
  const fixedRule = FIXED_FORMAT_RULE[field.type];
  return (
    <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
      <TextInput label="Label shown to applicants" required value={field.label} onChange={(label) => set({ label })} maxLength={120} />
      {field.builtin ? (
        <div>
          <p className="mb-1 text-xs font-bold text-slate-700">Field type</p>
          <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">{FIELD_TYPE_LABEL[field.type]} (built-in)</p>
        </div>
      ) : (
        <Select label="Field type" value={field.type} onChange={(type) => onChange((current) => retypeCustomField(current, type as FieldType))}
          options={CUSTOM_FIELD_TYPES.map((type) => ({ value: type, label: FIELD_TYPE_LABEL[type] }))} />
      )}
      <TextInput label="Placeholder" value={field.placeholder} onChange={(placeholder) => set({ placeholder })} maxLength={120} placeholder="Example text inside the box" />
      <TextInput label="Help text" value={field.helpText} onChange={(helpText) => set({ helpText })} maxLength={300} placeholder="Short guidance under the field" />
      {OPTION_TYPES.has(field.type) && field.key !== 'position_applied' && (
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-bold text-slate-700" htmlFor={`options-${field.key}`}>Options (one per line)<span className="ml-0.5 text-rose-600" aria-hidden="true">*</span></label>
          <textarea
            id={`options-${field.key}`} className={inputClass} rows={Math.min(8, Math.max(3, field.options.length + 1))}
            value={field.options.join('\n')}
            onChange={(event) => set({ options: event.target.value.split('\n').map((option) => option.replace(/^\s+/, '')).slice(0, 40) })}
            onBlur={() => set({ options: field.options.map((option) => option.trim()).filter(Boolean) })}
          />
        </div>
      )}
      {field.key === 'position_applied' && <p className="text-xs text-slate-600 sm:col-span-2">Options are the posts you add in step 3.</p>}
      {(field.type === 'text' || field.type === 'textarea') && (
        <>
          <NumberInput label="Minimum length" value={field.validation.minLength} onChange={(minLength) => setValidation({ minLength: minLength === null ? null : Math.max(0, Math.round(minLength)) })} min={0} max={4000} />
          <NumberInput label="Maximum length" value={field.validation.maxLength} onChange={(maxLength) => setValidation({ maxLength: maxLength === null ? null : Math.max(1, Math.round(maxLength)) })} min={1} max={4000} />
        </>
      )}
      {field.type === 'number' && (
        <>
          <NumberInput label="Minimum value" value={field.validation.min} onChange={(min) => setValidation({ min })} />
          <NumberInput label="Maximum value" value={field.validation.max} onChange={(max) => setValidation({ max })} />
        </>
      )}
      {fixedRule && <p className="text-xs text-slate-600 sm:col-span-2"><span className="font-bold">Validation:</span> {fixedRule}</p>}
    </div>
  );
};

export const StepForm: React.FC<{ config: ExamConfig; title: string; onChange: (config: ExamConfig) => void }> = ({ config, title, onChange }) => {
  const sections = config.form.sections;
  const [selectedKey, setSelectedKey] = useState(sections[0]?.key ?? '');
  const [editing, setEditing] = useState<string | null>(null);
  const [newType, setNewType] = useState<FieldType>('text');
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const selected = sections.find((section) => section.key === selectedKey) ?? sections[0];
  const selectedIndex = selected ? sections.indexOf(selected) : -1;
  const aadhaar = sections.flatMap((section) => section.fields).find((field) => field.key === 'aadhaar_number');

  const moveSection = (index: number, to: number) => onChange({ ...config, form: { ...config.form, sections: moveItem(sections, index, to) } });
  const moveField = (from: number, to: number) => selected && onChange(updateSection(config, selected.key, (section) => ({ ...section, fields: moveItem(section.fields, from, to) })));

  return (
    <div className="space-y-4">
      <InfoNote>
        Configure the application form applicants will fill in later. You choose which details to ask for; you do not enter any applicant's information here.
      </InfoNote>
      <div className="grid gap-4 xl:grid-cols-[250px_minmax(0,1fr)_minmax(0,380px)]">
        <Panel title="Form sections" className="h-fit">
          <ul className="space-y-1">
            {sections.map((section, index) => (
              <li key={section.key} className={`rounded-xl border ${section.key === selected?.key ? 'border-emerald-300 bg-emerald-50' : 'border-transparent'}`}>
                <div className="flex items-center gap-1 p-1">
                  <button type="button" onClick={() => { setSelectedKey(section.key); setEditing(null); }} className={`min-w-0 flex-1 break-words rounded-lg px-2 py-1.5 text-left text-sm font-semibold ${section.enabled ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                    {section.title}
                  </button>
                  <button type="button" aria-label={`Move ${section.title} up`} disabled={index === 0} onClick={() => moveSection(index, index - 1)} className="rounded p-1 text-slate-500 hover:bg-white disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Move ${section.title} down`} disabled={index === sections.length - 1} onClick={() => moveSection(index, index + 1)} className="rounded p-1 text-slate-500 hover:bg-white disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
            <TextInput label="New section title" value={newSectionTitle} onChange={setNewSectionTitle} maxLength={80} placeholder="e.g. Hostel requirement" />
            <button type="button" disabled={sections.length >= 12} onClick={() => { const next = addCustomSection(config, newSectionTitle); onChange(next); setSelectedKey(next.form.sections[next.form.sections.length - 1].key); setNewSectionTitle(''); }}
              className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-emerald-600 px-3 py-2 text-sm font-bold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50">
              <Plus className="h-4 w-4" aria-hidden="true" /> Add section
            </button>
          </div>
        </Panel>

        {selected && (
          <Panel
            title={selected.title}
            description={selected.kind === 'academic' ? 'Filled from the qualifications you set in step 3.' : selected.kind === 'documents' ? 'Filled from the documents you set in step 4.' : `${selected.fields.filter((field) => field.enabled).length} of ${selected.fields.length} fields shown to applicants`}
            actions={(
              <div className="flex flex-wrap items-center gap-3">
                <Toggle checked={selected.enabled} onChange={(enabled) => onChange(updateSection(config, selected.key, (section) => ({ ...section, enabled })))} label="Section shown to applicants" showLabel disabled={selected.key === 'personal'} />
                {selected.key !== 'personal' && (
                  <button type="button" onClick={() => { onChange(removeSection(config, selected.key)); if (!selected.builtin) setSelectedKey(sections[0].key); }} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{selected.builtin ? 'Hide section' : 'Remove section'}
                  </button>
                )}
              </div>
            )}
          >
            {!selected.builtin && (
              <TextInput className="mb-3" label="Section title" required value={selected.title} maxLength={80} onChange={(value) => onChange(updateSection(config, selected.key, (section) => ({ ...section, title: value })))} />
            )}
            {selected.kind === 'fields' && (
              <>
                {selected.fields.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">No fields yet. Add a custom field below.</p>}
                <ul className="divide-y divide-slate-100">
                  {selected.fields.map((field, index) => {
                    const locked = Boolean(FIELD_CATALOG[field.key]?.locked);
                    const change = (fn: (current: FormField) => FormField) => onChange(updateField(config, selected.key, field.key, fn));
                    return (
                      <li key={field.key} className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="flex flex-col">
                            <button type="button" aria-label={`Move ${field.label} up`} disabled={index === 0} onClick={() => moveField(index, index - 1)} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronUp className="h-3.5 w-3.5" /></button>
                            <button type="button" aria-label={`Move ${field.label} down`} disabled={index === selected.fields.length - 1} onClick={() => moveField(index, index + 1)} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronDown className="h-3.5 w-3.5" /></button>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm font-semibold ${field.enabled ? 'text-slate-900' : 'text-slate-400'}`}>
                              {field.label}{locked && <Lock className="ml-1 inline h-3 w-3 text-slate-400" aria-label="Always required" />}
                            </p>
                            <p className="text-[11px] text-slate-500">{FIELD_TYPE_LABEL[field.type]}{field.builtin ? '' : ' · custom'}</p>
                          </div>
                          <Toggle checked={field.enabled} onChange={(enabled) => change((current) => ({ ...current, enabled }))} label={`Show ${field.label}`} disabled={locked} />
                          <label className="inline-flex items-center gap-1 text-xs text-slate-600">
                            <input type="checkbox" className="h-4 w-4 accent-emerald-700" checked={field.required} disabled={locked || !field.enabled} onChange={(event) => change((current) => ({ ...current, required: event.target.checked }))} />
                            Required
                          </label>
                          <button type="button" aria-expanded={editing === field.key} onClick={() => setEditing(editing === field.key ? null : field.key)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50">
                            {editing === field.key ? 'Done' : 'Edit'}
                          </button>
                          {!field.builtin && (
                            <button type="button" aria-label={`Remove ${field.label}`} onClick={() => { onChange(removeCustomField(config, selected.key, field.key)); setEditing(null); }} className="rounded p-1 text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" /></button>
                          )}
                        </div>
                        {editing === field.key && <div className="mt-2"><FieldEditor field={field} onChange={change} /></div>}
                        {field.key === 'aadhaar_number' && field.enabled && (
                          <p className="mt-1 text-[11px] text-amber-800">Enable Aadhaar only when your institution has a legitimate requirement. It is never shown in full.</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
                  <Select className="min-w-[180px] flex-1" label="New custom field type" value={newType} onChange={(value) => setNewType(value as FieldType)} options={CUSTOM_FIELD_TYPES.map((type) => ({ value: type, label: FIELD_TYPE_LABEL[type] }))} />
                  <button type="button" disabled={selected.fields.length >= 40} onClick={() => { const next = addCustomField(config, selected.key, newType); onChange(next); const added = next.form.sections.find((section) => section.key === selected.key)!.fields.at(-1); setEditing(added?.key ?? null); }}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                    <Plus className="h-4 w-4" aria-hidden="true" /> Add custom field
                  </button>
                </div>
              </>
            )}
            {selected.kind !== 'fields' && (
              <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                {selected.kind === 'academic' ? 'Choose the qualifications and the details asked for each one in step 3 (Eligibility & academic).' : 'Choose the documents, formats and size limits in step 4 (Application setup).'}
              </p>
            )}
          </Panel>
        )}

        <div className="xl:sticky xl:top-4 xl:h-fit">
          <button type="button" onClick={() => setShowPreview(!showPreview)} className="mb-2 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 xl:hidden">
            {showPreview ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}{showPreview ? 'Hide applicant preview' : 'Show applicant preview'}
          </button>
          <div className={showPreview ? 'block' : 'hidden xl:block'}>
            <ApplicantFormPreview config={config} title={title} compact />
          </div>
        </div>
      </div>

      {aadhaar?.enabled && (
        <Panel title="Identity documents accepted instead of Aadhaar" description={aadhaar.required ? 'Aadhaar is required: accept at least one alternative.' : 'Applicants who do not give Aadhaar may use one of these.'}>
          <div className="flex flex-wrap gap-4">
            {ALTERNATIVE_IDS.map((id) => (
              <CheckOption key={id} label={ALTERNATIVE_ID_LABEL[id]} checked={config.form.alternativeIds.includes(id)} onChange={(on) => onChange({ ...config, form: { ...config.form, alternativeIds: toggleInList(config.form.alternativeIds, id, on) } })} />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
};
