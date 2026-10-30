import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMockResponses } from './mockScoring.js';

test('scores mock answers on the server and ignores unknown question IDs', () => {
  const score = scoreMockResponses({
    '1': { selectedOptionId: 'B' },
    '2': { selectedOptionId: 'A' },
    '999': { selectedOptionId: 'B' },
  });

  assert.equal(score.totalQuestions, 4);
  assert.equal(score.attempted, 2);
  assert.equal(score.correct, 1);
  assert.equal(score.incorrect, 1);
  assert.equal(score.unattempted, 2);
  assert.equal(score.totalScore, 3);
  assert.equal(score.maxScore, 16);
  assert.equal(score.percentage, 19);
  assert.equal(score.sectionScores.Physics.score, 3);
  assert.equal(score.sectionScores.Chemistry.attempted, 0);
});

test('returns a zero score when all questions are unanswered', () => {
  const score = scoreMockResponses({});

  assert.equal(score.attempted, 0);
  assert.equal(score.totalScore, 0);
  assert.equal(score.unattempted, score.totalQuestions);
  assert.equal(score.percentage, 0);
});
