/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FAQItem {
  id: string;
  category: 'admit-card' | 'cbt-exam' | 'registration' | 'scoring' | 'centers';
  categoryLabel: string;
  question: string;
  answer: string;
  keyPoints?: string[];
  actionLink?: {
    label: string;
    actionId: 'admit-card' | 'cbt-mock' | 'apply' | 'grievance' | 'centers';
  };
}

export const FAQ_ITEMS: FAQItem[] = [
  {
    id: 'faq-01',
    category: 'admit-card',
    categoryLabel: 'Admit Card & Hall Ticket',
    question: 'How do I download my ELTNOY Admit Card / Hall Ticket?',
    answer: 'Candidates can download their official Admit Card from the portal by selecting their registered examination, entering their Application Number (e.g., NEA-2026-88419), and entering their Date of Birth in YYYY-MM-DD format.',
    keyPoints: [
      'Ensure your digital QR code and roll number are legible on the printout.',
      'Print at least 2 clear copies on A4 paper (laser print recommended).',
      'Verify test venue address, reporting shift time, and gate closing hour.',
    ],
    actionLink: {
      label: 'Download Admit Card Now',
      actionId: 'admit-card',
    },
  },
  {
    id: 'faq-02',
    category: 'cbt-exam',
    categoryLabel: 'CBT Exam Simulator',
    question: 'What is the question palette color coding in the Computer Based Test (CBT)?',
    answer: 'The CBT terminal uses standardized color indicators in the right-hand Question Palette to track your test progress in real-time:',
    keyPoints: [
      'Green (Answered): You have selected and saved an option response.',
      'Red (Not Answered): You visited the question but did not save an option.',
      'Purple (Marked for Review): Question flagged for re-checking.',
      'Gray (Not Visited): Question has not yet been opened.',
    ],
    actionLink: {
      label: 'Try CBT Mock Test Simulator',
      actionId: 'cbt-mock',
    },
  },
  {
    id: 'faq-03',
    category: 'scoring',
    categoryLabel: 'Marking Scheme & Results',
    question: 'What is the official marking scheme for the ELTNOY National Examination?',
    answer: 'The examination follows a standardized +4 / -1 negative marking system for multiple-choice questions to reward accuracy and deter random guessing.',
    keyPoints: [
      '+4 Marks awarded for every correct answer option.',
      '-1 Mark deducted for every incorrect response.',
      '0 Marks for unattempted or skipped questions.',
      'Questions Marked for Review with an answered option are evaluated in final scoring.',
    ],
  },
  {
    id: 'faq-04',
    category: 'cbt-exam',
    categoryLabel: 'CBT Exam Simulator',
    question: 'Is an on-screen scientific calculator available during the examination?',
    answer: 'Yes. An on-screen virtual non-programmable scientific calculator is provided in the top header bar of the CBT exam terminal for sections requiring mathematical computation (Physics, Mathematics, General Aptitude). Physical calculators and smart devices are strictly prohibited inside the center.',
    keyPoints: [
      'Supports logarithmic, exponential, trigonometric, and root functions.',
      'Accessible anytime via the top right keypad icon in the examination window.',
    ],
    actionLink: {
      label: 'Launch Practice Simulator',
      actionId: 'cbt-mock',
    },
  },
  {
    id: 'faq-05',
    category: 'centers',
    categoryLabel: 'Test Centers & Rules',
    question: 'What documents are mandatory to carry to the allotted examination center?',
    answer: 'Entry to the examination hall is granted only upon strict physical and biometric verification. Candidates must carry:',
    keyPoints: [
      'Hard copy of ELTNOY Printed Admit Card with clear candidate photograph.',
      'Original valid government photo ID (Aadhaar Card, Passport, Voter ID, or Driving License).',
      'One recent passport-size colored photograph matching the application upload.',
      'PWBD / Scribe certificate if seeking compensatory exam duration.',
    ],
    actionLink: {
      label: 'Locate Your Test Center',
      actionId: 'centers',
    },
  },
  {
    id: 'faq-06',
    category: 'cbt-exam',
    categoryLabel: 'CBT Exam Simulator',
    question: 'What happens if a workstation freezes or loses network during the test?',
    answer: 'The ELTNOY examination system operates with server-authoritative state synchronization. If a terminal freezes or suffers a hardware glitch:',
    keyPoints: [
      'Immediately notify the room invigilator without leaving your desk.',
      'The examination timer pauses on the central server the moment connection drops.',
      'You will be reassigned to a buffer workstation with 100% of your saved answers intact.',
      'Full compensatory duration is credited so you lose zero testing minutes.',
    ],
  },
  {
    id: 'faq-07',
    category: 'registration',
    categoryLabel: 'Registration & Eligibility',
    question: 'Can I edit my registration details after submitting the application?',
    answer: 'A dedicated 48-hour Application Correction Window opens after the regular registration deadline closes. During this period, candidates may update photograph, signature, and category details. Exam subject choices and primary email ID cannot be altered.',
    actionLink: {
      label: 'Apply for Examination',
      actionId: 'apply',
    },
  },
  {
    id: 'faq-08',
    category: 'scoring',
    categoryLabel: 'Marking Scheme & Results',
    question: 'How are multi-shift examination percentiles and normalizations calculated?',
    answer: 'When an examination is conducted across multiple shifts (Shift-I and Shift-II), raw scores are converted into NTA-standardized Percentile Scores using equipercentile normalization to ensure no candidate is disadvantaged by variations in shift difficulty levels.',
    keyPoints: [
      'Provisional answer keys are published within 72 hours of examination completion.',
      'Candidates can raise challenges online with supporting academic references.',
    ],
  },
];

/**
 * Filters FAQ list by category.
 */
export function filterFaqsByCategory(
  items: FAQItem[],
  category: string
): FAQItem[] {
  if (!category || category === 'all') {
    return items;
  }
  return items.filter((item) => item.category === category);
}

/**
 * Searches FAQs by question, answer, or category keyword.
 */
export function searchFaqs(items: FAQItem[], query: string): FAQItem[] {
  if (!query || query.trim() === '') {
    return items;
  }
  const q = query.toLowerCase().trim();
  return items.filter((item) => {
    const matchQuestion = item.question.toLowerCase().includes(q);
    const matchAnswer = item.answer.toLowerCase().includes(q);
    const matchCat = item.categoryLabel.toLowerCase().includes(q);
    const matchKeyPoints = item.keyPoints?.some((kp) => kp.toLowerCase().includes(q));
    return matchQuestion || matchAnswer || matchCat || Boolean(matchKeyPoints);
  });
}
