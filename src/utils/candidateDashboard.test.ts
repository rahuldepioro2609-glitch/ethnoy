import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDashboardContentState,
  NO_LINKED_APPLICATIONS_MESSAGE,
} from './candidateDashboard.js';

test('dashboard does not render counts or empty states while data is loading or failed', () => {
  assert.equal(getDashboardContentState(true, null), 'loading');
  assert.equal(getDashboardContentState(false, 'API unavailable'), 'error');
  assert.equal(getDashboardContentState(false, null), 'ready');
});

test('no-application guidance explains automatic and legacy account linking', () => {
  assert.match(NO_LINKED_APPLICATIONS_MESSAGE, /New applications submitted while signed in are linked automatically/);
  assert.match(NO_LINKED_APPLICATIONS_MESSAGE, /contact an official to verify ownership and link it to your account/);
  assert.doesNotMatch(NO_LINKED_APPLICATIONS_MESSAGE, /use your application number as your .* login ID/i);
});
