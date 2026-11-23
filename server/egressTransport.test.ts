// Email egress: address parsing, optional adapter settings and the Resend adapter's egress setting.
// The proxy itself (deploy/nginx/resend-egress.conf) is checked statically here; its runtime
// behaviour was verified with Docker (Resend reachable only through it, other names refused).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseEgressAddress, postThroughEgress } from './egressTransport.js';
import * as providers from './verificationProviders.js';
import './verificationProviderAdapters.js';

test('parseEgressAddress: host:port only', () => {
  assert.deepEqual(parseEgressAddress('resend-egress:8443'), { host: 'resend-egress', port: 8443 });
  assert.deepEqual(parseEgressAddress(' Proxy.Internal:443 '), { host: 'proxy.internal', port: 443 });
  for (const bad of ['', 'resend-egress', ':8443', 'resend-egress:0', 'resend-egress:65536', 'https://resend-egress:8443',
    'resend-egress:8443/path', 'user@resend-egress:8443', '-bad:8443', 'resend egress:8443', 'resend-egress:84a3']) {
    assert.equal(parseEgressAddress(bad), null, bad);
  }
});

test('postThroughEgress: refuses plain http and an already aborted request without connecting', async () => {
  const egress = parseEgressAddress('127.0.0.1:1')!;
  await assert.rejects(postThroughEgress(egress, new URL('http://api.resend.com/emails'), {}, '{}', new AbortController().signal), /https/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(postThroughEgress(egress, new URL('https://api.resend.com/emails'), {}, '{}', aborted.signal), /aborted/);
});

async function withKeys(run: (paths: { otp: string; resend: string }) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'egress-test-'));
  try {
    const paths = { otp: join(dir, 'otp'), resend: join(dir, 'resend') };
    await writeFile(paths.otp, randomBytes(32).toString('hex'));
    await writeFile(paths.resend, `re_${randomBytes(16).toString('hex')}`);
    run(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('optional adapter settings: passed only when set; same naming rules as required settings', async () => {
  await withKeys((paths) => {
    let received: Record<string, string> | null = null;
    providers.registerEmailProviderAdapter('egress-optional', {
      settings: ['EGRESS_TEST_FROM'],
      optionalSettings: ['EGRESS_TEST_ROUTE'],
      create: (config) => { received = { ...config.settings }; return { name: 'x', sendVerificationCode: async () => undefined }; },
    });
    const base = { AUTH_EMAIL_PROVIDER: 'egress-optional', AUTH_OTP_HMAC_KEY_FILE: paths.otp, EGRESS_TEST_FROM: 'a@example.test' };
    assert.ok(providers.resolveVerificationServices(base).email);
    assert.deepEqual(received, { EGRESS_TEST_FROM: 'a@example.test' }, 'unset optional setting is absent');
    providers.resolveVerificationServices({ ...base, EGRESS_TEST_ROUTE: '  ' });
    assert.deepEqual(received, { EGRESS_TEST_FROM: 'a@example.test' }, 'blank optional setting is absent');
    providers.resolveVerificationServices({ ...base, EGRESS_TEST_ROUTE: 'proxy:1' });
    assert.deepEqual(received, { EGRESS_TEST_FROM: 'a@example.test', EGRESS_TEST_ROUTE: 'proxy:1' });

    const create = () => ({ name: 'x', sendVerificationCode: async () => undefined });
    for (const [label, optionalSettings] of [['credential word', ['EGRESS_API_KEY']], ['_FILE name', ['EGRESS_ROUTE_FILE']],
      ['duplicate of a required setting', ['EGRESS_TEST_FROM']], ['lower case', ['egress_route']]] as const) {
      const name = `egress-bad-${label.replace(/\W+/g, '-')}`;
      providers.registerEmailProviderAdapter(name, { settings: ['EGRESS_TEST_FROM'], optionalSettings, create });
      const result = providers.resolveVerificationServices({ ...base, AUTH_EMAIL_PROVIDER: name });
      assert.equal(result.email, null, label);
      assert.match(result.reasons.email ?? '', /declares its configuration incorrectly/, label);
    }
  });
});

test('Resend adapter: RESEND_EGRESS_ADDRESS is optional; an invalid value keeps email closed', async () => {
  await withKeys((paths) => {
    const env = { AUTH_EMAIL_PROVIDER: 'resend', AUTH_OTP_HMAC_KEY_FILE: paths.otp, RESEND_FROM_EMAIL: 'noreply@example.test', RESEND_API_KEY_FILE: paths.resend };
    assert.ok(providers.resolveVerificationServices(env).email, 'direct (local development)');
    assert.ok(providers.resolveVerificationServices({ ...env, RESEND_EGRESS_ADDRESS: 'resend-egress:8443' }).email, 'through the proxy');
    const invalid = providers.resolveVerificationServices({ ...env, RESEND_EGRESS_ADDRESS: 'https://resend-egress' });
    assert.equal(invalid.email, null);
    assert.equal(invalid.reasons.email, 'The email provider configuration is incomplete or invalid.');
  });
});

test('egress proxy configuration: TLS passthrough to api.resend.com only, on the port api_public uses', () => {
  const conf = readFileSync(new URL('../deploy/nginx/resend-egress.conf', import.meta.url), 'utf8');
  const active = conf.split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean).join('\n');
  assert.doesNotMatch(active, /\bhttp\s*\{/, 'no http block');
  assert.doesNotMatch(active, /ssl_certificate|proxy_ssl\b|\bssl\s+on/, 'never terminates TLS');
  assert.match(active, /ssl_preread on;/);
  assert.match(active, /listen 8443;/);
  const map = /map \$ssl_preread_server_name \$egress_upstream \{([^}]*)\}/.exec(active);
  assert.ok(map, 'SNI allowlist map');
  const entries = map[1].trim().split('\n').map((line) => line.replace(/;$/, '').trim().split(/\s+/));
  assert.deepEqual(entries, [['api.resend.com', 'api.resend.com:443'], ['default', '127.0.0.1:1']]);
  assert.match(active, /proxy_pass \$egress_upstream;/);
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /RESEND_EGRESS_ADDRESS: resend-egress:8443\n/);
});
