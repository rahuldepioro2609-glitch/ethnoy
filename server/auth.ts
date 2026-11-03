import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';

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

export async function requireAuth(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = getSessionToken(request);
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
    response.status(401).json({ error: 'Sign in is required.' });
    return;
  }

  try {
    const tokenHash = hashSessionToken(token);
    const { rows } = await pool.query(
      `SELECT u.id, u.login_id, u.display_name, u.role, u.account_status, u.is_super_admin
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash],
    );
    if (!rows[0]) {
      response.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });
      response.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      return;
    }
    if (rows[0].account_status !== 'approved') {
      response.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });
      response.status(403).json({ error: 'This account is not approved to access the portal.' });
      return;
    }

    request.user = {
      id: rows[0].id,
      loginId: rows[0].login_id,
      name: rows[0].display_name,
      role: rows[0].role,
      isSuperAdmin: rows[0].is_super_admin === true,
    };
    request.sessionTokenHash = tokenHash;
    next();
  } catch (error) {
    next(error);
  }
}

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
      response.status(403).json({ error: 'You do not have permission to perform this action.' });
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
