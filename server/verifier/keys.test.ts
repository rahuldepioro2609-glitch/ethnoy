import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseVerifierConfig } from './config.js';
import { encodeMfaAssociatedData, loadVerifierKeys, validateKeyFileMetadata, VerifierCryptographicError } from './keys.js';

async function withTemporaryKeys(work: (environment: Record<string, string>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'eltnoy-verifier-test-'));
  try {
    const pair = generateKeyPairSync('ed25519');
    const privatePath = join(directory, 'signing.pem');
    const mfaPath = join(directory, 'mfa.key');
    await writeFile(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(mfaPath, randomBytes(32), { mode: 0o600 });
    await chmod(privatePath, 0o600);
    await chmod(mfaPath, 0o600);
    await work({
      VERIFIER_BIND_HOST: '127.0.0.1',
      VERIFIER_PORT: '4317',
      VERIFIER_AUTH_ORIGIN: 'http://localhost:3001',
      VERIFIER_SIGNING_KEY_FILE: privatePath,
      VERIFIER_SIGNING_KEY_ID: 'test-signing-v1',
      VERIFIER_MFA_KEY_FILE: mfaPath,
      VERIFIER_MFA_KEY_VERSION: '1',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('loads disposable keys, signs/verifies, and encrypts MFA secrets with identity binding', async () => {
  await withTemporaryKeys(async (environment) => {
    const keys = loadVerifierKeys(parseVerifierConfig(environment));
    try {
      const payload = Buffer.from('synthetic assertion');
      const signature = keys.signing.sign(payload);
      assert.equal(keys.signing.verify('test-signing-v1', payload, signature), true);
      assert.equal(keys.signing.verify('wrong-key-id', payload, signature), false);

      const secret = randomBytes(20);
      const encrypted = keys.mfa.encrypt(secret, 'factor-test', 'user-test');
      assert.deepEqual(keys.mfa.decrypt(encrypted, 'factor-test', 'user-test'), secret);
      assert.throws(
        () => keys.mfa.decrypt(encrypted, 'factor-other', 'user-test'),
        (error: unknown) => error instanceof VerifierCryptographicError && error.code === 'MFA_SECRET_DECRYPT_FAILED',
      );
      assert.throws(
        () => keys.mfa.decrypt({ ...encrypted, keyVersion: 2 }, 'factor-test', 'user-test'),
        (error: unknown) => error instanceof VerifierCryptographicError && error.code === 'MFA_KEY_VERSION_UNSUPPORTED',
      );
      assert.throws(
        () => keys.mfa.decrypt({ ...encrypted, nonce: Buffer.alloc(11) }, 'factor-test', 'user-test'),
        (error: unknown) => error instanceof VerifierCryptographicError && error.code === 'MFA_CIPHERTEXT_INVALID',
      );
      const tampered = { ...encrypted, tag: Buffer.from(encrypted.tag) };
      tampered.tag[0] ^= 0xff;
      assert.throws(
        () => keys.mfa.decrypt(tampered, 'factor-test', 'user-test'),
        (error: unknown) => error instanceof VerifierCryptographicError && error.code === 'MFA_SECRET_DECRYPT_FAILED',
      );
      secret.fill(0);
    } finally {
      keys.destroy();
    }
  });
});

test('destroy releases the signing-key reference and disables signing', async () => {
  await withTemporaryKeys(async (environment) => {
    const keys = loadVerifierKeys(parseVerifierConfig(environment));
    const payload = Buffer.from('synthetic assertion');
    const signature = keys.signing.sign(payload);
    keys.destroy();
    assert.throws(() => keys.signing.sign(payload));
    assert.equal(keys.signing.verify('test-signing-v1', payload, signature), true);
    const secret = randomBytes(20);
    assert.throws(
      () => keys.mfa.encrypt(secret, 'factor-test', 'user-test'),
      (error: unknown) => error instanceof VerifierCryptographicError && error.code === 'MFA_KEY_UNAVAILABLE',
    );
    secret.fill(0);
  });
});

test('length-prefixed MFA associated data separates legacy-delimiter collision pairs', async () => {
  const left = encodeMfaAssociatedData(1, 'user:part', 'factor');
  const right = encodeMfaAssociatedData(1, 'user', 'part:factor');
  assert.notDeepEqual(left, right);

  await withTemporaryKeys(async (environment) => {
    const keys = loadVerifierKeys(parseVerifierConfig(environment));
    const secret = randomBytes(20);
    try {
      const envelope = keys.mfa.encrypt(secret, 'factor', 'user:part');
      assert.deepEqual(keys.mfa.decrypt(envelope, 'factor', 'user:part'), secret);
      assert.throws(() => keys.mfa.decrypt(envelope, 'part:factor', 'user'));
      assert.throws(
        () => keys.mfa.decrypt({ ...envelope, aadVersion: 1 }, 'factor', 'user:part'),
        (error: unknown) => error instanceof VerifierCryptographicError && error.code === 'MFA_AAD_VERSION_UNSUPPORTED',
      );
    } finally {
      secret.fill(0);
      keys.destroy();
    }
  });
});

test('MFA associated data rejects invalid identifier types and UTF-8 lengths', () => {
  assert.throws(() => encodeMfaAssociatedData(1, 42, 'factor'));
  assert.throws(() => encodeMfaAssociatedData(1, 'user', 'x'.repeat(129)));
  assert.throws(() => encodeMfaAssociatedData(1, 'invalid\ud800', 'factor'));
});

test('key-loading failures are sanitized and do not disclose paths', async () => {
  await withTemporaryKeys(async (environment) => {
    await assert.rejects(
      async () => loadVerifierKeys(parseVerifierConfig({
        ...environment,
        VERIFIER_MFA_KEY_FILE: join(tmpdir(), 'missing-verifier-test-key'),
      })),
      (error: unknown) => error instanceof Error
        && error.message === 'VERIFIER_KEY_LOAD_FAILED'
        && !error.message.includes(environment.VERIFIER_SIGNING_KEY_FILE),
    );
  });
});

test('key-file loader rejects broad permissions and symlinks', async () => {
  await withTemporaryKeys(async (environment) => {
    const signingPath = environment.VERIFIER_SIGNING_KEY_FILE!;
    const mfaPath = environment.VERIFIER_MFA_KEY_FILE!;
    await chmod(signingPath, 0o640);
    await assert.rejects(async () => loadVerifierKeys(parseVerifierConfig(environment)));
    await chmod(signingPath, 0o600);

    const linkPath = join(tmpdir(), `eltnoy-verifier-link-${Date.now()}`);
    try {
      await symlink(mfaPath, linkPath);
      await assert.rejects(async () => loadVerifierKeys(parseVerifierConfig({
        ...environment,
        VERIFIER_MFA_KEY_FILE: linkPath,
      })));
    } finally {
      await rm(linkPath, { force: true });
    }
  });
});

test('key-file metadata requires regular restrictive files everywhere and production ownership', () => {
  assert.equal(validateKeyFileMetadata(
    { isFile: () => true, mode: 0o100600, uid: 501 },
    { production: true, effectiveUid: 501 },
  ), true);
  assert.equal(validateKeyFileMetadata(
    { isFile: () => true, mode: 0o100600, uid: 0 },
    { production: true, effectiveUid: 501 },
  ), false);
  assert.equal(validateKeyFileMetadata(
    { isFile: () => true, mode: 0o100640, uid: 501 },
    { production: true, effectiveUid: 501 },
  ), false);
  assert.equal(validateKeyFileMetadata(
    { isFile: () => true, mode: 0o100600, uid: 0 },
    { production: false, effectiveUid: 501 },
  ), true);
  assert.equal(validateKeyFileMetadata(
    { isFile: () => false, mode: 0o100600, uid: 501 },
    { production: false, effectiveUid: 501 },
  ), false);
  assert.equal(validateKeyFileMetadata(
    { isFile: () => true, mode: 0o100640, uid: 0 },
    { production: false, effectiveUid: 501 },
  ), false);
});
