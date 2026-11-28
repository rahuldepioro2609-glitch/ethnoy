import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  loadMigrationFiles,
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_FILES,
  type MigrationClient,
  type MigrationFile,
  runMigrations,
} from './migrate.js';

const INSTITUTION_MIGRATIONS = [
  'institutionDocumentsMigration.sql',
  'institutionDocumentSubmissionMigration.sql',
  'institutionDocumentsImmutabilityMigration.sql',
] as const;

async function readServerFile(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8');
}

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

class RecordingClient implements MigrationClient {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly failOn?: (text: string) => boolean, private readonly failRollback = false) {}

  async query(text: string, values?: unknown[]): Promise<unknown> {
    this.calls.push({ text, values });
    if (text === 'ROLLBACK' && this.failRollback) throw new Error('connection lost');
    if (this.failOn?.(text)) throw new Error(`synthetic failure: ${text}`);
    return { rows: [] };
  }

  get texts(): string[] {
    return this.calls.map(({ text }) => text);
  }
}

const fakeMigrations: MigrationFile[] = [
  { name: 'schema.sql', sql: '-- schema' },
  { name: 'institutionDocumentsMigration.sql', sql: '-- milestone 1' },
  { name: 'institutionDocumentSubmissionMigration.sql', sql: '-- milestone 2' },
  { name: 'institutionDocumentsImmutabilityMigration.sql', sql: '-- immutability' },
  { name: 'databaseGrantsMigration.sql', sql: '-- grants' },
];

test('db:migrate runs core, auth, staff and grants migrations in dependency order', async () => {
  assert.deepEqual([...MIGRATION_FILES], [
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
    'studentEmailOtpMigration.sql',
    'auditEventsMigration.sql',
    'meritListMigration.sql',
    'databaseGrantsMigration.sql',
  ]);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['db:migrate'], 'tsx server/migrate.ts');

  const loaded = await loadMigrationFiles();
  assert.deepEqual(loaded.map(({ name }) => name), [...MIGRATION_FILES]);
  for (const migration of loaded) {
    assert.equal(migration.sql, await readServerFile(migration.name));
  }
});

test('runner applies every file on one client inside one locked transaction', async () => {
  const client = new RecordingClient();
  await runMigrations(client, fakeMigrations);
  assert.deepEqual(client.texts, [
    'BEGIN',
    'SELECT pg_advisory_xact_lock($1::bigint)',
    '-- schema',
    '-- milestone 1',
    '-- milestone 2',
    '-- immutability',
    '-- grants',
    'COMMIT',
  ]);
  assert.deepEqual(client.calls[1].values, [MIGRATION_ADVISORY_LOCK_KEY]);
  assert.match(MIGRATION_ADVISORY_LOCK_KEY, /^\d+$/);
});

test('runner rolls back every file when any migration fails', async () => {
  const client = new RecordingClient((text) => text === '-- milestone 1');
  await assert.rejects(
    runMigrations(client, fakeMigrations),
    /failed at institutionDocumentsMigration\.sql; all changes were rolled back/,
  );
  assert.deepEqual(client.texts, [
    'BEGIN',
    'SELECT pg_advisory_xact_lock($1::bigint)',
    '-- schema',
    '-- milestone 1',
    'ROLLBACK',
  ]);
});

test('runner rolls back when the advisory lock or commit fails', async () => {
  const lockFailure = new RecordingClient((text) => text.startsWith('SELECT pg_advisory_xact_lock'));
  await assert.rejects(runMigrations(lockFailure, fakeMigrations), /failed at advisory lock/);
  assert.deepEqual(lockFailure.texts, ['BEGIN', 'SELECT pg_advisory_xact_lock($1::bigint)', 'ROLLBACK']);

  const commitFailure = new RecordingClient((text) => text === 'COMMIT');
  await assert.rejects(runMigrations(commitFailure, fakeMigrations), /failed at commit/);
  assert.equal(commitFailure.texts.at(-1), 'ROLLBACK');
});

test('a failure in the grants migration rolls back every file in the same transaction', async () => {
  const client = new RecordingClient((text) => text === '-- grants');
  await assert.rejects(
    runMigrations(client, fakeMigrations),
    /failed at databaseGrantsMigration\.sql; all changes were rolled back/,
  );
  assert.deepEqual(client.texts, [
    'BEGIN',
    'SELECT pg_advisory_xact_lock($1::bigint)',
    '-- schema',
    '-- milestone 1',
    '-- milestone 2',
    '-- immutability',
    '-- grants',
    'ROLLBACK',
  ]);
});

test('the grants migration is last, is not a role bootstrap, and is a no-op until roles exist', async () => {
  assert.equal(MIGRATION_FILES.at(-1), 'databaseGrantsMigration.sql');
  assert.ok(!(MIGRATION_FILES as readonly string[]).includes('databaseRoleBootstrap.sql'));
  const sql = withoutComments(await readServerFile('databaseGrantsMigration.sql'));
  assert.match(sql, /IF NOT roles_ready THEN\s+RAISE NOTICE '[^']*';\s+RETURN;/);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT)\b[^;\n]*;/im);
});

test('runner reports the original failure even if rollback also fails', async () => {
  const client = new RecordingClient((text) => text === '-- milestone 2', true);
  await assert.rejects(runMigrations(client, fakeMigrations), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /failed at institutionDocumentSubmissionMigration\.sql/);
    assert.match(String((error.cause as Error).message), /synthetic failure: -- milestone 2/);
    return true;
  });
  assert.equal(client.texts.includes('COMMIT'), false);
});

for (const name of INSTITUTION_MIGRATIONS) {
  test(`${name} has no transaction control of its own`, async () => {
    const sql = withoutComments(await readServerFile(name));
    // PL/pgSQL bodies use `BEGIN` (no semicolon) and `END;`, which are not transaction control.
    assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b[^;\n]*;/im);
  });

  test(`${name} guards every CREATE and ALTER ... ADD so it can be re-run`, async () => {
    const sql = withoutComments(await readServerFile(name));

    const tables = [...sql.matchAll(/CREATE TABLE\s+(?!IF NOT EXISTS)(\w+)/g)];
    assert.deepEqual(tables.map((match) => match[1]), [], 'unguarded CREATE TABLE');
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX\s+(?!IF NOT EXISTS)(\w+)/g)];
    assert.deepEqual(indexes.map((match) => match[1]), [], 'unguarded CREATE INDEX');
    const functions = [...sql.matchAll(/CREATE\s+(?!OR REPLACE)FUNCTION\s+(\w+)/g)];
    assert.deepEqual(functions.map((match) => match[1]), [], 'CREATE FUNCTION without OR REPLACE');
    const columns = [...sql.matchAll(/ADD COLUMN\s+(?!IF NOT EXISTS)(\w+)/g)];
    assert.deepEqual(columns.map((match) => match[1]), [], 'unguarded ADD COLUMN');

    const triggers = [...sql.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE [A-Z ]+? ON (\w+)/g)];
    assert.ok(triggers.length > 0);
    for (const [, trigger, table] of triggers) {
      assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${trigger} ON ${table};\\s*CREATE TRIGGER ${trigger}\\b`));
    }

    for (const [, constraint] of sql.matchAll(/ADD CONSTRAINT (\w+)/g)) {
      assert.match(
        sql,
        new RegExp(`IF NOT EXISTS \\(\\s*SELECT 1 FROM pg_constraint\\s+WHERE conname = '${constraint}'\\s+AND conrelid = to_regclass\\('\\w+'\\)\\s*\\) THEN\\s+ALTER TABLE \\w+\\s+ADD CONSTRAINT ${constraint}\\b`),
        `ADD CONSTRAINT ${constraint} must be guarded by a pg_constraint check`,
      );
    }
  });

  test(`${name} never changes existing rows, permissions, or columns`, async () => {
    const sql = withoutComments(await readServerFile(name));
    assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
    assert.doesNotMatch(sql, /\bUPDATE\s+\w+\s+SET\b/i);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(sql, /^\s*TRUNCATE\b/im);
    assert.doesNotMatch(sql, /\b(GRANT|REVOKE)\b/i);
    assert.doesNotMatch(sql, /\bALTER\s+(ROLE|USER|DEFAULT PRIVILEGES)\b/i);
    assert.doesNotMatch(sql, /\bOWNER\s+TO\b/i);
    assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+COLUMN\b/i);
    assert.doesNotMatch(sql, /\bSET\s+NOT\s+NULL\b/i);
    const drops = [...sql.matchAll(/\bDROP\s+(\w+)(\s+IF EXISTS)?/gi)];
    for (const [statement, kind, ifExists] of drops) {
      assert.ok(kind.toUpperCase() === 'TRIGGER' && ifExists, `unexpected ${statement}`);
    }
  });
}

test('the immutability migration rejects every UPDATE, DELETE and TRUNCATE on institution_documents', async () => {
  const sql = withoutComments(await readServerFile('institutionDocumentsImmutabilityMigration.sql'));
  assert.match(sql, /CREATE OR REPLACE FUNCTION reject_institution_document_mutation\(\)\s+RETURNS trigger LANGUAGE plpgsql AS \$\$\s+BEGIN\s+RAISE EXCEPTION '[^']+';\s+END;\s+\$\$;/,
    'the trigger function must reject unconditionally');
  assert.match(sql, /CREATE TRIGGER institution_documents_immutable\s+BEFORE UPDATE OR DELETE ON institution_documents\s+FOR EACH ROW EXECUTE FUNCTION reject_institution_document_mutation\(\);/);
  assert.match(sql, /CREATE TRIGGER institution_documents_no_truncate\s+BEFORE TRUNCATE ON institution_documents\s+FOR EACH STATEMENT EXECUTE FUNCTION reject_institution_document_mutation\(\);/);
  const files = [...MIGRATION_FILES] as string[];
  assert.ok(files.indexOf('institutionDocumentsImmutabilityMigration.sql') > files.indexOf('institutionDocumentsMigration.sql'));
  assert.ok(files.indexOf('institutionDocumentsImmutabilityMigration.sql') < files.indexOf('databaseGrantsMigration.sql'));
});

test('Milestone 2 keeps submission_cycle_id nullable without backfilling legacy rows', async () => {
  const sql = withoutComments(await readServerFile('institutionDocumentSubmissionMigration.sql'));
  assert.match(sql, /ALTER TABLE institution_documents\s+ADD COLUMN IF NOT EXISTS submission_cycle_id text;/);
  // Only institution_documents holds legacy rows; capabilities.submission_cycle_id is a new NOT NULL column.
  const documentAlters = [...sql.matchAll(/ALTER TABLE institution_documents\b[^;]*;/g)].map(([statement]) => statement);
  assert.equal(documentAlters.length, 2);
  for (const statement of documentAlters) {
    assert.doesNotMatch(statement, /NOT NULL|DEFAULT|ALTER COLUMN|USING/i);
  }
  assert.doesNotMatch(sql, /submission_cycle_id\s*=/i);
  assert.match(sql, /BEFORE INSERT ON institution_documents/);
  assert.doesNotMatch(sql, /BEFORE (INSERT OR )?UPDATE ON institution_documents/);
});

test('AUTH-1 and Staff migrations run after their dependencies and before the grants migration', () => {
  const files = [...MIGRATION_FILES] as string[];
  const auth = files.indexOf('authVerificationMigration.sql');
  assert.ok(auth > files.indexOf('schema.sql'), 'needs users and auth_sessions from schema.sql');
  assert.ok(auth > files.indexOf('institutionDocumentsImmutabilityMigration.sql'), 'existing order is preserved');
  assert.ok(auth < files.indexOf('databaseGrantsMigration.sql'), 'before the grants migration');
  assert.equal(files.filter((name) => name === 'authVerificationMigration.sql').length, 1);
  const platform = files.indexOf('platformStaffMigration.sql');
  const organization = files.indexOf('organizationStaffMigration.sql');
  assert.ok(platform > files.indexOf('adminMfaMigration.sql'), 'after the authentication schema');
  assert.ok(organization > auth, 'Organization Staff uses AUTH-1 institute verification state');
  assert.ok(platform < files.indexOf('databaseGrantsMigration.sql'), 'before grants coverage');
  assert.ok(organization < files.indexOf('databaseGrantsMigration.sql'), 'before grants coverage');
  for (const staff of ['platformStaffMigration.sql', 'organizationStaffMigration.sql']) {
    assert.equal(files.filter((name) => name === staff).length, 1, `${staff} runs exactly once`);
  }
});

test('AUTH C1: the claims migration runs once, right after AUTH-1 and before the grants migration', () => {
  const files = [...MIGRATION_FILES] as string[];
  const claims = files.indexOf('studentRegistrationClaimsMigration.sql');
  assert.equal(files.filter((name) => name === 'studentRegistrationClaimsMigration.sql').length, 1);
  assert.equal(files.indexOf('studentEmailVerificationMigration.sql'), files.indexOf('authVerificationMigration.sql') + 1, 'extends the AUTH-1 challenge-purpose constraint');
  assert.equal(claims, files.indexOf('studentEmailVerificationMigration.sql') + 1, 'depends on verification_challenges and auth_verification_events');
  assert.ok(claims < files.indexOf('databaseGrantsMigration.sql'), 'the grants manifest lists student_registration_claims');
  assert.equal(files.indexOf('adminMfaMigration.sql'), claims + 1, 'AUTH C1.8: the MFA migration follows the claims migration');
  assert.equal(files.at(-1), 'databaseGrantsMigration.sql', 'the grants migration stays last');
  assert.equal(files.indexOf('platformStaffMigration.sql'), files.indexOf('adminMfaMigration.sql') + 1);
  assert.equal(files.indexOf('organizationStaffMigration.sql'), files.indexOf('platformStaffMigration.sql') + 1);
});

test('AUTH_MOBILE_VERIFICATION: the email-OTP migration runs once, after AUTH-1, right before grants, and only widens the session-method CHECK', async () => {
  const files = [...MIGRATION_FILES] as string[];
  assert.equal(files.filter((name) => name === 'studentEmailOtpMigration.sql').length, 1);
  assert.ok(files.indexOf('studentEmailOtpMigration.sql') > files.indexOf('authVerificationMigration.sql'), 'needs auth_session_verifications');
  assert.equal(files.indexOf('studentEmailOtpMigration.sql'), files.indexOf('auditEventsMigration.sql') - 1);
  const sql = withoutComments(await readServerFile('studentEmailOtpMigration.sql'));
  assert.doesNotMatch(sql, /\bBEGIN\s*;|\bCOMMIT\b|\bROLLBACK\b/i, 'the runner owns the transaction');
  assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|UPDATE\s+\w+\s+SET|CREATE TABLE|ADD COLUMN|DROP TABLE|DROP COLUMN)\b/i, 'no data, table or column changes');
  const statements = sql.split(/;\s*(?=\n|$)/).map((statement) => statement.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements, [
    'ALTER TABLE auth_session_verifications DROP CONSTRAINT IF EXISTS auth_session_verifications_method_check',
    "ALTER TABLE auth_session_verifications ADD CONSTRAINT auth_session_verifications_method_check CHECK ( method IN ('sms_otp', 'email_otp', 'password') )",
  ]);
});

test('AUTH C1: the claims migration is additive, re-runnable, non-exclusive per mobile, and never touches existing rows', async () => {
  const sql = withoutComments(await readServerFile('studentRegistrationClaimsMigration.sql'));
  assert.doesNotMatch(sql, /\bDROP (?:TABLE|COLUMN|INDEX|CONSTRAINT)\b/i, 'additive: nothing is dropped');
  assert.doesNotMatch(sql, /\bBEGIN\s*;|\bCOMMIT\b|\bROLLBACK\b/i, 'the runner owns the transaction');
  assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|UPDATE\s+\w+\s+SET)\b/i, 'no data changes or backfills');
  const statements = sql.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$').split(/;\s*(?=\n|$)/).map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    // ('$$body$$' as a replacement string yields '$body$'.)
    assert.match(statement, /^(?:(?:CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|ALTER TABLE verification_challenges (?:ADD COLUMN IF NOT EXISTS|ALTER COLUMN user_id DROP NOT NULL))\b|DO \$body\$$)/i, `re-runnable: ${statement.slice(0, 80)}`);
  }
  const body = withoutComments(await readServerFile('studentRegistrationClaimsMigration.sql'));
  assert.match(body, /IF NOT EXISTS \([\s\S]*conname = 'verification_challenges_owner_check'[\s\S]*ADD CONSTRAINT verification_challenges_owner_check/, 'the CHECK is added only once');
  assert.match(body, /\(user_id IS NOT NULL AND registration_claim_id IS NULL\)\s+OR \(user_id IS NULL AND registration_claim_id IS NOT NULL AND purpose = 'student_registration'\)/, 'exactly one owner; claims only for Student registration');
  assert.match(body, /registration_claim_id text REFERENCES student_registration_claims\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(body, /UNIQUE[^;]*\bmobile\b|UNIQUE INDEX[^;]*student_registration_claims/i, 'claims are not exclusive per mobile');
  assert.match(body, /password_hash text NOT NULL/);
  assert.doesNotMatch(body, /\bpassword text\b|\bcode text\b|\botp\b/i, 'no plaintext password or OTP column');
  assert.match(body, /CHECK \(expires_at > created_at\)/, 'claims expire');
  assert.match(body, /consumed_at timestamptz/, 'claims are single use');
  assert.equal((body.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 1, 'one new table');
});

test('AUTH-1: the migration is additive and every statement is safe to re-run', async () => {
  const sql = withoutComments(await readServerFile('authVerificationMigration.sql'));
  assert.doesNotMatch(sql, /\bDROP (?:TABLE|COLUMN)\b/i, 'additive: nothing is dropped');
  assert.doesNotMatch(sql, /\bBEGIN\s*;|\bCOMMIT\b|\bROLLBACK\b/i, 'no transaction control (the runner owns the transaction)');
  // Collapse dollar-quoted function bodies so their inner semicolons don't split statements.
  const statements = sql.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$').split(/;\s*(?=\n|$)/).map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    // Trigger definitions may name UPDATE/DELETE/TRUNCATE events; no statement may *start* as a data or table change.
    assert.doesNotMatch(statement, /^(?:ALTER TABLE|TRUNCATE|DELETE|UPDATE|INSERT)\b/i, `additive: ${statement.slice(0, 80)}`);
    if (/^CREATE\b/i.test(statement)) {
      assert.match(statement, /^CREATE (?:TABLE IF NOT EXISTS|(?:UNIQUE )?INDEX IF NOT EXISTS|OR REPLACE FUNCTION|TRIGGER)\b/i, statement.slice(0, 80));
    } else {
      assert.match(statement, /^DROP TRIGGER IF EXISTS\b/i, statement.slice(0, 80));
    }
  }
  // Every trigger is dropped first, so re-running recreates it instead of failing.
  for (const [, name, table] of sql.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE [A-Z ]+ ON (\w+)/g)) {
    assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${name} ON ${table};`), name);
  }
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 7);
});
