// Institute Workspace: the configuration an Institute prepares for one examination, admission or recruitment
// notice in the "Create Examination" wizard. Shared by the screen (src/components/workspace/CreateExamWizard.tsx)
// and the server (server/instituteWorkspace.ts), which validates every save with examConfigSchema; the server
// is the authority.
//
// What this is: settings, never applicant records. It describes the application form applicants will fill in
// later (sections, fields, qualifications, documents), the eligibility rules, dates and the category-wise fee
// structure. The Institute administrator never enters an applicant's details here.
//
// What does not exist yet (and is not simulated): ELTNOY has no applicant-facing form, candidate document
// storage or fee collection for Institute examinations (candidate access is an open product decision). Fees are
// configuration only; nothing is charged, collected or marked paid.
//
// Privacy: the Aadhaar field is off by default. When an Institute enables it as required, at least one
// alternative identity document must be accepted. The configuration stores no identity numbers.
import { z } from 'zod';

export const EXAM_CONFIG_VERSION = 1 as const;
/**
 * Upper bound for the configuration as JSON text. The database CHECK allows 65,536 bytes of its own text form,
 * which adds spaces, so the API limit is lower to keep a valid save from ever hitting the CHECK.
 */
export const EXAM_CONFIG_MAX_BYTES = 49_152;

// ---------------------------------------------------------------------------------------------------------------
// Step 1: examination type and mode. The exact choice is stored here; the existing database columns get the
// nearest existing value (the category and mode lists in the database are unchanged).
// ---------------------------------------------------------------------------------------------------------------
export const EXAM_TYPES = [
  'general', 'institution_admission', 'recruitment', 'hospital_recruitment', 'entrance', 'university', 'scholarship', 'certification', 'other',
] as const;
export type ExamType = (typeof EXAM_TYPES)[number];
type DbCategory = 'Scholarship' | 'Recruitment' | 'Admission' | 'Certification' | 'Other';

export const EXAM_TYPE_INFO: Readonly<Record<ExamType, { label: string; description: string; category: DbCategory; example: string }>> = Object.freeze({
  general: { label: 'General Examination', description: 'Academic, internal or external examination', category: 'Other', example: 'Annual Internal Assessment 2027' },
  institution_admission: { label: 'Institution Admission', description: 'College, school or university admission', category: 'Admission', example: 'MP College Admission Entrance Test 2027' },
  recruitment: { label: 'Recruitment / Job', description: 'Staff, faculty or project recruitment', category: 'Recruitment', example: 'Assistant Professor Recruitment 2027' },
  hospital_recruitment: { label: 'Hospital Recruitment', description: 'Doctors, nurses, technicians and healthcare staff', category: 'Recruitment', example: 'Staff Nurse Recruitment 2027' },
  entrance: { label: 'Entrance Examination', description: 'Competitive or entrance test for courses', category: 'Admission', example: 'B.Sc Nursing Entrance Examination 2027' },
  university: { label: 'University / College Examination', description: 'Semester, annual or supplementary examination', category: 'Other', example: 'B.A. Semester III Examination 2027' },
  scholarship: { label: 'Scholarship', description: 'Merit or need-based scholarship test', category: 'Scholarship', example: 'Merit Scholarship Test 2027' },
  certification: { label: 'Certification', description: 'Skill or professional certification', category: 'Certification', example: 'Basic Life Support Certification 2027' },
  other: { label: 'Other', description: 'Any other examination or selection', category: 'Other', example: 'Departmental Promotion Examination 2027' },
});

export function examCategoryFor(type: ExamType): DbCategory {
  return EXAM_TYPE_INFO[type].category;
}

export const EXAM_MODES = ['online_cbt', 'offline_omr', 'descriptive', 'interview', 'practical', 'hybrid'] as const;
export type ExamMode = (typeof EXAM_MODES)[number];
export const EXAM_MODE_INFO: Readonly<Record<ExamMode, { label: string; dbMode: 'Online CBT' | 'Offline' | 'Hybrid' }>> = Object.freeze({
  online_cbt: { label: 'Online CBT', dbMode: 'Online CBT' },
  offline_omr: { label: 'Offline OMR', dbMode: 'Offline' },
  descriptive: { label: 'Descriptive (written)', dbMode: 'Offline' },
  interview: { label: 'Interview', dbMode: 'Offline' },
  practical: { label: 'Practical', dbMode: 'Offline' },
  hybrid: { label: 'Hybrid', dbMode: 'Hybrid' },
});

export function examDbModeFor(mode: ExamMode): 'Online CBT' | 'Offline' | 'Hybrid' {
  return EXAM_MODE_INFO[mode].dbMode;
}

export const EXAM_LEVELS = ['institute', 'university', 'district', 'state', 'national', 'other'] as const;
export const EXAM_LEVEL_LABEL: Readonly<Record<(typeof EXAM_LEVELS)[number], string>> = Object.freeze({
  institute: 'Institute level', university: 'University level', district: 'District level', state: 'State level', national: 'National level', other: 'Other',
});

// ---------------------------------------------------------------------------------------------------------------
// Step 2: the applicant form. Sections hold fields; two section kinds are filled from step 3 and 4 settings
// (academic qualifications and documents) instead of fields.
// ---------------------------------------------------------------------------------------------------------------
export const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'email', 'mobile', 'pin', 'aadhaar', 'select', 'radio', 'checkbox', 'state', 'district'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_TYPE_LABEL: Readonly<Record<FieldType, string>> = Object.freeze({
  text: 'Short text', textarea: 'Long text', number: 'Number', date: 'Date', email: 'Email address', mobile: 'Indian mobile number',
  pin: 'PIN code', aadhaar: 'Aadhaar number', select: 'Dropdown', radio: 'Single choice', checkbox: 'Multiple choice',
  state: 'State / UT (list)', district: 'District',
});
/** Types whose answers are chosen from options. */
export const OPTION_TYPES: ReadonlySet<FieldType> = new Set(['select', 'radio', 'checkbox']);
/** Custom field types an Institute may add (Aadhaar stays a single built-in field). */
export const CUSTOM_FIELD_TYPES: readonly FieldType[] = Object.freeze(FIELD_TYPES.filter((type) => type !== 'aadhaar'));

export const FIXED_FORMAT_RULE: Readonly<Partial<Record<FieldType, string>>> = Object.freeze({
  email: 'A valid email address.',
  mobile: '10-digit Indian mobile number starting with 6, 7, 8 or 9.',
  pin: '6-digit PIN code, not starting with 0.',
  aadhaar: '12 digits; shown masked (XXXX XXXX 1234) wherever it is displayed.',
  date: 'A valid date.',
  state: 'One of the 36 Indian states and union territories.',
});

export const SECTION_KINDS = ['fields', 'academic', 'documents'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

const fieldValidationSchema = z.object({
  minLength: z.number().int().min(0).max(4000).nullable(),
  maxLength: z.number().int().min(1).max(4000).nullable(),
  min: z.number().min(-1_000_000_000).max(1_000_000_000).nullable(),
  max: z.number().min(-1_000_000_000).max(1_000_000_000).nullable(),
}).strict();

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Field keys use lowercase letters, digits and underscores.');
const sectionKey = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Section keys use lowercase letters, digits and underscores.');

const fieldSchema = z.object({
  key: fieldKey,
  type: z.enum(FIELD_TYPES),
  /** Built-in fields come from FIELD_CATALOG and keep their type; custom fields start with "custom_". */
  builtin: z.boolean(),
  label: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  required: z.boolean(),
  placeholder: z.string().trim().max(120),
  helpText: z.string().trim().max(300),
  options: z.array(z.string().trim().min(1).max(100)).max(40),
  validation: fieldValidationSchema,
}).strict();
export type FormField = z.infer<typeof fieldSchema>;

const sectionSchema = z.object({
  key: sectionKey,
  title: z.string().trim().min(2).max(80),
  kind: z.enum(SECTION_KINDS),
  builtin: z.boolean(),
  enabled: z.boolean(),
  fields: z.array(fieldSchema).max(40),
}).strict();
export type FormSection = z.infer<typeof sectionSchema>;

/** Built-in fields: key → fixed type and default label. Locked fields are always enabled and required. */
export interface CatalogField { type: FieldType; label: string; section: string; locked?: boolean; placeholder?: string; helpText?: string; options?: readonly string[] }

export const CATEGORY_OPTIONS = Object.freeze(['General / UR', 'OBC', 'SC', 'ST', 'EWS']);

export const FIELD_CATALOG: Readonly<Record<string, CatalogField>> = Object.freeze({
  full_name: { type: 'text', label: 'Full name (as per identity document)', section: 'personal', locked: true, placeholder: 'e.g. Priya Sharma' },
  date_of_birth: { type: 'date', label: 'Date of birth', section: 'personal' },
  gender: { type: 'select', label: 'Gender', section: 'personal', options: ['Female', 'Male', 'Transgender'] },
  father_name: { type: 'text', label: "Father's name", section: 'personal' },
  mother_name: { type: 'text', label: "Mother's name", section: 'personal' },
  guardian_name: { type: 'text', label: "Guardian's name", section: 'personal' },
  nationality: { type: 'select', label: 'Nationality', section: 'personal', options: ['Indian', 'Other'] },
  religion: { type: 'select', label: 'Religion', section: 'personal', options: ['Hindu', 'Muslim', 'Christian', 'Sikh', 'Buddhist', 'Jain', 'Other', 'Prefer not to say'] },
  blood_group: { type: 'select', label: 'Blood group', section: 'personal', options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
  aadhaar_number: { type: 'aadhaar', label: 'Aadhaar number', section: 'personal', helpText: 'Optional unless your institution has a legal requirement. Shown masked.' },
  mobile: { type: 'mobile', label: 'Mobile number', section: 'personal', locked: true, placeholder: '10-digit mobile number' },
  email: { type: 'email', label: 'Email address', section: 'personal', locked: true, placeholder: 'name@example.com' },
  category: { type: 'select', label: 'Category', section: 'category', options: CATEGORY_OPTIONS },
  caste: { type: 'text', label: 'Caste', section: 'category', helpText: 'Ask only when the institution needs it.' },
  pwd_status: { type: 'radio', label: 'Person with disability (PwD)', section: 'category', options: ['Yes', 'No'] },
  pwd_type: { type: 'select', label: 'Type of disability', section: 'category', options: ['Locomotor', 'Visual', 'Hearing', 'Speech and language', 'Intellectual', 'Multiple', 'Other'] },
  ex_serviceman: { type: 'radio', label: 'Ex-serviceman', section: 'category', options: ['Yes', 'No'] },
  domicile_state: { type: 'state', label: 'Domicile state', section: 'category' },
  reservation_details: { type: 'textarea', label: 'Reservation / relaxation claimed (details)', section: 'category' },
  father_occupation: { type: 'text', label: "Father's occupation", section: 'parent' },
  father_contact: { type: 'mobile', label: "Father's mobile number", section: 'parent' },
  mother_occupation: { type: 'text', label: "Mother's occupation", section: 'parent' },
  mother_contact: { type: 'mobile', label: "Mother's mobile number", section: 'parent' },
  guardian_relationship: { type: 'select', label: 'Relationship with guardian', section: 'parent', options: ['Father', 'Mother', 'Brother', 'Sister', 'Uncle', 'Aunt', 'Other'] },
  emergency_contact: { type: 'mobile', label: 'Emergency contact number', section: 'parent' },
  address_line1: { type: 'text', label: 'Address line 1 (house, street)', section: 'address' },
  address_line2: { type: 'text', label: 'Address line 2 (area, landmark)', section: 'address' },
  city: { type: 'text', label: 'City / town / village', section: 'address' },
  state: { type: 'state', label: 'State / UT', section: 'address' },
  district: { type: 'district', label: 'District', section: 'address' },
  pin_code: { type: 'pin', label: 'PIN code', section: 'address' },
  permanent_same: { type: 'radio', label: 'Permanent address same as current address?', section: 'address', options: ['Yes', 'No'] },
  permanent_address: { type: 'textarea', label: 'Permanent address (if different)', section: 'address' },
  alternate_mobile: { type: 'mobile', label: 'Alternate mobile number', section: 'address' },
  position_applied: { type: 'select', label: 'Post applied for', section: 'experience', helpText: 'Options come from the posts you configure in step 3.' },
  experience_years: { type: 'number', label: 'Total experience (years)', section: 'experience' },
  current_employer: { type: 'text', label: 'Current / previous employer', section: 'experience' },
  registration_council: { type: 'text', label: 'Registration council', section: 'experience', placeholder: 'e.g. MP Nurses Registration Council' },
  registration_number: { type: 'text', label: 'Registration number', section: 'experience' },
  registration_validity: { type: 'date', label: 'Registration valid until', section: 'experience' },
  professional_certifications: { type: 'textarea', label: 'Professional certifications (e.g. BLS / ACLS)', section: 'experience' },
  shift_availability: { type: 'select', label: 'Shift availability', section: 'experience', options: ['Day', 'Night', 'Rotational'] },
});
export const LOCKED_FIELD_KEYS = Object.freeze(Object.keys(FIELD_CATALOG).filter((key) => FIELD_CATALOG[key].locked));

export const BUILTIN_SECTIONS: Readonly<Record<string, { title: string; kind: SectionKind }>> = Object.freeze({
  personal: { title: 'Personal information', kind: 'fields' },
  category: { title: 'Category & reservation', kind: 'fields' },
  parent: { title: 'Parent / guardian details', kind: 'fields' },
  address: { title: 'Address & contact', kind: 'fields' },
  academic: { title: 'Academic qualifications', kind: 'academic' },
  experience: { title: 'Experience & work details', kind: 'fields' },
  documents: { title: 'Documents upload', kind: 'documents' },
});

const emptyValidation = () => ({ minLength: null, maxLength: null, min: null, max: null });

/** A built-in field as the catalogue defines it (enabled and requirement chosen by the caller). */
export function catalogField(key: string, enabled: boolean, required: boolean): FormField {
  const info = FIELD_CATALOG[key];
  if (!info) throw new Error(`Unknown built-in field ${key}`);
  return {
    key, type: info.type, builtin: true, label: info.label, enabled: enabled || Boolean(info.locked), required: required || Boolean(info.locked),
    placeholder: info.placeholder ?? '', helpText: info.helpText ?? '', options: [...(info.options ?? [])],
    validation: info.type === 'text' ? { ...emptyValidation(), maxLength: 120 } : emptyValidation(),
  };
}

/** A new custom field for the Institute to edit. */
export function customField(key: string, type: FieldType = 'text'): FormField {
  return {
    key, type, builtin: false, label: 'New field', enabled: true, required: false, placeholder: '', helpText: '',
    options: OPTION_TYPES.has(type) ? ['Option 1', 'Option 2'] : [], validation: emptyValidation(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Indian formats (applied to applicant answers once an applicant form exists; shown as rules in the preview).
// ---------------------------------------------------------------------------------------------------------------
export function normalizeIndianMobile(value: string): string | null {
  const digits = value.replace(/[\s-]/g, '');
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits);
  return match ? match[1] : null;
}
export function isValidIndianMobile(value: string): boolean {
  return normalizeIndianMobile(value) !== null;
}
export function isValidPinCode(value: string): boolean {
  return /^[1-9]\d{5}$/.test(value.trim());
}
/** Aadhaar for display: only the last four digits, never the full number. */
export function maskAadhaar(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 12 ? `XXXX XXXX ${digits.slice(8)}` : 'XXXX XXXX XXXX';
}

export const INDIAN_STATES_AND_UTS = Object.freeze([
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry',
] as const);

export const ALTERNATIVE_IDS = ['pan', 'voter_id', 'passport', 'driving_licence'] as const;
export const ALTERNATIVE_ID_LABEL: Readonly<Record<(typeof ALTERNATIVE_IDS)[number], string>> = Object.freeze({
  pan: 'PAN card', voter_id: 'Voter ID', passport: 'Passport', driving_licence: 'Driving licence',
});

// ---------------------------------------------------------------------------------------------------------------
// Step 3: qualifications, eligibility and (hospital recruitment) posts.
// ---------------------------------------------------------------------------------------------------------------
export const QUALIFICATION_LEVELS = ['class_10', 'class_12', 'diploma', 'graduation', 'post_graduation', 'professional', 'other'] as const;
export const QUALIFICATION_LABEL: Readonly<Record<(typeof QUALIFICATION_LEVELS)[number], string>> = Object.freeze({
  class_10: 'Class 10', class_12: 'Class 12', diploma: 'Diploma', graduation: 'Graduation',
  post_graduation: 'Post Graduation', professional: 'Professional qualification', other: 'Other qualification',
});
export const QUALIFICATION_DETAILS = ['board_university', 'institution', 'passing_year', 'roll_number', 'total_marks', 'obtained_marks', 'percentage', 'cgpa', 'subjects', 'upload'] as const;
export const QUALIFICATION_DETAIL_LABEL: Readonly<Record<(typeof QUALIFICATION_DETAILS)[number], string>> = Object.freeze({
  board_university: 'Board / university', institution: 'School / college', passing_year: 'Passing year', roll_number: 'Roll number',
  total_marks: 'Total marks', obtained_marks: 'Obtained marks', percentage: 'Percentage', cgpa: 'CGPA', subjects: 'Subjects',
  upload: 'Upload marksheet / certificate',
});

export const GENDERS = ['female', 'male', 'transgender'] as const;
export const GENDER_LABEL: Readonly<Record<(typeof GENDERS)[number], string>> = Object.freeze({ female: 'Female', male: 'Male', transgender: 'Transgender' });

export const RESERVATION_CATEGORIES = ['general', 'obc', 'sc', 'st', 'ews', 'pwd'] as const;
export type ReservationCategory = (typeof RESERVATION_CATEGORIES)[number];
export const RESERVATION_LABEL: Readonly<Record<ReservationCategory, string>> = Object.freeze({
  general: 'General / UR', obc: 'OBC', sc: 'SC', st: 'ST', ews: 'EWS', pwd: 'PwD',
});

export const EMPLOYMENT_TYPES = ['not_applicable', 'permanent', 'contractual', 'temporary'] as const;
export const EMPLOYMENT_TYPE_LABEL: Readonly<Record<(typeof EMPLOYMENT_TYPES)[number], string>> = Object.freeze({
  not_applicable: 'Not applicable', permanent: 'Permanent', contractual: 'Contractual', temporary: 'Temporary',
});

export const HOSPITAL_ROLES = ['doctor', 'medical_officer', 'specialist', 'nurse', 'pharmacist', 'lab_technician', 'radiology_technician', 'physiotherapist', 'administration', 'other'] as const;
export const HOSPITAL_ROLE_LABEL: Readonly<Record<(typeof HOSPITAL_ROLES)[number], string>> = Object.freeze({
  doctor: 'Doctor', medical_officer: 'Medical Officer', specialist: 'Specialist', nurse: 'Nurse', pharmacist: 'Pharmacist',
  lab_technician: 'Lab Technician', radiology_technician: 'Radiology Technician', physiotherapist: 'Physiotherapist',
  administration: 'Hospital Administration', other: 'Other staff',
});
export const HOSPITAL_QUALIFICATIONS = ['MBBS', 'MD / MS', 'DNB', 'BDS', 'MDS', 'BAMS', 'BHMS', 'BUMS', 'B.Sc Nursing', 'M.Sc Nursing', 'Post Basic B.Sc Nursing', 'GNM', 'ANM', 'D.Pharm', 'B.Pharm', 'DMLT', 'B.Sc MLT', 'Radiology / Imaging diploma', 'BPT', 'MPT', 'MHA / Hospital Administration', 'Other'] as const;
export const HOSPITAL_ROLE_SUGGESTIONS: Readonly<Record<(typeof HOSPITAL_ROLES)[number], readonly (typeof HOSPITAL_QUALIFICATIONS)[number][]>> = Object.freeze({
  doctor: ['MBBS'], medical_officer: ['MBBS'], specialist: ['MD / MS', 'DNB'], nurse: ['B.Sc Nursing', 'GNM'],
  pharmacist: ['D.Pharm', 'B.Pharm'], lab_technician: ['DMLT', 'B.Sc MLT'], radiology_technician: ['Radiology / Imaging diploma'],
  physiotherapist: ['BPT'], administration: ['MHA / Hospital Administration'], other: [],
});

// ---------------------------------------------------------------------------------------------------------------
// Step 4: documents and fees. Fees are configuration only: no payment is collected or verified.
// ---------------------------------------------------------------------------------------------------------------
export const DOCUMENT_KINDS = [
  'photo', 'signature', 'identity_proof', 'class_10_certificate', 'class_12_marksheet', 'graduation_certificate', 'category_certificate',
  'pwd_certificate', 'domicile_certificate', 'experience_certificate', 'medical_certificate', 'registration_certificate', 'other',
] as const;
export const DOCUMENT_KIND_LABEL: Readonly<Record<(typeof DOCUMENT_KINDS)[number], string>> = Object.freeze({
  photo: 'Photograph', signature: 'Signature', identity_proof: 'Aadhaar / identity document', class_10_certificate: 'Class 10 certificate',
  class_12_marksheet: 'Class 12 marksheet', graduation_certificate: 'Graduation certificate', category_certificate: 'Category certificate',
  pwd_certificate: 'Disability certificate', domicile_certificate: 'Domicile certificate', experience_certificate: 'Experience certificate',
  medical_certificate: 'Medical fitness certificate', registration_certificate: 'Registration certificate', other: 'Other document',
});
export const DOCUMENT_FORMATS = ['pdf', 'jpg', 'png'] as const;
export const MAX_FEE_PAISE = 100_000_000;

// ---------------------------------------------------------------------------------------------------------------
// Schema. Every object is strict: unknown fields are refused.
// ---------------------------------------------------------------------------------------------------------------
const text = (max: number) => z.string().trim().max(max);
const isoDate = z.string().date();
const paise = z.number().int().min(0).max(MAX_FEE_PAISE);

const qualificationSchema = z.object({
  level: z.enum(QUALIFICATION_LEVELS),
  label: z.string().trim().min(2).max(80),
  required: z.boolean(),
  details: z.array(z.enum(QUALIFICATION_DETAILS)).max(QUALIFICATION_DETAILS.length),
  minPercentage: z.number().min(0).max(100).nullable(),
  minCgpa: z.number().min(0).max(10).nullable(),
  subjects: text(200),
  notes: text(300),
}).strict();

const documentSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  label: z.string().trim().min(2).max(80),
  required: z.boolean(),
  formats: z.array(z.enum(DOCUMENT_FORMATS)).min(1).max(DOCUMENT_FORMATS.length),
  maxSizeKb: z.number().int().min(10).max(5120),
  description: text(300),
}).strict();

const hospitalPostSchema = z.object({
  title: z.string().trim().min(2).max(120),
  role: z.enum(HOSPITAL_ROLES),
  department: text(120),
  vacancies: z.number().int().min(0).max(100_000).nullable(),
  qualifications: z.array(z.enum(HOSPITAL_QUALIFICATIONS)).max(HOSPITAL_QUALIFICATIONS.length),
  specialization: text(160),
  registrationRequired: z.boolean(),
  registrationCouncil: text(160),
  minExperienceYears: z.number().min(0).max(50).nullable(),
  otherRequirements: text(1000),
}).strict();

const feeRowSchema = z.object({ fee: paise, lateFee: paise }).strict();

export const examConfigSchema = z.object({
  version: z.literal(EXAM_CONFIG_VERSION),
  basics: z.object({
    examType: z.enum(EXAM_TYPES),
    mode: z.enum(EXAM_MODES),
    conductingUnit: text(160),
    examLevel: z.enum(EXAM_LEVELS),
    description: text(2000),
  }).strict(),
  form: z.object({
    sections: z.array(sectionSchema).min(1).max(12),
    alternativeIds: z.array(z.enum(ALTERNATIVE_IDS)).max(ALTERNATIVE_IDS.length),
    declaration: text(2000),
    consentRequired: z.boolean(),
  }).strict(),
  eligibility: z.object({
    minAge: z.number().int().min(0).max(100).nullable(),
    maxAge: z.number().int().min(0).max(100).nullable(),
    ageAsOn: isoDate.nullable(),
    ageRelaxation: z.array(z.object({ category: z.enum(RESERVATION_CATEGORIES), years: z.number().int().min(1).max(20) }).strict()).max(RESERVATION_CATEGORIES.length),
    genders: z.array(z.enum(GENDERS)).max(GENDERS.length),
    categories: z.array(z.enum(RESERVATION_CATEGORIES)).max(RESERVATION_CATEGORIES.length),
    nationality: text(160),
    domicile: text(300),
    states: z.array(z.enum(INDIAN_STATES_AND_UTS)).max(INDIAN_STATES_AND_UTS.length),
    districts: text(500),
    minPercentage: z.number().min(0).max(100).nullable(),
    minCgpa: z.number().min(0).max(10).nullable(),
    requiredSubjects: text(300),
    requiredQualification: text(500),
    pwdEligible: z.boolean(),
    exServicemanEligible: z.boolean(),
    experienceRequired: z.boolean(),
    minExperienceYears: z.number().min(0).max(50).nullable(),
    experienceDetails: text(1000),
    medicalFitnessRequired: z.boolean(),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    otherCriteria: text(2000),
  }).strict(),
  qualifications: z.array(qualificationSchema).max(10),
  hospitalPosts: z.array(hospitalPostSchema).max(20),
  dates: z.object({
    lateDeadline: isoDate.nullable(),
    correctionStart: isoDate.nullable(),
    correctionEnd: isoDate.nullable(),
    admitCardDate: isoDate.nullable(),
    resultDate: isoDate.nullable(),
  }).strict(),
  fees: z.object({
    categories: z.object(Object.fromEntries(RESERVATION_CATEGORIES.map((key) => [key, feeRowSchema])) as Record<ReservationCategory, typeof feeRowSchema>).strict(),
    correctionFee: paise.nullable(),
    exemptionNotes: text(1000),
  }).strict(),
  documents: z.array(documentSchema).max(20),
}).strict().superRefine((config, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  const sectionKeys = new Set<string>();
  const fieldKeys = new Set<string>();
  let totalFields = 0;
  config.form.sections.forEach((section, sectionIndex) => {
    const at = ['form', 'sections', sectionIndex];
    if (sectionKeys.has(section.key)) issue([...at, 'key'], 'Each section needs a different key.');
    sectionKeys.add(section.key);
    const builtin = BUILTIN_SECTIONS[section.key];
    if (section.builtin && !builtin) issue([...at, 'key'], 'Unknown built-in section.');
    if (section.builtin && builtin && builtin.kind !== section.kind) issue([...at, 'kind'], 'A built-in section keeps its kind.');
    if (!section.builtin && (!section.key.startsWith('custom_') || section.kind !== 'fields')) issue([...at, 'key'], 'Custom sections hold fields and have keys starting with "custom_".');
    if (section.kind !== 'fields' && section.fields.length > 0) issue([...at, 'fields'], 'This section is filled from the qualification or document settings.');
    section.fields.forEach((field, fieldIndex) => {
      const fat = [...at, 'fields', fieldIndex];
      totalFields += 1;
      if (fieldKeys.has(field.key)) issue([...fat, 'key'], 'Each field needs a different key.');
      fieldKeys.add(field.key);
      const info = FIELD_CATALOG[field.key];
      if (field.builtin && !info) issue([...fat, 'key'], 'Unknown built-in field.');
      if (field.builtin && info && info.type !== field.type) issue([...fat, 'type'], 'A built-in field keeps its type.');
      if (!field.builtin && !field.key.startsWith('custom_')) issue([...fat, 'key'], 'Custom field keys start with "custom_".');
      if (!field.builtin && field.type === 'aadhaar') issue([...fat, 'type'], 'Use the built-in Aadhaar field.');
      if (info?.locked && (!field.enabled || !field.required || !section.enabled)) issue([...fat, 'required'], `${info.label} is always collected and required.`);
      if (field.required && !field.enabled) issue([...fat, 'required'], 'A disabled field cannot be required.');
      if (OPTION_TYPES.has(field.type) && field.options.length < 2 && field.key !== 'position_applied') issue([...fat, 'options'], 'Give at least two options.');
      if (!OPTION_TYPES.has(field.type) && field.options.length > 0) issue([...fat, 'options'], 'Only choice fields have options.');
      if (new Set(field.options.map((option) => option.toLowerCase())).size !== field.options.length) issue([...fat, 'options'], 'Each option must be different.');
      const v = field.validation;
      const lengthType = field.type === 'text' || field.type === 'textarea';
      if (!lengthType && (v.minLength !== null || v.maxLength !== null)) issue([...fat, 'validation'], 'Length limits apply to text fields only.');
      if (field.type !== 'number' && (v.min !== null || v.max !== null)) issue([...fat, 'validation'], 'Value limits apply to number fields only.');
      if (v.minLength !== null && v.maxLength !== null && v.minLength > v.maxLength) issue([...fat, 'validation'], 'Maximum length must be at least the minimum length.');
      if (v.min !== null && v.max !== null && v.min > v.max) issue([...fat, 'validation'], 'Maximum value must be at least the minimum value.');
    });
  });
  if (totalFields > 150) issue(['form', 'sections'], 'A form can have at most 150 fields.');
  for (const key of LOCKED_FIELD_KEYS) {
    if (!fieldKeys.has(key)) issue(['form', 'sections'], `${FIELD_CATALOG[key].label} must be on the form.`);
  }
  const aadhaar = config.form.sections.flatMap((section) => section.fields).find((field) => field.key === 'aadhaar_number');
  if (aadhaar?.enabled && aadhaar.required && config.form.alternativeIds.length === 0) {
    issue(['form', 'alternativeIds'], 'When Aadhaar is required, accept at least one alternative identity document.');
  }
  if (new Set(config.form.alternativeIds).size !== config.form.alternativeIds.length) issue(['form', 'alternativeIds'], 'Each identity document can be listed once.');
  if (config.form.consentRequired && config.form.declaration.length < 10) issue(['form', 'declaration'], 'Write the declaration the applicant must accept.');

  const e = config.eligibility;
  if (e.minAge !== null && e.maxAge !== null && e.minAge > e.maxAge) issue(['eligibility', 'maxAge'], 'Maximum age must be at least the minimum age.');
  if ((e.minAge !== null || e.maxAge !== null) && e.ageAsOn === null) issue(['eligibility', 'ageAsOn'], 'Give the date on which age is calculated.');
  if (e.ageRelaxation.length > 0 && e.maxAge === null) issue(['eligibility', 'ageRelaxation'], 'Age relaxation needs a maximum age.');
  for (const [name, list] of [['ageRelaxation', e.ageRelaxation.map((item) => item.category)], ['genders', e.genders], ['categories', e.categories], ['states', e.states]] as const) {
    if (new Set(list).size !== list.length) issue(['eligibility', name], 'Each value can be listed once.');
  }
  if (e.experienceRequired && e.minExperienceYears === null && e.experienceDetails.length < 3) issue(['eligibility', 'minExperienceYears'], 'Give the minimum experience or describe it.');

  const levels = config.qualifications.filter((item) => item.level !== 'other' && item.level !== 'professional').map((item) => item.level);
  if (new Set(levels).size !== levels.length) issue(['qualifications'], 'Each qualification level can be listed once (use "Professional" or "Other" for more).');
  config.qualifications.forEach((item, index) => {
    if (new Set(item.details).size !== item.details.length) issue(['qualifications', index, 'details'], 'Each detail can be listed once.');
  });

  if (config.basics.examType === 'hospital_recruitment') {
    if (config.hospitalPosts.length === 0) issue(['hospitalPosts'], 'Add at least one post for a hospital recruitment.');
  } else if (config.hospitalPosts.length > 0) {
    issue(['hospitalPosts'], 'Posts are only used for hospital recruitment.');
  }
  config.hospitalPosts.forEach((post, index) => {
    if (post.registrationRequired && post.registrationCouncil.length < 2) issue(['hospitalPosts', index, 'registrationCouncil'], 'Name the registration council for this post.');
  });

  const d = config.dates;
  if ((d.correctionStart === null) !== (d.correctionEnd === null)) issue(['dates', 'correctionEnd'], 'Give both the start and the end of the correction window.');
  if (d.correctionStart !== null && d.correctionEnd !== null && d.correctionEnd < d.correctionStart) issue(['dates', 'correctionEnd'], 'The correction window must end on or after it starts.');
  if (config.fees.correctionFee !== null && d.correctionStart === null) issue(['fees', 'correctionFee'], 'A correction fee needs a correction window.');
  const lateFees = RESERVATION_CATEGORIES.some((key) => config.fees.categories[key].lateFee > 0);
  if (lateFees && d.lateDeadline === null) issue(['fees'], 'Late fees need a late application deadline.');

  const labels = config.documents.map((item) => item.label.toLowerCase());
  if (new Set(labels).size !== labels.length) issue(['documents'], 'Each document needs a different name.');
  config.documents.forEach((item, index) => {
    if (new Set(item.formats).size !== item.formats.length) issue(['documents', index, 'formats'], 'Each file format can be listed once.');
  });
});

export type ExamConfig = z.infer<typeof examConfigSchema>;
export type QualificationRule = ExamConfig['qualifications'][number];
export type DocumentRule = ExamConfig['documents'][number];
export type HospitalPost = ExamConfig['hospitalPosts'][number];

/** Checks the configuration against the examination's own dates (those are exam columns, outside the config). */
export function examConfigDateIssues(config: ExamConfig, exam: { appOpenDate: string; appCloseDate: string; examDate: string }): string[] {
  const issues: string[] = [];
  const d = config.dates;
  if (d.lateDeadline !== null && (d.lateDeadline < exam.appCloseDate || d.lateDeadline > exam.examDate)) {
    issues.push('The late application deadline must fall between the application end date and the exam date.');
  }
  if (d.correctionStart !== null && d.correctionEnd !== null && (d.correctionStart < exam.appOpenDate || d.correctionEnd > exam.examDate)) {
    issues.push('The correction window must fall between the application start date and the exam date.');
  }
  if (d.admitCardDate !== null && (d.admitCardDate < exam.appCloseDate || d.admitCardDate > exam.examDate)) {
    issues.push('The admit card release date must fall between the application end date and the exam date.');
  }
  if (d.resultDate !== null && d.resultDate < exam.examDate) {
    issues.push('The result declaration date must be on or after the exam date.');
  }
  if (config.eligibility.ageAsOn !== null && config.eligibility.ageAsOn > exam.examDate) {
    issues.push('The age calculation date must be on or before the exam date.');
  }
  return issues;
}

export function examConfigTooLarge(config: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(config)).length > EXAM_CONFIG_MAX_BYTES;
}

/** Plain-language list of configuration problems (the wizard shows these; the server sends its own). */
export function examConfigIssues(config: unknown): { path: string; message: string }[] {
  const parsed = examConfigSchema.safeParse(config);
  if (parsed.success) return [];
  return parsed.error.issues.map((item) => ({ path: item.path.join('.'), message: item.message }));
}

/** Fields shown to applicants (enabled fields in enabled sections). */
export function enabledFields(config: ExamConfig): FormField[] {
  return config.form.sections.filter((section) => section.enabled).flatMap((section) => section.fields.filter((field) => field.enabled));
}

export function formFieldCounts(config: ExamConfig): { enabled: number; required: number } {
  const fields = enabledFields(config);
  return { enabled: fields.length, required: fields.filter((field) => field.required).length };
}

// ---------------------------------------------------------------------------------------------------------------
// Presets. A preset only pre-fills the wizard; the Institute reviews and changes everything before saving, and
// the server validates the result like any other configuration.
// ---------------------------------------------------------------------------------------------------------------
type FieldPlan = Record<string, 'required' | 'optional'>;

const PERSONAL: FieldPlan = { full_name: 'required', date_of_birth: 'required', gender: 'required', father_name: 'required', mother_name: 'required', guardian_name: 'optional', nationality: 'required', mobile: 'required', email: 'required' };
const CATEGORY: FieldPlan = { category: 'required', pwd_status: 'required', pwd_type: 'optional' };
const PARENT: FieldPlan = { father_occupation: 'optional', mother_occupation: 'optional', guardian_relationship: 'optional', emergency_contact: 'optional' };
const ADDRESS: FieldPlan = { address_line1: 'required', address_line2: 'optional', city: 'required', state: 'required', district: 'required', pin_code: 'required', permanent_same: 'required', permanent_address: 'optional', alternate_mobile: 'optional' };
const JOB_EXPERIENCE: FieldPlan = { experience_years: 'optional', current_employer: 'optional' };
const HOSPITAL_EXPERIENCE: FieldPlan = { position_applied: 'required', experience_years: 'required', current_employer: 'optional', registration_council: 'required', registration_number: 'required', registration_validity: 'required', professional_certifications: 'optional', shift_availability: 'optional' };

function fieldsSection(key: string, plan: FieldPlan, enabled = true): FormSection {
  const catalogKeys = Object.keys(FIELD_CATALOG).filter((name) => FIELD_CATALOG[name].section === key);
  return {
    key, title: BUILTIN_SECTIONS[key].title, kind: 'fields', builtin: true, enabled,
    fields: catalogKeys.map((name) => catalogField(name, name in plan, plan[name] === 'required')),
  };
}

const qualification = (level: QualificationRule['level'], required: boolean, extra: Partial<QualificationRule> = {}): QualificationRule => ({
  level, label: QUALIFICATION_LABEL[level], required,
  details: ['board_university', 'institution', 'passing_year', 'roll_number', 'total_marks', 'obtained_marks', 'percentage', 'upload'],
  minPercentage: null, minCgpa: null, subjects: '', notes: '', ...extra,
});

const document = (kind: DocumentRule['kind'], required: boolean, description = ''): DocumentRule => ({
  kind, label: DOCUMENT_KIND_LABEL[kind], required,
  formats: kind === 'photo' || kind === 'signature' ? ['jpg', 'png'] : ['pdf', 'jpg', 'png'],
  maxSizeKb: kind === 'photo' || kind === 'signature' ? 200 : 1024,
  description: kind === 'photo' ? 'Recent passport-size colour photograph with a white background.' : kind === 'signature' ? 'Signature in black or blue ink on white paper.' : description,
});

export function hospitalPost(role: HospitalPost['role'], title: string = HOSPITAL_ROLE_LABEL[role]): HospitalPost {
  const registered = ['doctor', 'medical_officer', 'specialist', 'nurse', 'pharmacist', 'physiotherapist'].includes(role);
  return {
    title, role, department: '', vacancies: null, qualifications: [...HOSPITAL_ROLE_SUGGESTIONS[role]], specialization: '',
    registrationRequired: registered,
    registrationCouncil: role === 'nurse' ? 'State Nursing Council' : role === 'pharmacist' ? 'State Pharmacy Council' : registered ? 'National Medical Commission / State Medical Council' : '',
    minExperienceYears: null, otherRequirements: '',
  };
}

const DECLARATION = 'I declare that the information given in this application is true, complete and correct to the best of my knowledge. I understand that any false information may lead to rejection of my application or cancellation of my candidature at any stage.';

/** A complete, valid configuration for an examination type: the wizard's starting point. */
export function examConfigPreset(type: ExamType): ExamConfig {
  const isJob = type === 'recruitment' || type === 'hospital_recruitment';
  const isHospital = type === 'hospital_recruitment';
  const qualifications: QualificationRule[] = ({
    general: [qualification('class_12', false)],
    institution_admission: [qualification('class_10', true), qualification('class_12', true)],
    recruitment: [qualification('graduation', true), qualification('post_graduation', false)],
    hospital_recruitment: [qualification('class_12', true), qualification('professional', true, { label: 'Nursing / medical qualification for the post', details: ['board_university', 'institution', 'passing_year', 'percentage', 'upload'] })],
    entrance: [qualification('class_10', true), qualification('class_12', true, { subjects: 'Physics, Chemistry, Biology (PCB)', minPercentage: 45 })],
    university: [qualification('class_12', true), qualification('graduation', false, { details: ['board_university', 'institution', 'passing_year', 'roll_number', 'percentage', 'cgpa', 'upload'] })],
    scholarship: [qualification('class_10', true), qualification('class_12', false)],
    certification: [qualification('class_12', false)],
    other: [],
  } as Record<ExamType, QualificationRule[]>)[type];
  const documents: DocumentRule[] = [
    document('photo', true), document('signature', true), document('identity_proof', true, 'Aadhaar or any accepted identity document.'),
    ...(type === 'other' || type === 'certification' ? [] : [document('class_10_certificate', true, 'Used as proof of date of birth.')]),
    ...(['institution_admission', 'entrance', 'hospital_recruitment', 'university'].includes(type) ? [document('class_12_marksheet', true)] : []),
    ...(type === 'recruitment' ? [document('graduation_certificate', true)] : []),
    document('category_certificate', false, 'Only for applicants claiming a reserved category.'),
    document('pwd_certificate', false, 'Only for applicants claiming PwD status.'),
    ...(isJob ? [document('experience_certificate', isHospital)] : []),
    ...(isHospital ? [document('registration_certificate', true, 'Valid registration with the council named for the post.'), document('medical_certificate', false)] : []),
  ];
  const sections: FormSection[] = [
    fieldsSection('personal', PERSONAL),
    fieldsSection('category', isJob ? { ...CATEGORY, ex_serviceman: 'required' } : CATEGORY),
    fieldsSection('parent', PARENT, !isJob),
    fieldsSection('address', ADDRESS),
    { key: 'academic', title: BUILTIN_SECTIONS.academic.title, kind: 'academic', builtin: true, enabled: qualifications.length > 0, fields: [] },
    fieldsSection('experience', isHospital ? HOSPITAL_EXPERIENCE : JOB_EXPERIENCE, isJob),
    { key: 'documents', title: BUILTIN_SECTIONS.documents.title, kind: 'documents', builtin: true, enabled: true, fields: [] },
  ];
  const fee = { fee: 0, lateFee: 0 };
  return {
    version: EXAM_CONFIG_VERSION,
    basics: { examType: type, mode: isJob ? 'offline_omr' : 'online_cbt', conductingUnit: '', examLevel: type === 'university' ? 'university' : 'institute', description: '' },
    form: { sections, alternativeIds: [...ALTERNATIVE_IDS], declaration: DECLARATION, consentRequired: true },
    eligibility: {
      minAge: null, maxAge: null, ageAsOn: null, ageRelaxation: [], genders: [], categories: [], nationality: 'Indian', domicile: '', states: [],
      districts: '', minPercentage: null, minCgpa: null, requiredSubjects: type === 'entrance' ? 'Physics, Chemistry, Biology (PCB) in Class 12' : '',
      requiredQualification: isHospital ? 'GNM or B.Sc Nursing from a recognised institution, with valid registration' : '',
      pwdEligible: true, exServicemanEligible: isJob, experienceRequired: false, minExperienceYears: null, experienceDetails: '',
      medicalFitnessRequired: isHospital, employmentType: isJob ? 'permanent' : 'not_applicable', otherCriteria: '',
    },
    qualifications,
    hospitalPosts: isHospital ? [hospitalPost('nurse', 'Staff Nurse'), hospitalPost('medical_officer')] : [],
    dates: { lateDeadline: null, correctionStart: null, correctionEnd: null, admitCardDate: null, resultDate: null },
    fees: { categories: { general: { ...fee }, obc: { ...fee }, sc: { ...fee }, st: { ...fee }, ews: { ...fee }, pwd: { ...fee } }, correctionFee: null, exemptionNotes: '' },
    documents,
  };
}
