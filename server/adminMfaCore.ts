// ELTNOY AUTH C1.7, Phase 1: the cryptographic core for privileged TOTP MFA.
// Specification: docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md (revision 2), §3.
//
// This module is deliberately PURE:
// - no Express, no PostgreSQL, no sessions, no file or network I/O, and no logging;
// - it uses only node:crypto;
// - every key is supplied by the caller (key-file loading belongs to a later phase).
//
// Errors carry only a fixed code. They never include a secret, code, key, nonce, tag or hash.
// Returned secrets are Buffers: callers should keep them in memory only for as long as needed and
// overwrite them (buffer.fill(0)) afterwards.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------------------------
// Fixed parameters (RFC 6238 / RFC 4226 as approved for C1.7)
// ---------------------------------------------------------------------------------------------

/** TOTP secret length in bytes (160 bits, the RFC 4226 recommendation for HMAC-SHA1). */
export const TOTP_SECRET_BYTES = 20;
/** Number of digits in a code. */
export const TOTP_DIGITS = 6;
/** Time step in seconds (RFC 6238 X). T0 is the Unix epoch. */
export const TOTP_STEP_SECONDS = 30;
/** Adjacent steps accepted on each side of the current step (approved: ±1). */
export const TOTP_WINDOW_STEPS = 1;
/** AES-256-GCM key, nonce and tag sizes in bytes. */
export const ENCRYPTION_KEY_BYTES = 32;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
/** Minimum HMAC key length for recovery-code hashing. */
export const RECOVERY_HMAC_KEY_MIN_BYTES = 32;
/**
 * Engineering bounds for the recovery-code length, in Base32 characters (5 bits each).
 * The product values (the code length and the batch size) are owner decision D-2 and are NOT chosen
 * here. Every caller must pass them explicitly. The lower bound is a safety floor of 50 random bits.
 */
export const RECOVERY_CODE_MIN_CHARACTERS = 10;
export const RECOVERY_CODE_MAX_CHARACTERS = 64;
export const RECOVERY_CODE_MAX_BATCH = 100;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS_MODULUS = 10 ** TOTP_DIGITS;
const STEP_MS = TOTP_STEP_SECONDS * 1000;
const IDENTIFIER_MAX_BYTES = 256;
const AAD_DOMAIN = 'eltnoy-admin-mfa-totp-secret-v1';
const RECOVERY_DOMAIN = 'eltnoy-admin-mfa-recovery-code-v1';
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type AdminMfaCryptoErrorCode =
  | 'MFA_INVALID_BASE32'
  | 'MFA_INVALID_SECRET'
  | 'MFA_INVALID_COUNTER'
  | 'MFA_INVALID_CLOCK'
  | 'MFA_INVALID_KEY'
  | 'MFA_INVALID_KEY_VERSION'
  | 'MFA_UNKNOWN_KEY_VERSION'
  | 'MFA_INVALID_IDENTIFIER'
  | 'MFA_INVALID_ENVELOPE'
  | 'MFA_SECRET_DECRYPTION_FAILED'
  | 'MFA_INVALID_RECOVERY_PARAMETERS'
  | 'MFA_INVALID_STORED_HASH';

/** A fail-closed error. The message is the fixed code only, so it can never echo input material. */
export class AdminMfaCryptoError extends Error {
  readonly code: AdminMfaCryptoErrorCode;
  constructor(code: AdminMfaCryptoErrorCode) {
    super(code);
    this.name = 'AdminMfaCryptoError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function requireSecret(secret: unknown): Uint8Array {
  if (!isBytes(secret) || secret.length !== TOTP_SECRET_BYTES) throw new AdminMfaCryptoError('MFA_INVALID_SECRET');
  return secret;
}

function requireEncryptionKey(key: unknown): Uint8Array {
  if (!isBytes(key) || key.length !== ENCRYPTION_KEY_BYTES) throw new AdminMfaCryptoError('MFA_INVALID_KEY');
  return key;
}

function requireHmacKey(key: unknown): Uint8Array {
  if (!isBytes(key) || key.length < RECOVERY_HMAC_KEY_MIN_BYTES) throw new AdminMfaCryptoError('MFA_INVALID_KEY');
  return key;
}

function requireKeyVersion(version: unknown): number {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new AdminMfaCryptoError('MFA_INVALID_KEY_VERSION');
  }
  return version;
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > IDENTIFIER_MAX_BYTES) {
    throw new AdminMfaCryptoError('MFA_INVALID_IDENTIFIER');
  }
  return value;
}

/** Length-prefixed concatenation, so that distinct field tuples can never encode to the same bytes. */
function encodeFields(fields: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

/**
 * Constant-time equality for two byte strings. A length difference returns false immediately: every
 * value compared in this module (6-digit codes and SHA-256 digests) has a fixed public length, so the
 * length itself is not secret.
 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (!isBytes(left) || !isBytes(right) || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------------------------
// Base32 (RFC 4648 §6, canonical form: upper case, no padding)
// ---------------------------------------------------------------------------------------------

/** Encodes bytes as canonical Base32 (RFC 4648 alphabet, upper case, no padding). */
export function encodeBase32(bytes: Uint8Array): string {
  if (!isBytes(bytes)) throw new AdminMfaCryptoError('MFA_INVALID_BASE32');
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

/**
 * Strictly decodes canonical Base32. It refuses lower case, padding, whitespace, characters outside
 * the alphabet, impossible lengths (length mod 8 of 1, 3 or 6) and non-zero trailing bits, so every
 * accepted string has exactly one byte sequence.
 */
export function decodeBase32(text: string): Buffer {
  if (typeof text !== 'string' || text.length === 0) throw new AdminMfaCryptoError('MFA_INVALID_BASE32');
  const remainder = text.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) throw new AdminMfaCryptoError('MFA_INVALID_BASE32');
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value < 0) throw new AdminMfaCryptoError('MFA_INVALID_BASE32');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) throw new AdminMfaCryptoError('MFA_INVALID_BASE32');
  return Buffer.from(output);
}

// ---------------------------------------------------------------------------------------------
// HOTP (RFC 4226) and TOTP (RFC 6238)
// ---------------------------------------------------------------------------------------------

/** Generates a new 20-byte TOTP secret from the operating system's secure random generator. */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/**
 * RFC 4226 HOTP with HMAC-SHA1 and dynamic truncation, formatted as exactly six digits (with leading
 * zeroes). The counter is a non-negative safe integer, encoded as an 8-byte big-endian value.
 */
export function computeHotp(secret: Uint8Array, counter: number): string {
  requireSecret(secret);
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) {
    throw new AdminMfaCryptoError('MFA_INVALID_COUNTER');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  // RFC 4226 §5.3 dynamic truncation. The offset is at most 15, and a SHA-1 digest is 20 bytes, so the
  // bounds-checked 4-byte read at offset..offset+3 is always in range.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % DIGITS_MODULUS).padStart(TOTP_DIGITS, '0');
}

/** The RFC 6238 time-step counter for a Unix time in milliseconds: floor(seconds / 30), T0 = 0. */
export function totpStepAt(unixMs: number): number {
  if (typeof unixMs !== 'number' || !Number.isSafeInteger(unixMs) || unixMs < 0) {
    throw new AdminMfaCryptoError('MFA_INVALID_CLOCK');
  }
  return Math.floor(unixMs / STEP_MS);
}

/** Returns Unix time in milliseconds. It is injected so that tests are deterministic. */
export type Clock = () => number;

/** Computes the code for the current step. For tests and enrolment previews; never log the result. */
export function computeTotp(secret: Uint8Array, clock: Clock = Date.now): string {
  return computeHotp(secret, totpStepAt(clock()));
}

export interface VerifyTotpOptions {
  secret: Uint8Array;
  /** The candidate code as submitted. Anything other than exactly six ASCII digits is rejected. */
  code: unknown;
  clock?: Clock;
  /**
   * The factor's last used step (`admin_mfa_factors.last_used_step`; -1 if never used). Steps less
   * than or equal to it are never accepted, so a code cannot be replayed. The caller must still make
   * the update conditional (`… WHERE last_used_step < $step`) so that concurrent requests cannot both
   * succeed. This function cannot provide that guarantee.
   */
  lastUsedStep?: number;
}

export type VerifyTotpResult =
  | { readonly valid: true; readonly step: number }
  | { readonly valid: false; readonly reason: 'malformed' | 'invalid' | 'replayed' };

const SIX_DIGITS = /^[0-9]{6}$/;

/**
 * Verifies a TOTP code against steps t-1, t and t+1.
 *
 * - Every step in the window is always computed and compared in constant time; there is no early
 *   exit, so timing does not reveal which step matched.
 * - Among the steps greater than `lastUsedStep`, the lowest matching one is returned, so a later
 *   legitimate code is not blocked unnecessarily.
 * - A code that matches only steps at or below `lastUsedStep` gives `replayed`.
 * - An invalid secret, clock or `lastUsedStep` throws (fail closed). A malformed user-supplied code
 *   returns `malformed` and never throws.
 */
export function verifyTotp(options: VerifyTotpOptions): VerifyTotpResult {
  const secret = requireSecret(options.secret);
  const clock = options.clock ?? Date.now;
  const lastUsedStep = options.lastUsedStep ?? -1;
  if (typeof lastUsedStep !== 'number' || !Number.isSafeInteger(lastUsedStep) || lastUsedStep < -1) {
    throw new AdminMfaCryptoError('MFA_INVALID_COUNTER');
  }
  const current = totpStepAt(clock());
  const code = options.code;
  const wellFormed = typeof code === 'string' && SIX_DIGITS.test(code);
  // A fixed-length placeholder keeps the comparison work identical for malformed input.
  const candidate = Buffer.from(wellFormed ? code : '\0'.repeat(TOTP_DIGITS), 'ascii');

  let accepted: number | null = null;
  let replayed = false;
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    if (step < 0) continue;
    const matches = constantTimeEqual(Buffer.from(computeHotp(secret, step), 'ascii'), candidate);
    if (!matches || !wellFormed) continue;
    if (step > lastUsedStep) {
      if (accepted === null) accepted = step;
    } else {
      replayed = true;
    }
  }
  if (!wellFormed) return { valid: false, reason: 'malformed' };
  if (accepted !== null) return { valid: true, step: accepted };
  return { valid: false, reason: replayed ? 'replayed' : 'invalid' };
}

// ---------------------------------------------------------------------------------------------
// Secret encryption at rest (AES-256-GCM)
// ---------------------------------------------------------------------------------------------

/** Encrypted secret material as stored in `admin_mfa_factors`. */
export interface EncryptedTotpSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
}

export interface SecretBinding {
  /** The `admin_mfa_factors.id` the ciphertext belongs to. */
  factorId: string;
  /** The owning `users.id`. */
  userId: string;
}

function associatedData(binding: SecretBinding, keyVersion: number): Buffer {
  return encodeFields([AAD_DOMAIN, requireIdentifier(binding.factorId), requireIdentifier(binding.userId), String(keyVersion)]);
}

/**
 * Encrypts a TOTP secret with AES-256-GCM.
 *
 * - A fresh 12-byte nonce comes from the secure random generator on every call.
 * - The 16-byte tag is returned separately.
 * - The factor id, user id and key version are authenticated as additional data, so ciphertext
 *   copied to another row, user or key version fails to decrypt.
 */
export function encryptTotpSecret(
  secret: Uint8Array,
  key: Uint8Array,
  keyVersion: number,
  binding: SecretBinding,
): EncryptedTotpSecret {
  requireSecret(secret);
  requireEncryptionKey(key);
  const version = requireKeyVersion(keyVersion);
  const aad = associatedData(binding, version);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), keyVersion: version };
}

/** Keys by version. The caller loads them; this module never reads files. */
export type EncryptionKeyRing = ReadonlyMap<number, Uint8Array>;

/**
 * Decrypts and authenticates a stored TOTP secret.
 *
 * Any failure throws `MFA_SECRET_DECRYPTION_FAILED` and returns no partial plaintext. Failures
 * include: a wrong key; modified ciphertext, nonce, tag or binding; a truncated tag; or plaintext of
 * the wrong length.
 */
export function decryptTotpSecret(envelope: EncryptedTotpSecret, keyRing: EncryptionKeyRing, binding: SecretBinding): Buffer {
  if (
    envelope === null || typeof envelope !== 'object'
    || !isBytes(envelope.ciphertext) || !isBytes(envelope.nonce) || !isBytes(envelope.tag)
    || envelope.nonce.length !== GCM_NONCE_BYTES || envelope.tag.length !== GCM_TAG_BYTES
    || envelope.ciphertext.length !== TOTP_SECRET_BYTES
  ) {
    throw new AdminMfaCryptoError('MFA_INVALID_ENVELOPE');
  }
  const version = requireKeyVersion(envelope.keyVersion);
  if (!(keyRing instanceof Map)) throw new AdminMfaCryptoError('MFA_INVALID_KEY');
  const key = keyRing.get(version);
  if (key === undefined) throw new AdminMfaCryptoError('MFA_UNKNOWN_KEY_VERSION');
  requireEncryptionKey(key);
  const aad = associatedData(binding, version);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.tag);
    plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } catch {
    throw new AdminMfaCryptoError('MFA_SECRET_DECRYPTION_FAILED');
  }
  if (plaintext.length !== TOTP_SECRET_BYTES) {
    plaintext.fill(0);
    throw new AdminMfaCryptoError('MFA_SECRET_DECRYPTION_FAILED');
  }
  return plaintext;
}

// ---------------------------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------------------------

function requireRecoveryLength(characters: unknown): number {
  if (
    typeof characters !== 'number' || !Number.isSafeInteger(characters)
    || characters < RECOVERY_CODE_MIN_CHARACTERS || characters > RECOVERY_CODE_MAX_CHARACTERS
  ) {
    throw new AdminMfaCryptoError('MFA_INVALID_RECOVERY_PARAMETERS');
  }
  return characters;
}

/**
 * Generates `count` distinct recovery codes, each `characters` long, from the RFC 4648 Base32
 * alphabet (5 random bits per character).
 *
 * - Each character is `randomByte & 31`. 256 is divisible by 32, so there is no modulo bias.
 * - The codes are returned in canonical form for one-time display only. The caller stores only
 *   `hashRecoveryCode` output.
 * - `count` and `characters` are owner decision D-2 and have no defaults.
 */
export function generateRecoveryCodes(count: number, characters: number): string[] {
  const length = requireRecoveryLength(characters);
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > RECOVERY_CODE_MAX_BATCH) {
    throw new AdminMfaCryptoError('MFA_INVALID_RECOVERY_PARAMETERS');
  }
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = randomBytes(length);
    let code = '';
    for (const byte of bytes) code += BASE32_ALPHABET[byte & 31];
    bytes.fill(0);
    codes.add(code);
  }
  return [...codes];
}

/**
 * Canonicalises user input: removes spaces and hyphens and upper-cases it. Returns null if the result
 * is not a plausible code (wrong alphabet or length), so the caller can reject it without hashing.
 */
export function normaliseRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > RECOVERY_CODE_MAX_CHARACTERS * 2) return null;
  const canonical = input.replace(/[\s-]/g, '').toUpperCase();
  if (canonical.length < RECOVERY_CODE_MIN_CHARACTERS || canonical.length > RECOVERY_CODE_MAX_CHARACTERS) return null;
  for (const character of canonical) if (!BASE32_ALPHABET.includes(character)) return null;
  return canonical;
}

/**
 * `HMAC-SHA256(key, domain ‖ userId ‖ code)` as 64 lower-case hex characters, with the fields
 * length-prefixed. Binding the user id means a hash is valid only for its owner. The input must
 * already be canonical (`normaliseRecoveryCode`).
 */
export function hashRecoveryCode(code: string, userId: string, key: Uint8Array): string {
  requireHmacKey(key);
  const canonical = normaliseRecoveryCode(code);
  if (canonical === null || canonical !== code) throw new AdminMfaCryptoError('MFA_INVALID_RECOVERY_PARAMETERS');
  return createHmac('sha256', key).update(encodeFields([RECOVERY_DOMAIN, requireIdentifier(userId), canonical])).digest('hex');
}

/**
 * Finds which stored hash, if any, matches a user-supplied candidate.
 *
 * - Returns the index of the first matching hash, or -1. A malformed candidate also gives -1.
 * - Every stored hash is compared in constant time, with no early exit.
 * - A malformed stored hash throws (data corruption fails closed).
 * - Marking the code used atomically (`… WHERE used_at IS NULL AND revoked_at IS NULL`) is the
 *   caller's job.
 */
export function findRecoveryCodeMatch(candidate: unknown, userId: string, storedHashes: readonly string[], key: Uint8Array): number {
  requireHmacKey(key);
  requireIdentifier(userId);
  if (!Array.isArray(storedHashes)) throw new AdminMfaCryptoError('MFA_INVALID_STORED_HASH');
  const stored = storedHashes.map((hash) => {
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) throw new AdminMfaCryptoError('MFA_INVALID_STORED_HASH');
    return Buffer.from(hash, 'hex');
  });
  const canonical = normaliseRecoveryCode(candidate);
  // A malformed candidate is compared as an all-zero digest, so the work done stays the same.
  const digest = canonical === null ? Buffer.alloc(32) : Buffer.from(hashRecoveryCode(canonical, userId, key), 'hex');
  let match = -1;
  stored.forEach((hash, index) => {
    if (constantTimeEqual(hash, digest) && canonical !== null && match === -1) match = index;
  });
  return match;
}
