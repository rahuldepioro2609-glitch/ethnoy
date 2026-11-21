-- AUTH C1.8 (MFA Phase 2): privileged MFA schema for Officials and Super Admins.
-- Specification: docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md (revision 2) §9, with these owner decisions:
-- - D-1 (2026-11-15): a Super Admin target needs two different Super Admins (initiator and approver); an
--   ordinary Official target needs one Super Admin other than the target;
-- - recovery codes and tickets keep revoked_at;
-- - the session evidence table is auth_session_mfa_verifications.
--
-- Six additive tables. They store no plaintext secret, code, token or ticket:
-- - admin_mfa_factors              TOTP secret as AES-256-GCM ciphertext, nonce and tag, plus key version;
--                                  last_used_step supports the atomic replay guard
--                                  (UPDATE ... WHERE last_used_step < $step);
-- - admin_mfa_recovery_codes       HMAC-SHA256 hex digests only; single use (used_at) or revoked;
-- - admin_mfa_challenges           id = SHA-256 hex of the challenge token; single use; expiring;
--                                  step-up challenges are bound to one session of the same user;
-- - admin_mfa_enrolment_tickets    id = SHA-256 hex of the ticket; single use; expiring;
-- - auth_session_mfa_verifications INSERT-ONLY evidence, many rows per session (login, enrol, step_up);
--                                  verified_at is always the database clock;
-- - admin_mfa_reset_requests       pending -> executed | rejected | cancelled | expired | superseded.
--                                  Finished requests can never change.
--
-- Defence in depth. The triggers below re-check, against the current users and session rows, the
-- rules the application must already enforce:
-- - the target is an Official;
-- - the approval mode matches the target (two_person for a Super Admin, single_super_admin otherwise);
-- - initiators and deciders are approved Super Admins;
-- - decisions carry TOTP evidence from a live session of the deciding person;
-- - a two-person approver verified TOTP after the request was created.
-- The FRESHNESS WINDOW (an owner value) and the full authorization remain application duties
-- (MFA Phases 3 and 6). These constraints do not replace them.
--
-- Commit-time integrity (AUTH C1.8.4; F1, F2, O-3). Deferred constraint triggers refuse the COMMIT, and so
-- roll back the whole transaction, unless:
-- - every reset ticket commits together with its executed request (same target, ticket, decider, mode);
-- - every executed reset (and every break-glass ticket) leaves the target with no active factor, no
--   unused recovery code, no open challenge, no other open ticket and no unexpired session, with an open
--   replacement ticket and its audit event;
-- - every reset-labelled or break-glass factor disable belongs to such a reset in the same transaction.
-- Ticket issuers, request state, the first-time and bootstrap rules are checked at INSERT.
-- O-1 (open, to be resolved before MFA Phase 7): the operator CLI and the API share database credentials,
-- so no trigger can tell who issued a bootstrap or break-glass ticket. These checks validate the workflow,
-- not the caller.
--
-- Audit. No new audit table: events go to the existing append-only auth_verification_events
-- (authVerificationMigration.sql), actions prefixed 'admin_mfa.' (specification §9). This migration
-- does not change that table.
-- - user_id is the account concerned.
-- - details may hold only: actorId, actorKind ('user' or 'operator'), requestId, approvalMode, reason,
--   outcome, sessionsRevoked, codesRemaining, incidentRef, operatorIdentity (self-asserted), host,
--   eligibleSuperAdmins.
-- - Never a secret, code, token, ticket, key, hash or credential.
-- Approved actions:
--   admin_mfa.challenge_created  admin_mfa.verified  admin_mfa.code_rejected  admin_mfa.challenge_locked
--   admin_mfa.throttled  admin_mfa.recovery_code_used  admin_mfa.recovery_codes_regenerated
--   admin_mfa.ticket_issued  admin_mfa.ticket_used  admin_mfa.enrolment_started  admin_mfa.enrolled
--   admin_mfa.step_up_verified  admin_mfa.step_up_refused  admin_mfa.reset_initiated  admin_mfa.reset_approved
--   admin_mfa.reset_rejected  admin_mfa.reset_cancelled  admin_mfa.reset_expired  admin_mfa.reset_refused
--   admin_mfa.reset_executed  admin_mfa.break_glass_reset  admin_mfa.break_glass_acknowledged
--   admin_mfa.bootstrap_ticket_issued
--
-- Additive and re-runnable: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS
-- followed by CREATE TRIGGER, and guarded additions for the nullable factor challenge association plus
-- foreign keys. Existing factor rows are not backfilled and remain NULL-associated. No permission is
-- changed. Needs users and auth_sessions (schema.sql); runs after the AUTH C1 claims migration and
-- before the grants migration.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_mfa_factors (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  enrolment_challenge_id text,
  kind text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_tag bytea NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  last_used_step bigint NOT NULL DEFAULT -1,
  disabled_at timestamptz,
  disabled_by text REFERENCES users(id) ON DELETE RESTRICT,
  disabled_via text,
  CONSTRAINT admin_mfa_factors_id_user_key UNIQUE (id, user_id),
  CONSTRAINT admin_mfa_factors_kind_check CHECK (kind IN ('totp')),
  CONSTRAINT admin_mfa_factors_secret_shape_check CHECK (
    octet_length(secret_ciphertext) = 20 AND octet_length(secret_nonce) = 12 AND octet_length(secret_tag) = 16),
  CONSTRAINT admin_mfa_factors_key_version_check CHECK (key_version >= 1),
  CONSTRAINT admin_mfa_factors_last_used_step_check CHECK (last_used_step >= -1),
  CONSTRAINT admin_mfa_factors_disabled_via_check CHECK (
    disabled_via IN ('two_person_reset', 'single_approver_reset', 'break_glass', 'enrolment_superseded')),
  CONSTRAINT admin_mfa_factors_disabled_pair_check CHECK ((disabled_at IS NULL) = (disabled_via IS NULL)),
  CONSTRAINT admin_mfa_factors_disabled_by_check CHECK (disabled_by IS NULL OR disabled_at IS NOT NULL)
);
-- Existing factors remain NULL-associated; only newly inserted factors require a challenge.
ALTER TABLE admin_mfa_factors ADD COLUMN IF NOT EXISTS enrolment_challenge_id text;
-- One active (not disabled) factor of each kind per user, confirmed or still being enrolled.
CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_factors_one_active_idx ON admin_mfa_factors (user_id, kind) WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_factors_one_per_enrolment_challenge_idx
  ON admin_mfa_factors (enrolment_challenge_id) WHERE enrolment_challenge_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  factor_id text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (factor_id, user_id) REFERENCES admin_mfa_factors(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT admin_mfa_recovery_codes_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_mfa_recovery_codes_single_end_check CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS admin_mfa_recovery_codes_unused_idx ON admin_mfa_recovery_codes (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_session_mfa_verifications (
  id text PRIMARY KEY,
  token_hash text NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose text NOT NULL,
  method text NOT NULL,
  factor_id text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (factor_id, user_id) REFERENCES admin_mfa_factors(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT auth_session_mfa_verifications_id_user_key UNIQUE (id, user_id),
  CONSTRAINT auth_session_mfa_verifications_purpose_check CHECK (purpose IN ('login', 'enrol', 'step_up')),
  CONSTRAINT auth_session_mfa_verifications_method_check CHECK (method IN ('totp', 'recovery_code')),
  -- Recovery codes never satisfy step-up (approved) and never confirm an enrolment.
  CONSTRAINT auth_session_mfa_verifications_totp_only_check CHECK (purpose = 'login' OR method = 'totp')
);
CREATE INDEX IF NOT EXISTS auth_session_mfa_verifications_session_idx ON auth_session_mfa_verifications (token_hash, verified_at DESC);
CREATE INDEX IF NOT EXISTS auth_session_mfa_verifications_user_idx ON auth_session_mfa_verifications (user_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS admin_mfa_reset_requests (
  id text PRIMARY KEY,
  target_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approval_mode text NOT NULL,
  initiated_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  initiated_verification_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by text REFERENCES users(id) ON DELETE RESTRICT,
  decided_verification_id text,
  decided_at timestamptz,
  decision_reason text,
  ticket_id text,
  FOREIGN KEY (initiated_verification_id, initiated_by) REFERENCES auth_session_mfa_verifications(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (decided_verification_id, decided_by) REFERENCES auth_session_mfa_verifications(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT admin_mfa_reset_requests_mode_check CHECK (approval_mode IN ('two_person', 'single_super_admin')),
  CONSTRAINT admin_mfa_reset_requests_status_check CHECK (status IN ('pending', 'executed', 'rejected', 'cancelled', 'expired', 'superseded')),
  CONSTRAINT admin_mfa_reset_requests_reason_check CHECK (char_length(btrim(reason)) >= 1 AND char_length(reason) <= 1000),
  CONSTRAINT admin_mfa_reset_requests_decision_reason_check CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 1000),
  CONSTRAINT admin_mfa_reset_requests_expiry_check CHECK (expires_at > created_at),
  -- Nobody resets their own MFA.
  CONSTRAINT admin_mfa_reset_requests_not_self_target_check CHECK (initiated_by <> target_user_id),
  CONSTRAINT admin_mfa_reset_requests_decider_not_target_check CHECK (decided_by IS NULL OR decided_by <> target_user_id),
  -- Two-person: the approver is never the initiator. Single Super Admin (ordinary Official target): the
  -- initiating Super Admin executes.
  CONSTRAINT admin_mfa_reset_requests_two_person_check CHECK (
    status <> 'executed' OR approval_mode <> 'two_person' OR decided_by <> initiated_by),
  CONSTRAINT admin_mfa_reset_requests_single_approver_check CHECK (
    status <> 'executed' OR approval_mode <> 'single_super_admin' OR decided_by = initiated_by),
  -- A rejection comes from someone other than the initiator (the initiator cancels instead).
  CONSTRAINT admin_mfa_reset_requests_reject_check CHECK (status <> 'rejected' OR decided_by <> initiated_by),
  CONSTRAINT admin_mfa_reset_requests_cancel_check CHECK (status <> 'cancelled' OR decided_by = initiated_by),
  CONSTRAINT admin_mfa_reset_requests_decided_pair_check CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT admin_mfa_reset_requests_decider_check CHECK (
    CASE WHEN status IN ('executed', 'rejected', 'cancelled') THEN decided_by IS NOT NULL AND decided_verification_id IS NOT NULL
         ELSE decided_by IS NULL AND decided_verification_id IS NULL END),
  CONSTRAINT admin_mfa_reset_requests_ticket_check CHECK ((status = 'executed') = (ticket_id IS NOT NULL))
);
-- At most one pending request per target.
CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_reset_requests_one_pending_idx ON admin_mfa_reset_requests (target_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS admin_mfa_reset_requests_status_idx ON admin_mfa_reset_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_mfa_enrolment_tickets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issued_by text REFERENCES users(id) ON DELETE RESTRICT,
  issued_via text NOT NULL,
  reset_request_id text REFERENCES admin_mfa_reset_requests(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT admin_mfa_enrolment_tickets_id_user_key UNIQUE (id, user_id),
  CONSTRAINT admin_mfa_enrolment_tickets_id_check CHECK (id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_mfa_enrolment_tickets_via_check CHECK (
    issued_via IN ('super_admin', 'bootstrap_cli', 'two_person_reset', 'single_approver_reset', 'break_glass')),
  -- Operator CLI tickets have no issuing user; every other ticket names one.
  CONSTRAINT admin_mfa_enrolment_tickets_issuer_check CHECK ((issued_via IN ('bootstrap_cli', 'break_glass')) = (issued_by IS NULL)),
  CONSTRAINT admin_mfa_enrolment_tickets_request_check CHECK (
    (issued_via IN ('two_person_reset', 'single_approver_reset')) = (reset_request_id IS NOT NULL)),
  CONSTRAINT admin_mfa_enrolment_tickets_not_self_check CHECK (issued_by IS NULL OR issued_by <> user_id),
  CONSTRAINT admin_mfa_enrolment_tickets_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT admin_mfa_enrolment_tickets_single_end_check CHECK (used_at IS NULL OR revoked_at IS NULL)
);
-- At most one open (unused, unrevoked) ticket per user.
CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_enrolment_tickets_one_open_idx ON admin_mfa_enrolment_tickets (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_mfa_challenges (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose text NOT NULL,
  session_token_hash text REFERENCES auth_sessions(token_hash) ON DELETE RESTRICT,
  enrolment_ticket_id text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_reason text,
  FOREIGN KEY (enrolment_ticket_id, user_id) REFERENCES admin_mfa_enrolment_tickets(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT admin_mfa_challenges_id_check CHECK (id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admin_mfa_challenges_purpose_check CHECK (purpose IN ('login', 'enrol', 'step_up')),
  CONSTRAINT admin_mfa_challenges_session_check CHECK ((purpose = 'step_up') = (session_token_hash IS NOT NULL)),
  CONSTRAINT admin_mfa_challenges_ticket_check CHECK (enrolment_ticket_id IS NULL OR purpose = 'enrol'),
  CONSTRAINT admin_mfa_challenges_attempts_check CHECK (attempts >= 0),
  CONSTRAINT admin_mfa_challenges_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT admin_mfa_challenges_consumed_pair_check CHECK ((consumed_at IS NULL) = (consumed_reason IS NULL)),
  CONSTRAINT admin_mfa_challenges_consumed_reason_check CHECK (consumed_reason IN ('verified', 'locked', 'superseded', 'revoked'))
);
-- A composite unique target enforces that a factor and its exact challenge share one user.
CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_challenges_id_user_idx ON admin_mfa_challenges (id, user_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_mfa_factors_enrolment_challenge_fkey'
       AND conrelid = to_regclass('admin_mfa_factors')
  ) THEN
    ALTER TABLE admin_mfa_factors
      ADD CONSTRAINT admin_mfa_factors_enrolment_challenge_fkey
      FOREIGN KEY (enrolment_challenge_id, user_id)
      REFERENCES admin_mfa_challenges(id, user_id) ON DELETE RESTRICT;
  END IF;
END
$$;
-- At most one open step-up challenge per session.
CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_challenges_one_step_up_idx ON admin_mfa_challenges (session_token_hash) WHERE purpose = 'step_up' AND consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS admin_mfa_challenges_user_idx ON admin_mfa_challenges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_mfa_challenges_open_idx ON admin_mfa_challenges (expires_at) WHERE consumed_at IS NULL;

-- Closes the reference cycle (tickets -> requests above; requests -> tickets here). An executed
-- request names the ticket it issued; the trigger checks that the ticket points back to it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_mfa_reset_requests_ticket_fkey' AND conrelid = to_regclass('admin_mfa_reset_requests')
  ) THEN
    ALTER TABLE admin_mfa_reset_requests
      ADD CONSTRAINT admin_mfa_reset_requests_ticket_fkey FOREIGN KEY (ticket_id) REFERENCES admin_mfa_enrolment_tickets(id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Trigger functions (no EXECUTE grant is needed or given: the grants migration revokes EXECUTE)
-- ---------------------------------------------------------------------------------------------

-- TRUNCATE is refused on every MFA table, for every role.
CREATE OR REPLACE FUNCTION reject_admin_mfa_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin MFA records cannot be truncated';
END;
$$;

-- Session MFA evidence is insert-only.
CREATE OR REPLACE FUNCTION reject_auth_session_mfa_verification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'session MFA evidence is insert-only';
END;
$$;

-- Evidence belongs to a live session of the same user and a confirmed, active factor; the time is the
-- database clock, never a caller-supplied value.
CREATE OR REPLACE FUNCTION check_auth_session_mfa_verification_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.verified_at := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1 FROM auth_sessions s
     WHERE s.token_hash = NEW.token_hash AND s.user_id = NEW.user_id
       AND s.revoked_at IS NULL AND s.expires_at > NEW.verified_at
  ) THEN
    RAISE EXCEPTION 'MFA evidence must belong to a live session of the same user';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM admin_mfa_factors f
     WHERE f.id = NEW.factor_id AND f.user_id = NEW.user_id AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MFA evidence requires a confirmed, active factor';
  END IF;
  RETURN NEW;
END;
$$;

-- Factors: only Officials enrol; a new factor starts unconfirmed with no used step. Disabled is
-- terminal; last_used_step never decreases; confirmed_at is set once. Timestamps come from the
-- database clock. Rows are never deleted. (The secret columns and key_version are not granted to the
-- API role; a separately approved key-rotation script, run by the owner, may re-encrypt them.)
--
-- O-4 (AUTH C1.8.4, mandatory Phase 4 requirement). Two enforcement points in this one trigger:
--
-- A. Factor INSERT (enrollment start). The database requires the factor's exact challenge ID and
--    verifies that the referenced open, unexpired enrolment challenge belongs to the same user and
--    that its enrolment_ticket_id references a ticket that:
--      - belongs to the same user,
--      - is not used or revoked,
--      - was created no more than ENROLMENT_TICKET_TTL_SECONDS (1,800 s, owner decision) ago.
--    The INSERT is refused if any condition fails. The ticket is NOT consumed here: it remains
--    open for the subsequent confirmation step, so a rollback or an interruption after factor
--    INSERT leaves the ticket available for retry.
--
-- B. Factor UPDATE to set confirmed_at (enrollment confirm). The database re-reads the open enrol
--    challenge and its linked ticket for the same user, verifies the ticket is still open and
--    unexpired, then sets the ticket's used_at atomically in the same statement that confirms the
--    factor. This UPDATE fires protect_admin_mfa_enrolment_ticket() on the ticket row, which
--    enforces all single-use and expiry guards on that table. If the UPDATE affects zero rows (e.g.
--    a concurrent confirmation already consumed the ticket, or the ticket expired), the COMMIT is
--    refused and the whole transaction rolls back.
--
-- The factor's enrolment_challenge_id is immutable. Because the challenge trigger makes
-- enrolment_ticket_id immutable once set, confirmation can consume only the ticket belonging to
-- that factor's exact challenge.
CREATE OR REPLACE FUNCTION protect_admin_mfa_factor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- O-4: approved ticket lifetime (owner decision: 1,800 seconds).
  ENROLMENT_TICKET_TTL_SECONDS constant integer := 1800;
  enrol_challenge record;
  rows_updated integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin MFA factors cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.enrolment_challenge_id IS NULL THEN
      RAISE EXCEPTION 'a new admin MFA factor requires its exact enrolment challenge';
    END IF;
    IF NEW.confirmed_at IS NOT NULL OR NEW.disabled_at IS NOT NULL OR NEW.disabled_by IS NOT NULL
       OR NEW.disabled_via IS NOT NULL OR NEW.last_used_step <> -1 THEN
      RAISE EXCEPTION 'a new admin MFA factor starts unconfirmed, active and unused';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.role = 'official') THEN
      RAISE EXCEPTION 'admin MFA factors are for Officials only';
    END IF;
    -- O-4-A: validate only the exact, live enrolment challenge supplied by the factor row.
    SELECT c.id, c.user_id, c.enrolment_ticket_id INTO enrol_challenge
      FROM admin_mfa_challenges c
     WHERE c.id = NEW.enrolment_challenge_id
       AND c.user_id = NEW.user_id
       AND c.purpose = 'enrol'
       AND c.consumed_at IS NULL
       AND c.expires_at > clock_timestamp()
       AND c.enrolment_ticket_id IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a factor requires its exact live enrolment challenge with a bound ticket';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM admin_mfa_enrolment_tickets t
       WHERE t.id = enrol_challenge.enrolment_ticket_id
         AND t.user_id = enrol_challenge.user_id
         AND t.used_at IS NULL
         AND t.revoked_at IS NULL
         AND t.expires_at > clock_timestamp()
         AND t.created_at > clock_timestamp() - (ENROLMENT_TICKET_TTL_SECONDS || ' seconds')::interval
    ) THEN
      RAISE EXCEPTION 'enrolment requires a valid, open and unexpired enrolment ticket (maximum 1800 seconds)';
    END IF;
    -- The ticket is NOT consumed here. It is consumed atomically at confirmation (O-4-B below).
    RETURN NEW;
  END IF;
  IF OLD.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a disabled admin MFA factor cannot change';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.enrolment_challenge_id IS DISTINCT FROM OLD.enrolment_challenge_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'admin MFA factor identity cannot change';
  END IF;
  IF NEW.last_used_step < OLD.last_used_step THEN
    RAISE EXCEPTION 'last_used_step can only increase';
  END IF;
  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'confirmed_at is set once';
  END IF;
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL THEN
    NEW.confirmed_at := clock_timestamp();
    -- O-4-B: consume only the ticket linked to this factor's immutable exact challenge.
    SELECT c.id, c.user_id, c.enrolment_ticket_id INTO enrol_challenge
      FROM admin_mfa_challenges c
     WHERE c.id = OLD.enrolment_challenge_id
       AND c.user_id = OLD.user_id
       AND c.purpose = 'enrol'
       AND c.consumed_at IS NULL
       AND c.expires_at > clock_timestamp()
       AND c.enrolment_ticket_id IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'factor confirmation requires its exact open enrolment challenge with a bound ticket';
    END IF;
    -- Conditionally set used_at on the ticket. protect_admin_mfa_enrolment_ticket fires on this
    -- UPDATE and enforces single-use, expiry, and identity guards on the ticket row. If zero rows
    -- are updated (ticket already consumed by a concurrent confirmation, or now expired), the whole
    -- transaction rolls back and the factor remains unconfirmed.
    UPDATE admin_mfa_enrolment_tickets
       SET used_at = clock_timestamp()
     WHERE id = enrol_challenge.enrolment_ticket_id
       AND user_id = enrol_challenge.user_id
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > clock_timestamp()
       AND created_at > clock_timestamp() - (ENROLMENT_TICKET_TTL_SECONDS || ' seconds')::interval;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    IF rows_updated <> 1 THEN
      RAISE EXCEPTION 'enrolment ticket could not be consumed: it may be expired, used or revoked';
    END IF;
  END IF;
  IF NEW.disabled_at IS NOT NULL THEN
    -- AUTH C1.8.4 (O-3), immediate part. The reset-labelled and break-glass disables are also linked to
    -- their workflow at commit (check_admin_mfa_reset_commit).
    IF NEW.disabled_via = 'enrolment_superseded' AND (OLD.confirmed_at IS NOT NULL OR NEW.confirmed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'only an unconfirmed factor can be superseded by a new enrolment';
    END IF;
    IF NEW.disabled_via IN ('two_person_reset', 'single_approver_reset') AND NEW.disabled_by IS NULL THEN
      RAISE EXCEPTION 'a reset disable must name the deciding Super Admin';
    END IF;
    IF NEW.disabled_via = 'break_glass' AND NEW.disabled_by IS NOT NULL THEN
      RAISE EXCEPTION 'a break-glass disable is an operator action and names no user';
    END IF;
    NEW.disabled_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

-- Enrollment confirmation is the only application-callable factor-confirmation mutation. The
-- function re-acquires the complete lock chain in the approved order even when called outside the
-- normal application path; the app role has no direct UPDATE privilege on confirmed_at.
CREATE OR REPLACE FUNCTION confirm_admin_mfa_enrolment_factor(
  p_user_id text,
  p_challenge_id text,
  p_ticket_id text,
  p_factor_id text,
  p_accepted_step bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  challenge_ticket_id text;
  rows_updated integer;
BEGIN
  IF p_user_id IS NULL OR p_challenge_id IS NULL OR p_ticket_id IS NULL
     OR p_factor_id IS NULL OR p_accepted_step IS NULL OR p_accepted_step < 0 THEN
    RAISE EXCEPTION 'invalid admin MFA enrollment confirmation identity';
  END IF;

  PERFORM pg_advisory_xact_lock(734251, hashtext(p_user_id));

  SELECT c.enrolment_ticket_id INTO challenge_ticket_id
    FROM public.admin_mfa_challenges c
   WHERE c.id = p_challenge_id
     AND c.user_id = p_user_id
     AND c.purpose = 'enrol'
     AND c.consumed_at IS NULL
     AND c.expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND OR challenge_ticket_id IS DISTINCT FROM p_ticket_id THEN
    RAISE EXCEPTION 'factor confirmation requires its exact open enrolment challenge and ticket';
  END IF;

  PERFORM 1
    FROM public.admin_mfa_enrolment_tickets t
   WHERE t.id = p_ticket_id
     AND t.user_id = p_user_id
     AND t.used_at IS NULL
     AND t.revoked_at IS NULL
     AND t.expires_at > clock_timestamp()
     AND t.created_at > clock_timestamp() - interval '1800 seconds'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'factor confirmation requires its exact valid, open enrolment ticket';
  END IF;

  PERFORM 1
    FROM public.admin_mfa_factors f
   WHERE f.id = p_factor_id
     AND f.user_id = p_user_id
     AND f.enrolment_challenge_id = p_challenge_id
     AND f.kind = 'totp'
     AND f.confirmed_at IS NULL
     AND f.disabled_at IS NULL
     AND f.last_used_step < p_accepted_step
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'factor confirmation requires its exact unused factor and accepted step';
  END IF;

  UPDATE public.admin_mfa_factors
     SET confirmed_at = clock_timestamp(), last_used_step = p_accepted_step
   WHERE id = p_factor_id
     AND user_id = p_user_id
     AND enrolment_challenge_id = p_challenge_id
     AND confirmed_at IS NULL
     AND disabled_at IS NULL
     AND last_used_step < p_accepted_step;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  IF rows_updated <> 1 THEN
    RAISE EXCEPTION 'factor confirmation did not update exactly one factor';
  END IF;
  RETURN true;
END;
$$;

-- Recovery codes: inserted unused; used or revoked exactly once; never deleted.
CREATE OR REPLACE FUNCTION protect_admin_mfa_recovery_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin MFA recovery codes cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new recovery code starts unused';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used or revoked recovery code cannot change';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.factor_id IS DISTINCT FROM OLD.factor_id
     OR NEW.code_hash IS DISTINCT FROM OLD.code_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'recovery code identity cannot change';
  END IF;
  IF NEW.used_at IS NOT NULL THEN NEW.used_at := clock_timestamp(); END IF;
  IF NEW.revoked_at IS NOT NULL THEN NEW.revoked_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;

-- Enrolment tickets: only for Officials; inserted open; used (before expiry) or revoked exactly once;
-- never deleted.
-- AUTH C1.8.4 (F1), immediate checks at INSERT:
-- - an issuing user is an approved Super Admin with a confirmed, active factor;
-- - a reset ticket references a PENDING, unexpired request for the same target, with the label of its
--   approval mode. The issuer is the approver (not the initiator) for two_person, and the initiating
--   Super Admin for single_super_admin. The request is closed as executed later in the same transaction;
--   the deferred check_admin_mfa_reset_commit() refuses the COMMIT otherwise;
-- - a first-time ('super_admin') ticket only for an Official who has NEVER had a confirmed factor (factors
--   are never deleted and keep confirmed_at when disabled, so a reset target never qualifies);
-- - a bootstrap ticket only for an approved Super Admin, while no Super Admin has a confirmed factor and no
--   other bootstrap ticket is open, checked under a transaction-level advisory lock so that two concurrent
--   bootstrap commands cannot both pass. These checks validate the WORKFLOW only: the operator CLI uses
--   the API's database credentials, so the database cannot tell who issued a bootstrap or break-glass
--   ticket (owner decision O-1, to be resolved before MFA Phase 7).
CREATE OR REPLACE FUNCTION protect_admin_mfa_enrolment_ticket()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin MFA enrolment tickets cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new enrolment ticket starts open';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.role = 'official') THEN
      RAISE EXCEPTION 'enrolment tickets are for Officials only';
    END IF;
    IF NEW.issued_by IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM users u JOIN admin_mfa_factors f ON f.user_id = u.id
       WHERE u.id = NEW.issued_by AND u.role = 'official' AND u.is_super_admin AND u.account_status = 'approved'
         AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL
    ) THEN
      RAISE EXCEPTION 'a ticket issuer must be an approved Super Admin with a confirmed, active MFA factor';
    END IF;
    IF NEW.issued_via IN ('two_person_reset', 'single_approver_reset') THEN
      SELECT r.target_user_id, r.approval_mode, r.initiated_by, r.status, r.expires_at INTO request_row
        FROM admin_mfa_reset_requests r WHERE r.id = NEW.reset_request_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a reset ticket must reference an existing reset request';
      END IF;
      IF request_row.status <> 'pending' OR request_row.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'a reset ticket can only be issued for a pending, unexpired reset request';
      END IF;
      IF request_row.target_user_id <> NEW.user_id THEN
        RAISE EXCEPTION 'a reset ticket must be issued to the target of its reset request';
      END IF;
      IF NEW.issued_via <> (CASE request_row.approval_mode WHEN 'two_person' THEN 'two_person_reset' ELSE 'single_approver_reset' END) THEN
        RAISE EXCEPTION 'the reset ticket label must match the approval mode of its reset request';
      END IF;
      IF request_row.approval_mode = 'two_person' AND NEW.issued_by IS NOT DISTINCT FROM request_row.initiated_by THEN
        RAISE EXCEPTION 'a two-person reset ticket is issued by the approver, never the initiator';
      END IF;
      IF request_row.approval_mode = 'single_super_admin' AND NEW.issued_by IS DISTINCT FROM request_row.initiated_by THEN
        RAISE EXCEPTION 'a single-approver reset ticket is issued by the initiating Super Admin';
      END IF;
    ELSIF NEW.issued_via = 'super_admin' THEN
      IF EXISTS (SELECT 1 FROM admin_mfa_factors f WHERE f.user_id = NEW.user_id AND f.confirmed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'the target has enrolled before: replacing a factor requires a reset';
      END IF;
    ELSIF NEW.issued_via = 'bootstrap_cli' THEN
      -- Under REPEATABLE READ or SERIALIZABLE the checks below would reuse the transaction snapshot taken
      -- before the lock was acquired, so a concurrent bootstrap could go unseen: refuse those levels.
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'a bootstrap ticket must be issued under READ COMMITTED isolation';
      END IF;
      PERFORM pg_advisory_xact_lock(7342519187);
      IF NOT EXISTS (
        SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.role = 'official' AND u.is_super_admin AND u.account_status = 'approved'
      ) THEN
        RAISE EXCEPTION 'a bootstrap ticket is only for an approved Super Admin';
      END IF;
      IF EXISTS (
        SELECT 1 FROM admin_mfa_factors f JOIN users u ON u.id = f.user_id WHERE u.is_super_admin AND f.confirmed_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a Super Admin has already enrolled: bootstrap is closed';
      END IF;
      IF EXISTS (
        SELECT 1 FROM admin_mfa_enrolment_tickets t
         WHERE t.issued_via = 'bootstrap_cli' AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp()
      ) THEN
        RAISE EXCEPTION 'an open bootstrap ticket already exists';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used or revoked enrolment ticket cannot change';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.issued_via IS DISTINCT FROM OLD.issued_via OR NEW.reset_request_id IS DISTINCT FROM OLD.reset_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'enrolment ticket identity cannot change';
  END IF;
  IF NEW.used_at IS NOT NULL THEN
    IF clock_timestamp() >= OLD.expires_at THEN
      RAISE EXCEPTION 'an expired enrolment ticket cannot be used';
    END IF;
    NEW.used_at := clock_timestamp();
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN NEW.revoked_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;

-- Challenges: inserted unused (a step-up challenge only for a live session of the same user);
-- attempts rise one at a time and only before expiry; a ticket is bound once; consumption is final;
-- never deleted.
CREATE OR REPLACE FUNCTION protect_admin_mfa_challenge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin MFA challenges cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.attempts <> 0 OR NEW.consumed_at IS NOT NULL OR NEW.consumed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a new admin MFA challenge starts unused';
    END IF;
    IF NEW.session_token_hash IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM auth_sessions s
       WHERE s.token_hash = NEW.session_token_hash AND s.user_id = NEW.user_id
         AND s.revoked_at IS NULL AND s.expires_at > NEW.created_at
    ) THEN
      RAISE EXCEPTION 'a step-up challenge must belong to a live session of the same user';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed admin MFA challenge cannot change';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.session_token_hash IS DISTINCT FROM OLD.session_token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'admin MFA challenge identity cannot change';
  END IF;
  IF OLD.enrolment_ticket_id IS NOT NULL AND NEW.enrolment_ticket_id IS DISTINCT FROM OLD.enrolment_ticket_id THEN
    RAISE EXCEPTION 'an enrolment ticket is bound to a challenge once';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'attempts rise one at a time';
  END IF;
  IF clock_timestamp() >= OLD.expires_at AND (
       NEW.attempts <> OLD.attempts OR NEW.enrolment_ticket_id IS DISTINCT FROM OLD.enrolment_ticket_id
       OR NEW.consumed_reason = 'verified') THEN
    RAISE EXCEPTION 'an expired admin MFA challenge cannot be used';
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN NEW.consumed_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;

-- Reset requests, on INSERT: pending, undecided; the target is an Official; the mode matches the
-- target; the initiator is an approved Super Admin with TOTP evidence from a live session.
CREATE OR REPLACE FUNCTION check_admin_mfa_reset_request_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_row record;
BEGIN
  NEW.created_at := clock_timestamp();
  IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_verification_id IS NOT NULL
     OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL OR NEW.ticket_id IS NOT NULL THEN
    RAISE EXCEPTION 'a new admin MFA reset request is pending with no decision';
  END IF;
  SELECT u.role, u.is_super_admin INTO target_row FROM users u WHERE u.id = NEW.target_user_id;
  IF NOT FOUND OR target_row.role <> 'official' THEN
    RAISE EXCEPTION 'the reset target must be an Official';
  END IF;
  IF NEW.approval_mode <> (CASE WHEN target_row.is_super_admin THEN 'two_person' ELSE 'single_super_admin' END) THEN
    RAISE EXCEPTION 'a Super Admin target needs two_person approval; an ordinary Official target needs single_super_admin';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = NEW.initiated_by AND u.role = 'official' AND u.is_super_admin AND u.account_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'only an approved Super Admin may initiate an MFA reset';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth_session_mfa_verifications v JOIN auth_sessions s ON s.token_hash = v.token_hash
     WHERE v.id = NEW.initiated_verification_id AND v.user_id = NEW.initiated_by AND v.method = 'totp'
       AND s.revoked_at IS NULL AND s.expires_at > NEW.created_at
  ) THEN
    RAISE EXCEPTION 'initiation requires TOTP evidence from a live session of the initiator';
  END IF;
  RETURN NEW;
END;
$$;

-- Reset requests, on UPDATE or DELETE: only a pending request may change, and only to a valid end state.
CREATE OR REPLACE FUNCTION protect_admin_mfa_reset_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_row record;
  ticket_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin MFA reset requests cannot be deleted';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a finished admin MFA reset request cannot change';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
     OR NEW.approval_mode IS DISTINCT FROM OLD.approval_mode OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
     OR NEW.initiated_verification_id IS DISTINCT FROM OLD.initiated_verification_id OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'admin MFA reset request identity cannot change';
  END IF;
  IF NEW.status = 'pending' THEN
    IF NEW.decided_by IS NOT NULL OR NEW.decided_verification_id IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.decision_reason IS NOT NULL OR NEW.ticket_id IS NOT NULL THEN
      RAISE EXCEPTION 'a pending admin MFA reset request carries no decision';
    END IF;
    RETURN NEW;
  END IF;

  NEW.decided_at := clock_timestamp();
  IF NEW.status = 'expired' THEN
    IF NEW.decided_at < OLD.expires_at THEN
      RAISE EXCEPTION 'the admin MFA reset request has not expired';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'superseded' THEN
    RETURN NEW;  -- break-glass (operator path, MFA Phase 7); the application records the incident.
  END IF;

  -- executed, rejected or cancelled: before expiry, by a person holding TOTP evidence from a live session.
  IF NEW.decided_at >= OLD.expires_at THEN
    RAISE EXCEPTION 'an expired admin MFA reset request can only be closed as expired';
  END IF;
  SELECT v.verified_at INTO evidence_row
    FROM auth_session_mfa_verifications v JOIN auth_sessions s ON s.token_hash = v.token_hash
   WHERE v.id = NEW.decided_verification_id AND v.user_id = NEW.decided_by AND v.method = 'totp'
     AND s.revoked_at IS NULL AND s.expires_at > NEW.decided_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a decision requires TOTP evidence from a live session of the deciding person';
  END IF;
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;  -- the initiator (constraint admin_mfa_reset_requests_cancel_check)
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = NEW.decided_by AND u.role = 'official' AND u.is_super_admin AND u.account_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'only an approved Super Admin may decide an MFA reset';
  END IF;
  IF NEW.status = 'rejected' THEN
    RETURN NEW;
  END IF;

  -- executed
  IF NEW.approval_mode = 'single_super_admin'
     AND EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.target_user_id AND u.is_super_admin) THEN
    RAISE EXCEPTION 'the target is now a Super Admin: two-person approval is required';
  END IF;
  IF NEW.approval_mode = 'two_person' THEN
    IF evidence_row.verified_at <= OLD.created_at THEN
      RAISE EXCEPTION 'the approver must verify TOTP after the reset request was created';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id = NEW.initiated_by AND u.role = 'official' AND u.is_super_admin AND u.account_status = 'approved'
    ) THEN
      RAISE EXCEPTION 'the initiator is no longer an approved Super Admin';
    END IF;
  END IF;
  -- The ticket: open, for the target, issued by this decider for this request under the matching label.
  SELECT t.user_id, t.reset_request_id, t.issued_via, t.issued_by, t.used_at, t.revoked_at INTO ticket_row
    FROM admin_mfa_enrolment_tickets t WHERE t.id = NEW.ticket_id;
  IF NOT FOUND OR ticket_row.user_id <> NEW.target_user_id OR ticket_row.reset_request_id IS DISTINCT FROM NEW.id
     OR ticket_row.issued_by IS DISTINCT FROM NEW.decided_by
     OR ticket_row.used_at IS NOT NULL OR ticket_row.revoked_at IS NOT NULL
     OR ticket_row.issued_via <> (CASE NEW.approval_mode WHEN 'two_person' THEN 'two_person_reset' ELSE 'single_approver_reset' END) THEN
    RAISE EXCEPTION 'an executed reset must name the open enrolment ticket it issued to the target';
  END IF;
  RETURN NEW;
END;
$$;

-- AUTH C1.8.4 (F1, F2, O-3): commit-time integrity of every reset, as DEFERRABLE INITIALLY DEFERRED
-- constraint triggers. They run at COMMIT (or at SET CONSTRAINTS ... IMMEDIATE, which can only make them
-- run earlier) and RE-READ the current rows, so they judge the final state of the transaction, not the
-- NEW image of an earlier statement. Any failure aborts the COMMIT and PostgreSQL rolls back the whole
-- transaction: a reset is all or nothing. The application role cannot skip them: disabling triggers needs
-- table ownership, and session_replication_role is reserved for superusers.
-- One function serves all three tables (branching on TG_TABLE_NAME) because the grants migration revokes
-- EXECUTE on every function, so a trigger function cannot call a shared helper as the application role.
--
-- Timestamps: now() is the transaction start; every time compared here is stamped by a trigger with
-- clock_timestamp() and is never granted to the application. "In this transaction" is therefore
-- "stamped at or after now()", and the required order inside the transaction (the factor is disabled
-- before the request is closed or the break-glass ticket issued) is checked from the same stamps.
CREATE OR REPLACE FUNCTION check_admin_mfa_reset_commit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target text;
  replacement text;
  request_row record;
  ticket_row record;
  factor_row record;
BEGIN
  -- O-3: a reset-labelled or break-glass factor disable must belong to a reset in this transaction.
  IF TG_TABLE_NAME = 'admin_mfa_factors' THEN
    SELECT f.user_id, f.disabled_at, f.disabled_by, f.disabled_via INTO factor_row FROM admin_mfa_factors f WHERE f.id = NEW.id;
    IF factor_row.disabled_via IN ('two_person_reset', 'single_approver_reset') THEN
      IF NOT EXISTS (
        SELECT 1 FROM admin_mfa_reset_requests r
         WHERE r.target_user_id = factor_row.user_id AND r.status = 'executed'
           AND r.decided_by = factor_row.disabled_by
           AND r.decided_at >= now() AND r.decided_at >= factor_row.disabled_at
           AND factor_row.disabled_via = (CASE r.approval_mode WHEN 'two_person' THEN 'two_person_reset' ELSE 'single_approver_reset' END)
      ) THEN
        RAISE EXCEPTION 'a reset-labelled factor disable needs its matching reset executed later in the same transaction';
      END IF;
    ELSIF factor_row.disabled_via = 'break_glass' THEN
      IF NOT EXISTS (
        SELECT 1 FROM admin_mfa_enrolment_tickets t
         WHERE t.user_id = factor_row.user_id AND t.issued_via = 'break_glass'
           AND t.created_at >= now() AND t.created_at >= factor_row.disabled_at
      ) THEN
        RAISE EXCEPTION 'a break-glass factor disable needs a break-glass ticket issued later in the same transaction';
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'admin_mfa_reset_requests' THEN
    -- F2: an executed request is linked to its open replacement ticket and its audit event.
    SELECT r.id, r.target_user_id, r.status, r.approval_mode, r.decided_by, r.ticket_id INTO request_row
      FROM admin_mfa_reset_requests r WHERE r.id = NEW.id;
    IF request_row.status <> 'executed' THEN
      RAISE EXCEPTION 'an executed reset request cannot change state';
    END IF;
    target := request_row.target_user_id;
    replacement := request_row.ticket_id;
    SELECT t.user_id, t.issued_by, t.issued_via, t.reset_request_id, t.used_at, t.revoked_at INTO ticket_row
      FROM admin_mfa_enrolment_tickets t WHERE t.id = request_row.ticket_id;
    IF NOT FOUND OR ticket_row.user_id <> target OR ticket_row.reset_request_id IS DISTINCT FROM request_row.id
       OR ticket_row.issued_by IS DISTINCT FROM request_row.decided_by
       OR ticket_row.issued_via <> (CASE request_row.approval_mode WHEN 'two_person' THEN 'two_person_reset' ELSE 'single_approver_reset' END) THEN
      RAISE EXCEPTION 'an executed reset must be linked to the replacement ticket its decider issued';
    END IF;
    IF ticket_row.used_at IS NOT NULL OR ticket_row.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'the replacement enrolment ticket must still be open when the reset commits';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM auth_verification_events e
       WHERE e.action = 'admin_mfa.reset_executed' AND e.user_id = target AND e.details->>'requestId' = request_row.id
    ) THEN
      RAISE EXCEPTION 'an executed reset needs its admin_mfa.reset_executed audit event';
    END IF;
  ELSE
    SELECT t.id, t.user_id, t.issued_by, t.issued_via, t.reset_request_id, t.used_at, t.revoked_at INTO ticket_row
      FROM admin_mfa_enrolment_tickets t WHERE t.id = NEW.id;
    IF ticket_row.issued_via IN ('two_person_reset', 'single_approver_reset') THEN
      -- F1: a reset ticket commits only together with its executed request (same target, ticket, decider, mode).
      IF NOT EXISTS (
        SELECT 1 FROM admin_mfa_reset_requests r
         WHERE r.id = ticket_row.reset_request_id AND r.status = 'executed' AND r.ticket_id = ticket_row.id
           AND r.target_user_id = ticket_row.user_id AND r.decided_by = ticket_row.issued_by
           AND ticket_row.issued_via = (CASE r.approval_mode WHEN 'two_person' THEN 'two_person_reset' ELSE 'single_approver_reset' END)
      ) THEN
        RAISE EXCEPTION 'a reset ticket commits only together with its executed reset request';
      END IF;
      RETURN NULL;  -- the reset invariants are checked by the request's own commit trigger
    END IF;
    -- break_glass (operator path, MFA Phase 7). The event is application-supplied and is NOT proof of
    -- operator identity (O-1); it is required so that no break-glass reset can commit unaudited.
    target := ticket_row.user_id;
    replacement := ticket_row.id;
    IF ticket_row.used_at IS NOT NULL OR ticket_row.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'the replacement enrolment ticket must still be open when the reset commits';
    END IF;
    IF EXISTS (SELECT 1 FROM admin_mfa_reset_requests r WHERE r.target_user_id = target AND r.status = 'pending') THEN
      RAISE EXCEPTION 'a break-glass reset must supersede the pending reset request of its target';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM auth_verification_events e
       WHERE e.action = 'admin_mfa.break_glass_reset' AND e.user_id = target AND e.occurred_at >= now()
    ) THEN
      RAISE EXCEPTION 'a break-glass reset needs its admin_mfa.break_glass_reset audit event';
    END IF;
  END IF;

  -- F2: every side effect of the reset is complete for the target.
  IF EXISTS (SELECT 1 FROM admin_mfa_factors f WHERE f.user_id = target AND f.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'a reset must leave the target with no active MFA factor';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_mfa_recovery_codes c WHERE c.user_id = target AND c.used_at IS NULL AND c.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a reset must revoke every unused recovery code of the target';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_mfa_challenges c WHERE c.user_id = target AND c.consumed_at IS NULL) THEN
    RAISE EXCEPTION 'a reset must close every open MFA challenge of the target';
  END IF;
  IF EXISTS (
    SELECT 1 FROM admin_mfa_enrolment_tickets t
     WHERE t.user_id = target AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.id <> replacement
  ) THEN
    RAISE EXCEPTION 'a reset must revoke every other open enrolment ticket of the target';
  END IF;
  IF EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id = target AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'a reset must revoke every unexpired session of the target';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER IF EXISTS admin_mfa_factors_protect ON admin_mfa_factors;
CREATE TRIGGER admin_mfa_factors_protect
  BEFORE INSERT OR UPDATE OR DELETE ON admin_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION protect_admin_mfa_factor();
DROP TRIGGER IF EXISTS admin_mfa_factors_no_truncate ON admin_mfa_factors;
CREATE TRIGGER admin_mfa_factors_no_truncate
  BEFORE TRUNCATE ON admin_mfa_factors
  FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_mfa_truncate();

DROP TRIGGER IF EXISTS admin_mfa_recovery_codes_protect ON admin_mfa_recovery_codes;
CREATE TRIGGER admin_mfa_recovery_codes_protect
  BEFORE INSERT OR UPDATE OR DELETE ON admin_mfa_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION protect_admin_mfa_recovery_code();
DROP TRIGGER IF EXISTS admin_mfa_recovery_codes_no_truncate ON admin_mfa_recovery_codes;
CREATE TRIGGER admin_mfa_recovery_codes_no_truncate
  BEFORE TRUNCATE ON admin_mfa_recovery_codes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_mfa_truncate();

DROP TRIGGER IF EXISTS auth_session_mfa_verifications_check_insert ON auth_session_mfa_verifications;
CREATE TRIGGER auth_session_mfa_verifications_check_insert
  BEFORE INSERT ON auth_session_mfa_verifications
  FOR EACH ROW EXECUTE FUNCTION check_auth_session_mfa_verification_insert();
DROP TRIGGER IF EXISTS auth_session_mfa_verifications_append_only ON auth_session_mfa_verifications;
CREATE TRIGGER auth_session_mfa_verifications_append_only
  BEFORE UPDATE OR DELETE ON auth_session_mfa_verifications
  FOR EACH ROW EXECUTE FUNCTION reject_auth_session_mfa_verification_mutation();
DROP TRIGGER IF EXISTS auth_session_mfa_verifications_no_truncate ON auth_session_mfa_verifications;
CREATE TRIGGER auth_session_mfa_verifications_no_truncate
  BEFORE TRUNCATE ON auth_session_mfa_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION reject_auth_session_mfa_verification_mutation();

DROP TRIGGER IF EXISTS admin_mfa_reset_requests_check_insert ON admin_mfa_reset_requests;
CREATE TRIGGER admin_mfa_reset_requests_check_insert
  BEFORE INSERT ON admin_mfa_reset_requests
  FOR EACH ROW EXECUTE FUNCTION check_admin_mfa_reset_request_insert();
DROP TRIGGER IF EXISTS admin_mfa_reset_requests_protect ON admin_mfa_reset_requests;
CREATE TRIGGER admin_mfa_reset_requests_protect
  BEFORE UPDATE OR DELETE ON admin_mfa_reset_requests
  FOR EACH ROW EXECUTE FUNCTION protect_admin_mfa_reset_request();
DROP TRIGGER IF EXISTS admin_mfa_reset_requests_no_truncate ON admin_mfa_reset_requests;
CREATE TRIGGER admin_mfa_reset_requests_no_truncate
  BEFORE TRUNCATE ON admin_mfa_reset_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_mfa_truncate();

DROP TRIGGER IF EXISTS admin_mfa_enrolment_tickets_protect ON admin_mfa_enrolment_tickets;
CREATE TRIGGER admin_mfa_enrolment_tickets_protect
  BEFORE INSERT OR UPDATE OR DELETE ON admin_mfa_enrolment_tickets
  FOR EACH ROW EXECUTE FUNCTION protect_admin_mfa_enrolment_ticket();
DROP TRIGGER IF EXISTS admin_mfa_enrolment_tickets_no_truncate ON admin_mfa_enrolment_tickets;
CREATE TRIGGER admin_mfa_enrolment_tickets_no_truncate
  BEFORE TRUNCATE ON admin_mfa_enrolment_tickets
  FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_mfa_truncate();

DROP TRIGGER IF EXISTS admin_mfa_challenges_protect ON admin_mfa_challenges;
CREATE TRIGGER admin_mfa_challenges_protect
  BEFORE INSERT OR UPDATE OR DELETE ON admin_mfa_challenges
  FOR EACH ROW EXECUTE FUNCTION protect_admin_mfa_challenge();
DROP TRIGGER IF EXISTS admin_mfa_challenges_no_truncate ON admin_mfa_challenges;
CREATE TRIGGER admin_mfa_challenges_no_truncate
  BEFORE TRUNCATE ON admin_mfa_challenges
  FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_mfa_truncate();

-- AUTH C1.8.4: commit-time integrity (deferred; see check_admin_mfa_reset_commit).
DROP TRIGGER IF EXISTS admin_mfa_reset_requests_commit_check ON admin_mfa_reset_requests;
CREATE CONSTRAINT TRIGGER admin_mfa_reset_requests_commit_check
  AFTER UPDATE ON admin_mfa_reset_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'executed')
  EXECUTE FUNCTION check_admin_mfa_reset_commit();
DROP TRIGGER IF EXISTS admin_mfa_enrolment_tickets_commit_check ON admin_mfa_enrolment_tickets;
CREATE CONSTRAINT TRIGGER admin_mfa_enrolment_tickets_commit_check
  AFTER INSERT ON admin_mfa_enrolment_tickets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.issued_via IN ('two_person_reset', 'single_approver_reset', 'break_glass'))
  EXECUTE FUNCTION check_admin_mfa_reset_commit();
DROP TRIGGER IF EXISTS admin_mfa_factors_commit_check ON admin_mfa_factors;
CREATE CONSTRAINT TRIGGER admin_mfa_factors_commit_check
  AFTER UPDATE ON admin_mfa_factors
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL AND NEW.disabled_via IN ('two_person_reset', 'single_approver_reset', 'break_glass'))
  EXECUTE FUNCTION check_admin_mfa_reset_commit();
