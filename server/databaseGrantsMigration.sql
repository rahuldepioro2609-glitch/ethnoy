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
-- - Allowed table privileges are SELECT, INSERT and UPDATE only. Never TRUNCATE, REFERENCES or
--   TRIGGER: the API never truncates or runs DDL. DELETE is refused on every table except exactly
--   one, student_registration_claims (AUTH C1, approved): the API deletes only expired, unconsumed
--   registration claims there. No other table may ever be granted DELETE (enforced below).
-- - A table with an empty privilege string is deliberately retained but inaccessible to the API.
--   This is for legacy production tables with no references in the current source; their data stays
--   preserved and they can be reviewed separately before any future feature is allowed to use them.
-- - update_columns lists column-level UPDATE grants. Since OD-P4 no table has table-wide UPDATE:
--   each list is exactly the columns the server code assigns (UPDATE ... SET and
--   INSERT ... ON CONFLICT DO UPDATE SET). SELECT ... FOR UPDATE / FOR SHARE needs UPDATE on at
--   least one column, which every locked table has. Column-only UPDATE also denies the API role
--   LOCK TABLE ... ACCESS EXCLUSIVE (PostgreSQL 17: every explicit LOCK mode other than ACCESS SHARE
--   and ROW EXCLUSIVE needs table-level UPDATE, DELETE, TRUNCATE or MAINTAIN).
-- - AUTH C1 locking note (student_registration_claims). A normal DELETE takes only a ROW EXCLUSIVE
--   table-level lock plus row-level locks on the rows it deletes; it never takes ACCESS EXCLUSIVE.
--   But the table-level DELETE grant also lets eltnoy_app request an explicit LOCK TABLE in any mode
--   on this one table, including ACCESS EXCLUSIVE. Application code never issues LOCK TABLE; a misused
--   or compromised application role could block all reads and writes on student_registration_claims
--   (and so Student registration) until its transaction ends. No other table is affected.
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
    ('users',                                'SELECT, INSERT',         ARRAY['account_status', 'display_name', 'contact_email', 'registration_number', 'registered_address', 'website']),
    -- AUTH-1 (authVerificationMigration.sql). UPDATE columns are exactly those the server assigns;
    -- append-only auth_verification_events and the insert-only tables get none.
    ('account_contacts',                     'SELECT, INSERT',         ARRAY['destination', 'verified_at']),
    ('auth_session_verifications',           'SELECT, INSERT',         NULL),
    ('auth_verification_events',             'SELECT, INSERT',         NULL),
    ('google_identities',                    'SELECT, INSERT',         NULL),
    ('institute_verifications',              'SELECT, INSERT',         ARRAY['mobile_destination', 'mobile_verified_at', 'email_destination', 'email_verified_at', 'updated_at', 'institutional_status', 'institutional_decided_at', 'institutional_decided_by', 'suspended_at', 'suspended_by']),
    ('oauth_states',                         'SELECT, INSERT',         ARRAY['consumed_at']),
    ('verification_challenges',              'SELECT, INSERT',         ARRAY['destination', 'code_hash', 'code_expires_at', 'send_count', 'last_sent_at', 'attempts', 'consumed_at']),
    -- AUTH C1 (studentRegistrationClaimsMigration.sql). consumed_at is the only assigned column (it
    -- also permits the completion's SELECT ... FOR UPDATE); DELETE is for expired-claim cleanup only.
    ('student_registration_claims',          'SELECT, INSERT, DELETE', ARRAY['consumed_at']),
    -- AUTH C1.8, MFA Phase 2 (adminMfaMigration.sql). No DELETE anywhere. UPDATE columns are only the
    -- state columns each workflow sets; identity, secret, hash and time-of-creation columns are never
    -- updatable. Triggers stamp every state time from the database clock (decided_at needs no grant
    -- at all) and make finished states final. auth_session_mfa_verifications is insert-only.
    ('admin_mfa_challenges',                 'SELECT, INSERT',         ARRAY['attempts', 'enrolment_ticket_id', 'consumed_at', 'consumed_reason']),
    ('admin_mfa_enrolment_tickets',          'SELECT, INSERT',         ARRAY['used_at', 'revoked_at']),
    ('admin_mfa_factors',                    'SELECT, INSERT',         ARRAY['last_used_step', 'disabled_at', 'disabled_by', 'disabled_via']),
    ('admin_mfa_recovery_codes',             'SELECT, INSERT',         ARRAY['used_at', 'revoked_at']),
    ('admin_mfa_reset_requests',             'SELECT, INSERT',         ARRAY['status', 'decided_by', 'decided_verification_id', 'decision_reason', 'ticket_id']),
    ('auth_session_mfa_verifications',       'SELECT, INSERT',         NULL),
    -- SM-1 Platform Staff. The catalogue and role-permission join stay read-only and empty until
    -- their policy is approved. All account/session changes use narrow state-column UPDATE grants.
    ('platform_staff_departments',           'SELECT, INSERT',         NULL),
    ('platform_staff_roles',                'SELECT, INSERT',         NULL),
    ('platform_staff_permission_catalogue', 'SELECT',                 NULL),
    ('platform_staff_role_permissions',     'SELECT',                 NULL),
    ('platform_staff_accounts',             'SELECT, INSERT',         ARRAY['password_hash', 'must_change_password', 'status', 'department_id', 'deactivated_at', 'deactivated_by']),
    ('platform_staff_account_roles',        'SELECT, INSERT',         ARRAY['revoked_at', 'revoked_by']),
    ('platform_staff_sessions',             'SELECT, INSERT',         ARRAY['revoked_at']),
    ('platform_staff_audit_events',         'SELECT, INSERT',         NULL),
    -- SM-1 Organization Staff. Predefined role templates are migration-seeded and API read-only.
    -- SMS verification remains unavailable until an approved provider is configured.
    ('org_staff_role_templates',            'SELECT',                 NULL),
    ('org_staff_members',                  'SELECT, INSERT',         ARRAY['password_hash', 'accepted_at', 'status', 'activated_at', 'activated_by']),
    ('org_staff_invitations',              'SELECT, INSERT',         ARRAY['used_at']),
    ('org_staff_member_roles',             'SELECT, INSERT',         ARRAY['revoked_at', 'revoked_by']),
    ('org_staff_sessions',                 'SELECT, INSERT',         ARRAY['revoked_at']),
    ('org_staff_audit_events',             'SELECT, INSERT',         NULL),
    -- Legacy Render tables absent from current source. Preserve them without granting the app access.
    ('answer_key_objection_windows',        '',                       NULL),
    ('answer_key_objections',               '',                       NULL),
    ('auth_tokens',                         '',                       NULL),
    ('uploaded_files',                      '',                       NULL)
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

  -- Trigger functions are owner-only. Enrollment confirmation is the sole application-callable
  -- function; it enforces the lock order and is the only path that can set confirmed_at.
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public
    FROM PUBLIC, eltnoy_app, eltnoy_audit_writer, eltnoy_audit_reader, eltnoy_audit_verifier;
  GRANT EXECUTE ON FUNCTION public.confirm_admin_mfa_enrolment_factor(text, text, text, text, bigint)
    TO eltnoy_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;

  -- Tables: start from nothing for every non-owner role, then grant the manifest exactly.
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, eltnoy_app, eltnoy_audit_writer, eltnoy_audit_reader, eltnoy_audit_verifier;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, eltnoy_app, eltnoy_audit_writer, eltnoy_audit_reader, eltnoy_audit_verifier;
  FOR i IN 1 .. array_length(tbls, 1) LOOP
    IF privs[i] = '' THEN
      IF colsets[i] <> '' THEN
        RAISE EXCEPTION 'manifest for % has update columns but no table privileges', tbls[i];
      END IF;
      CONTINUE;
    END IF;
    IF privs[i] !~ '^(SELECT|INSERT|UPDATE|DELETE)(, (SELECT|INSERT|UPDATE|DELETE))*$' THEN
      RAISE EXCEPTION 'manifest privileges for % must be drawn from SELECT, INSERT, UPDATE (DELETE only on student_registration_claims): %', tbls[i], privs[i];
    END IF;
    IF privs[i] ~ 'DELETE' AND tbls[i] <> 'student_registration_claims' THEN
      RAISE EXCEPTION 'DELETE may be granted only on student_registration_claims, not on %', tbls[i];
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
