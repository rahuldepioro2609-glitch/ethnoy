// AUTH-1: provider-independent verification layer (SMS OTP, email verification, Google OAuth).
//
// Provider adapters may be registered by server code, but a channel is AVAILABLE only when an
// approved provider is selected and its configuration validates. Otherwise it is DISABLED and every
// dependent flow fails closed with a fixed code. There is no development provider, no fixed or
// predictable code and no automatic verification.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * AUTH C1.4-A: one delivery attempt, handed to an adapter as a single request object.
 *
 * Adapter contract (adapters' responsibility; core cannot enforce what a vendor does):
 * - `correlationId` identifies exactly ONE code, ONE destination and ONE delivery attempt. Pass it to
 *   the vendor as the idempotency key where the vendor supports one; never reuse it for another code.
 *   SMS: it equals the send reservation's id. Email: a fresh UUID per delivery.
 * - `signal` is aborted when the core deadline (PROVIDER_DELIVERY_TIMEOUT_MS) expires: honour it, start
 *   no new vendor request after it is aborted, and never retry internally (core never retries either;
 *   a user resend is a new attempt with a new code and a new correlationId).
 * - A message the vendor has already accepted may still arrive late. Do not claim cancellation unless
 *   the vendor documents it. A late code is harmless: core has already invalidated its challenge.
 * - Throw on any failure. To report a known cause, throw ProviderDeliveryError with a category; anything
 *   else is recorded as 'unknown'. Never put the code, destination or credentials in an error.
 */
export interface ProviderDeliveryRequest {
  /** SMS: E.164 number. Email: normalised address. */
  readonly destination: string;
  readonly code: string;
  readonly purpose: VerificationPurpose;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}
export type SmsDeliveryRequest = ProviderDeliveryRequest;
export type EmailDeliveryRequest = ProviderDeliveryRequest;

export interface SmsOtpCheckRequest {
  /** E.164 number attached to the pending challenge. */
  readonly destination: string;
  /** Six-digit code entered by the user. */
  readonly code: string;
  readonly signal: AbortSignal;
}

export interface SmsOtpProvider {
  readonly name: string;
  /** `provider` means the vendor generates and checks the code; local codeHash stays null. */
  readonly verificationMode?: 'local' | 'provider';
  /** Delivers one code to an E.164 number (see the ProviderDeliveryRequest contract). */
  sendOtp(request: SmsDeliveryRequest): Promise<void>;
  /** Required only when verificationMode is `provider`. Returns true only after vendor approval. */
  verifyOtp?(request: SmsOtpCheckRequest): Promise<boolean>;
}

export interface EmailVerificationProvider {
  readonly name: string;
  /** Delivers one code to an email address (see the ProviderDeliveryRequest contract). */
  sendVerificationCode(request: EmailDeliveryRequest): Promise<void>;
}

/**
 * AUTH C1.4-A: the ONLY failure categories ever recorded. Core sets 'timeout' when its deadline fired
 * (the signal is aborted); adapters may declare one through ProviderDeliveryError; anything else is
 * 'unknown'. Raw messages, causes and vendor payloads are never recorded or returned.
 */
export const PROVIDER_FAILURE_CATEGORIES = Object.freeze(['timeout', 'throttled', 'rejected_destination', 'authentication', 'provider_unavailable', 'unknown'] as const);
export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

/** Thrown by an adapter to declare a known failure category. Its message carries the category only. */
export class ProviderDeliveryError extends Error {
  constructor(public readonly category: ProviderFailureCategory) {
    super(`provider delivery failed (${String(category)})`);
    this.name = 'ProviderDeliveryError';
  }
}

/** Maps any thrown value to a fixed category; nothing of the error itself is kept. */
export function classifyProviderFailure(error: unknown, deadlineFired: boolean): ProviderFailureCategory {
  if (deadlineFired) return 'timeout';
  if (error instanceof ProviderDeliveryError && (PROVIDER_FAILURE_CATEGORIES as readonly string[]).includes(error.category)) return error.category;
  return 'unknown';
}

/**
 * Bounded deadline for one provider delivery call. On expiry the adapter's signal is aborted and the
 * delivery fails closed exactly like a provider error, even if the adapter ignores the signal.
 */
export const PROVIDER_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * A delivery deadline can only be shortened, never extended: anything missing, non-finite or above the
 * fixed maximum yields PROVIDER_DELIVERY_TIMEOUT_MS; anything below 1 ms yields 1 ms.
 */
export function boundedDeliveryTimeout(requestedMs?: number): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs)) return PROVIDER_DELIVERY_TIMEOUT_MS;
  return Math.min(PROVIDER_DELIVERY_TIMEOUT_MS, Math.max(1, Math.floor(requestedMs)));
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Exact, absolute https redirect URI registered with Google for the Exam surface. */
  redirectUri: string;
}

export type VerificationPurpose = 'student_login' | 'student_mobile_capture' | 'student_email_capture' | 'student_registration' | 'institute_mobile' | 'institute_email';

export interface VerificationServices {
  sms: SmsOtpProvider | null;
  email: EmailVerificationProvider | null;
  google: GoogleOAuthConfig | null;
  /** HMAC key for OTP hashes (32+ bytes). Required for any OTP channel to be available. */
  otpKey: Buffer | null;
  /** Fixed, user-safe reasons for disabled channels (never secret values). */
  reasons: { sms: string | null; email: string | null; google: string | null };
}

export const OTP_PROVIDER_NOT_CONFIGURED = 'OTP_PROVIDER_NOT_CONFIGURED';
export const EMAIL_PROVIDER_NOT_CONFIGURED = 'EMAIL_PROVIDER_NOT_CONFIGURED';
export const GOOGLE_OAUTH_NOT_CONFIGURED = 'GOOGLE_OAUTH_NOT_CONFIGURED';

const NO_SMS = 'No SMS provider is configured.';
const NO_EMAIL = 'No email provider is configured.';
const NO_GOOGLE = 'Google sign-in is not configured.';

export const DISABLED_SERVICES: VerificationServices = Object.freeze({
  sms: null,
  email: null,
  google: null,
  otpKey: null,
  reasons: Object.freeze({ sms: NO_SMS, email: NO_EMAIL, google: NO_GOOGLE }),
}) as VerificationServices;

// ---------------------------------------------------------------------------
// Adapter registry (server code only; nothing here is reachable from a request)
// ---------------------------------------------------------------------------

/**
 * AUTH C1.4-A: restricted configuration handed to an adapter's create(): ONLY the settings and secret
 * files its registration declared. Adapters never see the environment or any secret-file path.
 */
export interface ProviderAdapterConfig {
  /** Declared ordinary settings, by environment name (non-empty strings). */
  readonly settings: Readonly<Record<string, string>>;
  /** Declared secrets, by logical name: the trimmed file contents (never the path). */
  readonly secrets: Readonly<Record<string, Buffer>>;
}

export interface ProviderAdapterRegistration<P> {
  /** Required ordinary settings (environment names). Credential-like names are refused. */
  readonly settings?: readonly string[];
  /** Required secret files: logical name -> { env: <NAME>_FILE, minBytes }. Read by core, not the adapter. */
  readonly secretFiles?: Readonly<Record<string, { readonly env: string; readonly minBytes: number }>>;
  /** Builds the adapter from its restricted configuration. May throw (the channel then stays disabled). */
  create(config: ProviderAdapterConfig): P;
}

const smsRegistrations = new Map<string, ProviderAdapterRegistration<SmsOtpProvider>>();
const emailRegistrations = new Map<string, ProviderAdapterRegistration<EmailVerificationProvider>>();

/** An approved SMS integration registers itself here under its provider name. */
export function registerSmsProviderAdapter(name: string, registration: ProviderAdapterRegistration<SmsOtpProvider>): void {
  smsRegistrations.set(name, registration);
}
/** An approved email integration registers itself here under its provider name. */
export function registerEmailProviderAdapter(name: string, registration: ProviderAdapterRegistration<EmailVerificationProvider>): void {
  emailRegistrations.set(name, registration);
}

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Boundary-aware: KEY, SECRET, TOKEN or PASSWORD as a whole underscore-separated word (MONKEY is fine). */
const CREDENTIAL_WORD = /(^|_)(KEY|SECRET|TOKEN|PASSWORD)(_|$)/;

/** True only for a well-formed declaration: _FILE secret names, no credential-like plain settings, no overlaps. */
export function isValidAdapterDeclaration(registration: ProviderAdapterRegistration<unknown>): boolean {
  const settings = registration.settings ?? [];
  const secretFiles = Object.values(registration.secretFiles ?? {});
  const names = [...settings, ...secretFiles.map((secret) => secret.env)];
  if (typeof registration.create !== 'function' || new Set(names).size !== names.length) return false;
  for (const name of settings) {
    if (!ENVIRONMENT_NAME.test(name) || CREDENTIAL_WORD.test(name) || name.endsWith('_FILE')) return false;
  }
  for (const secret of secretFiles) {
    if (!ENVIRONMENT_NAME.test(secret.env) || !secret.env.endsWith('_FILE')) return false;
    if (!Number.isInteger(secret.minBytes) || secret.minBytes < 1) return false;
  }
  return true;
}

/**
 * Builds the restricted configuration, or null if any declared setting is missing or any declared
 * secret file is missing, not absolute or too short (existing readSecretFile rules). Nothing is logged.
 */
function restrictedAdapterConfig(registration: ProviderAdapterRegistration<unknown>, env: Readonly<Record<string, string | undefined>>): ProviderAdapterConfig | null {
  const settings: Record<string, string> = {};
  for (const name of registration.settings ?? []) {
    const value = env[name];
    if (value === undefined || value.trim() === '') return null;
    settings[name] = value;
  }
  const secrets: Record<string, Buffer> = {};
  for (const [logical, secret] of Object.entries(registration.secretFiles ?? {})) {
    const contents = readSecretFile(env[secret.env], secret.minBytes);
    if (!contents) return null;
    secrets[logical] = contents;
  }
  return Object.freeze({ settings: Object.freeze(settings), secrets: Object.freeze(secrets) });
}

/** One channel: declaration check, restricted configuration, create(); fixed reasons only. */
function resolveAdapter<P>(
  channel: 'SMS' | 'email',
  name: string,
  registration: ProviderAdapterRegistration<P> | undefined,
  otpKey: Buffer | null,
  env: Readonly<Record<string, string | undefined>>,
): { provider: P | null; reason: string | null } {
  if (!registration) return { provider: null, reason: `The configured ${channel} provider has no approved integration in this build.` };
  if (!isValidAdapterDeclaration(registration)) return { provider: null, reason: `The ${channel} provider integration declares its configuration incorrectly.` };
  if (!otpKey) return { provider: null, reason: `${channel === 'SMS' ? 'SMS' : 'Email'} verification needs AUTH_OTP_HMAC_KEY_FILE (a 32-byte or longer secret file).` };
  const config = restrictedAdapterConfig(registration, env);
  if (!config) return { provider: null, reason: `The ${channel} provider configuration is incomplete or invalid.` };
  try {
    return { provider: registration.create(config), reason: null };
  } catch {
    return { provider: null, reason: `The ${channel} provider configuration is incomplete or invalid.` };
  }
}

function readSecretFile(path: string | undefined, minimumBytes: number): Buffer | null {
  if (!path || !path.startsWith('/')) return null;
  try {
    const value = readFileSync(path);
    const trimmed = Buffer.from(value.toString('utf8').trim(), 'utf8');
    return trimmed.length >= minimumBytes ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Builds the verification services from the environment. Missing or incomplete configuration, an
 * unknown provider name, an adapter that throws while initialising or a missing OTP key all give a
 * DISABLED channel with a fixed reason. Secret values are never logged or returned.
 */
export function resolveVerificationServices(
  env: Readonly<Record<string, string | undefined>> = process.env,
  /** The configured Exam surface hostname; Google sign-in stays disabled unless the redirect URI uses exactly this host. */
  expectedExamHostname?: string,
): VerificationServices {
  const reasons = { sms: NO_SMS, email: NO_EMAIL, google: NO_GOOGLE } as VerificationServices['reasons'];
  const otpKey = readSecretFile(env.AUTH_OTP_HMAC_KEY_FILE, 32);

  // AUTH C1.4-A: each adapter receives ONLY its declared settings and secret-file contents.
  let sms: SmsOtpProvider | null = null;
  const smsName = env.AUTH_SMS_PROVIDER;
  if (smsName) {
    const resolved = resolveAdapter('SMS', smsName, smsRegistrations.get(smsName), otpKey, env);
    sms = resolved.provider;
    reasons.sms = resolved.reason;
  }

  let email: EmailVerificationProvider | null = null;
  const emailName = env.AUTH_EMAIL_PROVIDER;
  if (emailName) {
    const resolved = resolveAdapter('email', emailName, emailRegistrations.get(emailName), otpKey, env);
    email = resolved.provider;
    reasons.email = resolved.reason;
  }

  let google: GoogleOAuthConfig | null = null;
  if (env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_SECRET_FILE || env.GOOGLE_OAUTH_REDIRECT_URI) {
    const secret = readSecretFile(env.GOOGLE_OAUTH_CLIENT_SECRET_FILE, 16);
    const redirect = validateRedirectUri(env.GOOGLE_OAUTH_REDIRECT_URI, expectedExamHostname);
    const clientId = env.GOOGLE_OAUTH_CLIENT_ID ?? '';
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId) || !secret) {
      reasons.google = 'Google sign-in configuration is incomplete or invalid.';
    } else if (!redirect) {
      reasons.google = 'The Google sign-in redirect URI must be https://<Exam host>/api/auth/google/callback on the configured Exam host.';
    } else {
      google = { clientId, clientSecret: secret.toString('utf8'), redirectUri: redirect };
      reasons.google = null;
    }
  }

  return { sms, email, google, otpKey: sms || email ? otpKey : null, reasons };
}

/**
 * Only an absolute https URI on exactly the expected Exam host (no explicit port, credentials, query or
 * fragment) with exactly the callback path. Without an expected hostname nothing validates (fail closed).
 */
export function validateRedirectUri(value: string | undefined, expectedHostname: string | undefined): string | null {
  if (!value || !expectedHostname) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.port !== '') return null;
    if (url.hostname !== expectedHostname.trim().toLowerCase()) return null;
    if (url.pathname !== '/api/auth/google/callback') return null;
    return url.toString();
  } catch {
    return null;
  }
}

let current: VerificationServices = DISABLED_SERVICES;

/** Called once at API startup (and by isolated tests). Never reachable from a request. */
export function configureVerificationServices(services: VerificationServices): void {
  current = services;
}

export function verificationServices(): VerificationServices {
  return current;
}

/** Public, secret-free availability summary for the UI. */
export function providerStatus(services: VerificationServices = current) {
  return {
    sms: { available: services.sms !== null && services.otpKey !== null, reason: services.sms && services.otpKey ? null : services.reasons.sms },
    email: { available: services.email !== null && services.otpKey !== null, reason: services.email && services.otpKey ? null : services.reasons.email },
    google: { available: services.google !== null && services.sms !== null && services.otpKey !== null, reason: services.google ? (services.sms ? null : 'Google sign-in also needs mobile verification, which is unavailable.') : services.reasons.google },
  };
}

// ---------------------------------------------------------------------------
// OTP primitives
// ---------------------------------------------------------------------------

/** Verification policy. Values are conservative defaults pending owner approval (see AUTH-1 report). */
export const OTP_POLICY = Object.freeze({
  digits: 6,
  ttlMs: 5 * 60 * 1000,
  maxAttempts: 5,
  resendCooldownMs: 60 * 1000,
  maxSendsPerChallenge: 3,
  /** Pending sign-in/registration challenge lifetime (the verification cookie). */
  challengeTtlMs: 15 * 60 * 1000,
});

/** Uniformly random 6-digit code from the CSPRNG (leading zeros allowed). */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_POLICY.digits)).padStart(OTP_POLICY.digits, '0');
}

/** Keyed hash bound to the challenge, so a stored hash is useless without the server key. */
export function hashOtp(key: Buffer, challengeId: string, code: string): string {
  return createHmac('sha256', key).update(`${challengeId}:${code}`).digest('hex');
}

export function otpMatches(key: Buffer, challengeId: string, code: string, storedHash: string): boolean {
  if (!/^[0-9]{6}$/.test(code) || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashOtp(key, challengeId, code), 'hex'), Buffer.from(storedHash, 'hex'));
}

/** Indian mobile numbers in E.164 (+91 followed by 10 digits starting 6–9). Other regions need a decision. */
export function normaliseMobile(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s()-]/g, '');
  const match = /^(?:\+?91|0)?([6-9][0-9]{9})$/.exec(digits);
  return match ? `+91${match[1]}` : null;
}

export function normaliseEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

/**
 * Login ID of a mobile-first Student account: a keyed, one-way derivation of the normalised mobile
 * (domain-separated from OTP hashes). It makes the existing UNIQUE users.login_id the duplicate
 * check without storing or displaying the phone number as an identifier (A-08: phone numbers stay
 * hidden from ordinary Officials, who can see login IDs). Requires the configured OTP key, so it is
 * only usable when mobile verification is available. Rotating that key changes the derivation; the
 * account then stays reachable through its verified mobile contact.
 */
export function studentLoginIdForMobile(key: Buffer, normalisedMobile: string): string {
  return `M-${createHmac('sha256', key).update(`student-login-id:${normalisedMobile}`).digest('hex').slice(0, 24).toUpperCase()}`;
}

export function maskMobile(mobile: string): string {
  return `${mobile.slice(0, 3)}******${mobile.slice(-2)}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
