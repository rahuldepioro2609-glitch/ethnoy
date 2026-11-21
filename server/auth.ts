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

/**
 * AUTH-1: server-side verification evidence attached to a portal session. Students need a session
 * issued after genuine mobile OTP verification; Institutes need verified mobile AND email,
 * institutional verification, Official approval (account_status) and no suspension.
 */
export interface SessionVerification {
  sessionVerified: boolean;
  /**
   * AUTH C1.9.1 (MFA P3a-1): for an Official session, true only if THIS session has login (or enrolment)
   * MFA evidence from a factor that is still confirmed and not disabled. Never looked up for other roles.
   * Absent or anything other than `true` means NOT verified (fail closed).
   */
  officialMfaVerified?: boolean;
  institute: {
    mobileVerified: boolean;
    emailVerified: boolean;
    institutionalStatus: 'pending' | 'verified' | 'rejected' | null;
    suspended: boolean;
  } | null;
}

export type SessionLookup =
  | { status: 'no_token' }
  | { status: 'not_found' }
  | { status: 'found'; tokenHash: string; user: AuthenticatedUser; accountStatus: unknown; verification: SessionVerification };

export type PortalVerificationDecision = { ok: true } | { ok: false; code: 'STUDENT_VERIFICATION_REQUIRED' | 'INSTITUTE_VERIFICATION_INCOMPLETE' | 'INSTITUTE_SUSPENDED' | 'ADMIN_MFA_REQUIRED'; message: string };

/**
 * Pure gate, applied to every request with a session (AUTH-1 strict; AUTH C1.9.1).
 * - Students: the session was issued after mobile OTP verification.
 * - Institutes: verified mobile and email, institutional verification, not suspended.
 * - Officials and Super Admins: the session carries MFA evidence from an active, confirmed factor. Every
 *   password-only session (all sessions issued before MFA) is refused, with no exception or switch.
 */
export function portalVerificationGate(role: UserRole, verification: SessionVerification): PortalVerificationDecision {
  if (role === 'official' && verification.officialMfaVerified !== true) {
    return { ok: false, code: 'ADMIN_MFA_REQUIRED', message: 'Administrative access requires multi-factor authentication. Please sign in again.' };
  }
  if (role === 'candidate' && !verification.sessionVerified) {
    return { ok: false, code: 'STUDENT_VERIFICATION_REQUIRED', message: 'Student sign-in requires mobile verification, which is not available yet. Please sign in again when it is.' };
  }
  if (role === 'center') {
    const institute = verification.institute;
    if (institute?.suspended) return { ok: false, code: 'INSTITUTE_SUSPENDED', message: 'This institute account is suspended.' };
    if (!institute || !institute.mobileVerified || !institute.emailVerified || institute.institutionalStatus !== 'verified') {
      return { ok: false, code: 'INSTITUTE_VERIFICATION_INCOMPLETE', message: 'Institute access requires verified mobile and email and completed institutional verification.' };
    }
  }
  return { ok: true };
}

const SESSION_WITH_VERIFICATION_SQL = `SELECT u.id, u.login_id, u.display_name, u.role, u.account_status, u.is_super_admin,
            v.verified_at AS session_verified_at,
            iv.institution_id AS iv_institution_id, iv.mobile_verified_at AS iv_mobile_verified_at,
            iv.email_verified_at AS iv_email_verified_at, iv.institutional_status AS iv_institutional_status,
            iv.suspended_at AS iv_suspended_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN auth_session_verifications v ON v.token_hash = s.token_hash
       LEFT JOIN institute_verifications iv ON iv.institution_id = u.id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`;

const SESSION_LEGACY_SQL = `SELECT u.id, u.login_id, u.display_name, u.role, u.account_status, u.is_super_admin
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`;

/**
 * AUTH C1.9.1: Official MFA evidence, looked up ONLY for Official sessions and kept separate from the
 * shared Student/Institute query, so a missing MFA table can never affect Student or Institute sign-in.
 * True only for a live session (not revoked, not expired) with login or enrolment evidence of the same
 * user from a factor that is still confirmed and not disabled. (Step-up evidence alone never counts.)
 */
export const OFFICIAL_MFA_SQL = `SELECT EXISTS (
         SELECT 1 FROM auth_session_mfa_verifications v
           JOIN admin_mfa_factors f ON f.id = v.factor_id AND f.user_id = v.user_id
          WHERE v.token_hash = s.token_hash AND v.user_id = s.user_id AND v.purpose IN ('login', 'enrol')
            AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL
       ) AS official_mfa_verified
       FROM auth_sessions s
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`;

/**
 * Fail closed: a missing MFA table (42P01) means no evidence, so the Official is refused. Any other
 * database error propagates (500); it never grants access.
 */
async function officialMfaVerified(tokenHash: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(OFFICIAL_MFA_SQL, [tokenHash]);
    return rows.length === 1 && rows[0].official_mfa_verified === true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '42P01') return false;
    throw error;
  }
}

function verificationFromRow(row: Record<string, unknown>): SessionVerification {
  return {
    sessionVerified: row.session_verified_at !== null && row.session_verified_at !== undefined,
    officialMfaVerified: false,
    institute: row.iv_institution_id ? {
      mobileVerified: Boolean(row.iv_mobile_verified_at),
      emailVerified: Boolean(row.iv_email_verified_at),
      institutionalStatus: (row.iv_institutional_status ?? null) as 'pending' | 'verified' | 'rejected' | null,
      suspended: Boolean(row.iv_suspended_at),
    } : null,
  };
}

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
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await pool.query(SESSION_WITH_VERIFICATION_SQL, [tokenHash]));
    } catch (error) {
      // AUTH-1 tables not installed yet: fall back to the session-only lookup. The verification
      // evidence is then absent, so Student and Institute sessions are refused (fail closed).
      // Official sessions are judged by their separate MFA lookup below (also fail closed).
      if (!(typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '42P01')) throw error;
      ({ rows } = await pool.query(SESSION_LEGACY_SQL, [tokenHash]));
    }
    if (!rows[0]) return { status: 'not_found' };
    const verification = verificationFromRow(rows[0]);
    if (rows[0].role === 'official') verification.officialMfaVerified = await officialMfaVerified(tokenHash);
    return {
      status: 'found',
      tokenHash,
      verification,
      accountStatus: rows[0].account_status,
      user: {
        id: rows[0].id as string,
        loginId: rows[0].login_id as string,
        name: rows[0].display_name as string,
        role: rows[0].role as UserRole,
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
  // AUTH-1 (strict): Student and Institute sessions need server-side verification evidence on every
  // request. A session issued before verification existed, or without it, is refused.
  const gate = portalVerificationGate(user.role, session.verification);
  if (!gate.ok) {
    clearSessionCookie(response);
    response.status(403).json({ error: gate.message, code: gate.code });
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
