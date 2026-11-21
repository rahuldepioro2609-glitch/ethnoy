// SM-1: static checks for the supported Staff migrations (text only; nothing is executed).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATION_FILES } from './migrate.js';
import { ORG_STAFF_ROLE_CODES } from './organizationStaff.js';

const platform = await readFile(new URL('./platformStaffMigration.sql', import.meta.url), 'utf8');
const organization = await readFile(new URL('./organizationStaffMigration.sql', import.meta.url), 'utf8');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');

test('the staff migrations are wired once before the final grants migration', () => {
  const files = [...MIGRATION_FILES] as string[];
  for (const name of ['platformStaffMigration.sql', 'organizationStaffMigration.sql']) {
    assert.equal(files.filter((file) => file === name).length, 1, name);
    assert.ok(files.indexOf(name) < files.indexOf('databaseGrantsMigration.sql'), name);
  }
  assert.equal(files.indexOf('organizationStaffMigration.sql'), files.indexOf('platformStaffMigration.sql') + 1);
});

test('staff identities never alter or extend the users table', () => {
  for (const sql of [platform, organization]) {
    assert.doesNotMatch(strip(sql), /ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?users\b/i);
    assert.doesNotMatch(strip(sql), /INSERT\s+INTO\s+users\b|UPDATE\s+users\b|DELETE\s+FROM\s+users\b/i);
  }
});

test('the two systems use separate identity, session and audit tables', () => {
  for (const table of ['platform_staff_accounts', 'platform_staff_sessions', 'platform_staff_audit_events']) {
    assert.match(platform, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.doesNotMatch(organization, new RegExp(`\\b${table}\\b`));
  }
  for (const table of ['org_staff_members', 'org_staff_sessions', 'org_staff_audit_events', 'org_staff_invitations']) {
    assert.match(organization, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.doesNotMatch(platform, new RegExp(`\\b${table}\\b`));
  }
});

test('every statement is re-runnable (IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING / DROP … IF EXISTS)', () => {
  for (const sql of [platform, organization]) {
    const body = strip(sql);
    assert.equal((body.match(/CREATE TABLE (?!IF NOT EXISTS)/g) ?? []).length, 0);
    assert.equal((body.match(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g) ?? []).length, 0);
    assert.equal((body.match(/CREATE FUNCTION/g) ?? []).length, 0, 'functions use CREATE OR REPLACE');
    assert.equal((body.match(/CREATE TRIGGER/g) ?? []).length, (body.match(/DROP TRIGGER IF EXISTS/g) ?? []).length);
    for (const insert of body.match(/INSERT INTO[\s\S]*?;/g) ?? []) assert.match(insert, /ON CONFLICT[\s\S]*DO NOTHING/);
  }
});

test('audit tables are append-only: row UPDATE/DELETE and TRUNCATE are always rejected', () => {
  for (const [sql, table] of [[platform, 'platform_staff_audit_events'], [organization, 'org_staff_audit_events']] as const) {
    assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON ${table}\\s+FOR EACH ROW`));
    assert.match(sql, new RegExp(`BEFORE TRUNCATE ON ${table}\\s+FOR EACH STATEMENT`));
    assert.match(sql, /RAISE EXCEPTION '[^']*append-only'/);
  }
});

test('D-08: the platform permission catalogue is created empty and nothing seeds it', () => {
  assert.match(platform, /CREATE TABLE IF NOT EXISTS platform_staff_permission_catalogue/);
  assert.doesNotMatch(strip(platform), /INSERT INTO platform_staff_permission_catalogue/);
  assert.doesNotMatch(strip(platform), /INSERT INTO platform_staff_role_permissions/);
  assert.match(platform, /permission_code text NOT NULL REFERENCES platform_staff_permission_catalogue\(code\)/);
});

test('Q117: exactly the six approved role templates are seeded; no permission catalogue for organizations yet', () => {
  const seeded = [...organization.matchAll(/\('([a-z_]+)', '[^']+', '[^']+\(Q117\)\.'\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(seeded, [...ORG_STAFF_ROLE_CODES].sort());
  assert.doesNotMatch(organization, /permission_catalogue/);
});

test('Q115/Q116: an active member needs a recorded verification, activation and password; codes are hashed and single-live', () => {
  assert.match(organization, /status <> 'active' OR \(verified_at IS NOT NULL AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND password_hash IS NOT NULL\)/);
  const invitations = organization.slice(organization.indexOf('CREATE TABLE IF NOT EXISTS org_staff_invitations'));
  const invitationColumns = invitations.slice(0, invitations.indexOf(');'));
  assert.match(invitationColumns, /code_hash text NOT NULL/);
  assert.doesNotMatch(invitationColumns, /\bcode text\b|invitation_code text/, 'the plaintext code is never a column');
  assert.match(organization, /org_staff_invitations_one_live_idx ON org_staff_invitations \(member_id\) WHERE used_at IS NULL/);
  assert.match(organization, /expires_at > created_at/);
});

test('tenant isolation in the schema: composite keys keep invitations, roles and sessions in one organization', () => {
  assert.match(organization, /CONSTRAINT org_staff_members_id_org_key UNIQUE \(id, organization_id\)/);
  for (const table of ['org_staff_invitations', 'org_staff_member_roles', 'org_staff_sessions']) {
    const block = organization.slice(organization.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(block.slice(0, block.indexOf(');')), /FOREIGN KEY \(member_id, organization_id\)\s+REFERENCES org_staff_members\(id, organization_id\)/, table);
  }
  assert.match(organization, /org_staff_members_org_staff_id_idx ON org_staff_members \(organization_id, staff_id\)/);
});

test('no plaintext secrets or OTP columns exist (C-18: no OTP storage until a provider is approved)', () => {
  for (const sql of [platform, organization]) {
    assert.doesNotMatch(strip(sql), /\bpassword text\b|\btoken text\b|\botp\b|mobile/i);
  }
});
