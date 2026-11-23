-- AUTH C1: secure Student registration (approved architecture B + D).
--
-- A permanent Student account (users row) is created ONLY after the owner of the submitted mobile
-- number has verified the OTP. Until then the registration exists as a temporary, NON-EXCLUSIVE claim:
-- - any number of pending claims may exist for one mobile (no unique index on mobile), so a claim by
--   someone else can never block the real owner;
-- - a claim does not reserve the mobile-derived Student login ID (users.login_id is written only at
--   completion, inside the completion transaction);
-- - a claim stores a bcrypt hash, never a plaintext password, and no OTP value;
-- - a claim expires (expires_at) and is single use (consumed_at).
--
-- verification_challenges gains a nullable registration_claim_id. A challenge is owned by EXACTLY ONE
-- of user_id (existing flows, unchanged) or registration_claim_id (Student registration only).
--
-- Cleanup (approved): the application role may DELETE expired, unconsumed claims from this table only.
-- The FK is ON DELETE CASCADE, so the registration-only challenges of a deleted claim go with it
-- (referential actions run as the table owner; the application role has no DELETE on
-- verification_challenges). Cleanup never selects a claim with a live challenge.
--
-- SMS accounting: destination limits and the daily SMS budget count append-only
-- auth_verification_events rows (action 'sms.send_reserved', keyed destination hash in details), so
-- claim cleanup can never lower a counter.
--
-- Additive and re-runnable. Runs after authVerificationMigration.sql and before the grants migration.

CREATE TABLE IF NOT EXISTS student_registration_claims (
  id text PRIMARY KEY,
  mobile text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT student_registration_claims_mobile_check CHECK (mobile ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT student_registration_claims_name_check CHECK (length(display_name) BETWEEN 2 AND 120),
  CONSTRAINT student_registration_claims_password_hash_check CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'),
  CONSTRAINT student_registration_claims_expiry_check CHECK (expires_at > created_at)
);

-- Destination lookups and expired-claim cleanup. Deliberately NOT unique on mobile.
CREATE INDEX IF NOT EXISTS student_registration_claims_mobile_created_idx ON student_registration_claims (mobile, created_at DESC);
CREATE INDEX IF NOT EXISTS student_registration_claims_expiry_idx ON student_registration_claims (expires_at) WHERE consumed_at IS NULL;

-- Claim-backed challenges.
ALTER TABLE verification_challenges ADD COLUMN IF NOT EXISTS registration_claim_id text REFERENCES student_registration_claims(id) ON DELETE CASCADE;
ALTER TABLE verification_challenges ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'verification_challenges_owner_check' AND conrelid = 'verification_challenges'::regclass
  ) THEN
    ALTER TABLE verification_challenges ADD CONSTRAINT verification_challenges_owner_check CHECK (
      (user_id IS NOT NULL AND registration_claim_id IS NULL)
      OR (user_id IS NULL AND registration_claim_id IS NOT NULL AND purpose = 'student_registration')
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS verification_challenges_registration_claim_idx ON verification_challenges (registration_claim_id) WHERE registration_claim_id IS NOT NULL;

-- SMS send reservations: per-destination counts (the daily budget uses the existing action/time index).
CREATE INDEX IF NOT EXISTS auth_verification_events_sms_destination_idx
  ON auth_verification_events ((details->>'destinationKey'), occurred_at DESC)
  WHERE action = 'sms.send_reserved';
