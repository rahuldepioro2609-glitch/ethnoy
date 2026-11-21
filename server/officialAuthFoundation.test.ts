import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATION_FILES } from './migrate.js';

const migration = await readFile(new URL('./officialAuthFoundationMigration.sql', import.meta.url), 'utf8');
const roles = await readFile(new URL('./officialAuthFoundationRoles.sql', import.meta.url), 'utf8');
const schemaBootstrap = await readFile(new URL('./officialAuthFoundationSchemaBootstrap.sql', import.meta.url), 'utf8');
const publicGrants = await readFile(new URL('./officialAuthFoundationPublicGrants.sql', import.meta.url), 'utf8');
const grants = await readFile(new URL('./officialAuthFoundationGrants.sql', import.meta.url), 'utf8');
const postgresIntegration = await readFile(
  new URL('./officialAuthFoundation.postgres.integration.test.ts', import.meta.url),
  'utf8',
);
const migrationStatements = migration
  .replace(/--[^\n]*/g, '')
  .replace(/\$([a-zA-Z_]\w*)\$[\s\S]*?\$\1\$/g, '$body$');
const tables = [
  'credentials',
  'credential_events',
  'auth_transactions',
  'assertion_consumptions',
  'mfa_factors',
  'mfa_challenges',
  'enrolment_tickets',
  'recovery_codes',
  'reset_requests',
  'official_sessions',
  'session_mfa_evidence',
  'audit_events',
];
const functionBody = (name: string): string => {
  const definition = migration.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION official_auth\\.${name}\\([\\s\\S]*?AS \\$([a-zA-Z_]\\w*)\\$([\\s\\S]*?)\\$\\1\\$;`,
    ),
  );
  assert.ok(definition, `function ${name} must be defined`);
  return definition[2];
};
const tableDefinition = (name: string): string => {
  const definition = migration.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS official_auth\\.${name} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(definition, `table ${name} must be defined`);
  return definition[1];
};

test('Phase 2B artifacts are opt-in and excluded from the application migration runner', () => {
  for (const file of [
    'officialAuthFoundationMigration.sql',
    'officialAuthFoundationRoles.sql',
    'officialAuthFoundationSchemaBootstrap.sql',
    'officialAuthFoundationPublicGrants.sql',
    'officialAuthFoundationGrants.sql',
  ]) {
    assert.ok(!new Set<string>(MIGRATION_FILES).has(file), `${file} must remain unwired`);
  }
});

test('additive schema migration creates all required tables without altering existing authentication tables', () => {
  const created = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS official_auth\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(created.sort(), [...tables].sort());
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP)\s+(?:TABLE|COLUMN)\s+(?:public\.users|users|auth_sessions|admin_mfa_\w+)/i);
  assert.doesNotMatch(migrationStatements, /\b(?:INSERT\s+INTO|UPDATE\s+public\.users|DELETE\s+FROM|TRUNCATE\s+(?:TABLE|ONLY))\b/i);
  assert.doesNotMatch(migrationStatements, /^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im);
  assert.match(migration, /current_user <> 'official_auth_owner'/);
  assert.match(migration, /official_auth\.apply_foundation/);
});

test('creation order and composite foreign-key targets are valid', () => {
  const positions = new Map(
    [...migration.matchAll(/CREATE TABLE IF NOT EXISTS official_auth\.(\w+)/g)]
      .map((match) => [match[1], match.index ?? 0]),
  );
  assert.ok(positions.get('audit_events')! < migration.indexOf('CREATE TRIGGER official_auth_audit_events_immutable'));
  assert.match(migration, /UNIQUE \(transaction_id, user_id\)/);
  assert.match(migration, /FOREIGN KEY \(transaction_id, user_id\)\s+REFERENCES official_auth\.auth_transactions \(transaction_id, user_id\)/);
  assert.match(migration, /UNIQUE \(challenge_hash, user_id\)/);
  assert.match(migration, /FOREIGN KEY \(enrolment_challenge_id, user_id\)\s+REFERENCES official_auth\.mfa_challenges \(challenge_hash, user_id\)/);
  assert.match(migration, /UNIQUE \(ticket_hash, user_id\)/);
  assert.match(migration, /FOREIGN KEY \(enrolment_ticket_hash, user_id\)\s+REFERENCES official_auth\.enrolment_tickets \(ticket_hash, user_id\)/);
  const resetRequest = tableDefinition('reset_requests');
  const enrollmentTicket = tableDefinition('enrolment_tickets');
  assert.match(resetRequest, /UNIQUE \(request_id, target_user_id\)/);
  assert.match(enrollmentTicket, /UNIQUE \(ticket_hash, user_id\)/);
  const resetTicketConstraints = migration.match(
    /ALTER TABLE official_auth\.enrolment_tickets\s+ADD CONSTRAINT official_auth_ticket_reset_request_fkey\s+FOREIGN KEY \(reset_request_id, user_id\)\s+REFERENCES official_auth\.reset_requests \(request_id, target_user_id\)[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  const resetRequestConstraints = migration.match(
    /ALTER TABLE official_auth\.reset_requests\s+ADD CONSTRAINT official_auth_reset_ticket_fkey\s+FOREIGN KEY \(ticket_hash, target_user_id\)\s+REFERENCES official_auth\.enrolment_tickets \(ticket_hash, user_id\)[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.ok(resetTicketConstraints, 'ticket reset-request FK must bind the ticket user to the reset target');
  assert.ok(resetRequestConstraints, 'reset request ticket FK must bind the reset target to the ticket user');
  assert.doesNotMatch(migration, /FOREIGN KEY \(reset_request_id\)\s+REFERENCES official_auth\.reset_requests/);
  assert.doesNotMatch(migration, /FOREIGN KEY \(ticket_hash\)\s+REFERENCES official_auth\.enrolment_tickets/);
  for (const [table, body] of migration.matchAll(
    /CREATE TABLE IF NOT EXISTS official_auth\.(\w+) \(([\s\S]*?)\n\);/g,
  )) {
    const tablePosition = positions.get(table)!;
    for (const [, referencedTable] of body.matchAll(/REFERENCES official_auth\.(\w+)/g)) {
      assert.ok(
        positions.get(referencedTable)! < tablePosition,
        `${table} must not declare an inline FK to later table ${referencedTable}`,
      );
    }
  }
});

test('credentials retain bcrypt without plaintext password columns', () => {
  assert.match(migration, /password_hash text NOT NULL/);
  assert.match(migration, /hash_scheme text NOT NULL DEFAULT 'bcrypt' CHECK \(hash_scheme = 'bcrypt'\)/);
  assert.match(migration, /password_hash ~ '\^\\\$2\[aby\]\\\$/);
  assert.doesNotMatch(migration, /\b(?:plaintext_password|raw_password|password text)\b/i);
});

test('bearer, challenge, assertion, and recovery values are represented by hashes only', () => {
  assert.match(migration, /challenge_hash char\(64\)/);
  assert.match(migration, /browser_binding_hash char\(64\)/);
  assert.match(migration, /session_token_hash char\(64\)/);
  assert.match(migration, /ticket_hash char\(64\)/);
  assert.match(migration, /code_hash char\(64\)/);
  assert.doesNotMatch(migration, /\b(?:raw_token|session_token|challenge_token|recovery_code|assertion_jwt)\s+(?:text|varchar|bytea)\b/i);
});

test('MFA envelope versions and factor ownership remain explicit', () => {
  assert.match(migration, /aad_version smallint NOT NULL CHECK \(aad_version IN \(1, 2\)\)/);
  assert.match(migration, /key_version integer NOT NULL CHECK \(key_version >= 1\)/);
  assert.match(migration, /FOREIGN KEY \(factor_id, user_id\)\s+REFERENCES official_auth\.mfa_factors \(factor_id, user_id\)/);
  assert.match(migration, /last_used_step < OLD\.last_used_step/);
  assert.match(migration, /MFA replay counter can only increase/);
});

test('transaction and session bounds do not encode unapproved maximum lifetimes', () => {
  assert.match(migration, /CONSTRAINT official_auth_transactions_lifetime_check CHECK \(expires_at > created_at\)/);
  assert.match(migration, /CONSTRAINT official_auth_sessions_time_check CHECK \(expires_at > created_at\)/);
  assert.doesNotMatch(migration, /expires_at\s*<=?\s*created_at\s*\+\s*INTERVAL/i);
  assert.doesNotMatch(migration, /INTERVAL\s+'(?:[1-9]\d*)\s+(?:second|minute|hour|day)s?'/i);
  const transactionGuard = functionBody('protect_auth_transaction_state');
  assert.match(transactionGuard, /IF TG_OP = 'INSERT' THEN[\s\S]*?NEW\.state <> 'pending'[\s\S]*?NEW\.completed_at IS NOT NULL[\s\S]*?NEW\.consumed_at IS NOT NULL/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON official_auth\.auth_transactions/);
  assert.match(postgresIntegration, /'completed'[\s\S]*?\/must start pending\//);
  assert.match(postgresIntegration, /'consumed'[\s\S]*?\/must start pending\//);
});

test('session revocation is terminal and session identity is immutable', () => {
  const sessionGuard = functionBody('protect_official_session_state');
  const credentialGuard = functionBody('protect_credential_state');
  assert.match(sessionGuard, /NEW\.session_token_hash IS DISTINCT FROM OLD\.session_token_hash[\s\S]*?NEW\.credential_version IS DISTINCT FROM OLD\.credential_version[\s\S]*?NEW\.expires_at IS DISTINCT FROM OLD\.expires_at/);
  assert.match(sessionGuard, /IF OLD\.revoked_at IS NOT NULL AND NEW\.revoked_at IS DISTINCT FROM OLD\.revoked_at THEN[\s\S]*?RAISE EXCEPTION/);
  assert.match(sessionGuard, /IF OLD\.revoked_at IS NULL AND NEW\.revoked_at IS NOT NULL THEN[\s\S]*?NEW\.revoked_at := clock_timestamp\(\)/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON official_auth\.official_sessions/);
  assert.match(sessionGuard, /current_credential_version IS DISTINCT FROM NEW\.credential_version[\s\S]*?current_credential_state IS DISTINCT FROM 'active'/);
  assert.match(postgresIntegration, /c\.credential_version = s\.credential_version[\s\S]*?c\.credential_state = 'active'/);
  assert.match(credentialGuard, /NEW\.credential_version < OLD\.credential_version/);
  assert.match(credentialGuard, /NEW\.password_hash IS DISTINCT FROM OLD\.password_hash[\s\S]*?NEW\.credential_version <= OLD\.credential_version/);
  assert.match(credentialGuard, /NEW\.credential_state IS DISTINCT FROM OLD\.credential_state[\s\S]*?NEW\.credential_version <= OLD\.credential_version/);
  assert.match(postgresIntegration, /SET revoked_at = NULL[\s\S]*?\/revocation is terminal\//);
  assert.match(postgresIntegration, /SET revoked_at = revoked_at \+ interval '1 second'[\s\S]*?\/revocation is terminal\//);
  assert.match(postgresIntegration, /SET credential_version = 1[\s\S]*?\/credential version cannot decrease\//);
  assert.match(postgresIntegration, /SET password_hash = '\$\{updatedBcryptHash\}'[\s\S]*?\/changing the password hash requires a higher credential version\//);
  assert.match(postgresIntegration, /SET password_hash = \$1, credential_version = 2/);
  assert.match(postgresIntegration, /assert\.equal\(invalidatedSession\.rowCount, 0\)/);
  assert.match(postgresIntegration, /session credential version must match an active credential/);
  assert.match(migration, /ALTER TABLE official_auth\.official_sessions ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY official_auth_sessions_live_select[\s\S]*?FOR SELECT[\s\S]*?TO official_verifier, official_session_gateway[\s\S]*?revoked_at IS NULL[\s\S]*?expires_at > clock_timestamp\(\)[\s\S]*?c\.credential_version = official_sessions\.credential_version[\s\S]*?c\.credential_state = 'active'/);
  assert.match(migration, /CREATE POLICY official_auth_sessions_gateway_insert[\s\S]*?FOR INSERT[\s\S]*?TO official_session_gateway/);
  assert.match(migration, /CREATE POLICY official_auth_sessions_gateway_revoke[\s\S]*?FOR UPDATE[\s\S]*?TO official_session_gateway/);
});

test('terminal audit and MFA evidence cannot be updated, deleted, or truncated', () => {
  for (const table of ['credential_events', 'session_mfa_evidence', 'audit_events']) {
    assert.match(migration, new RegExp(`BEFORE UPDATE OR DELETE ON official_auth\\.${table}`));
    assert.match(migration, new RegExp(`BEFORE TRUNCATE ON official_auth\\.${table}`));
  }
});

test('role bootstrap is guarded and runtime identities have no privileged memberships', () => {
  for (const artifact of [roles, schemaBootstrap, publicGrants, grants]) {
    assert.match(artifact, /official_auth_foundation_test/);
    assert.match(artifact, /server_version_num/);
    assert.match(artifact, /official_auth\.disposable_test/);
    assert.match(artifact, /127\.0\.0\.1/);
  }
  assert.match(roles, /NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(roles, /GRANT official_auth_owner TO official_auth_migrator WITH INHERIT FALSE, SET TRUE/);
  assert.match(roles, /official_verifier.*official_session_gateway.*eltnoy_app/s);
  assert.doesNotMatch(roles, /PASSWORD\s+'|LOGIN\s+PASSWORD/i);
});

test('permission manifest keeps app, verifier, and gateway boundaries separate', () => {
  assert.match(grants, /REVOKE ALL ON SCHEMA official_auth FROM PUBLIC, eltnoy_app, official_verifier, official_session_gateway/);
  assert.match(grants, /GRANT SELECT ON official_auth\.credentials TO official_verifier/);
  assert.doesNotMatch(grants, /GRANT SELECT ON official_auth\.credentials TO official_session_gateway/i);
  assert.match(grants, /GRANT SELECT, INSERT ON official_auth\.official_sessions TO official_session_gateway/);
  assert.match(grants, /GRANT INSERT \(challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at\)\s+ON official_auth\.mfa_challenges TO official_session_gateway/);
  assert.match(grants, /GRANT SELECT \(user_id, credential_version, credential_state\)\s+ON official_auth\.credentials TO official_session_gateway/);
  assert.match(migration, /the session gateway may create only step-up MFA challenges/);
  assert.match(grants, /GRANT SELECT \(session_token_hash, user_id, credential_version, expires_at, revoked_at\)\s+ON official_auth\.official_sessions TO official_verifier/);
  assert.doesNotMatch(grants, /GRANT SELECT ON official_auth\.official_sessions TO official_verifier/i);
  assert.doesNotMatch(grants, /GRANT SELECT, INSERT ON official_auth\.official_sessions TO official_verifier/i);
  const challengeGuard = functionBody('protect_mfa_challenge_state');
  assert.match(challengeGuard, /current_user = 'official_session_gateway' AND NEW\.purpose <> 'step_up'/);
  assert.doesNotMatch(challengeGuard, /current_user = 'official_verifier'.*step_up/);
  assert.match(challengeGuard, /s\.session_token_hash = NEW\.session_token_hash[\s\S]*?s\.user_id = NEW\.user_id[\s\S]*?s\.revoked_at IS NULL[\s\S]*?s\.expires_at > NEW\.created_at/);
  assert.match(postgresIntegration, /const liveStepUpTransaction[\s\S]*?insertVerifierStepUpChallenge/);
  assert.match(postgresIntegration, /missingSessionTransaction[\s\S]*?expiredSessionTransaction[\s\S]*?revokedSessionTransaction[\s\S]*?crossUserStepUpTransaction/);
  assert.match(postgresIntegration, /SELECT created_at FROM official_auth\.official_sessions/);
  assert.match(postgresIntegration, /actualTablePrivileges[\s\S]*?expectedTablePrivileges[\s\S]*?actualColumnPrivileges[\s\S]*?expectedColumnPrivileges[\s\S]*?functionPrivileges/);
  assert.match(postgresIntegration, /has_schema_privilege/);
  assert.match(postgresIntegration, /has_table_privilege/);
  assert.match(postgresIntegration, /has_function_privilege/);
  assert.match(grants, /GRANT SELECT \(factor_id, user_id, confirmed_at, disabled_at\)\s+ON official_auth\.mfa_factors TO official_session_gateway/);
  assert.doesNotMatch(grants, /GRANT [^;]* ON ALL TABLES|GRANT ALL/i);
  assert.match(grants, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA official_auth\s+FROM PUBLIC, eltnoy_app/);
});

test('no definer-rights helper or automatic authentication endpoint is introduced', () => {
  assert.doesNotMatch(migration, /\bSECURITY\s+DEFINER\b/i);
  for (const source of [migration, roles, schemaBootstrap, publicGrants, grants]) {
    assert.doesNotMatch(source, /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[^;]*(?:http|login_endpoint)/i);
  }
});
