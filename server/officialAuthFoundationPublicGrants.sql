-- Narrow public.users privileges required by official_auth foreign keys and role guards.
-- Disposable PostgreSQL 17 test-cluster artifact only; does not alter eltnoy_app grants.

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
    RAISE EXCEPTION 'public.users grants require the explicitly marked loopback PostgreSQL 17 disposable test database';
  END IF;
END
$test_guard$;

GRANT USAGE ON SCHEMA public TO official_auth_owner, official_verifier, official_session_gateway;
GRANT REFERENCES (id) ON public.users TO official_auth_owner;
GRANT SELECT (id, role) ON public.users TO official_auth_owner;
GRANT SELECT (id, login_id, role, account_status) ON public.users TO official_verifier;
GRANT SELECT (id, role, account_status) ON public.users TO official_session_gateway;
