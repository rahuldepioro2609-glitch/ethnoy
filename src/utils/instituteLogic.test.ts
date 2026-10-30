/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  calculateInstituteOverview,
  filterBiometrics,
  updateBiometricRecordStatus,
  INITIAL_CENTER_PROFILES,
  INITIAL_SLOTS,
  INITIAL_BIOMETRIC_RECORDS,
} from './instituteLogic.ts';

describe('Institute Logic Tests', () => {
  test('should compute correct institute statistics', () => {
    const stats = calculateInstituteOverview(
      INITIAL_CENTER_PROFILES[0],
      INITIAL_SLOTS,
      INITIAL_BIOMETRIC_RECORDS
    );
    assert.strictEqual(stats.verifiedCount, 3);
    assert.strictEqual(stats.flaggedCount, 1);
    assert.strictEqual(stats.pendingCount, 1);
    assert.strictEqual(stats.invigilatorsOnDuty, 4);
  });

  test('should filter biometrics by status and text search', () => {
    const flagged = filterBiometrics(INITIAL_BIOMETRIC_RECORDS, 'FLAGGED');
    assert.strictEqual(flagged.length, 1);
    assert.strictEqual(flagged[0].rollNumber, 'ENT-2025-8812');

    const searchResult = filterBiometrics(INITIAL_BIOMETRIC_RECORDS, 'ALL', 'Priya');
    assert.strictEqual(searchResult.length, 1);
    assert.strictEqual(searchResult[0].candidateName, 'Priya Patel');
  });

  test('should update biometric verification status and adjust credentials', () => {
    const updated = updateBiometricRecordStatus(
      INITIAL_BIOMETRIC_RECORDS,
      'bio-003',
      'Verified & Admitted',
      'A-099'
    );
    const rec = updated.find((r) => r.id === 'bio-003');
    assert.strictEqual(rec?.status, 'Verified & Admitted');
    assert.strictEqual(rec?.seatNumber, 'A-099');
    assert.ok(rec!.fingerprintMatchPercent >= 90);
  });
});
