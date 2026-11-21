import {
  encodeBase32,
  generateTotpSecret,
  verifyTotp,
  type Clock,
} from '../adminMfaCore.js';
import type { VerifierMfaKeys } from './keys.js';

export interface TotpProvisioning {
  readonly secret: Buffer;
  readonly secretBase32: string;
  readonly otpauthUri: string;
}

export function provisionOfficialTotp(loginId: string): TotpProvisioning {
  const secret = generateTotpSecret();
  const secretBase32 = encodeBase32(secret);
  const label = encodeURIComponent(`ELTNOY:${loginId}`);
  const issuer = encodeURIComponent('ELTNOY');
  return Object.freeze({
    secret,
    secretBase32,
    otpauthUri: `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
  });
}

export function verifyOfficialTotp(input: {
  readonly secret: Uint8Array;
  readonly code: unknown;
  readonly lastUsedStep?: number;
  readonly clock?: Clock;
}): ReturnType<typeof verifyTotp> {
  if (typeof input.code !== 'string' || !/^[0-9]{6}$/.test(input.code)) {
    return { valid: false, reason: 'malformed' };
  }
  return verifyTotp({
    secret: input.secret,
    code: input.code,
    ...(input.lastUsedStep === undefined ? {} : { lastUsedStep: input.lastUsedStep }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

export function encryptOfficialTotpSecret(
  keys: VerifierMfaKeys,
  secret: Uint8Array,
  factorId: string,
  userId: string,
) {
  return keys.encrypt(secret, factorId, userId);
}

export function decryptOfficialTotpSecret(
  keys: VerifierMfaKeys,
  envelope: Parameters<VerifierMfaKeys['decrypt']>[0],
  factorId: string,
  userId: string,
) {
  return keys.decrypt(envelope, factorId, userId);
}
