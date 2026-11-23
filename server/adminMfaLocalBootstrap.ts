import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pool } from './db.js';
import { loopbackDatabaseHost } from './localOperatorGuards.js';

/** Local development only. Production bootstrap remains an operator-host procedure. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'development' || !stdin.isTTY || !stdout.isTTY) {
    throw new Error('Local MFA bootstrap requires NODE_ENV=development and an interactive terminal.');
  }
  const target = process.argv[2]?.trim();
  if (!target || process.argv.length !== 3) throw new Error('Usage: npm run admin-mfa:bootstrap-local -- <LOGIN_ID>');
  // Loopback only: also refuses ?host= / ?hostaddr= parameters, which would override the URL host.
  loopbackDatabaseHost(process.env.DATABASE_URL);

  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const confirmation = await terminal.question(`Retype target login ID ${target} to issue its one-time enrollment ticket: `);
    if (confirmation.trim() !== target) throw new Error('Confirmation did not match; no ticket was issued.');
  } finally {
    terminal.close();
  }

  const ticket = randomBytes(32).toString('base64url');
  const ticketHash = createHash('sha256').update(ticket).digest('hex');
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7342519187']);

    const user = await client.query(
      `SELECT id FROM users WHERE login_id = $1 AND role = 'official' AND account_status = 'approved' AND is_super_admin = true`,
      [target],
    );
    if (user.rowCount !== 1) throw new Error('Target is not an approved Super Admin; no ticket was issued.');
    const userId = String(user.rows[0].id);

    const confirmedSuperAdmin = await client.query(
      `SELECT 1 FROM admin_mfa_factors f JOIN users u ON u.id = f.user_id
        WHERE u.role = 'official' AND u.is_super_admin = true AND f.kind = 'totp' AND f.confirmed_at IS NOT NULL LIMIT 1`,
    );
    if (confirmedSuperAdmin.rowCount !== 0) throw new Error('A Super Admin already has a confirmed authenticator; bootstrap is closed.');

    const existingFactor = await client.query(
      `SELECT 1 FROM admin_mfa_factors WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL LIMIT 1`,
      [userId],
    );
    if (existingFactor.rowCount !== 0) throw new Error('This account had a confirmed authenticator before; bootstrap is refused.');
    const openBootstrap = await client.query(
      `SELECT 1 FROM admin_mfa_enrolment_tickets
        WHERE issued_via = 'bootstrap_cli' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() LIMIT 1`,
    );
    if (openBootstrap.rowCount !== 0) throw new Error('An unexpired bootstrap ticket already exists; no ticket was issued.');

    await client.query(
      `INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, expires_at)
       VALUES ($1, $2, NULL, 'bootstrap_cli', clock_timestamp() + interval '30 minutes')`,
      [ticketHash, userId],
    );
    await client.query(
      `INSERT INTO auth_verification_events (id, action, user_id, details)
       VALUES ($1, 'admin_mfa.bootstrap_ticket_issued', $2, $3)`,
      [randomUUID(), userId, JSON.stringify({ outcome: 'issued', operator: process.env.USER ?? 'self-asserted-local-operator' })],
    );
    await client.query('COMMIT');
    console.log(`One-time enrollment ticket (expires in 30 minutes):\n${ticket}`);
    console.log('Copy it into the local Admin enrollment screen now. It will not be shown again.');
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release(failed);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Local MFA bootstrap failed.');
  process.exitCode = 1;
});
