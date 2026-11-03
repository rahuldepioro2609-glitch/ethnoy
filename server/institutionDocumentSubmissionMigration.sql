BEGIN;

CREATE TABLE institution_submission_cycles (
  id text PRIMARY KEY,
  institution_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submission_version integer NOT NULL CHECK (submission_version > 0),
  source_type text NOT NULL CHECK (
    source_type IN ('initial_registration', 'resubmission', 'recovery')
  ),
  source_reference text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (institution_id, submission_version),
  UNIQUE (id, institution_id),
  CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX institution_submission_cycles_one_open_idx
  ON institution_submission_cycles(institution_id)
  WHERE status = 'open';

CREATE OR REPLACE FUNCTION protect_institution_submission_cycles()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'institution submission cycles cannot be deleted or truncated';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
     OR NEW.submission_version IS DISTINCT FROM OLD.submission_version
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'institution submission cycle identity is immutable';
  END IF;
  IF OLD.status = 'closed'
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
    RAISE EXCEPTION 'closed institution submission cycles are immutable';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'open' AND NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'an open submission cycle cannot have a closed timestamp';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER institution_submission_cycles_immutable
  BEFORE UPDATE OR DELETE ON institution_submission_cycles
  FOR EACH ROW EXECUTE FUNCTION protect_institution_submission_cycles();

CREATE TRIGGER institution_submission_cycles_no_truncate
  BEFORE TRUNCATE ON institution_submission_cycles
  FOR EACH STATEMENT EXECUTE FUNCTION protect_institution_submission_cycles();

CREATE TABLE institution_submission_capabilities (
  id text PRIMARY KEY,
  institution_id text NOT NULL,
  submission_cycle_id text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (submission_cycle_id, institution_id)
    REFERENCES institution_submission_cycles(id, institution_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE INDEX institution_submission_capabilities_active_idx
  ON institution_submission_capabilities(institution_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX institution_submission_capabilities_one_unrevoked_idx
  ON institution_submission_capabilities(institution_id)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION protect_institution_submission_capabilities()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'institution submission capabilities cannot be deleted or truncated';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
     OR NEW.submission_cycle_id IS DISTINCT FROM OLD.submission_cycle_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'institution submission capability identity is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'revoked institution submission capabilities are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER institution_submission_capabilities_immutable
  BEFORE UPDATE OR DELETE ON institution_submission_capabilities
  FOR EACH ROW EXECUTE FUNCTION protect_institution_submission_capabilities();

CREATE TRIGGER institution_submission_capabilities_no_truncate
  BEFORE TRUNCATE ON institution_submission_capabilities
  FOR EACH STATEMENT EXECUTE FUNCTION protect_institution_submission_capabilities();

ALTER TABLE institution_documents
  ADD COLUMN submission_cycle_id text;

ALTER TABLE institution_documents
  ADD CONSTRAINT institution_documents_submission_cycle_fk
  FOREIGN KEY (submission_cycle_id, institution_id)
  REFERENCES institution_submission_cycles(id, institution_id)
  ON DELETE RESTRICT;

CREATE INDEX institution_documents_submission_cycle_idx
  ON institution_documents(submission_cycle_id, category);

CREATE OR REPLACE FUNCTION require_cycle_for_new_institution_document()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.submission_cycle_id IS NULL THEN
    RAISE EXCEPTION 'new institution documents require a submission cycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER institution_documents_require_cycle_on_insert
  BEFORE INSERT ON institution_documents
  FOR EACH ROW EXECUTE FUNCTION require_cycle_for_new_institution_document();

COMMIT;
