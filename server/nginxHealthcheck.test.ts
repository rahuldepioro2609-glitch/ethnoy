import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const nginxConfig = await readFile(new URL('../deploy/nginx/default.conf.template', import.meta.url), 'utf8');
const composeConfig = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');

test('Nginx health endpoint returns 200 only to the container loopback', () => {
  const healthLocation = nginxConfig.match(/location = \/_internal-health \{([\s\S]*?)\n    \}/)?.[1];

  assert.ok(healthLocation, 'expected an exact-match internal health location');
  assert.match(healthLocation, /allow 127\.0\.0\.1;/);
  assert.match(healthLocation, /deny all;/);
  assert.match(healthLocation, /return 200 "ok\\n";/);
});

test('Compose probes the internal health endpoint without disabling TLS checks', () => {
  assert.match(composeConfig, /http:\/\/127\.0\.0\.1:8080\/_internal-health/);
  assert.doesNotMatch(composeConfig, /--no-check-certificate|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*0/);
});

test('normal HTTP requests still redirect to HTTPS and TLS policy remains enabled', () => {
  assert.match(nginxConfig, /location \/ \{\s*return 301 https:\/\/\$\{APP_HOSTNAME\}\$request_uri;/);
  assert.match(nginxConfig, /listen 8443 ssl;/);
  assert.match(nginxConfig, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
});
