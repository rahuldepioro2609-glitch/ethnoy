-- Phase 2B isolated test-cluster role definitions only.
--
-- Never run this artifact against an existing application database or cluster. PostgreSQL roles
-- are cluster-wide. The guard requires the dedicated disposable database, a loopback TCP
-- connection, PostgreSQL 17, an explicit test-session flag, and a superuser.
-- No passwords or production login attributes are provisioned here.

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
    RAISE EXCEPTION 'role bootstrap requires the explicitly marked loopback PostgreSQL 17 disposable test database';
  END IF;
END
$test_guard$;

DO $roles$
DECLARE
  role_name text;
  existing_role record;
  required_roles text[] := ARRAY[
    'official_auth_owner',
    'official_auth_migrator',
    'official_verifier',
    'official_session_gateway',
    'eltnoy_app'
  ];
BEGIN
  FOREACH role_name IN ARRAY required_roles LOOP
    SELECT * INTO existing_role FROM pg_roles WHERE rolname = role_name;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        role_name
      );
    ELSIF existing_role.rolcanlogin
       OR existing_role.rolsuper
       OR existing_role.rolcreatedb
       OR existing_role.rolcreaterole
       OR existing_role.rolreplication
       OR existing_role.rolbypassrls
       OR existing_role.rolinherit THEN
      RAISE EXCEPTION 'existing test role % does not have the required unprivileged NOLOGIN attributes', role_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members AS membership
      JOIN pg_roles AS member_role ON member_role.oid = membership.member
      JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
     WHERE member_role.rolname IN ('official_verifier', 'official_session_gateway', 'eltnoy_app')
       AND granted_role.rolname IN ('official_auth_owner', 'official_auth_migrator')
  ) THEN
    RAISE EXCEPTION 'runtime and app test roles must not be members of owner or migrator roles';
  END IF;
END
$roles$;

GRANT official_auth_owner TO official_auth_migrator WITH INHERIT FALSE, SET TRUE;
