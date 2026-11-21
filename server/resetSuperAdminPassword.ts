import 'dotenv/config';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { loopbackDatabaseHost } from './localOperatorGuards.js';

function promptHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command directly in Terminal so the password prompt is hidden.'));
  }
  stdout.write(prompt);
  stdin.setEncoding('utf8');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Password reset cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function promptVisible(prompt: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(prompt)).trim();
  } finally {
    readline.close();
  }
}

function isLocalAddress(address: string | null): boolean {
  if (address === null) return true; // Unix-domain PostgreSQL socket.
  const [host, prefix, extra] = address.split('/');
  if (extra !== undefined) return false;
  const version = isIP(host);
  if (version === 4 && prefix !== undefined && prefix !== '32') return false;
  if (version === 6 && prefix !== undefined && prefix !== '128') return false;
  if (version === 6) return host.toLowerCase() === '::1' || /^(fc|fd)/i.test(host);
  if (version !== 4) return false;
  const octets = host.split('.').map(Number);
  return octets[0] === 127 || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

const loginId = z.string().trim().min(4).max(100).safeParse(process.argv[2] ?? '');
if (!loginId.success) {
  console.error('Usage: npm run user:reset-superadmin-password -- <existing-superadmin-login-id>');
  process.exitCode = 1;
} else {
  let client: PoolClient | undefined;
  let transactionOpen = false;
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('This recovery command is local-development only and refuses NODE_ENV=production.');
    }
    // Loopback only: also refuses ?host= / ?hostaddr= parameters, which would override the URL host.
    const host = loopbackDatabaseHost(process.env.DATABASE_URL);

    const target = await pool.query(
      'SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, current_user AS database_user',
    );
    const db = target.rows[0];
    if (!db || !isLocalAddress(db.server_address === null ? null : String(db.server_address))) {
      throw new Error('Refusing a database connection whose server address is not loopback.');
    }

    const normalizedLoginId = loginId.data.toUpperCase();
    const lookup = await pool.query(
      `SELECT id, login_id, display_name, role, is_super_admin, account_status
       FROM users WHERE login_id = $1`,
      [normalizedLoginId],
    );
    const user = lookup.rows[0];
    if (!user || user.role !== 'official' || user.is_super_admin !== true || user.account_status !== 'approved') {
      throw new Error('That login ID is not an approved Super Admin in this local database. No account was changed.');
    }

    stdout.write(`Target: ${user.login_id} (${user.display_name}), approved Super Admin\n`);
    stdout.write(`Database: ${db.database_name} at ${host} as ${db.database_user}\n`);
    const confirmation = await promptVisible(`Type RESET ${db.database_name} to continue (visible): `);
    if (confirmation !== `RESET ${db.database_name}`) throw new Error('Confirmation did not match. No account was changed.');

    const password = await promptHidden('Choose a new password (12-128 characters; input is hidden): ');
    if (!z.string().min(12).max(128).safeParse(password).success) {
      throw new Error('Password must be between 12 and 128 characters. No account was changed.');
    }
    const repeated = await promptHidden('Type the same password again to confirm: ');
    if (password !== repeated) throw new Error('Passwords do not match. No account was changed.');

    const passwordHash = await bcrypt.hash(password, 12);
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    const locked = await client.query(
      `SELECT id FROM users
       WHERE id = $1 AND login_id = $2 AND role = 'official'
         AND is_super_admin = true AND account_status = 'approved'
       FOR UPDATE`,
      [user.id, normalizedLoginId],
    );
    if (locked.rowCount !== 1) throw new Error('The account changed during reset. No password was changed.');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);
    await client.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    stdout.write(`Password reset for ${normalizedLoginId}. MFA settings were left unchanged; existing sessions were revoked.\n`);
  } catch (error) {
    if (transactionOpen && client) {
      try { await client.query('ROLLBACK'); } catch { /* keep the original error */ }
    }
    console.error('Could not reset Super Admin password:', error instanceof Error ? error.message : 'Unknown error.');
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
}
