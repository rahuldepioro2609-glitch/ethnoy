// Candidate dashboard card for an online exam (P0-4 Phase 6).
//
// Uses the backend's `attempt.state` (computed from the database clock):
//   in_progress | final_submit_window | expired_pending_scoring | expired_unscored | scored
// Pending recovery is never shown as scored, expired attempts never offer "Resume", and a
// scored attempt shows its stored score. If `state` is absent (an older API), the previous
// behaviour is used unchanged.

export type OnlineExamCardTone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';

export interface OnlineExamCardView {
  /** Status line under the exam name, or null for none. */
  statusText: string | null;
  tone: OnlineExamCardTone;
  /** Whether the start/resume button is enabled. */
  canOpen: boolean;
  buttonLabel: 'Start exam' | 'Resume exam' | 'Attempt used';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** "Score: 6 / 10" from the stored score; "Score: 6" without a max; "Submitted" if absent. */
export function formatStoredScore(score: unknown): string {
  if (!isRecord(score) || score.totalScore === undefined || score.totalScore === null) return 'Submitted';
  const total = String(score.totalScore);
  return typeof score.maxScore === 'number' ? `Score: ${total} / ${score.maxScore}` : `Score: ${total}`;
}

export function describeOnlineExamAttempt(attempt: Record<string, unknown> | null | undefined, nowMs: number): OnlineExamCardView {
  if (!attempt) {
    return { statusText: null, tone: 'neutral', canOpen: true, buttonLabel: 'Start exam' };
  }
  switch (attempt.state) {
    case 'scored':
      return { statusText: `Attempt completed. ${formatStoredScore(attempt.score)}`, tone: 'success', canOpen: false, buttonLabel: 'Attempt used' };
    case 'in_progress':
      return { statusText: 'Attempt in progress. Your saved answers will be restored.', tone: 'active', canOpen: true, buttonLabel: 'Resume exam' };
    case 'final_submit_window':
      return { statusText: 'Time is up. Your final submission is being processed.', tone: 'warning', canOpen: false, buttonLabel: 'Attempt used' };
    case 'expired_pending_scoring':
      return {
        statusText: 'Time expired. Your last saved answers will be scored automatically shortly.',
        tone: 'warning',
        canOpen: false,
        buttonLabel: 'Attempt used',
      };
    case 'expired_unscored':
      return {
        statusText: 'Time expired. This attempt was not scored automatically. Please contact the exam office.',
        tone: 'danger',
        canOpen: false,
        buttonLabel: 'Attempt used',
      };
    default:
      break;
  }
  // No (or unknown) state: the previous logic, unchanged.
  const submitted = Boolean(attempt.submitted_at);
  const isActive = !submitted && new Date(String(attempt.expires_at)).getTime() > nowMs;
  if (submitted) {
    const score = isRecord(attempt.score) ? attempt.score : undefined;
    return { statusText: `Attempt completed. Score: ${String(score?.totalScore ?? 'Submitted')}`, tone: 'success', canOpen: false, buttonLabel: 'Attempt used' };
  }
  if (!isActive) return { statusText: 'Attempt expired.', tone: 'warning', canOpen: false, buttonLabel: 'Attempt used' };
  return { statusText: null, tone: 'neutral', canOpen: true, buttonLabel: 'Resume exam' };
}
