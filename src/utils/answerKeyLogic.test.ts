/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  objectionStatusLabel,
  proposedKeyLabel,
  validateObjection,
  filterQuestions,
  SAMPLE_ANSWER_KEYS,
} from './answerKeyLogic.ts';

describe('Answer Key & Objection Logic Tests', () => {
  test('should describe proposed keys and objection outcomes', () => {
    assert.strictEqual(proposedKeyLabel('C'), 'Option C');
    assert.strictEqual(proposedKeyLabel('NONE'), 'None of the options');
    assert.strictEqual(objectionStatusLabel({ status: 'pending', resolution: null }), 'Under review by subject experts');
    assert.strictEqual(objectionStatusLabel({ status: 'accepted', resolution: 'key_changed' }), 'Accepted · key revised');
    assert.strictEqual(objectionStatusLabel({ status: 'accepted', resolution: 'question_dropped' }), 'Accepted · question dropped');
    assert.strictEqual(objectionStatusLabel({ status: 'rejected', resolution: 'key_changed' }), 'Not accepted · key upheld');
  });

  test('should validate objection input requiring meaningful justification and reference', () => {
    const invalidShort = validateObjection({
      questionNumber: 1,
      proposedKey: 'C',
      justification: 'Wrong',
      referenceSource: '',
    });
    assert.strictEqual(invalidShort.isValid, false);
    assert.ok(invalidShort.error?.includes('justification'));

    const valid = validateObjection({
      questionNumber: 1,
      proposedKey: 'C',
      justification: 'According to theorem 4.2 in linear algebra, the solution simplifies to option C.',
      referenceSource: 'Standard Higher Algebra by Hall & Knight, Page 112',
    });
    assert.strictEqual(valid.isValid, true);
  });

  test('should filter questions by subject and query text', () => {
    const mathOnly = filterQuestions(SAMPLE_ANSWER_KEYS, 'Mathematics');
    assert.strictEqual(mathOnly.length, 2);

    const physicsSearch = filterQuestions(SAMPLE_ANSWER_KEYS, 'All', 'refractive');
    assert.strictEqual(physicsSearch.length, 1);
    assert.strictEqual(physicsSearch[0].questionNumber, 4);
  });
});
