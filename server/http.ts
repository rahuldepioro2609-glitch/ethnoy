import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import type { AuthenticatedRequest } from './auth.js';

export function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

export function sendValidationError(response: Response, error: z.ZodError): void {
  response.status(400).json({
    error: 'Invalid request.',
    details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  });
}

export function getUser(request: Request) {
  return (request as AuthenticatedRequest).user;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/*
 * Many students share one public IP address (mobile carrier NAT, college Wi-Fi), so limits that
 * guard against guessing count only failed attempts, and signed-in actions are counted per account.
 */

/** Sign-in (password or Google): 20 failed attempts per 15 minutes per IP; successful sign-ins are not counted. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many failed sign-in attempts. Try again in 15 minutes.' },
});

/** New student or institute accounts: 30 per 15 minutes per IP, enough for a classroom registering together. */
export const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many new accounts from this network. Try again in 15 minutes.' },
});

/** Admit card and result lookups: 25 failed lookups per 15 minutes per IP, which stops date-of-birth guessing. */
export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many unsuccessful lookups. Check your details and try again in 15 minutes.' },
});

/** Other writes: 30 per 15 minutes per signed-in account, or per IP for guests. */
export const publicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (request) => {
    const userId = (request as AuthenticatedRequest).user?.id;
    return userId ? `user:${userId}` : ipKeyGenerator(request.ip ?? '');
  },
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

/** Each call creates an independent counter, so one recovery route cannot exhaust another. */
export function accountRecoveryLimiter(limit = 20) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many account requests from this network. Try again in an hour.' },
  });
}

export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many uploads. Please try again later.' },
});
