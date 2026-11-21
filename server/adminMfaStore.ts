// AUTH C1.9.1 (MFA P3a-1): PostgreSQL store for privileged (Official and Super Admin) TOTP sign-in.
// Specification: docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md §4.1, §4.4; schema: adminMfaMigration.sql.
//
// Every verification runs in ONE transaction under a per-user advisory lock:
// - the per-account failure throttle, the attempt reservation, the replay guard and the challenge
//   consumption therefore cannot race;
// - the session row, its MFA evidence and the audit event exist only if that transaction commits.
// The code check itself (decrypt, then verify) is a callback supplied by the caller, so this module
// holds no key material and performs no cryptography.
//
// Approved values (owner, AUTH C1.9.1): a 300-second challenge, 5 attempts per challenge, and 5 failed
// codes per account in a rolling 15 minutes.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isUndefinedTableError } from './staffCommon.js';

export const ADMIN_MFA_LOGIN_POLICY = Object.freeze({
  challengeTtlSeconds: 300,
  maxAttempts: 5,
  throttleFailures: 5,
  throttleWindowSeconds: 15 * 60,
});

/**
 * Two-key advisory lock namespace for per-user MFA serialisation. The two-int4 key space never
 * overlaps the single-bigint key space used by the migration runner, the AUTH-1 stores and the MFA
 * bootstrap lock.
 */
export const ADMIN_MFA_USER_LOCK_NAMESPACE = 734251;

/** The MFA tables are not installed (42P01): every privileged sign-in fails closed. */
export class AdminMfaUnavailableError extends Error {
  constructor() {
    super('Admin MFA storage is not available.');
    this.name = 'AdminMfaUnavailableError';
  }
}

/** A confirmed, active TOTP factor as stored. The secret stays encrypted here. */
export interface StoredTotpFactor {
  readonly id: string;
  readonly userId: string;
  readonly keyVersion: number;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly lastUsedStep: number;
}

/** Result of the caller's code check: an accepted RFC 6238 step, or a rejection reason. */
export type AdminMfaCodeDecision =
  | { readonly outcome: 'accept'; readonly step: number }
  | { readonly outcome: 'reject'; readonly reason: 'invalid' | 'malformed' | 'replayed' };

export interface AdminMfaSignedInUser {
  readonly id: string;
  readonly loginId: string;
  readonly name: string;
  readonly isSuperAdmin: boolean;
}

export type AdminMfaVerifyResult =
  | { readonly status: 'signed_in'; readonly user: AdminMfaSignedInUser }
  | { readonly status: 'invalid_code'; readonly attemptsRemaining: number }
  | { readonly status: 'locked' }
  | { readonly status: 'throttled' }
  /** Unknown, consumed or expired challenge, or a challenge of another purpose. */
  | { readonly status: 'expired' }
  /** The account is no longer an approved Official, or has no active factor: the challenge is closed. */
  | { readonly status: 'not_eligible' };

export interface AdminMfaVerifyInput {
  /** SHA-256 hex of the challenge cookie token. */
  readonly challengeId: string;
  /** SHA-256 hex of the session token the caller will set ONLY if this resolves `signed_in`. */
  readonly sessionTokenHash: string;
  readonly sessionSeconds: number;
  /** Decrypts and verifies the submitted code. May throw (for example a missing key): the transaction then rolls back. */
  readonly check: (factor: StoredTotpFactor) => AdminMfaCodeDecision;
}

export interface AdminMfaStore {
  /** True if the user has a confirmed, not disabled factor. */
  hasActiveFactor(userId: string): Promise<boolean>;
  /** Closes the user's open login challenges (superseded) and creates a new one. */
  createLoginChallenge(input: { challengeId: string; userId: string; ttlSeconds: number }): Promise<void>;
  /**
   * Closes open MFA challenges and creates a ticket-unbound enrollment challenge after password verification.
   * Its ID is the hash of the enrollment cookie and becomes the exact immutable challenge association on the factor.
   */
  createEnrolmentChallenge(input: { challengeId: string; userId: string; ttlSeconds: number }): Promise<void>;
  /** The whole verification, in one transaction under the per-user lock. */
  verifyLogin(input: AdminMfaVerifyInput): Promise<AdminMfaVerifyResult>;
}

interface QueryablePool {
  connect(): Promise<PoolClient>;
}

type Row = Record<string, unknown>;

const EVENT_SQL = 'INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ($1, $2, $3, $4)';

function toSafeInteger(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(number)) throw new Error('Admin MFA store: integer out of range.');
  return number;
}

function toBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error('Admin MFA store: unexpected secret encoding.');
  return value;
}

export function createPostgresAdminMfaStore(pool: QueryablePool): AdminMfaStore {
  /** One transaction on one client. ROLLBACK on any error, including a failed COMMIT. */
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let failed = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed = true;
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUndefinedTableError(error)) throw new AdminMfaUnavailableError();
      throw error;
    } finally {
      client.release(failed);
    }
  }

  const lockUser = (client: PoolClient, userId: string) =>
    client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [ADMIN_MFA_USER_LOCK_NAMESPACE, userId]);
  const event = (client: PoolClient, action: string, userId: string, details: Row = {}) =>
    client.query(EVENT_SQL, [randomUUID(), action, userId, JSON.stringify(details)]);
  const closeChallenge = (client: PoolClient, challengeId: string, reason: 'locked' | 'revoked') =>
    client.query(`UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = $2 WHERE id = $1 AND consumed_at IS NULL`, [challengeId, reason]);

  return {
    async hasActiveFactor(userId) {
      return transaction(async (client) => {
        const { rows } = await client.query(
          `SELECT 1 FROM admin_mfa_factors WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL AND disabled_at IS NULL`,
          [userId],
        );
        return rows.length === 1;
      });
    },

    async createLoginChallenge({ challengeId, userId, ttlSeconds }) {
      await transaction(async (client) => {
        await lockUser(client, userId);
        await client.query(
          `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'superseded' WHERE user_id = $1 AND purpose = 'login' AND consumed_at IS NULL`,
          [userId],
        );
        await client.query(
          `INSERT INTO admin_mfa_challenges (id, user_id, purpose, expires_at) VALUES ($1, $2, 'login', clock_timestamp() + ($3 * interval '1 second'))`,
          [challengeId, userId, ttlSeconds],
        );
        await event(client, 'admin_mfa.challenge_created', userId);
      });
    },

    async createEnrolmentChallenge({ challengeId, userId, ttlSeconds }) {
      await transaction(async (client) => {
        // The user lock precedes challenge-state changes; later enrollment locks this exact challenge first.
        await lockUser(client, userId);
        await client.query(
          `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'superseded' WHERE user_id = $1 AND purpose IN ('login', 'enrol') AND consumed_at IS NULL`,
          [userId],
        );
        await client.query(
          `INSERT INTO admin_mfa_challenges (id, user_id, purpose, expires_at) VALUES ($1, $2, 'enrol', clock_timestamp() + ($3 * interval '1 second'))`,
          [challengeId, userId, ttlSeconds],
        );
        await event(client, 'admin_mfa.challenge_created', userId, { outcome: 'enrolment' });
      });
    },

    async verifyLogin({ challengeId, sessionTokenHash, sessionSeconds, check }) {
      return transaction(async (client): Promise<AdminMfaVerifyResult> => {
        const policy = ADMIN_MFA_LOGIN_POLICY;
        // 1. Identify the challenge's user (the cookie hash is the only input), then serialise on that user.
        const found = await client.query(`SELECT user_id, purpose FROM admin_mfa_challenges WHERE id = $1`, [challengeId]);
        if (!found.rows[0] || found.rows[0].purpose !== 'login') return { status: 'expired' };
        const userId = String(found.rows[0].user_id);
        await lockUser(client, userId);

        // 2. Re-read under the lock: open, unexpired, login, same user.
        const { rows: challenges } = await client.query(
          `SELECT user_id, purpose, attempts, consumed_at, expires_at > clock_timestamp() AS live FROM admin_mfa_challenges WHERE id = $1 FOR UPDATE`,
          [challengeId],
        );
        const challenge = challenges[0];
        if (!challenge || challenge.purpose !== 'login' || String(challenge.user_id) !== userId
          || challenge.consumed_at !== null || challenge.live !== true) {
          return { status: 'expired' };
        }

        // 3. Per-account throttle: failed codes of this account in the rolling window (any challenge).
        const { rows: failures } = await client.query(
          `SELECT count(*)::int AS failures FROM auth_verification_events WHERE user_id = $1 AND action = 'admin_mfa.code_rejected' AND occurred_at > clock_timestamp() - ($2 * interval '1 second')`,
          [userId, policy.throttleWindowSeconds],
        );
        if (toSafeInteger(failures[0]?.failures ?? 0) >= policy.throttleFailures) {
          await event(client, 'admin_mfa.throttled', userId);
          return { status: 'throttled' };
        }

        // 4. Reserve one attempt atomically before any comparison.
        const reserved = await client.query(
          `UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < $2 RETURNING attempts`,
          [challengeId, policy.maxAttempts],
        );
        if (!reserved.rows[0]) {
          await closeChallenge(client, challengeId, 'locked');
          await event(client, 'admin_mfa.challenge_locked', userId);
          return { status: 'locked' };
        }
        const attempts = toSafeInteger(reserved.rows[0].attempts);

        // 5. The account must still be an approved Official.
        const { rows: users } = await client.query(
          `SELECT id, login_id, display_name, role, account_status, is_super_admin FROM users WHERE id = $1`,
          [userId],
        );
        const user = users[0];
        if (!user || user.role !== 'official' || user.account_status !== 'approved') {
          await closeChallenge(client, challengeId, 'revoked');
          return { status: 'not_eligible' };
        }

        // 6. The confirmed, active factor (locked against a concurrent disable).
        const { rows: factors } = await client.query(
          `SELECT id, key_version, secret_ciphertext, secret_nonce, secret_tag, last_used_step FROM admin_mfa_factors WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,
          [userId],
        );
        const factorRow = factors[0];
        if (!factorRow) {
          await closeChallenge(client, challengeId, 'revoked');
          return { status: 'not_eligible' };
        }
        const factor: StoredTotpFactor = {
          id: String(factorRow.id),
          userId,
          keyVersion: toSafeInteger(factorRow.key_version),
          ciphertext: toBuffer(factorRow.secret_ciphertext),
          nonce: toBuffer(factorRow.secret_nonce),
          tag: toBuffer(factorRow.secret_tag),
          lastUsedStep: toSafeInteger(factorRow.last_used_step),
        };

        // 7. The caller decrypts and verifies; a throw (for example a missing key) rolls everything back.
        let decision = check(factor);

        // 8. Replay guard: the step must be newer than the last used one (exactly one row).
        if (decision.outcome === 'accept') {
          const advanced = await client.query(
            `UPDATE admin_mfa_factors SET last_used_step = $2 WHERE id = $1 AND disabled_at IS NULL AND confirmed_at IS NOT NULL AND last_used_step < $2`,
            [factor.id, decision.step],
          );
          if (advanced.rowCount !== 1) decision = { outcome: 'reject', reason: 'replayed' };
        }

        if (decision.outcome === 'reject') {
          await event(client, 'admin_mfa.code_rejected', userId, { outcome: decision.reason });
          if (attempts >= policy.maxAttempts) {
            await closeChallenge(client, challengeId, 'locked');
            await event(client, 'admin_mfa.challenge_locked', userId);
            return { status: 'locked' };
          }
          return { status: 'invalid_code', attemptsRemaining: policy.maxAttempts - attempts };
        }

        // 9. Success: consume the challenge (exactly one row), then the session, its evidence and the event.
        const consumed = await client.query(
          `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'verified' WHERE id = $1 AND consumed_at IS NULL`,
          [challengeId],
        );
        if (consumed.rowCount !== 1) throw new Error('Admin MFA store: the challenge was not consumed exactly once.');
        await client.query(
          `INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
          [sessionTokenHash, userId, sessionSeconds],
        );
        await client.query(
          `INSERT INTO auth_session_mfa_verifications (id, token_hash, user_id, purpose, method, factor_id) VALUES ($1, $2, $3, 'login', 'totp', $4)`,
          [randomUUID(), sessionTokenHash, userId, factor.id],
        );
        await event(client, 'admin_mfa.verified', userId, { outcome: 'login' });
        return {
          status: 'signed_in',
          user: { id: userId, loginId: String(user.login_id), name: String(user.display_name), isSuperAdmin: user.is_super_admin === true },
        };
      });
    },
  };
}
