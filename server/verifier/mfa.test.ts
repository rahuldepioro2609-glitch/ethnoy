import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTotp, generateTotpSecret } from '../adminMfaCore.js';
import { provisionOfficialTotp, verifyOfficialTotp } from './mfa.js';

test('verifier provisions compatible TOTP material and verifies a synthetic code', () => {
  const provisioning = provisionOfficialTotp('SYNTHETIC-OFFICIAL');
  try {
    assert.match(provisioning.secretBase32, /^[A-Z2-7]+$/);
    assert.match(provisioning.otpauthUri, /^otpauth:\/\/totp\/ELTNOY%3ASYNTHETIC-OFFICIAL\?/);
    const clock = () => 1_800_000_000_000;
    const code = computeTotp(provisioning.secret, clock);
    assert.deepEqual(verifyOfficialTotp({ secret: provisioning.secret, code, clock }), {
      valid: true,
      step: Math.floor(clock() / 30_000),
    });
    assert.deepEqual(verifyOfficialTotp({ secret: provisioning.secret, code: 'abc123', clock }), {
      valid: false,
      reason: 'malformed',
    });
  } finally {
    provisioning.secret.fill(0);
  }
});

test('verifier TOTP adapter rejects replayed steps', () => {
  const secret = generateTotpSecret();
  const clock = () => 1_800_000_000_000;
  try {
    const code = computeTotp(secret, clock);
    const step = Math.floor(clock() / 30_000);
    assert.deepEqual(verifyOfficialTotp({ secret, code, lastUsedStep: step, clock }), {
      valid: false,
      reason: 'replayed',
    });
  } finally {
    secret.fill(0);
  }
});

test('verifier TOTP adapter rejects malformed and non-six-digit codes', () => {
  const secret = generateTotpSecret();
  try {
    for (const code of ['', '12345', '1234567', '12a456', null, 123456]) {
      assert.deepEqual(verifyOfficialTotp({ secret, code }), { valid: false, reason: 'malformed' });
    }
    assert.deepEqual(verifyOfficialTotp({ secret, code: '000000', clock: () => 1_000 }), {
      valid: false,
      reason: 'invalid',
    });
  } finally {
    secret.fill(0);
  }
});
