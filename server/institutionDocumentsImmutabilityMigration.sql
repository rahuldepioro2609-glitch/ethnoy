-- OD-P3: institution_documents rows are immutable.
--
-- A document row records only identity (id, institution, category, submission cycle, creation
-- time). Content changes are new rows in the append-only institution_document_versions table, so
-- no workflow ever updates or deletes an institution_documents row (verified against the server
-- code: INSERT, SELECT and one SELECT ... FOR UPDATE only). Every foreign key involving this table
-- is ON DELETE RESTRICT with the default ON UPDATE NO ACTION, so no cascade touches it either.
--
-- These triggers reject UPDATE, DELETE and TRUNCATE for every role, the owner included. That makes
-- the single column-level UPDATE grant the API role holds on this table harmless: PostgreSQL
-- requires UPDATE privilege on at least one column for SELECT ... FOR UPDATE (used to serialize
-- document replacement), but any actual UPDATE is now refused by the database.
--
-- Run by `npm run db:migrate` (server/migrate.ts) after the two institution migrations and before
-- databaseGrantsMigration.sql, which refuses to grant that column unless these triggers exist and
-- are enabled. Safe to re-run; changes no rows, privileges or columns.

CREATE OR REPLACE FUNCTION reject_institution_document_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'institution documents are immutable; upload a new version instead';
END;
$$;

DROP TRIGGER IF EXISTS institution_documents_immutable ON institution_documents;
CREATE TRIGGER institution_documents_immutable
  BEFORE UPDATE OR DELETE ON institution_documents
  FOR EACH ROW EXECUTE FUNCTION reject_institution_document_mutation();

DROP TRIGGER IF EXISTS institution_documents_no_truncate ON institution_documents;
CREATE TRIGGER institution_documents_no_truncate
  BEFORE TRUNCATE ON institution_documents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_institution_document_mutation();
