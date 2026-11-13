-- Final migration (S-1 phase 1A, OD-P2): least-privilege grants for the application roles.
--
-- Execution semantics
-- - Runs as the object owner: the eltnoy_migrator login, whose sessions start as eltnoy_owner
--   (ALTER ROLE eltnoy_migrator SET role = 'eltnoy_owner'), after every other file in
--   MIGRATION_FILES, inside the same single migration transaction.
-- - Prerequisite: server/databaseRoleBootstrap.sql, run once by the bootstrap superuser, which
--   creates the roles, limits database CONNECT, and transfers ownership of the public schema and
--   every existing object to eltnoy_owner.
-- - Before that bootstrap has run (no eltnoy_* roles), this file changes nothing and only raises
--   a NOTICE, so it is safe in the current superuser deployment.
-- - Once the roles exist it fails closed: it refuses to run as any role other than eltnoy_owner or
--   a superuser, refuses objects not owned by eltnoy_owner, refuses unsafe role attributes or
--   memberships, and refuses any table or sequence missing from the manifests below.
-- - Idempotent: every run revokes and re-grants each listed table, so the final privileges equal
--   the manifest exactly. No data, ownership or role attributes are changed.
--
-- Manifest rules (checked by server/databaseGrants.test.ts)
-- - Every table in schema public appears exactly once in the table manifest.
-- - Allowed table privileges are SELECT, INSERT and UPDATE only. Never DELETE, TRUNCATE,
--   REFERENCES or TRIGGER: the API never deletes, truncates or runs DDL.
-- - update_columns lists column-level UPDATE grants. Since OD-P4 no table has table-wide UPDATE:
--   each list is exactly the columns the server code assigns (UPDATE ... SET and
--   INSERT ... ON CONFLICT DO UPDATE SET). SELECT ... FOR UPDATE / FOR SHARE needs UPDATE on at
--   least one column, which every locked table has. Column-only UPDATE also denies the API role
--   LOCK TABLE ... ACCESS EXCLUSIVE (which needs table-level UPDATE, DELETE or TRUNCATE).
-- - Lock-only grants: institution_documents is immutable (OD-P3,
--   institutionDocumentsImmutabilityMigration.sql), yet its replacement path locks rows with
--   SELECT ... FOR UPDATE, which needs UPDATE on one column. That column grant is allowed only
--   while the always-reject UPDATE/DELETE and TRUNCATE triggers exist and are enabled; otherwise
--   this migration fails.
-- - Every sequence in schema public must appear in the sequence manifest (currently none).

DO $grants$
DECLARE
  roles_ready boolean;
  r record;
  missing text;
  stale text;
  unowned text;
  col text;
  cols text;
  i int;
  tbls text[] := ARRAY[]::text[];        -- manifest, as parallel arrays (no temporary objects:
  privs text[] := ARRAY[]::text[];       -- TEMPORARY is revoked on the database by the bootstrap)
  colsets text[] := ARRAY[]::text[];
BEGIN
  SELECT count(*) = 6 INTO roles_ready
    FROM pg_roles
   WHERE rolname IN ('eltnoy_owner', 'eltnoy_migrator', 'eltnoy_app',
                     'eltnoy_audit_writer', 'eltnoy_audit_reader', 'eltnoy_audit_verifier');
  IF NOT roles_ready THEN
    RAISE NOTICE 'databaseGrantsMigration: eltnoy_* roles are not provisioned; no privileges were changed. Run server/databaseRoleBootstrap.sql first.';
    RETURN;
  END IF;

  -- Execution role
  IF current_user <> 'eltnoy_owner' AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'databaseGrantsMigration must run as eltnoy_owner (via eltnoy_migrator), not as %', current_user;
  END IF;

  -- Role safety: the application and audit roles must never be privileged or members of the owner.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO unowned
    FROM pg_roles
   WHERE rolname IN ('eltnoy_owner', 'eltnoy_migrator', 'eltnoy_app', 'eltnoy_audit_writer', 'eltnoy_audit_reader', 'eltnoy_audit_verifier')
     AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);
  IF unowned IS NOT NULL THEN
    RAISE EXCEPTION 'unsafe role attributes (superuser, createrole, createdb, replication or bypassrls) on: %', unowned;
  END IF;
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'eltnoy_owner') THEN
    RAISE EXCEPTION 'eltnoy_owner must be NOLOGIN';
  END IF;
  IF pg_has_role('eltnoy_app', 'eltnoy_owner', 'MEMBER') OR pg_has_role('eltnoy_app', 'eltnoy_migrator', 'MEMBER')
     OR pg_has_role('eltnoy_audit_verifier', 'eltnoy_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'eltnoy_app and eltnoy_audit_verifier must not be members of eltnoy_owner or eltnoy_migrator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid = 'eltnoy_owner'::regrole AND m.member = 'eltnoy_migrator'::regrole AND m.inherit_option) THEN
    RAISE EXCEPTION 'eltnoy_migrator must hold eltnoy_owner WITH INHERIT FALSE';
  END IF;

  -- Ownership: every object in public must already belong to eltnoy_owner (bootstrap transfers it).
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') <> 'eltnoy_owner' THEN
    RAISE EXCEPTION 'schema public must be owned by eltnoy_owner; run server/databaseRoleBootstrap.sql';
  END IF;
  SELECT string_agg(c.relname || ' (' || pg_get_userbyid(c.relowner) || ')', ', ' ORDER BY c.relname) INTO unowned
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND pg_get_userbyid(c.relowner) <> 'eltnoy_owner';
  IF unowned IS NOT NULL THEN
    RAISE EXCEPTION 'objects not owned by eltnoy_owner: %', unowned;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO unowned
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND pg_get_userbyid(p.proowner) <> 'eltnoy_owner';
  IF unowned IS NOT NULL THEN
    RAISE EXCEPTION 'functions not owned by eltnoy_owner: %', unowned;
  END IF;

  -- Coverage: every relation must be in the table manifest, and every manifest entry must exist.
  FOR r IN SELECT * FROM (VALUES
('admit_cards',                          'SELECT, INSERT',         ARRAY['roll_number', 'exam_date', 'reporting_time', 'gate_closing_time', 'exam_timing', 'center_code', 'center_name', 'center_address', 'published_at']::text[]),
    ('answer_key_questions',                 'SELECT, INSERT',         ARRAY['subject', 'question_text', 'options', 'official_key', 'explanation', 'is_published']),
    ('applications',                         'SELECT, INSERT',         ARRAY['status', 'user_id', 'ownership_verified_at', 'ownership_verified_by', 'ownership_verification_method']),
    ('auth_sessions',                        'SELECT, INSERT',         ARRAY['revoked_at']),
    ('center_checkins',                      'SELECT, INSERT',         ARRAY['status', 'note', 'updated_by', 'updated_at']),
    ('exams',                                'SELECT, INSERT',         ARRAY['is_published', 'updated_at']),
    ('feedback',                             'SELECT, INSERT',         ARRAY['status', 'resolution_note']),
    ('institute_forms',                      'SELECT, INSERT',         ARRAY['status', 'reviewed_by', 'reviewed_at']),
    ('institute_profile_changes',            'SELECT, INSERT',         ARRAY['status', 'reviewed_by', 'reviewed_at']),
    ('institute_resubmissions',              'SELECT, INSERT',         NULL),
    ('institute_status_history',             'SELECT, INSERT',         NULL),
    ('institute_wallet_entries',             'SELECT, INSERT',         NULL),
    ('institute_withdrawals',                'SELECT, INSERT',         ARRAY['status', 'transfer_reference', 'reviewed_by', 'reviewed_at']),
    ('institution_document_review_history',  'SELECT, INSERT',         NULL),
    ('institution_document_versions',        'SELECT, INSERT',         NULL),
    ('institution_documents',                'SELECT, INSERT',         ARRAY['created_at']),  -- lock-only: every UPDATE is rejected by trigger (OD-P3)
    ('institution_submission_capabilities',  'SELECT, INSERT',         ARRAY['revoked_at']),
    ('institution_submission_cycles',        'SELECT, INSERT',         ARRAY['status', 'closed_at']),
    ('mock_exam_attempts',                   'SELECT, INSERT',         NULL),
    ('online_exam_attempts',                 'SELECT, INSERT',         ARRAY['responses', 'score', 'submitted_at']),
    ('online_exam_questions',                'SELECT, INSERT',         ARRAY['exam_name', 'duration_minutes', 'section', 'question_text', 'options', 'correct_option', 'points', 'is_published']),
    ('portal_notices',                       'SELECT, INSERT',         ARRAY['is_published', 'published_at']),
    ('published_results',                    'SELECT, INSERT',         ARRAY['application_number', 'date_of_birth', 'scorecard', 'is_published', 'published_at']),
    ('users',                                'SELECT, INSERT',         ARRAY['account_status', 'display_name', 'contact_email', 'registration_number', 'registered_address', 'website'])
  ) AS m(tbl, privileges, update_columns) LOOP
    IF r.tbl = ANY (tbls) THEN
      RAISE EXCEPTION 'grant manifest lists % twice', r.tbl;
    END IF;
    tbls := tbls || r.tbl::text;
    privs := privs || r.privileges::text;
    colsets := colsets || coalesce(array_to_string(r.update_columns::text[], ','), '');
  END LOOP;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND NOT c.relispartition
     AND c.relname <> ALL (tbls);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'tables without an entry in the grant manifest: %', missing;
  END IF;
  SELECT string_agg(t, ', ' ORDER BY t) INTO stale
    FROM unnest(tbls) AS t
   WHERE to_regclass(format('public.%I', t)) IS NULL;
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION 'grant manifest lists tables that do not exist: %', stale;
  END IF;
  -- Sequence manifest: currently empty (all keys are text). A new sequence must be listed here
  -- with an explicit USAGE grant before this migration will pass.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
     AND c.relname <> ALL (ARRAY[]::text[]);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'sequences without an entry in the sequence manifest: %', missing;
  END IF;

  -- Lock-only column grants require the immutability triggers (OD-P3): fail closed if either is
  -- missing or disabled, so the UPDATE privilege that enables row locking can never update a row.
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM (VALUES ('institution_documents_immutable'), ('institution_documents_no_truncate')) AS t(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger g
      WHERE g.tgrelid = 'public.institution_documents'::regclass AND g.tgname = t.name
        AND g.tgenabled IN ('O', 'A')
        AND g.tgfoid = to_regprocedure('public.reject_institution_document_mutation()'));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'institution_documents lock-only UPDATE grant requires enabled immutability triggers; missing or disabled: %', missing;
  END IF;

  -- Schema access: only the owner creates objects; named roles may resolve names.
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO eltnoy_app, eltnoy_audit_verifier;
  REVOKE CREATE ON SCHEMA public FROM eltnoy_app, eltnoy_audit_writer, eltnoy_audit_reader, eltnoy_audit_verifier;

  -- Functions: trigger functions don't need EXECUTE; nobody but the owner may call them directly.
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;

  -- Tables: start from nothing for every non-owner role, then grant the manifest exactly.
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, eltnoy_app, eltnoy_audit_writer, eltnoy_audit_reader, eltnoy_audit_verifier;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, eltnoy_app, eltnoy_audit_writer, eltnoy_audit_reader, eltnoy_audit_verifier;
  FOR i IN 1 .. array_length(tbls, 1) LOOP
    IF privs[i] !~ '^(SELECT|INSERT|UPDATE)(, (SELECT|INSERT|UPDATE))*$' THEN
      RAISE EXCEPTION 'manifest privileges for % must be drawn from SELECT, INSERT, UPDATE: %', tbls[i], privs[i];
    END IF;
    EXECUTE format('GRANT %s ON TABLE public.%I TO eltnoy_app', privs[i], tbls[i]);
    IF colsets[i] <> '' THEN
      IF position('UPDATE' IN privs[i]) > 0 THEN
        RAISE EXCEPTION 'manifest for % grants table-wide UPDATE and column UPDATE; choose one', tbls[i];
      END IF;
      cols := NULL;
      FOREACH col IN ARRAY string_to_array(colsets[i], ',') LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = format('public.%I', tbls[i])::regclass
                        AND attname = col AND attnum > 0 AND NOT attisdropped) THEN
          RAISE EXCEPTION 'manifest column %.% does not exist', tbls[i], col;
        END IF;
        cols := concat_ws(', ', cols, quote_ident(col));
      END LOOP;
      EXECUTE format('GRANT UPDATE (%s) ON TABLE public.%I TO eltnoy_app', cols, tbls[i]);
    END IF;
  END LOOP;
END
$grants$;
