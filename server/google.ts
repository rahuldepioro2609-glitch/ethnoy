import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Express, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { hashSessionToken, newSessionToken, requireAuth, requireRoles, setSessionCookie, SESSION_TTL_MS, type UserRole } from './auth.js';
import { pool } from './db.js';
import { accountRecoveryLimiter, asyncRoute, authLimiter, getUser, sendValidationError } from './http.js';

/**
 * "Sign in with Google" for students and institutes, using Google Identity Services.
 * The browser gets a Google-signed ID token; the server verifies its signature, issuer,
 * audience (GOOGLE_CLIENT_ID) and expiry before trusting the Google account it names.
 * Only the public OAuth client ID is needed: no client secret is stored.
 */

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity>;

export function googleClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.GOOGLE_CLIENT_ID?.trim();
  return id && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) ? id : null;
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export function createGoogleVerifier(clientId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))): GoogleVerifier {
  return async (credential) => {
    const { payload } = await jwtVerify(credential, keys, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      algorithms: ['RS256'],
      clockTolerance: 60,
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('Google token is missing the account details.');
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : payload.email.split('@')[0],
    };
  };
}

let verifier: GoogleVerifier | null = null;
let verifierClientId: string | null = null;

/** Lets tests replace the Google signature check. */
export function setGoogleVerifierForTests(next: GoogleVerifier | null): void {
  verifier = next;
  verifierClientId = next ? 'test' : null;
}

function getVerifier(): GoogleVerifier | null {
  if (verifierClientId === 'test') return verifier;
  const clientId = googleClientId();
  if (!clientId) return null;
  if (!verifier || verifierClientId !== clientId) {
    verifier = createGoogleVerifier(clientId);
    verifierClientId = clientId;
  }
  return verifier;
}

const credentialSchema = z.string().min(20).max(4096).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/);

async function verifiedIdentity(credential: string, response: Response): Promise<GoogleIdentity | null> {
  const verify = getVerifier();
  if (!verify) {
    response.status(503).json({ error: 'Google sign-in is not set up on this portal yet.' });
    return null;
  }
  let identity: GoogleIdentity;
  try {
    identity = await verify(credential);
  } catch {
    response.status(401).json({ error: 'Google sign-in could not be confirmed. Please try again.' });
    return null;
  }
  if (!identity.emailVerified) {
    response.status(403).json({ error: 'Your Google account email is not verified. Verify it with Google, then try again.' });
    return null;
  }
  return identity;
}

/** A student login ID such as STU48213907, for accounts created through Google. */
export function generatedStudentLoginId(): string {
  return `STU${randomInt(10_000_000, 100_000_000)}`;
}

async function startSession(response: Response, userId: string): Promise<void> {
  const token = newSessionToken();
  await pool.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
    [hashSessionToken(token), userId, Math.floor(SESSION_TTL_MS / 1000)],
  );
  setSessionCookie(response, token);
}

type UserRow = { id: string; login_id: string; display_name: string; role: UserRole; account_status: string; google_sub: string | null; email_verified_at: Date | null };

const USER_COLUMNS = 'id, login_id, display_name, role, account_status, google_sub, email_verified_at';

export function registerGoogleRoutes(app: Express): void {
  app.post('/api/auth/google', authLimiter, asyncRoute(async (request, response) => {
    const parsed = z.object({ credential: credentialSchema, role: z.enum(['candidate', 'center']) }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const { credential, role } = parsed.data;
    const identity = await verifiedIdentity(credential, response);
    if (!identity) return;

    let user: UserRow | undefined = (await pool.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE google_sub = $1`,
      [identity.sub],
    )).rows[0];

    if (user && user.role !== role) {
      response.status(409).json({
        error: user.role === 'candidate'
          ? 'This Google account is linked to a student account. Use Student Login.'
          : user.role === 'center'
            ? 'This Google account is linked to an institute account. Use Institute Login.'
            : 'This Google account cannot be used here.',
      });
      return;
    }

    let created = false;
    if (!user) {
      // An existing account with the same, already verified email is linked automatically.
      // Unverified matches are not, so nobody can pre-register someone else's email and take over their Google sign-in.
      const { rows: matches } = await pool.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE role = $1 AND lower(contact_email) = $2 ORDER BY created_at LIMIT 5`,
        [role, identity.email],
      );
      const verifiedMatches = (matches as UserRow[]).filter((row) => row.email_verified_at && !row.google_sub);
      if (verifiedMatches.length === 1) {
        user = verifiedMatches[0];
        await pool.query('UPDATE users SET google_sub = $2, google_email = $3 WHERE id = $1 AND google_sub IS NULL', [user.id, identity.sub, identity.email]);
      } else if (matches.length) {
        response.status(409).json({
          error: 'An account with this email already exists. Sign in with your login ID and password, then connect Google from your dashboard.',
        });
        return;
      } else if (role === 'center') {
        response.status(404).json({
          error: 'No institute account is connected to this Google account. Register your institute first, or sign in with your institute ID and connect Google from the dashboard.',
        });
        return;
      } else {
        const unusablePassword = await bcrypt.hash(randomBytes(32).toString('base64url'), 12);
        for (let attempt = 0; attempt < 5 && !user; attempt += 1) {
          const { rows } = await pool.query(
            `INSERT INTO users (id, login_id, display_name, role, password_hash, contact_email, email_verified_at, google_sub, google_email, has_password, account_status)
             VALUES ($1, $2, $3, 'candidate', $4, $5, now(), $6, $5, false, 'approved')
             ON CONFLICT DO NOTHING
             RETURNING ${USER_COLUMNS}`,
            [randomUUID(), generatedStudentLoginId(), identity.name, unusablePassword, identity.email, identity.sub],
          );
          user = rows[0];
          if (!user) {
            // Another request may have linked this Google account meanwhile.
            user = (await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = $1`, [identity.sub])).rows[0];
          }
        }
        if (!user) throw new Error('Could not create a student account.');
        created = true;
      }
    }

    if (user.account_status !== 'approved') {
      response.status(403).json({
        error: user.account_status === 'pending'
          ? 'Institute registration is awaiting Super Admin approval.'
          : 'This account was not approved. Contact the portal administrator.',
      });
      return;
    }
    await startSession(response, user.id);
    response.status(created ? 201 : 200).json({
      created,
      user: { id: user.id, loginId: user.login_id, name: user.display_name, role: user.role },
    });
  }));

  app.post('/api/account/google', requireAuth, requireRoles('candidate', 'center'), accountRecoveryLimiter(), asyncRoute(async (request, response) => {
    const parsed = z.object({ credential: credentialSchema }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const identity = await verifiedIdentity(parsed.data.credential, response);
    if (!identity) return;
    const user = getUser(request)!;
    const { rows: owner } = await pool.query('SELECT id FROM users WHERE google_sub = $1', [identity.sub]);
    if (owner[0] && owner[0].id !== user.id) {
      response.status(409).json({ error: 'This Google account is already connected to another ELTNOY account.' });
      return;
    }
    await pool.query('UPDATE users SET google_sub = $2, google_email = $3 WHERE id = $1', [user.id, identity.sub, identity.email]);
    response.json({ googleEmail: identity.email, message: 'Google account connected. You can now use "Continue with Google" to sign in.' });
  }));
}
