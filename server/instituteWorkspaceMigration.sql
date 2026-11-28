-- Institute Workspace (Sections 01-17) additive, re-runnable PostgreSQL migration.
-- All tables are tenant-scoped by institute_id -> users(id) and use text UUID primary keys
-- (no sequences). Every table is registered in databaseGrantsMigration.sql.

CREATE TABLE IF NOT EXISTS institute_branches (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 150),
  code text NOT NULL CHECK (char_length(btrim(code)) BETWEEN 2 AND 40),
  city text NOT NULL CHECK (char_length(btrim(city)) BETWEEN 2 AND 100),
  state text NOT NULL DEFAULT '' CHECK (char_length(state) <= 100),
  coordinator_name text NOT NULL CHECK (char_length(btrim(coordinator_name)) BETWEEN 2 AND 120),
  coordinator_email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institute_id, code)
);
CREATE INDEX IF NOT EXISTS institute_branches_institute_idx
  ON institute_branches(institute_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_exams (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_code text NOT NULL CHECK (char_length(btrim(exam_code)) BETWEEN 2 AND 40),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  category text NOT NULL CHECK (category IN ('Scholarship', 'Recruitment', 'Admission', 'Mock', 'Certification', 'Other')),
  mode text NOT NULL CHECK (mode IN ('Online CBT', 'Offline', 'Hybrid')),
  eligibility text NOT NULL CHECK (char_length(btrim(eligibility)) BETWEEN 2 AND 300),
  academic_year text NOT NULL DEFAULT '2026-27',
  app_open_date date NOT NULL,
  app_close_date date NOT NULL,
  exam_date date NOT NULL,
  exam_time text NOT NULL DEFAULT '10:00',
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 10 AND 600),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  sessions_info text NOT NULL DEFAULT '',
  fee_paise bigint NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
  refund_policy text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  approval_mode text NOT NULL DEFAULT 'single' CHECK (approval_mode IN ('single', 'dual')),
  lifecycle_status text NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_status IN ('draft', 'pending_approval', 'needs_changes', 'approved', 'published', 'registration_open', 'closed', 'cancelled', 'archived')),
  status_reason text NOT NULL DEFAULT '',
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institute_id, exam_code),
  CHECK (app_close_date >= app_open_date)
);
CREATE INDEX IF NOT EXISTS institute_exams_institute_idx
  ON institute_exams(institute_id, exam_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_exam_broadcasts (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text NOT NULL REFERENCES institute_exams(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('all_registered', 'verified_only', 'pending_verification', 'admit_card_released')),
  subject text NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 3 AND 180),
  message text NOT NULL CHECK (char_length(btrim(message)) BETWEEN 5 AND 4000),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  channel text NOT NULL DEFAULT 'portal_notice' CHECK (channel IN ('portal_notice', 'email', 'sms')),
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'provider_unavailable')),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_exam_broadcasts_idx
  ON institute_exam_broadcasts(institute_id, exam_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_app_forms (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  document_rules_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_at timestamptz,
  close_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_app_forms_idx
  ON institute_app_forms(institute_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_candidate_applications (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  form_id text REFERENCES institute_app_forms(id) ON DELETE SET NULL,
  application_number text NOT NULL CHECK (char_length(btrim(application_number)) BETWEEN 3 AND 60),
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  candidate_email text NOT NULL DEFAULT '',
  candidate_mobile text NOT NULL DEFAULT '',
  form_data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  documents_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  stage text NOT NULL DEFAULT 'submitted' CHECK (stage IN ('started', 'profile', 'documents', 'submitted')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'waived')),
  review_status text NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'verified', 'correction_requested', 'flagged', 'rejected')),
  review_reason text NOT NULL DEFAULT '',
  reviewer_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institute_id, application_number)
);
CREATE INDEX IF NOT EXISTS institute_candidate_applications_idx
  ON institute_candidate_applications(institute_id, review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_verification_logs (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text NOT NULL REFERENCES institute_candidate_applications(id) ON DELETE CASCADE,
  reviewer_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('verified', 'correction_requested', 'flagged', 'rejected')),
  target_field text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_verification_logs_idx
  ON institute_verification_logs(institute_id, application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_fee_transactions (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  application_id text REFERENCES institute_candidate_applications(id) ON DELETE SET NULL,
  txn_ref text NOT NULL CHECK (char_length(btrim(txn_ref)) BETWEEN 3 AND 80),
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  payment_method text NOT NULL DEFAULT 'UPI' CHECK (payment_method IN ('UPI', 'Card', 'NetBanking', 'Challan', 'Manual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('initiated', 'pending', 'successful', 'failed', 'refunded')),
  gateway_ref text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institute_id, txn_ref)
);
CREATE INDEX IF NOT EXISTS institute_fee_transactions_idx
  ON institute_fee_transactions(institute_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_fee_refunds (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id text NOT NULL REFERENCES institute_fee_transactions(id) ON DELETE CASCADE,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'processed')),
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_fee_refunds_idx
  ON institute_fee_refunds(institute_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_admit_card_templates (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  template_name text NOT NULL CHECK (char_length(btrim(template_name)) BETWEEN 2 AND 120),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  header_title text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  show_photo boolean NOT NULL DEFAULT true,
  show_qr boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_admit_card_templates_idx
  ON institute_admit_card_templates(institute_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS institute_hall_tickets (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text NOT NULL REFERENCES institute_exams(id) ON DELETE CASCADE,
  application_id text REFERENCES institute_candidate_applications(id) ON DELETE SET NULL,
  roll_number text NOT NULL CHECK (char_length(btrim(roll_number)) BETWEEN 3 AND 60),
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  center_code text NOT NULL DEFAULT '',
  center_name text NOT NULL DEFAULT '',
  seat_number text NOT NULL DEFAULT '',
  exam_date date NOT NULL,
  exam_time text NOT NULL DEFAULT '10:00',
  qr_token_hash text NOT NULL,
  release_status text NOT NULL DEFAULT 'generated' CHECK (release_status IN ('generated', 'released', 'revoked')),
  download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (institute_id, exam_id, roll_number)
);
CREATE INDEX IF NOT EXISTS institute_hall_tickets_idx
  ON institute_hall_tickets(institute_id, exam_id, release_status);
-- One admit card per application and exam, enforced by the database (concurrent generation cannot
-- create a second card for the same candidate).
CREATE UNIQUE INDEX IF NOT EXISTS institute_hall_tickets_application_idx
  ON institute_hall_tickets(exam_id, application_id) WHERE application_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS institute_questions (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 2 AND 80),
  topic text NOT NULL DEFAULT '' CHECK (char_length(topic) <= 120),
  difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question_type text NOT NULL DEFAULT 'mcq' CHECK (question_type IN ('mcq', 'multi_select', 'true_false', 'descriptive')),
  question_text text NOT NULL CHECK (char_length(btrim(question_text)) BETWEEN 3 AND 4000),
  options_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  correct_answer text NOT NULL DEFAULT '',
  explanation text NOT NULL DEFAULT '',
  marks numeric(6,2) NOT NULL DEFAULT 1 CHECK (marks > 0),
  negative_marks numeric(6,2) NOT NULL DEFAULT 0 CHECK (negative_marks >= 0),
  tags text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  moderation_status text NOT NULL DEFAULT 'draft'
    CHECK (moderation_status IN ('draft', 'in_review', 'approved', 'rejected', 'archived')),
  authored_by text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_questions_idx
  ON institute_questions(institute_id, moderation_status, subject);

CREATE TABLE IF NOT EXISTS institute_paper_blueprints (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  total_marks numeric(8,2) NOT NULL DEFAULT 0 CHECK (total_marks >= 0),
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 10 AND 600),
  sections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  question_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_locked boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  locked_by text REFERENCES users(id) ON DELETE SET NULL,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_paper_blueprints_idx
  ON institute_paper_blueprints(institute_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_cbt_sessions (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  application_id text REFERENCES institute_candidate_applications(id) ON DELETE SET NULL,
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  roll_number text NOT NULL CHECK (char_length(btrim(roll_number)) BETWEEN 2 AND 60),
  room_name text NOT NULL DEFAULT 'Room A',
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'active', 'reconnecting', 'disconnected', 'submitted')),
  started_at timestamptz,
  authoritative_end_at timestamptz,
  last_heartbeat_at timestamptz,
  autosave_count integer NOT NULL DEFAULT 0 CHECK (autosave_count >= 0),
  invigilator_name text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_cbt_sessions_idx
  ON institute_cbt_sessions(institute_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS institute_cbt_incidents (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES institute_cbt_sessions(id) ON DELETE CASCADE,
  flag_type text NOT NULL CHECK (flag_type IN ('focus_loss', 'device_switch', 'network_retry', 'other')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  note text NOT NULL DEFAULT '',
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'reviewed', 'escalated', 'dismissed')),
  reviewed_by text REFERENCES users(id) ON DELETE SET NULL,
  review_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_cbt_incidents_idx
  ON institute_cbt_incidents(institute_id, review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_exam_results (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text NOT NULL REFERENCES institute_exams(id) ON DELETE CASCADE,
  application_id text REFERENCES institute_candidate_applications(id) ON DELETE SET NULL,
  roll_number text NOT NULL CHECK (char_length(btrim(roll_number)) BETWEEN 2 AND 60),
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  raw_score numeric(8,2) NOT NULL DEFAULT 0,
  max_score numeric(8,2) NOT NULL DEFAULT 100 CHECK (max_score > 0),
  percentage numeric(6,2) NOT NULL DEFAULT 0,
  rank_position integer CHECK (rank_position IS NULL OR rank_position > 0),
  qualifying_status text NOT NULL DEFAULT 'pending' CHECK (qualifying_status IN ('passed', 'failed', 'pending')),
  evaluation_status text NOT NULL DEFAULT 'pending'
    CHECK (evaluation_status IN ('pending', 'evaluated', 'moderated', 'approved', 'published')),
  answer_key_approved_by text REFERENCES users(id) ON DELETE SET NULL,
  final_approved_by text REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institute_id, exam_id, roll_number)
);
CREATE INDEX IF NOT EXISTS institute_exam_results_idx
  ON institute_exam_results(institute_id, exam_id, evaluation_status);

CREATE TABLE IF NOT EXISTS institute_result_appeals (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result_id text NOT NULL REFERENCES institute_exam_results(id) ON DELETE CASCADE,
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'rejected')),
  resolution_note text NOT NULL DEFAULT '',
  resolved_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_result_appeals_idx
  ON institute_result_appeals(institute_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_saved_reports (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 160),
  dataset text NOT NULL CHECK (dataset IN ('applications', 'exams', 'fees', 'attendance', 'results')),
  filters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_format text NOT NULL DEFAULT 'csv' CHECK (output_format IN ('csv', 'json')),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  last_generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_saved_reports_idx
  ON institute_saved_reports(institute_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_attendance_logs (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  roll_number text NOT NULL CHECK (char_length(btrim(roll_number)) BETWEEN 2 AND 60),
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  center_name text NOT NULL DEFAULT '',
  session_name text NOT NULL DEFAULT 'Morning',
  status text NOT NULL CHECK (status IN ('present', 'absent', 'late', 'exception')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('qr_scan', 'manual', 'import')),
  reason text NOT NULL DEFAULT '',
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_attendance_logs_idx
  ON institute_attendance_logs(institute_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_interviews (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id text REFERENCES institute_exams(id) ON DELETE SET NULL,
  candidate_name text NOT NULL CHECK (char_length(btrim(candidate_name)) BETWEEN 2 AND 120),
  application_number text NOT NULL DEFAULT '',
  panel_name text NOT NULL CHECK (char_length(btrim(panel_name)) BETWEEN 2 AND 80),
  panelist_names text NOT NULL DEFAULT '',
  scheduled_date date NOT NULL,
  start_time text NOT NULL CHECK (start_time ~ '^\d{2}:\d{2}$'),
  end_time text NOT NULL CHECK (end_time ~ '^\d{2}:\d{2}$'),
  mode text NOT NULL DEFAULT 'video' CHECK (mode IN ('video', 'in_person')),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'completed', 'cancelled')),
  consent_recorded boolean NOT NULL DEFAULT false,
  recording_enabled boolean NOT NULL DEFAULT false,
  meeting_ref text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT recording_enabled OR consent_recorded)
);
CREATE INDEX IF NOT EXISTS institute_interviews_idx
  ON institute_interviews(institute_id, scheduled_date, start_time);

CREATE TABLE IF NOT EXISTS institute_interview_scorecards (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interview_id text NOT NULL REFERENCES institute_interviews(id) ON DELETE CASCADE,
  panelist_name text NOT NULL CHECK (char_length(btrim(panelist_name)) BETWEEN 2 AND 120),
  subject_score numeric(4,2) NOT NULL CHECK (subject_score BETWEEN 0 AND 10),
  communication_score numeric(4,2) NOT NULL CHECK (communication_score BETWEEN 0 AND 10),
  pedagogy_score numeric(4,2) NOT NULL CHECK (pedagogy_score BETWEEN 0 AND 10),
  problem_solving_score numeric(4,2) NOT NULL CHECK (problem_solving_score BETWEEN 0 AND 10),
  remarks text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft', 'submitted', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_interview_scorecards_idx
  ON institute_interview_scorecards(institute_id, interview_id, created_at DESC);

-- Interview cancellation and rescheduling history (2026-11-28). Append-only: the API role may only read and
-- add rows, so earlier dates, times, panels and reasons are never overwritten. Written in the same
-- transaction as the change to institute_interviews.
CREATE TABLE IF NOT EXISTS institute_interview_changes (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interview_id text NOT NULL REFERENCES institute_interviews(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('cancelled', 'rescheduled')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  previous_json jsonb NOT NULL,
  new_json jsonb,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'cancelled' AND new_json IS NULL) OR (action = 'rescheduled' AND new_json IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS institute_interview_changes_idx
  ON institute_interview_changes(institute_id, interview_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_training_courses (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  category text NOT NULL DEFAULT 'General',
  module_count integer NOT NULL DEFAULT 1 CHECK (module_count BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_training_courses_idx
  ON institute_training_courses(institute_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS institute_training_sessions (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text REFERENCES institute_training_courses(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  session_date date NOT NULL,
  session_time text NOT NULL DEFAULT '10:00',
  visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft', 'published')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_training_sessions_idx
  ON institute_training_sessions(institute_id, session_date);

CREATE TABLE IF NOT EXISTS institute_training_enrollments (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text NOT NULL REFERENCES institute_training_courses(id) ON DELETE CASCADE,
  learner_name text NOT NULL CHECK (char_length(btrim(learner_name)) BETWEEN 2 AND 120),
  learner_email text NOT NULL DEFAULT '',
  completed_modules integer NOT NULL DEFAULT 0 CHECK (completed_modules >= 0),
  assessment_score numeric(5,2) CHECK (assessment_score IS NULL OR (assessment_score BETWEEN 0 AND 100)),
  certificate_code text UNIQUE,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institute_training_enrollments_idx
  ON institute_training_enrollments(institute_id, course_id);
-- One enrolment per learner per course (2026-11-28). A learner is identified by email when one is given;
-- without an email, by name, so an accidental repeat is refused and two people with the same name need an
-- email to tell them apart. The database decides, so concurrent requests cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS institute_training_enrollments_email_uidx
  ON institute_training_enrollments(institute_id, course_id, lower(learner_email))
  WHERE learner_email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS institute_training_enrollments_name_uidx
  ON institute_training_enrollments(institute_id, course_id, lower(btrim(learner_name)))
  WHERE learner_email = '';

CREATE TABLE IF NOT EXISTS institute_support_tickets (
  id text PRIMARY KEY,
  institute_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_code text NOT NULL CHECK (char_length(btrim(ticket_code)) BETWEEN 3 AND 40),
  category text NOT NULL CHECK (category IN ('Payment', 'Access', 'Examination', 'Technical', 'Compliance', 'Other')),
  subject text NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 4 AND 180),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 10 AND 4000),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'pending', 'resolved')),
  owner_team text NOT NULL DEFAULT 'Platform Support',
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institute_id, ticket_code)
);
CREATE INDEX IF NOT EXISTS institute_support_tickets_idx
  ON institute_support_tickets(institute_id, status, created_at DESC);
