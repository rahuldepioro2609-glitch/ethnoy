import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentDateInTimeZone,
  getDateOnlyParts,
  isRegistrationOpen,
  isValidTimeZone,
} from './examSchedule.js';

test('validates IANA time zones', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

test("uses the exam timezone rather than the visitor timezone for today's date", () => {
  const now = new Date('2026-10-31T02:00:00.000Z');
  assert.equal(currentDateInTimeZone(now, 'America/Los_Angeles'), '2026-10-30');
  assert.equal(currentDateInTimeZone(now, 'Asia/Kolkata'), '2026-10-31');
  assert.equal(isRegistrationOpen('2026-10-30', '2026-10-30', 'America/Los_Angeles', now), true);
  assert.equal(isRegistrationOpen('2026-10-31', '2026-10-31', 'America/Los_Angeles', now), false);
});

test('formats a calendar date without shifting it across time zones', () => {
  assert.deepEqual(getDateOnlyParts('2026-10-31'), { day: '31', month: 'OCT' });
  assert.equal(getDateOnlyParts('2026-10-31', 'hi-IN').month.length > 0, true);
  assert.throws(() => getDateOnlyParts('2026-02-30'), RangeError);
});
