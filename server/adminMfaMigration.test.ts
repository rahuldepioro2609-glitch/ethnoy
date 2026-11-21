// AUTH C1.8 (MFA Phase 2): static tests for server/adminMfaMigration.sql. No database is used.
// Behaviour against a real PostgreSQL server is covered by the MFA section of
// server/databaseGrants.postgres.integration.test.ts (disposable cluster only; separate approval to run).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATION_FILES } from './migrate.js';

const FILE = 'adminMfaMigration.sql';
const MFA_TABLES = [
  'admin_mfa_factors', 'admin_mfa_recovery_codes', 'auth_session_mfa_verifications',
  'admin_mfa_reset_requests', 'admin_mfa_enrolment_tickets', 'admin_mfa_challenges',
];

const raw = await readFile(new URL(`./${FILE}`, import.meta.url), 'utf8');
const sql = raw.replace(/--[^\n]*/g, '');
/** Dollar-quoted bodies collapsed, so statements can be split on semicolons. */
const statements = sql.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$').split(/;\s*(?=\n|$)/).map((s) => s.trim()).filter(Boolean);
const tableBody = (table: string): string => {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  assert.ok(match, `${table} definition`);
  return match[1].replace(/\s+/g, ' ');
};
const functionBody = (name: string): string => {
  const match = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(sql);
  assert.ok(match, `${name} definition`);
  return match[1].replace(/\s+/g, ' ');
};

// ---------------------------------------------------------------------------------------------
// Wiring and migration conventions
// ---------------------------------------------------------------------------------------------

test('wired once after auth prerequisites and before Staff and grants migrations', () => {
  const files = [...MIGRATION_FILES] as string[];
  assert.equal(files.filter((name) => name === FILE).length, 1);
  assert.equal(files.indexOf(FILE), files.indexOf('studentRegistrationClaimsMigration.sql') + 1);
  assert.ok(files.indexOf(FILE) < files.indexOf('platformStaffMigration.sql'), 'staff follows core auth/MFA schema');
  assert.ok(files.indexOf(FILE) < files.indexOf('databaseGrantsMigration.sql'), 'the grants manifest lists the MFA tables');
  assert.ok(files.indexOf(FILE) > files.indexOf('schema.sql') && files.indexOf(FILE) > files.indexOf('authVerificationMigration.sql'));
  assert.equal(files.indexOf('organizationStaffMigration.sql'), files.indexOf('platformStaffMigration.sql') + 1);
});

test('every statement is re-runnable, and every trigger is dropped before it is created', () => {
  for (const statement of statements) {
    assert.match(statement,
      /^(?:(?:CREATE TABLE IF NOT EXISTS|CREATE (?:UNIQUE )?INDEX IF NOT EXISTS|CREATE OR REPLACE FUNCTION|DROP TRIGGER IF EXISTS|CREATE (?:CONSTRAINT )?TRIGGER)\b|ALTER TABLE admin_mfa_factors ADD COLUMN IF NOT EXISTS enrolment_challenge_id text$|DO \$body\$$)/,
      `re-runnable: ${statement.slice(0, 80)}`);
  }
  for (const [, trigger, table] of sql.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE [A-Z ]+? ON (\w+)/g)) {
    assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${trigger} ON ${table};\\s*CREATE TRIGGER ${trigger}\\b`), trigger);
  }
  // AUTH C1.8.4: constraint triggers (no IF NOT EXISTS form exists) are dropped first as well.
  const constraintTriggers = [...sql.matchAll(/CREATE CONSTRAINT TRIGGER (\w+)\s+AFTER [A-Z ]+? ON (\w+)/g)];
  assert.equal(constraintTriggers.length, 3);
  for (const [, trigger, table] of constraintTriggers) {
    assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${trigger} ON ${table};\\s*CREATE CONSTRAINT TRIGGER ${trigger}\\b`), trigger);
  }
  // Every CREATE ... TRIGGER statement is covered by one of the two loops above.
  assert.equal([...sql.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER \w+/g)].length,
    [...sql.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE [A-Z ]+? ON (\w+)/g)].length + constraintTriggers.length);
  // Every ADD CONSTRAINT is guarded by a pg_constraint lookup.
  const adds = [...sql.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(adds, ['admin_mfa_factors_enrolment_challenge_fkey', 'admin_mfa_reset_requests_ticket_fkey']);
  assert.match(sql, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint\s+WHERE conname = 'admin_mfa_factors_enrolment_challenge_fkey'\s+AND conrelid = to_regclass\('admin_mfa_factors'\)\s*\) THEN\s+ALTER TABLE admin_mfa_factors\s+ADD CONSTRAINT admin_mfa_factors_enrolment_challenge_fkey\s+FOREIGN KEY \(enrolment_challenge_id, user_id\)\s+REFERENCES admin_mfa_challenges\(id, user_id\) ON DELETE RESTRICT;/);
  assert.match(sql, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint\s+WHERE conname = 'admin_mfa_reset_requests_ticket_fkey' AND conrelid = to_regclass\('admin_mfa_reset_requests'\)\s*\) THEN\s+ALTER TABLE admin_mfa_reset_requests\s+ADD CONSTRAINT admin_mfa_reset_requests_ticket_fkey FOREIGN KEY \(ticket_id\) REFERENCES admin_mfa_enrolment_tickets\(id\) ON DELETE RESTRICT;/);
});

test('additive only: no data or permission changes; the only existing-column addition is nullable factor association', () => {
  const outsideBodies = sql.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$');
  assert.doesNotMatch(outsideBodies, /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b|^\s*TRUNCATE\b/im, 'no data changes');
  // String literals (error messages such as 'a reset must revoke ...') are blanked so that only SQL is checked.
  assert.doesNotMatch(sql.replace(/'(?:[^']|'')*'/g, "''"), /\b(GRANT|REVOKE)\b/i, 'privileges belong to the grants migration');
  assert.doesNotMatch(sql, /\bALTER\s+(ROLE|USER|DEFAULT PRIVILEGES)\b|\bOWNER\s+TO\b/i);
  const withoutConfirmationRoutine = sql.replace(
    /CREATE OR REPLACE FUNCTION confirm_admin_mfa_enrolment_factor\([\s\S]*?AS \$\$[\s\S]*?\$\$;/,
    '',
  );
  assert.doesNotMatch(withoutConfirmationRoutine, /\bSECURITY DEFINER\b/i, 'only the exact confirmation operation may use definer rights');
  assert.doesNotMatch(sql, /\bDROP\s+(?!TRIGGER IF EXISTS)\w+/i, 'only triggers are dropped (to be recreated)');
  assert.doesNotMatch(sql, /\b(?:DROP|ALTER)\s+COLUMN\b|\bSET\s+NOT\s+NULL\b/i);
  assert.doesNotMatch(outsideBodies, /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT)\b[^;\n]*;/im, 'the runner owns the transaction');
  assert.match(sql, /ALTER TABLE admin_mfa_factors ADD COLUMN IF NOT EXISTS enrolment_challenge_id text;/,
    'legacy factors retain NULL association; no backfill or NOT NULL conversion');
  assert.deepEqual([...sql.matchAll(/ALTER TABLE (\w+)/g)].map((m) => m[1]),
    ['admin_mfa_factors', 'admin_mfa_factors', 'admin_mfa_reset_requests']);
  // Existing tables are referenced, never redefined, and the audit table is untouched.
  for (const existing of ['users', 'auth_sessions', 'auth_verification_events', 'auth_session_verifications', 'verification_challenges']) {
    assert.doesNotMatch(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${existing}\\b|(?:ALTER TABLE|ON) ${existing}\\b(?! *\\()`), existing);
  }
});

test('exactly six new tables; no second audit table', () => {
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(created.sort(), [...MFA_TABLES].sort());
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS \w*(?:event|audit|log)\w*/i, 'audit reuses auth_verification_events');
});

test('creation order satisfies every foreign key', () => {
  const order = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const position = (table: string) => order.indexOf(table);
  for (const table of order) {
    for (const [, referenced] of tableBody(table).matchAll(/REFERENCES (\w+)\(/g)) {
      if (MFA_TABLES.includes(referenced)) assert.ok(position(referenced) < position(table), `${table} references ${referenced}, created later`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// No plaintext secrets
// ---------------------------------------------------------------------------------------------

test('no column can hold a plaintext secret, code, token or ticket', () => {
  for (const table of MFA_TABLES) {
    const columns = [...tableBody(table).matchAll(/(?:^|, )([a-z_][a-z0-9_]*) (text|bytea|integer|bigint|timestamptz)\b/g)].map((m) => m[1]);
    for (const column of columns) {
      assert.doesNotMatch(column, /^(secret|code|otp|token|ticket|password|recovery_code|key)$/, `${table}.${column}`);
    }
  }
  const factors = tableBody('admin_mfa_factors');
  assert.match(factors, /secret_ciphertext bytea NOT NULL, secret_nonce bytea NOT NULL, secret_tag bytea NOT NULL, key_version integer NOT NULL/);
  assert.match(factors, /octet_length\(secret_ciphertext\) = 20 AND octet_length\(secret_nonce\) = 12 AND octet_length\(secret_tag\) = 16/,
    'shape matches the Phase 1 AES-256-GCM envelope (20-byte secret, 12-byte nonce, 16-byte tag)');
  assert.match(tableBody('admin_mfa_recovery_codes'), /code_hash text NOT NULL UNIQUE.*CHECK \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/, 'HMAC-SHA256 hex only');
  assert.match(tableBody('admin_mfa_enrolment_tickets'), /CHECK \(id ~ '\^\[0-9a-f\]\{64\}\$'\)/, 'tickets are stored as SHA-256 hex');
  assert.match(tableBody('admin_mfa_challenges'), /CHECK \(id ~ '\^\[0-9a-f\]\{64\}\$'\)/, 'challenge tokens are stored as SHA-256 hex');
});

// ---------------------------------------------------------------------------------------------
// Constraints, uniqueness and foreign keys
// ---------------------------------------------------------------------------------------------

test('factors: key version, replay counter, one active factor per user and kind, consistent disabling', () => {
  const body = tableBody('admin_mfa_factors');
  assert.match(body, /enrolment_challenge_id text/);
  assert.doesNotMatch(body, /enrolment_challenge_id text NOT NULL/,
    'legacy confirmed factors retain a nullable association');
  assert.match(body, /last_used_step bigint NOT NULL DEFAULT -1/);
  assert.match(body, /CHECK \(last_used_step >= -1\)/);
  assert.match(body, /CHECK \(key_version >= 1\)/);
  assert.match(body, /CONSTRAINT admin_mfa_factors_id_user_key UNIQUE \(id, user_id\)/);
  assert.match(body, /CHECK \(\(disabled_at IS NULL\) = \(disabled_via IS NULL\)\)/);
  assert.match(body, /disabled_via IN \('two_person_reset', 'single_approver_reset', 'break_glass', 'enrolment_superseded'\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_factors_one_active_idx ON admin_mfa_factors \(user_id, kind\) WHERE disabled_at IS NULL;/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_factors_one_per_enrolment_challenge_idx\s+ON admin_mfa_factors \(enrolment_challenge_id\) WHERE enrolment_challenge_id IS NOT NULL;/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_challenges_id_user_idx ON admin_mfa_challenges \(id, user_id\);/);
});

test('recovery codes and evidence are tied to the same user as their factor (composite foreign keys)', () => {
  assert.match(tableBody('admin_mfa_recovery_codes'), /FOREIGN KEY \(factor_id, user_id\) REFERENCES admin_mfa_factors\(id, user_id\) ON DELETE RESTRICT/);
  assert.match(tableBody('auth_session_mfa_verifications'), /FOREIGN KEY \(factor_id, user_id\) REFERENCES admin_mfa_factors\(id, user_id\) ON DELETE RESTRICT/);
  assert.match(tableBody('admin_mfa_challenges'), /FOREIGN KEY \(enrolment_ticket_id, user_id\) REFERENCES admin_mfa_enrolment_tickets\(id, user_id\) ON DELETE RESTRICT/);
  assert.match(sql, /FOREIGN KEY \(enrolment_challenge_id, user_id\)\s+REFERENCES admin_mfa_challenges\(id, user_id\) ON DELETE RESTRICT/);
  for (const table of MFA_TABLES) {
    const body = tableBody(table);
    assert.doesNotMatch(body, /ON DELETE (CASCADE|SET NULL)/, `${table}: MFA records are never removed or orphaned by a cascade`);
    for (const [, action] of body.matchAll(/REFERENCES \w+\([\w, ]+\)( ON DELETE RESTRICT)?/g)) assert.ok(action, `${table}: every foreign key is ON DELETE RESTRICT`);
  }
});

test('single-use, expiring challenges and tickets; step-up challenges bound to a session; one open per session or user', () => {
  const challenges = tableBody('admin_mfa_challenges');
  assert.match(challenges, /CHECK \(\(purpose = 'step_up'\) = \(session_token_hash IS NOT NULL\)\)/);
  assert.match(challenges, /CHECK \(enrolment_ticket_id IS NULL OR purpose = 'enrol'\)/);
  assert.match(challenges, /CHECK \(expires_at > created_at\)/);
  assert.match(challenges, /CHECK \(\(consumed_at IS NULL\) = \(consumed_reason IS NULL\)\)/);
  assert.match(challenges, /consumed_reason IN \('verified', 'locked', 'superseded', 'revoked'\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_challenges_one_step_up_idx ON admin_mfa_challenges \(session_token_hash\) WHERE purpose = 'step_up' AND consumed_at IS NULL;/);
  const tickets = tableBody('admin_mfa_enrolment_tickets');
  assert.match(tickets, /CHECK \(expires_at > created_at\)/);
  assert.match(tickets, /CHECK \(used_at IS NULL OR revoked_at IS NULL\)/);
  assert.match(tickets, /CHECK \(\(issued_via IN \('bootstrap_cli', 'break_glass'\)\) = \(issued_by IS NULL\)\)/);
  assert.match(tickets, /CHECK \( ?\(issued_via IN \('two_person_reset', 'single_approver_reset'\)\) = \(reset_request_id IS NOT NULL\)\)/);
  assert.match(tickets, /CHECK \(issued_by IS NULL OR issued_by <> user_id\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_enrolment_tickets_one_open_idx ON admin_mfa_enrolment_tickets \(user_id\) WHERE used_at IS NULL AND revoked_at IS NULL;/);
  assert.match(tableBody('admin_mfa_recovery_codes'), /CHECK \(used_at IS NULL OR revoked_at IS NULL\)/);
});

test('session evidence: insert-only, many rows per session, recovery codes only at sign-in', () => {
  const body = tableBody('auth_session_mfa_verifications');
  assert.match(body, /^ ?id text PRIMARY KEY, token_hash text NOT NULL REFERENCES auth_sessions\(token_hash\) ON DELETE RESTRICT/, 'its own id: many rows per session');
  assert.doesNotMatch(body, /token_hash text PRIMARY KEY|UNIQUE \(token_hash/, 'token_hash is not unique');
  assert.match(body, /CHECK \(purpose = 'login' OR method = 'totp'\)/, 'step-up and enrolment need TOTP');
  assert.match(sql, /CREATE TRIGGER auth_session_mfa_verifications_append_only\s+BEFORE UPDATE OR DELETE ON auth_session_mfa_verifications\s+FOR EACH ROW EXECUTE FUNCTION reject_auth_session_mfa_verification_mutation\(\);/);
  assert.match(sql, /CREATE TRIGGER auth_session_mfa_verifications_no_truncate\s+BEFORE TRUNCATE ON auth_session_mfa_verifications/);
  assert.match(functionBody('reject_auth_session_mfa_verification_mutation'), /^ BEGIN RAISE EXCEPTION '[^']+'; END; $/, 'rejects unconditionally');
  const insert = functionBody('check_auth_session_mfa_verification_insert');
  assert.match(insert, /NEW\.verified_at := clock_timestamp\(\);/, 'the database clock, never a caller value');
  assert.match(insert, /s\.user_id = NEW\.user_id AND s\.revoked_at IS NULL AND s\.expires_at > NEW\.verified_at/, 'a live session of the same user');
  assert.match(insert, /f\.confirmed_at IS NOT NULL AND f\.disabled_at IS NULL/, 'a confirmed, active factor');
});

test('reset requests: states, one pending per target, no self-reset, two-person and single-approver rules', () => {
  const body = tableBody('admin_mfa_reset_requests');
  assert.match(body, /status IN \('pending', 'executed', 'rejected', 'cancelled', 'expired', 'superseded'\)/);
  assert.match(body, /approval_mode IN \('two_person', 'single_super_admin'\)/);
  assert.match(body, /CHECK \(initiated_by <> target_user_id\)/);
  assert.match(body, /CHECK \(decided_by IS NULL OR decided_by <> target_user_id\)/);
  assert.match(body, /CONSTRAINT admin_mfa_reset_requests_two_person_check CHECK \( status <> 'executed' OR approval_mode <> 'two_person' OR decided_by <> initiated_by\)/);
  assert.match(body, /CONSTRAINT admin_mfa_reset_requests_single_approver_check CHECK \( status <> 'executed' OR approval_mode <> 'single_super_admin' OR decided_by = initiated_by\)/);
  assert.match(body, /CHECK \(status <> 'rejected' OR decided_by <> initiated_by\)/);
  assert.match(body, /CHECK \(status <> 'cancelled' OR decided_by = initiated_by\)/);
  assert.match(body, /CHECK \(\(status = 'pending'\) = \(decided_at IS NULL\)\)/);
  assert.match(body, /CHECK \(\(status = 'executed'\) = \(ticket_id IS NOT NULL\)\)/);
  assert.match(body, /FOREIGN KEY \(initiated_verification_id, initiated_by\) REFERENCES auth_session_mfa_verifications\(id, user_id\)/, 'initiation evidence belongs to the initiator');
  assert.match(body, /FOREIGN KEY \(decided_verification_id, decided_by\) REFERENCES auth_session_mfa_verifications\(id, user_id\)/, 'decision evidence belongs to the decider');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_reset_requests_one_pending_idx ON admin_mfa_reset_requests \(target_user_id\) WHERE status = 'pending';/);
});

// ---------------------------------------------------------------------------------------------
// Trigger logic (statically): finished states are final, nothing is deleted or truncated
// ---------------------------------------------------------------------------------------------

test('every MFA table refuses TRUNCATE and DELETE for every role', () => {
  for (const table of MFA_TABLES) {
    assert.match(sql, new RegExp(`CREATE TRIGGER ${table}_no_truncate\\s+BEFORE TRUNCATE ON ${table}\\s+FOR EACH STATEMENT EXECUTE FUNCTION reject_\\w+\\(\\);`), `${table} TRUNCATE`);
  }
  for (const [name, table] of [
    ['protect_admin_mfa_factor', 'admin_mfa_factors'], ['protect_admin_mfa_recovery_code', 'admin_mfa_recovery_codes'],
    ['protect_admin_mfa_enrolment_ticket', 'admin_mfa_enrolment_tickets'], ['protect_admin_mfa_challenge', 'admin_mfa_challenges'],
    ['protect_admin_mfa_reset_request', 'admin_mfa_reset_requests'],
  ] as const) {
    assert.match(functionBody(name), /IF TG_OP = 'DELETE' THEN RAISE EXCEPTION/, `${name} refuses DELETE`);
    assert.match(sql, new RegExp(`BEFORE (?:INSERT OR )?UPDATE OR DELETE ON ${table}\\s+FOR EACH ROW EXECUTE FUNCTION ${name}\\(\\)`), `${table} trigger`);
  }
});

test('factor guard: disabled is terminal, the replay counter only rises, confirmation is set once', () => {
  const body = functionBody('protect_admin_mfa_factor');
  assert.match(body, /IF OLD\.disabled_at IS NOT NULL THEN RAISE EXCEPTION/);
  assert.match(body, /IF NEW\.last_used_step < OLD\.last_used_step THEN RAISE EXCEPTION/);
  assert.match(body, /IF OLD\.confirmed_at IS NOT NULL AND NEW\.confirmed_at IS DISTINCT FROM OLD\.confirmed_at THEN RAISE EXCEPTION/);
  assert.match(body, /NEW\.last_used_step <> -1 THEN RAISE EXCEPTION/, 'a new factor starts unused');
  assert.match(body, /u\.role = 'official'/, 'Officials only');
});

test('O-4: factor INSERT requires the exact live challenge and its bound, unexpired, unused ticket', () => {
  const body = functionBody('protect_admin_mfa_factor');
  const insertPath = body.slice(body.indexOf("TG_OP = 'INSERT'"), body.indexOf('RETURN NEW'));
  assert.match(insertPath, /NEW\.enrolment_challenge_id IS NULL THEN RAISE EXCEPTION/,
    'new factors require an explicit association');
  assert.match(insertPath, /FROM admin_mfa_challenges c\s+WHERE c\.id = NEW\.enrolment_challenge_id\s+AND c\.user_id = NEW\.user_id\s+AND c\.purpose = 'enrol'\s+AND c\.consumed_at IS NULL\s+AND c\.expires_at > clock_timestamp\(\)\s+AND c\.enrolment_ticket_id IS NOT NULL/,
    'challenge ID and user are exact; purpose, consumed state and expiry are checked');
  // O-4-A: ticket validation — same user, open, unexpired
  assert.match(insertPath, /FROM admin_mfa_enrolment_tickets t\s+WHERE t\.id = enrol_challenge\.enrolment_ticket_id\s+AND t\.user_id = enrol_challenge\.user_id\s+AND t\.used_at IS NULL\s+AND t\.revoked_at IS NULL\s+AND t\.expires_at > clock_timestamp\(\)/);
  // O-4-A: 1800-second lifetime enforced
  assert.match(insertPath, /ENROLMENT_TICKET_TTL_SECONDS/, 'lifetime constant used in INSERT path');
  // O-4-A: the INSERT path must NOT set used_at on the ticket (ticket reserved for confirmation)
  assert.doesNotMatch(insertPath, /SET used_at/, 'factor INSERT must not consume the ticket');
});

test('O-4: factor confirmation uses OLD exact association and consumes only its ticket once', () => {
  const body = functionBody('protect_admin_mfa_factor');
  assert.match(body, /NEW\.enrolment_challenge_id IS DISTINCT FROM OLD\.enrolment_challenge_id/,
    'the factor-to-challenge association is immutable');
  const confirmationPath = body.slice(body.indexOf('IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL'));
  assert.match(confirmationPath, /FROM admin_mfa_challenges c\s+WHERE c\.id = OLD\.enrolment_challenge_id\s+AND c\.user_id = OLD\.user_id\s+AND c\.purpose = 'enrol'\s+AND c\.consumed_at IS NULL\s+AND c\.expires_at > clock_timestamp\(\)\s+AND c\.enrolment_ticket_id IS NOT NULL/,
    'confirmation selects only the associated live challenge');
  assert.match(confirmationPath, /WHERE id = enrol_challenge\.enrolment_ticket_id\s+AND user_id = enrol_challenge\.user_id\s+AND used_at IS NULL\s+AND revoked_at IS NULL\s+AND expires_at > clock_timestamp\(\)/,
    'confirmation consumes only that exact challenge ticket');
  // O-4-B: conditional UPDATE sets used_at on the ticket
  assert.match(confirmationPath, /UPDATE admin_mfa_enrolment_tickets\s+SET used_at = clock_timestamp\(\)/);
  // O-4-B: row-count guard — zero rows = reject
  assert.match(confirmationPath, /GET DIAGNOSTICS rows_updated = ROW_COUNT/);
  assert.match(confirmationPath, /rows_updated <> 1 THEN\s+RAISE EXCEPTION 'enrolment ticket could not be consumed/);
  // O-4-B: conditional UPDATE guards — only an open, unexpired ticket is targeted
  assert.match(confirmationPath, /AND used_at IS NULL\s+AND revoked_at IS NULL\s+AND expires_at > clock_timestamp\(\)\s+AND created_at > clock_timestamp\(\)/);
  assert.doesNotMatch(body, /LIMIT\s+1/i, 'factor guard never discovers challenge or ticket by unordered selection');
});

test('new factor association rejects missing/cross-user challenges and cannot be duplicated or changed', () => {
  const body = functionBody('protect_admin_mfa_factor');
  assert.match(body, /NEW\.enrolment_challenge_id IS NULL/);
  assert.match(body, /WHERE c\.id = NEW\.enrolment_challenge_id\s+AND c\.user_id = NEW\.user_id/);
  assert.match(sql, /FOREIGN KEY \(enrolment_challenge_id, user_id\)\s+REFERENCES admin_mfa_challenges\(id, user_id\) ON DELETE RESTRICT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_factors_one_per_enrolment_challenge_idx\s+ON admin_mfa_factors \(enrolment_challenge_id\) WHERE enrolment_challenge_id IS NOT NULL;/);
  assert.match(body, /NEW\.enrolment_challenge_id IS DISTINCT FROM OLD\.enrolment_challenge_id/);
});

test('O-4: ticket lifetime constant is exactly 1800 seconds (owner decision)', () => {
  const body = functionBody('protect_admin_mfa_factor');
  // The constant is declared with the owner-approved value of 1800 seconds.
  assert.match(body, /ENROLMENT_TICKET_TTL_SECONDS constant integer := 1800/);
  // All interval expressions in both enforcement points reference the constant,
  // not a bare 1800 literal: confirm no raw interval like "1800 seconds" or "'1800 seconds'" appears.
  assert.doesNotMatch(body, /'\d+ seconds'::interval/, "intervals use the constant, not a string literal like '1800 seconds'");
  assert.match(body, /ENROLMENT_TICKET_TTL_SECONDS \|\| ' seconds'\)::interval/, 'interval expressions concatenate the named constant');
});

test('O-4: ticket consumption at confirmation uses database clock, never caller-supplied time', () => {
  const body = functionBody('protect_admin_mfa_factor');
  assert.match(body, /SET used_at = clock_timestamp\(\)/, 'used_at stamped with clock_timestamp()');
  // No now() usage anywhere in the factor trigger
  assert.doesNotMatch(body, /\bnow\(\)/, 'clock_timestamp() is used exclusively, never now()');
});

test('O-4: O-4 is documented in SQL comments and cross-references AUTH C1.8.4', () => {
  assert.match(raw, /O-4.*mandatory Phase 4 requirement/i, 'O-4 comment present');
  assert.match(raw, /1,800 s.*owner decision/i, 'owner-approved lifetime documented');
  assert.match(raw, /AUTH C1\.8\.4/, 'cross-reference to policy control');
});

test('single-use guards: used, revoked and consumed rows are final; expired tickets and challenges cannot be used', () => {
  assert.match(functionBody('protect_admin_mfa_recovery_code'), /IF OLD\.used_at IS NOT NULL OR OLD\.revoked_at IS NOT NULL THEN RAISE EXCEPTION/);
  const ticket = functionBody('protect_admin_mfa_enrolment_ticket');
  assert.match(ticket, /IF OLD\.used_at IS NOT NULL OR OLD\.revoked_at IS NOT NULL THEN RAISE EXCEPTION/);
  assert.match(ticket, /IF clock_timestamp\(\) >= OLD\.expires_at THEN RAISE EXCEPTION 'an expired enrolment ticket cannot be used'/);
  const challenge = functionBody('protect_admin_mfa_challenge');
  assert.match(challenge, /IF OLD\.consumed_at IS NOT NULL THEN RAISE EXCEPTION/);
  assert.match(challenge, /IF NEW\.attempts < OLD\.attempts OR NEW\.attempts > OLD\.attempts \+ 1 THEN RAISE EXCEPTION/);
  assert.match(challenge, /NEW\.consumed_reason = 'verified'\) THEN RAISE EXCEPTION 'an expired admin MFA challenge cannot be used'/);
  assert.match(challenge, /s\.user_id = NEW\.user_id AND s\.revoked_at IS NULL/, 'a step-up challenge belongs to a live session of the same user');
});

test('reset guard: only pending changes; decisions need TOTP evidence; the two-person approver verified after creation', () => {
  const insert = functionBody('check_admin_mfa_reset_request_insert');
  assert.match(insert, /IF NEW\.status <> 'pending' OR NEW\.decided_by IS NOT NULL/, 'inserted pending and undecided');
  assert.match(insert, /CASE WHEN target_row\.is_super_admin THEN 'two_person' ELSE 'single_super_admin' END/, 'mode follows the target (D-1)');
  assert.match(insert, /u\.id = NEW\.initiated_by AND u\.role = 'official' AND u\.is_super_admin AND u\.account_status = 'approved'/);
  assert.match(insert, /v\.method = 'totp'/);
  const update = functionBody('protect_admin_mfa_reset_request');
  assert.match(update, /IF OLD\.status <> 'pending' THEN RAISE EXCEPTION 'a finished admin MFA reset request cannot change'/);
  assert.match(update, /NEW\.decided_at := clock_timestamp\(\);/);
  assert.match(update, /IF NEW\.decided_at >= OLD\.expires_at THEN RAISE EXCEPTION/, 'no decision after expiry');
  assert.match(update, /v\.user_id = NEW\.decided_by AND v\.method = 'totp' AND s\.revoked_at IS NULL AND s\.expires_at > NEW\.decided_at/);
  assert.match(update, /IF evidence_row\.verified_at <= OLD\.created_at THEN RAISE EXCEPTION/, 'fresh approval evidence (two-person)');
  assert.match(update, /the initiator is no longer an approved Super Admin/);
  assert.match(update, /the target is now a Super Admin: two-person approval is required/);
  assert.match(update, /ticket_row\.reset_request_id IS DISTINCT FROM NEW\.id/, 'the executed request names its own ticket');
  assert.match(update, /ticket_row\.issued_by IS DISTINCT FROM NEW\.decided_by/, 'issued by the decider');
  assert.match(update, /ticket_row\.used_at IS NOT NULL OR ticket_row\.revoked_at IS NOT NULL/, 'an open ticket');
});

test('trigger functions remain invoker-rights; only the enrollment confirmation operation uses definer rights', () => {
  const names = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+AS \$\$/g)].map((m) => m[1]);
  assert.equal(names.length, 10);
  assert.equal([...sql.matchAll(/CREATE OR REPLACE FUNCTION/g)].length, 11);
  const signature = /CREATE OR REPLACE FUNCTION confirm_admin_mfa_enrolment_factor\(\s*p_user_id text,\s*p_challenge_id text,\s*p_ticket_id text,\s*p_factor_id text,\s*p_accepted_step bigint\s*\)\s+RETURNS boolean\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, public\s+AS \$\$([\s\S]*?)\$\$;/;
  const match = signature.exec(sql);
  assert.ok(match, 'the only non-trigger routine has a fixed signature and pinned search_path');
  const body = match[1].replace(/\s+/g, ' ');
  const advisoryLock = body.indexOf('PERFORM pg_advisory_xact_lock(734251, hashtext(p_user_id))');
  const challengeLock = body.indexOf('FROM public.admin_mfa_challenges c');
  const ticketLock = body.indexOf('FROM public.admin_mfa_enrolment_tickets t');
  const factorLock = body.indexOf('FROM public.admin_mfa_factors f');
  const mutation = body.indexOf('UPDATE public.admin_mfa_factors');
  assert.ok(advisoryLock >= 0 && advisoryLock < challengeLock && challengeLock < ticketLock
    && ticketLock < factorLock && factorLock < mutation, 'locks and mutation follow user, challenge, ticket, factor order');
  assert.match(body, /c\.id = p_challenge_id AND c\.user_id = p_user_id AND c\.purpose = 'enrol' AND c\.consumed_at IS NULL AND c\.expires_at > clock_timestamp\(\)/);
  assert.match(body, /challenge_ticket_id IS DISTINCT FROM p_ticket_id/);
  assert.match(body, /t\.id = p_ticket_id AND t\.user_id = p_user_id AND t\.used_at IS NULL AND t\.revoked_at IS NULL AND t\.expires_at > clock_timestamp\(\) AND t\.created_at > clock_timestamp\(\) - interval '1800 seconds'/);
  assert.match(body, /f\.id = p_factor_id AND f\.user_id = p_user_id AND f\.enrolment_challenge_id = p_challenge_id/);
  assert.match(body, /GET DIAGNOSTICS rows_updated = ROW_COUNT; IF rows_updated <> 1 THEN RAISE EXCEPTION/);
  assert.doesNotMatch(body, /\bLIMIT\s+1\b/i);
});

// ---------------------------------------------------------------------------------------------
// AUTH C1.8.4: F1 ticket integrity, F2 all-or-nothing resets, O-3 factor-disable linkage, bootstrap lock
// ---------------------------------------------------------------------------------------------

test('commit-time checks are deferred constraint triggers on exactly the three reset tables, with exact firing conditions', () => {
  const definition = (name: string) => {
    const match = new RegExp(`CREATE CONSTRAINT TRIGGER ${name}\\s+([\\s\\S]*?);`).exec(sql);
    assert.ok(match, name);
    return match[1].replace(/\s+/g, ' ').trim();
  };
  assert.equal(definition('admin_mfa_reset_requests_commit_check'),
    "AFTER UPDATE ON admin_mfa_reset_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status = 'executed') EXECUTE FUNCTION check_admin_mfa_reset_commit()");
  assert.equal(definition('admin_mfa_enrolment_tickets_commit_check'),
    "AFTER INSERT ON admin_mfa_enrolment_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.issued_via IN ('two_person_reset', 'single_approver_reset', 'break_glass')) EXECUTE FUNCTION check_admin_mfa_reset_commit()");
  assert.equal(definition('admin_mfa_factors_commit_check'),
    "AFTER UPDATE ON admin_mfa_factors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL AND NEW.disabled_via IN ('two_person_reset', 'single_approver_reset', 'break_glass')) EXECUTE FUNCTION check_admin_mfa_reset_commit()");
  assert.doesNotMatch(sql, /NOT DEFERRABLE|INITIALLY IMMEDIATE/, 'no commit check may run before the transaction has finished its writes');
});

test('the commit check re-reads current rows, uses only inline SQL, and enforces every reset side effect', () => {
  const body = functionBody('check_admin_mfa_reset_commit');
  // Re-reads by id instead of trusting the NEW image of an earlier statement.
  for (const table of ['admin_mfa_factors f', 'admin_mfa_reset_requests r', 'admin_mfa_enrolment_tickets t']) {
    assert.match(body, new RegExp(`FROM ${table} WHERE \\w\\.id = NEW\\.id`), `re-reads ${table}`);
  }
  assert.doesNotMatch(body, /\bPERFORM\b|\bNEW\.(?!id\b)\w+/, 'no helper calls (EXECUTE is revoked) and no use of stale NEW columns');
  assert.match(body, /RETURN NULL;/);
  // F2 invariants.
  for (const message of [
    'a reset must leave the target with no active MFA factor',
    'a reset must revoke every unused recovery code of the target',
    'a reset must close every open MFA challenge of the target',
    'a reset must revoke every other open enrolment ticket of the target',
    'a reset must revoke every unexpired session of the target',
    'the replacement enrolment ticket must still be open when the reset commits',
    'an executed reset must be linked to the replacement ticket its decider issued',
    'an executed reset needs its admin_mfa.reset_executed audit event',
  ]) assert.ok(body.includes(message), message);
  assert.match(body, /e\.action = 'admin_mfa\.reset_executed' AND e\.user_id = target AND e\.details->>'requestId' = request_row\.id/);
  assert.match(body, /s\.user_id = target AND s\.revoked_at IS NULL AND s\.expires_at > clock_timestamp\(\)/);
  // F1 at commit: the reset ticket and its executed request, same target, ticket, decider and mode.
  assert.match(body, /r\.id = ticket_row\.reset_request_id AND r\.status = 'executed' AND r\.ticket_id = ticket_row\.id AND r\.target_user_id = ticket_row\.user_id AND r\.decided_by = ticket_row\.issued_by/);
  // O-3: reset-labelled disables tie to a matching request decided in THIS transaction, after the disable.
  assert.match(body, /r\.decided_by = factor_row\.disabled_by AND r\.decided_at >= now\(\) AND r\.decided_at >= factor_row\.disabled_at/);
  assert.match(body, /t\.issued_via = 'break_glass' AND t\.created_at >= now\(\) AND t\.created_at >= factor_row\.disabled_at/);
  // Break-glass: supersedes a pending request and is audited (application-supplied; not operator identity).
  assert.ok(body.includes('a break-glass reset must supersede the pending reset request of its target'));
  assert.match(body, /e\.action = 'admin_mfa\.break_glass_reset' AND e\.user_id = target AND e\.occurred_at >= now\(\)/);
});

test('ticket INSERT: issuer eligibility, pending request of the right target, mode and issuer, first-time and bootstrap rules', () => {
  const body = functionBody('protect_admin_mfa_enrolment_ticket');
  assert.match(body, /u\.id = NEW\.issued_by AND u\.role = 'official' AND u\.is_super_admin AND u\.account_status = 'approved' AND f\.confirmed_at IS NOT NULL AND f\.disabled_at IS NULL/);
  for (const message of [
    'a reset ticket must reference an existing reset request',
    'a reset ticket can only be issued for a pending, unexpired reset request',
    'a reset ticket must be issued to the target of its reset request',
    'the reset ticket label must match the approval mode of its reset request',
    'a two-person reset ticket is issued by the approver, never the initiator',
    'a single-approver reset ticket is issued by the initiating Super Admin',
    'the target has enrolled before: replacing a factor requires a reset',
    'a bootstrap ticket is only for an approved Super Admin',
    'a Super Admin has already enrolled: bootstrap is closed',
    'an open bootstrap ticket already exists',
  ]) assert.ok(body.includes(message), message);
  assert.match(body, /request_row\.status <> 'pending' OR request_row\.expires_at <= clock_timestamp\(\)/);
  assert.match(body, /f\.user_id = NEW\.user_id AND f\.confirmed_at IS NOT NULL/, 'never enrolled: disabled factors keep confirmed_at');
});

test('bootstrap concurrency: READ COMMITTED only, a transaction-level advisory lock, then every precondition', () => {
  const body = functionBody('protect_admin_mfa_enrolment_ticket');
  const bootstrap = body.slice(body.indexOf("ELSIF NEW.issued_via = 'bootstrap_cli' THEN"));
  const isolation = bootstrap.indexOf("current_setting('transaction_isolation') <> 'read committed'");
  const lock = bootstrap.indexOf('PERFORM pg_advisory_xact_lock(7342519187);');
  assert.ok(isolation > 0 && lock > isolation, 'isolation is checked, then the lock is taken');
  for (const check of ['bootstrap ticket is only for an approved Super Admin', 'bootstrap is closed', 'open bootstrap ticket already exists']) {
    assert.ok(bootstrap.indexOf(check) > lock, `${check}: checked after the lock is held`);
  }
  assert.doesNotMatch(raw, /pg_advisory_lock\(|pg_advisory_unlock/, 'transaction-scoped only: released at COMMIT or ROLLBACK');
  assert.equal([...sql.matchAll(/pg_advisory_xact_lock\(7342519187\)/g)].length, 1, 'no other MFA path takes the bootstrap lock');
  // Distinct from the migration runner's lock key (server/migrate.ts).
  assert.doesNotMatch(raw, /7342519086/);
});

test('O-3 immediate checks: superseding only unconfirmed factors; reset disables name the decider; break-glass names no user', () => {
  const body = functionBody('protect_admin_mfa_factor');
  assert.match(body, /NEW\.disabled_via = 'enrolment_superseded' AND \(OLD\.confirmed_at IS NOT NULL OR NEW\.confirmed_at IS NOT NULL\)/);
  assert.match(body, /NEW\.disabled_via IN \('two_person_reset', 'single_approver_reset'\) AND NEW\.disabled_by IS NULL/);
  assert.match(body, /NEW\.disabled_via = 'break_glass' AND NEW\.disabled_by IS NOT NULL/);
});

test('O-1 is documented as open: the database cannot authenticate the operator CLI', () => {
  assert.match(raw.replace(/\n--\s*/g, ' '), /O-1 \(open, to be resolved before MFA Phase 7\): the operator CLI and the API share database credentials/);
});

// ---------------------------------------------------------------------------------------------
// Audit design
// ---------------------------------------------------------------------------------------------

test('audit: the approved admin_mfa.* actions are declared, with a safe details vocabulary', () => {
  const actions = [...raw.matchAll(/admin_mfa\.([a-z_]+)/g)].map((m) => m[1]);
  const expected = [
    'challenge_created', 'verified', 'code_rejected', 'challenge_locked', 'throttled', 'recovery_code_used', 'recovery_codes_regenerated',
    'ticket_issued', 'ticket_used', 'enrolment_started', 'enrolled', 'step_up_verified', 'step_up_refused', 'reset_initiated', 'reset_approved',
    'reset_rejected', 'reset_cancelled', 'reset_expired', 'reset_refused', 'reset_executed', 'break_glass_reset', 'break_glass_acknowledged',
    'bootstrap_ticket_issued',
  ];
  assert.deepEqual([...new Set(actions)].sort(), [...expected].sort());
  const details = /details may hold only: ([^.]+)\./.exec(raw.replace(/\n--\s+/g, ' '));
  assert.ok(details, 'details vocabulary declared');
  assert.doesNotMatch(details[1], /secret|code\b|token|ticket\b|key\b|hash|password|credential/i, 'no sensitive field in the vocabulary');
  assert.match(raw, /Never a secret, code, token, ticket, key, hash or credential/);
});
