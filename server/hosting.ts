import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** Origins allowed to send form submissions. APP_ORIGIN may hold several, comma-separated; the first is primary. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return list(env.APP_ORIGIN);
}

/** The public origin used to build links in emails. */
export function primaryOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return allowedOrigins(env)[0] ?? 'http://localhost:3000';
}

/**
 * Sends requests for REDIRECT_HOSTS (e.g. "eltnoy.in,www.eltnoy.in,www.eltnoy.com") to
 * https://CANONICAL_HOST with a permanent redirect, keeping the path and query.
 */
export function redirectTarget(host: string | undefined, originalUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const canonical = env.CANONICAL_HOST?.trim().toLowerCase();
  if (!canonical || !host) return null;
  const hostname = host.toLowerCase().split(':')[0];
  if (hostname === canonical || !list(env.REDIRECT_HOSTS?.toLowerCase()).includes(hostname)) return null;
  return `https://${canonical}${originalUrl.startsWith('/') ? originalUrl : '/'}`;
}

export function canonicalHostRedirect(request: Request, response: Response, next: NextFunction): void {
  const target = redirectTarget(request.get('host'), request.originalUrl);
  if (target) {
    response.redirect(301, target);
    return;
  }
  next();
}

/**
 * Creates the first Super Admin from BOOTSTRAP_ADMIN_LOGIN_ID / BOOTSTRAP_ADMIN_PASSWORD when that
 * account does not exist yet. Used where no shell is available to run `npm run user:create`
 * (such as Render's free plan). It never changes an existing account.
 */
export async function bootstrapAdmin(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<'created' | 'exists' | 'skipped'> {
  const loginId = env.BOOTSTRAP_ADMIN_LOGIN_ID?.trim().toUpperCase();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!loginId || !password) return 'skipped';
  if (!/^[A-Z0-9._-]{4,50}$/.test(loginId) || password.length < 12 || password.length > 128) {
    console.warn('BOOTSTRAP_ADMIN_* ignored: use a 4-50 character login ID and a 12-128 character password.');
    return 'skipped';
  }
  const { rows } = await pool.query(
    `INSERT INTO users (id, login_id, display_name, role, password_hash, account_status)
     VALUES ($1, $2, $3, 'official', $4, 'approved')
     ON CONFLICT (login_id) DO NOTHING
     RETURNING id`,
    [randomUUID(), loginId, env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Portal Administrator', await bcrypt.hash(password, 12)],
  );
  if (rows[0]) console.log(`Created Super Admin account ${loginId} from BOOTSTRAP_ADMIN_* settings.`);
  return rows[0] ? 'created' : 'exists';
}

/**
 * Whether the staff (Super Admin) portal may be used on this host. When STAFF_HOSTS is set
 * (e.g. "eltnoy-portal.onrender.com"), staff sign-in, staff sessions, /api/admin/* and the staff
 * pages only work on those hosts; every other host, including the public domain, gets 404.
 * When STAFF_HOSTS is unset (local development), all hosts are allowed.
 */
export function staffPortalAllowed(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const staffHosts = list(env.STAFF_HOSTS?.toLowerCase());
  if (!staffHosts.length) return true;
  return Boolean(host) && staffHosts.includes(host!.toLowerCase().split(':')[0]);
}

const STAFF_PAGE = /^\/(login|dashboard)\/official\/?$/i;

/** Returns 404 for staff pages and staff APIs on hosts where the staff portal is not allowed. */
export function blockStaffPortalOnPublicHosts(request: Request, response: Response, next: NextFunction): void {
  if (staffPortalAllowed(request.get('host'))) {
    next();
    return;
  }
  // Express matches routes case-insensitively, so compare in lower case.
  const path = request.path.toLowerCase().replace(/\/{2,}/g, '/');
  if (path === '/api/admin' || path.startsWith('/api/admin/')) {
    response.status(404).json({ error: 'Route not found.' });
    return;
  }
  if (STAFF_PAGE.test(path)) {
    response.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Page not found</title><p>Page not found. <a href="/">Go to the home page</a>.</p>');
    return;
  }
  next();
}
