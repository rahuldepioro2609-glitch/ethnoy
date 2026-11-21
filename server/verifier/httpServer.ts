import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RequestRateLimiter } from './rateLimiter.js';
import type { SecurityEventLogger } from './securityEvents.js';

function respond(response: ServerResponse, status: number, body: { status: string }): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(serialized),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(serialized);
}

function routeOf(request: IncomingMessage): '/healthz' | '/readyz' | 'other' {
  if (request.url === '/healthz') return '/healthz';
  if (request.url === '/readyz') return '/readyz';
  return 'other';
}

export interface VerifierHttpDependencies {
  readonly logger: SecurityEventLogger;
  readonly ready: () => boolean;
  readonly limiter?: RequestRateLimiter;
}

export function handleVerifierRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: VerifierHttpDependencies,
  limiter: RequestRateLimiter,
): void {
  const route = routeOf(request);
  if (!limiter.allow(request.socket.remoteAddress)) {
    dependencies.logger.write({ event: 'request_rate_limited', outcome: 'failure', code: 'RATE_LIMITED', route });
    respond(response, 429, { status: 'rate_limited' });
    return;
  }
  if (route === 'other') {
    dependencies.logger.write({ event: 'request_rejected', outcome: 'failure', code: 'NOT_FOUND', route });
    respond(response, 404, { status: 'not_found' });
    return;
  }
  if (request.method !== 'GET') {
    dependencies.logger.write({
      event: 'request_rejected',
      outcome: 'failure',
      code: 'METHOD_NOT_ALLOWED',
      route,
    });
    respond(response, 405, { status: 'method_not_allowed' });
    return;
  }
  if (request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined) {
    dependencies.logger.write({ event: 'request_rejected', outcome: 'failure', code: 'BODY_NOT_ALLOWED', route });
    respond(response, 400, { status: 'invalid_request' });
    return;
  }
  if (route === '/healthz') {
    respond(response, 200, { status: 'ok' });
    return;
  }
  if (!dependencies.ready()) {
    respond(response, 503, { status: 'not_ready' });
    return;
  }
  respond(response, 200, { status: 'ready' });
}

export function createVerifierHttpServer(input: VerifierHttpDependencies): Server {
  const limiter = input.limiter ?? new RequestRateLimiter();
  return createServer((request, response) => handleVerifierRequest(request, response, input, limiter));
}
