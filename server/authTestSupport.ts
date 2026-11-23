// AUTH-1 TEST SUPPORT ONLY. Never imported by production code (a static test enforces this).
// - VERIFIED_PORTAL_SESSION: session-row fields representing a session issued AFTER genuine
//   verification, for fixtures that exercise Student/Institute routes behind the AUTH-1 gate.
// - Test-double providers that record codes in memory so tests can complete a verification. They
//   exist only inside the test process; production has no provider at all.
// - An in-memory AuthVerificationStore mirroring the PostgreSQL semantics (single use, attempts).
// - AUTH C1.1-b: an in-memory SMS send guard mirroring the PostgreSQL reservation semantics, and
//   TEST-ONLY SMS limits (production has no defaults: the real values are pending owner approval).
import type { AuthVerificationEvent, AuthVerificationStore, ContactChannel, InstituteVerificationState, InstitutionalAction, InstitutionalDecisionResult, OAuthState, PortalUserRecord, VerificationChallenge } from './authVerificationStore.js';
import { DEFAULT_INSTITUTE_STATE, INSTITUTIONAL_EVENT_ACTIONS, nextInstitutionalState, VerificationStoreUnavailableError } from './authVerificationStore.js';
import type { EmailDeliveryRequest, EmailVerificationProvider, GoogleOAuthConfig, ProviderDeliveryRequest, SmsDeliveryRequest, SmsOtpProvider, VerificationPurpose, VerificationServices } from './verificationProviders.js';
import type { EmailBucket, EmailSendGuardStore, EmailSendReservationInput, SmsBucket, SmsSendGuardStore, SmsSendReservationInput } from './authVerificationStore.js';
import type { AbuseProtectionConfig } from './authVerification.js';

export const VERIFIED_PORTAL_SESSION = Object.freeze({
  session_verified_at: '2026-11-01T00:00:00.000Z',
  iv_institution_id: 'verified-institution',
  iv_mobile_verified_at: '2026-11-01T00:00:00.000Z',
  iv_email_verified_at: '2026-11-01T00:00:00.000Z',
  iv_institutional_status: 'verified',
  iv_suspended_at: null,
  // AUTH C1.9.1: an Official session issued after TOTP. Answers the separate Official MFA lookup
  // (server/auth.ts OFFICIAL_MFA_SQL, which also reads FROM auth_sessions s by token hash) in stubs that
  // serve session rows by token hash. A fixture for a password-only Official overrides it with false.
  official_mfa_verified: true,
});

export class RecordingSmsProvider implements SmsOtpProvider {
  readonly name = 'test-recording-sms';
  readonly sent: Array<{ destination: string; code: string; purpose: VerificationPurpose; correlationId: string }> = [];
  failNext = false;
  async sendOtp({ destination, code, purpose, correlationId }: SmsDeliveryRequest) {
    if (this.failNext) { this.failNext = false; throw new Error('test delivery failure'); }
    this.sent.push({ destination, code, purpose, correlationId });
  }
  lastCode() { return this.sent.at(-1)?.code; }
}

export class RecordingEmailProvider implements EmailVerificationProvider {
  readonly name = 'test-recording-email';
  readonly sent: Array<{ destination: string; code: string; purpose: VerificationPurpose; correlationId: string }> = [];
  async sendVerificationCode({ destination, code, purpose, correlationId }: EmailDeliveryRequest) { this.sent.push({ destination, code, purpose, correlationId }); }
  lastCode() { return this.sent.at(-1)?.code; }
}

/**
 * AUTH C1.4-A local contract kit (TEST ONLY). A scripted adapter over a fake "vendor" that records every
 * vendor call and whether the request's signal was already aborted at that moment, so tests can check
 * abort handling, late resolution, retry-after-abort and declared failures without any network.
 * Behaviours:
 * - 'success': one vendor call, resolves.
 * - 'honours-abort': one vendor call that settles only when the signal aborts (rejects with AbortError).
 * - 'ignores-abort': one vendor call that never settles on its own (until releaseLate()).
 * - 'retry-after-abort': like 'honours-abort', then (a contract VIOLATION) calls the vendor again.
 * - 'resolve-late': ignores the signal and resolves only when releaseLate() is called.
 * - 'throw': rejects immediately with the value from `throwValue`.
 */
export type ContractBehaviour = 'success' | 'honours-abort' | 'ignores-abort' | 'retry-after-abort' | 'resolve-late' | 'throw';

export class ContractTestAdapter implements SmsOtpProvider, EmailVerificationProvider {
  readonly name = 'test-contract-adapter';
  readonly vendorCalls: Array<{ correlationId: string; destination: string; code: string; purpose: VerificationPurpose; abortedAtCall: boolean }> = [];
  readonly requests: ProviderDeliveryRequest[] = [];
  private releases: Array<() => void> = [];
  constructor(public behaviour: ContractBehaviour = 'success', public throwValue: unknown = new Error('test failure')) {}
  private vendor(request: ProviderDeliveryRequest) {
    this.vendorCalls.push({ correlationId: request.correlationId, destination: request.destination, code: request.code, purpose: request.purpose, abortedAtCall: request.signal.aborted });
  }
  /** Contract check: any vendor call made after the request's signal was aborted. */
  vendorCallsAfterAbort() { return this.vendorCalls.filter((call) => call.abortedAtCall).length; }
  /** Settles every pending 'ignores-abort' / 'resolve-late' delivery (the late vendor completion). */
  releaseLate() { for (const release of this.releases.splice(0)) release(); }
  sendOtp(request: SmsDeliveryRequest) { return this.deliver(request); }
  sendVerificationCode(request: EmailDeliveryRequest) { return this.deliver(request); }
  private deliver(request: ProviderDeliveryRequest): Promise<void> {
    this.requests.push(request);
    this.vendor(request);
    switch (this.behaviour) {
      case 'success': return Promise.resolve();
      case 'throw': return Promise.reject(this.throwValue);
      case 'honours-abort':
      case 'retry-after-abort':
        return new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            if (this.behaviour === 'retry-after-abort') this.vendor(request); // violation, for detection
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      case 'ignores-abort':
      case 'resolve-late':
        return new Promise<void>((resolve) => { this.releases.push(resolve); });
    }
  }
}

export function testServices(options: { sms?: SmsOtpProvider | null; email?: EmailVerificationProvider | null; google?: GoogleOAuthConfig | null } = {}): VerificationServices {
  return {
    sms: options.sms ?? null,
    email: options.email ?? null,
    google: options.google ?? null,
    otpKey: Buffer.alloc(32, 7),
    reasons: { sms: options.sms ? null : 'test: no SMS', email: options.email ? null : 'test: no email', google: options.google ? null : 'test: no Google' },
  };
}

export class MemoryAuthVerificationStore implements AuthVerificationStore {
  users = new Map<string, PortalUserRecord>();
  challenges = new Map<string, VerificationChallenge & { createdAt: Date }>();
  contacts = new Map<string, string>(); // `${userId}:${channel}` -> destination (verified)
  institutes = new Map<string, InstituteVerificationState>();
  sessions: Array<{ tokenHash: string; userId: string; expiresAt: Date; verified: boolean; method?: 'sms_otp' | 'email_otp' | 'password' }> = [];
  google = new Map<string, { userId: string; email: string }>(); // sub -> link
  oauth = new Map<string, OAuthState & { consumed: boolean }>();
  readonly events: AuthVerificationEvent[] = [];

  async findPortalUser(userId: string) { return this.users.get(userId) ?? null; }
  async createChallenge(c: Omit<VerificationChallenge, 'attempts' | 'sendCount' | 'consumedAt' | 'codeHash' | 'codeExpiresAt' | 'lastSentAt'>, event: AuthVerificationEvent) {
    this.challenges.set(c.id, { ...c, attempts: 0, sendCount: 0, consumedAt: null, codeHash: null, codeExpiresAt: null, lastSentAt: null, createdAt: new Date() });
    this.events.push(event);
  }
  async getChallenge(id: string) { const c = this.challenges.get(id); return c ? { ...c } : null; }
  async setChallengeDestination(id: string, destination: string) { const c = this.challenges.get(id); if (c && !c.consumedAt && !c.destination) c.destination = destination; }
  async recordSend(id: string, codeHash: string | null, codeExpiresAt: Date, now: Date, expected: { sendCount: number; destination: string }) {
    const c = this.challenges.get(id);
    if (!c || c.consumedAt || c.sendCount !== expected.sendCount || c.destination !== expected.destination) return false;
    Object.assign(c, { codeHash, codeExpiresAt, sendCount: c.sendCount + 1, lastSentAt: now });
    return true;
  }
  async reserveAttempt(id: string, maxAttempts: number) {
    const c = this.challenges.get(id);
    if (!c || c.consumedAt || c.attempts >= maxAttempts) return null;
    c.attempts += 1;
    return c.attempts;
  }
  async invalidateChallenge(id: string, now: Date, event: AuthVerificationEvent) { const c = this.challenges.get(id); if (c) c.consumedAt ??= now; this.events.push(event); }
  async countChallengesSince(userId: string, since: Date) { return [...this.challenges.values()].filter((c) => c.userId === userId && c.createdAt >= since).length; }
  async findVerifiedContact(userId: string, channel: ContactChannel) { return this.contacts.get(`${userId}:${channel}`) ?? null; }
  async findCandidateIdsByVerifiedMobile(mobile: string, limit: number) {
    return [...this.contacts.entries()]
      .filter(([key, destination]) => key.endsWith(':sms') && destination === mobile && this.users.get(key.slice(0, -4))?.role === 'candidate')
      .map(([key]) => key.slice(0, -4)).sort().slice(0, limit);
  }
  async findCandidateIdsByVerifiedEmail(email: string, limit: number) {
    return [...this.contacts.entries()]
      .filter(([key, destination]) => key.endsWith(':email') && destination.toLowerCase() === email.toLowerCase() && this.users.get(key.slice(0, -6))?.role === 'candidate')
      .map(([key]) => key.slice(0, -6)).sort().slice(0, limit);
  }
  async issueStudentPasswordSession(input: { userId: string; sessionTokenHash: string; sessionExpiresAt: Date; now: Date }) {
    this.sessions.push({ tokenHash: input.sessionTokenHash, userId: input.userId, expiresAt: input.sessionExpiresAt, verified: true, method: 'password' });
    this.events.push({ action: 'student.password_session_issued', userId: input.userId });
  }
  async completeStudentVerification(input: { challengeId: string; userId: string; channel?: ContactChannel; destination: string; sessionTokenHash: string; sessionExpiresAt: Date; now: Date }) {
    const c = this.challenges.get(input.challengeId);
    if (!c || c.consumedAt) return false;
    c.consumedAt = input.now;
    const channel = input.channel ?? 'sms';
    this.contacts.set(`${input.userId}:${channel}`, input.destination);
    const user = this.users.get(input.userId);
    if (channel === 'email' && user) user.contactEmail = input.destination;
    this.sessions.push({ tokenHash: input.sessionTokenHash, userId: input.userId, expiresAt: input.sessionExpiresAt, verified: true, method: channel === 'email' ? 'email_otp' : 'sms_otp' });
    this.events.push({ action: 'student.verified_session_issued', userId: input.userId, details: { channel } });
    return true;
  }
  async completeStudentEmailVerification(input: { challengeId: string; userId: string; destination: string; now: Date }) {
    const challenge = this.challenges.get(input.challengeId);
    const user = this.users.get(input.userId);
    if (!challenge || challenge.consumedAt || challenge.userId !== input.userId || challenge.purpose !== 'student_email_capture' || challenge.channel !== 'email' || !user || user.role !== 'candidate') return false;
    challenge.consumedAt = input.now;
    user.contactEmail = input.destination;
    this.contacts.set(`${input.userId}:email`, input.destination);
    this.events.push({ action: 'student.email_verified', userId: input.userId });
    return true;
  }
  async getInstituteVerification(institutionId: string) { const s = this.institutes.get(institutionId); return s ? { ...s } : null; }
  async completeInstituteContactVerification(input: { challengeId: string; institutionId: string; channel: ContactChannel; destination: string; now: Date }) {
    const c = this.challenges.get(input.challengeId);
    if (!c || c.consumedAt) return false;
    c.consumedAt = input.now;
    const state = this.institutes.get(input.institutionId) ?? { mobileDestination: null, mobileVerifiedAt: null, emailDestination: null, emailVerifiedAt: null, institutionalStatus: 'pending' as const, suspendedAt: null };
    if (input.channel === 'sms') Object.assign(state, { mobileDestination: input.destination, mobileVerifiedAt: input.now });
    else Object.assign(state, { emailDestination: input.destination, emailVerifiedAt: input.now });
    this.institutes.set(input.institutionId, state);
    this.contacts.set(`${input.institutionId}:${input.channel}`, input.destination);
    this.events.push({ action: input.channel === 'sms' ? 'institute.mobile_verified' : 'institute.email_verified', userId: input.institutionId });
    return true;
  }
  async findUserIdByGoogleSub(sub: string) { return this.google.get(sub)?.userId ?? null; }
  async linkGoogleIdentity(userId: string, sub: string, email: string) {
    if (this.google.has(sub)) return 'sub_taken' as const;
    if ([...this.google.values()].some((link) => link.userId === userId)) return 'user_has_link' as const;
    this.google.set(sub, { userId, email });
    return 'linked' as const;
  }
  async createOAuthState(state: OAuthState) { this.oauth.set(state.stateHash, { ...state, consumed: false }); }
  async consumeOAuthState(stateHash: string, now: Date) {
    const state = this.oauth.get(stateHash);
    if (!state || state.consumed || state.expiresAt <= now) return null;
    state.consumed = true;
    return { ...state };
  }
  async recordEvent(event: AuthVerificationEvent) { this.events.push(event); }
  /** Mirrors the PostgreSQL decision transaction (not_found, refused transition, state + audit together). */
  decisionMeta = new Map<string, { decidedAt: Date | null; decidedBy: string | null; suspendedBy: string | null }>();
  eventTimes: Date[] = [];
  unavailable = false; // simulates the AUTH-1 tables not being installed
  private guard() { if (this.unavailable) throw new VerificationStoreUnavailableError(); }
  async listInstituteVerificationOverview(limit: number) {
    this.guard();
    return [...this.users.values()].filter((user) => user.role === 'center').slice(0, limit).map((user) => ({
      institutionId: user.id, loginId: user.loginId, name: user.loginId, accountStatus: user.accountStatus,
      state: { ...(this.institutes.get(user.id) ?? DEFAULT_INSTITUTE_STATE) }, institutionalDecidedAt: this.decisionMeta.get(user.id)?.decidedAt ?? null,
    }));
  }
  async decideInstitutional(input: { institutionId: string; actorId: string; action: InstitutionalAction; reason: string; now: Date }): Promise<InstitutionalDecisionResult> {
    this.guard();
    const user = this.users.get(input.institutionId);
    if (!user || user.role !== 'center') return { status: 'not_found' };
    const current = { ...(this.institutes.get(input.institutionId) ?? DEFAULT_INSTITUTE_STATE) };
    const next = nextInstitutionalState(current, input.action, input.now);
    if (!next) return { status: 'invalid_transition', state: current };
    this.institutes.set(input.institutionId, next);
    const meta = this.decisionMeta.get(input.institutionId) ?? { decidedAt: null, decidedBy: null, suspendedBy: null };
    if (input.action === 'verify' || input.action === 'reject') Object.assign(meta, { decidedAt: input.now, decidedBy: input.actorId });
    else meta.suspendedBy = input.action === 'suspend' ? input.actorId : null;
    this.decisionMeta.set(input.institutionId, meta);
    this.events.push({
      action: INSTITUTIONAL_EVENT_ACTIONS[input.action], userId: input.institutionId,
      details: { actorId: input.actorId, actorKind: 'super_admin', targetInstitutionId: input.institutionId, decision: input.action, reason: input.reason, previous: { institutionalStatus: current.institutionalStatus, suspended: current.suspendedAt !== null } },
    });
    this.eventTimes[this.events.length - 1] = input.now;
    return { status: 'applied', state: next };
  }
  async listInstitutionalDecisions(limit: number) {
    this.guard();
    const names = Object.values(INSTITUTIONAL_EVENT_ACTIONS);
    return this.events.map((event, index) => ({ event, index })).filter(({ event }) => names.includes(event.action)).reverse().slice(0, limit).map(({ event, index }) => ({
      id: `event-${index}`, occurredAt: this.eventTimes[index] ?? new Date(0), action: event.action, institutionId: event.userId,
      actorId: String(event.details?.actorId ?? '') || null, reason: String(event.details?.reason ?? '') || null,
    }));
  }
}

/**
 * TEST-ONLY SMS limits and claim lifetime (AUTH C1 / C1.1-b). Generous so ordinary flows are never
 * limited; tests of the limits pass their own. Never used by production code.
 */
export function testAbuseProtection(
  overrides: Partial<NonNullable<AbuseProtectionConfig['sms']>> = {},
  registrationClaimTtlMs: number | null = 10 * 60 * 1000,
  emailOverrides: Partial<NonNullable<AbuseProtectionConfig['email']>> = {},
): AbuseProtectionConfig {
  return {
    // AUTH C1.4-B-1: TEST-ONLY email limits (generous; tests of the limits pass their own).
    email: {
      unverified: { windowMs: 3600 * 1000, maxSends: 50 },
      account: { windowMs: 3600 * 1000, maxSends: 50 },
      dailyMaxSends: 1000,
      dailyMaxUnverifiedSends: 800,
      ...emailOverrides,
    },
    sms: {
      unverified: { windowMs: 3600 * 1000, maxSends: 50 },
      verified: { windowMs: 3600 * 1000, maxSends: 50 },
      account: { windowMs: 3600 * 1000, maxSends: 50 },
      dailyMaxSends: 1000,
      dailyMaxUnverifiedSends: 800,
      ...overrides,
    },
    registrationClaimTtlMs,
    problems: [],
  };
}

/** In-memory mirror of createPostgresSmsSendGuardStore (serialized by construction: no await inside). */
export class MemorySmsGuardStore implements SmsSendGuardStore {
  reservations: Array<{ reservationId: string; destinationKey: string; bucket: SmsBucket; purpose: VerificationPurpose; at: number }> = [];
  refusals: Array<{ reason: string; bucket: SmsBucket; purpose: VerificationPurpose; reservationId: string }> = [];
  async reserveSmsSend(input: SmsSendReservationInput) {
    const now = Date.now();
    const day = this.reservations.filter((r) => r.at > now - 24 * 3600 * 1000);
    const refuse = <T extends string>(reason: string, result: T) => { this.refusals.push({ reason, bucket: input.bucket, purpose: input.purpose, reservationId: input.reservationId }); return result; };
    if (day.length >= input.dailyMaxSends) return refuse('daily_limit', 'daily_limited' as const);
    if (input.bucket === 'unverified' && day.filter((r) => r.bucket === 'unverified').length >= input.dailyMaxUnverifiedSends) return refuse('unverified_daily_limit', 'unverified_daily_limited' as const);
    if (this.reservations.filter((r) => r.destinationKey === input.destinationKey && r.bucket === input.bucket && r.at > now - input.destinationWindowMs).length >= input.destinationMaxSends) {
      return refuse('destination_limit', 'destination_limited' as const);
    }
    this.reservations.push({ reservationId: input.reservationId, destinationKey: input.destinationKey, bucket: input.bucket, purpose: input.purpose, at: now });
    return 'reserved' as const;
  }
  async smsDestinationUsage(input: { destinationKey: string; bucket: SmsBucket; windowMs: number }) {
    const now = Date.now();
    return this.reservations.filter((r) => r.destinationKey === input.destinationKey && r.bucket === input.bucket && r.at > now - input.windowMs).length;
  }
  async smsUsageLast24h() {
    const day = this.reservations.filter((r) => r.at > Date.now() - 24 * 3600 * 1000);
    return { total: day.length, unverified: day.filter((r) => r.bucket === 'unverified').length };
  }
}

/** AUTH C1.4-B-1: in-memory mirror of createPostgresEmailSendGuardStore (serialized by construction). */
export class MemoryEmailGuardStore implements EmailSendGuardStore {
  reservations: Array<{ reservationId: string; destinationKey: string; bucket: EmailBucket; purpose: VerificationPurpose; at: number }> = [];
  refusals: Array<{ reason: string; bucket: EmailBucket; purpose: VerificationPurpose; reservationId: string }> = [];
  async reserveEmailSend(input: EmailSendReservationInput) {
    const now = Date.now();
    const day = this.reservations.filter((r) => r.at > now - 24 * 3600 * 1000);
    const refuse = <T extends string>(reason: string, result: T) => { this.refusals.push({ reason, bucket: input.bucket, purpose: input.purpose, reservationId: input.reservationId }); return result; };
    if (day.length >= input.dailyMaxSends) return refuse('daily_limit', 'daily_limited' as const);
    if (input.bucket === 'unverified' && day.filter((r) => r.bucket === 'unverified').length >= input.dailyMaxUnverifiedSends) return refuse('unverified_daily_limit', 'unverified_daily_limited' as const);
    if (this.reservations.filter((r) => r.destinationKey === input.destinationKey && r.bucket === input.bucket && r.at > now - input.destinationWindowMs).length >= input.destinationMaxSends) {
      return refuse('destination_limit', 'destination_limited' as const);
    }
    this.reservations.push({ reservationId: input.reservationId, destinationKey: input.destinationKey, bucket: input.bucket, purpose: input.purpose, at: now });
    return 'reserved' as const;
  }
  async emailUsageLast24h() {
    const day = this.reservations.filter((r) => r.at > Date.now() - 24 * 3600 * 1000);
    return { total: day.length, unverified: day.filter((r) => r.bucket === 'unverified').length };
  }
  async emailDestinationUsage(input: { destinationKey: string; bucket: EmailBucket; windowMs: number }) {
    const now = Date.now();
    return this.reservations.filter((r) => r.destinationKey === input.destinationKey && r.bucket === input.bucket && r.at > now - input.windowMs).length;
  }
}
