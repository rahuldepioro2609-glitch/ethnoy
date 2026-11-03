import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Migration files, in the only supported order. schema.sql creates the core
 * tables; Milestone 1 depends on users; Milestone 2 depends on users and on
 * Milestone 1's institution_documents. Every file must be safe to re-run.
 */
export const MIGRATION_FILES = [
  'schema.sql',
  'institutionDocumentsMigration.sql',
  'institutionDocumentSubmissionMigration.sql',
] as const;

/** Serializes concurrent `db:migrate` runs against the same database. */
export const MIGRATION_ADVISORY_LOCK_KEY = '7342519086';

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export async function loadMigrationFiles(): Promise<MigrationFile[]> {
  return Promise.all(MIGRATION_FILES.map(async (name) => ({
    name,
    sql: await readFile(new URL(`./${name}`, import.meta.url), 'utf8'),
  })));
}

/**
 * Applies every migration file on one client inside one transaction. Any
 * failure rolls back all files, so a failed run leaves the database unchanged
 * and can simply be retried.
 */
export async function runMigrations(
  client: MigrationClient,
  migrations: readonly MigrationFile[],
): Promise<void> {
  await client.query('BEGIN');
  let current = 'advisory lock';
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    for (const migration of migrations) {
      current = migration.name;
      await client.query(migration.sql);
    }
    current = 'commit';
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original failure is reported below; the caller discards the client.
    }
    throw new Error(`Database migration failed at ${current}; all changes were rolled back.`, { cause: error });
  }
}

async function main(): Promise<void> {
  const migrations = await loadMigrationFiles();
  const { pool } = await import('./db.js');
  try {
    const client = await pool.connect();
    let failed = false;
    try {
      await runMigrations(client, migrations);
      console.log(`Database schema is up to date (${migrations.map(({ name }) => name).join(', ')}).`);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      client.release(failed);
    }
  } finally {
    await pool.end();
  }
}

async function isDirectRun(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    const [entry, self] = await Promise.all([
      realpath(process.argv[1]),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return entry === self;
  } catch {
    return false;
  }
}

if (await isDirectRun()) {
  try {
    await main();
  } catch (error) {
    console.error('Database migration failed:', error);
    process.exitCode = 1;
  }
}
