import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  INTERNAL_TEST_COMPOSE_VARIABLES,
  INTERNAL_TEST_ENV_BASENAME,
  INTERNAL_TEST_PROJECT,
  internalTestingComposeArguments,
  parseInternalTestingEnv,
  renderInternalTestingNginx,
  runInternalTestingOperation,
  validateInternalTestingConfiguration,
  type InternalTestingVariable,
} from './internalTestingDeployment.js';

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);
const sample: Record<InternalTestingVariable, string> = {
  INTERNAL_TEST_DATABASE_NAME: 'eltnoy_internal_test',
  INTERNAL_TEST_POSTGRES_USER: 'eltnoy_internal_test_bootstrap',
  INTERNAL_TEST_ROLE_BOOTSTRAP_APPROVAL: 'PENDING',
  INTERNAL_TEST_ROLE_PASSWORDS_CONFIGURED: 'NO',
  INTERNAL_TEST_ROOT_DIR: '/var/tmp/eltnoy/internal-testing',
  INTERNAL_TEST_SECRETS_DIR: '/var/tmp/eltnoy/internal-testing/secrets',
  INTERNAL_TEST_POSTGRES_TLS_DIR: '/var/tmp/eltnoy/internal-testing/postgres-tls',
  INTERNAL_TEST_POSTGRES_CA_FILE: '/var/tmp/eltnoy/internal-testing/postgres-tls/ca.crt',
  INTERNAL_TEST_PUBLIC_TLS_CERT_DIR: '/var/tmp/eltnoy/internal-testing/public-tls',
  INTERNAL_TEST_ADMIN_TLS_CERT_DIR: '/var/tmp/eltnoy/internal-testing/admin-tls',
  INTERNAL_TEST_NGINX_RENDERED_DIR: '/var/tmp/eltnoy/internal-testing/nginx',
  INTERNAL_TEST_API_IMAGE: 'localhost/eltnoy-api:internal-testing-review-1',
  INTERNAL_TEST_NGINX_IMAGE: `nginxinc/nginx-unprivileged:1.27.5@sha256:${'a'.repeat(64)}`,
  INTERNAL_TEST_POSTGRES_IMAGE: `postgres:17.5@sha256:${'b'.repeat(64)}`,
  INTERNAL_TEST_MARKETING_HOSTNAME: 'portal.test.invalid',
  INTERNAL_TEST_EXAM_HOSTNAME: 'exam.test.invalid',
  INTERNAL_TEST_INSTITUTION_HOSTNAME: 'institution.test.invalid',
  INTERNAL_TEST_ADMIN_HOSTNAME: 'admin.test.invalid',
  INTERNAL_TEST_PUBLIC_BIND_ADDRESS: '10.211.5.10',
  INTERNAL_TEST_ADMIN_BIND_ADDRESS: '10.212.5.10',
  INTERNAL_TEST_WIREGUARD_INTERFACE_ADDRESS: '10.212.5.10',
  INTERNAL_TEST_PUBLIC_APP_SUBNET: '172.29.40.0/24',
  INTERNAL_TEST_ADMIN_APP_SUBNET: '172.29.41.0/24',
  INTERNAL_TEST_NGINX_PUBLIC_APP_ADDRESS: '172.29.40.2',
  INTERNAL_TEST_NGINX_ADMIN_APP_ADDRESS: '172.29.41.2',
  INTERNAL_TEST_API_PUBLIC_APP_ADDRESS: '172.29.40.3',
  INTERNAL_TEST_API_ADMIN_APP_ADDRESS: '172.29.41.3',
  INTERNAL_TEST_MIGRATION_APPROVAL: 'PENDING',
  INTERNAL_TEST_PHASE2B_SOURCE_REVIEW: 'PENDING',
  INTERNAL_TEST_PHASE2B_POSTGRES17_RUNTIME: 'PENDING',
  INTERNAL_TEST_SCHEMA_MIGRATIONS: 'PENDING',
};
const envText = (values: Record<string, string>) =>
  `${INTERNAL_TEST_COMPOSE_VARIABLES.map((name) => `${name}=${values[name] ?? ''}`).join('\n')}\n`;
const asValues = (values: Record<string, string> = sample) => new Map(Object.entries(values));

test('environment parser requires every testing variable and rejects production keys and interpolation', () => {
  const parsed = parseInternalTestingEnv(envText(sample));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.values.size, INTERNAL_TEST_COMPOSE_VARIABLES.length);

  const missing = parseInternalTestingEnv('');
  assert.ok(missing.errors.includes('INTERNAL_TEST_DATABASE_NAME must be set.'));
  assert.ok(missing.errors.includes('INTERNAL_TEST_POSTGRES_IMAGE must be set.'));

  const productionSettings = parseInternalTestingEnv(`${envText(sample)}\nDATABASE_URL=postgres://prod\nPOSTGRES_DB=eltnoy\n`);
  assert.ok(productionSettings.errors.some((error) => error.includes('DATABASE_URL is not an allowed')));
  assert.ok(productionSettings.errors.some((error) => error.includes('POSTGRES_DB is not an allowed')));

  const injection = parseInternalTestingEnv(envText({ ...sample, INTERNAL_TEST_DATABASE_NAME: '${POSTGRES_DB}' }));
  assert.ok(injection.errors.some((error) => error.includes('INTERNAL_TEST_DATABASE_NAME contains unsupported syntax')));

  const compose = readFileSync(new URL('../internal-testing.compose.yml', import.meta.url), 'utf8');
  const interpolated = [...new Set([...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]))].sort();
  assert.ok(interpolated.every((name) => name.startsWith('INTERNAL_TEST_')));
  assert.deepEqual(interpolated.filter((name) => !INTERNAL_TEST_COMPOSE_VARIABLES.includes(name as InternalTestingVariable)), []);
  const example = readFileSync(new URL('../.env.internal-testing.example', import.meta.url), 'utf8');
  for (const name of INTERNAL_TEST_COMPOSE_VARIABLES) assert.match(example, new RegExp(`^${name}=`, 'm'), name);
});

test('preflight rejects production env paths, production hostnames, unsafe images, and shared networks', () => {
  const validFile = '/var/tmp/.env.internal-testing';
  assert.deepEqual(validateInternalTestingConfiguration(asValues(), validFile, repositoryRoot), []);
  assert.ok(validateInternalTestingConfiguration(asValues(), '/var/tmp/.env.production', repositoryRoot).some((error) => error.includes('.env.internal-testing')));
  assert.ok(validateInternalTestingConfiguration(asValues(), `${repositoryRoot}/.env.internal-testing`, repositoryRoot).some((error) => error.includes('outside the repository')));
  // Both production domains (public eltnoy.com, private Admin eltnoy.in) and their subdomains are refused.
  for (const [setting, host] of [
    ['INTERNAL_TEST_ADMIN_HOSTNAME', 'admin.eltnoy.in'], ['INTERNAL_TEST_ADMIN_HOSTNAME', 'admin.eltnoy.com'],
    ['INTERNAL_TEST_ADMIN_HOSTNAME', 'eltnoy.in'], ['INTERNAL_TEST_ADMIN_HOSTNAME', 'test-admin.staging.eltnoy.in'],
    ['INTERNAL_TEST_MARKETING_HOSTNAME', 'eltnoy.com'], ['INTERNAL_TEST_EXAM_HOSTNAME', 'exam.eltnoy.com'],
  ] as const) {
    assert.ok(validateInternalTestingConfiguration(asValues({ ...sample, [setting]: host }), validFile, repositoryRoot)
      .some((error) => error.includes('non-production hostnames')), `${setting}=${host}`);
  }
  assert.ok(validateInternalTestingConfiguration(asValues({ ...sample, INTERNAL_TEST_API_IMAGE: 'localhost/eltnoy-api:production' }), validFile, repositoryRoot)
    .some((error) => error.includes('internal-testing-*')));
  assert.ok(validateInternalTestingConfiguration(asValues({ ...sample, INTERNAL_TEST_ADMIN_APP_SUBNET: '172.29.40.0/24' }), validFile, repositoryRoot)
    .some((error) => error.includes('must not overlap')));
});

test('wrapper pins the testing compose file/project and migration command is gated', () => {
  const args = internalTestingComposeArguments('start', '/var/tmp/.env.internal-testing', repositoryRoot);
  assert.ok(args);
  assert.deepEqual(args.slice(0, 8), [
    '--host', 'unix:///var/run/docker.sock', 'compose', '--project-name', INTERNAL_TEST_PROJECT, '-f', resolve(repositoryRoot, 'internal-testing.compose.yml'), '--env-file',
  ]);
  assert.ok(args.includes('--env-file'));
  assert.equal(internalTestingComposeArguments('migrate', '/var/tmp/.env.internal-testing', repositoryRoot)?.at(-1), 'it_migrate');
  assert.match(internalTestingComposeArguments('bootstrap-roles', '/var/tmp/.env.internal-testing', repositoryRoot)?.at(-1) ?? '', /internal-testing-role-bootstrap\.sql$/);
  assert.deepEqual(internalTestingComposeArguments('set-role-passwords', '/var/tmp/.env.internal-testing', repositoryRoot)?.slice(-4), [
    '-U', 'eltnoy_internal_test_bootstrap', '-d', 'eltnoy_internal_test',
  ]);

  let dockerCalled = false;
  for (const operation of ['migrate', 'start'] as const) {
    const result = runInternalTestingOperation({
      envFilePath: '/var/tmp/.env.internal-testing',
      operation,
    envText: envText(sample),
    repositoryRoot,
    environment: { PATH: '/usr/bin' },
    docker: () => { dockerCalled = true; return 0; },
    });
    assert.equal(result.code, 2);
    assert.ok(result.errors.some((error) => error.includes('INTERNAL_TEST_MIGRATION_APPROVAL=APPROVED')));
    assert.ok(result.errors.some((error) => error.includes('independent Phase 2B source review')));
    assert.ok(result.errors.some((error) => error.includes('PostgreSQL 17 runtime validation')));
    assert.equal(dockerCalled, false);
  }

  const unsafe = runInternalTestingOperation({
    envFilePath: '/var/tmp/.env.production',
    operation: 'start',
    envText: envText(sample),
    repositoryRoot,
    environment: { PATH: '/usr/bin', COMPOSE_PROJECT_NAME: 'eltnoy-production' },
    docker: () => { dockerCalled = true; return 0; },
  });
  assert.equal(unsafe.code, 2);
  assert.equal(dockerCalled, false);
});

test('testing Nginx render substitutes only validated testing hosts and preserves proxy/TLS restrictions', () => {
  const parent = mkdtempSync(join(tmpdir(), 'eltnoy-it-nginx-'));
  const root = join(parent, 'internal-testing');
  const output = join(root, 'nginx');
  mkdirSync(root);
  try {
    assert.deepEqual(renderInternalTestingNginx(asValues({
      ...sample,
      INTERNAL_TEST_ROOT_DIR: root,
      INTERNAL_TEST_NGINX_RENDERED_DIR: output,
    }), repositoryRoot, output), []);
    const publicConfig = readFileSync(join(output, 'public.conf'), 'utf8');
    const adminConfig = readFileSync(join(output, 'admin.conf'), 'utf8');
    for (const host of [
      sample.INTERNAL_TEST_MARKETING_HOSTNAME,
      sample.INTERNAL_TEST_EXAM_HOSTNAME,
      sample.INTERNAL_TEST_INSTITUTION_HOSTNAME,
    ]) assert.ok(publicConfig.includes(host), host);
    assert.ok(adminConfig.includes(sample.INTERNAL_TEST_ADMIN_HOSTNAME));
    assert.ok(!publicConfig.includes('@@INTERNAL_TEST_'));
    assert.ok(!adminConfig.includes('@@INTERNAL_TEST_'));
    for (const productionDomain of ['eltnoy.com', 'eltnoy.in']) {
      assert.ok(!publicConfig.includes(productionDomain), productionDomain);
      assert.ok(!adminConfig.includes(productionDomain), productionDomain);
    }
    for (const config of [publicConfig, adminConfig]) {
      assert.match(config, /ssl_reject_handshake on/);
      assert.match(config, /include \/etc\/nginx\/includes\/eltnoy-tls\.conf/);
      assert.match(config, /include \/etc\/nginx\/includes\/eltnoy-proxy\.conf/);
      assert.match(config, /return 421/);
      assert.match(config, /return 444/);
    }
    assert.match(publicConfig, /eltnoy_internal_testing_public_listener/);
    assert.match(adminConfig, /eltnoy_internal_testing_admin_listener/);
    assert.ok(!publicConfig.includes('it-api-admin'));
    assert.ok(!adminConfig.includes('it-api-public'));
    assert.ok(publicConfig.includes('~*^portal\\.test\\.invalid$'));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('future migration command requires recorded Phase 2B gates; absent values remain closed', () => {
  const pending = parseInternalTestingEnv(envText(sample));
  assert.equal(pending.values.get('INTERNAL_TEST_MIGRATION_APPROVAL'), 'PENDING');
  const approved = {
    ...sample,
    INTERNAL_TEST_MIGRATION_APPROVAL: 'APPROVED',
    INTERNAL_TEST_PHASE2B_SOURCE_REVIEW: 'APPROVED',
    INTERNAL_TEST_PHASE2B_POSTGRES17_RUNTIME: 'PASSED',
    INTERNAL_TEST_SCHEMA_MIGRATIONS: 'APPLIED',
  };
  assert.deepEqual(validateInternalTestingConfiguration(asValues(approved), '/var/tmp/.env.internal-testing', repositoryRoot), []);
  assert.equal(INTERNAL_TEST_ENV_BASENAME, '.env.internal-testing');
});
