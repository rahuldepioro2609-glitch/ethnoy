/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface CandidateAdmitCardData {
  applicationNumber: string;
  candidateName: string;
  fatherName: string;
  dob: string;
  gender: string;
  category: string;
  rollNumber: string;
  examName: string;
  examCode: string;
  examDate: string;
  reportingTime: string;
  gateClosingTime: string;
  examTiming: string;
  centerCode: string;
  centerName: string;
  centerAddress: string;
  photoUrl: string;
}

export interface QuestionOption {
  id: string;
  text: string;
}

export interface MockQuestion {
  id: number;
  section: string;
  questionText: string;
  options: QuestionOption[];
  correctOptionId: string;
  explanation: string;
}

export interface QuestionResponseState {
  selectedOptionId?: string;
  isMarkedForReview: boolean;
  visited: boolean;
}

export interface ExamScoreResult {
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

/**
 * Validates candidate credentials for Admit Card retrieval
 */
export function validateAdmitCardLookup(appNumber: string, dob: string): { isValid: boolean; error?: string } {
  const cleanApp = (appNumber || '').trim().toUpperCase();
  if (!cleanApp) {
    return { isValid: false, error: 'Application number is required.' };
  }
  if (cleanApp.length < 5) {
    return { isValid: false, error: 'Application number must be at least 5 alphanumeric characters.' };
  }
  if (!dob) {
    return { isValid: false, error: 'Date of birth is required.' };
  }
  return { isValid: true };
}

/**
 * Returns mock admit card data for a candidate query
 */
export function generateCandidateAdmitCard(appNumber: string, examCode = 'NEE-2026'): CandidateAdmitCardData {
  const normalized = (appNumber || 'NEA-2026-88419').trim().toUpperCase();
  const digits = normalized.replace(/\D/g, '') || '88419';
  const roll = `26${digits.padStart(8, '0')}`;

  const exams: Record<string, { name: string; date: string; time: string; repTime: string; gateTime: string }> = {
    'ENT-2025': {
      name: 'ELTNOY National Test 2025 (Under Graduate Entrance Exam)',
      date: 'Sunday, 25 May 2025',
      time: '09:00 AM - 12:00 PM (Shift-I)',
      repTime: '07:30 AM',
      gateTime: '08:30 AM',
    },
    'EST-2025': {
      name: 'ELTNOY Scholarship Test 2025 (Class 10th - 12th)',
      date: 'Tuesday, 10 June 2025',
      time: '10:00 AM - 12:00 PM',
      repTime: '08:45 AM',
      gateTime: '09:30 AM',
    },
    'NEE-2026': {
      name: 'ELTNOY National Engineering Entrance Examination 2025',
      date: 'Sunday, 25 May 2025',
      time: '09:00 AM - 12:00 PM (Shift-I)',
      repTime: '07:30 AM',
      gateTime: '08:30 AM',
    },
    'CMET-2026': {
      name: 'ELTNOY Medical Eligibility & Entrance Test 2025',
      date: 'Sunday, 24 May 2025',
      time: '02:00 PM - 05:20 PM (Shift-II)',
      repTime: '12:30 PM',
      gateTime: '01:30 PM',
    },
    'GAA-2026': {
      name: 'ELTNOY Graduate Aptitude Assessment 2025',
      date: 'Saturday, 06 June 2025',
      time: '09:00 AM - 12:00 PM (Shift-I)',
      repTime: '07:45 AM',
      gateTime: '08:35 AM',
    },
  };

  const selectedExam = exams[examCode] || exams['ENT-2025'] || exams['NEE-2026'];

  return {
    applicationNumber: normalized,
    candidateName: 'AARAV SHARMA',
    fatherName: 'RAJESH SHARMA',
    dob: '2008-04-14',
    gender: 'MALE',
    category: 'GENERAL (UR)',
    rollNumber: roll,
    examName: selectedExam.name,
    examCode: examCode,
    examDate: selectedExam.date,
    reportingTime: selectedExam.repTime,
    gateClosingTime: selectedExam.gateTime,
    examTiming: selectedExam.time,
    centerCode: 'CBT-DL-0419',
    centerName: 'National Informatics Center & CBT Test Complex - Center 04',
    centerAddress: 'Plot 14-B, Institutional Area, Sector 62, Metro Station Road, New Delhi - 110001',
    photoUrl: '',
  };
}

/**
 * Standard marking scheme:
 * +4 for correct answer
 * -1 for incorrect answer
 * 0 for unattempted
 */
export function calculateExamScore(
  questions: MockQuestion[],
  responses: Record<number, QuestionResponseState>
): ExamScoreResult {
  let attempted = 0;
  let correct = 0;
  let incorrect = 0;
  let unattempted = 0;
  let totalScore = 0;

  const sectionScores: Record<string, { total: number; attempted: number; score: number }> = {};

  questions.forEach((q) => {
    if (!sectionScores[q.section]) {
      sectionScores[q.section] = { total: 0, attempted: 0, score: 0 };
    }
    sectionScores[q.section].total += 1;

    const resp = responses[q.id];
    if (resp && resp.selectedOptionId) {
      attempted += 1;
      sectionScores[q.section].attempted += 1;
      if (resp.selectedOptionId === q.correctOptionId) {
        correct += 1;
        totalScore += 4;
        sectionScores[q.section].score += 4;
      } else {
        incorrect += 1;
        totalScore -= 1;
        sectionScores[q.section].score -= 1;
      }
    } else {
      unattempted += 1;
    }
  });

  const totalQuestions = questions.length;
  const maxScore = totalQuestions * 4;
  const percentage = maxScore > 0 ? Math.max(0, Math.round((totalScore / maxScore) * 100)) : 0;

  return {
    totalQuestions,
    attempted,
    correct,
    incorrect,
    unattempted,
    totalScore,
    maxScore,
    percentage,
    sectionScores,
  };
}

/**
 * Filters items by query string (case-insensitive substring)
 */
export function searchKnowledgeBase<T extends { title: string; tags?: string[]; code?: string; description?: string }>(
  items: T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  return items.filter((item) => {
    const titleMatch = item.title.toLowerCase().includes(q);
    const codeMatch = item.code ? item.code.toLowerCase().includes(q) : false;
    const descMatch = item.description ? item.description.toLowerCase().includes(q) : false;
    const tagMatch = item.tags ? item.tags.some((t) => t.toLowerCase().includes(q)) : false;
    return titleMatch || codeMatch || descMatch || tagMatch;
  });
}
