// Server-synchronized countdown for online exams (P0-4 Phase 6).
//
// The browser's wall clock (Date.now) is never used for exam timing. The server's time is
// estimated from timestamps the existing API already returns:
//   - the HTTP `Date` header on every response (one-second resolution), and
//   - `savedAt` from autosave (the database decision time, millisecond resolution).
// Elapsed time between samples is measured with a monotonic clock (performance.now), which
// does not move when the user or the OS changes the wall clock.

/** Monotonic milliseconds. Defaults to performance.now(); injectable for tests. */
export type MonotonicClock = () => number;

export const defaultMonotonicClock: MonotonicClock = () => performance.now();

export interface ServerTimeSample {
  /** Server time in epoch milliseconds, as reported (possibly truncated, see resolutionMs). */
  serverTimeMs: number;
  /** Monotonic time when the request was sent and when the response arrived. */
  sentAt: number;
  receivedAt: number;
  /** Truncation of serverTimeMs: 1000 for the HTTP Date header, 1 for millisecond timestamps. */
  resolutionMs: number;
}

/**
 * Maps the monotonic clock onto the server clock. Keeps the most precise sample (smallest
 * round trip), but replaces it when a new sample clearly disagrees (for example after the
 * device slept and the monotonic clock paused) or after markStale() (page resumed).
 */
export class ServerClock {
  private offsetMs: number | null = null;
  private uncertaintyMs = Number.POSITIVE_INFINITY;

  constructor(private readonly monotonicNow: MonotonicClock = defaultMonotonicClock) {}

  record(sample: ServerTimeSample): boolean {
    if (!Number.isFinite(sample.serverTimeMs) || !Number.isFinite(sample.sentAt) || !Number.isFinite(sample.receivedAt)) return false;
    if (sample.receivedAt < sample.sentAt) return false;
    const halfRoundTrip = (sample.receivedAt - sample.sentAt) / 2;
    const offset = sample.serverTimeMs + sample.resolutionMs / 2 - (sample.sentAt + halfRoundTrip);
    const uncertainty = halfRoundTrip + sample.resolutionMs / 2;
    const disagrees = this.offsetMs !== null && Math.abs(offset - this.offsetMs) > uncertainty + this.uncertaintyMs;
    if (this.offsetMs === null || uncertainty <= this.uncertaintyMs || disagrees) {
      this.offsetMs = offset;
      this.uncertaintyMs = uncertainty;
      return true;
    }
    return false;
  }

  /** Records the HTTP `Date` header of a response. Returns false if it is missing or invalid. */
  recordDateHeader(dateHeader: string | null | undefined, sentAt: number, receivedAt: number): boolean {
    if (!dateHeader) return false;
    return this.record({ serverTimeMs: Date.parse(dateHeader), sentAt, receivedAt, resolutionMs: 1000 });
  }

  /** Records a server timestamp such as autosave's savedAt (millisecond resolution). */
  recordTimestamp(timestamp: unknown, sentAt: number, receivedAt: number): boolean {
    if (typeof timestamp !== 'string') return false;
    return this.record({ serverTimeMs: Date.parse(timestamp), sentAt, receivedAt, resolutionMs: 1 });
  }

  /** The current estimate stays in use, but the next sample replaces it (call on page resume). */
  markStale(): void {
    this.uncertaintyMs = Number.POSITIVE_INFINITY;
  }

  isSynchronized(): boolean {
    return this.offsetMs !== null;
  }

  /** Estimated server time in epoch milliseconds, or null before the first sample. */
  now(): number | null {
    return this.offsetMs === null ? null : this.monotonicNow() + this.offsetMs;
  }
}

/** Milliseconds until expiry by the server clock, or null if the clock is not synchronized. */
export function remainingMs(expiresAt: string, clock: ServerClock): number | null {
  const serverNow = clock.now();
  const expiresAtMs = Date.parse(expiresAt);
  if (serverNow === null || !Number.isFinite(expiresAtMs)) return null;
  return expiresAtMs - serverNow;
}

/** Whole seconds shown on the countdown; rounds up so "00:00" appears only at true zero. */
export function displaySeconds(ms: number | null): number | null {
  if (ms === null) return null;
  return Math.max(0, Math.ceil(ms / 1000));
}

export type TimeWarning = 'none' | 'low' | 'critical' | 'expired';

export const LOW_TIME_WARNING_SECONDS = 5 * 60;
export const CRITICAL_TIME_WARNING_SECONDS = 60;

export function timeWarning(seconds: number | null): TimeWarning {
  if (seconds === null) return 'none';
  if (seconds <= 0) return 'expired';
  if (seconds <= CRITICAL_TIME_WARNING_SECONDS) return 'critical';
  if (seconds <= LOW_TIME_WARNING_SECONDS) return 'low';
  return 'none';
}

/** "mm:ss" (minutes may exceed 59, as before), or "--:--" when the clock is not synchronized. */
export function formatCountdown(seconds: number | null): string {
  if (seconds === null) return '--:--';
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
