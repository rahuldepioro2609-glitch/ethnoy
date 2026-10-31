import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool } from './db.js';

export type UserRole = 'candidate' | 'center' | 'official';

export interface AuthenticatedUser {
  id: string;
  loginId: string;
  name: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  sessionTokenHash?: string;
}

export const SESSION_COOKIE = 'elt_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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
      `SELECT u.id, u.login_id, u.display_name, u.role, u.account_status
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
