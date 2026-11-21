// AUTH-1: persistence for verification challenges, verified contacts, verified sessions, institute
// verification state, Google links and OAuth state. Tables come from authVerificationMigration.sql
// and (AUTH C1) studentRegistrationClaimsMigration.sql. Missing tables map to
// VerificationStoreUnavailableError.
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isUndefinedTableError } from './staffCommon.js';
import type { VerificationPurpose } from './verificationProviders.js';

export type ContactChannel = 'sms' | 'email';

export interface VerificationChallenge {
  /** SHA-256 of the opaque token held in the verification cookie. */
  id: string;
  purpose: VerificationPurpose;
  /**
   * The account the challenge belongs to. NULL only for a claim-backed Student registration
   * (AUTH C1): exactly one of userId and registrationClaimId is set (database CHECK).
   */
  userId: string | null;
  /** AUTH C1: the pending registration claim (purpose 'student_registration' only). */
  registrationClaimId?: string | null;
  channel: ContactChannel;
  destination: string | null;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  attempts: number;
  sendCount: number;
  lastSentAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
}

export interface InstituteVerificationState {
  mobileDestination: string | null;
  mobileVerifiedAt: Date | null;
  emailDestination: string | null;
  emailVerifiedAt: Date | null;
  institutionalStatus: 'pending' | 'verified' | 'rejected';
  suspendedAt: Date | null;
}

export interface PortalUserRecord {
  id: string;
  loginId: string;
  role: 'candidate' | 'center' | 'official';
  accountStatus: string;
  contactEmail: string | null;
}

export interface AuthVerificationEvent {
  action: string;
  userId: string | null;
  details?: Record<string, unknown>;
}

export interface OAuthState {
  stateHash: string;
  nonce: string;
  codeVerifier: string;
  intent: 'login' | 'link';
  userId: string | null;
  expiresAt: Date;
}

/** Super Admin decisions on institutional verification and suspension (separate from Official approval). */
export type InstitutionalAction = 'verify' | 'reject' | 'suspend' | 'restore';
export const INSTITUTIONAL_ACTIONS: readonly InstitutionalAction[] = Object.freeze(['verify', 'reject', 'suspend', 'restore']);
/** Audit action names written to auth_verification_events (user_id = the target institution). */
export const INSTITUTIONAL_EVENT_ACTIONS: Readonly<Record<InstitutionalAction, string>> = Object.freeze({
  verify: 'institute.institutional_verified',
  reject: 'institute.institutional_rejected',
  suspend: 'institute.suspended',
  restore: 'institute.suspension_lifted',
});

export interface InstituteVerificationOverview {
  institutionId: string;
  loginId: string;
  name: string;
  /** Official approval (users.account_status): reported only, never changed by these decisions. */
  accountStatus: string;
  state: InstituteVerificationState;
  institutionalDecidedAt: Date | null;
}

export interface InstitutionalDecisionEvent {
  id: string;
  occurredAt: Date;
  action: string;
  institutionId: string | null;
  actorId: string | null;
  reason: string | null;
}

export type InstitutionalDecisionResult =
  | { status: 'applied'; state: InstituteVerificationState }
  | { status: 'not_found' }
  | { status: 'invalid_transition'; state: InstituteVerificationState };

export const DEFAULT_INSTITUTE_STATE: Readonly<InstituteVerificationState> = Object.freeze({
  mobileDestination: null, mobileVerifiedAt: null, emailDestination: null, emailVerifiedAt: null, institutionalStatus: 'pending', suspendedAt: null,
});

/**
 * Pure transition rule. verify/reject move institutional_status to a DIFFERENT value; suspend needs
 * an unsuspended institute and restore a suspended one. Anything else is refused (no silent no-op).
 */
export function nextInstitutionalState(current: InstituteVerificationState, action: InstitutionalAction, now: Date): InstituteVerificationState | null {
  switch (action) {
    case 'verify': return current.institutionalStatus === 'verified' ? null : { ...current, institutionalStatus: 'verified' };
    case 'reject': return current.institutionalStatus === 'rejected' ? null : { ...current, institutionalStatus: 'rejected' };
    case 'suspend': return current.suspendedAt ? null : { ...current, suspendedAt: now };
    case 'restore': return current.suspendedAt ? { ...current, suspendedAt: null } : null;
  }
}

export interface AuthVerificationStore {
  findPortalUser(userId: string): Promise<PortalUserRecord | null>;
  createChallenge(challenge: Omit<VerificationChallenge, 'attempts' | 'sendCount' | 'consumedAt' | 'codeHash' | 'codeExpiresAt' | 'lastSentAt'>, event: AuthVerificationEvent): Promise<void>;
  getChallenge(id: string): Promise<VerificationChallenge | null>;
  setChallengeDestination(id: string, destination: string): Promise<void>;
  /**
   * New code for a (re)send: increments send_count; attempts are NOT reset by a resend. Applies only
   * while the challenge is unconsumed AND still has the send_count and destination the caller
   * checked (compare-and-set), so concurrent sends cannot exceed the cap or target another number.
   * False when it did not apply; the caller must then NOT deliver the code.
   */
  recordSend(id: string, codeHash: string, codeExpiresAt: Date, now: Date, expected: { sendCount: number; destination: string }): Promise<boolean>;
  /**
   * Atomically uses one verification attempt BEFORE the code is compared (attempts < maxAttempts and
   * unconsumed). Returns the new attempt count, or null when none is left, so concurrent guesses
   * cannot exceed the limit.
   */
  reserveAttempt(id: string, maxAttempts: number): Promise<number | null>;
  invalidateChallenge(id: string, now: Date, event: AuthVerificationEvent): Promise<void>;
  countChallengesSince(userId: string, since: Date): Promise<number>;
  findVerifiedContact(userId: string, channel: ContactChannel): Promise<string | null>;
  /**
   * Student accounts (users.role = 'candidate') whose VERIFIED mobile contact is this number, at most
   * `limit` ids. Used only to detect ambiguity in mobile sign-in; no cross-account uniqueness exists.
   */
  findCandidateIdsByVerifiedMobile(mobile: string, limit: number): Promise<string[]>;
  /**
   * Consumes the challenge (single use), stores the verified mobile and issues the portal session
   * together with its verification record, in ONE transaction. False if already consumed.
   *
   * AUTH C1: the write of the verified mobile is serialized per number (transaction-level advisory
   * lock, studentMobileLockKey) with Student registration completion. When `mobileFirstLoginId` is
   * given (mobile capture), the capture is refused with 'mobile_in_use' if ANOTHER Student account
   * already has that mobile-derived login ID (approved rule: refuse only against mobile-first
   * accounts); the challenge is then consumed and no contact or session is written.
   */
  completeStudentVerification(input: { challengeId: string; userId: string; destination: string; sessionTokenHash: string; sessionExpiresAt: Date; now: Date; mobileFirstLoginId?: string }): Promise<boolean | 'mobile_in_use'>;
  /** Consumes a Student email-capture challenge and records the newly verified address atomically. */
  completeStudentEmailVerification(input: { challengeId: string; userId: string; destination: string; now: Date }): Promise<boolean>;
  getInstituteVerification(institutionId: string): Promise<InstituteVerificationState | null>;
  /** Consumes the challenge and records ONE channel (mobile or email) as verified. False if already consumed. */
  completeInstituteContactVerification(input: { challengeId: string; institutionId: string; channel: ContactChannel; destination: string; now: Date }): Promise<boolean>;
  findUserIdByGoogleSub(sub: string): Promise<string | null>;
  linkGoogleIdentity(userId: string, sub: string, email: string, now: Date): Promise<'linked' | 'sub_taken' | 'user_has_link'>;
  createOAuthState(state: OAuthState): Promise<void>;
  /** Single use: returns the state only the first time and only before expiry. */
  consumeOAuthState(stateHash: string, now: Date): Promise<OAuthState | null>;
  recordEvent(event: AuthVerificationEvent): Promise<void>;
  /** Every Institute (users.role = 'center') with its verification state; a missing row reads as the defaults. */
  listInstituteVerificationOverview(limit: number): Promise<InstituteVerificationOverview[]>;
  /**
   * Applies one Super Admin decision in ONE transaction: locks the state row (created with defaults if
   * absent), checks the transition, updates the existing columns and appends the audit event with
   * actor, target, action and reason. Never touches users.account_status.
   */
  decideInstitutional(input: { institutionId: string; actorId: string; action: InstitutionalAction; reason: string; now: Date }): Promise<InstitutionalDecisionResult>;
  listInstitutionalDecisions(limit: number): Promise<InstitutionalDecisionEvent[]>;
}

// ---------------------------------------------------------------------------
// AUTH C1: Student registration claims and SMS send reservations
// ---------------------------------------------------------------------------

export interface StudentRegistrationClaim {
  id: string;
  /** Normalised E.164 (+91) mobile. */
  mobile: string;
  displayName: string;
  /** bcrypt hash; the plaintext password is never stored. */
  passwordHash: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * completed: account, verified contact, session and session verification were written, and the claim
 *   was deleted (its challenge with it, by cascade) in the same transaction.
 * refused: the mobile already belongs to a Student (verified contact or mobile-derived login ID);
 *   only the challenge consumption, the claim's consumed_at (dead) and an audit event were written.
 * expired: the claim has expired; nothing but the challenge consumption was written.
 * A database error is thrown instead (never a result): everything is rolled back and the same
 * challenge can be verified again.
 * not_in_progress: the challenge was already consumed, expired, or the claim no longer exists.
 */
export type StudentRegistrationResult = 'completed' | 'refused' | 'expired' | 'not_in_progress';

export interface StudentRegistrationStore {
  /** Inserts a pending claim. Claims are NOT exclusive: any number may exist for one mobile. */
  createClaim(claim: StudentRegistrationClaim): Promise<void>;
  /**
   * Completes a verified registration in ONE transaction: locks the claim, consumes the challenge,
   * serializes on the mobile (studentMobileLockKey), refuses generically if a Student already owns the
   * mobile, inserts the account (ON CONFLICT on the unique login_id refuses), the verified contact,
   * the session and its verification record, and deletes the claim (AUTH C1.1). A refusal marks the
   * claim consumed. Any error rolls everything back.
   */
  completeRegistration(input: {
    challengeId: string; claimId: string; destination: string; userId: string; loginId: string;
    sessionTokenHash: string; sessionExpiresAt: Date; now: Date;
  }): Promise<StudentRegistrationResult>;
  /**
   * Deletes at most `limit` claims that are expired OR consumed (refused), and have no live challenge
   * (unconsumed and unexpired), skipping claims locked by a completion in progress. Idempotent.
   * Returns the number deleted. (Name kept from AUTH C1; it also removes consumed claims.)
   */
  deleteExpiredClaims(now: Date, limit: number): Promise<number>;
}

/**
 * AUTH C1.1-b: destination bucket of one SMS (decided by the server at send time). 'account' (C-1) is an
 * approved Institute's own recorded mobile: keyed per (account, destination), it counts towards the
 * shared daily total but NOT the anonymous (unverified) daily cap.
 */
export type SmsBucket = 'verified' | 'unverified' | 'account';

export type SmsSendReservation = 'reserved' | 'destination_limited' | 'daily_limited' | 'unverified_daily_limited';

export interface SmsSendReservationInput {
  /** Random id: the reservation event's id, also carried by the later code_sent / delivery_failed events. */
  reservationId: string;
  /** Keyed hash of the destination (never the number). */
  destinationKey: string;
  bucket: SmsBucket;
  purpose: VerificationPurpose;
  /** The limit of THIS bucket (per destination, rolling window). */
  destinationWindowMs: number;
  destinationMaxSends: number;
  /** All SMS, every purpose and bucket, rolling 24 hours. */
  dailyMaxSends: number;
  /** Unverified-bucket SMS, rolling 24 hours (never above dailyMaxSends). */
  dailyMaxUnverifiedSends: number;
}

export interface SmsUsage {
  /** Reservations in the last 24 hours, all buckets. */
  total: number;
  /** Of which unverified (C1 reservations without a bucket count as unverified: they were registration).
   *  Account-bucket reservations are never included here. */
  unverified: number;
}

export interface SmsSendGuardStore {
  /**
   * Atomically checks the shared rolling 24-hour total, the rolling 24-hour unverified cap (unverified
   * bucket only) and this bucket's per-destination window, and records one reservation (append-only
   * audit event: bucket, purpose and keyed destination hash only) when all allow it. All reservations
   * are serialized, so parallel requests cannot exceed any limit. A refusal is recorded with its reason.
   */
  reserveSmsSend(input: SmsSendReservationInput): Promise<SmsSendReservation>;
  /** ADVISORY read of the last 24 hours (no lock): only for early fail-closed answers, never enforcement. */
  smsUsageLast24h(): Promise<SmsUsage>;
  /** ADVISORY (C-2): reservations of one destination key in one bucket within the window (no lock). */
  smsDestinationUsage(input: { destinationKey: string; bucket: SmsBucket; windowMs: number }): Promise<number>;
}

/** Signed 64-bit advisory-lock key (decimal string) for a label; domain-separated by the label prefix. */
function advisoryKey(label: string): string {
  return createHash('sha256').update(label).digest().readBigInt64BE(0).toString();
}

/**
 * AUTH C1: the transaction-level advisory lock that serializes every write of a verified Student
 * mobile (registration completion and mobile capture) for one number.
 */
export function studentMobileLockKey(mobile: string): string {
  return advisoryKey(`eltnoy.auth.student-mobile:${mobile}`);
}

/** AUTH C1: serializes all SMS send reservations (daily budget and destination limits). */
export const SMS_SEND_RESERVATION_LOCK_KEY = advisoryKey('eltnoy.auth.sms-send-reservations');

export class VerificationStoreUnavailableError extends Error {
  constructor() {
    super('Verification tables are not installed.');
    this.name = 'VerificationStoreUnavailableError';
  }
}

interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<PoolClient>;
}

const date = (value: unknown) => (value === null || value === undefined ? null : new Date(String(value)));

function toInstituteState(row: Record<string, unknown> | undefined): InstituteVerificationState {
  if (!row || row.institution_id === null || row.institution_id === undefined) return { ...DEFAULT_INSTITUTE_STATE };
  return {
    mobileDestination: row.mobile_destination === null ? null : String(row.mobile_destination), mobileVerifiedAt: date(row.mobile_verified_at),
    emailDestination: row.email_destination === null ? null : String(row.email_destination), emailVerifiedAt: date(row.email_verified_at),
    institutionalStatus: row.institutional_status as InstituteVerificationState['institutionalStatus'], suspendedAt: date(row.suspended_at),
  };
}

/** Rolls the decision transaction back (including a row created only for it) and reports the state. */
class InstitutionalTransitionRefused extends Error {
  constructor(public readonly state: InstituteVerificationState) { super('institutional transition refused'); }
}

function toChallenge(row: Record<string, unknown>): VerificationChallenge {
  return {
    id: String(row.id), purpose: row.purpose as VerificationPurpose,
    userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
    registrationClaimId: row.registration_claim_id === null || row.registration_claim_id === undefined ? null : String(row.registration_claim_id),
    channel: row.channel as ContactChannel,
    destination: row.destination === null ? null : String(row.destination),
    codeHash: row.code_hash === null ? null : String(row.code_hash), codeExpiresAt: date(row.code_expires_at),
    attempts: Number(row.attempts), sendCount: Number(row.send_count), lastSentAt: date(row.last_sent_at),
    consumedAt: date(row.consumed_at), expiresAt: new Date(String(row.expires_at)),
  };
}

export function createPostgresAuthVerificationStore(pool: QueryablePool): AuthVerificationStore {
  async function run<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (isUndefinedTableError(error)) throw new VerificationStoreUnavailableError();
      throw error;
    }
  }
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUndefinedTableError(error)) throw new VerificationStoreUnavailableError();
      throw error;
    } finally {
      client.release();
    }
  }
  const event = (db: QueryablePool | PoolClient, e: AuthVerificationEvent) => db.query(
    'INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ($1, $2, $3, $4::jsonb)',
    [randomUUID(), e.action, e.userId, JSON.stringify(e.details ?? {})],
  );

  return {
    findPortalUser: (userId) => run(async () => {
      const { rows } = await pool.query('SELECT id, login_id, role, account_status, contact_email FROM users WHERE id = $1', [userId]);
      return rows[0] ? {
        id: String(rows[0].id), loginId: String(rows[0].login_id), role: rows[0].role as PortalUserRecord['role'],
        accountStatus: String(rows[0].account_status), contactEmail: rows[0].contact_email === null ? null : String(rows[0].contact_email),
      } : null;
    }),
    createChallenge: (c, e) => transaction(async (client) => {
      await client.query(
        'INSERT INTO verification_challenges (id, purpose, user_id, registration_claim_id, channel, destination, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [c.id, c.purpose, c.userId, c.registrationClaimId ?? null, c.channel, c.destination, c.expiresAt],
      );
      await event(client, e);
    }),
    getChallenge: (id) => run(async () => {
      const { rows } = await pool.query('SELECT * FROM verification_challenges WHERE id = $1', [id]);
      return rows[0] ? toChallenge(rows[0]) : null;
    }),
    setChallengeDestination: (id, destination) => run(async () => {
      await pool.query('UPDATE verification_challenges SET destination = $2 WHERE id = $1 AND consumed_at IS NULL AND destination IS NULL', [id, destination]);
    }),
    recordSend: (id, codeHash, codeExpiresAt, now, expected) => run(async () => {
      const result = await pool.query(
        `UPDATE verification_challenges SET code_hash = $2, code_expires_at = $3, send_count = send_count + 1, last_sent_at = $4
         WHERE id = $1 AND consumed_at IS NULL AND send_count = $5 AND destination = $6`,
        [id, codeHash, codeExpiresAt, now, expected.sendCount, expected.destination],
      );
      return result.rowCount === 1;
    }),
    reserveAttempt: (id, maxAttempts) => run(async () => {
      const { rows } = await pool.query(
        'UPDATE verification_challenges SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < $2 RETURNING attempts',
        [id, maxAttempts],
      );
      return rows[0] ? Number(rows[0].attempts) : null;
    }),
    invalidateChallenge: (id, now, e) => transaction(async (client) => {
      await client.query('UPDATE verification_challenges SET consumed_at = COALESCE(consumed_at, $2) WHERE id = $1', [id, now]);
      await event(client, e);
    }),
    countChallengesSince: (userId, since) => run(async () => Number((await pool.query(
      'SELECT count(*)::int AS n FROM verification_challenges WHERE user_id = $1 AND created_at >= $2', [userId, since],
    )).rows[0].n)),
    findVerifiedContact: (userId, channel) => run(async () => {
      const { rows } = await pool.query('SELECT destination FROM account_contacts WHERE user_id = $1 AND channel = $2 AND verified_at IS NOT NULL', [userId, channel]);
      return rows[0] ? String(rows[0].destination) : null;
    }),
    findCandidateIdsByVerifiedMobile: (mobile, limit) => run(async () => (await pool.query(
      `SELECT ac.user_id FROM account_contacts ac JOIN users u ON u.id = ac.user_id
        WHERE ac.channel = 'sms' AND ac.destination = $1 AND ac.verified_at IS NOT NULL AND u.role = 'candidate'
        ORDER BY ac.user_id LIMIT $2`,
      [mobile, limit],
    )).rows.map((row) => String(row.user_id))),
    completeStudentVerification: (input) => transaction(async (client) => {
      const consumed = await client.query('UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id', [input.challengeId, input.now]);
      if (consumed.rowCount !== 1) return false;
      // AUTH C1: serialize with registration completion for the same number (same key, same order:
      // own challenge first, then the mobile lock). Each later statement sees the other's commit.
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [studentMobileLockKey(input.destination)]);
      if (input.mobileFirstLoginId) {
        const owner = await client.query("SELECT id FROM users WHERE login_id = $1 AND role = 'candidate' AND id <> $2", [input.mobileFirstLoginId, input.userId]);
        if (owner.rows.length > 0) {
          await event(client, { action: 'student.mobile_capture_refused', userId: input.userId, details: { reason: 'mobile_first_account' } });
          return 'mobile_in_use' as const;
        }
      }
      await client.query(
        `INSERT INTO account_contacts (id, user_id, channel, destination, verified_at) VALUES ($1, $2, 'sms', $3, $4)
         ON CONFLICT (user_id, channel) DO UPDATE SET destination = EXCLUDED.destination, verified_at = EXCLUDED.verified_at`,
        [randomUUID(), input.userId, input.destination, input.now],
      );
      await client.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [input.sessionTokenHash, input.userId, input.sessionExpiresAt]);
      await client.query("INSERT INTO auth_session_verifications (token_hash, method, verified_at) VALUES ($1, 'sms_otp', $2)", [input.sessionTokenHash, input.now]);
      await event(client, { action: 'student.verified_session_issued', userId: input.userId });
      return true;
    }),
    completeStudentEmailVerification: (input) => transaction(async (client) => {
      const consumed = await client.query(
        "UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1 AND user_id = $3 AND purpose = 'student_email_capture' AND channel = 'email' AND consumed_at IS NULL AND expires_at > $2 RETURNING id",
        [input.challengeId, input.now, input.userId],
      );
      if (consumed.rowCount !== 1) return false;
      const updated = await client.query("UPDATE users SET contact_email = $2 WHERE id = $1 AND role = 'candidate'", [input.userId, input.destination]);
      if (updated.rowCount !== 1) throw new Error('Student account disappeared during email verification');
      await client.query(
        `INSERT INTO account_contacts (id, user_id, channel, destination, verified_at) VALUES ($1, $2, 'email', $3, $4)
         ON CONFLICT (user_id, channel) DO UPDATE SET destination = EXCLUDED.destination, verified_at = EXCLUDED.verified_at`,
        [randomUUID(), input.userId, input.destination, input.now],
      );
      await event(client, { action: 'student.email_verified', userId: input.userId });
      return true;
    }),
    getInstituteVerification: (institutionId) => run(async () => {
      const { rows } = await pool.query('SELECT * FROM institute_verifications WHERE institution_id = $1', [institutionId]);
      if (!rows[0]) return null;
      const row = rows[0];
      return {
        mobileDestination: row.mobile_destination === null ? null : String(row.mobile_destination), mobileVerifiedAt: date(row.mobile_verified_at),
        emailDestination: row.email_destination === null ? null : String(row.email_destination), emailVerifiedAt: date(row.email_verified_at),
        institutionalStatus: row.institutional_status as InstituteVerificationState['institutionalStatus'], suspendedAt: date(row.suspended_at),
      };
    }),
    completeInstituteContactVerification: (input) => transaction(async (client) => {
      const consumed = await client.query('UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id', [input.challengeId, input.now]);
      if (consumed.rowCount !== 1) return false;
      await client.query('INSERT INTO institute_verifications (institution_id) VALUES ($1) ON CONFLICT (institution_id) DO NOTHING', [input.institutionId]);
      const statement = input.channel === 'sms'
        ? 'UPDATE institute_verifications SET mobile_destination = $2, mobile_verified_at = $3, updated_at = $3 WHERE institution_id = $1'
        : 'UPDATE institute_verifications SET email_destination = $2, email_verified_at = $3, updated_at = $3 WHERE institution_id = $1';
      await client.query(statement, [input.institutionId, input.destination, input.now]);
      await client.query(
        `INSERT INTO account_contacts (id, user_id, channel, destination, verified_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, channel) DO UPDATE SET destination = EXCLUDED.destination, verified_at = EXCLUDED.verified_at`,
        [randomUUID(), input.institutionId, input.channel, input.destination, input.now],
      );
      await event(client, { action: input.channel === 'sms' ? 'institute.mobile_verified' : 'institute.email_verified', userId: input.institutionId });
      return true;
    }),
    findUserIdByGoogleSub: (sub) => run(async () => {
      const { rows } = await pool.query('SELECT user_id FROM google_identities WHERE google_sub = $1', [sub]);
      return rows[0] ? String(rows[0].user_id) : null;
    }),
    // Atomic link without row locks (the API role has no UPDATE on google_identities). The UNIQUE
    // indexes on google_sub and user_id decide: INSERT ... ON CONFLICT DO NOTHING either inserts the
    // link or, for a concurrent/committed conflicting row, waits for it and inserts nothing. An existing
    // link is never modified, so no account can be re-bound. The conflict is then classified from the
    // committed rows (READ COMMITTED: the next statement sees the winner).
    linkGoogleIdentity: (userId, sub, email, now) => transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO google_identities (id, user_id, google_sub, email, linked_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING RETURNING id`,
        [randomUUID(), userId, sub, email, now],
      );
      if (inserted.rowCount === 1) {
        await event(client, { action: 'student.google_linked', userId });
        return 'linked' as const;
      }
      const existing = await client.query('SELECT user_id, google_sub FROM google_identities WHERE google_sub = $1 OR user_id = $2', [sub, userId]);
      if (existing.rows.some((row) => row.google_sub === sub)) return 'sub_taken' as const;
      if (existing.rows.some((row) => row.user_id === userId)) return 'user_has_link' as const;
      // A conflict that matches neither key (for example a generated-id collision): link nothing.
      throw new Error('Google identity link conflict could not be classified; nothing was linked.');
    }),
    createOAuthState: (s) => run(async () => {
      await pool.query(
        'INSERT INTO oauth_states (state_hash, nonce, code_verifier, intent, user_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [s.stateHash, s.nonce, s.codeVerifier, s.intent, s.userId, s.expiresAt],
      );
    }),
    consumeOAuthState: (stateHash, now) => run(async () => {
      const { rows } = await pool.query(
        'UPDATE oauth_states SET consumed_at = $2 WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > $2 RETURNING *',
        [stateHash, now],
      );
      if (!rows[0]) return null;
      return {
        stateHash, nonce: String(rows[0].nonce), codeVerifier: String(rows[0].code_verifier), intent: rows[0].intent as OAuthState['intent'],
        userId: rows[0].user_id === null ? null : String(rows[0].user_id), expiresAt: new Date(String(rows[0].expires_at)),
      };
    }),
    recordEvent: (e) => run(async () => { await event(pool, e); }),
    listInstituteVerificationOverview: (limit) => run(async () => (await pool.query(
      `SELECT u.id, u.login_id, u.display_name, u.account_status,
              iv.institution_id, iv.mobile_destination, iv.mobile_verified_at, iv.email_destination, iv.email_verified_at,
              iv.institutional_status, iv.institutional_decided_at, iv.suspended_at
         FROM users u LEFT JOIN institute_verifications iv ON iv.institution_id = u.id
        WHERE u.role = 'center' ORDER BY u.created_at DESC LIMIT $1`,
      [limit],
    )).rows.map((row) => ({
      institutionId: String(row.id), loginId: String(row.login_id), name: String(row.display_name), accountStatus: String(row.account_status),
      state: toInstituteState(row), institutionalDecidedAt: date(row.institutional_decided_at),
    }))),
    decideInstitutional: async (input) => {
      try {
        return await transaction(async (client) => {
          const owner = await client.query("SELECT id FROM users WHERE id = $1 AND role = 'center' FOR SHARE", [input.institutionId]);
          if (owner.rowCount !== 1) return { status: 'not_found' as const };
          await client.query('INSERT INTO institute_verifications (institution_id) VALUES ($1) ON CONFLICT (institution_id) DO NOTHING', [input.institutionId]);
          const locked = await client.query('SELECT * FROM institute_verifications WHERE institution_id = $1 FOR UPDATE', [input.institutionId]);
          const current = toInstituteState(locked.rows[0]);
          const next = nextInstitutionalState(current, input.action, input.now);
          if (!next) throw new InstitutionalTransitionRefused(current);
          if (input.action === 'verify' || input.action === 'reject') {
            await client.query(
              'UPDATE institute_verifications SET institutional_status = $2, institutional_decided_at = $3, institutional_decided_by = $4, updated_at = $3 WHERE institution_id = $1',
              [input.institutionId, next.institutionalStatus, input.now, input.actorId],
            );
          } else if (input.action === 'suspend') {
            await client.query('UPDATE institute_verifications SET suspended_at = $2, suspended_by = $3, updated_at = $2 WHERE institution_id = $1', [input.institutionId, input.now, input.actorId]);
          } else {
            await client.query('UPDATE institute_verifications SET suspended_at = NULL, suspended_by = NULL, updated_at = $2 WHERE institution_id = $1', [input.institutionId, input.now]);
          }
          await event(client, {
            action: INSTITUTIONAL_EVENT_ACTIONS[input.action],
            userId: input.institutionId,
            details: {
              actorId: input.actorId, actorKind: 'super_admin', targetInstitutionId: input.institutionId, decision: input.action, reason: input.reason,
              previous: { institutionalStatus: current.institutionalStatus, suspended: current.suspendedAt !== null },
            },
          });
          return { status: 'applied' as const, state: next };
        });
      } catch (error) {
        if (error instanceof InstitutionalTransitionRefused) return { status: 'invalid_transition', state: error.state };
        throw error;
      }
    },
    listInstitutionalDecisions: (limit) => run(async () => (await pool.query(
      'SELECT id, occurred_at, action, user_id, details FROM auth_verification_events WHERE action = ANY($1::text[]) ORDER BY occurred_at DESC LIMIT $2',
      [Object.values(INSTITUTIONAL_EVENT_ACTIONS), limit],
    )).rows.map((row) => {
      const details = (row.details ?? {}) as Record<string, unknown>;
      return {
        id: String(row.id), occurredAt: new Date(String(row.occurred_at)), action: String(row.action),
        institutionId: row.user_id === null ? null : String(row.user_id),
        actorId: typeof details.actorId === 'string' ? details.actorId : null,
        reason: typeof details.reason === 'string' ? details.reason : null,
      };
    })),
  };
}

/** Transaction helper shared by the AUTH C1 stores (same semantics as the AUTH-1 store's). */
async function inTransaction<T>(pool: QueryablePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUndefinedTableError(error)) throw new VerificationStoreUnavailableError();
    throw error;
  } finally {
    client.release();
  }
}

const appendEvent = (client: PoolClient, e: AuthVerificationEvent) => client.query(
  'INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ($1, $2, $3, $4::jsonb)',
  [randomUUID(), e.action, e.userId, JSON.stringify(e.details ?? {})],
);

/** AUTH C1: PostgreSQL Student registration claims (studentRegistrationClaimsMigration.sql). */
export function createPostgresStudentRegistrationStore(pool: QueryablePool): StudentRegistrationStore {
  return {
    createClaim: (claim) => inTransaction(pool, async (client) => {
      await client.query(
        'INSERT INTO student_registration_claims (id, mobile, display_name, password_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [claim.id, claim.mobile, claim.displayName, claim.passwordHash, claim.createdAt, claim.expiresAt],
      );
    }),
    completeRegistration: (input) => inTransaction(pool, async (client) => {
      // Lock order: claim, then challenge, then the mobile. Cleanup locks the claim first too (and its
      // challenges only through the cascade), so the two can never deadlock.
      const claims = await client.query(
        'SELECT mobile, display_name, password_hash, expires_at, consumed_at FROM student_registration_claims WHERE id = $1 FOR UPDATE',
        [input.claimId],
      );
      const consumed = await client.query(
        'UPDATE verification_challenges SET consumed_at = $3 WHERE id = $1 AND registration_claim_id = $2 AND consumed_at IS NULL AND expires_at > $3 RETURNING id',
        [input.challengeId, input.claimId, input.now],
      );
      const claim = claims.rows[0];
      if (!claim || consumed.rowCount !== 1) return 'not_in_progress' as const;
      if (claim.consumed_at !== null || new Date(String(claim.expires_at)) <= input.now || String(claim.mobile) !== input.destination) {
        // The challenge stays consumed; the unconsumed, expired claim is left for cleanup.
        await appendEvent(client, { action: 'student.registration_refused', userId: null, details: { reason: claim.consumed_at !== null ? 'claim_consumed' : 'claim_expired' } });
        return 'expired' as const;
      }
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [studentMobileLockKey(input.destination)]);
      const owned = await client.query(
        `SELECT ac.user_id FROM account_contacts ac JOIN users u ON u.id = ac.user_id
          WHERE ac.channel = 'sms' AND ac.destination = $1 AND ac.verified_at IS NOT NULL AND u.role = 'candidate' LIMIT 1`,
        [input.destination],
      );
      // AUTH C1.1: a permanent business refusal marks the claim consumed (dead) in the same transaction
      // that consumed its only challenge, so it can never be replayed; cleanup then removes it.
      const refuse = async (reason: 'mobile_in_use' | 'login_id_taken') => {
        await client.query('UPDATE student_registration_claims SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL', [input.claimId, input.now]);
        await appendEvent(client, { action: 'student.registration_refused', userId: null, details: { reason } });
        return 'refused' as const;
      };
      if (owned.rows.length > 0) return refuse('mobile_in_use');
      const inserted = await client.query(
        `INSERT INTO users (id, login_id, display_name, role, password_hash, account_status)
         VALUES ($1, $2, $3, 'candidate', $4, 'approved')
         ON CONFLICT (login_id) DO NOTHING
         RETURNING id`,
        [input.userId, input.loginId, String(claim.display_name), String(claim.password_hash)],
      );
      if (inserted.rowCount !== 1) return refuse('login_id_taken');
      await client.query(
        "INSERT INTO account_contacts (id, user_id, channel, destination, verified_at) VALUES ($1, $2, 'sms', $3, $4)",
        [randomUUID(), input.userId, input.destination, input.now],
      );
      await client.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [input.sessionTokenHash, input.userId, input.sessionExpiresAt]);
      await client.query("INSERT INTO auth_session_verifications (token_hash, method, verified_at) VALUES ($1, 'sms_otp', $2)", [input.sessionTokenHash, input.now]);
      // AUTH C1.1: the completed claim is deleted in this same transaction (already row-locked above);
      // ON DELETE CASCADE removes its registration-only challenge. Nothing is deleted unless every
      // write above succeeded, and any later error rolls the deletion back with everything else.
      const removed = await client.query('DELETE FROM student_registration_claims WHERE id = $1', [input.claimId]);
      if (removed.rowCount !== 1) throw new Error('registration claim disappeared during completion');
      await appendEvent(client, { action: 'student.registration_completed', userId: input.userId });
      await appendEvent(client, { action: 'student.verified_session_issued', userId: input.userId });
      return 'completed' as const;
    }),
    deleteExpiredClaims: (now, limit) => inTransaction(pool, async (client) => {
      const deleted = await client.query(
        `DELETE FROM student_registration_claims WHERE id IN (
           SELECT c.id FROM student_registration_claims c
            WHERE (c.consumed_at IS NOT NULL OR c.expires_at <= $1)
              AND NOT EXISTS (SELECT 1 FROM verification_challenges v
                               WHERE v.registration_claim_id = c.id AND v.consumed_at IS NULL AND v.expires_at > $1)
            ORDER BY c.expires_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED)`,
        [now, limit],
      );
      return deleted.rowCount ?? 0;
    }),
  };
}

/**
 * AUTH C1 / C1.1-b: SMS send reservations counted from append-only auth_verification_events. Event time
 * is clock_timestamp() (the moment of the reservation, after the serializing lock), not the transaction
 * start, and the windows are measured against clock_timestamp() too.
 */
/**
 * Usage and per-destination SQL for one channel's fixed reservation action. The action is one of two
 * code constants ('sms.send_reserved' or 'email.send_reserved'), never input, so the SMS text is
 * byte-for-byte the C1.1-b statement.
 */
const usageSql = (reservedAction: 'sms.send_reserved' | 'email.send_reserved') => `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE coalesce(details->>'bucket', 'unverified') = 'unverified')::int AS unverified
    FROM auth_verification_events
   WHERE action = '${reservedAction}' AND occurred_at > clock_timestamp() - interval '24 hours'`;

const destinationUsageSql = (reservedAction: 'sms.send_reserved' | 'email.send_reserved') => `SELECT count(*)::int AS n FROM auth_verification_events
   WHERE action = '${reservedAction}' AND details->>'destinationKey' = $1
     AND coalesce(details->>'bucket', 'unverified') = $2
     AND occurred_at > clock_timestamp() - make_interval(secs => $3)`;

interface ReservationChannel {
  reservedAction: 'sms.send_reserved' | 'email.send_reserved';
  refusedAction: 'sms.send_refused' | 'email.send_refused';
  lockKey: string;
}

/** Shared serialized reservation logic (C1.1-b), parameterised by channel; each channel has its own lock. */
function createReservationGuard(pool: QueryablePool, channel: ReservationChannel) {
  const USAGE = usageSql(channel.reservedAction);
  const DESTINATION_USAGE = destinationUsageSql(channel.reservedAction);
  const record = (client: PoolClient, id: string, action: string, details: Record<string, unknown>) => client.query(
    'INSERT INTO auth_verification_events (id, occurred_at, action, user_id, details) VALUES ($1, clock_timestamp(), $2, NULL, $3::jsonb)',
    [id, action, JSON.stringify(details)],
  );
  const advisory = async <T>(work: () => Promise<T>) => {
    try { return await work(); } catch (error) {
      if (isUndefinedTableError(error)) throw new VerificationStoreUnavailableError();
      throw error;
    }
  };
  return {
    reserve: (input: { reservationId: string; destinationKey: string; bucket: string; purpose: VerificationPurpose; destinationWindowMs: number; destinationMaxSends: number; dailyMaxSends: number; dailyMaxUnverifiedSends: number }) => inTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [channel.lockKey]);
      const usage = (await client.query(USAGE)).rows[0];
      const refuse = async (reason: 'daily_limit' | 'unverified_daily_limit' | 'destination_limit', result: SmsSendReservation) => {
        await record(client, randomUUID(), channel.refusedAction, { reason, bucket: input.bucket, purpose: input.purpose, reservationId: input.reservationId });
        return result;
      };
      if (Number(usage.total) >= input.dailyMaxSends) return refuse('daily_limit', 'daily_limited');
      if (input.bucket === 'unverified' && Number(usage.unverified) >= input.dailyMaxUnverifiedSends) return refuse('unverified_daily_limit', 'unverified_daily_limited');
      const recent = await client.query(DESTINATION_USAGE, [input.destinationKey, input.bucket, input.destinationWindowMs / 1000]);
      if (Number(recent.rows[0].n) >= input.destinationMaxSends) return refuse('destination_limit', 'destination_limited');
      await record(client, input.reservationId, channel.reservedAction, { destinationKey: input.destinationKey, bucket: input.bucket, purpose: input.purpose, reservationId: input.reservationId });
      return 'reserved' as const;
    }),
    usage: () => advisory(async () => {
      const row = (await pool.query(USAGE)).rows[0];
      return { total: Number(row.total), unverified: Number(row.unverified) };
    }),
    destinationUsage: (input: { destinationKey: string; bucket: string; windowMs: number }) => advisory(async () => {
      const row = (await pool.query(DESTINATION_USAGE, [input.destinationKey, input.bucket, input.windowMs / 1000])).rows[0];
      return Number(row.n);
    }),
  };
}

export function createPostgresSmsSendGuardStore(pool: QueryablePool): SmsSendGuardStore {
  const guard = createReservationGuard(pool, { reservedAction: 'sms.send_reserved', refusedAction: 'sms.send_refused', lockKey: SMS_SEND_RESERVATION_LOCK_KEY });
  return { reserveSmsSend: guard.reserve, smsUsageLast24h: guard.usage, smsDestinationUsage: guard.destinationUsage };
}

// ---------------------------------------------------------------------------
// AUTH C1.4-B-1: email send reservations (same mechanism, own actions and own lock)
// ---------------------------------------------------------------------------

/** 'unverified': anonymous (new and pending Institutes). 'account': an approved Institute's recorded address. */
export type EmailBucket = 'unverified' | 'account';

export interface EmailSendReservationInput {
  /** Becomes the email delivery's correlationId. */
  reservationId: string;
  /** Keyed hash of the address (never the address). */
  destinationKey: string;
  bucket: EmailBucket;
  purpose: VerificationPurpose;
  destinationWindowMs: number;
  destinationMaxSends: number;
  dailyMaxSends: number;
  dailyMaxUnverifiedSends: number;
}

export interface EmailSendGuardStore {
  /** Serialized like SMS (own lock): email total, unverified cap (unverified only), this bucket's per-address window. */
  reserveEmailSend(input: EmailSendReservationInput): Promise<SmsSendReservation>;
  /** ADVISORY (no lock): early fail-closed answers only. */
  emailUsageLast24h(): Promise<SmsUsage>;
  /** ADVISORY (no lock): reservations of one address key in one bucket within the window. */
  emailDestinationUsage(input: { destinationKey: string; bucket: EmailBucket; windowMs: number }): Promise<number>;
}

/** AUTH C1.4-B-1: serializes all email send reservations (independent of the SMS lock). */
export const EMAIL_SEND_RESERVATION_LOCK_KEY = advisoryKey('eltnoy.auth.email-send-reservations');

export function createPostgresEmailSendGuardStore(pool: QueryablePool): EmailSendGuardStore {
  const guard = createReservationGuard(pool, { reservedAction: 'email.send_reserved', refusedAction: 'email.send_refused', lockKey: EMAIL_SEND_RESERVATION_LOCK_KEY });
  return { reserveEmailSend: guard.reserve, emailUsageLast24h: guard.usage, emailDestinationUsage: guard.destinationUsage };
}
