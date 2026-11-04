// Pure online-exam scoring. No database or request access.
//
// scoreOnlineExam() is the formula previously written inline in the
// POST /api/online-exams/:examCode/submit handler, moved here unchanged:
// points are awarded only for a correct answer (no negative marking), the
// maximum score is the sum of all question points, and the score object keeps
// its original field names and key order.

export type OnlineExamOption = 'A' | 'B' | 'C' | 'D';

/** A row from `SELECT question_number, correct_option, points, section FROM online_exam_questions`. */
export interface OnlineExamQuestionRow {
  question_number: unknown;
  correct_option: unknown;
  points: unknown;
  section: unknown;
}

export interface OnlineExamSectionScore {
  correct: number;
  total: number;
  score: number;
  maxScore: number;
}

export interface OnlineExamScore {
  totalQuestions: number;
  attempted: number;
  correct: number;
  incorrect: number;
  unattempted: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
  sectionScores: Record<string, OnlineExamSectionScore>;
}

export interface SanitizedOnlineExamResponses {
  /** Answers kept for scoring and storage, in their original insertion order. */
  accepted: Record<string, OnlineExamOption>;
  /** Entries dropped because the question number is unknown or the option is not A–D. */
  ignored: number;
  /** True when the input was not a plain object (for example NULL, an array or a string). */
  malformed: boolean;
}

const VALID_OPTIONS: ReadonlySet<string> = new Set(['A', 'B', 'C', 'D']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Keeps only answers for known question numbers whose value is exactly A, B, C or D.
 * Never throws. For an already-validated answer object this returns the same entries,
 * in the same order, as the previous inline filter.
 */
export function sanitizeOnlineExamResponses(
  raw: unknown,
  questions: readonly OnlineExamQuestionRow[],
): SanitizedOnlineExamResponses {
  if (!isPlainObject(raw)) {
    return { accepted: {}, ignored: 0, malformed: raw !== undefined && raw !== null };
  }
  const questionNumbers = new Set(questions.map((question) => String(question.question_number)));
  const entries = Object.entries(raw);
  const kept = entries.filter(([questionNumber, option]) => (
    questionNumbers.has(questionNumber) && typeof option === 'string' && VALID_OPTIONS.has(option)
  )) as Array<[string, OnlineExamOption]>;
  return {
    accepted: Object.fromEntries(kept) as Record<string, OnlineExamOption>,
    ignored: entries.length - kept.length,
    malformed: false,
  };
}

/** The original online-exam scoring formula, unchanged. */
export function scoreOnlineExam(
  questions: readonly OnlineExamQuestionRow[],
  responses: Readonly<Record<string, OnlineExamOption>>,
): OnlineExamScore {
  let correct = 0;
  let totalScore = 0;
  let maxScore = 0;
  const sectionScores: Record<string, OnlineExamSectionScore> = {};
  for (const question of questions) {
    const section = String(question.section);
    sectionScores[section] ??= { correct: 0, total: 0, score: 0, maxScore: 0 };
    const points = Number(question.points);
    maxScore += points;
    sectionScores[section].total += 1;
    sectionScores[section].maxScore += points;
    if (responses[String(question.question_number)] === question.correct_option) {
      correct += 1;
      totalScore += points;
      sectionScores[section].correct += 1;
      sectionScores[section].score += points;
    }
  }
  return {
    totalQuestions: questions.length,
    attempted: Object.keys(responses).length,
    correct,
    incorrect: Math.max(0, Object.keys(responses).length - correct),
    unattempted: Math.max(0, questions.length - Object.keys(responses).length),
    totalScore,
    maxScore,
    percentage: maxScore ? Math.round((totalScore / maxScore) * 100) : 0,
    sectionScores,
  };
}
