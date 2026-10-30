/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AnswerKeyQuestion {
  questionNumber: number;
  subject: 'Mathematics' | 'Physics' | 'Chemistry' | 'Logical Reasoning';
  questionText: string;
  options: {
    A: string;
    B: string;
    C: string;
    D: string;
  };
  officialKey: 'A' | 'B' | 'C' | 'D';
  candidateResponse?: 'A' | 'B' | 'C' | 'D';
  status: 'Key Finalized' | 'Under Challenge' | 'Key Revised';
  explanation: string;
}

export interface CandidateObjection {
  id: string;
  questionNumber: number;
  subject: string;
  officialKey: 'A' | 'B' | 'C' | 'D';
  proposedKey: 'A' | 'B' | 'C' | 'D' | 'All Options Invalid';
  objectionCategory: 'Incorrect Key' | 'Ambiguous Question' | 'Multiple Answers' | 'Out of Syllabus' | 'Typographical Discrepancy';
  justification: string;
  referenceSource: string;
  attachedDocumentName?: string;
  attachedDocumentSize?: string;
  feePaid: number;
  submissionDate: string;
  status: 'Under Review by Expert Panel' | 'Accepted (Marks Revised)' | 'Rejected (Official Key Upheld)';
  expertRemarks?: string;
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
    status: 'Key Finalized',
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
    status: 'Key Finalized',
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
    status: 'Key Finalized',
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
    status: 'Key Finalized',
    explanation: 'Letter shift pattern: +2, +2, +2, +2. H(+2)=J, A(+2)=C, W(+2)=Y, K(+2)=M => JCYM.',
  },
];

export const INITIAL_OBJECTIONS: CandidateObjection[] = [
  {
    id: 'OBJ-2025-014',
    questionNumber: 3,
    subject: 'Physics',
    officialKey: 'B',
    proposedKey: 'C',
    objectionCategory: 'Incorrect Key',
    justification: 'The question did not state whether amplitude displacement was measured from the extreme point or the equilibrium position. If measured from extreme, x\' differs.',
    referenceSource: 'NCERT Physics Class XI, Chapter 14 Oscillations, Page 346, Problem 14.12',
    attachedDocumentName: 'NCERT_Oscillations_Reference_Pg346.pdf',
    attachedDocumentSize: '1.4 MB',
    feePaid: 500,
    submissionDate: '12 Apr 2025',
    status: 'Under Review by Expert Panel',
    expertRemarks: 'Subject Matter Committee review scheduled for 18 Apr 2025.',
  },
];

export function calculateObjectionFee(questionCount: number, feePerQuestion: number = 500): number {
  return Math.max(0, questionCount * feePerQuestion);
}

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
