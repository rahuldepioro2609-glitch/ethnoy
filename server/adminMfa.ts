// AUTH C1.9.1 (MFA P3a-1): mandatory TOTP sign-in for Officials and Super Admins (server side).
// Specification: docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md §3, §4.1, §10.
//
// - The password step (server/index.ts) never creates a session for an Official. It calls
//   beginAdminMfaSignIn, which answers 202 and, when the account has an active factor, sets the
//   challenge cookie `elt_admin_mfa` (HttpOnly, SameSite=Strict, Path=/api/auth/mfa).
// - POST /api/auth/mfa/verify accepts only { code: six digits }. It reads the challenge ONLY from that
//   cookie, and sets `elt_session` only after the database has committed the session and its MFA
//   evidence (adminMfaStore.verifyLogin).
// - The TOTP secret is decrypted with the versioned key ring loaded from ADMIN_MFA_ENCRYPTION_KEY_FILE
//   (canonical Base64 of exactly 32 bytes; this file is version v1). A missing or invalid key, or an
//   unknown key version, fails closed with 503 ADMIN_MFA_UNAVAILABLE.
// There is no bypass, fixed code or enforcement switch. Enrolment is Phase 4 and step-up is Phase 3b.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AdminMfaCryptoError, decryptTotpSecret, encryptTotpSecret, encodeBase32, generateTotpSecret, verifyTotp, type Clock, type EncryptionKeyRing } from './adminMfaCore.js';
import { hashSessionToken, newSessionToken, SESSION_TTL_MS, setSessionCookie } from './auth.js';
import {
  ADMIN_MFA_LOGIN_POLICY,
  ADMIN_MFA_USER_LOCK_NAMESPACE,
  AdminMfaUnavailableError,
  createPostgresAdminMfaStore,
  type AdminMfaCodeDecision,
  type AdminMfaStore,
  type StoredTotpFactor,
} from './adminMfaStore.js';
import { pool } from './db.js';
import { isUndefinedTableError, readCookie } from './staffCommon.js';

export const ADMIN_MFA_COOKIE = 'elt_admin_mfa';
export const ADMIN_MFA_COOKIE_PATH = '/api/auth/mfa';
export const ADMIN_MFA_KEY_FILE_ENV = 'ADMIN_MFA_ENCRYPTION_KEY_FILE';
/** Key-version labels and the integer stored in admin_mfa_factors.key_version. Only v1 exists. */
export const ADMIN_MFA_KEY_VERSIONS = Object.freeze({ v1: 1 } as const);

const SESSION_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
/** A challenge token is 32 random bytes in Base64url: exactly 43 characters. */
const CHALLENGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TICKET_ID = /^[0-9a-f]{64}$/;
/**
 * Canonical standard Base64 of exactly 32 bytes: 43 symbols plus one '=' pad. The last symbol encodes
 * only 4 data bits, so its 2 low bits must be zero, which leaves A E I M Q U Y c g k o s w 0 4 8.
 */
const CANONICAL_BASE64_32_BYTES = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

// ---------------------------------------------------------------------------------------------
// Errors (fixed codes and messages; never a key, path, secret, code or internal detail)
// ---------------------------------------------------------------------------------------------

export class AdminMfaFlowError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AdminMfaFlowError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const unavailable = () => new AdminMfaFlowError(503, 'ADMIN_MFA_UNAVAILABLE', 'Sign-in for administrative accounts is unavailable. Please try again later.');
const expired = () => new AdminMfaFlowError(410, 'MFA_CHALLENGE_EXPIRED', 'This sign-in has expired or is no longer valid. Please sign in again.');

/** Writes the response for a known MFA error and returns true; otherwise returns false. */
export function sendAdminMfaError(response: Response, error: unknown): boolean {
  const known = error instanceof AdminMfaUnavailableError ? unavailable() : error;
  if (!(known instanceof AdminMfaFlowError)) return false;
  response.status(known.status).json({ error: known.message, code: known.code, ...known.extra });
  return true;
}

function toSafeInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed)) throw new Error('Admin MFA: integer out of range.');
  return parsed;
}

function getUser(request: Request): { id?: string; loginId?: string } | undefined {
  return (request as { user?: { id?: string; loginId?: string } }).user;
}

// ---------------------------------------------------------------------------------------------
// Encryption key ring
// ---------------------------------------------------------------------------------------------

export type AdminMfaKeyRingResult = { readonly ok: true; readonly ring: EncryptionKeyRing } | { readonly ok: false };

/**
 * Loads the TOTP-secret encryption key from ADMIN_MFA_ENCRYPTION_KEY_FILE.
 * - The path must be absolute. Only that file is read.
 * - The contents must be canonical standard Base64 of exactly 32 bytes. One trailing LF (as written by
 *   most editors and `echo`) is the only tolerated extra byte; anything else is refused, with no trimming.
 * - The decoded key is version v1 of the ring.
 * Nothing about the path, the contents or the failure reason is logged or returned. The raw file buffer
 * is overwritten after decoding.
 */
export function loadAdminMfaKeyRing(env: Readonly<Record<string, string | undefined>> = process.env): AdminMfaKeyRingResult {
  const path = env[ADMIN_MFA_KEY_FILE_ENV];
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) return { ok: false };
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return { ok: false };
  }
  try {
    const length = raw.length > 0 && raw[raw.length - 1] === 0x0a ? raw.length - 1 : raw.length;
    if (length !== 44) return { ok: false };
    for (let index = 0; index < length; index += 1) if (raw[index] > 0x7f) return { ok: false };
    const text = raw.toString('ascii', 0, length);
    if (!CANONICAL_BASE64_32_BYTES.test(text)) return { ok: false };
    const key = Buffer.from(text, 'base64');
    if (key.length !== 32) {
      key.fill(0);
      return { ok: false };
    }
    return { ok: true, ring: new Map<number, Uint8Array>([[ADMIN_MFA_KEY_VERSIONS.v1, key]]) };
  } finally {
    raw.fill(0);
  }
}

let cachedKeyRing: AdminMfaKeyRingResult | undefined;

/**
 * The process key ring. A successful load is kept for the life of the process; a failed load is retried
 * on the next sign-in, so correcting the key file does not need a restart. There is no generated or
 * default key.
 */
export function adminMfaKeyRing(): AdminMfaKeyRingResult {
  if (cachedKeyRing?.ok) return cachedKeyRing;
  const loaded = loadAdminMfaKeyRing();
  if (loaded.ok) cachedKeyRing = loaded;
  return loaded;
}

/** Dependency injection for tests (like configureVerificationServices). `undefined` restores loading from the environment. */
export function configureAdminMfaKeyRing(next: AdminMfaKeyRingResult | undefined): void {
  cachedKeyRing = next;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

let store: AdminMfaStore | undefined;
export function adminMfaStore(): AdminMfaStore {
  store ??= createPostgresAdminMfaStore(pool);
  return store;
}
/** Dependency injection for tests (like configureAuthVerificationStore). */
export function configureAdminMfaStore(next: AdminMfaStore | undefined): void {
  store = next;
}

// ---------------------------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------------------------

const secureFlag = () => (process.env.NODE_ENV === 'production' ? '; Secure' : '');

function setChallengeCookie(response: Response, token: string): void {
  response.append('Set-Cookie', `${ADMIN_MFA_COOKIE}=${token}; Path=${ADMIN_MFA_COOKIE_PATH}; Max-Age=${ADMIN_MFA_LOGIN_POLICY.challengeTtlSeconds}; HttpOnly; SameSite=Strict${secureFlag()}`);
}

export function clearChallengeCookie(response: Response): void {
  response.append('Set-Cookie', `${ADMIN_MFA_COOKIE}=; Path=${ADMIN_MFA_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secureFlag()}`);
}

// ---------------------------------------------------------------------------------------------
// Password step (called by POST /api/auth/login for an approved Official after the password matched)
// ---------------------------------------------------------------------------------------------

export type AdminMfaSignInStart = { readonly status: 'mfa_required' } | { readonly status: 'mfa_enrolment_required' };

/**
 * Never creates a session. With an active factor it creates a login challenge; without one it creates an
 * enrollment-purpose challenge. Both store only the SHA-256 of a random token and set the HttpOnly
 * challenge cookie. A missing or invalid key, or missing MFA tables, fail closed.
 */
export async function beginAdminMfaSignIn(response: Response, userId: string): Promise<AdminMfaSignInStart> {
  if (!adminMfaKeyRing().ok) throw unavailable();
  const mfa = adminMfaStore();
  const token = randomBytes(32).toString('base64url');
  const hasActiveFactor = await mfa.hasActiveFactor(userId);
  if (hasActiveFactor) {
    await mfa.createLoginChallenge({ challengeId: hashSessionToken(token), userId, ttlSeconds: ADMIN_MFA_LOGIN_POLICY.challengeTtlSeconds });
  } else {
    await mfa.createEnrolmentChallenge({ challengeId: hashSessionToken(token), userId, ttlSeconds: ADMIN_MFA_LOGIN_POLICY.challengeTtlSeconds });
  }
  setChallengeCookie(response, token);
  return { status: hasActiveFactor ? 'mfa_required' : 'mfa_enrolment_required' };
}

export interface AdminMfaEnrolmentStartResult {
  readonly otpauthUri: string;
  readonly secretBase32: string;
}

function parseTicket(ticket: string): string {
  const ticketHash = hashSessionToken(ticket);
  if (ticket.length === 0 || !TICKET_ID.test(ticketHash)) {
    throw new AdminMfaFlowError(400, 'MFA_TICKET_INVALID', 'This enrolment ticket is no longer valid.');
  }
  return ticketHash;
}

/** Returns the standard TOTP provisioning URI used by authenticator apps. */
export function createTotpAuthUri(secretBase32: string, loginId: string): string {
  const label = encodeURIComponent(`ELTNOY:${loginId}`);
  const issuer = encodeURIComponent('ELTNOY');
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

async function withEnrolmentTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
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
    if (isUndefinedTableError(error)) throw unavailable();
    throw error;
  } finally {
    client.release(failed);
  }
}

async function lockEnrolmentUser(client: PoolClient, userId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [ADMIN_MFA_USER_LOCK_NAMESPACE, userId]);
}

export async function beginAdminMfaEnrolment(
  response: Response,
  ticket: string,
  challengeToken: string,
): Promise<AdminMfaEnrolmentStartResult> {
  if (!adminMfaKeyRing().ok) throw unavailable();
  const ticketHash = parseTicket(ticket);
  const keyRing = adminMfaKeyRing();
  if (!keyRing.ok) throw unavailable();
  const key = keyRing.ring.get(ADMIN_MFA_KEY_VERSIONS.v1);
  if (!key) throw unavailable();

  const secret = generateTotpSecret();
  const factorId = randomUUID();
  let secretBase32: string | undefined;
  try {
    const challengeId = hashSessionToken(challengeToken);
    const result = await withEnrolmentTransaction(async (client) => {
      const identity = await client.query(
        `SELECT user_id, purpose FROM admin_mfa_challenges WHERE id = $1`,
        [challengeId],
      );
      if (identity.rows.length !== 1 || identity.rows[0].purpose !== 'enrol') throw expired();
      const userId = String(identity.rows[0].user_id);

      await lockEnrolmentUser(client, userId);
      const challenge = await client.query(
        `SELECT id, user_id, enrolment_ticket_id, expires_at > clock_timestamp() AS live FROM admin_mfa_challenges WHERE id = $1 AND user_id = $2 AND purpose = 'enrol' AND consumed_at IS NULL FOR UPDATE`,
        [challengeId, userId],
      );
      if (challenge.rows.length !== 1 || challenge.rows[0].live !== true || challenge.rows[0].enrolment_ticket_id !== null) {
        throw expired();
      }

      await client.query(
        `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'superseded' WHERE user_id = $1 AND purpose = 'enrol' AND consumed_at IS NULL AND id <> $2`,
        [userId, challengeId],
      );

      const ticketRow = await client.query(
        `SELECT id, user_id FROM admin_mfa_enrolment_tickets
          WHERE id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at > clock_timestamp()
            AND created_at > clock_timestamp() - interval '1800 seconds'
          FOR UPDATE`,
        [ticketHash, userId],
      );
      if (ticketRow.rows.length !== 1) {
        throw new AdminMfaFlowError(400, 'MFA_TICKET_INVALID', 'This enrolment ticket is no longer valid.');
      }
      const userRow = await client.query(
        `SELECT id, login_id FROM users WHERE id = $1 AND role = 'official' AND account_status = 'approved'`,
        [userId],
      );
      if (userRow.rows.length !== 1) {
        throw new AdminMfaFlowError(403, 'MFA_TICKET_INVALID', 'This enrolment is no longer available.');
      }
      const existingFactor = await client.query(
        `SELECT id FROM admin_mfa_factors WHERE user_id = $1 AND kind = 'totp' AND disabled_at IS NULL FOR UPDATE`,
        [userId],
      );
      if (existingFactor.rows.length !== 0) {
        throw new AdminMfaFlowError(409, 'MFA_TICKET_INVALID', 'This enrolment is no longer available.');
      }

      const encrypted = encryptTotpSecret(secret, key, ADMIN_MFA_KEY_VERSIONS.v1, { factorId, userId });
      const bound = await client.query(
        `UPDATE admin_mfa_challenges SET enrolment_ticket_id = $2 WHERE id = $1 AND user_id = $3 AND purpose = 'enrol' AND consumed_at IS NULL AND enrolment_ticket_id IS NULL RETURNING id`,
        [challengeId, ticketHash, userId],
      );
      if (bound.rowCount !== 1) {
        throw new AdminMfaFlowError(400, 'MFA_TICKET_INVALID', 'This enrolment challenge is no longer valid.');
      }
      await client.query(
        `INSERT INTO admin_mfa_factors (id, user_id, enrolment_challenge_id, kind, secret_ciphertext, secret_nonce, secret_tag, key_version)
         VALUES ($1, $2, $3, 'totp', $4, $5, $6, $7)`,
        [factorId, userId, challengeId, encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.keyVersion],
      );
      await client.query(
        `INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ($1, 'admin_mfa.enrolment_started', $2, $3)`,
        [randomUUID(), userId, JSON.stringify({ outcome: 'started' })],
      );
      return { loginId: String(userRow.rows[0].login_id) };
    });

    secretBase32 = encodeBase32(secret);
    const otpauthUri = createTotpAuthUri(secretBase32, result.loginId);
    setChallengeCookie(response, challengeToken);
    return { otpauthUri, secretBase32 };
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code === '23505') {
      throw new AdminMfaFlowError(409, 'MFA_TICKET_INVALID', 'This enrolment ticket is no longer valid.');
    }
    throw error;
  } finally {
    secret.fill(0);
  }
}

const enrolVerifyBody = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict();

export function createAdminMfaEnrolStartHandler(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
      const token = readCookie(request, ADMIN_MFA_COOKIE);
      if (typeof token !== 'string' || !CHALLENGE_TOKEN.test(token)) {
        clearChallengeCookie(response);
        throw expired();
      }
      const parsed = z.object({ ticket: z.string().min(1) }).strict().safeParse(request.body);
      if (!parsed.success) {
        throw new AdminMfaFlowError(400, 'MFA_TICKET_INVALID', 'This enrolment ticket is no longer valid.');
      }
      const result = await beginAdminMfaEnrolment(response, parsed.data.ticket, token);
      response.status(200).json(result);
    })().catch((error: unknown) => {
      if (error instanceof AdminMfaFlowError && error.code === 'MFA_CHALLENGE_EXPIRED') clearChallengeCookie(response);
      if (!sendAdminMfaError(response, error)) next(error);
    });
  };
}

export function createAdminMfaEnrolConfirmHandler(options: AdminMfaVerifyOptions = {}): RequestHandler {
  const clock = options.clock ?? Date.now;
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
      const token = readCookie(request, ADMIN_MFA_COOKIE);
      if (typeof token !== 'string' || !CHALLENGE_TOKEN.test(token)) {
        clearChallengeCookie(response);
        throw expired();
      }
      const parsed = enrolVerifyBody.safeParse(request.body);
      if (!parsed.success) {
        throw new AdminMfaFlowError(400, 'MFA_CODE_INVALID', 'Enter the six-digit code from your authenticator app.');
      }
      const keys = adminMfaKeyRing();
      if (!keys.ok) throw unavailable();
      const challengeId = hashSessionToken(token);
      const outcome = await withEnrolmentTransaction(async (client) => {
        const identity = await client.query(
          `SELECT user_id, purpose FROM admin_mfa_challenges WHERE id = $1`,
          [challengeId],
        );
        if (identity.rows.length !== 1 || identity.rows[0].purpose !== 'enrol') return { status: 'expired' as const };
        const userId = String(identity.rows[0].user_id);
        await lockEnrolmentUser(client, userId);

        const challenge = await client.query(
          `SELECT id, user_id, enrolment_ticket_id, attempts, expires_at > clock_timestamp() AS live FROM admin_mfa_challenges WHERE id = $1 AND user_id = $2 AND purpose = 'enrol' AND consumed_at IS NULL FOR UPDATE`,
          [challengeId, userId],
        );
        if (challenge.rows.length !== 1 || challenge.rows[0].live !== true) return { status: 'expired' as const };
        const ticketId = challenge.rows[0].enrolment_ticket_id;
        if (typeof ticketId !== 'string') return { status: 'invalid_ticket' as const };

        const ticket = await client.query(
          `SELECT id FROM admin_mfa_enrolment_tickets
            WHERE id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL
              AND expires_at > clock_timestamp()
              AND created_at > clock_timestamp() - interval '1800 seconds'
            FOR UPDATE`,
          [ticketId, userId],
        );
        if (ticket.rows.length !== 1) return { status: 'invalid_ticket' as const };

        const factorResult = await client.query(
          `SELECT id, user_id, enrolment_challenge_id, key_version, secret_ciphertext, secret_nonce, secret_tag, last_used_step
             FROM admin_mfa_factors
            WHERE enrolment_challenge_id = $1 AND user_id = $2 AND kind = 'totp' AND confirmed_at IS NULL AND disabled_at IS NULL
            FOR UPDATE`,
          [challengeId, userId],
        );
        if (factorResult.rows.length !== 1 || factorResult.rows[0].enrolment_challenge_id !== challengeId) {
          return { status: 'invalid_ticket' as const };
        }

        const userResult = await client.query(
          `SELECT id, login_id, display_name, is_super_admin FROM users WHERE id = $1 AND role = 'official' AND account_status = 'approved'`,
          [userId],
        );
        if (userResult.rows.length !== 1) return { status: 'not_eligible' as const };

        const attempts = toSafeInteger(challenge.rows[0].attempts);
        if (attempts >= ADMIN_MFA_LOGIN_POLICY.maxAttempts) {
          await client.query(
            `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'locked' WHERE id = $1 AND consumed_at IS NULL`,
            [challengeId],
          );
          return { status: 'locked' as const };
        }

        const factor: StoredTotpFactor = {
          id: String(factorResult.rows[0].id),
          userId,
          keyVersion: toSafeInteger(factorResult.rows[0].key_version),
          ciphertext: Buffer.from(factorResult.rows[0].secret_ciphertext),
          nonce: Buffer.from(factorResult.rows[0].secret_nonce),
          tag: Buffer.from(factorResult.rows[0].secret_tag),
          lastUsedStep: toSafeInteger(factorResult.rows[0].last_used_step),
        };
        const decision = checkCode(factor, parsed.data.code, keys.ring, clock);
        if (decision.outcome === 'reject') {
          const updated = await client.query(
            `UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL RETURNING attempts`,
            [challengeId],
          );
          if (updated.rows.length !== 1) throw expired();
          const attemptsAfterFailure = toSafeInteger(updated.rows[0].attempts);
          if (attemptsAfterFailure >= ADMIN_MFA_LOGIN_POLICY.maxAttempts) {
            await client.query(
              `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'locked' WHERE id = $1 AND consumed_at IS NULL`,
              [challengeId],
            );
            return { status: 'locked' as const };
          }
          return { status: 'invalid_code' as const, attemptsRemaining: ADMIN_MFA_LOGIN_POLICY.maxAttempts - attemptsAfterFailure };
        }

        const factorId = factor.id;
        const confirmed = await client.query(
          `SELECT public.confirm_admin_mfa_enrolment_factor($1, $2, $3, $4, $5) AS confirmed`,
          [userId, challengeId, ticketId, factorId, decision.step],
        );
        if (confirmed.rowCount !== 1 || confirmed.rows[0].confirmed !== true) {
          throw new AdminMfaFlowError(400, 'MFA_TICKET_INVALID', 'This enrolment ticket is no longer valid.');
        }
        const consumedChallenge = await client.query(
          `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'verified' WHERE id = $1 AND user_id = $2 AND purpose = 'enrol' AND consumed_at IS NULL RETURNING id`,
          [challengeId, userId],
        );
        if (consumedChallenge.rowCount !== 1) throw new Error('Admin MFA: the enrolment challenge was not consumed exactly once.');

        const sessionToken = newSessionToken();
        const sessionTokenHash = hashSessionToken(sessionToken);
        await client.query(
          `INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
          [sessionTokenHash, userId, SESSION_SECONDS],
        );
        await client.query(
          `INSERT INTO auth_session_mfa_verifications (id, token_hash, user_id, purpose, method, factor_id) VALUES ($1, $2, $3, 'enrol', 'totp', $4)`,
          [randomUUID(), sessionTokenHash, userId, factorId],
        );
        await client.query(
          `INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ($1, 'admin_mfa.enrolled', $2, $3)`,
          [randomUUID(), userId, JSON.stringify({ outcome: 'confirmed' })],
        );
        return {
          status: 'signed_in' as const,
          sessionToken,
          user: { id: userId, loginId: String(userResult.rows[0].login_id), name: String(userResult.rows[0].display_name), isSuperAdmin: userResult.rows[0].is_super_admin === true },
        };
      });

      if (outcome.status === 'expired' || outcome.status === 'not_eligible') {
        clearChallengeCookie(response);
        throw expired();
      }
      if (outcome.status === 'invalid_ticket') {
        throw new AdminMfaFlowError(400, 'MFA_TICKET_INVALID', 'This enrolment ticket is no longer valid.');
      }
      if (outcome.status === 'locked') {
        clearChallengeCookie(response);
        throw new AdminMfaFlowError(429, 'MFA_CHALLENGE_LOCKED', 'Too many incorrect codes. Please sign in again.');
      }
      if (outcome.status === 'invalid_code') {
        throw new AdminMfaFlowError(400, 'MFA_CODE_INVALID', 'The code is incorrect.', { attemptsRemaining: outcome.attemptsRemaining });
      }
      clearChallengeCookie(response);
      setSessionCookie(response, outcome.sessionToken);
      response.json({ status: 'signed_in', user: { ...outcome.user, role: 'official' } });
    })().catch((error: unknown) => {
      if (!sendAdminMfaError(response, error)) next(error);
    });
  };
}

// ---------------------------------------------------------------------------------------------
// POST /api/auth/mfa/verify
// ---------------------------------------------------------------------------------------------

const verifyBody = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict();

/** Decrypts the factor secret, verifies the code against `lastUsedStep`, and always overwrites the secret. */
function checkCode(factor: StoredTotpFactor, code: string, ring: EncryptionKeyRing, clock: Clock): AdminMfaCodeDecision {
  let secret: Buffer | undefined;
  try {
    secret = decryptTotpSecret(
      { ciphertext: factor.ciphertext, nonce: factor.nonce, tag: factor.tag, keyVersion: factor.keyVersion },
      ring,
      { factorId: factor.id, userId: factor.userId },
    );
    const result = verifyTotp({ secret, code, clock, lastUsedStep: factor.lastUsedStep });
    return result.valid ? { outcome: 'accept', step: result.step } : { outcome: 'reject', reason: result.reason };
  } catch (error) {
    // Unknown key version, wrong key, tampered or malformed stored secret: fail closed, with a fixed answer.
    if (error instanceof AdminMfaCryptoError) throw unavailable();
    throw error;
  } finally {
    secret?.fill(0);
  }
}

export interface AdminMfaVerifyOptions {
  /** Unix milliseconds; injected by tests. */
  readonly clock?: Clock;
}

export function createAdminMfaVerifyHandler(options: AdminMfaVerifyOptions = {}): RequestHandler {
  const clock = options.clock ?? Date.now;
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
      const token = readCookie(request, ADMIN_MFA_COOKIE);
      if (typeof token !== 'string' || !CHALLENGE_TOKEN.test(token)) {
        clearChallengeCookie(response);
        throw expired();
      }
      const parsed = verifyBody.safeParse(request.body);
      if (!parsed.success) {
        throw new AdminMfaFlowError(400, 'MFA_CODE_INVALID', 'Enter the six-digit code from your authenticator app.');
      }
      const keys = adminMfaKeyRing();
      if (!keys.ok) throw unavailable();

      const sessionToken = newSessionToken();
      const result = await adminMfaStore().verifyLogin({
        challengeId: hashSessionToken(token),
        sessionTokenHash: hashSessionToken(sessionToken),
        sessionSeconds: SESSION_SECONDS,
        check: (factor) => checkCode(factor, parsed.data.code, keys.ring, clock),
      });

      switch (result.status) {
        case 'signed_in':
          // The database has committed the session and its MFA evidence: only now set the session cookie.
          clearChallengeCookie(response);
          setSessionCookie(response, sessionToken);
          response.json({
            status: 'signed_in',
            user: { id: result.user.id, loginId: result.user.loginId, name: result.user.name, role: 'official', isSuperAdmin: result.user.isSuperAdmin },
          });
          return;
        case 'invalid_code':
          throw new AdminMfaFlowError(400, 'MFA_CODE_INVALID', 'The code is incorrect.', { attemptsRemaining: result.attemptsRemaining });
        case 'locked':
          clearChallengeCookie(response);
          throw new AdminMfaFlowError(429, 'MFA_CHALLENGE_LOCKED', 'Too many incorrect codes. Please sign in again.');
        case 'throttled':
          clearChallengeCookie(response);
          throw new AdminMfaFlowError(429, 'MFA_THROTTLED', 'Too many incorrect codes for this account. Please wait and sign in again later.');
        case 'expired':
        case 'not_eligible':
          clearChallengeCookie(response);
          throw expired();
        default:
          throw new Error('Admin MFA: unexpected verification result.');
      }
    })().catch((error: unknown) => {
      if (!sendAdminMfaError(response, error)) next(error);
    });
  };
}
