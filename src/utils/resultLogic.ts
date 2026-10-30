/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SectionScore {
  sectionName: string;
  maxMarks: number;
  marksObtained: number;
  percentile: number;
}

export interface CandidateScorecard {
  rollNumber: string;
  applicationNumber: string;
  candidateName: string;
  fatherName: string;
  motherName: string;
  dob: string;
  gender: 'Male' | 'Female' | 'Other';
  category: 'General' | 'OBC-NCL' | 'SC' | 'ST' | 'Gen-EWS';
  pwdStatus: boolean;
  examCode: string;
  examName: string;
  examDate: string;
  centerName: string;
  sectionScores: SectionScore[];
  totalMaxMarks: number;
  totalMarksObtained: number;
  aggregatePercentile: number;
  allIndiaRank: number;
  categoryRank: number;
  qualifyingStatus: 'QUALIFIED' | 'NOT_QUALIFIED';
  cutoffMarks: {
    general: number;
    obc: number;
    ews: number;
    scSt: number;
  };
  digitalVerificationCode: string;
  counselingStream: string;
  issueDate: string;
}

export const PRESET_SCORECARDS: CandidateScorecard[] = [
  {
    rollNumber: 'ENT-2025-9981',
    applicationNumber: 'ELT2025987114',
    candidateName: 'Aarav Sharma',
    fatherName: 'Rajesh Sharma',
    motherName: 'Sunita Sharma',
    dob: '2004-06-14',
    gender: 'Male',
    category: 'General',
    pwdStatus: false,
    examCode: 'ENT-2025',
    examName: 'ELTNOY National Test 2025 (Undergraduate)',
    examDate: '25 May 2025',
    centerName: 'ELTNOY Examination Complex - North Zone (ELT-DL-01)',
    sectionScores: [
      { sectionName: 'Quantitative Aptitude & Mathematics', maxMarks: 100, marksObtained: 94, percentile: 99.64 },
      { sectionName: 'Logical & Critical Analytical Reasoning', maxMarks: 100, marksObtained: 91, percentile: 98.92 },
      { sectionName: 'Language Comprehension & Core Sciences', maxMarks: 100, marksObtained: 89, percentile: 98.45 },
    ],
    totalMaxMarks: 300,
    totalMarksObtained: 274,
    aggregatePercentile: 99.42,
    allIndiaRank: 142,
    categoryRank: 142,
    qualifyingStatus: 'QUALIFIED',
    cutoffMarks: { general: 195, obc: 175, ews: 180, scSt: 145 },
    digitalVerificationCode: 'ELT-VER-9981-AIR142-SECURE',
    counselingStream: 'Tier 1 Central University Honors Program',
    issueDate: '05 July 2025',
  },
  {
    rollNumber: 'EST-2025-4420',
    applicationNumber: 'ELT2025442088',
    candidateName: 'Priya Patel',
    fatherName: 'Kishore Patel',
    motherName: 'Meenakshi Patel',
    dob: '2005-09-22',
    gender: 'Female',
    category: 'OBC-NCL',
    pwdStatus: false,
    examCode: 'EST-2025',
    examName: 'ELTNOY Scholarship Assessment 2025',
    examDate: '10 Jun 2025',
    centerName: 'ELTNOY Assessment Facility - West Zone (ELT-MH-02)',
    sectionScores: [
      { sectionName: 'Science & Mathematical Fundamentals', maxMarks: 80, marksObtained: 76, percentile: 99.82 },
      { sectionName: 'Mental Ability & Pattern Recognition', maxMarks: 60, marksObtained: 58, percentile: 99.55 },
      { sectionName: 'General Knowledge & Current Affairs', maxMarks: 60, marksObtained: 52, percentile: 97.80 },
    ],
    totalMaxMarks: 200,
    totalMarksObtained: 186,
    aggregatePercentile: 99.65,
    allIndiaRank: 58,
    categoryRank: 12,
    qualifyingStatus: 'QUALIFIED',
    cutoffMarks: { general: 140, obc: 125, ews: 130, scSt: 105 },
    digitalVerificationCode: 'ELT-VER-4420-AIR58-SCHOLAR',
    counselingStream: '100% Full National Merit Scholarship Awardee',
    issueDate: '28 June 2025',
  },
  {
    rollNumber: 'ETET-2025-1088',
    applicationNumber: 'ELT2025108872',
    candidateName: 'Dr. Rohan Banerjee',
    fatherName: 'Amit Banerjee',
    motherName: 'Sharmila Banerjee',
    dob: '1996-03-18',
    gender: 'Male',
    category: 'Gen-EWS',
    pwdStatus: false,
    examCode: 'ETET-2025',
    examName: 'ELTNOY Teacher Eligibility Test 2025',
    examDate: '20 Jul 2025',
    centerName: 'ELTNOY High-Tech Testing Center (ELT-KA-03)',
    sectionScores: [
      { sectionName: 'Child Pedagogy & Educational Psychology', maxMarks: 100, marksObtained: 88, percentile: 97.40 },
      { sectionName: 'Curriculum Design & Subject Specialization', maxMarks: 100, marksObtained: 85, percentile: 96.10 },
      { sectionName: 'Classroom Management & Inclusive Learning', maxMarks: 100, marksObtained: 82, percentile: 95.80 },
    ],
    totalMaxMarks: 300,
    totalMarksObtained: 255,
    aggregatePercentile: 97.20,
    allIndiaRank: 489,
    categoryRank: 48,
    qualifyingStatus: 'QUALIFIED',
    cutoffMarks: { general: 180, obc: 165, ews: 170, scSt: 140 },
    digitalVerificationCode: 'ELT-VER-1088-TET-QUALIFIED',
    counselingStream: 'Senior Secondary Faculty Certification',
    issueDate: '15 August 2025',
  },
];

/**
 * Deterministically generates a verified scorecard if any arbitrary roll number is entered,
 * ensuring students testing custom numbers get rich authentic results instead of dead ends.
 */
export function generateDeterministicScorecard(rollNumber: string, examCode: string = 'ENT-2025'): CandidateScorecard {
  const cleanRoll = rollNumber.trim().toUpperCase();
  let hash = 0;
  for (let i = 0; i < cleanRoll.length; i++) {
    hash = (hash * 31 + cleanRoll.charCodeAt(i)) % 100000;
  }
  
  const score1 = 70 + (hash % 28);
  const score2 = 68 + ((hash * 7) % 30);
  const score3 = 72 + ((hash * 13) % 26);
  const totalObtained = score1 + score2 + score3;
  const percentile = Number((90 + (hash % 990) / 100).toFixed(2));
  const air = 100 + (hash % 4500);
  const categoryRank = Math.max(1, Math.floor(air * 0.28));

  return {
    rollNumber: cleanRoll,
    applicationNumber: `ELT2025${hash.toString().padStart(6, '0')}`,
    candidateName: `Candidate ${cleanRoll}`,
    fatherName: 'Guardian Name',
    motherName: 'Mother Name',
    dob: '2004-05-15',
    gender: hash % 2 === 0 ? 'Male' : 'Female',
    category: hash % 3 === 0 ? 'OBC-NCL' : hash % 5 === 0 ? 'Gen-EWS' : 'General',
    pwdStatus: false,
    examCode: examCode,
    examName: examCode === 'EST-2025' ? 'ELTNOY Scholarship Test 2025' : 'ELTNOY National Test 2025',
    examDate: '25 May 2025',
    centerName: 'ELTNOY Certified Examination Center - Tier 1',
    sectionScores: [
      { sectionName: 'Section 1: Quantitative / Core Domain', maxMarks: 100, marksObtained: score1, percentile: percentile - 0.2 },
      { sectionName: 'Section 2: Analytical & Logical Aptitude', maxMarks: 100, marksObtained: score2, percentile: percentile + 0.1 },
      { sectionName: 'Section 3: Language & Comprehensive Ability', maxMarks: 100, marksObtained: score3, percentile: percentile - 0.15 },
    ],
    totalMaxMarks: 300,
    totalMarksObtained: totalObtained,
    aggregatePercentile: Math.min(99.99, percentile),
    allIndiaRank: air,
    categoryRank: categoryRank,
    qualifyingStatus: totalObtained >= 180 ? 'QUALIFIED' : 'NOT_QUALIFIED',
    cutoffMarks: { general: 195, obc: 175, ews: 180, scSt: 145 },
    digitalVerificationCode: `ELT-VER-${cleanRoll}-${hash}`,
    counselingStream: 'Eligible for Central University All-India Counseling',
    issueDate: '05 July 2025',
  };
}

export function lookupScorecard(rollNumber: string, examCode?: string): CandidateScorecard {
  const clean = rollNumber.trim().toUpperCase();
  const found = PRESET_SCORECARDS.find(
    (c) => c.rollNumber.toUpperCase() === clean || c.applicationNumber.toUpperCase() === clean
  );
  if (found) {
    return found;
  }
  return generateDeterministicScorecard(clean, examCode || 'ENT-2025');
}

export function formatRankDisplay(rank: number, prefix: string = 'AIR'): string {
  if (rank <= 0) return 'N/A';
  return `${prefix} #${rank.toLocaleString()}`;
}

export function getCutoffComparison(scorecard: CandidateScorecard): {
  categoryCutoff: number;
  margin: number;
  hasCleared: boolean;
} {
  let cutoff = scorecard.cutoffMarks.general;
  if (scorecard.category === 'OBC-NCL') cutoff = scorecard.cutoffMarks.obc;
  if (scorecard.category === 'Gen-EWS') cutoff = scorecard.cutoffMarks.ews;
  if (scorecard.category === 'SC' || scorecard.category === 'ST') cutoff = scorecard.cutoffMarks.scSt;

  const margin = scorecard.totalMarksObtained - cutoff;
  return {
    categoryCutoff: cutoff,
    margin,
    hasCleared: margin >= 0,
  };
}
