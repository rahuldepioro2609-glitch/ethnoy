import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { isSessionAllowedOnSurface, isSurface, type Surface } from './surface.js';

export type UserRole = 'candidate' | 'center' | 'official';
const BCRYPT_MAX_PASSWORD_BYTES = 72;

export const registrationPasswordSchema = z.string().min(12).refine(
  (password) => Buffer.byteLength(password, 'utf8') <= BCRYPT_MAX_PASSWORD_BYTES,
  `Password must not exceed ${BCRYPT_MAX_PASSWORD_BYTES} UTF-8 bytes.`,
);

export interface AuthenticatedUser {
  id: string;
  loginId: string;
  name: string;
  role: UserRole;
  isSuperAdmin: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  sessionTokenHash?: string;
}

export const SESSION_COOKIE = 'elt_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getConfiguredOrigin(): string | undefined {
  const configuredOrigin = process.env.APP_ORIGIN;
  if (!configuredOrigin) return undefined;

  try {
    const url = new URL(configuredOrigin);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isValidRequestOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * Pre-P1-B single-origin guard. No longer mounted by the application: P1-B validates the exact
 * Origin of each surface centrally (server/surfaceEnforcement.ts). Kept for reference and its tests.
 */
export function requireTrustedMutationOrigin(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    next();
    return;
  }

  const origin = request.get('origin');
  if (!origin) {
    const hasSessionCookie = request.headers.cookie
      ?.split(';')
      .some((cookie) => cookie.trim().split('=', 1)[0] === SESSION_COOKIE);
    if (!hasSessionCookie) {
      next();
      return;
    }
  }

  const allowedOrigin = getConfiguredOrigin();
  if (!origin || !allowedOrigin || !isValidRequestOrigin(origin) || origin !== allowedOrigin) {
    response.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }
  next();
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function setSessionCookie(response: Response, token: string): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

function getSessionToken(request: AuthenticatedRequest): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

// ---------------------------------------------------------------------------
// Trusted request context (P1-B)
// ---------------------------------------------------------------------------
// Request-local state keyed by the request object in module-private WeakMaps. Request input
// (headers, body, query parameters, cookies) cannot create or change these entries; only server
// code that holds the request object and calls these functions can.

interface TrustedRequestContext {
  surface: Surface;
  expectedOrigin: string;
}

const trustedContexts = new WeakMap<object, TrustedRequestContext>();

/**
 * Records the surface (and its exact expected Origin) resolved by the surface enforcement from the
 * listener, trusted proxy peer and validated original host. Once set it cannot be changed.
 */
export function setTrustedRequestSurface(request: object, surface: Surface, expectedOrigin: string): void {
  if (!isSurface(surface) || typeof expectedOrigin !== 'string' || expectedOrigin.length === 0) {
    throw new Error('Invalid trusted request surface.');
  }
  const existing = trustedContexts.get(request);
  if (existing) {
    if (existing.surface !== surface || existing.expectedOrigin !== expectedOrigin) throw new Error('The trusted request surface cannot change.');
    return;
  }
  trustedContexts.set(request, Object.freeze({ surface, expectedOrigin }));
}

export function getTrustedRequestSurface(request: object): Surface | undefined {
  return trustedContexts.get(request)?.surface;
}

export function getTrustedRequestOrigin(request: object): string | undefined {
  return trustedContexts.get(request)?.expectedOrigin;
}

// ---------------------------------------------------------------------------
// Session loading (shared by central enforcement and requireAuth)
// ---------------------------------------------------------------------------

export type SessionLookup =
  | { status: 'no_token' }
  | { status: 'not_found' }
  | { status: 'found'; tokenHash: string; user: AuthenticatedUser; accountStatus: unknown };

const sessionLookups = new WeakMap<object, Promise<SessionLookup>>();

/**
 * Looks up the request's session at most once per request. A second caller (route-level
 * requireAuth after central enforcement) reuses the same result without another query.
 */
export function loadSession(request: AuthenticatedRequest): Promise<SessionLookup> {
  const cached = sessionLookups.get(request);
  if (cached) return cached;
  const lookup = (async (): Promise<SessionLookup> => {
    const token = getSessionToken(request);
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return { status: 'no_token' };
    const tokenHash = hashSessionToken(token);
    const { rows } = await pool.query(
      `SELECT u.id, u.login_id, u.display_name, u.role, u.account_status, u.is_super_admin
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash],
    );
    if (!rows[0]) return { status: 'not_found' };
    return {
      status: 'found',
      tokenHash,
      accountStatus: rows[0].account_status,
      user: {
        id: rows[0].id,
        loginId: rows[0].login_id,
        name: rows[0].display_name,
        role: rows[0].role,
        isSuperAdmin: rows[0].is_super_admin === true,
      },
    };
  })();
  sessionLookups.set(request, lookup);
  return lookup;
}

function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

/** session: any session valid on the trusted surface; a role or super_admin narrows it further. */
export type SessionRequirement = 'session' | UserRole | 'super_admin';

const SIGN_IN_REQUIRED = 'Sign in is required.';
const FORBIDDEN = 'You do not have permission to perform this action.';

/**
 * Authenticates the request for its trusted surface. Writes the failure response and returns false,
 * or sets request.user and returns true. Order:
 * 1. no trusted surface → 401 (fail closed, no query);
 * 2. no or malformed token → 401 (no query);
 * 3. unknown/expired/revoked session → clear cookie, 401;
 * 4. session role not valid on this surface → 401; the session is NOT revoked and its cookie is
 *    NOT cleared (it belongs to another portal and stays valid there);
 * 5. account not approved → clear cookie, 403;
 * 6. wrong role or missing Super Admin on the correct surface → 403.
 */
export async function authenticateRequest(
  request: AuthenticatedRequest,
  response: Response,
  requirement: SessionRequirement = 'session',
): Promise<boolean> {
  const surface = getTrustedRequestSurface(request);
  if (!surface) {
    response.status(401).json({ error: SIGN_IN_REQUIRED });
    return false;
  }
  const session = await loadSession(request);
  if (session.status === 'no_token') {
    response.status(401).json({ error: SIGN_IN_REQUIRED });
    return false;
  }
  if (session.status === 'not_found') {
    clearSessionCookie(response);
    response.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    return false;
  }
  const { user } = session;
  if (!isSessionAllowedOnSurface(surface, { role: user.role, isSuperAdmin: user.isSuperAdmin })) {
    response.status(401).json({ error: SIGN_IN_REQUIRED });
    return false;
  }
  if (session.accountStatus !== 'approved') {
    clearSessionCookie(response);
    response.status(403).json({ error: 'This account is not approved to access the portal.' });
    return false;
  }
  const roleAllowed = requirement === 'session'
    || (requirement === 'super_admin' ? user.role === 'official' && user.isSuperAdmin === true : user.role === requirement);
  if (!roleAllowed) {
    response.status(403).json({ error: FORBIDDEN });
    return false;
  }
  request.user = user;
  request.sessionTokenHash = session.tokenHash;
  return true;
}

export async function requireAuth(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (await authenticateRequest(request, response, 'session')) next();
  } catch (error) {
    next(error);
  }
}

/** Retained helper (D10). No route uses it since P1-B; protected routes use requireAuth. */
export function optionalAuth(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  if (getSessionToken(request) === undefined) {
    next();
    return;
  }
  void requireAuth(request, response, next);
}

export function requireRoles(...roles: UserRole[]) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    if (!request.user || !roles.includes(request.user.role)) {
      response.status(403).json({ error: FORBIDDEN });
      return;
    }
    next();
  };
}

export function requireSuperAdmin(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  if (request.user?.role !== 'official' || request.user.isSuperAdmin !== true) {
    response.status(403).json({ error: 'You do not have permission to perform this action.' });
    return;
  }
  next();
}
