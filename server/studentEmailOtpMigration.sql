-- AUTH_MOBILE_VERIFICATION=off (owner decision, 2026-11-23): while SMS is unavailable, Students verify
-- sign-in and registration with a one-time code sent by EMAIL. The session evidence for that code is
-- recorded as method 'email_otp'. The API counts it only while AUTH_MOBILE_VERIFICATION is off
-- (server/auth.ts, acceptedStudentSessionMethods); with `required` only 'sms_otp' counts, so switching
-- back makes email-verified Student sessions sign in again.
--
-- Owner decision, 2026-11-24: while AUTH_MOBILE_VERIFICATION is off, a Student whose account exists
-- signs in with email or mobile + password alone; that session is recorded as method 'password' and
-- also counts only while the switch is off. The one-time email code is still required at registration.
--
-- No new purpose is needed: 'student_login' and 'student_registration' already allow channel 'email'
-- (verification_challenges_channel_check). No column or data changes.
--
-- Re-runnable: the CHECK is dropped and re-created on every run (it only widens: existing rows stay valid).
-- Must run before databaseGrantsMigration.sql, like every file in MIGRATION_FILES.

ALTER TABLE auth_session_verifications DROP CONSTRAINT IF EXISTS auth_session_verifications_method_check;
ALTER TABLE auth_session_verifications ADD CONSTRAINT auth_session_verifications_method_check CHECK (
  method IN ('sms_otp', 'email_otp', 'password')
);
