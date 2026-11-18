import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { hashSessionToken, newSessionToken, requireAuth, requireRoles, type AuthenticatedRequest } from './auth.js';
import { pool } from './db.js';
import { passwordChangedEmail, passwordResetEmail, portalLink, verificationEmail } from './emailTemplates.js';
import { accountRecoveryLimiter, asyncRoute, getUser, sendValidationError } from './http.js';
import { isEmailEnabled, sendEmailInBackground } from './mailer.js';
import { primaryOrigin, staffPortalAllowed } from './hosting.js';

export const PASSWORD_RESET_MINUTES = 30;
export const VERIFICATION_HOURS = 48;

type TokenPurpose = 'password_reset' | 'email_verification';
type Queryable = Pick<PoolClient, 'query'>;

const GENERIC_RESET_MESSAGE = 'If the login ID and email match an account, a reset link has been sent. Check your inbox and spam folder. The link expires in 30 minutes.';

function appOrigin(): string {
  return primaryOrigin();
}

/** Creates a single-use token, invalidating older unused tokens of the same purpose. */
async function issueToken(db: Queryable, userId: string, purpose: TokenPurpose, email: string, ttlMs: number): Promise<string> {
  await db.query(
    'UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
    [userId, purpose],
  );
  const token = newSessionToken();
  await db.query(
    `INSERT INTO auth_tokens (token_hash, user_id, purpose, email, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond'))`,
    [hashSessionToken(token), userId, purpose, email.toLowerCase(), ttlMs],
  );
  return token;
}

/** Atomically marks a valid token used and returns its owner, or null if invalid/expired/used. */
async function consumeToken(db: Queryable, token: string, purpose: TokenPurpose): Promise<{ user_id: string; email: string } | null> {
  const { rows } = await db.query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id, email`,
    [hashSessionToken(token), purpose],
  );
  return rows[0] ?? null;
}

export async function sendVerificationEmail(userId: string, name: string, email: string): Promise<void> {
  if (!isEmailEnabled()) return;
  const token = await issueToken(pool, userId, 'email_verification', email, VERIFICATION_HOURS * 3600_000);
  sendEmailInBackground(email, verificationEmail(name, portalLink(appOrigin(), '/verify-email', { token }), VERIFICATION_HOURS));
}

const tokenSchema = z.string().trim().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);

export function registerAccountRoutes(app: Express): void {
  app.get('/api/auth/options', (request, response) => {
    response.json({ emailEnabled: isEmailEnabled(), staffPortal: staffPortalAllowed(request.get('host')) });
  });

  app.post('/api/auth/password-reset/request', accountRecoveryLimiter(), asyncRoute(async (request, response) => {
    const parsed = z.object({
      loginId: z.string().trim().min(1).max(100),
      email: z.string().trim().email().max(254),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    if (!isEmailEnabled()) {
      response.status(503).json({ error: 'Password reset by email is not available. Contact the ELTNOY helpdesk to reset your password.' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT id, login_id, display_name, contact_email FROM users
       WHERE login_id = $1 AND lower(contact_email) = lower($2) AND account_status = 'approved'`,
      [parsed.data.loginId.toUpperCase(), parsed.data.email],
    );
    const user = rows[0];
    if (user) {
      const token = await issueToken(pool, user.id, 'password_reset', user.contact_email, PASSWORD_RESET_MINUTES * 60_000);
      sendEmailInBackground(
        user.contact_email,
        passwordResetEmail(user.display_name, user.login_id, portalLink(appOrigin(), '/reset-password', { token }), PASSWORD_RESET_MINUTES),
      );
    }
    // Same response either way, so this form cannot be used to discover accounts.
    response.json({ message: GENERIC_RESET_MESSAGE });
  }));

  app.post('/api/auth/password-reset/confirm', accountRecoveryLimiter(), asyncRoute(async (request, response) => {
    const parsed = z.object({
      token: tokenSchema,
      password: z.string().min(12, 'Use at least 12 characters.').max(128),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const token = await consumeToken(client, parsed.data.token, 'password_reset');
      const { rows } = token
        ? await client.query(
          `UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now())
           WHERE id = $1 AND lower(contact_email) = $3 AND account_status = 'approved'
           RETURNING login_id, display_name, contact_email, role`,
          [token.user_id, passwordHash, token.email],
        )
        : { rows: [] };
      if (!token || !rows[0]) {
        await client.query('ROLLBACK');
        response.status(400).json({ error: 'This reset link is invalid, expired, or already used. Request a new one.' });
        return;
      }
      await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [token.user_id]);
      await client.query('COMMIT');
      sendEmailInBackground(rows[0].contact_email, passwordChangedEmail(rows[0].display_name, rows[0].login_id));
      response.json({ message: 'Your password has been changed. Sign in with your new password.', role: rows[0].role });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post('/api/auth/verify-email', accountRecoveryLimiter(), asyncRoute(async (request, response) => {
    const parsed = z.object({ token: tokenSchema }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const token = await consumeToken(pool, parsed.data.token, 'email_verification');
    const { rowCount } = token
      ? await pool.query(
        'UPDATE users SET email_verified_at = now() WHERE id = $1 AND lower(contact_email) = $2',
        [token.user_id, token.email],
      )
      : { rowCount: 0 };
    if (!rowCount) {
      response.status(400).json({ error: 'This verification link is invalid, expired, or already used.' });
      return;
    }
    response.json({ message: 'Your email address is verified.' });
  }));

  app.get('/api/account', requireAuth, asyncRoute(async (request, response) => {
    const user = getUser(request);
    const { rows } = await pool.query(
      'SELECT login_id, display_name, role, contact_email, email_verified_at FROM users WHERE id = $1',
      [user?.id],
    );
    response.json({
      account: {
        loginId: rows[0].login_id,
        name: rows[0].display_name,
        role: rows[0].role,
        email: rows[0].contact_email,
        emailVerified: Boolean(rows[0].email_verified_at),
      },
      emailEnabled: isEmailEnabled(),
    });
  }));

  // Institutes change their email through the reviewed profile-change flow instead.
  app.put('/api/account/email', requireAuth, requireRoles('candidate', 'official'), accountRecoveryLimiter(), asyncRoute(async (request, response) => {
    const parsed = z.object({
      email: z.string().trim().email().max(254),
      currentPassword: z.string().min(1).max(128),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const user = getUser(request)!;
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!rows[0] || !(await bcrypt.compare(parsed.data.currentPassword, rows[0].password_hash))) {
      response.status(403).json({ error: 'Your current password is incorrect.' });
      return;
    }
    const email = parsed.data.email.toLowerCase();
    await pool.query(
      `UPDATE users SET contact_email = $2,
         email_verified_at = CASE WHEN lower(contact_email) = $2 THEN email_verified_at ELSE NULL END
       WHERE id = $1`,
      [user.id, email],
    );
    // Any reset link sent to the old address stops working.
    await pool.query(
      `UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL AND email <> $2`,
      [user.id, email],
    );
    const { rows: updated } = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [user.id]);
    if (!updated[0].email_verified_at) await sendVerificationEmail(user.id, user.name, email);
    response.json({ email, emailVerified: Boolean(updated[0].email_verified_at) });
  }));

  app.put('/api/account/password', requireAuth, accountRecoveryLimiter(), asyncRoute(async (request, response) => {
    const parsed = z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(12, 'Use at least 12 characters.').max(128),
    }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const user = getUser(request)!;
    const { rows } = await pool.query('SELECT password_hash, contact_email, display_name, login_id FROM users WHERE id = $1', [user.id]);
    if (!rows[0] || !(await bcrypt.compare(parsed.data.currentPassword, rows[0].password_hash))) {
      response.status(403).json({ error: 'Your current password is incorrect.' });
      return;
    }
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      response.status(400).json({ error: 'Choose a password different from your current one.' });
      return;
    }
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await bcrypt.hash(parsed.data.newPassword, 12)]);
    // Sign out every other device; keep this session.
    await pool.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2',
      [user.id, (request as AuthenticatedRequest).sessionTokenHash],
    );
    sendEmailInBackground(rows[0].contact_email, passwordChangedEmail(rows[0].display_name, rows[0].login_id));
    response.json({ message: 'Password changed. Other devices have been signed out.' });
  }));

  app.post('/api/account/email/verification', requireAuth, accountRecoveryLimiter(), asyncRoute(async (request, response) => {
    const user = getUser(request)!;
    const { rows } = await pool.query('SELECT contact_email, email_verified_at FROM users WHERE id = $1', [user.id]);
    if (!rows[0]?.contact_email) {
      response.status(400).json({ error: 'Add an email address first.' });
      return;
    }
    if (rows[0].email_verified_at) {
      response.json({ message: 'Your email address is already verified.' });
      return;
    }
    if (!isEmailEnabled()) {
      response.status(503).json({ error: 'Email is not configured on this portal yet.' });
      return;
    }
    await sendVerificationEmail(user.id, user.name, rows[0].contact_email);
    response.json({ message: `A verification link has been sent to ${rows[0].contact_email}.` });
  }));
}
