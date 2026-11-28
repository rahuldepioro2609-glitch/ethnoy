// Create Examination wizard: step navigation rules, draft round trip, form designer helpers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { examConfigIssues, examConfigPreset } from './examConfig.ts';
import {
  WIZARD_STEPS, addCustomField, addCustomSection, applyExamType, canSaveDraft, defaultAcademicYear, draftFromExam, eligibilitySummary,
  fieldOptionsForPreview, moveItem, newDraft, nextCustomKey, paiseFromRupees, removeCustomField, removeSection, requestBody,
  retypeCustomField, stepIssues, updateField, type WizardDraft,
} from './examWizard.ts';

const ready = (): WizardDraft => ({
  ...newDraft('entrance'), examCode: 'nur-2027', title: 'B.Sc Nursing Entrance Examination 2027', academicYear: '2026-27',
  appOpenDate: '2027-02-01', appCloseDate: '2027-02-20', examDate: '2027-03-15', examTime: '10:00', durationMinutes: '120',
});

test('five steps in the order of the reference design', () => {
  assert.deepEqual(WIZARD_STEPS.map((step) => step.key), ['details', 'form', 'eligibility', 'setup', 'preview']);
});

test('step 1 must be complete before a draft can be saved', () => {
  const draft = newDraft();
  assert.equal(canSaveDraft(draft), false);
  const issues = stepIssues(draft, 'details');
  assert.ok(issues.some((issue) => issue.includes('title')));
  assert.ok(issues.some((issue) => issue.includes('examination code')));
  assert.ok(issues.some((issue) => issue.includes('application start and end dates')));
  assert.equal(canSaveDraft(ready()), true);
  assert.ok(stepIssues({ ...ready(), appCloseDate: '2027-01-01' }, 'details').some((issue) => issue.includes('on or after the start date')));
  assert.ok(stepIssues({ ...ready(), examDate: '2027-02-10' }, 'details').some((issue) => issue.includes('on or after the application end date')));
  assert.ok(stepIssues({ ...ready(), examCode: 'bad code!' }, 'details').some((issue) => issue.includes('examination code')));
  assert.ok(stepIssues({ ...ready(), durationMinutes: '5' }, 'details').some((issue) => issue.includes('10 and 600')));
  const early = ready();
  early.config.dates.resultDate = '2027-03-01';
  assert.ok(stepIssues(early, 'details').some((issue) => issue.includes('result declaration')), 'step 1 catches a result date before the exam');
  assert.deepEqual(stepIssues({ ...ready(), examId: '00000000-0000-4000-8000-000000000001', examCode: '' }, 'details'), [], 'the code is fixed after the first save');
});

test('each step reports only its own configuration problems', () => {
  const draft = ready();
  draft.config.eligibility.minAge = 18; // no age calculation date
  assert.deepEqual(stepIssues(draft, 'form'), []);
  assert.ok(stepIssues(draft, 'eligibility').some((issue) => issue.includes('age is calculated')));
  assert.ok(stepIssues(draft, 'preview').length > 0, 'the final step checks everything');
  const setup = ready();
  setup.config.dates.resultDate = '2027-03-01';
  assert.ok(stepIssues(setup, 'setup').some((issue) => issue.includes('result declaration')));
  assert.deepEqual(stepIssues(ready(), 'preview'), []);
});

test('request body: a new exam sends its code; an edit sends the version it loaded instead', () => {
  const draft = ready();
  const created = requestBody(draft, false);
  assert.equal(created.examCode, 'NUR-2027');
  assert.equal(created.expectedUpdatedAt, undefined);
  assert.equal(created.submitForApproval, false);
  assert.equal(typeof created.eligibility, 'string');
  assert.ok((created.eligibility as string).length >= 2);
  const edited = requestBody({ ...draft, examId: 'exam-1', expectedUpdatedAt: '2026-11-28T10:00:00.000Z' }, true);
  assert.equal(edited.examCode, undefined);
  assert.equal(edited.expectedUpdatedAt, '2026-11-28T10:00:00.000Z');
  assert.equal(edited.submitForApproval, true);
  assert.deepEqual(Object.keys(created).sort(), ['academicYear', 'appCloseDate', 'appOpenDate', 'config', 'durationMinutes', 'eligibility', 'examCode', 'examDate', 'examTime', 'instructions', 'submitForApproval', 'title'], 'only exam settings; no applicant data');
});

test('reopening a saved draft restores everything; an exam from before the wizard gets a preset', () => {
  const draft = ready();
  draft.config.basics.conductingUnit = 'Institute of Medical Sciences';
  const exam = {
    id: 'exam-1', exam_code: 'NUR-2027', title: draft.title, category: 'Admission', mode: 'Online CBT', eligibility: 'Class 12 PCB',
    academic_year: '2026-27', app_open_date: '2027-02-01', app_close_date: '2027-02-20', exam_date: '2027-03-15', exam_time: '10:00',
    duration_minutes: 120, instructions: 'Read carefully', lifecycle_status: 'needs_changes', status_reason: 'Add the fee table',
    exam_config_json: draft.config, updated_at: '2026-11-28T10:00:00.000Z',
  };
  const reopened = draftFromExam(exam);
  assert.equal(reopened.legacy, false);
  assert.deepEqual(reopened.config, draft.config);
  assert.equal(reopened.expectedUpdatedAt, '2026-11-28T10:00:00.000Z');
  assert.equal(reopened.statusReason, 'Add the fee table');
  const legacy = draftFromExam({ ...exam, exam_config_json: {}, category: 'Recruitment', mode: 'Hybrid' });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.config.basics.examType, 'recruitment');
  assert.equal(legacy.config.basics.mode, 'hybrid');
  assert.deepEqual(examConfigIssues(legacy.config), []);
});

test('changing the type replaces the suggested form but keeps details, dates and fees', () => {
  const draft = ready();
  draft.config.basics.conductingUnit = 'Nursing College';
  draft.config.basics.mode = 'descriptive';
  draft.config.fees.categories.general.fee = 50_000;
  draft.config.dates.resultDate = '2027-04-01';
  const switched = applyExamType(draft, 'hospital_recruitment');
  assert.equal(switched.config.basics.examType, 'hospital_recruitment');
  assert.equal(switched.config.basics.conductingUnit, 'Nursing College');
  assert.equal(switched.config.basics.mode, 'descriptive');
  assert.equal(switched.config.fees.categories.general.fee, 50_000);
  assert.equal(switched.config.dates.resultDate, '2027-04-01');
  assert.ok(switched.config.hospitalPosts.length > 0);
  assert.equal(switched.title, draft.title);
});

test('form designer: add, edit, move and remove sections and custom fields', () => {
  let config = examConfigPreset('general');
  config = addCustomSection(config, 'Hostel requirement');
  const section = config.form.sections.at(-1)!;
  assert.equal(section.key, 'custom_section_1');
  assert.equal(section.builtin, false);
  config = addCustomField(config, section.key, 'select');
  const added = config.form.sections.at(-1)!.fields[0];
  assert.equal(added.key, 'custom_field_1');
  assert.deepEqual(added.options, ['Option 1', 'Option 2']);
  assert.equal(nextCustomKey(config, 'custom_field'), 'custom_field_2');
  config = updateField(config, section.key, added.key, (current) => ({ ...current, label: 'Hostel needed?', required: true, options: ['Yes', 'No'] }));
  assert.deepEqual(examConfigIssues(config), []);
  assert.equal(retypeCustomField(added, 'text').options.length, 0);
  config = updateField(config, 'personal', 'mobile', (current) => ({ ...current, enabled: false, required: false }));
  const mobile = config.form.sections[0].fields.find((item) => item.key === 'mobile')!;
  assert.equal(mobile.enabled && mobile.required, true, 'locked fields cannot be switched off');
  config = updateField(config, 'personal', 'religion', (current) => ({ ...current, enabled: false, required: true }));
  assert.equal(config.form.sections[0].fields.find((item) => item.key === 'religion')!.required, false, 'a hidden field is never required');
  config = removeCustomField(config, section.key, added.key);
  assert.equal(config.form.sections.at(-1)!.fields.length, 0);
  const hidden = removeSection(config, 'parent');
  assert.equal(hidden.form.sections.find((item) => item.key === 'parent')!.enabled, false, 'built-in sections are hidden, not deleted');
  const deleted = removeSection(config, section.key);
  assert.equal(deleted.form.sections.some((item) => item.key === section.key), false);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
});

test('the post field offers the configured hospital posts', () => {
  const config = examConfigPreset('hospital_recruitment');
  const post = config.form.sections.flatMap((section) => section.fields).find((item) => item.key === 'position_applied')!;
  assert.deepEqual(fieldOptionsForPreview(config, post), config.hospitalPosts.map((item) => item.title));
});

test('eligibility summary, rupees and academic year', () => {
  const config = examConfigPreset('hospital_recruitment');
  Object.assign(config.eligibility, { minAge: 18, maxAge: 35, ageAsOn: '2027-01-01' });
  const summary = eligibilitySummary(config);
  assert.match(summary, /Age 18–35 years as on 01 Jan 2027/);
  assert.match(summary, /GNM or B\.Sc Nursing/);
  assert.ok(summary.length <= 300);
  assert.equal(eligibilitySummary(examConfigPreset('other')), 'As described in the examination notice');
  assert.equal(paiseFromRupees('500'), 50_000);
  assert.equal(paiseFromRupees('12.345'), 1235);
  assert.equal(paiseFromRupees('-5'), 0);
  assert.equal(paiseFromRupees('abc'), 0);
  assert.equal(defaultAcademicYear(new Date('2026-11-28T00:00:00Z')), '2026-27');
  assert.equal(defaultAcademicYear(new Date('2027-02-01T00:00:00Z')), '2026-27');
  assert.equal(defaultAcademicYear(new Date('2027-04-02T00:00:00Z')), '2027-28');
});
