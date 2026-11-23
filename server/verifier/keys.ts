import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { constants, fstatSync, openSync, readFileSync, closeSync } from 'node:fs';
import { VerifierConfigurationError, type VerifierConfig } from './config.js';

export interface VerifierSigningKeys {
  readonly keyId: string;
  sign(payload: Uint8Array): string;
  verify(keyId: string, payload: Uint8Array, signature: string): boolean;
  destroy(): void;
}

export interface EncryptedMfaSecret {
  readonly keyVersion: number;
  readonly aadVersion: 2;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export interface VerifierMfaKeys {
  readonly activeKeyVersion: number;
  encrypt(secret: Uint8Array, factorId: string, userId: string): EncryptedMfaSecret;
  decrypt(envelope: unknown, factorId: string, userId: string): Buffer;
  destroy(): void;
}

export interface VerifierKeys {
  readonly signing: VerifierSigningKeys;
  readonly mfa: VerifierMfaKeys;
  destroy(): void;
}

export class VerifierCryptographicError extends Error {
  constructor(readonly code:
    | 'MFA_KEY_UNAVAILABLE'
    | 'MFA_KEY_VERSION_UNSUPPORTED'
    | 'MFA_AAD_VERSION_UNSUPPORTED'
    | 'MFA_CONTEXT_INVALID'
    | 'MFA_SECRET_INVALID'
    | 'MFA_CIPHERTEXT_INVALID'
    | 'MFA_SECRET_ENCRYPT_FAILED'
    | 'MFA_SECRET_DECRYPT_FAILED') {
    super(code);
    this.name = 'VerifierCryptographicError';
  }
}

export class VerifierSigningKeyUnavailableError extends Error {
  constructor() {
    super('SIGNING_KEY_UNAVAILABLE');
    this.name = 'VerifierSigningKeyUnavailableError';
  }
}

export function validateKeyFileMetadata(
  metadata: { isFile(): boolean; readonly mode: number; readonly uid: number },
  options: { readonly production: boolean; readonly effectiveUid: number },
): boolean {
  return metadata.isFile()
    && (metadata.mode & 0o077) === 0
    && (!options.production || metadata.uid === options.effectiveUid);
}

function readPrivateFile(path: string, production: boolean): Buffer {
  let descriptor: number | undefined;
  try {
    if (typeof constants.O_NOFOLLOW !== 'number') {
      throw new VerifierConfigurationError('VERIFIER_KEY_LOAD_FAILED');
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!validateKeyFileMetadata(metadata, { production, effectiveUid: process.geteuid?.() ?? -1 })) {
      throw new VerifierConfigurationError('VERIFIER_KEY_LOAD_FAILED');
    }
    return readFileSync(descriptor);
  } catch {
    throw new VerifierConfigurationError('VERIFIER_KEY_LOAD_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function encodeIdentifier(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new VerifierCryptographicError('MFA_CONTEXT_INVALID');
  }
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength > 128 || encoded.toString('utf8') !== value) {
    throw new VerifierCryptographicError('MFA_CONTEXT_INVALID');
  }
  return encoded;
}

export function encodeMfaAssociatedData(version: number, userId: unknown, factorId: unknown): Buffer {
  if (
    !Number.isSafeInteger(version)
    || version < 1
    || version > 2_147_483_647
  ) {
    throw new VerifierCryptographicError('MFA_CONTEXT_INVALID');
  }
  const fields = [
    Buffer.from('eltnoy:official-totp:aes-256-gcm:v2', 'utf8'),
    Buffer.from(String(version), 'ascii'),
    encodeIdentifier(userId),
    encodeIdentifier(factorId),
  ];
  return Buffer.concat(fields.flatMap((field) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(field.byteLength);
    return [length, field];
  }));
}

function createSigningKeys(key: KeyObject | undefined, keyId: string): VerifierSigningKeys {
  if (!key) throw new VerifierConfigurationError('VERIFIER_KEY_LOAD_FAILED');
  let privateKey: KeyObject | undefined = key;
  const publicKey = createPublicKey(privateKey);
  key = undefined;
  return Object.freeze({
    keyId,
    sign(payload: Uint8Array) {
      if (!privateKey) throw new VerifierSigningKeyUnavailableError();
      return sign(null, payload, privateKey).toString('base64url');
    },
    verify(candidateKeyId: string, payload: Uint8Array, signature: string) {
      if (candidateKeyId !== keyId || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
      try {
        return verify(null, payload, publicKey, Buffer.from(signature, 'base64url'));
      } catch {
        return false;
      }
    },
    destroy() {
      privateKey = undefined;
    },
  });
}

function createMfaKeys(key: Buffer, keyVersion: number): VerifierMfaKeys {
  let destroyed = false;
  return Object.freeze({
    activeKeyVersion: keyVersion,
    encrypt(secret: Uint8Array, factorId: string, userId: string) {
      if (destroyed) throw new VerifierCryptographicError('MFA_KEY_UNAVAILABLE');
      if (secret.byteLength !== 20) throw new VerifierCryptographicError('MFA_SECRET_INVALID');
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(encodeMfaAssociatedData(keyVersion, userId, factorId));
        const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
        return { keyVersion, aadVersion: 2 as const, nonce, ciphertext, tag: cipher.getAuthTag() };
      } catch {
        throw new VerifierCryptographicError('MFA_SECRET_ENCRYPT_FAILED');
      }
    },
    decrypt(envelope: unknown, factorId: string, userId: string) {
      if (destroyed) throw new VerifierCryptographicError('MFA_KEY_UNAVAILABLE');
      if (typeof envelope !== 'object' || envelope === null) {
        throw new VerifierCryptographicError('MFA_CIPHERTEXT_INVALID');
      }
      const candidate = envelope as Partial<EncryptedMfaSecret>;
      if (!Number.isSafeInteger(candidate.keyVersion) || candidate.keyVersion !== keyVersion) {
        throw new VerifierCryptographicError('MFA_KEY_VERSION_UNSUPPORTED');
      }
      if (candidate.aadVersion !== 2) throw new VerifierCryptographicError('MFA_AAD_VERSION_UNSUPPORTED');
      if (
        !Buffer.isBuffer(candidate.nonce)
        || !Buffer.isBuffer(candidate.tag)
        || !Buffer.isBuffer(candidate.ciphertext)
        || candidate.nonce.byteLength !== 12
        || candidate.tag.byteLength !== 16
        || candidate.ciphertext.byteLength !== 20
      ) {
        throw new VerifierCryptographicError('MFA_CIPHERTEXT_INVALID');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, candidate.nonce);
        decipher.setAAD(encodeMfaAssociatedData(keyVersion, userId, factorId));
        decipher.setAuthTag(candidate.tag);
        return Buffer.concat([decipher.update(candidate.ciphertext), decipher.final()]);
      } catch {
        throw new VerifierCryptographicError('MFA_SECRET_DECRYPT_FAILED');
      }
    },
    destroy() {
      if (!destroyed) key.fill(0);
      destroyed = true;
    },
  });
}

export function loadVerifierKeys(config: VerifierConfig): VerifierKeys {
  const signingFile = readPrivateFile(config.signingKeyFile, config.production);
  let mfaKey: Buffer | undefined;
  try {
    const signingKey = createPrivateKey(signingFile);
    if (signingKey.asymmetricKeyType !== 'ed25519') {
      throw new VerifierConfigurationError('VERIFIER_KEY_LOAD_FAILED');
    }
    mfaKey = readPrivateFile(config.mfaKeyFile, config.production);
    if (mfaKey.byteLength !== 32) {
      throw new VerifierConfigurationError('VERIFIER_KEY_LOAD_FAILED');
    }
    const encryptionKey = Buffer.from(mfaKey);
    const signing = createSigningKeys(signingKey, config.signingKeyId);
    const mfa = createMfaKeys(encryptionKey, config.mfaKeyVersion);
    return Object.freeze({
      signing,
      mfa,
      destroy() {
        signing.destroy();
        mfa.destroy();
      },
    });
  } catch {
    mfaKey?.fill(0);
    throw new VerifierConfigurationError('VERIFIER_KEY_LOAD_FAILED');
  } finally {
    signingFile.fill(0);
    mfaKey?.fill(0);
  }
}
