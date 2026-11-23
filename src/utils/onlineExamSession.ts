// Online exam session controller (P0-4 Phase 6).
//
// Owns the countdown, answer locking, autosave and the single final submission for one exam
// attempt. Framework-independent: the React screen subscribes to its state. Transport, timers
// and the monotonic clock are injected, so every behaviour is unit-tested with fakes.
//
// Rules implemented here:
// - Timing uses the server clock (ServerClock), never the browser's wall clock.
// - Answers can be changed only before expiry. At zero (or when the server reports that
//   answering has closed) inputs lock, any pending autosave is cancelled, and the in-memory
//   answers are captured once and submitted once.
// - Autosave is debounced (500 ms, as before), one request at a time, never after expiry.
//   A late autosave response never changes what was submitted.
// - Final submission: at most 4 attempts (1 + 3 retries after 1 s, 2 s, 4 s), and only for
//   network failures, timeouts and HTTP 502/503/504. Every other failure stops immediately.
//   "Submitted" is shown only after a 200 response containing a score.

import { ApiError, type OnlineExamOption, type OnlineExamStartData, type OnlineExamTransport } from '../api';
import {
  defaultMonotonicClock,
  displaySeconds,
  type MonotonicClock,
  remainingMs,
  ServerClock,
  type TimeWarning,
  timeWarning,
} from './onlineExamTimer';

export const AUTOSAVE_DEBOUNCE_MS = 500;
export const AUTOSAVE_RETRY_MS = 5_000;
export const TICK_MS = 250;
export const SUBMIT_MAX_ATTEMPTS = 4;
export const SUBMIT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export type ExamLoadState = 'loading' | 'ready' | 'failed';

/**
 * - in_progress: answering (or locked with nothing submitted yet).
 * - submitting / retrying: the final submission is in flight (retrying = a retry attempt).
 * - submitted: confirmed by a 200 response with a score.
 * - submit_unconfirmed: no confirmation after the allowed attempts; the outcome is unknown.
 * - submit_rejected: the server refused (400/401/403/404/409/500…); not submitted by this request.
 * - awaiting_recovery: time expired; the saved answers are waiting to be scored automatically.
 * - expired_unscored: time expired and the attempt will not be scored automatically.
 */
export type ExamPhase =
  | 'in_progress'
  | 'submitting'
  | 'retrying'
  | 'submitted'
  | 'submit_unconfirmed'
  | 'submit_rejected'
  | 'awaiting_recovery'
  | 'expired_unscored';

/** idle (nothing to save), unsaved (change pending), saving, saved, save_failed, closed (answering ended). */
export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'save_failed' | 'closed';

export type ExamAnswers = Readonly<Record<string, OnlineExamOption>>;

export interface ExamSessionState {
  loadState: ExamLoadState;
  loadError: string | null;
  questions: OnlineExamStartData['questions'];
  attemptId: string | null;
  expiresAt: string | null;
  answers: ExamAnswers;
  locked: boolean;
  timeExpired: boolean;
  remainingSeconds: number | null;
  warning: TimeWarning;
  clockSynchronized: boolean;
  saveStatus: SaveStatus;
  lastSavedAt: string | null;
  saveMessage: string | null;
  phase: ExamPhase;
  submitAttempt: number;
  maxSubmitAttempts: number;
  score: Record<string, unknown> | null;
  submittedAt: unknown;
  alreadyScored: boolean;
  completionReason: string | null;
  message: string | null;
  checkingStatus: boolean;
}

export interface TimerFunctions {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerFunctions = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type ExamTransport = Pick<OnlineExamTransport, 'start' | 'saveAnswers' | 'submitAnswers' | 'listExams'>;

export interface OnlineExamSessionOptions {
  examCode: string;
  transport: ExamTransport;
  monotonicNow?: MonotonicClock;
  timers?: TimerFunctions;
  onChange?: (state: ExamSessionState) => void;
}

export type SubmitFailureKind = 'retry' | 'rejected' | 'unconfirmed';

/**
 * retry: network failure, timeout or HTTP 502/503/504 (nothing was applied, or the request may
 * not have arrived; the server's submit is idempotent, so retrying cannot score twice).
 * rejected: HTTP 400/401/403/404/409 — a definite answer from the server; never retried.
 * unconfirmed: any other HTTP error (e.g. 500); not retried and not reported as success.
 */
export function classifySubmitFailure(error: unknown): SubmitFailureKind {
  if (error instanceof ApiError) {
    if (RETRYABLE_STATUSES.has(error.status)) return 'retry';
    if ([400, 401, 403, 404, 409].includes(error.status)) return 'rejected';
    return 'unconfirmed';
  }
  return 'retry';
}

export const MESSAGES = {
  timeUp: 'Time is up. Your answers are locked and are being submitted.',
  submitting: 'Submitting your answers…',
  retrying: (attempt: number, max: number) => `Connection problem. Retrying submission (attempt ${attempt} of ${max})…`,
  submitted: 'Exam submitted. Your score is shown below.',
  /** Used when an earlier request in this submission flow went unanswered but did reach the server. */
  submissionRecorded: 'Exam submitted. Your submission was recorded, and your score is shown below.',
  alreadyScored: 'This exam had already been submitted. Your recorded score is shown below.',
  savedAnswersScored: 'Time expired before your final answers reached the server. Your last saved answers were scored.',
  unconfirmed: 'We could not confirm your submission. It may still have been recorded. Use “Check status” to see the result before trying again.',
  incomplete: 'The server response did not include a score, so the submission could not be confirmed. Use “Check status”.',
  awaitingRecovery: 'Time has expired. Your last saved answers will be scored automatically shortly. Check again in a minute.',
  expiredUnscored: 'This attempt has expired and was not scored automatically. Please contact the exam office.',
  stillOpen: 'Your attempt is still open, so the submission was not recorded. You can retry the submission.',
  statusUnknown: 'The attempt status could not be determined. Please refresh your dashboard.',
  statusCheckFailed: 'Could not check the status right now. Please try again shortly.',
  saveFailed: 'Your latest answers are not saved yet. Retrying automatically…',
  loadFailed: 'Could not start this exam.',
  finalizedElsewhere: 'This exam has already been submitted. Checking your recorded result…',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function completionReasonOf(score: Record<string, unknown>): string | null {
  const completion = score.completion;
  return isRecord(completion) && typeof completion.reason === 'string' ? completion.reason : null;
}

export class OnlineExamSession {
  private state: ExamSessionState;
  private readonly clock: ServerClock;
  private readonly now: MonotonicClock;
  private readonly timers: TimerFunctions;
  private readonly transport: ExamTransport;
  private readonly examCode: string;
  private readonly onChange?: (state: ExamSessionState) => void;

  private disposed = false;
  private loadStarted = false;
  private tickHandle: unknown = null;
  private debounceHandle: unknown = null;
  private saveRetryHandle: unknown = null;
  private saving = false;
  private saveRequested = false;
  private answerVersion = 0;
  private finalAnswers: ExamAnswers | null = null;
  private submitInFlight = false;
  /** True once a score is confirmed (own 200, or the server record found by checkStatus). Final. */
  private submissionConfirmed = false;
  /**
   * Submit requests in this flow whose outcome is unknown (network error, timeout, 500, 502, 504):
   * they may have committed. A 503 `busy` is not counted: the server applied nothing.
   */
  private possiblyDeliveredSubmits = 0;
  /**
   * True only while a submit request is awaiting its response (not during retry waits, unlike
   * submitInFlight). Such a request may already have committed when Check status runs.
   */
  private submitRequestOutstanding = false;
  private resyncInFlight = false;
  private readonly pendingWaits = new Set<{ handle: unknown; resolve: () => void }>();

  constructor(options: OnlineExamSessionOptions) {
    this.examCode = options.examCode;
    this.transport = options.transport;
    this.now = options.monotonicNow ?? defaultMonotonicClock;
    this.timers = options.timers ?? defaultTimers;
    this.onChange = options.onChange;
    this.clock = new ServerClock(this.now);
    this.state = {
      loadState: 'loading',
      loadError: null,
      questions: [],
      attemptId: null,
      expiresAt: null,
      answers: {},
      locked: false,
      timeExpired: false,
      remainingSeconds: null,
      warning: 'none',
      clockSynchronized: false,
      saveStatus: 'idle',
      lastSavedAt: null,
      saveMessage: null,
      phase: 'in_progress',
      submitAttempt: 0,
      maxSubmitAttempts: SUBMIT_MAX_ATTEMPTS,
      score: null,
      submittedAt: null,
      alreadyScored: false,
      completionReason: null,
      message: null,
      checkingStatus: false,
    };
  }

  getState(): ExamSessionState {
    return this.state;
  }

  /** The answers captured for the final submission (null until submission starts). */
  getSubmittedAnswers(): ExamAnswers | null {
    return this.finalAnswers;
  }

  private patch(changes: Partial<ExamSessionState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...changes };
    this.onChange?.(this.state);
  }

  // -------------------------------------------------------------------------
  // Loading (start or resume; a refresh resumes the same attempt and expiry)
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    if (this.loadStarted) return;
    this.loadStarted = true;
    const sentAt = this.now();
    try {
      const response = await this.transport.start(this.examCode);
      const receivedAt = this.now();
      if (this.disposed) return;
      this.clock.recordDateHeader(response.serverDate, sentAt, receivedAt);
      const { attempt, questions, responses } = response.data;
      const answers = { ...(responses ?? {}) };
      this.patch({
        loadState: 'ready',
        attemptId: attempt.id,
        expiresAt: attempt.expires_at,
        questions,
        answers,
        saveStatus: Object.keys(answers).length ? 'saved' : 'idle',
      });
      this.tick();
      this.scheduleTick();
    } catch (error) {
      if (this.disposed) return;
      this.patch({ loadState: 'failed', loadError: error instanceof ApiError ? error.message : MESSAGES.loadFailed });
    }
  }

  // -------------------------------------------------------------------------
  // Countdown
  // -------------------------------------------------------------------------

  private scheduleTick(): void {
    if (this.disposed || this.state.timeExpired) return;
    this.tickHandle = this.timers.setTimeout(() => {
      this.tickHandle = null;
      this.tick();
      this.scheduleTick();
    }, TICK_MS);
  }

  /** Recomputes the countdown from the server clock; triggers expiry once at zero. No network. */
  tick(): void {
    if (this.disposed || this.state.loadState !== 'ready' || !this.state.expiresAt) return;
    const ms = remainingMs(this.state.expiresAt, this.clock);
    if (ms !== null && ms <= 0) {
      this.expire();
      return;
    }
    const seconds = displaySeconds(ms);
    const warning = this.state.timeExpired ? 'expired' : timeWarning(seconds);
    const synchronized = this.clock.isSynchronized();
    if (seconds !== this.state.remainingSeconds || warning !== this.state.warning || synchronized !== this.state.clockSynchronized) {
      this.patch({ remainingSeconds: seconds, warning, clockSynchronized: synchronized });
    }
  }

  /** Call when the page becomes visible again or the network returns: re-reads server time. */
  async resync(): Promise<void> {
    if (this.disposed || this.state.loadState !== 'ready' || this.resyncInFlight) return;
    this.resyncInFlight = true;
    this.clock.markStale();
    const sentAt = this.now();
    try {
      const response = await this.transport.listExams();
      if (!this.disposed) this.clock.recordDateHeader(response.serverDate, sentAt, this.now());
    } catch {
      // Keep the previous estimate; the next request will refresh it.
    } finally {
      this.resyncInFlight = false;
    }
    this.tick();
  }

  private expire(): void {
    if (this.state.timeExpired) return;
    this.lockAndStopSaving();
    const startSubmission = this.finalAnswers === null;
    this.patch({
      timeExpired: true,
      remainingSeconds: 0,
      warning: 'expired',
      message: startSubmission ? MESSAGES.timeUp : this.state.message,
    });
    if (this.tickHandle !== null) {
      this.timers.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    if (startSubmission) this.beginFinalSubmission();
  }

  // -------------------------------------------------------------------------
  // Answers and autosave
  // -------------------------------------------------------------------------

  /** Returns false (and changes nothing) once answering has ended. */
  selectAnswer(questionNumber: number | string, option: OnlineExamOption): boolean {
    if (this.disposed || this.state.loadState !== 'ready' || this.state.locked) return false;
    const ms = this.state.expiresAt ? remainingMs(this.state.expiresAt, this.clock) : null;
    if (ms !== null && ms <= 0) {
      this.expire();
      return false;
    }
    this.answerVersion += 1;
    this.patch({
      answers: { ...this.state.answers, [String(questionNumber)]: option },
      saveStatus: 'unsaved',
      saveMessage: null,
    });
    this.scheduleSave(AUTOSAVE_DEBOUNCE_MS);
    return true;
  }

  private scheduleSave(ms: number): void {
    if (this.state.locked || this.disposed) return;
    if (this.debounceHandle !== null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.flushSave();
    }, ms);
  }

  private async flushSave(): Promise<void> {
    if (this.disposed || this.state.locked || !this.state.attemptId) return;
    if (this.saving) {
      this.saveRequested = true;
      return;
    }
    const ms = this.state.expiresAt ? remainingMs(this.state.expiresAt, this.clock) : null;
    if (ms !== null && ms <= 0) {
      this.expire();
      return;
    }
    const version = this.answerVersion;
    const snapshot = { ...this.state.answers };
    this.saving = true;
    this.patch({ saveStatus: 'saving' });
    const sentAt = this.now();
    try {
      const response = await this.transport.saveAnswers(this.examCode, this.state.attemptId, snapshot);
      const receivedAt = this.now();
      if (this.disposed) return;
      this.clock.recordDateHeader(response.serverDate, sentAt, receivedAt);
      this.clock.recordTimestamp(response.data?.savedAt, sentAt, receivedAt);
      // Once locked, the final submission carries every answer; a late save result changes nothing.
      if (this.state.locked) return;
      if (version === this.answerVersion) {
        this.patch({
          saveStatus: 'saved',
          lastSavedAt: typeof response.data?.savedAt === 'string' ? response.data.savedAt : this.state.lastSavedAt,
          saveMessage: null,
        });
      } else {
        this.saveRequested = true;
      }
    } catch (error) {
      if (this.disposed) return;
      // A confirmed submission is final. A late autosave response (e.g. 409 finalized, which our own
      // committed submission causes) must not change its state or trigger a status request.
      // Before confirmation the branches below still apply.
      if (this.submissionConfirmed) return;
      if (error instanceof ApiError && error.status === 409 && error.code === 'answering_closed') {
        this.expire();
        return;
      }
      if (error instanceof ApiError && error.status === 409 && error.code === 'finalized') {
        this.lockAndStopSaving();
        this.patch({ message: MESSAGES.finalizedElsewhere });
        void this.checkStatus();
        return;
      }
      if (this.state.locked) return;
      const transient = !(error instanceof ApiError) || RETRYABLE_STATUSES.has(error.status);
      this.patch({
        saveStatus: 'save_failed',
        saveMessage: transient ? MESSAGES.saveFailed : (error as ApiError).message,
      });
      if (transient) {
        if (this.saveRetryHandle !== null) this.timers.clearTimeout(this.saveRetryHandle);
        this.saveRetryHandle = this.timers.setTimeout(() => {
          this.saveRetryHandle = null;
          void this.flushSave();
        }, AUTOSAVE_RETRY_MS);
      }
    } finally {
      this.saving = false;
      if (this.saveRequested && !this.state.locked && !this.disposed) {
        this.saveRequested = false;
        this.scheduleSave(0);
      }
    }
  }

  private lockAndStopSaving(): void {
    if (this.debounceHandle !== null) {
      this.timers.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.saveRetryHandle !== null) {
      this.timers.clearTimeout(this.saveRetryHandle);
      this.saveRetryHandle = null;
    }
    this.saveRequested = false;
    this.patch({ locked: true, saveStatus: this.state.saveStatus === 'saved' ? 'saved' : 'closed' });
  }

  // -------------------------------------------------------------------------
  // Final submission (captured once, submitted once, bounded retries)
  // -------------------------------------------------------------------------

  /** Candidate clicked "Submit exam". Locks answers; returns false if a submission already started. */
  submit(): boolean {
    if (this.disposed || this.state.loadState !== 'ready' || this.finalAnswers !== null) return false;
    this.lockAndStopSaving();
    this.beginFinalSubmission();
    return true;
  }

  /** Candidate-triggered retry after an unconfirmed result. Re-sends the same captured answers. */
  retrySubmission(): boolean {
    if (this.disposed || this.state.phase !== 'submit_unconfirmed' || this.finalAnswers === null || this.submitInFlight) return false;
    void this.runSubmission();
    return true;
  }

  private beginFinalSubmission(): void {
    if (this.finalAnswers !== null) return;
    this.finalAnswers = Object.freeze({ ...this.state.answers });
    void this.runSubmission();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry = { handle: null as unknown, resolve };
      entry.handle = this.timers.setTimeout(() => {
        this.pendingWaits.delete(entry);
        resolve();
      }, ms);
      this.pendingWaits.add(entry);
    });
  }

  private async runSubmission(): Promise<void> {
    if (this.submitInFlight || this.finalAnswers === null || !this.state.attemptId) return;
    this.submitInFlight = true;
    const answers = this.finalAnswers;
    const attemptId = this.state.attemptId;
    try {
      for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt += 1) {
        // Stop if disposed, or if checkStatus confirmed the score during a retry wait.
        if (this.disposed || this.submissionConfirmed) return;
        this.patch({
          phase: attempt === 1 ? 'submitting' : 'retrying',
          submitAttempt: attempt,
          message: attempt === 1 ? (this.state.timeExpired ? MESSAGES.timeUp : MESSAGES.submitting) : MESSAGES.retrying(attempt, SUBMIT_MAX_ATTEMPTS),
        });
        const sentAt = this.now();
        try {
          this.submitRequestOutstanding = true;
          let response: Awaited<ReturnType<ExamTransport['submitAnswers']>>;
          try {
            response = await this.transport.submitAnswers(this.examCode, attemptId, { ...answers });
          } finally {
            this.submitRequestOutstanding = false;
          }
          if (this.disposed) return;
          this.clock.recordDateHeader(response.serverDate, sentAt, this.now());
          const score = isRecord(response.data?.score) ? response.data.score : null;
          if (!score) {
            // A response without a score never replaces a score already confirmed by Check status.
            if (this.submissionConfirmed) return;
            this.patch({ phase: 'submit_unconfirmed', message: MESSAGES.incomplete });
            return;
          }
          this.confirmSubmission(score, response.data?.submittedAt ?? null, response.data?.alreadyScored === true, 'submit_response');
          return;
        } catch (error) {
          if (this.disposed || this.submissionConfirmed) return;
          const kind = classifySubmitFailure(error);
          // Count only outcomes that may have committed: not definite refusals (400/401/403/404/409),
          // and not a 503 `busy`, which the server sends only when nothing was applied.
          const busyNotApplied = error instanceof ApiError && error.status === 503 && error.code === 'busy';
          if (kind !== 'rejected' && !busyNotApplied) this.possiblyDeliveredSubmits += 1;
          if (kind === 'retry' && attempt < SUBMIT_MAX_ATTEMPTS) {
            // Show "retrying" for the whole wait, not only once the next request starts.
            this.patch({ phase: 'retrying', message: MESSAGES.retrying(attempt + 1, SUBMIT_MAX_ATTEMPTS) });
            await this.wait(SUBMIT_RETRY_DELAYS_MS[attempt - 1]);
            continue;
          }
          if (kind === 'rejected') {
            const expiredUnscored = error instanceof ApiError && error.code === 'expired_unscored';
            this.patch({
              phase: expiredUnscored ? 'expired_unscored' : 'submit_rejected',
              message: error instanceof ApiError ? error.message : MESSAGES.unconfirmed,
            });
          } else {
            this.patch({ phase: 'submit_unconfirmed', message: MESSAGES.unconfirmed });
          }
          return;
        }
      }
    } finally {
      this.submitInFlight = false;
    }
  }

  /**
   * Records a confirmed score and chooses honest wording. A server "already scored" answer is the
   * candidate's own submission flow when a request in this flow may have reached the server and the
   * stored score was made from submitted answers (candidate_submit / grace_submit): it is then
   * reported as this submission, not as a pre-existing one. "May have reached the server" means an
   * earlier request with an unknown outcome, or (for Check status only) a submit request that is
   * still awaiting its response. A submit response never counts itself. Scores made from saved
   * answers by automatic recovery, and scores that existed before this flow, keep their own wording.
   */
  private confirmSubmission(
    score: Record<string, unknown>,
    submittedAt: unknown,
    serverSaysAlreadyScored: boolean,
    source: 'submit_response' | 'status_check',
  ): void {
    const reason = completionReasonOf(score);
    const fromSubmittedAnswers = reason === 'candidate_submit' || reason === 'grace_submit';
    const ownRequestMayHaveCommitted = this.possiblyDeliveredSubmits > 0
      || (source === 'status_check' && this.submitRequestOutstanding);
    const ownEarlierRequest = serverSaysAlreadyScored && ownRequestMayHaveCommitted && fromSubmittedAnswers;
    const alreadyScored = serverSaysAlreadyScored && !ownEarlierRequest;
    let message: string;
    if (ownEarlierRequest) message = MESSAGES.submissionRecorded;
    else if (reason === 'expired_saved_answers') message = MESSAGES.savedAnswersScored;
    else if (alreadyScored) message = MESSAGES.alreadyScored;
    else message = MESSAGES.submitted;
    this.submissionConfirmed = true;
    this.patch({ phase: 'submitted', score, submittedAt, alreadyScored, completionReason: reason, message });
  }

  // -------------------------------------------------------------------------
  // Status check (safe, read-only)
  // -------------------------------------------------------------------------

  /** Reads the attempt from the candidate's exam list and reports its real state. Never submits. */
  async checkStatus(): Promise<void> {
    // Idempotent after confirmation: a confirmed score is final, so there is nothing left to check.
    if (this.disposed || this.state.checkingStatus || this.submissionConfirmed) return;
    this.patch({ checkingStatus: true });
    const sentAt = this.now();
    try {
      const response = await this.transport.listExams();
      if (this.disposed) return;
      this.clock.recordDateHeader(response.serverDate, sentAt, this.now());
      const exam = (response.data?.exams ?? []).find((entry) => String(entry.exam_code).toUpperCase() === this.examCode.toUpperCase());
      const attempt = exam?.attempt ?? null;
      const state = attempt && typeof attempt.state === 'string' ? attempt.state : null;
      if (attempt && attempt.submitted_at && isRecord(attempt.score)) {
        this.confirmSubmission(attempt.score, attempt.submitted_at, true, 'status_check');
      } else if (state === 'expired_pending_scoring' || state === 'final_submit_window') {
        this.patch({ phase: 'awaiting_recovery', message: MESSAGES.awaitingRecovery });
      } else if (state === 'expired_unscored') {
        this.patch({ phase: 'expired_unscored', message: MESSAGES.expiredUnscored });
      } else if (state === 'in_progress') {
        this.patch({ phase: this.finalAnswers ? 'submit_unconfirmed' : this.state.phase, message: MESSAGES.stillOpen });
      } else {
        this.patch({ message: MESSAGES.statusUnknown });
      }
    } catch {
      this.patch({ message: MESSAGES.statusCheckFailed });
    } finally {
      this.patch({ checkingStatus: false });
    }
  }

  /** Stops every timer and pending retry. Call when the screen closes. */
  dispose(): void {
    if (this.disposed) return;
    for (const handle of [this.tickHandle, this.debounceHandle, this.saveRetryHandle]) {
      if (handle !== null) this.timers.clearTimeout(handle);
    }
    this.tickHandle = null;
    this.debounceHandle = null;
    this.saveRetryHandle = null;
    for (const entry of this.pendingWaits) {
      this.timers.clearTimeout(entry.handle);
      entry.resolve();
    }
    this.pendingWaits.clear();
    this.disposed = true;
  }
}
