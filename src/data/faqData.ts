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
    question: 'How do I download my ELTNOY admit card?',
    answer: 'Sign in with your student account, open Admit Card, and enter the exam code, your application number (for example APP-2026-123456) and your date of birth. Admit cards appear only after the exam authority publishes your centre allocation.',
    keyPoints: [
      'Check that your photograph, signature and roll number are clearly printed.',
      'Print at least two clear copies on A4 paper.',
      'Check the venue address, reporting time and gate closing time.',
    ],
    actionLink: {
      label: 'Download admit card',
      actionId: 'admit-card',
    },
  },
  {
    id: 'faq-02',
    category: 'cbt-exam',
    categoryLabel: 'CBT Practice Test',
    question: 'What do the question palette colours mean in the CBT practice test?',
    answer: 'The palette on the right of the practice test shows the state of every question:',
    keyPoints: [
      'Green (Answered): you selected an option.',
      'Red (Not answered): you opened the question but did not select an option.',
      'Purple (Marked for review): you flagged the question to check again.',
      'Grey (Not visited): you have not opened the question yet.',
    ],
    actionLink: {
      label: 'Try the CBT practice test',
      actionId: 'cbt-mock',
    },
  },
  {
    id: 'faq-03',
    category: 'scoring',
    categoryLabel: 'Marking Scheme & Results',
    question: 'How is the practice test marked, and what about real exams?',
    answer: 'The practice test uses +4 for a correct answer, -1 for a wrong answer and 0 for a question you skip. Each real exam follows the marking scheme in its official notice; online exams on this portal award the marks shown with each question and do not deduct marks for wrong answers.',
    keyPoints: [
      'Practice test: +4 correct, -1 incorrect, 0 unattempted.',
      'Online exams: marks per question are shown next to each question.',
      'Always check the exam notice for the official marking scheme.',
    ],
  },
  {
    id: 'faq-04',
    category: 'cbt-exam',
    categoryLabel: 'CBT Practice Test',
    question: 'Is an on-screen calculator available?',
    answer: 'The practice test has a basic on-screen calculator (addition, subtraction, multiplication and division) in its top bar. Whether a calculator is allowed in a real exam is stated in that exam\'s notice. Physical calculators and phones are not allowed in exam centres.',
    keyPoints: [
      'Open it with the calculator button in the top bar of the practice test.',
      'It supports +, -, × and ÷ with decimals.',
    ],
    actionLink: {
      label: 'Open the practice test',
      actionId: 'cbt-mock',
    },
  },
  {
    id: 'faq-05',
    category: 'centers',
    categoryLabel: 'Test Centres & Rules',
    question: 'What must I bring to the exam centre?',
    answer: 'Centre staff check your identity against the photograph and signature on your application before you enter. Bring:',
    keyPoints: [
      'A printed copy of your ELTNOY admit card.',
      'An original, valid photo ID (Aadhaar card, passport, voter ID or driving licence).',
      'Any certificate the exam notice asks for, such as a PwBD or scribe certificate.',
    ],
    actionLink: {
      label: 'Find a test centre',
      actionId: 'centers',
    },
  },
  {
    id: 'faq-06',
    category: 'cbt-exam',
    categoryLabel: 'CBT Practice Test',
    question: 'What if my screen or connection freezes during an online exam?',
    answer: 'Your answers are saved to the server as you go, so you can reopen the exam from your dashboard and continue. The timer keeps running while you are disconnected, so reconnect as soon as you can.',
    keyPoints: [
      'At a centre, tell the invigilator immediately without leaving your seat.',
      'At home, reload the page or sign in again and choose "Resume exam".',
      'Answers saved before the freeze are kept.',
      'The exam ends at its scheduled time even if you were disconnected.',
    ],
  },
  {
    id: 'faq-07',
    category: 'registration',
    categoryLabel: 'Registration & Eligibility',
    question: 'Can I change my application after submitting it?',
    answer: 'Not online at present. If you made a mistake, contact the candidate helpdesk with your application number and the correction needed. Your account email can be changed from your dashboard.',
    actionLink: {
      label: 'Apply for an exam',
      actionId: 'apply',
    },
  },
  {
    id: 'faq-08',
    category: 'scoring',
    categoryLabel: 'Marking Scheme & Results',
    question: 'How do answer keys and objections work?',
    answer: 'After an exam, the exam authority publishes an answer key. While the objection window is open, candidates who applied can challenge any answer with a reason and a reference. Subject experts review every objection; a key may be changed or a question dropped.',
    keyPoints: [
      'There is no fee for filing an objection.',
      'You can file one objection per question.',
      'Decisions and expert remarks appear under "My objections".',
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
