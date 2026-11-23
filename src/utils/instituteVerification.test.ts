import assert from 'node:assert/strict';
import test from 'node:test';
import { availableDecisions } from './instituteVerification.ts';

test('offered decisions mirror the server transitions; suspension is independent of verification', () => {
  assert.deepEqual(availableDecisions({ institutionalVerification: 'pending', suspended: false }), ['verify', 'reject', 'suspend']);
  assert.deepEqual(availableDecisions({ institutionalVerification: 'verified', suspended: false }), ['reject', 'suspend']);
  assert.deepEqual(availableDecisions({ institutionalVerification: 'rejected', suspended: true }), ['verify', 'restore']);
});
