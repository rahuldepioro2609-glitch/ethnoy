/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type FeedbackType = 'bug' | 'suggestion' | 'cbt_issue' | 'admit_card' | 'performance' | 'other';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';
export type FeedbackStatus = 'under_review' | 'in_progress' | 'resolved';

export interface FeedbackEntry {
  id: string; // e.g., FB-2025-4819
  type: FeedbackType;
  title: string;
  description: string;
  module: string;
  candidateName?: string;
  email?: string;
  applicationNumber?: string;
  priority: FeedbackPriority;
  rating?: number; // 1-5
  status: FeedbackStatus;
  createdAt: string;
  attachmentName?: string;
  resolutionNote?: string;
}

export const INITIAL_MOCK_FEEDBACK: FeedbackEntry[] = [
  {
    id: 'FB-2025-1042',
    type: 'cbt_issue',
    title: 'Scientific calculator keypad delay in Mock Test',
    description: 'When switching quickly between logarithm and square root calculations in the Physics section, button inputs experience a 1-second lag.',
    module: 'Online CBT Exam Simulator',
    candidateName: 'Aarav Sharma',
    email: 'aarav.sharma@example.com',
    applicationNumber: 'NEA-2026-88419',
    priority: 'medium',
    rating: 4,
    status: 'in_progress',
    createdAt: '2025-04-14T09:30:00.000Z',
    resolutionNote: 'Engineering team optimized event throttling for mathematical functions.',
  },
  {
    id: 'FB-2025-1089',
    type: 'suggestion',
    title: 'Add dark mode toggle for 3-hour examination sessions',
    description: 'During full-length 180-minute practice exams, prolonged white screen exposure strains eyesight. A high-contrast or dark mode option in the exam header would help.',
    module: 'Online CBT Exam Simulator',
    candidateName: 'Priya Patel',
    email: 'priya.patel@example.com',
    priority: 'low',
    rating: 5,
    status: 'under_review',
    createdAt: '2025-04-15T14:15:00.000Z',
  },
  {
    id: 'FB-2025-1120',
    type: 'bug',
    title: 'Admit Card PDF download center code text wrapping',
    description: 'Center address wraps abruptly on narrower print preview margins for Karnataka Center 03.',
    module: 'Admit Card Download',
    candidateName: 'Rohan Deshmukh',
    priority: 'high',
    rating: 3,
    status: 'resolved',
    createdAt: '2025-04-15T16:45:00.000Z',
    resolutionNote: 'Fixed print stylesheet padding and allowed flexible address line wraps.',
  },
];

const STORAGE_KEY = 'eltnoy_portal_feedback_store_v1';

/**
 * Loads feedback entries from localStorage if available, falling back to mock array.
 */
export function getStoredFeedbackEntries(): FeedbackEntry[] {
  if (typeof window === 'undefined') {
    return [...INITIAL_MOCK_FEEDBACK];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(INITIAL_MOCK_FEEDBACK));
      return [...INITIAL_MOCK_FEEDBACK];
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
    return [...INITIAL_MOCK_FEEDBACK];
  } catch {
    return [...INITIAL_MOCK_FEEDBACK];
  }
}

/**
 * Persists feedback entries array to localStorage.
 */
export function saveFeedbackEntries(entries: FeedbackEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    console.error('Failed to save feedback to localStorage', e);
  }
}

/**
 * Validates candidate feedback input before submission.
 */
export function validateFeedback(data: {
  title?: string;
  description?: string;
  type?: string;
  email?: string;
}): { isValid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!data.title || data.title.trim().length < 4) {
    errors.title = 'Title must be at least 4 characters long.';
  } else if (data.title.trim().length > 100) {
    errors.title = 'Title cannot exceed 100 characters.';
  }

  if (!data.description || data.description.trim().length < 10) {
    errors.description = 'Please provide at least 10 characters describing the issue or suggestion.';
  } else if (data.description.trim().length > 1000) {
    errors.description = 'Description cannot exceed 1000 characters.';
  }

  if (data.email && data.email.trim() !== '') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email.trim())) {
      errors.email = 'Please provide a valid email address.';
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Creates a new feedback ticket with a generated reference number.
 */
export function createFeedbackTicket(
  input: Omit<FeedbackEntry, 'id' | 'createdAt' | 'status'>
): FeedbackEntry {
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const now = new Date();
  const year = now.getFullYear();
  const id = `FB-${year}-${randomSuffix}`;

  return {
    ...input,
    id,
    status: 'under_review',
    createdAt: now.toISOString(),
  };
}

/**
 * Filters feedback list by category, status, or search keywords.
 */
export function filterFeedbackEntries(
  entries: FeedbackEntry[],
  filters: { type?: string; status?: string; query?: string }
): FeedbackEntry[] {
  return entries.filter((entry) => {
    if (filters.type && filters.type !== 'all' && entry.type !== filters.type) {
      return false;
    }
    if (filters.status && filters.status !== 'all' && entry.status !== filters.status) {
      return false;
    }
    if (filters.query && filters.query.trim() !== '') {
      const q = filters.query.toLowerCase().trim();
      const matchTitle = entry.title.toLowerCase().includes(q);
      const matchDesc = entry.description.toLowerCase().includes(q);
      const matchId = entry.id.toLowerCase().includes(q);
      const matchModule = entry.module.toLowerCase().includes(q);
      const matchAuthor = (entry.candidateName || '').toLowerCase().includes(q);
      return matchTitle || matchDesc || matchId || matchModule || matchAuthor;
    }
    return true;
  });
}
