// SM-1: helpers shared by the two independent staff modules (Platform Staff and Organization
// Staff). Nothing here touches the users table or the portal session (elt_session).
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { registrationPasswordSchema } from './auth.js';

/** Staff IDs: 4–50 characters from A–Z, 0–9, dot, underscore and hyphen; stored upper-case. */
export const STAFF_ID_PATTERN = /^[A-Za-z0-9._-]{4,50}$/;
export const staffIdSchema = z.string().trim().regex(STAFF_ID_PATTERN, 'Use 4–50 letters, digits, dots, underscores or hyphens.').transform((value) => value.toUpperCase());
export const displayNameSchema = z.string().trim().min(2).max(120);
/** Same rules as portal registration: at least 12 characters, at most 72 UTF-8 bytes (bcrypt). */
export const staffPasswordSchema = registrationPasswordSchema;
export const BCRYPT_COST = 12;

/** Session lifetime: the existing portal session lifetime (12 hours). Staff-specific value pending. */
export { SESSION_TTL_MS as STAFF_SESSION_TTL_MS } from './auth.js';

let dummyHash: Promise<string> | undefined;
/**
 * Runs a bcrypt comparison against a fixed dummy hash, so an unknown or inactive staff ID costs the
 * same time as a wrong password and the response cannot reveal which IDs exist.
 */
export async function compareAgainstDummyHash(password: string): Promise<false> {
  dummyHash ??= bcrypt.hash('eltnoy-staff-timing-equaliser', BCRYPT_COST);
  await bcrypt.compare(password, await dummyHash);
  return false;
}

export function readCookie(request: Request, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Host-only, HttpOnly, SameSite=Strict cookie scoped to the module's own API path. */
export function setScopedSessionCookie(response: Response, name: string, path: string, token: string, maxAgeMs: number): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.append('Set-Cookie', `${name}=${token}; Path=${path}; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Strict${secure}`);
  response.set('Cache-Control', 'no-store');
}

export function clearScopedSessionCookie(response: Response, name: string, path: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.append('Set-Cookie', `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
}

export function isPlausibleToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.length >= 32 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

/** Raised by a store when its tables are not installed (migration not applied). */
export class StaffStoreUnavailableError extends Error {
  constructor() {
    super('Staff management tables are not installed.');
    this.name = 'StaffStoreUnavailableError';
  }
}

export class StaffConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffConflictError';
  }
}

export class StaffNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffNotFoundError';
  }
}

export function isUndefinedTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '42P01';
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}

export function sendValidationError(response: Response, error: z.ZodError): void {
  response.status(400).json({
    error: 'Invalid request.',
    details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  });
}

/**
 * Wraps an async handler. Store errors map to fixed responses; anything else goes to the
 * application error handler (which logs it without request bodies).
 */
export function staffRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      if (error instanceof StaffStoreUnavailableError) {
        response.status(503).json({ error: 'Staff management is not installed yet. The reviewed staff migration has not been applied.', code: 'STAFF_NOT_INSTALLED' });
        return;
      }
      if (error instanceof StaffConflictError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof StaffNotFoundError) {
        response.status(404).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

/** Per-client-address limiter for staff sign-in and invitation acceptance (existing portal limits). */
export function createStaffAuthLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });
}

export const GENERIC_STAFF_LOGIN_FAILURE = 'Invalid staff ID or password.';
