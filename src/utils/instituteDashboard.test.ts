import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstituteDashboardStats,
  parseInstituteDashboardSummary,
  recentMonthKeys,
} from './instituteDashboard.ts';

// Synthetic data only. 2026-11-15 12:00 IST.
const NOW = new Date('2026-11-15T06:30:00Z');

const serverSummary = {
  totalCheckins: '812',
  checkinStatuses: { verified: '400', admitted: '300', flagged: '70', rejected: '42' },
  approvedForms: '230',
  pendingForms: '5',
  monthlyCheckins: [
    { month: '2026-06', count: '100' },
    { month: '2026-09', count: '212' },
    { month: '2026-11', count: '500' },
  ],
};

const checkinRows = (count: number, status = 'verified', updatedAt = '2026-11-10T05:00:00Z') =>
  Array.from({ length: count }, (_, index) => ({ id: `c${index}`, status, updated_at: updatedAt }));

test('the server summary wins over the capped lists, so totals past 500 check-ins are exact', () => {
  const stats = buildInstituteDashboardStats({
    summary: serverSummary,
    forms: [{ status: 'approved' }],
    checkins: checkinRows(500),
    workspaceState: 'success',
    checkinsState: 'success',
    now: NOW,
  });
  assert.equal(stats.checkins?.total, 812);
  assert.deepEqual(stats.checkins?.statuses, { verified: 400, admitted: 300, flagged: 70, rejected: 42 });
  assert.deepEqual(stats.forms, { approved: 230, pending: 5 });
  assert.deepEqual(stats.checkins?.months, [
    { key: '2026-06', value: 100 },
    { key: '2026-07', value: 0 },
    { key: '2026-08', value: 0 },
    { key: '2026-09', value: 212 },
    { key: '2026-10', value: 0 },
    { key: '2026-11', value: 500 },
  ]);
});

test('check-in figures still come from the summary when only the check-in list failed', () => {
  const stats = buildInstituteDashboardStats({
    summary: serverSummary, forms: [], checkins: [], workspaceState: 'success', checkinsState: 'error', now: NOW,
  });
  assert.equal(stats.checkins?.total, 812);
});

test('a failed or loading section gives null figures, never a misleading zero', () => {
  for (const state of ['error', 'loading'] as const) {
    const stats = buildInstituteDashboardStats({
      summary: serverSummary, forms: [], checkins: [], workspaceState: state, checkinsState: state, now: NOW,
    });
    assert.equal(stats.checkins, null, `checkins while ${state}`);
    assert.equal(stats.forms, null, `forms while ${state}`);
  }
});

test('without the workspace, check-ins fall back to the list and forms stay unknown', () => {
  const stats = buildInstituteDashboardStats({
    summary: undefined,
    forms: [],
    checkins: [...checkinRows(3), ...checkinRows(2, 'flagged', '2026-09-01T05:00:00Z')],
    workspaceState: 'error',
    checkinsState: 'success',
    now: NOW,
  });
  assert.equal(stats.forms, null);
  assert.equal(stats.checkins?.total, 5);
  assert.deepEqual(stats.checkins?.statuses, { verified: 3, admitted: 0, flagged: 2, rejected: 0 });
  assert.equal(stats.checkins?.months.find((month) => month.key === '2026-09')?.value, 2);
  assert.equal(stats.checkins?.months.find((month) => month.key === '2026-11')?.value, 3);
});

test('a missing or malformed summary falls back to the lists', () => {
  const forms = [{ status: 'approved' }, { status: 'Pending' }, { status: 'pending' }, { status: 'rejected' }];
  for (const summary of [
    undefined,
    null,
    {},
    { ...serverSummary, totalCheckins: '-1' },
    { ...serverSummary, approvedForms: '1.5' },
    { ...serverSummary, pendingForms: 'many' },
    { ...serverSummary, checkinStatuses: { ...serverSummary.checkinStatuses, flagged: undefined } },
    { ...serverSummary, monthlyCheckins: [{ month: 'Nov', count: '1' }] },
    { ...serverSummary, monthlyCheckins: 'none' },
  ]) {
    assert.equal(parseInstituteDashboardSummary(summary), null, JSON.stringify(summary));
    const stats = buildInstituteDashboardStats({
      summary, forms, checkins: checkinRows(2), workspaceState: 'success', checkinsState: 'success', now: NOW,
    });
    assert.deepEqual(stats.forms, { approved: 1, pending: 2 });
    assert.equal(stats.checkins?.total, 2);
  }
});

test('summary counts accept numbers as well as Postgres text counts', () => {
  const summary = parseInstituteDashboardSummary({
    ...serverSummary, totalCheckins: 7, monthlyCheckins: [{ month: '2026-11', count: 7 }],
  });
  assert.equal(summary?.totalCheckins, 7);
  assert.equal(summary?.monthlyCheckins.get('2026-11'), 7);
});

test('the six months are IST months, oldest first, across a year boundary', () => {
  assert.deepEqual(recentMonthKeys(new Date('2026-02-10T00:00:00Z')),
    ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
  // 30 Nov 19:00 UTC is already 1 Dec in India.
  assert.equal(recentMonthKeys(new Date('2026-11-30T19:00:00Z')).at(-1), '2026-12');
});

test('Attendance register shows the check-in time from the server row (updated_at), never a blank "—"', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { InstituteAdvancedSection } = await import('../components/InstituteAdvancedSection.tsx');
  // Exactly the columns centerCheckinsQuery returns (server/authorizationQueries.ts).
  const row = {
    id: 'c1', status: 'verified', note: null, updated_at: '2026-11-23T04:15:00Z',
    application_number: 'APP100001', candidate_name: 'Synthetic Candidate', exam_code: 'DEMO-EXAM-1', roll_number: 'R5000',
  };
  const html = renderToStaticMarkup(React.createElement(InstituteAdvancedSection, {
    sectionId: 'institute-attendance', centerCode: 'DEMO-CENTER-01', forms: [], checkins: [row], summary: undefined,
    workspaceState: 'success', checkinsState: 'success', onCreateForm: () => undefined, onOpenCheckins: () => undefined,
  }));
  const cells = [...html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((match) => match[1].replace(/<[^>]+>/g, ''));
  const time = cells[3];
  assert.notEqual(time, '—', 'the check-in time is shown');
  assert.match(time, /23 Nov 2026/);
  assert.match(time, /09:45/, '04:15 UTC is 09:45 in India');
});
