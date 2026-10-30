import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAdmitCardLookup,
  generateCandidateAdmitCard,
  calculateExamScore,
  searchKnowledgeBase,
  MockQuestion,
  QuestionResponseState,
} from './examLogic';

test('validateAdmitCardLookup verifies required fields and minimum length', () => {
  assert.equal(validateAdmitCardLookup('', '2008-01-01').isValid, false);
  assert.equal(validateAdmitCardLookup('123', '2008-01-01').isValid, false);
  assert.equal(validateAdmitCardLookup('NEA-2026-88419', '').isValid, false);
  assert.equal(validateAdmitCardLookup('NEA-2026-88419', '2008-04-14').isValid, true);
});

test('generateCandidateAdmitCard creates valid hall ticket with roll number and venue', () => {
  const card = generateCandidateAdmitCard('NEA-2026-99120', 'NEE-2026');
  assert.equal(card.applicationNumber, 'NEA-2026-99120');
  assert.equal(card.examCode, 'NEE-2026');
  assert.ok(card.rollNumber.startsWith('26'));
  assert.ok(card.centerAddress.length > 10);
  assert.equal(card.candidateName, 'AARAV SHARMA');
});

test('calculateExamScore computes marking scheme: +4 for correct, -1 for incorrect, 0 for unattempted', () => {
  const sampleQuestions: MockQuestion[] = [
    {
      id: 1,
      section: 'Physics',
      questionText: 'What is the SI unit of electric capacitance?',
      options: [
        { id: 'A', text: 'Henry' },
        { id: 'B', text: 'Farad' },
        { id: 'C', text: 'Tesla' },
        { id: 'D', text: 'Weber' },
      ],
      correctOptionId: 'B',
      explanation: 'Capacitance is measured in Farads (F).',
    },
    {
      id: 2,
      section: 'Chemistry',
      questionText: 'Which orbital has zero angular nodes?',
      options: [
        { id: 'A', text: '1s' },
        { id: 'B', text: '2p' },
        { id: 'C', text: '3d' },
        { id: 'D', text: '4f' },
      ],
      correctOptionId: 'A',
      explanation: 'For s-orbitals, angular nodes l = 0.',
    },
    {
      id: 3,
      section: 'Mathematics',
      questionText: 'What is the derivative of sin(x)?',
      options: [
        { id: 'A', text: '-cos(x)' },
        { id: 'B', text: 'cos(x)' },
        { id: 'C', text: 'tan(x)' },
        { id: 'D', text: '-sin(x)' },
      ],
      correctOptionId: 'B',
      explanation: 'd/dx[sin(x)] = cos(x).',
    },
  ];

  const responses: Record<number, QuestionResponseState> = {
    1: { selectedOptionId: 'B', isMarkedForReview: false, visited: true }, // Correct (+4)
    2: { selectedOptionId: 'C', isMarkedForReview: false, visited: true }, // Wrong (-1)
    // 3 unattempted (0)
  };

  const result = calculateExamScore(sampleQuestions, responses);

  assert.equal(result.totalQuestions, 3);
  assert.equal(result.attempted, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.incorrect, 1);
  assert.equal(result.unattempted, 1);
  assert.equal(result.totalScore, 3); // 4 - 1 = 3
  assert.equal(result.maxScore, 12);
  assert.equal(result.percentage, 25);
  assert.equal(result.sectionScores['Physics'].score, 4);
  assert.equal(result.sectionScores['Chemistry'].score, -1);
  assert.equal(result.sectionScores['Mathematics'].score, 0);
});

test('searchKnowledgeBase filters properly by title, code, and tags', () => {
  const items = [
    { title: 'National Engineering Entrance Exam', code: 'NEE-2026', tags: ['btech', 'engineering'] },
    { title: 'Central Medical Eligibility Test', code: 'CMET-2026', tags: ['mbbs', 'medical'] },
    { title: 'Public Notice on Biometric Guidelines', code: 'CIR-2026-09', tags: ['biometric', 'admit-card'] },
  ];

  assert.equal(searchKnowledgeBase(items, 'NEE').length, 1);
  assert.equal(searchKnowledgeBase(items, 'medical').length, 1);
  assert.equal(searchKnowledgeBase(items, 'biometric').length, 1);
  assert.equal(searchKnowledgeBase(items, '2026').length, 3);
  assert.equal(searchKnowledgeBase(items, 'nonexistent').length, 0);
});
