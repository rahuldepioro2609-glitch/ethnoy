// Create Examination wizard: the screen's state and its pure rules (no React). The server repeats every check
// (server/instituteWorkspace.ts with src/utils/examConfig.ts); this only guides the Institute step by step.
import {
  EXAM_MODES, EXAM_TYPE_INFO, EXAM_TYPES, FIELD_CATALOG, GENDER_LABEL, INDIAN_STATES_AND_UTS, OPTION_TYPES, RESERVATION_LABEL,
  customField, examConfigDateIssues, examConfigIssues, examConfigPreset, examConfigSchema, type ExamConfig, type ExamMode,
  type ExamType, type FieldType, type FormField, type FormSection,
} from './examConfig';

export const WIZARD_STEPS = [
  { key: 'details', title: 'Exam details', subtitle: 'Type & basic info' },
  { key: 'form', title: 'Form configuration', subtitle: 'Applicant fields' },
  { key: 'eligibility', title: 'Eligibility & academic', subtitle: 'Criteria & qualifications' },
  { key: 'setup', title: 'Application setup', subtitle: 'Dates, fees & documents' },
  { key: 'preview', title: 'Preview & submit', subtitle: 'Review and send' },
] as const;
export type WizardStepKey = (typeof WIZARD_STEPS)[number]['key'];

/** Everything the wizard edits: the exam columns plus the configuration. Never applicant data. */
export interface WizardDraft {
  examId: string | null;
  /** The version loaded from the server (compare-and-set on save). */
  expectedUpdatedAt: string | null;
  status: string | null;
  statusReason: string;
  examCode: string;
  title: string;
  academicYear: string;
  appOpenDate: string;
  appCloseDate: string;
  examDate: string;
  examTime: string;
  durationMinutes: string;
  /** Short eligibility line shown in examination lists; generated from the rules when left empty. */
  eligibilitySummary: string;
  instructions: string;
  config: ExamConfig;
  /** True when this examination existed before the wizard and had no configuration. */
  legacy: boolean;
}

export function newDraft(type: ExamType = 'general'): WizardDraft {
  return {
    examId: null, expectedUpdatedAt: null, status: null, statusReason: '', examCode: '', title: '', academicYear: defaultAcademicYear(),
    appOpenDate: '', appCloseDate: '', examDate: '', examTime: '10:00', durationMinutes: '120', eligibilitySummary: '', instructions: '',
    config: examConfigPreset(type), legacy: false,
  };
}

/** The current Indian academic year (April to March), e.g. 2026-27 from April 2026 to March 2027. */
export function defaultAcademicYear(now = new Date()): string {
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(-2)}`;
}

/**
 * Switch the examination type: start from that type's preset but keep everything already typed in step 1 and
 * the fees and dates. The screen asks before calling this once the form has been changed.
 */
export function applyExamType(draft: WizardDraft, type: ExamType): WizardDraft {
  const preset = examConfigPreset(type);
  const { basics } = draft.config;
  return {
    ...draft,
    config: {
      ...preset,
      basics: { ...preset.basics, conductingUnit: basics.conductingUnit, examLevel: basics.examLevel, description: basics.description, mode: draft.config.basics.mode },
      dates: draft.config.dates,
      fees: draft.config.fees,
    },
  };
}

// --- Server rows ↔ draft -------------------------------------------------------------------------------------

export interface ExamForEdit {
  id: string; exam_code: string; title: string; category: string; mode: string; eligibility: string; academic_year: string;
  app_open_date: string; app_close_date: string; exam_date: string; exam_time: string; duration_minutes: number | string;
  instructions: string; lifecycle_status: string; status_reason?: string; exam_config_json: unknown; updated_at: string;
}

const LEGACY_TYPE: Readonly<Record<string, ExamType>> = Object.freeze({
  Recruitment: 'recruitment', Admission: 'institution_admission', Scholarship: 'scholarship', Certification: 'certification', Mock: 'general', Other: 'other',
});
const LEGACY_MODE: Readonly<Record<string, ExamMode>> = Object.freeze({ 'Online CBT': 'online_cbt', Offline: 'offline_omr', Hybrid: 'hybrid' });

/** A saved examination as a draft. An examination made before the wizard gets the preset for its category. */
export function draftFromExam(exam: ExamForEdit): WizardDraft {
  const parsed = examConfigSchema.safeParse(exam.exam_config_json);
  let config: ExamConfig;
  let legacy = false;
  if (parsed.success) {
    config = parsed.data;
  } else {
    legacy = true;
    config = examConfigPreset(LEGACY_TYPE[exam.category] ?? 'other');
    config.basics.mode = LEGACY_MODE[exam.mode] ?? 'offline_omr';
  }
  return {
    examId: exam.id, expectedUpdatedAt: exam.updated_at, status: exam.lifecycle_status, statusReason: exam.status_reason ?? '',
    examCode: exam.exam_code, title: exam.title, academicYear: exam.academic_year, appOpenDate: exam.app_open_date,
    appCloseDate: exam.app_close_date, examDate: exam.exam_date, examTime: exam.exam_time, durationMinutes: String(exam.duration_minutes),
    eligibilitySummary: exam.eligibility, instructions: exam.instructions, config, legacy,
  };
}

/** The JSON body for POST /api/center/exams (new) or PATCH /api/center/exams/:id (existing). */
export function requestBody(draft: WizardDraft, submitForApproval: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: draft.title.trim(), academicYear: draft.academicYear.trim(), appOpenDate: draft.appOpenDate, appCloseDate: draft.appCloseDate,
    examDate: draft.examDate, examTime: draft.examTime, durationMinutes: Number(draft.durationMinutes),
    eligibility: (draft.eligibilitySummary.trim() || eligibilitySummary(draft.config)).slice(0, 300),
    instructions: draft.instructions.trim(), config: draft.config, submitForApproval,
  };
  if (draft.examId) body.expectedUpdatedAt = draft.expectedUpdatedAt;
  else body.examCode = draft.examCode.trim().toUpperCase();
  return body;
}

const shortDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/** One line describing the eligibility rules, for examination lists (the exam column allows 300 characters). */
export function eligibilitySummary(config: ExamConfig): string {
  const e = config.eligibility;
  const parts: string[] = [];
  if (e.minAge !== null || e.maxAge !== null) {
    const range = e.minAge !== null && e.maxAge !== null ? `${e.minAge}–${e.maxAge} years` : e.minAge !== null ? `at least ${e.minAge} years` : `up to ${e.maxAge} years`;
    parts.push(`Age ${range}${e.ageAsOn ? ` as on ${shortDate(e.ageAsOn)}` : ''}`);
  }
  if (e.requiredQualification) parts.push(e.requiredQualification);
  else {
    const required = config.qualifications.filter((item) => item.required).map((item) => item.label);
    if (required.length > 0) parts.push(required.join(', '));
  }
  if (e.minPercentage !== null) parts.push(`minimum ${e.minPercentage}%`);
  if (e.requiredSubjects) parts.push(e.requiredSubjects);
  if (e.genders.length > 0) parts.push(`${e.genders.map((item) => GENDER_LABEL[item]).join(' / ')} applicants`);
  if (e.states.length > 0 && e.states.length < INDIAN_STATES_AND_UTS.length) parts.push(`domicile: ${e.states.slice(0, 3).join(', ')}${e.states.length > 3 ? ' and others' : ''}`);
  if (e.nationality && e.nationality !== 'Indian') parts.push(`nationality: ${e.nationality}`);
  const summary = parts.join('; ');
  return (summary || 'As described in the examination notice').slice(0, 300);
}

// --- Step checks (the server is the authority; these guide the Institute) -----------------------------------

const CODE = /^[A-Za-z0-9_-]{2,40}$/;

function issuesUnder(config: ExamConfig, prefixes: string[]): string[] {
  return examConfigIssues(config).filter((item) => prefixes.some((prefix) => item.path === prefix || item.path.startsWith(`${prefix}.`))).map((item) => item.message);
}

/** Problems that stop the Institute from leaving a step (or saving, for step 1). */
export function stepIssues(draft: WizardDraft, step: WizardStepKey): string[] {
  const issues: string[] = [];
  const datesOk = draft.appOpenDate && draft.appCloseDate && draft.examDate;
  if (step === 'details' || step === 'preview') {
    if (draft.title.trim().length < 3) issues.push('Enter the examination title (at least 3 characters).');
    if (!draft.examId && !CODE.test(draft.examCode.trim())) issues.push('Enter an examination code: 2–40 letters, digits, hyphens or underscores.');
    if (draft.academicYear.trim().length < 4) issues.push('Enter the academic year, for example 2026-27.');
    if (!datesOk) issues.push('Enter the application start and end dates and the tentative examination date.');
    else {
      if (draft.appCloseDate < draft.appOpenDate) issues.push('The application end date must be on or after the start date.');
      if (draft.examDate < draft.appCloseDate) issues.push('The examination date must be on or after the application end date.');
    }
    if (draft.examDate && draft.config.dates.resultDate && draft.config.dates.resultDate < draft.examDate) {
      issues.push('The result declaration date must be on or after the examination date.');
    }
    const minutes = Number(draft.durationMinutes);
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > 600) issues.push('Duration must be between 10 and 600 minutes.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.examTime)) issues.push('Enter the examination start time.');
    issues.push(...issuesUnder(draft.config, ['basics']));
  }
  if (step === 'form' || step === 'preview') issues.push(...issuesUnder(draft.config, ['form']));
  if (step === 'eligibility' || step === 'preview') issues.push(...issuesUnder(draft.config, ['eligibility', 'qualifications', 'hospitalPosts']));
  if (step === 'setup' || step === 'preview') {
    issues.push(...issuesUnder(draft.config, ['dates', 'fees', 'documents']));
    if (datesOk && examConfigSchema.safeParse(draft.config).success) {
      issues.push(...examConfigDateIssues(draft.config, { appOpenDate: draft.appOpenDate, appCloseDate: draft.appCloseDate, examDate: draft.examDate }));
    }
  }
  if (step === 'preview' && examConfigIssues(draft.config).length > 0 && issues.length === 0) {
    issues.push('Some settings are not valid yet. Go back through the steps to fix them.');
  }
  return [...new Set(issues)];
}

/** Saving needs the exam columns the server requires (step 1); the rest can be finished later. */
export function canSaveDraft(draft: WizardDraft): boolean {
  return stepIssues(draft, 'details').length === 0;
}

// --- Form designer helpers ----------------------------------------------------------------------------------

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** A key not yet used by any section or field, for a new custom section or field. */
export function nextCustomKey(config: ExamConfig, prefix: 'custom_section' | 'custom_field'): string {
  const used = new Set<string>([
    ...config.form.sections.map((section) => section.key),
    ...config.form.sections.flatMap((section) => section.fields.map((field) => field.key)),
  ]);
  for (let index = 1; index < 1000; index += 1) {
    const key = `${prefix}_${index}`;
    if (!used.has(key)) return key;
  }
  throw new Error('Too many custom entries.');
}

export function addCustomSection(config: ExamConfig, title: string): ExamConfig {
  const section: FormSection = { key: nextCustomKey(config, 'custom_section'), title: title.trim() || 'Additional details', kind: 'fields', builtin: false, enabled: true, fields: [] };
  return { ...config, form: { ...config.form, sections: [...config.form.sections, section] } };
}

export function addCustomField(config: ExamConfig, sectionKey: string, type: FieldType): ExamConfig {
  const key = nextCustomKey(config, 'custom_field');
  return updateSection(config, sectionKey, (section) => ({ ...section, fields: [...section.fields, customField(key, type)] }));
}

export function updateSection(config: ExamConfig, sectionKey: string, change: (section: FormSection) => FormSection): ExamConfig {
  return { ...config, form: { ...config.form, sections: config.form.sections.map((section) => (section.key === sectionKey ? change(section) : section)) } };
}

export function updateField(config: ExamConfig, sectionKey: string, fieldKey: string, change: (field: FormField) => FormField): ExamConfig {
  return updateSection(config, sectionKey, (section) => ({
    ...section,
    fields: section.fields.map((field) => {
      if (field.key !== fieldKey) return field;
      const next = change(field);
      const locked = Boolean(FIELD_CATALOG[field.key]?.locked);
      // Locked fields stay on and required; a disabled field is never required.
      return { ...next, enabled: locked || next.enabled, required: locked || (next.enabled && next.required) };
    }),
  }));
}

/** Removing a section: built-in sections are switched off (they can be switched back on); custom ones are deleted. */
export function removeSection(config: ExamConfig, sectionKey: string): ExamConfig {
  const section = config.form.sections.find((item) => item.key === sectionKey);
  if (!section) return config;
  if (section.builtin) return updateSection(config, sectionKey, (item) => ({ ...item, enabled: false }));
  return { ...config, form: { ...config.form, sections: config.form.sections.filter((item) => item.key !== sectionKey) } };
}

export function removeCustomField(config: ExamConfig, sectionKey: string, fieldKey: string): ExamConfig {
  return updateSection(config, sectionKey, (section) => ({ ...section, fields: section.fields.filter((field) => field.builtin || field.key !== fieldKey) }));
}

/** Change a custom field's type, keeping options only where they apply. */
export function retypeCustomField(field: FormField, type: FieldType): FormField {
  if (field.builtin) return field;
  return {
    ...field, type,
    options: OPTION_TYPES.has(type) ? (field.options.length >= 2 ? field.options : ['Option 1', 'Option 2']) : [],
    validation: { minLength: null, maxLength: null, min: null, max: null },
  };
}

/** The options a "Post applied for" field offers: the posts configured for a hospital recruitment. */
export function fieldOptionsForPreview(config: ExamConfig, field: FormField): string[] {
  if (field.key === 'position_applied' && config.hospitalPosts.length > 0) return config.hospitalPosts.map((post) => post.title);
  if (field.type === 'state') return [...INDIAN_STATES_AND_UTS];
  return field.options;
}

// --- Display helpers ----------------------------------------------------------------------------------------

export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Rupees typed by the Institute → paise (whole paise, never negative). */
export function paiseFromRupees(value: string): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

export function typeLabel(type: ExamType): string {
  return EXAM_TYPE_INFO[type].label;
}

export { EXAM_TYPES, EXAM_MODES, RESERVATION_LABEL };

// --- Unsaved work in this browser (sessionStorage; a convenience only, the server copy is authoritative) -----

const STORAGE_PREFIX = 'eltnoy.examWizard.';

export function storageKey(examId: string | null): string {
  return `${STORAGE_PREFIX}${examId ?? 'new'}`;
}

export function saveLocalDraft(draft: WizardDraft): void {
  try {
    window.sessionStorage.setItem(storageKey(draft.examId), JSON.stringify({ savedAt: Date.now(), draft }));
  } catch {
    // Storage can be unavailable (private mode, blocked); the server draft is unaffected.
  }
}

export function loadLocalDraft(examId: string | null): { savedAt: number; draft: WizardDraft } | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(examId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; draft?: WizardDraft };
    if (typeof parsed.savedAt !== 'number' || !parsed.draft || !examConfigSchema.safeParse(parsed.draft.config).success) return null;
    return { savedAt: parsed.savedAt, draft: parsed.draft };
  } catch {
    return null;
  }
}

export function clearLocalDraft(examId: string | null): void {
  try {
    window.sessionStorage.removeItem(storageKey(examId));
  } catch {
    // Nothing to clear.
  }
}
