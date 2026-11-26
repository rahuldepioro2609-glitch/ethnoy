// AUTH-1 tests. No real database, provider or Google endpoint is used: providers are test doubles
// that record codes in memory, the store is in-memory, and the shared pool is stubbed.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as signData } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import express, { type RequestHandler } from 'express';

process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:9/placeholder';

const [{ app }, { pool }, auth, verification, providers, google, support, harness] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
  import('./authVerification.js'),
  import('./verificationProviders.js'),
  import('./googleOAuth.js'),
  import('./authTestSupport.js'),
  import('./staffTestHarness.js'),
]);
const { ContractTestAdapter, MemoryAuthVerificationStore, MemoryEmailGuardStore, MemorySmsGuardStore, RecordingEmailProvider, RecordingSmsProvider, testAbuseProtection, testServices } = support;
const { call, cookieValue, startHarness } = harness;
type StudentRegistrationStore = import('./authVerificationStore.js').StudentRegistrationStore;
type StudentRegistrationClaim = import('./authVerificationStore.js').StudentRegistrationClaim;

// ---------------------------------------------------------------------------
// AUTH C1 in-memory stores (mirror the PostgreSQL semantics of authVerificationStore.ts)
// ---------------------------------------------------------------------------

/** Adds the AUTH C1 capture rule to the shared in-memory store (refuse against mobile-first accounts). */
function withC1CaptureRule(store: InstanceType<typeof MemoryAuthVerificationStore>) {
  const original = store.completeStudentVerification.bind(store);
  (store as unknown as { completeStudentVerification: (input: Parameters<typeof original>[0] & { mobileFirstLoginId?: string }) => Promise<boolean | 'mobile_in_use'> }).completeStudentVerification = async (input) => {
    if (input.mobileFirstLoginId && [...store.users.values()].some((user) => user.loginId === input.mobileFirstLoginId && user.role === 'candidate' && user.id !== input.userId)) {
      const challenge = store.challenges.get(input.challengeId);
      if (!challenge || challenge.consumedAt) return false;
      challenge.consumedAt = input.now;
      store.events.push({ action: 'student.mobile_capture_refused', userId: input.userId, details: { reason: 'mobile_first_account' } });
      return 'mobile_in_use';
    }
    return original(input);
  };
  return store;
}

class MemoryRegistrationStore implements StudentRegistrationStore {
  claims = new Map<string, StudentRegistrationClaim & { consumedAt: Date | null }>();
  constructor(private readonly auth: InstanceType<typeof MemoryAuthVerificationStore>, private readonly onUserCreated: (user: { id: string; loginId: string; displayName: string; passwordHash: string }) => void) {}
  async createClaim(claim: StudentRegistrationClaim) { this.claims.set(claim.id, { ...claim, consumedAt: null }); }
  async getClaimMobile(claimId: string) { return this.claims.get(claimId)?.mobile ?? null; }
  /** Simulates a transient database failure (thrown before any change, i.e. a full rollback). */
  failNext = false;
  async completeRegistration(input: Parameters<StudentRegistrationStore['completeRegistration']>[0]) {
    // No await inside: atomic with respect to other requests, like the PostgreSQL transaction + locks.
    if (this.failNext) { this.failNext = false; throw new Error('synthetic transient database failure'); }
    const claim = this.claims.get(input.claimId);
    const challenge = this.auth.challenges.get(input.challengeId);
    if (!claim || !challenge || challenge.consumedAt || challenge.registrationClaimId !== input.claimId || challenge.expiresAt <= input.now) return 'not_in_progress' as const;
    challenge.consumedAt = input.now;
    const channel = input.channel ?? 'sms';
    // SMS: the code went to the claim's mobile. Email (AUTH_MOBILE_VERIFICATION off): to the challenge's email.
    if (claim.consumedAt || claim.expiresAt <= input.now || (channel === 'sms' && claim.mobile !== input.destination)) {
      this.auth.events.push({ action: 'student.registration_refused', userId: null, details: { reason: 'claim_expired' } });
      return 'expired' as const;
    }
    const owned = [...this.auth.contacts.entries()].some(([key, destination]) => key.endsWith(':sms') && destination === claim.mobile && this.auth.users.get(key.slice(0, -4))?.role === 'candidate');
    if (owned || [...this.auth.users.values()].some((user) => user.loginId === input.loginId)) {
      claim.consumedAt ??= input.now; // AUTH C1.1: a refused claim is dead
      this.auth.events.push({ action: 'student.registration_refused', userId: null, details: { reason: owned ? 'mobile_in_use' : 'login_id_taken' } });
      return 'refused' as const;
    }
    this.auth.users.set(input.userId, { id: input.userId, loginId: input.loginId, role: 'candidate', accountStatus: 'approved', contactEmail: channel === 'email' ? input.destination : null });
    this.onUserCreated({ id: input.userId, loginId: input.loginId, displayName: claim.displayName, passwordHash: claim.passwordHash });
    this.auth.contacts.set(`${input.userId}:${channel}`, channel === 'sms' ? claim.mobile : input.destination);
    this.auth.sessions.push({ tokenHash: input.sessionTokenHash, userId: input.userId, expiresAt: input.sessionExpiresAt, verified: true, method: channel === 'email' ? 'email_otp' : 'sms_otp' });
    // AUTH C1.1: the completed claim is deleted, and its challenge with it (ON DELETE CASCADE).
    this.removeClaim(claim.id);
    this.auth.events.push({ action: 'student.registration_completed', userId: input.userId }, { action: 'student.verified_session_issued', userId: input.userId });
    return 'completed' as const;
  }
  async deleteExpiredClaims(now: Date, limit: number) {
    const live = (id: string) => [...this.auth.challenges.values()].some((c) => c.registrationClaimId === id && !c.consumedAt && c.expiresAt > now);
    const eligible = [...this.claims.values()].filter((claim) => (claim.consumedAt !== null || claim.expiresAt <= now) && !live(claim.id)).slice(0, limit);
    for (const claim of eligible) this.removeClaim(claim.id);
    return eligible.length;
  }
  private removeClaim(id: string) {
    this.claims.delete(id);
    for (const [challengeId, challenge] of this.auth.challenges) if (challenge.registrationClaimId === id) this.auth.challenges.delete(challengeId); // ON DELETE CASCADE
  }
}

/** TEST-ONLY limits (the real values are pending owner approval; production has no defaults). */
const TEST_PROTECTION = testAbuseProtection();

/** For tests that configure providers themselves: test-only SMS limits and an in-memory guard. */
function enableTestSmsProtection() {
  const guard = new MemorySmsGuardStore();
  verification.configureSmsSendGuardStore(guard);
  verification.configureEmailSendGuardStore(new MemoryEmailGuardStore());
  verification.configureAbuseProtection(testAbuseProtection());
  return guard;
}

const STUDENT_PASSWORD = 'Student-password-2026';
const INSTITUTE_PASSWORD = 'Institute-password-2026';

function routeHandlers(method: 'get' | 'post', path: string): RequestHandler[] {
  const stack = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } })._router.stack;
  const route = stack.map((layer) => layer.route).find((candidate) => candidate?.path === path && candidate.methods[method]);
  assert.ok(route, `${method} ${path}`);
  return route.stack.map((layer) => layer.handle);
}

interface Fixture {
  store: InstanceType<typeof MemoryAuthVerificationStore>;
  sms: InstanceType<typeof RecordingSmsProvider>;
  email: InstanceType<typeof RecordingEmailProvider>;
  base: string;
  close: () => Promise<void>;
  sessionsInserted: string[];
  /** Sessions that exist WITHOUT a verification record (e.g. issued before AUTH-1), by token hash. */
  legacy: Map<string, string>;
  lookups: number;
  /** login_id values passed to INSERT INTO users (the pool stub; AUTH C1 registration never uses it). */
  inserted: string[];
  /** AUTH C1 stores. */
  registrations: MemoryRegistrationStore;
  smsGuard: InstanceType<typeof MemorySmsGuardStore>;
  /** AUTH C1.4-B-1. */
  emailGuard: InstanceType<typeof MemoryEmailGuardStore>;
  /** Accounts created by registration completion (login IDs). */
  created: string[];
}

/**
 * A loopback HTTP app with the REAL login/register/me handlers and the REAL verification router.
 * The shared pool answers only users lookups, users inserts, auth_sessions inserts and session
 * lookups, from in-memory fixtures; any other query fails the test.
 */
async function setup(options: { services?: 'none' | 'sms' | 'both' | 'email'; mobileVerification?: 'required' | 'off'; studentMobile?: string | null; studentEmail?: string | null; extraStudents?: Array<{ id: string; loginId: string; mobile?: string }>; institute?: { status: string; verification?: Parameters<InstanceType<typeof MemoryAuthVerificationStore>['institutes']['set']>[1] }; protection?: import('./authVerification.js').AbuseProtectionConfig } = {}): Promise<Fixture> {
  const store = withC1CaptureRule(new MemoryAuthVerificationStore());
  const sms = new RecordingSmsProvider();
  const email = new RecordingEmailProvider();
  const mode = options.services ?? 'both';
  providers.configureVerificationServices(mode === 'none' ? providers.DISABLED_SERVICES : {
    ...testServices({ sms: mode === 'email' ? null : sms, email: mode === 'both' || mode === 'email' ? email : null }),
    mobileVerification: options.mobileVerification ?? 'required',
  });
  verification.configureAuthVerificationStore(store);
  const studentHash = await bcrypt.hash(STUDENT_PASSWORD, 4);
  const instituteHash = await bcrypt.hash(INSTITUTE_PASSWORD, 4);
  const users = [
    { id: 'student-1', login_id: 'STUDENT-1', display_name: 'Synthetic Student', role: 'candidate', password_hash: studentHash, account_status: 'approved', is_super_admin: false, contact_email: null },
    { id: 'institute-1', login_id: 'INSTITUTE-1', display_name: 'Synthetic Institute', role: 'center', password_hash: instituteHash, account_status: options.institute?.status ?? 'approved', is_super_admin: false, contact_email: 'office@example.test' },
  ];
  for (const extra of options.extraStudents ?? []) {
    users.push({ id: extra.id, login_id: extra.loginId, display_name: 'Synthetic Student', role: 'candidate', password_hash: studentHash, account_status: 'approved', is_super_admin: false, contact_email: null });
    if (extra.mobile) store.contacts.set(`${extra.id}:sms`, extra.mobile);
  }
  for (const user of users) store.users.set(user.id, { id: user.id, loginId: user.login_id, role: user.role as 'candidate' | 'center', accountStatus: user.account_status, contactEmail: user.contact_email });
  if (options.studentMobile) store.contacts.set('student-1:sms', options.studentMobile);
  if (options.studentEmail) store.contacts.set('student-1:email', options.studentEmail);
  if (options.institute?.verification) store.institutes.set('institute-1', options.institute.verification);
  const created: string[] = [];
  const registrations = new MemoryRegistrationStore(store, (user) => {
    created.push(user.loginId);
    users.push({ id: user.id, login_id: user.loginId, display_name: user.displayName, role: 'candidate', password_hash: user.passwordHash, account_status: 'approved', is_super_admin: false, contact_email: null });
  });
  const smsGuard = new MemorySmsGuardStore();
  const emailGuard = new MemoryEmailGuardStore();
  verification.configureStudentRegistrationStore(registrations);
  verification.configureSmsSendGuardStore(smsGuard);
  verification.configureEmailSendGuardStore(emailGuard);
  verification.configureAbuseProtection(options.protection ?? TEST_PROTECTION);
  const fixture: Fixture = { store, sms, email, base: '', close: async () => undefined, sessionsInserted: [], legacy: new Map(), lookups: 0, inserted: [], registrations, smsGuard, emailGuard, created };

  (pool as unknown as { query: unknown }).query = async (text: string, values: unknown[] = []) => {
    if (text.includes('JOIN institute_verifications iv') && text.includes('lower(iv.email_destination)')) {
      fixture.lookups += 1;
      const emailAddress = String(values[0]).trim().toLowerCase();
      const matches = users.filter((user) => {
        const state = store.institutes.get(user.id);
        return user.role === 'center' && Boolean(state?.emailVerifiedAt)
          && state?.emailDestination?.toLowerCase() === emailAddress;
      });
      return { rows: matches.slice(0, 2) };
    }
    if (text.includes('FROM users WHERE login_id = $1 AND role = $2')) {
      fixture.lookups += 1;
      return { rows: users.filter((user) => user.login_id === values[0] && user.role === values[1]) };
    }
    if (text.includes("FROM users WHERE login_id = $1 AND role = 'candidate'")) {
      fixture.lookups += 1;
      return { rows: users.filter((user) => user.login_id === values[0] && user.role === 'candidate') };
    }
    if (text.includes("FROM users WHERE id = $1 AND role = 'candidate'")) {
      fixture.lookups += 1;
      return { rows: users.filter((user) => user.id === values[0] && user.role === 'candidate') };
    }
    if (text.includes('INSERT INTO auth_sessions')) {
      fixture.sessionsInserted.push(String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM auth_sessions s')) {
      const tokenHash = String(values[0]);
      const verified = store.sessions.find((session) => session.tokenHash === tokenHash);
      const ownerId = verified?.userId ?? fixture.legacy.get(tokenHash) ?? (fixture.sessionsInserted.includes(tokenHash) ? 'institute-1' : undefined);
      if (!ownerId) return { rows: [] };
      const user = users.find((candidate) => candidate.id === ownerId)!;
      const state = store.institutes.get(user.id);
      // Mirrors `v.method = ANY($2)`: only the accepted session methods count as verification evidence.
      const accepted = Array.isArray(values[1]) ? values[1] as string[] : ['sms_otp'];
      const evidence = verified !== undefined && accepted.includes(verified.method ?? 'sms_otp');
      return { rows: [{ ...user, session_verified_at: evidence ? new Date() : null, iv_institution_id: state ? user.id : null,
        iv_mobile_verified_at: state?.mobileVerifiedAt ?? null, iv_email_verified_at: state?.emailVerifiedAt ?? null,
        iv_institutional_status: state?.institutionalStatus ?? null, iv_suspended_at: state?.suspendedAt ?? null }] };
    }
    if (text.includes('INSERT INTO users')) {
      fixture.inserted.push(String(values[1]));
      // Mirrors ON CONFLICT (login_id) DO NOTHING on the existing UNIQUE login_id.
      if (users.some((user) => user.login_id === values[1])) return { rows: [] };
      return { rows: [{ id: 'new-student', login_id: String(values[1]), display_name: String(values[2]), role: 'candidate' }] };
    }
    throw new Error(`unexpected query in AUTH-1 test: ${text.slice(0, 80)}`);
  };

  const testApp = express.Router();
  // The shared production rate limiter (first handler) is skipped, as in the existing route tests.
  testApp.post('/auth/login', ...routeHandlers('post', '/api/auth/login').slice(1));
  testApp.post('/auth/register', ...routeHandlers('post', '/api/auth/register').slice(1));
  testApp.get('/auth/me', ...routeHandlers('get', '/api/auth/me'));
  const server = await startHarness([testApp, verification.createAuthVerificationRouter()]);
  fixture.base = server.url;
  fixture.close = async () => {
    await server.close();
    providers.configureVerificationServices(providers.DISABLED_SERVICES);
    verification.configureAbuseProtection(undefined); // back to the (unset) environment: fail closed
  };
  return fixture;
}

const studentLogin = (f: Fixture) => call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { loginId: 'student-1', password: STUDENT_PASSWORD, role: 'candidate' } });
const instituteLogin = (f: Fixture) => call(f.base, 'POST', '/api/auth/login', { surface: 'institution', body: { loginId: 'institute-1', password: INSTITUTE_PASSWORD, role: 'center' } });
const instituteEmailLogin = (f: Fixture, email = 'office@example.test', password = INSTITUTE_PASSWORD) => call(f.base, 'POST', '/api/auth/login', { surface: 'institution', body: { loginId: email, password, role: 'center' } });
const verificationCookie = (result: { setCookies: string[] }) => `elt_verification=${cookieValue(result.setCookies, 'elt_verification')}`;
const verify = (f: Fixture, cookie: string, code: string, surface = 'exam') => call(f.base, 'POST', '/api/auth/verification/verify', { surface, cookie, body: { code } });

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

test('no providers are configured by default; incomplete or unknown configuration stays disabled', () => {
  const none = providers.resolveVerificationServices({});
  assert.deepEqual([none.sms, none.email, none.google, none.otpKey], [null, null, null, null]);
  const unknown = providers.resolveVerificationServices({ AUTH_SMS_PROVIDER: 'any-vendor', AUTH_EMAIL_PROVIDER: 'any-vendor' });
  assert.equal(unknown.sms, null);
  assert.equal(unknown.email, null);
  assert.match(unknown.reasons.sms ?? '', /no approved integration/);
  const googleIncomplete = providers.resolveVerificationServices({ GOOGLE_OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com' });
  assert.equal(googleIncomplete.google, null);
  for (const uri of ['http://exam.eltnoy.com/api/auth/google/callback', 'https://exam.eltnoy.com/other', 'https://user:pw@exam.eltnoy.com/api/auth/google/callback', 'https://exam.eltnoy.com/api/auth/google/callback?x=1', 'not a url']) {
    assert.equal(providers.validateRedirectUri(uri, 'exam.eltnoy.com'), null, uri);
  }
  assert.equal(providers.validateRedirectUri('https://exam.eltnoy.com/api/auth/google/callback', 'exam.eltnoy.com'), 'https://exam.eltnoy.com/api/auth/google/callback');
  const status = providers.providerStatus(providers.DISABLED_SERVICES);
  assert.deepEqual([status.sms.available, status.email.available, status.google.available], [false, false, false]);
});

test('OTP primitives: 6 CSPRNG digits, keyed hash only, constant-time comparison', () => {
  const key = Buffer.alloc(32, 1);
  const codes = new Set(Array.from({ length: 200 }, () => providers.generateOtp()));
  assert.ok([...codes].every((code) => /^[0-9]{6}$/.test(code)));
  assert.ok(codes.size > 190, 'codes are not predictable or repeated');
  const hash = providers.hashOtp(key, 'challenge-1', '123456');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes('123456'));
  assert.notEqual(hash, providers.hashOtp(key, 'challenge-2', '123456'), 'bound to the challenge');
  assert.notEqual(hash, providers.hashOtp(Buffer.alloc(32, 2), 'challenge-1', '123456'), 'bound to the server key');
  assert.equal(providers.otpMatches(key, 'challenge-1', '123456', hash), true);
  for (const wrong of ['123457', '12345', '1234567', 'abcdef', '']) assert.equal(providers.otpMatches(key, 'challenge-1', wrong, hash), false, wrong);
  assert.equal(providers.normaliseMobile('98765 43210'), '+919876543210');
  assert.equal(providers.normaliseMobile('+91-9876543210'), '+919876543210');
  for (const bad of ['12345', '5876543210', '+1 202 555 0100', 42]) assert.equal(providers.normaliseMobile(bad), null, String(bad));
});

// ---------------------------------------------------------------------------
// Closed while no provider exists (the current state)
// ---------------------------------------------------------------------------

test('with no providers: Student and Institute sign-in and registration are closed before any lookup or write', async () => {
  const f = await setup({ services: 'none' });
  try {
    const status = await call(f.base, 'GET', '/api/auth/providers', { surface: 'exam' });
    assert.deepEqual([status.body.sms, status.body.email, status.body.google].map((entry) => (entry as { available: boolean }).available), [false, false, false]);
    const student = await studentLogin(f);
    assert.equal(student.status, 503);
    assert.equal(student.body.code, 'OTP_PROVIDER_NOT_CONFIGURED');
    const institute = await instituteLogin(f);
    assert.equal(institute.status, 503);
    assert.equal(institute.body.code, 'EMAIL_PROVIDER_NOT_CONFIGURED');
    const register = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { loginId: 'NEW-STUDENT', name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543210' } });
    assert.equal(register.status, 503);
    assert.equal(f.lookups, 0, 'no account lookup reveals anything');
    for (const result of [student, institute, register]) {
      assert.equal(cookieValue(result.setCookies, 'elt_session'), undefined);
      assert.equal(cookieValue(result.setCookies, 'elt_verification'), undefined);
    }
    assert.equal(f.sms.sent.length + f.email.sent.length, 0, 'nothing is sent');
    // A wrong password gets the same 503: availability is checked before credentials.
    const wrong = await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { loginId: 'student-1', password: 'wrong-password-123', role: 'candidate' } });
    assert.deepEqual([wrong.status, wrong.body.code], [503, 'OTP_PROVIDER_NOT_CONFIGURED']);
    // Verification endpoints have nothing to act on.
    for (const path of ['/api/auth/verification/verify', '/api/auth/verification/resend', '/api/auth/verification/destination']) {
      const result = await call(f.base, 'POST', path, { surface: 'exam', body: { code: '000000', mobile: '9876543210' } });
      assert.equal(result.status, 401, path);
      assert.equal(result.body.code, 'NO_VERIFICATION_IN_PROGRESS');
    }
    // Google is unavailable and never redirects anywhere.
    for (const path of ['/api/auth/google/start', '/api/auth/google/callback?code=x&state=y']) {
      const result = await call(f.base, 'GET', path, { surface: 'exam' });
      assert.deepEqual([result.status, result.body.code], [503, 'GOOGLE_OAUTH_NOT_CONFIGURED'], path);
    }
  } finally {
    await f.close();
  }
});

test('the session gate refuses Student and Institute sessions without server-side verification evidence', () => {
  const none = { sessionVerified: false, institute: null };
  assert.equal(auth.portalVerificationGate('candidate', none).ok, false);
  assert.equal(auth.portalVerificationGate('center', none).ok, false);
  // AUTH C1.9.1: Officials and Super Admins now need MFA evidence on the session (absent means refused).
  assert.deepEqual(auth.portalVerificationGate('official', none), { ok: false, code: 'ADMIN_MFA_REQUIRED', message: 'Administrative access requires multi-factor authentication. Please sign in again.' });
  assert.equal(auth.portalVerificationGate('official', { ...none, officialMfaVerified: false }).ok, false);
  assert.equal(auth.portalVerificationGate('official', { ...none, officialMfaVerified: true }).ok, true);
  // Student and Institute decisions never depend on the Official MFA field.
  assert.equal(auth.portalVerificationGate('candidate', { ...none, officialMfaVerified: true }).ok, false);
  assert.equal(auth.portalVerificationGate('center', { ...none, officialMfaVerified: true }).ok, false);
  assert.equal(auth.portalVerificationGate('candidate', { sessionVerified: true, institute: null }).ok, true);
  const base = { mobileVerified: true, emailVerified: true, institutionalStatus: 'verified' as const, suspended: false };
  assert.equal(auth.portalVerificationGate('center', { sessionVerified: false, institute: base }).ok, true);
  for (const [label, institute] of [
    ['mobile only', { ...base, emailVerified: false }],
    ['email only', { ...base, mobileVerified: false }],
    ['institutional pending', { ...base, institutionalStatus: 'pending' as const }],
    ['institutional rejected', { ...base, institutionalStatus: 'rejected' as const }],
  ] as const) {
    const decision = auth.portalVerificationGate('center', { sessionVerified: true, institute });
    assert.deepEqual(decision.ok ? 'ok' : decision.code, 'INSTITUTE_VERIFICATION_INCOMPLETE', label);
  }
  const suspended = auth.portalVerificationGate('center', { sessionVerified: true, institute: { ...base, suspended: true } });
  assert.deepEqual(suspended.ok ? 'ok' : suspended.code, 'INSTITUTE_SUSPENDED');
});

// ---------------------------------------------------------------------------
// Student: password + mobile OTP
// ---------------------------------------------------------------------------

test('Student: a correct password gives no session; only a verified OTP issues one, exactly once', async () => {
  const f = await setup({ studentMobile: '+919876543210' });
  try {
    const login = await studentLogin(f);
    assert.equal(login.status, 202);
    assert.equal(login.body.status, 'verification_required');
    assert.equal(login.body.destination, '+91******10', 'masked');
    assert.equal(cookieValue(login.setCookies, 'elt_session'), undefined, 'no session before verification');
    assert.equal(f.sessionsInserted.length + f.store.sessions.length, 0);
    const raw = login.setCookies.find((cookie) => cookie.startsWith('elt_verification='))!;
    assert.match(raw, /Path=\/api\/auth\/verification;.*HttpOnly; SameSite=Strict/);
    const cookie = verificationCookie(login);
    const code = f.sms.lastCode()!;
    assert.equal(f.sms.sent[0].destination, '+919876543210');
    assert.ok(!JSON.stringify(login.body).includes(code), 'the code is never returned');
    assert.ok(!JSON.stringify(f.store.events).includes(code) && !JSON.stringify([...f.store.challenges.values()]).includes(`"${code}"`), 'the code is never stored or audited');
    // Client-claimed verification is ignored.
    assert.equal((await verify(f, cookie, '000000')).status === 200, false);
    const wrongCode = code === '111111' ? '222222' : '111111';
    const wrong = await verify(f, cookie, wrongCode);
    assert.deepEqual([wrong.status, wrong.body.code], [400, 'INVALID_CODE']);
    const ok = await verify(f, cookie, code);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'signed_in');
    const session = cookieValue(ok.setCookies, 'elt_session');
    assert.ok(session);
    assert.equal(f.store.sessions.length, 1);
    assert.equal(f.store.sessions[0].verified, true);
    const me = await call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: `elt_session=${session}` });
    assert.equal(me.status, 200);
    const replay = await verify(f, cookie, code);
    assert.equal(replay.status, 401, 'single use');
  } finally {
    await f.close();
  }
});

test('Student: attempt limit, expiry, resend cooldown, resend cap and account throttling', async () => {
  const f = await setup({ studentMobile: '+919876543210' });
  try {
    const login = await studentLogin(f);
    const cookie = verificationCookie(login);
    const code = f.sms.lastCode()!;
    const wrongCode = code === '111111' ? '222222' : '111111';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await verify(f, cookie, wrongCode);
      assert.deepEqual([result.status, result.body.attemptsRemaining], [400, 5 - attempt]);
    }
    const locked = await verify(f, cookie, wrongCode);
    assert.deepEqual([locked.status, locked.body.code], [429, 'TOO_MANY_ATTEMPTS']);
    assert.equal((await verify(f, cookie, code)).status, 401, 'locked challenge cannot be used even with the right code');

    const second = await studentLogin(f);
    const cookie2 = verificationCookie(second);
    const cooldown = await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'exam', cookie: cookie2 });
    assert.deepEqual([cooldown.status, cooldown.body.code], [429, 'RESEND_COOLDOWN']);
    const challenge = [...f.store.challenges.values()].at(-1)!;
    for (const expected of [200, 200, 429]) {
      challenge.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
      const resend = await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'exam', cookie: cookie2 });
      assert.equal(resend.status, expected);
    }
    challenge.codeExpiresAt = new Date(Date.now() - 1000);
    const expired = await verify(f, cookie2, f.sms.lastCode()!);
    assert.deepEqual([expired.status, expired.body.code], [410, 'CODE_EXPIRED']);
    challenge.expiresAt = new Date(Date.now() - 1000);
    const gone = await verify(f, cookie2, f.sms.lastCode()!);
    assert.deepEqual([gone.status, gone.body.code], [410, 'VERIFICATION_EXPIRED']);

    for (let i = 0; i < 3; i += 1) assert.equal((await studentLogin(f)).status, 202);
    const throttled = await studentLogin(f);
    assert.deepEqual([throttled.status, throttled.body.code], [429, 'TOO_MANY_VERIFICATION_REQUESTS']);
  } finally {
    await f.close();
  }
});

test('Student without a registered mobile: capture at next sign-in, then OTP; delivery failure fails closed', async () => {
  const f = await setup({ studentMobile: null });
  try {
    const login = await studentLogin(f);
    assert.deepEqual([login.status, login.body.step, login.body.codeSent], [202, 'destination', false]);
    const cookie = verificationCookie(login);
    assert.equal((await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie, body: { mobile: '12345' } })).status, 400);
    f.sms.failNext = true;
    const failed = await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie, body: { mobile: '9876543211' } });
    assert.deepEqual([failed.status, failed.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    assert.equal((await verify(f, cookie, '123456')).status, 401, 'a failed delivery invalidates the challenge');

    const retry = await studentLogin(f);
    const cookie2 = verificationCookie(retry);
    const captured = await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: cookie2, body: { mobile: '98765 43211' } });
    assert.deepEqual([captured.status, captured.body.step, captured.body.destination], [200, 'code', '+91******11']);
    assert.equal((await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: cookie2, body: { mobile: '9876543212' } })).status, 409, 'destination cannot be swapped');
    const ok = await verify(f, cookie2, f.sms.lastCode()!);
    assert.equal(ok.status, 200);
    assert.equal(f.store.contacts.get('student-1:sms'), '+919876543211');
  } finally {
    await f.close();
  }
});

/** Every request reads its challenge snapshot, then waits, so parallel requests all act on stale state. */
function delayChallengeReads(store: InstanceType<typeof MemoryAuthVerificationStore>) {
  const read = store.getChallenge.bind(store);
  store.getChallenge = async (id: string) => {
    const snapshot = await read(id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return snapshot;
  };
}

test('concurrency: parallel guesses, captures and resends cannot exceed the limits or misdirect a code', async () => {
  const f = await setup({ studentMobile: '+919876543210' });
  try {
    const cookie = verificationCookie(await studentLogin(f));
    const code = f.sms.lastCode()!;
    const wrongCode = code === '111111' ? '222222' : '111111';
    delayChallengeReads(f.store);
    const guesses = await Promise.all(Array.from({ length: 8 }, () => verify(f, cookie, wrongCode)));
    assert.equal(f.store.events.filter((event) => event.action === 'verification.code_rejected').length, 5, 'at most 5 codes are ever compared');
    assert.equal(guesses.filter((result) => result.status === 400).length, 4);
    assert.ok(guesses.filter((result) => result.status !== 400).every((result) => result.status === 429 && result.body.code === 'TOO_MANY_ATTEMPTS'));
    assert.equal([...f.store.challenges.values()][0].attempts, 5);

    const second = await studentLogin(f);
    const challenge = [...f.store.challenges.values()].at(-1)!;
    challenge.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    const sentBefore = f.sms.sent.length;
    const resends = await Promise.all(Array.from({ length: 4 }, () => call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'exam', cookie: verificationCookie(second) })));
    assert.equal(f.sms.sent.length - sentBefore, 1, 'one resend delivered, not four');
    assert.equal(challenge.sendCount, 2);
    assert.equal(resends.filter((result) => result.status === 200).length, 1);
    assert.ok(resends.filter((result) => result.status !== 200).every((result) => result.body.code === 'VERIFICATION_CONFLICT'));
  } finally {
    await f.close();
  }

  const g = await setup({ studentMobile: null });
  try {
    const cookie = verificationCookie(await studentLogin(g));
    delayChallengeReads(g.store);
    const captures = await Promise.all(['9876543221', '9876543222'].map((mobile) => call(g.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie, body: { mobile } })));
    const stored = [...g.store.challenges.values()][0].destination;
    assert.deepEqual(captures.map((result) => result.status).sort(), [200, 409]);
    assert.equal(g.sms.sent.length, 1);
    assert.equal(g.sms.sent[0].destination, stored, 'the code goes only to the stored destination');
    assert.equal((await verify(g, cookie, g.sms.lastCode()!)).status, 200);
    assert.equal(g.store.contacts.get('student-1:sms'), stored);
  } finally {
    await g.close();
  }
});

test('Student registration (AUTH C1): a claim, not an account, until the mobile is verified; then one account, atomically', async () => {
  const f = await setup({});
  try {
    const usersBefore = f.store.users.size;
    const result = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { loginId: 'new-student', name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543213' } });
    assert.deepEqual([result.status, result.body.purpose, result.body.step, result.body.codeSent], [202, 'student_registration', 'code', true]);
    assert.equal(cookieValue(result.setCookies, 'elt_session'), undefined, 'no session before verification');
    assert.equal(f.store.users.size, usersBefore, 'no permanent account before verification');
    assert.deepEqual([f.inserted, f.created], [[], []], 'no users row and no login ID reserved');
    assert.equal(f.registrations.claims.size, 1);
    const challenge = [...f.store.challenges.values()].at(-1)!;
    assert.equal(challenge.userId, null, 'the challenge is owned by the claim, not by an account');
    assert.equal(challenge.registrationClaimId, [...f.registrations.claims.keys()][0]);
    // Before verification there is no portal access at all.
    assert.equal((await call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: verificationCookie(result) })).status, 401);
    assert.equal((await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { loginId: 'other', name: 'Other', password: STUDENT_PASSWORD, mobile: 'nope' } })).status, 400);

    const ok = await verify(f, verificationCookie(result), f.sms.lastCode()!);
    assert.deepEqual([ok.status, ok.body.status], [200, 'signed_in']);
    assert.deepEqual(f.created, [derivedId('+919876543213')], 'exactly one account, with the mobile-derived login ID');
    const account = [...f.store.users.values()].find((user) => user.loginId === derivedId('+919876543213'))!;
    assert.equal(f.store.contacts.get(`${account.id}:sms`), '+919876543213', 'verified contact written with the account');
    assert.equal(f.store.sessions.filter((session) => session.userId === account.id && session.verified).length, 1, 'one verified session');
    assert.equal(f.registrations.claims.size, 0, 'AUTH C1.1: the completed claim is deleted in the completion');
    assert.equal(f.store.challenges.has(challenge.id), false, 'its registration challenge went with it (cascade)');
    const session = cookieValue(ok.setCookies, 'elt_session')!;
    assert.equal((await call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: `elt_session=${session}` })).status, 200, 'the verified session reaches the portal');
    assert.equal((await verify(f, verificationCookie(result), f.sms.lastCode()!)).status, 401, 'single use');
    assert.equal(f.created.length, 1);
  } finally {
    await f.close();
  }
});

test('legacy sessions without verification evidence are refused on every request (Student and Institute)', async () => {
  const f = await setup({ studentMobile: '+919876543210' });
  try {
    const studentToken = 'L'.repeat(43);
    const instituteToken = 'M'.repeat(43);
    f.legacy.set(auth.hashSessionToken(studentToken), 'student-1');
    f.legacy.set(auth.hashSessionToken(instituteToken), 'institute-1');
    const student = await call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: `elt_session=${studentToken}` });
    assert.deepEqual([student.status, student.body.code], [403, 'STUDENT_VERIFICATION_REQUIRED']);
    assert.match(student.setCookies.join(';'), /elt_session=;/, 'the refused session cookie is cleared');
    const institute = await call(f.base, 'GET', '/api/auth/me', { surface: 'institution', cookie: `elt_session=${instituteToken}` });
    assert.deepEqual([institute.status, institute.body.code], [403, 'INSTITUTE_VERIFICATION_INCOMPLETE']);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Institute: independent mobile and email, institutional verification, approval, suspension
// ---------------------------------------------------------------------------

test('Institute: mobile then email are verified independently; access also needs institutional verification', async () => {
  const f = await setup({ institute: { status: 'approved', verification: { mobileDestination: '+919876500010', mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null } } });
  try {
    const login = await instituteLogin(f);
    assert.deepEqual([login.status, login.body.channel, login.body.purpose], [202, 'sms', 'institute_mobile']);
    assert.equal(cookieValue(login.setCookies, 'elt_session'), undefined);
    const mobile = await verify(f, verificationCookie(login), f.sms.lastCode()!, 'institution');
    assert.deepEqual([mobile.status, mobile.body.verified, mobile.body.channel], [200, 'sms', 'email'], 'email is still required');
    assert.equal(f.email.sent[0].destination, 'office@example.test');
    const state = f.store.institutes.get('institute-1')!;
    assert.ok(state.mobileVerifiedAt && !state.emailVerifiedAt, 'mobile does not imply email');
    const emailDone = await verify(f, verificationCookie(mobile), f.email.lastCode()!, 'institution');
    assert.deepEqual([emailDone.status, emailDone.body.status], [200, 'contacts_verified']);
    assert.equal(cookieValue(emailDone.setCookies, 'elt_session'), undefined, 'verification itself never signs an Institute in');
    const pending = await instituteLogin(f);
    assert.deepEqual([pending.status, pending.body.code], [403, 'INSTITUTIONAL_VERIFICATION_PENDING']);
    f.store.institutes.get('institute-1')!.institutionalStatus = 'verified';
    const signedIn = await instituteLogin(f);
    assert.equal(signedIn.status, 200);
    const session = cookieValue(signedIn.setCookies, 'elt_session')!;
    assert.equal((await call(f.base, 'GET', '/api/auth/me', { surface: 'institution', cookie: `elt_session=${session}` })).status, 200);
    // Suspension ends access on the next request and blocks sign-in.
    f.store.institutes.get('institute-1')!.suspendedAt = new Date();
    const me = await call(f.base, 'GET', '/api/auth/me', { surface: 'institution', cookie: `elt_session=${session}` });
    assert.deepEqual([me.status, me.body.code], [403, 'INSTITUTE_SUSPENDED']);
    const blocked = await instituteLogin(f);
    assert.deepEqual([blocked.status, blocked.body.code], [403, 'INSTITUTE_SUSPENDED']);
  } finally {
    await f.close();
  }
});

test('Institute: verified email sign-in works without an SMS provider; Student SMS requirements stay unchanged', async () => {
  const f = await setup({ services: 'email', institute: { status: 'approved', verification: { mobileDestination: '+919876500010', mobileVerifiedAt: new Date(), emailDestination: 'office@example.test', emailVerifiedAt: new Date(), institutionalStatus: 'verified', suspendedAt: null } } });
  try {
    const login = await instituteEmailLogin(f);
    assert.equal(login.status, 200);
    assert.ok(cookieValue(login.setCookies, 'elt_session'), 'a session is issued only after matching password and verified institute state');
    assert.equal(f.sessionsInserted.length, 1);

    const wrongPassword = await instituteEmailLogin(f, 'office@example.test', 'Wrong-password-2026');
    assert.equal(wrongPassword.status, 401);
    assert.equal(cookieValue(wrongPassword.setCookies, 'elt_session'), undefined);

    f.store.institutes.get('institute-1')!.emailVerifiedAt = null;
    const unverifiedAddress = await instituteEmailLogin(f);
    assert.equal(unverifiedAddress.status, 401, 'unverified contact emails cannot become login aliases');
    assert.equal(cookieValue(unverifiedAddress.setCookies, 'elt_session'), undefined);

    f.store.institutes.get('institute-1')!.emailVerifiedAt = new Date();
    f.store.institutes.get('institute-1')!.institutionalStatus = 'pending';
    const pending = await instituteEmailLogin(f);
    assert.deepEqual([pending.status, pending.body.code], [403, 'INSTITUTIONAL_VERIFICATION_PENDING']);
    assert.equal(cookieValue(pending.setCookies, 'elt_session'), undefined);
    assert.equal(f.sms.sent.length, 0, 'a verified Institute mobile needs no SMS at login');

    const student = await studentLogin(f);
    assert.deepEqual([student.status, student.body.code], [503, 'OTP_PROVIDER_NOT_CONFIGURED'], 'Institute sign-in availability does not weaken Student SMS verification');
  } finally {
    await f.close();
  }
});

test('Institute: without a verified mobile, email-only provider configuration cannot bypass the mobile challenge', async () => {
  const f = await setup({ services: 'email', institute: { status: 'approved', verification: { mobileDestination: '+919876500010', mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: new Date(), institutionalStatus: 'verified', suspendedAt: null } } });
  try {
    const result = await instituteEmailLogin(f);
    assert.deepEqual([result.status, result.body.code], [503, 'OTP_PROVIDER_NOT_CONFIGURED']);
    assert.equal(cookieValue(result.setCookies, 'elt_session'), undefined);
  } finally {
    await f.close();
  }
});

test('Institute: pending and rejected accounts never reach verification or a session; email-only providers keep it closed', async () => {
  for (const [status, code] of [['pending', 'APPROVAL_PENDING'], ['rejected', 'ACCOUNT_REJECTED']] as const) {
    const f = await setup({ institute: { status } });
    try {
      const result = await instituteLogin(f);
      assert.deepEqual([result.status, result.body.code], [403, code]);
      assert.equal(cookieValue(result.setCookies, 'elt_verification'), undefined);
    } finally {
      await f.close();
    }
  }
  const smsOnly = await setup({ services: 'sms', institute: { status: 'approved' } });
  try {
    const result = await instituteLogin(smsOnly);
    assert.deepEqual([result.status, result.body.code], [503, 'EMAIL_PROVIDER_NOT_CONFIGURED']);
    assert.equal(smsOnly.lookups, 0);
  } finally {
    await smsOnly.close();
  }
});

// ---------------------------------------------------------------------------
// Google OAuth (ID token validation and account linking)
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const CLIENT_ID = '123456789-testclient.apps.googleusercontent.com';

function idToken(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'test-kid', typ: 'JWT' }, key = privateKey) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode(header)}.${encode(claims)}`;
  return `${body}.${signData('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const goodClaims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1234567890', email: 'Student@Example.test', email_verified: true, nonce: 'n-1', iat: now, exp: now + 300 };
const getKeys = async () => [jwk];

test('Google ID token: signature, issuer, audience, expiry, nonce and verified email are all enforced', async () => {
  const ok = await google.verifyGoogleIdToken(idToken(goodClaims), { clientId: CLIENT_ID, nonce: 'n-1', nowSeconds: now, getKeys });
  assert.deepEqual(ok, { sub: '1234567890', email: 'student@example.test' });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const cases: Array<[string, string]> = [
    ['invalid signature', idToken(goodClaims, undefined, otherKey)],
    ['unexpected issuer', idToken({ ...goodClaims, iss: 'https://evil.example' })],
    ['unexpected audience', idToken({ ...goodClaims, aud: 'other-client' })],
    ['expired', idToken({ ...goodClaims, exp: now - 3600 })],
    ['issued in the future', idToken({ ...goodClaims, iat: now + 3600 })],
    ['nonce mismatch', idToken({ ...goodClaims, nonce: 'other' })],
    ['email not verified', idToken({ ...goodClaims, email_verified: false })],
    ['email not verified', idToken({ ...goodClaims, email_verified: 'true' })],
    ['unexpected algorithm', idToken(goodClaims, { alg: 'none', kid: 'test-kid' })],
    ['unexpected algorithm', idToken(goodClaims, { alg: 'HS256', kid: 'test-kid' })],
    ['unknown signing key', idToken(goodClaims, { alg: 'RS256', kid: 'other-kid' })],
    ['malformed token', 'a.b'],
  ];
  for (const [reason, token] of cases) {
    await assert.rejects(google.verifyGoogleIdToken(token, { clientId: CLIENT_ID, nonce: 'n-1', nowSeconds: now, getKeys }), (error: unknown) => error instanceof google.GoogleTokenError && error.reason === reason, reason);
  }
});

test('Google flow: PKCE + state; an unlinked account gets no session; a linked one still needs the mobile OTP', async () => {
  const store = new MemoryAuthVerificationStore();
  const sms = new RecordingSmsProvider();
  const googleConfig = { clientId: CLIENT_ID, clientSecret: 'test-client-secret', redirectUri: 'https://exam.example.test/api/auth/google/callback' };
  providers.configureVerificationServices(testServices({ sms, google: googleConfig }));
  enableTestSmsProtection();
  verification.configureAuthVerificationStore(store);
  store.users.set('student-1', { id: 'student-1', loginId: 'STUDENT-1', role: 'candidate', accountStatus: 'approved', contactEmail: null });
  store.contacts.set('student-1:sms', '+919876543210');
  let tokenRequests = 0;
  let nextClaims: Record<string, unknown> = goodClaims;
  const fetchImpl: import('./googleOAuth.js').FetchLike = async (url, init) => {
    if (url === google.GOOGLE_JWKS_ENDPOINT) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }), headers: { get: () => 'max-age=600' } };
    if (url === google.GOOGLE_TOKEN_ENDPOINT) {
      tokenRequests += 1;
      const form = new URLSearchParams(init?.body ?? '');
      assert.match(form.get('code_verifier') ?? '', /^[A-Za-z0-9_-]{43,128}$/, 'PKCE verifier sent');
      assert.equal(form.get('redirect_uri'), googleConfig.redirectUri);
      return { ok: true, status: 200, json: async () => ({ id_token: idToken(nextClaims) }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const server = await startHarness([verification.createAuthVerificationRouter({ fetchImpl })]);
  const begin = async () => {
    const response = await fetch(`${server.url}/api/auth/google/start`, { headers: { 'x-test-surface': 'exam' }, redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location')!);
    assert.equal(`${location.origin}${location.pathname}`, google.GOOGLE_AUTHORIZATION_ENDPOINT);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('redirect_uri'), googleConfig.redirectUri);
    const state = location.searchParams.get('state')!;
    nextClaims = { ...goodClaims, nonce: location.searchParams.get('nonce') };
    return { state, cookie: `elt_oauth_state=${cookieValue(response.headers.getSetCookie(), 'elt_oauth_state')}` };
  };
  const callback = (state: string, cookie: string) => fetch(`${server.url}/api/auth/google/callback?code=auth-code&state=${state}`, { headers: { 'x-test-surface': 'exam', cookie }, redirect: 'manual' });
  try {
    // State bound to the browser: a different browser's cookie is rejected.
    const first = await begin();
    const forged = await callback(first.state, 'elt_oauth_state=someone-elses-state-value-000000000000000');
    assert.equal(forged.headers.get('location'), '/login/candidate?google=failed');
    assert.equal(tokenRequests, 0, 'no code exchange without a matching state');
    // Unlinked Google identity: no account is created or linked, no session, no verification.
    const second = await begin();
    const unlinked = await callback(second.state, second.cookie);
    assert.equal(unlinked.headers.get('location'), '/login/candidate?google=not_linked');
    assert.equal(cookieValue(unlinked.headers.getSetCookie(), 'elt_session'), undefined);
    assert.equal(store.google.size, 0);
    // State is single use.
    const replay = await callback(second.state, second.cookie);
    assert.equal(replay.headers.get('location'), '/login/candidate?google=failed');
    // Linked identity: Google is not enough; the registered mobile OTP is required first.
    store.google.set('1234567890', { userId: 'student-1', email: 'student@example.test' });
    const third = await begin();
    const linked = await callback(third.state, third.cookie);
    assert.equal(linked.headers.get('location'), '/login/candidate?verification=pending');
    assert.equal(cookieValue(linked.headers.getSetCookie(), 'elt_session'), undefined, 'no session from Google alone');
    assert.ok(cookieValue(linked.headers.getSetCookie(), 'elt_verification'));
    assert.equal(sms.sent.at(-1)?.purpose, 'student_login');
    // An unverified Google email is rejected even for a linked account.
    const fourth = await begin();
    nextClaims = { ...nextClaims, email_verified: false };
    const unverified = await callback(fourth.state, fourth.cookie);
    assert.equal(unverified.headers.get('location'), '/login/candidate?google=failed');
  } finally {
    await server.close();
    providers.configureVerificationServices(providers.DISABLED_SERVICES);
  }
});

test('Google linking: one Google account per Student and one Student per Google account', async () => {
  const store = new MemoryAuthVerificationStore();
  assert.equal(await store.linkGoogleIdentity('student-1', 'sub-1', 'a@example.test'), 'linked');
  assert.equal(await store.linkGoogleIdentity('student-2', 'sub-1', 'a@example.test'), 'sub_taken');
  assert.equal(await store.linkGoogleIdentity('student-1', 'sub-2', 'b@example.test'), 'user_has_link');
  // Linking requires a verified Student session (the route guard is requireAuth + candidate).
  const router = verification.createAuthVerificationRouter() as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: RequestHandler }> } }> };
  const link = router.stack.find((layer) => layer.route?.path === '/auth/google/link')!.route!.stack.map((layer) => layer.handle.name);
  assert.equal(link[0], 'requireAuth');
});

// ---------------------------------------------------------------------------
// Static safety checks
// ---------------------------------------------------------------------------

test('static: production code never imports test support, and there is no fixed, development or bypass OTP', async () => {
  const files = (await readdir(new URL('.', import.meta.url))).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !/TestStores|TestHarness|TestSupport/.test(name));
  for (const name of files) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /authTestSupport|staffTestStores|staffTestHarness/, `${name} imports test support`);
    assert.doesNotMatch(source, /['"](?:000000|123456|111111)['"]/, `${name} contains a fixed code`);
    assert.doesNotMatch(source, /(?:DEV|TEST|MOCK|FAKE)_?OTP|bypassVerification|skipVerification/i, `${name} contains a bypass`);
  }
  const providerSource = await readFile(new URL('./verificationProviders.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(providerSource, /registerSmsProviderAdapter\(\s*['"]/, 'no SMS adapter is registered in this build');
  assert.doesNotMatch(providerSource, /registerEmailProviderAdapter\(\s*['"]/, 'no email adapter is registered in this build');
});

test('static: the AUTH-1 migration is wired before the grants migration, additive, with hashed codes and append-only audit', async () => {
  const sql = await readFile(new URL('./authVerificationMigration.sql', import.meta.url), 'utf8');
  const { MIGRATION_FILES } = await import('./migrate.js');
  const files = [...MIGRATION_FILES] as string[];
  assert.ok(files.indexOf('authVerificationMigration.sql') >= 0 && files.indexOf('authVerificationMigration.sql') < files.indexOf('databaseGrantsMigration.sql'), 'wired before the grants migration');
  assert.equal(files.indexOf('studentEmailVerificationMigration.sql'), files.indexOf('authVerificationMigration.sql') + 1, 'Student email challenges extend AUTH-1');
  assert.equal(files.indexOf('studentRegistrationClaimsMigration.sql'), files.indexOf('studentEmailVerificationMigration.sql') + 1, 'AUTH C1 claims follow the AUTH-1 additions');
  const body = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /ALTER TABLE|DROP TABLE|DROP COLUMN/i, 'additive only');
  assert.equal((body.match(/CREATE TABLE (?!IF NOT EXISTS)/g) ?? []).length, 0);
  assert.match(body, /code_hash text/);
  assert.doesNotMatch(body, /\bcode text\b|\botp text\b|plaintext/i);
  assert.match(body, /BEFORE UPDATE OR DELETE ON auth_verification_events/);
  assert.match(body, /BEFORE TRUNCATE ON auth_verification_events/);
});

// ---------------------------------------------------------------------------
// Mobile-first Student sign-in (mobile + password, then OTP) and the legacy Student ID path
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.alloc(32, 7); // the otpKey of testServices()
const derivedId = (mobile: string) => providers.studentLoginIdForMobile(TEST_KEY, mobile);
const mobileLogin = (f: Fixture, mobile: string, password = STUDENT_PASSWORD) =>
  call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { mobile, password, role: 'candidate' } });

test('Student mobile sign-in: mobile + password, then a code to that mobile; no Student ID needed', async () => {
  const f = await setup({ extraStudents: [{ id: 'student-m', loginId: derivedId('+919876543250'), mobile: '+919876543250' }] });
  try {
    const login = await mobileLogin(f, '98765 43250');
    assert.deepEqual([login.status, login.body.status, login.body.destination], [202, 'verification_required', '+91******50']);
    assert.equal(cookieValue(login.setCookies, 'elt_session'), undefined, 'password alone gives no session');
    assert.equal(f.sms.sent.at(-1)!.destination, '+919876543250');
    const ok = await verify(f, verificationCookie(login), f.sms.lastCode()!);
    assert.deepEqual([ok.status, ok.body.status], [200, 'signed_in']);
    assert.equal(f.store.sessions.at(-1)!.userId, 'student-m');

    // Wrong password, unknown and malformed numbers: one generic answer, no code sent.
    const sentBefore = f.sms.sent.length;
    const failures = [await mobileLogin(f, '9876543250', 'Wrong-password-2026'), await mobileLogin(f, '9876500000'), await mobileLogin(f, '12345')];
    for (const result of failures) assert.deepEqual([result.status, result.body.code], [401, 'INVALID_MOBILE_CREDENTIALS']);
    assert.equal(new Set(failures.map((result) => JSON.stringify(result.body))).size, 1, 'indistinguishable');
    assert.equal(f.sms.sent.length, sentBefore);

    // Exactly one identifier for Students; Institutes and Officials still need loginId (unchanged).
    const both = await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { mobile: '9876543250', loginId: 'student-1', password: STUDENT_PASSWORD, role: 'candidate' } });
    assert.equal(both.status, 400);
    const instituteByMobile = await call(f.base, 'POST', '/api/auth/login', { surface: 'institution', body: { mobile: '9876543250', password: INSTITUTE_PASSWORD, role: 'center' } });
    assert.equal(instituteByMobile.status, 400);
  } finally {
    await f.close();
  }
});

test('Student mobile sign-in: an account created with a Student ID is found through its VERIFIED mobile; the legacy path is unchanged', async () => {
  const f = await setup({ studentMobile: '+919876543210' });
  try {
    const byMobile = await mobileLogin(f, '9876543210');
    assert.deepEqual([byMobile.status, byMobile.body.purpose], [202, 'student_login']);
    const legacy = await studentLogin(f); // { loginId: 'student-1', password }
    assert.deepEqual([legacy.status, legacy.body.purpose], [202, 'student_login']);
  } finally {
    await f.close();
  }
  const g = await setup({ studentMobile: null });
  try {
    const legacyNoMobile = await studentLogin(g);
    assert.deepEqual([legacyNoMobile.status, legacyNoMobile.body.step], [202, 'destination'], 'legacy accounts without a mobile still capture one (existing flow)');
    assert.equal((await mobileLogin(g, '9876543210')).status, 401, 'no verified mobile, so not found by mobile');
  } finally {
    await g.close();
  }
});

test('Student mobile sign-in: several accounts tied to one mobile are refused generically (ambiguity is unresolved policy)', async () => {
  // A Student ID account verified this mobile AND a mobile-first account was created for it.
  const f = await setup({ studentMobile: '+919876543210', extraStudents: [{ id: 'student-m', loginId: derivedId('+919876543210') }] });
  try {
    const result = await mobileLogin(f, '9876543210');
    assert.deepEqual([result.status, result.body.code], [401, 'INVALID_MOBILE_CREDENTIALS']);
    assert.match(String(result.body.error), /Existing account\?/, 'points to the legacy Student ID path');
    assert.equal(f.sms.sent.length, 0, 'no code is sent to an ambiguous number');
    assert.equal((await studentLogin(f)).status, 202, 'the Student ID path still works for the older account');
  } finally {
    await f.close();
  }
  // Two Student ID accounts that both verified the same mobile.
  const g = await setup({ studentMobile: '+919876543210', extraStudents: [{ id: 'student-2', loginId: 'STUDENT-2', mobile: '+919876543210' }] });
  try {
    assert.equal((await mobileLogin(g, '9876543210')).status, 401);
    assert.equal(g.sms.sent.length, 0);
  } finally {
    await g.close();
  }
});

test('Student registration is mobile-first: no Student ID is chosen, the login ID never contains the number, an existing mobile-first number is refused only after proof', async () => {
  const f = await setup({ extraStudents: [{ id: 'student-taken', loginId: derivedId('+919876543260'), mobile: '+919876543260' }] });
  try {
    const created = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543213' } });
    assert.deepEqual([created.status, created.body.purpose], [202, 'student_registration']);
    assert.equal((await verify(f, verificationCookie(created), f.sms.lastCode()!)).status, 200);
    const loginId = f.created.at(-1)!;
    assert.equal(loginId, derivedId('+919876543213'));
    assert.match(loginId, /^M-[0-9A-F]{24}$/);
    assert.ok(!loginId.includes('9876543213'), 'the phone number is not the stored identifier');

    // An existing mobile-first Student's number: the same 202 as a new number (no oracle) ...
    const duplicate = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name: 'Someone Else', password: STUDENT_PASSWORD, mobile: '9876543260' } });
    assert.deepEqual([duplicate.status, duplicate.body.purpose, duplicate.body.step], [202, 'student_registration', 'code']);
    // ... and only the holder of the phone, after proving it, learns that no account was created.
    const refused = await verify(f, verificationCookie(duplicate), f.sms.lastCode()!);
    assert.deepEqual([refused.status, refused.body.code], [409, 'ACCOUNT_NOT_CREATED']);
    assert.doesNotMatch(String(refused.body.error), /mobile|number|registered/i, 'does not confirm that the number is registered');
    assert.equal(cookieValue(refused.setCookies, 'elt_session'), undefined);
    assert.equal(f.created.length, 1, 'no second account');
    assert.equal(f.store.users.get('student-taken')?.loginId, derivedId('+919876543260'), 'the existing account is unchanged');
    assert.equal(f.store.contacts.get('student-taken:sms'), '+919876543260');

    // An older client's loginId is ignored, never used as the identifier.
    const old = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { loginId: 'CHOSEN-ID', name: 'Old Client', password: STUDENT_PASSWORD, mobile: '9876543214' } });
    assert.equal((await verify(f, verificationCookie(old), f.sms.lastCode()!)).status, 200);
    assert.equal(f.created.at(-1), derivedId('+919876543214'));
    assert.ok(!f.created.includes('CHOSEN-ID'));
  } finally {
    await f.close();
  }
});

test('Student mobile sign-in and registration stay fail-closed without an SMS provider: 503 before any lookup or write', async () => {
  const f = await setup({ services: 'none', extraStudents: [{ id: 'student-m', loginId: 'M-ANY', mobile: '+919876543250' }] });
  try {
    const login = await mobileLogin(f, '9876543250');
    assert.deepEqual([login.status, login.body.code], [503, 'OTP_PROVIDER_NOT_CONFIGURED']);
    const register = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543250' } });
    assert.deepEqual([register.status, register.body.code], [503, 'OTP_PROVIDER_NOT_CONFIGURED']);
    assert.equal(f.lookups, 0);
    assert.equal(f.inserted.length, 0);
    assert.equal(f.registrations.claims.size, 0, 'no registration claim is written');
    assert.equal(f.sms.sent.length, 0);
  } finally {
    await f.close();
  }
});

test('Google linking re-checks at the callback that the account is still an approved Student', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const store = new MemoryAuthVerificationStore();
  const sms = new RecordingSmsProvider();
  const googleConfig = { clientId: CLIENT_ID, clientSecret: 'test-client-secret', redirectUri: 'https://exam.example.test/api/auth/google/callback' };
  providers.configureVerificationServices(testServices({ sms, google: googleConfig }));
  enableTestSmsProtection();
  verification.configureAuthVerificationStore(store);
  store.users.set('student-ok', { id: 'student-ok', loginId: 'STUDENT-OK', role: 'candidate', accountStatus: 'approved', contactEmail: null });
  store.users.set('student-off', { id: 'student-off', loginId: 'STUDENT-OFF', role: 'candidate', accountStatus: 'rejected', contactEmail: null });
  const fetchImpl: import('./googleOAuth.js').FetchLike = async (url) => {
    if (url === google.GOOGLE_JWKS_ENDPOINT) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }), headers: { get: () => 'max-age=600' } };
    if (url === google.GOOGLE_TOKEN_ENDPOINT) return { ok: true, status: 200, json: async () => ({ id_token: idToken(goodClaims) }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const server = await startHarness([verification.createAuthVerificationRouter({ fetchImpl })]);
  // A link started earlier from a verified Student session (as GET /api/auth/google/link records it).
  const linkState = async (userId: string) => {
    const state = randomBytes(32).toString('base64url');
    await store.createOAuthState({ stateHash: createHash('sha256').update(state).digest('hex'), nonce: 'n-1', codeVerifier: 'v'.repeat(64), intent: 'link', userId, expiresAt: new Date(Date.now() + 60_000) });
    return fetch(`${server.url}/api/auth/google/callback?code=auth-code&state=${state}`, { headers: { 'x-test-surface': 'exam', cookie: `elt_oauth_state=${state}` }, redirect: 'manual' });
  };
  try {
    const refused = await linkState('student-off');
    assert.equal(refused.headers.get('location'), '/login/candidate?google=failed');
    assert.equal(store.google.size, 0, 'nothing linked for an account that is no longer eligible');
    assert.ok(store.events.some((event) => event.action === 'google.link_refused' && event.userId === 'student-off'));
    const linked = await linkState('student-ok');
    assert.equal(linked.headers.get('location'), '/dashboard/candidate?google=linked');
    assert.equal(store.google.get('1234567890')?.userId, 'student-ok');
  } finally {
    await server.close();
    providers.configureVerificationServices(providers.DISABLED_SERVICES);
  }
});

// ---------------------------------------------------------------------------
// Provider delivery deadline (fake providers only; no network)
// ---------------------------------------------------------------------------

type FakeSms = import('./verificationProviders.js').SmsOtpProvider;

/** A capture-step challenge served by a router whose delivery deadline is shortened (bounded) for the test. */
async function deliveryHarness(sms: FakeSms, deliveryTimeoutMs?: number) {
  const store = new MemoryAuthVerificationStore();
  providers.configureVerificationServices(testServices({ sms }));
  enableTestSmsProtection();
  verification.configureAuthVerificationStore(store);
  const server = await startHarness([verification.createAuthVerificationRouter({ deliveryTimeoutMs })]);
  const token = randomBytes(32).toString('base64url');
  const id = createHash('sha256').update(token).digest('hex');
  await store.createChallenge(
    { id, purpose: 'student_mobile_capture', userId: 'student-1', channel: 'sms', destination: null, expiresAt: new Date(Date.now() + 10 * 60_000) },
    { action: 'verification.started', userId: 'student-1' },
  );
  const capture = () => call(server.url, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: `elt_verification=${token}`, body: { mobile: '9876543299' } });
  const verify = (code: string) => call(server.url, 'POST', '/api/auth/verification/verify', { surface: 'exam', cookie: `elt_verification=${token}`, body: { code } });
  return {
    store, id, capture, verify,
    close: async () => {
      await server.close();
      providers.configureVerificationServices(providers.DISABLED_SERVICES);
    },
  };
}

test('delivery deadline: the deadline is fixed at 10 seconds and can only be shortened', () => {
  assert.equal(providers.PROVIDER_DELIVERY_TIMEOUT_MS, 10_000);
  for (const requested of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 10_001, 60_000]) {
    assert.equal(providers.boundedDeliveryTimeout(requested), 10_000, String(requested));
  }
  assert.equal(providers.boundedDeliveryTimeout(40), 40);
  assert.equal(providers.boundedDeliveryTimeout(0), 1);
  assert.equal(providers.boundedDeliveryTimeout(-5), 1);
});

test('delivery deadline: a provider that ignores the abort signal still fails closed with the existing 503', async () => {
  // Assigned inside the fake provider; the assertion keeps TypeScript from narrowing it to null.
  let received = null as { code: string; signal?: AbortSignal } | null;
  const hanging: FakeSms = {
    name: 'fake-hanging-sms',
    sendOtp: ({ code, signal }) => {
      received = { code, signal };
      return new Promise<void>(() => undefined); // never settles and ignores the signal
    },
  };
  const h = await deliveryHarness(hanging, 40);
  try {
    const started = Date.now();
    const result = await h.capture();
    assert.ok(Date.now() - started < 5_000, 'the deadline, not the provider, ends the request');
    assert.deepEqual([result.status, result.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    assert.equal(result.body.error, 'The verification code could not be delivered. Please try again later.');
    assert.ok(received, 'the provider was called');
    assert.equal(received!.signal?.aborted, true, 'the signal was aborted at the deadline');
    assert.ok(!JSON.stringify(result.body).includes(received!.code), 'the code is never returned');
    assert.ok(h.store.challenges.get(h.id)!.consumedAt, 'the challenge is invalidated');
    assert.ok(h.store.events.some((event) => event.action === 'verification.delivery_failed'));
    assert.ok(!h.store.events.some((event) => event.action === 'verification.code_sent'));
    assert.ok(!JSON.stringify(h.store.events).includes(received!.code), 'the code is never audited');
  } finally {
    await h.close();
  }
});

test('delivery deadline: an adapter that honours the signal is aborted and fails closed', async () => {
  let seen: AbortSignal | undefined;
  const cancellable: FakeSms = {
    name: 'fake-cancellable-sms',
    sendOtp: ({ signal }) => {
      seen = signal;
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted by deadline')), { once: true });
      });
    },
  };
  const h = await deliveryHarness(cancellable, 40);
  try {
    const result = await h.capture();
    assert.deepEqual([result.status, result.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    assert.ok(seen instanceof AbortSignal, 'an AbortSignal is passed to the adapter');
    assert.equal(seen!.aborted, true);
    assert.ok(!JSON.stringify(result.body).includes('aborted by deadline'), 'the provider error is never exposed');
    assert.ok(h.store.challenges.get(h.id)!.consumedAt, 'the challenge is invalidated');
  } finally {
    await h.close();
  }
});

test('delivery deadline: a fast provider succeeds under the fixed 10-second deadline and the timer is always cleared', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const deadlineHandles: unknown[] = [];
  t.mock.method(globalThis, 'setTimeout', ((handler: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
    const handle = realSetTimeout(handler, delay, ...rest);
    if (delay === providers.PROVIDER_DELIVERY_TIMEOUT_MS) deadlineHandles.push(handle);
    return handle;
  }) as typeof setTimeout);
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  let seen: AbortSignal | undefined;
  const sms = new RecordingSmsProvider();
  const fast: FakeSms = {
    name: 'fake-fast-sms',
    sendOtp: async (request) => {
      seen = request.signal;
      await sms.sendOtp(request);
    },
  };
  const h = await deliveryHarness(fast); // no override: production deadline
  try {
    const result = await h.capture();
    assert.deepEqual([result.status, result.body.step, result.body.codeSent], [200, 'code', true]);
    assert.equal(sms.sent.length, 1);
    assert.equal(seen?.aborted, false, 'the signal is not aborted on success');
    assert.equal(h.store.challenges.get(h.id)!.consumedAt, null, 'the challenge stays usable');
    assert.equal(deadlineHandles.length, 1, 'one 10-second deadline was armed');
    assert.ok(cleared.mock.calls.some((callRecord) => callRecord.arguments[0] === deadlineHandles[0]), 'the deadline timer was cleared');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Google OAuth redirect URI: exact https host and callback path (fail closed)
// ---------------------------------------------------------------------------

test('Google redirect: only https on exactly the expected Exam host and callback path is accepted', () => {
  const host = 'exam.eltnoy.com';
  assert.equal(providers.validateRedirectUri('https://exam.eltnoy.com/api/auth/google/callback', host), 'https://exam.eltnoy.com/api/auth/google/callback');
  assert.equal(providers.validateRedirectUri('https://EXAM.eltnoy.com/api/auth/google/callback', 'Exam.Eltnoy.com'), 'https://exam.eltnoy.com/api/auth/google/callback', 'hostnames compare case-insensitively');
  for (const uri of [
    'https://admin.eltnoy.in/api/auth/google/callback', // another surface
    'https://eltnoy.com/api/auth/google/callback', // marketing
    'https://evil.example/api/auth/google/callback', // foreign host
    'https://exam.eltnoy.com.evil.example/api/auth/google/callback', // suffix trick
    'https://x.exam.eltnoy.com/api/auth/google/callback', // subdomain
    'https://exam.eltnoy.com:8443/api/auth/google/callback', // explicit port
    'http://exam.eltnoy.com/api/auth/google/callback', // not https
    'https://exam.eltnoy.com/api/auth/google/callback/', // trailing slash
    'https://exam.eltnoy.com/api/auth/google/other', // other path
    'https://exam.eltnoy.com/api/auth/google/callback#x', // fragment
  ]) {
    assert.equal(providers.validateRedirectUri(uri, host), null, uri);
  }
  assert.equal(providers.validateRedirectUri('https://exam.eltnoy.com/api/auth/google/callback', undefined), null, 'no expected host: fail closed');
  assert.equal(providers.validateRedirectUri('https://exam.eltnoy.com/api/auth/google/callback', ''), null);
});

test('Google redirect: startup enables Google only for a redirect on the configured Exam host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eltnoy-google-test-'));
  try {
    const secretFile = join(dir, 'client-secret');
    await writeFile(secretFile, 'synthetic-test-client-secret-0001\n'); // synthetic, not a credential
    const env = {
      GOOGLE_OAUTH_CLIENT_ID: '123456789-testclient.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET_FILE: secretFile,
      GOOGLE_OAUTH_REDIRECT_URI: 'https://exam.eltnoy.com/api/auth/google/callback',
    };
    const matching = providers.resolveVerificationServices(env, 'exam.eltnoy.com');
    assert.equal(matching.google?.redirectUri, 'https://exam.eltnoy.com/api/auth/google/callback');
    assert.equal(matching.reasons.google, null);

    const mismatched = providers.resolveVerificationServices(env, 'staging-exam.example.test');
    assert.equal(mismatched.google, null);
    assert.match(mismatched.reasons.google ?? '', /redirect URI must be/);
    assert.doesNotMatch(mismatched.reasons.google ?? '', /synthetic-test-client-secret/, 'no secret in the reason');

    const unknownHost = providers.resolveVerificationServices(env);
    assert.equal(unknownHost.google, null, 'without the Exam hostname Google stays disabled');

    const withPort = providers.resolveVerificationServices({ ...env, GOOGLE_OAUTH_REDIRECT_URI: 'https://exam.eltnoy.com:444/api/auth/google/callback' }, 'exam.eltnoy.com');
    assert.equal(withPort.google, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AUTH-2 scope A: Google identity linking without row locks; proposed migration indexes
// ---------------------------------------------------------------------------

const authStore = await import('./authVerificationStore.js');

/**
 * In-process stand-in for PostgreSQL (no database): google_identities with its two UNIQUE keys
 * (google_sub, user_id) enforced atomically at INSERT time, as ON CONFLICT DO NOTHING does once the
 * conflicting row is committed. Every query yields first, so concurrent calls genuinely interleave.
 */
function fakeGoogleIdentityPool() {
  const rows: Array<{ user_id: string; google_sub: string }> = [];
  const log: string[] = [];
  let forceIdCollision = false;
  const query = async (text: string, values: unknown[] = []) => {
    await new Promise((resolve) => setImmediate(resolve));
    const sql = text.replace(/\s+/g, ' ').trim();
    log.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO google_identities')) {
      const [, userId, sub] = values as string[];
      if (forceIdCollision || rows.some((row) => row.google_sub === sub || row.user_id === userId)) return { rows: [], rowCount: 0 };
      rows.push({ user_id: userId, google_sub: sub });
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT user_id, google_sub FROM google_identities')) {
      const [sub, userId] = values as string[];
      const found = rows.filter((row) => row.google_sub === sub || row.user_id === userId);
      return { rows: found.map((row) => ({ ...row })), rowCount: found.length };
    }
    if (sql.startsWith('INSERT INTO auth_verification_events')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query in google identity test: ${sql.slice(0, 60)}`);
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { rows, log, pool, collideIds: () => { forceIdCollision = true; } };
}

const linkedEvents = (log: string[]) => log.filter((sql) => sql.startsWith('INSERT INTO auth_verification_events')).length;

test('Google linking (PostgreSQL store): success, subject already linked, user already linked; existing links never change', async () => {
  const fake = fakeGoogleIdentityPool();
  const pg = authStore.createPostgresAuthVerificationStore(fake.pool as never);
  const now = new Date('2026-11-14T12:00:00.000Z');

  assert.equal(await pg.linkGoogleIdentity('student-a', 'sub-1', 'a@example.test', now), 'linked');
  assert.deepEqual(fake.rows, [{ user_id: 'student-a', google_sub: 'sub-1' }]);
  assert.equal(linkedEvents(fake.log), 1, 'the link is audited in the same transaction');
  assert.ok(fake.log.some((sql) => /^INSERT INTO google_identities .* ON CONFLICT DO NOTHING RETURNING id$/.test(sql)), 'atomic insert on the unique keys');

  assert.equal(await pg.linkGoogleIdentity('student-b', 'sub-1', 'b@example.test', now), 'sub_taken', 'that Google account belongs to another Student');
  assert.equal(await pg.linkGoogleIdentity('student-a', 'sub-2', 'a2@example.test', now), 'user_has_link', 'this Student already has a Google account');
  assert.equal(await pg.linkGoogleIdentity('student-a', 'sub-1', 'a@example.test', now), 'sub_taken', 're-linking the same pair is reported as taken (unchanged behaviour)');

  assert.deepEqual(fake.rows, [{ user_id: 'student-a', google_sub: 'sub-1' }], 'no conflicting attempt re-binds or adds a link');
  assert.equal(linkedEvents(fake.log), 1, 'only the successful link is audited');
  assert.equal(fake.log.filter((sql) => sql === 'COMMIT').length, 4);
});

test('Google linking (PostgreSQL store): concurrent conflicts on either unique key yield exactly one link', async () => {
  const fake = fakeGoogleIdentityPool();
  const pg = authStore.createPostgresAuthVerificationStore(fake.pool as never);
  const now = new Date('2026-11-14T12:00:00.000Z');

  // Two Students race for the same Google account.
  const sameSub = await Promise.all([
    pg.linkGoogleIdentity('student-a', 'sub-x', 'x@example.test', now),
    pg.linkGoogleIdentity('student-b', 'sub-x', 'x@example.test', now),
  ]);
  assert.deepEqual([...sameSub].sort(), ['linked', 'sub_taken']);
  assert.equal(fake.rows.filter((row) => row.google_sub === 'sub-x').length, 1);

  // One Student races to link two different Google accounts.
  const sameUser = await Promise.all([
    pg.linkGoogleIdentity('student-c', 'sub-y', 'y@example.test', now),
    pg.linkGoogleIdentity('student-c', 'sub-z', 'z@example.test', now),
  ]);
  assert.deepEqual([...sameUser].sort(), ['linked', 'user_has_link']);
  assert.equal(fake.rows.filter((row) => row.user_id === 'student-c').length, 1);

  // A larger burst on one subject: still exactly one owner.
  const burst = await Promise.all(['p', 'q', 'r', 's', 't'].map((u) => pg.linkGoogleIdentity(`student-${u}`, 'sub-burst', 'burst@example.test', now)));
  assert.equal(burst.filter((result) => result === 'linked').length, 1);
  assert.equal(burst.filter((result) => result === 'sub_taken').length, 4);
  assert.equal(fake.rows.filter((row) => row.google_sub === 'sub-burst').length, 1);
  assert.equal(linkedEvents(fake.log), 3, 'one audit event per actual link');
});

test('Google linking (PostgreSQL store): an unclassifiable conflict links nothing and rolls back', async () => {
  const fake = fakeGoogleIdentityPool();
  fake.collideIds();
  const pg = authStore.createPostgresAuthVerificationStore(fake.pool as never);
  await assert.rejects(pg.linkGoogleIdentity('student-a', 'sub-1', 'a@example.test', new Date()), /nothing was linked/);
  assert.deepEqual(fake.rows, []);
  assert.equal(fake.log.at(-1), 'ROLLBACK');
  assert.equal(linkedEvents(fake.log), 0);
});

test('Google linking takes no row lock on google_identities (the API role has no UPDATE there)', async () => {
  const fake = fakeGoogleIdentityPool();
  const pg = authStore.createPostgresAuthVerificationStore(fake.pool as never);
  await pg.linkGoogleIdentity('student-a', 'sub-1', 'a@example.test', new Date());
  await pg.linkGoogleIdentity('student-b', 'sub-1', 'b@example.test', new Date());
  for (const sql of fake.log.filter((statement) => statement.includes('google_identities'))) {
    assert.doesNotMatch(sql, /\bFOR (?:NO KEY )?(?:UPDATE|SHARE)\b/, sql);
  }
  const source = await readFile(new URL('./authVerificationStore.ts', import.meta.url), 'utf8');
  for (const [statement] of source.matchAll(/(['`])[^'`]*google_identities[^'`]*\1/g)) {
    assert.doesNotMatch(statement, /\bFOR (?:NO KEY )?(?:UPDATE|SHARE)\b/, statement);
  }
});

test('AUTH-1 migration: indexes for mobile sign-in and decision history exist after their tables', async () => {
  const sql = (await readFile(new URL('./authVerificationMigration.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
  const mobile = /CREATE INDEX IF NOT EXISTS account_contacts_channel_destination_idx ON account_contacts \(channel, destination\) WHERE verified_at IS NOT NULL;/.exec(sql);
  const history = /CREATE INDEX IF NOT EXISTS auth_verification_events_action_time_idx ON auth_verification_events \(action, occurred_at DESC\);/.exec(sql);
  assert.ok(mobile, 'mobile sign-in index (channel, destination) for verified contacts');
  assert.ok(history, 'decision history index (action, occurred_at DESC)');
  assert.doesNotMatch(mobile![0], /UNIQUE/, 'no cross-account mobile uniqueness is introduced (M-28 stays open)');
  assert.ok(mobile!.index > sql.indexOf('CREATE TABLE IF NOT EXISTS account_contacts'));
  assert.ok(history!.index > sql.indexOf('CREATE TABLE IF NOT EXISTS auth_verification_events'));
  const { MIGRATION_FILES } = await import('./migrate.js');
  assert.ok((MIGRATION_FILES as readonly string[]).includes('authVerificationMigration.sql'), 'wired into the migration runner (AUTH-1 scope B)');
});

// ---------------------------------------------------------------------------
// AUTH C1: secure Student registration (claims, not accounts, until the OTP is verified)
// ---------------------------------------------------------------------------

const register = (f: Fixture, mobile: string, name = 'New Student', password = STUDENT_PASSWORD) =>
  call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name, password, mobile } });
/** The code most recently sent to `destination` (each request's SMS is recorded in order). */
const codeFor = (f: Fixture, destination: string) => f.sms.sent.filter((entry) => entry.destination === destination).at(-1)!.code;
const claimFor = (f: Fixture, result: { setCookies: string[] }) => {
  const token = cookieValue(result.setCookies, 'elt_verification')!;
  const challenge = f.store.challenges.get(createHash('sha256').update(token).digest('hex'))!;
  return { challenge, claim: f.registrations.claims.get(challenge.registrationClaimId!)! };
};

test('AUTH C1: an attacker\'s claim on a victim\'s number never blocks the owner, and can never become an account', async () => {
  const f = await setup({});
  try {
    const attacker = await register(f, '9876543300', 'Attacker', 'Attacker-password-2026');
    assert.equal(attacker.status, 202);
    const attackerCode = codeFor(f, '+919876543300'); // delivered to the victim's phone, not to the attacker
    // The attacker cannot complete without the code: guesses fail and lock the attacker's own claim.
    const wrong = attackerCode === '111111' ? '222222' : '111111';
    assert.deepEqual([(await verify(f, verificationCookie(attacker), wrong)).status, f.created.length], [400, 0]);

    // The genuine owner registers the same number afterwards: same 202, a second independent claim.
    const owner = await register(f, '98765 43300', 'Genuine Owner');
    assert.equal(owner.status, 202);
    assert.equal(f.registrations.claims.size, 2, 'claims are not exclusive');
    const ownerClaim = claimFor(f, owner).claim;
    assert.equal(ownerClaim.displayName, 'Genuine Owner');
    const ok = await verify(f, verificationCookie(owner), codeFor(f, '+919876543300'));
    assert.deepEqual([ok.status, ok.body.status], [200, 'signed_in']);
    assert.deepEqual(f.created, [derivedId('+919876543300')]);
    const account = [...f.store.users.values()].find((user) => user.loginId === derivedId('+919876543300'))!;
    assert.equal(f.registrations.claims.has(ownerClaim.id), false, 'the completed claim is deleted');
    const attackerClaim = claimFor(f, attacker).claim;
    assert.equal(attackerClaim.consumedAt, null, 'the attacker claim is untouched until it is used');

    // Even the code sent for the attacker's claim (only the owner's phone has it) cannot create a second account.
    const late = await verify(f, verificationCookie(attacker), attackerCode);
    assert.deepEqual([late.status, late.body.code], [409, 'ACCOUNT_NOT_CREATED']);
    assert.equal(f.created.length, 1);
    assert.ok(attackerClaim.consumedAt, 'AUTH C1.1: the refused claim is marked consumed (dead)');
    assert.equal((await verify(f, verificationCookie(attacker), attackerCode)).status, 401, 'a refused claim cannot be replayed');
    // The owner signs in by mobile with THEIR password; the attacker's password never works.
    const signIn = await mobileLogin(f, '9876543300');
    assert.deepEqual([signIn.status, signIn.body.purpose], [202, 'student_login']);
    assert.equal((await mobileLogin(f, '9876543300', 'Attacker-password-2026')).status, 401);
    assert.equal(f.store.contacts.get(`${account.id}:sms`), '+919876543300');
  } finally {
    await f.close();
  }
});

test('AUTH C1/C1.1: abandoned, expired and refused claims never create an account; cleanup removes only dead claims', async () => {
  // student-v owns +919876543307 as a verified contact; student-d has the derived login ID of +919876543308 only.
  const f = await setup({ extraStudents: [{ id: 'student-v', loginId: 'STUDENT-V', mobile: '+919876543307' }, { id: 'student-d', loginId: derivedId('+919876543308') }] });
  try {
    const abandoned = await register(f, '9876543301');
    const expiredClaim = await register(f, '9876543302');
    const active = await register(f, '9876543303');
    const liveChallenge = await register(f, '9876543304');
    const completed = await register(f, '9876543305');
    const refusedContact = await register(f, '9876543307');
    const refusedLogin = await register(f, '9876543308');
    const consumedButLive = await register(f, '9876543309');
    const ids = {
      abandoned: claimFor(f, abandoned).claim.id, expired: claimFor(f, expiredClaim).claim.id, active: claimFor(f, active).claim.id,
      live: claimFor(f, liveChallenge).claim.id, completed: claimFor(f, completed).claim.id,
      refusedContact: claimFor(f, refusedContact).claim.id, refusedLogin: claimFor(f, refusedLogin).claim.id, consumedButLive: claimFor(f, consumedButLive).claim.id,
    };
    assert.equal((await verify(f, verificationCookie(completed), codeFor(f, '+919876543305'))).status, 200);
    assert.equal(f.created.length, 1, 'only the verified registration became an account');
    assert.equal(f.registrations.claims.has(ids.completed), false, 'a completed claim is deleted by the completion itself');

    // Permanent business refusals: the claim is marked consumed and can never be replayed.
    for (const [result, mobile, claimId] of [[refusedContact, '+919876543307', ids.refusedContact], [refusedLogin, '+919876543308', ids.refusedLogin]] as const) {
      const refused = await verify(f, verificationCookie(result), codeFor(f, mobile));
      assert.deepEqual([refused.status, refused.body.code], [409, 'ACCOUNT_NOT_CREATED']);
      assert.ok(f.registrations.claims.get(claimId)!.consumedAt, `${mobile}: the refused claim is consumed`);
      assert.equal((await verify(f, verificationCookie(result), codeFor(f, mobile))).status, 401, `${mobile}: no replay`);
    }
    assert.equal(f.store.users.get('student-v')?.loginId, 'STUDENT-V', 'the existing accounts are unchanged');
    assert.equal(f.store.contacts.get('student-d:sms'), undefined);
    assert.equal(f.created.length, 1);

    // An expired claim cannot complete, even with the right code and a still-valid challenge.
    claimFor(f, expiredClaim).claim.expiresAt = new Date(Date.now() - 1000);
    const late = await verify(f, verificationCookie(expiredClaim), codeFor(f, '+919876543302'));
    assert.deepEqual([late.status, late.body.code], [410, 'VERIFICATION_EXPIRED']);
    assert.equal(cookieValue(late.setCookies, 'elt_session'), undefined);
    assert.equal(f.created.length, 1);

    // Abandoned: claim and challenge both expired.
    const stale = claimFor(f, abandoned);
    stale.claim.expiresAt = new Date(Date.now() - 1000);
    stale.challenge.expiresAt = new Date(Date.now() - 1000);
    // Expired claim whose challenge is still live: kept (a verification might still be in flight).
    claimFor(f, liveChallenge).claim.expiresAt = new Date(Date.now() - 1000);
    // A consumed claim whose challenge is still live: kept (cleanup never removes a live challenge).
    claimFor(f, consumedButLive).claim.consumedAt = new Date();
    const userChallenges = [...f.store.challenges.values()].filter((c) => c.userId !== null).length;

    // The next registration runs the bounded cleanup first.
    assert.equal((await register(f, '9876543306')).status, 202);
    const kept = (id: string) => f.registrations.claims.has(id);
    assert.equal(kept(ids.abandoned), false, 'abandoned + expired: deleted');
    assert.equal(kept(ids.expired), false, 'expired with its challenge consumed by the refused attempt: deleted');
    assert.equal(kept(ids.refusedContact), false, 'refused (verified contact), no live challenge: deleted');
    assert.equal(kept(ids.refusedLogin), false, 'refused (login ID taken), no live challenge: deleted');
    assert.equal(kept(ids.active), true, 'active claim kept');
    assert.equal(kept(ids.live), true, 'expired claim with a live challenge kept');
    assert.equal(kept(ids.consumedButLive), true, 'consumed claim with a live challenge kept');
    for (const id of [ids.abandoned, ids.expired, ids.refusedContact, ids.refusedLogin]) {
      assert.ok(![...f.store.challenges.values()].some((c) => c.registrationClaimId === id), 'their registration challenges went with them (cascade)');
    }
    assert.ok([...f.store.challenges.values()].some((c) => c.registrationClaimId === ids.active && !c.consumedAt), 'the active challenge is untouched');
    assert.equal([...f.store.challenges.values()].filter((c) => c.userId !== null).length, userChallenges, 'account challenges are never touched');
    // Idempotent.
    assert.equal(await f.registrations.deleteExpiredClaims(new Date(), 50), 0);
    assert.equal(await f.registrations.deleteExpiredClaims(new Date(), 50), 0);
    assert.equal(f.created.length, 1);
  } finally {
    await f.close();
  }
});

test('AUTH C1.1: a transient failure during completion rolls back and the same code can be verified again', async () => {
  const f = await setup({});
  try {
    const result = await register(f, '9876543311');
    const code = codeFor(f, '+919876543311');
    const { claim, challenge } = claimFor(f, result);
    f.registrations.failNext = true;
    const failed = await verify(f, verificationCookie(result), code);
    assert.equal(failed.status, 500, 'an unexpected error is not a refusal');
    assert.equal(cookieValue(failed.setCookies, 'elt_session'), undefined);
    assert.deepEqual([f.created.length, f.store.sessions.length], [0, 0], 'nothing was written');
    assert.equal(f.registrations.claims.get(claim.id)?.consumedAt, null, 'the claim is not consumed by a retryable failure');
    assert.equal(f.store.challenges.get(challenge.id)?.consumedAt, null, 'the challenge is still usable');
    const retry = await verify(f, verificationCookie(result), code);
    assert.deepEqual([retry.status, retry.body.status], [200, 'signed_in'], 'safe retry');
    assert.deepEqual([f.created.length, f.registrations.claims.size], [1, 0]);
  } finally {
    await f.close();
  }
});

test('AUTH C1.1 concurrency: a completion racing cleanup leaves either a full account or nothing, never partial state', async () => {
  const f = await setup({});
  try {
    const result = await register(f, '9876543312');
    const code = codeFor(f, '+919876543312');
    delayChallengeReads(f.store);
    const [verified] = await Promise.all([
      verify(f, verificationCookie(result), code),
      f.registrations.deleteExpiredClaims(new Date(), 50),
      f.registrations.deleteExpiredClaims(new Date(), 50),
    ]);
    assert.equal(verified.status, 200, 'a live claim is never removed by cleanup');
    assert.deepEqual([f.created.length, f.registrations.claims.size], [1, 0]);
    assert.ok(![...f.store.challenges.values()].some((c) => c.registrationClaimId), 'no orphaned registration challenge');
  } finally {
    await f.close();
  }
});

test('AUTH C1: a failed or timed-out delivery leaves no account, and registering again works', async () => {
  const f = await setup({});
  try {
    f.sms.failNext = true;
    const failed = await register(f, '9876543310');
    assert.deepEqual([failed.status, failed.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    assert.equal(cookieValue(failed.setCookies, 'elt_verification'), undefined);
    assert.deepEqual([f.created, f.inserted], [[], []], 'no permanent account');
    const retry = await register(f, '9876543310');
    assert.equal(retry.status, 202, 'retry is not blocked (nothing was reserved)');
    assert.equal((await verify(f, verificationCookie(retry), codeFor(f, '+919876543310'))).status, 200);
    assert.deepEqual(f.created, [derivedId('+919876543310')]);
  } finally {
    await f.close();
  }
});

test('AUTH C1: an existing verified Student\'s mobile cannot be claimed into a second account; the legacy Student ID login keeps working', async () => {
  const f = await setup({ studentMobile: '+919876543210' }); // student-1 (Student ID account) verified this number
  try {
    const attempt = await register(f, '9876543210');
    assert.equal(attempt.status, 202, 'same answer as for a new number');
    const refused = await verify(f, verificationCookie(attempt), codeFor(f, '+919876543210'));
    assert.deepEqual([refused.status, refused.body.code], [409, 'ACCOUNT_NOT_CREATED']);
    assert.equal(f.created.length, 0, 'no second account');
    assert.equal(f.store.contacts.get('student-1:sms'), '+919876543210', 'the existing account is unchanged');
    assert.equal(f.store.users.get('student-1')?.loginId, 'STUDENT-1');
    // The number still identifies exactly one Student, and both sign-in paths still work.
    assert.deepEqual([(await mobileLogin(f, '9876543210')).status, (await studentLogin(f)).status], [202, 202]);
  } finally {
    await f.close();
  }
});

test('AUTH C1: registration answers do not disclose whether a number is new, registered or already claimed', async () => {
  const f = await setup({ extraStudents: [{ id: 'student-m', loginId: derivedId('+919876543321'), mobile: '+919876543321' }] });
  try {
    await register(f, '9876543322'); // an existing pending claim
    const answers = [await register(f, '9876543320'), await register(f, '9876543321'), await register(f, '9876543322')];
    const shape = (result: Awaited<ReturnType<typeof register>>) => {
      const { destination: _d, resendAvailableAt: _r, expiresAt: _e, ...rest } = result.body;
      return { status: result.status, rest, cookies: result.setCookies.map((cookie) => cookie.split('=')[0]) };
    };
    assert.deepEqual(shape(answers[0]), shape(answers[1]));
    assert.deepEqual(shape(answers[0]), shape(answers[2]));
    assert.deepEqual(answers.map((result) => result.status), [202, 202, 202]);
    for (const result of answers) assert.equal(cookieValue(result.setCookies, 'elt_session'), undefined, 'no session before verification');
  } finally {
    await f.close();
  }
});

test('AUTH C1: OTP values, passwords and phone numbers never appear in claims, challenges or audit events', async () => {
  const f = await setup({});
  try {
    const result = await register(f, '9876543330', 'Private Person', 'Very-secret-pass-2026');
    const code = codeFor(f, '+919876543330');
    assert.ok(!JSON.stringify(result.body).includes(code), 'the code is never returned');
    const { claim, challenge } = claimFor(f, result);
    assert.match(claim.passwordHash, /^\$2[aby]\$12\$/, 'bcrypt, existing cost');
    assert.ok(await bcrypt.compare('Very-secret-pass-2026', claim.passwordHash));
    assert.ok(!JSON.stringify(claim).includes('Very-secret-pass-2026'));
    assert.ok(!JSON.stringify(challenge).includes(`"${code}"`), 'only the keyed hash of the code is stored');
    assert.equal((await verify(f, verificationCookie(result), code)).status, 200);
    const audit = JSON.stringify(f.store.events);
    for (const secret of [code, 'Very-secret-pass-2026', '9876543330', claim.passwordHash]) assert.ok(!audit.includes(secret), 'not in the audit trail');
    assert.ok(f.store.events.some((event) => event.action === 'student.registration_completed'));
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b: SMS settings are all required, positive whole numbers, consistent, and have no defaults', () => {
  const unset = verification.resolveAbuseProtection({});
  assert.deepEqual([unset.sms, unset.registrationClaimTtlMs], [null, null]);
  assert.deepEqual(unset.problems, [
    'AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS is not set', 'AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS is not set',
    'AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS is not set', 'AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS is not set',
    'AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS is not set', 'AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS is not set',
    'AUTH_SMS_DAILY_MAX_SENDS is not set', 'AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS is not set',
    'AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS is not set',
  ]);
  const VALID = {
    AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS: '3600', AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS: '3',
    AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS: '1800', AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS: '5',
    AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS: '7200', AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS: '4',
    AUTH_SMS_DAILY_MAX_SENDS: '500', AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '300', AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: '600',
  };
  const valid = verification.resolveAbuseProtection(VALID);
  assert.deepEqual([valid.sms, valid.registrationClaimTtlMs, valid.problems], [{
    unverified: { windowMs: 3_600_000, maxSends: 3 }, verified: { windowMs: 1_800_000, maxSends: 5 }, account: { windowMs: 7_200_000, maxSends: 4 },
    dailyMaxSends: 500, dailyMaxUnverifiedSends: 300,
  }, 600_000, []]);
  // Each SMS setting missing, zero, negative, fractional or non-numeric: SMS closed (never partially applied).
  for (const name of Object.keys(VALID).filter((key) => key !== 'AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS')) {
    for (const bad of [undefined, '', '0', '-1', '1.5', 'ten', '1e3']) {
      const result = verification.resolveAbuseProtection({ ...VALID, [name]: bad });
      assert.equal(result.sms, null, `${name}=${String(bad)}`);
      assert.match(result.problems.join('|'), new RegExp(name), `${name}=${String(bad)} is reported by name`);
    }
  }
  // The unverified daily cap may equal but never exceed the shared total.
  assert.ok(verification.resolveAbuseProtection({ ...VALID, AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '500' }).sms);
  const inconsistent = verification.resolveAbuseProtection({ ...VALID, AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '501' });
  assert.equal(inconsistent.sms, null);
  assert.deepEqual(inconsistent.problems, ['AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS must not exceed AUTH_SMS_DAILY_MAX_SENDS']);
  // The C1 generic settings are no longer read: they never configure anything.
  const legacy = verification.resolveAbuseProtection({ AUTH_SMS_DESTINATION_WINDOW_SECONDS: '3600', AUTH_SMS_DESTINATION_MAX_SENDS: '4', AUTH_SMS_DAILY_MAX_SENDS: '500', AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: '600' });
  assert.equal(legacy.sms, null);
  assert.match(verification.resolveAbuseProtection({ ...VALID, AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: '901' }).problems.join('|'), /CLAIM_TTL_SECONDS must not exceed 900/);
});

test('C1.3-B.2 regression: a missing claim lifetime keeps Student registration closed (503 REGISTRATION_NOT_CONFIGURED), with nothing written or sent', async () => {
  // Valid (test-only) SMS limits and a working test SMS provider: only the claim lifetime is missing.
  for (const protection of [testAbuseProtection({}, null), verification.resolveAbuseProtection({})]) {
    const f = await setup({ protection: protection.sms ? protection : { ...protection, sms: TEST_PROTECTION.sms } });
    try {
      assert.equal(verification.abuseProtection().registrationClaimTtlMs, null, 'the claim lifetime is missing');
      assert.ok(verification.abuseProtection().sms, 'SMS limits are configured, so only the claim lifetime closes registration');
      const result = await register(f, '9876543700');
      assert.deepEqual([result.status, result.body.code], [503, 'REGISTRATION_NOT_CONFIGURED']);
      assert.equal(f.registrations.claims.size, 0, 'no registration claim is created');
      assert.equal(f.store.challenges.size, 0, 'no verification challenge is created');
      assert.equal(f.sms.sent.length, 0, 'no SMS delivery is attempted');
      assert.equal(f.smsGuard.reservations.length + f.smsGuard.refusals.length, 0, 'no SMS reservation is attempted');
      assert.deepEqual([f.created.length, f.inserted.length], [0, 0], 'no account');
      assert.equal(cookieValue(result.setCookies, 'elt_verification'), undefined);
      assert.equal(cookieValue(result.setCookies, 'elt_session'), undefined);
      // Other SMS flows are unaffected by the claim lifetime (it is independent).
      f.store.contacts.set('student-1:sms', '+919876543701');
      assert.equal((await studentLogin(f)).status, 202, 'Student sign-in still works');
    } finally {
      await f.close();
    }
  }
});

test('C1.3-B: authVerification re-exports the one pure resolver (same functions, same results)', async () => {
  const pure = await import('./smsProtectionConfig.js');
  assert.equal(verification.resolveAbuseProtection, pure.resolveAbuseProtection, 'the very same function');
  assert.equal(verification.abuseProtectionReadiness, pure.abuseProtectionReadiness);
  assert.equal(verification.ABUSE_PROTECTION_SETTINGS, pure.ABUSE_PROTECTION_SETTINGS);
  assert.equal(verification.SMS_PROTECTION_SETTING_NAMES, pure.SMS_PROTECTION_SETTING_NAMES);
  for (const env of [{}, { AUTH_SMS_DAILY_MAX_SENDS: '5' }, { AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: '901' }]) {
    assert.deepEqual(verification.resolveAbuseProtection(env), pure.resolveAbuseProtection(env));
  }
  const source = await readFile(new URL('./smsProtectionConfig.ts', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import[^;]*from '([^']+)'/gm)].map((match) => match[1]), ['./verificationProviders.js'], 'the pure module imports only OTP_POLICY');
});

test('C1.3-A: the resolver reports every setting\'s status (never its value), and the readiness summary separates the claim lifetime', () => {
  const VALID = {
    AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS: '3601', AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS: '3',
    AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS: '1801', AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS: '5',
    AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS: '7201', AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS: '4',
    AUTH_SMS_DAILY_MAX_SENDS: '501', AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '301', AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: '601',
  };
  assert.deepEqual([...verification.SMS_PROTECTION_SETTING_NAMES].sort(), Object.keys(VALID).filter((name) => name !== 'AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS').sort(), 'exactly the eight SMS settings');
  const all = (status: string) => Object.fromEntries(verification.SMS_PROTECTION_SETTING_NAMES.map((name) => [name, status]));
  const unset = verification.abuseProtectionReadiness(verification.resolveAbuseProtection({}));
  assert.deepEqual(unset, { smsProtectionConfigured: false, registrationClaimTtlConfigured: false, smsSettings: all('missing'), registrationClaimTtlSetting: { AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: 'missing' } });
  const valid = verification.abuseProtectionReadiness(verification.resolveAbuseProtection(VALID));
  assert.deepEqual(valid, { smsProtectionConfigured: true, registrationClaimTtlConfigured: true, smsSettings: all('valid'), registrationClaimTtlSetting: { AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: 'valid' } });
  for (const [bad, status] of [['', 'missing'], ['0', 'invalid'], ['-1', 'invalid'], ['1.5', 'invalid'], ['ten', 'invalid']] as const) {
    const readiness = verification.abuseProtectionReadiness(verification.resolveAbuseProtection({ ...VALID, AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS: bad }));
    assert.equal(readiness.smsProtectionConfigured, false, bad);
    assert.equal(readiness.smsSettings.AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS, status, bad);
    assert.equal(Object.values(readiness.smsSettings).filter((value) => value !== 'valid').length, 1, 'only that setting is flagged');
  }
  const inconsistent = verification.abuseProtectionReadiness(verification.resolveAbuseProtection({ ...VALID, AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '502' }));
  assert.deepEqual([inconsistent.smsProtectionConfigured, inconsistent.smsSettings.AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS], [false, 'inconsistent']);
  // A claim-lifetime problem never closes SMS; it only closes Student registration.
  const ttlOnly = verification.abuseProtectionReadiness(verification.resolveAbuseProtection({ ...VALID, AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: '901' }));
  assert.deepEqual([ttlOnly.smsProtectionConfigured, ttlOnly.registrationClaimTtlConfigured, ttlOnly.registrationClaimTtlSetting.AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS], [true, false, 'invalid']);
  // No value ever appears in the summary.
  const text = JSON.stringify([valid, inconsistent, ttlOnly]);
  for (const value of Object.values(VALID)) assert.ok(!text.includes(value), `value ${value} is not reported`);
  // The startup initializer installs exactly what requests then use.
  const installed = verification.initializeAbuseProtection(VALID);
  assert.equal(verification.abuseProtection(), installed);
  verification.configureAbuseProtection(undefined);
});

test('AUTH C1.1-b: every SMS flow fails closed without the limits, before any lookup or write, with one answer for every credential', async () => {
  for (const [protection, code] of [
    [{ ...TEST_PROTECTION, sms: null }, 'SMS_PROTECTION_NOT_CONFIGURED'],
    [verification.resolveAbuseProtection({}), 'SMS_PROTECTION_NOT_CONFIGURED'],
  ] as const) {
    const f = await setup({ protection, studentMobile: '+919876543210', institute: { status: 'approved', verification: { mobileDestination: '+919876500010', mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null } } });
    try {
      const answers = [
        await studentLogin(f),
        await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { loginId: 'student-1', password: 'Wrong-password-2026', role: 'candidate' } }),
        await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { loginId: 'nobody', password: STUDENT_PASSWORD, role: 'candidate' } }),
        await mobileLogin(f, '9876543210'),
        await instituteLogin(f),
        await call(f.base, 'POST', '/api/auth/login', { surface: 'institution', body: { loginId: 'institute-1', password: 'Wrong-password-2026', role: 'center' } }),
        await register(f, '9876543340'),
      ];
      for (const result of answers) assert.deepEqual([result.status, result.body.code], [503, code]);
      assert.equal(new Set(answers.slice(0, 4).map((result) => JSON.stringify(result.body))).size, 1, 'right, wrong and unknown credentials answer identically');
      assert.equal(new Set(answers.slice(4, 6).map((result) => JSON.stringify(result.body))).size, 1);
      assert.equal(f.lookups, 0, 'no account lookup, no password check');
      assert.deepEqual([f.registrations.claims.size, f.store.challenges.size, f.sms.sent.length, f.created.length, f.smsGuard.reservations.length], [0, 0, 0, 0, 0]);
    } finally {
      await f.close();
    }
  }
  // A challenge started while configured cannot send once the limits are removed (resend or capture).
  const login = await setup({ studentMobile: '+919876543210' });
  try {
    const signedIn = await studentLogin(login);
    verification.configureAbuseProtection({ ...TEST_PROTECTION, sms: null });
    [...login.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    const resend = await call(login.base, 'POST', '/api/auth/verification/resend', { surface: 'exam', cookie: verificationCookie(signedIn) });
    assert.deepEqual([resend.status, resend.body.code], [503, 'SMS_PROTECTION_NOT_CONFIGURED']);
    assert.equal(login.sms.sent.length, 1, 'no second SMS');
  } finally {
    await login.close();
  }
  const g = await setup({ studentMobile: null });
  try {
    const capture = await studentLogin(g);
    verification.configureAbuseProtection({ ...TEST_PROTECTION, sms: null });
    const destination = await call(g.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: verificationCookie(capture), body: { mobile: '9876543341' } });
    assert.deepEqual([destination.status, destination.body.code], [503, 'SMS_PROTECTION_NOT_CONFIGURED']);
    assert.equal(g.sms.sent.length, 0);
  } finally {
    await g.close();
  }
});

test('AUTH C1.1-b: every SMS purpose is reserved before delivery, in the bucket the server decides', async () => {
  const f = await setup({
    studentMobile: '+919876543500',
    extraStudents: [{ id: 'student-m', loginId: derivedId('+919876543501'), mobile: '+919876543501' }, { id: 'student-c', loginId: 'STUDENT-C' }],
    institute: { status: 'approved', verification: { mobileDestination: '+919876500020', mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null } },
  });
  try {
    const legacyLogin = await studentLogin(f);                                      // student_login to the verified contact
    await mobileLogin(f, '9876543501');                                             // student_login (mobile-first) to its verified contact
    const capture = await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { loginId: 'student-c', password: STUDENT_PASSWORD, role: 'candidate' } });
    await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: verificationCookie(capture), body: { mobile: '9876543502' } }); // capture
    await register(f, '9876543503');                                                // registration claim
    const institute = await instituteLogin(f);                                      // approved Institute, its recorded mobile (account bucket, C-1)
    // Resends inherit the server's classification.
    for (const challenge of f.store.challenges.values()) challenge.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'exam', cookie: verificationCookie(legacyLogin) });
    await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie: verificationCookie(institute) });

    const shape = f.smsGuard.reservations.map((r) => [r.purpose, r.bucket]);
    assert.deepEqual(shape, [
      ['student_login', 'verified'], ['student_login', 'verified'], ['student_mobile_capture', 'unverified'],
      ['student_registration', 'unverified'], ['institute_mobile', 'account'], ['student_login', 'verified'], ['institute_mobile', 'account'],
    ]);
    assert.equal(f.sms.sent.length, f.smsGuard.reservations.length, 'no SMS without a reservation');
    assert.ok(f.smsGuard.reservations.every((r) => /^[0-9a-f]{32}$/.test(r.destinationKey)), 'keyed destination hashes only');
    // Reservation ids correlate with code_sent; no phone number or code is recorded anywhere.
    const sentIds = f.store.events.filter((e) => e.action === 'verification.code_sent' && e.details?.channel === 'sms').map((e) => e.details!.correlationId);
    assert.deepEqual(sentIds, f.smsGuard.reservations.map((r) => r.reservationId));
    const audit = JSON.stringify([f.store.events, f.smsGuard.reservations, f.smsGuard.refusals]);
    for (const secret of [...f.sms.sent.map((entry) => entry.code), '9876543500', '9876543501', '9876543502', '9876543503', '9876500020']) assert.ok(!audit.includes(secret));
    // Email is not an SMS: no reservation (email limits are a separate decision).
    assert.ok(!f.smsGuard.reservations.some((r) => String(r.purpose) === 'institute_email'));
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b: a sign-in to a number that is not the account\'s current verified contact is unverified', async () => {
  const f = await setup({ studentMobile: '+919876543510' });
  try {
    const login = await studentLogin(f);
    assert.equal(f.smsGuard.reservations.at(-1)!.bucket, 'verified');
    // The verified contact changes after the challenge was created (any mismatch, however it arises).
    f.store.contacts.set('student-1:sms', '+919876543511');
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    assert.equal((await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'exam', cookie: verificationCookie(login) })).status, 200);
    assert.deepEqual([f.smsGuard.reservations.at(-1)!.purpose, f.smsGuard.reservations.at(-1)!.bucket], ['student_login', 'unverified']);
    // The bucket rule itself: account + student_login + exact current verified contact, nothing else.
    const rule = (input: Partial<Parameters<typeof verification.smsBucketFor>[0]>) => verification.smsBucketFor({ userId: 'student-1', purpose: 'student_login', destination: '+919876543511', channel: 'sms', ...input });
    assert.equal(await rule({}), 'verified');
    assert.equal(await rule({ destination: '+919876543510' }), 'unverified', 'mismatch');
    assert.equal(await rule({ userId: null }), 'unverified', 'no account (claim)');
    for (const purpose of ['student_mobile_capture', 'student_registration', 'institute_mobile'] as const) assert.equal(await rule({ purpose }), 'unverified', purpose);
    assert.equal(await rule({ userId: 'institute-1' }), 'unverified', 'no verified Student contact');
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b: one purpose cannot evade another\'s unverified allowance, and unverified traffic cannot exhaust a victim\'s sign-in', async () => {
  const victim = '+919876543520';
  const f = await setup({
    studentMobile: victim, // the victim (student-1) signs in to this verified number
    extraStudents: [{ id: 'student-x', loginId: 'STUDENT-X' }],
    institute: { status: 'approved', verification: { mobileDestination: victim, mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null } },
    protection: testAbuseProtection({ unverified: { windowMs: 3600_000, maxSends: 2 }, verified: { windowMs: 3600_000, maxSends: 2 } }),
  });
  try {
    // Unverified traffic to the victim's number from three different purposes shares one allowance.
    assert.equal((await register(f, '9876543520')).status, 202);
    const capture = await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { loginId: 'student-x', password: STUDENT_PASSWORD, role: 'candidate' } });
    assert.equal((await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: verificationCookie(capture), body: { mobile: '9876543520' } })).status, 200);
    const third = await register(f, '9876543520');
    assert.deepEqual([third.status, third.body.code], [429, 'SMS_DESTINATION_LIMITED'], 'a third unverified purpose cannot evade the shared allowance');
    assert.equal(f.sms.sent.filter((entry) => entry.destination === victim).length, 2);
    // C-1: the APPROVED Institute whose recorded mobile was flooded still verifies it (account bucket).
    const institute = await instituteLogin(f);
    assert.deepEqual([institute.status, institute.body.purpose], [202, 'institute_mobile'], 'anonymous flooding no longer locks out the Institute');
    assert.equal(f.smsGuard.reservations.at(-1)!.bucket, 'account');
    // The victim's own sign-in uses the separate verified allowance and still works.
    assert.equal((await studentLogin(f)).status, 202);
    assert.equal((await studentLogin(f)).status, 202);
    const limited = await studentLogin(f);
    assert.deepEqual([limited.status, limited.body.code], [429, 'SMS_DESTINATION_LIMITED'], 'the verified allowance has its own limit');
    // Student registration has no per-number pre-check (C-2 covers Institute registration only), so its
    // third send is refused by the authoritative reservation.
    assert.deepEqual(f.smsGuard.refusals.map((r) => [r.reason, r.bucket]), [['destination_limit', 'unverified'], ['destination_limit', 'verified']]);
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b: the unverified 24-hour cap keeps headroom for sign-in; the shared total counts every purpose; no password oracle when exhausted', async () => {
  const f = await setup({
    studentMobile: '+919876543530',
    institute: { status: 'approved', verification: { mobileDestination: '+919876500030', mobileVerifiedAt: new Date(), emailDestination: 'office@example.test', emailVerifiedAt: new Date(), institutionalStatus: 'verified', suspendedAt: null } },
    protection: testAbuseProtection({ dailyMaxSends: 4, dailyMaxUnverifiedSends: 2 }),
  });
  try {
    assert.equal((await register(f, '9876543531')).status, 202);
    assert.equal((await register(f, '9876543532')).status, 202);
    const capped = await register(f, '9876543533');
    assert.deepEqual([capped.status, capped.body.code], [503, 'SMS_DAILY_LIMIT_REACHED'], 'unverified cap reached (closed before any write)');
    assert.equal(f.registrations.claims.size, 2);
    // Sign-in still has the remaining shared capacity.
    assert.equal((await studentLogin(f)).status, 202);
    assert.equal((await studentLogin(f)).status, 202);
    assert.equal(f.sms.sent.length, 4, 'the shared total is never exceeded');
    // Total exhausted: Student sign-in is closed BEFORE the password check, identically for any credential.
    const lookups = f.lookups;
    const right = await studentLogin(f);
    const wrong = await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { loginId: 'student-1', password: 'Wrong-password-2026', role: 'candidate' } });
    assert.deepEqual([right.status, right.body.code], [503, 'SMS_DAILY_LIMIT_REACHED']);
    assert.deepEqual(right.body, wrong.body, 'no password oracle');
    assert.equal(f.lookups, lookups, 'no lookup while exhausted');
    // A verified Institute needs no SMS to sign in, so exhaustion does not lock it out.
    assert.equal((await instituteLogin(f)).status, 200);
    assert.equal(f.sms.sent.length, 4);
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b: failed and timed-out deliveries still count, and their reservation id is recorded', async () => {
  const f = await setup({ studentMobile: '+919876543540', protection: testAbuseProtection({ verified: { windowMs: 3600_000, maxSends: 2 } }) });
  try {
    f.sms.failNext = true;
    const failed = await studentLogin(f);
    assert.deepEqual([failed.status, failed.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    const failure = f.store.events.find((e) => e.action === 'verification.delivery_failed')!;
    assert.equal(failure.details?.correlationId, f.smsGuard.reservations[0].reservationId, 'the failure is correlated with its reservation (C1.4-A: correlationId = reservation id)');
    assert.equal(failure.details?.failure, 'unknown', 'a plain Error is recorded as unknown');
    assert.equal((await studentLogin(f)).status, 202);
    const third = await studentLogin(f);
    assert.deepEqual([third.status, third.body.code], [429, 'SMS_DESTINATION_LIMITED'], 'the failed delivery counted');
    assert.equal(f.sms.sent.length, 1);
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b concurrency: parallel sends to one number never exceed its allowance', async () => {
  const f = await setup({ protection: testAbuseProtection({ unverified: { windowMs: 3600_000, maxSends: 3 } }) });
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => register(f, '9876543550')));
    assert.equal(results.filter((result) => result.status === 202).length, 3);
    assert.ok(results.filter((result) => result.status !== 202).every((result) => result.status === 429 && result.body.code === 'SMS_DESTINATION_LIMITED'));
    assert.equal(f.sms.sent.length, 3);
  } finally {
    await f.close();
  }
});

const UNVERIFIED_INSTITUTE = (mobile: string) => ({ mobileDestination: mobile, mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'pending' as const, suspendedAt: null });

test('AUTH C1.1-b C-1: the account bucket is only an APPROVED Institute\'s own recorded mobile, decided from fresh server data', async () => {
  const f = await setup({ institute: { status: 'approved', verification: UNVERIFIED_INSTITUTE('+919876543600') } });
  try {
    const rule = (input: Partial<Parameters<typeof verification.smsBucketFor>[0]>) => verification.smsBucketFor({ userId: 'institute-1', purpose: 'institute_mobile', destination: '+919876543600', channel: 'sms', ...input });
    assert.equal(await rule({}), 'account');
    assert.equal(await rule({ destination: '+919876543601' }), 'unverified', 'mismatched destination');
    assert.equal(await rule({ userId: null }), 'unverified', 'not user-backed');
    assert.equal(await rule({ purpose: 'student_mobile_capture' }), 'unverified', 'another purpose');
    assert.equal(await rule({ userId: 'student-1' }), 'unverified', 'not an Institute');
    // Authoritative data, read fresh at send time: a change of status or recorded mobile changes the bucket.
    f.store.users.get('institute-1')!.accountStatus = 'pending';
    assert.equal(await rule({}), 'unverified', 'pending Institute (registration-time) stays unverified');
    f.store.users.get('institute-1')!.accountStatus = 'approved';
    f.store.institutes.get('institute-1')!.mobileDestination = '+919876543602';
    assert.equal(await rule({}), 'unverified', 'recorded mobile changed');
    f.store.institutes.get('institute-1')!.mobileDestination = '+919876543600';
    // Legacy Student capture is unchanged (unverified), even for an approved Student.
    assert.equal(await verification.smsBucketFor({ userId: 'student-1', purpose: 'student_mobile_capture', destination: '+919876543600', channel: 'sms' }), 'unverified');
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b C-1: the account allowance is keyed to (Institute, number); anonymous traffic and other accounts cannot consume it', async () => {
  const key = Buffer.alloc(32, 7);
  const own = verification.smsAccountDestinationKey(key, 'institute-1', '+919876543610');
  assert.notEqual(own, verification.smsAccountDestinationKey(key, 'institute-2', '+919876543610'), 'another account has its own key');
  assert.notEqual(own, verification.smsDestinationKey(key, '+919876543610'), 'distinct from the per-number key');
  assert.match(own, /^[0-9a-f]{32}$/);
  assert.ok(!own.includes('9876543610'));
  const f = await setup({
    institute: { status: 'approved', verification: UNVERIFIED_INSTITUTE('+919876543610') },
    protection: testAbuseProtection({ unverified: { windowMs: 3600_000, maxSends: 1 }, account: { windowMs: 3600_000, maxSends: 2 } }),
  });
  try {
    // Anonymous traffic uses up the number's unverified allowance ...
    assert.equal((await register(f, '9876543610')).status, 202);
    assert.equal((await register(f, '9876543610')).status, 429);
    // ... another account's account-bucket sends to the same number use their own key ...
    await f.smsGuard.reserveSmsSend({ reservationId: 'other', destinationKey: verification.smsAccountDestinationKey(key, 'institute-2', '+919876543610'), bucket: 'account', purpose: 'institute_mobile', destinationWindowMs: 3600_000, destinationMaxSends: 2, dailyMaxSends: 1000, dailyMaxUnverifiedSends: 800 });
    await f.smsGuard.reserveSmsSend({ reservationId: 'other-2', destinationKey: verification.smsAccountDestinationKey(key, 'institute-2', '+919876543610'), bucket: 'account', purpose: 'institute_mobile', destinationWindowMs: 3600_000, destinationMaxSends: 2, dailyMaxSends: 1000, dailyMaxUnverifiedSends: 800 });
    // ... so this Institute still has its full allowance of 2, and then its own limit applies.
    const first = await instituteLogin(f);
    assert.equal(first.status, 202);
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    assert.equal((await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie: verificationCookie(first) })).status, 200);
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    const third = await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie: verificationCookie(first) });
    assert.deepEqual([third.status, third.body.code], [429, 'SMS_DESTINATION_LIMITED'], 'its own account allowance is enforced');
    assert.deepEqual(f.smsGuard.reservations.filter((r) => r.destinationKey === own).length, 2);
    assert.equal(f.sms.sent.filter((entry) => entry.purpose === 'institute_mobile').length, 2);
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b C-1: account sends count against the shared total but not the anonymous unverified cap', async () => {
  const f = await setup({
    studentMobile: '+919876543620',
    institute: { status: 'approved', verification: UNVERIFIED_INSTITUTE('+919876543621') },
    protection: testAbuseProtection({ dailyMaxSends: 3, dailyMaxUnverifiedSends: 1 }),
  });
  try {
    assert.equal((await register(f, '9876543622')).status, 202, 'anonymous: 1 of the unverified cap 1');
    assert.deepEqual([(await register(f, '9876543623')).status], [503], 'the anonymous cap is reached');
    const institute = await instituteLogin(f);
    assert.equal(institute.status, 202, 'the account bucket is not blocked by the anonymous cap');
    assert.deepEqual(await f.smsGuard.smsUsageLast24h(), { total: 2, unverified: 1 }, 'the account send counts towards the total only');
    assert.equal((await studentLogin(f)).status, 202, 'total 3 of 3');
    const closed = await studentLogin(f);
    assert.deepEqual([closed.status, closed.body.code], [503, 'SMS_DAILY_LIMIT_REACHED'], 'the shared total includes the account send');
  } finally {
    await f.close();
  }
});

test('AUTH C1.1-b C-2: the destination gate is advisory, unverified-only and keyed (no number is stored)', async () => {
  const f = await setup({ protection: testAbuseProtection({ unverified: { windowMs: 3600_000, maxSends: 1 } }) });
  try {
    assert.equal(await verification.smsProtectionGate('unverified', '+919876543630'), null);
    assert.equal((await register(f, '9876543630')).status, 202);
    const limited = await verification.smsProtectionGate('unverified', '+919876543630');
    assert.deepEqual([limited?.status, limited?.code], [429, 'SMS_DESTINATION_LIMITED']);
    assert.equal(await verification.smsProtectionGate('unverified', '+919876543631'), null, 'other numbers unaffected');
    assert.equal(await verification.smsProtectionGate('any', '+919876543630'), null, 'the destination check applies to unverified scope only');
    assert.equal(f.smsGuard.refusals.length, 0, 'advisory reads record nothing');
  } finally {
    await f.close();
  }
});

test('static: the SMS provider is called only from deliverCode, after the universal reservation', async () => {
  const source = await readFile(new URL('./authVerification.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/\.sendOtp\(/g) ?? []).length, 1);
  const deliver = source.slice(source.indexOf('async function deliverCode('), source.indexOf('export async function startVerification('));
  assert.ok(deliver.includes('.sendOtp('), 'inside deliverCode');
  assert.ok(deliver.indexOf("if (challenge.channel === 'sms') {") < deliver.indexOf('reserveSmsSend(') && deliver.indexOf('reserveSmsSend(') < deliver.indexOf('generateOtp()'), 'reserved before a code exists');
  assert.ok(!/registrationClaimId && challenge\.channel === 'sms'/.test(deliver), 'no registration-only condition remains');
  for (const name of ['server/index.ts']) {
    const index = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    assert.ok(index.indexOf("smsProtectionGate(role === 'candidate' ? 'any' : 'config')") < index.indexOf("const USER_COLUMNS = 'id, login_id"), `${name}: login gate precedes the lookup`);
    const registerStart = index.indexOf("app.post('/api/center/register'");
    assert.ok(index.indexOf("smsProtectionGate('unverified')", registerStart) < index.indexOf('INSERT INTO users', registerStart), `${name}: Institute registration gate precedes the write`);
  }
});

test('AUTH C1: a legacy Student cannot capture a mobile-first Student\'s number; capturing another legacy number is unchanged', async () => {
  const f = await setup({ studentMobile: null, extraStudents: [{ id: 'student-m', loginId: derivedId('+919876543360'), mobile: '+919876543360' }, { id: 'student-2', loginId: 'STUDENT-2', mobile: '+919876543361' }] });
  try {
    const login = await studentLogin(f);
    const cookie = verificationCookie(login);
    await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie, body: { mobile: '9876543360' } });
    const refused = await verify(f, cookie, codeFor(f, '+919876543360'));
    assert.deepEqual([refused.status, refused.body.code], [409, 'MOBILE_NOT_AVAILABLE']);
    assert.equal(cookieValue(refused.setCookies, 'elt_session'), undefined);
    assert.equal(f.store.contacts.get('student-1:sms'), undefined, 'nothing captured');
    assert.equal((await mobileLogin(f, '9876543360')).status, 202, 'the mobile-first Student keeps an unambiguous mobile sign-in');

    // Existing, unresolved legacy-vs-legacy policy is unchanged (not part of AUTH C1).
    const again = await studentLogin(f);
    await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: verificationCookie(again), body: { mobile: '9876543361' } });
    assert.equal((await verify(f, verificationCookie(again), codeFor(f, '+919876543361'))).status, 200);
  } finally {
    await f.close();
  }
});

test('AUTH C1 concurrency: parallel verification of several claims, or of one claim, yields exactly one account and one session', async () => {
  const f = await setup({});
  try {
    const claims = [await register(f, '9876543370', 'First'), await register(f, '9876543370', 'Second'), await register(f, '9876543370', 'Third')];
    const codes = f.sms.sent.filter((entry) => entry.destination === '+919876543370').map((entry) => entry.code);
    delayChallengeReads(f.store);
    const results = await Promise.all(claims.map((claim, index) => verify(f, verificationCookie(claim), codes[index])));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409, 409]);
    assert.equal(f.created.length, 1, 'exactly one permanent account');
    assert.equal(f.store.sessions.filter((session) => session.verified).length, 1, 'exactly one session');
    assert.deepEqual(await f.store.findCandidateIdsByVerifiedMobile('+919876543370', 5), [[...f.store.users.values()].find((u) => u.loginId === derivedId('+919876543370'))!.id], 'no ambiguous identity');
  } finally {
    await f.close();
  }
  const g = await setup({});
  try {
    const claim = await register(g, '9876543371');
    const code = codeFor(g, '+919876543371');
    delayChallengeReads(g.store);
    const results = await Promise.all(Array.from({ length: 6 }, () => verify(g, verificationCookie(claim), code)));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    // Losers hit the existing single-use paths: 401 (consumed) or 429 TOO_MANY_ATTEMPTS (attempt reservation on a consumed challenge).
    assert.ok(results.filter((result) => result.status !== 200).every((result) => result.status === 401 || (result.status === 429 && result.body.code === 'TOO_MANY_ATTEMPTS')));
    assert.deepEqual([g.created.length, g.store.sessions.length], [1, 1]);
  } finally {
    await g.close();
  }
});

test('AUTH C1 concurrency: a legacy mobile capture racing a registration of the same number binds it to exactly one Student', async () => {
  for (let round = 0; round < 2; round += 1) {
    const f = await setup({ studentMobile: null });
    try {
      const capture = verificationCookie(await studentLogin(f));
      await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: capture, body: { mobile: '9876543380' } });
      const captureCode = codeFor(f, '+919876543380');
      const registration = await register(f, '9876543380');
      const registrationCode = codeFor(f, '+919876543380');
      delayChallengeReads(f.store);
      const pair = [() => verify(f, capture, captureCode), () => verify(f, verificationCookie(registration), registrationCode)];
      if (round === 1) pair.reverse();
      const results = await Promise.all(pair.map((run) => run()));
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 409], 'one wins, the other is refused');
      const owners = await f.store.findCandidateIdsByVerifiedMobile('+919876543380', 5);
      assert.equal(owners.length, 1, 'exactly one Student holds the verified number');
      const mobileFirst = [...f.store.users.values()].filter((user) => user.loginId === derivedId('+919876543380'));
      assert.ok(mobileFirst.length === 0 || owners[0] === mobileFirst[0].id, 'no derived account beside another verified owner');
      assert.equal((await mobileLogin(f, '9876543380')).status, 202, 'mobile sign-in stays unambiguous');
    } finally {
      await f.close();
    }
  }
});

test('AUTH C1 concurrency: cleanup racing a verification of an expired claim never creates an account', async () => {
  const f = await setup({});
  try {
    const claim = await register(f, '9876543390');
    const code = codeFor(f, '+919876543390');
    const { claim: record } = claimFor(f, claim);
    record.expiresAt = new Date(Date.now() - 1000);
    delayChallengeReads(f.store);
    const [verified, other] = await Promise.all([verify(f, verificationCookie(claim), code), register(f, '9876543391')]);
    assert.equal(other.status, 202);
    assert.ok([410, 401].includes(verified.status), `expired or gone, got ${verified.status}`);
    assert.deepEqual(f.created, []);
    assert.equal(cookieValue(verified.setCookies, 'elt_session'), undefined);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// AUTH C1: the PostgreSQL store statements (scripted client; the real database run is in
// databaseGrants.postgres.integration.test.ts, gated and not executed here)
// ---------------------------------------------------------------------------

function scriptedPool(answer: (sql: string, values: unknown[]) => { rows?: Record<string, unknown>[]; rowCount?: number } | Error) {
  const log: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      log.push({ sql, values });
      const result = ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) ? {} : answer(sql, values);
      if (result instanceof Error) throw result;
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
    },
    release: () => undefined,
  };
  return { log, pool: { query: client.query, connect: async () => client } as never };
}

const CLAIM_ROW = { mobile: '+919876543400', display_name: 'New Student', password_hash: '$2a$12$' + 'a'.repeat(53), expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null };
const completion = (overrides: Record<string, unknown> = {}) => ({
  challengeId: 'ch-1', claimId: 'claim-1', destination: '+919876543400', userId: 'user-new', loginId: 'M-NEW',
  sessionTokenHash: 'session-hash', sessionExpiresAt: new Date(Date.now() + 3600_000), now: new Date(), ...overrides,
});

test('AUTH C1 PostgreSQL store: completion locks claim, then challenge, then the mobile, and writes everything in one transaction', async () => {
  const storeModule = await import('./authVerificationStore.js');
  const happy = scriptedPool((sql) => {
    if (sql.startsWith('SELECT mobile, display_name')) return { rows: [CLAIM_ROW] };
    if (sql.startsWith('SELECT ac.user_id')) return { rows: [] };
    return { rowCount: 1, rows: sql.includes('RETURNING id') ? [{ id: 'x' }] : [] };
  });
  assert.equal(await storeModule.createPostgresStudentRegistrationStore(happy.pool).completeRegistration(completion()), 'completed');
  const order = happy.log.map(({ sql }) => sql);
  const expectOrder = ['BEGIN', 'SELECT mobile, display_name, password_hash, expires_at', 'UPDATE verification_challenges SET consumed_at', 'SELECT pg_advisory_xact_lock', 'SELECT ac.user_id FROM account_contacts', 'INSERT INTO users', 'INSERT INTO account_contacts', 'INSERT INTO auth_sessions', 'INSERT INTO auth_session_verifications', 'DELETE FROM student_registration_claims WHERE id = $1', 'INSERT INTO auth_verification_events', 'INSERT INTO auth_verification_events', 'COMMIT'];
  assert.equal(order.length, expectOrder.length, order.join(' | '));
  expectOrder.forEach((prefix, index) => assert.ok(order[index].startsWith(prefix), `${index}: ${order[index].slice(0, 60)} vs ${prefix}`));
  assert.match(happy.log[1].sql, /FOR UPDATE$/);
  assert.match(happy.log[2].sql, /registration_claim_id = \$2 AND consumed_at IS NULL AND expires_at > \$3/);
  assert.deepEqual(happy.log[3].values, [storeModule.studentMobileLockKey('+919876543400')]);
  assert.match(happy.log[5].sql, /ON CONFLICT \(login_id\) DO NOTHING/);
  assert.deepEqual(happy.log[9].values, ['claim-1'], 'AUTH C1.1: the completed claim (and, by cascade, its challenge) is deleted inside the transaction, after every write');
  assert.ok(!happy.log.some(({ sql }) => sql.startsWith('UPDATE student_registration_claims')), 'a completed claim is deleted, not merely consumed');
  assert.ok(!JSON.stringify(happy.log.filter(({ sql }) => sql.startsWith('INSERT INTO auth_verification_events'))).includes('+919876543400'), 'no phone number in events');

  for (const [label, answer, expected, consumesClaim] of [
    ['mobile already verified by a Student', (sql: string) => (sql.startsWith('SELECT mobile') ? { rows: [CLAIM_ROW] } : sql.startsWith('SELECT ac.user_id') ? { rows: [{ user_id: 'legacy' }] } : { rowCount: 1 }), 'refused', true],
    ['login ID already taken', (sql: string) => (sql.startsWith('SELECT mobile') ? { rows: [CLAIM_ROW] } : sql.startsWith('SELECT ac.user_id') ? { rows: [] } : sql.startsWith('INSERT INTO users') ? { rowCount: 0 } : { rowCount: 1 }), 'refused', true],
    ['claim expired', (sql: string) => (sql.startsWith('SELECT mobile') ? { rows: [{ ...CLAIM_ROW, expires_at: new Date(Date.now() - 1000).toISOString() }] } : { rowCount: 1 }), 'expired', false],
    ['challenge already consumed', (sql: string) => (sql.startsWith('SELECT mobile') ? { rows: [CLAIM_ROW] } : { rowCount: 0 }), 'not_in_progress', false],
    ['claim deleted by cleanup', (sql: string) => (sql.startsWith('SELECT mobile') ? { rows: [] } : { rowCount: 0 }), 'not_in_progress', false],
  ] as const) {
    const scripted = scriptedPool(answer);
    assert.equal(await storeModule.createPostgresStudentRegistrationStore(scripted.pool).completeRegistration(completion()), expected, label);
    assert.ok(!scripted.log.some(({ sql }) => /INSERT INTO (account_contacts|auth_sessions)/.test(sql)), `${label}: no contact or session`);
    assert.ok(!scripted.log.some(({ sql }) => sql.startsWith('DELETE FROM student_registration_claims')), `${label}: the claim is not deleted`);
    const consumed = scripted.log.filter(({ sql }) => sql.startsWith('UPDATE student_registration_claims'));
    assert.equal(consumed.length, consumesClaim ? 1 : 0, `${label}: claim consumed only for a permanent business refusal`);
    if (consumesClaim) {
      assert.equal(consumed[0].sql, 'UPDATE student_registration_claims SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL');
      // Same transaction as the challenge consumption, so the refused claim has no live challenge left.
      assert.ok(scripted.log.findIndex(({ sql }) => sql.startsWith('UPDATE verification_challenges SET consumed_at')) < scripted.log.indexOf(consumed[0]));
      assert.equal(scripted.log.at(-1)!.sql, 'COMMIT');
    }
  }
  // Any error rolls the whole completion back (no COMMIT).
  const failing = scriptedPool((sql) => (sql.startsWith('SELECT mobile') ? { rows: [CLAIM_ROW] } : sql.startsWith('SELECT ac.user_id') ? { rows: [] } : sql.startsWith('INSERT INTO auth_sessions') ? new Error('synthetic failure') : { rowCount: 1, rows: [{ id: 'x' }] }));
  await assert.rejects(storeModule.createPostgresStudentRegistrationStore(failing.pool).completeRegistration(completion()), /synthetic failure/);
  assert.deepEqual(failing.log.slice(-1).map(({ sql }) => sql), ['ROLLBACK']);
  assert.ok(!failing.log.some(({ sql }) => sql === 'COMMIT'));
  assert.ok(!failing.log.some(({ sql }) => /^(UPDATE|DELETE FROM) student_registration_claims/.test(sql)), 'a transient failure never consumes or deletes the claim (retry stays possible)');
  // A failure at the very end (the claim deletion itself) also rolls everything back.
  const lateFailure = scriptedPool((sql) => (sql.startsWith('SELECT mobile') ? { rows: [CLAIM_ROW] } : sql.startsWith('SELECT ac.user_id') ? { rows: [] } : sql.startsWith('DELETE FROM student_registration_claims') ? { rowCount: 0 } : { rowCount: 1, rows: [{ id: 'x' }] }));
  await assert.rejects(storeModule.createPostgresStudentRegistrationStore(lateFailure.pool).completeRegistration(completion()), /claim disappeared/);
  assert.equal(lateFailure.log.at(-1)!.sql, 'ROLLBACK');
});

test('AUTH C1 PostgreSQL store: capture takes the same mobile lock after its own challenge and refuses against a mobile-first account', async () => {
  const storeModule = await import('./authVerificationStore.js');
  const input = { challengeId: 'ch-2', userId: 'legacy-1', destination: '+919876543410', sessionTokenHash: 'h', sessionExpiresAt: new Date(Date.now() + 1000), now: new Date(), mobileFirstLoginId: 'M-OWNER' };
  const refused = scriptedPool((sql) => (sql.startsWith('SELECT id FROM users') ? { rows: [{ id: 'mobile-first' }] } : { rowCount: 1, rows: [{ id: 'ch-2' }] }));
  assert.equal(await storeModule.createPostgresAuthVerificationStore(refused.pool).completeStudentVerification(input), 'mobile_in_use');
  assert.ok(refused.log[1].sql.startsWith('UPDATE verification_challenges SET consumed_at'));
  assert.deepEqual([refused.log[2].sql, refused.log[2].values], ['SELECT pg_advisory_xact_lock($1::bigint)', [storeModule.studentMobileLockKey('+919876543410')]]);
  assert.match(refused.log[3].sql, /login_id = \$1 AND role = 'candidate' AND id <> \$2/);
  assert.ok(!refused.log.some(({ sql }) => /INSERT INTO (account_contacts|auth_sessions)/.test(sql)));
  assert.equal(refused.log.at(-1)!.sql, 'COMMIT', 'the challenge stays consumed');
  // A Student login (no capture) takes the lock but never runs the mobile-first check.
  const login = scriptedPool(() => ({ rowCount: 1, rows: [{ id: 'ch-2' }] }));
  assert.equal(await storeModule.createPostgresAuthVerificationStore(login.pool).completeStudentVerification({ ...input, mobileFirstLoginId: undefined }), true);
  assert.ok(login.log.some(({ sql }) => sql.startsWith('SELECT pg_advisory_xact_lock')));
  assert.ok(!login.log.some(({ sql }) => sql.startsWith('SELECT id FROM users')));
});

test('AUTH C1 PostgreSQL store: cleanup is bounded to expired or consumed claims without a live challenge; SMS reservations are serialized', async () => {
  const storeModule = await import('./authVerificationStore.js');
  const cleanup = scriptedPool(() => ({ rowCount: 3 }));
  assert.equal(await storeModule.createPostgresStudentRegistrationStore(cleanup.pool).deleteExpiredClaims(new Date(), 50), 3);
  const sql = cleanup.log[1].sql;
  assert.match(sql, /^DELETE FROM student_registration_claims WHERE id IN \( SELECT c\.id FROM student_registration_claims c/);
  assert.match(sql, /WHERE \(c\.consumed_at IS NOT NULL OR c\.expires_at <= \$1\)/, 'expired or consumed (refused) claims');
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM verification_challenges v WHERE v\.registration_claim_id = c\.id AND v\.consumed_at IS NULL AND v\.expires_at > \$1\)/);
  assert.match(sql, /LIMIT \$2 FOR UPDATE SKIP LOCKED\)$/);
  assert.equal(cleanup.log[1].values[1], 50);

  const base = { reservationId: 'res-1', destinationKey: 'a'.repeat(32), purpose: 'student_registration' as const, destinationWindowMs: 3600_000, destinationMaxSends: 2, dailyMaxSends: 10, dailyMaxUnverifiedSends: 6 };
  for (const [bucket, total, unverified, recent, expected, reason] of [
    ['unverified', 0, 0, 0, 'reserved', null],
    ['verified', 0, 0, 0, 'reserved', null],
    ['unverified', 10, 0, 0, 'daily_limited', 'daily_limit'],
    ['verified', 10, 0, 0, 'daily_limited', 'daily_limit'],
    ['unverified', 6, 6, 0, 'unverified_daily_limited', 'unverified_daily_limit'],
    ['verified', 6, 6, 0, 'reserved', null],
    ['unverified', 3, 3, 2, 'destination_limited', 'destination_limit'],
    ['verified', 3, 0, 2, 'destination_limited', 'destination_limit'],
    ['account', 6, 6, 0, 'reserved', null],
    ['account', 10, 6, 0, 'daily_limited', 'daily_limit'],
    ['account', 3, 0, 2, 'destination_limited', 'destination_limit'],
  ] as const) {
    const reservation = scriptedPool((statement) => (statement.includes('AS total') ? { rows: [{ total, unverified }] } : statement.includes('make_interval') ? { rows: [{ n: recent }] } : { rowCount: 1 }));
    assert.equal(await storeModule.createPostgresSmsSendGuardStore(reservation.pool).reserveSmsSend({ ...base, bucket }), expected, `${bucket} ${total}/${unverified}/${recent}`);
    assert.deepEqual([reservation.log[1].sql, reservation.log[1].values], ['SELECT pg_advisory_xact_lock($1::bigint)', [storeModule.SMS_SEND_RESERVATION_LOCK_KEY]], 'serialized first');
    assert.match(reservation.log[2].sql, /occurred_at > clock_timestamp\(\) - interval '24 hours'/, 'windows measured with clock_timestamp()');
    const destination = reservation.log.find(({ sql: s }) => s.includes('make_interval'));
    if (destination) {
      assert.match(destination.sql, /coalesce\(details->>'bucket', 'unverified'\) = \$2 AND occurred_at > clock_timestamp\(\) - make_interval/);
      assert.deepEqual(destination.values, [base.destinationKey, bucket, 3600]);
    }
    const recorded = reservation.log.filter(({ sql: s }) => s.startsWith('INSERT INTO auth_verification_events'));
    assert.equal(recorded.length, 1);
    assert.match(recorded[0].sql, /VALUES \(\$1, clock_timestamp\(\), \$2, NULL, \$3::jsonb\)/, 'event time is clock_timestamp()');
    const details = JSON.parse(String(recorded[0].values[2]));
    if (expected === 'reserved') {
      assert.deepEqual([recorded[0].values[0], recorded[0].values[1]], ['res-1', 'sms.send_reserved'], 'the reservation id is the event id');
      assert.deepEqual(details, { destinationKey: base.destinationKey, bucket, purpose: base.purpose, reservationId: 'res-1' });
    } else {
      assert.equal(recorded[0].values[1], 'sms.send_refused');
      assert.deepEqual(details, { reason, bucket, purpose: base.purpose, reservationId: 'res-1' }, 'refusals carry no destination');
    }
  }
  const usage = scriptedPool(() => ({ rows: [{ total: 7, unverified: 4 }] }));
  assert.deepEqual(await storeModule.createPostgresSmsSendGuardStore(usage.pool).smsUsageLast24h(), { total: 7, unverified: 4 });
  assert.equal(usage.log.length, 1, 'advisory usage takes no lock and no transaction');
  assert.match(usage.log[0].sql, /coalesce\(details->>'bucket', 'unverified'\) = 'unverified'/, 'C1 reservations without a bucket count as unverified; account sends never do');
  const destinationUsage = scriptedPool(() => ({ rows: [{ n: 2 }] }));
  assert.equal(await storeModule.createPostgresSmsSendGuardStore(destinationUsage.pool).smsDestinationUsage({ destinationKey: 'b'.repeat(32), bucket: 'unverified', windowMs: 1800_000 }), 2);
  assert.equal(destinationUsage.log.length, 1, 'advisory: one read, no lock, no transaction');
  assert.deepEqual(destinationUsage.log[0].values, ['b'.repeat(32), 'unverified', 1800]);
  assert.match(destinationUsage.log[0].sql, /details->>'destinationKey' = \$1 AND coalesce\(details->>'bucket', 'unverified'\) = \$2 AND occurred_at > clock_timestamp\(\) - make_interval\(secs => \$3\)/);
  assert.notEqual(storeModule.SMS_SEND_RESERVATION_LOCK_KEY, '7342519086', 'distinct from the migration lock');
  assert.notEqual(storeModule.studentMobileLockKey('+919876543400'), storeModule.studentMobileLockKey('+919876543401'));
});

// ---------------------------------------------------------------------------
// AUTH C1.4-A: adapter contract hardening (request objects, correlation, categories, restricted config)
// Local test doubles and temporary TEST-ONLY fixture files only: no vendor, no network, no real secret.
// ---------------------------------------------------------------------------

async function withFixtureFiles(files: Record<string, string>, work: (paths: Record<string, string>) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'eltnoy-c14a-fixtures-'));
  try {
    const paths: Record<string, string> = {};
    for (const [name, contents] of Object.entries(files)) {
      paths[name] = join(directory, name);
      await writeFile(paths[name], contents, { mode: 0o600 });
    }
    await work(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const FIXTURE_OTP_KEY = 'test-only-c14a-otp-key-fixture-0123456789abcdef';
const FIXTURE_API_KEY = 'test-only-c14a-api-key-fixture-ZYXW';

test('C1.4-A T1/T2: registered SMS and email adapters receive ONLY their declared settings and secret contents', async () => {
  await withFixtureFiles({ otp: FIXTURE_OTP_KEY, smsKey: FIXTURE_API_KEY, emailKey: `${FIXTURE_API_KEY}-email` }, (paths) => {
    const received: Record<string, unknown> = {};
    providers.registerSmsProviderAdapter('c14a-test-sms', {
      settings: ['C14A_SMS_SENDER'],
      secretFiles: { apiKey: { env: 'C14A_SMS_API_KEY_FILE', minBytes: 16 } },
      create: (config) => { received.sms = config; return new RecordingSmsProvider(); },
    });
    providers.registerEmailProviderAdapter('c14a-test-email', {
      settings: ['C14A_EMAIL_FROM_ADDRESS'],
      secretFiles: { apiKey: { env: 'C14A_EMAIL_API_KEY_FILE', minBytes: 16 } },
      create: (config) => { received.email = config; return new RecordingEmailProvider(); },
    });
    const env = {
      AUTH_SMS_PROVIDER: 'c14a-test-sms', AUTH_EMAIL_PROVIDER: 'c14a-test-email', AUTH_OTP_HMAC_KEY_FILE: paths.otp,
      C14A_SMS_SENDER: 'TESTSENDER', C14A_SMS_API_KEY_FILE: paths.smsKey,
      C14A_EMAIL_FROM_ADDRESS: 'noreply@example.test', C14A_EMAIL_API_KEY_FILE: paths.emailKey,
      UNRELATED_SETTING: 'must-not-reach-the-adapter', DATABASE_URL: 'postgresql://must-not-reach@host/db',
    };
    const services = providers.resolveVerificationServices(env);
    assert.ok(services.sms && services.email, 'both channels available');
    assert.deepEqual([services.reasons.sms, services.reasons.email], [null, null]);
    const sms = received.sms as { settings: Record<string, string>; secrets: Record<string, Buffer> };
    const email = received.email as { settings: Record<string, string>; secrets: Record<string, Buffer> };
    assert.deepEqual(Object.keys(sms).sort(), ['secrets', 'settings']);
    assert.deepEqual(sms.settings, { C14A_SMS_SENDER: 'TESTSENDER' }, 'only the declared setting');
    assert.deepEqual(Object.keys(sms.secrets), ['apiKey']);
    assert.ok(Buffer.isBuffer(sms.secrets.apiKey) && sms.secrets.apiKey.toString('utf8') === FIXTURE_API_KEY, 'secret contents as a Buffer');
    assert.deepEqual(email.settings, { C14A_EMAIL_FROM_ADDRESS: 'noreply@example.test' });
    const handed = JSON.stringify({ settings: [sms.settings, email.settings] });
    for (const leaked of [paths.smsKey, paths.emailKey, paths.otp, 'must-not-reach', 'DATABASE_URL']) assert.ok(!handed.includes(leaked), `the adapter never sees ${leaked}`);
  });
});

test('C1.4-A T3/T4/T5/T5b: unknown name, throwing factory, missing OTP key and bad declarations fail closed with fixed reasons', async () => {
  await withFixtureFiles({ otp: FIXTURE_OTP_KEY, shortOtp: 'short', key: FIXTURE_API_KEY, shortKey: 'tiny' }, (paths) => {
    const create = () => new RecordingSmsProvider();
    const resolve = (name: string, extra: Record<string, string> = {}) => providers.resolveVerificationServices({ AUTH_SMS_PROVIDER: name, AUTH_OTP_HMAC_KEY_FILE: paths.otp, ...extra });
    // T3 unknown provider.
    const unknown = resolve('c14a-not-registered');
    assert.equal(unknown.sms, null);
    assert.match(unknown.reasons.sms ?? '', /no approved integration/);
    // T4 factory throws: its raw message never surfaces.
    providers.registerSmsProviderAdapter('c14a-throws', { create: () => { throw new Error(`boom ${FIXTURE_API_KEY} ${paths.key}`); } });
    const thrown = resolve('c14a-throws');
    assert.equal(thrown.sms, null);
    assert.equal(thrown.reasons.sms, 'The SMS provider configuration is incomplete or invalid.');
    // T5 missing or short OTP key.
    providers.registerSmsProviderAdapter('c14a-ok', { create });
    for (const otp of [undefined, paths.shortOtp, 'relative/path', '/nonexistent/c14a/otp']) {
      const result = providers.resolveVerificationServices({ AUTH_SMS_PROVIDER: 'c14a-ok', ...(otp ? { AUTH_OTP_HMAC_KEY_FILE: otp } : {}) });
      assert.equal(result.sms, null, String(otp));
      assert.match(result.reasons.sms ?? '', /needs AUTH_OTP_HMAC_KEY_FILE/);
    }
    assert.ok(resolve('c14a-ok').sms, 'control: a valid key enables it');
    // T5b bad declarations.
    const badDeclarations: Array<[string, Parameters<typeof providers.registerSmsProviderAdapter>[1]]> = [
      ['secret without _FILE', { secretFiles: { apiKey: { env: 'C14A_API_KEY', minBytes: 4 } }, create }],
      ['credential-like setting KEY', { settings: ['C14A_API_KEY'], create }],
      ['credential-like setting SECRET', { settings: ['C14A_CLIENT_SECRET'], create }],
      ['credential-like setting TOKEN', { settings: ['TOKEN'], create }],
      ['credential-like setting PASSWORD', { settings: ['C14A_PASSWORD_HINT'], create }],
      ['plain setting ending _FILE', { settings: ['C14A_TEMPLATE_FILE'], create }],
      ['duplicate names', { settings: ['C14A_SENDER'], secretFiles: { a: { env: 'C14A_A_FILE', minBytes: 1 }, b: { env: 'C14A_A_FILE', minBytes: 1 } }, create }],
      ['non-positive minBytes', { secretFiles: { apiKey: { env: 'C14A_API_KEY_FILE', minBytes: 0 } }, create }],
      ['lower-case name', { settings: ['c14a_sender'], create }],
    ];
    for (const [label, registration] of badDeclarations) {
      const name = `c14a-bad-${label.replace(/\W+/g, '-')}`;
      providers.registerSmsProviderAdapter(name, registration);
      const result = resolve(name, { C14A_API_KEY: 'x', C14A_CLIENT_SECRET: 'x', TOKEN: 'x', C14A_PASSWORD_HINT: 'x', C14A_TEMPLATE_FILE: '/x', C14A_SENDER: 'x', C14A_A_FILE: paths.key, C14A_API_KEY_FILE: paths.key, c14a_sender: 'x' });
      assert.equal(result.sms, null, label);
      assert.equal(result.reasons.sms, 'The SMS provider integration declares its configuration incorrectly.', label);
    }
    // Boundary-aware: words merely containing KEY/TOKEN are ordinary settings.
    providers.registerSmsProviderAdapter('c14a-boundary', { settings: ['C14A_MONKEY_MODE', 'C14A_TOKENISER_LANGUAGE'], create });
    assert.ok(resolve('c14a-boundary', { C14A_MONKEY_MODE: 'on', C14A_TOKENISER_LANGUAGE: 'en' }).sms, 'MONKEY / TOKENISER are not credential words');
    // Missing setting, missing / short / relative secret file: fail closed.
    providers.registerSmsProviderAdapter('c14a-secret', { settings: ['C14A_SENDER'], secretFiles: { apiKey: { env: 'C14A_API_KEY_FILE', minBytes: 16 } }, create });
    for (const [label, extra] of [
      ['missing setting', { C14A_API_KEY_FILE: paths.key }],
      ['missing secret file', { C14A_SENDER: 'S' }],
      ['undersized secret', { C14A_SENDER: 'S', C14A_API_KEY_FILE: paths.shortKey }],
      ['relative secret path', { C14A_SENDER: 'S', C14A_API_KEY_FILE: 'secrets/key' }],
      ['nonexistent secret', { C14A_SENDER: 'S', C14A_API_KEY_FILE: '/nonexistent/c14a/key' }],
    ] as const) {
      const result = resolve('c14a-secret', extra);
      assert.equal(result.sms, null, label);
      assert.equal(result.reasons.sms, 'The SMS provider configuration is incomplete or invalid.', label);
    }
    assert.ok(resolve('c14a-secret', { C14A_SENDER: 'S', C14A_API_KEY_FILE: paths.key }).sms, 'control: complete configuration');
    // T13 (resolution part): no reason ever carries a path, secret contents or a thrown message.
    const reasons = JSON.stringify([unknown.reasons, thrown.reasons, resolve('c14a-secret', { C14A_SENDER: 'S', C14A_API_KEY_FILE: paths.shortKey }).reasons]);
    for (const leaked of [paths.key, paths.otp, paths.shortKey, FIXTURE_API_KEY, FIXTURE_OTP_KEY, 'boom']) assert.ok(!reasons.includes(leaked), `reason never contains ${leaked}`);
  });
});

test('C1.4-A T6/T7/T8: abort handling: honoured, ignored, and a retry after abort is detected by the contract kit', async () => {
  for (const behaviour of ['honours-abort', 'ignores-abort', 'retry-after-abort'] as const) {
    const adapter = new ContractTestAdapter(behaviour);
    const h = await deliveryHarness(adapter, 40);
    try {
      const started = Date.now();
      const result = await h.capture();
      assert.ok(Date.now() - started < 5_000, `${behaviour}: the core deadline ends the request`);
      assert.deepEqual([result.status, result.body.code], [503, 'PROVIDER_DELIVERY_FAILED'], behaviour);
      assert.ok(h.store.challenges.get(h.id)!.consumedAt, `${behaviour}: the challenge is invalidated`);
      const failure = h.store.events.find((event) => event.action === 'verification.delivery_failed')!;
      assert.equal(failure.details?.failure, 'timeout', `${behaviour}: deadline/abort is always 'timeout'`);
      assert.equal(adapter.requests[0].signal.aborted, true);
      assert.equal(adapter.vendorCallsAfterAbort(), behaviour === 'retry-after-abort' ? 1 : 0, `${behaviour}: retry-after-abort detection`);
    } finally {
      adapter.releaseLate();
      await h.close();
    }
  }
});

test('C1.4-A T9: a code the vendor delivers late (after the deadline) can never verify the invalidated challenge', async () => {
  const adapter = new ContractTestAdapter('resolve-late');
  const h = await deliveryHarness(adapter, 40);
  try {
    const result = await h.capture();
    assert.deepEqual([result.status, result.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    adapter.releaseLate(); // the vendor "delivers" now
    await new Promise((resolve) => setImmediate(resolve));
    const lateCode = adapter.vendorCalls[0].code;
    assert.match(lateCode, /^[0-9]{6}$/);
    assert.ok(h.store.challenges.get(h.id)!.consumedAt, 'still invalidated after the late success');
    assert.ok(!h.store.events.some((event) => event.action === 'verification.code_sent'), 'a late success is never recorded as sent');
    const verifyResult = await h.verify(lateCode);
    assert.deepEqual([verifyResult.status, verifyResult.body.code], [401, 'NO_VERIFICATION_IN_PROGRESS'], 'the late code is unusable');
    assert.equal(h.store.sessions.length, 0, 'no session');
  } finally {
    await h.close();
  }
});

test('C1.4-A T10/T11: SMS correlationId is the reservation id; email correlationIds are unique per send; both appear in the events', async () => {
  const f = await setup({ studentMobile: '+919876543800', institute: { status: 'approved', verification: { mobileDestination: '+919876500080', mobileVerifiedAt: new Date(), emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null } } });
  try {
    // SMS: sign-in, then a resend (a new attempt: new reservation, new code, new id).
    const login = await studentLogin(f);
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'exam', cookie: verificationCookie(login) });
    const smsIds = f.sms.sent.map((entry) => entry.correlationId);
    assert.deepEqual(smsIds, f.smsGuard.reservations.map((r) => r.reservationId), 'SMS correlationId === reservation id');
    assert.equal(new Set(smsIds).size, smsIds.length);
    const smsEvents = f.store.events.filter((e) => e.action === 'verification.code_sent' && e.details?.channel === 'sms').map((e) => e.details!.correlationId);
    assert.deepEqual(smsEvents, smsIds);
    // Email: the Institute's mobile is verified, so sign-in sends the email code; then a resend.
    const institute = await instituteLogin(f);
    assert.equal(institute.body.channel, 'email');
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie: verificationCookie(institute) });
    const emailIds = f.email.sent.map((entry) => entry.correlationId);
    assert.equal(emailIds.length, 2);
    assert.equal(new Set(emailIds).size, 2, 'unique per send');
    for (const id of emailIds) assert.match(id, /^[0-9a-f-]{36}$/);
    assert.ok(emailIds.every((id) => !smsIds.includes(id)));
    assert.equal(f.smsGuard.reservations.length, smsIds.length, 'email sends make no SMS reservation');
    const emailEvents = f.store.events.filter((e) => e.action === 'verification.code_sent' && e.details?.channel === 'email').map((e) => e.details!.correlationId);
    assert.deepEqual(emailEvents, emailIds);
    assert.deepEqual(f.emailGuard.reservations.map((r) => r.reservationId), emailIds, 'C1.4-B-1: email correlationId === email reservation id');
  } finally {
    await f.close();
  }
});

test('C1.4-A T12/T13: failure categories are fixed; anything else is unknown; no code, destination or error text is recorded', async () => {
  const cases: Array<[unknown, string]> = [
    ...(['throttled', 'rejected_destination', 'authentication', 'provider_unavailable', 'timeout', 'unknown'] as const).map((category) => [new providers.ProviderDeliveryError(category), category] as [unknown, string]),
    [new Error(`vendor said: number ${'+919876543299'} rejected, key ${FIXTURE_API_KEY}`), 'unknown'],
    [new providers.ProviderDeliveryError('bogus' as never), 'unknown'],
    ['a thrown string with +919876543299', 'unknown'],
    [{ category: 'throttled' }, 'unknown'],
    [undefined, 'unknown'],
  ];
  assert.deepEqual([...providers.PROVIDER_FAILURE_CATEGORIES], ['timeout', 'throttled', 'rejected_destination', 'authentication', 'provider_unavailable', 'unknown']);
  for (const [thrown, expected] of cases) {
    assert.equal(providers.classifyProviderFailure(thrown, false), expected, String(expected));
    assert.equal(providers.classifyProviderFailure(thrown, true), 'timeout', 'a fired deadline always wins');
    const adapter = new ContractTestAdapter('throw', thrown);
    const h = await deliveryHarness(adapter, 1_000);
    try {
      const result = await h.capture();
      assert.deepEqual([result.status, result.body.code, result.body.error], [503, 'PROVIDER_DELIVERY_FAILED', 'The verification code could not be delivered. Please try again later.'], 'the user response is unchanged and generic');
      const failure = h.store.events.find((event) => event.action === 'verification.delivery_failed')!;
      assert.deepEqual(Object.keys(failure.details ?? {}).sort(), ['channel', 'correlationId', 'failure']);
      assert.equal(failure.details?.failure, expected);
      assert.equal(failure.details?.correlationId, adapter.requests[0].correlationId);
      const recorded = JSON.stringify([h.store.events, result.body]);
      for (const leaked of [adapter.vendorCalls[0].code, '9876543299', 'vendor said', FIXTURE_API_KEY, 'bogus', 'a thrown string']) assert.ok(!recorded.includes(leaked), `${expected}: never records ${leaked}`);
    } finally {
      await h.close();
    }
  }
});

test('C1.4-A T14: exactly one adapter invocation per delivery attempt, also under concurrent requests', async () => {
  const adapter = new ContractTestAdapter('success');
  const h = await deliveryHarness(adapter);
  try {
    const results = await Promise.all([h.capture(), h.capture(), h.capture()]);
    assert.equal(results.filter((result) => result.status === 200).length, 1, 'one capture wins');
    assert.equal(adapter.requests.length, 1, 'one adapter call');
    assert.equal(adapter.vendorCalls.length, 1, 'one vendor call');
    const sent = h.store.events.filter((event) => event.action === 'verification.code_sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details?.correlationId, adapter.requests[0].correlationId);
  } finally {
    await h.close();
  }
});

test('C1.4-A T15 (static): deliverCode is the only caller of both adapter methods; production never imports the contract kit', async () => {
  const source = await readFile(new URL('./authVerification.ts', import.meta.url), 'utf8');
  for (const method of ['.sendOtp(', '.sendVerificationCode(']) assert.equal(source.split(method).length - 1, 1, `${method} is called exactly once`);
  const deliver = source.slice(source.indexOf('async function deliverCode('), source.indexOf('export async function startVerification('));
  assert.ok(deliver.includes('.sendOtp(request)') && deliver.includes('.sendVerificationCode(request)'), 'both calls use the request object inside deliverCode');
  for (const name of (await readdir(new URL('.', import.meta.url))).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !/TestStores|TestHarness|TestSupport/.test(file))) {
    assert.doesNotMatch(await readFile(new URL(`./${name}`, import.meta.url), 'utf8'), /ContractTestAdapter|authTestSupport/, `${name} never imports the contract kit`);
  }
  const providerSource = await readFile(new URL('./verificationProviders.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(providerSource, /create\(env\)|factory\(env\)/, 'adapters never receive the environment');
});

// ---------------------------------------------------------------------------
// AUTH C1.4-B-1: email abuse protection (two buckets, six settings). Local doubles and the in-memory
// email guard only: atomicity under real PostgreSQL concurrency is NOT proven here (C1.4-B-3 pending).
// ---------------------------------------------------------------------------

const EMAIL_VALID = {
  AUTH_EMAIL_UNVERIFIED_DESTINATION_WINDOW_SECONDS: '3631', AUTH_EMAIL_UNVERIFIED_DESTINATION_MAX_SENDS: '31',
  AUTH_EMAIL_ACCOUNT_DESTINATION_WINDOW_SECONDS: '7231', AUTH_EMAIL_ACCOUNT_DESTINATION_MAX_SENDS: '41',
  AUTH_EMAIL_DAILY_MAX_SENDS: '531', AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS: '331',
};
const approvedInstitute = (emailDestination: string) => ({ status: 'approved', verification: { mobileDestination: '+919876500090', mobileVerifiedAt: new Date(), emailDestination, emailVerifiedAt: null, institutionalStatus: 'pending' as const, suspendedAt: null } });

/** An institute_email challenge for an account (as after mobile verification), driven through the resend route. */
async function emailChallenge(f: Fixture, userId: string, destination: string) {
  const token = randomBytes(32).toString('base64url');
  const id = createHash('sha256').update(token).digest('hex');
  await f.store.createChallenge({ id, purpose: 'institute_email', userId, channel: 'email', destination, expiresAt: new Date(Date.now() + 10 * 60_000) }, { action: 'verification.started', userId });
  const cookie = `elt_verification=${token}`;
  return { id, cookie, send: () => call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie }) };
}
const addInstitute = (f: Fixture, id: string, accountStatus: string, emailDestination: string) => {
  f.store.users.set(id, { id, loginId: id.toUpperCase(), role: 'center', accountStatus, contactEmail: emailDestination });
  f.store.institutes.set(id, { mobileDestination: '+919876500091', mobileVerifiedAt: new Date(), emailDestination, emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null });
};

test('C1.4-B-1 config (13/14/15): the six email settings are one all-or-nothing group, independent of SMS, with no defaults', () => {
  const unset = verification.resolveEmailProtection({});
  assert.equal(unset.email, null, 'missing: every email refused');
  assert.deepEqual(Object.values(verification.emailProtectionReadiness(verification.resolveAbuseProtection({})).emailSettings), Array(6).fill('missing'));
  assert.deepEqual(verification.resolveEmailProtection(EMAIL_VALID).email, {
    unverified: { windowMs: 3_631_000, maxSends: 31 }, account: { windowMs: 7_231_000, maxSends: 41 }, dailyMaxSends: 531, dailyMaxUnverifiedSends: 331,
  });
  for (const name of Object.keys(EMAIL_VALID)) {
    const partial = { ...EMAIL_VALID } as Record<string, string>;
    delete partial[name];
    assert.equal(verification.resolveEmailProtection(partial).email, null, `partial without ${name}`);
    for (const bad of ['', '0', '-1', '1.5', 'ten', '1e3']) {
      const result = verification.resolveEmailProtection({ ...EMAIL_VALID, [name]: bad });
      assert.equal(result.email, null, `${name}=${bad}`);
      assert.equal(result.emailSettings?.[name], bad === '' ? 'missing' : 'invalid');
    }
  }
  const inconsistent = verification.resolveEmailProtection({ ...EMAIL_VALID, AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS: '532' });
  assert.deepEqual([inconsistent.email, inconsistent.emailSettings?.AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS], [null, 'inconsistent']);
  assert.ok(verification.resolveEmailProtection({ ...EMAIL_VALID, AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS: '531' }).email, 'equal to the total is allowed');
  // Independent groups: email never changes the SMS result, and the C1.3 SMS fields are unchanged.
  const smsOnly = verification.resolveAbuseProtection({ ...EMAIL_VALID });
  assert.equal(smsOnly.sms, null);
  assert.ok(smsOnly.email);
  assert.ok(!smsOnly.problems.some((problem) => problem.startsWith('AUTH_EMAIL_')), 'SMS problems never list email settings');
  assert.ok(!verification.SMS_PROTECTION_SETTING_NAMES.some((name) => name.startsWith('AUTH_EMAIL_')));
  const text = JSON.stringify([verification.emailProtectionReadiness(verification.resolveAbuseProtection(EMAIL_VALID)), inconsistent.emailSettings]);
  for (const value of Object.values(EMAIL_VALID)) assert.ok(!text.includes(value), `value ${value} is never reported`);
});

test('C1.4-B-1 bucket rule: account only for an APPROVED Institute\'s recorded address, re-evaluated per send; no email verified bucket', async () => {
  const f = await setup({ institute: approvedInstitute('office@example.test') });
  try {
    const rule = (input: Partial<Parameters<typeof verification.emailBucketFor>[0]>) => verification.emailBucketFor({ userId: 'institute-1', purpose: 'institute_email', destination: 'office@example.test', channel: 'email', ...input });
    assert.equal(await rule({}), 'account');
    assert.equal(await rule({ destination: 'other@example.test' }), 'unverified', 'mismatch');
    assert.equal(await rule({ userId: null }), 'unverified');
    assert.equal(await rule({ purpose: 'institute_mobile' }), 'unverified');
    assert.equal(await rule({ channel: 'sms' }), 'unverified');
    assert.equal(await rule({ userId: 'student-1' }), 'unverified', 'not an Institute');
    f.store.users.get('institute-1')!.accountStatus = 'pending';
    assert.equal(await rule({}), 'unverified', 'pending: anonymous, even with a stored address');
    f.store.users.get('institute-1')!.accountStatus = 'approved';
    f.store.institutes.get('institute-1')!.emailDestination = 'changed@example.test';
    assert.equal(await rule({}), 'unverified', 'fresh data: recorded address changed');
  } finally {
    await f.close();
  }
});

test('C1.4-B-1 (1/5/7): the anonymous per-address limit is shared across pending Institutes and counted per address', async () => {
  const f = await setup({ protection: testAbuseProtection({}, undefined, { unverified: { windowMs: 3600_000, maxSends: 2 } }) });
  try {
    addInstitute(f, 'pending-a', 'pending', 'victim@example.test');
    addInstitute(f, 'pending-b', 'pending', 'victim@example.test');
    const a = await emailChallenge(f, 'pending-a', 'victim@example.test');
    const b = await emailChallenge(f, 'pending-b', 'victim@example.test');
    assert.equal((await a.send()).status, 200);
    assert.equal((await b.send()).status, 200, 'second pending Institute, same address');
    const third = await emailChallenge(f, 'pending-a', 'victim@example.test');
    const refused = await third.send();
    assert.deepEqual([refused.status, refused.body.code], [429, 'EMAIL_DESTINATION_LIMITED'], 'the address allowance is shared across accounts');
    // Different addresses for one account each have their own allowance (7).
    const other = await emailChallenge(f, 'pending-a', 'someone-else@example.test');
    assert.equal((await other.send()).status, 200);
    assert.deepEqual(f.emailGuard.reservations.map((r) => r.bucket), ['unverified', 'unverified', 'unverified']);
    assert.equal(f.email.sent.length, 3);
  } finally {
    await f.close();
  }
});

test('C1.4-B-1 (2/6): an approved Institute\'s own allowance is isolated from anonymous abuse of its address, and has its own limit', async () => {
  const f = await setup({ institute: approvedInstitute('office@example.test'), protection: testAbuseProtection({}, undefined, { unverified: { windowMs: 3600_000, maxSends: 1 }, account: { windowMs: 3600_000, maxSends: 2 } }) });
  try {
    addInstitute(f, 'pending-x', 'pending', 'office@example.test');
    const flood = await emailChallenge(f, 'pending-x', 'office@example.test');
    assert.equal((await flood.send()).status, 200);
    assert.equal((await flood.send()).status, 429, 'anonymous allowance of the address used up (cooldown aside)');
    const login = await instituteLogin(f);
    assert.deepEqual([login.status, login.body.channel], [202, 'email'], 'the approved Institute is not locked out');
    assert.equal(f.emailGuard.reservations.at(-1)!.bucket, 'account');
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    assert.equal((await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie: verificationCookie(login) })).status, 200);
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    const third = await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie: verificationCookie(login) });
    assert.deepEqual([third.status, third.body.code], [429, 'EMAIL_DESTINATION_LIMITED'], 'its own account limit applies');
    const accountKeys = new Set(f.emailGuard.reservations.filter((r) => r.bucket === 'account').map((r) => r.destinationKey));
    assert.equal(accountKeys.size, 1);
    assert.ok(![...accountKeys][0].includes('office'));
    assert.notEqual([...accountKeys][0], verification.emailDestinationKey(Buffer.alloc(32, 7), 'office@example.test'), 'account key is distinct from the per-address key');
  } finally {
    await f.close();
  }
});

test('C1.4-B-1 (3/4): the email total counts both buckets; the unverified cap leaves room for approved Institutes', async () => {
  const f = await setup({ institute: approvedInstitute('office@example.test'), protection: testAbuseProtection({}, undefined, { dailyMaxSends: 2, dailyMaxUnverifiedSends: 1 }) });
  try {
    addInstitute(f, 'pending-a', 'pending', 'a@example.test');
    assert.equal((await (await emailChallenge(f, 'pending-a', 'a@example.test')).send()).status, 200, 'unverified 1 of 1');
    const capped = await (await emailChallenge(f, 'pending-a', 'b@example.test')).send();
    assert.deepEqual([capped.status, capped.body.code], [503, 'EMAIL_DAILY_LIMIT_REACHED'], 'unverified cap');
    assert.equal((await instituteLogin(f)).status, 202, 'account send still allowed (total 2 of 2)');
    assert.deepEqual(await f.emailGuard.emailUsageLast24h(), { total: 2, unverified: 1 });
    // The email total is now used up: the next account send (a new sign-in) is refused at its send.
    const total = await instituteLogin(f);
    assert.deepEqual([total.status, total.body.code], [503, 'EMAIL_DAILY_LIMIT_REACHED']);
    assert.equal(f.email.sent.length, 2, 'the email total is never exceeded');
    assert.ok(f.emailGuard.refusals.some((r) => r.reason === 'daily_limit' && r.bucket === 'account'), 'account sends are bound by the total');
  } finally {
    await f.close();
  }
});

test('C1.4-B-1 (8): parallel sends to one address never exceed its allowance (in-memory guard; PostgreSQL pending)', async () => {
  const f = await setup({ protection: testAbuseProtection({}, undefined, { unverified: { windowMs: 3600_000, maxSends: 2 } }) });
  try {
    const challenges = [];
    for (let i = 0; i < 6; i += 1) {
      addInstitute(f, `pending-${i}`, 'pending', 'same@example.test');
      challenges.push(await emailChallenge(f, `pending-${i}`, 'same@example.test'));
    }
    const results = await Promise.all(challenges.map((challenge) => challenge.send()));
    assert.equal(results.filter((result) => result.status === 200).length, 2);
    assert.ok(results.filter((result) => result.status !== 200).every((result) => result.body.code === 'EMAIL_DESTINATION_LIMITED'));
    assert.equal(f.email.sent.length, 2);
  } finally {
    await f.close();
  }
});

/** An email challenge served by a router with a shortened (bounded) deadline and a scripted adapter. */
async function emailHarness(adapter: InstanceType<typeof ContractTestAdapter>, deliveryTimeoutMs: number, protection = testAbuseProtection()) {
  const store = new MemoryAuthVerificationStore();
  const guard = new MemoryEmailGuardStore();
  providers.configureVerificationServices(testServices({ sms: new RecordingSmsProvider(), email: adapter }));
  verification.configureAuthVerificationStore(store);
  verification.configureEmailSendGuardStore(guard);
  verification.configureAbuseProtection(protection);
  store.users.set('pending-1', { id: 'pending-1', loginId: 'PENDING-1', role: 'center', accountStatus: 'pending', contactEmail: 'pending@example.test' });
  const server = await startHarness([verification.createAuthVerificationRouter({ deliveryTimeoutMs })]);
  const token = randomBytes(32).toString('base64url');
  const id = createHash('sha256').update(token).digest('hex');
  await store.createChallenge({ id, purpose: 'institute_email', userId: 'pending-1', channel: 'email', destination: 'pending@example.test', expiresAt: new Date(Date.now() + 10 * 60_000) }, { action: 'verification.started', userId: 'pending-1' });
  const cookie = `elt_verification=${token}`;
  return {
    store, guard, id,
    send: () => call(server.url, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie }),
    verify: (code: string) => call(server.url, 'POST', '/api/auth/verification/verify', { surface: 'institution', cookie, body: { code } }),
    close: async () => { adapter.releaseLate(); await server.close(); providers.configureVerificationServices(providers.DISABLED_SERVICES); verification.configureAbuseProtection(undefined); },
  };
}

test('C1.4-B-1 (9/10/11/12): failures and timeouts count; correlationId is the reservation id; the challenge is invalidated; a late code is useless', async () => {
  // Provider failure.
  const failing = new ContractTestAdapter('throw', new providers.ProviderDeliveryError('rejected_destination'));
  const h = await emailHarness(failing, 1_000, testAbuseProtection({}, undefined, { unverified: { windowMs: 3600_000, maxSends: 1 } }));
  try {
    const failed = await h.send();
    assert.deepEqual([failed.status, failed.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    assert.equal(h.guard.reservations.length, 1, 'the failed send still counts');
    assert.equal(failing.requests[0].correlationId, h.guard.reservations[0].reservationId, 'correlationId === email reservation id');
    const event = h.store.events.find((e) => e.action === 'verification.delivery_failed')!;
    assert.deepEqual(event.details, { channel: 'email', correlationId: h.guard.reservations[0].reservationId, failure: 'rejected_destination' });
    assert.ok(h.store.challenges.get(h.id)!.consumedAt, 'the challenge is invalidated');
  } finally {
    await h.close();
  }
  // Timeout, then a late vendor delivery: the late code cannot establish a session.
  const late = new ContractTestAdapter('resolve-late');
  const t = await emailHarness(late, 40);
  try {
    const timedOut = await t.send();
    assert.deepEqual([timedOut.status, timedOut.body.code], [503, 'PROVIDER_DELIVERY_FAILED']);
    assert.equal(t.store.events.find((e) => e.action === 'verification.delivery_failed')!.details?.failure, 'timeout');
    assert.equal(t.guard.reservations.length, 1, 'the timed-out send counts');
    late.releaseLate();
    await new Promise((resolve) => setImmediate(resolve));
    const verified = await t.verify(late.vendorCalls[0].code);
    assert.deepEqual([verified.status, verified.body.code], [401, 'NO_VERIFICATION_IN_PROGRESS']);
    assert.equal(t.store.sessions.length, 0, 'no session');
    assert.ok(!t.store.events.some((e) => e.action === 'verification.code_sent'));
  } finally {
    await t.close();
  }
});

test('C1.4-B-1 (13/17): without email limits every email is refused, and Institute sign-in closes before any lookup with one answer for every credential', async () => {
  const f = await setup({ institute: approvedInstitute('office@example.test'), protection: { ...testAbuseProtection(), email: null } });
  try {
    const answers = [
      await instituteLogin(f),
      await call(f.base, 'POST', '/api/auth/login', { surface: 'institution', body: { loginId: 'institute-1', password: 'Wrong-password-2026', role: 'center' } }),
      await call(f.base, 'POST', '/api/auth/login', { surface: 'institution', body: { loginId: 'nobody', password: INSTITUTE_PASSWORD, role: 'center' } }),
    ];
    for (const result of answers) assert.deepEqual([result.status, result.body.code], [503, 'EMAIL_PROTECTION_NOT_CONFIGURED']);
    assert.equal(new Set(answers.map((result) => JSON.stringify(result.body))).size, 1, 'indistinguishable');
    assert.equal(f.lookups, 0, 'no account lookup');
    // A challenge started earlier cannot send either.
    addInstitute(f, 'pending-a', 'pending', 'a@example.test');
    const refused = await (await emailChallenge(f, 'pending-a', 'a@example.test')).send();
    assert.deepEqual([refused.status, refused.body.code], [503, 'EMAIL_PROTECTION_NOT_CONFIGURED']);
    assert.equal(f.email.sent.length + f.emailGuard.reservations.length, 0);
    // SMS flows are unaffected by the email group.
    f.store.contacts.set('student-1:sms', '+919876543810');
    assert.equal((await studentLogin(f)).status, 202);
  } finally {
    await f.close();
  }
});

test('C1.4-B-1 (18): no raw email address or verification code in reservations, refusals or events', async () => {
  const f = await setup({ institute: approvedInstitute('private.person@example.test'), protection: testAbuseProtection({}, undefined, { account: { windowMs: 3600_000, maxSends: 1 } }) });
  try {
    const login = await instituteLogin(f);
    [...f.store.challenges.values()].at(-1)!.lastSentAt = new Date(Date.now() - 2 * 60 * 1000);
    await call(f.base, 'POST', '/api/auth/verification/resend', { surface: 'institution', cookie: verificationCookie(login) }); // refused (account limit)
    const recorded = JSON.stringify([f.emailGuard.reservations, f.emailGuard.refusals, f.store.events]);
    for (const secret of ['private.person', 'example.test', ...f.email.sent.map((entry) => entry.code)]) assert.ok(!recorded.includes(secret), `never records ${secret}`);
    assert.ok(f.emailGuard.reservations.every((r) => /^[0-9a-f]{32}$/.test(r.destinationKey)));
    assert.equal(f.emailGuard.refusals.length, 1);
  } finally {
    await f.close();
  }
});

test('C1.4-B-1 PostgreSQL store statements: own lock and actions; SMS statements unchanged (scripted client, no database)', async () => {
  const storeModule = await import('./authVerificationStore.js');
  const base = { reservationId: 'em-1', destinationKey: 'e'.repeat(32), purpose: 'institute_email' as const, destinationWindowMs: 3600_000, destinationMaxSends: 2, dailyMaxSends: 10, dailyMaxUnverifiedSends: 6 };
  for (const [bucket, total, unverified, recent, expected] of [
    ['unverified', 0, 0, 0, 'reserved'], ['account', 6, 6, 0, 'reserved'], ['unverified', 6, 6, 0, 'unverified_daily_limited'],
    ['account', 10, 0, 0, 'daily_limited'], ['unverified', 3, 3, 2, 'destination_limited'],
  ] as const) {
    const reservation = scriptedPool((statement) => (statement.includes('AS total') ? { rows: [{ total, unverified }] } : statement.includes('make_interval') ? { rows: [{ n: recent }] } : { rowCount: 1 }));
    assert.equal(await storeModule.createPostgresEmailSendGuardStore(reservation.pool).reserveEmailSend({ ...base, bucket }), expected);
    assert.deepEqual(reservation.log[1].values, [storeModule.EMAIL_SEND_RESERVATION_LOCK_KEY], 'email lock first');
    assert.match(reservation.log[2].sql, /WHERE action = 'email\.send_reserved' AND occurred_at > clock_timestamp\(\) - interval '24 hours'/);
    const recorded = reservation.log.find(({ sql }) => sql.startsWith('INSERT INTO auth_verification_events'))!;
    assert.equal(recorded.values[1], expected === 'reserved' ? 'email.send_reserved' : 'email.send_refused');
    if (expected === 'reserved') assert.equal(recorded.values[0], 'em-1');
  }
  assert.notEqual(storeModule.EMAIL_SEND_RESERVATION_LOCK_KEY, storeModule.SMS_SEND_RESERVATION_LOCK_KEY, 'independent of the SMS lock');
  // SMS statements are byte-for-byte unchanged.
  const sms = scriptedPool((statement) => (statement.includes('AS total') ? { rows: [{ total: 0, unverified: 0 }] } : statement.includes('make_interval') ? { rows: [{ n: 0 }] } : { rowCount: 1 }));
  await storeModule.createPostgresSmsSendGuardStore(sms.pool).reserveSmsSend({ ...base, bucket: 'unverified', purpose: 'student_registration' });
  assert.equal(sms.log[2].sql, "SELECT count(*)::int AS total, count(*) FILTER (WHERE coalesce(details->>'bucket', 'unverified') = 'unverified')::int AS unverified FROM auth_verification_events WHERE action = 'sms.send_reserved' AND occurred_at > clock_timestamp() - interval '24 hours'");
  assert.equal(sms.log[3].sql, "SELECT count(*)::int AS n FROM auth_verification_events WHERE action = 'sms.send_reserved' AND details->>'destinationKey' = $1 AND coalesce(details->>'bucket', 'unverified') = $2 AND occurred_at > clock_timestamp() - make_interval(secs => $3)");
  assert.equal(sms.log.find(({ sql }) => sql.startsWith('INSERT'))!.values[1], 'sms.send_reserved');
});

// ---------------------------------------------------------------------------
// AUTH_MOBILE_VERIFICATION=off (owner decision, 2026-11-23): email-only verification while SMS is
// unavailable. Institutes verify email only; Students keep mobile + password, codes go by email.
// ---------------------------------------------------------------------------

test('AUTH_MOBILE_VERIFICATION: parsing, preflight rule, provider status and the pure gates', async () => {
  const { validateMobileVerificationDeployment } = await import('./smsProtectionConfig.js');
  for (const value of [undefined, '', 'required']) assert.equal(providers.parseMobileVerificationSetting(value), 'required', String(value));
  assert.equal(providers.parseMobileVerificationSetting('off'), 'off');
  for (const bad of ['OFF', 'false', '0', 'no', 'disabled', ' off']) {
    assert.equal(providers.parseMobileVerificationSetting(bad), null, bad);
    assert.deepEqual(validateMobileVerificationDeployment({ AUTH_MOBILE_VERIFICATION: bad }), ['AUTH_MOBILE_VERIFICATION is invalid: it must be required or off (or left empty for required).'], bad);
  }
  for (const ok of [{}, { AUTH_MOBILE_VERIFICATION: '' }, { AUTH_MOBILE_VERIFICATION: 'required' }, { AUTH_MOBILE_VERIFICATION: 'off' }]) assert.deepEqual(validateMobileVerificationDeployment(ok), []);
  // An invalid value never weakens verification at runtime either.
  assert.equal(providers.resolveVerificationServices({ AUTH_MOBILE_VERIFICATION: 'OFF' }).mobileVerification, 'required');
  assert.equal(providers.resolveVerificationServices({ AUTH_MOBILE_VERIFICATION: 'off' }).mobileVerification, 'off');
  assert.equal(providers.mobileVerificationMode({}), 'required', 'absent means required');
  assert.equal(providers.providerStatus(providers.DISABLED_SERVICES).mobileVerification, 'required');
  assert.equal(providers.providerStatus({ ...providers.DISABLED_SERVICES, mobileVerification: 'off' }).mobileVerification, 'off');

  assert.deepEqual(auth.acceptedStudentSessionMethods('required'), ['sms_otp']);
  assert.deepEqual(auth.acceptedStudentSessionMethods('off'), ['sms_otp', 'email_otp', 'password']);
  const emailOnlyInstitute = { sessionVerified: false, officialMfaVerified: false, institute: { mobileVerified: false, emailVerified: true, institutionalStatus: 'verified' as const, suspended: false } };
  assert.deepEqual(auth.portalVerificationGate('center', emailOnlyInstitute, 'off'), { ok: true });
  assert.equal(auth.portalVerificationGate('center', emailOnlyInstitute, 'required').ok, false, 'mobile still required by default');
  assert.equal(auth.portalVerificationGate('center', { ...emailOnlyInstitute, institute: { ...emailOnlyInstitute.institute, emailVerified: false } }, 'off').ok, false, 'email is always required');
  assert.equal(auth.portalVerificationGate('candidate', emailOnlyInstitute, 'off').ok, false, 'a Student still needs session evidence');

  const fresh = { mobileDestination: '+919876500010', mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'pending' as const, suspendedAt: null };
  assert.equal(verification.nextInstituteChannel(fresh, 'required'), 'sms');
  assert.equal(verification.nextInstituteChannel(fresh, 'off'), 'email');
  assert.equal(verification.nextInstituteChannel({ ...fresh, emailVerifiedAt: new Date() }, 'off'), null, 'email alone completes contacts');
  assert.equal(verification.nextInstituteChannel({ ...fresh, emailVerifiedAt: new Date() }, 'required'), 'sms');
});

test('AUTH_MOBILE_VERIFICATION=off: Institutes verify email only (no SMS provider needed) and then reach the portal', async () => {
  const f = await setup({ services: 'email', mobileVerification: 'off', institute: { status: 'approved', verification: { mobileDestination: '+919876500010', mobileVerifiedAt: null, emailDestination: 'office@example.test', emailVerifiedAt: null, institutionalStatus: 'verified', suspendedAt: null } } });
  try {
    const status = await call(f.base, 'GET', '/api/auth/providers', { surface: 'institution' });
    assert.deepEqual([status.body.mobileVerification, (status.body.sms as { available: boolean }).available, (status.body.email as { available: boolean }).available], ['off', false, true]);
    const login = await instituteLogin(f);
    assert.deepEqual([login.status, login.body.channel, login.body.purpose, login.body.step], [202, 'email', 'institute_email', 'code']);
    assert.equal(f.email.sent.at(-1)!.destination, 'office@example.test');
    const done = await verify(f, verificationCookie(login), f.email.lastCode()!, 'institution');
    assert.deepEqual([done.status, done.body.status], [200, 'contacts_verified']);
    assert.match(String(done.body.message), /^Email is verified\./);
    assert.equal(f.store.institutes.get('institute-1')!.mobileVerifiedAt, null, 'the mobile is not marked verified');
    const signedIn = await instituteLogin(f);
    assert.equal(signedIn.status, 200);
    const session = cookieValue(signedIn.setCookies, 'elt_session')!;
    assert.equal((await call(f.base, 'GET', '/api/auth/me', { surface: 'institution', cookie: `elt_session=${session}` })).status, 200);
    assert.equal(f.sms.sent.length, 0, 'no SMS is ever attempted');
  } finally {
    await f.close();
  }
});

test('AUTH_MOBILE_VERIFICATION=off: Student registration sends the code by email; the account keeps the mobile-derived login ID', async () => {
  const f = await setup({ services: 'email', mobileVerification: 'off' });
  try {
    const missing = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543290' } });
    assert.deepEqual([missing.status, missing.body.code], [400, 'EMAIL_REQUIRED']);
    const invalid = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543290', email: 'not-an-email' } });
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'INVALID_EMAIL']);
    assert.equal(f.registrations.claims.size, 0, 'nothing is written for invalid input');

    const result = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543290', email: 'New.Student@Example.test' } });
    assert.deepEqual([result.status, result.body.purpose, result.body.channel, result.body.step, result.body.codeSent], [202, 'student_registration', 'email', 'code', true]);
    assert.equal(f.email.sent.at(-1)!.destination, 'new.student@example.test', 'normalised email');
    assert.equal(f.created.length, 0, 'no account before the code is verified');
    const ok = await verify(f, verificationCookie(result), f.email.lastCode()!);
    assert.deepEqual([ok.status, ok.body.status], [200, 'signed_in']);
    assert.deepEqual(f.created, [derivedId('+919876543290')], 'login ID still derived from the mobile');
    const account = [...f.store.users.values()].find((user) => user.loginId === derivedId('+919876543290'))!;
    assert.equal(f.store.contacts.get(`${account.id}:email`), 'new.student@example.test', 'the proven email is the verified contact');
    assert.equal(f.store.contacts.get(`${account.id}:sms`), undefined, 'the mobile is NOT marked verified');
    assert.equal(account.contactEmail, 'new.student@example.test');
    assert.equal(f.store.sessions.at(-1)!.method, 'email_otp');
    const session = cookieValue(ok.setCookies, 'elt_session')!;
    assert.equal((await call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: `elt_session=${session}` })).status, 200, 'an email_otp session is accepted while the switch is off');
    assert.equal(f.sms.sent.length, 0);
  } finally {
    await f.close();
  }
});

test('AUTH_MOBILE_VERIFICATION=off: an existing Student signs in with email, mobile or Student ID + password alone (no code)', async () => {
  const f = await setup({ services: 'email', mobileVerification: 'off', studentEmail: 'student@example.test', extraStudents: [{ id: 'student-m', loginId: derivedId('+919876543291') }] });
  const login = (body: Record<string, string>) => call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { password: STUDENT_PASSWORD, role: 'candidate', ...body } });
  const me = (result: { setCookies: string[] }) => call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: `elt_session=${cookieValue(result.setCookies, 'elt_session')}` });
  try {
    // Verified email (case and spaces do not matter): a session straight away, recorded as 'password'.
    const byEmail = await login({ email: '  Student@Example.TEST ' });
    assert.equal(byEmail.status, 200);
    assert.deepEqual(byEmail.body.user, { id: 'student-1', loginId: 'STUDENT-1', name: 'Synthetic Student', role: 'candidate', isSuperAdmin: false });
    assert.equal(cookieValue(byEmail.setCookies, 'elt_verification'), undefined, 'no verification challenge');
    assert.equal(f.store.sessions.at(-1)!.method, 'password');
    assert.equal((await me(byEmail)).status, 200, 'a password session is accepted while the switch is off');
    assert.ok(f.store.events.some((event) => event.action === 'student.password_session_issued' && event.userId === 'student-1'));

    // Mobile (no verified email needed) and Student ID work the same way.
    const byMobile = await login({ mobile: '9876543291' });
    assert.deepEqual([byMobile.status, (byMobile.body.user as { id: string }).id], [200, 'student-m']);
    assert.equal((await me(byMobile)).status, 200);
    const byId = await studentLogin(f);
    assert.equal(byId.status, 200);
    assert.equal((await me(byId)).status, 200);

    // Wrong password, unknown or unverified email: one generic answer, no session.
    const sessions = f.store.sessions.length;
    const refusals: Array<Record<string, string>> = [{ email: 'student@example.test', password: 'wrong-password-123' }, { email: 'nobody@example.test' }, { email: 'not-an-email' }, { mobile: '9876543299' }];
    for (const body of refusals) {
      const refused = await login(body);
      assert.deepEqual([refused.status, refused.body.code], [401, 'INVALID_SIGN_IN_CREDENTIALS'], JSON.stringify(body));
    }
    assert.equal(f.store.sessions.length, sessions);
    // Exactly one identifier.
    assert.equal((await login({ email: 'student@example.test', mobile: '9876543291' })).status, 400);
    // Nothing is ever sent at sign-in.
    assert.deepEqual([f.email.sent.length, f.sms.sent.length], [0, 0]);
  } finally {
    await f.close();
  }
});

test('AUTH_MOBILE_VERIFICATION: password and email_otp sessions stop counting when the switch is back to required; email sign-in is refused there', async () => {
  const f = await setup({ services: 'both', mobileVerification: 'off', studentEmail: 'student@example.test' });
  try {
    const login = await studentLogin(f);
    assert.equal(login.status, 200);
    const session = cookieValue(login.setCookies, 'elt_session')!;
    assert.equal((await call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: `elt_session=${session}` })).status, 200);
    // Operator sets AUTH_MOBILE_VERIFICATION=required again (same services, mode switched).
    providers.configureVerificationServices({ ...providers.verificationServices(), mobileVerification: 'required' });
    const refused = await call(f.base, 'GET', '/api/auth/me', { surface: 'exam', cookie: `elt_session=${session}` });
    assert.deepEqual([refused.status, refused.body.code], [403, 'STUDENT_VERIFICATION_REQUIRED']);
    // In required mode the same sign-in goes back to SMS (here: mobile capture, no verified mobile yet).
    const sms = await studentLogin(f);
    assert.deepEqual([sms.status, sms.body.channel, sms.body.purpose], [202, 'sms', 'student_mobile_capture']);
    // And an email destination is refused for an SMS challenge.
    const wrong = await call(f.base, 'POST', '/api/auth/verification/destination', { surface: 'exam', cookie: verificationCookie(sms), body: { email: 'x@example.test' } });
    assert.deepEqual([wrong.status, wrong.body.code], [400, 'INVALID_MOBILE']);
    // Email sign-in exists only while the switch is off.
    const byEmail = await call(f.base, 'POST', '/api/auth/login', { surface: 'exam', body: { email: 'student@example.test', password: STUDENT_PASSWORD, role: 'candidate' } });
    assert.deepEqual([byEmail.status, byEmail.body.code], [401, 'INVALID_MOBILE_CREDENTIALS']);
  } finally {
    await f.close();
  }
});

test('AUTH_MOBILE_VERIFICATION=off: registration stays closed without an email provider; password sign-in needs none', async () => {
  const f = await setup({ services: 'sms', mobileVerification: 'off' });
  try {
    const institute = await instituteLogin(f);
    assert.deepEqual([institute.status, institute.body.code], [503, 'EMAIL_PROVIDER_NOT_CONFIGURED']);
    const register = await call(f.base, 'POST', '/api/auth/register', { surface: 'exam', body: { name: 'New Student', password: STUDENT_PASSWORD, mobile: '9876543292', email: 'a@example.test' } });
    assert.deepEqual([register.status, register.body.code], [503, 'EMAIL_PROVIDER_NOT_CONFIGURED']);
    assert.equal(f.lookups, 0, 'closed before any account lookup');
    const student = await studentLogin(f);
    assert.equal(student.status, 200, 'an existing Student still signs in with a password');
    assert.deepEqual([f.sms.sent.length, f.email.sent.length, f.registrations.claims.size], [0, 0, 0]);
  } finally {
    await f.close();
  }
});

test('AUTH_MOBILE_VERIFICATION=off (PostgreSQL store): email completion stores the email contact and an email_otp session; SMS is unchanged', async () => {
  const storeModule = await import('./authVerificationStore.js');
  const scripted = scriptedPool((sql) => {
    if (sql.startsWith('SELECT mobile, display_name')) return { rows: [CLAIM_ROW] };
    if (sql.startsWith('SELECT ac.user_id')) return { rows: [] };
    return { rowCount: 1, rows: sql.includes('RETURNING id') ? [{ id: 'x' }] : [] };
  });
  // The destination is the email the code went to (not the claim mobile): still completed.
  assert.equal(await storeModule.createPostgresStudentRegistrationStore(scripted.pool).completeRegistration(completion({ channel: 'email', destination: 'new@example.test' })), 'completed');
  const user = scripted.log.find(({ sql }) => sql.startsWith('INSERT INTO users'))!;
  assert.equal(user.values[4], 'new@example.test', 'users.contact_email is the proven email');
  const contact = scripted.log.find(({ sql }) => sql.startsWith('INSERT INTO account_contacts'))!;
  assert.deepEqual(contact.values.slice(2, 4), ['email', 'new@example.test']);
  const method = scripted.log.find(({ sql }) => sql.startsWith('INSERT INTO auth_session_verifications'))!;
  assert.equal(method.values[1], 'email_otp');

  // SMS (default channel) keeps the claim-mobile check and writes exactly what it wrote before.
  const sms = scriptedPool((sql) => {
    if (sql.startsWith('SELECT mobile, display_name')) return { rows: [CLAIM_ROW] };
    if (sql.startsWith('SELECT ac.user_id')) return { rows: [] };
    return { rowCount: 1, rows: sql.includes('RETURNING id') ? [{ id: 'x' }] : [] };
  });
  assert.equal(await storeModule.createPostgresStudentRegistrationStore(sms.pool).completeRegistration(completion({ destination: '+919876543499' })), 'expired', 'an SMS code to another number never completes');
  const smsOk = scriptedPool((sql) => {
    if (sql.startsWith('SELECT mobile, display_name')) return { rows: [CLAIM_ROW] };
    if (sql.startsWith('SELECT ac.user_id')) return { rows: [] };
    return { rowCount: 1, rows: sql.includes('RETURNING id') ? [{ id: 'x' }] : [] };
  });
  assert.equal(await storeModule.createPostgresStudentRegistrationStore(smsOk.pool).completeRegistration(completion()), 'completed');
  assert.equal(smsOk.log.find(({ sql }) => sql.startsWith('INSERT INTO users'))!.values[4], null);
  assert.deepEqual(smsOk.log.find(({ sql }) => sql.startsWith('INSERT INTO account_contacts'))!.values.slice(2, 4), ['sms', '+919876543400']);
  assert.equal(smsOk.log.find(({ sql }) => sql.startsWith('INSERT INTO auth_session_verifications'))!.values[1], 'sms_otp');
});

test('AUTH_MOBILE_VERIFICATION=off (PostgreSQL store): password sessions are written atomically; email lookup uses verified Student contacts only', async () => {
  const storeModule = await import('./authVerificationStore.js');
  const scripted = scriptedPool((sql) => (sql.startsWith('SELECT ac.user_id') ? { rows: [{ user_id: 'student-9' }] } : { rowCount: 1 }));
  const store = storeModule.createPostgresAuthVerificationStore(scripted.pool);
  const now = new Date();
  await store.issueStudentPasswordSession({ userId: 'student-9', sessionTokenHash: 'h'.repeat(64), sessionExpiresAt: new Date(now.getTime() + 1000), now });
  const statements = scripted.log.map(({ sql }) => sql.split(' (')[0]);
  assert.deepEqual(statements, ['BEGIN', 'INSERT INTO auth_sessions', 'INSERT INTO auth_session_verifications', 'INSERT INTO auth_verification_events', 'COMMIT']);
  assert.equal(scripted.log[2].values[1], 'password');
  assert.equal(scripted.log[3].values[1], 'student.password_session_issued');

  assert.deepEqual(await store.findCandidateIdsByVerifiedEmail('student@example.test', 2), ['student-9']);
  const lookup = scripted.log.at(-1)!;
  assert.match(lookup.sql, /ac\.channel = 'email' AND lower\(ac\.destination\) = lower\(\$1\) AND ac\.verified_at IS NOT NULL AND u\.role = 'candidate'/);
  assert.deepEqual(lookup.values, ['student@example.test', 2]);
});
