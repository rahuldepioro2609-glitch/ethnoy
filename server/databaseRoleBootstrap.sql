-- One-time role bootstrap for least-privilege database access (S-1 phase 1A, OD-P2).
--
-- NOT a migration and NOT part of MIGRATION_FILES. An operator runs it with psql as the bootstrap
-- superuser (the image's POSTGRES_USER), connected to the application database, only after a
-- verified backup and an approved maintenance window, with the API stopped. Then the four migration
-- files run as eltnoy_migrator; the fourth (databaseGrantsMigration.sql) applies the table grants.
--
-- What it does (idempotent; safe to re-run):
-- 1. Creates or normalizes the roles. LOGIN roles are created WITHOUT passwords: set them afterwards
--    interactively with psql's \password, so no password is ever written to a file or the server log.
-- 2. Lets eltnoy_migrator act only as eltnoy_owner (SET, not INHERIT); every migrator session starts
--    as eltnoy_owner, so existing migration code needs no change.
-- 3. Limits CONNECT on this database (and on the postgres maintenance database) to named roles.
-- 4. Transfers ownership of the public schema and of every existing table, sequence, view and
--    function in it to eltnoy_owner. Object by object: REASSIGN OWNED BY the bootstrap superuser
--    would also try to reassign system objects and fail.
-- It never drops anything, never changes data, and never alters the bootstrap superuser.

DO $bootstrap$
DECLARE
  r record;
  spec record;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'databaseRoleBootstrap.sql must be run by the bootstrap superuser, not %', current_user;
  END IF;
  IF current_database() IN ('postgres', 'template0', 'template1') THEN
    RAISE EXCEPTION 'connect to the application database, not %', current_database();
  END IF;

  -- 1. Roles. Attributes are re-asserted on every run so drift is corrected.
  FOR spec IN SELECT * FROM (VALUES
      ('eltnoy_owner',          false, -1),
      ('eltnoy_migrator',       true,  -1),
      ('eltnoy_app',            true,  40),
      ('eltnoy_audit_writer',   false, -1),
      ('eltnoy_audit_reader',   false, -1),
      ('eltnoy_audit_verifier', true,  -1),
      ('eltnoy_backup',         true,  -1)
    ) AS v(name, can_login, conn_limit) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = spec.name) THEN
      EXECUTE format('CREATE ROLE %I', spec.name);
    END IF;
    EXECUTE format('ALTER ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
                   spec.name, CASE WHEN spec.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END, spec.conn_limit);
  END LOOP;

  -- 2. Memberships.
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = 'eltnoy_owner'::regrole AND member = 'eltnoy_migrator'::regrole) THEN
    REVOKE eltnoy_owner FROM eltnoy_migrator;   -- re-granted below with exactly the required options
  END IF;
  GRANT eltnoy_owner TO eltnoy_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
  ALTER ROLE eltnoy_migrator SET role = 'eltnoy_owner';
  GRANT pg_read_all_data TO eltnoy_backup;   -- read-only backups (pg_dump)

  -- 3. Database access.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO eltnoy_migrator, eltnoy_app, eltnoy_audit_verifier, eltnoy_backup', current_database());
  REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;

  -- 4. Ownership.
  ALTER SCHEMA public OWNER TO eltnoy_owner;
  FOR r IN
    SELECT c.oid::regclass AS obj, c.relkind
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND pg_get_userbyid(c.relowner) <> 'eltnoy_owner'
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO eltnoy_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, r.obj);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS fn
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND pg_get_userbyid(p.proowner) <> 'eltnoy_owner'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO eltnoy_owner', r.fn);
  END LOOP;

  RAISE NOTICE 'databaseRoleBootstrap: roles normalized; % now owns schema public and all its objects. Set LOGIN passwords with \password; then run the migrations as eltnoy_migrator.', 'eltnoy_owner';
END
$bootstrap$;
