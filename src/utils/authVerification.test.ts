import assert from 'node:assert/strict';
import test from 'node:test';
import { googleLinkNotice, googleNotice, isChallenge, secondsUntil, signInAvailable, studentMobileOption, studentGoogleSignInOption, studentGoogleSignUpOption, unavailableMessage, verificationMessage, type ProviderStatus } from './authVerification.ts';

const none: ProviderStatus = { sms: { available: false, reason: 'x' }, email: { available: false, reason: 'x' }, google: { available: false, reason: 'x' } };
const smsOnly: ProviderStatus = { ...none, sms: { available: true, reason: null } };
const emailOnly: ProviderStatus = { ...none, email: { available: true, reason: null } };
const both: ProviderStatus = { ...smsOnly, email: { available: true, reason: null } };

test('sign-in availability follows the server status; Super Admin/Official is never affected', () => {
  assert.equal(signInAvailable('candidate', null), null, 'unknown until the server answers');
  assert.equal(signInAvailable('candidate', none), false);
  assert.equal(signInAvailable('candidate', smsOnly), true, 'Students need SMS verification');
  assert.equal(signInAvailable('candidate', emailOnly), false, 'email alone cannot verify Student sign-in');
  assert.equal(signInAvailable('center', smsOnly), false, 'institutes need mobile AND email');
  assert.equal(signInAvailable('center', both), true);
  assert.equal(signInAvailable('official', none), true);
  assert.match(unavailableMessage('candidate'), /mobile/i);
  assert.match(unavailableMessage('center'), /email/i);
});

test('error codes map to fixed messages; attempts remaining are shown; unknown codes use the server text', () => {
  assert.equal(verificationMessage('INVALID_CODE', 'x', 2), 'That code is not correct. 2 attempts left.');
  assert.equal(verificationMessage('INVALID_CODE', 'x', 1), 'That code is not correct. 1 attempt left.');
  assert.match(verificationMessage('TOO_MANY_ATTEMPTS', 'x'), /sign in again/);
  assert.match(verificationMessage('CODE_EXPIRED', 'x'), /expired/);
  assert.match(verificationMessage('INSTITUTE_SUSPENDED', 'x'), /suspended/);
  assert.equal(verificationMessage('SOMETHING_NEW', 'Server text'), 'Server text');
  assert.equal(verificationMessage(undefined, 'Server text'), 'Server text');
});

test('challenge detection, resend countdown and Google notices', () => {
  assert.equal(isChallenge({ status: 'verification_required' }), true);
  assert.equal(isChallenge({ status: 'signed_in' }), false);
  assert.equal(isChallenge({ verified: true }), false, 'a client-side flag is not a challenge');
  assert.equal(secondsUntil(new Date(10_000).toISOString(), 4_000), 6);
  assert.equal(secondsUntil(new Date(1_000).toISOString(), 4_000), 0);
  assert.match(googleNotice('?google=not_linked') ?? '', /not linked/);
  assert.match(googleNotice('?google=failed') ?? '', /could not be completed/);
  assert.equal(googleNotice('?google=<script>'), null, 'unknown values are never echoed');
});

test('Student options stay visible with an explicit state: checking, available or unavailable with a reason', () => {
  assert.deepEqual(studentMobileOption(null), { state: 'checking' });
  const mobileOff = studentMobileOption(none);
  assert.equal(mobileOff.state, 'unavailable');
  assert.match(mobileOff.state === 'unavailable' ? mobileOff.reason : '', /mobile.*verification/i);
  assert.deepEqual(studentMobileOption(smsOnly), { state: 'available' });
  const googleOff = studentGoogleSignInOption({ ...smsOnly, google: { available: false, reason: 'Google sign-in is not configured.' } });
  assert.deepEqual(googleOff, { state: 'unavailable', reason: 'Google sign-in is not configured.' }, "the server's reason is shown");
  assert.deepEqual(studentGoogleSignInOption({ ...smsOnly, google: { available: true, reason: null } }), { state: 'available' });
  assert.deepEqual(studentGoogleSignInOption({ ...none, google: { available: true, reason: null } }), { state: 'unavailable', reason: mobileOff.state === 'unavailable' ? mobileOff.reason : '' }, 'Google must still be able to finish with SMS OTP');
  const signUp = studentGoogleSignUpOption();
  assert.equal(signUp.state, 'unavailable', 'the server never creates accounts from Google');
  assert.match(signUp.state === 'unavailable' ? signUp.reason : '', /mobile number/);
});

test('mobile sign-in and registration errors map to fixed, privacy-safe messages; Google link notices use fixed values only', () => {
  assert.match(verificationMessage('INVALID_MOBILE_CREDENTIALS', 'x'), /Existing account\?/);
  assert.doesNotMatch(verificationMessage('ACCOUNT_NOT_CREATED', 'x'), /mobile|number/i);
  assert.equal(googleLinkNotice('?google=linked')?.tone, 'success');
  assert.equal(googleLinkNotice('?google=sub_taken')?.tone, 'error');
  assert.equal(googleLinkNotice('?google=user_has_link')?.tone, 'error');
  assert.equal(googleLinkNotice('?google=<b>x</b>'), null);
});
