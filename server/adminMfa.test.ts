// AUTH C1.9.1 (MFA P3a-1): server-side Official MFA sign-in, key ring and central enforcement.
// No database, network or real secret is used: the shared pool is stubbed per test, the MFA store is
// an in-memory double (or a scripted PostgreSQL client for the real store), and every key and TOTP
// secret below is synthetic and generated in this process.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PoolClient } from 'pg';

process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:9/placeholder';
delete process.env.ADMIN_MFA_ENCRYPTION_KEY_FILE;

const [{ app }, { pool }, auth, mfa, store, core, surface] = await Promise.all([
  import('./index.js'),
  import('./db.js'),
  import('./auth.js'),
  import('./adminMfa.js'),
  import('./adminMfaStore.js'),
  import('./adminMfaCore.js'),
  import('./surface.js'),
]);
type AdminMfaStore = import('./adminMfaStore.js').AdminMfaStore;
type AdminMfaVerifyInput = import('./adminMfaStore.js').AdminMfaVerifyInput;
type AdminMfaVerifyResult = import('./adminMfaStore.js').AdminMfaVerifyResult;
type StoredTotpFactor = import('./adminMfaStore.js').StoredTotpFactor;

const NOW = 1_800_000_000_000;            // fixed TOTP clock (Unix ms)
const KEY = randomBytes(32);              // synthetic v1 key, this process only
const RING = new Map<number, Uint8Array>([[1, KEY]]);
const POLICY = store.ADMIN_MFA_LOGIN_POLICY;

// ---------------------------------------------------------------------------------------------
// In-memory store double (mirrors the PostgreSQL semantics: per-user serialisation, throttle,
// attempt reservation, replay guard, single use, and rollback when the code check throws)
// ---------------------------------------------------------------------------------------------

interface MemUser { id: string; loginId: string; name: string; role: string; status: string; superAdmin: boolean }
interface MemFactor { id: string; userId: string; secret: Buffer; keyVersion: number; confirmed: boolean; disabled: boolean; lastUsedStep: number }
interface MemChallenge { userId: string; purpose: string; attempts: number; consumed: string | null; expiresAt: number }

class MemoryMfaStore implements AdminMfaStore {
  users = new Map<string, MemUser>();
  factors = new Map<string, MemFactor>();
  challenges = new Map<string, MemChallenge>();
  sessions = new Map<string, string>();
  evidence: Array<{ tokenHash: string; userId: string; factorId: string }> = [];
  events: Array<{ action: string; userId: string; details: Record<string, unknown> }> = [];
  createdChallenges: Array<{ challengeId: string; userId: string; ttlSeconds: number }> = [];
  failSessionInsert = false;
  private queue: Promise<unknown> = Promise.resolve();

  addOfficial(id: string, options: { superAdmin?: boolean; status?: string; factor?: boolean; keyVersion?: number } = {}): { secret: Buffer } {
    this.users.set(id, { id, loginId: id.toUpperCase(), name: `Official ${id}`, role: 'official', status: options.status ?? 'approved', superAdmin: options.superAdmin === true });
    const secret = core.generateTotpSecret();
    if (options.factor !== false) {
      this.factors.set(id, { id: `factor-${id}`, userId: id, secret, keyVersion: options.keyVersion ?? 1, confirmed: true, disabled: false, lastUsedStep: -1 });
    }
    return { secret };
  }

  addChallenge(challengeId: string, userId: string, options: Partial<MemChallenge> = {}): void {
    this.challenges.set(challengeId, { userId, purpose: 'login', attempts: 0, consumed: null, expiresAt: Date.now() + 300_000, ...options });
  }

  private serial<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async hasActiveFactor(userId: string): Promise<boolean> {
    const factor = this.factors.get(userId);
    return Boolean(factor && factor.confirmed && !factor.disabled);
  }

  async createLoginChallenge(input: { challengeId: string; userId: string; ttlSeconds: number }): Promise<void> {
    this.createdChallenges.push(input);
    for (const challenge of this.challenges.values()) {
      if (challenge.userId === input.userId && challenge.purpose === 'login' && challenge.consumed === null) challenge.consumed = 'superseded';
    }
    this.addChallenge(input.challengeId, input.userId, { expiresAt: Date.now() + input.ttlSeconds * 1000 });
    this.events.push({ action: 'admin_mfa.challenge_created', userId: input.userId, details: {} });
  }

  async createEnrolmentChallenge(input: { challengeId: string; userId: string; ttlSeconds: number }): Promise<void> {
    this.createdChallenges.push(input);
    for (const challenge of this.challenges.values()) {
      if (challenge.userId === input.userId && ['login', 'enrol'].includes(challenge.purpose) && challenge.consumed === null) challenge.consumed = 'superseded';
    }
    this.addChallenge(input.challengeId, input.userId, { purpose: 'enrol', expiresAt: Date.now() + input.ttlSeconds * 1000 });
    this.events.push({ action: 'admin_mfa.challenge_created', userId: input.userId, details: { outcome: 'enrolment' } });
  }

  verifyLogin(input: AdminMfaVerifyInput): Promise<AdminMfaVerifyResult> {
    return this.serial(() => this.verifyNow(input));
  }

  private verifyNow({ challengeId, sessionTokenHash, check }: AdminMfaVerifyInput): AdminMfaVerifyResult {
    const pending: Array<() => void> = [];   // applied only when the "transaction" commits
    const commit = <T>(result: T): T => { for (const apply of pending) apply(); return result; };
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.purpose !== 'login' || challenge.consumed !== null || challenge.expiresAt <= Date.now()) return commit({ status: 'expired' });
    const userId = challenge.userId;
    const event = (action: string, details: Record<string, unknown> = {}) => pending.push(() => this.events.push({ action, userId, details }));
    const failures = this.events.filter((e) => e.userId === userId && e.action === 'admin_mfa.code_rejected').length;
    if (failures >= POLICY.throttleFailures) { event('admin_mfa.throttled'); return commit({ status: 'throttled' }); }
    if (challenge.attempts >= POLICY.maxAttempts) {
      pending.push(() => { challenge.consumed = 'locked'; });
      event('admin_mfa.challenge_locked');
      return commit({ status: 'locked' });
    }
    const attempts = challenge.attempts + 1;
    pending.push(() => { challenge.attempts = attempts; });
    const user = this.users.get(userId);
    if (!user || user.role !== 'official' || user.status !== 'approved') {
      pending.push(() => { challenge.consumed = 'revoked'; });
      return commit({ status: 'not_eligible' });
    }
    const stored = this.factors.get(userId);
    if (!stored || !stored.confirmed || stored.disabled) {
      pending.push(() => { challenge.consumed = 'revoked'; });
      return commit({ status: 'not_eligible' });
    }
    const envelope = core.encryptTotpSecret(stored.secret, KEY, stored.keyVersion, { factorId: stored.id, userId });
    const factor: StoredTotpFactor = { id: stored.id, userId, keyVersion: stored.keyVersion, ciphertext: envelope.ciphertext, nonce: envelope.nonce, tag: envelope.tag, lastUsedStep: stored.lastUsedStep };
    let decision = check(factor);  // a throw here discards `pending` (rollback)
    if (decision.outcome === 'accept' && !(stored.lastUsedStep < decision.step)) decision = { outcome: 'reject', reason: 'replayed' };
    if (decision.outcome === 'reject') {
      event('admin_mfa.code_rejected', { outcome: decision.reason });
      if (attempts >= POLICY.maxAttempts) {
        pending.push(() => { challenge.consumed = 'locked'; });
        event('admin_mfa.challenge_locked');
        return commit({ status: 'locked' });
      }
      return commit({ status: 'invalid_code', attemptsRemaining: POLICY.maxAttempts - attempts });
    }
    if (this.failSessionInsert) throw new Error('injected session insert failure');  // nothing applied
    const step = decision.step;
    pending.push(() => { stored.lastUsedStep = step; challenge.consumed = 'verified'; this.sessions.set(sessionTokenHash, userId); this.evidence.push({ tokenHash: sessionTokenHash, userId, factorId: stored.id }); });
    event('admin_mfa.verified', { outcome: 'login' });
    return commit({ status: 'signed_in', user: { id: userId, loginId: user.loginId, name: user.name, isSuperAdmin: user.superAdmin } });
  }
}

// ---------------------------------------------------------------------------------------------
// Request/response doubles
// ---------------------------------------------------------------------------------------------

interface Outcome { status: number; body: Record<string, unknown>; cookies: string[]; sessionCookie: string | null; headers: Record<string, string>; error?: unknown }

function invoke(handler: RequestHandler, request: Partial<Request>): Promise<Outcome> {
  return new Promise((resolve) => {
    const outcome: Outcome = { status: 200, body: {}, cookies: [], sessionCookie: null, headers: {} };
    const response = {
      headersSent: false,
      status(code: number) { outcome.status = code; return response; },
      set(name: string, value: string) { outcome.headers[name] = value; return response; },
      json(body: Record<string, unknown>) { outcome.body = body; resolve(outcome); return response; },
      append(name: string, value: string) { if (name === 'Set-Cookie') outcome.cookies.push(value); return response; },
      cookie(name: string, value: string) { outcome.cookies.push(`${name}=${value}`); if (name === auth.SESSION_COOKIE) outcome.sessionCookie = value; return response; },
      clearCookie(name: string) { outcome.cookies.push(`${name}=; cleared`); return response; },
    };
    const next: NextFunction = (error?: unknown) => resolve({ ...outcome, status: error ? 500 : -1, error });
    handler(request as Request, response as unknown as Response, next);
  });
}

const challengeCookie = (outcome: Outcome) => outcome.cookies.find((c) => c.startsWith(`${mfa.ADMIN_MFA_COOKIE}=`) && !c.includes('Max-Age=0'));
const tokenFrom = (cookie: string | undefined) => cookie?.split(';')[0].split('=')[1] ?? '';
const verifyHandler = mfa.createAdminMfaVerifyHandler({ clock: () => NOW });
const verify = (token: string | null, body: unknown) =>
  invoke(verifyHandler, { headers: token === null ? {} : { cookie: `${mfa.ADMIN_MFA_COOKIE}=${token}` }, body } as Partial<Request>);
const codeAt = (secret: Buffer, offsetSteps = 0) => core.computeTotp(secret, () => NOW + offsetSteps * 30_000);

async function withEnrollmentDatabase<T>(
  work: (state: { log: string[]; factorConfirmed: boolean; ticketUsed: boolean; challengeConsumed: boolean; sessions: number; factorChallengeId: string; challengeId: string; consumedTicketId: string }) => Promise<T>,
  challengePurpose = 'enrol',
  options: { challengeLive?: boolean; ticketOwner?: string; ticketConsumptionRows?: number } = {},
): Promise<T> {
  const originalConnect = (pool as unknown as { connect: unknown }).connect;
  const state = {
    log: [] as string[],
    challengePurpose,
    challengeLive: options.challengeLive ?? true,
    ticketOwner: options.ticketOwner ?? 'off-1',
    ticketConsumptionRows: options.ticketConsumptionRows ?? 1,
    challengeId: '',
    ticketId: '',
    consumedTicketId: '',
    factorId: '',
    factorChallengeId: '',
    ciphertext: Buffer.alloc(20),
    nonce: Buffer.alloc(12),
    tag: Buffer.alloc(16),
    factorConfirmed: false,
    ticketUsed: false,
    challengeConsumed: false,
    attempts: 0,
    sessions: 0,
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({
    async query(text: string, values: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      state.log.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT user_id, purpose FROM admin_mfa_challenges')) {
        state.challengeId = String(values[0]);
        return { rows: [{ user_id: 'off-1', purpose: state.challengePurpose }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, user_id, enrolment_ticket_id')) {
        return {
          rows: [{
            id: state.challengeId,
            user_id: 'off-1',
            enrolment_ticket_id: state.ticketId || null,
            attempts: state.attempts,
            live: state.challengeLive && !state.challengeConsumed,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE admin_mfa_challenges SET consumed_at') && sql.includes("consumed_reason = 'superseded'")) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT id, user_id FROM admin_mfa_enrolment_tickets')) {
        if (String(values[1]) === state.ticketOwner) {
          state.ticketId = String(values[0]);
          return { rows: [{ id: state.ticketId, user_id: state.ticketOwner }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SELECT id FROM admin_mfa_enrolment_tickets')) {
        return state.ticketUsed || String(values[0]) !== state.ticketId || String(values[1]) !== state.ticketOwner
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: state.ticketId }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, login_id FROM users')) {
        return { rows: [{ id: 'off-1', login_id: 'OFF-1' }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, login_id, display_name, is_super_admin FROM users')) {
        return { rows: [{ id: 'off-1', login_id: 'OFF-1', display_name: 'Official One', is_super_admin: false }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id FROM admin_mfa_factors')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('UPDATE admin_mfa_challenges SET enrolment_ticket_id')) {
        state.ticketId = String(values[1]);
        return { rows: [{ id: state.challengeId }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO admin_mfa_factors')) {
        state.factorId = String(values[0]);
        state.factorChallengeId = String(values[2]);
        state.ciphertext = Buffer.from(values[3] as Uint8Array);
        state.nonce = Buffer.from(values[4] as Uint8Array);
        state.tag = Buffer.from(values[5] as Uint8Array);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, user_id, enrolment_challenge_id')) {
        if (String(values[0]) !== state.factorChallengeId || String(values[1]) !== 'off-1') {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            id: state.factorId,
            user_id: 'off-1',
            enrolment_challenge_id: state.factorChallengeId,
            key_version: 1,
            secret_ciphertext: state.ciphertext,
            secret_nonce: state.nonce,
            secret_tag: state.tag,
            last_used_step: -1,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE admin_mfa_challenges SET attempts')) {
        state.attempts += 1;
        return { rows: [{ attempts: state.attempts }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE admin_mfa_challenges SET consumed_at') && sql.includes("consumed_reason = 'locked'")) {
        state.challengeConsumed = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT public.confirm_admin_mfa_enrolment_factor')) {
        if (state.ticketConsumptionRows !== 1 || String(values[0]) !== 'off-1'
          || String(values[1]) !== state.factorChallengeId || String(values[2]) !== state.ticketId
          || String(values[3]) !== state.factorId) {
          throw new Error('synthetic factor trigger rejected non-exact ticket consumption');
        }
        state.factorConfirmed = true;
        state.ticketUsed = true; // Represents the migration trigger's same-transaction ticket update.
        state.consumedTicketId = state.ticketId;
        return { rows: [{ confirmed: true }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE admin_mfa_challenges SET consumed_at') && sql.includes("consumed_reason = 'verified'")) {
        state.challengeConsumed = true;
        return { rows: [{ id: state.challengeId }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO auth_sessions')) {
        state.sessions += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO auth_session_mfa_verifications') || sql.startsWith('INSERT INTO auth_verification_events')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected enrollment query: ${sql.slice(0, 100)}`);
    },
    release() {},
  });
  try {
    return await work(state);
  } finally {
    (pool as unknown as { connect: unknown }).connect = originalConnect;
  }
}

/** Installs a fresh memory store and the synthetic key ring; returns the store. */
function freshStore(): MemoryMfaStore {
  const memory = new MemoryMfaStore();
  mfa.configureAdminMfaStore(memory);
  mfa.configureAdminMfaKeyRing({ ok: true, ring: RING });
  return memory;
}

/** Creates a challenge for `userId` through the real password-step helper; returns its raw token. */
async function startChallenge(userId: string): Promise<string> {
  const outcome = await new Promise<Outcome>((resolve) => {
    const out: Outcome = { status: 200, body: {}, cookies: [], sessionCookie: null, headers: {} };
    const response = { append(name: string, value: string) { if (name === 'Set-Cookie') out.cookies.push(value); return response; } };
    void mfa.beginAdminMfaSignIn(response as unknown as Response, userId).then((body) => resolve({ ...out, body: body as Record<string, unknown> }));
  });
  assert.deepEqual(outcome.body, { status: 'mfa_required' });
  return tokenFrom(challengeCookie(outcome));
}

// ---------------------------------------------------------------------------------------------
// Key loader and v1 key ring
// ---------------------------------------------------------------------------------------------

test('key loader: canonical Base64 of exactly 32 bytes (one trailing LF tolerated), as version v1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eltnoy-mfa-key-'));
  try {
    const key = randomBytes(32);
    const write = async (name: string, contents: string | Buffer) => { const path = join(dir, name); await writeFile(path, contents, { mode: 0o600 }); return path; };
    const load = (path: string | undefined) => mfa.loadAdminMfaKeyRing({ [mfa.ADMIN_MFA_KEY_FILE_ENV]: path });
    for (const contents of [key.toString('base64'), `${key.toString('base64')}\n`]) {
      const result = load(await write(`ok-${contents.length}`, contents));
      assert.equal(result.ok, true);
      assert.ok(result.ok && result.ring instanceof Map);
      assert.deepEqual(result.ok && [...result.ring.keys()], [mfa.ADMIN_MFA_KEY_VERSIONS.v1]);
      assert.deepEqual(result.ok && Buffer.from(result.ring.get(1)!), key);
    }
    assert.equal(mfa.ADMIN_MFA_KEY_VERSIONS.v1, 1);
    const b64 = key.toString('base64');
    const refused: Array<[string, string | Buffer]> = [
      ['crlf', `${b64}\r\n`], ['two-lf', `${b64}\n\n`], ['leading-space', ` ${b64}`], ['trailing-space', `${b64} `],
      ['no-padding', b64.slice(0, 43)], ['base64url', b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, '')],
      ['short-16-bytes', randomBytes(16).toString('base64')], ['long-33-bytes', randomBytes(33).toString('base64')],
      ['non-canonical-last-symbol', `${b64.slice(0, 42)}B=`], ['hex', key.toString('hex')], ['raw-binary', key], ['empty', ''],
      ['non-ascii', Buffer.concat([Buffer.from(b64.slice(0, 43)), Buffer.from([0xc3])])],
    ];
    for (const [label, contents] of refused) assert.deepEqual(load(await write(label, contents)), { ok: false }, label);
    assert.deepEqual(load(undefined), { ok: false }, 'unset');
    assert.deepEqual(load('relative/key.b64'), { ok: false }, 'relative path');
    assert.deepEqual(load(join(dir, 'missing')), { ok: false }, 'missing file');
    assert.deepEqual(load(dir), { ok: false }, 'a directory');
    // The answer never carries the path or contents.
    assert.equal(JSON.stringify(load(join(dir, 'missing'))).includes(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('key ring: a successful load is cached; a failure is retried; no default key exists', async () => {
  mfa.configureAdminMfaKeyRing(undefined);
  assert.deepEqual(mfa.adminMfaKeyRing(), { ok: false }, 'unset environment: no key, no generated default');
  const dir = await mkdtemp(join(tmpdir(), 'eltnoy-mfa-key-'));
  try {
    const path = join(dir, 'key');
    await writeFile(path, randomBytes(32).toString('base64'), { mode: 0o600 });
    process.env.ADMIN_MFA_ENCRYPTION_KEY_FILE = path;
    assert.equal(mfa.adminMfaKeyRing().ok, true, 'a corrected key file is picked up without a restart');
    await rm(path);
    assert.equal(mfa.adminMfaKeyRing().ok, true, 'the loaded ring stays in memory');
  } finally {
    delete process.env.ADMIN_MFA_ENCRYPTION_KEY_FILE;
    mfa.configureAdminMfaKeyRing(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Password step (the real POST /api/auth/login handler)
// ---------------------------------------------------------------------------------------------

const loginRoute = (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } })
  ._router.stack.find((layer) => layer.route?.path === '/api/auth/login' && layer.route.methods.post)!.route!;
const loginHandler = loginRoute.stack[loginRoute.stack.length - 1].handle;
const PASSWORD = 'synthetic-official-password';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

/** Stubs the shared pool: the users lookup answers `row`; any auth_sessions INSERT is recorded. */
async function withUsersLookup<T>(row: Record<string, unknown> | null, work: (statements: string[]) => Promise<T>): Promise<T> {
  const original = pool.query.bind(pool);
  const statements: string[] = [];
  (pool as unknown as { query: unknown }).query = async (text: string) => {
    statements.push(text);
    if (text.includes('FROM users WHERE login_id = $1 AND role = $2')) return { rows: row ? [row] : [] };
    throw new Error(`unexpected query in the login test: ${text.slice(0, 60)}`);
  };
  try { return await work(statements); } finally { (pool as unknown as { query: unknown }).query = original; }
}

const login = (body: Record<string, unknown>, surfaceName: import('./surface.js').Surface = 'admin') => {
  const request = { body, headers: {} } as Partial<Request>;
  auth.setTrustedRequestSurface(request, surfaceName, surface.expectedOrigin(surfaceName));
  return invoke(loginHandler, request);
};
const officialRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'off-1', login_id: 'OFF-1', display_name: 'Official One', role: 'official', password_hash: PASSWORD_HASH,
  account_status: 'approved', is_super_admin: false, contact_email: null, ...overrides,
});

test('login: a correct Official password creates a challenge only: 202 mfa_required, no session row, no elt_session', async () => {
  for (const superAdmin of [false, true]) {
    const memory = freshStore();
    memory.addOfficial('off-1', { superAdmin });
    const outcome = await withUsersLookup(officialRow({ is_super_admin: superAdmin }), async (statements) => {
      const result = await login({ loginId: 'off-1', password: PASSWORD, role: 'official' });
      assert.ok(!statements.some((s) => /INSERT INTO auth_sessions/.test(s)), 'no session row');
      return result;
    });
    assert.equal(outcome.status, 202);
    assert.deepEqual(outcome.body, { status: 'mfa_required' }, 'no role, Super Admin or account information');
    assert.equal(outcome.sessionCookie, null);
    assert.ok(!outcome.cookies.some((c) => c.startsWith(`${auth.SESSION_COOKIE}=`)), 'no elt_session cookie');
    const cookie = challengeCookie(outcome)!;
    assert.match(cookie, /^elt_admin_mfa=[A-Za-z0-9_-]{43}; Path=\/api\/auth\/mfa; Max-Age=300; HttpOnly; SameSite=Strict$/);
    const token = tokenFrom(cookie);
    assert.equal(memory.createdChallenges.length, 1);
    assert.equal(memory.createdChallenges[0].challengeId, auth.hashSessionToken(token), 'only the SHA-256 of the token is stored');
    assert.notEqual(memory.createdChallenges[0].challengeId, token);
    assert.equal(memory.createdChallenges[0].ttlSeconds, 300);
    assert.equal(memory.createdChallenges[0].userId, 'off-1');
  }
});

test('login: an Official without an active factor gets an enrollment challenge cookie and no session', async () => {
  const memory = freshStore();
  memory.addOfficial('off-1', { factor: false, superAdmin: true });
  const outcome = await withUsersLookup(officialRow({ is_super_admin: true }), async (statements) => {
    const result = await login({ loginId: 'off-1', password: PASSWORD, role: 'official' });
    assert.ok(!statements.some((s) => /INSERT INTO auth_sessions/.test(s)), 'no session row');
    return result;
  });
  assert.equal(outcome.status, 202);
  assert.deepEqual(outcome.body, { status: 'mfa_enrolment_required' });
  assert.equal(outcome.sessionCookie, null);
  const cookie = challengeCookie(outcome)!;
  assert.match(cookie, /^elt_admin_mfa=[A-Za-z0-9_-]{43}; Path=\/api\/auth\/mfa; Max-Age=300; HttpOnly; SameSite=Strict$/);
  const token = tokenFrom(cookie);
  assert.equal(memory.createdChallenges.length, 1);
  assert.equal(memory.createdChallenges[0].challengeId, auth.hashSessionToken(token));
  assert.equal(memory.createdChallenges[0].userId, 'off-1');
  assert.equal(memory.challenges.get(auth.hashSessionToken(token))?.purpose, 'enrol');
});

test('enrollment: password, ticket, challenge cookie and TOTP complete without a pre-existing session', async () => {
  const memory = freshStore();
  memory.addOfficial('off-1', { factor: false });
  const loginOutcome = await withUsersLookup(officialRow(), () =>
    login({ loginId: 'off-1', password: PASSWORD, role: 'official' }));
  assert.equal(loginOutcome.status, 202);
  assert.deepEqual(loginOutcome.body, { status: 'mfa_enrolment_required' });
  assert.equal(loginOutcome.sessionCookie, null);
  const challengeToken = tokenFrom(challengeCookie(loginOutcome));
  assert.equal(memory.challenges.get(auth.hashSessionToken(challengeToken))?.purpose, 'enrol');
  const headers = { cookie: `${mfa.ADMIN_MFA_COOKIE}=${challengeToken}` };

  await withEnrollmentDatabase(async (database) => {
    const start = await invoke(mfa.createAdminMfaEnrolStartHandler(), {
      headers,
      body: { ticket: 'synthetic-enrolment-ticket' },
    } as Partial<Request>);
    assert.equal(start.status, 200);
    assert.equal(typeof start.body.secretBase32, 'string');
    assert.equal(start.headers['Cache-Control'], 'no-store', 'the response carrying the TOTP secret is never cached');
    assert.equal(start.sessionCookie, null, 'enrollment start issues no application session');
    assert.equal(database.sessions, 0);
    assert.equal(database.factorChallengeId, auth.hashSessionToken(challengeToken),
      'the factor is inserted with the exact challenge ID derived from its cookie');
    assert.ok(database.log.some((sql) => sql.includes('enrolment_challenge_id') && sql.includes('VALUES ($1, $2, $3')),
      'factor INSERT explicitly includes the challenge association');

    const startLocks = database.log.slice(database.log.indexOf('BEGIN'));
    const startLockIndex = startLocks.findIndex((sql) => sql.startsWith('SELECT pg_advisory_xact_lock'));
    const startChallengeIndex = startLocks.findIndex((sql) => sql.includes('admin_mfa_challenges') && sql.endsWith('FOR UPDATE'));
    const startTicketIndex = startLocks.findIndex((sql) => sql.includes('admin_mfa_enrolment_tickets') && sql.endsWith('FOR UPDATE'));
    const startFactorIndex = startLocks.findIndex((sql) => sql.startsWith('INSERT INTO admin_mfa_factors'));
    assert.ok(startLockIndex < startChallengeIndex && startChallengeIndex < startTicketIndex && startTicketIndex < startFactorIndex,
      'enrollment start acquires user advisory, challenge, ticket, then factor');

    const secret = core.decodeBase32(String(start.body.secretBase32));
    const validCode = codeAt(secret);
    const wrongCode = String((Number(validCode) + 1) % 1_000_000).padStart(6, '0');
    const confirmHandler = mfa.createAdminMfaEnrolConfirmHandler({ clock: () => NOW });
    const rejected = await invoke(confirmHandler, { headers, body: { code: wrongCode } } as Partial<Request>);
    assert.deepEqual([rejected.status, rejected.body.code, rejected.sessionCookie], [400, 'MFA_CODE_INVALID', null]);
    assert.deepEqual([database.factorConfirmed, database.ticketUsed, database.challengeConsumed, database.sessions], [false, false, false, 0]);

    const confirmationStart = database.log.lastIndexOf('BEGIN');
    const confirm = await invoke(confirmHandler, { headers, body: { code: validCode } } as Partial<Request>);
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.status, 'signed_in');
    assert.ok(confirm.sessionCookie, 'session cookie is issued only after successful TOTP confirmation');
    assert.deepEqual([database.factorConfirmed, database.ticketUsed, database.challengeConsumed, database.sessions], [true, true, true, 1]);
    assert.equal(database.consumedTicketId, auth.hashSessionToken('synthetic-enrolment-ticket'),
      'the factor trigger consumes the exact ticket linked to the enrollment challenge');
    const confirmationLog = database.log.slice(confirmationStart);
    const confirmLockIndex = confirmationLog.findIndex((sql) => sql.startsWith('SELECT pg_advisory_xact_lock'));
    const confirmChallengeIndex = confirmationLog.findIndex((sql) => sql.includes('admin_mfa_challenges') && sql.endsWith('FOR UPDATE'));
    const confirmTicketIndex = confirmationLog.findIndex((sql) => sql.includes('admin_mfa_enrolment_tickets') && sql.endsWith('FOR UPDATE'));
    const confirmFactorIndex = confirmationLog.findIndex((sql) => sql.includes('admin_mfa_factors') && sql.endsWith('FOR UPDATE'));
    assert.ok(confirmLockIndex < confirmChallengeIndex && confirmChallengeIndex < confirmTicketIndex && confirmTicketIndex < confirmFactorIndex,
      'confirmation acquires user advisory, challenge, ticket, then factor');
    assert.ok(confirmationLog.some((sql) => sql.includes('WHERE enrolment_challenge_id = $1 AND user_id = $2')),
      'confirmation selects the factor by exact challenge and user');
    assert.ok(confirmationLog.some((sql) => sql.includes('WHERE id = $1 AND user_id = $2 AND used_at IS NULL')),
      'confirmation validates the exact ticket linked by the locked challenge');
    assert.ok(confirmationLog.some((sql) => sql.startsWith('SELECT public.confirm_admin_mfa_enrolment_factor')),
      'confirmation uses the single ordered database mutation operation');
    assert.ok(!confirmationLog.some((sql) => sql.startsWith('UPDATE admin_mfa_factors SET confirmed_at')),
      'the application cannot directly update confirmed_at');
    assert.ok(!confirmationLog.some((sql) => sql.startsWith('UPDATE admin_mfa_enrolment_tickets')),
      'the factor trigger consumes the already-locked ticket atomically');
    assert.ok(!confirmationLog.some((sql) => /LIMIT\s+1/i.test(sql)),
      'confirmation does not select an arbitrary challenge, ticket or factor');
    secret.fill(0);
  });
});

test('enrollment start rejects expired challenge and ticket ownership mismatch without creating a factor', async () => {
  const token = randomBytes(32).toString('base64url');
  const headers = { cookie: `${mfa.ADMIN_MFA_COOKIE}=${token}` };
  await withEnrollmentDatabase(async (database) => {
    const outcome = await invoke(mfa.createAdminMfaEnrolStartHandler(), {
      headers,
      body: { ticket: 'synthetic-enrolment-ticket' },
    } as Partial<Request>);
    assert.equal(outcome.body.code, 'MFA_CHALLENGE_EXPIRED');
    assert.equal(database.factorChallengeId, '');
    assert.ok(!database.log.some((sql) => sql.startsWith('INSERT INTO admin_mfa_factors')));
  }, 'enrol', { challengeLive: false });

  await withEnrollmentDatabase(async (database) => {
    const outcome = await invoke(mfa.createAdminMfaEnrolStartHandler(), {
      headers,
      body: { ticket: 'synthetic-enrolment-ticket' },
    } as Partial<Request>);
    assert.equal(outcome.body.code, 'MFA_TICKET_INVALID');
    assert.equal(database.factorChallengeId, '');
    assert.ok(!database.log.some((sql) => sql.startsWith('INSERT INTO admin_mfa_factors')));
  }, 'enrol', { ticketOwner: 'another-official' });
});

test('enrollment confirmation rejects a trigger result that does not consume exactly one ticket', async () => {
  const token = randomBytes(32).toString('base64url');
  const headers = { cookie: `${mfa.ADMIN_MFA_COOKIE}=${token}` };
  await withEnrollmentDatabase(async (database) => {
    const start = await invoke(mfa.createAdminMfaEnrolStartHandler(), {
      headers,
      body: { ticket: 'synthetic-enrolment-ticket' },
    } as Partial<Request>);
    assert.equal(start.status, 200);
    const secret = core.decodeBase32(String(start.body.secretBase32));
    const confirm = await invoke(mfa.createAdminMfaEnrolConfirmHandler({ clock: () => NOW }), {
      headers,
      body: { code: codeAt(secret) },
    } as Partial<Request>);
    assert.equal(confirm.status, 500);
    assert.deepEqual([database.factorConfirmed, database.ticketUsed, database.sessions], [false, false, 0]);
    secret.fill(0);
  }, 'enrol', { ticketConsumptionRows: 0 });
});

test('enrollment: both endpoints reject a login-purpose challenge cookie', async () => {
  await withEnrollmentDatabase(async (database) => {
    const token = randomBytes(32).toString('base64url');
    const request = {
      headers: { cookie: `${mfa.ADMIN_MFA_COOKIE}=${token}` },
      body: { ticket: 'synthetic-enrolment-ticket' },
    } as Partial<Request>;
    const start = await invoke(mfa.createAdminMfaEnrolStartHandler(), request);
    const confirm = await invoke(mfa.createAdminMfaEnrolConfirmHandler({ clock: () => NOW }), {
      headers: request.headers,
      body: { code: '000000' },
    } as Partial<Request>);
    assert.deepEqual([start.status, start.body.code, start.sessionCookie], [410, 'MFA_CHALLENGE_EXPIRED', null]);
    assert.deepEqual([confirm.status, confirm.body.code, confirm.sessionCookie], [410, 'MFA_CHALLENGE_EXPIRED', null]);
    assert.equal(database.factorConfirmed, false);
    assert.equal(database.sessions, 0);
    assert.ok(!database.log.some((sql) => sql.startsWith('SELECT pg_advisory_xact_lock')),
      'wrong-purpose challenge is rejected before locking or modifying enrollment state');
  }, 'login');
});

test('enrollment association: new factor insert and confirmation contain no user-only LIMIT 1 lookup', async () => {
  const source = await readFile(new URL('./adminMfa.ts', import.meta.url), 'utf8');
  const enrollment = source.slice(source.indexOf('export async function beginAdminMfaEnrolment'), source.indexOf('export function createAdminMfaEnrolStartHandler'));
  const confirmation = source.slice(source.indexOf('export function createAdminMfaEnrolConfirmHandler'));
  assert.match(enrollment, /INSERT INTO admin_mfa_factors \(id, user_id, enrolment_challenge_id,/);
  assert.match(confirmation, /WHERE enrolment_challenge_id = \$1 AND user_id = \$2/);
  assert.doesNotMatch(`${enrollment}\n${confirmation}`, /LIMIT\s+1/i);

  const storeSource = await readFile(new URL('./adminMfaStore.ts', import.meta.url), 'utf8');
  const loginFactorSelection = storeSource.slice(storeSource.indexOf('const { rows: factors }'), storeSource.indexOf('const factorRow = factors[0]'));
  assert.match(loginFactorSelection, /confirmed_at IS NOT NULL AND disabled_at IS NULL/,
    'legacy confirmed factors remain available for login');
  assert.doesNotMatch(loginFactorSelection, /enrolment_challenge_id IS NOT NULL/,
    'login does not require legacy confirmed factors to have an enrollment association');
});

test('login: wrong password and unknown login ID give the same generic 401; neither creates a challenge', async () => {
  const memory = freshStore();
  memory.addOfficial('off-1');
  const generic = { error: 'Invalid login ID, password, or account type.' };
  const wrong = await withUsersLookup(officialRow(), () => login({ loginId: 'off-1', password: 'not-the-password', role: 'official' }));
  const unknown = await withUsersLookup(null, () => login({ loginId: 'nobody', password: PASSWORD, role: 'official' }));
  for (const outcome of [wrong, unknown]) {
    assert.deepEqual([outcome.status, outcome.body], [401, generic]);
    assert.deepEqual(outcome.cookies, []);
  }
  assert.equal(memory.createdChallenges.length, 0);
});

test('login (static): an unknown login ID costs one dummy bcrypt comparison; the Official branch returns before any session insert', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/auth/login'"), source.indexOf("app.post('/api/auth/mfa/verify'"));
  assert.match(route, /const valid = user \? await bcrypt\.compare\(password, user\.password_hash\) : await compareAgainstDummyHash\(password\);\s+if \(!user \|\| !valid\)/);
  const official = route.indexOf("if (user.role === 'official') {");
  const insert = route.indexOf('INSERT INTO auth_sessions');
  assert.ok(official > 0 && insert > official, 'the Official branch precedes the only session insert of the login route');
  assert.match(route.slice(official, insert), /response\.status\(202\)\.json\(await beginAdminMfaSignIn\(response, String\(user\.id\)\)\);[\s\S]*?return;\s+\}/);
  // The dummy hash is created once per process (staffCommon), never per request.
  const common = await readFile(new URL('./staffCommon.ts', import.meta.url), 'utf8');
  assert.match(common, /dummyHash \?\?= bcrypt\.hash\(/);
});

test('login: an unapproved Official is refused before any challenge', async () => {
  const memory = freshStore();
  memory.addOfficial('off-1', { status: 'rejected' });
  const outcome = await withUsersLookup(officialRow({ account_status: 'rejected' }), () => login({ loginId: 'off-1', password: PASSWORD, role: 'official' }));
  assert.equal(outcome.status, 403);
  assert.equal(memory.createdChallenges.length, 0);
  assert.deepEqual(outcome.cookies, []);
});

test('login: a missing or invalid key, or missing MFA tables, fail closed with 503 ADMIN_MFA_UNAVAILABLE and no challenge', async () => {
  const memory = freshStore();
  memory.addOfficial('off-1');
  mfa.configureAdminMfaKeyRing(undefined);   // no key file configured
  const noKey = await withUsersLookup(officialRow(), () => login({ loginId: 'off-1', password: PASSWORD, role: 'official' }));
  assert.deepEqual([noKey.status, noKey.body.code], [503, 'ADMIN_MFA_UNAVAILABLE']);
  assert.equal(memory.createdChallenges.length, 0);
  assert.deepEqual(noKey.cookies, []);
  assert.doesNotMatch(JSON.stringify(noKey.body), /ADMIN_MFA_ENCRYPTION_KEY_FILE|\/|key file/i, 'no path or variable name');
  mfa.configureAdminMfaKeyRing({ ok: true, ring: RING });
  mfa.configureAdminMfaStore({
    hasActiveFactor: async () => { throw new store.AdminMfaUnavailableError(); },
    createLoginChallenge: async () => { throw new Error('unreachable'); },
    createEnrolmentChallenge: async () => { throw new Error('unreachable'); },
    verifyLogin: async () => { throw new Error('unreachable'); },
  });
  const noTables = await withUsersLookup(officialRow(), () => login({ loginId: 'off-1', password: PASSWORD, role: 'official' }));
  assert.deepEqual([noTables.status, noTables.body.code], [503, 'ADMIN_MFA_UNAVAILABLE']);
});

// ---------------------------------------------------------------------------------------------
// POST /api/auth/mfa/verify
// ---------------------------------------------------------------------------------------------

test('verify: a valid code creates the session and its evidence; elt_session is set only then; the challenge is single use', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1', { superAdmin: true });
  const token = await startChallenge('off-1');
  const ok = await verify(token, { code: codeAt(secret) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { status: 'signed_in', user: { id: 'off-1', loginId: 'OFF-1', name: 'Official off-1', role: 'official', isSuperAdmin: true } });
  assert.ok(ok.sessionCookie && ok.sessionCookie.length === 43);
  assert.ok(ok.cookies.some((c) => c.startsWith('elt_admin_mfa=; Path=/api/auth/mfa; Max-Age=0')), 'the challenge cookie is cleared');
  const hash = auth.hashSessionToken(ok.sessionCookie!);
  assert.equal(memory.sessions.get(hash), 'off-1', 'the session row belongs to the challenge user');
  assert.deepEqual(memory.evidence, [{ tokenHash: hash, userId: 'off-1', factorId: 'factor-off-1' }], 'evidence for exactly this session');
  assert.ok(memory.events.some((e) => e.action === 'admin_mfa.verified'));
  // Replaying the same challenge cookie is refused, and issues nothing.
  const replay = await verify(token, { code: codeAt(secret, 1) });
  assert.deepEqual([replay.status, replay.body.code, replay.sessionCookie], [410, 'MFA_CHALLENGE_EXPIRED', null]);
});

test('verify: missing or malformed cookie, bad body, extra client fields: refused without touching a challenge', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1');
  const token = await startChallenge('off-1');
  for (const [cookie, body] of [[null, { code: codeAt(secret) }], ['short', { code: codeAt(secret) }], [`${token}x`, { code: codeAt(secret) }]] as const) {
    const outcome = await verify(cookie, body);
    assert.deepEqual([outcome.status, outcome.body.code, outcome.sessionCookie], [410, 'MFA_CHALLENGE_EXPIRED', null]);
  }
  const bodies: unknown[] = [{}, { code: '12345' }, { code: '1234567' }, { code: 123456 }, { code: codeAt(secret), userId: 'off-2' },
    { code: codeAt(secret), role: 'official' }, { code: codeAt(secret), factorId: 'x' }, { code: codeAt(secret), isSuperAdmin: true }, null];
  for (const body of bodies) {
    const outcome = await verify(token, body);
    assert.deepEqual([outcome.status, outcome.body.code, outcome.sessionCookie], [400, 'MFA_CODE_INVALID', null], JSON.stringify(body));
  }
  assert.equal(memory.challenges.get(auth.hashSessionToken(token))!.attempts, 0, 'no attempt was consumed');
});

test('verify: wrong codes use attempts, are audited, and the fifth locks the challenge', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1');
  const token = await startChallenge('off-1');
  const wrong = String((Number(codeAt(secret)) + 500_000) % 1_000_000).padStart(6, '0');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const outcome = await verify(token, { code: wrong });
    assert.deepEqual([outcome.status, outcome.body.code, outcome.body.attemptsRemaining, outcome.sessionCookie], [400, 'MFA_CODE_INVALID', 5 - attempt, null]);
  }
  const fifth = await verify(token, { code: wrong });
  assert.deepEqual([fifth.status, fifth.body.code, fifth.sessionCookie], [429, 'MFA_CHALLENGE_LOCKED', null]);
  assert.ok(fifth.cookies.some((c) => c.includes('Max-Age=0')));
  assert.equal(memory.challenges.get(auth.hashSessionToken(token))!.consumed, 'locked');
  // Even the right code no longer works on the locked challenge.
  assert.equal((await verify(token, { code: codeAt(secret) })).status, 410);
  const rejected = memory.events.filter((e) => e.action === 'admin_mfa.code_rejected');
  assert.equal(rejected.length, 5);
  assert.ok(rejected.every((e) => JSON.stringify(e.details) === '{"outcome":"invalid"}'), 'no code, secret or token in the event');
  assert.equal(memory.sessions.size, 0);
});

test('verify: the per-account throttle (5 failures) holds across challenges and does not use an attempt', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1');
  const wrong = String((Number(codeAt(secret)) + 1) % 1_000_000).padStart(6, '0');
  let failures = 0;
  while (failures < POLICY.throttleFailures) {
    const token = await startChallenge('off-1');
    for (let i = 0; i < 2 && failures < POLICY.throttleFailures; i += 1, failures += 1) assert.equal((await verify(token, { code: wrong })).status, 400);
  }
  const token = await startChallenge('off-1');
  const throttled = await verify(token, { code: codeAt(secret) });
  assert.deepEqual([throttled.status, throttled.body.code, throttled.sessionCookie], [429, 'MFA_THROTTLED', null], 'even a correct code');
  assert.equal(memory.challenges.get(auth.hashSessionToken(token))!.attempts, 0);
  assert.ok(memory.events.some((e) => e.action === 'admin_mfa.throttled'));
  assert.equal(POLICY.throttleWindowSeconds, 900);
});

test('verify: expired, superseded and wrong-purpose challenges are refused; another user cannot complete a challenge', async () => {
  const memory = freshStore();
  const { secret: secret1 } = memory.addOfficial('off-1');
  const { secret: secret2 } = memory.addOfficial('off-2');
  const expiredToken = randomBytes(32).toString('base64url');
  memory.addChallenge(auth.hashSessionToken(expiredToken), 'off-1', { expiresAt: Date.now() - 1 });
  assert.equal((await verify(expiredToken, { code: codeAt(secret1) })).status, 410);
  const stepUpToken = randomBytes(32).toString('base64url');
  memory.addChallenge(auth.hashSessionToken(stepUpToken), 'off-1', { purpose: 'step_up' });
  assert.equal((await verify(stepUpToken, { code: codeAt(secret1) })).status, 410);
  const first = await startChallenge('off-1');
  const second = await startChallenge('off-1');
  assert.equal((await verify(first, { code: codeAt(secret1) })).status, 410, 'a new sign-in supersedes the old challenge');
  // off-2's code against off-1's challenge: the code is checked against off-1's factor only.
  const crossed = await verify(second, { code: codeAt(secret2) });
  assert.ok(crossed.status === 400 && crossed.sessionCookie === null, 'no session for either user');
  const ok = await verify(second, { code: codeAt(secret1) });
  assert.equal(memory.sessions.get(auth.hashSessionToken(ok.sessionCookie!)), 'off-1');
});

test('verify: a TOTP step is used once, including concurrently across two challenges of the same account', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1');
  const a = await startChallenge('off-1');
  const ok = await verify(a, { code: codeAt(secret) });
  assert.equal(ok.status, 200);
  const b = await startChallenge('off-1');
  const replay = await verify(b, { code: codeAt(secret) });
  assert.deepEqual([replay.status, replay.body.code], [400, 'MFA_CODE_INVALID'], 'the same step is replayed');
  assert.ok(memory.events.some((e) => e.action === 'admin_mfa.code_rejected' && e.details.outcome === 'replayed'));
  // Two challenges, the next step, at the same time: exactly one session.
  const c = randomBytes(32).toString('base64url');
  const d = randomBytes(32).toString('base64url');
  memory.addChallenge(auth.hashSessionToken(c), 'off-1');
  memory.addChallenge(auth.hashSessionToken(d), 'off-1');
  const both = await Promise.all([verify(c, { code: codeAt(secret, 1) }), verify(d, { code: codeAt(secret, 1) })]);
  assert.equal(both.filter((o) => o.status === 200).length, 1);
  assert.equal(memory.sessions.size, 2, 'one from the first sign-in, one from the race');
});

test('verify: concurrent attempts on one challenge never exceed five', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1');
  const token = await startChallenge('off-1');
  const wrong = String((Number(codeAt(secret)) + 7) % 1_000_000).padStart(6, '0');
  const outcomes = await Promise.all(Array.from({ length: 9 }, () => verify(token, { code: wrong })));
  assert.equal(memory.challenges.get(auth.hashSessionToken(token))!.attempts, 5);
  assert.equal(outcomes.filter((o) => o.status === 400).length, 4);
  assert.ok(outcomes.filter((o) => o.status !== 400).every((o) => o.status === 429 || o.status === 410));
});

test('verify: a factor disabled, or an account suspended, during sign-in is refused and the challenge closed', async () => {
  for (const change of ['disable', 'suspend'] as const) {
    const memory = freshStore();
    const { secret } = memory.addOfficial('off-1');
    const token = await startChallenge('off-1');
    if (change === 'disable') memory.factors.get('off-1')!.disabled = true;
    else memory.users.get('off-1')!.status = 'rejected';
    const outcome = await verify(token, { code: codeAt(secret) });
    assert.deepEqual([outcome.status, outcome.body.code, outcome.sessionCookie], [410, 'MFA_CHALLENGE_EXPIRED', null], change);
    assert.equal(memory.challenges.get(auth.hashSessionToken(token))!.consumed, 'revoked');
    assert.equal(memory.sessions.size, 0);
  }
});

test('verify: a missing key or an unknown key version fails closed with 503 and changes nothing', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1');
  const token = await startChallenge('off-1');
  mfa.configureAdminMfaKeyRing({ ok: false });
  const noKey = await verify(token, { code: codeAt(secret) });
  assert.deepEqual([noKey.status, noKey.body.code, noKey.sessionCookie], [503, 'ADMIN_MFA_UNAVAILABLE', null]);
  mfa.configureAdminMfaKeyRing({ ok: true, ring: RING });
  memory.factors.get('off-1')!.keyVersion = 2;   // encrypted under v2, which the ring does not hold
  const unknown = await verify(token, { code: codeAt(secret) });
  assert.deepEqual([unknown.status, unknown.body.code, unknown.sessionCookie], [503, 'ADMIN_MFA_UNAVAILABLE', null]);
  const challenge = memory.challenges.get(auth.hashSessionToken(token))!;
  assert.deepEqual([challenge.attempts, challenge.consumed], [0, null], 'rolled back: no attempt used');
  assert.equal(memory.sessions.size, 0);
  assert.doesNotMatch(JSON.stringify([noKey.body, unknown.body]), /MFA_UNKNOWN_KEY_VERSION|key_version|secret/);
});

test('verify: a failure inside the transaction issues no session and no cookie, and leaves the challenge usable', async () => {
  const memory = freshStore();
  const { secret } = memory.addOfficial('off-1');
  const token = await startChallenge('off-1');
  memory.failSessionInsert = true;
  const failed = await verify(token, { code: codeAt(secret) });
  assert.equal(failed.status, 500, 'the generic error handler answers');
  assert.equal(failed.sessionCookie, null);
  assert.ok(!failed.cookies.some((c) => c.startsWith(`${auth.SESSION_COOKIE}=`)));
  assert.deepEqual([memory.sessions.size, memory.evidence.length], [0, 0]);
  assert.deepEqual([memory.challenges.get(auth.hashSessionToken(token))!.consumed, memory.factors.get('off-1')!.lastUsedStep], [null, -1]);
  memory.failSessionInsert = false;
  assert.equal((await verify(token, { code: codeAt(secret) })).status, 200, 'the same code still works after the rollback');
});

test('verify (static): the decrypted secret is always overwritten; no logging; challenge read only from its cookie', async () => {
  const source = await readFile(new URL('./adminMfa.ts', import.meta.url), 'utf8');
  const check = source.slice(source.indexOf('function checkCode('), source.indexOf('export interface AdminMfaVerifyOptions'));
  assert.match(check, /\} finally \{\s+secret\?\.fill\(0\);\s+\}/);
  assert.match(source, /const token = readCookie\(request, ADMIN_MFA_COOKIE\);/);
  assert.doesNotMatch(source, /\bconsole\.|readSecretFile|\.trim\(\)/, 'no logging; the key file is never trimmed or read as a text secret');
  assert.match(source, /\} finally \{\s+raw\.fill\(0\);\s+\}/, 'the raw key file buffer is overwritten');
  assert.doesNotMatch(source, /process\.env\.(?!NODE_ENV)/, 'the key path is read only by loadAdminMfaKeyRing (through its env argument)');
});

// ---------------------------------------------------------------------------------------------
// The real PostgreSQL store against a scripted client (statement order, rollback, COMMIT failure)
// ---------------------------------------------------------------------------------------------

type Reply = { rows?: Record<string, unknown>[]; rowCount?: number } | Error;

function scriptedStore(overrides: Array<[RegExp, Reply]> = []) {
  const log: string[] = [];
  const replies: Array<[RegExp, Reply]> = [
    ...overrides,
    [/^(BEGIN|COMMIT|ROLLBACK)$/, {}],
    [/^SELECT user_id, purpose FROM admin_mfa_challenges/, { rows: [{ user_id: 'u1', purpose: 'login' }] }],
    [/^SELECT pg_advisory_xact_lock/, {}],
    [/^SELECT user_id, purpose, attempts/, { rows: [{ user_id: 'u1', purpose: 'login', attempts: 0, consumed_at: null, live: true }] }],
    [/^SELECT count\(\*\)::int AS failures/, { rows: [{ failures: 0 }] }],
    [/^UPDATE admin_mfa_challenges SET attempts/, { rows: [{ attempts: 1 }] }],
    [/^SELECT id, login_id/, { rows: [{ id: 'u1', login_id: 'U1', display_name: 'U', role: 'official', account_status: 'approved', is_super_admin: true }] }],
    [/^SELECT id, key_version/, { rows: [{ id: 'f1', key_version: 1, secret_ciphertext: Buffer.alloc(20), secret_nonce: Buffer.alloc(12), secret_tag: Buffer.alloc(16), last_used_step: '41' }] }],
    [/^UPDATE admin_mfa_factors SET last_used_step/, { rowCount: 1 }],
    [/^UPDATE admin_mfa_challenges SET consumed_at/, { rowCount: 1 }],
    [/^INSERT INTO/, { rowCount: 1 }],
    [/^UPDATE admin_mfa_challenges SET consumed_at = now\(\), consumed_reason = 'superseded'/, { rowCount: 0 }],
  ];
  let released: boolean | undefined;
  const client = {
    async query(text: string) {
      const sql = text.replace(/\s+/g, ' ').trim();
      log.push(sql);
      const reply = replies.find(([pattern]) => pattern.test(sql))?.[1];
      if (!reply) throw new Error(`unscripted: ${sql.slice(0, 60)}`);
      if (reply instanceof Error) throw reply;
      return { rows: reply.rows ?? [], rowCount: reply.rowCount ?? reply.rows?.length ?? 0 };
    },
    release(destroy?: boolean) { released = destroy === true; },
  };
  const pgStore = store.createPostgresAdminMfaStore({ connect: async () => client as unknown as PoolClient });
  return { pgStore, log, wasDestroyed: () => released };
}
type CodeCheck = (factor: StoredTotpFactor) => import('./adminMfaStore.js').AdminMfaCodeDecision;
const accept: CodeCheck = () => ({ outcome: 'accept', step: 42 });
const verifyInput = (check: CodeCheck = accept) => ({ challengeId: 'c'.repeat(64), sessionTokenHash: 's'.repeat(64), sessionSeconds: 43_200, check });
const kinds = (log: string[]) => log.map((sql) => sql.split(' ').slice(0, 3).join(' '));

test('store: a successful verification is one transaction, in the approved order, ending with COMMIT', async () => {
  const { pgStore, log } = scriptedStore();
  const result = await pgStore.verifyLogin(verifyInput());
  assert.equal(result.status, 'signed_in');
  const order = [
    /^BEGIN$/, /^SELECT user_id, purpose FROM admin_mfa_challenges WHERE id = \$1$/, /^SELECT pg_advisory_xact_lock\(\$1, hashtext\(\$2\)\)$/,
    /FROM admin_mfa_challenges WHERE id = \$1 FOR UPDATE$/, /action = 'admin_mfa\.code_rejected'/, /^UPDATE admin_mfa_challenges SET attempts = attempts \+ 1 .* attempts < \$2 RETURNING attempts$/,
    /^SELECT id, login_id, display_name, role, account_status, is_super_admin FROM users WHERE id = \$1$/,
    /FROM admin_mfa_factors WHERE user_id = \$1 AND kind = 'totp' AND confirmed_at IS NOT NULL AND disabled_at IS NULL FOR UPDATE$/,
    /^UPDATE admin_mfa_factors SET last_used_step = \$2 WHERE id = \$1 AND disabled_at IS NULL AND confirmed_at IS NOT NULL AND last_used_step < \$2$/,
    /^UPDATE admin_mfa_challenges SET consumed_at = now\(\), consumed_reason = 'verified' WHERE id = \$1 AND consumed_at IS NULL$/,
    /^INSERT INTO auth_sessions \(token_hash, user_id, expires_at\)/, /^INSERT INTO auth_session_mfa_verifications .* VALUES \(\$1, \$2, \$3, 'login', 'totp', \$4\)$/,
    /^INSERT INTO auth_verification_events/, /^COMMIT$/,
  ];
  assert.equal(log.length, order.length, kinds(log).join(' | '));
  order.forEach((pattern, index) => assert.match(log[index], pattern, `statement ${index}`));
});

test('store: the factor passed to the check is the stored, still-encrypted factor of the challenge user', async () => {
  const { pgStore } = scriptedStore();
  let seen: StoredTotpFactor | undefined;
  await pgStore.verifyLogin({ ...verifyInput(), check: (factor) => { seen = factor; return accept(factor); } });
  assert.deepEqual(seen && { id: seen.id, userId: seen.userId, keyVersion: seen.keyVersion, lastUsedStep: seen.lastUsedStep, sizes: [seen.ciphertext.length, seen.nonce.length, seen.tag.length] },
    { id: 'f1', userId: 'u1', keyVersion: 1, lastUsedStep: 41, sizes: [20, 12, 16] });
});

test('store: an injected failure after the challenge is consumed, or at session creation, rolls everything back', async () => {
  for (const failing of [/^INSERT INTO auth_sessions/, /^INSERT INTO auth_session_mfa_verifications/, /^INSERT INTO auth_verification_events/, /^UPDATE admin_mfa_challenges SET consumed_at = now\(\), consumed_reason = 'verified'/]) {
    const { pgStore, log, wasDestroyed } = scriptedStore([[failing, new Error('injected')]]);
    await assert.rejects(pgStore.verifyLogin(verifyInput()), /injected/);
    assert.equal(log.at(-1), 'ROLLBACK', String(failing));
    assert.ok(!log.includes('COMMIT'), 'never committed');
    assert.equal(wasDestroyed(), true, 'the failed client is discarded');
  }
});

test('store: a COMMIT failure is a complete failure (rolled back, error raised)', async () => {
  const { pgStore, log } = scriptedStore([[/^COMMIT$/, new Error('commit failed')]]);
  await assert.rejects(pgStore.verifyLogin(verifyInput()), /commit failed/);
  assert.deepEqual(log.slice(-2), ['COMMIT', 'ROLLBACK']);
});

test('store: a throwing check (missing key) rolls back the reserved attempt', async () => {
  const { pgStore, log } = scriptedStore();
  await assert.rejects(pgStore.verifyLogin(verifyInput(() => { throw new Error('no key'); })), /no key/);
  assert.ok(log.some((sql) => sql.startsWith('UPDATE admin_mfa_challenges SET attempts')));
  assert.equal(log.at(-1), 'ROLLBACK');
  assert.ok(!log.includes('COMMIT'));
});

test('store: a rejected code commits only the attempt and the audit event; replay at the guard is a rejection', async () => {
  const rejected = scriptedStore();
  assert.deepEqual(await rejected.pgStore.verifyLogin(verifyInput(() => ({ outcome: 'reject', reason: 'invalid' }))), { status: 'invalid_code', attemptsRemaining: 4 });
  assert.ok(!rejected.log.some((sql) => /INSERT INTO auth_sessions|INSERT INTO auth_session_mfa|SET last_used_step|consumed_reason = 'verified'/.test(sql)));
  assert.ok(rejected.log.some((sql) => sql.startsWith('INSERT INTO auth_verification_events')));
  assert.equal(rejected.log.at(-1), 'COMMIT');
  const replayed = scriptedStore([[/^UPDATE admin_mfa_factors SET last_used_step/, { rowCount: 0 }]]);
  assert.deepEqual(await replayed.pgStore.verifyLogin(verifyInput()), { status: 'invalid_code', attemptsRemaining: 4 });
  assert.ok(!replayed.log.some((sql) => /INSERT INTO auth_sessions/.test(sql)));
});

test('store: throttled, locked, expired, wrong purpose and ineligible paths create no session', async () => {
  const cases: Array<[Array<[RegExp, Reply]>, string]> = [
    [[[/^SELECT count\(\*\)::int AS failures/, { rows: [{ failures: 5 }] }]], 'throttled'],
    [[[/^UPDATE admin_mfa_challenges SET attempts/, { rows: [] }]], 'locked'],
    [[[/^SELECT user_id, purpose FROM admin_mfa_challenges/, { rows: [] }]], 'expired'],
    [[[/^SELECT user_id, purpose FROM admin_mfa_challenges/, { rows: [{ user_id: 'u1', purpose: 'step_up' }] }]], 'expired'],
    [[[/^SELECT user_id, purpose, attempts/, { rows: [{ user_id: 'u1', purpose: 'login', attempts: 0, consumed_at: null, live: false }] }]], 'expired'],
    [[[/^SELECT user_id, purpose, attempts/, { rows: [{ user_id: 'u1', purpose: 'login', attempts: 0, consumed_at: 'x', live: true }] }]], 'expired'],
    [[[/^SELECT id, login_id/, { rows: [{ id: 'u1', role: 'official', account_status: 'rejected' }] }]], 'not_eligible'],
    [[[/^SELECT id, key_version/, { rows: [] }]], 'not_eligible'],
  ];
  for (const [overrides, status] of cases) {
    const { pgStore, log } = scriptedStore(overrides);
    assert.equal((await pgStore.verifyLogin(verifyInput())).status, status);
    assert.ok(!log.some((sql) => /INSERT INTO auth_sessions|INSERT INTO auth_session_mfa/.test(sql)), status);
    assert.equal(log.at(-1), 'COMMIT', `${status}: its attempt or event is kept`);
  }
});

test('store: missing MFA tables (42P01) become AdminMfaUnavailableError; challenge creation supersedes under the user lock', async () => {
  const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  const { pgStore } = scriptedStore([[/^SELECT 1 FROM admin_mfa_factors/, missing]]);
  await assert.rejects(pgStore.hasActiveFactor('u1'), store.AdminMfaUnavailableError);
  const created = scriptedStore();
  await created.pgStore.createLoginChallenge({ challengeId: 'c'.repeat(64), userId: 'u1', ttlSeconds: 300 });
  assert.deepEqual(kinds(created.log), ['BEGIN', 'SELECT pg_advisory_xact_lock($1, hashtext($2))', 'UPDATE admin_mfa_challenges SET', 'INSERT INTO admin_mfa_challenges', 'INSERT INTO auth_verification_events', 'COMMIT']);
  assert.match(created.log[3], /VALUES \(\$1, \$2, 'login', clock_timestamp\(\) \+ \(\$3 \* interval '1 second'\)\)$/);
  const enrolment = scriptedStore();
  await enrolment.pgStore.createEnrolmentChallenge({ challengeId: 'e'.repeat(64), userId: 'u1', ttlSeconds: 300 });
  assert.deepEqual(kinds(enrolment.log), ['BEGIN', 'SELECT pg_advisory_xact_lock($1, hashtext($2))', 'UPDATE admin_mfa_challenges SET', 'INSERT INTO admin_mfa_challenges', 'INSERT INTO auth_verification_events', 'COMMIT']);
  assert.match(enrolment.log[3], /VALUES \(\$1, \$2, 'enrol', clock_timestamp\(\) \+ \(\$3 \* interval '1 second'\)\)$/);
});

// ---------------------------------------------------------------------------------------------
// Central authorization (the real authenticateRequest, stubbed pool)
// ---------------------------------------------------------------------------------------------

async function authenticateAs(row: Record<string, unknown> | null, options: { surface?: import('./surface.js').Surface; requirement?: import('./auth.js').SessionRequirement; mfa?: unknown } = {}) {
  const original = pool.query.bind(pool);
  const statements: string[] = [];
  (pool as unknown as { query: unknown }).query = async (text: string) => {
    statements.push(text);
    if (text.includes('auth_session_mfa_verifications')) {
      if (options.mfa instanceof Error) throw options.mfa;
      return { rows: row ? [{ official_mfa_verified: options.mfa ?? row.official_mfa_verified }] : [] };
    }
    if (text.includes('FROM auth_sessions s')) return { rows: row ? [row] : [] };
    throw new Error('unexpected query');
  };
  const token = 'Z'.repeat(43);
  const request = { headers: { cookie: `${auth.SESSION_COOKIE}=${token}` } } as unknown as import('./auth.js').AuthenticatedRequest;
  const surfaceName = options.surface ?? 'admin';
  auth.setTrustedRequestSurface(request, surfaceName, surface.expectedOrigin(surfaceName));
  const outcome = { status: 200, body: undefined as unknown, cleared: false };
  const response = {
    status(code: number) { outcome.status = code; return response; },
    json(body: unknown) { outcome.body = body; return response; },
    clearCookie() { outcome.cleared = true; return response; },
  };
  try {
    const ok = await auth.authenticateRequest(request, response as unknown as Response, options.requirement ?? 'session');
    return { ok, ...outcome, statements, user: request.user };
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
}

const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'off-1', login_id: 'OFF-1', display_name: 'Official', role: 'official', account_status: 'approved', is_super_admin: false,
  session_verified_at: null, iv_institution_id: null, official_mfa_verified: true, ...overrides,
});

test('central: an Official session needs MFA evidence; password-only and legacy sessions are refused and their cookie cleared', async () => {
  const verified = await authenticateAs(sessionRow());
  assert.equal(verified.ok, true);
  assert.equal(verified.user?.id, 'off-1');
  for (const mfaValue of [false, null, undefined, 'true', 1]) {
    const refused = await authenticateAs(sessionRow({ official_mfa_verified: mfaValue }), { mfa: mfaValue });
    assert.equal(refused.ok, false, String(mfaValue));
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, { error: 'Administrative access requires multi-factor authentication. Please sign in again.', code: 'ADMIN_MFA_REQUIRED' });
    assert.equal(refused.cleared, true);
  }
});

test('central: missing MFA tables refuse Officials; any other MFA query error propagates and never grants access', async () => {
  const missing = await authenticateAs(sessionRow(), { mfa: Object.assign(new Error('missing'), { code: '42P01' }) });
  assert.deepEqual([missing.ok, missing.status], [false, 403]);
  await assert.rejects(authenticateAs(sessionRow(), { mfa: new Error('connection lost') }), /connection lost/);
});

test('central: Super Admin flag, suspension and revocation are re-read on every request', async () => {
  const superAdmin = await authenticateAs(sessionRow({ is_super_admin: true }), { requirement: 'super_admin' });
  assert.equal(superAdmin.ok, true);
  const demoted = await authenticateAs(sessionRow({ is_super_admin: false }), { requirement: 'super_admin' });
  assert.deepEqual([demoted.ok, demoted.status], [false, 403]);
  const suspended = await authenticateAs(sessionRow({ account_status: 'rejected' }));
  assert.deepEqual([suspended.ok, suspended.status], [false, 403]);
  const revoked = await authenticateAs(null);   // revoked or expired: the session query finds nothing
  assert.deepEqual([revoked.ok, revoked.status], [false, 401]);
});

test('central: Student and Institute sessions never issue the Official MFA query and keep their decisions', async () => {
  const verifiedFields = { session_verified_at: '2026-11-01T00:00:00.000Z', iv_institution_id: 'i1', iv_mobile_verified_at: 'x', iv_email_verified_at: 'x', iv_institutional_status: 'verified', iv_suspended_at: null };
  const candidate = await authenticateAs(sessionRow({ role: 'candidate', official_mfa_verified: false, ...verifiedFields }), { surface: 'exam', mfa: new Error('must not run') });
  assert.equal(candidate.ok, true);
  assert.ok(!candidate.statements.some((s) => s.includes('auth_session_mfa_verifications')));
  const center = await authenticateAs(sessionRow({ role: 'center', official_mfa_verified: false, ...verifiedFields }), { surface: 'institution', mfa: new Error('must not run') });
  assert.equal(center.ok, true);
  assert.ok(!center.statements.some((s) => s.includes('auth_session_mfa_verifications')));
  const unverifiedStudent = await authenticateAs(sessionRow({ role: 'candidate', session_verified_at: null }), { surface: 'exam' });
  assert.deepEqual([unverifiedStudent.ok, (unverifiedStudent.body as { code: string }).code], [false, 'STUDENT_VERIFICATION_REQUIRED']);
});

test('central (static): the Official MFA query is separate from the shared session query and checks session, evidence and factor', async () => {
  const source = await readFile(new URL('./auth.ts', import.meta.url), 'utf8');
  const shared = source.slice(source.indexOf('const SESSION_WITH_VERIFICATION_SQL'), source.indexOf('const SESSION_LEGACY_SQL'));
  assert.doesNotMatch(shared, /admin_mfa|auth_session_mfa/, 'a missing MFA table can never break Student or Institute sign-in');
  const official = source.slice(source.indexOf('const OFFICIAL_MFA_SQL'), source.indexOf('async function officialMfaVerified'));
  for (const fragment of ["v.purpose IN ('login', 'enrol')", 'f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL', 'v.token_hash = s.token_hash AND v.user_id = s.user_id',
    's.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()']) {
    assert.ok(official.includes(fragment), fragment);
  }
  assert.match(source, /if \(rows\[0\]\.role === 'official'\) verification\.officialMfaVerified = await officialMfaVerified\(tokenHash\);/);
});

test('routing (static): /api/auth/mfa/verify is Admin-only, login class, with the per-address limiter; no MFA bypass exists', async () => {
  const policy = surface.ROUTE_POLICY.find((e) => e.method === 'POST' && e.path === '/api/auth/mfa/verify');
  assert.ok(policy);
  assert.deepEqual(policy.access, { marketing: { decision: 'deny' }, exam: { decision: 'deny' }, institution: { decision: 'deny' }, admin: { decision: 'allow', auth: 'login' } });
  for (const path of ['/api/auth/mfa/enrol/start', '/api/auth/mfa/enrol/confirm']) {
    const enrolmentPolicy = surface.ROUTE_POLICY.find((entry) => entry.method === 'POST' && entry.path === path);
    assert.ok(enrolmentPolicy, `${path} has an explicit surface policy`);
    assert.deepEqual(enrolmentPolicy.access, { marketing: { decision: 'deny' }, exam: { decision: 'deny' }, institution: { decision: 'deny' }, admin: { decision: 'allow', auth: 'login' } });
  }
  const index = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(index, /app\.post\('\/api\/auth\/mfa\/verify', authLimiter, createAdminMfaVerifyHandler\(\)\);/);
  assert.match(index, /app\.post\('\/api\/auth\/mfa\/enrol\/start', authLimiter, createAdminMfaEnrolStartHandler\(\)\);/);
  assert.match(index, /app\.post\('\/api\/auth\/mfa\/enrol\/confirm', authLimiter, createAdminMfaEnrolConfirmHandler\(\)\);/);
  for (const name of ['adminMfa.ts', 'adminMfaStore.ts', 'auth.ts', 'index.ts']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:skip|bypass|disable)_?(?:admin_?)?mfa|MFA_(?:BYPASS|DISABLED|OPTIONAL)|ADMIN_MFA_ENFORCE/i, `${name}: no MFA switch or bypass`);
  }
});

test('cleanup: restore default MFA wiring', () => {
  mfa.configureAdminMfaStore(undefined);
  mfa.configureAdminMfaKeyRing(undefined);
});
