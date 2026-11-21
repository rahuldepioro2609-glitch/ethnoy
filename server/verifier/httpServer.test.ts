import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVerifierRequest } from './httpServer.js';
import { RequestRateLimiter } from './rateLimiter.js';
import type { SecurityEvent } from './securityEvents.js';

function request(method: string, url: string) {
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function responseCapture() {
  const result: { status?: number; headers?: Record<string, string | number>; body?: string } = {};
  const response = {
    writeHead(status: number, headers: Record<string, string | number>) {
      result.status = status;
      result.headers = headers;
      return this;
    },
    end(body: string) {
      result.body = body;
      return this;
    },
  } as unknown as ServerResponse;
  return { result, response };
}

test('health and readiness expose only status, and unknown routes disclose no internals', () => {
  const events: SecurityEvent[] = [];
  const dependencies = {
    logger: { write(event: SecurityEvent) { events.push(event); } },
    ready: () => true,
  };
  const limiter = new RequestRateLimiter();
  const health = responseCapture();
  handleVerifierRequest(request('GET', '/healthz'), health.response, dependencies, limiter);
  assert.equal(health.result.status, 200);
  assert.deepEqual(JSON.parse(health.result.body!), { status: 'ok' });
  assert.equal(health.result.headers?.['Cache-Control'], 'no-store');

  const ready = responseCapture();
  handleVerifierRequest(request('GET', '/readyz'), ready.response, dependencies, limiter);
  assert.equal(ready.result.status, 200);
  assert.deepEqual(JSON.parse(ready.result.body!), { status: 'ready' });

  const missing = responseCapture();
  handleVerifierRequest(request('GET', '/credentials'), missing.response, dependencies, limiter);
  assert.equal(missing.result.status, 404);
  assert.deepEqual(JSON.parse(missing.result.body!), { status: 'not_found' });
  assert.equal(events.at(-1)?.code, 'NOT_FOUND');
});

test('readiness fails closed until an authentication persistence and proof consumer are wired', () => {
  const capture = responseCapture();
  handleVerifierRequest(request('GET', '/readyz'), capture.response, {
    logger: { write() {} },
    ready: () => false,
  }, new RequestRateLimiter());
  assert.equal(capture.result.status, 503);
  assert.deepEqual(JSON.parse(capture.result.body!), { status: 'not_ready' });
});

test('HTTP handler rejects request bodies and rate-limits unknown paths', () => {
  const events: SecurityEvent[] = [];
  const dependencies = {
    logger: { write(event: SecurityEvent) { events.push(event); } },
    ready: () => true,
  };
  const bodyRequest = request('GET', '/healthz');
  bodyRequest.headers['content-length'] = '1';
  const bodyResponse = responseCapture();
  handleVerifierRequest(bodyRequest, bodyResponse.response, dependencies, new RequestRateLimiter());
  assert.equal(bodyResponse.result.status, 400);

  const limiter = new RequestRateLimiter(1, 1000, 10);
  const first = responseCapture();
  handleVerifierRequest(request('GET', '/missing'), first.response, dependencies, limiter);
  const second = responseCapture();
  handleVerifierRequest(request('GET', '/missing'), second.response, dependencies, limiter);
  assert.equal(first.result.status, 404);
  assert.equal(second.result.status, 429);
});

test('rate limiter is bounded and enforces a fixed per-client request window', () => {
  const limiter = new RequestRateLimiter(2, 1000, 2);
  assert.equal(limiter.allow('127.0.0.1', 100), true);
  assert.equal(limiter.allow('127.0.0.1', 200), true);
  assert.equal(limiter.allow('127.0.0.1', 300), false);
  assert.equal(limiter.allow('127.0.0.1', 1200), true);
  assert.equal(limiter.allow('192.168.1.1', 1200), true);
  assert.equal(limiter.allow('10.0.0.1', 1200), false);
});
