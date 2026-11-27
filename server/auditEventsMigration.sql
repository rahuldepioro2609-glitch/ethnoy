-- A-11 / A-12 / A-13: the platform audit trail (`audit_events`).
-- Design: docs/architecture/audit-infrastructure-proposal.md (release 1, reduced scope).
--
-- What this file does
-- - One append-only table. The API writes it only through server/audit.ts, in the same transaction
--   as the action it records (A-11): if the audit insert fails, the action rolls back.
-- - Rows can never be updated, deleted or truncated (triggers below), by anyone who does not first
--   disable the triggers. The API role (eltnoy_app) gets SELECT and INSERT only
--   (databaseGrantsMigration.sql).
-- - Each row carries a SHA-256 hash of its own contents, set by the database on insert and
--   overwriting anything the client sent. It makes later edits by a database operator detectable
--   when the hash is recomputed. It is tamper-evident, not immutable.
-- - Retention: no automatic deletion this release (A-13). `retention_class` lets a future,
--   client-approved retention rule treat categories differently.
--
-- Deliberately NOT in this file (client decisions pending; see the proposal §12)
-- - source IP and user-agent columns (OD-3)
-- - the sealing chain and off-host checkpoints (OD-6)
-- - any organization-facing read access (A-12 says Super Admin only; C-03)
--
-- References (actor, organization, resource) are text and NOT foreign keys: a cascade or SET NULL
-- would have to modify audit rows. No sequences (the grants manifest has none): rows are ordered by
-- (occurred_at, id).
--
-- Re-runnable: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS.

CREATE TABLE IF NOT EXISTS audit_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  schema_version  smallint    NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  category        text        NOT NULL CHECK (category IN (
                    'auth', 'account', 'organization', 'permission', 'application', 'review', 'publishing',
                    'document', 'exam', 'finance', 'payment', 'admin', 'security', 'audit', 'operations')),
  action          text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(action) <= 80),
  outcome         text        NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
  reason_code     text        CHECK (reason_code IS NULL OR (reason_code ~ '^[a-z][a-z0-9_]*$' AND length(reason_code) <= 64)),
  actor_type      text        NOT NULL CHECK (actor_type IN ('user', 'system', 'operator', 'anonymous')),
  actor_user_id   text        CHECK (actor_user_id IS NULL OR length(actor_user_id) <= 200),
  actor_role      text        CHECK (actor_role IS NULL OR actor_role IN (
                    'candidate', 'center', 'official', 'super_admin', 'staff', 'system', 'operator')),
  -- The institution the event belongs to (users.id of the institute today). NULL for platform-only
  -- events. Used only to filter in the Super Admin viewer; never as an access grant.
  organization_id text        CHECK (organization_id IS NULL OR length(organization_id) <= 200),
  resource_type   text        NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]*$' AND length(resource_type) <= 64),
  resource_id     text        CHECK (resource_id IS NULL OR length(resource_id) <= 200),
  request_id      uuid,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  before_state    jsonb,
  after_state     jsonb,
  retention_class text        NOT NULL CHECK (retention_class IN ('security', 'financial', 'governance', 'access', 'operational')),
  row_hash        bytea       NOT NULL,
  CONSTRAINT audit_events_actor_consistency CHECK (
    (actor_type = 'user'      AND actor_user_id IS NOT NULL AND actor_role IS NOT NULL) OR
    (actor_type = 'operator'  AND actor_role = 'operator') OR
    (actor_type = 'system'    AND actor_user_id IS NULL AND actor_role = 'system') OR
    (actor_type = 'anonymous' AND actor_user_id IS NULL AND actor_role IS NULL)),
  CONSTRAINT audit_events_reason_for_refusals CHECK (outcome = 'succeeded' OR reason_code IS NOT NULL),
  CONSTRAINT audit_events_json_shapes CHECK (
    jsonb_typeof(metadata) = 'object'
    AND (before_state IS NULL OR jsonb_typeof(before_state) = 'object')
    AND (after_state  IS NULL OR jsonb_typeof(after_state)  = 'object')),
  CONSTRAINT audit_events_payload_size CHECK (
    pg_column_size(metadata) <= 8192
    AND coalesce(pg_column_size(before_state), 0) <= 8192
    AND coalesce(pg_column_size(after_state), 0)  <= 8192),
  -- Defence in depth only (top-level keys); server/audit.ts allow-lists every key per action.
  CONSTRAINT audit_events_no_secret_keys CHECK (NOT (
    metadata ?| ARRAY['password', 'password_hash', 'otp', 'code', 'code_hash', 'token', 'session_token', 'token_hash',
                      'cookie', 'secret', 'api_key', 'card_number', 'cvv', 'upi_pin', 'responses', 'answers', 'file_content'])),
  CONSTRAINT audit_events_hash_length CHECK (octet_length(row_hash) = 32)
);

-- Append-only: reject every UPDATE, DELETE and TRUNCATE.
CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

-- Per-row content hash over a canonical text form; overwrites anything the client supplied.
-- sha256(bytea) is built in (PostgreSQL 11+). Defaults (id, occurred_at) are already set when a
-- BEFORE INSERT trigger runs.
CREATE OR REPLACE FUNCTION audit_events_set_row_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_hash := sha256(convert_to(concat_ws(E'\x1f',
      NEW.id::text, to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      NEW.schema_version::text, NEW.category, NEW.action, NEW.outcome, coalesce(NEW.reason_code, ''),
      NEW.actor_type, coalesce(NEW.actor_user_id, ''), coalesce(NEW.actor_role, ''), coalesce(NEW.organization_id, ''),
      NEW.resource_type, coalesce(NEW.resource_id, ''), coalesce(NEW.request_id::text, ''),
      NEW.metadata::text, coalesce(NEW.before_state::text, ''), coalesce(NEW.after_state::text, ''), NEW.retention_class),
    'UTF8'));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events;
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();
DROP TRIGGER IF EXISTS audit_events_row_hash ON audit_events;
CREATE TRIGGER audit_events_row_hash BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_set_row_hash();

-- Indexes for the Super Admin viewer: newest first, with keyset pagination on (occurred_at, id).
CREATE INDEX IF NOT EXISTS audit_events_recent       ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor        ON audit_events (actor_user_id, occurred_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_organization ON audit_events (organization_id, occurred_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_resource     ON audit_events (resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action       ON audit_events (category, action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_refusals     ON audit_events (occurred_at DESC) WHERE outcome <> 'succeeded';
