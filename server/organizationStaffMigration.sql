-- SM-1: Organization Staff (Organization Owner-managed, Q115–Q117) migration.
--
-- Included in MIGRATION_FILES after auth/MFA migrations and before databaseGrantsMigration.sql.
-- The grants migration validates exact application-role privileges for every created table.
-- Database runtime rehearsal remains a separate release gate; this file is never run against a
-- database except through the supported migration runner.
--
-- Design (approved: Option A, independent identities; Q115–Q117 preserved):
-- - Organization Staff identities are NOT rows in users and are independent of Platform Staff.
-- - Every row carries organization_id (the Owner's users.id, role 'center'); composite foreign
--   keys keep members, invitations, role grants and sessions inside one organization.
-- - Q116: invitation codes are unique, single-use, expiring, stored hashed and bound to one
--   organization. Mobile OTP verification is NOT implemented (C-18: no approved SMS provider), so
--   verified_at stays NULL and no member can become active.
-- - Q115: only a Super Admin activates; the CHECK below makes 'active' impossible without a
--   recorded verification and a recorded activating Super Admin.
-- - Q117: the six predefined role templates are seeded. Custom roles and the permission catalogue
--   (D-08) are not created here.
-- - Suspension and removal states exist in the CHECK (from the reviewed data-model proposal), but no
--   code path sets them until the Q115 gap (who may suspend or remove) is decided.
-- - The audit table is append-only.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS org_staff_role_templates (
  code text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL
);

INSERT INTO org_staff_role_templates (code, label, description) VALUES
  ('reviewer', 'Reviewer', 'Reviews applications (Q117).'),
  ('verifier', 'Verifier', 'Verifies application details and documents (Q117).'),
  ('application_manager', 'Application Manager', 'Manages assigned application workflows (Q117).'),
  ('finance_viewer', 'Finance Viewer', 'Read-only financial reports (Q117).'),
  ('invigilator', 'Invigilator', 'Assigned examination sessions only (Q117).'),
  ('viewer', 'Viewer', 'Read-only access to permitted modules (Q117).')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS org_staff_members (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  staff_id text NOT NULL,
  display_name text NOT NULL,
  password_hash text,
  status text NOT NULL DEFAULT 'invited',
  invited_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  verified_at timestamptz,
  verification_method text,
  activated_at timestamptz,
  activated_by text REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT org_staff_members_status_check CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  CONSTRAINT org_staff_members_staff_id_check CHECK (staff_id ~ '^[A-Z0-9._-]{4,50}$'),
  CONSTRAINT org_staff_members_active_check CHECK (
    status <> 'active' OR (verified_at IS NOT NULL AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND password_hash IS NOT NULL)
  ),
  CONSTRAINT org_staff_members_id_org_key UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_staff_members_org_staff_id_idx ON org_staff_members (organization_id, staff_id);

CREATE TABLE IF NOT EXISTS org_staff_invitations (
  id text PRIMARY KEY,
  member_id text NOT NULL,
  organization_id text NOT NULL,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT org_staff_invitations_member_fk FOREIGN KEY (member_id, organization_id)
    REFERENCES org_staff_members(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT org_staff_invitations_expiry_check CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_staff_invitations_code_hash_idx ON org_staff_invitations (code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS org_staff_invitations_one_live_idx ON org_staff_invitations (member_id) WHERE used_at IS NULL;

-- Role grants are never deleted (the API role has no DELETE): removing a role sets revoked_at.
CREATE TABLE IF NOT EXISTS org_staff_member_roles (
  id text PRIMARY KEY,
  member_id text NOT NULL,
  organization_id text NOT NULL,
  role_code text NOT NULL REFERENCES org_staff_role_templates(code) ON DELETE RESTRICT,
  granted_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT org_staff_member_roles_member_fk FOREIGN KEY (member_id, organization_id)
    REFERENCES org_staff_members(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT org_staff_member_roles_revocation_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS org_staff_member_roles_active_idx ON org_staff_member_roles (member_id, role_code) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS org_staff_sessions (
  token_hash text PRIMARY KEY,
  member_id text NOT NULL,
  organization_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT org_staff_sessions_member_fk FOREIGN KEY (member_id, organization_id)
    REFERENCES org_staff_members(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT org_staff_sessions_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS org_staff_sessions_active_idx ON org_staff_sessions (member_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS org_staff_audit_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  organization_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL,
  actor_id text,
  action text NOT NULL,
  target_member_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT org_staff_audit_events_actor_check CHECK (actor_kind IN ('organization_owner', 'org_staff', 'super_admin', 'anonymous'))
);
CREATE INDEX IF NOT EXISTS org_staff_audit_events_org_time_idx ON org_staff_audit_events (organization_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_org_staff_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization staff audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS org_staff_audit_events_append_only ON org_staff_audit_events;
CREATE TRIGGER org_staff_audit_events_append_only
  BEFORE UPDATE OR DELETE ON org_staff_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_org_staff_audit_mutation();

DROP TRIGGER IF EXISTS org_staff_audit_events_no_truncate ON org_staff_audit_events;
CREATE TRIGGER org_staff_audit_events_no_truncate
  BEFORE TRUNCATE ON org_staff_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_org_staff_audit_mutation();
