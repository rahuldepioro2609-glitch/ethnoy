// Institute Workspace Question Bank: labels, the moderation actions shown to an Institute, and the shape
// rule for a question's options and answer key. The server (server/instituteWorkspace.ts) imports
// questionShapeError, so the form and the server apply the same rule. Moderation is decided by the server
// (QUESTION_MODERATION_TRANSITIONS); server/instituteWorkspace.test.ts checks these actions agree with it.

export type QuestionType = 'mcq' | 'multi_select' | 'true_false' | 'descriptive';
export type ModerationStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'archived';

export const QUESTION_TYPE_LABEL: Readonly<Record<QuestionType, string>> = Object.freeze({
  mcq: 'Single choice',
  multi_select: 'Multiple choice',
  true_false: 'True or false',
  descriptive: 'Descriptive',
});

export const MODERATION_LABEL: Readonly<Record<ModerationStatus, string>> = Object.freeze({
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  archived: 'Archived',
});

export const DIFFICULTY_LABEL: Readonly<Record<string, string>> = Object.freeze({ easy: 'Easy', medium: 'Medium', hard: 'Hard' });

export interface QuestionAction {
  to: ModerationStatus;
  label: string;
  /** Archiving cannot be undone, so the screen asks first. */
  confirm: boolean;
}

const ACTIONS: Readonly<Record<ModerationStatus, readonly QuestionAction[]>> = Object.freeze({
  draft: [
    { to: 'in_review', label: 'Send for review', confirm: false },
    { to: 'archived', label: 'Archive', confirm: true },
  ],
  in_review: [
    { to: 'approved', label: 'Approve', confirm: false },
    { to: 'rejected', label: 'Reject', confirm: false },
    { to: 'archived', label: 'Archive', confirm: true },
  ],
  approved: [{ to: 'archived', label: 'Archive', confirm: true }],
  rejected: [{ to: 'archived', label: 'Archive', confirm: true }],
  archived: [],
});

export function questionActions(status: string): readonly QuestionAction[] {
  return ACTIONS[status as ModerationStatus] ?? [];
}

export function isChoiceQuestion(questionType: string): boolean {
  return questionType === 'mcq' || questionType === 'multi_select';
}

/**
 * Shape rules for a question's options and answer key, so a paper never holds an unanswerable item:
 * - mcq: 2–10 options, the answer is one option key;
 * - multi_select: 2–10 options, the answer is one or more option keys separated by commas;
 * - true_false: no options, the answer is "true" or "false";
 * - descriptive: no options, the answer (a model answer) is optional.
 * Returns an error message, or null when the question is well formed.
 */
export function questionShapeError(questionType: string, options: Readonly<Record<string, string>>, correctAnswer: string): string | null {
  const keys = Object.keys(options);
  if (isChoiceQuestion(questionType)) {
    if (keys.length < 2 || keys.length > 10) return 'A choice question needs between 2 and 10 options.';
    const answers = correctAnswer.split(',').map((key) => key.trim()).filter(Boolean);
    if (answers.length === 0) return 'Choose the correct option.';
    if (questionType === 'mcq' && answers.length !== 1) return 'A single-choice question has exactly one correct option.';
    if (new Set(answers).size !== answers.length) return 'The same option is listed twice in the answer.';
    if (answers.some((key) => !keys.includes(key))) return 'The answer must name one of the options.';
    return null;
  }
  if (keys.length > 0) return 'This question type has no options.';
  if (questionType === 'true_false' && correctAnswer !== 'true' && correctAnswer !== 'false') return 'A true/false answer must be "true" or "false".';
  return null;
}
