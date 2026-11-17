import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isWindowOpen, objectionOutcome, questionStatus } from './objectionRules.ts';

describe('answer-key objection rules', () => {
  const now = new Date('2026-11-17T10:00:00Z');

  test('window is open only when enabled and before the closing time', () => {
    assert.equal(isWindowOpen(undefined, now), false);
    assert.equal(isWindowOpen({ is_open: false, closes_at: null }, now), false);
    assert.equal(isWindowOpen({ is_open: true, closes_at: null }, now), true);
    assert.equal(isWindowOpen({ is_open: true, closes_at: '2026-11-18T00:00:00Z' }, now), true);
    assert.equal(isWindowOpen({ is_open: true, closes_at: '2026-11-17T09:59:59Z' }, now), false);
  });

  test('a key change upholds only objections that proposed the new key', () => {
    assert.equal(objectionOutcome('key_changed', 'C', 'C'), 'accepted');
    assert.equal(objectionOutcome('key_changed', 'D', 'C'), 'rejected');
    assert.equal(objectionOutcome('key_changed', 'NONE', 'C'), 'rejected');
  });

  test('dropping a question upholds every objection; no change rejects all', () => {
    assert.equal(objectionOutcome('question_dropped', 'NONE'), 'accepted');
    assert.equal(objectionOutcome('question_dropped', 'A'), 'accepted');
    assert.equal(objectionOutcome('no_change', 'A'), 'rejected');
  });

  test('question status priority: dropped > revised > challenged > published', () => {
    assert.equal(questionStatus({ is_dropped: true, original_key: 'A', pending_objections: 3 }), 'Question Dropped');
    assert.equal(questionStatus({ original_key: 'A', pending_objections: 3 }), 'Key Revised');
    assert.equal(questionStatus({ pending_objections: 1 }), 'Under Challenge');
    assert.equal(questionStatus({}), 'Key Published');
  });
});
