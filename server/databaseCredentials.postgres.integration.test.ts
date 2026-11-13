// PostgreSQL integration test for DATABASE_PASSWORD_FILE (UD-1-B).
//
// Skipped unless ELTNOY_CREDENTIALS_INTEGRATION=1. It then requires:
//   ELTNOY_CREDENTIALS_TEST_DATABASE_URL   postgresql://eltnoy_credentials_probe@<host>:<port>/eltnoy_credentials_test
//                                         (no password; the host must be loopback or exactly
//                                         ELTNOY_CREDENTIALS_TEST_ALLOWED_HOST, and the server must require a
//                                         password for that connection, e.g. scram-sha-256 over the network)
//   ELTNOY_CREDENTIALS_TEST_PASSWORD_FILE  absolute path of the probe role's password file
// The probe role must be a non-superuser LOGIN role that owns nothing. The test changes ONLY that role's
// own password (via a client-side SCRAM verifier, so no plain text reaches SQL or the server log) and
// restores it before finishing. Never point it at a real database.
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import pg from 'pg';
import { databasePoolConfig } from './databaseCredentials.js';

const TEST_DATABASE = 'eltnoy_credentials_test';
const PROBE_ROLE = 'eltnoy_credentials_probe';
const enabled = process.env.ELTNOY_CREDENTIALS_INTEGRATION === '1';
const options = { skip: enabled ? false : 'Set ELTNOY_CREDENTIALS_INTEGRATION=1 to run against the dedicated disposable test database.' };

function target(): { url: string; passwordFile: string } {
  const url = process.env.ELTNOY_CREDENTIALS_TEST_DATABASE_URL;
  const passwordFile = process.env.ELTNOY_CREDENTIALS_TEST_PASSWORD_FILE;
  if (!url || !passwordFile) throw new Error('ELTNOY_CREDENTIALS_TEST_DATABASE_URL and ELTNOY_CREDENTIALS_TEST_PASSWORD_FILE are required.');
  const parsed = new URL(url);
  const allowedHost = process.env.ELTNOY_CREDENTIALS_TEST_ALLOWED_HOST;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (decodeURIComponent(parsed.pathname.slice(1)) !== TEST_DATABASE || decodeURIComponent(parsed.username) !== PROBE_ROLE
      || parsed.password !== '' || !(loopback || (allowedHost && parsed.hostname === allowedHost))) {
    throw new Error(`Only ${PROBE_ROLE} on the dedicated ${TEST_DATABASE} database on a loopback or explicitly allowed host may be used.`);
  }
  return { url, passwordFile };
}

/** What psql's \password sends: a SCRAM-SHA-256 verifier, never the password itself. */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const work = mkdtempSync(join(tmpdir(), 'eltnoy-cred-it-'));
after(() => rmSync(work, { recursive: true, force: true }));
function privateFile(name: string, content: string): string {
  const path = join(work, name);
  writeFileSync(path, `${content}\n`, { mode: 0o600 });
  chmodSync(path, 0o400);
  return path;
}
function rewriteInPlace(path: string, content: string): void {
  chmodSync(path, 0o600);
  writeFileSync(path, `${content}\n`); // same inode, as an in-place rotation does
  chmodSync(path, 0o400);
}
const envFor = (url: string, passwordFile: string): NodeJS.ProcessEnv => ({ DATABASE_URL: url, DATABASE_PASSWORD_FILE: passwordFile, DATABASE_POOL_SIZE: '4' });
const noSecret = (error: unknown, ...secrets: string[]) => {
  const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))}`;
  for (const secret of secrets) assert.ok(!text.includes(secret), 'error must not contain a password');
};

test('password file: connects as the named non-superuser role; the file is read for every new connection', options, async () => {
  const { url, passwordFile } = target();
  const config = databasePoolConfig(envFor(url, passwordFile));
  let reads = 0;
  const read = config.password as () => Promise<string>;
  const pool = new pg.Pool({ ...config, password: async () => { reads += 1; return read(); } });
  try {
    const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
    const { rows } = await a.query('SELECT session_user AS s, current_user AS c, (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS su');
    assert.deepEqual([rows[0].s, rows[0].c, rows[0].su], [PROBE_ROLE, PROBE_ROLE, false]);
    assert.equal(reads, 2, 'one password-file read per new connection');
    a.release(); b.release();
  } finally {
    await pool.end();
  }
});

test('legacy DATABASE_URL with an embedded password still connects (compatibility)', options, async () => {
  const { url, passwordFile } = target();
  const withPassword = new URL(url);
  withPassword.password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
  const pool = new pg.Pool(databasePoolConfig({ DATABASE_URL: withPassword.toString() }));
  try {
    assert.equal((await pool.query('SELECT current_user AS u')).rows[0].u, PROBE_ROLE);
  } finally {
    await pool.end();
  }
});

test('a wrong password file is rejected with 28P01 and the error carries no password', options, async () => {
  const { url, passwordFile } = target();
  const real = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
  const wrong = randomBytes(24).toString('hex');
  const pool = new pg.Pool(databasePoolConfig(envFor(url, privateFile('wrong', wrong))));
  try {
    await assert.rejects(pool.query('SELECT 1'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, '28P01');
      noSecret(error, real, wrong);
      return true;
    });
  } finally {
    await pool.end();
  }
});

test('rotation: in-place rewrite is used by the next connection; existing connections are unaffected', options, async () => {
  const { url, passwordFile } = target();
  const original = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
  const rotated = randomBytes(24).toString('hex');
  const file = privateFile('rotating', original);
  const pool = new pg.Pool(databasePoolConfig(envFor(url, file)));
  const held = await pool.connect();
  try {
    await held.query(`ALTER ROLE CURRENT_USER PASSWORD '${scramVerifier(rotated)}'`);
    assert.equal((await held.query('SELECT 1 AS one')).rows[0].one, 1, 'existing connection keeps working');
    await assert.rejects(pool.connect(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, '28P01', 'new connection with the old file content is rejected');
      noSecret(error, original, rotated);
      return true;
    });
    rewriteInPlace(file, rotated);
    const fresh = await pool.connect();
    assert.equal((await fresh.query('SELECT current_user AS u')).rows[0].u, PROBE_ROLE, 'new connection uses the rotated password');
    fresh.release();
  } finally {
    await held.query(`ALTER ROLE CURRENT_USER PASSWORD '${scramVerifier(original)}'`); // restore for reruns
    held.release();
    await pool.end();
  }
  const check = new pg.Pool(databasePoolConfig(envFor(url, passwordFile)));
  try {
    assert.equal((await check.query('SELECT current_user AS u')).rows[0].u, PROBE_ROLE, 'original password restored');
  } finally {
    await check.end();
  }
});
