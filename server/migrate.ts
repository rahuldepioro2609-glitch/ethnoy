import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Migration files, in the only supported order. schema.sql creates the core
 * tables; Milestone 1 depends on users; Milestone 2 depends on users and on
 * Milestone 1's institution_documents. Every file must be safe to re-run.
 *
 * institutionDocumentsImmutabilityMigration.sql (OD-P3) makes institution_documents
 * rows immutable with always-reject triggers; it depends on Milestone 1 and must
 * run before the grants migration, which checks that those triggers are enabled.
 *
 * authVerificationMigration.sql (AUTH-1) adds the verification tables (contacts, OTP
 * challenges, session verification evidence, institute verification, Google identities,
 * OAuth state and an append-only audit). It is additive and re-runnable, depends only on
 * schema.sql's users and auth_sessions, and must run before the grants migration, whose
 * manifest lists its seven tables.
 *
 * studentEmailVerificationMigration.sql adds the Student email-capture challenge purpose to the
 * AUTH-1 purpose constraint. It is additive and re-runnable, and must run before the grants migration.
 *
 * studentRegistrationClaimsMigration.sql (AUTH C1) adds temporary Student registration
 * claims and the nullable verification_challenges.registration_claim_id. It depends on
 * authVerificationMigration.sql (verification_challenges, auth_verification_events), is
 * additive and re-runnable, and must run before the grants migration, whose manifest
 * lists student_registration_claims.
 *
 * The Platform Staff and Organization Staff migrations depend on users and are additive.
 * They run after authentication/MFA schema and before the grants migration, whose manifest
 * lists every created table and the exact application-role privileges. Organization Staff
 * also reads AUTH-1 verification state at runtime, so authVerificationMigration.sql stays earlier.
 *
 * databaseGrantsMigration.sql must stay last: it grants the application role
 * exactly the privileges listed in its manifest for every table the earlier
 * files create. Until server/databaseRoleBootstrap.sql has provisioned the
 * eltnoy_* roles it changes nothing (it only raises a NOTICE); afterwards it
 * must run as eltnoy_owner (via eltnoy_migrator) and fails closed on unlisted
 * tables or sequences, so a failure rolls back every file in this list.
 */
export const MIGRATION_FILES = [
  'schema.sql',
  'institutionDocumentsMigration.sql',
  'institutionDocumentSubmissionMigration.sql',
  'institutionDocumentsImmutabilityMigration.sql',
  'authVerificationMigration.sql',
  'studentEmailVerificationMigration.sql',
  'studentRegistrationClaimsMigration.sql',
  'adminMfaMigration.sql',
  'platformStaffMigration.sql',
  'organizationStaffMigration.sql',
  // AUTH_MOBILE_VERIFICATION=off: allows the 'email_otp' Student session method (needs file 5).
  'studentEmailOtpMigration.sql',
  'databaseGrantsMigration.sql',
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
