export interface MockResponse {
  selectedOptionId?: string;
}

export interface MockExamScore {
  totalQuestions: number;
  attempted: number;
  correct: number;
  incorrect: number;
  unattempted: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
  sectionScores: Record<string, { total: number; attempted: number; score: number }>;
}

const answerKey: Record<number, { answer: string; section: string }> = {
  1: { answer: 'B', section: 'Physics' },
  2: { answer: 'C', section: 'Physics' },
  3: { answer: 'A', section: 'Chemistry' },
  4: { answer: 'B', section: 'General Aptitude' },
};

export function scoreMockResponses(responses: Record<string, MockResponse>): MockExamScore {
  const sectionScores: MockExamScore['sectionScores'] = {};
  let attempted = 0;
  let correct = 0;
  let incorrect = 0;
  let totalScore = 0;

  for (const [idString, question] of Object.entries(answerKey)) {
    const section = question.section;
    sectionScores[section] ??= { total: 0, attempted: 0, score: 0 };
    sectionScores[section].total += 1;
    const selected = responses[idString]?.selectedOptionId;
    if (!selected) continue;

    attempted += 1;
    sectionScores[section].attempted += 1;
    const points = selected === question.answer ? 4 : -1;
    if (points > 0) correct += 1;
    else incorrect += 1;
    totalScore += points;
    sectionScores[section].score += points;
  }

  const totalQuestions = Object.keys(answerKey).length;
  const maxScore = totalQuestions * 4;
  return {
    totalQuestions,
    attempted,
    correct,
    incorrect,
    unattempted: totalQuestions - attempted,
    totalScore,
    maxScore,
    percentage: Math.max(0, Math.round((totalScore / maxScore) * 100)),
    sectionScores,
  };
}
