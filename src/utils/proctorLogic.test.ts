/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  calculateCandidateTrustScore,
  issueWarningToCandidate,
  updateCandidateStatus,
  resolveProctorIncident,
  INITIAL_PROCTORED_CANDIDATES,
  INITIAL_INCIDENTS,
} from './proctorLogic.ts';

describe('AI Proctor Logic Tests', () => {
  test('should reduce trust score for multiple faces and tab switches', () => {
    const score = calculateCandidateTrustScore({
      faceStatus: 'Multiple Faces',
      tabSwitchCount: 2,
      audioAnomaly: true,
    });
    // 100 - 30 - 16 - 15 = 39
    assert.strictEqual(score, 39);
  });

  test('should append warning and elevate flag status when warnings accumulate', () => {
    const updated = issueWarningToCandidate(
      INITIAL_PROCTORED_CANDIDATES,
      'cand-01',
      'Please look at the center of your screen'
    );
    const cand = updated.find((c) => c.id === 'cand-01');
    assert.strictEqual(cand?.warningsIssued.length, 1);
    assert.strictEqual(cand?.flagStatus, 'WARNING');
  });

  test('should update candidate exam status to Paused or Terminated', () => {
    const paused = updateCandidateStatus(INITIAL_PROCTORED_CANDIDATES, 'cand-03', 'Paused');
    assert.strictEqual(paused.find((c) => c.id === 'cand-03')?.examStatus, 'Paused');

    const terminated = updateCandidateStatus(INITIAL_PROCTORED_CANDIDATES, 'cand-03', 'Terminated');
    assert.strictEqual(terminated.find((c) => c.id === 'cand-03')?.examStatus, 'Terminated');
    assert.strictEqual(terminated.find((c) => c.id === 'cand-03')?.flagStatus, 'CRITICAL');
  });

  test('should mark incident as resolved with action taken notes', () => {
    const resolvedList = resolveProctorIncident(
      INITIAL_INCIDENTS,
      'inc-101',
      'Candidate issued final warning. Physical invigilator inspected Desk B-08.'
    );
    const inc = resolvedList.find((i) => i.id === 'inc-101');
    assert.strictEqual(inc?.resolved, true);
    assert.strictEqual(inc?.actionTaken, 'Candidate issued final warning. Physical invigilator inspected Desk B-08.');
  });
});
