// AUTH C1.7, Phase 1: unit tests for the privileged-MFA cryptographic core (server/adminMfaCore.ts).
// Pure and deterministic. There is no database, network, file secret or environment access, and every
// key and secret below is a public test fixture.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AdminMfaCryptoError,
  RECOVERY_CODE_MAX_CHARACTERS,
  RECOVERY_CODE_MIN_CHARACTERS,
  TOTP_SECRET_BYTES,
  computeHotp,
  computeTotp,
  constantTimeEqual,
  decodeBase32,
  decryptTotpSecret,
  encodeBase32,
  encryptTotpSecret,
  findRecoveryCodeMatch,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normaliseRecoveryCode,
  totpStepAt,
  verifyTotp,
  type EncryptedTotpSecret,
} from './adminMfaCore.js';

// The RFC 4226 Appendix D / RFC 6238 Appendix B SHA-1 secret: ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const ENCRYPTION_KEY = Buffer.alloc(32, 0x11);
const OTHER_KEY = Buffer.alloc(32, 0x22);
const HMAC_KEY = Buffer.alloc(32, 0x33);
const BINDING = { factorId: 'factor-test-1', userId: 'user-test-1' };
const atStep = (step: number, offsetMs = 0) => () => step * 30_000 + offsetMs;

function assertCryptoError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof AdminMfaCryptoError && error.code === code && error.message === code);
}

// ---------------------------------------------------------------------------------------------
// RFC vectors
// ---------------------------------------------------------------------------------------------

test('RFC 4226 Appendix D: HOTP values for counters 0 to 9', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(computeHotp(RFC_SECRET, counter), code, `counter ${counter}`));
});

test('RFC 6238 Appendix B (SHA-1): every vector, truncated to six digits', () => {
  // The eight-digit RFC values are binary mod 10^8. The six-digit code is the same binary mod 10^6,
  // which is exactly the last six digits.
  const vectors: Array<[seconds: number, step: number, eightDigits: string]> = [
    [59, 1, '94287082'],
    [1111111109, 37037036, '07081804'],
    [1111111111, 37037037, '14050471'],
    [1234567890, 41152263, '89005924'],
    [2000000000, 66666666, '69279037'],
    [20000000000, 666666666, '65353130'],
  ];
  for (const [seconds, step, eight] of vectors) {
    assert.equal(totpStepAt(seconds * 1000), step, `step at ${seconds}`);
    const six = eight.slice(-6);
    assert.equal(computeTotp(RFC_SECRET, () => seconds * 1000), six, `code at ${seconds}`);
    assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code: six, clock: () => seconds * 1000 }), { valid: true, step });
  }
});

test('codes are always six digits, with leading zeroes kept', () => {
  assert.equal(computeTotp(RFC_SECRET, () => 1111111109_000), '081804');
  assert.equal(computeTotp(RFC_SECRET, () => 1234567890_000), '005924');
  for (let counter = 0; counter < 2000; counter += 1) assert.match(computeHotp(RFC_SECRET, counter), /^[0-9]{6}$/);
});

// ---------------------------------------------------------------------------------------------
// Window, clock and replay
// ---------------------------------------------------------------------------------------------

test('the current, previous and next steps are accepted, and the matched step is returned', () => {
  const step = 50_000_000;
  for (const offset of [-1, 0, 1]) {
    const code = computeHotp(RFC_SECRET, step + offset);
    assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step, 12_345) }), { valid: true, step: step + offset });
  }
});

test('steps outside ±1 are rejected', () => {
  const step = 50_000_000;
  for (const offset of [-3, -2, 2, 3]) {
    const code = computeHotp(RFC_SECRET, step + offset);
    // Skip the (1-in-a-million) case where an out-of-window code collides with an in-window one.
    if ([-1, 0, 1].some((inside) => computeHotp(RFC_SECRET, step + inside) === code)) continue;
    assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step) }), { valid: false, reason: 'invalid' });
  }
});

test('clock boundaries: the step changes exactly at a 30-second multiple', () => {
  assert.equal(totpStepAt(0), 0);
  assert.equal(totpStepAt(29_999), 0);
  assert.equal(totpStepAt(30_000), 1);
  assert.equal(totpStepAt(59_999), 1);
  assert.equal(totpStepAt(60_000), 2);
  const step = 40_000_000;
  const plusTwo = computeHotp(RFC_SECRET, step + 2);
  // The last millisecond of step s: s+2 is outside. The first millisecond of s+1: s+2 is inside.
  assert.equal(verifyTotp({ secret: RFC_SECRET, code: plusTwo, clock: atStep(step, 29_999) }).valid, false);
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code: plusTwo, clock: atStep(step + 1) }), { valid: true, step: step + 2 });
  // At the epoch there is no step -1, and step 1 is still accepted.
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code: computeHotp(RFC_SECRET, 1), clock: () => 0 }), { valid: true, step: 1 });
});

test('an invalid clock fails closed', () => {
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertCryptoError(() => verifyTotp({ secret: RFC_SECRET, code: '123456', clock: () => value }), 'MFA_INVALID_CLOCK');
  }
  assertCryptoError(() => totpStepAt('0' as unknown as number), 'MFA_INVALID_CLOCK');
});

test('replay support: steps at or below lastUsedStep are refused as replayed, and higher steps are returned', () => {
  const step = 60_000_000;
  const code = computeHotp(RFC_SECRET, step);
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step), lastUsedStep: step - 1 }), { valid: true, step });
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step), lastUsedStep: step }), { valid: false, reason: 'replayed' });
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step), lastUsedStep: step + 1 }), { valid: false, reason: 'replayed' });
  // A caller that records the returned step rejects the same code on the next attempt.
  const first = verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step), lastUsedStep: -1 });
  assert.equal(first.valid, true);
  const recorded = first.valid ? first.step : -1;
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step, 5_000), lastUsedStep: recorded }), { valid: false, reason: 'replayed' });
  for (const bad of [-2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '5' as unknown as number]) {
    assertCryptoError(() => verifyTotp({ secret: RFC_SECRET, code, clock: atStep(step), lastUsedStep: bad }), 'MFA_INVALID_COUNTER');
  }
});

test('malformed codes are rejected without throwing', () => {
  const clock = atStep(70_000_000);
  const valid = computeTotp(RFC_SECRET, clock);
  const malformed: unknown[] = [
    '', '12345', '1234567', ` ${valid}`, `${valid} `, `${valid.slice(0, 3)} ${valid.slice(3)}`, 'abcdef', '12345a', '１２３４５６',
    '-12345', '+12345', '123.45', Number(valid), null, undefined, {}, [valid], Buffer.from(valid),
  ];
  for (const code of malformed) {
    assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, clock }), { valid: false, reason: 'malformed' }, String(code));
  }
  const wrong = String((Number(valid) + 1) % 1_000_000).padStart(6, '0');
  const result = verifyTotp({ secret: RFC_SECRET, code: wrong, clock });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------------------------
// Secrets and Base32
// ---------------------------------------------------------------------------------------------

test('generated secrets are 20 random bytes and round-trip through Base32', () => {
  const seen = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    const secret = generateTotpSecret();
    assert.equal(secret.length, TOTP_SECRET_BYTES);
    const text = encodeBase32(secret);
    assert.match(text, /^[A-Z2-7]{32}$/);
    assert.deepEqual(decodeBase32(text), secret);
    seen.add(text);
  }
  assert.equal(seen.size, 200);
});

test('Base32 matches the RFC 4648 §10 vectors (unpadded canonical form)', () => {
  const vectors: Array<[string, string]> = [['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [plain, encoded] of vectors) {
    assert.equal(encodeBase32(Buffer.from(plain)), encoded);
    assert.equal(decodeBase32(encoded).toString('ascii'), plain);
  }
  assert.equal(encodeBase32(RFC_SECRET), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('invalid Base32 is refused', () => {
  const invalid = [
    '', 'my', 'MZXW6YTBOI==', 'MZXW 6YTB', 'MZXW6YT1', 'MZXW6YT8', 'MZXW6YT0', 'MZXW6YT!',
    'A', 'ABC', 'ABCDEF', // impossible lengths (mod 8 = 1, 3 or 6)
    'MZ', 'MZXR', // non-zero trailing bits ("f" is MY and "fo" is MZXQ)
  ];
  for (const text of invalid) assertCryptoError(() => decodeBase32(text), 'MFA_INVALID_BASE32');
  assertCryptoError(() => decodeBase32(undefined as unknown as string), 'MFA_INVALID_BASE32');
  assertCryptoError(() => encodeBase32('abc' as unknown as Uint8Array), 'MFA_INVALID_BASE32');
});

test('secrets of any length other than 20 bytes are refused everywhere', () => {
  const bad: unknown[] = [Buffer.alloc(0), Buffer.alloc(19), Buffer.alloc(21), Buffer.alloc(32), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', null, [1, 2, 3]];
  for (const secret of bad) {
    assertCryptoError(() => computeHotp(secret as Uint8Array, 0), 'MFA_INVALID_SECRET');
    assertCryptoError(() => verifyTotp({ secret: secret as Uint8Array, code: '123456', clock: () => 0 }), 'MFA_INVALID_SECRET');
    assertCryptoError(() => encryptTotpSecret(secret as Uint8Array, ENCRYPTION_KEY, 1, BINDING), 'MFA_INVALID_SECRET');
  }
  for (const counter of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assertCryptoError(() => computeHotp(RFC_SECRET, counter), 'MFA_INVALID_COUNTER');
  }
});

// ---------------------------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------------------------

const ring = (entries: Array<[number, Buffer]>) => new Map<number, Uint8Array>(entries);

function tamper(envelope: EncryptedTotpSecret, field: 'ciphertext' | 'nonce' | 'tag', index: number): EncryptedTotpSecret {
  const copy = Buffer.from(envelope[field]);
  copy[index] ^= 0x01;
  return { ...envelope, [field]: copy };
}

test('AES-256-GCM: round trip, with version and sizes recorded', () => {
  const secret = generateTotpSecret();
  const envelope = encryptTotpSecret(secret, ENCRYPTION_KEY, 3, BINDING);
  assert.equal(envelope.keyVersion, 3);
  assert.equal(envelope.nonce.length, 12);
  assert.equal(envelope.tag.length, 16);
  assert.equal(envelope.ciphertext.length, 20);
  assert.notDeepEqual(envelope.ciphertext, secret);
  assert.deepEqual(decryptTotpSecret(envelope, ring([[3, ENCRYPTION_KEY]]), BINDING), secret);
});

test('AES-256-GCM: key rotation is selected by key version', () => {
  const secret = generateTotpSecret();
  const old = encryptTotpSecret(secret, ENCRYPTION_KEY, 1, BINDING);
  const fresh = encryptTotpSecret(secret, OTHER_KEY, 2, BINDING);
  const keys = ring([[1, ENCRYPTION_KEY], [2, OTHER_KEY]]);
  assert.deepEqual(decryptTotpSecret(old, keys, BINDING), secret);
  assert.deepEqual(decryptTotpSecret(fresh, keys, BINDING), secret);
  assertCryptoError(() => decryptTotpSecret(fresh, ring([[1, ENCRYPTION_KEY]]), BINDING), 'MFA_UNKNOWN_KEY_VERSION');
  // Relabelling the version (the same key under another number) breaks the authenticated binding.
  assertCryptoError(() => decryptTotpSecret({ ...old, keyVersion: 2 }, ring([[2, ENCRYPTION_KEY]]), BINDING), 'MFA_SECRET_DECRYPTION_FAILED');
});

test('AES-256-GCM: a wrong key is rejected', () => {
  const envelope = encryptTotpSecret(generateTotpSecret(), ENCRYPTION_KEY, 1, BINDING);
  assertCryptoError(() => decryptTotpSecret(envelope, ring([[1, OTHER_KEY]]), BINDING), 'MFA_SECRET_DECRYPTION_FAILED');
});

test('AES-256-GCM: modified ciphertext, nonce or tag is rejected (every byte position)', () => {
  const envelope = encryptTotpSecret(generateTotpSecret(), ENCRYPTION_KEY, 1, BINDING);
  const keys = ring([[1, ENCRYPTION_KEY]]);
  for (const field of ['ciphertext', 'nonce', 'tag'] as const) {
    for (let index = 0; index < envelope[field].length; index += 1) {
      assertCryptoError(() => decryptTotpSecret(tamper(envelope, field, index), keys, BINDING), 'MFA_SECRET_DECRYPTION_FAILED');
    }
  }
});

test('AES-256-GCM: ciphertext moved to another factor or user is rejected', () => {
  const envelope = encryptTotpSecret(generateTotpSecret(), ENCRYPTION_KEY, 1, BINDING);
  const keys = ring([[1, ENCRYPTION_KEY]]);
  assertCryptoError(() => decryptTotpSecret(envelope, keys, { ...BINDING, factorId: 'factor-test-2' }), 'MFA_SECRET_DECRYPTION_FAILED');
  assertCryptoError(() => decryptTotpSecret(envelope, keys, { ...BINDING, userId: 'user-test-2' }), 'MFA_SECRET_DECRYPTION_FAILED');
  // Length prefixes keep field boundaries unambiguous ("ab" + "c" is not "a" + "bc").
  const shifted = encryptTotpSecret(generateTotpSecret(), ENCRYPTION_KEY, 1, { factorId: 'ab', userId: 'c' });
  assertCryptoError(() => decryptTotpSecret(shifted, keys, { factorId: 'a', userId: 'bc' }), 'MFA_SECRET_DECRYPTION_FAILED');
});

test('AES-256-GCM: truncated tags and malformed envelopes are refused before decryption', () => {
  const envelope = encryptTotpSecret(generateTotpSecret(), ENCRYPTION_KEY, 1, BINDING);
  const keys = ring([[1, ENCRYPTION_KEY]]);
  const malformed: unknown[] = [
    { ...envelope, tag: envelope.tag.subarray(0, 12) },
    { ...envelope, tag: envelope.tag.subarray(0, 4) },
    { ...envelope, nonce: envelope.nonce.subarray(0, 11) },
    { ...envelope, nonce: Buffer.concat([envelope.nonce, Buffer.alloc(4)]) },
    { ...envelope, ciphertext: envelope.ciphertext.subarray(0, 19) },
    { ...envelope, ciphertext: Buffer.concat([envelope.ciphertext, Buffer.alloc(1)]) },
    { ...envelope, ciphertext: envelope.ciphertext.toString('hex') },
    null,
    'envelope',
  ];
  for (const candidate of malformed) {
    assertCryptoError(() => decryptTotpSecret(candidate as EncryptedTotpSecret, keys, BINDING), 'MFA_INVALID_ENVELOPE');
  }
  for (const version of [0, -1, 1.5, Number.NaN, '1']) {
    assertCryptoError(() => decryptTotpSecret({ ...envelope, keyVersion: version as number }, keys, BINDING), 'MFA_INVALID_KEY_VERSION');
    assertCryptoError(() => encryptTotpSecret(RFC_SECRET, ENCRYPTION_KEY, version as number, BINDING), 'MFA_INVALID_KEY_VERSION');
  }
});

test('AES-256-GCM: key length is validated exactly (32 bytes)', () => {
  const envelope = encryptTotpSecret(RFC_SECRET, ENCRYPTION_KEY, 1, BINDING);
  for (const key of [Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(24), Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(64), 'k'.repeat(32), null]) {
    assertCryptoError(() => encryptTotpSecret(RFC_SECRET, key as Uint8Array, 1, BINDING), 'MFA_INVALID_KEY');
    assertCryptoError(() => decryptTotpSecret(envelope, ring([[1, key as Buffer]]), BINDING), 'MFA_INVALID_KEY');
  }
  assertCryptoError(() => decryptTotpSecret(envelope, { get: () => ENCRYPTION_KEY } as unknown as Map<number, Uint8Array>, BINDING), 'MFA_INVALID_KEY');
  for (const binding of [{ factorId: '', userId: 'u' }, { factorId: 'f', userId: '' }, { factorId: 'f'.repeat(257), userId: 'u' }, { factorId: 1, userId: 'u' }]) {
    assertCryptoError(() => encryptTotpSecret(RFC_SECRET, ENCRYPTION_KEY, 1, binding as typeof BINDING), 'MFA_INVALID_IDENTIFIER');
  }
});

test('AES-256-GCM: nonces are unique across repeated encryption of the same secret', () => {
  const nonces = new Set<string>();
  const ciphertexts = new Set<string>();
  for (let index = 0; index < 2000; index += 1) {
    const envelope = encryptTotpSecret(RFC_SECRET, ENCRYPTION_KEY, 1, BINDING);
    nonces.add(envelope.nonce.toString('hex'));
    ciphertexts.add(envelope.ciphertext.toString('hex'));
  }
  assert.equal(nonces.size, 2000);
  assert.equal(ciphertexts.size, 2000);
});

// ---------------------------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------------------------

test('recovery codes: format, distinctness and parameters (no defaults)', () => {
  const codes = generateRecoveryCodes(10, 16);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[A-Z2-7]{16}$/);
  assert.match(generateRecoveryCodes(1, RECOVERY_CODE_MIN_CHARACTERS)[0], /^[A-Z2-7]{10}$/);
  assert.equal(generateRecoveryCodes(1, RECOVERY_CODE_MAX_CHARACTERS)[0].length, RECOVERY_CODE_MAX_CHARACTERS);
  const badParameters: Array<[unknown, unknown]> = [
    [0, 16], [101, 16], [1.5, 16], ['10', 16], [undefined, 16],
    [10, RECOVERY_CODE_MIN_CHARACTERS - 1], [10, RECOVERY_CODE_MAX_CHARACTERS + 1], [10, 12.5], [10, undefined],
  ];
  for (const [count, length] of badParameters) {
    assertCryptoError(() => generateRecoveryCodes(count as number, length as number), 'MFA_INVALID_RECOVERY_PARAMETERS');
  }
});

test('recovery codes: every alphabet symbol appears, with no gross bias (sanity check, not a proof)', () => {
  const counts = new Map<string, number>();
  const codes = generateRecoveryCodes(100, 64); // 6,400 symbols; the expected count is 200 per symbol
  for (const code of codes) for (const character of code) counts.set(character, (counts.get(character) ?? 0) + 1);
  assert.equal(counts.size, 32);
  for (const [, count] of counts) assert.ok(count > 100 && count < 300, `symbol count ${count} outside sanity range`);
});

test('recovery codes: normalisation accepts spacing, hyphens and lower case, and nothing else', () => {
  assert.equal(normaliseRecoveryCode('abcd-efgh 2345'), 'ABCDEFGH2345');
  assert.equal(normaliseRecoveryCode('ABCDEFGH2345'), 'ABCDEFGH2345');
  for (const input of ['', 'ABCDEFGH1', 'ABCDEFGH0123', 'ABCDEFGH234!', 'ÄBCDEFGH2345', 'A'.repeat(65), 'A'.repeat(200), 42, null, undefined]) {
    assert.equal(normaliseRecoveryCode(input), null, String(input));
  }
});

test('recovery codes: HMAC-SHA256 hashing is consistent, keyed and bound to the user', () => {
  const [code] = generateRecoveryCodes(1, 16);
  const hash = hashRecoveryCode(code, 'user-a', HMAC_KEY);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashRecoveryCode(code, 'user-a', HMAC_KEY), hash);
  assert.notEqual(hashRecoveryCode(code, 'user-b', HMAC_KEY), hash);
  assert.notEqual(hashRecoveryCode(code, 'user-a', Buffer.alloc(32, 0x44)), hash);
  assert.ok(!hash.includes(code.toLowerCase()) && !hash.includes(code));
  // An independent recomputation pins the documented construction, so that a later change cannot
  // silently invalidate stored hashes. The construction is HMAC-SHA256 over length-prefixed
  // (uint32 big-endian) fields: domain, user id, canonical code.
  const field = (value: string) => { const bytes = Buffer.from(value, 'utf8'); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); };
  const independent = createHmac('sha256', HMAC_KEY)
    .update(Buffer.concat([field('eltnoy-admin-mfa-recovery-code-v1'), field('user-a'), field('ABCDEFGH234567AB')]))
    .digest('hex');
  assert.equal(hashRecoveryCode('ABCDEFGH234567AB', 'user-a', HMAC_KEY), independent);
  // Only canonical input may be hashed; the caller normalises first.
  assertCryptoError(() => hashRecoveryCode('abcdefgh23456789', 'user-a', HMAC_KEY), 'MFA_INVALID_RECOVERY_PARAMETERS');
  for (const key of [Buffer.alloc(31), Buffer.alloc(0), 'k'.repeat(64), null]) {
    assertCryptoError(() => hashRecoveryCode(code, 'user-a', key as Uint8Array), 'MFA_INVALID_KEY');
  }
});

test('recovery codes: matching a candidate against stored hashes', () => {
  const codes = generateRecoveryCodes(10, 16);
  const stored = codes.map((code) => hashRecoveryCode(code, 'user-a', HMAC_KEY));
  codes.forEach((code, index) => assert.equal(findRecoveryCodeMatch(code, 'user-a', stored, HMAC_KEY), index));
  const display = `${codes[4].slice(0, 4).toLowerCase()}-${codes[4].slice(4, 8)} ${codes[4].slice(8)}`;
  assert.equal(findRecoveryCodeMatch(display, 'user-a', stored, HMAC_KEY), 4);
  assert.equal(findRecoveryCodeMatch(codes[0], 'user-b', stored, HMAC_KEY), -1);
  assert.equal(findRecoveryCodeMatch(codes[0], 'user-a', stored, Buffer.alloc(32, 0x44)), -1);
  assert.equal(findRecoveryCodeMatch(generateRecoveryCodes(1, 16)[0], 'user-a', stored, HMAC_KEY), -1);
  for (const candidate of ['', 'short', '!!!!!!!!!!!!!!!!', null, 42, undefined]) {
    assert.equal(findRecoveryCodeMatch(candidate, 'user-a', stored, HMAC_KEY), -1);
  }
  assert.equal(findRecoveryCodeMatch(codes[0], 'user-a', [], HMAC_KEY), -1);
});

test('recovery codes: every stored hash is examined, with no early exit at a match (fail closed on corruption)', () => {
  const [code] = generateRecoveryCodes(1, 16);
  const good = hashRecoveryCode(code, 'user-a', HMAC_KEY);
  // The match is first, but a corrupt later entry is still reached and still throws, which proves the loop
  // does not stop at the first match.
  for (const corrupt of ['xyz', good.toUpperCase(), good.slice(0, 63), 42]) {
    assertCryptoError(() => findRecoveryCodeMatch(code, 'user-a', [good, corrupt as string], HMAC_KEY), 'MFA_INVALID_STORED_HASH');
  }
  assertCryptoError(() => findRecoveryCodeMatch(code, 'user-a', 'not-an-array' as unknown as string[], HMAC_KEY), 'MFA_INVALID_STORED_HASH');
});

// ---------------------------------------------------------------------------------------------
// Constant-time comparison (implementation level)
// ---------------------------------------------------------------------------------------------

test('constantTimeEqual: equal, unequal and different-length inputs', () => {
  assert.equal(constantTimeEqual(Buffer.from('123456'), Buffer.from('123456')), true);
  assert.equal(constantTimeEqual(Buffer.from('123456'), Buffer.from('123457')), false);
  assert.equal(constantTimeEqual(Buffer.from('123456'), Buffer.from('1234567')), false);
  assert.equal(constantTimeEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
  assert.equal(constantTimeEqual('123456' as unknown as Uint8Array, Buffer.from('123456')), false);
});

test('static: code and hash comparisons go through timingSafeEqual, and the TOTP window has no early return', async () => {
  const source = await readFile(new URL('./adminMfaCore.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*\btimingSafeEqual\b[^}]*\} from 'node:crypto'/);
  assert.match(source, /return timingSafeEqual\(left, right\);/);
  const body = (name: string) => {
    const start = source.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, name);
    const next = source.indexOf('\nexport ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };
  const verify = body('verifyTotp');
  const match = body('findRecoveryCodeMatch');
  assert.match(verify, /constantTimeEqual\(/);
  assert.match(match, /constantTimeEqual\(/);
  // No direct string or Buffer equality on codes or digests.
  for (const fn of [verify, match]) {
    assert.doesNotMatch(fn, /(code|candidate|digest|hash)\s*={2,3}\s*[a-z]/i);
    assert.doesNotMatch(fn, /\.equals\(/);
  }
  // The window loop has no return or break inside it.
  const loop = verify.slice(verify.indexOf('for (let step'), verify.indexOf('if (!wellFormed) return'));
  assert.doesNotMatch(loop, /\breturn\b|\bbreak\b/);
  // forEach over every stored hash (no some or find, which would short-circuit).
  assert.match(match, /stored\.forEach\(/);
  assert.doesNotMatch(match, /\.(some|find|findIndex|indexOf)\(/);
});

// ---------------------------------------------------------------------------------------------
// No secrets in errors or logs
// ---------------------------------------------------------------------------------------------

test('no plaintext secret, code or key appears in error messages, stacks or serialisation', () => {
  const secret = Buffer.from('0123456789abcdefghij', 'ascii');
  const secretForms = [secret.toString('hex'), encodeBase32(secret), secret.toString('ascii'), secret.toString('base64')];
  const [recovery] = generateRecoveryCodes(1, 16);
  const forbidden = [...secretForms, recovery, ENCRYPTION_KEY.toString('hex'), HMAC_KEY.toString('hex'), OTHER_KEY.toString('hex')];
  const envelope = encryptTotpSecret(secret, ENCRYPTION_KEY, 1, BINDING);
  const failures: unknown[] = [];
  const capture = (action: () => unknown) => { try { action(); } catch (error) { failures.push(error); } };
  capture(() => decryptTotpSecret(envelope, ring([[1, OTHER_KEY]]), BINDING));
  capture(() => decryptTotpSecret(tamper(envelope, 'tag', 0), ring([[1, ENCRYPTION_KEY]]), BINDING));
  capture(() => encryptTotpSecret(Buffer.concat([secret, Buffer.from('x')]), ENCRYPTION_KEY, 1, BINDING));
  capture(() => decodeBase32(`${encodeBase32(secret)}=`));
  capture(() => hashRecoveryCode(recovery.toLowerCase(), 'user-a', HMAC_KEY));
  capture(() => findRecoveryCodeMatch(recovery, 'user-a', ['bad'], HMAC_KEY));
  capture(() => hashRecoveryCode(recovery, 'user-a', HMAC_KEY.subarray(0, 31)));
  assert.equal(failures.length, 7);
  for (const error of failures) {
    assert.ok(error instanceof AdminMfaCryptoError);
    const rendered = [error.message, String(error.stack), String(error), JSON.stringify(error), JSON.stringify(Object.entries(error))].join('\n');
    for (const value of forbidden) assert.ok(!rendered.includes(value), 'error output contains protected material');
  }
});

test('the module never logs: no console or stream output during success and failure paths', async () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = methods.map((method) => console[method]);
  const calls: string[] = [];
  methods.forEach((method) => { console[method] = (...args: unknown[]) => { calls.push(`${method}:${args.length}`); }; });
  try {
    const secret = generateTotpSecret();
    const envelope = encryptTotpSecret(secret, ENCRYPTION_KEY, 1, BINDING);
    decryptTotpSecret(envelope, ring([[1, ENCRYPTION_KEY]]), BINDING);
    verifyTotp({ secret, code: computeTotp(secret, atStep(1_000)), clock: atStep(1_000) });
    verifyTotp({ secret, code: 'bad', clock: atStep(1_000) });
    const codes = generateRecoveryCodes(3, 12);
    findRecoveryCodeMatch(codes[0], 'u', codes.map((code) => hashRecoveryCode(code, 'u', HMAC_KEY)), HMAC_KEY);
    for (const action of [
      () => decryptTotpSecret(envelope, ring([[1, OTHER_KEY]]), BINDING),
      () => decodeBase32('a'),
      () => computeHotp(Buffer.alloc(3), 0),
    ]) {
      try { action(); } catch { /* expected */ }
    }
  } finally {
    methods.forEach((method, index) => { console[method] = originals[index]; });
  }
  assert.deepEqual(calls, []);
  const source = await readFile(new URL('./adminMfaCore.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)|\bprocess\.env\b|from 'node:fs|from 'pg'|from 'express'|readFile/);
});

test('static: the module imports only node:crypto (pure: no Express, PostgreSQL, filesystem or network)', async () => {
  const source = await readFile(new URL('./adminMfaCore.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:crypto']);
  assert.doesNotMatch(source, /\bimport\(/);
});
