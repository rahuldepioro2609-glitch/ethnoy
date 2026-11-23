// AUTH-1: Student mobile OTP and Institute mobile/email verification flows, plus Google sign-in.
//
// A pending verification is identified by an opaque token in the elt_verification cookie (HttpOnly,
// SameSite=Strict, Path=/api/auth/verification); the server stores only its SHA-256 as the
// challenge id. NO portal session exists until a code is verified server-side. Codes are sent only
// through a configured provider and are never returned, logged or audited.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { hashSessionToken, newSessionToken, requireAuth, requireRoles, SESSION_TTL_MS, setSessionCookie, type AuthenticatedRequest } from './auth.js';
import {
  createPostgresAuthVerificationStore,
  createPostgresEmailSendGuardStore,
  createPostgresSmsSendGuardStore,
  createPostgresStudentRegistrationStore,
  VerificationStoreUnavailableError,
  type AuthVerificationStore,
  type ContactChannel,
  type EmailBucket,
  type EmailSendGuardStore,
  type InstituteVerificationState,
  type SmsBucket,
  type SmsSendGuardStore,
  type StudentRegistrationStore,
  type VerificationChallenge,
} from './authVerificationStore.js';
import {
  buildAuthorizationUrl,
  createGoogleKeySource,
  createPkcePair,
  exchangeAuthorizationCode,
  GoogleTokenError,
  randomUrlToken,
  verifyGoogleIdToken,
  type FetchLike,
} from './googleOAuth.js';
import { pool } from './db.js';
import { readCookie } from './staffCommon.js';
import {
  EMAIL_PROVIDER_NOT_CONFIGURED,
  generateOtp,
  GOOGLE_OAUTH_NOT_CONFIGURED,
  hashOtp,
  maskEmail,
  maskMobile,
  normaliseEmail,
  normaliseMobile,
  OTP_POLICY,
  boundedDeliveryTimeout,
  classifyProviderFailure,
  OTP_PROVIDER_NOT_CONFIGURED,
  otpMatches,
  PROVIDER_DELIVERY_TIMEOUT_MS,
  providerStatus,
  studentLoginIdForMobile,
  verificationServices,
  type VerificationPurpose,
  type VerificationServices,
} from './verificationProviders.js';

export const VERIFICATION_COOKIE = 'elt_verification';
export const VERIFICATION_COOKIE_PATH = '/api/auth/verification';
export const OAUTH_STATE_COOKIE = 'elt_oauth_state';
export const OAUTH_COOKIE_PATH = '/api/auth/google';
export const ACCOUNT_CHALLENGES_PER_HOUR = 5;

// ---------------------------------------------------------------------------
// Store (configured at startup; the default never connects until a request needs it)
// ---------------------------------------------------------------------------

let store: AuthVerificationStore = createPostgresAuthVerificationStore(pool);
export function configureAuthVerificationStore(next: AuthVerificationStore): void { store = next; }
export function authVerificationStore(): AuthVerificationStore { return store; }

// AUTH C1: Student registration claims and SMS send reservations (separate stores; same pool).
let registrationStore: StudentRegistrationStore = createPostgresStudentRegistrationStore(pool);
let smsGuardStore: SmsSendGuardStore = createPostgresSmsSendGuardStore(pool);
export function configureStudentRegistrationStore(next: StudentRegistrationStore): void { registrationStore = next; }
export function configureSmsSendGuardStore(next: SmsSendGuardStore): void { smsGuardStore = next; }
// AUTH C1.4-B-1: email send reservations (own store and lock; same pool).
let emailGuardStore: EmailSendGuardStore = createPostgresEmailSendGuardStore(pool);
export function configureEmailSendGuardStore(next: EmailSendGuardStore): void { emailGuardStore = next; }

// ---------------------------------------------------------------------------
// AUTH C1: abuse-protection configuration (values PENDING OWNER APPROVAL; nothing is defaulted)
// ---------------------------------------------------------------------------

// C1.3-B: the settings, types and resolver live in the pure module smsProtectionConfig.ts (shared with
// the deployment preflight). Re-exported here so existing imports keep working unchanged.
export {
  ABUSE_PROTECTION_SETTINGS,
  abuseProtectionReadiness,
  EMAIL_PROTECTION_SETTING_NAMES,
  EMAIL_PROTECTION_SETTINGS,
  emailProtectionReadiness,
  resolveEmailProtection,
  type EmailSendLimits,
  resolveAbuseProtection,
  SMS_PROTECTION_SETTING_NAMES,
  type AbuseProtectionConfig,
  type AbuseProtectionSettingStatus,
  type SmsDestinationLimit,
  type SmsSendLimits,
} from './smsProtectionConfig.js';
import { resolveAbuseProtection, type AbuseProtectionConfig } from './smsProtectionConfig.js';

/**
 * C1.3-A: called once at API startup. Resolves the settings with the same resolver the requests use
 * and installs the result, so startup and request-time can never disagree. Never throws and never
 * stops startup: an invalid configuration keeps every SMS refused (fail closed).
 */
export function initializeAbuseProtection(env: Readonly<Record<string, string | undefined>>): AbuseProtectionConfig {
  const config = resolveAbuseProtection(env);
  configureAbuseProtection(config);
  return config;
}

let abuseProtectionConfig: AbuseProtectionConfig | undefined;
/** Overrides the configuration (isolated tests). Undefined re-reads the environment on next use. */
export function configureAbuseProtection(config: AbuseProtectionConfig | undefined): void { abuseProtectionConfig = config; }
export function abuseProtection(): AbuseProtectionConfig {
  abuseProtectionConfig ??= resolveAbuseProtection(process.env);
  return abuseProtectionConfig;
}

/** Keyed, domain-separated destination identifier for SMS accounting (never the number itself). */
export function smsDestinationKey(otpKey: Buffer, destination: string): string {
  return createHmac('sha256', otpKey).update(`sms-destination:${destination}`).digest('hex').slice(0, 32);
}

/** AUTH C1.4-B-1: keyed identifier of an email address for email accounting (domain-separated from SMS). */
export function emailDestinationKey(otpKey: Buffer, address: string): string {
  return createHmac('sha256', otpKey).update(`email-destination:${address}`).digest('hex').slice(0, 32);
}

/** AUTH C1.4-B-1: keyed identifier of ONE approved Institute's own recorded address. */
export function emailAccountDestinationKey(otpKey: Buffer, accountId: string, address: string): string {
  return createHmac('sha256', otpKey).update(`email-account-destination:${accountId.length}:${accountId}:${address}`).digest('hex').slice(0, 32);
}

/**
 * AUTH C1.1-b C-1: keyed identifier of one ACCOUNT's own destination (domain-separated from the
 * per-number key), so the account allowance can only be used by sends for that account and number.
 */
export function smsAccountDestinationKey(otpKey: Buffer, accountId: string, destination: string): string {
  return createHmac('sha256', otpKey).update(`sms-account-destination:${accountId.length}:${accountId}:${destination}`).digest('hex').slice(0, 32);
}

/** Bounded opportunistic cleanup of expired registration claims, run before each new registration. */
export const EXPIRED_CLAIM_CLEANUP_BATCH = 50;

// ---------------------------------------------------------------------------
// Errors with fixed codes
// ---------------------------------------------------------------------------

export class VerificationFlowError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'VerificationFlowError';
  }
}

export function providerUnavailable(channel: ContactChannel): VerificationFlowError {
  return channel === 'sms'
    ? new VerificationFlowError(503, OTP_PROVIDER_NOT_CONFIGURED, 'Mobile verification is not available: no SMS provider is configured.')
    : new VerificationFlowError(503, EMAIL_PROVIDER_NOT_CONFIGURED, 'Email verification is not available: no email provider is configured.');
}

export function sendFlowError(response: Response, error: unknown): boolean {
  if (error instanceof VerificationFlowError) {
    response.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
    return true;
  }
  if (error instanceof VerificationStoreUnavailableError) {
    response.status(503).json({ error: 'Verification is not installed yet.', code: 'VERIFICATION_NOT_INSTALLED' });
    return true;
  }
  return false;
}

function channelAvailable(services: VerificationServices, channel: ContactChannel): boolean {
  return services.otpKey !== null && (channel === 'sms' ? services.sms !== null : services.email !== null);
}

// ---------------------------------------------------------------------------
// Challenge lifecycle
// ---------------------------------------------------------------------------

const challengeId = (token: string) => createHash('sha256').update(token).digest('hex');

function setVerificationCookie(response: Response, token: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.append('Set-Cookie', `${VERIFICATION_COOKIE}=${token}; Path=${VERIFICATION_COOKIE_PATH}; Max-Age=${Math.floor(OTP_POLICY.challengeTtlMs / 1000)}; HttpOnly; SameSite=Strict${secure}`);
  response.set('Cache-Control', 'no-store');
}

function clearVerificationCookie(response: Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.append('Set-Cookie', `${VERIFICATION_COOKIE}=; Path=${VERIFICATION_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
}

const masked = (channel: ContactChannel, destination: string | null) => (destination ? (channel === 'sms' ? maskMobile(destination) : maskEmail(destination)) : null);

export function describeChallenge(challenge: VerificationChallenge, now: Date) {
  return {
    status: 'verification_required' as const,
    purpose: challenge.purpose,
    channel: challenge.channel,
    step: challenge.destination ? 'code' as const : 'destination' as const,
    destination: masked(challenge.channel, challenge.destination),
    codeSent: challenge.sendCount > 0,
    attemptsRemaining: Math.max(0, OTP_POLICY.maxAttempts - challenge.attempts),
    resendAvailableAt: challenge.lastSentAt ? new Date(challenge.lastSentAt.getTime() + OTP_POLICY.resendCooldownMs).toISOString() : now.toISOString(),
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

/** Generates, stores (hash only) and delivers a fresh code. Fails closed on any provider failure. */
async function deliverCode(challenge: VerificationChallenge, now: Date, deadlineMs: number = PROVIDER_DELIVERY_TIMEOUT_MS): Promise<void> {
  const services = verificationServices();
  if (!channelAvailable(services, challenge.channel)) throw providerUnavailable(challenge.channel);
  if (!challenge.destination) throw new VerificationFlowError(409, 'DESTINATION_REQUIRED', 'Enter the mobile number to verify first.');
  if (challenge.sendCount >= OTP_POLICY.maxSendsPerChallenge) throw new VerificationFlowError(429, 'TOO_MANY_RESENDS', 'Too many codes were requested. Start again later.');
  if (challenge.lastSentAt && now.getTime() - challenge.lastSentAt.getTime() < OTP_POLICY.resendCooldownMs) {
    throw new VerificationFlowError(429, 'RESEND_COOLDOWN', 'Please wait before requesting another code.', { resendAvailableAt: new Date(challenge.lastSentAt.getTime() + OTP_POLICY.resendCooldownMs).toISOString() });
  }
  // AUTH C1.1-b: EVERY SMS (every purpose, every route, resends included) is reserved here before a code
  // is generated or delivered: per-destination limit of its bucket, the unverified 24-hour cap and the
  // shared 24-hour total. Refused outright while the limits are not configured. A reservation that is
  // then not delivered (compare-and-set loss, provider failure, timeout) still counts.
  let reservationId: string | null = null;
  if (challenge.channel === 'sms') {
    const limits = abuseProtection().sms;
    if (!limits) throw smsProtectionNotConfigured();
    const bucket = await smsBucketFor(challenge);
    reservationId = randomUUID();
    const reservation = await smsGuardStore.reserveSmsSend({
      reservationId,
      destinationKey: bucket === 'account'
        ? smsAccountDestinationKey(services.otpKey!, challenge.userId!, challenge.destination)
        : smsDestinationKey(services.otpKey!, challenge.destination),
      bucket,
      purpose: challenge.purpose,
      destinationWindowMs: limits[bucket].windowMs,
      destinationMaxSends: limits[bucket].maxSends,
      dailyMaxSends: limits.dailyMaxSends,
      dailyMaxUnverifiedSends: limits.dailyMaxUnverifiedSends,
    });
    if (reservation === 'destination_limited') throw smsDestinationLimited();
    if (reservation !== 'reserved') throw smsDailyLimitReached();
  } else if (challenge.channel === 'email') {
    // AUTH C1.4-B-1: EVERY email (every purpose, resends included) is reserved the same way, with its
    // own limits, actions and lock: per-address limit of its bucket, the unverified 24-hour cap and the
    // email 24-hour total. Refused outright while the email limits are not configured.
    const limits = abuseProtection().email;
    if (!limits) throw emailProtectionNotConfigured();
    const bucket = await emailBucketFor(challenge);
    reservationId = randomUUID();
    const reservation = await emailGuardStore.reserveEmailSend({
      reservationId,
      destinationKey: bucket === 'account'
        ? emailAccountDestinationKey(services.otpKey!, challenge.userId!, challenge.destination)
        : emailDestinationKey(services.otpKey!, challenge.destination),
      bucket,
      purpose: challenge.purpose,
      destinationWindowMs: limits[bucket].windowMs,
      destinationMaxSends: limits[bucket].maxSends,
      dailyMaxSends: limits.dailyMaxSends,
      dailyMaxUnverifiedSends: limits.dailyMaxUnverifiedSends,
    });
    if (reservation === 'destination_limited') throw emailDestinationLimited();
    if (reservation !== 'reserved') throw emailDailyLimitReached();
  }
  // AUTH C1.4-A: one correlation id per delivery attempt, fixed before the code exists: the send
  // reservation's id (SMS and, since C1.4-B-1, email). It names exactly this code, destination and attempt.
  const correlationId = reservationId!; // every SMS and email attempt has a reservation (above)
  const providerManaged = challenge.channel === 'sms' && services.sms!.verificationMode === 'provider';
  const code = providerManaged ? '' : generateOtp();
  const recorded = await store.recordSend(challenge.id, providerManaged ? null : hashOtp(services.otpKey!, challenge.id, code), new Date(now.getTime() + OTP_POLICY.ttlMs), now, { sendCount: challenge.sendCount, destination: challenge.destination });
  // A concurrent request changed the challenge after it was checked: send nothing.
  if (!recorded) throw new VerificationFlowError(409, 'VERIFICATION_CONFLICT', 'This verification changed while the request was processed. Please try again.');
  // Bounded delivery: the deadline aborts the adapter's signal and rejects on its own, so an adapter
  // that ignores the signal still cannot hold the request. A timeout is handled exactly like any other
  // delivery failure; neither the code nor the provider error is logged or returned. Exactly ONE adapter
  // call per attempt; core never retries.
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        reject(new Error('provider delivery deadline exceeded'));
      }, boundedDeliveryTimeout(deadlineMs));
    });
    const request = Object.freeze({ destination: challenge.destination, code, purpose: challenge.purpose, correlationId, signal: controller.signal });
    const delivery = challenge.channel === 'sms' ? services.sms!.sendOtp(request) : services.email!.sendVerificationCode(request);
    // A late settlement after the deadline is ignored: its rejection must never surface as an
    // unhandled rejection, and a late success changes nothing (the challenge is already invalidated).
    void Promise.resolve(delivery).catch(() => undefined);
    await Promise.race([delivery, deadline]);
  } catch (error) {
    // AUTH C1.4-A: only a fixed category is kept (timeout once the deadline fired); never the error.
    const failure = classifyProviderFailure(error, controller.signal.aborted);
    await store.invalidateChallenge(challenge.id, now, { action: 'verification.delivery_failed', userId: challenge.userId, details: { channel: challenge.channel, correlationId, failure } });
    throw new VerificationFlowError(503, 'PROVIDER_DELIVERY_FAILED', 'The verification code could not be delivered. Please try again later.');
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
  await store.recordEvent({ action: 'verification.code_sent', userId: challenge.userId, details: { channel: challenge.channel, purpose: challenge.purpose, correlationId } });
}

/**
 * Starts a verification for an account (after a correct password, at registration or after Google
 * sign-in). Throttled per account. Sets the verification cookie; sends a code when the destination
 * is known. Never creates a portal session.
 */
export async function startVerification(
  response: Response,
  input: { purpose: VerificationPurpose; channel: ContactChannel; destination: string | null; now?: Date }
    & ({ userId: string; registrationClaimId?: undefined } | { userId?: undefined; registrationClaimId: string }),
) {
  const now = input.now ?? new Date();
  if (!channelAvailable(verificationServices(), input.channel)) throw providerUnavailable(input.channel);
  const userId = input.userId ?? null;
  const registrationClaimId = input.registrationClaimId ?? null;
  // AUTH C1: registration claims are completed only by the Student's SMS OTP.
  if (registrationClaimId && (input.purpose !== 'student_registration' || input.channel !== 'sms')) {
    throw new Error('registration claims are used only for Student registration over SMS');
  }
  // Per-account throttling applies to accounts; a pending claim has none (destination limits apply).
  if (userId && await store.countChallengesSince(userId, new Date(now.getTime() - 3600 * 1000)) >= ACCOUNT_CHALLENGES_PER_HOUR) {
    throw new VerificationFlowError(429, 'TOO_MANY_VERIFICATION_REQUESTS', 'Too many verification requests for this account. Try again later.');
  }
  const token = randomBytes(32).toString('base64url');
  const id = challengeId(token);
  await store.createChallenge(
    { id, purpose: input.purpose, userId, registrationClaimId, channel: input.channel, destination: input.destination, expiresAt: new Date(now.getTime() + OTP_POLICY.challengeTtlMs) },
    { action: 'verification.started', userId, details: { purpose: input.purpose, channel: input.channel } },
  );
  let challenge = (await store.getChallenge(id))!;
  if (challenge.destination) {
    await deliverCode(challenge, now);
    challenge = (await store.getChallenge(id))!;
  }
  setVerificationCookie(response, token);
  return describeChallenge(challenge, now);
}

function smsProtectionNotConfigured(): VerificationFlowError {
  return new VerificationFlowError(503, 'SMS_PROTECTION_NOT_CONFIGURED', 'Mobile verification is unavailable: SMS sending limits are not configured.');
}

function emailProtectionNotConfigured(): VerificationFlowError {
  return new VerificationFlowError(503, 'EMAIL_PROTECTION_NOT_CONFIGURED', 'Email verification is unavailable: email sending limits are not configured.');
}

function emailDestinationLimited(): VerificationFlowError {
  return new VerificationFlowError(429, 'EMAIL_DESTINATION_LIMITED', 'Too many codes were sent to this email address. Please try again later.');
}

function emailDailyLimitReached(): VerificationFlowError {
  return new VerificationFlowError(503, 'EMAIL_DAILY_LIMIT_REACHED', 'Email verification is temporarily unavailable. Please try again later.');
}

/**
 * AUTH C1.4-B-1 email bucket rule, evaluated fresh for every send and resend from server data only:
 * ACCOUNT only when a fresh findPortalUser shows an APPROVED Institute, the purpose is institute_email
 * and the destination is exactly its recorded institute_verifications.email_destination. A stored
 * address is never treated as verified. Everything else (new and pending Institutes) is UNVERIFIED.
 */
export async function emailBucketFor(challenge: Pick<VerificationChallenge, 'userId' | 'purpose' | 'destination' | 'channel'>): Promise<EmailBucket> {
  if (challenge.channel !== 'email' || !challenge.userId || !challenge.destination || challenge.purpose !== 'institute_email') return 'unverified';
  const account = await store.findPortalUser(challenge.userId);
  if (!account || account.role !== 'center' || account.accountStatus !== 'approved') return 'unverified';
  const state = await store.getInstituteVerification(challenge.userId);
  return state?.emailDestination != null && state.emailDestination === challenge.destination ? 'account' : 'unverified';
}

/**
 * AUTH C1.4-B-1 early email gate, BEFORE any lookup or write (advisory reads only; the reservation in
 * deliverCode stays authoritative and is the only place a reservation is made). 'config': the email
 * limits must be configured. 'unverified': also the email total, the unverified cap and, when
 * `destination` is given, that address's unverified allowance. Returns the error to send, or null.
 */
export async function emailProtectionGate(scope: 'config' | 'unverified', destination?: string): Promise<VerificationFlowError | null> {
  const limits = abuseProtection().email;
  if (!limits) return emailProtectionNotConfigured();
  if (scope === 'config') return null;
  const usage = await emailGuardStore.emailUsageLast24h();
  if (usage.total >= limits.dailyMaxSends || usage.unverified >= limits.dailyMaxUnverifiedSends) return emailDailyLimitReached();
  const otpKey = verificationServices().otpKey;
  if (destination && otpKey) {
    const recent = await emailGuardStore.emailDestinationUsage({ destinationKey: emailDestinationKey(otpKey, destination), bucket: 'unverified', windowMs: limits.unverified.windowMs });
    if (recent >= limits.unverified.maxSends) return emailDestinationLimited();
  }
  return null;
}

function smsDestinationLimited(): VerificationFlowError {
  return new VerificationFlowError(429, 'SMS_DESTINATION_LIMITED', 'Too many codes were sent to this number. Please try again later.');
}

function smsDailyLimitReached(): VerificationFlowError {
  return new VerificationFlowError(503, 'SMS_DAILY_LIMIT_REACHED', 'Mobile verification is temporarily unavailable. Please try again later.');
}

/**
 * AUTH C1.1-b bucket rule, evaluated by the server for every send (resends included), from fresh store
 * data only; nothing from the client is consulted.
 * - VERIFIED: an account's student_login to exactly its current verified SMS contact.
 * - ACCOUNT (C-1): an APPROVED Institute's institute_mobile to exactly its recorded
 *   institute_verifications.mobile_destination. Pending registrations stay unverified.
 * - UNVERIFIED: everything else (claims, capture, pending Institutes, any mismatch).
 */
export async function smsBucketFor(challenge: Pick<VerificationChallenge, 'userId' | 'purpose' | 'destination' | 'channel'>): Promise<SmsBucket> {
  if (challenge.channel !== 'sms' || !challenge.userId || !challenge.destination) return 'unverified';
  if (challenge.purpose === 'student_login') {
    const current = await store.findVerifiedContact(challenge.userId, 'sms');
    return current !== null && current === challenge.destination ? 'verified' : 'unverified';
  }
  if (challenge.purpose === 'institute_mobile') {
    const account = await store.findPortalUser(challenge.userId);
    if (!account || account.role !== 'center' || account.accountStatus !== 'approved') return 'unverified';
    const state = await store.getInstituteVerification(challenge.userId);
    return state?.mobileDestination != null && state.mobileDestination === challenge.destination ? 'account' : 'unverified';
  }
  return 'unverified';
}

/**
 * AUTH C1.1-b early fail-closed check, for routes that may need an SMS, BEFORE any account lookup,
 * password check or write, so a closed or exhausted SMS service answers the same for every
 * credential. 'config': limits must be configured. 'any': also ADVISORY shared 24-hour total.
 * 'unverified': also ADVISORY unverified 24-hour cap and, when `destination` is given (C-2), that
 * number's unverified per-destination allowance. Advisory reads are never enforcement: the serialized
 * reservation in deliverCode stays authoritative. Returns the error to send, or null.
 */
export async function smsProtectionGate(scope: 'config' | 'any' | 'unverified', destination?: string): Promise<VerificationFlowError | null> {
  const limits = abuseProtection().sms;
  if (!limits) return smsProtectionNotConfigured();
  if (scope === 'config') return null;
  const usage = await smsGuardStore.smsUsageLast24h();
  if (usage.total >= limits.dailyMaxSends) return smsDailyLimitReached();
  if (scope === 'unverified' && usage.unverified >= limits.dailyMaxUnverifiedSends) return smsDailyLimitReached();
  const otpKey = verificationServices().otpKey;
  if (scope === 'unverified' && destination && otpKey) {
    const recent = await smsGuardStore.smsDestinationUsage({ destinationKey: smsDestinationKey(otpKey, destination), bucket: 'unverified', windowMs: limits.unverified.windowMs });
    if (recent >= limits.unverified.maxSends) return smsDestinationLimited();
  }
  return null;
}

/**
 * AUTH C1: Student registration. Creates a temporary, non-exclusive claim (no users row, no login ID
 * reserved) and verifies the mobile before creating the permanent account.
 */
export async function startStudentRegistration(
  response: Response,
  input: { mobile: string; displayName: string; passwordHash: string; now?: Date },
) {
  const now = input.now ?? new Date();
  if (!channelAvailable(verificationServices(), 'sms')) throw providerUnavailable('sms');
  const protection = abuseProtection();
  if (!protection.sms) throw smsProtectionNotConfigured();
  if (protection.registrationClaimTtlMs === null) {
    throw new VerificationFlowError(503, 'REGISTRATION_NOT_CONFIGURED', 'Student registration is unavailable: the registration lifetime is not configured.');
  }
  // Check only the shared daily budgets before creating a temporary claim. The destination is
  // deliberately omitted: per-number limits are authoritatively reserved in deliverCode. This
  // advisory check avoids unnecessary claims when the daily service budget is already exhausted.
  const dailyGate = await smsProtectionGate('unverified');
  if (dailyGate) throw dailyGate;
  // Bounded, idempotent cleanup of expired claims. Best effort: a failure never blocks registration
  // and removes nothing it should not (the store selects only expired, unconsumed, dead claims).
  await registrationStore.deleteExpiredClaims(now, EXPIRED_CLAIM_CLEANUP_BATCH).catch(() => 0);
  const claimId = randomUUID();
  await registrationStore.createClaim({
    id: claimId, mobile: input.mobile, displayName: input.displayName, passwordHash: input.passwordHash,
    createdAt: now, expiresAt: new Date(now.getTime() + protection.registrationClaimTtlMs),
  });
  return startVerification(response, { purpose: 'student_registration', registrationClaimId: claimId, channel: 'sms', destination: input.mobile, now });
}

async function currentChallenge(request: Request, now: Date): Promise<VerificationChallenge> {
  const token = readCookie(request, VERIFICATION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new VerificationFlowError(401, 'NO_VERIFICATION_IN_PROGRESS', 'No verification is in progress. Sign in again.');
  const challenge = await store.getChallenge(challengeId(token));
  if (!challenge || challenge.consumedAt) throw new VerificationFlowError(401, 'NO_VERIFICATION_IN_PROGRESS', 'No verification is in progress. Sign in again.');
  if (challenge.expiresAt <= now) throw new VerificationFlowError(410, 'VERIFICATION_EXPIRED', 'This verification has expired. Sign in again.');
  return challenge;
}

/** Institute contact verification is mobile first, then email. */
export function nextInstituteChannel(state: InstituteVerificationState | null): ContactChannel | null {
  if (!state?.mobileVerifiedAt) return 'sms';
  if (!state.emailVerifiedAt) return 'email';
  return null;
}

/** Starts the next Institute contact verification. */
export async function startInstituteVerification(response: Response, institutionId: string, contactEmail: string | null, state: InstituteVerificationState | null, now?: Date) {
  const channel = nextInstituteChannel(state);
  if (!channel) return null;
  const destination = channel === 'sms'
    ? state?.mobileDestination ?? null
    : normaliseEmail(state?.emailDestination ?? contactEmail);
  return startVerification(response, { purpose: channel === 'sms' ? 'institute_mobile' : 'institute_email', userId: institutionId, channel, destination, now });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface AuthVerificationRouterOptions {
  now?: () => Date;
  fetchImpl?: FetchLike;
  /**
   * Delivery deadline for codes sent by this router's routes. Bounded by boundedDeliveryTimeout: it can
   * only shorten the fixed 10-second deadline (used by isolated tests); production never sets it.
   */
  deliveryTimeoutMs?: number;
}

function flowRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch((error: unknown) => { if (!sendFlowError(response, error)) next(error); });
  };
}

export function createAuthVerificationRouter(options: AuthVerificationRouterOptions = {}): Router {
  const now = options.now ?? (() => new Date());
  const deliveryDeadlineMs = boundedDeliveryTimeout(options.deliveryTimeoutMs);
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);
  const getKeys = createGoogleKeySource(fetchImpl);
  const verificationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many verification attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' } });
  const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' } });
  const router = express.Router();

  router.get('/auth/providers', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(providerStatus());
  });

  router.get('/auth/student/email', requireAuth, requireRoles('candidate'), flowRoute(async (request, response) => {
    // requireAuth has already attached the signed-in Student.
    const user = (request as AuthenticatedRequest).user!;
    response.set('Cache-Control', 'no-store');
    response.json({ email: await store.findVerifiedContact(user.id, 'email') });
  }));

  router.post('/auth/student/email', requireAuth, requireRoles('candidate'), verificationLimiter, flowRoute(async (request, response) => {
    const user = (request as AuthenticatedRequest).user!;
    const parsed = z.object({ email: z.string().trim().max(254) }).strict().safeParse(request.body);
    const destination = parsed.success ? normaliseEmail(parsed.data.email) : null;
    if (!destination) throw new VerificationFlowError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    if (!channelAvailable(verificationServices(), 'email')) throw providerUnavailable('email');
    if (await store.findVerifiedContact(user.id, 'email') === destination) {
      response.json({ status: 'already_verified', email: destination });
      return;
    }
    const gate = await emailProtectionGate('unverified', destination);
    if (gate) throw gate;
    response.status(202).json(await startVerification(response, {
      purpose: 'student_email_capture', userId: user.id, channel: 'email', destination,
    }));
  }));

  router.get('/auth/verification', verificationLimiter, flowRoute(async (request, response) => {
    const challenge = await currentChallenge(request, now());
    response.set('Cache-Control', 'no-store');
    response.json(describeChallenge(challenge, now()));
  }));

  // Existing accounts without a registered mobile (decision: capture at next sign-in).
  router.post('/auth/verification/destination', verificationLimiter, flowRoute(async (request, response) => {
    const challenge = await currentChallenge(request, now());
    if (challenge.channel !== 'sms' || challenge.destination) throw new VerificationFlowError(409, 'DESTINATION_ALREADY_SET', 'A destination is already set for this verification.');
    const mobile = normaliseMobile((request.body as { mobile?: unknown })?.mobile);
    if (!mobile) throw new VerificationFlowError(400, 'INVALID_MOBILE', 'Enter a valid 10-digit Indian mobile number.');
    if (!channelAvailable(verificationServices(), 'sms')) throw providerUnavailable('sms');
    await store.setChallengeDestination(challenge.id, mobile);
    // Deliver only to the destination actually stored: a concurrent capture may have set another one.
    const updated = await store.getChallenge(challenge.id);
    if (!updated || updated.consumedAt || updated.destination !== mobile) throw new VerificationFlowError(409, 'DESTINATION_ALREADY_SET', 'A destination is already set for this verification.');
    await deliverCode(updated, now(), deliveryDeadlineMs);
    response.json(describeChallenge((await store.getChallenge(challenge.id))!, now()));
  }));

  router.post('/auth/verification/resend', verificationLimiter, flowRoute(async (request, response) => {
    const challenge = await currentChallenge(request, now());
    await deliverCode(challenge, now(), deliveryDeadlineMs);
    response.json(describeChallenge((await store.getChallenge(challenge.id))!, now()));
  }));

  router.post('/auth/verification/verify', verificationLimiter, flowRoute(async (request, response) => {
    const services = verificationServices();
    const challenge = await currentChallenge(request, now());
    if (!channelAvailable(services, challenge.channel)) throw providerUnavailable(challenge.channel);
    const parsed = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict().safeParse(request.body);
    if (challenge.attempts >= OTP_POLICY.maxAttempts) {
      await store.invalidateChallenge(challenge.id, now(), { action: 'verification.locked', userId: challenge.userId });
      clearVerificationCookie(response);
      throw new VerificationFlowError(429, 'TOO_MANY_ATTEMPTS', 'Too many incorrect codes. Sign in again to restart verification.');
    }
    const providerManaged = challenge.channel === 'sms' && services.sms!.verificationMode === 'provider';
    if ((!providerManaged && !challenge.codeHash) || (providerManaged && challenge.codeHash !== null) || !challenge.codeExpiresAt || !challenge.destination) throw new VerificationFlowError(409, 'NO_CODE_SENT', 'Request a code first.');
    if (challenge.codeExpiresAt <= now()) throw new VerificationFlowError(410, 'CODE_EXPIRED', 'This code has expired. Request a new code.');
    // The attempt is used atomically BEFORE comparing, so parallel guesses cannot exceed the limit.
    const attempts = await store.reserveAttempt(challenge.id, OTP_POLICY.maxAttempts);
    if (attempts === null) {
      await store.invalidateChallenge(challenge.id, now(), { action: 'verification.locked', userId: challenge.userId });
      clearVerificationCookie(response);
      throw new VerificationFlowError(429, 'TOO_MANY_ATTEMPTS', 'Too many incorrect codes. Sign in again to restart verification.');
    }
    let validCode = false;
    if (parsed.success) {
      if (providerManaged) {
        if (!services.sms!.verifyOtp) throw new VerificationFlowError(503, 'PROVIDER_CHECK_FAILED', 'Code verification is temporarily unavailable. Please try again.');
        const controller = new AbortController();
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            deadlineTimer = setTimeout(() => { controller.abort(); reject(new Error('provider verification deadline exceeded')); }, boundedDeliveryTimeout(deliveryDeadlineMs));
          });
          const check = services.sms!.verifyOtp(Object.freeze({ destination: challenge.destination, code: parsed.data.code, signal: controller.signal }));
          void Promise.resolve(check).catch(() => undefined);
          validCode = await Promise.race([check, deadline]);
        } catch {
          await store.recordEvent({ action: 'verification.provider_check_failed', userId: challenge.userId, details: { channel: 'sms' } });
          throw new VerificationFlowError(503, 'PROVIDER_CHECK_FAILED', 'Code verification is temporarily unavailable. Please try again.');
        } finally { if (deadlineTimer) clearTimeout(deadlineTimer); }
      } else {
        validCode = otpMatches(services.otpKey!, challenge.id, parsed.data.code, challenge.codeHash!);
      }
    }
    if (!validCode) {
      await store.recordEvent({ action: 'verification.code_rejected', userId: challenge.userId, details: { channel: challenge.channel } });
      const remaining = Math.max(0, OTP_POLICY.maxAttempts - attempts);
      if (remaining === 0) {
        await store.invalidateChallenge(challenge.id, now(), { action: 'verification.locked', userId: challenge.userId });
        clearVerificationCookie(response);
        throw new VerificationFlowError(429, 'TOO_MANY_ATTEMPTS', 'Too many incorrect codes. Sign in again to restart verification.');
      }
      throw new VerificationFlowError(400, 'INVALID_CODE', 'The code is incorrect.', { attemptsRemaining: remaining });
    }

    // AUTH C1: a verified registration claim becomes a permanent Student account, atomically.
    if (challenge.registrationClaimId) {
      const token = newSessionToken();
      const mobile = await registrationStore.getClaimMobile(challenge.registrationClaimId);
      if (!mobile) {
        clearVerificationCookie(response);
        throw new VerificationFlowError(410, 'VERIFICATION_EXPIRED', 'This registration has expired. Please register again.');
      }
      const result = await registrationStore.completeRegistration({
        challengeId: challenge.id, claimId: challenge.registrationClaimId, destination: challenge.destination,
        userId: randomUUID(), loginId: studentLoginIdForMobile(services.otpKey!, mobile),
        sessionTokenHash: hashSessionToken(token), sessionExpiresAt: new Date(now().getTime() + SESSION_TTL_MS), now: now(),
      });
      if (result !== 'completed') {
        clearVerificationCookie(response);
        if (result === 'refused') {
          // Same wording as the earlier duplicate answer; only the holder of the phone ever sees it.
          throw new VerificationFlowError(409, 'ACCOUNT_NOT_CREATED', 'We could not create an account with these details. If you already have an account, sign in instead.');
        }
        if (result === 'expired') throw new VerificationFlowError(410, 'VERIFICATION_EXPIRED', 'This registration has expired. Please register again.');
        throw new VerificationFlowError(401, 'NO_VERIFICATION_IN_PROGRESS', 'No verification is in progress. Please register again.');
      }
      clearVerificationCookie(response);
      setSessionCookie(response, token);
      response.json({ status: 'signed_in' });
      return;
    }

    const user = challenge.userId ? await store.findPortalUser(challenge.userId) : null;
    if (challenge.purpose === 'student_email_capture') {
      if (!user || user.role !== 'candidate' || user.accountStatus !== 'approved') throw new VerificationFlowError(403, 'ACCOUNT_NOT_ELIGIBLE', 'This account cannot verify an email address.');
      const done = await store.completeStudentEmailVerification({
        challengeId: challenge.id, userId: user.id, destination: challenge.destination, now: now(),
      });
      if (!done) throw new VerificationFlowError(401, 'NO_VERIFICATION_IN_PROGRESS', 'No verification is in progress. Sign in again.');
      clearVerificationCookie(response);
      response.json({ status: 'contact_verified', verified: 'email', message: 'Student email address verified.' });
      return;
    }

    if (challenge.purpose === 'student_login' || challenge.purpose === 'student_mobile_capture') {
      if (!user || user.role !== 'candidate' || user.accountStatus !== 'approved') throw new VerificationFlowError(403, 'ACCOUNT_NOT_ELIGIBLE', 'This account cannot sign in.');
      const token = newSessionToken();
      const done = await store.completeStudentVerification({
        challengeId: challenge.id, userId: user.id, destination: challenge.destination, sessionTokenHash: hashSessionToken(token),
        sessionExpiresAt: new Date(now().getTime() + SESSION_TTL_MS), now: now(),
        // AUTH C1 (approved rule): capturing a number that belongs to a mobile-first Student is refused.
        mobileFirstLoginId: challenge.purpose === 'student_mobile_capture' ? studentLoginIdForMobile(services.otpKey!, challenge.destination) : undefined,
      });
      if (done === 'mobile_in_use') {
        clearVerificationCookie(response);
        throw new VerificationFlowError(409, 'MOBILE_NOT_AVAILABLE', 'This mobile number cannot be added to this account. Please contact support.');
      }
      if (!done) throw new VerificationFlowError(401, 'NO_VERIFICATION_IN_PROGRESS', 'No verification is in progress. Sign in again.');
      clearVerificationCookie(response);
      setSessionCookie(response, token);
      response.json({ status: 'signed_in' });
      return;
    }

    // Institute contact verification (mobile and email are independent).
    if (!user || user.role !== 'center' || (user.accountStatus !== 'approved' && user.accountStatus !== 'pending')) throw new VerificationFlowError(403, 'ACCOUNT_NOT_ELIGIBLE', 'This account cannot be verified.');
    const done = await store.completeInstituteContactVerification({ challengeId: challenge.id, institutionId: user.id, channel: challenge.channel, destination: challenge.destination, now: now() });
    if (!done) throw new VerificationFlowError(401, 'NO_VERIFICATION_IN_PROGRESS', 'No verification is in progress. Sign in again.');
    const state = await store.getInstituteVerification(user.id);
    if (nextInstituteChannel(state)) {
      // The next channel's challenge replaces the cookie (one Set-Cookie for it, not clear + set).
      const next = await startInstituteVerification(response, user.id, user.contactEmail, state, now());
      response.json({ ...next, verified: challenge.channel });
      return;
    }
    clearVerificationCookie(response);
    response.json({
      status: 'contacts_verified',
      verified: challenge.channel,
      approval: user.accountStatus,
      institutionalVerification: state?.institutionalStatus ?? 'pending',
      message: 'Mobile and email are verified. Sign in again; access also needs institutional verification and Official approval.',
    });
  }));

  // --- Google sign-in (Authorization Code + PKCE + state + nonce) ---
  const googleUnavailable = (response: Response) => response.status(503).json({ error: 'Google sign-in is not configured.', code: GOOGLE_OAUTH_NOT_CONFIGURED });
  const googleReady = () => {
    const services = verificationServices();
    return services.google && channelAvailable(services, 'sms') ? services.google : null;
  };
  async function beginGoogle(response: Response, intent: 'login' | 'link', userId: string | null) {
    const google = googleReady();
    if (!google) {
      googleUnavailable(response);
      return;
    }
    const state = randomUrlToken();
    const nonce = randomUrlToken();
    const pkce = createPkcePair();
    await store.createOAuthState({ stateHash: challengeId(state), nonce, codeVerifier: pkce.verifier, intent, userId, expiresAt: new Date(now().getTime() + 10 * 60 * 1000) });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    response.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; Path=${OAUTH_COOKIE_PATH}; Max-Age=600; HttpOnly; SameSite=Lax${secure}`);
    response.set('Cache-Control', 'no-store');
    response.redirect(302, buildAuthorizationUrl(google, { state, nonce, codeChallenge: pkce.challenge }));
  }

  router.get('/auth/google/start', oauthLimiter, flowRoute(async (_request, response) => beginGoogle(response, 'login', null)));

  // Linking proves ownership of the Student account: it needs a VERIFIED Student session
  // (password + mobile OTP; enforced by requireAuth's AUTH-1 gate).
  router.get('/auth/google/link', requireAuth, requireRoles('candidate'), flowRoute(async (request, response) => beginGoogle(response, 'link', (request as AuthenticatedRequest).user!.id)));

  router.get('/auth/google/callback', oauthLimiter, flowRoute(async (request, response) => {
    const google = googleReady();
    if (!google) {
      googleUnavailable(response);
      return;
    }
    const fail = (reason: string) => response.redirect(302, `/login/candidate?google=${reason}`);
    const queryState = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    const cookieState = readCookie(request, OAUTH_STATE_COOKIE) ?? '';
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    response.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=${OAUTH_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
    if (!queryState || !code || cookieState.length !== queryState.length || !timingSafeEqual(Buffer.from(cookieState), Buffer.from(queryState))) {
      fail('failed');
      return;
    }
    const state = await store.consumeOAuthState(challengeId(queryState), now());
    if (!state) {
      fail('failed');
      return;
    }
    let identity;
    try {
      const idToken = await exchangeAuthorizationCode(google, code, state.codeVerifier, fetchImpl);
      identity = await verifyGoogleIdToken(idToken, { clientId: google.clientId, nonce: state.nonce, nowSeconds: Math.floor(now().getTime() / 1000), getKeys });
    } catch (error) {
      await store.recordEvent({ action: 'google.rejected', userId: state.userId, details: { reason: error instanceof GoogleTokenError ? error.reason : 'exchange_failed' } });
      fail('failed');
      return;
    }
    if (state.intent === 'link') {
      // The link was started from a verified Student session up to 10 minutes ago: re-check that the
      // account is still an approved Student before linking (same rule as Google sign-in below).
      const owner = await store.findPortalUser(state.userId!);
      if (!owner || owner.role !== 'candidate' || owner.accountStatus !== 'approved') {
        await store.recordEvent({ action: 'google.link_refused', userId: state.userId, details: { reason: 'account_not_eligible' } });
        fail('failed');
        return;
      }
      const result = await store.linkGoogleIdentity(state.userId!, identity.sub, identity.email, now());
      response.redirect(302, `/dashboard/candidate?google=${result}`);
      return;
    }
    // Sign-in: only an ALREADY linked Student account; never link or create by email.
    const userId = await store.findUserIdByGoogleSub(identity.sub);
    const user = userId ? await store.findPortalUser(userId) : null;
    if (!user || user.role !== 'candidate' || user.accountStatus !== 'approved') {
      await store.recordEvent({ action: 'google.not_linked', userId: null });
      fail('not_linked');
      return;
    }
    // Google is not enough: the registered mobile must be verified by OTP before any session.
    const mobile = await store.findVerifiedContact(user.id, 'sms');
    await startVerification(response, { purpose: mobile ? 'student_login' : 'student_mobile_capture', userId: user.id, channel: 'sms', destination: mobile, now: now() });
    response.redirect(302, '/login/candidate?verification=pending');
  }));

  return router;
}
