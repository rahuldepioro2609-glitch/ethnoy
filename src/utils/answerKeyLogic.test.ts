/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  calculateObjectionFee,
  validateObjection,
  filterQuestions,
  SAMPLE_ANSWER_KEYS,
} from './answerKeyLogic.ts';

describe('Answer Key & Objection Logic Tests', () => {
  test('should calculate correct fee per question', () => {
    assert.strictEqual(calculateObjectionFee(1), 500);
    assert.strictEqual(calculateObjectionFee(3), 1500);
    assert.strictEqual(calculateObjectionFee(0), 0);
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
