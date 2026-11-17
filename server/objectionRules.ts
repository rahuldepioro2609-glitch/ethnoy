export type AnswerOption = 'A' | 'B' | 'C' | 'D';
export type ProposedKey = AnswerOption | 'NONE';
export type KeyDecision = 'key_changed' | 'question_dropped' | 'no_change';

export const OBJECTION_CATEGORIES = [
  'Incorrect Key',
  'Ambiguous Question',
  'Multiple Answers',
  'Out of Syllabus',
  'Typographical Discrepancy',
] as const;

export function isWindowOpen(window: { is_open?: boolean | null; closes_at?: Date | string | null } | undefined, now = new Date()): boolean {
  if (!window?.is_open) return false;
  if (!window.closes_at) return true;
  return new Date(window.closes_at).getTime() > now.getTime();
}

/**
 * Decides whether one objection is upheld by the panel's decision for its question.
 * - Key changed: upheld only if the candidate proposed the new key.
 * - Question dropped: every objection on it is upheld, since the question itself was faulty.
 * - No change: every objection is rejected.
 */
export function objectionOutcome(decision: KeyDecision, proposedKey: ProposedKey, newKey?: AnswerOption): 'accepted' | 'rejected' {
  if (decision === 'question_dropped') return 'accepted';
  if (decision === 'key_changed') return proposedKey === newKey ? 'accepted' : 'rejected';
  return 'rejected';
}

export function questionStatus(question: { is_dropped?: boolean; original_key?: string | null; pending_objections?: number }):
  'Question Dropped' | 'Key Revised' | 'Under Challenge' | 'Key Published' {
  if (question.is_dropped) return 'Question Dropped';
  if (question.original_key) return 'Key Revised';
  if ((question.pending_objections ?? 0) > 0) return 'Under Challenge';
  return 'Key Published';
}
