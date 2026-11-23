import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVerifierConfig, VerifierConfigurationError } from './config.js';

const validEnvironment = {
  VERIFIER_BIND_HOST: '127.0.0.1',
  VERIFIER_PORT: '4317',
  VERIFIER_AUTH_ORIGIN: 'http://localhost:3001',
  VERIFIER_SIGNING_KEY_FILE: '/run/secrets/verifier-ed25519.pem',
  VERIFIER_SIGNING_KEY_ID: 'signing-v1',
  VERIFIER_MFA_KEY_FILE: '/run/secrets/verifier-mfa-v1.key',
  VERIFIER_MFA_KEY_VERSION: '1',
};

test('verifier configuration requires every setting', () => {
  assert.throws(
    () => parseVerifierConfig({}),
    (error: unknown) => error instanceof VerifierConfigurationError && error.code === 'VERIFIER_CONFIG_INVALID',
  );
});

test('verifier binds only private addresses and rejects shared key paths', () => {
  assert.throws(() => parseVerifierConfig({ ...validEnvironment, VERIFIER_BIND_HOST: '0.0.0.0' }));
  assert.throws(() => parseVerifierConfig({
    ...validEnvironment,
    VERIFIER_MFA_KEY_FILE: validEnvironment.VERIFIER_SIGNING_KEY_FILE,
  }));
});

test('production requires the approved HTTPS auth origin', () => {
  assert.throws(() => parseVerifierConfig({ ...validEnvironment, NODE_ENV: 'production' }));
  assert.equal(parseVerifierConfig({
    ...validEnvironment,
    VERIFIER_AUTH_ORIGIN: 'https://auth.eltnoy.com',
    NODE_ENV: 'production',
  }).authOrigin, 'https://auth.eltnoy.com');
});
