import assert from 'node:assert/strict';
import test from 'node:test';
import { describeOnlineExamAttempt, formatStoredScore } from './onlineExamDashboard.js';

const NOW = Date.parse('2031-03-15T09:00:00Z');
const SCORE = { totalQuestions: 3, attempted: 2, correct: 2, totalScore: 6, maxScore: 10, percentage: 60, sectionScores: {} };

test('17. dashboard: each of the five server states is described honestly', () => {
  const scored = describeOnlineExamAttempt({ state: 'scored', submitted_at: '2031-03-15T08:00:00Z', score: SCORE }, NOW);
  assert.deepEqual(scored, { statusText: 'Attempt completed. Score: 6 / 10', tone: 'success', canOpen: false, buttonLabel: 'Attempt used' });

  const inProgress = describeOnlineExamAttempt({ state: 'in_progress', submitted_at: null, score: null }, NOW);
  assert.equal(inProgress.canOpen, true);
  assert.equal(inProgress.buttonLabel, 'Resume exam');

  const finalWindow = describeOnlineExamAttempt({ state: 'final_submit_window', submitted_at: null, score: null }, NOW);
  assert.equal(finalWindow.canOpen, false, 'no resume once time is up');
  assert.match(finalWindow.statusText ?? '', /final submission is being processed/);

  const pending = describeOnlineExamAttempt({ state: 'expired_pending_scoring', submitted_at: null, score: null }, NOW);
  assert.equal(pending.canOpen, false);
  assert.equal(pending.tone, 'warning');
  assert.match(pending.statusText ?? '', /will be scored automatically/);
  assert.doesNotMatch(pending.statusText ?? '', /completed|Score:/, 'pending recovery is never shown as scored');

  const unscored = describeOnlineExamAttempt({ state: 'expired_unscored', submitted_at: null, score: null }, NOW);
  assert.equal(unscored.canOpen, false, 'no resume action');
  assert.equal(unscored.buttonLabel, 'Attempt used');
  assert.match(unscored.statusText ?? '', /not scored automatically/);
});

test('17b. dashboard: no attempt → Start exam (unchanged)', () => {
  assert.deepEqual(describeOnlineExamAttempt(null, NOW), { statusText: null, tone: 'neutral', canOpen: true, buttonLabel: 'Start exam' });
});

test('17c. dashboard: without a state field the previous behaviour is kept exactly', () => {
  const future = new Date(NOW + 60_000).toISOString();
  const past = new Date(NOW - 60_000).toISOString();
  assert.deepEqual(describeOnlineExamAttempt({ submitted_at: null, expires_at: future }, NOW), { statusText: null, tone: 'neutral', canOpen: true, buttonLabel: 'Resume exam' });
  assert.deepEqual(describeOnlineExamAttempt({ submitted_at: null, expires_at: past }, NOW), { statusText: 'Attempt expired.', tone: 'warning', canOpen: false, buttonLabel: 'Attempt used' });
  assert.equal(describeOnlineExamAttempt({ submitted_at: past, expires_at: past, score: SCORE }, NOW).statusText, 'Attempt completed. Score: 6');
  assert.equal(describeOnlineExamAttempt({ submitted_at: past, expires_at: past, score: null }, NOW).statusText, 'Attempt completed. Score: Submitted');
  assert.equal(describeOnlineExamAttempt({ state: 'something_new', submitted_at: null, expires_at: past }, NOW).statusText, 'Attempt expired.', 'unknown state falls back');
});

test('17d. stored score formatting', () => {
  assert.equal(formatStoredScore(SCORE), 'Score: 6 / 10');
  assert.equal(formatStoredScore({ totalScore: 0, maxScore: 5 }), 'Score: 0 / 5');
  assert.equal(formatStoredScore({ totalScore: 4 }), 'Score: 4');
  assert.equal(formatStoredScore(null), 'Submitted');
  assert.equal(formatStoredScore({}), 'Submitted');
});
