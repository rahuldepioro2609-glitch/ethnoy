// UD-1: DATABASE_URL / DATABASE_PASSWORD_FILE resolution. No database connection is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DatabaseCredentialError, databasePoolConfig, resolveDatabaseCredentials } from './databaseCredentials.js';

const SECRET = 'synthetic-Pa55-not-real-7f3c';
const dir = mkdtempSync(join(tmpdir(), 'eltnoy-cred-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
function secretFile(content: string, mode = 0o440): string {
  const path = join(dir, `secret-${counter += 1}`);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}
const URL_NO_PW = 'postgresql://eltnoy_app@postgres:5432/eltnoy';
const fileMode = (overrides: NodeJS.ProcessEnv = {}) => ({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile(SECRET), ...overrides });

function rejects(env: NodeJS.ProcessEnv, pattern: RegExp) {
  assert.throws(() => resolveDatabaseCredentials(env), (error: unknown) => {
    assert.ok(error instanceof DatabaseCredentialError, 'DatabaseCredentialError');
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(SECRET), 'the message must not contain the secret');
    assert.ok(!error.message.includes('postgres:5432'), 'the message must not echo DATABASE_URL');
    return true;
  });
}

async function passwordOf(env: NodeJS.ProcessEnv): Promise<string> {
  const resolved = resolveDatabaseCredentials(env);
  assert.equal(resolved.source, 'password-file');
  if (resolved.source !== 'password-file') throw new Error('unreachable');
  return resolved.password();
}

test('legacy: without DATABASE_PASSWORD_FILE, DATABASE_URL (with its password) passes through unchanged', () => {
  const url = 'postgresql://eltnoy_dev:placeholder-not-a-secret@postgres:5432/eltnoy_dev?options=-c%20search_path%3Dit_x';
  assert.deepEqual(resolveDatabaseCredentials({ DATABASE_URL: url }), { source: 'database-url', connection: { connectionString: url } });
  assert.deepEqual(resolveDatabaseCredentials({ DATABASE_URL: url, DATABASE_PASSWORD_FILE: '' }), { source: 'database-url', connection: { connectionString: url } });
  assert.deepEqual(databasePoolConfig({ DATABASE_URL: url, DATABASE_SSL: 'true', DATABASE_POOL_SIZE: '7' }), {
    connectionString: url, ssl: { rejectUnauthorized: true }, max: 7, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
  }, 'identical to the pre-UD-1 pool configuration');
  assert.deepEqual(databasePoolConfig({ DATABASE_URL: url, DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }).ssl, { rejectUnauthorized: false });
  assert.deepEqual(databasePoolConfig(fileMode({ DATABASE_SSL: 'true' })).ssl, { rejectUnauthorized: true }, 'file mode keeps TLS settings');
  assert.equal(databasePoolConfig({ DATABASE_URL: url }).ssl, undefined);
  rejects({}, /DATABASE_URL must be set/);
});

test('password file: explicit connection fields; one trailing newline stripped; 0440 and 0400 accepted', async () => {
  for (const mode of [0o440, 0o400, 0o600, 0o640]) {
    const env = { DATABASE_URL: 'postgresql://eltnoy_app@postgres:6543/eltnoy%5Fdb', DATABASE_PASSWORD_FILE: secretFile(`${SECRET}\n`, mode) };
    const resolved = resolveDatabaseCredentials(env);
    assert.equal(resolved.source, 'password-file');
    assert.deepEqual(resolved.connection, { host: 'postgres', port: 6543, database: 'eltnoy_db', user: 'eltnoy_app' });
    assert.equal(await passwordOf(env), SECRET);
  }
  const ipv6 = resolveDatabaseCredentials({ DATABASE_URL: 'postgresql://eltnoy_app@[::1]/eltnoy', DATABASE_PASSWORD_FILE: secretFile(SECRET) });
  assert.deepEqual(ipv6.connection, { host: '::1', port: 5432, database: 'eltnoy', user: 'eltnoy_app' });
  assert.equal(await passwordOf({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile(`${SECRET}\r\n`) }), SECRET);
});

test('node-postgres keeps the password function only when no connectionString is passed (regression)', () => {
  const config = databasePoolConfig(fileMode({ DATABASE_SSL: 'true' }));
  assert.equal('connectionString' in config, false, 'file mode must not pass connectionString');
  assert.equal(typeof config.password, 'function');
  const client = new pg.Client(config);
  assert.equal(typeof client.password, 'function', 'pg.Client keeps the password function');
  assert.deepEqual([client.host, client.port, client.database, client.user], ['postgres', 5432, 'eltnoy', 'eltnoy_app']);
  const pool = new pg.Pool(config);
  assert.equal(typeof pool.options.password, 'function', 'pg.Pool passes the password function to its clients');
  void pool.end();
  const broken = new pg.Client({ connectionString: URL_NO_PW, password: config.password });
  assert.notEqual(typeof broken.password, 'function', 'documents the pg behaviour this module works around');
});

test('conflicting password configuration is rejected', () => {
  rejects(fileMode({ DATABASE_URL: `postgresql://eltnoy_app:${SECRET}@postgres:5432/eltnoy` }), /must not contain a password/);
  rejects(fileMode({ DATABASE_URL: `postgresql://eltnoy_app@postgres:5432/eltnoy?password=${SECRET}` }), /must not contain a password/);
  rejects(fileMode({ PGPASSWORD: SECRET }), /PGPASSWORD must not be set/);
  rejects(fileMode({ DATABASE_URL: `${URL_NO_PW}?sslmode=disable` }), /query parameters are not supported/);
});

test('invalid URL or path is rejected without echoing it', () => {
  rejects(fileMode({ DATABASE_URL: 'postgresql://postgres:5432/eltnoy' }), /must name the database role/);
  rejects(fileMode({ DATABASE_URL: 'postgresql://eltnoy_app@postgres:5432/' }), /must name a host and a database/);
  rejects(fileMode({ DATABASE_URL: 'mysql://eltnoy_app@postgres:5432/eltnoy' }), /postgresql:\/\/ scheme/);
  rejects(fileMode({ DATABASE_URL: 'not a url postgres:5432' }), /not a valid/);
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: 'relative/secret' }, /absolute path/);
});

test('missing, unreadable or unsafe secret files fail closed with a non-secret message', () => {
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: join(dir, 'missing') }, /cannot be read \(ENOENT\)/);
  if (process.getuid?.() !== 0) rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile(SECRET, 0o000) }, /cannot be read \(EACCES\)/);
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile(SECRET, 0o444) }, /must not be accessible to other users \(mode 444/);
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile(SECRET, 0o644) }, /must not be accessible to other users/);
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile('\n') }, /is empty/);
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile(`${SECRET}\nsecond\n`) }, /single line/);
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile('x'.repeat(1025)) }, /longer than 1024/);
  const sub = join(dir, 'a-directory'); mkdirSync(sub);
  rejects({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: sub }, /not a regular file/);
});

test('rotation: the file is re-read for each new connection (in place, replaced, symlinked, removed)', async () => {
  const path = secretFile(SECRET);
  const env = { DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: path };
  const resolved = resolveDatabaseCredentials(env);
  if (resolved.source !== 'password-file') throw new Error('unreachable');
  assert.equal(await resolved.password(), SECRET);
  chmodSync(path, 0o640); writeFileSync(path, `${SECRET}-in-place\n`); chmodSync(path, 0o440);
  assert.equal(await resolved.password(), `${SECRET}-in-place`, 'in-place rewrite');
  const replacement = secretFile(`${SECRET}-renamed`); renameSync(replacement, path);
  assert.equal(await resolved.password(), `${SECRET}-renamed`,
    'a renamed-over file is seen by the process; inside a container a single-file bind mount still pins the old inode (see docs)');
  const link = join(dir, 'link'); symlinkSync(secretFile(`${SECRET}-linked`), link);
  assert.equal(await passwordOf({ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: link }), `${SECRET}-linked`, 'secret-agent style symlink');
  chmodSync(path, 0o644);
  await assert.rejects(resolved.password(), (error: unknown) => error instanceof DatabaseCredentialError && /other users/.test(error.message) && !error.message.includes(SECRET));
  rmSync(path);
  await assert.rejects(resolved.password(), (error: unknown) => error instanceof DatabaseCredentialError && /ENOENT/.test(error.message));
});

test('process level: importing server/db.ts with a bad secret exits non-zero and prints no secret or URL', () => {
  const dbModule = fileURLToPath(new URL('./db.ts', import.meta.url));
  const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{ DATABASE_URL: `postgresql://eltnoy_app:${SECRET}@postgres:5432/eltnoy`, DATABASE_PASSWORD_FILE: secretFile(SECRET) }, /must not contain a password/],
    [{ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: secretFile(SECRET, 0o444) }, /must not be accessible to other users/],
    [{ DATABASE_URL: URL_NO_PW, DATABASE_PASSWORD_FILE: join(dir, 'absent') }, /cannot be read \(ENOENT\)/],
  ];
  for (const [env, pattern] of cases) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `await import(${JSON.stringify(dbModule)})`], {
      env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null', ...env }, encoding: 'utf8', timeout: 30_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, pattern);
    assert.ok(!output.includes(SECRET), 'no secret in process output');
    assert.ok(!output.includes('postgres:5432'), 'no DATABASE_URL in process output');
  }
});
