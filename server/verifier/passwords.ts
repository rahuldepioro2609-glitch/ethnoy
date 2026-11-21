import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const VERIFIER_MAX_PASSWORD_CHARACTERS = 128;
const BCRYPT_HASH = /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/;

const credentialSchema = z.object({
  loginId: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(VERIFIER_MAX_PASSWORD_CHARACTERS),
}).strict();

export type PasswordCredentialInput = z.infer<typeof credentialSchema>;

export function parsePasswordCredentialInput(value: unknown): PasswordCredentialInput | undefined {
  const parsed = credentialSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Compatibility-only bcrypt adapter. It accepts bcrypt hashes without rewriting them and deliberately
 * returns the same false result for bad passwords and malformed stored hashes.
 */
export async function verifyBcryptPassword(password: unknown, storedHash: unknown): Promise<boolean> {
  if (
    typeof password !== 'string'
    || password.length === 0
    || password.length > VERIFIER_MAX_PASSWORD_CHARACTERS
    || typeof storedHash !== 'string'
    || !BCRYPT_HASH.test(storedHash)
  ) {
    return false;
  }
  try {
    return await bcrypt.compare(password, storedHash);
  } catch {
    return false;
  }
}
