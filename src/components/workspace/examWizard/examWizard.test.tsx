// Create Examination wizard screens (server-rendered markup): the Institute configures; nothing collects
// applicant data, fees are configuration only, and submission goes to ELTNOY review.
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { examConfigPreset } from '../../../utils/examConfig.ts';
import { newDraft, type WizardDraft } from '../../../utils/examWizard.ts';
import { ApplicantFormPreview } from './ApplicantFormPreview.tsx';
import { StepDetails } from './StepDetails.tsx';
import { StepEligibility } from './StepEligibility.tsx';
import { StepForm } from './StepForm.tsx';
import { NoticePreview, StepPreview } from './StepPreview.tsx';
import { StepSetup } from './StepSetup.tsx';

const noop = () => undefined;
const draft = (): WizardDraft => ({
  ...newDraft('hospital_recruitment'), examCode: 'SNR-2027', title: 'Staff Nurse Recruitment 2027', appOpenDate: '2027-02-01',
  appCloseDate: '2027-02-20', examDate: '2027-03-15',
});

test('the applicant form preview cannot be filled in and says applicants cannot apply yet', () => {
  const html = renderToStaticMarkup(<ApplicantFormPreview config={examConfigPreset('entrance')} title="B.Sc Nursing Entrance Examination 2027" />);
  assert.match(html, /preview only/i);
  assert.match(html, /Applicants cannot apply through ELTNOY/);
  assert.doesNotMatch(html, /<input|<textarea|<select/, 'no controls an applicant (or the Institute) could fill in');
  assert.match(html, /<fieldset disabled/);
  assert.match(html, /Full name \(as per identity document\)/);
  assert.doesNotMatch(html, /Aadhaar number/, 'Aadhaar is not on the form by default');
  assert.match(html, /10-digit Indian mobile number/);
  assert.match(html, /6-digit PIN code/);
  assert.match(html, /Class 12/);
  assert.match(html, /PCB/);
});

test('an enabled Aadhaar field is shown masked, with the accepted alternatives', () => {
  const config = examConfigPreset('general');
  Object.assign(config.form.sections[0].fields.find((field) => field.key === 'aadhaar_number')!, { enabled: true, required: false });
  config.form.alternativeIds = ['passport', 'voter_id'];
  const html = renderToStaticMarkup(<ApplicantFormPreview config={config} title="Test" />);
  assert.match(html, /XXXX XXXX 1234/);
  assert.match(html, /Passport, Voter ID/);
});

test('step 1 offers every examination type and mode, with Indian examples', () => {
  const html = renderToStaticMarkup(<StepDetails draft={draft()} update={noop} updateBasics={noop} onChooseType={noop} />);
  for (const label of ['General Examination', 'Institution Admission', 'Recruitment / Job', 'Hospital Recruitment', 'Entrance Examination', 'University / College Examination', 'Scholarship', 'Certification', 'Other']) {
    assert.ok(html.includes(label), label);
  }
  for (const mode of ['Online CBT', 'Offline OMR', 'Descriptive', 'Interview', 'Practical', 'Hybrid']) assert.ok(html.includes(mode), mode);
  assert.match(html, /Staff Nurse Recruitment 2027/);
  assert.match(html, /cannot publish it directly/);
});

test('step 2 configures fields (show, required, edit) and says no applicant information is entered', () => {
  const html = renderToStaticMarkup(<StepForm config={examConfigPreset('general')} title="Test" onChange={noop} />);
  assert.match(html, /you do not enter any applicant&#x27;s information here/);
  assert.match(html, /role="switch"/);
  assert.match(html, /Required/);
  assert.match(html, /Add custom field/);
  assert.match(html, /Add section/);
  assert.match(html, /Applicant view · preview only/);
});

test('step 3 and step 4 render; fees are configuration only and no payment method is offered', () => {
  const d = draft();
  assert.match(renderToStaticMarkup(<StepEligibility config={d.config} onChange={noop} />), /Minimum age/);
  const setup = renderToStaticMarkup(<StepSetup draft={d} update={noop} onChange={noop} />);
  assert.match(setup, /Application start date/);
  assert.match(setup, /Correction window start/);
  assert.match(setup, /Admit card release date/);
  assert.doesNotMatch(setup, /Payment gateway|Pay now|UPI \(Recommended\)/i);
});

test('step 5 and the notice: D-02 review, fee configuration only, posts listed', () => {
  const d = draft();
  d.config.fees.categories.general.fee = 50_000;
  const preview = renderToStaticMarkup(<StepPreview draft={d} goTo={noop} />);
  assert.match(preview, /goes to the ELTNOY Super Admin for review \(D-02\)/);
  assert.match(preview, /Draft|Not saved yet/);
  const notice = renderToStaticMarkup(<NoticePreview draft={d} />);
  assert.match(notice, /Staff Nurse/);
  assert.match(notice, /₹500/);
  assert.match(notice, /Payment collection is not available on ELTNOY/);
  assert.match(notice, /Examination notice · preview only/);
});
