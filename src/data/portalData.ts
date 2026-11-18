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
