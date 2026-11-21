import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { request as httpRequest } from 'node:http';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

const LOCAL_SURFACE_HOSTS = {
  marketing: 'marketing.127.0.0.1.nip.io',
  exam: 'exam.127.0.0.1.nip.io',
  institution: 'institution.127.0.0.1.nip.io',
  admin: 'admin.127.0.0.1.nip.io',
} as const;
const localSurfaceHostSet = new Set(Object.values(LOCAL_SURFACE_HOSTS));

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
      allowedHosts: Object.values(LOCAL_SURFACE_HOSTS),
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
