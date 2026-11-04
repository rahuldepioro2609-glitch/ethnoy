// Tests for the API helpers used by the online exam screen. `fetch` is replaced with a stub;
// no network request is made.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, apiRequest, apiRequestWithMeta, onlineExamTransport } from '../api.js';

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withFetch(stub: FetchStub, run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return stub(input, init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('apiRequestWithMeta returns data, status and the server Date header', async () => {
  await withFetch(async () => json({ saved: true, savedAt: '2031-03-15T09:00:00.123Z' }, 200, { date: 'Sat, 15 Mar 2031 09:00:00 GMT' }), async () => {
    const result = await apiRequestWithMeta<{ saved: boolean }>('/x');
    assert.deepEqual(result, { data: { saved: true, savedAt: '2031-03-15T09:00:00.123Z' }, status: 200, serverDate: 'Sat, 15 Mar 2031 09:00:00 GMT' });
  });
});

test('apiRequestWithMeta puts the error body code and message on ApiError', async () => {
  await withFetch(async () => json({ error: 'Time is up for this exam.', code: 'answering_closed' }, 409), async () => {
    await assert.rejects(apiRequestWithMeta('/x'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'answering_closed');
      assert.equal(error.message, 'Time is up for this exam.');
      return true;
    });
  });
});

test('apiRequestWithMeta aborts after the timeout with a non-ApiError (treated as unconfirmed/retryable)', async () => {
  await withFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }), async () => {
    await assert.rejects(apiRequestWithMeta('/slow', {}, 20), (error: unknown) => !(error instanceof ApiError));
  });
});

test('online exam transport uses the existing endpoints, methods and request bodies', async () => {
  await withFetch(async () => json({}, 200), async (calls) => {
    await onlineExamTransport.start('EX 1');
    await onlineExamTransport.saveAnswers('EX 1', 'attempt-1', { 1: 'A' });
    await onlineExamTransport.submitAnswers('EX 1', 'attempt-1', { 1: 'A' });
    await onlineExamTransport.listExams();
    assert.deepEqual(calls.map((call) => [call.init?.method ?? 'GET', call.url]), [
      ['POST', '/api/online-exams/EX%201/start'],
      ['PATCH', '/api/online-exams/EX%201/attempt'],
      ['POST', '/api/online-exams/EX%201/submit'],
      ['GET', '/api/online-exams'],
    ]);
    assert.equal(calls[1].init?.body, JSON.stringify({ attemptId: 'attempt-1', responses: { 1: 'A' } }));
    assert.equal(calls[2].init?.body, JSON.stringify({ attemptId: 'attempt-1', responses: { 1: 'A' } }));
    assert.equal(calls[0].init?.credentials, 'same-origin');
  });
});

test('apiRequest behaviour is unchanged (message from body, status, no code required)', async () => {
  await withFetch(async () => json({ error: 'Nope.' }, 403), async () => {
    await assert.rejects(apiRequest('/x'), (error: unknown) => error instanceof ApiError && error.status === 403 && error.message === 'Nope.');
  });
  await withFetch(async () => json({ ok: 1 }), async () => {
    assert.deepEqual(await apiRequest('/x'), { ok: 1 });
  });
});
