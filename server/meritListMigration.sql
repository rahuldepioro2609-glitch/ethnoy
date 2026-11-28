-- Merit List Engine, foundation release (documentation/MERIT_LIST_GAP_ANALYSIS.md).
--
-- merit_list_snapshots: append-only DRAFT versions of an exam's marks order, computed by
-- server/meritList.ts from the exam's result records. A snapshot never changes results, never
-- breaks ties, never applies cut-offs or categories (client decisions ML-1 to ML-9 pending), and is
-- never published: status is 'draft' only until a publication rule is approved (ML-6).
--
-- - Version history: rows are never updated or deleted (triggers below); a recalculation is a new
--   version. (exam_code, version) and (exam_code, input_fingerprint) are unique, so the same inputs
--   can never create a second version, and two concurrent creations cannot share a version number.
-- - Data minimisation: entries hold application and roll numbers, totals, positions, tie groups and
--   issue codes only; never names, dates of birth, categories or section marks.
-- - created_by is text, not a foreign key (history must survive account changes). No sequences.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS merit_list_snapshots (
  id                text        PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 64),
  exam_code         text        NOT NULL CHECK (char_length(exam_code) BETWEEN 2 AND 30 AND exam_code = upper(exam_code)),
  version           integer     NOT NULL CHECK (version >= 1),
  status            text        NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  engine_version    text        NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
  input_fingerprint text        NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  result_count      integer     NOT NULL CHECK (result_count >= 0),
  entry_count       integer     NOT NULL CHECK (entry_count >= 0),
  excluded_count    integer     NOT NULL CHECK (excluded_count >= 0),
  tie_group_count   integer     NOT NULL CHECK (tie_group_count >= 0),
  issue_count       integer     NOT NULL CHECK (issue_count >= 0),
  entries           jsonb       NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  excluded          jsonb       NOT NULL CHECK (jsonb_typeof(excluded) = 'array'),
  created_by        text        NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT merit_list_snapshots_version_unique UNIQUE (exam_code, version),
  CONSTRAINT merit_list_snapshots_inputs_unique UNIQUE (exam_code, input_fingerprint)
);

CREATE OR REPLACE FUNCTION merit_list_snapshots_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merit_list_snapshots is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS merit_list_snapshots_no_update_delete ON merit_list_snapshots;
CREATE TRIGGER merit_list_snapshots_no_update_delete BEFORE UPDATE OR DELETE ON merit_list_snapshots
  FOR EACH ROW EXECUTE FUNCTION merit_list_snapshots_reject_mutation();
DROP TRIGGER IF EXISTS merit_list_snapshots_no_truncate ON merit_list_snapshots;
CREATE TRIGGER merit_list_snapshots_no_truncate BEFORE TRUNCATE ON merit_list_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION merit_list_snapshots_reject_mutation();
