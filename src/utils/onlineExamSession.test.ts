// Tests for the online exam session controller (P0-4 Phase 6). No browser, network or database:
// a fake monotonic clock and fake timers drive time, the "server" clock is deliberately far from
// the real date, and the transport is scripted per test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type OnlineExamOption, type OnlineExamStartData } from '../api.js';
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_RETRY_MS,
  classifySubmitFailure,
  type ExamSessionState,
  type ExamTransport,
  MESSAGES,
  OnlineExamSession,
  SUBMIT_MAX_ATTEMPTS,
  type TimerFunctions,
} from './onlineExamSession.js';

// ---------------------------------------------------------------------------
// Fake environment
// ---------------------------------------------------------------------------

async function flush() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

class FakeEnv {
  mono = 10_000;
  /** Server epoch ms at mono = 0. Far from the real date on purpose (year 2031). */
  serverBaseMs = Date.parse('2031-03-15T09:00:00.500Z') - 10_000;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;

  readonly timers: TimerFunctions = {
    setTimeout: (callback, ms) => {
      const id = this.nextId++;
      this.pending.set(id, { at: this.mono + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout: (handle) => {
      this.pending.delete(handle as number);
    },
  };

  readonly monotonicNow = () => this.mono;
  serverNow() {
    return this.serverBaseMs + this.mono;
  }

  pendingCount() {
    return this.pending.size;
  }

  async advance(ms: number) {
    const target = this.mono + ms;
    for (;;) {
      await flush();
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([idA, a], [idB, b]) => a.at - b.at || idA - idB)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.mono = due[1].at;
      due[1].callback();
    }
    this.mono = target;
    await flush();
  }
}

const httpDate = (ms: number) => new Date(ms).toUTCString();
const iso = (ms: number) => new Date(ms).toISOString();
const ATTEMPT_ID = '8d0f6a2e-6f7d-4a43-9a7e-2a1f3c5b7d90';
const QUESTIONS: OnlineExamStartData['questions'] = [1, 2, 3].map((n) => ({
  questionNumber: n,
  section: 'S',
  questionText: `Q${n}`,
  options: { A: 'a', B: 'b', C: 'c', D: 'd' },
  points: 1,
}));
const SCORE = { totalQuestions: 3, attempted: 2, correct: 2, incorrect: 0, unattempted: 1, totalScore: 2, maxScore: 3, percentage: 67, sectionScores: {} };

type Answers = Record<string, OnlineExamOption>;
type Handler<T> = (env: FakeEnv) => Promise<T> | T;

interface TransportOptions {
  expiresInMs?: number;
  saved?: Answers;
  startError?: unknown;
  noDateHeader?: boolean;
  save?: Handler<unknown>;
  submit?: Array<Handler<unknown>>;
  submitDefault?: Handler<unknown>;
  list?: Handler<unknown>;
}

const ok = (env: FakeEnv, data: unknown, noDate = false) => ({ data, status: 200, serverDate: noDate ? null : httpDate(env.serverNow()) });
const networkError = () => { throw new TypeError('Failed to fetch'); };
const apiError = (status: number, message: string, code?: string) => () => { throw new ApiError(message, status, code); };
const success = (env: FakeEnv, extra: Record<string, unknown> = {}) => ok(env, { submittedAt: iso(env.serverNow()), score: { ...SCORE }, alreadyScored: false, ...extra });

function createSession(options: TransportOptions = {}) {
  const env = new FakeEnv();
  const expiresAtMs = env.serverNow() + (options.expiresInMs ?? 10 * 60_000);
  const calls = { start: 0, save: [] as Answers[], submit: [] as Answers[], list: 0, saveTimes: [] as number[], submitTimes: [] as number[] };
  const transport = {
    async start() {
      calls.start += 1;
      if (options.startError) throw options.startError;
      return {
        data: { attempt: { id: ATTEMPT_ID, expires_at: iso(expiresAtMs) }, questions: QUESTIONS, responses: { ...(options.saved ?? {}) } },
        status: 201,
        serverDate: options.noDateHeader ? null : httpDate(env.serverNow()),
      };
    },
    async saveAnswers(_code: string, _id: string, answers: Answers) {
      calls.save.push({ ...answers });
      calls.saveTimes.push(env.serverNow());
      if (options.save) return options.save(env);
      if (env.serverNow() >= expiresAtMs) throw new ApiError('Time is up for this exam.', 409, 'answering_closed');
      return ok(env, { saved: true, savedAt: iso(env.serverNow()) }, options.noDateHeader);
    },
    async submitAnswers(_code: string, _id: string, answers: Answers) {
      calls.submit.push({ ...answers });
      calls.submitTimes.push(env.mono);
      const handler = options.submit?.[calls.submit.length - 1] ?? options.submitDefault ?? success;
      return handler(env);
    },
    async listExams() {
      calls.list += 1;
      if (options.list) return options.list(env);
      return ok(env, { exams: [] });
    },
  } as unknown as ExamTransport;
  const states: ExamSessionState[] = [];
  const session = new OnlineExamSession({
    examCode: 'EXAM1',
    transport,
    monotonicNow: env.monotonicNow,
    timers: env.timers,
    onChange: (state) => { states.push(state); },
  });
  return { env, session, calls, states, expiresAtMs };
}

async function loaded(options: TransportOptions = {}) {
  const harness = createSession(options);
  await harness.session.load();
  await flush();
  return harness;
}

// ---------------------------------------------------------------------------
// 1–2, 16: server time, not the browser clock
// ---------------------------------------------------------------------------

test('1. countdown follows the server clock (server is years away from the browser clock)', async () => {
  const { session, env } = await loaded({ expiresInMs: 10 * 60_000 });
  assert.equal(session.getState().clockSynchronized, true);
  assert.equal(session.getState().remainingSeconds, 600);
  await env.advance(61_000);
  assert.equal(session.getState().remainingSeconds, 539);
});

test('2. changing the browser wall clock never extends (or shortens) the exam', async () => {
  const { session, env } = await loaded({ expiresInMs: 120_000 });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() - 24 * 3600_000; // clock moved back a day
    await env.advance(30_000);
    assert.equal(session.getState().remainingSeconds, 90);
    Date.now = () => realNow() + 24 * 3600_000; // clock moved forward a day
    await env.advance(30_000);
    assert.equal(session.getState().remainingSeconds, 60);
    assert.equal(session.getState().timeExpired, false);
  } finally {
    Date.now = realNow;
  }
});

test('16a. a refresh resumes the same attempt: the countdown continues from the server expiry, not from the start', async () => {
  const first = await loaded({ expiresInMs: 300_000 });
  await first.env.advance(120_000);
  assert.equal(first.session.getState().remainingSeconds, 180);
  first.session.dispose();
  // "Refresh": a new session; the start route returns the same attempt and expires_at.
  const env = first.env;
  const session = new OnlineExamSession({
    examCode: 'EXAM1',
    monotonicNow: env.monotonicNow,
    timers: env.timers,
    transport: {
      start: async () => ({ data: { attempt: { id: ATTEMPT_ID, expires_at: iso(first.expiresAtMs) }, questions: QUESTIONS, responses: { 1: 'A' } }, status: 200, serverDate: httpDate(env.serverNow()) }),
      saveAnswers: async () => { throw new Error('unused'); },
      submitAnswers: async () => { throw new Error('unused'); },
      listExams: async () => { throw new Error('unused'); },
    } as unknown as ExamTransport,
  });
  await session.load();
  assert.equal(session.getState().remainingSeconds, 180, 'not reset to the full duration');
  assert.deepEqual(session.getState().answers, { 1: 'A' }, 'saved answers restored');
  session.dispose();
});

test('16b. after a sleep or hidden tab, resync() corrects the countdown from server time and expires if due', async () => {
  const { session, env, calls } = await loaded({
    expiresInMs: 300_000,
    list: (e) => ok(e, { exams: [] }),
  });
  assert.equal(session.getState().remainingSeconds, 300);
  // The device sleeps 10 minutes: server time moves on, the monotonic clock does not.
  env.serverBaseMs += 600_000;
  await env.advance(1_000);
  assert.equal(session.getState().remainingSeconds, 299, 'before resync the paused clock is stale');
  await session.resync();
  await flush();
  assert.equal(calls.list, 1, 'one read-only request');
  assert.equal(session.getState().timeExpired, true, 'expired by server time');
  assert.equal(session.getState().locked, true);
  assert.equal(calls.submit.length, 1);
});

test('16c. a refresh after expiry does not reopen the exam (the start route refuses it)', async () => {
  const { session, calls } = await loaded({ startError: new ApiError('An attempt has already been completed or expired for this exam.', 409) });
  assert.equal(session.getState().loadState, 'failed');
  assert.equal(session.getState().loadError, 'An attempt has already been completed or expired for this exam.');
  assert.equal(session.selectAnswer(1, 'A'), false);
  assert.equal(session.submit(), false);
  assert.equal(calls.submit.length, 0);
});

// ---------------------------------------------------------------------------
// 3–7: expiry, locking, autosave cancellation, single submission
// ---------------------------------------------------------------------------

test('3. at zero the answers lock and further changes are refused', async () => {
  const { session, env } = await loaded({ expiresInMs: 5_000 });
  assert.equal(session.selectAnswer(1, 'A'), true);
  await env.advance(5_000);
  const state = session.getState();
  assert.equal(state.timeExpired, true);
  assert.equal(state.locked, true);
  assert.equal(state.remainingSeconds, 0);
  assert.equal(state.warning, 'expired');
  assert.equal(session.selectAnswer(2, 'B'), false);
  assert.deepEqual(session.getState().answers, { 1: 'A' });
});

test('4. a pending autosave is cancelled at expiry; the change is carried by the final submission', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 10_000 });
  await env.advance(9_800);
  session.selectAnswer(3, 'C'); // debounce would fire at +500 ms, after expiry
  await env.advance(1_000);
  assert.equal(calls.save.length, 0, 'no autosave sent');
  assert.deepEqual(calls.submit, [{ 3: 'C' }], 'the final submission includes the change');
});

test('5. no autosave request is ever sent after expiry', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 3_000 });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(calls.save.length, 1);
  await env.advance(3_000);
  session.selectAnswer(2, 'B');
  await env.advance(120_000);
  assert.equal(calls.save.length, 1);
  assert.ok(calls.saveTimes.every((at) => at < Date.parse(session.getState().expiresAt ?? '')), 'every save before expires_at');
});

test('6. the final in-memory answers are captured once and submitted exactly once', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 4_000, saved: { 1: 'D' } });
  session.selectAnswer(1, 'A');
  session.selectAnswer(2, 'B');
  await env.advance(4_000);
  assert.deepEqual(calls.submit, [{ 1: 'A', 2: 'B' }]);
  assert.deepEqual(session.getSubmittedAnswers(), { 1: 'A', 2: 'B' });
  assert.equal(session.getState().phase, 'submitted');
});

test('7. repeated timer callbacks, ticks and submit clicks never duplicate the submission', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 2_000 });
  await env.advance(2_000);
  for (let index = 0; index < 20; index += 1) session.tick();
  assert.equal(session.submit(), false, 'submit after automatic submission is refused');
  await env.advance(60_000);
  assert.equal(calls.submit.length, 1);
  assert.equal(env.pendingCount(), 0, 'no timer left running');
});

test('7b. the countdown makes no network request while it runs', async () => {
  const { env, calls } = await loaded({ expiresInMs: 120_000 });
  await env.advance(119_000);
  assert.deepEqual([calls.save.length, calls.submit.length, calls.list], [0, 0, 0]);
});

// ---------------------------------------------------------------------------
// 8–15: retries and honest outcomes
// ---------------------------------------------------------------------------

test('8. network failures retry a bounded number of times (4 attempts: +1 s, +2 s, +4 s), then stop', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 1_000, submitDefault: networkError });
  session.selectAnswer(1, 'A');
  await env.advance(1_000);
  await env.advance(120_000);
  assert.equal(calls.submit.length, SUBMIT_MAX_ATTEMPTS);
  const gaps = calls.submitTimes.slice(1).map((at, index) => at - calls.submitTimes[index]);
  assert.deepEqual(gaps, [1_000, 2_000, 4_000]);
  assert.ok(calls.submit.every((answers) => answers[1] === 'A'), 'same captured answers each time');
  assert.equal(session.getState().phase, 'submit_unconfirmed');
  assert.equal(session.getState().message, MESSAGES.unconfirmed);
});

test('9. HTTP 503 (busy) is retried; a later 200 is confirmed; 503 throughout ends unconfirmed', async () => {
  const busy = apiError(503, 'The exam service is busy.', 'busy');
  const first = await loaded({ expiresInMs: 1_000, submit: [busy, busy, success] });
  await first.env.advance(1_000);
  await first.env.advance(10_000);
  assert.equal(first.calls.submit.length, 3);
  assert.equal(first.session.getState().phase, 'submitted');

  const second = await loaded({ expiresInMs: 1_000, submitDefault: busy });
  await second.env.advance(1_000);
  await second.env.advance(60_000);
  assert.equal(second.calls.submit.length, SUBMIT_MAX_ATTEMPTS);
  assert.equal(second.session.getState().phase, 'submit_unconfirmed');
  for (const status of [502, 504]) assert.equal(classifySubmitFailure(new ApiError('x', status)), 'retry');
});

for (const [label, status, code] of [
  ['10. HTTP 400', 400, 'invalid_responses'],
  ['11a. HTTP 401', 401, undefined],
  ['11b. HTTP 403', 403, undefined],
  ['12. HTTP 404', 404, 'attempt_not_found'],
] as const) {
  test(`${label} is not retried and is never shown as submitted`, async () => {
    const message = `server says ${status}`;
    const { session, env, calls } = await loaded({ expiresInMs: 1_000, submitDefault: apiError(status, message, code) });
    await env.advance(1_000);
    await env.advance(60_000);
    assert.equal(calls.submit.length, 1);
    assert.equal(session.getState().phase, 'submit_rejected');
    assert.equal(session.getState().score, null);
    assert.equal(session.getState().message, message);
  });
}

test('13. HTTP 409 is never reported as success (expired_unscored and other conflicts)', async () => {
  const expired = await loaded({ expiresInMs: 1_000, submitDefault: apiError(409, 'This exam attempt has expired and was not scored automatically.', 'expired_unscored') });
  await expired.env.advance(61_000);
  assert.equal(expired.calls.submit.length, 1);
  assert.equal(expired.session.getState().phase, 'expired_unscored');
  assert.equal(expired.session.getState().score, null);

  const conflict = await loaded({ expiresInMs: 1_000, submitDefault: apiError(409, 'Conflict.') });
  await conflict.env.advance(61_000);
  assert.equal(conflict.calls.submit.length, 1);
  assert.equal(conflict.session.getState().phase, 'submit_rejected');
});

test('13b. HTTP 500 is not retried and is reported as unconfirmed, not as success', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 1_000, submitDefault: apiError(500, 'An unexpected server error occurred.') });
  await env.advance(61_000);
  assert.equal(calls.submit.length, 1);
  assert.equal(session.getState().phase, 'submit_unconfirmed');
});

test('14. a confirmed HTTP 200 shows success with the score; "submitted" is never shown before it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { session, env, states } = await loaded({
    expiresInMs: 60_000,
    submit: [async (e) => { await gate; return success(e); }],
  });
  session.selectAnswer(1, 'A');
  assert.equal(session.submit(), true);
  await env.advance(100);
  assert.equal(session.getState().phase, 'submitting');
  assert.equal(session.getState().locked, true, 'answers locked once submit is clicked');
  assert.equal(states.some((state) => state.phase === 'submitted'), false, 'not submitted while in flight');
  release();
  await flush();
  assert.equal(session.getState().phase, 'submitted');
  assert.deepEqual(session.getState().score, SCORE);
  assert.equal(session.getState().message, MESSAGES.submitted);
});

test('14b. idempotent and saved-answer outcomes are described honestly', async () => {
  const repeat = await loaded({ expiresInMs: 1_000, submitDefault: (e) => success(e, { alreadyScored: true }) });
  await repeat.env.advance(1_000);
  assert.equal(repeat.session.getState().message, MESSAGES.alreadyScored);
  const late = await loaded({
    expiresInMs: 1_000,
    submitDefault: (e) => ok(e, { submittedAt: iso(e.serverNow()), score: { ...SCORE, completion: { reason: 'expired_saved_answers' } }, alreadyScored: false }),
  });
  await late.env.advance(1_000);
  assert.equal(late.session.getState().message, MESSAGES.savedAnswersScored);
  const incomplete = await loaded({ expiresInMs: 1_000, submitDefault: (e) => ok(e, { submittedAt: null }) });
  await incomplete.env.advance(1_000);
  assert.equal(incomplete.session.getState().phase, 'submit_unconfirmed', 'a 200 without a score is not treated as success');
});

test('15. exhausted retries show an honest uncertain state; Check status reports the real outcome', async () => {
  const outcomes: Array<[string, Record<string, unknown> | null, string, string]> = [
    ['scored', { state: 'scored', submitted_at: '2031-03-15T09:00:01Z', score: { ...SCORE } }, 'submitted', MESSAGES.alreadyScored],
    ['pending', { state: 'expired_pending_scoring', submitted_at: null, score: null }, 'awaiting_recovery', MESSAGES.awaitingRecovery],
    ['grace', { state: 'final_submit_window', submitted_at: null, score: null }, 'awaiting_recovery', MESSAGES.awaitingRecovery],
    ['unscored', { state: 'expired_unscored', submitted_at: null, score: null }, 'expired_unscored', MESSAGES.expiredUnscored],
    ['open', { state: 'in_progress', submitted_at: null, score: null }, 'submit_unconfirmed', MESSAGES.stillOpen],
    ['unknown', null, 'submit_unconfirmed', MESSAGES.statusUnknown],
  ];
  for (const [label, attempt, phase, message] of outcomes) {
    const { session, env, calls } = await loaded({
      expiresInMs: 1_000,
      submitDefault: networkError,
      list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt }] }),
    });
    await env.advance(61_000);
    assert.equal(session.getState().phase, 'submit_unconfirmed', label);
    await session.checkStatus();
    assert.equal(session.getState().phase, phase, label);
    assert.equal(session.getState().message, message, label);
    assert.equal(calls.submit.length, SUBMIT_MAX_ATTEMPTS, `${label}: checking status never submits`);
  }
});

test('15b. Retry submission is candidate-triggered, re-sends the same answers, and is bounded again', async () => {
  const { session, env, calls } = await loaded({
    expiresInMs: 1_000,
    submit: [networkError, networkError, networkError, networkError, success],
  });
  session.selectAnswer(2, 'B');
  await env.advance(61_000);
  assert.equal(calls.submit.length, 4);
  assert.equal(session.retrySubmission(), true);
  assert.equal(session.retrySubmission(), false, 'a second click while in flight does nothing');
  await env.advance(1_000);
  assert.equal(session.getState().phase, 'submitted');
  assert.equal(calls.submit.length, 5);
  assert.ok(calls.submit.every((answers) => JSON.stringify(answers) === JSON.stringify({ 2: 'B' })));
  assert.equal(session.retrySubmission(), false, 'not available after success');
});

test('15c. answers stay locked while a retry is pending', async () => {
  const { session, env } = await loaded({ expiresInMs: 60_000, submit: [networkError, success] });
  session.selectAnswer(1, 'A');
  session.submit();
  await env.advance(100);
  assert.equal(session.getState().phase, 'retrying');
  assert.equal(session.selectAnswer(1, 'B'), false);
  await env.advance(1_000);
  assert.equal(session.getState().phase, 'submitted');
  assert.deepEqual(session.getSubmittedAnswers(), { 1: 'A' });
});

// ---------------------------------------------------------------------------
// 18: answering and autosave
// ---------------------------------------------------------------------------

test('18a. selecting answers updates state; rapid changes are debounced into one save; saved time shown', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 600_000 });
  assert.equal(session.selectAnswer(1, 'A'), true);
  assert.equal(session.getState().saveStatus, 'unsaved');
  await env.advance(200);
  session.selectAnswer(2, 'B');
  await env.advance(200);
  session.selectAnswer(1, 'C');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.deepEqual(calls.save, [{ 1: 'C', 2: 'B' }]);
  assert.equal(session.getState().saveStatus, 'saved');
  assert.ok(session.getState().lastSavedAt?.startsWith('2031-03-15T09:'), 'server savedAt shown');
});

test('18b. a change made while a save is in flight is saved afterwards; an older response never marks newer answers saved', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let saves = 0;
  const { session, env, calls } = await loaded({
    expiresInMs: 600_000,
    save: async (e) => {
      saves += 1;
      if (saves === 1) await gate;
      return ok(e, { saved: true, savedAt: iso(e.serverNow()) });
    },
  });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  session.selectAnswer(2, 'B');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(calls.save.length, 1, 'one request at a time');
  release();
  await flush();
  assert.notEqual(session.getState().saveStatus, 'saved', 'the older response does not cover the newer change');
  await env.advance(10);
  assert.deepEqual(calls.save[1], { 1: 'A', 2: 'B' });
  assert.equal(session.getState().saveStatus, 'saved');
});

test('18c. a failed save is shown honestly and retried automatically before expiry', async () => {
  let fail = true;
  const { session, env, calls } = await loaded({
    expiresInMs: 600_000,
    save: (e) => {
      if (fail) throw new TypeError('Failed to fetch');
      return ok(e, { saved: true, savedAt: iso(e.serverNow()) });
    },
  });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(session.getState().saveStatus, 'save_failed');
  assert.equal(session.getState().saveMessage, MESSAGES.saveFailed);
  fail = false;
  await env.advance(AUTOSAVE_RETRY_MS);
  assert.equal(calls.save.length, 2);
  assert.equal(session.getState().saveStatus, 'saved');
});

test('18d. a late save response after the final submission changes nothing', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { session, env } = await loaded({
    expiresInMs: 600_000,
    save: async (e) => { await gate; return ok(e, { saved: true, savedAt: iso(e.serverNow()) }); },
  });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  session.submit();
  await env.advance(10);
  assert.equal(session.getState().phase, 'submitted');
  const before = session.getState();
  release();
  await flush();
  assert.equal(session.getState().saveStatus, before.saveStatus);
  assert.equal(session.getState().phase, 'submitted');
});

test('18e. if the server reports that answering has closed, the screen locks and submits once', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 600_000, save: () => { throw new ApiError('Time is up for this exam.', 409, 'answering_closed'); } });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(session.getState().timeExpired, true);
  assert.equal(session.getState().locked, true);
  assert.deepEqual(calls.submit, [{ 1: 'A' }]);
});

test('18f. an autosave rejected as already finalized locks the screen and checks the real status', async () => {
  const { session, env, calls } = await loaded({
    expiresInMs: 600_000,
    save: () => { throw new ApiError('This exam has already been submitted.', 409, 'finalized'); },
    list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt: { state: 'scored', submitted_at: '2031-03-15T09:00:00Z', score: { ...SCORE } } }] }),
  });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(session.getState().locked, true);
  assert.equal(calls.list, 1);
  assert.equal(session.getState().phase, 'submitted');
  assert.equal(calls.submit.length, 0, 'no submission sent');
});

test('18g. low-time warnings: 5 minutes, then 1 minute', async () => {
  const { session, env } = await loaded({ expiresInMs: 6 * 60_000 });
  assert.equal(session.getState().warning, 'none');
  await env.advance(61_000);
  assert.equal(session.getState().warning, 'low');
  await env.advance(4 * 60_000);
  assert.equal(session.getState().warning, 'critical');
});

test('18h. without a server Date header the timer shows unsynchronized and the server still enforces expiry', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 2_000, noDateHeader: true });
  assert.equal(session.getState().clockSynchronized, false);
  assert.equal(session.getState().remainingSeconds, null);
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(session.getState().saveStatus, 'saved', 'saving still works');
  await env.advance(5_000);
  session.selectAnswer(2, 'B');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(session.getState().timeExpired, true, 'expired when the server refused the save');
  assert.equal(calls.submit.length, 1);
});

test('dispose stops every timer and pending retry', async () => {
  const { session, env, calls } = await loaded({ expiresInMs: 1_000, submitDefault: networkError });
  await env.advance(1_000);
  assert.equal(calls.submit.length, 1);
  session.dispose();
  await env.advance(60_000);
  assert.equal(calls.submit.length, 1);
  assert.equal(env.pendingCount(), 0);
});

// ---------------------------------------------------------------------------
// Final race fixes: N1 (late autosave after a confirmed submission) and N2(c) (wording)
// ---------------------------------------------------------------------------

const withCompletion = (reason: string, finalizedBy = 'candidate') => ({ ...SCORE, completion: { version: 1, reason, finalizedBy } });

/** A save that stays in flight until released, then fails with the given error. */
function gatedSaveFailure(error: ApiError) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { release, save: async () => { await gate; throw error; } };
}

test('N1. a late 409 finalized autosave response never changes a confirmed submission or triggers a status request', async () => {
  const late = gatedSaveFailure(new ApiError('This exam has already been submitted.', 409, 'finalized'));
  const { session, env, calls, states } = await loaded({ expiresInMs: 600_000, save: late.save });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS); // autosave now in flight
  assert.equal(calls.save.length, 1);
  // 1. The candidate's submission receives a confirmed 200.
  assert.equal(session.submit(), true);
  await env.advance(10);
  const confirmed = session.getState();
  assert.equal(confirmed.phase, 'submitted');
  assert.equal(confirmed.message, MESSAGES.submitted);
  assert.equal(confirmed.alreadyScored, false);
  const stateCountBefore = states.length;
  // 2. The pending autosave then returns 409 finalized.
  late.release();
  await env.advance(10);
  // 3. The confirmed success is unchanged. 4. No status request.
  assert.equal(states.length, stateCountBefore, 'no state change at all');
  assert.equal(session.getState().phase, 'submitted');
  assert.equal(session.getState().message, MESSAGES.submitted);
  assert.equal(session.getState().alreadyScored, false);
  assert.deepEqual(session.getState().score, SCORE);
  assert.equal(calls.list, 0, 'no status request');
  assert.equal(calls.submit.length, 1);
});

test('N1b. a late 409 answering_closed autosave response after a confirmed early submission changes nothing', async () => {
  const late = gatedSaveFailure(new ApiError('Time is up for this exam.', 409, 'answering_closed'));
  const { session, env, calls, states } = await loaded({ expiresInMs: 600_000, save: late.save });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  session.submit();
  await env.advance(10);
  const stateCountBefore = states.length;
  late.release();
  await env.advance(10);
  assert.equal(states.length, stateCountBefore);
  assert.equal(session.getState().timeExpired, false, 'no expiry triggered by the late response');
  assert.equal(session.getState().message, MESSAGES.submitted);
  assert.deepEqual([calls.submit.length, calls.list], [1, 0]);
});

test('N1c. before confirmation, a 409 finalized autosave still checks the real status (unchanged)', async () => {
  const { session, env, calls } = await loaded({
    expiresInMs: 600_000,
    save: () => { throw new ApiError('This exam has already been submitted.', 409, 'finalized'); },
    list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt: { state: 'scored', submitted_at: '2031-03-15T09:00:00Z', score: withCompletion('candidate_submit') } }] }),
  });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  assert.equal(calls.list, 1, 'legitimate status request');
  assert.equal(session.getState().phase, 'submitted');
  assert.equal(session.getState().message, MESSAGES.alreadyScored, 'no request of this session was sent: pre-existing');
  assert.equal(session.getState().alreadyScored, true);
});

test('N1d. a status confirmation during a retry wait stops the retry loop; the confirmed state is not overwritten', async () => {
  const late = gatedSaveFailure(new ApiError('This exam has already been submitted.', 409, 'finalized'));
  const { session, env, calls } = await loaded({
    expiresInMs: 600_000,
    save: late.save,
    submit: [networkError],
    list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt: { state: 'scored', submitted_at: '2031-03-15T09:00:00Z', score: withCompletion('candidate_submit') } }] }),
  });
  session.selectAnswer(1, 'A');
  await env.advance(AUTOSAVE_DEBOUNCE_MS);
  session.submit();
  await env.advance(10);
  assert.equal(session.getState().phase, 'retrying');
  late.release(); // not yet confirmed: the finalized response legitimately checks status
  await env.advance(10);
  assert.equal(calls.list, 1);
  assert.equal(session.getState().phase, 'submitted');
  assert.equal(session.getState().message, MESSAGES.submissionRecorded, 'the earlier request may have committed: attributed to this flow');
  await env.advance(60_000);
  assert.equal(calls.submit.length, 1, 'no further retry after confirmation');
  assert.equal(session.getState().phase, 'submitted');
});

test('N2c. a timed-out submission that committed: the retry returns alreadyScored and the screen confirms this submission', async () => {
  const timeout = () => { throw new DOMException('The operation was aborted.', 'AbortError'); };
  for (const reason of ['candidate_submit', 'grace_submit']) {
    const { session, env, calls } = await loaded({
      expiresInMs: 600_000,
      submit: [timeout, (e) => ok(e, { submittedAt: iso(e.serverNow()), score: withCompletion(reason), alreadyScored: true })],
    });
    session.selectAnswer(1, 'A');
    session.submit();
    await env.advance(2_000);
    assert.equal(calls.submit.length, 2, reason);
    const state = session.getState();
    assert.equal(state.phase, 'submitted', reason);
    assert.equal(state.message, MESSAGES.submissionRecorded, reason);
    assert.equal(state.alreadyScored, false, `${reason}: shown as this submission, not a pre-existing one`);
    assert.equal(state.score?.totalScore, SCORE.totalScore);
    assert.equal(state.completionReason, reason);
    assert.doesNotMatch(state.message ?? '', /had already been submitted/);
  }
});

test('C. a 503 busy (nothing applied) followed by an independently committed score keeps pre-existing wording; a definite refusal is never counted as delivered', async () => {
  const busyThenAlready = await loaded({
    expiresInMs: 600_000,
    submit: [apiError(503, 'busy', 'busy'), (e) => ok(e, { submittedAt: 'x', score: withCompletion('candidate_submit'), alreadyScored: true })],
  });
  busyThenAlready.session.submit();
  await busyThenAlready.env.advance(2_000);
  assert.equal(busyThenAlready.calls.submit.length, 2, '503 busy is still retried (policy unchanged)');
  assert.equal(busyThenAlready.session.getState().phase, 'submitted');
  assert.equal(busyThenAlready.session.getState().message, MESSAGES.alreadyScored, 'not claimed as this request');
  assert.equal(busyThenAlready.session.getState().alreadyScored, true);

  // A Check status during the retry wait after a 503 busy (no request outstanding) is also pre-existing.
  const busyThenStatus = await loaded({
    expiresInMs: 600_000,
    submit: [apiError(503, 'busy', 'busy')],
    list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt: { state: 'scored', submitted_at: 'x', score: withCompletion('candidate_submit') } }] }),
  });
  busyThenStatus.session.submit();
  await busyThenStatus.env.advance(10);
  assert.equal(busyThenStatus.session.getState().phase, 'retrying');
  await busyThenStatus.session.checkStatus();
  assert.equal(busyThenStatus.session.getState().message, MESSAGES.alreadyScored);
  assert.equal(busyThenStatus.session.getState().alreadyScored, true);
  await busyThenStatus.env.advance(60_000);
  assert.equal(busyThenStatus.calls.submit.length, 1, 'retry loop stopped by the confirmation');

  // A 409 refusal ends the flow; a later candidate-triggered status check finds a score that this
  // flow could not have created, so it is reported as pre-existing.
  const refused = await loaded({
    expiresInMs: 600_000,
    submit: [apiError(409, 'Conflict.')],
    list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt: { state: 'scored', submitted_at: 'x', score: withCompletion('candidate_submit') } }] }),
  });
  refused.session.submit();
  await refused.env.advance(10);
  await refused.session.checkStatus();
  assert.equal(refused.session.getState().message, MESSAGES.alreadyScored);
  assert.equal(refused.session.getState().alreadyScored, true);
});

test('N2c. genuinely pre-existing submissions keep their wording', async () => {
  // First request of this flow already finds a score: submitted earlier (another tab or an earlier page load).
  const preExisting = await loaded({ expiresInMs: 600_000, submitDefault: (e) => ok(e, { submittedAt: 'x', score: withCompletion('candidate_submit'), alreadyScored: true }) });
  preExisting.session.submit();
  await preExisting.env.advance(10);
  assert.equal(preExisting.session.getState().message, MESSAGES.alreadyScored);
  assert.equal(preExisting.session.getState().alreadyScored, true);

  // Legacy score without completion metadata, even after an unconfirmed request: cannot be ours (all new scores carry completion).
  const legacy = await loaded({ expiresInMs: 600_000, submit: [networkError, (e) => ok(e, { submittedAt: 'x', score: { ...SCORE }, alreadyScored: true })] });
  legacy.session.submit();
  await legacy.env.advance(2_000);
  assert.equal(legacy.session.getState().message, MESSAGES.alreadyScored);
  assert.equal(legacy.session.getState().alreadyScored, true);

  // Scored from saved answers by automatic recovery before the retry arrived: described as such.
  const recovered = await loaded({ expiresInMs: 600_000, submit: [networkError, (e) => ok(e, { submittedAt: 'x', score: withCompletion('expired_saved_answers', 'system'), alreadyScored: true })] });
  recovered.session.submit();
  await recovered.env.advance(2_000);
  assert.equal(recovered.session.getState().message, MESSAGES.savedAnswersScored);
  assert.equal(recovered.session.getState().alreadyScored, true);
});

test('N2c. Check status after an unconfirmed flow: own commit vs pre-existing vs automatic recovery', async () => {
  const cases: Array<[string, Record<string, unknown>, string, boolean]> = [
    ['own commit', withCompletion('candidate_submit'), MESSAGES.submissionRecorded, false],
    ['own grace commit', withCompletion('grace_submit'), MESSAGES.submissionRecorded, false],
    ['recovered', withCompletion('expired_saved_answers', 'system'), MESSAGES.savedAnswersScored, true],
    ['legacy', { ...SCORE }, MESSAGES.alreadyScored, true],
  ];
  for (const [label, score, message, alreadyScored] of cases) {
    const { session, env } = await loaded({
      expiresInMs: 1_000,
      submitDefault: networkError,
      list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt: { state: 'scored', submitted_at: 'x', score } }] }),
    });
    await env.advance(61_000);
    assert.equal(session.getState().phase, 'submit_unconfirmed', label);
    await session.checkStatus();
    assert.equal(session.getState().phase, 'submitted', label);
    assert.equal(session.getState().message, message, label);
    assert.equal(session.getState().alreadyScored, alreadyScored, label);
  }
});

// ---------------------------------------------------------------------------
// Final hardening: edge cases A, C, D and ambiguous-outcome counting
// ---------------------------------------------------------------------------

/**
 * A submit request held in flight, an autosave that is answered 409 `finalized` while it is held
 * (so Check status runs before the submit answers), and a status record with the given score.
 */
function inFlightHarness(statusScore: Record<string, unknown>, submitOutcome: 'no_score' | 'lost' | 'scored') {
  let releaseSubmit!: () => void;
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  const lateSave = gatedSaveFailure(new ApiError('This exam has already been submitted.', 409, 'finalized'));
  const harness = loaded({
    expiresInMs: 600_000,
    save: lateSave.save,
    submit: [async (e) => {
      await submitGate;
      if (submitOutcome === 'lost') throw new TypeError('Failed to fetch');
      return submitOutcome === 'no_score'
        ? ok(e, { submittedAt: iso(e.serverNow()) })
        : ok(e, { submittedAt: iso(e.serverNow()), score: { ...statusScore }, alreadyScored: false });
    }],
    list: (e) => ok(e, { exams: [{ exam_code: 'EXAM1', attempt: { state: 'scored', submitted_at: 'x', score: statusScore } }] }),
  });
  return { harness, releaseSubmit, releaseSave: lateSave.release };
}

async function confirmWhileSubmitInFlight(statusScore: Record<string, unknown>, submitOutcome: 'no_score' | 'lost' | 'scored') {
  const { harness, releaseSubmit, releaseSave } = inFlightHarness(statusScore, submitOutcome);
  const h = await harness;
  h.session.selectAnswer(1, 'A');
  await h.env.advance(AUTOSAVE_DEBOUNCE_MS); // autosave in flight
  h.session.submit();
  await h.env.advance(10); // submit in flight (awaiting its response, not in a retry wait)
  assert.equal(h.session.getState().phase, 'submitting');
  releaseSave(); // 409 finalized before confirmation → legitimate status check
  await h.env.advance(10);
  return { ...h, releaseSubmit };
}

test('A. a 200 without a score after Check status confirmed the score never overwrites the confirmed state', async () => {
  const h = await confirmWhileSubmitInFlight(withCompletion('candidate_submit'), 'no_score');
  assert.equal(h.calls.list, 1);
  const confirmed = h.session.getState();
  assert.equal(confirmed.phase, 'submitted');
  const stateCountBefore = h.states.length;
  h.releaseSubmit();
  await h.env.advance(10);
  assert.equal(h.states.length, stateCountBefore, 'no state change');
  assert.equal(h.session.getState().phase, 'submitted');
  assert.equal(h.session.getState().message, confirmed.message);
  assert.deepEqual(h.session.getState().score, confirmed.score);
  await h.env.advance(60_000);
  assert.deepEqual([h.calls.submit.length, h.calls.list], [1, 1], 'no retry, no further status request');
});

test('A2. Check status is idempotent after confirmation (no request, no state change)', async () => {
  const h = await confirmWhileSubmitInFlight(withCompletion('candidate_submit'), 'scored');
  h.releaseSubmit();
  await h.env.advance(10);
  const stateCountBefore = h.states.length;
  await h.session.checkStatus();
  assert.equal(h.calls.list, 1);
  assert.equal(h.states.length, stateCountBefore);
});

test('D. Check status confirming the candidate\'s own commit while the submit is still in flight uses own-submission wording', async () => {
  for (const reason of ['candidate_submit', 'grace_submit']) {
    const h = await confirmWhileSubmitInFlight(withCompletion(reason), 'lost');
    assert.equal(h.session.getState().phase, 'submitted', reason);
    assert.equal(h.session.getState().message, MESSAGES.submissionRecorded, reason);
    assert.equal(h.session.getState().alreadyScored, false, reason);
    // The in-flight request is then lost: the confirmed submission fields stay exactly as they were.
    // (The countdown itself keeps ticking until expires_at, as before; it is hidden once a score is shown.)
    const pick = (state: ExamSessionState) => ({
      phase: state.phase, message: state.message, alreadyScored: state.alreadyScored,
      score: state.score, submittedAt: state.submittedAt, completionReason: state.completionReason, locked: state.locked,
    });
    const before = pick(h.session.getState());
    h.releaseSubmit();
    await h.env.advance(60_000);
    assert.deepEqual(pick(h.session.getState()), before, `${reason}: no change after the lost response`);
    assert.equal(h.calls.submit.length, 1, `${reason}: no retry after confirmation`);
    assert.equal(h.calls.list, 1, `${reason}: no further status request`);
  }
});

test('D2. an in-flight submit does not misclassify recovery or legacy scores found by Check status', async () => {
  const recovery = await confirmWhileSubmitInFlight(withCompletion('expired_saved_answers', 'system'), 'lost');
  assert.equal(recovery.session.getState().message, MESSAGES.savedAnswersScored);
  assert.equal(recovery.session.getState().alreadyScored, true);
  const legacy = await confirmWhileSubmitInFlight({ ...SCORE }, 'lost');
  assert.equal(legacy.session.getState().message, MESSAGES.alreadyScored);
  assert.equal(legacy.session.getState().alreadyScored, true);
});

test('D3. a submit response never counts itself: alreadyScored on the first request stays pre-existing', async () => {
  const { session, env } = await loaded({
    expiresInMs: 600_000,
    submitDefault: (e) => ok(e, { submittedAt: 'x', score: withCompletion('candidate_submit'), alreadyScored: true }),
  });
  session.submit();
  await env.advance(10);
  assert.equal(session.getState().message, MESSAGES.alreadyScored);
  assert.equal(session.getState().alreadyScored, true);
});

test('Ambiguous outcomes (network, timeout, 500, 502, 504) still count as possibly delivered', async () => {
  const outcomes: Array<[string, () => never, boolean]> = [
    ['network', () => { throw new TypeError('Failed to fetch'); }, true],
    ['timeout', () => { throw new DOMException('The operation was aborted.', 'AbortError'); }, true],
    ['502', () => { throw new ApiError('Bad gateway', 502); }, true],
    ['504', () => { throw new ApiError('Gateway timeout', 504); }, true],
    ['503 without busy code (gateway)', () => { throw new ApiError('Service unavailable', 503); }, true],
    ['500', () => { throw new ApiError('An unexpected server error occurred.', 500); }, false],
  ];
  const already = (e: FakeEnv) => ok(e, { submittedAt: 'x', score: withCompletion('candidate_submit'), alreadyScored: true });
  for (const [label, failure, retried] of outcomes) {
    const { session, env, calls } = await loaded({ expiresInMs: 600_000, submit: [failure, already] });
    session.submit();
    await env.advance(2_000);
    if (!retried) {
      // 500 is not retried automatically; the candidate retries.
      assert.equal(session.getState().phase, 'submit_unconfirmed', label);
      assert.equal(session.retrySubmission(), true, label);
      await env.advance(10);
    }
    assert.equal(calls.submit.length, 2, label);
    assert.equal(session.getState().message, MESSAGES.submissionRecorded, `${label} counts as possibly delivered`);
    assert.equal(session.getState().alreadyScored, false, label);
  }
});

test('Recovery and legacy wording after an ambiguous outcome remain unchanged', async () => {
  const recovered = await loaded({ expiresInMs: 600_000, submit: [networkError, (e) => ok(e, { submittedAt: 'x', score: withCompletion('expired_saved_answers', 'system'), alreadyScored: true })] });
  recovered.session.submit();
  await recovered.env.advance(2_000);
  assert.equal(recovered.session.getState().message, MESSAGES.savedAnswersScored);
  assert.equal(recovered.session.getState().alreadyScored, true);
  const legacy = await loaded({ expiresInMs: 600_000, submit: [networkError, (e) => ok(e, { submittedAt: 'x', score: { ...SCORE }, alreadyScored: true })] });
  legacy.session.submit();
  await legacy.env.advance(2_000);
  assert.equal(legacy.session.getState().message, MESSAGES.alreadyScored);
  assert.equal(legacy.session.getState().alreadyScored, true);
  const ownAfterGrace = await loaded({ expiresInMs: 600_000, submitDefault: (e) => ok(e, { submittedAt: 'x', score: withCompletion('expired_saved_answers', 'system'), alreadyScored: false }) });
  ownAfterGrace.session.submit();
  await ownAfterGrace.env.advance(10);
  assert.equal(ownAfterGrace.session.getState().message, MESSAGES.savedAnswersScored);
  assert.equal(ownAfterGrace.session.getState().alreadyScored, false);
});
