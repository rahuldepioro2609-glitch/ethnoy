/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  lookupScorecard,
  generateDeterministicScorecard,
  formatRankDisplay,
  getCutoffComparison,
  PRESET_SCORECARDS,
} from './resultLogic.ts';

describe('Candidate Result Logic Tests', () => {
  test('should find preset scorecard by roll number', () => {
    const res = lookupScorecard('ENT-2025-9981');
    assert.strictEqual(res.candidateName, 'Aarav Sharma');
    assert.strictEqual(res.allIndiaRank, 142);
    assert.strictEqual(res.qualifyingStatus, 'QUALIFIED');
    assert.strictEqual(res.totalMarksObtained, 274);
  });

  test('should find preset scorecard by application number case-insensitively', () => {
    const res = lookupScorecard('elt2025442088');
    assert.strictEqual(res.candidateName, 'Priya Patel');
    assert.strictEqual(res.allIndiaRank, 58);
  });

  test('should generate deterministic scorecard for unlisted roll numbers without throwing', () => {
    const res1 = lookupScorecard('CUSTOM-ROLL-777');
    const res2 = lookupScorecard('CUSTOM-ROLL-777');
    assert.strictEqual(res1.rollNumber, 'CUSTOM-ROLL-777');
    assert.strictEqual(res1.allIndiaRank, res2.allIndiaRank);
    assert.strictEqual(res1.totalMarksObtained, res2.totalMarksObtained);
    assert.ok(res1.aggregatePercentile > 0);
  });

  test('should calculate cutoff comparison and margins accurately', () => {
    const preset = PRESET_SCORECARDS[0]; // Aarav Sharma, Gen, Marks 274, Gen Cutoff 195
    const comp = getCutoffComparison(preset);
    assert.strictEqual(comp.categoryCutoff, 195);
    assert.strictEqual(comp.margin, 79);
    assert.strictEqual(comp.hasCleared, true);
  });

  test('should format rank display with proper prefix', () => {
    assert.strictEqual(formatRankDisplay(142, 'AIR'), 'AIR #142');
    assert.strictEqual(formatRankDisplay(25, 'Category Rank'), 'Category Rank #25');
  });
});
