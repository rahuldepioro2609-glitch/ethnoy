-- DRAFT ONLY: intentionally not in server/migrate.ts.
-- AU-01 authorizes Student sign-in and registration via mobile OTP. Do not execute this email-OTP
-- migration without separate owner approval; it broadens the accepted Student authentication methods.

ALTER TABLE student_registration_claims ADD COLUMN IF NOT EXISTS email text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'student_registration_claims_email_check'
       AND conrelid = 'student_registration_claims'::regclass
  ) THEN
    ALTER TABLE student_registration_claims
      ADD CONSTRAINT student_registration_claims_email_check
      CHECK (email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email = lower(email)));
  END IF;
END
$$;

ALTER TABLE verification_challenges DROP CONSTRAINT IF EXISTS verification_challenges_purpose_check;
ALTER TABLE verification_challenges ADD CONSTRAINT verification_challenges_purpose_check CHECK (
  purpose IN ('student_login', 'student_login_email', 'student_mobile_capture', 'student_email_capture', 'student_registration', 'institute_mobile', 'institute_email')
);

ALTER TABLE auth_session_verifications DROP CONSTRAINT IF EXISTS auth_session_verifications_method_check;
ALTER TABLE auth_session_verifications ADD CONSTRAINT auth_session_verifications_method_check CHECK (
  method IN ('sms_otp', 'email_otp')
);
