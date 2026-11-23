export interface ParameterizedQuery {
  text: string;
  values: unknown[];
}

export function candidateAdmitCardQuery(
  userId: string,
  applicationNumber: string,
  examCode: string,
): ParameterizedQuery {
  return {
    text: `SELECT a.application_number, a.candidate_name, a.father_name, a.date_of_birth,
                  a.gender, a.category, a.exam_code,
                  c.roll_number, c.exam_date, c.reporting_time, c.gate_closing_time,
                  c.exam_timing, c.center_code, c.center_name, c.center_address
           FROM applications a
           JOIN admit_cards c ON c.application_id = a.id
           WHERE a.user_id = $1
             AND a.application_number = $2
             AND a.exam_code = $3`,
    values: [userId, applicationNumber, examCode],
  };
}

export function candidateApplicationsQuery(userId: string): ParameterizedQuery {
  return {
    text: `SELECT a.application_number, a.exam_code, a.candidate_name, a.status, a.created_at,
                  c.roll_number, c.exam_date, c.center_name, c.center_address
           FROM applications a
           LEFT JOIN admit_cards c ON c.application_id = a.id
           WHERE a.user_id = $1
           ORDER BY a.created_at DESC`,
    values: [userId],
  };
}

export function candidatePracticeHistoryQuery(userId: string): ParameterizedQuery {
  return {
    text: `SELECT id, total_questions, attempted, correct, incorrect, unattempted, total_score,
                  max_score, percentage, section_scores, submitted_at
           FROM mock_exam_attempts
           WHERE user_id = $1
           ORDER BY submitted_at DESC`,
    values: [userId],
  };
}

export function candidateResultsQuery(userId: string): ParameterizedQuery {
  return {
    text: `SELECT r.application_number, r.roll_number, r.exam_code, r.published_at
           FROM published_results r
           WHERE r.is_published = true
             AND r.application_number IN (
               SELECT a.application_number FROM applications a WHERE a.user_id = $1
             )
           ORDER BY r.published_at DESC`,
    values: [userId],
  };
}

export function candidateResultLookupQuery(
  userId: string,
  identifier: string,
  dateOfBirth: string,
  examCode: string,
): ParameterizedQuery {
  return {
    text: `SELECT r.scorecard
           FROM published_results r
           JOIN applications a
             ON a.application_number = r.application_number
            AND a.exam_code = r.exam_code
           WHERE a.user_id = $1
             AND (r.roll_number = $2 OR r.application_number = $2)
             AND a.date_of_birth = $3
             AND r.date_of_birth = $3
             AND r.exam_code = $4
             AND r.is_published = true
           LIMIT 1`,
    values: [userId, identifier, dateOfBirth, examCode],
  };
}

export function centerWorkspaceQueries(instituteId: string): ParameterizedQuery[] {
  return [
    {
      text: `SELECT display_name, contact_email, registration_number, registered_address, website
             FROM users WHERE id = $1 AND role = 'center'`,
      values: [instituteId],
    },
    {
      text: `SELECT id, form_type, title, description, eligibility, application_deadline,
                    external_url, status, created_at
             FROM institute_forms WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 200`,
      values: [instituteId],
    },
    {
      text: `SELECT id, display_name, contact_email, registration_number, registered_address,
                    website, status, created_at
             FROM institute_profile_changes WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 100`,
      values: [instituteId],
    },
    {
      text: `SELECT id, entry_type, amount_paise, description, payment_reference,
                    transfer_reference, created_at
             FROM institute_wallet_entries WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 200`,
      values: [instituteId],
    },
    {
      text: `SELECT id, amount_paise, status, transfer_reference, created_at, reviewed_at
             FROM institute_withdrawals WHERE institute_id = $1 ORDER BY created_at DESC LIMIT 100`,
      values: [instituteId],
    },
    {
      text: `WITH institute AS (
               SELECT id, upper(login_id) AS center_code
               FROM users WHERE id = $1 AND role = 'center'
             ),
             checkins AS (
               SELECT c.status, c.updated_at
               FROM center_checkins c
               JOIN institute i ON c.center_code = i.center_code
             )
             SELECT
               COALESCE((SELECT SUM(CASE WHEN entry_type = 'credit' THEN amount_paise ELSE -amount_paise END)
                         FROM institute_wallet_entries WHERE institute_id = $1), 0)::text AS balance_paise,
               COALESCE((SELECT SUM(amount_paise) FROM institute_withdrawals
                         WHERE institute_id = $1 AND status IN ('pending', 'approved')), 0)::text AS reserved_paise,
               (SELECT count(*)::text FROM checkins) AS total_checkins,
               (SELECT count(*)::text FROM checkins WHERE status = 'verified') AS verified_checkins,
               (SELECT count(*)::text FROM checkins WHERE status = 'admitted') AS admitted_checkins,
               (SELECT count(*)::text FROM checkins WHERE status = 'flagged') AS flagged_checkins,
               (SELECT count(*)::text FROM checkins WHERE status = 'rejected') AS rejected_checkins,
               (SELECT count(*)::text FROM institute_forms WHERE institute_id = $1 AND status = 'approved') AS approved_forms,
               (SELECT count(*)::text FROM institute_forms WHERE institute_id = $1 AND status = 'pending') AS pending_forms,
               COALESCE((
                 SELECT json_agg(json_build_object('month', monthly.month, 'count', monthly.checkins) ORDER BY monthly.month)
                 FROM (
                   SELECT to_char(date_trunc('month', updated_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month,
                          count(*)::text AS checkins
                   FROM checkins
                   WHERE updated_at >= (
                     date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '5 months'
                   ) AT TIME ZONE 'Asia/Kolkata'
                   GROUP BY 1
                 ) monthly
               ), '[]'::json) AS monthly_checkins`,
      values: [instituteId],
    },
  ];
}

export function centerCheckinsQuery(centerCode: string): ParameterizedQuery {
  return {
    text: `SELECT c.id, c.status, c.note, c.updated_at, a.application_number, a.candidate_name,
                  a.exam_code, card.roll_number
           FROM center_checkins c
           JOIN applications a ON a.id = c.application_id
           JOIN admit_cards card ON card.application_id = a.id
           WHERE c.center_code = $1
           ORDER BY c.updated_at DESC LIMIT 500`,
    values: [centerCode],
  };
}

export function linkLegacyApplicationQuery(input: {
  applicationId: string;
  applicationNumber: string;
  dateOfBirth: string;
  candidateLoginId: string;
  verifierId: string;
  verificationMethod: string;
}): ParameterizedQuery {
  return {
    text: `UPDATE applications a
           SET user_id = u.id,
               ownership_verified_at = now(),
               ownership_verified_by = $5,
               ownership_verification_method = $6
           FROM users u
           WHERE a.id = $1
             AND a.application_number = $2
             AND a.date_of_birth = $3
             AND a.user_id IS NULL
             AND u.login_id = $4
             AND u.role = 'candidate'
             AND u.account_status = 'approved'
           RETURNING a.application_number, a.user_id, a.ownership_verified_at,
                     a.ownership_verification_method`,
    values: [
      input.applicationId,
      input.applicationNumber.toUpperCase(),
      input.dateOfBirth,
      input.candidateLoginId.toUpperCase(),
      input.verifierId,
      input.verificationMethod,
    ],
  };
}
