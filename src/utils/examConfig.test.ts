// Create Examination configuration: the shared strict schema, presets, Indian formats and privacy rules.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXAM_CONFIG_MAX_BYTES, EXAM_MODES, EXAM_TYPES, FIELD_CATALOG, LOCKED_FIELD_KEYS, catalogField, customField, enabledFields,
  examCategoryFor, examConfigDateIssues, examConfigIssues, examConfigPreset, examConfigSchema, examConfigTooLarge, examDbModeFor,
  isValidIndianMobile, isValidPinCode, maskAadhaar, normalizeIndianMobile, type ExamConfig,
} from './examConfig.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const messages = (config: unknown) => examConfigIssues(config).map((item) => item.message);
const field = (config: ExamConfig, key: string) => config.form.sections.flatMap((section) => section.fields).find((item) => item.key === key)!;

test('every preset is a complete, valid configuration', () => {
  for (const type of EXAM_TYPES) {
    const preset = examConfigPreset(type);
    assert.deepEqual(examConfigIssues(preset), [], type);
    assert.equal(preset.basics.examType, type);
    assert.equal(examConfigTooLarge(preset), false, `${type} fits the size limit`);
  }
});

test('exam types and modes map to the unchanged database lists; the exact choice stays in the configuration', () => {
  const categories = new Set(['Scholarship', 'Recruitment', 'Admission', 'Mock', 'Certification', 'Other']);
  for (const type of EXAM_TYPES) assert.ok(categories.has(examCategoryFor(type)), type);
  assert.equal(examCategoryFor('hospital_recruitment'), 'Recruitment');
  assert.equal(examCategoryFor('entrance'), 'Admission');
  assert.equal(examCategoryFor('scholarship'), 'Scholarship');
  for (const mode of EXAM_MODES) assert.ok(['Online CBT', 'Offline', 'Hybrid'].includes(examDbModeFor(mode)), mode);
  assert.equal(examDbModeFor('offline_omr'), 'Offline');
  assert.equal(examDbModeFor('online_cbt'), 'Online CBT');
});

test('unknown properties are refused at every level', () => {
  const base = examConfigPreset('general');
  const top = { ...clone(base), applicants: [] };
  assert.equal(examConfigSchema.safeParse(top).success, false, 'top level');
  const nested = clone(base) as unknown as { basics: Record<string, unknown> };
  nested.basics.publishNow = true;
  assert.equal(examConfigSchema.safeParse(nested).success, false, 'basics');
  const inField = clone(base) as unknown as { form: { sections: Array<{ fields: Array<Record<string, unknown>> }> } };
  inField.form.sections[0].fields[0].value = 'Priya Sharma';
  assert.equal(examConfigSchema.safeParse(inField).success, false, 'a field cannot carry an answer');
  const inFee = clone(base) as unknown as { fees: { categories: { general: Record<string, unknown> } } };
  inFee.fees.categories.general.paid = true;
  assert.equal(examConfigSchema.safeParse(inFee).success, false, 'fees cannot carry payment state');
});

test('Aadhaar is off by default; when required, an alternative identity document must be accepted', () => {
  for (const type of EXAM_TYPES) {
    const aadhaar = field(examConfigPreset(type), 'aadhaar_number');
    assert.equal(aadhaar.enabled, false, `${type}: Aadhaar not collected by default`);
    assert.equal(aadhaar.required, false);
  }
  const config = examConfigPreset('entrance');
  Object.assign(field(config, 'aadhaar_number'), { enabled: true, required: true });
  config.form.alternativeIds = [];
  assert.ok(messages(config).some((message) => message.includes('alternative identity document')));
  config.form.alternativeIds = ['passport'];
  assert.deepEqual(examConfigIssues(config), []);
  assert.equal(maskAadhaar('1234 5678 9012'), 'XXXX XXXX 9012');
  assert.equal(maskAadhaar('123'), 'XXXX XXXX XXXX');
  const custom = examConfigPreset('general');
  custom.form.sections[0].fields.push({ ...customField('custom_field_1', 'text'), type: 'aadhaar' });
  assert.ok(messages(custom).some((message) => message.includes('built-in Aadhaar')), 'no second Aadhaar field');
});

test('full name, mobile and email are always collected and required', () => {
  assert.deepEqual([...LOCKED_FIELD_KEYS].sort(), ['email', 'full_name', 'mobile']);
  const config = examConfigPreset('general');
  field(config, 'email').required = false;
  assert.ok(messages(config).some((message) => message.includes('always collected')));
  const removed = examConfigPreset('general');
  removed.form.sections[0].fields = removed.form.sections[0].fields.filter((item) => item.key !== 'mobile');
  assert.ok(messages(removed).some((message) => message.includes('must be on the form')));
  const hidden = examConfigPreset('general');
  hidden.form.sections[0].enabled = false;
  assert.ok(messages(hidden).some((message) => message.includes('always collected')), 'the personal section cannot be switched off');
});

test('fields: built-ins keep their type, custom keys are prefixed and unique, options and limits are checked', () => {
  const retyped = examConfigPreset('general');
  field(retyped, 'pin_code').type = 'text';
  assert.ok(messages(retyped).some((message) => message.includes('keeps its type')));

  const badKey = examConfigPreset('general');
  badKey.form.sections[0].fields.push({ ...customField('hostel', 'text') });
  assert.ok(messages(badKey).some((message) => message.includes('start with "custom_"')));

  const duplicate = examConfigPreset('general');
  duplicate.form.sections[0].fields.push(customField('custom_field_1'), customField('custom_field_1'));
  assert.ok(messages(duplicate).some((message) => message.includes('different key')));

  const options = examConfigPreset('general');
  options.form.sections[0].fields.push({ ...customField('custom_field_1', 'select'), options: ['Only one'] });
  assert.ok(messages(options).some((message) => message.includes('at least two options')));

  const limits = examConfigPreset('general');
  limits.form.sections[0].fields.push({ ...customField('custom_field_1', 'number'), validation: { minLength: 3, maxLength: null, min: 10, max: 5 } });
  const limitMessages = messages(limits);
  assert.ok(limitMessages.some((message) => message.includes('text fields only')));
  assert.ok(limitMessages.some((message) => message.includes('at least the minimum value')));

  const disabledRequired = examConfigPreset('general');
  Object.assign(field(disabledRequired, 'religion'), { enabled: false, required: true });
  assert.ok(messages(disabledRequired).some((message) => message.includes('disabled field cannot be required')));

  assert.equal(catalogField('mobile', false, false).required, true, 'a locked catalogue field is always required');
  assert.equal(FIELD_CATALOG.aadhaar_number.type, 'aadhaar');
});

test('sections: custom sections hold fields; academic and document sections are filled from steps 3 and 4', () => {
  const config = examConfigPreset('general');
  config.form.sections.push({ key: 'hostel', title: 'Hostel', kind: 'fields', builtin: false, enabled: true, fields: [] });
  assert.ok(messages(config).some((message) => message.includes('Custom sections')));
  const academic = examConfigPreset('general');
  const section = academic.form.sections.find((item) => item.key === 'academic')!;
  section.fields.push(customField('custom_field_1'));
  assert.ok(messages(academic).some((message) => message.includes('filled from the qualification')));
});

test('eligibility rules are consistent', () => {
  const ages = examConfigPreset('recruitment');
  Object.assign(ages.eligibility, { minAge: 40, maxAge: 30 });
  const ageMessages = messages(ages);
  assert.ok(ageMessages.some((message) => message.includes('at least the minimum age')));
  assert.ok(ageMessages.some((message) => message.includes('age is calculated')));
  const relaxation = examConfigPreset('recruitment');
  relaxation.eligibility.ageRelaxation = [{ category: 'obc', years: 3 }];
  assert.ok(messages(relaxation).some((message) => message.includes('needs a maximum age')));
  const states = examConfigPreset('general') as unknown as { eligibility: { states: string[] } };
  states.eligibility.states = ['Atlantis'];
  assert.equal(examConfigSchema.safeParse(states).success, false, 'only real states and UTs');
});

test('hospital recruitment: posts with their own qualifications and council registration', () => {
  const config = examConfigPreset('hospital_recruitment');
  assert.ok(config.hospitalPosts.length >= 1);
  const nurse = config.hospitalPosts.find((post) => post.role === 'nurse')!;
  assert.ok(nurse.qualifications.includes('B.Sc Nursing') && nurse.qualifications.includes('GNM'));
  assert.equal(nurse.registrationRequired, true);
  assert.ok(config.documents.some((item) => item.kind === 'registration_certificate' && item.required));
  assert.equal(field(config, 'position_applied').enabled, true);
  config.hospitalPosts[0].registrationCouncil = '';
  assert.ok(messages(config).some((message) => message.includes('registration council')));
  const empty = examConfigPreset('hospital_recruitment');
  empty.hospitalPosts = [];
  assert.ok(messages(empty).some((message) => message.includes('at least one post')));
  const elsewhere = examConfigPreset('entrance');
  elsewhere.hospitalPosts = clone(examConfigPreset('hospital_recruitment').hospitalPosts);
  assert.ok(messages(elsewhere).some((message) => message.includes('only used for hospital recruitment')));
});

test('B.Sc Nursing entrance preset: Class 12 with PCB and a minimum percentage', () => {
  const config = examConfigPreset('entrance');
  const class12 = config.qualifications.find((item) => item.level === 'class_12')!;
  assert.match(class12.subjects, /PCB/);
  assert.equal(class12.minPercentage, 45);
  assert.ok(class12.details.includes('upload'));
});

test('dates and fees: windows, late fees and the exam dates agree', () => {
  const config = examConfigPreset('general');
  config.fees.categories.general.lateFee = 10_000;
  assert.ok(messages(config).some((message) => message.includes('late application deadline')));
  config.dates.lateDeadline = '2027-02-25';
  config.dates.correctionStart = '2027-02-26';
  assert.ok(messages(config).some((message) => message.includes('start and the end of the correction window')));
  config.dates.correctionEnd = '2027-02-28';
  config.dates.admitCardDate = '2027-01-01';
  config.dates.resultDate = '2027-03-01';
  assert.deepEqual(examConfigIssues(config), []);
  const exam = { appOpenDate: '2027-02-01', appCloseDate: '2027-02-20', examDate: '2027-03-15' };
  const issues = examConfigDateIssues(config, exam);
  assert.ok(issues.some((issue) => issue.includes('admit card')));
  assert.ok(issues.some((issue) => issue.includes('result declaration')));
  config.dates.admitCardDate = '2027-03-05';
  config.dates.resultDate = '2027-04-10';
  assert.deepEqual(examConfigDateIssues(config, exam), []);
  const correctionFee = examConfigPreset('general');
  correctionFee.fees.correctionFee = 5000;
  assert.ok(messages(correctionFee).some((message) => message.includes('correction window')));
  const negative = examConfigPreset('general') as unknown as { fees: { categories: { sc: { fee: number } } } };
  negative.fees.categories.sc.fee = -1;
  assert.equal(examConfigSchema.safeParse(negative).success, false);
});

test('documents: unique names and at least one format', () => {
  const config = examConfigPreset('general');
  config.documents.push(clone(config.documents[0]));
  assert.ok(messages(config).some((message) => message.includes('different name')));
  const noFormat = examConfigPreset('general');
  noFormat.documents[0].formats = [];
  assert.equal(examConfigSchema.safeParse(noFormat).success, false);
});

test('Indian mobile and PIN code formats', () => {
  for (const value of ['9876543210', '+91 98765 43210', '0987-654-3210', '919876543210']) assert.equal(normalizeIndianMobile(value), '9876543210', value);
  for (const value of ['5876543210', '987654321', '98765432100', 'abcdefghij']) assert.equal(isValidIndianMobile(value), false, value);
  for (const value of ['462001', '110001']) assert.equal(isValidPinCode(value), true, value);
  for (const value of ['062001', '46200', '4620011', 'ABCDEF']) assert.equal(isValidPinCode(value), false, value);
});

test('size limit stays below the database CHECK (65,536 bytes of jsonb text)', () => {
  assert.ok(EXAM_CONFIG_MAX_BYTES < 65_536);
  const big = examConfigPreset('general');
  big.basics.description = 'x'.repeat(2000);
  assert.equal(examConfigTooLarge(big), false);
  assert.equal(examConfigTooLarge({ blob: 'x'.repeat(EXAM_CONFIG_MAX_BYTES) }), true);
});

test('enabledFields lists only enabled fields in enabled sections', () => {
  const config = examConfigPreset('recruitment');
  const parent = config.form.sections.find((section) => section.key === 'parent')!;
  assert.equal(parent.enabled, false, 'recruitment preset hides parent details');
  const keys = enabledFields(config).map((item) => item.key);
  assert.ok(!keys.includes('father_occupation'));
  assert.ok(keys.includes('full_name') && keys.includes('mobile') && keys.includes('email'));
});
