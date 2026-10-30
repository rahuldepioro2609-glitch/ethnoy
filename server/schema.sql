CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  login_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('candidate', 'center', 'official')),
  password_hash text NOT NULL,
  contact_email text,
  registration_number text,
  registered_address text,
  website text,
  account_status text NOT NULL DEFAULT 'approved'
    CHECK (account_status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registered_address text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'approved';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_account_status_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_account_status_check
      CHECK (account_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS feedback (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('bug', 'suggestion', 'cbt_issue', 'admit_card', 'performance', 'other')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 4 AND 100),
  description text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 1000),
  module text NOT NULL,
  candidate_name text,
  email text,
  application_number text,
  priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'under_review' CHECK (status IN ('under_review', 'in_progress', 'resolved')),
  attachment_name text,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS applications (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  application_number text NOT NULL UNIQUE,
  exam_code text NOT NULL,
  candidate_name text NOT NULL,
  father_name text NOT NULL,
  date_of_birth date NOT NULL,
  gender text NOT NULL CHECK (gender IN ('Male', 'Female', 'Other')),
  category text NOT NULL CHECK (category IN ('General', 'OBC-NCL', 'SC', 'ST', 'Gen-EWS')),
  email text NOT NULL,
  phone text NOT NULL,
  first_city_preference text NOT NULL,
  second_city_preference text NOT NULL,
  language_medium text NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS father_name text NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'Other';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'General';
CREATE INDEX IF NOT EXISTS applications_exam_code_idx ON applications(exam_code);
CREATE INDEX IF NOT EXISTS applications_created_at_idx ON applications(created_at DESC);
CREATE INDEX IF NOT EXISTS applications_user_id_idx ON applications(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS applications_user_exam_idx
  ON applications(user_id, exam_code) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS exams (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('Undergraduate', 'Scholarship', 'Teacher', 'Professional')),
  target_audience text NOT NULL,
  registration_start date NOT NULL,
  registration_end date NOT NULL,
  exam_date date NOT NULL,
  fee text NOT NULL,
  duration text NOT NULL,
  mode text NOT NULL,
  shifts text NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (registration_end >= registration_start)
);
CREATE INDEX IF NOT EXISTS exams_public_dates_idx
  ON exams(is_published, registration_start, registration_end);

CREATE TABLE IF NOT EXISTS admit_cards (
  application_id text PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  roll_number text NOT NULL UNIQUE,
  exam_date text NOT NULL,
  reporting_time text NOT NULL,
  gate_closing_time text NOT NULL,
  exam_timing text NOT NULL,
  center_code text NOT NULL,
  center_name text NOT NULL,
  center_address text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS center_checkins (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  center_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('verified', 'admitted', 'flagged', 'rejected')),
  note text,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, center_code)
);
CREATE INDEX IF NOT EXISTS center_checkins_center_code_idx
  ON center_checkins(center_code, updated_at DESC);

CREATE TABLE IF NOT EXISTS mock_exam_attempts (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  responses jsonb NOT NULL,
  total_questions integer NOT NULL,
  attempted integer NOT NULL,
  correct integer NOT NULL,
  incorrect integer NOT NULL,
  unattempted integer NOT NULL,
  total_score integer NOT NULL,
  max_score integer NOT NULL,
  percentage integer NOT NULL,
  section_scores jsonb NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mock_exam_attempts_user_id_idx ON mock_exam_attempts(user_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS published_results (
  id text PRIMARY KEY,
  application_number text NOT NULL,
  roll_number text NOT NULL,
  exam_code text NOT NULL,
  date_of_birth date NOT NULL,
  scorecard jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_code, roll_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS published_results_application_idx
  ON published_results(exam_code, application_number);
