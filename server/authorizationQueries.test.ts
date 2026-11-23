import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateAdmitCardQuery,
  candidateApplicationsQuery,
  candidatePracticeHistoryQuery,
  candidateResultLookupQuery,
  candidateResultsQuery,
  centerCheckinsQuery,
  centerWorkspaceQueries,
  linkLegacyApplicationQuery,
} from './authorizationQueries.js';

test('candidate practice history returns all attempts scoped to the authenticated student', () => {
  const query = candidatePracticeHistoryQuery('candidate-a');

  assert.deepEqual(query.values, ['candidate-a']);
  assert.match(query.text, /WHERE user_id = \$1/);
  assert.match(query.text, /ORDER BY submitted_at DESC/);
  assert.doesNotMatch(query.text, /\bLIMIT\b|\bOFFSET\b/i);
});

test('candidate admit-card query requires ownership by the authenticated student', () => {
  const candidateA = candidateAdmitCardQuery('candidate-a', 'APP-1001', 'ENT-2025');
  const candidateB = candidateAdmitCardQuery('candidate-b', 'APP-1001', 'ENT-2025');

  assert.notDeepEqual(candidateA.values, candidateB.values);
  assert.deepEqual(candidateA.values, ['candidate-a', 'APP-1001', 'ENT-2025']);
  assert.match(candidateA.text, /a\.user_id = \$1/);
  assert.match(candidateA.text, /a\.application_number = \$2/);
  assert.match(candidateA.text, /a\.exam_code = \$3/);
  assert.match(candidateA.text, /JOIN admit_cards c ON c\.application_id = a\.id/);
  assert.doesNotMatch(candidateA.text, /login_id|\bOR\b/);
});

test('candidate portal queries expose only records owned by authenticated user ID', () => {
  const candidateA = candidateApplicationsQuery('candidate-a');
  const candidateB = candidateApplicationsQuery('candidate-b');
  const resultsA = candidateResultsQuery('candidate-a');

  assert.notDeepEqual(candidateA.values, candidateB.values);
  assert.deepEqual(candidateA.values, ['candidate-a']);
  assert.deepEqual(candidateB.values, ['candidate-b']);
  assert.match(candidateA.text, /WHERE a\.user_id = \$1/);
  assert.doesNotMatch(candidateA.text, /user_id IS NULL|application_number = \$2|roll_number = \$2/);
  assert.match(resultsA.text, /r\.is_published = true/);
  assert.match(resultsA.text, /a\.user_id = \$1/);
  assert.doesNotMatch(resultsA.text, /OR r\.application_number|OR r\.roll_number/);
});

test('candidate result lookup is scoped through the authenticated candidate application', () => {
  const query = candidateResultLookupQuery(
    'candidate-a',
    'ROLL-1001',
    '2000-01-02',
    'ENT-2025',
  );

  assert.deepEqual(query.values, ['candidate-a', 'ROLL-1001', '2000-01-02', 'ENT-2025']);
  assert.match(query.text, /JOIN applications a/);
  assert.match(query.text, /a\.user_id = \$1/);
  assert.match(query.text, /r\.roll_number = \$2 OR r\.application_number = \$2/);
  assert.match(query.text, /a\.date_of_birth = \$3/);
  assert.match(query.text, /r\.is_published = true/);
});

test('legacy application linking requires an unlinked record, matching identity fields, and verified candidate', () => {
  const query = linkLegacyApplicationQuery({
    applicationId: 'application-id',
    applicationNumber: 'app-1234',
    dateOfBirth: '2000-01-02',
    candidateLoginId: 'candidate-login',
    verifierId: 'official-id',
    verificationMethod: 'identity_document_review',
  });

  assert.match(query.text, /a\.user_id IS NULL/);
  assert.match(query.text, /a\.application_number = \$2/);
  assert.match(query.text, /a\.date_of_birth = \$3/);
  assert.match(query.text, /u\.role = 'candidate'/);
  assert.match(query.text, /u\.account_status = 'approved'/);
  assert.match(query.text, /ownership_verified_at = now\(\)/);
  assert.match(query.text, /ownership_verified_by = \$5/);
  assert.deepEqual(query.values, [
    'application-id',
    'APP-1234',
    '2000-01-02',
    'CANDIDATE-LOGIN',
    'official-id',
    'identity_document_review',
  ]);
});

test('center workspace queries always scope records to one institute', () => {
  const queries = centerWorkspaceQueries('institute-a');

  assert.equal(queries.length, 6);
  for (const query of queries) {
    assert.deepEqual(query.values, ['institute-a']);
    assert.match(query.text, /(?:WHERE id = \$1 AND role = 'center'|WHERE institute_id = \$1)/);
    assert.doesNotMatch(query.text, /institute_id IS NULL|OR institute_id/);
  }
});

test('center check-ins are scoped to authenticated center code', () => {
  const query = centerCheckinsQuery('CENTER-A');

  assert.deepEqual(query.values, ['CENTER-A']);
  assert.match(query.text, /WHERE c\.center_code = \$1/);
});
