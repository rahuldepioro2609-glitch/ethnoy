import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import test from 'node:test';
import { createOfficialAuthenticationAssertion, verifyOfficialAuthenticationAssertion } from './assertions.js';
import type { VerifierSigningKeys } from './keys.js';
import { sha256Hex, validateAuthenticationTransaction, VerifierProtocolError, type AuthenticationTransaction, type ExpectedTransactionBinding } from './transactions.js';

const NOW = 1_800_000_000;
const TEST_TRANSACTION_POLICY = Object.freeze({ maxLifetimeSeconds: 900 });
const binding: ExpectedTransactionBinding = {
  transactionId: randomUUID(),
  userId: 'synthetic-official-1',
  purpose: 'official_login',
  challenge: 'c'.repeat(43),
  browserBinding: 'b'.repeat(43),
};
const transaction: AuthenticationTransaction = {
  transactionId: binding.transactionId,
  userId: binding.userId,
  purpose: binding.purpose,
  challengeHash: sha256Hex(binding.challenge),
  browserBindingHash: sha256Hex(binding.browserBinding),
  createdAt: NOW - 10,
  expiresAt: NOW + 600,
  state: 'pending',
};

class TestAssertionReplayStore {
  private readonly consumed = new Set<string>();

  async consumeOnce(assertionId: string): Promise<boolean> {
    if (this.consumed.has(assertionId)) return false;
    this.consumed.add(assertionId);
    return true;
  }
}

function testSigningKeys(): VerifierSigningKeys {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyId: 'test-key-v1',
    sign(payload) {
      return sign(null, payload, pair.privateKey).toString('base64url');
    },
    verify(keyId, payload, signature) {
      if (keyId !== 'test-key-v1') return false;
      return verify(null, payload, pair.publicKey, Buffer.from(signature, 'base64url'));
    },
    destroy() {},
  };
}

test('transaction validation binds user, purpose, challenge, and browser', () => {
  assert.equal(validateAuthenticationTransaction(transaction, binding, NOW, TEST_TRANSACTION_POLICY).userId, binding.userId);
  assert.throws(
    () => validateAuthenticationTransaction(transaction, { ...binding, challenge: 'd'.repeat(43) }, NOW, TEST_TRANSACTION_POLICY),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_CHALLENGE_INVALID',
  );
  assert.throws(
    () => validateAuthenticationTransaction(transaction, { ...binding, browserBinding: 'e'.repeat(43) }, NOW, TEST_TRANSACTION_POLICY),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_BROWSER_BINDING_INVALID',
  );
  assert.throws(
    () => validateAuthenticationTransaction({ ...transaction, state: 'consumed' }, binding, NOW, TEST_TRANSACTION_POLICY),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_TRANSACTION_INVALID',
  );
});

test('transaction validation rejects future creation, excessive lifetime, and invalid time policy', () => {
  assert.throws(
    () => validateAuthenticationTransaction({ ...transaction, createdAt: NOW + 1 }, binding, NOW, TEST_TRANSACTION_POLICY),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_TRANSACTION_FUTURE',
  );
  assert.throws(
    () => validateAuthenticationTransaction({ ...transaction, expiresAt: NOW + 901 }, binding, NOW, TEST_TRANSACTION_POLICY),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_TRANSACTION_LIFETIME_INVALID',
  );
  assert.throws(
    () => validateAuthenticationTransaction(transaction, binding, NOW, { maxLifetimeSeconds: 0 }),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_TRANSACTION_POLICY_INVALID',
  );
  assert.throws(
    () => validateAuthenticationTransaction(transaction, binding, NOW, undefined),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_TRANSACTION_POLICY_INVALID',
  );
  assert.throws(
    () => validateAuthenticationTransaction(transaction, binding, Number.NaN, TEST_TRANSACTION_POLICY),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'AUTH_TRANSACTION_INVALID',
  );
});

test('assertion has a 30-second lifetime and verifies the intended proof purpose', () => {
  const signingKeys = testSigningKeys();
  const assertion = createOfficialAuthenticationAssertion({
    transaction, expected: binding, signingKeys, nowSeconds: NOW, transactionPolicy: TEST_TRANSACTION_POLICY,
  });
  assert.equal(assertion.claims.expiresAt - assertion.claims.issuedAt, 30);
  assert.equal(verifyOfficialAuthenticationAssertion({ ...binding, assertion }, signingKeys, NOW).userId, binding.userId);
  assert.throws(
    () => verifyOfficialAuthenticationAssertion({ ...binding, purpose: 'official_enrolment', assertion }, signingKeys, NOW),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'WRONG_PROOF_PURPOSE',
  );
});

test('assertion expiry observes the approved five-second skew and then rejects', () => {
  const signingKeys = testSigningKeys();
  const assertion = createOfficialAuthenticationAssertion({
    transaction, expected: binding, signingKeys, nowSeconds: NOW, transactionPolicy: TEST_TRANSACTION_POLICY,
  });
  assert.doesNotThrow(() => verifyOfficialAuthenticationAssertion({ ...binding, assertion }, signingKeys, NOW + 35));
  assert.throws(
    () => verifyOfficialAuthenticationAssertion({ ...binding, assertion }, signingKeys, NOW + 36),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'ASSERTION_EXPIRED',
  );
});

test('assertion issued beyond the five-second future skew is rejected', () => {
  const signingKeys = testSigningKeys();
  const assertion = createOfficialAuthenticationAssertion({
    transaction,
    expected: binding,
    signingKeys,
    nowSeconds: NOW + 10,
    transactionPolicy: TEST_TRANSACTION_POLICY,
  });
  assert.throws(
    () => verifyOfficialAuthenticationAssertion({ ...binding, assertion }, signingKeys, NOW),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'ASSERTION_NOT_YET_VALID',
  );
});

test('assertion IDs can be detected as replayed by the test-only replay store', async () => {
  const signingKeys = testSigningKeys();
  const assertion = createOfficialAuthenticationAssertion({
    transaction, expected: binding, signingKeys, nowSeconds: NOW, transactionPolicy: TEST_TRANSACTION_POLICY,
  });
  const replay = new TestAssertionReplayStore();
  const claims = verifyOfficialAuthenticationAssertion({ ...binding, assertion }, signingKeys, NOW);
  assert.equal(await replay.consumeOnce(claims.assertionId), true);
  assert.equal(await replay.consumeOnce(claims.assertionId), false);
});

test('invalid Ed25519 signatures and modified signed claims are rejected', () => {
  const signingKeys = testSigningKeys();
  const assertion = createOfficialAuthenticationAssertion({
    transaction, expected: binding, signingKeys, nowSeconds: NOW, transactionPolicy: TEST_TRANSACTION_POLICY,
  });
  const changedSignature = `${assertion.signature[0] === 'A' ? 'B' : 'A'}${assertion.signature.slice(1)}`;
  assert.throws(
    () => verifyOfficialAuthenticationAssertion({
      ...binding,
      assertion: { ...assertion, signature: changedSignature },
    }, signingKeys, NOW),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'ASSERTION_SIGNATURE_INVALID',
  );
  assert.throws(
    () => verifyOfficialAuthenticationAssertion({
      ...binding,
      assertion: { ...assertion, claims: { ...assertion.claims, userId: 'different-official' } },
    }, signingKeys, NOW),
    (error: unknown) => error instanceof VerifierProtocolError && error.code === 'ASSERTION_SIGNATURE_INVALID',
  );
});
