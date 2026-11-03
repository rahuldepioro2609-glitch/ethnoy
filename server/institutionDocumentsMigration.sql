BEGIN;

CREATE TABLE institution_documents (
  id text PRIMARY KEY,
  institution_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN (
    'Registration Certificate',
    'PAN Card',
    'Address Proof',
    'Affiliation / Recognition Certificate',
    'Authorized Person’s ID Proof'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, institution_id, category)
);

CREATE INDEX institution_documents_institution_category_idx
  ON institution_documents(institution_id, category, created_at DESC);

CREATE TABLE institution_document_versions (
  id text PRIMARY KEY,
  document_id text NOT NULL,
  institution_id text NOT NULL,
  category text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f-]{36}$'),
  detected_media_type text NOT NULL CHECK (
    detected_media_type IN ('application/pdf', 'image/jpeg', 'image/png')
  ),
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number),
  UNIQUE (id, institution_id),
  FOREIGN KEY (document_id, institution_id, category)
    REFERENCES institution_documents(id, institution_id, category)
    ON DELETE RESTRICT
);

CREATE INDEX institution_document_versions_institution_idx
  ON institution_document_versions(institution_id, uploaded_at DESC);

CREATE OR REPLACE FUNCTION reject_institution_document_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'institution document versions are append-only';
END;
$$;

CREATE TRIGGER institution_document_versions_append_only
  BEFORE UPDATE OR DELETE ON institution_document_versions
  FOR EACH ROW EXECUTE FUNCTION reject_institution_document_version_mutation();

CREATE TRIGGER institution_document_versions_no_truncate
  BEFORE TRUNCATE ON institution_document_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_institution_document_version_mutation();

CREATE TABLE institution_document_review_history (
  id text PRIMARY KEY,
  version_id text NOT NULL,
  institution_id text NOT NULL,
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision_code text,
  reviewer_remarks text NOT NULL CHECK (char_length(btrim(reviewer_remarks)) BETWEEN 1 AND 2000),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (version_id, institution_id)
    REFERENCES institution_document_versions(id, institution_id)
    ON DELETE RESTRICT
);

CREATE INDEX institution_document_review_history_version_idx
  ON institution_document_review_history(version_id, reviewed_at DESC);

CREATE OR REPLACE FUNCTION reject_institution_document_review_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'institution document review history is append-only';
END;
$$;

CREATE TRIGGER institution_document_review_history_append_only
  BEFORE UPDATE OR DELETE ON institution_document_review_history
  FOR EACH ROW EXECUTE FUNCTION reject_institution_document_review_mutation();

CREATE TRIGGER institution_document_review_history_no_truncate
  BEFORE TRUNCATE ON institution_document_review_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_institution_document_review_mutation();

COMMIT;
