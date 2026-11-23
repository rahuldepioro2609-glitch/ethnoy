-- AUTH-1: verification for Student and Institute authentication — PROPOSED migration, review only.
--
-- NOT part of MIGRATION_FILES and never run automatically. Future application order:
--   1. schema.sql and the other committed files (users, auth_sessions must exist; this file needs
--      users.is_super_admin only indirectly, through the committed code that reads it);
--   2. this file (independent of the SM-1 staff migrations);
--   3. grants-manifest entries for every table below, then databaseGrantsMigration.sql (last).
-- It needs separate approval and a disposable-database rehearsal first.
--
-- Additive only: no existing table or column is altered or dropped. No OTP or secret is stored in
-- plaintext: verification codes are kept only as HMAC-SHA256 hashes keyed by a server secret.
-- Rows are never deleted by the API (it has no DELETE); expired challenges and OAuth states are
-- inert after expires_at and can be purged later by a separately approved maintenance job.
-- Idempotent: safe to re-run.

-- Verified contact points (one per account and channel). Whether one mobile number may serve more
-- than one account is an open decision, so no cross-account uniqueness is enforced here.
CREATE TABLE IF NOT EXISTS account_contacts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  destination text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_contacts_channel_check CHECK (channel IN ('sms', 'email')),
  CONSTRAINT account_contacts_destination_check CHECK (
    (channel = 'sms' AND destination ~ '^\+91[6-9][0-9]{9}$')
    OR (channel = 'email' AND destination = lower(destination) AND length(destination) <= 254)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS account_contacts_user_channel_idx ON account_contacts (user_id, channel);
-- Mobile sign-in looks Students up by their VERIFIED mobile (channel + destination). Not unique: whether
-- one number may serve several accounts is open (M-28); ambiguous numbers are refused by the API.
CREATE INDEX IF NOT EXISTS account_contacts_channel_destination_idx ON account_contacts (channel, destination) WHERE verified_at IS NOT NULL;

-- OTP challenges. code_hash = HMAC-SHA256(server key, challenge id || ':' || code); never the code.
CREATE TABLE IF NOT EXISTS verification_challenges (
  id text PRIMARY KEY,
  purpose text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  destination text,
  code_hash text,
  code_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  send_count integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT verification_challenges_purpose_check CHECK (purpose IN ('student_login', 'student_mobile_capture', 'student_registration', 'institute_mobile', 'institute_email')),
  CONSTRAINT verification_challenges_channel_check CHECK (channel IN ('sms', 'email')),
  CONSTRAINT verification_challenges_hash_check CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT verification_challenges_counts_check CHECK (attempts >= 0 AND send_count >= 0),
  CONSTRAINT verification_challenges_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS verification_challenges_user_created_idx ON verification_challenges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_challenges_expiry_idx ON verification_challenges (expires_at) WHERE consumed_at IS NULL;

-- A portal session issued only after genuine OTP verification. Student sessions without a row here
-- are refused by the API (server/auth.ts).
CREATE TABLE IF NOT EXISTS auth_session_verifications (
  token_hash text PRIMARY KEY REFERENCES auth_sessions(token_hash) ON DELETE RESTRICT,
  method text NOT NULL,
  verified_at timestamptz NOT NULL,
  CONSTRAINT auth_session_verifications_method_check CHECK (method IN ('sms_otp'))
);

-- Institute verification: mobile and email independently, institutional (details/documents)
-- verification and suspension. Official approval stays users.account_status (unchanged).
CREATE TABLE IF NOT EXISTS institute_verifications (
  institution_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  mobile_destination text,
  mobile_verified_at timestamptz,
  email_destination text,
  email_verified_at timestamptz,
  institutional_status text NOT NULL DEFAULT 'pending',
  institutional_decided_at timestamptz,
  institutional_decided_by text REFERENCES users(id) ON DELETE RESTRICT,
  suspended_at timestamptz,
  suspended_by text REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institute_verifications_institutional_check CHECK (institutional_status IN ('pending', 'verified', 'rejected')),
  CONSTRAINT institute_verifications_mobile_check CHECK (mobile_verified_at IS NULL OR mobile_destination IS NOT NULL),
  CONSTRAINT institute_verifications_email_check CHECK (email_verified_at IS NULL OR email_destination IS NOT NULL),
  CONSTRAINT institute_verifications_suspension_check CHECK ((suspended_at IS NULL) = (suspended_by IS NULL))
);

-- Google identities: one Google account per Student and one Student per Google account.
CREATE TABLE IF NOT EXISTS google_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  google_sub text NOT NULL,
  email text NOT NULL,
  linked_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS google_identities_sub_idx ON google_identities (google_sub);
CREATE UNIQUE INDEX IF NOT EXISTS google_identities_user_idx ON google_identities (user_id);

-- OAuth Authorization Code + PKCE state (single use, short-lived). state_hash = SHA-256(state).
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  intent text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT oauth_states_intent_check CHECK (intent IN ('login', 'link')),
  CONSTRAINT oauth_states_link_user_check CHECK (intent <> 'link' OR user_id IS NOT NULL),
  CONSTRAINT oauth_states_expiry_check CHECK (expires_at > created_at)
);

-- Append-only verification audit. Never contains a code, hash, token or secret.
CREATE TABLE IF NOT EXISTS auth_verification_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  user_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS auth_verification_events_user_idx ON auth_verification_events (user_id, occurred_at DESC);
-- Super Admin decision history: events filtered by action, newest first.
CREATE INDEX IF NOT EXISTS auth_verification_events_action_time_idx ON auth_verification_events (action, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_auth_verification_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authentication verification events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS auth_verification_events_append_only ON auth_verification_events;
CREATE TRIGGER auth_verification_events_append_only
  BEFORE UPDATE OR DELETE ON auth_verification_events
  FOR EACH ROW EXECUTE FUNCTION reject_auth_verification_event_mutation();

DROP TRIGGER IF EXISTS auth_verification_events_no_truncate ON auth_verification_events;
CREATE TRIGGER auth_verification_events_no_truncate
  BEFORE TRUNCATE ON auth_verification_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_auth_verification_event_mutation();
