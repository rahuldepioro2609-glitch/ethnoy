// Grant-coverage tests for the fourth migration (server/databaseGrantsMigration.sql) and the
// one-time role bootstrap (server/databaseRoleBootstrap.sql). Static: no database is used.
//
// They fail when:
// - a table or sequence is added to a migration without a grant-manifest entry (or an entry is stale);
// - the manifest grants anything beyond SELECT, INSERT, UPDATE, or touches a protected column;
// - an append-only table (one with an UPDATE/DELETE-rejecting trigger) is granted UPDATE;
// - API code inserts into, updates, or row-locks a table without the matching grant, or deletes or
//   truncates anything at all;
// - either SQL file gains role, password, ownership, data or transaction statements it must not have.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATION_FILES } from './migrate.js';

const SERVER_DIR = new URL('./', import.meta.url);
const GRANTS_FILE = 'databaseGrantsMigration.sql';
const BOOTSTRAP_FILE = 'databaseRoleBootstrap.sql';

const readServerFile = (name: string) => readFile(new URL(name, SERVER_DIR), 'utf8');
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

interface ManifestEntry {
  privileges: string[];
  updateColumns: string[];
}

async function loadManifest(): Promise<Map<string, ManifestEntry>> {
  const sql = withoutComments(await readServerFile(GRANTS_FILE));
  const block = /FOR r IN SELECT \* FROM \(VALUES([\s\S]*?)\) AS m\(tbl, privileges, update_columns\)/.exec(sql);
  assert.ok(block, 'table manifest VALUES block not found');
  const manifest = new Map<string, ManifestEntry>();
  const row = /\('(\w+)',\s*'([A-Z, ]+)',\s*(NULL(?:::text\[\])?|ARRAY\[([^\]]*)\](?:::text\[\])?)\)/g;
  for (const [, table, privileges, , columns] of block[1].matchAll(row)) {
    assert.ok(!manifest.has(table), `manifest lists ${table} twice`);
    manifest.set(table, {
      privileges: privileges.split(',').map((p) => p.trim()),
      updateColumns: columns ? [...columns.matchAll(/'(\w+)'/g)].map((m) => m[1]) : [],
    });
  }
  assert.ok(manifest.size > 0, 'manifest is empty');
  return manifest;
}

async function loadSchema() {
  const files = await Promise.all(MIGRATION_FILES.map(async (name) => withoutComments(await readServerFile(name))));
  const sql = files.join('\n');
  const tables = new Map<string, Set<string>>();
  for (const [, table, body] of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = new Set<string>();
    for (const [, column] of body.matchAll(/^\s+([a-z_][a-z0-9_]*)\s+(?!KEY\b)[a-z]/gm)) {
      if (!['constraint', 'check', 'unique', 'primary', 'foreign'].includes(column)) columns.add(column);
    }
    tables.set(table, columns);
  }
  for (const [, table, column] of sql.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g)) {
    tables.get(table)?.add(column);
  }
  // Append-only = an UPDATE/DELETE trigger that always rejects (reject_*_mutation). Tables with
  // conditional protect_* triggers (submission cycles and capabilities) allow some updates.
  const appendOnly = new Set([...sql.matchAll(/CREATE TRIGGER \w+\s+BEFORE UPDATE OR DELETE ON (\w+)\s+FOR EACH ROW EXECUTE FUNCTION reject_\w+_mutation\(\)/g)].map((m) => m[1]));
  const sequences = [
    ...[...sql.matchAll(/CREATE SEQUENCE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]),
    ...[...sql.matchAll(/^\s+(\w+)\s+(?:small|big)?serial\b/gim)].map((m) => `${m[1]} (serial)`),
    ...[...sql.matchAll(/^\s+(\w+)\s+[a-z]+\s+GENERATED (?:ALWAYS|BY DEFAULT) AS IDENTITY/gim)].map((m) => `${m[1]} (identity)`),
  ];
  return { tables, appendOnly, sequences };
}

/**
 * Lock-only grants (OD-P3): immutable tables whose rows the API must lock with SELECT ... FOR UPDATE,
 * which PostgreSQL allows only with UPDATE on at least one column. Exactly one column, and only on a
 * table whose always-reject trigger refuses every UPDATE.
 */
const LOCK_ONLY_COLUMNS: Record<string, string[]> = {
  institution_documents: ['created_at'],
};

const PROTECTED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'login_id', 'role', 'password_hash', 'is_super_admin', 'created_at'],
  auth_sessions: ['token_hash', 'user_id', 'expires_at', 'created_at'],
  institute_withdrawals: ['id', 'institute_id', 'amount_paise', 'created_at'],
  applications: ['id', 'application_number', 'exam_code', 'date_of_birth', 'created_at'],
  // OD-P4: identity, ownership, timing and submitted-content columns of the narrowed tables.
  online_exam_attempts: ['id', 'user_id', 'exam_code', 'started_at', 'expires_at'],
  published_results: ['id', 'exam_code', 'roll_number'],
  admit_cards: ['application_id'],
  answer_key_questions: ['id', 'exam_code', 'question_number', 'created_at'],
  online_exam_questions: ['id', 'exam_code', 'question_number', 'created_at'],
  exams: ['id', 'code', 'name', 'category', 'registration_start', 'registration_end', 'exam_date', 'fee', 'created_at'],
  feedback: ['id', 'user_id', 'type', 'title', 'description', 'candidate_name', 'email', 'application_number', 'created_at'],
  portal_notices: ['id', 'title', 'summary', 'full_content', 'reference_number', 'created_by', 'created_at'],
  institution_submission_capabilities: ['id', 'institution_id', 'submission_cycle_id', 'token_hash', 'expires_at'],
  institution_submission_cycles: ['id', 'institution_id', 'submission_version', 'source_type'],
  institute_forms: ['id', 'institute_id'],
  institute_profile_changes: ['id', 'institute_id'],
  center_checkins: ['id', 'application_id', 'center_code'],
};

test('grant manifest covers exactly the tables created by the migrations', async () => {
  const [manifest, { tables }] = await Promise.all([loadManifest(), loadSchema()]);
  const missing = [...tables.keys()].filter((t) => !manifest.has(t)).sort();
  const stale = [...manifest.keys()].filter((t) => !tables.has(t)).sort();
  assert.deepEqual(missing, [], `tables without a grant-manifest entry: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `grant-manifest entries for tables that no migration creates: ${stale.join(', ')}`);
  assert.equal(tables.size, 24);
});

test('migrations create no sequences without a sequence-manifest entry (currently none allowed)', async () => {
  const { sequences } = await loadSchema();
  const grantsSql = withoutComments(await readServerFile(GRANTS_FILE));
  const listed = /c\.relname <> ALL \(ARRAY\[([^\]]*)\]::text\[\]\)/.exec(grantsSql);
  assert.ok(listed, 'sequence manifest not found');
  const allowed = [...listed[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(sequences.filter((s) => !allowed.includes(s.split(' ')[0])), [], 'sequences need an explicit manifest entry and USAGE grant');
});

test('manifest grants only SELECT, INSERT and UPDATE, and never UPDATE on protected columns', async () => {
  const [manifest, { tables }] = await Promise.all([loadManifest(), loadSchema()]);
  for (const [table, entry] of manifest) {
    for (const privilege of entry.privileges) {
      assert.ok(['SELECT', 'INSERT', 'UPDATE'].includes(privilege), `${table}: ${privilege} is not allowed`);
    }
    assert.ok(entry.privileges.includes('SELECT'), `${table}: SELECT expected`);
    assert.ok(!(entry.privileges.includes('UPDATE') && entry.updateColumns.length), `${table}: table-wide and column UPDATE both granted`);
    for (const column of entry.updateColumns) {
      assert.ok(tables.get(table)?.has(column), `${table}.${column} is not a column created by the migrations`);
    }
    const protectedColumns = PROTECTED_COLUMNS[table];
    if (protectedColumns) {
      assert.ok(!entry.privileges.includes('UPDATE'), `${table} must use column-level UPDATE only`);
      const leaked = entry.updateColumns.filter((c) => protectedColumns.includes(c));
      assert.deepEqual(leaked, [], `${table}: protected columns must never be updatable`);
    }
  }
});

test('no table grants table-wide UPDATE to the API role (OD-P4)', async () => {
  const manifest = await loadManifest();
  const tableWide = [...manifest].filter(([, entry]) => entry.privileges.includes('UPDATE')).map(([table]) => table);
  assert.deepEqual(tableWide, [], `use column-level UPDATE instead of table-wide UPDATE on: ${tableWide.join(', ')}`);
});

test('append-only and immutable tables (always-reject triggers) get no UPDATE beyond a declared lock-only column', async () => {
  const [manifest, { appendOnly }] = await Promise.all([loadManifest(), loadSchema()]);
  assert.deepEqual([...appendOnly].sort(), [
    'institute_resubmissions', 'institute_status_history', 'institution_document_review_history',
    'institution_document_versions', 'institution_documents',
  ]);
  for (const table of appendOnly) {
    const entry = manifest.get(table);
    assert.ok(entry, `${table} missing from manifest`);
    assert.ok(!entry.privileges.includes('UPDATE'), `${table} is immutable and must not get table-wide UPDATE`);
    assert.deepEqual(entry.updateColumns, LOCK_ONLY_COLUMNS[table] ?? [], `${table}: only its declared lock-only column (if any) may be granted`);
  }
});

test('lock-only grants exist only on immutable tables, one column each, and are enforced by the grants migration', async () => {
  const [{ appendOnly }, grantsSql, immutabilitySql] = await Promise.all([
    loadSchema(), readServerFile(GRANTS_FILE).then(withoutComments), readServerFile('institutionDocumentsImmutabilityMigration.sql').then(withoutComments),
  ]);
  for (const [table, columns] of Object.entries(LOCK_ONLY_COLUMNS)) {
    assert.ok(appendOnly.has(table), `${table} has a lock-only grant but no always-reject UPDATE/DELETE trigger`);
    assert.equal(columns.length, 1, `${table}: one lock-only column is enough for SELECT ... FOR UPDATE`);
  }
  assert.match(immutabilitySql, /CREATE TRIGGER institution_documents_no_truncate\s+BEFORE TRUNCATE ON institution_documents/);
  assert.match(grantsSql, /lock-only UPDATE grant requires enabled immutability triggers/, 'the grants migration must fail closed without the triggers');
  for (const name of ['institution_documents_immutable', 'institution_documents_no_truncate']) {
    assert.match(grantsSql, new RegExp(`'${name}'`), `the grants migration must check ${name}`);
  }
  assert.ok((MIGRATION_FILES as readonly string[]).indexOf('institutionDocumentsImmutabilityMigration.sql')
    < (MIGRATION_FILES as readonly string[]).indexOf(GRANTS_FILE), 'triggers must exist before the grants run');
});

// ---------------------------------------------------------------------------
// Code inventory: every SQL statement in the server code must be covered by the manifest.
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(['where', 'set', 'on', 'join', 'left', 'right', 'inner', 'cross', 'order', 'group', 'limit', 'for', 'using', 'returning', 'values', 'and', 'or', 'as']);

async function sqlStatements(): Promise<Array<{ file: string; sql: string }>> {
  const files = (await readdir(SERVER_DIR)).filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('integration'));
  const statements: Array<{ file: string; sql: string }> = [];
  for (const file of files) {
    const source = await readServerFile(file);
    for (const [, template, quoted] of source.matchAll(/`([^`]*)`|'((?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|WITH)\b[^'\n]*)'/g)) {
      const sql = (template ?? quoted).replace(/\$\{[^}]*\}/g, ' ');
      if (/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|TRUNCATE)\b/.test(sql) && /\b(FROM|INTO|SET|TRUNCATE)\b/.test(sql)) {
        statements.push({ file, sql: sql.replace(/\s+/g, ' ') });
      }
    }
  }
  return statements;
}

test('server code needs only privileges the manifest grants (and never DELETE or TRUNCATE)', async () => {
  const [manifest, statements] = await Promise.all([loadManifest(), sqlStatements()]);
  const problems: string[] = [];
  const has = (table: string, privilege: string) => manifest.get(table)?.privileges.includes(privilege) ?? false;
  const canUpdate = (table: string, column?: string) => has(table, 'UPDATE')
    || (column ? manifest.get(table)?.updateColumns.includes(column) : (manifest.get(table)?.updateColumns.length ?? 0) > 0) || false;
  let checked = 0;
  const assigned = new Map<string, Set<string>>();

  for (const { file, sql } of statements) {
    if (!manifest.size) break;
    for (const [, table] of sql.matchAll(/\bDELETE FROM (\w+)/g)) problems.push(`${file}: DELETE FROM ${table} (the API role has no DELETE)`);
    for (const [, table] of sql.matchAll(/\bTRUNCATE (?:TABLE )?(\w+)/g)) problems.push(`${file}: TRUNCATE ${table} (the API role has no TRUNCATE)`);
    for (const [, table] of sql.matchAll(/\bINSERT INTO (\w+)/g)) {
      checked += 1;
      if (manifest.has(table) && !has(table, 'INSERT')) problems.push(`${file}: INSERT INTO ${table} not granted`);
    }
    const updates = [
      ...[...sql.matchAll(/\bUPDATE (\w+)(?: (?!SET\b)\w+)? SET (.*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|$)/g)].map((m) => [m[1], m[2]] as const),
      ...[...sql.matchAll(/\bINSERT INTO (\w+)[\s\S]*?\bON CONFLICT\b[\s\S]*?\bDO UPDATE SET (.*?)(?=\bWHERE\b|\bRETURNING\b|$)/g)].map((m) => [m[1], m[2]] as const),
    ];
    for (const [table, assignments] of updates) {
      if (!manifest.has(table)) continue;
      if (LOCK_ONLY_COLUMNS[table]) problems.push(`${file}: UPDATE ${table} (immutable; its column grant exists only for row locking)`);
      for (const [, column] of assignments.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/g)) {
        checked += 1;
        if (!assigned.has(table)) assigned.set(table, new Set());
        assigned.get(table)!.add(column);
        if (!canUpdate(table, column)) problems.push(`${file}: UPDATE ${table}.${column} not granted`);
      }
    }
    if (/\bFOR (?:NO KEY )?(?:UPDATE|SHARE)\b/.test(sql)) {
      const aliases = new Map<string, string>();
      for (const [, table, alias] of sql.matchAll(/\b(?:FROM|JOIN) (\w+)(?: (?:AS )?(\w+))?/g)) {
        if (!manifest.has(table)) continue;
        aliases.set(table, table);
        if (alias && !KEYWORDS.has(alias.toLowerCase())) aliases.set(alias, table);
      }
      const of = /\bFOR (?:NO KEY )?(?:UPDATE|SHARE) OF ([\w, ]+)/.exec(sql);
      const locked = of ? of[1].split(',').map((a) => aliases.get(a.trim()) ?? a.trim()) : [...new Set(aliases.values())];
      for (const table of locked) {
        checked += 1;
        if (manifest.has(table) && !canUpdate(table)) problems.push(`${file}: row lock on ${table} needs UPDATE on at least one column`);
      }
    }
    for (const [, table] of sql.matchAll(/\b(?:FROM|JOIN) (\w+)/g)) {
      if (manifest.has(table) && !has(table, 'SELECT')) problems.push(`${file}: SELECT from ${table} not granted`);
    }
  }
  assert.ok(statements.length > 100, `expected the server SQL inventory, found ${statements.length} statements`);
  assert.ok(checked > 80, `expected many privilege checks, ran ${checked}`);
  assert.deepEqual([...new Set(problems)], []);

  // No unnecessary grants (OD-P4): every granted UPDATE column is assigned by some server statement,
  // except declared lock-only columns, which exist only to permit SELECT ... FOR UPDATE.
  const unused: string[] = [];
  for (const [table, entry] of manifest) {
    for (const column of entry.updateColumns) {
      if (LOCK_ONLY_COLUMNS[table]?.includes(column)) continue;
      if (!assigned.get(table)?.has(column)) unused.push(`${table}.${column}`);
    }
  }
  assert.deepEqual(unused, [], 'UPDATE granted on columns the server code never assigns');
});

// ---------------------------------------------------------------------------
// File safety and execution semantics
// ---------------------------------------------------------------------------

test('the grants migration manages privileges only, and is a no-op before roles are provisioned', async () => {
  const sql = withoutComments(await readServerFile(GRANTS_FILE));
  assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP)\s+(ROLE|USER)\b/i, 'roles belong to the bootstrap, not a migration');
  assert.doesNotMatch(sql, /\b(ENCRYPTED\s+)?PASSWORD\s+(['$:]|E')/i);
  assert.doesNotMatch(sql, /\bOWNER\s+TO\b/i, 'ownership is transferred only by the bootstrap');
  assert.doesNotMatch(sql, /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET|TRUNCATE)\b/i, 'no data changes');
  assert.doesNotMatch(sql, /\bCREATE\s+(TEMP|TEMPORARY)\b/i, 'TEMPORARY is revoked on the database');
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT)\b[^;\n]*;/im, 'the migration runner owns the transaction');
  assert.doesNotMatch(sql, /\bGRANT\b[^;]*\b(DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b[^;]*\bTO eltnoy_app\b/i);
  assert.match(sql, /IF NOT roles_ready THEN\s+RAISE NOTICE '[^']*';\s+RETURN;/, 'must skip when roles are not provisioned');
  assert.match(sql, /current_user <> 'eltnoy_owner' AND NOT \(SELECT rolsuper/, 'must refuse other executing roles');
  assert.match(sql, /tables without an entry in the grant manifest/, 'must fail closed on unlisted tables');
  assert.match(sql, /sequences without an entry in the sequence manifest/, 'must fail closed on unlisted sequences');
  assert.match(sql, /objects not owned by eltnoy_owner/, 'must refuse objects with the wrong owner');
  assert.match(sql, /pg_has_role\('eltnoy_app', 'eltnoy_owner', 'MEMBER'\)/, 'must refuse role escalation through membership');
});

test('the role bootstrap is superuser-only, password-free, non-destructive and not a migration', async () => {
  const sql = withoutComments(await readServerFile(BOOTSTRAP_FILE));
  assert.ok(!(MIGRATION_FILES as readonly string[]).includes(BOOTSTRAP_FILE), 'the bootstrap must never run as a migration');
  assert.match(sql, /IF NOT \(SELECT rolsuper FROM pg_roles WHERE rolname = current_user\) THEN\s+RAISE EXCEPTION/);
  assert.doesNotMatch(sql, /\b(ENCRYPTED\s+)?PASSWORD\s+(['$:]|E'|NULL)/i, 'passwords are set interactively (\\password), never stored');
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bREASSIGN\s+OWNED\b/i);
  assert.doesNotMatch(sql, /\bSUPERUSER\b(?<!NOSUPERUSER)|[^O]CREATEROLE\b|[^O]CREATEDB\b|[^O]BYPASSRLS\b/, 'no role may be granted elevated attributes');
  assert.match(sql, /GRANT eltnoy_owner TO eltnoy_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE/);
  assert.match(sql, /ALTER ROLE eltnoy_migrator SET role = 'eltnoy_owner'/);
  assert.match(sql, /ALTER SCHEMA public OWNER TO eltnoy_owner/);
});

test('if the grants migration is wired into MIGRATION_FILES, it runs last', () => {
  const files = [...MIGRATION_FILES] as string[];
  const index = files.indexOf(GRANTS_FILE);
  assert.ok(index === -1 || index === files.length - 1, 'databaseGrantsMigration.sql must be the last migration');
});
