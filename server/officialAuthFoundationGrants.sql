-- Exact Phase 2B runtime privilege manifest.
--
-- Disposable PostgreSQL 17 test-cluster artifact only. Run after the schema migration as a
-- superuser. It changes no current application grants or role memberships.

DO $test_guard$
DECLARE
  server_address text;
  version_number integer;
BEGIN
  server_address := inet_server_addr()::text;
  version_number := current_setting('server_version_num')::integer;
  IF current_database() <> 'official_auth_foundation_test'
     OR server_address NOT IN ('127.0.0.1', '::1')
     OR version_number < 170000 OR version_number >= 180000
     OR current_setting('official_auth.disposable_test', true) IS DISTINCT FROM 'on'
     OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'privilege manifest requires the explicitly marked loopback PostgreSQL 17 disposable test database';
  END IF;
END
$test_guard$;

REVOKE ALL ON SCHEMA official_auth FROM PUBLIC, eltnoy_app, official_verifier, official_session_gateway;
GRANT USAGE ON SCHEMA official_auth TO official_verifier, official_session_gateway;

REVOKE ALL ON ALL TABLES IN SCHEMA official_auth
  FROM PUBLIC, eltnoy_app, official_verifier, official_session_gateway;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA official_auth
  FROM PUBLIC, eltnoy_app, official_verifier, official_session_gateway;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA official_auth
  FROM PUBLIC, eltnoy_app, official_verifier, official_session_gateway;

GRANT SELECT ON official_auth.credentials TO official_verifier;
GRANT INSERT ON official_auth.credentials TO official_verifier;
GRANT UPDATE (password_hash, credential_version, credential_state, updated_at, password_changed_at, migration_batch_id)
  ON official_auth.credentials TO official_verifier;
GRANT INSERT ON official_auth.credential_events TO official_verifier;

GRANT SELECT, INSERT ON official_auth.auth_transactions TO official_verifier;
GRANT UPDATE (state, completed_at) ON official_auth.auth_transactions TO official_verifier;
GRANT SELECT, INSERT ON official_auth.mfa_factors TO official_verifier;
GRANT UPDATE (last_used_step) ON official_auth.mfa_factors TO official_verifier;
GRANT SELECT, INSERT ON official_auth.mfa_challenges TO official_verifier;
GRANT UPDATE (attempts, consumed_at, consumed_reason, enrolment_ticket_hash)
  ON official_auth.mfa_challenges TO official_verifier;
GRANT SELECT (session_token_hash, user_id, credential_version, expires_at, revoked_at)
  ON official_auth.official_sessions TO official_verifier;
GRANT SELECT ON official_auth.enrolment_tickets TO official_verifier;
GRANT SELECT, INSERT ON official_auth.recovery_codes TO official_verifier;
GRANT UPDATE (used_at, revoked_at) ON official_auth.recovery_codes TO official_verifier;
GRANT INSERT ON official_auth.audit_events TO official_verifier;

GRANT SELECT ON official_auth.auth_transactions TO official_session_gateway;
GRANT UPDATE (state, consumed_at) ON official_auth.auth_transactions TO official_session_gateway;
GRANT SELECT, INSERT ON official_auth.assertion_consumptions TO official_session_gateway;
GRANT SELECT, INSERT ON official_auth.official_sessions TO official_session_gateway;
GRANT UPDATE (revoked_at) ON official_auth.official_sessions TO official_session_gateway;
GRANT SELECT (user_id, credential_version, credential_state)
  ON official_auth.credentials TO official_session_gateway;
GRANT SELECT, INSERT ON official_auth.session_mfa_evidence TO official_session_gateway;
GRANT INSERT (challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at)
  ON official_auth.mfa_challenges TO official_session_gateway;
GRANT SELECT (factor_id, user_id, confirmed_at, disabled_at)
  ON official_auth.mfa_factors TO official_session_gateway;
GRANT INSERT ON official_auth.audit_events TO official_session_gateway;
