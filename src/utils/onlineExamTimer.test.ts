import assert from 'node:assert/strict';
import test from 'node:test';
import { displaySeconds, formatCountdown, remainingMs, ServerClock, timeWarning } from './onlineExamTimer.js';

test('server clock: maps the monotonic clock onto server time using the request midpoint', () => {
  let mono = 1_000;
  const clock = new ServerClock(() => mono);
  assert.equal(clock.now(), null);
  // Request sent at mono 1000, answered at 1200; server stamped 5_000_100 (ms resolution).
  assert.equal(clock.recordTimestamp(new Date(5_000_100).toISOString(), 1_000, 1_200), true);
  // Millisecond timestamps are centred within their millisecond (+0.5 ms), like the Date header within its second.
  mono = 1_200;
  assert.equal(clock.now(), 5_000_200.5);
  mono = 61_200;
  assert.equal(clock.now(), 5_060_200.5, 'advances with the monotonic clock only');
});

test('server clock: the HTTP Date header (1 s resolution) is centred within its second', () => {
  let mono = 0;
  const clock = new ServerClock(() => mono);
  clock.recordDateHeader('Sat, 15 Mar 2031 09:00:00 GMT', 0, 0);
  assert.equal(clock.now(), Date.parse('2031-03-15T09:00:00.500Z'));
  mono = 2_000;
  assert.equal(clock.now(), Date.parse('2031-03-15T09:00:02.500Z'));
  assert.equal(clock.recordDateHeader(null, 0, 0), false);
  assert.equal(clock.recordDateHeader('not a date', 0, 0), false);
});

test('server clock: keeps the most precise sample, but accepts a clearly different one (sleep) or after markStale', () => {
  let mono = 0;
  const clock = new ServerClock(() => mono);
  clock.recordTimestamp(new Date(1_000_000).toISOString(), 0, 10); // ±5 ms
  const precise = clock.now();
  // A noisy sample (±1 s) that roughly agrees is ignored.
  assert.equal(clock.recordTimestamp(new Date(1_000_300).toISOString(), 0, 2_000), false);
  assert.equal(clock.now(), precise);
  // After the device slept 10 minutes the monotonic clock is behind: a new sample disagrees and wins.
  mono = 100;
  assert.equal(clock.recordTimestamp(new Date(1_600_100).toISOString(), 100, 110), true);
  assert.ok(Math.abs((clock.now() ?? 0) - 1_600_100) < 10);
  // markStale lets the next sample replace the estimate even if it is less precise.
  clock.markStale();
  assert.equal(clock.recordTimestamp(new Date(1_600_200).toISOString(), 100, 900), true);
});

test('server clock: never reads the browser wall clock', () => {
  const realNow = Date.now;
  try {
    Date.now = () => { throw new Error('Date.now must not be used'); };
    let mono = 0;
    const clock = new ServerClock(() => mono);
    clock.recordTimestamp('2031-03-15T09:00:00.000Z', 0, 0);
    mono = 5_000;
    assert.equal(remainingMs('2031-03-15T09:01:00.000Z', clock), 54_999.5, '(timestamp centred within its millisecond)');
  } finally {
    Date.now = realNow;
  }
});

test('countdown display, warnings and formatting', () => {
  assert.equal(displaySeconds(null), null);
  assert.equal(displaySeconds(0), 0);
  assert.equal(displaySeconds(-5_000), 0);
  assert.equal(displaySeconds(1), 1, 'rounds up: 00:00 only at true zero');
  assert.equal(displaySeconds(59_001), 60);
  assert.deepEqual([timeWarning(null), timeWarning(301), timeWarning(300), timeWarning(61), timeWarning(60), timeWarning(0)],
    ['none', 'none', 'low', 'low', 'critical', 'expired']);
  assert.equal(formatCountdown(null), '--:--');
  assert.equal(formatCountdown(65), '01:05');
  assert.equal(formatCountdown(7_200), '120:00', 'minutes may exceed 59, as before');
});
