-- Student email capture (AUTH-1 follow-up).
--
-- Additive and re-runnable. Student account email is verified after sign-in through the existing
-- email challenge and account_contacts tables; this migration only permits the new challenge purpose.

ALTER TABLE verification_challenges DROP CONSTRAINT IF EXISTS verification_challenges_purpose_check;
ALTER TABLE verification_challenges ADD CONSTRAINT verification_challenges_purpose_check CHECK (
  purpose IN ('student_login', 'student_mobile_capture', 'student_email_capture', 'student_registration', 'institute_mobile', 'institute_email')
);
