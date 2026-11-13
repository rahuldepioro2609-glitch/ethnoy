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

test('db:migrate runs schema, Milestone 1, Milestone 2, document immutability, then the grants migration', async () => {
  assert.deepEqual([...MIGRATION_FILES], [
    'schema.sql',
    'institutionDocumentsMigration.sql',
    'institutionDocumentSubmissionMigration.sql',
    'institutionDocumentsImmutabilityMigration.sql',
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
