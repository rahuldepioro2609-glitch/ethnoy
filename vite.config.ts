import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

const LOCAL_SURFACE_HOSTS = {
  marketing: 'marketing.127.0.0.1.nip.io',
  exam: 'exam.127.0.0.1.nip.io',
  institution: 'institution.127.0.0.1.nip.io',
  admin: 'admin.127.0.0.1.nip.io',
} as const;
const localSurfaceHostSet = new Set(Object.values(LOCAL_SURFACE_HOSTS));
const LIVE_INSTITUTION_ORIGIN = 'https://institution.eltnoy.com';
const LIVE_INSTITUTION_HOST = new URL(LIVE_INSTITUTION_ORIGIN).hostname;
const LIVE_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', LOCAL_SURFACE_HOSTS.institution]);
const livePreviewEnabled = process.env.ELTNOY_LOCAL_LIVE_PREVIEW === '1';

/** The live preview forwards only sign-in/session calls and institute GETs. All dashboard writes stay blocked. */
function livePreviewRequestAllowed(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD') {
    return pathname === '/api/auth/providers'
      || pathname === '/api/auth/me'
      || pathname === '/api/auth/verification'
      || pathname.startsWith('/api/center/');
  }
  if (method === 'POST') {
    return pathname === '/api/auth/login'
      || pathname === '/api/auth/verification/verify'
      || pathname === '/api/auth/verification/resend'
      || pathname === '/api/auth/logout';
  }
  return false;
}

function requestHostname(request: { headers: { host?: string } }): string | null {
  const host = request.headers.host;
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function localSurfaceApiProxy(): Plugin {
  return {
    name: 'eltnoy-local-surface-api-proxy',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api')) return next();

        const hostname = requestHostname(request);
        if (livePreviewEnabled && hostname && LIVE_PREVIEW_HOSTS.has(hostname)) {
          let pathname: string;
          try {
            if (!request.url.startsWith('/api/')) throw new Error('Invalid API path.');
            pathname = new URL(request.url, LIVE_INSTITUTION_ORIGIN).pathname;
            if (/%2f|%5c|%2e/i.test(request.url)) throw new Error('Encoded path separators are not allowed.');
          } catch {
            response.statusCode = 400;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({ error: 'Invalid API path.' }));
            return;
          }

          if (!livePreviewRequestAllowed(request.method ?? 'GET', pathname)) {
            response.statusCode = 403;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify({ error: 'Writes are disabled in this local live preview.', code: 'LOCAL_PREVIEW_READ_ONLY' }));
            return;
          }

          const headers: OutgoingHttpHeaders = { ...request.headers, host: LIVE_INSTITUTION_HOST };
          delete headers['x-eltnoy-original-host'];
          delete headers['x-forwarded-host'];
          delete headers['x-forwarded-for'];
          delete headers['x-forwarded-proto'];
          delete headers.forwarded;
          if (request.method === 'POST') headers.origin = LIVE_INSTITUTION_ORIGIN;
          if (typeof headers.referer === 'string') {
            try {
              const referer = new URL(headers.referer);
              if (LIVE_PREVIEW_HOSTS.has(referer.hostname)) {
                headers.referer = referer.pathname === '/dashboard/center'
                  ? `${LIVE_INSTITUTION_ORIGIN}/dashboard/center`
                  : `${LIVE_INSTITUTION_ORIGIN}/login/center`;
              }
            } catch {
              delete headers.referer;
            }
          }

          const proxyRequest = httpsRequest({
            hostname: LIVE_INSTITUTION_HOST,
            port: 443,
            method: request.method,
            path: request.url,
            headers,
          }, (upstream) => {
            response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.headers);
            upstream.pipe(response);
          });
          proxyRequest.setTimeout(20_000, () => proxyRequest.destroy(new Error('Live preview request timed out.')));
          proxyRequest.on('error', () => {
            if (response.headersSent) {
              response.destroy();
              return;
            }
            response.statusCode = 502;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify({ error: 'The live institute service could not be reached.' }));
          });
          response.on('close', () => {
            if (!response.writableEnded) proxyRequest.destroy();
          });
          request.pipe(proxyRequest);
          return;
        }

        if (!hostname || !localSurfaceHostSet.has(hostname as (typeof LOCAL_SURFACE_HOSTS)[keyof typeof LOCAL_SURFACE_HOSTS])) {
          response.statusCode = 421;
          response.end('Misdirected request.');
          return;
        }

        const isAdmin = hostname === LOCAL_SURFACE_HOSTS.admin;
        const port = isAdmin ? 4001 : 4000;
        const proxyRequest = httpRequest({
          host: isAdmin ? '::1' : '127.0.0.1',
          port,
          method: request.method,
          path: request.url,
          headers: {
            ...request.headers,
            host: hostname,
            'x-eltnoy-original-host': hostname,
            'x-forwarded-host': hostname,
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'http',
          },
        }, (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.headers);
          upstream.pipe(response);
        });

        proxyRequest.on('error', () => {
          if (!response.headersSent) {
            response.statusCode = 502;
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          }
          response.end('Local API server unavailable.');
        });
        response.on('close', () => {
          if (!response.writableEnded) proxyRequest.destroy();
        });
        request.pipe(proxyRequest);
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [localSurfaceApiProxy(), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '127.0.0.1',
      // Only local surface hostnames are accepted by the dev server. Public previews should use
      // the production proxy configuration so they cannot bypass the surface boundary.
      allowedHosts: [...Object.values(LOCAL_SURFACE_HOSTS), 'localhost'],
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
