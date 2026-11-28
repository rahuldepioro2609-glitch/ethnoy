// Grant-coverage tests for the final migration (server/databaseGrantsMigration.sql) and the
// one-time role bootstrap (server/databaseRoleBootstrap.sql). Static: no database is used.
//
// They fail when:
// - a table or sequence is added to a migration without a grant-manifest entry (or an entry is stale);
// - the manifest grants anything beyond SELECT, INSERT, UPDATE, or touches a protected column;
// - an append-only table (one with an UPDATE/DELETE-rejecting trigger) is granted UPDATE;
// - API code inserts into, updates, or row-locks a table without the matching grant, truncates
//   anything, or deletes from any table other than the AUTH C1 claims table (bounded cleanup only);
// - either SQL file gains role, password, ownership, data or transaction statements it must not have.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATION_FILES } from './migrate.js';

const SERVER_DIR = new URL('./', import.meta.url);
const GRANTS_FILE = 'databaseGrantsMigration.sql';
const BOOTSTRAP_FILE = 'databaseRoleBootstrap.sql';
const PRESERVED_UNGRANTED_LEGACY_TABLES = [
  'answer_key_objection_windows', 'answer_key_objections', 'auth_tokens', 'uploaded_files',
];

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
  const row = /\('(\w+)',\s*'([A-Z, ]*)',\s*(NULL(?:::text\[\])?|ARRAY\[([^\]]*)\](?:::text\[\])?)\)/g;
  for (const [, table, privileges, , columns] of block[1].matchAll(row)) {
    assert.ok(!manifest.has(table), `manifest lists ${table} twice`);
    manifest.set(table, {
      privileges: privileges ? privileges.split(',').map((p) => p.trim()) : [],
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
  platform_staff_accounts: ['id', 'staff_id', 'display_name', 'created_by', 'created_at'],
  platform_staff_account_roles: ['id', 'account_id', 'role_id', 'granted_by', 'granted_at'],
  platform_staff_sessions: ['token_hash', 'account_id', 'created_at', 'expires_at'],
  org_staff_members: ['id', 'organization_id', 'staff_id', 'display_name', 'invited_by', 'created_at'],
  org_staff_invitations: ['id', 'member_id', 'organization_id', 'code_hash', 'created_at', 'expires_at'],
  org_staff_member_roles: ['id', 'member_id', 'organization_id', 'role_code', 'granted_by', 'granted_at'],
  org_staff_sessions: ['token_hash', 'member_id', 'organization_id', 'created_at', 'expires_at'],
};

test('grant manifest covers exactly the tables created by the migrations', async () => {
  const [manifest, { tables }] = await Promise.all([loadManifest(), loadSchema()]);
  const missing = [...tables.keys()].filter((t) => !manifest.has(t)).sort();
  const stale = [...manifest.keys()].filter((t) => !tables.has(t) && !PRESERVED_UNGRANTED_LEGACY_TABLES.includes(t)).sort();
  assert.deepEqual(missing, [], `tables without a grant-manifest entry: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `grant-manifest entries for tables that no migration creates: ${stale.join(', ')}`);
  for (const table of PRESERVED_UNGRANTED_LEGACY_TABLES) {
    assert.deepEqual(manifest.get(table), { privileges: [], updateColumns: [] }, `${table} stays inaccessible to the API`);
  }
  assert.equal(tables.size, 77, '24 existing tables, 7 AUTH-1 tables, the AUTH C1 claims table, 6 MFA tables, 14 Staff tables and 25 Institute Workspace tables');
});

// AUTH C1.8, MFA Phase 2 (adminMfaMigration.sql): exactly these six entries. No DELETE, no table-wide
// UPDATE; column UPDATE only on workflow state columns; the session evidence table is insert-only.
const MFA_MANIFEST: Record<string, ManifestEntry> = {
  admin_mfa_challenges: { privileges: ['SELECT', 'INSERT'], updateColumns: ['attempts', 'enrolment_ticket_id', 'consumed_at', 'consumed_reason'] },
  admin_mfa_enrolment_tickets: { privileges: ['SELECT', 'INSERT'], updateColumns: ['used_at', 'revoked_at'] },
  admin_mfa_factors: { privileges: ['SELECT', 'INSERT'], updateColumns: ['last_used_step', 'disabled_at', 'disabled_by', 'disabled_via'] },
  admin_mfa_recovery_codes: { privileges: ['SELECT', 'INSERT'], updateColumns: ['used_at', 'revoked_at'] },
  admin_mfa_reset_requests: { privileges: ['SELECT', 'INSERT'], updateColumns: ['status', 'decided_by', 'decided_verification_id', 'decision_reason', 'ticket_id'] },
  auth_session_mfa_verifications: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
};
const MFA_TABLES = Object.keys(MFA_MANIFEST);

/**
 * AUTH C1.9.1 (MFA P3a-1) writes exactly these granted MFA columns (server/adminMfaStore.ts): attempt
 * reservation and challenge closing, and the TOTP replay guard.
 */
const MFA_PHASE3_COLUMNS = ['admin_mfa_challenges.attempts', 'admin_mfa_challenges.consumed_at', 'admin_mfa_challenges.consumed_reason', 'admin_mfa_factors.last_used_step'];
const MFA_PHASE4_COLUMNS = ['admin_mfa_challenges.enrolment_ticket_id'];
/**
 * MFA columns granted in Phase 2 whose legitimate writers arrive in later phases, and ONLY these, are
 * exempt from the "no unused UPDATE grant" rule:
 * - Phase 4 (enrolment): challenge ticket binding, factor supersession, and ticket use. Confirmation
 *   is performed by the narrowly scoped database operation, not a direct app-role column grant.
 * - Phase 5 (recovery codes): code use and revocation;
 * - Phase 6 (resets): factor disabling, ticket revocation, request decisions.
 * The exemption test proves that each one is still unwritten; a phase that starts writing one must remove it.
 */
const MFA_PENDING_COLUMNS = new Set([
  'admin_mfa_enrolment_tickets.used_at', 'admin_mfa_enrolment_tickets.revoked_at',
  'admin_mfa_factors.disabled_at', 'admin_mfa_factors.disabled_by', 'admin_mfa_factors.disabled_via',
  'admin_mfa_recovery_codes.used_at', 'admin_mfa_recovery_codes.revoked_at',
  'admin_mfa_reset_requests.status', 'admin_mfa_reset_requests.decided_by', 'admin_mfa_reset_requests.decided_verification_id',
  'admin_mfa_reset_requests.decision_reason', 'admin_mfa_reset_requests.ticket_id',
]);

/** Columns assigned by UPDATE ... SET in server code, as "table.column" (the same parsing as the inventory test). */
async function assignedColumns(): Promise<Set<string>> {
  const assigned = new Set<string>();
  for (const { sql } of await sqlStatements()) {
    for (const [, table, assignments] of sql.matchAll(/\bUPDATE (\w+)(?: (?!SET\b)\w+)? SET (.*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|$)/g)) {
      for (const [, column] of assignments.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/g)) assigned.add(`${table}.${column}`);
    }
  }
  return assigned;
}

test('AUTH C1.8: the six MFA tables carry exactly the approved grants; never DELETE, identity, secret or hash columns', async () => {
  const [manifest, { tables }] = await Promise.all([loadManifest(), loadSchema()]);
  for (const table of MFA_TABLES) {
    assert.ok(tables.has(table), `${table} is created by a wired migration`);
    assert.deepEqual(manifest.get(table), MFA_MANIFEST[table], table);
  }
  const neverUpdatable: Record<string, string[]> = {
    admin_mfa_factors: ['id', 'user_id', 'kind', 'secret_ciphertext', 'secret_nonce', 'secret_tag', 'key_version', 'created_at'],
    admin_mfa_recovery_codes: ['id', 'user_id', 'factor_id', 'code_hash', 'created_at'],
    admin_mfa_challenges: ['id', 'user_id', 'purpose', 'session_token_hash', 'created_at', 'expires_at'],
    admin_mfa_enrolment_tickets: ['id', 'user_id', 'issued_by', 'issued_via', 'reset_request_id', 'created_at', 'expires_at'],
    admin_mfa_reset_requests: ['id', 'target_user_id', 'approval_mode', 'initiated_by', 'initiated_verification_id', 'reason', 'created_at', 'expires_at', 'decided_at'],
  };
  for (const [table, columns] of Object.entries(neverUpdatable)) {
    for (const column of columns) {
      assert.ok(tables.get(table)?.has(column), `${table}.${column} exists`);
      assert.ok(!manifest.get(table)!.updateColumns.includes(column), `${table}.${column} must never be updatable`);
    }
  }
});

test('AUTH C1.9.1: the unused-grant exemption is exactly the later-phase MFA columns, each still unwritten', async () => {
  const granted = Object.entries(MFA_MANIFEST).flatMap(([table, entry]) => entry.updateColumns.map((column) => `${table}.${column}`));
  assert.equal(granted.length, 17);
  // The pending exemption plus the Phase 3 and Phase 4 writers cover every grant, with no overlap.
  assert.deepEqual([...MFA_PENDING_COLUMNS, ...MFA_PHASE3_COLUMNS, ...MFA_PHASE4_COLUMNS].sort(), [...granted].sort());
  assert.equal(MFA_PENDING_COLUMNS.size, 12);
  const assigned = await assignedColumns();
  for (const column of MFA_PHASE3_COLUMNS) assert.ok(assigned.has(column), `${column} is written by Phase 3 code`);
  for (const column of MFA_PHASE4_COLUMNS) assert.ok(assigned.has(column), `${column} is written by Phase 4 code`);
  for (const column of MFA_PENDING_COLUMNS) {
    assert.ok(!assigned.has(column), `${column} is now written by server code: remove it from MFA_PENDING_COLUMNS`);
  }
  // Phase 3 login writes through the store; Phase 4 enrollment writes through adminMfa.ts;
  // auth.ts only reads MFA evidence for the Official session guard.
  const statements = await sqlStatements();
  const touching = new Set(statements.filter(({ sql }) => MFA_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(sql))).map(({ file }) => file));
  assert.deepEqual([...touching].sort(), ['adminMfa.ts', 'adminMfaStore.ts', 'auth.ts']);
  for (const { file, sql } of statements) {
    if (file === 'auth.ts' && MFA_TABLES.some((table) => sql.includes(table))) {
      assert.doesNotMatch(sql, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/, 'auth.ts only reads MFA tables');
    }
  }
});

test('enrollment confirmation is exposed only through its exact routine grant, never a direct factor-column update', async () => {
  const [manifest, grantsSql] = await Promise.all([
    loadManifest(),
    readServerFile(GRANTS_FILE).then(withoutComments),
  ]);
  assert.ok(!manifest.get('admin_mfa_factors')!.updateColumns.includes('confirmed_at'));
  assert.match(grantsSql,
    /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public\s+FROM PUBLIC, eltnoy_app, eltnoy_audit_writer, eltnoy_audit_reader, eltnoy_audit_verifier;\s+GRANT EXECUTE ON FUNCTION public\.confirm_admin_mfa_enrolment_factor\(text, text, text, text, bigint\)\s+TO eltnoy_app;/);
});

// AUTH C1 (studentRegistrationClaimsMigration.sql): the only table with DELETE, for expired-claim
// cleanup; UPDATE only on consumed_at (also enables the completion's row lock).
const CLAIMS_TABLE = 'student_registration_claims';
const C1_MANIFEST: ManifestEntry = { privileges: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['consumed_at'] };

test('AUTH C1: the claims table gets exactly SELECT, INSERT, DELETE and UPDATE (consumed_at); DELETE nowhere else', async () => {
  const [manifest, { tables }, grantsSql] = await Promise.all([loadManifest(), loadSchema(), readServerFile(GRANTS_FILE).then(withoutComments)]);
  assert.ok(tables.has(CLAIMS_TABLE), 'created by a wired migration');
  assert.deepEqual(manifest.get(CLAIMS_TABLE), C1_MANIFEST);
  const withDelete = [...manifest].filter(([, entry]) => entry.privileges.includes('DELETE')).map(([table]) => table);
  assert.deepEqual(withDelete, [CLAIMS_TABLE], 'no other table may be granted DELETE');
  for (const [table, entry] of manifest) {
    for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.ok(!entry.privileges.includes(privilege), `${table}: ${privilege}`);
  }
  // The grants migration itself refuses DELETE on any other table (fail closed if the manifest drifts).
  assert.match(grantsSql, /IF privs\[i\] ~ 'DELETE' AND tbls\[i\] <> 'student_registration_claims' THEN\s+RAISE EXCEPTION/);
  // verification_challenges keeps its AUTH-1 grants: registration_claim_id is written only on INSERT.
  assert.ok(!manifest.get('verification_challenges')!.updateColumns.includes('registration_claim_id'));
  assert.ok(!manifest.get('verification_challenges')!.updateColumns.includes('user_id'));
});

// AUTH-1 (authVerificationMigration.sql): exactly these seven entries. UPDATE columns are exactly the
// columns the server assigns; no table-wide UPDATE; the append-only audit and insert-only tables get none.
const AUTH1_MANIFEST: Record<string, ManifestEntry> = {
  account_contacts: { privileges: ['SELECT', 'INSERT'], updateColumns: ['destination', 'verified_at'] },
  auth_session_verifications: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  auth_verification_events: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  google_identities: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  institute_verifications: {
    privileges: ['SELECT', 'INSERT'],
    updateColumns: ['mobile_destination', 'mobile_verified_at', 'email_destination', 'email_verified_at', 'updated_at',
      'institutional_status', 'institutional_decided_at', 'institutional_decided_by', 'suspended_at', 'suspended_by'],
  },
  oauth_states: { privileges: ['SELECT', 'INSERT'], updateColumns: ['consumed_at'] },
  verification_challenges: {
    privileges: ['SELECT', 'INSERT'],
    updateColumns: ['destination', 'code_hash', 'code_expires_at', 'send_count', 'last_sent_at', 'attempts', 'consumed_at'],
  },
};

test('AUTH-1: the manifest grants exactly the seven AUTH-1 tables with least privilege', async () => {
  const [manifest, { tables }] = await Promise.all([loadManifest(), loadSchema()]);
  const auth1Tables = Object.keys(AUTH1_MANIFEST);
  assert.equal(auth1Tables.length, 7);
  for (const table of auth1Tables) {
    assert.ok(tables.has(table), `${table} is created by a wired migration`);
    assert.deepEqual(manifest.get(table), AUTH1_MANIFEST[table], table);
  }
  // Every other row is a pre-AUTH-1, AUTH C1, MFA, or Staff table with its own manifest checks.
});

const STAFF_MANIFEST: Record<string, ManifestEntry> = {
  platform_staff_departments: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  platform_staff_roles: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  platform_staff_permission_catalogue: { privileges: ['SELECT'], updateColumns: [] },
  platform_staff_role_permissions: { privileges: ['SELECT'], updateColumns: [] },
  platform_staff_accounts: { privileges: ['SELECT', 'INSERT'], updateColumns: ['password_hash', 'must_change_password', 'status', 'department_id', 'deactivated_at', 'deactivated_by'] },
  platform_staff_account_roles: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at', 'revoked_by'] },
  platform_staff_sessions: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at'] },
  platform_staff_audit_events: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
  org_staff_role_templates: { privileges: ['SELECT'], updateColumns: [] },
  org_staff_members: { privileges: ['SELECT', 'INSERT'], updateColumns: ['password_hash', 'accepted_at', 'status', 'activated_at', 'activated_by'] },
  org_staff_invitations: { privileges: ['SELECT', 'INSERT'], updateColumns: ['used_at'] },
  org_staff_member_roles: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at', 'revoked_by'] },
  org_staff_sessions: { privileges: ['SELECT', 'INSERT'], updateColumns: ['revoked_at'] },
  org_staff_audit_events: { privileges: ['SELECT', 'INSERT'], updateColumns: [] },
};

test('SM-1: Staff tables are wired with exact least-privilege application grants', async () => {
  const [manifest, { tables }] = await Promise.all([loadManifest(), loadSchema()]);
  assert.equal(Object.keys(STAFF_MANIFEST).length, 14);
  for (const [table, expected] of Object.entries(STAFF_MANIFEST)) {
    assert.ok(tables.has(table), `${table} is created by a wired migration`);
    assert.deepEqual(manifest.get(table), expected, table);
  }
  for (const [table, entry] of Object.entries(STAFF_MANIFEST)) {
    assert.ok(!entry.privileges.includes('DELETE'), `${table}: staff history is retained`);
    assert.ok(!entry.privileges.includes('TRUNCATE'), `${table}: API cannot truncate staff state`);
  }
});

test('migrations create no sequences without a sequence-manifest entry (currently none allowed)', async () => {
  const { sequences } = await loadSchema();
  const grantsSql = withoutComments(await readServerFile(GRANTS_FILE));
  const listed = /c\.relname <> ALL \(ARRAY\[([^\]]*)\]::text\[\]\)/.exec(grantsSql);
  assert.ok(listed, 'sequence manifest not found');
  const allowed = [...listed[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(sequences.filter((s) => !allowed.includes(s.split(' ')[0])), [], 'sequences need an explicit manifest entry and USAGE grant');
});

test('manifest grants only SELECT, INSERT and UPDATE (DELETE only on the AUTH C1 claims table), and never UPDATE on protected columns', async () => {
  const [manifest, { tables }] = await Promise.all([loadManifest(), loadSchema()]);
  for (const [table, entry] of manifest) {
    if (PRESERVED_UNGRANTED_LEGACY_TABLES.includes(table)) {
      assert.deepEqual(entry, { privileges: [], updateColumns: [] }, `${table}: preserved legacy data receives no API grants`);
      continue;
    }
    for (const privilege of entry.privileges) {
      const allowed = table === 'student_registration_claims' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : ['SELECT', 'INSERT', 'UPDATE'];
      assert.ok(allowed.includes(privilege), `${table}: ${privilege} is not allowed`);
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
    'auth_session_mfa_verifications', // AUTH C1.8: insert-only session MFA evidence
    'auth_verification_events', // AUTH-1: append-only audit
    'org_staff_audit_events', 'platform_staff_audit_events', // SM-1: append-only Staff audit
    'institute_resubmissions', 'institute_status_history', 'institution_document_review_history',
    'institution_document_versions', 'institution_documents',
  ].sort());
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

/**
 * Local-development operator CLIs. They never run inside the API process or as the application role
 * (the reset tool needs a password-hash UPDATE the app role must never have), so their SQL is not part
 * of the API privilege inventory. Each refuses non-loopback databases (localOperatorGuards.test.ts).
 */
const LOCAL_OPERATOR_TOOLS: readonly string[] = ['adminMfaLocalBootstrap.ts', 'resetSuperAdminPassword.ts'];

async function sqlStatements(): Promise<Array<{ file: string; sql: string }>> {
  const files = (await readdir(SERVER_DIR)).filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('integration')
    && !LOCAL_OPERATOR_TOOLS.includes(f));
  const statements: Array<{ file: string; sql: string }> = [];
  for (const file of files) {
    const source = await readServerFile(file);
    for (const [, template, singleQuoted, doubleQuoted] of source.matchAll(/`([^`]*)`|'((?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|WITH)\b[^'\n]*)'|"((?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|WITH)\b[^"\n]*)"/g)) {
      const sql = (template ?? singleQuoted ?? doubleQuoted).replace(/\$\{[^}]*\}/g, ' ');
      if (/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|TRUNCATE)\b/.test(sql) && /\b(FROM|INTO|SET|TRUNCATE)\b/.test(sql)) {
        statements.push({ file, sql: sql.replace(/\s+/g, ' ') });
      }
    }
  }
  return statements;
}

test('server code needs only privileges the manifest grants (never TRUNCATE; DELETE only from the claims table)', async () => {
  const [manifest, statements] = await Promise.all([loadManifest(), sqlStatements()]);
  const problems: string[] = [];
  const has = (table: string, privilege: string) => manifest.get(table)?.privileges.includes(privilege) ?? false;
  const canUpdate = (table: string, column?: string) => has(table, 'UPDATE')
    || (column ? manifest.get(table)?.updateColumns.includes(column) : (manifest.get(table)?.updateColumns.length ?? 0) > 0) || false;
  let checked = 0;
  const assigned = new Map<string, Set<string>>();
  const deleteForms = new Set<string>();

  for (const { file, sql } of statements) {
    if (!manifest.size) break;
    for (const [, table] of sql.matchAll(/\bDELETE FROM (\w+)/g)) {
      checked += 1;
      if (!has(table, 'DELETE')) problems.push(`${file}: DELETE FROM ${table} (the API role has no DELETE there)`);
      // AUTH C1/C1.1: exactly two bounded forms. Cleanup: expired or consumed claims without a live
      // challenge, batched with SKIP LOCKED. Completion: the one claim being completed, by id.
      else {
        const cleanup = /\(c\.consumed_at IS NOT NULL OR c\.expires_at <= \$1\)/.test(sql) && /NOT EXISTS \(SELECT 1 FROM verification_challenges v WHERE v\.registration_claim_id = c\.id AND v\.consumed_at IS NULL AND v\.expires_at > \$1\)/.test(sql) && /LIMIT \$2 FOR UPDATE SKIP LOCKED/.test(sql);
        const completion = sql.trim() === 'DELETE FROM student_registration_claims WHERE id = $1';
        if (!cleanup && !completion) problems.push(`${file}: unbounded DELETE FROM ${table}`);
        else deleteForms.add(cleanup ? 'cleanup' : 'completion');
      }
    }
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
  assert.deepEqual([...deleteForms].sort(), ['cleanup', 'completion'], 'both approved claim DELETE forms were inspected');

  // No unnecessary grants (OD-P4): every granted UPDATE column is assigned by some server statement,
  // except declared lock-only columns, which exist only to permit SELECT ... FOR UPDATE.
  const unused: string[] = [];
  for (const [table, entry] of manifest) {
    for (const column of entry.updateColumns) {
      if (LOCK_ONLY_COLUMNS[table]?.includes(column)) continue;
      if (MFA_PENDING_COLUMNS.has(`${table}.${column}`)) continue; // AUTH C1.8: see the exemption test
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
