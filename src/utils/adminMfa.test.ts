// AUTH C1.9.2 (MFA P3a-2): Official / Super Admin authenticator step in the frontend.
// No network: the request function is a fake; the component is rendered statically.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminMfaChallenge } from '../components/AdminMfaChallenge.tsx';
import { isChallenge } from './authVerification.ts';
import {
  ADMIN_MFA_VERIFY_PATH,
  adminMfaErrorView,
  adminMfaStartStatus,
  isAdminMfaSignedIn,
  isCompleteAdminMfaCode,
  normaliseAdminMfaCode,
  submitAdminMfaCode,
  type AdminMfaRequest,
} from './adminMfa.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the password step answers are recognised; they never look like an AUTH-1 verification challenge', () => {
  assert.equal(adminMfaStartStatus({ status: 'mfa_required' }), 'mfa_required');
  assert.equal(adminMfaStartStatus({ status: 'mfa_enrolment_required' }), 'mfa_enrolment_required');
  for (const value of [null, undefined, {}, { status: 'signed_in' }, { status: 'verification_required' }, 'mfa_required', { status: 'MFA_REQUIRED' }]) {
    assert.equal(adminMfaStartStatus(value), null, JSON.stringify(value));
  }
  assert.equal(isChallenge({ status: 'mfa_required' }), false);
  assert.equal(isChallenge({ status: 'mfa_enrolment_required' }), false);
  const enrollment = source('../components/AdminMfaEnrollment.tsx');
  assert.match(enrollment, /\/api\/auth\/mfa\/enrol\/start/);
  assert.match(enrollment, /\/api\/auth\/mfa\/enrol\/confirm/);
});

test('code entry keeps six digits only', () => {
  assert.equal(normaliseAdminMfaCode('123 456'), '123456');
  assert.equal(normaliseAdminMfaCode('12-34-56-78'), '123456');
  assert.equal(normaliseAdminMfaCode('abc'), '');
  assert.equal(isCompleteAdminMfaCode('123456'), true);
  for (const code of ['12345', '1234567', '12345a', '', ' 123456']) assert.equal(isCompleteAdminMfaCode(code), false, code);
  assert.equal(isAdminMfaSignedIn({ status: 'signed_in' }), true);
  assert.equal(isAdminMfaSignedIn({ status: 'mfa_required' }), false);
});

test('server error codes map to fixed, safe messages; only ended challenges return to the sign-in form', () => {
  assert.deepEqual(adminMfaErrorView(400, 'MFA_CODE_INVALID').restart, false);
  assert.match(adminMfaErrorView(400, 'MFA_CODE_INVALID').message, /not correct/);
  for (const [status, code, pattern] of [
    [410, 'MFA_CHALLENGE_EXPIRED', /expired/], [429, 'MFA_CHALLENGE_LOCKED', /Too many incorrect codes/],
    [429, 'MFA_THROTTLED', /wait/], [503, 'ADMIN_MFA_UNAVAILABLE', /temporarily unavailable/], [403, 'ADMIN_MFA_REQUIRED', /sign in again/],
  ] as const) {
    const view = adminMfaErrorView(status, code);
    assert.equal(view.restart, true, code);
    assert.match(view.message, pattern, code);
  }
  assert.deepEqual(adminMfaErrorView(429, undefined), { message: 'Too many sign-in attempts. Please wait and try again.', restart: false }, 'the per-address limiter');
  assert.deepEqual(adminMfaErrorView(500, undefined), { message: 'The code could not be verified. Please try again.', restart: false });
  assert.deepEqual(adminMfaErrorView(400, 'toString'), adminMfaErrorView(400, undefined), 'no prototype lookups');
  assert.deepEqual(adminMfaErrorView(400, 'SOMETHING_NEW'), adminMfaErrorView(400, undefined), 'unknown codes never echo server text');
});

test('submitting sends only the code, by POST, to the verify endpoint; success only on the server\'s signed_in', async () => {
  const calls: Array<{ path: string; init: { method: string; body: string } }> = [];
  const answer = (data: unknown): AdminMfaRequest => async (path, init) => { calls.push({ path, init }); return { data }; };
  assert.deepEqual(await submitAdminMfaCode('123456', answer({ status: 'signed_in', user: {} })), { kind: 'signed_in' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, ADMIN_MFA_VERIFY_PATH);
  assert.equal(ADMIN_MFA_VERIFY_PATH, '/api/auth/mfa/verify');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: '123456' }, 'no user, role, factor or challenge data');
  // Anything but signed_in is not a success, even with a 2xx answer.
  for (const data of [{}, { status: 'mfa_required' }, null, 'signed_in', { user: { id: 'x' } }]) {
    assert.equal((await submitAdminMfaCode('123456', answer(data))).kind, 'error', JSON.stringify(data));
  }
  // An incomplete code is never sent.
  calls.length = 0;
  assert.equal((await submitAdminMfaCode('12345', answer({ status: 'signed_in' }))).kind, 'error');
  assert.equal(calls.length, 0);
});

test('API errors (status and code) become the fixed views', async () => {
  const failing = (status: number, code?: string): AdminMfaRequest => async () => { throw Object.assign(new Error('server text that must not be shown'), { status, code }); };
  const expectView = async (status: number, code: string | undefined, restart: boolean) => {
    const outcome = await submitAdminMfaCode('123456', failing(status, code));
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') {
      assert.equal(outcome.view.restart, restart, `${status} ${code}`);
      assert.doesNotMatch(outcome.view.message, /server text/);
    }
  };
  await expectView(400, 'MFA_CODE_INVALID', false);
  await expectView(410, 'MFA_CHALLENGE_EXPIRED', true);
  await expectView(429, 'MFA_CHALLENGE_LOCKED', true);
  await expectView(429, 'MFA_THROTTLED', true);
  await expectView(503, 'ADMIN_MFA_UNAVAILABLE', true);
  await expectView(429, undefined, false);
  const network = await submitAdminMfaCode('123456', async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(network, { kind: 'error', view: { message: 'The code could not be verified. Please try again.', restart: false } });
});

test('the challenge screen: a labelled six-digit numeric one-time-code field; submit disabled until six digits', () => {
  const markup = renderToStaticMarkup(React.createElement(AdminMfaChallenge, { onSignedIn: () => undefined, onRestart: () => undefined }));
  assert.match(markup, /<h2[^>]*>Enter your authenticator code<\/h2>/);
  assert.match(markup, /<label for="admin-mfa-code"[^>]*>Authenticator code<\/label>/);
  const input = /<input[^>]*id="admin-mfa-code"[^>]*>/.exec(markup)?.[0] ?? '';
  for (const fragment of ['inputMode="numeric"', 'autoComplete="one-time-code"', 'pattern="[0-9]{6}"', 'maxLength="6"', 'required=""']) {
    assert.ok(input.includes(fragment), fragment);
  }
  assert.match(markup, /<button type="submit" disabled=""[^>]*>Verify and sign in<\/button>/);
  assert.match(markup, /<button type="button"[^>]*>Back to sign in<\/button>/);
  assert.match(markup, /aria-live="polite"/);
  assert.doesNotMatch(markup, /role="alert"/, 'no error before any submission');
});

test('static: the HttpOnly challenge cookie is never read; no fixed codes or bypass in the new frontend code', () => {
  for (const path of ['../components/AdminMfaChallenge.tsx', './adminMfa.ts', '../components/RolePortal.tsx', '../App.tsx']) {
    const text = source(path);
    assert.doesNotMatch(text, /document\.cookie|elt_admin_mfa/, `${path}: never touches the challenge cookie`);
    assert.doesNotMatch(text, /['"](?:000000|123456|111111)['"]/, `${path}: no fixed code`);
    assert.doesNotMatch(text, /(?:skip|bypass)\w*mfa|mfa\w*(?:bypass|skip)/i, `${path}: no MFA bypass`);
  }
});

test('static: RoleLoginPage handles the Official 202 answers and finishes through the existing /api/auth/me check', () => {
  const portal = source('../components/RolePortal.tsx');
  const branch = portal.slice(portal.indexOf("if (role === 'official' && result.status === 202) {"), portal.indexOf('// Verify the session was durably persisted'));
  assert.ok(branch.length > 0, 'an Official-only 202 branch exists');
  assert.match(branch, /if \(start === 'mfa_required'\) setAdminMfaPending\(true\);/);
  assert.match(branch, /else if \(start === 'mfa_enrolment_required'\) setAdminMfaEnrolmentPending\(true\);/);
  assert.match(portal, /role === 'official' && adminMfaEnrolmentPending \? \(\s+<AdminMfaEnrollment[\s\S]*?onSignedIn=\{\(\) => void finishVerifiedSignIn\(\)\}/);
  assert.match(branch, /return;\s+\}\s*$/, 'never falls through to /api/auth/me without a session');
  // The challenge screen is used only for Officials, and success goes through the existing session check.
  assert.match(portal, /role === 'official' && adminMfaPending \? \(\s+<AdminMfaChallenge[\s\S]*?onSignedIn=\{\(\) => void finishVerifiedSignIn\(\)\}/);
  // Search for RoleLoginPage's submit after finishVerifiedSignIn (other components in the file declare one too).
  const finishStart = portal.indexOf('const finishVerifiedSignIn');
  const finish = portal.slice(finishStart, portal.indexOf('const submit = async', finishStart));
  assert.ok(finishStart >= 0 && finish.length > 0, 'finishVerifiedSignIn is found before RoleLoginPage submit');
  assert.match(finish, /apiRequest<\{[\s\S]*?\}>\('\/api\/auth\/me'\)/);
  // The Student and Institute verification step is unchanged.
  assert.match(portal, /if \(result\.status === 202 && isChallenge\(result\.data\)\) \{\s+setPassword\(''\);\s+setVerification\(result\.data\);\s+return;\s+\}/);
});

test('static: the app treats a refused pre-MFA Official session as signed out, and every other error as before', () => {
  const app = source('../App.tsx');
  assert.match(app, /const signedOut = error instanceof ApiError && \(error\.status === 401 \|\| \(error\.status === 403 && error\.code === 'ADMIN_MFA_REQUIRED'\)\);/);
  assert.match(app, /if \(!signedOut\) \{\s+setSystemAlert\(/);
});
