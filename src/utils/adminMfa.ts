// AUTH C1.9.2 (MFA P3a-2): pure helpers for the Official / Super Admin sign-in MFA step.
// The server decides every outcome. These helpers only recognise its answers and turn its fixed error
// codes into fixed, user-safe messages (server text is never echoed). The challenge cookie is HttpOnly
// and is never read here: the browser sends it to /api/auth/mfa/verify on its own.

export const ADMIN_MFA_VERIFY_PATH = '/api/auth/mfa/verify';

/** The two 202 answers of POST /api/auth/login for an Official whose password matched. */
export type AdminMfaStartStatus = 'mfa_required' | 'mfa_enrolment_required';

export function adminMfaStartStatus(value: unknown): AdminMfaStartStatus | null {
  const status = typeof value === 'object' && value !== null ? (value as { status?: unknown }).status : undefined;
  return status === 'mfa_required' || status === 'mfa_enrolment_required' ? status : null;
}

/** Keeps only digits, at most six (paste-friendly: spaces or dashes from an app are dropped). */
export function normaliseAdminMfaCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

export function isCompleteAdminMfaCode(code: string): boolean {
  return /^[0-9]{6}$/.test(code);
}

export function isAdminMfaSignedIn(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'signed_in';
}

/**
 * How the challenge screen reacts to an error. `restart` means the challenge can no longer be used:
 * the screen closes and the sign-in form shows the message.
 */
export interface AdminMfaErrorView {
  readonly message: string;
  readonly restart: boolean;
}

const ERRORS: Readonly<Record<string, AdminMfaErrorView>> = Object.freeze({
  MFA_CODE_INVALID: { message: 'That code is not correct. Check your authenticator app and enter the current 6-digit code.', restart: false },
  MFA_CHALLENGE_EXPIRED: { message: 'This sign-in has expired or is no longer valid. Please sign in again.', restart: true },
  MFA_CHALLENGE_LOCKED: { message: 'Too many incorrect codes. Please sign in again.', restart: true },
  MFA_THROTTLED: { message: 'Too many incorrect codes for this account. Please wait and sign in again later.', restart: true },
  MFA_TICKET_INVALID: { message: 'This enrolment ticket is no longer valid. Please sign in again.', restart: true },
  ADMIN_MFA_UNAVAILABLE: { message: 'Administrative sign-in is temporarily unavailable. Please try again later.', restart: true },
  ADMIN_MFA_REQUIRED: { message: 'Administrative access requires your authenticator code. Please sign in again.', restart: true },
});

const RATE_LIMITED: AdminMfaErrorView = { message: 'Too many sign-in attempts. Please wait and try again.', restart: false };
const UNKNOWN: AdminMfaErrorView = { message: 'The code could not be verified. Please try again.', restart: false };

/** Maps an API error (HTTP status and the body's `code`, if any) to a fixed view. */
export function adminMfaErrorView(status: number | undefined, code: string | undefined): AdminMfaErrorView {
  if (code && Object.prototype.hasOwnProperty.call(ERRORS, code)) return ERRORS[code];
  if (status === 429) return RATE_LIMITED;
  return UNKNOWN;
}

export type AdminMfaSubmitOutcome = { readonly kind: 'signed_in' } | { readonly kind: 'error'; readonly view: AdminMfaErrorView };

/** The request function (the app passes apiRequestWithMeta; tests pass a fake). */
export type AdminMfaRequest = (path: string, init: { method: 'POST'; body: string }) => Promise<{ data: unknown }>;

/**
 * Sends ONLY the six-digit code to the verify endpoint. The challenge travels in its HttpOnly cookie;
 * no user, role or factor information is ever sent. Success is reported only when the server answers
 * `signed_in`. A rejected request becomes a fixed message.
 */
export async function submitAdminMfaCode(code: string, request: AdminMfaRequest): Promise<AdminMfaSubmitOutcome> {
  if (!isCompleteAdminMfaCode(code)) return { kind: 'error', view: ERRORS.MFA_CODE_INVALID };
  try {
    const { data } = await request(ADMIN_MFA_VERIFY_PATH, { method: 'POST', body: JSON.stringify({ code }) });
    return isAdminMfaSignedIn(data) ? { kind: 'signed_in' } : { kind: 'error', view: UNKNOWN };
  } catch (error) {
    const details = typeof error === 'object' && error !== null ? (error as { status?: unknown; code?: unknown }) : {};
    return {
      kind: 'error',
      view: adminMfaErrorView(typeof details.status === 'number' ? details.status : undefined, typeof details.code === 'string' ? details.code : undefined),
    };
  }
}
