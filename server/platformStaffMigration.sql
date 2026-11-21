-- SM-1: Platform Staff (Super Admin-managed) migration.
--
-- Included in MIGRATION_FILES after auth/MFA migrations and before databaseGrantsMigration.sql.
-- The grants migration validates exact application-role privileges for every created table.
-- Database runtime rehearsal remains a separate release gate; this file is never run against a
-- database except through the supported migration runner.
--
-- Design (approved: Option A, independent identities):
-- - Platform Staff identities are NOT rows in users; this file never alters users.
-- - Separate sessions (platform_staff_sessions) and credentials (bcrypt hashes only).
-- - The permission catalogue is created EMPTY: no permission can be granted until the catalogue
--   (policy D-08) is approved and seeded by a separately reviewed migration.
-- - The audit table is append-only (UPDATE/DELETE/TRUNCATE always rejected), like
--   institute_status_history.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS platform_staff_departments (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_staff_departments_name_check CHECK (length(btrim(name)) BETWEEN 2 AND 120)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_staff_departments_name_idx ON platform_staff_departments (lower(name));

CREATE TABLE IF NOT EXISTS platform_staff_roles (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_staff_roles_name_check CHECK (length(btrim(name)) BETWEEN 2 AND 120)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_staff_roles_name_idx ON platform_staff_roles (lower(name));

-- Empty until D-08 is approved. Codes are added only by a reviewed migration, never by the API.
CREATE TABLE IF NOT EXISTS platform_staff_permission_catalogue (
  code text PRIMARY KEY,
  module text NOT NULL,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_staff_role_permissions (
  role_id text NOT NULL REFERENCES platform_staff_roles(id) ON DELETE RESTRICT,
  permission_code text NOT NULL REFERENCES platform_staff_permission_catalogue(code) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE IF NOT EXISTS platform_staff_accounts (
  id text PRIMARY KEY,
  staff_id text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  must_change_password boolean NOT NULL DEFAULT true,
  department_id text REFERENCES platform_staff_departments(id) ON DELETE RESTRICT,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  deactivated_by text REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT platform_staff_accounts_status_check CHECK (status IN ('active', 'deactivated')),
  CONSTRAINT platform_staff_accounts_staff_id_check CHECK (staff_id ~ '^[A-Z0-9._-]{4,50}$'),
  CONSTRAINT platform_staff_accounts_deactivation_check CHECK (
    (status = 'active' AND deactivated_at IS NULL AND deactivated_by IS NULL)
    OR (status = 'deactivated' AND deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_staff_accounts_staff_id_idx ON platform_staff_accounts (staff_id);

-- Role grants are never deleted (the API role has no DELETE): removing a role sets revoked_at, so the
-- full grant history is kept. At most one active grant per account and role.
CREATE TABLE IF NOT EXISTS platform_staff_account_roles (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES platform_staff_accounts(id) ON DELETE RESTRICT,
  role_id text NOT NULL REFERENCES platform_staff_roles(id) ON DELETE RESTRICT,
  granted_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT platform_staff_account_roles_revocation_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_staff_account_roles_active_idx ON platform_staff_account_roles (account_id, role_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_staff_sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES platform_staff_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT platform_staff_sessions_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS platform_staff_sessions_active_idx ON platform_staff_sessions (account_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_staff_audit_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL,
  actor_id text,
  action text NOT NULL,
  target_account_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT platform_staff_audit_events_actor_check CHECK (actor_kind IN ('super_admin', 'platform_staff', 'anonymous'))
);
CREATE INDEX IF NOT EXISTS platform_staff_audit_events_time_idx ON platform_staff_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS platform_staff_audit_events_target_idx ON platform_staff_audit_events (target_account_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_platform_staff_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform staff audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS platform_staff_audit_events_append_only ON platform_staff_audit_events;
CREATE TRIGGER platform_staff_audit_events_append_only
  BEFORE UPDATE OR DELETE ON platform_staff_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_platform_staff_audit_mutation();

DROP TRIGGER IF EXISTS platform_staff_audit_events_no_truncate ON platform_staff_audit_events;
CREATE TRIGGER platform_staff_audit_events_no_truncate
  BEFORE TRUNCATE ON platform_staff_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_staff_audit_mutation();
