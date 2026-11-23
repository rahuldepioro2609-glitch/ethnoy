// AUTH-1: Google OAuth 2.0 / OpenID Connect (Authorization Code flow with PKCE, state and nonce).
// Used ONLY when Google sign-in is genuinely configured (verificationProviders.ts). Nothing here
// simulates Google; the endpoints are Google's published endpoints and are contacted only when an
// operator has configured a real client.
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type { GoogleOAuthConfig } from './verificationProviders.js';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = Object.freeze(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_SECONDS = 60;

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }>;

export class GoogleTokenError extends Error {
  constructor(public readonly reason: string) {
    super(`Google identity token rejected: ${reason}`);
    this.name = 'GoogleTokenError';
  }
}

const base64url = (buffer: Buffer) => buffer.toString('base64url');

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48)); // 64 characters (RFC 7636: 43–128)
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function randomUrlToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function buildAuthorizationUrl(config: GoogleOAuthConfig, input: { state: string; nonce: string; codeChallenge: string }): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** Exchanges the authorization code (with the PKCE verifier) for tokens; returns the ID token only. */
export async function exchangeAuthorizationCode(config: GoogleOAuthConfig, code: string, codeVerifier: string, fetchImpl: FetchLike): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  }).toString();
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!response.ok) throw new GoogleTokenError(`token endpoint answered ${response.status}`);
  const data = await response.json() as { id_token?: unknown };
  if (typeof data.id_token !== 'string') throw new GoogleTokenError('no id_token in the token response');
  return data.id_token;
}

interface Jwks { keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> }

/** Google's signing keys, cached for the Cache-Control max-age (at most 24 hours). */
export function createGoogleKeySource(fetchImpl: FetchLike, now: () => number = Date.now) {
  let cache: { keys: Jwks['keys']; expires: number } | null = null;
  return async (): Promise<Jwks['keys']> => {
    if (cache && cache.expires > now()) return cache.keys;
    const response = await fetchImpl(GOOGLE_JWKS_ENDPOINT);
    if (!response.ok) throw new GoogleTokenError(`key endpoint answered ${response.status}`);
    const data = await response.json() as Jwks;
    if (!Array.isArray(data.keys)) throw new GoogleTokenError('malformed key set');
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers?.get('cache-control') ?? '')?.[1] ?? 3600);
    cache = { keys: data.keys, expires: now() + Math.min(maxAge, 86400) * 1000 };
    return data.keys;
  };
}

export interface VerifiedGoogleIdentity { sub: string; email: string }

/**
 * Verifies a Google ID token: RS256 signature with a published Google key (by kid), issuer,
 * audience (and azp when several audiences), expiry and issued-at with bounded skew, the nonce of
 * this sign-in, and email_verified === true. Client-submitted profile data is never used.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: { clientId: string; nonce: string; nowSeconds: number; getKeys: () => Promise<Jwks['keys']> },
): Promise<VerifiedGoogleIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new GoogleTokenError('malformed token');
  let header: { alg?: unknown; kid?: unknown; typ?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleTokenError('malformed token');
  }
  if (header.alg !== 'RS256') throw new GoogleTokenError('unexpected algorithm');
  if (typeof header.kid !== 'string') throw new GoogleTokenError('missing key id');
  const jwk = (await options.getKeys()).find((key) => key.kid === header.kid && (key.kty === 'RSA'));
  if (!jwk) throw new GoogleTokenError('unknown signing key');
  const signatureValid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!signatureValid) throw new GoogleTokenError('invalid signature');

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) throw new GoogleTokenError('unexpected issuer');
  const audience = claims.aud;
  const audienceOk = audience === options.clientId
    || (Array.isArray(audience) && audience.includes(options.clientId) && claims.azp === options.clientId);
  if (!audienceOk) throw new GoogleTokenError('unexpected audience');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= options.nowSeconds) throw new GoogleTokenError('expired');
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > options.nowSeconds) throw new GoogleTokenError('issued in the future');
  if (typeof claims.nonce !== 'string' || claims.nonce !== options.nonce) throw new GoogleTokenError('nonce mismatch');
  if (claims.email_verified !== true) throw new GoogleTokenError('email not verified');
  if (typeof claims.sub !== 'string' || !/^[0-9]{1,64}$/.test(claims.sub)) throw new GoogleTokenError('missing subject');
  if (typeof claims.email !== 'string' || claims.email.length > 254) throw new GoogleTokenError('missing email');
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}
