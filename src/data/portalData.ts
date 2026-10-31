/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MockQuestion } from '../utils/examLogic';

export interface ExamItem {
  id: string;
  code: string;
  name: string;
  category: 'Undergraduate' | 'Scholarship' | 'Teacher' | 'Professional';
  targetAudience: string;
  day: string;
  month: string;
  regStart: string;
  regEnd: string;
  examDate: string;
  timeZone?: string;
  fee: string;
  status: 'Apply Now' | 'Apply Soon';
  isButtonActive: boolean;
  duration: string;
  mode: string;
  shifts: string;
  syllabusHighlights: string[];
}

export interface NoticeItem {
  id: string;
  day: string;
  month: string;
  title: string;
  date: string;
  category: 'Registration' | 'Admit Card' | 'Answer Key' | 'Result' | 'Circular';
  isNew: boolean;
  summary: string;
  fullContent: string;
  refNo: string;
  fileSize?: string;
}

export interface TestCenter {
  id: string;
  code: string;
  name: string;
  state: string;
  city: string;
  address: string;
  capacity: number;
  hasWheelchairAccess: boolean;
  biometricStations: number;
}

export const TEST_CENTERS: TestCenter[] = [
  {
    id: 'c-01',
    code: 'ELT-DL-01',
    name: 'ELTNOY Examination Complex - North Zone',
    state: 'Delhi NCR',
    city: 'New Delhi',
    address: 'Plot 14-B, Institutional Area, Sector 62, New Delhi - 110001',
    capacity: 750,
    hasWheelchairAccess: true,
    biometricStations: 8,
  },
  {
    id: 'c-02',
    code: 'ELT-MH-02',
    name: 'ELTNOY Assessment Facility - West Zone',
    state: 'Maharashtra',
    city: 'Mumbai',
    address: 'Campus Gate 3, Vidyanagari, Santacruz East, Mumbai - 400098',
    capacity: 600,
    hasWheelchairAccess: true,
    biometricStations: 6,
  },
  {
    id: 'c-03',
    code: 'ELT-KA-03',
    name: 'ELTNOY High-Tech Testing Center',
    state: 'Karnataka',
    city: 'Bengaluru',
    address: '8th Mile, Peenya Industrial Area, Bengaluru - 560057',
    capacity: 850,
    hasWheelchairAccess: true,
    biometricStations: 10,
  },
];

export interface QuickLinkGridItem {
  id: string;
  title: string;
  iconType: 'registration' | 'student-login' | 'admit-card' | 'answer-key' | 'result' | 'institute-login';
  bgColor: string;
  borderColor: string;
  textColor: string;
  iconBg: string;
  actionId: string;
}

export interface HeroActionRailItem {
  id: string;
  title: string;
  description: string;
  iconType: 'application' | 'admit-card' | 'cbt-exam' | 'answer-key' | 'institute-dashboard';
  iconColor: string;
  iconBg: string;
  actionId: string;
}

export const EXAMINATIONS: ExamItem[] = [
  {
    id: 'eltnoy-national-test',
    code: 'ENT-2025',
    name: 'ELTNOY National Test 2025',
    category: 'Undergraduate',
    targetAudience: 'Under Graduate Entrance Exam',
    day: '25',
    month: 'MAY',
    regStart: '15 Apr 2025',
    regEnd: '15 May 2025',
    examDate: '25 May 2025',
    fee: '₹1,500 / $25',
    status: 'Apply Now',
    isButtonActive: true,
    duration: '180 Minutes (3 Hours)',
    mode: 'Online Computer Based Test (CBT)',
    shifts: 'Shift 1 (09:00 - 12:00) & Shift 2 (02:00 - 05:00)',
    syllabusHighlights: [
      'Quantitative Aptitude & Mathematics',
      'Logical & Critical Analytical Reasoning',
      'Language Comprehension & Core Sciences',
    ],
  },
  {
    id: 'eltnoy-scholarship-test',
    code: 'EST-2025',
    name: 'ELTNOY Scholarship Test 2025',
    category: 'Scholarship',
    targetAudience: 'For Class 10th - 12th Students',
    day: '10',
    month: 'JUN',
    regStart: '20 Apr 2025',
    regEnd: '30 May 2025',
    examDate: '10 Jun 2025',
    fee: '₹500 / $10 (100% Waiver for Merit)',
    status: 'Apply Now',
    isButtonActive: true,
    duration: '120 Minutes (2 Hours)',
    mode: 'Online Computer Based Test (CBT)',
    shifts: 'Single Shift (10:00 AM - 12:00 PM)',
    syllabusHighlights: [
      'Science & Mathematical Fundamentals',
      'Mental Ability & Pattern Recognition',
      'General Knowledge & Current Affairs',
    ],
  },
  {
    id: 'eltnoy-tet',
    code: 'ETET-2025',
    name: 'ELTNOY Teacher Eligibility Test 2025',
    category: 'Teacher',
    targetAudience: 'For Teaching Aspirants',
    day: '20',
    month: 'JUL',
    regStart: '01 Jun 2025',
    regEnd: '10 Jul 2025',
    examDate: '20 Jul 2025',
    fee: '₹1,200',
    status: 'Apply Soon',
    isButtonActive: false,
    duration: '150 Minutes (2.5 Hours)',
    mode: 'Online CBT Mode',
    shifts: 'Morning Shift (09:30 AM - 12:00 PM)',
    syllabusHighlights: [
      'Child Pedagogy & Educational Psychology',
      'Curriculum Design & Subject Specialization',
      'Classroom Management & Inclusive Learning',
    ],
  },
  {
    id: 'eltnoy-skill-assessment',
    code: 'ESAT-2025',
    name: 'ELTNOY Skill Assessment Test 2025',
    category: 'Professional',
    targetAudience: 'For Professional Courses',
    day: '15',
    month: 'AUG',
    regStart: '01 Jul 2025',
    regEnd: '05 Aug 2025',
    examDate: '15 Aug 2025',
    fee: '₹1,000',
    status: 'Apply Soon',
    isButtonActive: false,
    duration: '120 Minutes (2 Hours)',
    mode: 'Adaptive Online Examination',
    shifts: 'Flexible Remote / Center Shift',
    syllabusHighlights: [
      'Professional Domain Competency',
      'Technical Communication & Data Literacy',
      'Industry Problem Solving',
    ],
  },
];

export const NOTICES: NoticeItem[] = [
  {
    id: 'not-01',
    day: '15',
    month: 'Apr',
    title: 'Online Application for ELTNOY National Test 2025 has started.',
    date: '15 Apr 2025',
    category: 'Registration',
    isNew: true,
    summary: 'The registration window for the ELTNOY National Test 2025 is officially open for all undergraduate aspirants.',
    fullContent: `The ELTNOY Examination Directorate announces the commencement of online candidate registrations for the ELTNOY National Test 2025.
    
Candidates can register directly through the unified application portal by providing basic educational records, selecting their preferred exam centers, and uploading digital photographs.
    
Key Dates:
- Online application commencement: 15 April 2025
- Last date for fee submission: 15 May 2025 (11:59 PM)
- Admit Card release date: 20 May 2025
- Examination Date: 25 May 2025`,
    refNo: 'ELTNOY/ADM/2025/N-101',
  },
  {
    id: 'not-02',
    day: '12',
    month: 'Apr',
    title: 'Admit Card for ELTNOY Scholarship Test 2025 released.',
    date: '12 Apr 2025',
    category: 'Admit Card',
    isNew: true,
    summary: 'Hall tickets for students registered in Class 10th-12th scholarship assessment are available for digital download.',
    fullContent: `Admit cards for the ELTNOY Scholarship Test 2025 are available for download. Candidates must enter their registered Application Number and Date of Birth to view and print their Hall Ticket.
    
Verification instructions:
1. Carry a printed copy of the Admit Card to the center.
2. Ensure the QR code and candidate roll number are legible.
3. Bring valid student photo ID proof.`,
    refNo: 'ELTNOY/SCH/2025/AC-88',
  },
  {
    id: 'not-03',
    day: '10',
    month: 'Apr',
    title: 'Answer Key for ELTNOY Mock Test 2025 available now.',
    date: '10 Apr 2025',
    category: 'Answer Key',
    isNew: false,
    summary: 'Official answer keys with question-wise solutions and scoring criteria published for candidates who attempted the CBT mock test.',
    fullContent: `Subject expert committee has published the comprehensive master answer key for all sections of the ELTNOY CBT Mock Examination 2025. Candidates can compare their responses and verify correct option keys.`,
    refNo: 'ELTNOY/EVAL/2025/AK-44',
  },
  {
    id: 'not-04',
    day: '05',
    month: 'Apr',
    title: 'Result of ELTNOY Talent Test 2025 declared.',
    date: '05 Apr 2025',
    category: 'Result',
    isNew: false,
    summary: 'Scorecards and merit rank lists for the Talent Search 2025 are hosted live. Candidates may view individual subject percentiles.',
    fullContent: `The examination board is pleased to announce the verified results and state-wise rank cards for the ELTNOY Talent Test 2025. Digitally signed certificates can be saved to DigiLocker or printed directly.`,
    refNo: 'ELTNOY/RES/2025/TL-09',
  },
  {
    id: 'not-05',
    day: '01',
    month: 'Apr',
    title: 'Extension of last date for application - ELTNOY Entrance Exam 2025.',
    date: '01 Apr 2025',
    category: 'Circular',
    isNew: false,
    summary: 'Due to requests from educational institutes, the application deadline has been extended by one week.',
    fullContent: `In order to accommodate candidates from rural testing districts, the Competent Authority has extended the closing date for online application submission.`,
    refNo: 'ELTNOY/NOT/2025/EXT-02',
  },
];

export const HERO_ACTION_RAIL: HeroActionRailItem[] = [
  {
    id: 'har-1',
    title: 'Online Application',
    description: 'Apply in few simple steps',
    iconType: 'application',
    iconColor: 'text-emerald-500',
    iconBg: 'bg-emerald-50 border-emerald-100',
    actionId: 'apply',
  },
  {
    id: 'har-2',
    title: 'Admit Card',
    description: 'Download your hall ticket',
    iconType: 'admit-card',
    iconColor: 'text-sky-500',
    iconBg: 'bg-sky-50 border-sky-100',
    actionId: 'admit-card',
  },
  {
    id: 'har-3',
    title: 'Online CBT Exam',
    description: 'Take exam from anywhere',
    iconType: 'cbt-exam',
    iconColor: 'text-amber-500',
    iconBg: 'bg-amber-50 border-amber-100',
    actionId: 'cbt-mock',
  },
  {
    id: 'har-4',
    title: 'Answer Key & Result',
    description: 'Get results instantly',
    iconType: 'answer-key',
    iconColor: 'text-purple-500',
    iconBg: 'bg-purple-50 border-purple-100',
    actionId: 'results',
  },
  {
    id: 'har-5',
    title: 'Institute Dashboard',
    description: 'Manage your examinations',
    iconType: 'institute-dashboard',
    iconColor: 'text-teal-600',
    iconBg: 'bg-teal-50 border-teal-100',
    actionId: 'institute-login',
  },
];

export const QUICK_LINKS_TILES: QuickLinkGridItem[] = [
  {
    id: 'qg-1',
    title: 'New Registration',
    iconType: 'registration',
    bgColor: 'bg-[#F2FAF4]',
    borderColor: 'border-[#DCF0E2]',
    textColor: 'text-slate-800',
    iconBg: 'bg-emerald-100 text-emerald-600',
    actionId: 'apply',
  },
  {
    id: 'qg-2',
    title: 'Student Login',
    iconType: 'student-login',
    bgColor: 'bg-[#F0F7FF]',
    borderColor: 'border-[#DBECFE]',
    textColor: 'text-slate-800',
    iconBg: 'bg-blue-100 text-blue-600',
    actionId: 'login-student',
  },
  {
    id: 'qg-3',
    title: 'Admit Card',
    iconType: 'admit-card',
    bgColor: 'bg-[#F9F5FF]',
    borderColor: 'border-[#EADBFD]',
    textColor: 'text-slate-800',
    iconBg: 'bg-purple-100 text-purple-600',
    actionId: 'admit-card',
  },
  {
    id: 'qg-4',
    title: 'Answer Key',
    iconType: 'answer-key',
    bgColor: 'bg-[#FEF2F2]',
    borderColor: 'border-[#FEE2E2]',
    textColor: 'text-slate-800',
    iconBg: 'bg-rose-100 text-rose-500',
    actionId: 'answer-key',
  },
  {
    id: 'qg-5',
    title: 'Result',
    iconType: 'result',
    bgColor: 'bg-[#FFFBEB]',
    borderColor: 'border-[#FEF3C7]',
    textColor: 'text-slate-800',
    iconBg: 'bg-amber-100 text-amber-500',
    actionId: 'results',
  },
  {
    id: 'qg-6',
    title: 'Institute Login',
    iconType: 'institute-login',
    bgColor: 'bg-[#F0FDFA]',
    borderColor: 'border-[#CCFBF1]',
    textColor: 'text-slate-800',
    iconBg: 'bg-teal-100 text-teal-600',
    actionId: 'login-institute',
  },
];

export const MOCK_QUESTIONS: MockQuestion[] = [
  {
    id: 1,
    section: 'Physics',
    questionText: 'A parallel plate capacitor has capacitance C. If the distance between plates is doubled and dielectric of constant K = 4 is inserted, what is the new capacitance?',
    options: [
      { id: 'A', text: 'C / 2' },
      { id: 'B', text: '2C' },
      { id: 'C', text: '4C' },
      { id: 'D', text: '8C' },
    ],
    correctOptionId: 'B',
    explanation: 'C_new = (K * epsilon_0 * A) / (2 * d) = (4/2) * (epsilon_0 * A / d) = 2C.',
  },
  {
    id: 2,
    section: 'Physics',
    questionText: 'Which electromagnetic wave has the highest frequency in the electromagnetic spectrum?',
    options: [
      { id: 'A', text: 'X-rays' },
      { id: 'B', text: 'Ultraviolet rays' },
      { id: 'C', text: 'Gamma rays' },
      { id: 'D', text: 'Microwaves' },
    ],
    correctOptionId: 'C',
    explanation: 'Gamma rays have wavelengths shorter than 0.01 nm and frequencies above 30 EHz, making them the most energetic.',
  },
  {
    id: 3,
    section: 'Chemistry',
    questionText: 'What is the hybridization and geometric shape of the Xenon Tetrafluoride (XeF4) molecule?',
    options: [
      { id: 'A', text: 'sp3d2, Square Planar' },
      { id: 'B', text: 'sp3d, Trigonal Bipyramidal' },
      { id: 'C', text: 'sp3, Tetrahedral' },
      { id: 'D', text: 'sp3d2, Octahedral' },
    ],
    correctOptionId: 'A',
    explanation: 'XeF4 has 4 bonding pairs and 2 lone pairs on central Xe atom (Steric number 6 = sp3d2). Lone pairs are trans, yielding square planar geometry.',
  },
  {
    id: 4,
    section: 'General Aptitude',
    questionText: 'A train 180 meters long is traveling at a speed of 72 km/h. How many seconds does it take to cross an electric pole?',
    options: [
      { id: 'A', text: '7 seconds' },
      { id: 'B', text: '9 seconds' },
      { id: 'C', text: '12 seconds' },
      { id: 'D', text: '15 seconds' },
    ],
    correctOptionId: 'B',
    explanation: 'Speed = 72 * (5/18) = 20 m/s. Time = Distance / Speed = 180 / 20 = 9 seconds.',
  },
];
