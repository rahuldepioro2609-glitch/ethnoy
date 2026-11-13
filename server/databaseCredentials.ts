// Resolves the PostgreSQL credential for this process (UD-1).
//
// - DATABASE_URL names the host, port, database and LOGIN role.
// - DATABASE_PASSWORD_FILE (optional) is an absolute path to a file that holds only the password (one
//   optional trailing newline). Compose mounts it at /run/secrets/<name>. The file is read once at
//   startup (fail fast) and again for every new pool connection, so a password rewritten in place is
//   picked up without restarting the process.
// - Without DATABASE_PASSWORD_FILE the URL is passed through unchanged (legacy and local development).
//
// node-postgres re-parses a connectionString and lets the URL's absent password replace a password
// function with null, so in password-file mode the URL is converted to explicit connection fields.
// Error messages name the variable, the path and the errno code only, never the URL or the file contents.
import { readFileSync, statSync, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { PoolConfig } from 'pg';

export class DatabaseCredentialError extends Error {
  override name = 'DatabaseCredentialError';
}

export interface DatabaseConnectionFields {
  host: string;
  port: number;
  database: string;
  user: string;
}

export type DatabaseCredentials =
  | { source: 'database-url'; connection: { connectionString: string } }
  | { source: 'password-file'; connection: DatabaseConnectionFields; password: () => Promise<string> };

const MAX_PASSWORD_BYTES = 1024;

function checkStats(path: string, stats: Stats): void {
  if (!stats.isFile()) throw new DatabaseCredentialError(`DATABASE_PASSWORD_FILE (${path}) is not a regular file.`);
  if ((stats.mode & 0o007) !== 0) {
    throw new DatabaseCredentialError(
      `DATABASE_PASSWORD_FILE (${path}) must not be accessible to other users (mode ${(stats.mode & 0o777).toString(8)}; use 0440 or 0400).`,
    );
  }
}

function parsePassword(path: string, raw: string): string {
  const password = raw.replace(/\r?\n$/, '');
  if (password.length === 0) throw new DatabaseCredentialError(`DATABASE_PASSWORD_FILE (${path}) is empty.`);
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    throw new DatabaseCredentialError(`DATABASE_PASSWORD_FILE (${path}) is longer than ${MAX_PASSWORD_BYTES} bytes.`);
  }
  if (/[\0\r\n]/.test(password)) throw new DatabaseCredentialError(`DATABASE_PASSWORD_FILE (${path}) must contain a single line.`);
  return password;
}

function describe(path: string, error: unknown): DatabaseCredentialError {
  if (error instanceof DatabaseCredentialError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
  return new DatabaseCredentialError(`DATABASE_PASSWORD_FILE (${path}) cannot be read (${code}).`);
}

export function readPasswordFileSync(path: string): string {
  try {
    checkStats(path, statSync(path));
    return parsePassword(path, readFileSync(path, 'utf8'));
  } catch (error) {
    throw describe(path, error);
  }
}

export async function readPasswordFile(path: string): Promise<string> {
  try {
    checkStats(path, await stat(path));
    return parsePassword(path, await readFile(path, 'utf8'));
  } catch (error) {
    throw describe(path, error);
  }
}

export function resolveDatabaseCredentials(env: NodeJS.ProcessEnv): DatabaseCredentials {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new DatabaseCredentialError('DATABASE_URL must be set before starting the API.');
  const passwordFile = env.DATABASE_PASSWORD_FILE;
  if (passwordFile === undefined || passwordFile === '') return { source: 'database-url', connection: { connectionString } };

  if (!isAbsolute(passwordFile)) throw new DatabaseCredentialError('DATABASE_PASSWORD_FILE must be an absolute path.');
  if (env.PGPASSWORD !== undefined && env.PGPASSWORD !== '') {
    throw new DatabaseCredentialError('PGPASSWORD must not be set when DATABASE_PASSWORD_FILE is set.');
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DatabaseCredentialError('DATABASE_URL is not a valid postgresql:// URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new DatabaseCredentialError('DATABASE_URL must use the postgresql:// scheme.');
  }
  if (url.password !== '' || url.searchParams.has('password')) {
    throw new DatabaseCredentialError('DATABASE_URL must not contain a password when DATABASE_PASSWORD_FILE is set.');
  }
  if (url.username === '') {
    throw new DatabaseCredentialError('DATABASE_URL must name the database role when DATABASE_PASSWORD_FILE is set.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new DatabaseCredentialError('DATABASE_URL query parameters are not supported with DATABASE_PASSWORD_FILE; configure TLS with DATABASE_SSL.');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const port = url.port === '' ? 5432 : Number(url.port);
  if (host === '' || database === '' || database.includes('/')) {
    throw new DatabaseCredentialError('DATABASE_URL must name a host and a database when DATABASE_PASSWORD_FILE is set.');
  }

  readPasswordFileSync(passwordFile); // fail fast at startup with a non-secret message
  return {
    source: 'password-file',
    connection: { host, port, database, user: decodeURIComponent(url.username) },
    password: () => readPasswordFile(passwordFile),
  };
}

/** The node-postgres pool configuration for this process (used by server/db.ts). */
export function databasePoolConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const credentials = resolveDatabaseCredentials(env);
  return {
    ...credentials.connection,
    ...(credentials.source === 'password-file' ? { password: credentials.password } : {}),
    ssl: env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
    max: Number(env.DATABASE_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}
