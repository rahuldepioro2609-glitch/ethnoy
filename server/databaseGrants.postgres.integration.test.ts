// PostgreSQL integration test for the role bootstrap and the fourth (grants) migration.
//
// Skipped unless ELTNOY_GRANTS_INTEGRATION=1. It then requires ELTNOY_GRANTS_TEST_DATABASE_URL to be a
// SUPERUSER connection to a dedicated, disposable database named eltnoy_grants_test on a disposable
// cluster (it creates cluster-wide roles). Never point it at a real database: it changes ownership,
// privileges and roles.
//
// AUTH C1.4-B-3.2: run it ONLY through scripts/run-disposable-grants-tests.sh, which creates a fresh
// loopback-only cluster and supplies everything below. When enabled, the harness fails closed (before
// any connection, store import or test) unless ALL of these hold (see assertIsolatedEnvironment):
// - DOTENV_CONFIG_PATH is exactly /dev/null and DATABASE_URL is the unreachable placeholder, so the
//   application modules some tests import can never load .env or reach an application database;
// - ELTNOY_GRANTS_TEST_ALLOWED_HOST and DATABASE_PASSWORD_FILE are unset;
// - the test URL is postgres://<user>@127.0.0.1:<expected port>/eltnoy_grants_test with NO password in
//   it; the password comes only from ELTNOY_GRANTS_TEST_PASSWORD_FILE (absolute, regular, 0600);
// - ELTNOY_GRANTS_TEST_EXPECTED_PORT is set and is not 5432; ELTNOY_GRANTS_TEST_EXPECTED_DATA_DIR is set;
// - after connecting, the server reports exactly that port and data directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { MIGRATION_FILES, runMigrations } from './migrate.js';

const TEST_DATABASE = 'eltnoy_grants_test';
const enabled = process.env.ELTNOY_GRANTS_INTEGRATION === '1';
const skip = !enabled;
let client: pg.Client | undefined;

/** The only application database URL accepted while this harness runs: nothing listens on port 9. */
const PLACEHOLDER_DATABASE_URL = 'postgresql://placeholder:placeholder@127.0.0.1:9/placeholder';

/**
 * AUTH C1.4-B-3.2: environment isolation, checked BEFORE any connection or application import. Errors
 * name variables and rules only, never values. Exported shape is internal to this file.
 */
function isolationErrors(env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = [];
  if (env.DOTENV_CONFIG_PATH !== '/dev/null') errors.push('DOTENV_CONFIG_PATH must be exactly /dev/null (no .env may be loaded).');
  if (env.DATABASE_URL !== PLACEHOLDER_DATABASE_URL) errors.push('DATABASE_URL must be the unreachable placeholder (never an application database).');
  if (env.ELTNOY_GRANTS_TEST_ALLOWED_HOST !== undefined) errors.push('ELTNOY_GRANTS_TEST_ALLOWED_HOST must be unset (loopback only).');
  if (env.DATABASE_PASSWORD_FILE !== undefined) errors.push('DATABASE_PASSWORD_FILE must be unset.');
  const expectedPort = env.ELTNOY_GRANTS_TEST_EXPECTED_PORT ?? '';
  if (!/^[1-9][0-9]{0,4}$/.test(expectedPort) || Number(expectedPort) > 65535) errors.push('ELTNOY_GRANTS_TEST_EXPECTED_PORT must be a port number.');
  else if (expectedPort === '5432') errors.push('ELTNOY_GRANTS_TEST_EXPECTED_PORT must not be 5432 (the default server port).');
  const dataDir = env.ELTNOY_GRANTS_TEST_EXPECTED_DATA_DIR ?? '';
  if (!dataDir.startsWith('/')) errors.push('ELTNOY_GRANTS_TEST_EXPECTED_DATA_DIR must be an absolute path.');
  const passwordFile = env.ELTNOY_GRANTS_TEST_PASSWORD_FILE ?? '';
  if (!passwordFile.startsWith('/')) errors.push('ELTNOY_GRANTS_TEST_PASSWORD_FILE must be an absolute path.');
  else {
    try {
      const stats = statSync(passwordFile);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0 || (process.getuid && stats.uid !== process.getuid())) {
        errors.push('ELTNOY_GRANTS_TEST_PASSWORD_FILE must be a regular file owned by this user with mode 0600.');
      }
    } catch {
      errors.push('ELTNOY_GRANTS_TEST_PASSWORD_FILE must exist.');
    }
  }
  const raw = env.ELTNOY_GRANTS_TEST_DATABASE_URL;
  if (!raw) errors.push('ELTNOY_GRANTS_TEST_DATABASE_URL is required.');
  else {
    let url: URL | null = null;
    try { url = new URL(raw); } catch { errors.push('ELTNOY_GRANTS_TEST_DATABASE_URL must be a URL.'); }
    if (url) {
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) errors.push('ELTNOY_GRANTS_TEST_DATABASE_URL must use the postgres scheme.');
      if (url.hostname !== '127.0.0.1') errors.push('ELTNOY_GRANTS_TEST_DATABASE_URL must use host 127.0.0.1 (the disposable cluster listens only there).');
      if (url.port !== expectedPort || url.port === '5432' || url.port === '') errors.push('ELTNOY_GRANTS_TEST_DATABASE_URL must use exactly ELTNOY_GRANTS_TEST_EXPECTED_PORT (never 5432).');
      if (decodeURIComponent(url.pathname.slice(1)) !== TEST_DATABASE) errors.push(`ELTNOY_GRANTS_TEST_DATABASE_URL must name exactly ${TEST_DATABASE}.`);
      if (url.password !== '') errors.push('ELTNOY_GRANTS_TEST_DATABASE_URL must not contain a password (use ELTNOY_GRANTS_TEST_PASSWORD_FILE).');
      if (url.search !== '' || url.hash !== '') errors.push('ELTNOY_GRANTS_TEST_DATABASE_URL must not carry options.');
    }
  }
  return errors;
}

function assertIsolatedEnvironment(): void {
  const errors = isolationErrors(process.env);
  if (errors.length > 0) throw new Error(`Refusing to run the PostgreSQL harness: isolation is not proven.\n- ${errors.join('\n- ')}`);
}

/** Connection options for the disposable cluster only: the password is read from the 0600 file, never from a URL or variable. */
function connectionOptions(): { host: string; port: number; database: string; user: string; password: () => Promise<string> } {
  assertIsolatedEnvironment();
  const passwordFile = process.env.ELTNOY_GRANTS_TEST_PASSWORD_FILE!;
  // Explicit fields from the already validated URL, and NO connectionString: in pg 8.23.1, parsing a
  // connectionString overrides a separately supplied password function.
  const url = new URL(process.env.ELTNOY_GRANTS_TEST_DATABASE_URL!);
  return {
    host: url.hostname,
    port: Number(url.port),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: async () => (await readFile(passwordFile, 'utf8')).trim(),
  };
}

/** After connecting: the server must be exactly the expected disposable cluster (port and data directory). */
async function assertExpectedCluster(connection: pg.Client): Promise<void> {
  const row = (await connection.query("SELECT current_setting('port') AS port, current_setting('data_directory') AS data_directory")).rows[0];
  const real = (path: string) => { try { return realpathSync(path); } catch { return null; } };
  const expectedDir = real(process.env.ELTNOY_GRANTS_TEST_EXPECTED_DATA_DIR!);
  if (String(row.port) !== process.env.ELTNOY_GRANTS_TEST_EXPECTED_PORT || !expectedDir || real(String(row.data_directory)) !== expectedDir) {
    await connection.end().catch(() => undefined);
    throw new Error('Refusing to run the PostgreSQL harness: the server is not the expected disposable cluster (port or data directory differ).');
  }
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

/** The 24 tables granted before AUTH-1; all must stay in the manifest unchanged in membership. */
const LEGACY_UNGRANTED_TABLES = [
  'answer_key_objection_windows', 'answer_key_objections', 'auth_tokens', 'uploaded_files',
];

const PRE_AUTH1_TABLES = [
  'admit_cards', 'answer_key_questions', 'applications', 'auth_sessions', 'center_checkins', 'exams', 'feedback',
  'institute_forms', 'institute_profile_changes', 'institute_resubmissions', 'institute_status_history',
  'institute_wallet_entries', 'institute_withdrawals', 'institution_document_review_history',
  'institution_document_versions', 'institution_documents', 'institution_submission_capabilities',
  'institution_submission_cycles', 'mock_exam_attempts', 'online_exam_attempts', 'online_exam_questions',
  'portal_notices', 'published_results', 'users',
];

/** AUTH C1 (studentRegistrationClaimsMigration.sql): the ONLY table with DELETE (expired-claim cleanup). */
const C1_CLAIMS_TABLE = 'student_registration_claims';
const C1_GRANTS = { privileges: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['consumed_at'] };

/** AUTH-1 (authVerificationMigration.sql): exact grants for eltnoy_app; UPDATE only on these columns. */
const AUTH1_GRANTS: Record<string, { privileges: string[]; updateColumns: string[] }> = {
  account_contacts: { privileges: ['SELECT', 'INSERT'], updateColumns: ['destination', 'verified_at'] },
  auth_session_verifications: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  auth_verification_events: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  google_identities: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  institute_verifications: {
    privileges: ['SELECT', 'INSERT'],
    updateColumns: ['email_destination', 'email_verified_at', 'institutional_decided_at', 'institutional_decided_by', 'institutional_status',
      'mobile_destination', 'mobile_verified_at', 'suspended_at', 'suspended_by', 'updated_at'],
  },
  oauth_states: { privileges: ['SELECT', 'INSERT'], updateColumns: ['consumed_at'] },
  verification_challenges: {
    privileges: ['SELECT', 'INSERT'],
    updateColumns: ['attempts', 'code_expires_at', 'code_hash', 'consumed_at', 'destination', 'last_sent_at', 'send_count'],
  },
};

/** AUTH C1.8 (adminMfaMigration.sql): exact grants for eltnoy_app; no DELETE; UPDATE only on state columns. */
const MFA_GRANTS: Record<string, { privileges: string[]; updateColumns: string[] }> = {
  admin_mfa_challenges: { privileges: ['SELECT', 'INSERT'], updateColumns: ['attempts', 'consumed_at', 'consumed_reason', 'enrolment_ticket_id'] },
  admin_mfa_enrolment_tickets: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at', 'used_at'] },
  admin_mfa_factors: { privileges: ['SELECT', 'INSERT'], updateColumns: ['disabled_at', 'disabled_by', 'disabled_via', 'last_used_step'] },
  admin_mfa_recovery_codes: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at', 'used_at'] },
  admin_mfa_reset_requests: { privileges: ['SELECT', 'INSERT'], updateColumns: ['decided_by', 'decided_verification_id', 'decision_reason', 'status', 'ticket_id'] },
  auth_session_mfa_verifications: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
};

/** SM-1: exact grants for the wired Platform and Organization Staff tables. */
const STAFF_GRANTS: Record<string, { privileges: string[]; updateColumns: string[] }> = {
  platform_staff_departments: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  platform_staff_roles: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  platform_staff_permission_catalogue: { privileges: ['SELECT'], updateColumns: [] },
  platform_staff_role_permissions: { privileges: ['SELECT'], updateColumns: [] },
  platform_staff_accounts: { privileges: ['SELECT', 'INSERT'], updateColumns: ['deactivated_at', 'deactivated_by', 'department_id', 'must_change_password', 'password_hash', 'status'] },
  platform_staff_account_roles: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at', 'revoked_by'] },
  platform_staff_sessions: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at'] },
  platform_staff_audit_events: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  org_staff_role_templates: { privileges: ['SELECT'], updateColumns: [] },
  org_staff_members: { privileges: ['SELECT', 'INSERT'], updateColumns: ['accepted_at', 'activated_at', 'activated_by', 'password_hash', 'status'] },
  org_staff_invitations: { privileges: ['SELECT', 'INSERT'], updateColumns: ['used_at'] },
  org_staff_member_roles: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at', 'revoked_by'] },
  org_staff_sessions: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at'] },
  org_staff_audit_events: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
};

before(async () => {
  if (skip) return;
  // AUTH C1.4-B-3.2: fail closed BEFORE any connection, store import or test.
  assertIsolatedEnvironment();
  client = new pg.Client(connectionOptions());
  await client.connect();
  await assertExpectedCluster(client);
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

test('bootstrap + every wired migration (one transaction, as the owner) + idempotent re-run', { skip }, async () => {
  await q(await readServerFile('databaseRoleBootstrap.sql'));
  await q(await readServerFile('databaseRoleBootstrap.sql'));       // idempotent
  // The real production sequence, exactly once each: MIGRATION_FILES already ends with the grants migration.
  const files = [...MIGRATION_FILES] as string[];
  assert.equal(files.at(-1), 'databaseGrantsMigration.sql');
  assert.equal(files.filter((name) => name === 'databaseGrantsMigration.sql').length, 1);
  const orderedAuthMigrations = [
    'authVerificationMigration.sql',
    'studentEmailVerificationMigration.sql',
    'studentRegistrationClaimsMigration.sql',
    'adminMfaMigration.sql',
    'platformStaffMigration.sql',
    'organizationStaffMigration.sql',
    'databaseGrantsMigration.sql',
  ];
  for (const name of orderedAuthMigrations) {
    assert.equal(files.filter((file) => file === name).length, 1, `${name} is wired exactly once`);
  }
  const orderedAuthPositions = orderedAuthMigrations.map((name) => files.indexOf(name));
  assert.ok(orderedAuthPositions.every((position, index) => index === 0 || position > orderedAuthPositions[index - 1]),
    'AUTH-1, Student verification, claims, MFA and Staff migrations stay in dependency order before grants');
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

/** Institute Workspace (instituteWorkspaceMigration.sql): the 25 tables, listed explicitly. */
const WORKSPACE_TABLES = [
  'institute_admit_card_templates', 'institute_app_forms', 'institute_attendance_logs', 'institute_branches',
  'institute_candidate_applications', 'institute_cbt_incidents', 'institute_cbt_sessions', 'institute_exam_broadcasts',
  'institute_exam_results', 'institute_exams', 'institute_fee_refunds', 'institute_fee_transactions', 'institute_hall_tickets',
  'institute_interview_changes', 'institute_interview_scorecards', 'institute_interviews', 'institute_paper_blueprints', 'institute_questions',
  'institute_result_appeals', 'institute_saved_reports', 'institute_support_tickets', 'institute_training_courses',
  'institute_training_enrollments', 'institute_training_sessions', 'institute_verification_logs',
];

test('catalog privileges for eltnoy_app equal the manifest exactly', { skip }, async () => {
  const sql = (await readServerFile('databaseGrantsMigration.sql')).replace(/--[^\n]*/g, '');
  const rows = [...sql.matchAll(/\('(\w+)',\s*'([A-Z, ]+)',\s*(NULL(?:::text\[\])?|ARRAY\[([^\]]*)\](?:::text\[\])?)\)/g)];
  // Derived, not hard-coded: the manifest must list exactly the 24 pre-AUTH-1 tables, the AUTH-1,
  // claims, MFA, Staff and Institute Workspace tables, and exactly the tables the wired migrations created here.
  const manifestTables = rows.map(([, table]) => table).sort();
  assert.equal(new Set(manifestTables).size, manifestTables.length, 'no table is listed twice');
  assert.deepEqual(manifestTables, [...PRE_AUTH1_TABLES, ...Object.keys(AUTH1_GRANTS), C1_CLAIMS_TABLE, ...Object.keys(MFA_GRANTS), ...Object.keys(STAFF_GRANTS), ...WORKSPACE_TABLES].sort(), 'manifest = 24 existing + 7 AUTH-1 + 1 AUTH C1 + 6 MFA + 14 Staff + 25 Institute Workspace tables');
  // Sorted in JS on both sides: the database collation may order underscores differently.
  // Legacy Render tables may be absent from a fresh database; if present, each remains manifest-listed.
  const catalogTables = (await q("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')")).map((r) => String(r.relname)).sort();
  const catalogSet = new Set(catalogTables);
  const expectedCatalogTables = manifestTables.filter((table) =>
    !LEGACY_UNGRANTED_TABLES.includes(table) || catalogSet.has(table));
  assert.deepEqual(catalogTables, expectedCatalogTables, 'every current table has one manifest row; optional legacy rows may be absent');
  for (const [, table, privileges, , columns] of rows) {
    if (LEGACY_UNGRANTED_TABLES.includes(table) && !catalogSet.has(table)) {
      assert.equal(privileges, '', `${table} remains ungranted when absent`);
      assert.equal(columns, undefined, `${table} has no column grants`);
      continue;
    }
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
  assert.equal(await one("SELECT has_function_privilege('eltnoy_app', 'public.confirm_admin_mfa_enrolment_factor(text,text,text,text,bigint)', 'EXECUTE')"), true);
  assert.equal(await one("SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> 'public.confirm_admin_mfa_enrolment_factor(text,text,text,text,bigint)'::regprocedure AND has_function_privilege('eltnoy_app', p.oid, 'EXECUTE')"), 0);
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
    // AUTH C1.1: the table-level DELETE grant on the claims table permits an explicit LOCK TABLE in any
    // mode on that table alone (PostgreSQL 17: modes other than ACCESS SHARE / ROW EXCLUSIVE need
    // table-level UPDATE, DELETE, TRUNCATE or MAINTAIN). Asserted positively, so the documentation is tested.
    if (table === C1_CLAIMS_TABLE) {
      assert.equal(await attempt('eltnoy_app', `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`), null, `LOCK TABLE ${table} is permitted by its DELETE grant`);
      continue;
    }
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
    if (table === C1_CLAIMS_TABLE) continue; // AUTH C1: the one approved DELETE grant (asserted in the C1 tests)
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

// ---------------------------------------------------------------------------
// AUTH-1 (authVerificationMigration.sql): grants, append-only audit, Google identity constraints and
// the row locks the AUTH-1 store takes. Synthetic rows only, always inside a rolled-back transaction.
// ---------------------------------------------------------------------------

/**
 * Seeds `setup` as the superuser, then runs `sql` as `role` inside a savepoint; everything is rolled
 * back. Returns the error (or null) and `probe` evaluated before and after (to prove nothing changed).
 */
async function attemptWithSetup(setup: string, role: string, sql: string, probe?: string): Promise<{ error: string | null; before: unknown; after: unknown }> {
  await q('BEGIN');
  try {
    await q(setup);
    const before = probe ? await one(probe) : null;
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
    return { error, before, after: probe ? await one(probe) : null };
  } finally {
    await q('ROLLBACK');
  }
}

test('AUTH-1: the seven tables carry exactly the manifest grants, column UPDATE included, and nothing else', { skip }, async () => {
  for (const [table, expected] of Object.entries(AUTH1_GRANTS)) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(await one(`SELECT has_table_privilege('eltnoy_app', 'public.${table}', '${privilege}')`), expected.privileges.includes(privilege), `${table} ${privilege}`);
    }
    const granted = (await q(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'eltnoy_app' AND table_name = $1 AND privilege_type = 'UPDATE'`, [table]))
      .map((r) => String(r.column_name)).sort();
    assert.deepEqual(granted, [...expected.updateColumns].sort(), `${table}: column-level UPDATE is exactly the manifest list`);
  }
  // Identity and ownership columns are never updatable by the API role.
  const denied: Array<[string, string]> = [
    ['account_contacts.user_id', "UPDATE account_contacts SET user_id = 'x' WHERE false"],
    ['verification_challenges.user_id', "UPDATE verification_challenges SET user_id = 'x' WHERE false"],
    ['verification_challenges.purpose', "UPDATE verification_challenges SET purpose = 'x' WHERE false"],
    ['auth_session_verifications.method', "UPDATE auth_session_verifications SET method = 'x' WHERE false"],
    ['institute_verifications.institution_id', "UPDATE institute_verifications SET institution_id = 'x' WHERE false"],
    ['google_identities.user_id (rebinding)', "UPDATE google_identities SET user_id = 'x' WHERE false"],
    ['google_identities.google_sub', "UPDATE google_identities SET google_sub = 'x' WHERE false"],
    ['oauth_states.user_id', "UPDATE oauth_states SET user_id = 'x' WHERE false"],
    ['auth_verification_events.details', "UPDATE auth_verification_events SET details = '{}' WHERE false"],
  ];
  for (const [label, sql] of denied) {
    assert.match(await attempt('eltnoy_app', sql) ?? 'succeeded', /permission denied/, label);
  }
  for (const table of Object.keys(AUTH1_GRANTS)) {
    assert.match(await attempt('eltnoy_app', `DELETE FROM ${table} WHERE false`) ?? 'succeeded', /permission denied/, `DELETE ${table}`);
    assert.match(await attempt('eltnoy_app', `TRUNCATE ${table}`) ?? 'succeeded', /permission denied/, `TRUNCATE ${table}`);
  }
});

test('SM-1: Staff tables carry exactly the manifest grants and no DELETE or table-wide UPDATE', { skip }, async () => {
  for (const [table, expected] of Object.entries(STAFF_GRANTS)) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(await one(`SELECT has_table_privilege('eltnoy_app', 'public.${table}', '${privilege}')`), expected.privileges.includes(privilege), `${table} ${privilege}`);
    }
    const granted = (await q(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'eltnoy_app' AND table_name = $1 AND privilege_type = 'UPDATE' ORDER BY 1`, [table])).map((r) => String(r.column_name));
    assert.deepEqual(granted, [...expected.updateColumns].sort(), `${table}: exact column-level UPDATE`);
  }
});

const AUTH_EVENT_SETUP = "INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ('it-event', 'it.synthetic', NULL, '{}'::jsonb);";
const AUTH_EVENT_ROW = "SELECT md5(e::text) FROM auth_verification_events e WHERE id = 'it-event'";

test('AUTH-1: auth_verification_events is append-only for every role; eltnoy_app can append and read', { skip }, async () => {
  const rejected: Array<[string, string, RegExp]> = [
    ['eltnoy_app', "UPDATE auth_verification_events SET action = 'x' WHERE id = 'it-event'", /permission denied/],
    ['eltnoy_app', "DELETE FROM auth_verification_events WHERE id = 'it-event'", /permission denied/],
    ['eltnoy_app', 'TRUNCATE auth_verification_events', /permission denied/],
    ['eltnoy_owner', "UPDATE auth_verification_events SET action = 'x' WHERE id = 'it-event'", /append-only/],
    ['eltnoy_owner', "DELETE FROM auth_verification_events WHERE id = 'it-event'", /append-only/],
    ['eltnoy_owner', 'TRUNCATE auth_verification_events', /append-only/],
  ];
  for (const [role, sql, expected] of rejected) {
    const result = await attemptWithSetup(AUTH_EVENT_SETUP, role, sql, AUTH_EVENT_ROW);
    assert.match(result.error ?? 'succeeded', expected, `${role}: ${sql}`);
    assert.equal(result.after, result.before, `${role}: the event row is unchanged after the refused statement`);
  }
  const allowed = [
    "INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ('it-event-2', 'it.synthetic', NULL, '{}'::jsonb)",
    "SELECT id, occurred_at, action, user_id, details FROM auth_verification_events WHERE action = ANY(ARRAY['it.synthetic']) ORDER BY occurred_at DESC LIMIT 5",
  ];
  for (const sql of allowed) {
    const result = await attemptWithSetup(AUTH_EVENT_SETUP, 'eltnoy_app', sql, AUTH_EVENT_ROW);
    assert.equal(result.error, null, sql);
    assert.equal(result.after, result.before);
  }
});

// Two synthetic accounts (rolled back with the test); the FK on google_identities.user_id needs them.
const GOOGLE_SETUP = `
  INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES
    ('it-google-a', 'ITGOOGLEA', 'IT Synthetic A', 'center', '!synthetic'),
    ('it-google-b', 'ITGOOGLEB', 'IT Synthetic B', 'center', '!synthetic');`;
const GOOGLE_LINK = (id: string, userId: string, sub: string) =>
  `INSERT INTO google_identities (id, user_id, google_sub, email, linked_at) VALUES ('${id}', '${userId}', '${sub}', 'it@example.test', now()) ON CONFLICT DO NOTHING RETURNING id`;

test('AUTH-1: google_identities unique constraints decide links atomically, as eltnoy_app, without row locks', { skip }, async () => {
  await q('BEGIN');
  try {
    await q(GOOGLE_SETUP);
    await q('SET LOCAL ROLE eltnoy_app');
    // The store's exact statement: the first link is inserted.
    assert.equal((await q(GOOGLE_LINK('it-link-1', 'it-google-a', 'it-sub-1'))).length, 1, 'first link inserted');
    // Same Google subject for another account: the unique index on google_sub inserts nothing.
    assert.equal((await q(GOOGLE_LINK('it-link-2', 'it-google-b', 'it-sub-1'))).length, 0, 'sub_taken: nothing inserted');
    // Second Google subject for the same account: the unique index on user_id inserts nothing.
    assert.equal((await q(GOOGLE_LINK('it-link-3', 'it-google-a', 'it-sub-2'))).length, 0, 'user_has_link: nothing inserted');
    // The store's classification query sees the committed-in-transaction winner.
    const classified = await q("SELECT user_id, google_sub FROM google_identities WHERE google_sub = 'it-sub-1' OR user_id = 'it-google-b'");
    assert.deepEqual(classified, [{ user_id: 'it-google-a', google_sub: 'it-sub-1' }], 'the existing link is unchanged');
    // Without ON CONFLICT the constraints raise unique violations (never a silent second link).
    await q('SAVEPOINT plain_insert');
    await assert.rejects(q("INSERT INTO google_identities (id, user_id, google_sub, email, linked_at) VALUES ('it-link-4', 'it-google-b', 'it-sub-1', 'it@example.test', now())"),
      (error: unknown) => (error as { code?: string }).code === '23505');
    await q('ROLLBACK TO SAVEPOINT plain_insert');
    // Rebinding is impossible for the API role, and so is the row lock the old code used.
    await q('SAVEPOINT rebind');
    await assert.rejects(q("UPDATE google_identities SET user_id = 'it-google-b' WHERE google_sub = 'it-sub-1'"), /permission denied/);
    await q('ROLLBACK TO SAVEPOINT rebind');
    await q('SAVEPOINT lock');
    await assert.rejects(q("SELECT user_id FROM google_identities WHERE google_sub = 'it-sub-1' FOR UPDATE"), /permission denied/);
    await q('ROLLBACK TO SAVEPOINT lock');
    assert.equal((await q("SELECT count(*)::int AS n FROM google_identities WHERE id LIKE 'it-link-%'"))[0].n, 1, 'exactly one link exists');
  } finally {
    await q('ROLLBACK');
  }
  assert.equal(await one("SELECT count(*)::int FROM google_identities WHERE id LIKE 'it-link-%'"), 0, 'nothing persists after the test');
  assert.equal(await one("SELECT count(*)::int FROM users WHERE id LIKE 'it-google-%'"), 0, 'no synthetic account persists');
});

test('AUTH-1: eltnoy_app may take the row locks the AUTH-1 store uses (users FOR SHARE, institute_verifications FOR UPDATE)', { skip }, async () => {
  // Exactly the statements in authVerificationStore.ts decideInstitutional.
  assert.equal(await attempt('eltnoy_app', "SELECT id FROM users WHERE id = 'it-none' AND role = 'center' FOR SHARE"), null, 'users FOR SHARE');
  assert.equal(await attempt('eltnoy_app', "SELECT * FROM institute_verifications WHERE institution_id = 'it-none' FOR UPDATE"), null, 'institute_verifications FOR UPDATE');
  // Other AUTH-1 locks the store relies on: none on google_identities (asserted above), and the
  // verification_challenges and oauth_states updates use column grants, not row locks.
  assert.match(await attempt('eltnoy_app', 'LOCK TABLE institute_verifications IN ACCESS EXCLUSIVE MODE') ?? 'succeeded', /permission denied/, 'no exclusive table lock');
});

// ---------------------------------------------------------------------------
// AUTH C1 (studentRegistrationClaimsMigration.sql): grants, constraints, and the REAL store code run
// as eltnoy_app against PostgreSQL transactions, row locks and advisory locks. Synthetic ids start
// with 'it-c1-'; rows are removed at the end (append-only audit events stay in this disposable DB).
// ---------------------------------------------------------------------------

const C1_HASH = `$2a$04$${'a'.repeat(53)}`;

test('AUTH C1: claims grants are exactly SELECT, INSERT, DELETE + UPDATE(consumed_at); constraints enforce ownership and shape', { skip }, async () => {
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.equal(await one(`SELECT has_table_privilege('eltnoy_app', 'public.${C1_CLAIMS_TABLE}', '${privilege}')`), C1_GRANTS.privileges.includes(privilege), `${C1_CLAIMS_TABLE} ${privilege}`);
  }
  const columns = (await q(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'eltnoy_app' AND table_name = $1 AND privilege_type = 'UPDATE' ORDER BY 1`, [C1_CLAIMS_TABLE])).map((r) => String(r.column_name));
  assert.deepEqual(columns, C1_GRANTS.updateColumns);
  // Exactly one table in the database grants DELETE to the API role.
  assert.deepEqual((await q(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND has_table_privilege('eltnoy_app', oid, 'DELETE') ORDER BY 1`)).map((r) => r.relname), [C1_CLAIMS_TABLE]);
  for (const [label, sql] of [
    ['claims.mobile', "UPDATE student_registration_claims SET mobile = 'x' WHERE false"],
    ['claims.password_hash', "UPDATE student_registration_claims SET password_hash = 'x' WHERE false"],
    ['claims.expires_at', 'UPDATE student_registration_claims SET expires_at = now() WHERE false'],
    ['challenges.registration_claim_id', "UPDATE verification_challenges SET registration_claim_id = 'x' WHERE false"],
    ['challenges.user_id', "UPDATE verification_challenges SET user_id = 'x' WHERE false"],
    ['DELETE challenges', 'DELETE FROM verification_challenges WHERE false'],
    ['TRUNCATE claims', 'TRUNCATE student_registration_claims'],
  ] as const) {
    assert.match(await attempt('eltnoy_app', sql) ?? 'succeeded', /permission denied/, label);
  }
  for (const [label, sql] of [
    ['row lock on a claim', "SELECT id FROM student_registration_claims WHERE id = 'it-none' FOR UPDATE"],
    ['bounded cleanup statement', "DELETE FROM student_registration_claims WHERE id IN (SELECT c.id FROM student_registration_claims c WHERE c.consumed_at IS NULL AND c.expires_at <= now() LIMIT 1 FOR UPDATE SKIP LOCKED)"],
    ['transaction advisory lock', 'SELECT pg_advisory_xact_lock(42::bigint)'],
  ] as const) {
    assert.equal(await attempt('eltnoy_app', sql), null, label);
  }
  // AUTH C1.1 locking: a normal DELETE takes only ROW EXCLUSIVE on the table (plus row locks on the rows
  // it deletes), never ACCESS EXCLUSIVE; an explicit LOCK TABLE can take ACCESS EXCLUSIVE on this table
  // only. Lock modes are read from pg_locks for this backend inside a rolled-back transaction.
  const tableLockModes = async (sql: string) => {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE eltnoy_app');
      await q(sql);
      return (await q(`SELECT mode FROM pg_locks WHERE locktype = 'relation' AND pid = pg_backend_pid() AND relation = 'public.student_registration_claims'::regclass ORDER BY mode`)).map((r) => String(r.mode));
    } finally {
      await q('ROLLBACK');
    }
  };
  assert.deepEqual(await tableLockModes('DELETE FROM student_registration_claims WHERE id = \'it-none\''), ['RowExclusiveLock'], 'DELETE takes ROW EXCLUSIVE only');
  assert.deepEqual(await tableLockModes('LOCK TABLE student_registration_claims IN ACCESS EXCLUSIVE MODE'), ['AccessExclusiveLock'], 'explicit LOCK TABLE takes ACCESS EXCLUSIVE');
  for (const unrelated of ['users', 'verification_challenges', 'auth_verification_events', 'account_contacts']) {
    assert.match(await attempt('eltnoy_app', `LOCK TABLE ${unrelated} IN ACCESS EXCLUSIVE MODE`) ?? 'succeeded', /permission denied/, `no ACCESS EXCLUSIVE on ${unrelated}`);
  }
  // Constraints (as the API role, inside rolled-back transactions).
  const seed = `INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ('it-c1-u0', 'IT-C1-U0', 'IT', 'candidate', '!synthetic');
    INSERT INTO student_registration_claims (id, mobile, display_name, password_hash, created_at, expires_at) VALUES ('it-c1-k0', '+919876500100', 'IT Claim', '${C1_HASH}', now(), now() + interval '5 minutes');`;
  const challenge = (userId: string, claimId: string, purpose = 'student_registration') =>
    `INSERT INTO verification_challenges (id, purpose, user_id, registration_claim_id, channel, destination, expires_at) VALUES ('it-c1-ch', '${purpose}', ${userId}, ${claimId}, 'sms', '+919876500100', now() + interval '5 minutes')`;
  for (const [label, sql] of [
    ['no owner', challenge('NULL', 'NULL')],
    ['two owners', challenge("'it-c1-u0'", "'it-c1-k0'")],
    ['claim for another purpose', challenge('NULL', "'it-c1-k0'", 'student_login')],
    ['unknown claim (FK)', challenge('NULL', "'it-c1-missing'")],
    ['claim mobile not E.164 +91', `INSERT INTO student_registration_claims (id, mobile, display_name, password_hash, created_at, expires_at) VALUES ('it-c1-k1', '9876500100', 'IT', '${C1_HASH}', now(), now() + interval '1 minute')`],
    ['plaintext password', "INSERT INTO student_registration_claims (id, mobile, display_name, password_hash, created_at, expires_at) VALUES ('it-c1-k1', '+919876500100', 'IT', 'plain-password', now(), now() + interval '1 minute')"],
    ['claim that never expires', `INSERT INTO student_registration_claims (id, mobile, display_name, password_hash, created_at, expires_at) VALUES ('it-c1-k1', '+919876500100', 'IT', '${C1_HASH}', now(), now())`],
  ] as const) {
    const result = await attemptWithSetup(seed, 'eltnoy_app', sql);
    assert.match(result.error ?? 'succeeded', /violates (check|foreign key) constraint/, label);
  }
  for (const [label, sql] of [
    ['claim-backed registration challenge', challenge('NULL', "'it-c1-k0'")],
    ['account-backed challenge (existing flows)', challenge("'it-c1-u0'", 'NULL', 'student_login')],
    ['a second, non-exclusive claim for the same mobile', `INSERT INTO student_registration_claims (id, mobile, display_name, password_hash, created_at, expires_at) VALUES ('it-c1-k2', '+919876500100', 'IT', '${C1_HASH}', now(), now() + interval '1 minute')`],
  ] as const) {
    assert.equal((await attemptWithSetup(seed, 'eltnoy_app', sql)).error, null, label);
  }
});

/** A pool whose every connection acts as eltnoy_app (the role the API uses), for the real store code. */
function appDatabase() {
  const pool = new pg.Pool({ ...connectionOptions(), max: 8 });
  const connect = async () => {
    const connection = await pool.connect();
    await connection.query('SET ROLE eltnoy_app');
    return connection;
  };
  const db = {
    connect,
    query: async (text: string, values?: unknown[]) => {
      const connection = await connect();
      try { return await connection.query(text, values); } finally { connection.release(); }
    },
  };
  return { db, storeDb: db as never, end: () => pool.end() };
}

let c1Sequence = 0;
const c1Id = (label: string) => `it-c1-${label}-${(c1Sequence += 1)}`;

async function c1Claim(stores: { registration: import('./authVerificationStore.js').StudentRegistrationStore; auth: import('./authVerificationStore.js').AuthVerificationStore }, mobile: string, options: { claimTtlMs?: number; challengeTtlMs?: number } = {}) {
  const now = Date.now();
  const claimId = c1Id('claim');
  const challengeId = c1Id('challenge');
  await stores.registration.createClaim({ id: claimId, mobile, displayName: 'IT Student', passwordHash: C1_HASH, createdAt: new Date(now - 1000), expiresAt: new Date(now + (options.claimTtlMs ?? 300_000)) });
  await stores.auth.createChallenge({ id: challengeId, purpose: 'student_registration', userId: null, registrationClaimId: claimId, channel: 'sms', destination: mobile, expiresAt: new Date(now + (options.challengeTtlMs ?? 300_000)) }, { action: 'it.c1.started', userId: null });
  return { claimId, challengeId };
}

const c1Complete = (registration: import('./authVerificationStore.js').StudentRegistrationStore, claim: { claimId: string; challengeId: string }, mobile: string, loginId: string) =>
  registration.completeRegistration({
    challengeId: claim.challengeId, claimId: claim.claimId, destination: mobile, userId: c1Id('user'), loginId,
    sessionTokenHash: c1Id('session'), sessionExpiresAt: new Date(Date.now() + 3600_000), now: new Date(),
  });

const c1Owners = async (mobile: string) => (await q(
  `SELECT ac.user_id FROM account_contacts ac JOIN users u ON u.id = ac.user_id WHERE ac.channel = 'sms' AND ac.destination = $1 AND ac.verified_at IS NOT NULL AND u.role = 'candidate'`, [mobile],
)).map((r) => String(r.user_id));

test('AUTH C1: real completion, concurrency, legacy-capture race, expiry/cleanup race and SMS reservations as eltnoy_app', { skip }, async () => {
  const storeModule = await import('./authVerificationStore.js');
  const { db, storeDb, end } = appDatabase();
  const registration = storeModule.createPostgresStudentRegistrationStore(storeDb);
  const auth = storeModule.createPostgresAuthVerificationStore(storeDb);
  const guard = storeModule.createPostgresSmsSendGuardStore(storeDb);
  const stores = { registration, auth };
  try {
    assert.equal((await db.query('SELECT current_user AS u')).rows[0].u, 'eltnoy_app');

    // 1. Attacker claim, then owner claim: the first VERIFIED claim wins; the other is refused.
    const m1 = '+919876500101';
    const attacker = await c1Claim(stores, m1);
    const owner = await c1Claim(stores, m1);
    assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-M1'`), 0, 'a claim reserves no login ID');
    assert.equal(await c1Complete(registration, owner, m1, 'IT-C1-M1'), 'completed');
    assert.equal(await c1Complete(registration, attacker, m1, 'IT-C1-M1'), 'refused');
    assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-M1'`), 1);
    assert.equal((await c1Owners(m1)).length, 1);
    assert.equal(await one(`SELECT count(*)::int FROM auth_sessions s JOIN auth_session_verifications v USING (token_hash) JOIN users u ON u.id = s.user_id WHERE u.login_id = 'IT-C1-M1'`), 1, 'one verified session');
    // AUTH C1.1: the completed claim and its challenge are deleted by the completion; the refused claim is consumed (dead).
    assert.equal(await one(`SELECT count(*)::int FROM student_registration_claims WHERE id = '${owner.claimId}'`), 0, 'completed claim deleted');
    assert.equal(await one(`SELECT count(*)::int FROM verification_challenges WHERE id = '${owner.challengeId}'`), 0, 'its challenge cascaded');
    assert.equal(await one(`SELECT consumed_at IS NOT NULL FROM student_registration_claims WHERE id = '${attacker.claimId}'`), true, 'refused claim consumed');
    assert.equal(await one(`SELECT consumed_at IS NOT NULL FROM verification_challenges WHERE id = '${attacker.challengeId}'`), true, 'refused claim has no live challenge');
    assert.equal(await c1Complete(registration, owner, m1, 'IT-C1-M1'), 'not_in_progress', 'a completed claim cannot be replayed');
    assert.equal(await c1Complete(registration, attacker, m1, 'IT-C1-M1'), 'not_in_progress', 'a refused claim cannot be replayed');
    // Login-ID refusal (a derived login ID exists without a verified contact): also consumed.
    const m1b = '+919876500111';
    await q(`INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ('it-c1-derived', 'IT-C1-M1B', 'IT Derived', 'candidate', '!synthetic')`);
    const loginTaken = await c1Claim(stores, m1b);
    assert.equal(await c1Complete(registration, loginTaken, m1b, 'IT-C1-M1B'), 'refused');
    assert.equal(await one(`SELECT consumed_at IS NOT NULL FROM student_registration_claims WHERE id = '${loginTaken.claimId}'`), true);
    assert.equal(await one(`SELECT count(*)::int FROM account_contacts WHERE user_id = 'it-c1-derived'`), 0, 'the existing account is unchanged');

    // Transient failure: a duplicate session token (primary-key violation) rolls the whole completion
    // back; the claim stays unconsumed, the challenge stays live, and a retry completes.
    const m1c = '+919876500112';
    const retryable = await c1Claim(stores, m1c);
    const takenToken = String(await one(`SELECT s.token_hash FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.login_id = 'IT-C1-M1'`));
    await assert.rejects(registration.completeRegistration({
      challengeId: retryable.challengeId, claimId: retryable.claimId, destination: m1c, userId: c1Id('user'), loginId: 'IT-C1-M1C',
      sessionTokenHash: takenToken, sessionExpiresAt: new Date(Date.now() + 3600_000), now: new Date(),
    }), (error: unknown) => (error as { code?: string }).code === '23505');
    assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-M1C'`), 0, 'nothing persisted');
    assert.equal(await one(`SELECT consumed_at IS NULL FROM student_registration_claims WHERE id = '${retryable.claimId}'`), true, 'claim not consumed');
    assert.equal(await one(`SELECT consumed_at IS NULL FROM verification_challenges WHERE id = '${retryable.challengeId}'`), true, 'challenge still live');
    assert.equal(await c1Complete(registration, retryable, m1c, 'IT-C1-M1C'), 'completed', 'safe retry');

    // 2. Several claims for one mobile completed in parallel: exactly one account.
    const m2 = '+919876500102';
    const parallel = await Promise.all([1, 2, 3, 4].map(() => c1Claim(stores, m2)));
    const outcomes = await Promise.all(parallel.map((claim) => c1Complete(registration, claim, m2, 'IT-C1-M2')));
    assert.deepEqual(outcomes.sort(), ['completed', 'refused', 'refused', 'refused']);
    assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-M2'`), 1);
    assert.equal((await c1Owners(m2)).length, 1);

    // 3. The same claim completed in parallel: one account, one session.
    const m3 = '+919876500103';
    const same = await c1Claim(stores, m3);
    const twice = await Promise.all([1, 2, 3].map(() => c1Complete(registration, same, m3, 'IT-C1-M3')));
    assert.deepEqual(twice.sort(), ['completed', 'not_in_progress', 'not_in_progress']);
    assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-M3'`), 1);

    // 4. Legacy mobile capture racing registration of the same number (several rounds, both orders).
    for (let round = 0; round < 6; round += 1) {
      const mobile = `+91987650020${round}`;
      const legacyId = c1Id('legacy');
      await q(`INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ($1, $2, 'IT Legacy', 'candidate', '!synthetic')`, [legacyId, legacyId.toUpperCase()]);
      const captureId = c1Id('capture');
      await auth.createChallenge({ id: captureId, purpose: 'student_mobile_capture', userId: legacyId, channel: 'sms', destination: mobile, expiresAt: new Date(Date.now() + 300_000) }, { action: 'it.c1.started', userId: legacyId });
      const claim = await c1Claim(stores, mobile);
      const loginId = `IT-C1-RACE-${round}`;
      const capture = () => auth.completeStudentVerification({ challengeId: captureId, userId: legacyId, destination: mobile, sessionTokenHash: c1Id('session'), sessionExpiresAt: new Date(Date.now() + 3600_000), now: new Date(), mobileFirstLoginId: loginId });
      const complete = () => c1Complete(registration, claim, mobile, loginId);
      const [a, b] = round % 2 === 0 ? await Promise.all([capture(), complete()]) : (await Promise.all([complete(), capture()])).reverse();
      const captured = a === true;
      const registered = b === 'completed';
      assert.ok(captured !== registered, `round ${round}: exactly one wins (capture=${String(a)}, registration=${b})`);
      const owners = await c1Owners(mobile);
      const derived = (await q('SELECT id FROM users WHERE login_id = $1', [loginId])).map((r) => String(r.id));
      if (captured) {
        assert.equal(owners.length, 1, `round ${round}: capture winner owns the verified mobile`);
        assert.deepEqual(derived, [], `round ${round}: a mobile capture does not create a second derived account`);
      } else {
        assert.equal(owners.length, 1, 'registration completion records the verified mobile');
        assert.equal(registered, true, `round ${round}: registration winner has the derived account`);
        assert.equal(derived.length, 1);
        assert.equal((await c1Owners(mobile)).length, 1, `round ${round}: registration winner owns the verified email`);
      }
    }

    // 5. Expiry vs cleanup: an expired claim with a live challenge is kept and cannot complete; once its
    //    challenge is dead, cleanup (as eltnoy_app) deletes it and cascades its challenge only.
    const m5 = '+919876500105';
    const expired = await c1Claim(stores, m5, { claimTtlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [first, deletedWhileLive] = await Promise.all([c1Complete(registration, expired, m5, 'IT-C1-M5'), registration.deleteExpiredClaims(new Date(), 50)]);
    assert.equal(first, 'expired');
    assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-M5'`), 0);
    assert.equal(deletedWhileLive >= 0, true);
    const dead = await c1Claim(stores, '+919876500106', { claimTtlMs: 1 });
    // Its challenge is dead (consumed, e.g. by a failed delivery); set directly, the clock is not raced.
    await q('UPDATE verification_challenges SET consumed_at = now() WHERE id = $1', [dead.challengeId]);
    const active = await c1Claim(stores, '+919876500107');
    const accountChallenges = await one('SELECT count(*)::int FROM verification_challenges WHERE user_id IS NOT NULL');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [completion] = await Promise.all([c1Complete(registration, dead, '+919876500106', 'IT-C1-M6'), registration.deleteExpiredClaims(new Date(), 50)]);
    assert.ok(['not_in_progress', 'expired'].includes(completion), completion);
    // SKIP LOCKED may have skipped the claim while the completion held it; cleanup is idempotent.
    await registration.deleteExpiredClaims(new Date(), 50);
    assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-M6'`), 0);
    assert.equal(await one(`SELECT count(*)::int FROM student_registration_claims WHERE id = '${dead.claimId}'`), 0, 'dead claim deleted');
    assert.equal(await one(`SELECT count(*)::int FROM verification_challenges WHERE id = '${dead.challengeId}'`), 0, 'its challenge cascaded');
    assert.equal(await one(`SELECT count(*)::int FROM student_registration_claims WHERE id = '${active.claimId}'`), 1, 'active claim kept');
    assert.equal((await q('SELECT count(*)::int AS n FROM student_registration_claims WHERE id = ANY($1)', [[attacker.claimId, loginTaken.claimId]]))[0].n, 0, 'refused (consumed) claims without a live challenge deleted');
    // A consumed claim whose challenge is still live is never removed.
    const consumedLive = await c1Claim(stores, '+919876500113');
    await q('UPDATE student_registration_claims SET consumed_at = now() WHERE id = $1', [consumedLive.claimId]);
    await registration.deleteExpiredClaims(new Date(), 50);
    assert.equal(await one(`SELECT count(*)::int FROM student_registration_claims WHERE id = '${consumedLive.claimId}'`), 1, 'consumed claim with a live challenge kept');
    assert.equal(await one(`SELECT consumed_at IS NULL FROM verification_challenges WHERE id = '${consumedLive.challengeId}'`), true, 'its live challenge untouched');
    assert.equal(await one('SELECT count(*)::int FROM verification_challenges WHERE user_id IS NOT NULL'), accountChallenges, 'account challenges untouched');
    assert.equal(await registration.deleteExpiredClaims(new Date(), 50) >= 0, true);
    assert.equal(await registration.deleteExpiredClaims(new Date(), 50), 0, 'idempotent: nothing left to delete');

    // 5b. Successful completions racing cleanup: no deadlock (PostgreSQL would raise 40P01), and each
    //     claim ends as a full account with the claim and challenge gone, never partial state.
    for (let round = 0; round < 4; round += 1) {
      const mobile = `+91987650030${round}`;
      const claim = await c1Claim(stores, mobile);
      const [result] = await Promise.all([
        c1Complete(registration, claim, mobile, `IT-C1-CL-${round}`),
        registration.deleteExpiredClaims(new Date(), 50),
        registration.deleteExpiredClaims(new Date(), 50),
      ]);
      assert.equal(result, 'completed', `round ${round}`);
      assert.equal(await one(`SELECT count(*)::int FROM users WHERE login_id = 'IT-C1-CL-${round}'`), 1);
      assert.equal(await one(`SELECT count(*)::int FROM student_registration_claims WHERE id = '${claim.claimId}'`), 0);
      assert.equal(await one(`SELECT count(*)::int FROM verification_challenges WHERE id = '${claim.challengeId}'`), 0);
      assert.equal((await c1Owners(mobile)).length, 1, 'successful registration records its verified mobile');
    }

    // 6. SMS reservations (AUTH C1.1-b): per-bucket destination limits, the unverified 24-hour cap and the
    //    shared 24-hour total hold under parallel requests; events carry bucket and reservation id only.
    const reserve = (overrides: Partial<import('./authVerificationStore.js').SmsSendReservationInput>) => guard.reserveSmsSend({
      reservationId: randomUUID(), destinationKey: 'c1'.repeat(16), bucket: 'unverified', purpose: 'student_registration',
      destinationWindowMs: 3600_000, destinationMaxSends: 3, dailyMaxSends: 1_000_000, dailyMaxUnverifiedSends: 1_000_000, ...overrides,
    });
    const burst = await Promise.all(Array.from({ length: 10 }, () => reserve({})));
    assert.equal(burst.filter((r) => r === 'reserved').length, 3, 'unverified destination limit');
    assert.ok(burst.filter((r) => r !== 'reserved').every((r) => r === 'destination_limited'));
    // The same number's verified allowance is separate: unverified traffic did not use it up.
    const verifiedBurst = await Promise.all(Array.from({ length: 10 }, () => reserve({ bucket: 'verified', purpose: 'student_login' })));
    assert.equal(verifiedBurst.filter((r) => r === 'reserved').length, 3, 'verified destination limit, independent of the unverified one');
    // Mixed unverified purposes to one number share one allowance (no purpose switching).
    const purposes = ['student_registration', 'student_mobile_capture', 'institute_mobile'] as const;
    const mixed = await Promise.all(Array.from({ length: 9 }, (_, i) => reserve({ destinationKey: 'c2'.repeat(16), purpose: purposes[i % 3], destinationMaxSends: 2 })));
    assert.equal(mixed.filter((r) => r === 'reserved').length, 2, 'cross-purpose: one unverified allowance');
    // C-1 account bucket: its own (account, number) key and limit; unaffected by the exhausted anonymous
    // allowance of the same number; counted in the shared total but never in the anonymous cap.
    const accountKey = 'a1'.repeat(16);
    const accountBurst = await Promise.all(Array.from({ length: 8 }, () => reserve({ bucket: 'account', purpose: 'institute_mobile', destinationKey: accountKey, destinationMaxSends: 2 })));
    assert.equal(accountBurst.filter((r) => r === 'reserved').length, 2, 'account destination limit under parallel requests');
    assert.equal(await guard.smsDestinationUsage({ destinationKey: accountKey, bucket: 'account', windowMs: 3600_000 }), 2, 'advisory per-destination usage matches');
    assert.equal(await guard.smsDestinationUsage({ destinationKey: accountKey, bucket: 'unverified', windowMs: 3600_000 }), 0, 'buckets are counted separately');
    const before = await guard.smsUsageLast24h();
    const anonymousCapFull = { dailyMaxSends: 1_000_000, dailyMaxUnverifiedSends: before.unverified };
    assert.equal(await reserve({ ...anonymousCapFull, destinationKey: 'a2'.repeat(16) }), 'unverified_daily_limited', 'the anonymous cap is full');
    assert.equal(await reserve({ ...anonymousCapFull, bucket: 'account', purpose: 'institute_mobile', destinationKey: 'a3'.repeat(16) }), 'reserved', 'account sends ignore the anonymous cap');
    assert.deepEqual(await guard.smsUsageLast24h(), { total: before.total + 1, unverified: before.unverified }, 'the account send counts in the total only');
    assert.equal(await reserve({ dailyMaxSends: before.total + 1, bucket: 'account', purpose: 'institute_mobile', destinationKey: 'a4'.repeat(16) }), 'daily_limited', 'the shared total binds account sends');
    // Unverified cap keeps headroom for sign-in; the shared total counts both buckets.
    const usage = await guard.smsUsageLast24h();
    const caps = { dailyMaxSends: usage.total + 4, dailyMaxUnverifiedSends: usage.unverified + 2 };
    const contested = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 === 0
      ? reserve({ ...caps, destinationKey: `u${i}`.padEnd(32, 'u') })
      : reserve({ ...caps, bucket: 'verified', purpose: 'student_login', destinationKey: `v${i}`.padEnd(32, 'v') })).then((result) => [i % 2 === 0 ? 'unverified' : 'verified', result] as const)));
    const won = (bucket: string) => contested.filter(([b, r]) => b === bucket && r === 'reserved').length;
    assert.ok(won('unverified') <= 2, `unverified cap held (${won('unverified')})`);
    assert.equal(won('unverified') + won('verified'), 4, 'the shared total is filled exactly, never exceeded');
    assert.ok(won('verified') >= 2, 'sign-in keeps the headroom the unverified cap leaves');
    assert.ok(contested.filter(([b, r]) => b === 'unverified' && r !== 'reserved').every(([, r]) => r === 'unverified_daily_limited' || r === 'daily_limited'));
    assert.deepEqual(await guard.smsUsageLast24h(), { total: usage.total + 4, unverified: usage.unverified + won('unverified') }, 'advisory usage reads the same accounting');
    // Accounting: reservation id is the event id; clock_timestamp() times are distinct under serialization;
    // refusals carry reason and bucket but no destination; no phone numbers anywhere.
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action = 'sms.send_reserved' AND details->>'reservationId' IS DISTINCT FROM id`), 0);
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action = 'sms.send_reserved' AND details->>'bucket' IS NULL`), 0, 'every new reservation has a bucket');
    assert.equal(await one(`SELECT count(*) - count(DISTINCT occurred_at) FROM (SELECT occurred_at FROM auth_verification_events WHERE action = 'sms.send_reserved') e`), '0', 'reservation times are distinct (clock_timestamp)');
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action = 'sms.send_refused' AND (details ? 'destinationKey' OR NOT details ? 'reason' OR NOT details ? 'bucket')`), 0);
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action LIKE 'sms.%' AND details::text LIKE '%+91%'`), 0, 'no phone numbers in SMS accounting');
  } finally {
    await end();
    // Remove synthetic rows (FK order). Append-only audit events cannot be deleted and stay in this disposable database.
    await q(`DELETE FROM auth_session_verifications WHERE token_hash LIKE 'it-c1-%'`);
    await q(`DELETE FROM auth_sessions WHERE token_hash LIKE 'it-c1-%'`);
    await q(`DELETE FROM account_contacts WHERE user_id LIKE 'it-c1-%'`);
    await q(`DELETE FROM verification_challenges WHERE id LIKE 'it-c1-%'`);
    await q(`DELETE FROM student_registration_claims WHERE id LIKE 'it-c1-%'`);
    await q(`DELETE FROM users WHERE id LIKE 'it-c1-%'`);
  }
  for (const table of ['users', 'student_registration_claims', 'verification_challenges', 'account_contacts', 'auth_sessions']) {
    assert.equal(await one(`SELECT count(*)::int FROM ${table} WHERE ${table === 'auth_sessions' ? 'token_hash' : table === 'account_contacts' ? 'user_id' : 'id'} LIKE 'it-c1-%'`), 0, `no synthetic ${table} rows persist`);
  }
});

// ---------------------------------------------------------------------------
// AUTH C1.4-B-3.2: email reservations against real PostgreSQL (as eltnoy_app), and the real deliverCode
// path end to end with a local ContractTestAdapter (no provider, no network, no real email).
// Synthetic ids start with 'it-c14b-'; append-only events stay in this disposable database.
// ---------------------------------------------------------------------------

test('AUTH C1.4-B-3: email reservations: per-address and account limits, daily total and cap, separation from SMS, as eltnoy_app', { skip }, async () => {
  const storeModule = await import('./authVerificationStore.js');
  const { db, storeDb, end } = appDatabase();
  const email = storeModule.createPostgresEmailSendGuardStore(storeDb);
  const sms = storeModule.createPostgresSmsSendGuardStore(storeDb);
  try {
    assert.equal((await db.query('SELECT current_user AS u')).rows[0].u, 'eltnoy_app');
    const reserve = (overrides: Partial<import('./authVerificationStore.js').EmailSendReservationInput>) => email.reserveEmailSend({
      reservationId: randomUUID(), destinationKey: 'e1'.repeat(16), bucket: 'unverified', purpose: 'institute_email',
      destinationWindowMs: 3600_000, destinationMaxSends: 3, dailyMaxSends: 1_000_000, dailyMaxUnverifiedSends: 1_000_000, ...overrides,
    });
    const smsBefore = await sms.smsUsageLast24h();

    // Concurrent reservations to one address: exactly the destination limit (anonymous sharing: the
    // address key is the same whichever pending account triggers the send).
    const burst = await Promise.all(Array.from({ length: 10 }, () => reserve({})));
    assert.equal(burst.filter((r) => r === 'reserved').length, 3);
    assert.ok(burst.filter((r) => r !== 'reserved').every((r) => r === 'destination_limited'));
    assert.equal(await email.emailDestinationUsage({ destinationKey: 'e1'.repeat(16), bucket: 'unverified', windowMs: 3600_000 }), 3);

    // Account bucket: its own (account, address) key and limit; untouched by the exhausted anonymous key.
    const account = await Promise.all(Array.from({ length: 8 }, () => reserve({ bucket: 'account', destinationKey: 'a1'.repeat(16), destinationMaxSends: 2 })));
    assert.equal(account.filter((r) => r === 'reserved').length, 2);
    assert.equal(await email.emailDestinationUsage({ destinationKey: 'a1'.repeat(16), bucket: 'unverified', windowMs: 3600_000 }), 0, 'buckets counted separately');

    // Different addresses are independent.
    const distinct = await Promise.all(Array.from({ length: 5 }, (_, i) => reserve({ destinationKey: `d${i}`.padEnd(32, 'd'), destinationMaxSends: 1 })));
    assert.deepEqual(distinct, Array(5).fill('reserved'));

    // Unverified cap keeps account headroom; the email total counts both buckets and is never exceeded.
    const usage = await email.emailUsageLast24h();
    const caps = { dailyMaxSends: usage.total + 4, dailyMaxUnverifiedSends: usage.unverified + 2 };
    const contested = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 === 0
      ? reserve({ ...caps, destinationKey: `u${i}`.padEnd(32, 'u') })
      : reserve({ ...caps, bucket: 'account', destinationKey: `c${i}`.padEnd(32, 'c') })).then((result) => [i % 2 === 0 ? 'unverified' : 'account', result] as const)));
    const won = (bucket: string) => contested.filter(([b, r]) => b === bucket && r === 'reserved').length;
    assert.ok(won('unverified') <= 2, 'unverified cap held');
    assert.equal(won('unverified') + won('account'), 4, 'email total filled exactly, never exceeded');
    assert.ok(won('account') >= 2, 'account headroom kept');

    // Separation: email never counts towards SMS usage, SMS never towards email.
    assert.deepEqual(await sms.smsUsageLast24h(), smsBefore, 'SMS accounting unchanged by email reservations');
    const emailNow = await email.emailUsageLast24h();
    await sms.reserveSmsSend({ reservationId: randomUUID(), destinationKey: 's1'.repeat(16), bucket: 'unverified', purpose: 'student_registration', destinationWindowMs: 3600_000, destinationMaxSends: 5, dailyMaxSends: 1_000_000, dailyMaxUnverifiedSends: 1_000_000 });
    assert.deepEqual(await email.emailUsageLast24h(), emailNow, 'email accounting unchanged by an SMS reservation');

    // Accounting shape: reservation id is the event id; keyed hashes only; no address anywhere.
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action = 'email.send_reserved' AND details->>'reservationId' IS DISTINCT FROM id`), 0);
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action LIKE 'email.%' AND details::text LIKE '%@%'`), 0, 'no address in email accounting');
    // Permissions: no new grant was needed (the events table keeps SELECT/INSERT only for eltnoy_app).
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      assert.equal(await one(`SELECT has_table_privilege('eltnoy_app', 'public.auth_verification_events', '${privilege}')`), false, privilege);
    }
  } finally {
    await end();
  }
});

test('AUTH C1.4-B-3: end-to-end deliverCode with real PostgreSQL stores: reserve first, correlationId = reservation id, failures count and invalidate', { skip }, async () => {
  const storeModule = await import('./authVerificationStore.js');
  const verification = await import('./authVerification.js');
  const providers = await import('./verificationProviders.js');
  const support = await import('./authTestSupport.js');
  const { storeDb, end } = appDatabase();
  const userId = 'it-c14b-inst-1';
  await q(`INSERT INTO users (id, login_id, display_name, role, password_hash, account_status) VALUES ($1, 'IT-C14B-INST-1', 'IT Institute', 'center', '!synthetic', 'pending')`, [userId]);
  const fakeResponse = { append: () => undefined, set: () => undefined } as never;
  const smsEventsBefore = Number(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action LIKE 'sms.%'`));
  try {
    // No real provider is registered in this build (the registry is empty).
    assert.equal(providers.resolveVerificationServices({ AUTH_EMAIL_PROVIDER: 'any-vendor' }).email, null);
    verification.configureAuthVerificationStore(storeModule.createPostgresAuthVerificationStore(storeDb));
    verification.configureEmailSendGuardStore(storeModule.createPostgresEmailSendGuardStore(storeDb));
    verification.configureAbuseProtection(support.testAbuseProtection());
    const seen: Array<{ correlationId: string; reservedBeforeDelivery: number }> = [];
    let behaviour: 'fail' | 'succeed' = 'fail';
    const adapter = {
      name: 'it-local-contract-adapter',
      async sendVerificationCode(request: import('./verificationProviders.js').EmailDeliveryRequest) {
        // The reservation must already be committed when the adapter is called.
        const reserved = Number(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action = 'email.send_reserved' AND id = '${request.correlationId}'`));
        seen.push({ correlationId: request.correlationId, reservedBeforeDelivery: reserved });
        if (behaviour === 'fail') throw new providers.ProviderDeliveryError('provider_unavailable');
      },
    };
    providers.configureVerificationServices(support.testServices({ email: adapter }));

    // Failure: 503, reservation consumed, challenge invalidated, category recorded.
    await assert.rejects(
      verification.startVerification(fakeResponse, { purpose: 'institute_email', userId, channel: 'email', destination: 'it-c14b@example.test' }),
      (error: unknown) => (error as { status?: number; code?: string }).status === 503 && (error as { code?: string }).code === 'PROVIDER_DELIVERY_FAILED',
    );
    assert.equal(seen.length, 1, 'exactly one adapter call (no retry)');
    assert.equal(seen[0].reservedBeforeDelivery, 1, 'reservation committed before provider delivery');
    const reservation = (await q(`SELECT details FROM auth_verification_events WHERE action = 'email.send_reserved' AND id = $1`, [seen[0].correlationId]))[0];
    assert.deepEqual([reservation.details.bucket, reservation.details.purpose, reservation.details.reservationId], ['unverified', 'institute_email', seen[0].correlationId], 'pending Institute: anonymous bucket; correlationId = reservation id');
    const failed = (await q(`SELECT details FROM auth_verification_events WHERE action = 'verification.delivery_failed' AND details->>'correlationId' = $1`, [seen[0].correlationId]))[0];
    assert.deepEqual(failed.details, { channel: 'email', correlationId: seen[0].correlationId, failure: 'provider_unavailable' });
    assert.equal(await one(`SELECT count(*)::int FROM verification_challenges WHERE user_id = '${userId}' AND consumed_at IS NULL`), 0, 'the failed challenge is invalidated');

    // Success: a new attempt gets a new reservation; code_sent carries it.
    behaviour = 'succeed';
    await verification.startVerification(fakeResponse, { purpose: 'institute_email', userId, channel: 'email', destination: 'it-c14b@example.test' });
    assert.equal(seen.length, 2);
    assert.notEqual(seen[1].correlationId, seen[0].correlationId, 'fresh reservation per attempt');
    assert.equal(seen[1].reservedBeforeDelivery, 1);
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action = 'verification.code_sent' AND details->>'correlationId' = '${seen[1].correlationId}'`), 1);
    assert.equal(await one(`SELECT count(*)::int FROM verification_challenges WHERE user_id = '${userId}' AND consumed_at IS NULL`), 1, 'the successful challenge stays usable');

    // SMS accounting untouched; no address or code in any event of this test.
    assert.equal(Number(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action LIKE 'sms.%'`)), smsEventsBefore);
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE details::text LIKE '%it-c14b@example.test%'`), 0);
  } finally {
    providers.configureVerificationServices(providers.DISABLED_SERVICES);
    verification.configureAbuseProtection(undefined);
    await end();
    await q(`DELETE FROM verification_challenges WHERE user_id LIKE 'it-c14b-%'`);
    await q(`DELETE FROM users WHERE id LIKE 'it-c14b-%'`);
  }
  assert.equal(await one(`SELECT count(*)::int FROM users WHERE id LIKE 'it-c14b-%'`), 0, 'no synthetic account persists');
});

// ---------------------------------------------------------------------------
// AUTH C1.8, MFA Phase 2 (adminMfaMigration.sql): grants, constraints, single-use state, insert-only
// evidence, reset-request rules and concurrency, as eltnoy_app (and as the owner, to show the triggers
// bind every role). Synthetic accounts only. Scenario tests run inside one rolled-back transaction; the
// concurrency test commits rows and removes them afterwards as the superuser, with triggers suspended
// (session_replication_role = replica), because the MFA tables refuse DELETE for every other role.
// ---------------------------------------------------------------------------

/** Synthetic accounts, each with a live session (`s-${p}x`):
 * - ENROLLED: four Super Admins (sa1..sa4) and two ordinary Officials (off, off2), each with a confirmed TOTP
 *   factor (`f-${p}x`) and login evidence (`v-${p}x`);
 * - NEVER ENROLLED (AUTH C1.8.4, first-time tickets): ordinary Officials new1..new3 and a Super Admin nsa,
 *   with no factor at all;
 * - a Candidate. */
const MFA_ENROLLED = ['sa1', 'sa2', 'sa3', 'sa4', 'off', 'off2'];
const mfaSeed = (p: string) => `
  INSERT INTO users (id, login_id, display_name, role, password_hash, is_super_admin) VALUES
    ('${p}sa1', upper('${p}sa1'), 'IT MFA', 'official', '!synthetic', true),
    ('${p}sa2', upper('${p}sa2'), 'IT MFA', 'official', '!synthetic', true),
    ('${p}sa3', upper('${p}sa3'), 'IT MFA', 'official', '!synthetic', true),
    ('${p}sa4', upper('${p}sa4'), 'IT MFA', 'official', '!synthetic', true),
    ('${p}off', upper('${p}off'), 'IT MFA', 'official', '!synthetic', false),
    ('${p}off2', upper('${p}off2'), 'IT MFA', 'official', '!synthetic', false),
    ('${p}new1', upper('${p}new1'), 'IT MFA', 'official', '!synthetic', false),
    ('${p}new2', upper('${p}new2'), 'IT MFA', 'official', '!synthetic', false),
    ('${p}new3', upper('${p}new3'), 'IT MFA', 'official', '!synthetic', false),
    ('${p}nsa', upper('${p}nsa'), 'IT MFA', 'official', '!synthetic', true),
    ('${p}cand', upper('${p}cand'), 'IT MFA', 'candidate', '!synthetic', false);
  INSERT INTO auth_sessions (token_hash, user_id, expires_at) SELECT 's-' || id, id, now() + interval '1 hour' FROM users WHERE id LIKE '${p}%';
  SET LOCAL session_replication_role = 'replica';
  WITH enrolled AS (
    SELECT id FROM users WHERE id IN (${MFA_ENROLLED.map((x) => `'${p}${x}'`).join(', ')})
  ), tickets AS (
    INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, expires_at)
    SELECT md5('seed-ticket-a:' || id) || md5('seed-ticket-b:' || id), id, NULL, 'bootstrap_cli', now() + interval '1 hour'
      FROM enrolled RETURNING id, user_id
  ), challenges AS (
    INSERT INTO admin_mfa_challenges (id, user_id, purpose, enrolment_ticket_id, expires_at)
    SELECT md5('seed-challenge-a:' || user_id) || md5('seed-challenge-b:' || user_id), user_id, 'enrol', id, now() + interval '5 minutes'
      FROM tickets RETURNING id, user_id
  )
  INSERT INTO admin_mfa_factors (id, user_id, enrolment_challenge_id, kind, secret_ciphertext, secret_nonce, secret_tag, key_version)
    SELECT 'f-' || c.user_id, c.user_id, c.id, 'totp', decode(repeat('11', 20), 'hex'), decode(repeat('22', 12), 'hex'), decode(repeat('33', 16), 'hex'), 1
      FROM challenges c;
  UPDATE admin_mfa_factors SET confirmed_at = now() WHERE user_id LIKE '${p}%';
  UPDATE admin_mfa_enrolment_tickets SET used_at = now() WHERE user_id LIKE '${p}%';
  UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'verified' WHERE user_id LIKE '${p}%' AND purpose = 'enrol';
  SET LOCAL session_replication_role = 'origin';
  INSERT INTO auth_session_mfa_verifications (id, token_hash, user_id, purpose, method, factor_id)
    SELECT 'v-' || id, 's-' || id, id, 'login', 'totp', 'f-' || id FROM users WHERE id IN (${MFA_ENROLLED.map((x) => `'${p}${x}'`).join(', ')});`;

async function seedCommittedMfa(prefix: string): Promise<void> {
  await q('BEGIN');
  try {
    await q(mfaSeed(prefix));
    await q('COMMIT');
  } catch (error) {
    await q('ROLLBACK');
    throw error;
  }
}
const P = 'it-mfa-';
const hex = (c: string) => c.repeat(64);

interface MfaStep {
  ok(sql: string, role?: string): Promise<Record<string, unknown>[]>;
  fails(sql: string, pattern: RegExp, role?: string): Promise<void>;
  su(sql: string): Promise<Record<string, unknown>[]>;
}

/**
 * Seeds `mfaSeed(P)` (unless `seed: false`) plus `extra` as the superuser, runs `body`, then rolls everything
 * back. Deferred (commit-time) checks never fire on their own here, because nothing commits: a test that needs
 * them runs `SET CONSTRAINTS ALL IMMEDIATE` (see `atCommit`), which fires every queued check of the transaction.
 */
async function seedEnrolmentFixture(su: MfaStep['su'], userId: string, ticketId: string, challengeId: string): Promise<void> {
  await su("SET LOCAL session_replication_role = 'replica'");
  await su(`INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, expires_at)
    VALUES ('${ticketId}', '${userId}', NULL, 'bootstrap_cli', now() + interval '30 minutes')`);
  await su(`INSERT INTO admin_mfa_challenges (id, user_id, purpose, enrolment_ticket_id, expires_at)
    VALUES ('${challengeId}', '${userId}', 'enrol', '${ticketId}', now() + interval '5 minutes')`);
  await su("SET LOCAL session_replication_role = 'origin'");
}

async function mfaScenario(extra: string, body: (step: MfaStep) => Promise<void>, options: { seed?: boolean } = {}): Promise<void> {
  let n = 0;
  await q('BEGIN');
  try {
    await q((options.seed === false ? '' : mfaSeed(P)) + extra);
    const run = async (sql: string, role: string) => {
      await q(`SET LOCAL ROLE ${role}`);
      const rows = await q(sql);
      await q('RESET ROLE');
      return rows;
    };
    await body({
      ok: async (sql, role = 'eltnoy_app') => {
        const name = `mfa_${(n += 1)}`;
        await q(`SAVEPOINT ${name}`);
        try {
          const rows = await run(sql, role);
          await q(`RELEASE SAVEPOINT ${name}`);
          return rows;
        } catch (error) {
          await q(`ROLLBACK TO SAVEPOINT ${name}`);
          throw new Error(`expected success as ${role}: ${sql.slice(0, 160)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      fails: async (sql, pattern, role = 'eltnoy_app') => {
        const name = `mfa_${(n += 1)}`;
        await q(`SAVEPOINT ${name}`);
        let message: string | null = null;
        try { await run(sql, role); } catch (error) { message = error instanceof Error ? error.message : String(error); }
        await q(message === null ? `RELEASE SAVEPOINT ${name}` : `ROLLBACK TO SAVEPOINT ${name}`); // ROLLBACK TO also undoes SET LOCAL ROLE
        assert.match(message ?? 'succeeded', pattern, `as ${role}: ${sql.slice(0, 160)}`);
      },
      su: (sql) => q(sql),
    });
  } finally {
    await q('ROLLBACK');
  }
}

test('AUTH C1.8: the six MFA tables carry exactly the manifest grants; no DELETE or TRUNCATE for anyone', { skip }, async () => {
  for (const [table, expected] of Object.entries(MFA_GRANTS)) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(await one(`SELECT has_table_privilege('eltnoy_app', 'public.${table}', '${privilege}')`), expected.privileges.includes(privilege), `${table} ${privilege}`);
    }
    const granted = (await q(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'eltnoy_app' AND table_name = $1 AND privilege_type = 'UPDATE'`, [table]))
      .map((r) => String(r.column_name)).sort();
    assert.deepEqual(granted, [...expected.updateColumns].sort(), `${table}: column-level UPDATE is exactly the manifest list`);
  }
  await mfaScenario('', async ({ fails }) => {
    for (const table of Object.keys(MFA_GRANTS)) {
      await fails(`DELETE FROM ${table}`, /permission denied/);
      await fails(`TRUNCATE ${table}`, /permission denied/);
      await fails(`TRUNCATE ${table} CASCADE`, /cannot be truncated|insert-only/, 'eltnoy_owner');
    }
    // Even the owner cannot delete MFA rows: the triggers refuse every role.
    await fails(`DELETE FROM admin_mfa_factors WHERE user_id = '${P}sa1'`, /admin MFA factors cannot be deleted/, 'eltnoy_owner');
    await fails(`DELETE FROM auth_session_mfa_verifications WHERE user_id = '${P}sa1'`, /insert-only/, 'eltnoy_owner');
    // Identity, secret and evidence columns are not updatable by the API role.
    for (const sql of [
      `UPDATE admin_mfa_factors SET secret_ciphertext = secret_ciphertext WHERE false`,
      `UPDATE admin_mfa_factors SET key_version = 2 WHERE false`,
      `UPDATE admin_mfa_factors SET user_id = 'x' WHERE false`,
      `UPDATE admin_mfa_recovery_codes SET code_hash = 'x' WHERE false`,
      `UPDATE admin_mfa_challenges SET expires_at = now() WHERE false`,
      `UPDATE admin_mfa_enrolment_tickets SET expires_at = now() WHERE false`,
      `UPDATE admin_mfa_reset_requests SET decided_at = now() WHERE false`,
      `UPDATE admin_mfa_reset_requests SET initiated_by = 'x' WHERE false`,
      `UPDATE auth_session_mfa_verifications SET verified_at = now() WHERE false`,
    ]) await fails(sql, /permission denied/);
  });
});

test('AUTH C1.8: factors: one active per user and kind, Officials only, encrypted envelope shape, atomic replay guard, terminal disable', { skip }, async () => {
  const factor = (id: string, user: string, challengeId: string, confirmedAt = '') => `INSERT INTO admin_mfa_factors (id, user_id, enrolment_challenge_id, kind, secret_ciphertext, secret_nonce, secret_tag, key_version${confirmedAt ? ', confirmed_at' : ''})
    VALUES ('${id}', '${user}', '${challengeId}', 'totp', decode(repeat('11', 20), 'hex'), decode(repeat('22', 12), 'hex'), decode(repeat('33', 16), 'hex'), 1${confirmedAt ? `, ${confirmedAt}` : ''})`;
  await mfaScenario('', async ({ ok, fails, su }) => {
    await seedEnrolmentFixture(su, `${P}sa1`, hex('a'), hex('b'));
    await seedEnrolmentFixture(su, `${P}cand`, hex('c'), hex('d'));
    await seedEnrolmentFixture(su, `${P}sa2`, hex('e'), hex('f'));
    await seedEnrolmentFixture(su, `${P}off`, hex('1'), hex('2'));
    await fails(factor('it-f-dup', `${P}sa1`, hex('b')), /admin_mfa_factors_one_active_idx/);
    await fails(factor('it-f-cand', `${P}cand`, hex('d')), /for Officials only/);
    await fails(factor('it-f-conf', `${P}sa2`, hex('f'), 'now()'), /starts unconfirmed/);
    await fails(`INSERT INTO admin_mfa_factors (id, user_id, enrolment_challenge_id, kind, secret_ciphertext, secret_nonce, secret_tag, key_version)
      VALUES ('it-f-shape', '${P}off', '${hex('2')}', 'totp', decode('aa', 'hex'), decode(repeat('22', 12), 'hex'), decode(repeat('33', 16), 'hex'), 1)`, /admin_mfa_factors_secret_shape_check|admin_mfa_factors_one_active_idx/);

    // Replay guard: the conditional update succeeds once per step and never for an older step.
    const guard = (step: number) => `UPDATE admin_mfa_factors SET last_used_step = ${step} WHERE id = 'f-${P}sa1' AND disabled_at IS NULL AND confirmed_at IS NOT NULL AND last_used_step < ${step} RETURNING id`;
    assert.equal((await ok(guard(1000))).length, 1, 'first use of step 1000');
    assert.equal((await ok(guard(1000))).length, 0, 'replay of step 1000');
    assert.equal((await ok(guard(999))).length, 0, 'an older step');
    assert.equal((await ok(guard(1001))).length, 1, 'a later step');
    await fails(`UPDATE admin_mfa_factors SET last_used_step = 5 WHERE id = 'f-${P}sa1'`, /can only increase/);
    await fails(`UPDATE admin_mfa_factors SET confirmed_at = now() WHERE id = 'f-${P}sa1'`, /confirmed_at is set once/);

    // Disable (reset): consistent columns, then terminal; a new factor may then be enrolled.
    await fails(`UPDATE admin_mfa_factors SET disabled_at = now() WHERE id = 'f-${P}sa3'`, /admin_mfa_factors_disabled_pair_check/);
    await ok(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${P}sa2', disabled_via = 'two_person_reset' WHERE id = 'f-${P}sa3'`);
    await fails(`UPDATE admin_mfa_factors SET last_used_step = 99999 WHERE id = 'f-${P}sa3'`, /disabled admin MFA factor cannot change/);
    await fails(`UPDATE admin_mfa_factors SET disabled_at = NULL, disabled_via = NULL, disabled_by = NULL WHERE id = 'f-${P}sa3'`, /disabled admin MFA factor cannot change/, 'eltnoy_owner');
    await ok(factor('it-f-new', `${P}sa3`, hex('b')));
    assert.equal((await ok(`UPDATE admin_mfa_factors SET last_used_step = 1 WHERE id = 'f-${P}sa3' AND disabled_at IS NULL AND last_used_step < 1 RETURNING id`)).length, 0, 'the disabled factor no longer verifies');
  });
});

test('AUTH C1.8: recovery codes: hashed only, bound to the owner\'s factor, single use, revocation final', { skip }, async () => {
  const code = (id: string, user: string, factorId: string, hash: string) =>
    `INSERT INTO admin_mfa_recovery_codes (id, user_id, factor_id, code_hash) VALUES ('${id}', '${user}', '${factorId}', '${hash}')`;
  await mfaScenario('', async ({ ok, fails }) => {
    await ok(code('it-rc-1', `${P}sa1`, `f-${P}sa1`, hex('a')));
    await ok(code('it-rc-2', `${P}sa1`, `f-${P}sa1`, hex('b')));
    await fails(code('it-rc-plain', `${P}sa1`, `f-${P}sa1`, 'ABCDEFGH234567AB'), /admin_mfa_recovery_codes_hash_check/);
    await fails(code('it-rc-dup', `${P}sa2`, `f-${P}sa2`, hex('a')), /duplicate key/);
    await fails(code('it-rc-other', `${P}sa1`, `f-${P}sa2`, hex('c')), /foreign key/);
    await fails(`INSERT INTO admin_mfa_recovery_codes (id, user_id, factor_id, code_hash, used_at) VALUES ('it-rc-used', '${P}sa1', 'f-${P}sa1', '${hex('d')}', now())`, /starts unused/);
    const use = (id: string) => `UPDATE admin_mfa_recovery_codes SET used_at = now() WHERE id = '${id}' AND used_at IS NULL AND revoked_at IS NULL RETURNING id`;
    assert.equal((await ok(use('it-rc-1'))).length, 1, 'first use');
    assert.equal((await ok(use('it-rc-1'))).length, 0, 'second use');
    await fails(`UPDATE admin_mfa_recovery_codes SET revoked_at = now() WHERE id = 'it-rc-1'`, /used or revoked recovery code cannot change/);
    await ok(`UPDATE admin_mfa_recovery_codes SET revoked_at = now() WHERE user_id = '${P}sa1' AND used_at IS NULL AND revoked_at IS NULL`);
    assert.equal((await ok(use('it-rc-2'))).length, 0, 'a revoked code cannot be used');
    await fails(`UPDATE admin_mfa_recovery_codes SET used_at = now() WHERE id = 'it-rc-2'`, /used or revoked recovery code cannot change/);
  });
});

test('AUTH C1.8: challenges and tickets: hashed ids, single use, expiry, step-up bound to the user\'s live session', { skip }, async () => {
  const ticket = (id: string, user: string, issuer: string | null, via: string, expires = "now() + interval '30 minutes'") =>
    `INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, expires_at) VALUES ('${id}', '${user}', ${issuer ? `'${issuer}'` : 'NULL'}, '${via}', ${expires})`;
  const challenge = (id: string, user: string, purpose: string, session: string | null, expires = "now() + interval '5 minutes'") =>
    `INSERT INTO admin_mfa_challenges (id, user_id, purpose, session_token_hash, expires_at) VALUES ('${id}', '${user}', '${purpose}', ${session ? `'${session}'` : 'NULL'}, ${expires})`;
  await mfaScenario('', async ({ ok, fails, su }) => {
    // Tickets (first-time tickets go to never-enrolled Officials: AUTH C1.8.4)
    await ok(ticket(hex('1'), `${P}new1`, `${P}sa1`, 'super_admin'));
    await fails(ticket(hex('2'), `${P}new1`, `${P}sa1`, 'super_admin'), /admin_mfa_enrolment_tickets_one_open_idx/);
    await fails(ticket(hex('3'), `${P}cand`, `${P}sa1`, 'super_admin'), /for Officials only/);
    // Self-issue: a first-time ticket to oneself is refused because the issuer is enrolled; the
    // admin_mfa_enrolment_tickets_not_self_check path is exercised with a reset ticket in the F1 test.
    await fails(ticket(hex('4'), `${P}sa1`, `${P}sa1`, 'super_admin'), /enrolled before: replacing a factor requires a reset/);
    await fails(ticket('plain-ticket-token', `${P}new2`, `${P}sa1`, 'super_admin'), /admin_mfa_enrolment_tickets_id_check/);
    await fails(ticket(hex('5'), `${P}new2`, `${P}sa1`, 'break_glass'), /admin_mfa_enrolment_tickets_issuer_check/);
    await fails(ticket(hex('6'), `${P}new2`, `${P}sa1`, 'two_person_reset'), /must reference an existing reset request/);
    const useTicket = (id: string) => `UPDATE admin_mfa_enrolment_tickets SET used_at = now() WHERE id = '${id}' AND used_at IS NULL AND revoked_at IS NULL RETURNING id`;
    assert.equal((await ok(useTicket(hex('1')))).length, 1);
    assert.equal((await ok(useTicket(hex('1')))).length, 0, 'single use');
    await fails(`UPDATE admin_mfa_enrolment_tickets SET revoked_at = now() WHERE id = '${hex('1')}'`, /used or revoked enrolment ticket cannot change/);
    await ok(ticket(hex('7'), `${P}new3`, `${P}sa1`, 'super_admin', "clock_timestamp() + interval '50 milliseconds'"));
    await su('SELECT pg_sleep(0.1)');
    await fails(`UPDATE admin_mfa_enrolment_tickets SET used_at = now() WHERE id = '${hex('7')}'`, /expired enrolment ticket cannot be used/);

    // Challenges
    await ok(challenge(hex('a'), `${P}sa1`, 'login', null));
    await fails(challenge('plain-challenge-token', `${P}sa1`, 'login', null), /admin_mfa_challenges_id_check/);
    await fails(challenge(hex('b'), `${P}sa1`, 'step_up', null), /admin_mfa_challenges_session_check/);
    await fails(challenge(hex('b'), `${P}sa1`, 'login', `s-${P}sa1`), /admin_mfa_challenges_session_check/);
    await fails(challenge(hex('b'), `${P}sa1`, 'step_up', `s-${P}sa2`), /live session of the same user/);
    await ok(challenge(hex('b'), `${P}sa1`, 'step_up', `s-${P}sa1`));
    await fails(challenge(hex('c'), `${P}sa1`, 'step_up', `s-${P}sa1`), /admin_mfa_challenges_one_step_up_idx/);
    await su(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = 's-${P}off'`);
    await fails(challenge(hex('c'), `${P}off`, 'step_up', `s-${P}off`), /live session of the same user/);
    const reserve = (id: string) => `UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE id = '${id}' AND consumed_at IS NULL AND attempts < 5 RETURNING attempts`;
    assert.deepEqual(await ok(reserve(hex('a'))), [{ attempts: 1 }]);
    await fails(`UPDATE admin_mfa_challenges SET attempts = attempts + 2 WHERE id = '${hex('a')}'`, /rise one at a time/);
    await fails(`UPDATE admin_mfa_challenges SET attempts = 0 WHERE id = '${hex('a')}'`, /rise one at a time/);
    await fails(`UPDATE admin_mfa_challenges SET consumed_at = now() WHERE id = '${hex('a')}'`, /admin_mfa_challenges_consumed_pair_check/);
    const consume = (id: string) => `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'verified' WHERE id = '${id}' AND consumed_at IS NULL RETURNING id`;
    assert.equal((await ok(consume(hex('a')))).length, 1);
    assert.equal((await ok(consume(hex('a')))).length, 0, 'single use');
    await fails(`UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE id = '${hex('a')}'`, /consumed admin MFA challenge cannot change/);
    // Enrolment ticket binding: only the same user's ticket, only once.
    await ok(challenge(hex('d'), `${P}new2`, 'enrol', null));
    await ok(ticket(hex('8'), `${P}new2`, `${P}sa1`, 'super_admin'));
    await fails(`UPDATE admin_mfa_challenges SET enrolment_ticket_id = '${hex('7')}' WHERE id = '${hex('d')}'`, /foreign key/);
    await ok(`UPDATE admin_mfa_challenges SET enrolment_ticket_id = '${hex('8')}' WHERE id = '${hex('d')}'`);
    await fails(`UPDATE admin_mfa_challenges SET enrolment_ticket_id = NULL WHERE id = '${hex('d')}'`, /bound to a challenge once/);
    // An expired challenge cannot take an attempt or be verified (it may still be closed).
    await ok(challenge(hex('e'), `${P}sa2`, 'login', null, "clock_timestamp() + interval '50 milliseconds'"));
    await su('SELECT pg_sleep(0.1)');
    await fails(reserve(hex('e')), /expired admin MFA challenge cannot be used/);
    await fails(consume(hex('e')), /expired admin MFA challenge cannot be used/);
    await ok(`UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'revoked' WHERE id = '${hex('e')}'`);
  });
});

test('AUTH C1.8: session MFA evidence is insert-only, clock-stamped, TOTP-only for step-up, and tied to a live session and active factor', { skip }, async () => {
  const evidence = (id: string, session: string, user: string, purpose: string, method: string, factorId: string, extra = '') =>
    `INSERT INTO auth_session_mfa_verifications (id, token_hash, user_id, purpose, method, factor_id${extra ? ', verified_at' : ''}) VALUES ('${id}', '${session}', '${user}', '${purpose}', '${method}', '${factorId}'${extra})`;
  await mfaScenario('', async ({ ok, fails, su }) => {
    await ok(evidence('it-ev-1', `s-${P}sa1`, `${P}sa1`, 'step_up', 'totp', `f-${P}sa1`));
    await ok(evidence('it-ev-2', `s-${P}sa1`, `${P}sa1`, 'step_up', 'totp', `f-${P}sa1`));
    assert.equal(await one(`SELECT count(*)::int FROM auth_session_mfa_verifications WHERE token_hash = 's-${P}sa1'`), 3, 'many rows per session (login + two step-ups)');
    await fails(evidence('it-ev-rc', `s-${P}sa1`, `${P}sa1`, 'step_up', 'recovery_code', `f-${P}sa1`), /auth_session_mfa_verifications_totp_only_check/);
    await fails(evidence('it-ev-rc2', `s-${P}sa1`, `${P}sa1`, 'enrol', 'recovery_code', `f-${P}sa1`), /auth_session_mfa_verifications_totp_only_check/);
    await ok(evidence('it-ev-rc3', `s-${P}sa1`, `${P}sa1`, 'login', 'recovery_code', `f-${P}sa1`));
    await fails(evidence('it-ev-x', `s-${P}sa2`, `${P}sa1`, 'step_up', 'totp', `f-${P}sa1`), /live session of the same user/);
    await fails(evidence('it-ev-f', `s-${P}sa1`, `${P}sa1`, 'step_up', 'totp', `f-${P}sa2`), /confirmed, active factor/);
    // The caller cannot backdate or forward-date evidence.
    await ok(evidence('it-ev-date', `s-${P}sa1`, `${P}sa1`, 'step_up', 'totp', `f-${P}sa1`, ", '2999-01-01'"));
    assert.equal(await one(`SELECT verified_at < now() + interval '1 minute' FROM auth_session_mfa_verifications WHERE id = 'it-ev-date'`), true, 'verified_at is the database clock');
    await su(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = 's-${P}sa2'`);
    await fails(evidence('it-ev-rev', `s-${P}sa2`, `${P}sa2`, 'step_up', 'totp', `f-${P}sa2`), /live session of the same user/);
    await su(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_via = 'break_glass' WHERE id = 'f-${P}sa3'`);
    await fails(evidence('it-ev-dis', `s-${P}sa3`, `${P}sa3`, 'step_up', 'totp', `f-${P}sa3`), /confirmed, active factor/);
    await fails(`UPDATE auth_session_mfa_verifications SET purpose = 'step_up' WHERE id = 'it-ev-1'`, /permission denied/);
    await fails(`UPDATE auth_session_mfa_verifications SET purpose = 'step_up' WHERE id = 'it-ev-1'`, /insert-only/, 'eltnoy_owner');
    await fails(`DELETE FROM auth_session_mfa_verifications WHERE id = 'it-ev-1'`, /insert-only/, 'eltnoy_owner');
  });
});

/** A pending reset request by `initiator` for `target`; `evidence` defaults to the initiator's login evidence. */
const resetRequest = (id: string, target: string, initiator: string, mode: string, evidence = `v-${initiator}`, expires = "now() + interval '1 hour'") =>
  `INSERT INTO admin_mfa_reset_requests (id, target_user_id, approval_mode, initiated_by, initiated_verification_id, reason, expires_at)
   VALUES ('${id}', '${target}', '${mode}', '${initiator}', '${evidence}', 'IT synthetic: lost device', ${expires})`;
const resetTicket = (id: string, target: string, issuer: string, via: string, request: string) =>
  `INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, reset_request_id, expires_at) VALUES ('${id}', '${target}', '${issuer}', '${via}', '${request}', now() + interval '30 minutes')`;
const stepUp = (id: string, user: string) =>
  `INSERT INTO auth_session_mfa_verifications (id, token_hash, user_id, purpose, method, factor_id) VALUES ('${id}', 's-${user}', '${user}', 'step_up', 'totp', 'f-${user}')`;
const decide = (id: string, status: string, decider: string, evidence: string, ticket: string | null = null) =>
  `UPDATE admin_mfa_reset_requests SET status = '${status}', decided_by = '${decider}', decided_verification_id = '${evidence}'${ticket ? `, ticket_id = '${ticket}'` : ''} WHERE id = '${id}' AND status = 'pending' RETURNING id`;

/** AUTH C1.8.4: every statement of one complete reset, in the approved order (specification §6.4). */
interface ResetPlan { request: string; target: string; decider: string; mode: 'two_person' | 'single_super_admin'; evidence: string; ticket: string }
const RESET_ORDER = ['factor', 'codes', 'tickets', 'challenges', 'sessions', 'ticket', 'event', 'close'] as const;
type ResetStep = typeof RESET_ORDER[number];
const resetSteps = (r: ResetPlan): Record<ResetStep, string> => {
  const label = r.mode === 'two_person' ? 'two_person_reset' : 'single_approver_reset';
  return {
    factor: `UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${r.decider}', disabled_via = '${label}' WHERE user_id = '${r.target}' AND disabled_at IS NULL`,
    codes: `UPDATE admin_mfa_recovery_codes SET revoked_at = now() WHERE user_id = '${r.target}' AND used_at IS NULL AND revoked_at IS NULL`,
    tickets: `UPDATE admin_mfa_enrolment_tickets SET revoked_at = now() WHERE user_id = '${r.target}' AND used_at IS NULL AND revoked_at IS NULL`,
    challenges: `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'revoked' WHERE user_id = '${r.target}' AND consumed_at IS NULL`,
    sessions: `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = '${r.target}' AND revoked_at IS NULL`,
    ticket: resetTicket(r.ticket, r.target, r.decider, label, r.request),
    event: `INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ('ev-${r.request}-${r.ticket.slice(0, 8)}', 'admin_mfa.reset_executed', '${r.target}', jsonb_build_object('requestId', '${r.request}', 'actorId', '${r.decider}'))`,
    close: decide(r.request, 'executed', r.decider, r.evidence, r.ticket).replace(/ RETURNING id$/, ''),
  };
};
/** The statements of `plan` in order, without the steps listed in `omit`. */
const resetSequence = (plan: ResetPlan, omit: readonly ResetStep[] = []) => RESET_ORDER.filter((step) => !omit.includes(step)).map((step) => resetSteps(plan)[step]);
/** Fires every queued commit-time (deferred) check of the scenario transaction now, as the application role. */
const AT_COMMIT = 'SET CONSTRAINTS ALL IMMEDIATE';
/** State of one account that a reset touches, for before/after comparison. */
const resetFingerprint = (user: string) => `SELECT md5(concat_ws('|',
  (SELECT string_agg(f.id || ':' || coalesce(f.disabled_via, '-'), ',' ORDER BY f.id) FROM admin_mfa_factors f WHERE f.user_id = '${user}'),
  (SELECT string_agg(c.id || ':' || (c.revoked_at IS NULL)::text, ',' ORDER BY c.id) FROM admin_mfa_recovery_codes c WHERE c.user_id = '${user}'),
  (SELECT string_agg(c.id || ':' || coalesce(c.consumed_reason, '-'), ',' ORDER BY c.id) FROM admin_mfa_challenges c WHERE c.user_id = '${user}'),
  (SELECT string_agg(t.id || ':' || (t.revoked_at IS NULL)::text, ',' ORDER BY t.id) FROM admin_mfa_enrolment_tickets t WHERE t.user_id = '${user}'),
  (SELECT string_agg(s.token_hash || ':' || (s.revoked_at IS NULL)::text, ',' ORDER BY s.token_hash) FROM auth_sessions s WHERE s.user_id = '${user}'),
  (SELECT string_agg(r.id || ':' || r.status, ',' ORDER BY r.id) FROM admin_mfa_reset_requests r WHERE r.target_user_id = '${user}'),
  (SELECT count(*)::text FROM auth_verification_events e WHERE e.user_id = '${user}')))`;

test('AUTH C1.8: Super Admin reset: two different Super Admins, fresh approver evidence, no self-approval, finished requests final', { skip }, async () => {
  await mfaScenario('', async ({ ok, fails, su }) => {
    const sa1 = `${P}sa1`; const sa2 = `${P}sa2`; const sa3 = `${P}sa3`;
    // Initiation rules.
    await fails(resetRequest('it-rr-mode', sa3, sa1, 'single_super_admin'), /needs two_person approval/);
    await fails(resetRequest('it-rr-self', sa1, sa1, 'two_person'), /admin_mfa_reset_requests_not_self_target_check/);
    await fails(resetRequest('it-rr-off', sa3, `${P}off`, 'two_person'), /only an approved Super Admin may initiate/);
    await fails(resetRequest('it-rr-cand', `${P}cand`, sa1, 'two_person'), /must be an Official/);
    await fails(resetRequest('it-rr-ev', sa3, sa1, 'two_person', `v-${sa2}`), /initiation requires TOTP evidence from a live session of the initiator/);
    await fails(`INSERT INTO admin_mfa_reset_requests (id, target_user_id, approval_mode, initiated_by, initiated_verification_id, reason, expires_at, status)
      VALUES ('it-rr-exec', '${sa3}', 'two_person', '${sa1}', 'v-${sa1}', 'x', now() + interval '1 hour', 'executed')`, /pending with no decision/);
    await fails(resetRequest('it-rr-blank', sa3, sa1, 'two_person').replace("'IT synthetic: lost device'", "'   '"), /admin_mfa_reset_requests_reason_check/);
    await ok(resetRequest('it-rr-1', sa3, sa1, 'two_person'));
    await fails(resetRequest('it-rr-2', sa3, sa2, 'two_person'), /admin_mfa_reset_requests_one_pending_idx/);

    // The initiator cannot approve, even with fresh evidence: since AUTH C1.8.4 the initiator cannot even
    // issue the reset ticket, and cannot execute with the approver's ticket.
    await ok(stepUp('it-up-sa1', sa1));
    await fails(resetTicket(hex('9'), sa3, sa1, 'two_person_reset', 'it-rr-1'), /issued by the approver, never the initiator/);
    await ok(resetTicket(hex('a'), sa3, sa2, 'two_person_reset', 'it-rr-1'));
    await fails(decide('it-rr-1', 'executed', sa1, 'it-up-sa1', hex('a')), /must name the open enrolment ticket/);
    // A second Super Admin with evidence from BEFORE the request was created is refused.
    await fails(decide('it-rr-1', 'executed', sa2, `v-${sa2}`, hex('a')), /verify TOTP after the reset request was created/);
    // Recovery-code evidence never authorises a decision.
    await su(`INSERT INTO auth_session_mfa_verifications (id, token_hash, user_id, purpose, method, factor_id) VALUES ('it-rc-sa2', 's-${sa2}', '${sa2}', 'login', 'recovery_code', 'f-${sa2}')`);
    await fails(decide('it-rr-1', 'executed', sa2, 'it-rc-sa2', hex('a')), /TOTP evidence from a live session/);
    // Fresh step-up, but no ticket, or the wrong ticket.
    await ok(stepUp('it-up-sa2', sa2));
    await fails(decide('it-rr-1', 'executed', sa2, 'it-up-sa2'), /must name the open enrolment ticket/);
    await fails(decide('it-rr-1', 'executed', sa2, 'it-up-sa2', hex('9')), /must name the open enrolment ticket/);
    // The decider cannot set decided_at (database clock only).
    await fails(`UPDATE admin_mfa_reset_requests SET decided_at = now() WHERE id = 'it-rr-1'`, /permission denied/);
    // Valid approval, then atomic revocation of the target's sessions in the same transaction.
    assert.equal((await ok(decide('it-rr-1', 'executed', sa2, 'it-up-sa2', hex('a')))).length, 1);
    assert.equal(await one(`SELECT decided_at IS NOT NULL AND decided_at >= created_at FROM admin_mfa_reset_requests WHERE id = 'it-rr-1'`), true);
    await ok(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${sa2}', disabled_via = 'two_person_reset' WHERE user_id = '${sa3}' AND disabled_at IS NULL`);
    assert.equal((await ok(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = '${sa3}' AND revoked_at IS NULL RETURNING token_hash`)).length, 1);
    // Finished requests never change, for any role; a duplicate approval finds nothing pending.
    assert.equal((await ok(decide('it-rr-1', 'executed', `${P}sa4`, `v-${P}sa4`, hex('a')))).length, 0, 'duplicate approval');
    await fails(`UPDATE admin_mfa_reset_requests SET decision_reason = 'changed' WHERE id = 'it-rr-1'`, /finished admin MFA reset request cannot change/);
    await fails(`UPDATE admin_mfa_reset_requests SET status = 'rejected' WHERE id = 'it-rr-1'`, /finished admin MFA reset request cannot change/, 'eltnoy_owner');
    await fails(`DELETE FROM admin_mfa_reset_requests WHERE id = 'it-rr-1'`, /cannot be deleted/, 'eltnoy_owner');
    // A new request for the same target is possible once nothing is pending.
    await ok(resetRequest('it-rr-3', sa3, sa1, 'two_person'));
  });
});

test('AUTH C1.8: reset rejection, cancellation, expiry, revoked deciders and initiator re-check', { skip }, async () => {
  await mfaScenario('', async ({ ok, fails, su }) => {
    const sa1 = `${P}sa1`; const sa2 = `${P}sa2`; const sa3 = `${P}sa3`;
    await ok(resetRequest('it-rr-r', sa3, sa1, 'two_person'));
    await fails(decide('it-rr-r', 'rejected', sa1, `v-${sa1}`), /admin_mfa_reset_requests_reject_check/);
    await fails(decide('it-rr-r', 'cancelled', sa2, `v-${sa2}`), /admin_mfa_reset_requests_cancel_check/);
    await fails(decide('it-rr-r', 'rejected', `${P}off2`, `v-${P}off2`), /only an approved Super Admin may decide/);
    await fails(decide('it-rr-r', 'rejected', sa3, `v-${sa3}`), /admin_mfa_reset_requests_decider_not_target_check/);
    await fails(`UPDATE admin_mfa_reset_requests SET status = 'expired' WHERE id = 'it-rr-r'`, /has not expired/);
    assert.equal((await ok(decide('it-rr-r', 'cancelled', sa1, `v-${sa1}`))).length, 1, 'the initiator cancels');
    await ok(resetRequest('it-rr-r2', sa3, sa1, 'two_person'));
    assert.equal((await ok(decide('it-rr-r2', 'rejected', sa2, `v-${sa2}`))).length, 1, 'another Super Admin rejects');
    // A decider whose session was revoked has no live evidence.
    await ok(resetRequest('it-rr-rev', sa3, sa1, 'two_person'));
    await ok(stepUp('it-up2-sa2', sa2));
    await su(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = 's-${sa2}'`);
    await ok(resetTicket(hex('b'), sa3, sa2, 'two_person_reset', 'it-rr-rev'));
    await fails(decide('it-rr-rev', 'executed', sa2, 'it-up2-sa2', hex('b')), /TOTP evidence from a live session/);
    // An initiator demoted before approval invalidates the request.
    await ok(stepUp('it-up-sa4', `${P}sa4`));
    await su(`UPDATE users SET is_super_admin = false WHERE id = '${sa1}'`);
    await ok(`UPDATE admin_mfa_enrolment_tickets SET revoked_at = now() WHERE id = '${hex('b')}'`);
    await ok(resetTicket(hex('c'), sa3, `${P}sa4`, 'two_person_reset', 'it-rr-rev'));
    await fails(decide('it-rr-rev', 'executed', `${P}sa4`, 'it-up-sa4', hex('c')), /initiator is no longer an approved Super Admin/);
    await su(`UPDATE users SET is_super_admin = true WHERE id = '${sa1}'`);
    // Expiry: no decision after expiry; only 'expired' closes it; superseded (break-glass) is final too.
    await ok(resetRequest('it-rr-exp', `${P}off`, sa1, 'single_super_admin', `v-${sa1}`, "clock_timestamp() + interval '50 milliseconds'"));
    await su('SELECT pg_sleep(0.1)');
    await fails(decide('it-rr-exp', 'cancelled', sa1, `v-${sa1}`), /can only be closed as expired/);
    assert.equal((await ok(`UPDATE admin_mfa_reset_requests SET status = 'expired' WHERE id = 'it-rr-exp' AND status = 'pending' RETURNING id`)).length, 1);
    await ok(resetRequest('it-rr-sup', `${P}off`, sa1, 'single_super_admin'));
    assert.equal((await ok(`UPDATE admin_mfa_reset_requests SET status = 'superseded' WHERE id = 'it-rr-sup' RETURNING id`)).length, 1);
    await fails(`UPDATE admin_mfa_reset_requests SET status = 'pending' WHERE id = 'it-rr-sup'`, /finished admin MFA reset request cannot change/);
  });
});

test('AUTH C1.8: ordinary Official reset: one Super Admin other than the target, with TOTP evidence', { skip }, async () => {
  await mfaScenario('', async ({ ok, fails, su }) => {
    const sa1 = `${P}sa1`; const off = `${P}off`;
    await fails(resetRequest('it-ro-mode', off, sa1, 'two_person'), /needs single_super_admin/);
    await fails(resetRequest('it-ro-off', off, `${P}off2`, 'single_super_admin'), /only an approved Super Admin may initiate/);
    await ok(resetRequest('it-ro-1', off, sa1, 'single_super_admin'));
    await ok(stepUp('it-up-sa1', sa1));
    // Another Super Admin cannot execute a single-approver request: the initiating Super Admin does. Since
    // AUTH C1.8.4 another Super Admin cannot issue its ticket either, nor execute with the initiator's ticket.
    await ok(stepUp('it-up-sa2', `${P}sa2`));
    await fails(resetTicket(hex('d'), off, `${P}sa2`, 'single_approver_reset', 'it-ro-1'), /issued by the initiating Super Admin/);
    // A ticket under the two-person label does not match this request (refused at INSERT since AUTH C1.8.4).
    await fails(resetTicket(hex('e'), off, sa1, 'two_person_reset', 'it-ro-1'), /label must match the approval mode/);
    await ok(resetTicket(hex('f'), off, sa1, 'single_approver_reset', 'it-ro-1'));
    await fails(decide('it-ro-1', 'executed', `${P}sa2`, 'it-up-sa2', hex('f')), /must name the open enrolment ticket/);
    // A target promoted to Super Admin after initiation now needs two people.
    await su(`UPDATE users SET is_super_admin = true WHERE id = '${off}'`);
    await fails(decide('it-ro-1', 'executed', sa1, 'it-up-sa1', hex('f')), /now a Super Admin: two-person approval is required/);
    await su(`UPDATE users SET is_super_admin = false WHERE id = '${off}'`);
    assert.equal((await ok(decide('it-ro-1', 'executed', sa1, 'it-up-sa1', hex('f')))).length, 1, 'single Super Admin executes');
    await fails(`UPDATE admin_mfa_reset_requests SET decision_reason = 'x' WHERE id = 'it-ro-1'`, /finished admin MFA reset request cannot change/);
  });
});

test('AUTH C1.8: concurrency as eltnoy_app: replay guard, recovery code, step-up challenge, duplicate initiation and duplicate approval each succeed once', { skip }, async () => {
  const C = 'it-mfc-';
  await seedCommittedMfa(C); // committed: separate connections must see it
  const { db, end } = appDatabase();
  /** Runs `statements` in one transaction on its own connection, holding locks briefly before COMMIT. */
  const tx = async (statements: string[]): Promise<{ rows: number; error: string | null }> => {
    const connection = await db.connect();
    let rows = 0;
    try {
      await connection.query('BEGIN');
      for (const statement of statements) rows += (await connection.query(statement)).rowCount ?? 0;
      await connection.query('SELECT pg_sleep(0.2)');
      await connection.query('COMMIT');
      return { rows, error: null };
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      return { rows: 0, error: error instanceof Error ? error.message : String(error) };
    } finally {
      connection.release();
    }
  };
  const race = (a: string[], b: string[]) => Promise.all([tx(a), tx(b)]);
  try {
    assert.equal((await db.query('SELECT current_user AS u')).rows[0].u, 'eltnoy_app');
    // 1. The same TOTP step, verified twice at once: exactly one conditional update wins.
    const guard = `UPDATE admin_mfa_factors SET last_used_step = 7000 WHERE id = 'f-${C}sa1' AND disabled_at IS NULL AND last_used_step < 7000`;
    const replay = await race([guard], [guard]);
    assert.equal(replay.reduce((sum, r) => sum + r.rows, 0), 1, `replay: ${JSON.stringify(replay)}`);
    // 2. One recovery code used twice at once.
    await db.query(`INSERT INTO admin_mfa_recovery_codes (id, user_id, factor_id, code_hash) VALUES ('${C}rc', '${C}sa1', 'f-${C}sa1', '${hex('e')}')`);
    const use = `UPDATE admin_mfa_recovery_codes SET used_at = now() WHERE id = '${C}rc' AND used_at IS NULL AND revoked_at IS NULL`;
    const codes = await race([use], [use]);
    assert.equal(codes.reduce((sum, r) => sum + r.rows, 0), 1, `recovery: ${JSON.stringify(codes)}`);
    // 3. Two open step-up challenges for one session at once.
    const challenge = (id: string) => `INSERT INTO admin_mfa_challenges (id, user_id, purpose, session_token_hash, expires_at) VALUES ('${id}', '${C}sa1', 'step_up', 's-${C}sa1', now() + interval '5 minutes')`;
    const steps = await race([challenge(hex('1'))], [challenge(hex('2'))]);
    assert.equal(steps.filter((r) => r.error === null).length, 1, `step-up: ${JSON.stringify(steps)}`);
    assert.match(steps.find((r) => r.error)?.error ?? '', /admin_mfa_challenges_one_step_up_idx/);
    // 4. Two Super Admins initiate a reset of the same target at once.
    const initiate = (id: string, initiator: string) => resetRequest(id, `${C}sa3`, initiator, 'two_person');
    const initiations = await race([initiate(`${C}rr-a`, `${C}sa1`)], [initiate(`${C}rr-b`, `${C}sa2`)]);
    assert.equal(initiations.filter((r) => r.error === null).length, 1, `initiation: ${JSON.stringify(initiations)}`);
    assert.match(initiations.find((r) => r.error)?.error ?? '', /admin_mfa_reset_requests_one_pending_idx/);
    const pending = String(await one(`SELECT id FROM admin_mfa_reset_requests WHERE target_user_id = '${C}sa3' AND status = 'pending'`));
    const initiator = String(await one(`SELECT initiated_by FROM admin_mfa_reset_requests WHERE id = '${pending}'`));
    // 5. Two different eligible Super Admins approve it at once, each performing the COMPLETE reset (AUTH
    //    C1.8.4: anything less cannot commit): exactly one reset executes, and its effects are all present.
    const approvers = [`${C}sa2`, `${C}sa4`, `${C}sa1`].filter((id) => id !== initiator).slice(0, 2);
    const approve = (approver: string, ticketHex: string) => [
      stepUp(`${C}up-${approver}`, approver),
      ...resetSequence({ request: pending, target: `${C}sa3`, decider: approver, mode: 'two_person', evidence: `${C}up-${approver}`, ticket: hex(ticketHex) }),
    ];
    const approvals = await race(approve(approvers[0], '3'), approve(approvers[1], '4'));
    assert.equal(approvals.filter((r) => r.error === null).length, 1, `approval: ${JSON.stringify(approvals)}`);
    assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_reset_requests WHERE target_user_id = '${C}sa3' AND status = 'executed'`), 1);
    assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_enrolment_tickets WHERE reset_request_id = '${pending}'`), 1, 'the winning reset issued one replacement ticket');
    assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_enrolment_tickets WHERE user_id = '${C}sa3' AND used_at IS NULL AND revoked_at IS NULL`), 1, 'the replacement ticket is open');
    assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_factors WHERE user_id = '${C}sa3' AND disabled_at IS NULL`), 0, 'factor disabled');
    assert.equal(await one(`SELECT count(*)::int FROM auth_sessions WHERE user_id = '${C}sa3' AND revoked_at IS NULL`), 0, 'sessions revoked');
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE user_id = '${C}sa3' AND action = 'admin_mfa.reset_executed'`), 1, 'one audit event');
    // 6. Retry after the successful execution: nothing is pending, so a repeat changes nothing.
    const retry = await tx([decide(pending, 'executed', approvers[1], `${C}up-${approvers[1]}`, hex('4')).replace(/ RETURNING id$/, '')]);
    assert.deepEqual(retry, { rows: 0, error: null });
  } finally {
    await end();
    await removeCommittedMfaRows(C);
  }
});

/**
 * Removes committed synthetic MFA rows of one prefix as the superuser, with triggers (including FK and
 * deferred constraint triggers) suspended for this transaction only, then proves that none persist.
 */
async function removeCommittedMfaRows(prefix: string): Promise<void> {
  await q('BEGIN');
  try {
    await q("SET LOCAL session_replication_role = 'replica'");
    await q(`DELETE FROM admin_mfa_reset_requests WHERE target_user_id LIKE '${prefix}%'`);
    for (const table of ['admin_mfa_challenges', 'admin_mfa_enrolment_tickets', 'admin_mfa_recovery_codes', 'auth_session_mfa_verifications', 'admin_mfa_factors', 'auth_sessions', 'auth_verification_events']) {
      await q(`DELETE FROM ${table} WHERE user_id LIKE '${prefix}%'`);
    }
    await q(`DELETE FROM users WHERE id LIKE '${prefix}%'`);
    await q('COMMIT');
  } catch (error) {
    await q('ROLLBACK');
    throw error;
  }
  for (const table of ['users', 'auth_sessions', 'admin_mfa_factors', 'admin_mfa_recovery_codes', 'admin_mfa_challenges', 'admin_mfa_enrolment_tickets', 'auth_session_mfa_verifications', 'auth_verification_events']) {
    assert.equal(await one(`SELECT count(*)::int FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} LIKE '${prefix}%'`), 0, `no synthetic ${table} rows persist`);
  }
  assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_reset_requests WHERE target_user_id LIKE '${prefix}%'`), 0);
}

// ---------------------------------------------------------------------------
// AUTH C1.8.4: F1 ticket integrity, F2 all-or-nothing resets, O-3 factor-disable linkage, bootstrap.
// Commit-time checks are deferred: inside a rolled-back scenario they are fired with AT_COMMIT
// (SET CONSTRAINTS ALL IMMEDIATE); the committed concurrency tests exercise a real COMMIT.
// ---------------------------------------------------------------------------

/** Two-person reset of sa3 (initiator sa1, approver sa2), with a recovery code and an open challenge to clean up. */
const F2_TWO: ResetPlan = { request: 'it-f2-r', target: `${P}sa3`, decider: `${P}sa2`, mode: 'two_person', evidence: 'it-f2-up2', ticket: hex('c') };
/** Single-Super-Admin reset of the ordinary Official off by sa1. */
const F2_SINGLE: ResetPlan = { request: 'it-f2-s', target: `${P}off`, decider: `${P}sa1`, mode: 'single_super_admin', evidence: 'it-f2-up1', ticket: hex('d') };
const F2_SETUP = `
  INSERT INTO admin_mfa_recovery_codes (id, user_id, factor_id, code_hash) VALUES ('it-f2-rc3', '${P}sa3', 'f-${P}sa3', '${hex('7')}');
  INSERT INTO admin_mfa_recovery_codes (id, user_id, factor_id, code_hash) VALUES ('it-f2-rcoff', '${P}off', 'f-${P}off', '${hex('6')}');
  INSERT INTO admin_mfa_challenges (id, user_id, purpose, expires_at) VALUES ('${hex('8')}', '${P}sa3', 'login', now() + interval '5 minutes');
  ${resetRequest(F2_TWO.request, F2_TWO.target, `${P}sa1`, 'two_person')};
  ${resetRequest(F2_SINGLE.request, F2_SINGLE.target, `${P}sa1`, 'single_super_admin')};
  SELECT pg_sleep(0.01);
  ${stepUp(F2_TWO.evidence, F2_TWO.decider)};
  ${stepUp(F2_SINGLE.evidence, F2_SINGLE.decider)};`;

/** After a complete reset: every effect is present for the target, and the request is executed with an open ticket. */
async function assertResetComplete(plan: ResetPlan): Promise<void> {
  assert.equal(await one(`SELECT status FROM admin_mfa_reset_requests WHERE id = '${plan.request}'`), 'executed');
  assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_enrolment_tickets WHERE id = '${plan.ticket}' AND used_at IS NULL AND revoked_at IS NULL`), 1, 'replacement ticket open');
  assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_factors WHERE user_id = '${plan.target}' AND disabled_at IS NULL`), 0, 'no active factor');
  assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_recovery_codes WHERE user_id = '${plan.target}' AND used_at IS NULL AND revoked_at IS NULL`), 0, 'codes revoked');
  assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_challenges WHERE user_id = '${plan.target}' AND consumed_at IS NULL`), 0, 'challenges closed');
  assert.equal(await one(`SELECT count(*)::int FROM auth_sessions WHERE user_id = '${plan.target}' AND revoked_at IS NULL`), 0, 'sessions revoked');
  assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE action = 'admin_mfa.reset_executed' AND details->>'requestId' = '${plan.request}'`), 1, 'audited');
}

test('AUTH C1.8.4 F1: reset tickets need a pending request of the same target, the right label and issuer, and an eligible issuer', { skip }, async () => {
  const sa1 = `${P}sa1`; const sa2 = `${P}sa2`; const sa3 = `${P}sa3`; const off = `${P}off`;
  const firstTime = (id: string, user: string, issuer: string) =>
    `INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, expires_at) VALUES ('${id}', '${user}', '${issuer}', 'super_admin', now() + interval '30 minutes')`;
  await mfaScenario('', async ({ ok, fails, su }) => {
    await ok(resetRequest('it-f1-two', sa3, sa1, 'two_person'));
    await ok(resetRequest('it-f1-one', off, sa1, 'single_super_admin'));
    // Missing or unknown request.
    await fails(resetTicket(hex('1'), sa3, sa2, 'two_person_reset', 'it-f1-unknown'), /must reference an existing reset request/);
    // Target mismatch; label mismatch; wrong issuer for each mode; a self-issued reset ticket.
    await fails(resetTicket(hex('1'), off, sa2, 'two_person_reset', 'it-f1-two'), /issued to the target of its reset request/);
    await fails(resetTicket(hex('1'), sa3, sa2, 'single_approver_reset', 'it-f1-two'), /label must match the approval mode/);
    await fails(resetTicket(hex('1'), off, sa1, 'two_person_reset', 'it-f1-one'), /label must match the approval mode/);
    await fails(resetTicket(hex('1'), sa3, sa1, 'two_person_reset', 'it-f1-two'), /issued by the approver, never the initiator/);
    await fails(resetTicket(hex('1'), off, sa2, 'single_approver_reset', 'it-f1-one'), /issued by the initiating Super Admin/);
    await fails(resetTicket(hex('1'), sa3, sa3, 'two_person_reset', 'it-f1-two'), /admin_mfa_enrolment_tickets_not_self_check/);
    // Issuer eligibility: an ordinary Official, a Super Admin without a factor, with a disabled factor, not approved.
    await fails(firstTime(hex('2'), `${P}new1`, off), /approved Super Admin with a confirmed, active MFA factor/);
    await fails(firstTime(hex('2'), `${P}new1`, `${P}nsa`), /approved Super Admin with a confirmed, active MFA factor/);
    await su(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${sa2}', disabled_via = 'two_person_reset' WHERE id = 'f-${P}sa4'`);
    await fails(firstTime(hex('2'), `${P}new1`, `${P}sa4`), /approved Super Admin with a confirmed, active MFA factor/);
    await su(`UPDATE users SET account_status = 'pending' WHERE id = '${sa2}'`);
    await fails(firstTime(hex('2'), `${P}new1`, sa2), /approved Super Admin with a confirmed, active MFA factor/);
    await su(`UPDATE users SET account_status = 'approved' WHERE id = '${sa2}'`);
    // Expired and non-pending requests.
    await ok(resetRequest('it-f1-exp', `${P}off2`, sa1, 'single_super_admin', `v-${sa1}`, "clock_timestamp() + interval '50 milliseconds'"));
    await su('SELECT pg_sleep(0.1)');
    await fails(resetTicket(hex('3'), `${P}off2`, sa1, 'single_approver_reset', 'it-f1-exp'), /pending, unexpired reset request/);
    assert.equal((await ok(decide('it-f1-two', 'rejected', sa2, `v-${sa2}`))).length, 1);
    await fails(resetTicket(hex('3'), sa3, sa2, 'two_person_reset', 'it-f1-two'), /pending, unexpired reset request/);
  });
  // Legitimate first enrolment of a never-enrolled Official; no commit-time check refuses it.
  await mfaScenario('', async ({ ok }) => {
    await ok(firstTime(hex('4'), `${P}new1`, sa1));
    await ok(AT_COMMIT);
    assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_enrolment_tickets WHERE id = '${hex('4')}' AND used_at IS NULL AND revoked_at IS NULL`), 1);
  });
  // Re-enrolment after a confirmed factor was disabled is a reset, never a first-time ticket.
  await mfaScenario('', async ({ ok, fails, su }) => {
    await su(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${sa1}', disabled_via = 'single_approver_reset' WHERE id = 'f-${off}'`);
    await fails(firstTime(hex('5'), off, sa1), /enrolled before: replacing a factor requires a reset/);
    await ok(resetRequest('it-f1-re', off, sa1, 'single_super_admin'));
    await ok(resetTicket(hex('5'), off, sa1, 'single_approver_reset', 'it-f1-re'));
  });
  // A reset ticket inserted for a pending request cannot commit unless that request is executed with it.
  await mfaScenario('', async ({ ok, fails }) => {
    await ok(resetRequest('it-f1-pend', sa3, sa1, 'two_person'));
    await ok(resetTicket(hex('6'), sa3, sa2, 'two_person_reset', 'it-f1-pend'));
    // At a real COMMIT this error aborts the transaction, so the ticket never persists (the committed
    // concurrency tests exercise real COMMITs).
    await fails(AT_COMMIT, /a reset ticket commits only together with its executed reset request/);
  });
});

test('AUTH C1.8.4 F2: complete two-person and single-Super-Admin resets commit; each missing effect is refused at commit', { skip }, async () => {
  // Complete resets, in both approved modes.
  for (const plan of [F2_TWO, F2_SINGLE]) {
    await mfaScenario(F2_SETUP, async ({ ok }) => {
      for (const statement of resetSequence(plan)) await ok(statement);
      await ok(AT_COMMIT);
      await assertResetComplete(plan);
    });
  }
  // One effect missing at a time: refused at commit, with the specific invariant.
  const missing: Array<[ResetStep, RegExp]> = [
    ['factor', /a reset must leave the target with no active MFA factor/],
    ['codes', /a reset must revoke every unused recovery code of the target/],
    ['challenges', /a reset must close every open MFA challenge of the target/],
    ['sessions', /a reset must revoke every unexpired session of the target/],
    ['event', /an executed reset needs its admin_mfa\.reset_executed audit event/],
    ['close', /a reset-labelled factor disable needs its matching reset|a reset ticket commits only together with its executed reset request/],
  ];
  for (const [step, pattern] of missing) {
    await mfaScenario(F2_SETUP, async ({ ok, fails }) => {
      for (const statement of resetSequence(F2_TWO, [step])) await ok(statement);
      await fails(AT_COMMIT, pattern);
    });
  }
  // Without the replacement ticket the request cannot even be closed.
  await mfaScenario(F2_SETUP, async ({ ok, fails }) => {
    for (const statement of resetSequence(F2_TWO, ['ticket', 'close'])) await ok(statement);
    await fails(resetSteps(F2_TWO).close, /must name the open enrolment ticket/);
  });
  // A replacement ticket revoked before commit; a session created (as by a racing sign-in) before commit.
  await mfaScenario(F2_SETUP, async ({ ok, fails }) => {
    for (const statement of resetSequence(F2_TWO)) await ok(statement);
    await ok(`UPDATE admin_mfa_enrolment_tickets SET revoked_at = now() WHERE id = '${F2_TWO.ticket}'`);
    await fails(AT_COMMIT, /the replacement enrolment ticket must still be open when the reset commits/);
  });
  await mfaScenario(F2_SETUP, async ({ ok, fails, su }) => {
    for (const statement of resetSequence(F2_TWO)) await ok(statement);
    await su(`INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ('s-it-f2-late', '${F2_TWO.target}', now() + interval '1 hour')`);
    await fails(AT_COMMIT, /a reset must revoke every unexpired session of the target/);
  });
});

test('AUTH C1.8.4 F2: a failure after any intermediate write rolls the whole reset back', { skip }, async () => {
  for (let k = 1; k < RESET_ORDER.length; k += 1) {
    await mfaScenario(F2_SETUP, async ({ ok, fails, su }) => {
      const before = await one(resetFingerprint(F2_TWO.target));
      await su('SAVEPOINT reset_attempt');
      for (const statement of resetSequence(F2_TWO).slice(0, k)) await ok(statement);
      await fails(AT_COMMIT, /a reset-labelled factor disable needs its matching reset|a reset ticket commits only together with its executed reset request/);
      await su('ROLLBACK TO SAVEPOINT reset_attempt');
      await su('SET CONSTRAINTS ALL DEFERRED');
      assert.equal(await one(resetFingerprint(F2_TWO.target)), before, `after ${RESET_ORDER.slice(0, k).join(', ')}: nothing persists`);
      // A retry after the failed attempt succeeds from the unchanged state.
      for (const statement of resetSequence(F2_TWO)) await ok(statement);
      await ok(AT_COMMIT);
      await assertResetComplete(F2_TWO);
    });
  }
});

test('AUTH C1.8.4 F2: lost-ticket recovery through a second reset; retry after success; duplicate open tickets refused', { skip }, async () => {
  await mfaScenario(F2_SETUP, async ({ ok, fails, su }) => {
    for (const statement of resetSequence(F2_TWO)) await ok(statement);
    await ok(AT_COMMIT);
    await su('SET CONSTRAINTS ALL DEFERRED');
    // Retry after success: nothing pending; a new ticket for the executed request is refused.
    assert.equal((await ok(decide(F2_TWO.request, 'executed', F2_TWO.decider, F2_TWO.evidence, F2_TWO.ticket))).length, 0);
    await fails(resetTicket(hex('9'), F2_TWO.target, F2_TWO.decider, 'two_person_reset', F2_TWO.request), /pending, unexpired reset request/);
    // Lost ticket: a new two-person request; the old ticket must be revoked before the new one is issued.
    const second: ResetPlan = { request: 'it-f2-r2', target: F2_TWO.target, decider: `${P}sa4`, mode: 'two_person', evidence: 'it-f2-up4', ticket: hex('e') };
    await ok(resetRequest(second.request, second.target, `${P}sa1`, 'two_person'));
    await su('SELECT pg_sleep(0.01)');
    await ok(stepUp(second.evidence, second.decider));
    for (const statement of resetSequence(second, ['tickets', 'ticket', 'event', 'close'])) await ok(statement);
    await fails(resetSteps(second).ticket, /admin_mfa_enrolment_tickets_one_open_idx/);
    await ok(resetSteps(second).tickets);
    for (const step of ['ticket', 'event', 'close'] as const) await ok(resetSteps(second)[step]);
    await ok(AT_COMMIT);
    await assertResetComplete(second);
    assert.equal(await one(`SELECT revoked_at IS NOT NULL FROM admin_mfa_enrolment_tickets WHERE id = '${F2_TWO.ticket}'`), true, 'the lost ticket is revoked');
  });
});

test('AUTH C1.8.4 O-3: a factor is disabled only by its reset, by break-glass, or (unconfirmed) by a new enrolment', { skip }, async () => {
  const sa2 = `${P}sa2`; const sa3 = `${P}sa3`;
  // No matching reset at all.
  await mfaScenario('', async ({ ok, fails }) => {
    await ok(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${sa2}', disabled_via = 'two_person_reset' WHERE id = 'f-${sa3}'`);
    await fails(AT_COMMIT, /a reset-labelled factor disable needs its matching reset executed later in the same transaction/);
  });
  // A reset exists, but the disable names another decider, or the other mode's label.
  for (const factor of [
    `UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${P}sa4', disabled_via = 'two_person_reset' WHERE user_id = '${sa3}' AND disabled_at IS NULL`,
    `UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${sa2}', disabled_via = 'single_approver_reset' WHERE user_id = '${sa3}' AND disabled_at IS NULL`,
  ]) {
    await mfaScenario(F2_SETUP, async ({ ok, fails }) => {
      await ok(factor);
      for (const statement of resetSequence(F2_TWO, ['factor'])) await ok(statement);
      await fails(AT_COMMIT, /a reset-labelled factor disable needs its matching reset executed later in the same transaction/);
    });
  }
  // Immediate rules.
  await mfaScenario('', async ({ ok, fails, su }) => {
    await seedEnrolmentFixture(su, `${P}new1`, hex('9'), hex('a'));
    await fails(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_via = 'enrolment_superseded' WHERE id = 'f-${sa3}'`, /only an unconfirmed factor can be superseded/);
    await fails(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_via = 'two_person_reset' WHERE id = 'f-${sa3}'`, /must name the deciding Super Admin/);
    await fails(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_by = '${sa2}', disabled_via = 'break_glass' WHERE id = 'f-${sa3}'`, /names no user/);
    await ok(`INSERT INTO admin_mfa_factors (id, user_id, enrolment_challenge_id, kind, secret_ciphertext, secret_nonce, secret_tag, key_version)
      VALUES ('it-o3-new', '${P}new1', '${hex('a')}', 'totp', decode(repeat('11', 20), 'hex'), decode(repeat('22', 12), 'hex'), decode(repeat('33', 16), 'hex'), 1)`);
    await ok(`UPDATE admin_mfa_factors SET disabled_at = now(), disabled_via = 'enrolment_superseded' WHERE id = 'it-o3-new'`);
    await ok(AT_COMMIT);
  });
  // Break-glass (operator CLI path; O-1: the database checks the workflow, not the caller).
  const breakGlass = {
    factor: `UPDATE admin_mfa_factors SET disabled_at = now(), disabled_via = 'break_glass' WHERE user_id = '${sa3}' AND disabled_at IS NULL`,
    codes: `UPDATE admin_mfa_recovery_codes SET revoked_at = now() WHERE user_id = '${sa3}' AND used_at IS NULL AND revoked_at IS NULL`,
    challenges: `UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'revoked' WHERE user_id = '${sa3}' AND consumed_at IS NULL`,
    sessions: `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = '${sa3}' AND revoked_at IS NULL`,
    supersede: `UPDATE admin_mfa_reset_requests SET status = 'superseded' WHERE target_user_id = '${sa3}' AND status = 'pending'`,
    ticket: `INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, expires_at) VALUES ('${hex('f')}', '${sa3}', NULL, 'break_glass', now() + interval '30 minutes')`,
    event: `INSERT INTO auth_verification_events (id, action, user_id, details) VALUES ('ev-it-o3-bg', 'admin_mfa.break_glass_reset', '${sa3}', jsonb_build_object('incidentRef', 'IT-SYNTHETIC', 'actorKind', 'operator'))`,
  };
  const cases: Array<[string[], RegExp | null]> = [
    [['factor', 'codes', 'challenges', 'sessions', 'supersede', 'ticket', 'event'], null],
    [['factor', 'codes', 'challenges', 'sessions', 'supersede', 'ticket'], /admin_mfa\.break_glass_reset audit event/],
    [['factor', 'codes', 'challenges', 'sessions', 'supersede', 'event'], /break-glass factor disable needs a break-glass ticket/],
    [['factor', 'codes', 'challenges', 'sessions', 'ticket', 'event'], /must supersede the pending reset request/],
    [['codes', 'challenges', 'sessions', 'supersede', 'ticket', 'event'], /no active MFA factor/],
  ];
  for (const [steps, pattern] of cases) {
    await mfaScenario(F2_SETUP, async ({ ok, fails }) => {
      for (const step of steps) await ok(breakGlass[step as keyof typeof breakGlass]);
      if (pattern) await fails(AT_COMMIT, pattern);
      else await ok(AT_COMMIT);
    });
  }
});

test('AUTH C1.8.4: bootstrap tickets only for an approved Super Admin while none has enrolled, one at a time', { skip }, async () => {
  const bootstrap = (id: string, user: string) =>
    `INSERT INTO admin_mfa_enrolment_tickets (id, user_id, issued_by, issued_via, expires_at) VALUES ('${id}', '${user}', NULL, 'bootstrap_cli', now() + interval '30 minutes')`;
  // Closed once any Super Admin has a confirmed factor (the standard seed enrols four).
  await mfaScenario('', async ({ fails }) => {
    await fails(bootstrap(hex('1'), `${P}nsa`), /a Super Admin has already enrolled: bootstrap is closed/);
  });
  // Open on a database where no Super Admin has enrolled.
  assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_factors f JOIN users u ON u.id = f.user_id WHERE u.is_super_admin AND f.confirmed_at IS NOT NULL`), 0,
    'precondition: no committed Super Admin factor exists in the disposable database');
  const B = 'it-mfb-';
  const users = `
    INSERT INTO users (id, login_id, display_name, role, password_hash, is_super_admin) VALUES
      ('${B}sa1', upper('${B}sa1'), 'IT MFA', 'official', '!synthetic', true),
      ('${B}sa2', upper('${B}sa2'), 'IT MFA', 'official', '!synthetic', true),
      ('${B}off', upper('${B}off'), 'IT MFA', 'official', '!synthetic', false);`;
  await mfaScenario(users, async ({ ok, fails }) => {
    await fails(bootstrap(hex('2'), `${B}off`), /only for an approved Super Admin/);
    await ok(bootstrap(hex('2'), `${B}sa1`));
    await fails(bootstrap(hex('3'), `${B}sa2`), /an open bootstrap ticket already exists/);
    const bootstrapChallengeId = hex('7');
    await ok(`INSERT INTO admin_mfa_challenges (id, user_id, purpose, enrolment_ticket_id, expires_at)
      VALUES ('${bootstrapChallengeId}', '${B}sa1', 'enrol', '${hex('2')}', now() + interval '5 minutes')`);
    await ok(`INSERT INTO admin_mfa_factors (id, user_id, enrolment_challenge_id, kind, secret_ciphertext, secret_nonce, secret_tag, key_version)
      VALUES ('f-${B}sa1', '${B}sa1', '${bootstrapChallengeId}', 'totp', decode(repeat('11', 20), 'hex'), decode(repeat('22', 12), 'hex'), decode(repeat('33', 16), 'hex'), 1)`);
    await ok(`SELECT public.confirm_admin_mfa_enrolment_factor('${B}sa1', '${bootstrapChallengeId}', '${hex('2')}', 'f-${B}sa1', 1000)`);
    await ok(`UPDATE admin_mfa_challenges SET consumed_at = now(), consumed_reason = 'verified' WHERE id = '${bootstrapChallengeId}'`);
    await fails(bootstrap(hex('3'), `${B}sa2`), /a Super Admin has already enrolled: bootstrap is closed/);
  }, { seed: false });
  // Two bootstrap commands at once (real commits, separate connections): exactly one passes.
  await q(users);
  const { db, end } = appDatabase();
  const tx = async (statements: string[], begin = 'BEGIN'): Promise<{ rows: number; error: string | null }> => {
    const connection = await db.connect();
    let rows = 0;
    try {
      await connection.query(begin);
      for (const statement of statements) rows += (await connection.query(statement)).rowCount ?? 0;
      await connection.query('SELECT pg_sleep(0.2)');
      await connection.query('COMMIT');
      return { rows, error: null };
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      return { rows: 0, error: error instanceof Error ? error.message : String(error) };
    } finally {
      connection.release();
    }
  };
  try {
    const isolated = await tx([bootstrap(hex('4'), `${B}sa1`)], 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    assert.match(isolated.error ?? 'succeeded', /must be issued under READ COMMITTED isolation/);
    const results = await Promise.all([tx([bootstrap(hex('5'), `${B}sa1`)]), tx([bootstrap(hex('6'), `${B}sa2`)])]);
    assert.equal(results.filter((r) => r.error === null).length, 1, `bootstrap race: ${JSON.stringify(results)}`);
    assert.match(results.find((r) => r.error)?.error ?? '', /an open bootstrap ticket already exists/);
    assert.equal(await one(`SELECT count(*)::int FROM admin_mfa_enrolment_tickets WHERE issued_via = 'bootstrap_cli' AND user_id LIKE '${B}%'`), 1);
  } finally {
    await end();
    await removeCommittedMfaRows(B);
  }
});

// ---------------------------------------------------------------------------
// AUTH C1.9.1 (MFA P3a-1): the real Official sign-in store (server/adminMfaStore.ts) and the Official
// MFA session query (server/auth.ts OFFICIAL_MFA_SQL), as eltnoy_app on separate connections. The code
// check is a stub returning a fixed RFC 6238 step: the cryptography is unit-tested; this exercises
// the transaction, locks, grants, triggers and concurrency. Committed synthetic rows are removed by
// removeCommittedMfaRows.
// ---------------------------------------------------------------------------

test('AUTH C1.9.1: real sign-in store as eltnoy_app: completion, single use, rollback, concurrency, throttle and the Official MFA query', { skip }, async () => {
  const Q = 'it-mfp-';
  const { createPostgresAdminMfaStore, ADMIN_MFA_LOGIN_POLICY } = await import('./adminMfaStore.js');
  const { OFFICIAL_MFA_SQL } = await import('./auth.js');
  await seedCommittedMfa(Q); // committed: the store uses its own connections
  const { db, end } = appDatabase();
  const mfaStore = createPostgresAdminMfaStore(db as never);
  const accept = (step: number) => () => ({ outcome: 'accept' as const, step });
  const reject = () => ({ outcome: 'reject' as const, reason: 'invalid' as const });
  const input = (challengeId: string, sessionTokenHash: string, check: () => { outcome: 'accept'; step: number } | { outcome: 'reject'; reason: 'invalid' }) =>
    ({ challengeId, sessionTokenHash, sessionSeconds: 43_200, check });
  const user = `${Q}off`;
  try {
    assert.equal((await db.query('SELECT current_user AS u')).rows[0].u, 'eltnoy_app');
    assert.equal(await mfaStore.hasActiveFactor(user), true);
    assert.equal(await mfaStore.hasActiveFactor(`${Q}new1`), false, 'never enrolled');

    // 1. Completion: one session, its login evidence, the consumed challenge, the advanced step, the event.
    await mfaStore.createLoginChallenge({ challengeId: hex('1'), userId: user, ttlSeconds: ADMIN_MFA_LOGIN_POLICY.challengeTtlSeconds });
    assert.equal(await one(`SELECT round(extract(epoch FROM expires_at - created_at))::int FROM admin_mfa_challenges WHERE id = '${hex('1')}'`), 300);
    const signedIn = await mfaStore.verifyLogin(input(hex('1'), hex('a'), accept(1000)));
    assert.equal(signedIn.status, 'signed_in');
    assert.equal(await one(`SELECT count(*)::int FROM auth_sessions WHERE token_hash = '${hex('a')}' AND user_id = '${user}' AND revoked_at IS NULL`), 1);
    assert.equal(await one(`SELECT count(*)::int FROM auth_session_mfa_verifications WHERE token_hash = '${hex('a')}' AND purpose = 'login' AND method = 'totp'`), 1);
    assert.equal(await one(`SELECT consumed_reason FROM admin_mfa_challenges WHERE id = '${hex('1')}'`), 'verified');
    assert.equal(Number(await one(`SELECT last_used_step FROM admin_mfa_factors WHERE user_id = '${user}' AND disabled_at IS NULL`)), 1000);
    assert.deepEqual(await mfaStore.verifyLogin(input(hex('1'), hex('b'), accept(1001))), { status: 'expired' }, 'single use');

    // 2. The Official MFA query: verified session true; password-only, step-up-only and revoked sessions not.
    const mfaOf = async (tokenHash: string) => (await db.query(OFFICIAL_MFA_SQL, [tokenHash])).rows;
    assert.deepEqual(await mfaOf(hex('a')), [{ official_mfa_verified: true }]);
    await db.query(`INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ('${hex('c')}', '${user}', now() + interval '1 hour')`);
    assert.deepEqual(await mfaOf(hex('c')), [{ official_mfa_verified: false }], 'a password-only (legacy) session');
    await db.query(`INSERT INTO auth_session_mfa_verifications (id, token_hash, user_id, purpose, method, factor_id) VALUES ('${Q}su', '${hex('c')}', '${user}', 'step_up', 'totp', 'f-${user}')`);
    assert.deepEqual(await mfaOf(hex('c')), [{ official_mfa_verified: false }], 'step-up evidence alone never counts');
    await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = '${hex('a')}'`);
    assert.deepEqual(await mfaOf(hex('a')), [], 'a revoked session has no row');

    // 3. A failure after the challenge was consumed (duplicate session hash) rolls back everything.
    await mfaStore.createLoginChallenge({ challengeId: hex('2'), userId: user, ttlSeconds: 300 });
    await assert.rejects(mfaStore.verifyLogin(input(hex('2'), hex('c'), accept(1002))));
    assert.equal(await one(`SELECT consumed_at IS NULL AND attempts = 0 FROM admin_mfa_challenges WHERE id = '${hex('2')}'`), true, 'challenge open, attempt rolled back');
    assert.equal(Number(await one(`SELECT last_used_step FROM admin_mfa_factors WHERE user_id = '${user}' AND disabled_at IS NULL`)), 1000, 'step not advanced');
    // A throwing check (missing key) also leaves the challenge untouched.
    await assert.rejects(mfaStore.verifyLogin(input(hex('2'), hex('d'), () => { throw new Error('no key'); })), /no key/);
    assert.equal(await one(`SELECT attempts FROM admin_mfa_challenges WHERE id = '${hex('2')}'`), 0);

    // 4. Concurrent completion of ONE challenge: exactly one session.
    const once = await Promise.all([
      mfaStore.verifyLogin(input(hex('2'), hex('e'), accept(1003))),
      mfaStore.verifyLogin(input(hex('2'), hex('f'), accept(1003))),
    ]);
    assert.equal(once.filter((r) => r.status === 'signed_in').length, 1, JSON.stringify(once));
    assert.equal(await one(`SELECT count(*)::int FROM auth_sessions WHERE token_hash IN ('${hex('e')}', '${hex('f')}')`), 1);

    // 5. The same step on two open challenges of the account at once: exactly one session (replay guard).
    await mfaStore.createLoginChallenge({ challengeId: hex('3'), userId: user, ttlSeconds: 300 });
    await db.query(`INSERT INTO admin_mfa_challenges (id, user_id, purpose, expires_at) VALUES ('${hex('4')}', '${user}', 'login', now() + interval '5 minutes')`);
    const sameStep = await Promise.all([
      mfaStore.verifyLogin(input(hex('3'), hex('5'), accept(2000))),
      mfaStore.verifyLogin(input(hex('4'), hex('6'), accept(2000))),
    ]);
    assert.equal(sameStep.filter((r) => r.status === 'signed_in').length, 1, JSON.stringify(sameStep));
    assert.ok(sameStep.some((r) => r.status === 'invalid_code'), 'the loser is a rejected (replayed) code');

    // 6. Throttle under concurrency: across two challenges, no more than 5 failures are recorded, then refusal.
    const other = `${Q}off2`;
    await mfaStore.createLoginChallenge({ challengeId: hex('7'), userId: other, ttlSeconds: 300 });
    await db.query(`INSERT INTO admin_mfa_challenges (id, user_id, purpose, expires_at) VALUES ('${hex('8')}', '${other}', 'login', now() + interval '5 minutes')`);
    const flood = await Promise.all(Array.from({ length: 8 }, (_, i) => mfaStore.verifyLogin(input(i % 2 ? hex('7') : hex('8'), hex(String(i)).replace(/^./, 'b'), reject))));
    assert.equal(await one(`SELECT count(*)::int FROM auth_verification_events WHERE user_id = '${other}' AND action = 'admin_mfa.code_rejected'`), ADMIN_MFA_LOGIN_POLICY.throttleFailures);
    assert.ok(flood.some((r) => r.status === 'throttled'), JSON.stringify(flood));
    assert.equal(await one(`SELECT count(*)::int FROM auth_sessions WHERE user_id = '${other}' AND token_hash NOT LIKE 's-%'`), 0);

    // 7. An expired challenge is refused (the database also refuses any attempt on it).
    await mfaStore.createLoginChallenge({ challengeId: hex('9'), userId: `${Q}sa1`, ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(await mfaStore.verifyLogin(input(hex('9'), hex('0'), accept(3000))), { status: 'expired' });
  } finally {
    await end();
    await removeCommittedMfaRows(Q);
  }
});


// Institute dashboard aggregate query: run the actual SQL through the same restricted app role used
// by the API, against only the disposable cluster guarded by this file's preflight.
test('INSTITUTE DASHBOARD: center workspace aggregates stay scoped to the institute as eltnoy_app', { skip }, async () => {
  const { centerWorkspaceQueries } = await import('./authorizationQueries.js');
  const prefix = `it-cwd-${randomUUID().replaceAll('-', '')}-`;
  const instituteId = `${prefix}institute`;
  const centerCode = instituteId.toUpperCase();
  const { db, end } = appDatabase();
  const checkinCases = [
    { status: 'verified', updatedAt: 'now()' },
    { status: 'admitted', updatedAt: "now() - interval '1 hour'" },
    { status: 'flagged', updatedAt: "((date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '1 month' + interval '10 days') AT TIME ZONE 'Asia/Kolkata')" },
    { status: 'rejected', updatedAt: "((date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '6 months' + interval '10 days') AT TIME ZONE 'Asia/Kolkata')" },
  ] as const;
  try {
    await q(
      `INSERT INTO users (id, login_id, display_name, role, password_hash)
       VALUES ($1, $2, 'Synthetic dashboard institute', 'center', '!integration-test-only')`,
      [instituteId, centerCode],
    );

    for (const [index, checkin] of checkinCases.entries()) {
      const applicationId = `${prefix}application-${index}`;
      await q(
        `INSERT INTO applications (
           id, application_number, exam_code, candidate_name, father_name, date_of_birth, gender,
           category, email, phone, first_city_preference, second_city_preference, language_medium
         ) VALUES ($1, $2, 'IT-DASHBOARD', 'Synthetic Candidate', 'Synthetic Parent', '2000-01-01',
                  'Other', 'General', 'candidate@example.test', '+910000000000', 'Test City', 'Test City 2', 'English')`,
        [applicationId, `${prefix}${index}`],
      );
      await q(
        `INSERT INTO center_checkins (id, application_id, center_code, status, updated_at)
         VALUES ($1, $2, $3, $4, ${checkin.updatedAt})`,
        [`${prefix}checkin-${index}`, applicationId, centerCode, checkin.status],
      );
    }

    for (const [index, status] of ['approved', 'approved', 'pending', 'rejected'].entries()) {
      await q(
        `INSERT INTO institute_forms (id, institute_id, form_type, title, description, eligibility, status)
         VALUES ($1, $2, 'exam_application', 'Synthetic form', 'Synthetic description for integration coverage', 'Open to test users', $3)`,
        [`${prefix}form-${index}`, instituteId, status],
      );
    }

    const queryList = centerWorkspaceQueries(instituteId);
    assert.equal(queryList.length, 6, 'the dashboard aggregate remains part of the institute workspace query set');
    const results = await Promise.all(queryList.map(({ text, values }) => db.query(text, values)));
    assert.equal((await db.query('SELECT current_user AS role')).rows[0].role, 'eltnoy_app');

    const summary = results[5].rows[0] as Record<string, unknown>;
    assert.equal(summary.total_checkins, '4');
    assert.equal(summary.verified_checkins, '1');
    assert.equal(summary.admitted_checkins, '1');
    assert.equal(summary.flagged_checkins, '1');
    assert.equal(summary.rejected_checkins, '1');
    assert.equal(summary.approved_forms, '2');
    assert.equal(summary.pending_forms, '1');
    assert.equal(summary.balance_paise, '0');
    assert.equal(summary.reserved_paise, '0');

    const expectedMonths = (await q(`
      SELECT to_char(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS current_month,
             to_char(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '1 month', 'YYYY-MM') AS previous_month
    `))[0];
    assert.deepEqual(summary.monthly_checkins, [
      { month: expectedMonths.previous_month, count: '1' },
      { month: expectedMonths.current_month, count: '2' },
    ], 'the six-month chart groups in India time, oldest first, and excludes the older check-in');
  } finally {
    await end();
    await q('DELETE FROM center_checkins WHERE id LIKE $1 || \'%\'', [prefix]);
    await q('DELETE FROM applications WHERE id LIKE $1 || \'%\'', [prefix]);
    await q('DELETE FROM institute_forms WHERE id LIKE $1 || \'%\'', [prefix]);
    await q('DELETE FROM users WHERE id = $1', [instituteId]);
  }
});

// Institute Workspace (instituteWorkspaceMigration.sql), D-02 and data-integrity rules on a real
// database. Everything runs in one transaction that is rolled back.
test('INSTITUTE WORKSPACE: one admit card per application; attendance marks are permanent; no settings table; Super Admin columns granted', { skip }, async () => {
  const probe = async (sql: string, params?: unknown[]): Promise<string | null> => {
    await q('SAVEPOINT ws_probe');
    try {
      await q('SET LOCAL ROLE eltnoy_app');
      await q(sql, params);
      await q('RESET ROLE');
      await q('RELEASE SAVEPOINT ws_probe');
      return null;
    } catch (error) {
      await q('ROLLBACK TO SAVEPOINT ws_probe');
      await q('RESET ROLE');
      return error instanceof Error ? error.message : String(error);
    }
  };
  await q('BEGIN');
  try {
    await q("INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ('it-ws-inst', 'IT-WS-INST', 'IT Workspace institute', 'center', '!synthetic')");
    assert.equal(await probe(`INSERT INTO institute_exams (id, institute_id, exam_code, title, category, mode, eligibility, app_open_date, app_close_date, exam_date, duration_minutes)
      VALUES ('it-ws-exam', 'it-ws-inst', 'IT-WS-1', 'IT Workspace exam', 'Mock', 'Offline', 'Synthetic', '2027-01-01', '2027-01-10', '2027-01-20', 60)`), null, 'the API role prepares an exam');
    assert.equal(await probe(`INSERT INTO institute_candidate_applications (id, institute_id, exam_id, application_number, candidate_name)
      VALUES ('it-ws-app', 'it-ws-inst', 'it-ws-exam', 'IT-WS-APP-1', 'Synthetic Candidate')`), null);
    const ticket = (id: string, roll: string) => `INSERT INTO institute_hall_tickets (id, institute_id, exam_id, application_id, roll_number, candidate_name, exam_date, qr_token_hash)
      VALUES ('${id}', 'it-ws-inst', 'it-ws-exam', 'it-ws-app', '${roll}', 'Synthetic Candidate', '2027-01-20', '${'a'.repeat(64)}')`;
    assert.equal(await probe(ticket('it-ws-t1', 'IT-ROLL-1')), null, 'first admit card');
    assert.match(await probe(ticket('it-ws-t2', 'IT-ROLL-2')) ?? 'succeeded', /institute_hall_tickets_application_idx/, 'a second card for the same application is refused even with a new roll number');

    assert.equal(await probe(`INSERT INTO institute_attendance_logs (id, institute_id, exam_id, roll_number, candidate_name, status, source, reason)
      VALUES ('it-ws-mark', 'it-ws-inst', 'it-ws-exam', 'IT-ROLL-1', 'Synthetic Candidate', 'present', 'manual', 'Synthetic')`), null);
    assert.match(await probe("UPDATE institute_attendance_logs SET status = 'absent' WHERE id = 'it-ws-mark'") ?? 'succeeded', /permission denied/, 'a mark cannot be edited');
    assert.match(await probe("DELETE FROM institute_attendance_logs WHERE id = 'it-ws-mark'") ?? 'succeeded', /permission denied/, 'a mark cannot be deleted');

    assert.equal(await one("SELECT to_regclass('public.institute_settings') IS NULL"), true, 'the unimplemented settings table does not exist');
    for (const [table, column] of [['institute_exams', 'approved_by'], ['institute_hall_tickets', 'release_status'], ['institute_hall_tickets', 'released_at'],
      ['institute_exam_results', 'final_approved_by'], ['institute_exam_results', 'published_at']]) {
      assert.equal(await one(`SELECT has_column_privilege('eltnoy_app', '${table}', '${column}', 'UPDATE')`), true, `${table}.${column} (Super Admin review routes)`);
    }
    assert.equal(await one("SELECT has_table_privilege('eltnoy_app', 'institute_exam_results', 'DELETE')"), false, 'results are never deleted by the API');
  } finally {
    await q('ROLLBACK');
  }
});

test('INSTITUTE WORKSPACE: one Training enrolment per learner per course, also under concurrent requests (eltnoy_app)', { skip }, async () => {
  const { TRAINING_SQL } = await import('./instituteWorkspace.js');
  const { db, end } = appDatabase();
  const institute = `it-ws-tr-${randomUUID().slice(0, 8)}`;
  const course = randomUUID();
  const otherCourse = randomUUID();
  await q("INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ($1, upper($1), 'IT Training institute', 'center', '!synthetic')", [institute]);
  try {
    for (const id of [course, otherCourse]) {
      await db.query(TRAINING_SQL.insertCourse, [id, institute, 'IT Synthetic Course', 'General', 3]);
    }
    const enrol = (courseId: string, name: string, email: string) => db.query(TRAINING_SQL.insertEnrollment, [randomUUID(), institute, courseId, name, email]);

    // Eight simultaneous requests for the same learner: exactly one row is written; the rest insert nothing.
    const racing = await Promise.all(Array.from({ length: 8 }, () => enrol(course, 'IT Learner', 'it.learner@example.test')));
    assert.equal(racing.reduce((sum, result) => sum + (result.rowCount ?? 0), 0), 1, 'one enrolment wins the race');
    const count = async (courseId: string) => Number((await q('SELECT count(*)::int AS n FROM institute_training_enrollments WHERE course_id = $1', [courseId]))[0].n);
    assert.equal(await count(course), 1);

    assert.equal((await enrol(course, 'IT Learner Renamed', 'IT.Learner@Example.test')).rowCount, 0, 'the same email in another case is the same learner');
    assert.equal((await enrol(otherCourse, 'IT Learner', 'it.learner@example.test')).rowCount, 1, 'the same learner may join another course');
    assert.equal((await enrol(course, 'IT Learner', 'it.other@example.test')).rowCount, 1, 'a same-named learner with another email is a different person');

    const noEmail = await Promise.all(Array.from({ length: 4 }, () => enrol(course, 'IT Walk-in', '')));
    assert.equal(noEmail.reduce((sum, result) => sum + (result.rowCount ?? 0), 0), 1, 'without an email, a repeated name is refused, also concurrently');
    assert.equal((await enrol(course, '  it walk-in ', '')).rowCount, 0, 'name comparison ignores case and surrounding spaces');
    assert.equal(await count(course), 3);
  } finally {
    await end();
    await q('DELETE FROM users WHERE id = $1', [institute]); // cascades to the synthetic course and enrolments
  }
});

test('INSTITUTE WORKSPACE: interview cancel and reschedule through the real routes as eltnoy_app (conflicts, concurrency, freed slots, history, ownership)', { skip }, async () => {
  const [{ createInstituteWorkspaceRouter, INTERVIEW_SQL }, dbModule] = await Promise.all([import('./instituteWorkspace.js'), import('./db.js')]);
  const { db, end } = appDatabase();
  // The routes use the shared pool; point it at this disposable database (as eltnoy_app) for this test only.
  const shared = dbModule.pool as unknown as { connect: unknown; query: unknown };
  const original = { connect: shared.connect, query: shared.query };
  shared.connect = db.connect;
  shared.query = db.query;
  const router = createInstituteWorkspaceRouter();
  const invoke = (method: 'get' | 'post', path: string, user: string, params: Record<string, string> = {}, body: unknown = {}) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const layer = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown }> } }>)
      .find((item) => item.route?.path === path && item.route.methods[method]);
    if (!layer) { reject(new Error(`${method} ${path}`)); return; }
    let status = 200;
    const res = { status(code: number) { status = code; return res; }, set() { return res; }, json(value: Record<string, unknown>) { resolve({ status, body: value }); return res; } };
    Promise.resolve(layer.route!.stack.at(-1)!.handle({ params, body, query: {}, user: { id: user, role: 'center', isSuperAdmin: false } }, res, (error) => (error ? reject(error) : resolve({ status, body: {} })))).catch(reject);
  });
  const institute = `it-ws-iv-${randomUUID().slice(0, 8)}`;
  const other = `it-ws-iv2-${randomUUID().slice(0, 8)}`;
  for (const id of [institute, other]) await q("INSERT INTO users (id, login_id, display_name, role, password_hash) VALUES ($1, upper($1), 'IT Interview institute', 'center', '!synthetic')", [id]);
  const day = '2099-06-01';
  const book = (panelName: string, panelistNames: string, startTime: string, endTime: string) =>
    invoke('post', '/center/interviews', institute, {}, { candidateName: 'IT Candidate', panelName, panelistNames, scheduledDate: day, startTime, endTime });
  try {
    const a = await book('Panel A', 'IT Asha, IT Bala', '10:00', '10:30');
    assert.equal(a.status, 201);
    const aId = String((a.body.interview as { id: string }).id);
    const b = await book('Panel B', 'IT Chitra', '12:00', '12:30');
    const bId = String((b.body.interview as { id: string }).id);

    // A different panel that shares a panelist cannot overlap.
    const shared = await book('Panel C', 'it bala', '10:15', '10:45');
    assert.deepEqual([shared.status, shared.body.code], [409, 'PANEL_CONFLICT'], 'shared panelist across panels');

    // Seven concurrent claims on one panelist's 14:00 slot: one reschedule and six new bookings. Exactly one wins.
    const racers = await Promise.all([
      invoke('post', '/center/interviews/:id/reschedule', institute, { id: bId }, { scheduledDate: day, startTime: '14:00', endTime: '14:30', panelistNames: 'IT Devi', reason: 'IT race reschedule' }),
      ...Array.from({ length: 6 }, (_, i) => book(`Panel R${i}`, 'IT Devi', '14:00', '14:30')),
    ]);
    assert.equal(racers.filter((r) => r.status === 200 || r.status === 201).length, 1, 'one claim on the slot succeeds');
    assert.ok(racers.every((r) => [200, 201, 409].includes(r.status)));
    const devi = await q(`SELECT count(*)::int AS n FROM institute_interviews WHERE institute_id = $1 AND scheduled_date = $2 AND status <> 'cancelled' AND panelist_names ILIKE '%IT Devi%' AND start_time = '14:00'`, [institute, day]);
    assert.equal(devi[0].n, 1);

    // Ownership: another Institute's cancel and reschedule look like unknown interviews.
    assert.equal((await invoke('post', '/center/interviews/:id/cancel', other, { id: aId }, { reason: 'IT foreign cancel' })).status, 404);
    assert.equal((await invoke('post', '/center/interviews/:id/reschedule', other, { id: aId }, { scheduledDate: day, startTime: '16:00', endTime: '16:30', reason: 'IT foreign move' })).status, 404);

    // Cancel A: its slot (and panelist IT Bala) is free again.
    const cancelled = await invoke('post', '/center/interviews/:id/cancel', institute, { id: aId }, { reason: 'IT candidate withdrew' });
    assert.equal(cancelled.status, 200);
    assert.equal((await book('Panel C', 'IT Bala', '10:15', '10:45')).status, 201, 'the cancelled slot is available again');
    assert.equal((await invoke('post', '/center/interviews/:id/cancel', institute, { id: aId }, { reason: 'IT cancel twice' })).body.code, 'INTERVIEW_CANCELLED');

    // History: earlier details kept; the API role cannot rewrite or delete it.
    const history = await q('SELECT action, reason, previous_json, new_json FROM institute_interview_changes WHERE institute_id = $1 ORDER BY created_at', [institute]);
    const cancelRow = history.find((row) => row.action === 'cancelled')!;
    assert.deepEqual([cancelRow.reason, cancelRow.previous_json.startTime, cancelRow.previous_json.panelistNames, cancelRow.new_json], ['IT candidate withdrew', '10:00', 'IT Asha, IT Bala', null]);
    const e = await book('Panel E', 'IT Esha', '16:00', '16:30');
    const eId = String((e.body.interview as { id: string }).id);
    const moved = await invoke('post', '/center/interviews/:id/reschedule', institute, { id: eId }, { scheduledDate: '2099-06-02', startTime: '17:00', endTime: '17:45', panelName: 'Panel F', reason: 'IT panel moved' });
    assert.equal(moved.status, 200);
    const [movedRow] = await q("SELECT to_char(scheduled_date, 'YYYY-MM-DD') AS d, start_time, panel_name FROM institute_interviews WHERE id = $1", [eId]);
    assert.deepEqual([movedRow.d, movedRow.start_time, movedRow.panel_name], ['2099-06-02', '17:00', 'Panel F']);
    const [eHistory] = await q("SELECT reason, previous_json, new_json FROM institute_interview_changes WHERE interview_id = $1 AND action = 'rescheduled'", [eId]);
    assert.deepEqual([eHistory.reason, eHistory.previous_json.scheduledDate, eHistory.previous_json.startTime, eHistory.previous_json.panelName], ['IT panel moved', day, '16:00', 'Panel E'], 'the earlier date, time and panel are kept');
    assert.deepEqual([eHistory.new_json.scheduledDate, eHistory.new_json.startTime, eHistory.new_json.endTime], ['2099-06-02', '17:00', '17:45']);
    assert.equal((await book('Panel E', 'IT Esha', '16:00', '16:30')).status, 201, 'the slot it left is free again');
    for (const sql of ["UPDATE institute_interview_changes SET reason = 'rewritten'", 'DELETE FROM institute_interview_changes']) {
      const error = await db.query(sql).then(() => null, (e: Error) => e.message);
      assert.match(error ?? 'succeeded', /permission denied/, sql);
    }

    // A held interview (it has a scorecard) can no longer be cancelled or rescheduled.
    const heldId = randomUUID();
    await q(`INSERT INTO institute_interviews (id, institute_id, candidate_name, panel_name, scheduled_date, start_time, end_time) VALUES ($1, $2, 'IT Held', 'Panel H', '2020-01-01', '09:00', '09:30')`, [heldId, institute]);
    await q(`INSERT INTO institute_interview_scorecards (id, institute_id, interview_id, panelist_name, subject_score, communication_score, pedagogy_score, problem_solving_score) VALUES ($1, $2, $3, 'IT Asha', 7, 7, 7, 7)`, [randomUUID(), institute, heldId]);
    assert.equal((await invoke('post', '/center/interviews/:id/cancel', institute, { id: heldId }, { reason: 'IT late cancel' })).body.code, 'INTERVIEW_HELD');
    assert.equal((await invoke('post', '/center/interviews/:id/reschedule', institute, { id: heldId }, { scheduledDate: day, startTime: '18:00', endTime: '18:30', reason: 'IT late move' })).body.code, 'INTERVIEW_HELD');
    assert.ok(INTERVIEW_SQL.current.includes('FOR UPDATE'));
  } finally {
    shared.connect = original.connect;
    shared.query = original.query;
    await end();
    await q('DELETE FROM users WHERE id = ANY($1)', [[institute, other]]); // cascades to the synthetic interviews and history
  }
});
