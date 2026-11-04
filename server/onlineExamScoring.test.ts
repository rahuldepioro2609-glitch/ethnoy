import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type OnlineExamOption,
  type OnlineExamQuestionRow,
  sanitizeOnlineExamResponses,
  scoreOnlineExam,
} from './onlineExamScoring.js';

// Verbatim copy of the inline filter and scoring formula from the submit handler
// in server/index.ts at commit 29fb928 (lines 819-851). It is the reference that the
// extracted functions must match exactly. Do not "improve" this copy. Only the parameter
// types were added; pg returns these rows untyped in the original handler.
function originalSubmitScoring(
  questions: readonly OnlineExamQuestionRow[],
  submittedResponses: Record<string, OnlineExamOption>,
) {
  const questionNumbers = new Set(questions.map((question) => String(question.question_number)));
  const responses = Object.fromEntries(
    Object.entries(submittedResponses).filter(([questionNumber]) => questionNumbers.has(questionNumber)),
  );
  let correct = 0;
  let totalScore = 0;
  let maxScore = 0;
  const sectionScores: Record<string, { correct: number; total: number; score: number; maxScore: number }> = {};
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
  const score = {
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
  return { responses, score };
}

function extractedSubmitScoring(
  questions: OnlineExamQuestionRow[],
  submittedResponses: Record<string, OnlineExamOption>,
) {
  const { accepted: responses } = sanitizeOnlineExamResponses(submittedResponses, questions);
  return { responses, score: scoreOnlineExam(questions, responses) };
}

/** Exact equality including key order, which is what ends up in the stored JSON. */
function assertIdentical(actual: unknown, expected: unknown, message?: string) {
  assert.deepStrictEqual(actual, expected, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function question(number: number, correctOption: OnlineExamOption, points: number, section: string): OnlineExamQuestionRow {
  return { question_number: number, correct_option: correctOption, points, section };
}

// Rows as PostgreSQL returns them for the submit query: integer question_number and points.
const PAPER: OnlineExamQuestionRow[] = [
  question(1, 'A', 1, 'Mathematics'),
  question(2, 'B', 1, 'Mathematics'),
  question(3, 'C', 2, 'Physics'),
  question(4, 'D', 2, 'Physics'),
  question(5, 'A', 4, 'Logical Reasoning'),
];

// ---------------------------------------------------------------------------
// Golden fixtures: hand-computed expected scores.
// ---------------------------------------------------------------------------

const goldenCases: Array<{
  name: string;
  questions: OnlineExamQuestionRow[];
  responses: Record<string, OnlineExamOption>;
  expected: ReturnType<typeof scoreOnlineExam>;
}> = [
  {
    name: 'all answers correct',
    questions: PAPER,
    responses: { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'A' },
    expected: {
      totalQuestions: 5, attempted: 5, correct: 5, incorrect: 0, unattempted: 0,
      totalScore: 10, maxScore: 10, percentage: 100,
      sectionScores: {
        Mathematics: { correct: 2, total: 2, score: 2, maxScore: 2 },
        Physics: { correct: 2, total: 2, score: 4, maxScore: 4 },
        'Logical Reasoning': { correct: 1, total: 1, score: 4, maxScore: 4 },
      },
    },
  },
  {
    name: 'all answers incorrect',
    questions: PAPER,
    responses: { 1: 'B', 2: 'C', 3: 'D', 4: 'A', 5: 'B' },
    expected: {
      totalQuestions: 5, attempted: 5, correct: 0, incorrect: 5, unattempted: 0,
      totalScore: 0, maxScore: 10, percentage: 0,
      sectionScores: {
        Mathematics: { correct: 0, total: 2, score: 0, maxScore: 2 },
        Physics: { correct: 0, total: 2, score: 0, maxScore: 4 },
        'Logical Reasoning': { correct: 0, total: 1, score: 0, maxScore: 4 },
      },
    },
  },
  {
    name: 'partially answered (one correct, one wrong, three blank)',
    questions: PAPER,
    responses: { 3: 'C', 5: 'D' },
    expected: {
      totalQuestions: 5, attempted: 2, correct: 1, incorrect: 1, unattempted: 3,
      totalScore: 2, maxScore: 10, percentage: 20,
      sectionScores: {
        Mathematics: { correct: 0, total: 2, score: 0, maxScore: 2 },
        Physics: { correct: 1, total: 2, score: 2, maxScore: 4 },
        'Logical Reasoning': { correct: 0, total: 1, score: 0, maxScore: 4 },
      },
    },
  },
  {
    name: 'empty answers',
    questions: PAPER,
    responses: {},
    expected: {
      totalQuestions: 5, attempted: 0, correct: 0, incorrect: 0, unattempted: 5,
      totalScore: 0, maxScore: 10, percentage: 0,
      sectionScores: {
        Mathematics: { correct: 0, total: 2, score: 0, maxScore: 2 },
        Physics: { correct: 0, total: 2, score: 0, maxScore: 4 },
        'Logical Reasoning': { correct: 0, total: 1, score: 0, maxScore: 4 },
      },
    },
  },
  {
    name: 'multiple sections interleaved keep first-appearance order',
    questions: [
      question(1, 'A', 1, 'Physics'),
      question(2, 'A', 1, 'Chemistry'),
      question(3, 'A', 1, 'Physics'),
      question(4, 'A', 1, 'Mathematics'),
    ],
    responses: { 1: 'A', 2: 'B', 4: 'A' },
    expected: {
      totalQuestions: 4, attempted: 3, correct: 2, incorrect: 1, unattempted: 1,
      totalScore: 2, maxScore: 4, percentage: 50,
      sectionScores: {
        Physics: { correct: 1, total: 2, score: 1, maxScore: 2 },
        Chemistry: { correct: 0, total: 1, score: 0, maxScore: 1 },
        Mathematics: { correct: 1, total: 1, score: 1, maxScore: 1 },
      },
    },
  },
  {
    name: 'different point values (1, 50, 100)',
    questions: [
      question(1, 'A', 1, 'S'),
      question(2, 'B', 50, 'S'),
      question(3, 'C', 100, 'S'),
    ],
    responses: { 2: 'B', 3: 'D' },
    expected: {
      totalQuestions: 3, attempted: 2, correct: 1, incorrect: 1, unattempted: 1,
      totalScore: 50, maxScore: 151, percentage: 33,
      sectionScores: { S: { correct: 1, total: 3, score: 50, maxScore: 151 } },
    },
  },
  {
    name: 'no questions gives percentage 0, not NaN',
    questions: [],
    responses: {},
    expected: {
      totalQuestions: 0, attempted: 0, correct: 0, incorrect: 0, unattempted: 0,
      totalScore: 0, maxScore: 0, percentage: 0, sectionScores: {},
    },
  },
];

for (const goldenCase of goldenCases) {
  test(`golden: ${goldenCase.name}`, () => {
    const extracted = extractedSubmitScoring(goldenCase.questions, goldenCase.responses);
    const original = originalSubmitScoring(goldenCase.questions, goldenCase.responses);
    assertIdentical(extracted.score, goldenCase.expected, 'extracted score matches hand-computed golden value');
    assertIdentical(original.score, goldenCase.expected, 'original formula matches the same golden value');
    assertIdentical(extracted.responses, original.responses, 'stored responses are unchanged');
  });
}

test('golden: percentage uses Math.round exactly as before', () => {
  const ones = (count: number) => Array.from({ length: count }, (_, index) => question(index + 1, 'A', 1, 'S'));
  const answerFirst = (count: number) => Object.fromEntries(
    Array.from({ length: count }, (_, index) => [String(index + 1), 'A' as const]),
  );
  const cases: Array<[number, number, number]> = [
    [3, 1, 33], // 33.33… → 33
    [3, 2, 67], // 66.66… → 67
    [8, 1, 13], // 12.5   → 13 (Math.round rounds .5 up)
    [8, 5, 63], // 62.5   → 63
    [8, 3, 38], // 37.5   → 38
    [200, 1, 1], // 0.5   → 1
    [201, 1, 0], // 0.497… → 0
    [7, 7, 100],
  ];
  for (const [total, correctCount, expectedPercentage] of cases) {
    const questions = ones(total);
    const responses = answerFirst(correctCount);
    const extracted = extractedSubmitScoring(questions, responses);
    const original = originalSubmitScoring(questions, responses);
    assert.equal(extracted.score.percentage, expectedPercentage, `${correctCount}/${total}`);
    assertIdentical(extracted.score, original.score, `${correctCount}/${total}`);
  }
});

test('golden: unknown question numbers are ignored exactly as before', () => {
  const responses = { 1: 'A', 99: 'A', '01': 'A', ' 2': 'B', 2: 'B' } as Record<string, OnlineExamOption>;
  const extracted = extractedSubmitScoring(PAPER, responses);
  const original = originalSubmitScoring(PAPER, responses);
  assertIdentical(extracted, original);
  assertIdentical(extracted.responses, { 1: 'A', 2: 'B' });
  assert.equal(extracted.score.attempted, 2);
  assert.equal(extracted.score.correct, 2);
});

test('original and extracted scoring agree on 2,000 generated valid inputs, including key order', () => {
  // Deterministic linear congruential generator, so failures are reproducible.
  let seed = 20261103;
  const next = (limit: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  const options: OnlineExamOption[] = ['A', 'B', 'C', 'D'];
  const sections = ['Mathematics', 'Physics', 'Chemistry', 'Logical Reasoning'];
  for (let run = 0; run < 2000; run += 1) {
    const questionCount = next(25);
    const questions = Array.from({ length: questionCount }, (_, index) => question(
      index + 1 + next(3) * 100,
      options[next(4)],
      1 + next(100),
      sections[next(4)],
    ));
    const responses: Record<string, OnlineExamOption> = {};
    for (let index = 0; index < next(30); index += 1) {
      const pickKnown = questions.length > 0 && next(4) !== 0;
      const key = pickKnown ? String(questions[next(questions.length)].question_number) : String(1000 + next(50));
      responses[key] = options[next(4)];
    }
    const extracted = extractedSubmitScoring(questions, responses);
    const original = originalSubmitScoring(questions, responses);
    assertIdentical(extracted, original, `generated case ${run}`);
  }
});

test('score keeps the original field names and order', () => {
  const score = scoreOnlineExam(PAPER, { 1: 'A' });
  assert.deepEqual(Object.keys(score), [
    'totalQuestions', 'attempted', 'correct', 'incorrect', 'unattempted',
    'totalScore', 'maxScore', 'percentage', 'sectionScores',
  ]);
  assert.deepEqual(Object.keys(score.sectionScores.Mathematics), ['correct', 'total', 'score', 'maxScore']);
  assert.equal('completion' in score, false, 'completion metadata is not part of Phase 1');
});

// ---------------------------------------------------------------------------
// Safe validation of stored or untrusted answers (for later recovery use).
// ---------------------------------------------------------------------------

test('sanitize: invalid answer options are dropped and counted', () => {
  const result = sanitizeOnlineExamResponses(
    { 1: 'A', 2: 'b', 3: 'E', 4: '', 5: 'AB', 6: 1, 7: null, 8: ['A'], 9: { option: 'A' } },
    [...PAPER, question(6, 'A', 1, 'S'), question(7, 'A', 1, 'S'), question(8, 'A', 1, 'S'), question(9, 'A', 1, 'S')],
  );
  assertIdentical(result.accepted, { 1: 'A' });
  assert.equal(result.ignored, 8);
  assert.equal(result.malformed, false);
});

test('sanitize: unknown question numbers are dropped and counted', () => {
  const result = sanitizeOnlineExamResponses({ 1: 'A', 6: 'B', 'x': 'C', '1.0': 'D' }, PAPER);
  assertIdentical(result.accepted, { 1: 'A' });
  assert.equal(result.ignored, 3);
});

test('sanitize: NULL and missing answers are empty, not malformed, and never throw', () => {
  for (const raw of [null, undefined]) {
    const result = sanitizeOnlineExamResponses(raw, PAPER);
    assertIdentical(result.accepted, {});
    assert.equal(result.ignored, 0);
    assert.equal(result.malformed, false);
    assertIdentical(scoreOnlineExam(PAPER, result.accepted), goldenCases[3].expected);
  }
});

test('sanitize: malformed answer containers are treated as no answers and never throw', () => {
  const malformedInputs: unknown[] = [
    'A', 42, true, ['A', 'B'], [['1', 'A']], new Date(0), new Map([['1', 'A']]), () => 'A', Symbol('x'),
  ];
  for (const raw of malformedInputs) {
    const result = sanitizeOnlineExamResponses(raw, PAPER);
    assertIdentical(result.accepted, {}, String(typeof raw));
    assert.equal(result.ignored, 0);
    assert.equal(result.malformed, true, String(typeof raw));
    assert.doesNotThrow(() => scoreOnlineExam(PAPER, result.accepted));
  }
});

test('sanitize: special keys cannot alter the result object prototype', () => {
  const raw = JSON.parse('{"__proto__": "A", "constructor": "B", "1": "A"}') as unknown;
  const result = sanitizeOnlineExamResponses(raw, PAPER);
  assertIdentical(result.accepted, { 1: 'A' });
  assert.equal(Object.getPrototypeOf(result.accepted), Object.prototype);
  assert.equal(result.ignored, 2);
});

test('sanitize: objects without a prototype are accepted', () => {
  const raw = Object.assign(Object.create(null) as Record<string, unknown>, { 2: 'B', 3: 'Z' });
  const result = sanitizeOnlineExamResponses(raw, PAPER);
  assertIdentical(result.accepted, { 2: 'B' });
  assert.equal(result.ignored, 1);
});

test('sanitize: valid answers keep their insertion order', () => {
  const result = sanitizeOnlineExamResponses({ 5: 'A', 99: 'A', 3: 'C', 1: 'D' }, PAPER);
  // Integer-like keys are ordered numerically by JavaScript, exactly as in the original filter.
  assert.equal(JSON.stringify(result.accepted), JSON.stringify({ 1: 'D', 3: 'C', 5: 'A' }));
});

test('scoring rows that use string question numbers (as JSON would) still match the original', () => {
  const stringRows = PAPER.map((row) => ({ ...row, question_number: String(row.question_number) }));
  const responses = { 1: 'A', 3: 'D', 5: 'A' } as Record<string, OnlineExamOption>;
  assertIdentical(
    extractedSubmitScoring(stringRows, responses),
    originalSubmitScoring(stringRows, responses),
  );
});
