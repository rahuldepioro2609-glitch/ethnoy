// Nginx health check (P1-D.2): the configurations Compose mounts (deploy/nginx/public.conf and
// admin.conf) and the Compose probes. The legacy single-host template is retained in the repository
// but is no longer mounted. Static checks only; no Nginx or Docker command is run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const configs = {
  public: await readFile(new URL('../deploy/nginx/public.conf', import.meta.url), 'utf8'),
  admin: await readFile(new URL('../deploy/nginx/admin.conf', import.meta.url), 'utf8'),
};
const tlsPolicy = await readFile(new URL('../deploy/nginx/includes/eltnoy-tls.conf', import.meta.url), 'utf8');
const composeConfig = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const activeCompose = composeConfig.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

test('Nginx health endpoint returns 200 only to the container loopback, on the HTTP default server', () => {
  for (const [name, config] of Object.entries(configs)) {
    const defaultServer = config.match(/server \{\s*listen 8080 default_server;([\s\S]*?)\n\}/)?.[1];
    assert.ok(defaultServer, `${name}: HTTP default server`);
    const healthLocation = defaultServer.match(/location = \/_internal-health \{([\s\S]*?)\n    \}/)?.[1];
    assert.ok(healthLocation, `${name}: exact-match internal health location`);
    assert.match(healthLocation, /allow 127\.0\.0\.1;/);
    assert.match(healthLocation, /deny all;/);
    assert.match(healthLocation, /return 200 "ok\\n";/);
    assert.doesNotMatch(healthLocation, /proxy_pass/);
  }
});

test('Compose probes each Nginx without a Host override and without disabling TLS checks', () => {
  const probes = activeCompose.match(/- wget [^\n]*/g) ?? [];
  assert.deepEqual(probes, [
    '- wget -q -O /dev/null http://127.0.0.1:8080/_internal-health',
    '- wget -q -O /dev/null http://127.0.0.1:8080/_internal-health',
  ], 'one probe per Nginx; Host 127.0.0.1:8080 reaches the default server');
  assert.doesNotMatch(activeCompose, /--header|Host:|APP_HOSTNAME|--no-check-certificate|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*0/);
  assert.doesNotMatch(activeCompose, /default\.conf\.template/, 'the legacy template is no longer mounted');
});

test('normal HTTP requests still redirect to HTTPS and TLS policy remains enabled', () => {
  assert.match(configs.public, /location \/ \{\s*return 301 https:\/\/exam\.eltnoy\.com\$request_uri;/);
  assert.match(configs.admin, /location \/ \{\s*return 301 https:\/\/admin\.eltnoy\.in\$request_uri;/);
  for (const config of Object.values(configs)) assert.match(config, /listen 8443 ssl;/);
  assert.match(tlsPolicy, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
});
