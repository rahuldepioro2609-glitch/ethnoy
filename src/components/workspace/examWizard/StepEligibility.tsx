// Step 3: eligibility rules, academic qualifications and (hospital recruitment) posts. These are rules shown
// to applicants; ELTNOY does not decide anyone's eligibility automatically.
import React, { useState } from 'react';
import { Briefcase, GraduationCap, ListChecks, Plus, Trash2 } from 'lucide-react';
import {
  EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABEL, GENDERS, GENDER_LABEL, HOSPITAL_QUALIFICATIONS, HOSPITAL_ROLES, HOSPITAL_ROLE_LABEL,
  HOSPITAL_ROLE_SUGGESTIONS, INDIAN_STATES_AND_UTS, QUALIFICATION_DETAILS, QUALIFICATION_DETAIL_LABEL, QUALIFICATION_LABEL,
  QUALIFICATION_LEVELS, RESERVATION_CATEGORIES, RESERVATION_LABEL, hospitalPost, type ExamConfig, type HospitalPost, type QualificationRule,
} from '../../../utils/examConfig';
import { CheckOption, InfoNote, NumberInput, Panel, Select, Tabs, TextBox, TextInput, toggleInList } from './parts';

type Tab = 'criteria' | 'academic' | 'experience';

export const StepEligibility: React.FC<{ config: ExamConfig; onChange: (config: ExamConfig) => void }> = ({ config, onChange }) => {
  const [tab, setTab] = useState<Tab>('criteria');
  const [newLevel, setNewLevel] = useState<QualificationRule['level']>('graduation');
  const e = config.eligibility;
  const setE = (patch: Partial<ExamConfig['eligibility']>) => onChange({ ...config, eligibility: { ...e, ...patch } });
  const setQualification = (index: number, patch: Partial<QualificationRule>) =>
    onChange({ ...config, qualifications: config.qualifications.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  const setPost = (index: number, patch: Partial<HospitalPost>) =>
    onChange({ ...config, hospitalPosts: config.hospitalPosts.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  const isHospital = config.basics.examType === 'hospital_recruitment';
  const relaxation = (category: (typeof RESERVATION_CATEGORIES)[number]) => e.ageRelaxation.find((item) => item.category === category)?.years ?? null;
  const setRelaxation = (category: (typeof RESERVATION_CATEGORIES)[number], years: number | null) =>
    setE({ ageRelaxation: [...e.ageRelaxation.filter((item) => item.category !== category), ...(years && years > 0 ? [{ category, years: Math.min(20, Math.round(years)) }] : [])] });

  return (
    <div className="space-y-4">
      <Tabs<Tab> label="Eligibility sections" current={tab} onChange={setTab} tabs={[
        { key: 'criteria', label: 'Eligibility criteria', icon: <ListChecks className="h-4 w-4" /> },
        { key: 'academic', label: 'Academic qualifications', icon: <GraduationCap className="h-4 w-4" /> },
        { key: 'experience', label: isHospital ? 'Posts & experience' : 'Experience (optional)', icon: <Briefcase className="h-4 w-4" /> },
      ]} />

      {tab === 'criteria' && (
        <>
          <Panel title="Age" description="Leave empty when there is no age limit.">
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberInput label="Minimum age" value={e.minAge} onChange={(minAge) => setE({ minAge: minAge === null ? null : Math.round(minAge) })} min={0} max={100} suffix="years" />
              <NumberInput label="Maximum age" value={e.maxAge} onChange={(maxAge) => setE({ maxAge: maxAge === null ? null : Math.round(maxAge) })} min={0} max={100} suffix="years" />
              <TextInput type="date" label="Age calculated as on" required={e.minAge !== null || e.maxAge !== null} value={e.ageAsOn ?? ''} onChange={(value) => setE({ ageAsOn: value || null })} />
            </div>
            {e.maxAge !== null && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-bold text-slate-700">Upper age relaxation by category (years)</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                  {RESERVATION_CATEGORIES.filter((category) => category !== 'general').map((category) => (
                    <NumberInput key={category} label={RESERVATION_LABEL[category]} value={relaxation(category)} onChange={(years) => setRelaxation(category, years)} min={0} max={20} />
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">Enter the relaxation your institution applies; ELTNOY does not apply legal rules automatically.</p>
              </div>
            )}
          </Panel>

          <Panel title="Who may apply">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-bold text-slate-700">Gender eligibility</p>
                <div className="flex flex-wrap gap-3">
                  {GENDERS.map((gender) => <CheckOption key={gender} label={GENDER_LABEL[gender]} checked={e.genders.includes(gender)} onChange={(on) => setE({ genders: toggleInList(e.genders, gender, on) })} />)}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">None ticked means all genders may apply.</p>
              </div>
              <div>
                <p className="mb-1 text-xs font-bold text-slate-700">Category eligibility</p>
                <div className="flex flex-wrap gap-3">
                  {RESERVATION_CATEGORIES.map((category) => <CheckOption key={category} label={RESERVATION_LABEL[category]} checked={e.categories.includes(category)} onChange={(on) => setE({ categories: toggleInList(e.categories, category, on) })} />)}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">None ticked means all categories may apply.</p>
              </div>
              <TextInput label="Nationality" value={e.nationality} onChange={(nationality) => setE({ nationality })} maxLength={160} placeholder="Indian" />
              <TextInput label="Domicile requirement" value={e.domicile} onChange={(domicile) => setE({ domicile })} maxLength={300} placeholder="e.g. Domicile of Madhya Pradesh" />
              <div className="lg:col-span-2">
                <p className="mb-1 text-xs font-bold text-slate-700">Eligible states / UTs</p>
                <details className="rounded-lg border border-slate-200 p-2">
                  <summary className="cursor-pointer text-sm text-slate-700">{e.states.length === 0 ? 'All states and union territories' : `${e.states.length} selected: ${e.states.slice(0, 4).join(', ')}${e.states.length > 4 ? '…' : ''}`}</summary>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {INDIAN_STATES_AND_UTS.map((state) => <CheckOption key={state} label={state} checked={e.states.includes(state)} onChange={(on) => setE({ states: toggleInList(e.states, state, on) })} />)}
                  </div>
                </details>
              </div>
              <TextInput className="lg:col-span-2" label="Eligible districts (if limited)" value={e.districts} onChange={(districts) => setE({ districts })} maxLength={500} placeholder="e.g. Bhopal, Sehore, Raisen" />
              <CheckOption label="PwD applicants are eligible" checked={e.pwdEligible} onChange={(pwdEligible) => setE({ pwdEligible })} />
              <CheckOption label="Ex-servicemen are eligible" checked={e.exServicemanEligible} onChange={(exServicemanEligible) => setE({ exServicemanEligible })} />
              <CheckOption label="Medical fitness certificate required" checked={e.medicalFitnessRequired} onChange={(medicalFitnessRequired) => setE({ medicalFitnessRequired })} />
              <Select label="Employment type" value={e.employmentType} onChange={(value) => setE({ employmentType: value as typeof e.employmentType })} options={EMPLOYMENT_TYPES.map((type) => ({ value: type, label: EMPLOYMENT_TYPE_LABEL[type] }))} />
            </div>
          </Panel>

          <Panel title="Educational eligibility">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <NumberInput label="Minimum percentage" value={e.minPercentage} onChange={(minPercentage) => setE({ minPercentage })} min={0} max={100} step="0.01" suffix="%" />
              <NumberInput label="Minimum CGPA" value={e.minCgpa} onChange={(minCgpa) => setE({ minCgpa })} min={0} max={10} step="0.01" />
              <TextInput className="sm:col-span-2" label="Required subjects" value={e.requiredSubjects} onChange={(requiredSubjects) => setE({ requiredSubjects })} maxLength={300} placeholder="e.g. Physics, Chemistry, Biology (PCB) in Class 12" />
              <TextBox className="sm:col-span-2 lg:col-span-4" label="Required qualification" value={e.requiredQualification} onChange={(requiredQualification) => setE({ requiredQualification })} maxLength={500} rows={2}
                placeholder="e.g. Candidate must have GNM / B.Sc Nursing from a recognised institution and valid registration." />
              <TextBox className="sm:col-span-2 lg:col-span-4" label="Other eligibility conditions" value={e.otherCriteria} onChange={(otherCriteria) => setE({ otherCriteria })} maxLength={2000} rows={3} />
            </div>
          </Panel>
        </>
      )}

      {tab === 'academic' && (
        <Panel title="Academic qualifications asked on the form" description="For each qualification, choose what applicants must give.">
          {config.qualifications.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">No qualifications. Add one below, or leave empty if none is needed.</p>}
          <ul className="space-y-3">
            {config.qualifications.map((item, index) => (
              <li key={`${item.level}-${index}`} className="rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <TextInput className="min-w-[200px] flex-1" label={`${QUALIFICATION_LABEL[item.level]}: name shown`} required value={item.label} onChange={(label) => setQualification(index, { label })} maxLength={80} />
                  <CheckOption label="Required" checked={item.required} onChange={(required) => setQualification(index, { required })} />
                  <button type="button" onClick={() => onChange({ ...config, qualifications: config.qualifications.filter((_, i) => i !== index) })} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Remove
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                  {QUALIFICATION_DETAILS.map((detail) => (
                    <CheckOption key={detail} label={QUALIFICATION_DETAIL_LABEL[detail]} checked={item.details.includes(detail)} onChange={(on) => setQualification(index, { details: toggleInList(item.details, detail, on) })} />
                  ))}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <NumberInput label="Minimum percentage" value={item.minPercentage} onChange={(minPercentage) => setQualification(index, { minPercentage })} min={0} max={100} step="0.01" suffix="%" />
                  <NumberInput label="Minimum CGPA" value={item.minCgpa} onChange={(minCgpa) => setQualification(index, { minCgpa })} min={0} max={10} step="0.01" />
                  <TextInput className="sm:col-span-2" label="Subjects" value={item.subjects} onChange={(subjects) => setQualification(index, { subjects })} maxLength={200} placeholder="e.g. PCB" />
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
            <Select className="min-w-[200px]" label="Add qualification" value={newLevel} onChange={(value) => setNewLevel(value as QualificationRule['level'])} options={QUALIFICATION_LEVELS.map((level) => ({ value: level, label: QUALIFICATION_LABEL[level] }))} />
            <button type="button" disabled={config.qualifications.length >= 10} onClick={() => onChange({ ...config, qualifications: [...config.qualifications, {
              level: newLevel, label: QUALIFICATION_LABEL[newLevel], required: true,
              details: ['board_university', 'institution', 'passing_year', 'roll_number', 'total_marks', 'obtained_marks', 'percentage', 'upload'],
              minPercentage: null, minCgpa: null, subjects: '', notes: '',
            }] })} className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
              <Plus className="h-4 w-4" aria-hidden="true" />Add qualification
            </button>
          </div>
        </Panel>
      )}

      {tab === 'experience' && (
        <>
          <Panel title="Experience requirement">
            <div className="grid gap-3 sm:grid-cols-3">
              <CheckOption label="Work experience is required" checked={e.experienceRequired} onChange={(experienceRequired) => setE({ experienceRequired })} />
              <NumberInput label="Minimum experience" value={e.minExperienceYears} onChange={(minExperienceYears) => setE({ minExperienceYears })} min={0} max={50} step="0.5" suffix="years" />
              <TextBox className="sm:col-span-3" label="Experience details" value={e.experienceDetails} onChange={(experienceDetails) => setE({ experienceDetails })} maxLength={1000} rows={2} placeholder="e.g. Clinical experience in a hospital with at least 100 beds." />
            </div>
          </Panel>
          {isHospital ? (
            <Panel title="Posts" description="Configure the requirements for each post. Applicants choose one post on the form.">
              <ul className="space-y-3">
                {config.hospitalPosts.map((post, index) => (
                  <li key={index} className="rounded-xl border border-slate-200 p-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <TextInput label="Post title" required value={post.title} onChange={(title) => setPost(index, { title })} maxLength={120} />
                      <Select label="Role" value={post.role} onChange={(role) => setPost(index, { role: role as HospitalPost['role'], qualifications: [...HOSPITAL_ROLE_SUGGESTIONS[role as HospitalPost['role']]] })} options={HOSPITAL_ROLES.map((role) => ({ value: role, label: HOSPITAL_ROLE_LABEL[role] }))} />
                      <TextInput label="Department" value={post.department} onChange={(department) => setPost(index, { department })} maxLength={120} placeholder="e.g. Emergency" />
                      <NumberInput label="Vacancies" value={post.vacancies} onChange={(vacancies) => setPost(index, { vacancies: vacancies === null ? null : Math.max(0, Math.round(vacancies)) })} min={0} />
                      <TextInput label="Specialisation" value={post.specialization} onChange={(specialization) => setPost(index, { specialization })} maxLength={160} />
                      <NumberInput label="Minimum experience" value={post.minExperienceYears} onChange={(minExperienceYears) => setPost(index, { minExperienceYears })} min={0} max={50} step="0.5" suffix="years" />
                      <div className="flex items-end"><CheckOption label="Council registration required" checked={post.registrationRequired} onChange={(registrationRequired) => setPost(index, { registrationRequired })} /></div>
                      <TextInput label="Registration council" required={post.registrationRequired} value={post.registrationCouncil} onChange={(registrationCouncil) => setPost(index, { registrationCouncil })} maxLength={160} />
                    </div>
                    <div className="mt-3">
                      <p className="mb-1 text-xs font-bold text-slate-700">Accepted qualifications</p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {HOSPITAL_QUALIFICATIONS.map((qualification) => <CheckOption key={qualification} label={qualification} checked={post.qualifications.includes(qualification)} onChange={(on) => setPost(index, { qualifications: toggleInList(post.qualifications, qualification, on) })} />)}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <TextBox className="min-w-[240px] flex-1" label="Other requirements (internship, residency, certifications, shifts)" value={post.otherRequirements} onChange={(otherRequirements) => setPost(index, { otherRequirements })} maxLength={1000} rows={2} />
                      <button type="button" onClick={() => onChange({ ...config, hospitalPosts: config.hospitalPosts.filter((_, i) => i !== index) })} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50">
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Remove post
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <button type="button" disabled={config.hospitalPosts.length >= 20} onClick={() => onChange({ ...config, hospitalPosts: [...config.hospitalPosts, hospitalPost('nurse', 'New post')] })} className="mt-3 inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                <Plus className="h-4 w-4" aria-hidden="true" />Add post
              </button>
            </Panel>
          ) : (
            <InfoNote>Posts with their own qualifications and council registration are available for Hospital Recruitment. Choose that type in step 1 to use them.</InfoNote>
          )}
        </>
      )}
    </div>
  );
};
