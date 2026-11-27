import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSearchParams, initialAuditFilters } from './auditLogSearch.ts';

test('the default search is the last seven days, today included', () => {
  const filters = initialAuditFilters(new Date('2026-11-27T09:30:00Z'));
  assert.equal(filters.from, '2026-11-21');
  assert.equal(filters.to, '2026-11-27');
  const params = auditSearchParams(filters, null);
  assert.equal(params.get('from'), '2026-11-21T00:00:00Z');
  assert.equal(params.get('to'), '2026-11-28T00:00:00.000Z', 'the end date is inclusive');
  assert.equal(params.get('limit'), '50');
});

test('empty filters are omitted, values are trimmed, and the cursor is passed through', () => {
  const params = auditSearchParams({ ...initialAuditFilters(new Date('2026-11-27T00:00:00Z')), category: 'finance', organizationId: '  inst-1 ', actorUserId: ' ' }, '2026-11-26T10:00:00.000123Z|00000000-0000-4000-8000-000000000001');
  assert.equal(params.get('category'), 'finance');
  assert.equal(params.get('organizationId'), 'inst-1');
  assert.equal(params.has('actorUserId'), false);
  assert.equal(params.has('action'), false);
  assert.ok(params.get('cursor'));
});
