/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import {
  validateFeedback,
  createFeedbackTicket,
  filterFeedbackEntries,
  INITIAL_MOCK_FEEDBACK,
  FeedbackEntry,
} from './feedbackLogic';

test('validateFeedback catches empty titles and short descriptions', () => {
  const emptyRes = validateFeedback({});
  assert.strictEqual(emptyRes.isValid, false);
  assert.ok(emptyRes.errors.title);
  assert.ok(emptyRes.errors.description);

  const shortRes = validateFeedback({
    title: 'Hi',
    description: 'too short',
  });
  assert.strictEqual(shortRes.isValid, false);
  assert.ok(shortRes.errors.title);
  assert.ok(shortRes.errors.description);

  const validRes = validateFeedback({
    title: 'Calculator button delay',
    description: 'Pressing square root in Physics section has latency.',
    email: 'student@example.com',
  });
  assert.strictEqual(validRes.isValid, true);
  assert.strictEqual(Object.keys(validRes.errors).length, 0);
});

test('validateFeedback verifies email syntax if provided', () => {
  const invalidEmail = validateFeedback({
    title: 'Valid title here',
    description: 'This is a sufficiently long description of the issue.',
    email: 'not-an-email',
  });
  assert.strictEqual(invalidEmail.isValid, false);
  assert.ok(invalidEmail.errors.email);

  const validEmail = validateFeedback({
    title: 'Valid title here',
    description: 'This is a sufficiently long description of the issue.',
    email: 'valid.student@eltnoy.org',
  });
  assert.strictEqual(validEmail.isValid, true);
});

test('createFeedbackTicket generates proper ID prefix and initial status', () => {
  const ticket = createFeedbackTicket({
    type: 'bug',
    title: 'CBT Timer display flickering',
    description: 'Timer seconds jump between 14:59 and 15:00 repeatedly.',
    module: 'Online CBT Exam Simulator',
    priority: 'high',
    rating: 2,
    candidateName: 'Test Student',
  });

  assert.ok(ticket.id.startsWith('FB-'));
  assert.strictEqual(ticket.status, 'under_review');
  assert.strictEqual(ticket.type, 'bug');
  assert.ok(ticket.createdAt);
});

test('filterFeedbackEntries filters by type, status, and query correctly', () => {
  const entries: FeedbackEntry[] = [
    ...INITIAL_MOCK_FEEDBACK,
    {
      id: 'FB-2025-9999',
      type: 'other',
      title: 'Query about syllabus for chemistry',
      description: 'Is organic chemistry section weighted equally?',
      module: 'Examinations Syllabus',
      priority: 'low',
      status: 'resolved',
      createdAt: '2025-04-16T10:00:00.000Z',
    },
  ];

  // Filter by type 'bug'
  const bugOnly = filterFeedbackEntries(entries, { type: 'bug' });
  assert.ok(bugOnly.every((e) => e.type === 'bug'));

  // Filter by status 'resolved'
  const resolvedOnly = filterFeedbackEntries(entries, { status: 'resolved' });
  assert.ok(resolvedOnly.every((e) => e.status === 'resolved'));

  // Search keyword 'calculator'
  const calcSearch = filterFeedbackEntries(entries, { query: 'calculator' });
  assert.strictEqual(calcSearch.length, 1);
  assert.strictEqual(calcSearch[0].id, 'FB-2025-1042');
});
