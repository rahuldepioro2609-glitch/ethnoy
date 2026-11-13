// PostgreSQL integration test for the role bootstrap and the fourth (grants) migration.
//
// Skipped unless ELTNOY_GRANTS_INTEGRATION=1. It then requires ELTNOY_GRANTS_TEST_DATABASE_URL to be a
// SUPERUSER connection to a dedicated, disposable database named eltnoy_grants_test on a disposable
// cluster (it creates cluster-wide roles). The host must be loopback, or exactly the value of
// ELTNOY_GRANTS_TEST_ALLOWED_HOST (for a container on an isolated network). Never point it at a real
// database: it changes ownership, privileges and roles.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { MIGRATION_FILES, runMigrations } from './migrate.js';

const TEST_DATABASE = 'eltnoy_grants_test';
const enabled = process.env.ELTNOY_GRANTS_INTEGRATION === '1';
const skip = !enabled;
let client: pg.Client | undefined;

function validatedUrl(value: string | undefined): string {
  if (!value) throw new Error('ELTNOY_GRANTS_TEST_DATABASE_URL is required.');
  const url = new URL(value);
  const allowedHost = process.env.ELTNOY_GRANTS_TEST_ALLOWED_HOST;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (decodeURIComponent(url.pathname.slice(1)) !== TEST_DATABASE || !(loopback || (allowedHost && url.hostname === allowedHost))) {
    throw new Error(`Only the dedicated ${TEST_DATABASE} database on a loopback or explicitly allowed host may be used.`);
  }
  return value;
}

const readServerFile = (name: string) => readFile(new URL(name, import.meta.url), 'utf8');
const q = async (text: string, values?: unknown[]) => (await client!.query(text, values)).rows;
const one = async (text: string) => Object.values((await q(text))[0] ?? {})[0];

/** Runs `sql` acting as `role` inside a savepoint; returns the error message, or null if it succeeded. */
async function attempt(role: string, sql: string): Promise<string | null> {
  await q('BEGIN');
  try {
    await q(`SET LOCAL ROLE ${role}`);
    await q(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await q('ROLLBACK');
  }
}

async function migrateAsOwner(files: string[]): Promise<void> {
  const migrations = await Promise.all(files.map(async (name) => ({ name, sql: await readServerFile(name) })));
  await q('SET ROLE eltnoy_owner');
  try {
    await runMigrations({ query: (text: string, values?: unknown[]) => client!.query(text, values) }, migrations);
  } finally {
    await q('RESET ROLE');
  }
}

const FINGERPRINT = `SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, '') AS x FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL SELECT a.attrelid::regclass || '.' || a.attname || ':' || coalesce(a.attacl::text, '') FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT p.oid::regprocedure || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  UNION ALL SELECT 'schema:' || pg_get_userbyid(nspowner) || ':' || coalesce(nspacl::text, '') FROM pg_namespace WHERE nspname = 'public') s`;

before(async () => {
  if (skip) return;
  client = new pg.Client({ connectionString: validatedUrl(process.env.ELTNOY_GRANTS_TEST_DATABASE_URL) });
  await client.connect();
  assert.equal(await one('SELECT current_database()'), TEST_DATABASE);
  assert.equal(await one('SELECT rolsuper FROM pg_roles WHERE rolname = current_user'), true, 'a superuser connection is required');
  assert.equal(await one("SELECT count(*)::int FROM pg_class WHERE relnamespace = 'public'::regnamespace"), 0, 'the test database must start empty');
});
after(async () => { await client?.end(); });

test('before bootstrap, the grants migration is a no-op that changes no privileges', { skip }, async () => {
  const rolesExist = await one("SELECT count(*)::int FROM pg_roles WHERE rolname LIKE 'eltnoy\\_%'");
  if (rolesExist !== 0) return; // roles are cluster-wide: a re-run on the same cluster can't observe this path
  const fpBefore = await one(FINGERPRINT);
  const notices: string[] = [];
  client!.on('notice', (n) => notices.push(n.message ?? ''));
  await q(await readServerFile('databaseGrantsMigration.sql'));
  assert.equal(await one(FINGERPRINT), fpBefore);
  assert.ok(notices.some((m) => /roles are not provisioned/.test(m)));
});

test('bootstrap + all four migrations (one transaction, as the owner) + idempotent re-run', { skip }, async () => {
  await q(await readServerFile('databaseRoleBootstrap.sql'));
  await q(await readServerFile('databaseRoleBootstrap.sql'));       // idempotent
  const files = [...MIGRATION_FILES, 'databaseGrantsMigration.sql'];
  await migrateAsOwner(files);
  const first = await one(FINGERPRINT);
  await migrateAsOwner(files);
  assert.equal(await one(FINGERPRINT), first, 'second run must not change ownership or privileges');
  assert.deepEqual(await q(`SELECT DISTINCT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relnamespace = 'public'::regnamespace`), [{ o: 'eltnoy_owner' }]);
  assert.equal(await one("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'"), 'eltnoy_owner');
  const roles = await q(`SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'eltnoy\\_%' ORDER BY 1`);
  for (const r of roles) assert.ok(!r.rolsuper && !r.rolcreaterole && !r.rolcreatedb && !r.rolbypassrls, `${r.rolname} must not be privileged`);
  assert.equal(roles.find((r) => r.rolname === 'eltnoy_owner')?.rolcanlogin, false);
  assert.deepEqual(await q(`SELECT inherit_option, set_option, admin_option FROM pg_auth_members WHERE roleid = 'eltnoy_owner'::regrole AND member = 'eltnoy_migrator'::regrole`),
    [{ inherit_option: false, set_option: true, admin_option: false }]);
});

test('catalog privileges for eltnoy_app equal the manifest exactly', { skip }, async () => {
  const sql = (await readServerFile('databaseGrantsMigration.sql')).replace(/--[^\n]*/g, '');
  const rows = [...sql.matchAll(/\('(\w+)',\s*'([A-Z, ]+)',\s*(NULL(?:::text\[\])?|ARRAY\[([^\]]*)\](?:::text\[\])?)\)/g)];
  assert.equal(rows.length, 24);
  for (const [, table, privileges, , columns] of rows) {
    const expected = privileges.split(',').map((p) => p.trim());
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const actual = await one(`SELECT has_table_privilege('eltnoy_app', 'public.${table}', '${privilege}')`);
      assert.equal(actual, expected.includes(privilege), `${table} ${privilege}`);
    }
    const updateColumns = columns ? [...columns.matchAll(/'(\w+)'/g)].map((m) => m[1]) : [];
    const granted = (await q(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'eltnoy_app' AND table_name = $1 AND privilege_type = 'UPDATE' ORDER BY 1`, [table])).map((r) => r.column_name);
    if (!expected.includes('UPDATE')) assert.deepEqual(granted, [...updateColumns].sort(), `${table} column UPDATE`);
  }
  for (const role of ['eltnoy_audit_writer', 'eltnoy_audit_reader', 'eltnoy_audit_verifier', 'public']) {
    assert.equal(await one(`SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee = '${role === 'public' ? 'PUBLIC' : role}' AND table_schema = 'public'`), 0, `${role} has no table grants`);
  }
  assert.equal(await one("SELECT has_schema_privilege('eltnoy_app', 'public', 'CREATE')"), false);
  assert.equal(await one("SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('eltnoy_app', p.oid, 'EXECUTE')"), 0);
  assert.equal(await one('SELECT has_database_privilege(\'eltnoy_app\', current_database(), \'TEMPORARY\')'), false);
});

test('the migration fails closed on unlisted tables and sequences, wrong owners and a wrong executing role', { skip }, async () => {
  const grants = await readServerFile('databaseGrantsMigration.sql');
  const cases: Array<[string, string, RegExp]> = [
    ['eltnoy_owner', 'CREATE TABLE p1a_unlisted (id int)', /tables without an entry in the grant manifest: p1a_unlisted/],
    ['eltnoy_owner', 'CREATE SEQUENCE p1a_unlisted_seq', /sequences without an entry in the sequence manifest: p1a_unlisted_seq/],
  ];
  for (const [role, setup, expected] of cases) {
    const error = await attempt(role, `${setup}; ${grants}`);
    assert.match(error ?? '', expected);
  }
  await q('BEGIN');
  try {
    await q('CREATE TABLE p1a_wrong_owner (id int)');   // created by the superuser, not eltnoy_owner
    await assert.rejects(q(grants), /objects not owned by eltnoy_owner: p1a_wrong_owner/);
  } finally { await q('ROLLBACK'); }
  assert.match(await attempt('eltnoy_app', grants) ?? '', /must run as eltnoy_owner|permission denied/);
  assert.match(await attempt('eltnoy_audit_verifier', grants) ?? '', /must run as eltnoy_owner|permission denied/);
});

const DOCUMENT_SETUP = `
  INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ('it-center', 'ITCENTER', 'IT Synthetic Center', 'center', '!synthetic');
  INSERT INTO institution_submission_cycles (id, institution_id, submission_version, source_type, status) VALUES ('it-cycle', 'it-center', 1, 'initial_registration', 'open');
  INSERT INTO institution_documents (id, institution_id, category, submission_cycle_id) VALUES ('it-doc', 'it-center', 'PAN Card', 'it-cycle');`;
const DOCUMENT_ROW = "SELECT md5(d::text) FROM institution_documents d WHERE id = 'it-doc'";

/** Seeds a synthetic document as the superuser, then runs `sql` as `role`, all in one rolled-back transaction. */
async function attemptOnDocument(role: string, sql: string): Promise<{ error: string | null; rowBefore: unknown; rowAfter: unknown }> {
  await q('BEGIN');
  try {
    await q(DOCUMENT_SETUP);
    const rowBefore = await one(DOCUMENT_ROW);
    await q('SAVEPOINT probe');
    let error: string | null = null;
    try {
      await q(`SET LOCAL ROLE ${role}`);
      await q(sql);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      await q('ROLLBACK TO SAVEPOINT probe');
    }
    await q('RESET ROLE');
    return { error, rowBefore, rowAfter: await one(DOCUMENT_ROW) };
  } finally {
    await q('ROLLBACK');
  }
}

test('institution_documents is immutable for every role, yet eltnoy_app can create, read and row-lock documents (OD-P3)', { skip }, async () => {
  const rejected: Array<[string, string, RegExp]> = [
    ['eltnoy_app', "UPDATE institution_documents SET created_at = created_at WHERE id = 'it-doc'", /institution documents are immutable/],
    ['eltnoy_app', "UPDATE institution_documents SET category = 'Address Proof' WHERE id = 'it-doc'", /permission denied/],
    ['eltnoy_app', "DELETE FROM institution_documents WHERE id = 'it-doc'", /permission denied/],
    ['eltnoy_app', 'TRUNCATE institution_documents', /permission denied/],
    ['eltnoy_owner', "UPDATE institution_documents SET category = 'Address Proof' WHERE id = 'it-doc'", /institution documents are immutable/],
    ['eltnoy_owner', "DELETE FROM institution_documents WHERE id = 'it-doc'", /institution documents are immutable/],
    // TRUNCATE must cascade to the referencing version/review tables, whose own append-only triggers
    // may fire first; either way a trigger refuses it.
    ['eltnoy_owner', 'TRUNCATE institution_documents CASCADE', /immutable|append-only/],
  ];
  for (const [role, sql, expected] of rejected) {
    const result = await attemptOnDocument(role, sql);
    assert.match(result.error ?? 'succeeded', expected, `${role}: ${sql}`);
    assert.equal(result.rowAfter, result.rowBefore, `${role}: the document row must be unchanged after the refused statement`);
  }
  const allowed = [
    "SELECT id, category FROM institution_documents WHERE id = 'it-doc' AND institution_id = 'it-center' FOR UPDATE",
    "SELECT id FROM institution_documents WHERE institution_id = 'it-center' FOR NO KEY UPDATE",
    "SELECT COUNT(*) FROM institution_documents WHERE institution_id = 'it-center' AND category = 'PAN Card'",
    "INSERT INTO institution_documents (id, institution_id, category, submission_cycle_id) VALUES ('it-doc-2', 'it-center', 'Address Proof', 'it-cycle')",
  ];
  for (const sql of allowed) {
    const result = await attemptOnDocument('eltnoy_app', sql);
    assert.equal(result.error, null, sql);
    assert.equal(result.rowAfter, result.rowBefore, `row locking and inserts must not modify the existing document: ${sql}`);
  }
  assert.equal(await one("SELECT has_column_privilege('eltnoy_app', 'institution_documents', 'created_at', 'UPDATE')"), true, 'the lock-only column remains granted');
  assert.equal(await one("SELECT count(*)::int FROM information_schema.column_privileges WHERE grantee = 'eltnoy_app' AND table_name = 'institution_documents' AND privilege_type = 'UPDATE'"), 1, 'exactly one lock-only column');
});

test('the grants migration refuses the lock-only grant when an immutability trigger is disabled', { skip }, async () => {
  const grants = await readServerFile('databaseGrantsMigration.sql');
  for (const trigger of ['institution_documents_immutable', 'institution_documents_no_truncate']) {
    const error = await attempt('eltnoy_owner', `ALTER TABLE institution_documents DISABLE TRIGGER ${trigger}; ${grants}`);
    assert.match(error ?? 'succeeded', new RegExp(`requires enabled immutability triggers; missing or disabled: ${trigger}`));
  }
});

test('no table-wide UPDATE for eltnoy_app; exclusive table locks and narrowed columns are refused (OD-P4)', { skip }, async () => {
  assert.equal(await one(`SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                            AND has_table_privilege('eltnoy_app', c.oid, 'UPDATE')`), 0, 'table-wide UPDATE must not be granted anywhere');
  for (const table of (await q("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1")).map((r) => r.relname)) {
    assert.match(await attempt('eltnoy_app', `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`) ?? 'succeeded', /permission denied/, `LOCK TABLE ${table}`);
  }
  const narrowed: Array<[string, string]> = [
    ['online_exam_attempts.expires_at', 'UPDATE online_exam_attempts SET expires_at = now() WHERE false'],
    ['online_exam_attempts.user_id', "UPDATE online_exam_attempts SET user_id = 'x' WHERE false"],
    ['published_results.roll_number', "UPDATE published_results SET roll_number = 'x' WHERE false"],
    ['admit_cards.application_id', "UPDATE admit_cards SET application_id = 'x' WHERE false"],
    ['answer_key_questions.exam_code', "UPDATE answer_key_questions SET exam_code = 'x' WHERE false"],
    ['online_exam_questions.question_number', 'UPDATE online_exam_questions SET question_number = 1 WHERE false'],
    ['exams.fee', "UPDATE exams SET fee = 'x' WHERE false"],
    ['feedback.email', "UPDATE feedback SET email = 'x' WHERE false"],
    ['portal_notices.full_content', "UPDATE portal_notices SET full_content = 'x' WHERE false"],
    ['institution_submission_capabilities.token_hash', "UPDATE institution_submission_capabilities SET token_hash = 'x' WHERE false"],
    ['institution_submission_cycles.institution_id', "UPDATE institution_submission_cycles SET institution_id = 'x' WHERE false"],
    ['center_checkins.center_code', "UPDATE center_checkins SET center_code = 'x' WHERE false"],
    ['institute_forms.institute_id', "UPDATE institute_forms SET institute_id = 'x' WHERE false"],
  ];
  for (const [label, sql] of narrowed) {
    assert.match(await attempt('eltnoy_app', sql) ?? 'succeeded', /permission denied/, label);
  }
  const stillAllowed: Array<[string, string]> = [
    ['P0-4 autosave/finalize columns', 'UPDATE online_exam_attempts SET responses = responses, score = score, submitted_at = submitted_at WHERE false'],
    ['P0-3 result publication', 'UPDATE published_results SET is_published = is_published WHERE false'],
    ['P0-3 result upsert columns', 'UPDATE published_results SET application_number = application_number, date_of_birth = date_of_birth, scorecard = scorecard, published_at = published_at WHERE false'],
    ['feedback triage', 'UPDATE feedback SET status = status, resolution_note = resolution_note WHERE false'],
    ['exam publication', 'UPDATE exams SET is_published = is_published, updated_at = updated_at WHERE false'],
    ['row lock on every narrowed table', 'SELECT 1 FROM exams FOR SHARE; SELECT 1 FROM online_exam_attempts FOR UPDATE; SELECT 1 FROM answer_key_questions FOR UPDATE; SELECT 1 FROM online_exam_questions FOR UPDATE; SELECT 1 FROM institute_profile_changes FOR UPDATE; SELECT 1 FROM institution_submission_cycles FOR UPDATE'],
  ];
  for (const [label, sql] of stillAllowed) {
    assert.equal(await attempt('eltnoy_app', sql), null, label);
  }
});

test('eltnoy_app is denied DDL, DELETE, TRUNCATE, protected-column updates and role escalation', { skip }, async () => {
  const denied: Array<[string, string]> = [
    ['CREATE TABLE', 'CREATE TABLE p1a_probe (id int)'],
    ['CREATE FUNCTION', "CREATE FUNCTION p1a_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
    ['CREATE TEMP TABLE', 'CREATE TEMP TABLE p1a_probe (id int)'],
    ['ALTER TABLE', 'ALTER TABLE users ADD COLUMN p1a_probe int'],
    ['DROP TABLE', 'DROP TABLE feedback'],
    ['TRUNCATE', 'TRUNCATE feedback'],
    ['DISABLE TRIGGER', 'ALTER TABLE institute_status_history DISABLE TRIGGER ALL'],
    ['CREATE ROLE', 'CREATE ROLE p1a_probe'],
    ['GRANT role to self', 'GRANT eltnoy_owner TO eltnoy_app'],
    ['session_replication_role', 'SET session_replication_role = replica'],
    ['COPY TO PROGRAM', "COPY users TO PROGRAM 'cat'"],
    ['pg_read_file', "SELECT pg_read_file('/etc/hostname')"],
    ['users.is_super_admin', 'UPDATE users SET is_super_admin = true WHERE false'],
    ['users.role/password_hash', "UPDATE users SET role = 'official', password_hash = 'x' WHERE false"],
    ['auth_sessions.expires_at', 'UPDATE auth_sessions SET expires_at = now() WHERE false'],
    ['institute_withdrawals.amount_paise', 'UPDATE institute_withdrawals SET amount_paise = 1 WHERE false'],
    ['wallet ledger UPDATE', 'UPDATE institute_wallet_entries SET amount_paise = 1 WHERE false'],
    ['status history UPDATE', 'UPDATE institute_status_history SET reason = reason WHERE false'],
  ];
  for (const table of (await q("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1")).map((r) => r.relname)) {
    denied.push([`DELETE ${table}`, `DELETE FROM ${table} WHERE false`]);
  }
  for (const [label, sql] of denied) {
    assert.notEqual(await attempt('eltnoy_app', sql), null, `${label} must be denied`);
  }
  // SET ROLE is authorized against the SESSION user, so it can't be probed from this superuser
  // session with SET LOCAL ROLE. Assert the underlying membership facts instead.
  for (const target of ['eltnoy_owner', 'eltnoy_migrator', 'eltnoy_audit_writer', 'eltnoy_audit_reader', 'eltnoy_audit_verifier', 'eltnoy_backup', 'pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program']) {
    for (const option of ['MEMBER', 'SET']) {
      assert.equal(await one(`SELECT pg_has_role('eltnoy_app', '${target}', '${option}')`), false, `eltnoy_app must not have ${option} on ${target}`);
    }
  }
  const allowed: Array<[string, string]> = [
    ['SELECT', 'SELECT count(*) FROM users'],
    ['users.account_status', 'UPDATE users SET account_status = account_status WHERE false'],
    ['auth_sessions.revoked_at', 'UPDATE auth_sessions SET revoked_at = now() WHERE false'],
    ['FOR UPDATE users', 'SELECT id FROM users FOR UPDATE'],
    ['FOR UPDATE institution_documents', 'SELECT id FROM institution_documents FOR UPDATE'],
    ['FOR SHARE exams', 'SELECT code FROM exams FOR SHARE'],
    ['lock_timeout', "SELECT set_config('lock_timeout', '5000ms', true)"],
  ];
  for (const [label, sql] of allowed) {
    assert.equal(await attempt('eltnoy_app', sql), null, `${label} must be allowed`);
  }
});
