import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DashboardSectionLoader,
  getDashboardSectionContentState,
  type DashboardSectionStatusMap,
} from './dashboardData.js';

test('missing dashboard section data stays loading until a request succeeds', () => {
  assert.equal(getDashboardSectionContentState(undefined), 'loading');
  assert.equal(getDashboardSectionContentState({ state: 'loading' }), 'loading');
  assert.equal(getDashboardSectionContentState({ state: 'error', error: 'unavailable' }), 'error');
  assert.equal(getDashboardSectionContentState({ state: 'success' }), 'success');
});

test('dashboard sections load independently and failed sections can be retried', async () => {
  let data: Record<string, unknown> = {};
  let statuses: DashboardSectionStatusMap = {};
  let applicationAttempts = 0;
  const loader = new DashboardSectionLoader(
    (update) => { data = { ...data, ...update }; },
    (update) => { statuses = update(statuses); },
  );

  await Promise.all([
    loader.load('applications', async () => {
      applicationAttempts += 1;
      throw new Error('Applications unavailable.');
    }),
    loader.load('feedback', async () => ({ feedback: [{ id: 'ticket-1' }] })),
  ]);

  assert.deepEqual(data.feedback, [{ id: 'ticket-1' }]);
  assert.equal('applications' in data, false);
  assert.deepEqual(statuses.applications, {
    state: 'error',
    error: 'Applications unavailable.',
  });
  assert.deepEqual(statuses.feedback, { state: 'success' });

  await loader.load('applications', async () => {
    applicationAttempts += 1;
    return { applications: [{ id: 'application-1' }] };
  });

  assert.equal(applicationAttempts, 2);
  assert.deepEqual(data.applications, [{ id: 'application-1' }]);
  assert.deepEqual(statuses.applications, { state: 'success' });
});

test('dashboard section loader deduplicates concurrent requests', async () => {
  let data: Record<string, unknown> = {};
  let statuses: DashboardSectionStatusMap = {};
  let requestCount = 0;
  let resolveRequest!: (value: Record<string, unknown>) => void;
  const requestResult = new Promise<Record<string, unknown>>((resolve) => {
    resolveRequest = resolve;
  });
  const loader = new DashboardSectionLoader(
    (update) => { data = { ...data, ...update }; },
    (update) => { statuses = update(statuses); },
  );
  const request = async () => {
    requestCount += 1;
    return requestResult;
  };

  const first = loader.load('results', request);
  const duplicate = loader.load('results', request);
  resolveRequest({ results: [] });
  await Promise.all([first, duplicate]);

  assert.equal(requestCount, 1);
  assert.deepEqual(statuses.results, { state: 'success' });
  assert.deepEqual(data.results, []);
});

test('dashboard section loader ignores stale results after reset', async () => {
  let data: Record<string, unknown> = {};
  let statuses: DashboardSectionStatusMap = {};
  let resolveRequest!: (value: Record<string, unknown>) => void;
  const requestResult = new Promise<Record<string, unknown>>((resolve) => {
    resolveRequest = resolve;
  });
  const loader = new DashboardSectionLoader(
    (update) => { data = { ...data, ...update }; },
    (update) => { statuses = update(statuses); },
  );
  const pending = loader.load('official:applications', () => requestResult);

  loader.reset();
  resolveRequest({ applications: ['stale'] });
  await pending;

  assert.deepEqual(data, {});
  assert.deepEqual(statuses, {});
});
