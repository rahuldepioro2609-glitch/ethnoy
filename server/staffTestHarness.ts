// SM-1 test support: a minimal HTTP harness around the real staff routers. Portal (elt_session)
// sessions are answered by a stubbed pool that serves ONLY the auth_sessions lookup; any other
// database query throws, so staff code can never reach a database through the shared pool.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import { hashSessionToken, setTrustedRequestSurface } from './auth.js';
import { pool } from './db.js';
import { expectedOrigin, isSurface } from './surface.js';
import { VERIFIED_PORTAL_SESSION } from './authTestSupport.js';

export interface PortalPrincipal { token: string; id: string; role: 'candidate' | 'center' | 'official'; isSuperAdmin?: boolean; status?: string }

export function installPortalSessions(principals: PortalPrincipal[]): () => void {
  const byHash = new Map(principals.map((p) => [hashSessionToken(p.token), p]));
  const original = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = async (text: string, values?: unknown[]) => {
    if (typeof text === 'string' && text.includes('FROM auth_sessions')) {
      const principal = byHash.get(String(values?.[0]));
      return { rows: principal ? [{ id: principal.id, login_id: principal.id.toUpperCase(), display_name: principal.id, role: principal.role, account_status: principal.status ?? 'approved', is_super_admin: principal.isSuperAdmin === true, ...VERIFIED_PORTAL_SESSION }] : [] };
    }
    throw new Error(`unexpected database query in staff test: ${String(text).slice(0, 60)}`);
  };
  return () => { (pool as unknown as { query: unknown }).query = original; };
}

export async function startHarness(routers: Router[]): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  // Test stand-in for the P1-B gate: the surface comes from a test header (the real gate derives it
  // from the listener and validated host). Staff routers themselves never read it.
  app.use((request, _response, next) => {
    const surface = request.get('x-test-surface');
    if (isSurface(surface)) setTrustedRequestSurface(request, surface, expectedOrigin(surface));
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  for (const router of routers) app.use('/api', router);
  app.use((_request, response) => { response.status(404).json({ error: 'Route not found.' }); });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: 'test harness error', detail: error instanceof Error ? error.message : String(error) });
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export interface CallResult { status: number; body: Record<string, unknown>; setCookies: string[] }

export async function call(base: string, method: string, path: string, options: { surface?: string; cookie?: string; body?: unknown } = {}): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (options.surface) headers['x-test-surface'] = options.surface;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { raw: text }; }
  return { status: response.status, body, setCookies: response.headers.getSetCookie() };
}

export function cookieValue(setCookies: string[], name: string): string | undefined {
  const entry = setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  return entry?.split(';')[0].slice(name.length + 1);
}
