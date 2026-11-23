// AUTH-1 (frontend): verification state shapes and user-facing messages for server error codes.
// Pure and unit-tested. The UI only DISPLAYS state; every decision is made by the server.

export interface ProviderStatus {
  sms: { available: boolean; reason: string | null };
  email: { available: boolean; reason: string | null };
  google: { available: boolean; reason: string | null };
  /**
   * Server setting AUTH_MOBILE_VERIFICATION. `off`: Institutes verify only email, and Students get their
   * one-time code by email (they still sign in with mobile + password). Missing means `required`.
   */
  mobileVerification?: 'required' | 'off';
}

/** True while the server runs without mobile (SMS) verification (AUTH_MOBILE_VERIFICATION=off). */
export function emailOnlyVerification(providers: ProviderStatus | null): boolean {
  return providers?.mobileVerification === 'off';
}

export interface VerificationChallengeView {
  status: 'verification_required';
  purpose: 'student_login' | 'student_mobile_capture' | 'student_email_capture' | 'student_registration' | 'institute_mobile' | 'institute_email';
  channel: 'sms' | 'email';
  step: 'destination' | 'code';
  destination: string | null;
  codeSent: boolean;
  attemptsRemaining: number;
  resendAvailableAt: string;
  expiresAt: string;
}

export type PortalSignInRole = 'candidate' | 'center' | 'official';

/** Whether the server reports that sign-in for this role can currently be verified. */
export function signInAvailable(role: PortalSignInRole, providers: ProviderStatus | null): boolean | null {
  if (role === 'official') return true;
  if (!providers) return null;
  // Institutes that already verified their mobile during onboarding can sign in with email even
  // when no SMS vendor is configured. If a mobile still needs verification, the server keeps that
  // challenge fail-closed. Student sign-in continues to follow the selected mobile-verification mode.
  if (role === 'center') return providers.email.available;
  if (emailOnlyVerification(providers)) return providers.email.available;
  return providers.sms.available;
}

export function unavailableMessage(role: PortalSignInRole, providers: ProviderStatus | null = null): string {
  const emailOnly = emailOnlyVerification(providers);
  if (role === 'candidate') {
    return emailOnly
      ? 'Student sign-in and registration are temporarily unavailable. Email verification has not been set up yet, and students can only sign in after confirming a code sent to their email.'
      : 'Student sign-in and registration are temporarily unavailable. Mobile verification has not been set up yet, and students can only sign in after verifying their mobile number.';
  }
  if (providers && !providers.email.available) {
    return 'Institute sign-in and registration are paused until email verification is configured.';
  }
  return 'Institute sign-in is temporarily unavailable until email verification is configured.';
}

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  OTP_PROVIDER_NOT_CONFIGURED: 'Mobile verification is not available yet. Please try again later.',
  PROVIDER_CHECK_FAILED: 'Code verification is temporarily unavailable. Please try again.',
  EMAIL_PROVIDER_NOT_CONFIGURED: 'Email verification is not available yet. Please try again later.',
  GOOGLE_OAUTH_NOT_CONFIGURED: 'Google sign-in is not available.',
  PROVIDER_DELIVERY_FAILED: 'The verification code could not be sent. Please sign in again later.',
  INVALID_CODE: 'That code is not correct.',
  CODE_EXPIRED: 'This code has expired. Request a new code.',
  VERIFICATION_EXPIRED: 'This verification has expired. Please sign in again.',
  TOO_MANY_ATTEMPTS: 'Too many incorrect codes. Please sign in again to restart verification.',
  RESEND_COOLDOWN: 'Please wait a moment before requesting another code.',
  TOO_MANY_RESENDS: 'Too many codes were requested. Please sign in again later.',
  TOO_MANY_VERIFICATION_REQUESTS: 'Too many verification requests for this account. Please try again later.',
  NO_VERIFICATION_IN_PROGRESS: 'No verification is in progress. Please sign in again.',
  INVALID_MOBILE: 'Enter a valid 10-digit Indian mobile number.',
  INVALID_EMAIL: 'Enter a valid email address.',
  EMAIL_REQUIRED: 'Enter your email address to verify this Student account.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  APPROVAL_PENDING: 'Your institute registration is awaiting approval.',
  ACCOUNT_REJECTED: 'This account was not approved. Contact the portal administrator.',
  INSTITUTE_SUSPENDED: 'This institute account is suspended.',
  INSTITUTIONAL_VERIFICATION_PENDING: 'Your contact details are verified. Institutional verification is still pending.',
  INSTITUTIONAL_VERIFICATION_REJECTED: 'Institutional verification was not successful. Contact the portal administrator.',
  STUDENT_VERIFICATION_REQUIRED: 'Please sign in again and confirm the one-time code.',
  INSTITUTE_VERIFICATION_INCOMPLETE: 'Your institute must complete verification before using the portal.',
  INVALID_MOBILE_CREDENTIALS: 'Invalid mobile number or password. If you signed up earlier with a Student ID, use "Existing account?".',
  INVALID_SIGN_IN_CREDENTIALS: 'Invalid email, mobile number or password. If you signed up earlier with a Student ID, use "Existing account?".',
  ACCOUNT_NOT_CREATED: 'We could not create an account with these details. If you already have an account, sign in instead.',
  VERIFICATION_CONFLICT: 'This verification changed while your request was processed. Please try again.',
  VERIFICATION_NOT_INSTALLED: 'Verification is not available yet. Please try again later.',
});

// ---------------------------------------------------------------------------
// Student sign-in options (display only; the server decides availability and every outcome)
// ---------------------------------------------------------------------------

export type OptionState = { state: 'checking' } | { state: 'available' } | { state: 'unavailable'; reason: string };

export const STUDENT_MOBILE_UNAVAILABLE = 'Mobile sign-in is not available yet: mobile (SMS) verification has not been set up, so no code can be sent. Student sign-in and account creation are paused until it is.';
export const STUDENT_EMAIL_UNAVAILABLE = 'Sign-in is not available yet: email verification has not been set up, so no code can be sent. Student sign-in and account creation are paused until it is.';
export const STUDENT_GOOGLE_UNAVAILABLE = 'Google sign-in has not been set up.';
export const STUDENT_GOOGLE_PAUSED = 'Google sign-in is paused while codes are sent by email, because it still ends with a code sent to your mobile.';
export const STUDENT_GOOGLE_SIGN_UP_UNSUPPORTED = 'Google cannot create a new account. Create your account with your mobile number; after you sign in, you can link Google from your dashboard.';

/**
 * Student sign-in and registration with mobile + password. The one-time code goes to the mobile, or to
 * the email while the server runs without mobile verification (AUTH_MOBILE_VERIFICATION=off).
 */
export function studentMobileOption(providers: ProviderStatus | null): OptionState {
  if (!providers) return { state: 'checking' };
  if (emailOnlyVerification(providers)) {
    return providers.email.available ? { state: 'available' } : { state: 'unavailable', reason: STUDENT_EMAIL_UNAVAILABLE };
  }
  return providers.sms.available ? { state: 'available' } : { state: 'unavailable', reason: STUDENT_MOBILE_UNAVAILABLE };
}

/** "Continue with Google" for sign-in: only linked accounts, and it still ends with the mobile code. */
export function studentGoogleSignInOption(providers: ProviderStatus | null): OptionState {
  if (!providers) return { state: 'checking' };
  if (emailOnlyVerification(providers)) return { state: 'unavailable', reason: STUDENT_GOOGLE_PAUSED };
  if (!providers.sms.available) return { state: 'unavailable', reason: STUDENT_MOBILE_UNAVAILABLE };
  return providers.google.available ? { state: 'available' } : { state: 'unavailable', reason: providers.google.reason ?? STUDENT_GOOGLE_UNAVAILABLE };
}

/** The server never creates an account from Google, so this option is always shown as unavailable. */
export function studentGoogleSignUpOption(): OptionState {
  return { state: 'unavailable', reason: STUDENT_GOOGLE_SIGN_UP_UNSUPPORTED };
}

/** Dashboard notice after the server's Google link redirect (fixed values only; never echoed). */
export function googleLinkNotice(search: string): { tone: 'success' | 'error'; text: string } | null {
  const value = new URLSearchParams(search).get('google');
  if (value === 'linked') return { tone: 'success', text: 'Google is now linked. Next time you can choose "Continue with Google"; you will still confirm a code sent to your mobile.' };
  if (value === 'sub_taken') return { tone: 'error', text: 'That Google account is already linked to another student account.' };
  if (value === 'user_has_link') return { tone: 'error', text: 'Your account is already linked to a Google account.' };
  if (value === 'failed') return { tone: 'error', text: 'Google linking could not be completed. Please try again.' };
  return null;
}

/** Maps a server error code to a fixed message; falls back to the server's own user-safe text. */
export function verificationMessage(code: string | undefined, fallback: string, attemptsRemaining?: number): string {
  const base = code ? MESSAGES[code] : undefined;
  if (code === 'INVALID_CODE' && typeof attemptsRemaining === 'number') return `${MESSAGES.INVALID_CODE} ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} left.`;
  return base ?? fallback;
}

export function isChallenge(value: unknown): value is VerificationChallengeView {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'verification_required';
}

/** Seconds until a resend is allowed (0 when allowed now). */
export function secondsUntil(iso: string, nowMs: number = Date.now()): number {
  const target = Date.parse(iso);
  return Number.isFinite(target) ? Math.max(0, Math.ceil((target - nowMs) / 1000)) : 0;
}

/** Query-string notices after a Google redirect (fixed values only; never echoed). */
export function googleNotice(search: string): string | null {
  const value = new URLSearchParams(search).get('google');
  if (value === 'not_linked') return 'This Google account is not linked to a student account. Sign in with your login ID and password, then link Google from your dashboard.';
  if (value === 'failed') return 'Google sign-in could not be completed. Please try again.';
  return null;
}
