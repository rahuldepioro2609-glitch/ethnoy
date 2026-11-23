-- Phase 2B Official authentication isolation foundation.
--
-- ADDITIVE, OPT-IN ARTIFACT ONLY. Deliberately excluded from MIGRATION_FILES and db:migrate.
-- It must be rehearsed on a disposable PostgreSQL 17 database and separately approved before
-- application to any non-disposable database. It never alters existing tables or records.
--
-- Prerequisites:
--   1. public.users exists with its current id, role, and account_status columns.
--   2. officialAuthFoundationRoles.sql and officialAuthFoundationSchemaBootstrap.sql were
--      applied only to the disposable test cluster, or equivalent provisioning was separately approved.
--   3. officialAuthFoundationPublicGrants.sql was applied before this file.
--   4. Run this file as official_auth_owner.
--
-- This schema is storage only. It does not enable authentication endpoints, credential migration,
-- reset/recovery workflows, session issuance, or assertion consumption functions.

DO $apply_guard$
BEGIN
  IF current_user <> 'official_auth_owner'
     OR current_setting('official_auth.apply_foundation', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'official_auth foundation requires official_auth_owner and explicit session opt-in';
  END IF;
END
$apply_guard$;

DO $schema_owner$
BEGIN
  IF (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'official_auth')
       <> 'official_auth_owner' THEN
    RAISE EXCEPTION 'official_auth must be owned by official_auth_owner';
  END IF;
END
$schema_owner$;

REVOKE ALL ON SCHEMA official_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA official_auth TO official_verifier, official_session_gateway;

CREATE TABLE IF NOT EXISTS official_auth.credentials (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  password_hash text NOT NULL,
  hash_scheme text NOT NULL DEFAULT 'bcrypt' CHECK (hash_scheme = 'bcrypt'),
  credential_version bigint NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  credential_state text NOT NULL DEFAULT 'active' CHECK (credential_state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  password_changed_at timestamptz,
  migration_batch_id text,
  CONSTRAINT official_auth_credentials_user_version_key UNIQUE (user_id, credential_version),
  CONSTRAINT official_auth_credentials_bcrypt_check
    CHECK (password_hash ~ '^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$')
);

CREATE TABLE IF NOT EXISTS official_auth.credential_events (
  event_id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'credential_migrated', 'credential_changed', 'credential_disabled', 'credential_enabled'
  )),
  credential_version bigint NOT NULL CHECK (credential_version > 0),
  actor_user_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS official_auth_credential_events_user_idx
  ON official_auth.credential_events (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS official_auth.auth_transactions (
  transaction_id uuid PRIMARY KEY,
  user_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('official_login', 'official_enrolment')),
  challenge_hash char(64) NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  browser_binding_hash char(64) NOT NULL CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'consumed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT official_auth_transactions_lifetime_check CHECK (expires_at > created_at),
  CONSTRAINT official_auth_transactions_state_time_check CHECK (
    (state = 'pending' AND completed_at IS NULL AND consumed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND consumed_at IS NULL)
    OR (state = 'consumed' AND completed_at IS NOT NULL AND consumed_at IS NOT NULL)
  ),
  CONSTRAINT official_auth_transactions_id_user_key UNIQUE (transaction_id, user_id),
  CONSTRAINT official_auth_transactions_binding_key UNIQUE (transaction_id, user_id, purpose)
);
CREATE INDEX IF NOT EXISTS official_auth_transactions_user_state_idx
  ON official_auth.auth_transactions (user_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS official_auth_transactions_expiry_idx
  ON official_auth.auth_transactions (expires_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS official_auth.assertion_consumptions (
  assertion_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('official_login', 'official_enrolment')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT official_auth_assertion_lifetime_check CHECK (expires_at > issued_at),
  CONSTRAINT official_auth_assertion_transaction_key UNIQUE (transaction_id, purpose),
  CONSTRAINT official_auth_assertion_transaction_fkey
    FOREIGN KEY (transaction_id, user_id, purpose)
    REFERENCES official_auth.auth_transactions (transaction_id, user_id, purpose) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS official_auth_assertion_consumptions_expiry_idx
  ON official_auth.assertion_consumptions (expires_at);

CREATE TABLE IF NOT EXISTS official_auth.official_sessions (
  session_token_hash char(64) PRIMARY KEY CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  credential_version bigint NOT NULL CHECK (credential_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT official_auth_sessions_time_check CHECK (expires_at > created_at),
  CONSTRAINT official_auth_sessions_user_key UNIQUE (session_token_hash, user_id)
);
CREATE INDEX IF NOT EXISTS official_auth_sessions_user_idx
  ON official_auth.official_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS official_auth_sessions_expiry_idx
  ON official_auth.official_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS official_auth.mfa_factors (
  factor_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  enrolment_challenge_id char(64),
  kind text NOT NULL CHECK (kind = 'totp'),
  secret_ciphertext bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_tag bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  aad_version smallint NOT NULL CHECK (aad_version IN (1, 2)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  last_used_step bigint NOT NULL DEFAULT -1 CHECK (last_used_step >= -1),
  disabled_at timestamptz,
  disabled_by text REFERENCES public.users(id) ON DELETE RESTRICT,
  disabled_via text,
  CONSTRAINT official_auth_mfa_factors_id_user_key UNIQUE (factor_id, user_id),
  CONSTRAINT official_auth_mfa_kind_check CHECK (kind IN ('totp')),
  CONSTRAINT official_auth_mfa_secret_shape_check CHECK (
    octet_length(secret_ciphertext) = 20
    AND octet_length(secret_nonce) = 12
    AND octet_length(secret_tag) = 16
  ),
  CONSTRAINT official_auth_mfa_disabled_pair_check CHECK ((disabled_at IS NULL) = (disabled_via IS NULL)),
  CONSTRAINT official_auth_mfa_disabled_via_check CHECK (
    disabled_via IS NULL OR disabled_via IN (
      'two_person_reset', 'single_approver_reset', 'break_glass', 'enrolment_superseded'
    )
  ),
  CONSTRAINT official_auth_mfa_disabled_by_check CHECK (disabled_by IS NULL OR disabled_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS official_auth_mfa_one_active_factor_idx
  ON official_auth.mfa_factors (user_id, kind) WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS official_auth_mfa_one_per_enrolment_challenge_idx
  ON official_auth.mfa_factors (enrolment_challenge_id) WHERE enrolment_challenge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS official_auth_mfa_factors_user_idx
  ON official_auth.mfa_factors (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS official_auth.mfa_challenges (
  challenge_hash char(64) PRIMARY KEY CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('login', 'enrol', 'step_up')),
  session_token_hash char(64),
  enrolment_ticket_hash char(64),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_reason text,
  CONSTRAINT official_auth_mfa_challenge_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT official_auth_mfa_challenge_consumption_pair_check
    CHECK ((consumed_at IS NULL) = (consumed_reason IS NULL)),
  CONSTRAINT official_auth_mfa_challenge_reason_check
    CHECK (consumed_reason IS NULL OR consumed_reason IN ('verified', 'locked', 'superseded', 'revoked')),
  CONSTRAINT official_auth_mfa_challenge_session_check
    CHECK ((purpose = 'step_up') = (session_token_hash IS NOT NULL)),
  CONSTRAINT official_auth_mfa_challenge_ticket_check
    CHECK (enrolment_ticket_hash IS NULL OR purpose = 'enrol'),
  CONSTRAINT official_auth_mfa_challenge_transaction_fkey
    FOREIGN KEY (transaction_id, user_id)
    REFERENCES official_auth.auth_transactions (transaction_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT official_auth_mfa_challenge_session_fkey
    FOREIGN KEY (session_token_hash, user_id)
    REFERENCES official_auth.official_sessions (session_token_hash, user_id) ON DELETE RESTRICT,
  CONSTRAINT official_auth_mfa_challenge_id_user_key UNIQUE (challenge_hash, user_id),
  CONSTRAINT official_auth_mfa_challenge_transaction_key UNIQUE (transaction_id, purpose)
);
CREATE INDEX IF NOT EXISTS official_auth_mfa_challenges_user_idx
  ON official_auth.mfa_challenges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS official_auth_mfa_challenges_expiry_idx
  ON official_auth.mfa_challenges (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS official_auth.session_mfa_evidence (
  evidence_id uuid PRIMARY KEY,
  session_token_hash char(64) NOT NULL,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  factor_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('login', 'enrol', 'step_up')),
  method text NOT NULL CHECK (method IN ('totp', 'recovery_code')),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT official_auth_session_mfa_purpose_method_check
    CHECK (purpose = 'login' OR method = 'totp'),
  CONSTRAINT official_auth_session_mfa_evidence_user_key UNIQUE (evidence_id, user_id),
  CONSTRAINT official_auth_session_mfa_session_fkey
    FOREIGN KEY (session_token_hash, user_id)
    REFERENCES official_auth.official_sessions (session_token_hash, user_id) ON DELETE RESTRICT,
  CONSTRAINT official_auth_session_mfa_factor_fkey
    FOREIGN KEY (factor_id, user_id)
    REFERENCES official_auth.mfa_factors (factor_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS official_auth_session_mfa_session_idx
  ON official_auth.session_mfa_evidence (session_token_hash, verified_at DESC);
CREATE INDEX IF NOT EXISTS official_auth_session_mfa_user_idx
  ON official_auth.session_mfa_evidence (user_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS official_auth.reset_requests (
  request_id text PRIMARY KEY,
  target_user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approval_mode text NOT NULL CHECK (approval_mode IN ('two_person', 'single_super_admin')),
  initiated_by text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  initiated_evidence_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executed', 'rejected', 'cancelled', 'expired', 'superseded')),
  decided_by text REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_evidence_id uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 1000),
  ticket_hash char(64),
  CONSTRAINT official_auth_reset_request_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT official_auth_reset_request_target_key UNIQUE (request_id, target_user_id),
  CONSTRAINT official_auth_reset_request_not_self_check CHECK (initiated_by <> target_user_id),
  CONSTRAINT official_auth_reset_request_decider_not_target_check
    CHECK (decided_by IS NULL OR decided_by <> target_user_id),
  CONSTRAINT official_auth_reset_request_decided_pair_check
    CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT official_auth_reset_request_decision_evidence_pair_check
    CHECK ((decided_by IS NULL) = (decided_evidence_id IS NULL)),
  CONSTRAINT official_auth_reset_request_decider_check CHECK (
    CASE WHEN status IN ('executed', 'rejected', 'cancelled')
      THEN decided_by IS NOT NULL AND decided_evidence_id IS NOT NULL
      ELSE decided_by IS NULL AND decided_evidence_id IS NULL
    END
  ),
  CONSTRAINT official_auth_reset_request_ticket_pair_check
    CHECK ((status = 'executed') = (ticket_hash IS NOT NULL)),
  CONSTRAINT official_auth_reset_request_ticket_hash_check
    CHECK (ticket_hash IS NULL OR ticket_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT official_auth_reset_request_initiator_evidence_fkey
    FOREIGN KEY (initiated_evidence_id, initiated_by)
    REFERENCES official_auth.session_mfa_evidence (evidence_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT official_auth_reset_request_decider_evidence_fkey
    FOREIGN KEY (decided_evidence_id, decided_by)
    REFERENCES official_auth.session_mfa_evidence (evidence_id, user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS official_auth_reset_one_pending_per_target_idx
  ON official_auth.reset_requests (target_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS official_auth_reset_status_idx
  ON official_auth.reset_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS official_auth.enrolment_tickets (
  ticket_hash char(64) PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  issued_by text REFERENCES public.users(id) ON DELETE RESTRICT,
  issued_via text NOT NULL CHECK (
    issued_via IN ('super_admin', 'bootstrap_cli', 'two_person_reset', 'single_approver_reset', 'break_glass')
  ),
  reset_request_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT official_auth_ticket_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT official_auth_ticket_single_end_check CHECK (used_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT official_auth_ticket_issuer_check
    CHECK ((issued_via IN ('bootstrap_cli', 'break_glass')) = (issued_by IS NULL)),
  CONSTRAINT official_auth_ticket_reset_pair_check
    CHECK ((issued_via IN ('two_person_reset', 'single_approver_reset')) = (reset_request_id IS NOT NULL)),
  CONSTRAINT official_auth_ticket_not_self_check CHECK (issued_by IS NULL OR issued_by <> user_id),
  CONSTRAINT official_auth_ticket_id_user_key UNIQUE (ticket_hash, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS official_auth_ticket_one_open_per_user_idx
  ON official_auth.enrolment_tickets (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS official_auth.recovery_codes (
  recovery_code_id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  factor_id text NOT NULL,
  code_hash char(64) NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT official_auth_recovery_code_end_check CHECK (used_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT official_auth_recovery_code_factor_fkey
    FOREIGN KEY (factor_id, user_id)
    REFERENCES official_auth.mfa_factors (factor_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS official_auth_recovery_codes_unused_idx
  ON official_auth.recovery_codes (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS official_auth.audit_events (
  event_id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action ~ '^official_auth\.[a-z][a-z0-9_]{0,62}$'),
  actor_user_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  target_user_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS official_auth_audit_events_target_idx
  ON official_auth.audit_events (target_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS official_auth_audit_events_action_idx
  ON official_auth.audit_events (action, occurred_at DESC);

DO $cross_references$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'official_auth_mfa_factor_enrolment_challenge_fkey'
       AND conrelid = 'official_auth.mfa_factors'::regclass
  ) THEN
    ALTER TABLE official_auth.mfa_factors
      ADD CONSTRAINT official_auth_mfa_factor_enrolment_challenge_fkey
      FOREIGN KEY (enrolment_challenge_id, user_id)
      REFERENCES official_auth.mfa_challenges (challenge_hash, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'official_auth_mfa_challenge_ticket_fkey'
       AND conrelid = 'official_auth.mfa_challenges'::regclass
  ) THEN
    ALTER TABLE official_auth.mfa_challenges
      ADD CONSTRAINT official_auth_mfa_challenge_ticket_fkey
      FOREIGN KEY (enrolment_ticket_hash, user_id)
      REFERENCES official_auth.enrolment_tickets (ticket_hash, user_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'official_auth_ticket_reset_request_fkey'
       AND conrelid = 'official_auth.enrolment_tickets'::regclass
  ) THEN
    ALTER TABLE official_auth.enrolment_tickets
      ADD CONSTRAINT official_auth_ticket_reset_request_fkey
      FOREIGN KEY (reset_request_id, user_id)
      REFERENCES official_auth.reset_requests (request_id, target_user_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'official_auth_reset_ticket_fkey'
       AND conrelid = 'official_auth.reset_requests'::regclass
  ) THEN
    ALTER TABLE official_auth.reset_requests
      ADD CONSTRAINT official_auth_reset_ticket_fkey
      FOREIGN KEY (ticket_hash, target_user_id)
      REFERENCES official_auth.enrolment_tickets (ticket_hash, user_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$cross_references$;

CREATE OR REPLACE FUNCTION official_auth.guard_official_user_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $guard_user$
DECLARE
  referenced_user_id text;
  referenced_role text;
BEGIN
  IF TG_ARGV[0] NOT IN (
    'user_id', 'target_user_id', 'actor_user_id', 'disabled_by', 'issued_by', 'initiated_by', 'decided_by'
  ) THEN
    RAISE EXCEPTION 'invalid official user reference column';
  END IF;
  referenced_user_id := to_jsonb(NEW) ->> TG_ARGV[0];
  IF referenced_user_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT u.role INTO referenced_role FROM public.users AS u WHERE u.id = referenced_user_id;
  IF referenced_role IS DISTINCT FROM 'official' THEN
    RAISE EXCEPTION 'official_auth records require an Official user';
  END IF;
  RETURN NEW;
END
$guard_user$;

CREATE OR REPLACE FUNCTION official_auth.protect_mfa_factor_state()
RETURNS trigger
LANGUAGE plpgsql
AS $factor$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user <> 'official_auth_owner'
       AND (NEW.enrolment_challenge_id IS NULL
         OR NEW.confirmed_at IS NOT NULL
         OR NEW.disabled_at IS NOT NULL
         OR NEW.disabled_by IS NOT NULL
         OR NEW.disabled_via IS NOT NULL
         OR NEW.last_used_step <> -1) THEN
      RAISE EXCEPTION 'a new MFA factor requires its enrolment challenge and starts active, unconfirmed, and unused';
    END IF;
    IF NEW.enrolment_challenge_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM official_auth.mfa_challenges AS c
       WHERE c.challenge_hash = NEW.enrolment_challenge_id
         AND c.user_id = NEW.user_id
         AND c.purpose = 'enrol'
         AND c.enrolment_ticket_hash IS NOT NULL
         AND c.consumed_at IS NULL
         AND c.expires_at > clock_timestamp()
    ) AND current_user <> 'official_auth_owner' THEN
      RAISE EXCEPTION 'a new MFA factor must bind to its live enrollment challenge';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MFA factors cannot be deleted';
  END IF;
  IF NEW.factor_id IS DISTINCT FROM OLD.factor_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.enrolment_challenge_id IS DISTINCT FROM OLD.enrolment_challenge_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MFA factor identity is immutable';
  END IF;
  IF NEW.last_used_step < OLD.last_used_step THEN
    RAISE EXCEPTION 'MFA replay counter can only increase';
  END IF;
  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'MFA confirmation timestamp is immutable';
  END IF;
  IF OLD.disabled_at IS NOT NULL AND (
    NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
    OR NEW.disabled_by IS DISTINCT FROM OLD.disabled_by
    OR NEW.disabled_via IS DISTINCT FROM OLD.disabled_via
  ) THEN
    RAISE EXCEPTION 'disabled MFA factor state is terminal';
  END IF;
  IF current_user <> 'official_auth_owner' AND (
    NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext
    OR NEW.secret_nonce IS DISTINCT FROM OLD.secret_nonce
    OR NEW.secret_tag IS DISTINCT FROM OLD.secret_tag
    OR NEW.key_version IS DISTINCT FROM OLD.key_version
    OR NEW.aad_version IS DISTINCT FROM OLD.aad_version
  ) THEN
    RAISE EXCEPTION 'MFA envelope changes are restricted to the schema owner migration path';
  END IF;
  RETURN NEW;
END
$factor$;

CREATE OR REPLACE FUNCTION official_auth.protect_credential_state()
RETURNS trigger
LANGUAGE plpgsql
AS $credential$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Official credential rows cannot be deleted';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Official credential identity and creation time are immutable';
  END IF;
  IF NEW.credential_version < OLD.credential_version THEN
    RAISE EXCEPTION 'credential version cannot decrease';
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     AND NEW.credential_version <= OLD.credential_version THEN
    RAISE EXCEPTION 'changing the password hash requires a higher credential version';
  END IF;
  IF NEW.credential_state IS DISTINCT FROM OLD.credential_state
     AND NEW.credential_version <= OLD.credential_version THEN
    RAISE EXCEPTION 'changing credential state requires a higher credential version';
  END IF;
  RETURN NEW;
END
$credential$;

CREATE OR REPLACE FUNCTION official_auth.protect_auth_transaction_state()
RETURNS trigger
LANGUAGE plpgsql
AS $transaction$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.state <> 'pending'
       OR NEW.completed_at IS NOT NULL
       OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new authentication transaction must start pending';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authentication transactions cannot be deleted';
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.challenge_hash IS DISTINCT FROM OLD.challenge_hash
     OR NEW.browser_binding_hash IS DISTINCT FROM OLD.browser_binding_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'authentication transaction identity and lifetime are immutable';
  END IF;
  IF (OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'completed'))
     OR (OLD.state = 'completed' AND NEW.state NOT IN ('completed', 'consumed'))
     OR (OLD.state = 'consumed' AND NEW.state <> 'consumed') THEN
    RAISE EXCEPTION 'authentication transaction state cannot move backwards';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'authentication transaction completion is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'authentication transaction consumption is immutable';
  END IF;
  RETURN NEW;
END
$transaction$;

CREATE OR REPLACE FUNCTION official_auth.protect_official_session_state()
RETURNS trigger
LANGUAGE plpgsql
AS $session$
DECLARE
  current_credential_version bigint;
  current_credential_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new Official session cannot start revoked';
    END IF;
    SELECT c.credential_version, c.credential_state
      INTO current_credential_version, current_credential_state
      FROM official_auth.credentials AS c
     WHERE c.user_id = NEW.user_id;
    IF current_credential_version IS DISTINCT FROM NEW.credential_version
       OR current_credential_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'session credential version must match an active credential';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Official session records cannot be deleted';
  END IF;
  IF NEW.session_token_hash IS DISTINCT FROM OLD.session_token_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.credential_version IS DISTINCT FROM OLD.credential_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Official session identity, credential version, and expiry are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Official session revocation is terminal';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$session$;

CREATE OR REPLACE FUNCTION official_auth.protect_mfa_challenge_state()
RETURNS trigger
LANGUAGE plpgsql
AS $challenge$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.attempts <> 0 OR NEW.consumed_at IS NOT NULL OR NEW.consumed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a new MFA challenge starts unused';
    END IF;
    IF current_user = 'official_session_gateway' AND NEW.purpose <> 'step_up' THEN
      RAISE EXCEPTION 'the session gateway may create only step-up MFA challenges';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM official_auth.auth_transactions AS t
       WHERE t.transaction_id = NEW.transaction_id
         AND t.user_id = NEW.user_id
         AND ((NEW.purpose = 'login' AND t.purpose = 'official_login')
           OR (NEW.purpose = 'enrol' AND t.purpose = 'official_enrolment')
           OR (NEW.purpose = 'step_up' AND t.purpose = 'official_login'))
    ) THEN
      RAISE EXCEPTION 'MFA challenge purpose must match its authentication transaction';
    END IF;
    IF NEW.purpose = 'step_up' AND NOT EXISTS (
      SELECT 1
        FROM official_auth.official_sessions AS s
        JOIN official_auth.credentials AS c
          ON c.user_id = s.user_id
         AND c.credential_version = s.credential_version
         AND c.credential_state = 'active'
       WHERE s.session_token_hash = NEW.session_token_hash
         AND s.user_id = NEW.user_id
         AND s.revoked_at IS NULL
         AND s.expires_at > NEW.created_at
    ) THEN
      RAISE EXCEPTION 'a step-up challenge requires a live session of the same Official';
    END IF;
    IF NEW.enrolment_ticket_hash IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM official_auth.enrolment_tickets AS t
       WHERE t.ticket_hash = NEW.enrolment_ticket_hash
         AND t.user_id = NEW.user_id
         AND t.used_at IS NULL
         AND t.revoked_at IS NULL
         AND t.expires_at > NEW.created_at
    ) THEN
      RAISE EXCEPTION 'an MFA challenge requires a live enrollment ticket';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MFA challenges cannot be deleted';
  END IF;
  IF NEW.challenge_hash IS DISTINCT FROM OLD.challenge_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.session_token_hash IS DISTINCT FROM OLD.session_token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'MFA challenge identity and lifetime are immutable';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'MFA challenge attempts can increase only one at a time';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND (
    NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
    OR NEW.consumed_reason IS DISTINCT FROM OLD.consumed_reason
  ) THEN
    RAISE EXCEPTION 'consumed MFA challenge state is terminal';
  END IF;
  IF OLD.enrolment_ticket_hash IS NOT NULL
     AND NEW.enrolment_ticket_hash IS DISTINCT FROM OLD.enrolment_ticket_hash THEN
    RAISE EXCEPTION 'MFA challenge ticket binding is immutable once set';
  END IF;
  IF OLD.enrolment_ticket_hash IS NULL AND NEW.enrolment_ticket_hash IS NOT NULL
     AND (NEW.purpose <> 'enrol' OR NOT EXISTS (
       SELECT 1 FROM official_auth.enrolment_tickets AS t
        WHERE t.ticket_hash = NEW.enrolment_ticket_hash
          AND t.user_id = NEW.user_id
          AND t.used_at IS NULL
          AND t.revoked_at IS NULL
          AND t.expires_at > clock_timestamp()
     )) THEN
    RAISE EXCEPTION 'an enrollment challenge can bind only to a live ticket for the same Official';
  END IF;
  IF clock_timestamp() >= OLD.expires_at AND (
       NEW.attempts <> OLD.attempts
       OR NEW.enrolment_ticket_hash IS DISTINCT FROM OLD.enrolment_ticket_hash
       OR NEW.consumed_reason = 'verified'
  ) THEN
    RAISE EXCEPTION 'an expired MFA challenge cannot be used';
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN
    NEW.consumed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$challenge$;

CREATE OR REPLACE FUNCTION official_auth.protect_enrolment_ticket_state()
RETURNS trigger
LANGUAGE plpgsql
AS $ticket$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new enrollment ticket starts unused and unrevoked';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'enrollment tickets cannot be deleted';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used or revoked enrollment ticket cannot change';
  END IF;
  IF NEW.ticket_hash IS DISTINCT FROM OLD.ticket_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.issued_via IS DISTINCT FROM OLD.issued_via
     OR NEW.reset_request_id IS DISTINCT FROM OLD.reset_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'enrollment ticket identity and lifetime are immutable';
  END IF;
  IF NEW.used_at IS NOT NULL THEN
    IF clock_timestamp() >= OLD.expires_at THEN
      RAISE EXCEPTION 'an expired enrollment ticket cannot be used';
    END IF;
    NEW.used_at := clock_timestamp();
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$ticket$;

CREATE OR REPLACE FUNCTION official_auth.protect_recovery_code_state()
RETURNS trigger
LANGUAGE plpgsql
AS $recovery$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new recovery code starts unused and unrevoked';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recovery code history cannot be deleted';
  END IF;
  IF NEW.recovery_code_id IS DISTINCT FROM OLD.recovery_code_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.factor_id IS DISTINCT FROM OLD.factor_id
     OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'recovery code identity is immutable';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used or revoked recovery code cannot change';
  END IF;
  IF NEW.used_at IS NOT NULL THEN
    NEW.used_at := clock_timestamp();
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$recovery$;

CREATE OR REPLACE FUNCTION official_auth.reject_immutable_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable$
BEGIN
  RAISE EXCEPTION 'official_auth history is immutable';
END
$immutable$;

CREATE OR REPLACE FUNCTION official_auth.validate_session_mfa_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $evidence$
BEGIN
  NEW.verified_at := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1 FROM official_auth.official_sessions AS s
     WHERE s.session_token_hash = NEW.session_token_hash
       AND s.user_id = NEW.user_id
       AND s.revoked_at IS NULL
       AND s.expires_at > NEW.verified_at
  ) THEN
    RAISE EXCEPTION 'MFA evidence requires a live Official session';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM official_auth.mfa_factors AS f
     WHERE f.factor_id = NEW.factor_id
       AND f.user_id = NEW.user_id
       AND f.confirmed_at IS NOT NULL
       AND f.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MFA evidence requires a confirmed active factor';
  END IF;
  RETURN NEW;
END
$evidence$;

DROP TRIGGER IF EXISTS official_auth_credentials_official_user ON official_auth.credentials;
CREATE TRIGGER official_auth_credentials_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.credentials
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_credential_events_official_user ON official_auth.credential_events;
CREATE TRIGGER official_auth_credential_events_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.credential_events
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_credential_events_actor_official_user ON official_auth.credential_events;
CREATE TRIGGER official_auth_credential_events_actor_official_user
  BEFORE INSERT OR UPDATE OF actor_user_id ON official_auth.credential_events
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('actor_user_id');
DROP TRIGGER IF EXISTS official_auth_transactions_official_user ON official_auth.auth_transactions;
CREATE TRIGGER official_auth_transactions_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.auth_transactions
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_assertions_official_user ON official_auth.assertion_consumptions;
CREATE TRIGGER official_auth_assertions_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.assertion_consumptions
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_sessions_official_user ON official_auth.official_sessions;
CREATE TRIGGER official_auth_sessions_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.official_sessions
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_factors_official_user ON official_auth.mfa_factors;
CREATE TRIGGER official_auth_factors_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.mfa_factors
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_factors_disabled_by_official_user ON official_auth.mfa_factors;
CREATE TRIGGER official_auth_factors_disabled_by_official_user
  BEFORE INSERT OR UPDATE OF disabled_by ON official_auth.mfa_factors
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('disabled_by');
DROP TRIGGER IF EXISTS official_auth_challenges_official_user ON official_auth.mfa_challenges;
CREATE TRIGGER official_auth_challenges_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.mfa_challenges
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_tickets_official_user ON official_auth.enrolment_tickets;
CREATE TRIGGER official_auth_tickets_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.enrolment_tickets
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_tickets_issuer_official_user ON official_auth.enrolment_tickets;
CREATE TRIGGER official_auth_tickets_issuer_official_user
  BEFORE INSERT OR UPDATE OF issued_by ON official_auth.enrolment_tickets
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('issued_by');
DROP TRIGGER IF EXISTS official_auth_recovery_codes_official_user ON official_auth.recovery_codes;
CREATE TRIGGER official_auth_recovery_codes_official_user
  BEFORE INSERT OR UPDATE OF user_id ON official_auth.recovery_codes
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('user_id');
DROP TRIGGER IF EXISTS official_auth_reset_target_official_user ON official_auth.reset_requests;
CREATE TRIGGER official_auth_reset_target_official_user
  BEFORE INSERT OR UPDATE OF target_user_id ON official_auth.reset_requests
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('target_user_id');
DROP TRIGGER IF EXISTS official_auth_reset_initiator_official_user ON official_auth.reset_requests;
CREATE TRIGGER official_auth_reset_initiator_official_user
  BEFORE INSERT OR UPDATE OF initiated_by ON official_auth.reset_requests
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('initiated_by');
DROP TRIGGER IF EXISTS official_auth_reset_decider_official_user ON official_auth.reset_requests;
CREATE TRIGGER official_auth_reset_decider_official_user
  BEFORE INSERT OR UPDATE OF decided_by ON official_auth.reset_requests
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('decided_by');
DROP TRIGGER IF EXISTS official_auth_audit_actor_official_user ON official_auth.audit_events;
CREATE TRIGGER official_auth_audit_actor_official_user
  BEFORE INSERT OR UPDATE OF actor_user_id ON official_auth.audit_events
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('actor_user_id');
DROP TRIGGER IF EXISTS official_auth_audit_target_official_user ON official_auth.audit_events;
CREATE TRIGGER official_auth_audit_target_official_user
  BEFORE INSERT OR UPDATE OF target_user_id ON official_auth.audit_events
  FOR EACH ROW EXECUTE FUNCTION official_auth.guard_official_user_reference('target_user_id');

DROP TRIGGER IF EXISTS official_auth_session_evidence_validate ON official_auth.session_mfa_evidence;
CREATE TRIGGER official_auth_session_evidence_validate
  BEFORE INSERT ON official_auth.session_mfa_evidence
  FOR EACH ROW EXECUTE FUNCTION official_auth.validate_session_mfa_evidence();

DROP TRIGGER IF EXISTS official_auth_mfa_factor_state_guard ON official_auth.mfa_factors;
CREATE TRIGGER official_auth_mfa_factor_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON official_auth.mfa_factors
  FOR EACH ROW EXECUTE FUNCTION official_auth.protect_mfa_factor_state();
DROP TRIGGER IF EXISTS official_auth_transaction_state_guard ON official_auth.auth_transactions;
CREATE TRIGGER official_auth_transaction_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON official_auth.auth_transactions
  FOR EACH ROW EXECUTE FUNCTION official_auth.protect_auth_transaction_state();
DROP TRIGGER IF EXISTS official_auth_credential_state_guard ON official_auth.credentials;
CREATE TRIGGER official_auth_credential_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON official_auth.credentials
  FOR EACH ROW EXECUTE FUNCTION official_auth.protect_credential_state();
DROP TRIGGER IF EXISTS official_auth_session_state_guard ON official_auth.official_sessions;
CREATE TRIGGER official_auth_session_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON official_auth.official_sessions
  FOR EACH ROW EXECUTE FUNCTION official_auth.protect_official_session_state();
DROP TRIGGER IF EXISTS official_auth_mfa_challenge_state_guard ON official_auth.mfa_challenges;
CREATE TRIGGER official_auth_mfa_challenge_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON official_auth.mfa_challenges
  FOR EACH ROW EXECUTE FUNCTION official_auth.protect_mfa_challenge_state();
ALTER TABLE official_auth.official_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS official_auth_sessions_live_select ON official_auth.official_sessions;
CREATE POLICY official_auth_sessions_live_select
  ON official_auth.official_sessions
  FOR SELECT
  TO official_verifier, official_session_gateway
  USING (
    revoked_at IS NULL
    AND expires_at > clock_timestamp()
    AND EXISTS (
      SELECT 1 FROM official_auth.credentials AS c
       WHERE c.user_id = official_sessions.user_id
         AND c.credential_version = official_sessions.credential_version
         AND c.credential_state = 'active'
    )
  );
DROP POLICY IF EXISTS official_auth_sessions_gateway_insert ON official_auth.official_sessions;
CREATE POLICY official_auth_sessions_gateway_insert
  ON official_auth.official_sessions
  FOR INSERT
  TO official_session_gateway
  WITH CHECK (
    revoked_at IS NULL
    AND expires_at > clock_timestamp()
    AND EXISTS (
      SELECT 1 FROM official_auth.credentials AS c
       WHERE c.user_id = official_sessions.user_id
         AND c.credential_version = official_sessions.credential_version
         AND c.credential_state = 'active'
    )
  );
DROP POLICY IF EXISTS official_auth_sessions_gateway_revoke ON official_auth.official_sessions;
CREATE POLICY official_auth_sessions_gateway_revoke
  ON official_auth.official_sessions
  FOR UPDATE
  TO official_session_gateway
  USING (
    revoked_at IS NULL
    AND expires_at > clock_timestamp()
    AND EXISTS (
      SELECT 1 FROM official_auth.credentials AS c
       WHERE c.user_id = official_sessions.user_id
         AND c.credential_version = official_sessions.credential_version
         AND c.credential_state = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM official_auth.credentials AS c
       WHERE c.user_id = official_sessions.user_id
         AND c.credential_version = official_sessions.credential_version
         AND c.credential_state = 'active'
    )
  );
DROP TRIGGER IF EXISTS official_auth_enrolment_ticket_state_guard ON official_auth.enrolment_tickets;
CREATE TRIGGER official_auth_enrolment_ticket_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON official_auth.enrolment_tickets
  FOR EACH ROW EXECUTE FUNCTION official_auth.protect_enrolment_ticket_state();
DROP TRIGGER IF EXISTS official_auth_recovery_code_state_guard ON official_auth.recovery_codes;
CREATE TRIGGER official_auth_recovery_code_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON official_auth.recovery_codes
  FOR EACH ROW EXECUTE FUNCTION official_auth.protect_recovery_code_state();

DROP TRIGGER IF EXISTS official_auth_credential_events_immutable ON official_auth.credential_events;
CREATE TRIGGER official_auth_credential_events_immutable
  BEFORE UPDATE OR DELETE ON official_auth.credential_events
  FOR EACH ROW EXECUTE FUNCTION official_auth.reject_immutable_record_mutation();
DROP TRIGGER IF EXISTS official_auth_credential_events_no_truncate ON official_auth.credential_events;
CREATE TRIGGER official_auth_credential_events_no_truncate
  BEFORE TRUNCATE ON official_auth.credential_events
  FOR EACH STATEMENT EXECUTE FUNCTION official_auth.reject_immutable_record_mutation();
DROP TRIGGER IF EXISTS official_auth_session_evidence_immutable ON official_auth.session_mfa_evidence;
CREATE TRIGGER official_auth_session_evidence_immutable
  BEFORE UPDATE OR DELETE ON official_auth.session_mfa_evidence
  FOR EACH ROW EXECUTE FUNCTION official_auth.reject_immutable_record_mutation();
DROP TRIGGER IF EXISTS official_auth_session_evidence_no_truncate ON official_auth.session_mfa_evidence;
CREATE TRIGGER official_auth_session_evidence_no_truncate
  BEFORE TRUNCATE ON official_auth.session_mfa_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION official_auth.reject_immutable_record_mutation();
DROP TRIGGER IF EXISTS official_auth_audit_events_immutable ON official_auth.audit_events;
CREATE TRIGGER official_auth_audit_events_immutable
  BEFORE UPDATE OR DELETE ON official_auth.audit_events
  FOR EACH ROW EXECUTE FUNCTION official_auth.reject_immutable_record_mutation();
DROP TRIGGER IF EXISTS official_auth_audit_events_no_truncate ON official_auth.audit_events;
CREATE TRIGGER official_auth_audit_events_no_truncate
  BEFORE TRUNCATE ON official_auth.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION official_auth.reject_immutable_record_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA official_auth FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA official_auth FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA official_auth REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA official_auth REVOKE ALL ON FUNCTIONS FROM PUBLIC;
