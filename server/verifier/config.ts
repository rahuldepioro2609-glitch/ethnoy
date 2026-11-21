import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

export class VerifierConfigurationError extends Error {
  constructor(readonly code: 'VERIFIER_CONFIG_INVALID' | 'VERIFIER_KEY_LOAD_FAILED') {
    super(code);
    this.name = 'VerifierConfigurationError';
  }
}

export interface VerifierConfig {
  readonly bindHost: string;
  readonly port: number;
  readonly authOrigin: string;
  readonly signingKeyFile: string;
  readonly signingKeyId: string;
  readonly mfaKeyFile: string;
  readonly mfaKeyVersion: number;
  readonly production: boolean;
}

const configSchema = z.object({
  VERIFIER_BIND_HOST: z.string().min(1),
  VERIFIER_PORT: z.coerce.number().int().min(1).max(65_535),
  VERIFIER_AUTH_ORIGIN: z.string().min(1),
  VERIFIER_SIGNING_KEY_FILE: z.string().min(1),
  VERIFIER_SIGNING_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  VERIFIER_MFA_KEY_FILE: z.string().min(1),
  VERIFIER_MFA_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647),
}).strict();

function isPrivateBindAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized);
  }
  return false;
}

function isAllowedAuthOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function parseVerifierConfig(env: Readonly<Record<string, string | undefined>>): VerifierConfig {
  const parsed = configSchema.safeParse({
    VERIFIER_BIND_HOST: env.VERIFIER_BIND_HOST,
    VERIFIER_PORT: env.VERIFIER_PORT,
    VERIFIER_AUTH_ORIGIN: env.VERIFIER_AUTH_ORIGIN,
    VERIFIER_SIGNING_KEY_FILE: env.VERIFIER_SIGNING_KEY_FILE,
    VERIFIER_SIGNING_KEY_ID: env.VERIFIER_SIGNING_KEY_ID,
    VERIFIER_MFA_KEY_FILE: env.VERIFIER_MFA_KEY_FILE,
    VERIFIER_MFA_KEY_VERSION: env.VERIFIER_MFA_KEY_VERSION,
  });
  if (!parsed.success) throw new VerifierConfigurationError('VERIFIER_CONFIG_INVALID');

  const value = parsed.data;
  if (
    !isPrivateBindAddress(value.VERIFIER_BIND_HOST)
    || !isAllowedAuthOrigin(value.VERIFIER_AUTH_ORIGIN)
    || !isAbsolute(value.VERIFIER_SIGNING_KEY_FILE)
    || !isAbsolute(value.VERIFIER_MFA_KEY_FILE)
    || resolve(value.VERIFIER_SIGNING_KEY_FILE) === resolve(value.VERIFIER_MFA_KEY_FILE)
  ) {
    throw new VerifierConfigurationError('VERIFIER_CONFIG_INVALID');
  }
  if (env.NODE_ENV === 'production' && value.VERIFIER_AUTH_ORIGIN !== 'https://auth.eltnoy.com') {
    throw new VerifierConfigurationError('VERIFIER_CONFIG_INVALID');
  }

  return Object.freeze({
    bindHost: value.VERIFIER_BIND_HOST,
    port: value.VERIFIER_PORT,
    authOrigin: value.VERIFIER_AUTH_ORIGIN,
    signingKeyFile: resolve(value.VERIFIER_SIGNING_KEY_FILE),
    signingKeyId: value.VERIFIER_SIGNING_KEY_ID,
    mfaKeyFile: resolve(value.VERIFIER_MFA_KEY_FILE),
    mfaKeyVersion: value.VERIFIER_MFA_KEY_VERSION,
    production: env.NODE_ENV === 'production',
  });
}
