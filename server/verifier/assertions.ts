import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { VerifierSigningKeys } from './keys.js';
import {
  authTransactionSchema,
  OFFICIAL_PROOF_PURPOSES,
  parseExpectedTransactionBinding,
  sha256Hex,
  validateAuthenticationTransaction,
  VerifierProtocolError,
  type AuthenticationTransaction,
  type AuthenticationTransactionPolicy,
  type ExpectedTransactionBinding,
  type OfficialProofPurpose,
} from './transactions.js';

export const ASSERTION_LIFETIME_SECONDS = 30;
export const ASSERTION_CLOCK_SKEW_SECONDS = 5;
export const ASSERTION_ISSUER = 'urn:eltnoy:official-verifier:v1';
export const ASSERTION_AUDIENCE = 'urn:eltnoy:api-session-gateway';

const claimsSchema = z.object({
  version: z.literal(1),
  issuer: z.literal(ASSERTION_ISSUER),
  audience: z.literal(ASSERTION_AUDIENCE),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  assertionId: z.string().uuid(),
  transactionId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  purpose: z.enum(OFFICIAL_PROOF_PURPOSES),
  challengeHash: z.string().regex(/^[a-f0-9]{64}$/),
  browserBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict();

export type OfficialAuthenticationAssertionClaims = z.infer<typeof claimsSchema>;
export interface SignedOfficialAuthenticationAssertion {
  readonly claims: OfficialAuthenticationAssertionClaims;
  readonly signature: string;
}

export interface AssertionVerificationExpectation extends ExpectedTransactionBinding {
  readonly assertion: unknown;
}

function canonicalClaims(claims: OfficialAuthenticationAssertionClaims): Buffer {
  return Buffer.from(JSON.stringify({
    version: claims.version,
    issuer: claims.issuer,
    audience: claims.audience,
    keyId: claims.keyId,
    assertionId: claims.assertionId,
    transactionId: claims.transactionId,
    userId: claims.userId,
    purpose: claims.purpose,
    challengeHash: claims.challengeHash,
    browserBindingHash: claims.browserBindingHash,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  }), 'utf8');
}

export function createOfficialAuthenticationAssertion(input: {
  readonly transaction: AuthenticationTransaction;
  readonly expected: ExpectedTransactionBinding;
  readonly signingKeys: VerifierSigningKeys;
  readonly nowSeconds: number;
  readonly transactionPolicy: AuthenticationTransactionPolicy;
}): SignedOfficialAuthenticationAssertion {
  const transaction = validateAuthenticationTransaction(
    input.transaction,
    input.expected,
    input.nowSeconds,
    input.transactionPolicy,
  );
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 1) {
    throw new VerifierProtocolError('AUTH_TRANSACTION_INVALID');
  }
  const expiresAt = input.nowSeconds + ASSERTION_LIFETIME_SECONDS;
  if (transaction.expiresAt < expiresAt) throw new VerifierProtocolError('AUTH_TRANSACTION_EXPIRED');
  const parsed = claimsSchema.parse({
    version: 1,
    issuer: ASSERTION_ISSUER,
    audience: ASSERTION_AUDIENCE,
    keyId: input.signingKeys.keyId,
    assertionId: randomUUID(),
    transactionId: transaction.transactionId,
    userId: transaction.userId,
    purpose: transaction.purpose,
    challengeHash: sha256Hex(input.expected.challenge),
    browserBindingHash: sha256Hex(input.expected.browserBinding),
    issuedAt: input.nowSeconds,
    expiresAt,
  });
  return Object.freeze({
    claims: parsed,
    signature: input.signingKeys.sign(canonicalClaims(parsed)),
  });
}

export function verifyOfficialAuthenticationAssertion(
  input: AssertionVerificationExpectation,
  signingKeys: VerifierSigningKeys,
  nowSeconds: number,
): OfficialAuthenticationAssertionClaims {
  const assertionSchema = z.object({
    claims: claimsSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }).strict();
  const parsed = assertionSchema.safeParse(input.assertion);
  if (!parsed.success || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new VerifierProtocolError('ASSERTION_INVALID');
  }
  const { claims, signature } = parsed.data;
  if (!signingKeys.verify(claims.keyId, canonicalClaims(claims), signature)) {
    throw new VerifierProtocolError('ASSERTION_SIGNATURE_INVALID');
  }
  const expectedBinding: ExpectedTransactionBinding = {
    transactionId: input.transactionId,
    userId: input.userId,
    purpose: input.purpose,
    challenge: input.challenge,
    browserBinding: input.browserBinding,
  };
  if (!parseExpectedTransactionBinding(expectedBinding)) {
    throw new VerifierProtocolError('ASSERTION_INVALID');
  }
  if (claims.purpose !== input.purpose) throw new VerifierProtocolError('WRONG_PROOF_PURPOSE');
  if (
    claims.transactionId !== input.transactionId
    || claims.userId !== input.userId
    || claims.challengeHash !== sha256Hex(input.challenge)
  ) {
    throw new VerifierProtocolError('AUTH_CHALLENGE_INVALID');
  }
  if (claims.browserBindingHash !== sha256Hex(input.browserBinding)) {
    throw new VerifierProtocolError('AUTH_BROWSER_BINDING_INVALID');
  }
  if (
    claims.expiresAt - claims.issuedAt !== ASSERTION_LIFETIME_SECONDS
  ) {
    throw new VerifierProtocolError('ASSERTION_INVALID');
  }
  if (claims.issuedAt > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS) {
    throw new VerifierProtocolError('ASSERTION_NOT_YET_VALID');
  }
  if (nowSeconds > claims.expiresAt + ASSERTION_CLOCK_SKEW_SECONDS) {
    throw new VerifierProtocolError('ASSERTION_EXPIRED');
  }
  return claims;
}

export interface AssertionReplayStore {
  /** Must be invoked in the same transaction as the protected proof mutation; no production implementation exists in Phase 1. */
  consumeOnce(assertionId: string, expiresAt: number): Promise<boolean>;
}

export function parseAssertionPurpose(value: unknown): OfficialProofPurpose | undefined {
  const parsed = z.enum(OFFICIAL_PROOF_PURPOSES).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseTransaction(value: unknown): AuthenticationTransaction | undefined {
  const parsed = authTransactionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
