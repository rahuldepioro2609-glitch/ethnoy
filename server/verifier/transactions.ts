import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const OFFICIAL_PROOF_PURPOSES = ['official_login', 'official_enrolment'] as const;
export type OfficialProofPurpose = typeof OFFICIAL_PROOF_PURPOSES[number];

export class VerifierProtocolError extends Error {
  constructor(readonly code:
    | 'AUTH_TRANSACTION_INVALID'
    | 'AUTH_TRANSACTION_POLICY_INVALID'
    | 'AUTH_TRANSACTION_FUTURE'
    | 'AUTH_TRANSACTION_LIFETIME_INVALID'
    | 'AUTH_CHALLENGE_INVALID'
    | 'AUTH_BROWSER_BINDING_INVALID'
    | 'AUTH_TRANSACTION_EXPIRED'
    | 'WRONG_PROOF_PURPOSE'
    | 'ASSERTION_INVALID'
    | 'ASSERTION_EXPIRED'
    | 'ASSERTION_NOT_YET_VALID'
    | 'ASSERTION_SIGNATURE_INVALID'
    | 'ASSERTION_REPLAYED') {
    super(code);
    this.name = 'VerifierProtocolError';
  }
}

export const authTransactionSchema = z.object({
  transactionId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  purpose: z.enum(OFFICIAL_PROOF_PURPOSES),
  challengeHash: z.string().regex(/^[a-f0-9]{64}$/),
  browserBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  state: z.enum(['pending', 'completed', 'consumed']),
}).strict().refine((value) => value.expiresAt > value.createdAt, {
  message: 'Invalid authentication transaction lifetime.',
});

export type AuthenticationTransaction = z.infer<typeof authTransactionSchema>;

export interface ExpectedTransactionBinding {
  readonly transactionId: string;
  readonly userId: string;
  readonly purpose: OfficialProofPurpose;
  readonly challenge: string;
  readonly browserBinding: string;
}

export interface AuthenticationTransactionPolicy {
  /** Must be supplied from an operator-approved policy; there is deliberately no default. */
  readonly maxLifetimeSeconds: number;
}

const expectedBindingSchema = z.object({
  transactionId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  purpose: z.enum(OFFICIAL_PROOF_PURPOSES),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export function parseExpectedTransactionBinding(value: unknown): ExpectedTransactionBinding | undefined {
  const parsed = expectedBindingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function validateAuthenticationTransaction(
  input: unknown,
  expected: ExpectedTransactionBinding,
  nowSeconds: number,
  policy: AuthenticationTransactionPolicy | undefined,
): AuthenticationTransaction {
  const parsed = authTransactionSchema.safeParse(input);
  const parsedExpected = expectedBindingSchema.safeParse(expected);
  if (
    !parsed.success
    || !parsedExpected.success
    || !Number.isSafeInteger(nowSeconds)
    || nowSeconds < 0
    || parsed.data.state !== 'pending'
    || parsed.data.transactionId !== expected.transactionId
    || parsed.data.userId !== expected.userId
  ) {
    throw new VerifierProtocolError('AUTH_TRANSACTION_INVALID');
  }
  if (
    typeof policy !== 'object'
    || policy === null
    || !Number.isSafeInteger(policy.maxLifetimeSeconds)
    || policy.maxLifetimeSeconds < 1
  ) {
    throw new VerifierProtocolError('AUTH_TRANSACTION_POLICY_INVALID');
  }
  expected = parsedExpected.data;
  const transaction = parsed.data;
  if (transaction.createdAt > nowSeconds) throw new VerifierProtocolError('AUTH_TRANSACTION_FUTURE');
  if (transaction.expiresAt - transaction.createdAt > policy.maxLifetimeSeconds) {
    throw new VerifierProtocolError('AUTH_TRANSACTION_LIFETIME_INVALID');
  }
  if (transaction.purpose !== expected.purpose) throw new VerifierProtocolError('WRONG_PROOF_PURPOSE');
  if (transaction.expiresAt <= nowSeconds) throw new VerifierProtocolError('AUTH_TRANSACTION_EXPIRED');
  if (!safeHexEqual(transaction.challengeHash, sha256Hex(expected.challenge))) {
    throw new VerifierProtocolError('AUTH_CHALLENGE_INVALID');
  }
  if (!safeHexEqual(transaction.browserBindingHash, sha256Hex(expected.browserBinding))) {
    throw new VerifierProtocolError('AUTH_BROWSER_BINDING_INVALID');
  }
  return transaction;
}
