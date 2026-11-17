/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type AnswerOption = 'A' | 'B' | 'C' | 'D';
export type ProposedKey = AnswerOption | 'NONE';
export type AnswerKeyStatus = 'Key Published' | 'Under Challenge' | 'Key Revised' | 'Question Dropped';

export interface AnswerKeyQuestion {
  questionNumber: number;
  subject: 'Mathematics' | 'Physics' | 'Chemistry' | 'Logical Reasoning';
  questionText: string;
  options: Record<AnswerOption, string>;
  officialKey: AnswerOption;
  /** The key before an objection-driven revision, if any. */
  originalKey?: AnswerOption | null;
  candidateResponse?: AnswerOption;
  status: AnswerKeyStatus;
  explanation: string;
}

export const OBJECTION_CATEGORIES = [
  'Incorrect Key',
  'Ambiguous Question',
  'Multiple Answers',
  'Out of Syllabus',
  'Typographical Discrepancy',
] as const;
export type ObjectionCategory = typeof OBJECTION_CATEGORIES[number];

export interface CandidateObjection {
  id: string;
  referenceNumber: string;
  examCode: string;
  questionNumber: number;
  officialKey: AnswerOption;
  proposedKey: ProposedKey;
  category: ObjectionCategory;
  justification: string;
  referenceSource: string;
  documentFileId: string | null;
  documentName: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  resolution: 'key_changed' | 'question_dropped' | 'no_change' | null;
  reviewerRemarks: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export function proposedKeyLabel(key: ProposedKey): string {
  return key === 'NONE' ? 'None of the options' : `Option ${key}`;
}

export function objectionStatusLabel(objection: Pick<CandidateObjection, 'status' | 'resolution'>): string {
  if (objection.status === 'pending') return 'Under review by subject experts';
  if (objection.resolution === 'question_dropped') return 'Accepted · question dropped';
  if (objection.status === 'accepted') return 'Accepted · key revised';
  return 'Not accepted · key upheld';
}

export const SAMPLE_ANSWER_KEYS: AnswerKeyQuestion[] = [
  {
    questionNumber: 1,
    subject: 'Mathematics',
    questionText: 'If a matrix A satisfies A² - A + I = 0, then the inverse matrix A⁻¹ is equal to:',
    options: {
      A: 'A + I',
      B: 'I - A',
      C: 'A - I',
      D: 'A²',
    },
    officialKey: 'B',
    candidateResponse: 'B',
    status: 'Key Published',
    explanation: 'Multiplying both sides of A² - A + I = 0 by A⁻¹ gives A - I + A⁻¹ = 0, so A⁻¹ = I - A.',
  },
  {
    questionNumber: 2,
    subject: 'Mathematics',
    questionText: 'Evaluate the definite integral ∫ (from 0 to π/2) [ sin³(x) / (sin³(x) + cos³(x)) ] dx:',
    options: {
      A: 'π / 2',
      B: 'π / 4',
      C: '1',
      D: 'π / 8',
    },
    officialKey: 'B',
    candidateResponse: 'B',
    status: 'Key Published',
    explanation: 'Using King\'s property ∫ f(x) dx = ∫ f(a+b-x) dx, adding 2I gives ∫ dx = π/2, so I = π/4.',
  },
  {
    questionNumber: 3,
    subject: 'Physics',
    questionText: 'A particle executes simple harmonic motion with amplitude A. At what displacement from mean position is kinetic energy equal to potential energy?',
    options: {
      A: 'A / 2',
      B: 'A / √2',
      C: 'A / √3',
      D: 'A / 4',
    },
    officialKey: 'B',
    candidateResponse: 'C',
    status: 'Under Challenge',
    explanation: 'KE = 1/2 k(A² - x²) and PE = 1/2 kx². Equating gives A² - x² = x² => 2x² = A² => x = A/√2.',
  },
  {
    questionNumber: 4,
    subject: 'Physics',
    questionText: 'In a Young\'s double-slit experiment, if the entire apparatus is immersed in water of refractive index 4/3, the fringe width will:',
    options: {
      A: 'Increase by a factor of 4/3',
      B: 'Decrease to 3/4 of its initial value',
      C: 'Remain strictly unchanged',
      D: 'Disappear completely',
    },
    officialKey: 'B',
    candidateResponse: 'B',
    status: 'Key Published',
    explanation: 'Fringe width β = λD/d. In water, λ\' = λ/μ = 3/4 λ, so β\' = 3/4 β.',
  },
  {
    questionNumber: 5,
    subject: 'Chemistry',
    questionText: 'Which of the following coordination compounds exhibits optical isomerism?',
    options: {
      A: 'trans-[Co(en)₂Cl₂]⁺',
      B: 'cis-[Co(en)₂Cl₂]⁺',
      C: '[Co(NH₃)₄Cl₂]⁺',
      D: '[Zn(NH₃)₄]²⁺',
    },
    officialKey: 'B',
    candidateResponse: 'A',
    status: 'Under Challenge',
    explanation: 'The cis isomer of [Co(en)₂Cl₂]⁺ lacks a plane or center of symmetry, making it chiral and optically active.',
  },
  {
    questionNumber: 6,
    subject: 'Logical Reasoning',
    questionText: 'In a certain code, "EAGLE" is written as "GBING". How will "HAWK" be written in that code?',
    options: {
      A: 'JCZN',
      B: 'JCYM',
      C: 'KDZM',
      D: 'JBXN',
    },
    officialKey: 'B',
    candidateResponse: 'B',
    status: 'Key Published',
    explanation: 'Letter shift pattern: +2, +2, +2, +2. H(+2)=J, A(+2)=C, W(+2)=Y, K(+2)=M => JCYM.',
  },
];

export function validateObjection(data: {
  questionNumber: number;
  proposedKey: string;
  justification: string;
  referenceSource: string;
}): { isValid: boolean; error?: string } {
  if (!data.questionNumber || data.questionNumber <= 0) {
    return { isValid: false, error: 'Please choose a valid question number.' };
  }
  if (!data.proposedKey) {
    return { isValid: false, error: 'Please select your proposed correct answer option.' };
  }
  if (!data.justification || data.justification.trim().length < 15) {
    return { isValid: false, error: 'Please provide a clear justification of at least 15 characters.' };
  }
  if (!data.referenceSource || data.referenceSource.trim().length < 5) {
    return { isValid: false, error: 'Please cite an official textbook or standard reference source.' };
  }
  return { isValid: true };
}

export function filterQuestions(
  questions: AnswerKeyQuestion[],
  subjectFilter: string,
  searchQuery: string = ''
): AnswerKeyQuestion[] {
  const q = searchQuery.trim().toLowerCase();
  return questions.filter((item) => {
    const matchesSubject = subjectFilter === 'All' || item.subject === subjectFilter;
    if (!matchesSubject) return false;
    if (!q) return true;
    return (
      item.questionText.toLowerCase().includes(q) ||
      item.questionNumber.toString().includes(q) ||
      item.subject.toLowerCase().includes(q)
    );
  });
}
