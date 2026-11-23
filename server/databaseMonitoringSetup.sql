-- OD-P6: least-privilege database monitoring (eltnoy_monitor).
--
-- NOT a migration and NOT part of MIGRATION_FILES. An operator runs it with psql as the bootstrap
-- superuser, connected to the application database, after server/databaseRoleBootstrap.sql.
-- Idempotent; never drops anything, never changes data. No password appears here: set the LOGIN
-- password afterwards with psql's \password.
--
-- Design
-- - eltnoy_monitor (LOGIN) holds NO predefined role, NO membership and NO access to schema public.
--   It may: connect to this database; read PostgreSQL's built-in statistics views that every role
--   can read (pg_stat_database, pg_stat_user_tables, pg_locks, pg_stat_io, settings); and execute
--   the eltnoy_monitoring.* functions below.
-- - Seeing other roles' session state, wait events, timings and blocking requires the predefined
--   role pg_read_all_stats, which would also reveal every session's full query text (pg_monitor
--   adds pg_read_all_settings and pg_stat_scan_tables on top). So pg_read_all_stats is held only by
--   the NOLOGIN role eltnoy_monitor_reader, which owns SECURITY DEFINER functions returning
--   sanitized rows: no query text and no parameters, only the statement keyword.
-- - The functions pin search_path, take only typed arguments, and are executable by
--   eltnoy_monitor alone. Nothing here can write, signal or terminate a backend.

DO $monitoring$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'databaseMonitoringSetup.sql must be run by the bootstrap superuser, not %', current_user;
  END IF;
  IF current_database() IN ('postgres', 'template0', 'template1') THEN
    RAISE EXCEPTION 'connect to the application database, not %', current_database();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eltnoy_monitor') THEN
    CREATE ROLE eltnoy_monitor;
  END IF;
  ALTER ROLE eltnoy_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eltnoy_monitor_reader') THEN
    CREATE ROLE eltnoy_monitor_reader;
  END IF;
  ALTER ROLE eltnoy_monitor_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  GRANT pg_read_all_stats TO eltnoy_monitor_reader;

  -- The login role must never hold elevated or broad predefined roles, directly or indirectly.
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
              WHERE m.member = 'eltnoy_monitor'::regrole) THEN
    RAISE EXCEPTION 'eltnoy_monitor must not be a member of any role (found: %)',
      (SELECT string_agg(r.rolname, ', ') FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = 'eltnoy_monitor'::regrole);
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO eltnoy_monitor', current_database());
END
$monitoring$;

CREATE SCHEMA IF NOT EXISTS eltnoy_monitoring AUTHORIZATION eltnoy_monitor_reader;
ALTER SCHEMA eltnoy_monitoring OWNER TO eltnoy_monitor_reader;
REVOKE ALL ON SCHEMA eltnoy_monitoring FROM PUBLIC;
GRANT USAGE ON SCHEMA eltnoy_monitoring TO eltnoy_monitor;

-- Statement keyword only (e.g. SELECT, UPDATE, COMMIT); never the statement text or literals.
CREATE OR REPLACE FUNCTION eltnoy_monitoring.statement_kind(query text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN query IS NULL OR query = '' THEN NULL
              ELSE upper(substring(ltrim(regexp_replace(query, '^(\s|--[^\n]*\n|/\*.*?\*/)+', '')) FROM '^[A-Za-z]+')) END
$$;

-- Every client and background session: who, where, state, waits and ages. No query text.
CREATE OR REPLACE FUNCTION eltnoy_monitoring.sessions()
RETURNS TABLE (pid integer, usename name, datname name, application_name text, client_addr inet,
               backend_type text, state text, wait_event_type text, wait_event text, statement_kind text,
               backend_age interval, xact_age interval, query_age interval, state_age interval)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.pid, a.usename, a.datname, left(a.application_name, 64), a.client_addr, a.backend_type, a.state,
         a.wait_event_type, a.wait_event, eltnoy_monitoring.statement_kind(a.query),
         now() - a.backend_start, now() - a.xact_start, now() - a.query_start, now() - a.state_change
    FROM pg_stat_activity a
   ORDER BY a.pid
$$;

-- Blocked sessions and the sessions blocking them (pg_blocking_pids). No query text.
CREATE OR REPLACE FUNCTION eltnoy_monitoring.blocking()
RETURNS TABLE (blocked_pid integer, blocked_user name, blocked_statement_kind text, blocked_wait_event text,
               blocked_for interval, blocking_pid integer, blocking_user name, blocking_state text,
               blocking_statement_kind text, blocking_xact_age interval)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.pid, w.usename, eltnoy_monitoring.statement_kind(w.query), w.wait_event_type || '/' || w.wait_event,
         now() - w.state_change, b.pid, b.usename, b.state, eltnoy_monitoring.statement_kind(b.query), now() - b.xact_start
    FROM pg_stat_activity w
    CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid)
    JOIN pg_stat_activity b ON b.pid = bp.pid
   ORDER BY w.pid, b.pid
$$;

-- Transactions open longer than min_age (default 5 minutes), including idle-in-transaction.
CREATE OR REPLACE FUNCTION eltnoy_monitoring.long_transactions(min_age interval DEFAULT interval '5 minutes')
RETURNS TABLE (pid integer, usename name, datname name, state text, statement_kind text,
               xact_age interval, state_age interval, wait_event text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.pid, a.usename, a.datname, a.state, eltnoy_monitoring.statement_kind(a.query),
         now() - a.xact_start, now() - a.state_change, a.wait_event_type || '/' || a.wait_event
    FROM pg_stat_activity a
   WHERE a.xact_start IS NOT NULL AND now() - a.xact_start >= min_age AND a.pid <> pg_backend_pid()
   ORDER BY a.xact_start
$$;

-- Connection capacity: totals and per-role counts against max_connections.
CREATE OR REPLACE FUNCTION eltnoy_monitoring.connection_capacity()
RETURNS TABLE (max_connections integer, reserved_connections integer, client_connections bigint,
               usename name, state text, connections bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  WITH c AS (SELECT a.usename, coalesce(a.state, 'unknown') AS state FROM pg_stat_activity a WHERE a.backend_type = 'client backend')
  SELECT current_setting('max_connections')::integer,
         current_setting('superuser_reserved_connections')::integer + current_setting('reserved_connections')::integer,
         (SELECT count(*) FROM c), c.usename, c.state, count(*)
    FROM c GROUP BY c.usename, c.state ORDER BY c.usename, c.state
$$;

ALTER FUNCTION eltnoy_monitoring.statement_kind(text) OWNER TO eltnoy_monitor_reader;
ALTER FUNCTION eltnoy_monitoring.sessions() OWNER TO eltnoy_monitor_reader;
ALTER FUNCTION eltnoy_monitoring.blocking() OWNER TO eltnoy_monitor_reader;
ALTER FUNCTION eltnoy_monitoring.long_transactions(interval) OWNER TO eltnoy_monitor_reader;
ALTER FUNCTION eltnoy_monitoring.connection_capacity() OWNER TO eltnoy_monitor_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA eltnoy_monitoring FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA eltnoy_monitoring TO eltnoy_monitor;
ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_monitor_reader IN SCHEMA eltnoy_monitoring REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
