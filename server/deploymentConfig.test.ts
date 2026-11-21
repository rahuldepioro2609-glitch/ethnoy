import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyIpv4Address,
  DEPLOYMENT_CONFIG_ENVIRONMENT,
  deploymentConfigFromEnvironment,
  validateDeploymentConfig,
  type DeploymentConfig,
} from './deploymentConfig.js';

const verifiedTls: DeploymentConfig = {
  publicBindMode: 'private-eni',
  databaseSsl: 'true',
  databaseSslRejectUnauthorized: 'true',
  postgresCaFile: '/certs/ca.crt',
  postgresTlsDir: '/certs/postgres',
  // P1-D.2: separate certificate directories for the public and Admin Nginx.
  publicTlsCertDir: '/certs/nginx-public',
  adminTlsCertDir: '/certs/nginx-admin',
  // M-1/M-2: synthetic test values only (not real deployment addresses).
  apiImage: 'localhost/eltnoy-api:1.0.0',
  publicBindAddress: '10.250.0.10',
  adminBindAddress: '10.251.0.1',
  wireguardInterfaceAddress: '10.251.0.1',
};

test('production rejects development paths for every certificate source', () => {
  const cases: Array<Pick<DeploymentConfig, 'postgresCaFile' | 'postgresTlsDir' | 'publicTlsCertDir' | 'adminTlsCertDir'>> = [
    { postgresCaFile: './.local-dev/certs/ca/ca.crt' },
    { postgresTlsDir: './.local-dev/certs/postgres' },
    { publicTlsCertDir: './.local-dev/certs/nginx-public' },
    { adminTlsCertDir: './.local-dev/certs/nginx-admin' },
  ];

  for (const certificatePaths of cases) {
    const errors = validateDeploymentConfig({
      ...verifiedTls,
      deploymentMode: 'production',
      ...certificatePaths,
    });

    assert.ok(errors.some((error) => error.includes('.local-dev')), JSON.stringify(certificatePaths));
  }
});

test('production accepts separately supplied verified certificates', () => {
  assert.deepEqual(validateDeploymentConfig({
    ...verifiedTls,
    deploymentMode: 'production',
  }), []);
});

test('development explicitly allows local development certificate paths', () => {
  assert.deepEqual(validateDeploymentConfig({
    ...verifiedTls,
    deploymentMode: 'development',
    postgresCaFile: './.local-dev/certs/ca/ca.crt',
    postgresTlsDir: './.local-dev/certs/postgres',
    publicTlsCertDir: './.local-dev/certs/nginx-public',
    adminTlsCertDir: './.local-dev/certs/nginx-admin',
  }), []);
});

test('missing deployment mode and disabled TLS are rejected', () => {
  const errors = validateDeploymentConfig({
    ...verifiedTls,
    databaseSsl: 'false',
  });

  assert.ok(errors.some((error) => error.includes('DEPLOYMENT_MODE')));
  assert.ok(errors.some((error) => error.includes('DATABASE_SSL')));
});

test('P1-D.2: both Nginx certificate directories are required and must differ', () => {
  for (const missing of ['publicTlsCertDir', 'adminTlsCertDir'] as const) {
    const errors = validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production', [missing]: undefined });
    assert.ok(errors.some((error) => error.includes(missing === 'publicTlsCertDir' ? 'PUBLIC_TLS_CERT_DIR' : 'ADMIN_TLS_CERT_DIR')), missing);
  }
  for (const [publicDir, adminDir] of [
    ['/certs/nginx', '/certs/nginx'],
    ['/certs/nginx/', '/certs/nginx'],
    ['/certs/./nginx', '/certs/nginx/'],
  ]) {
    const errors = validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production', publicTlsCertDir: publicDir, adminTlsCertDir: adminDir });
    assert.ok(errors.includes('PUBLIC_TLS_CERT_DIR and ADMIN_TLS_CERT_DIR must be different directories.'), `${publicDir} / ${adminDir}`);
  }
  // The retired single directory setting is not accepted as a substitute.
  const legacyOnly = validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production', publicTlsCertDir: undefined, adminTlsCertDir: undefined });
  assert.ok(legacyOnly.some((error) => error.includes('PUBLIC_TLS_CERT_DIR')));
});

// ---------------------------------------------------------------------------
// M-1: local-only API image reference
// ---------------------------------------------------------------------------

const imageErrors = (apiImage: string | undefined) =>
  validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production', apiImage }).filter((error) => error.includes('ELTNOY_API_IMAGE'));

test('M-1: only localhost/eltnoy-api:<tag> is accepted', () => {
  for (const image of ['localhost/eltnoy-api:1.0.0', 'localhost/eltnoy-api:rc-day1', 'localhost/eltnoy-api:2026.11.11_build-3']) {
    assert.deepEqual(imageErrors(image), [], image);
  }
});

test('M-1: registry, Docker Hub, digest, untagged and malformed references are rejected', () => {
  for (const image of [
    'eltnoy-api:1.0.0', // Docker Hub library namespace
    'eltnoy/eltnoy-api:1.0.0', // Docker Hub user namespace
    'docker.io/library/eltnoy-api:1.0.0',
    'ghcr.io/example/eltnoy-api:1.0.0',
    'registry.example.com:5000/eltnoy-api:1.0.0',
    'localhost:5000/eltnoy-api:1.0.0', // a registry on localhost
    'localhost/eltnoy-api', // untagged (implicit latest)
    'localhost/eltnoy-api@sha256:' + 'a'.repeat(64),
    'localhost/eltnoy-api:1.0.0@sha256:' + 'a'.repeat(64),
    'localhost/other-api:1.0.0',
    'LOCALHOST/eltnoy-api:1.0.0',
    'localhost/eltnoy-api:',
    'localhost/eltnoy-api:.hidden',
    'localhost/eltnoy-api:' + 'x'.repeat(129),
    ' localhost/eltnoy-api:1.0.0',
    'localhost/eltnoy-api:1.0.0 ',
  ]) {
    assert.equal(imageErrors(image).length, 1, image);
  }
});

test('M-1: a missing image reference fails closed with no default', () => {
  assert.deepEqual(imageErrors(undefined), ['ELTNOY_API_IMAGE must be set.']);
  assert.deepEqual(imageErrors(''), ['ELTNOY_API_IMAGE must be set.']);
});

// ---------------------------------------------------------------------------
// M-2: Nginx bind addresses
// ---------------------------------------------------------------------------

const bindErrors = (overrides: Partial<DeploymentConfig>) =>
  validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production', ...overrides })
    .filter((error) => /BIND_MODE|BIND_ADDRESS|WIREGUARD_INTERFACE_ADDRESS/.test(error));

test('M-2: valid IPv4 configurations are accepted (private public bind; Admin equals the WireGuard address)', () => {
  for (const config of [
    { publicBindAddress: '10.250.0.10', adminBindAddress: '10.251.0.1', wireguardInterfaceAddress: '10.251.0.1' },
    { publicBindAddress: '172.31.5.20', adminBindAddress: '192.168.77.1', wireguardInterfaceAddress: '192.168.77.1' },
    { publicBindAddress: '192.168.1.0', adminBindAddress: '100.64.0.1', wireguardInterfaceAddress: '100.64.0.1' }, // shared (100.64.0.0/10) tunnel range
  ]) {
    assert.deepEqual(bindErrors(config), [], JSON.stringify(config));
  }
  // The full configuration (all checks) passes.
  assert.deepEqual(validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production' }), []);
});

test('M-2: IPv6 bind addresses are rejected (the Compose short port syntax cannot carry them)', () => {
  for (const address of ['fd00::1', '::1', '[fd00::1]', '::ffff:10.0.0.1']) {
    assert.ok(bindErrors({ publicBindAddress: address }).some((error) => error.startsWith('PUBLIC_BIND_ADDRESS must be a literal IPv4 address')), address);
    assert.ok(bindErrors({ adminBindAddress: address, wireguardInterfaceAddress: address }).some((error) => error.startsWith('ADMIN_BIND_ADDRESS must be a literal IPv4 address')), address);
  }
});

test('M-2: wildcard and unspecified addresses are rejected', () => {
  for (const address of ['0.0.0.0', '0.1.2.3']) {
    assert.ok(bindErrors({ publicBindAddress: address }).includes('PUBLIC_BIND_ADDRESS must not be a wildcard or unspecified address.'), address);
    assert.ok(bindErrors({ adminBindAddress: address, wireguardInterfaceAddress: address }).includes('ADMIN_BIND_ADDRESS must not be a wildcard or unspecified address.'), address);
    assert.ok(bindErrors({ wireguardInterfaceAddress: address }).includes('WIREGUARD_INTERFACE_ADDRESS must not be a wildcard or unspecified address.'), address);
  }
  for (const wildcard of ['*', '::', '']) {
    assert.ok(bindErrors({ adminBindAddress: wildcard }).length > 0, JSON.stringify(wildcard));
  }
});

test('M-2: loopback, link-local, multicast, reserved and broadcast addresses are rejected', () => {
  const cases: Array<[string, string]> = [
    ['127.0.0.1', 'must not be a loopback address.'],
    ['127.10.0.1', 'must not be a loopback address.'],
    ['169.254.10.1', 'must not be a link-local address.'],
    ['224.0.0.1', 'must not be a multicast, reserved or broadcast address.'],
    ['240.0.0.1', 'must not be a multicast, reserved or broadcast address.'],
    ['255.255.255.255', 'must not be a multicast, reserved or broadcast address.'],
  ];
  for (const [address, rule] of cases) {
    assert.ok(bindErrors({ publicBindAddress: address }).includes(`PUBLIC_BIND_ADDRESS ${rule}`), address);
    assert.ok(bindErrors({ adminBindAddress: address, wireguardInterfaceAddress: address }).includes(`ADMIN_BIND_ADDRESS ${rule}`), address);
  }
});

test('M-2: invalid literals, hostnames, ports and CIDR ranges are rejected (no DNS resolution)', () => {
  for (const address of ['10.0.0', '10.0.0.256', '10.00.0.1', '010.0.0.1', '10.0.0.1/32', '10.0.0.1:443', 'wg0', 'localhost', 'admin.internal', ' 10.0.0.1', '10.0.0.1 ', '10.0.0.1,10.0.0.2']) {
    assert.ok(bindErrors({ publicBindAddress: address }).some((error) => error.startsWith('PUBLIC_BIND_ADDRESS must be a literal IPv4 address')), address);
  }
});

test('M-2: a public bind address is rejected by default and accepted only in explicit direct-vps mode', () => {
  for (const address of ['203.0.113.10', '198.51.100.7', '8.8.8.8', '100.64.0.10']) {
    assert.ok(bindErrors({ publicBindAddress: address }).some((error) => error.startsWith('PUBLIC_BIND_ADDRESS must be a private (RFC 1918) host address')), address);
  }
  assert.deepEqual(bindErrors({ publicBindMode: 'direct-vps', publicBindAddress: '8.8.8.8' }), []);
  assert.ok(bindErrors({ publicBindMode: 'direct-vps', publicBindAddress: '10.0.0.1' }).some((error) => error.startsWith('PUBLIC_BIND_ADDRESS must be a public IPv4 address')));
  assert.ok(bindErrors({ publicBindMode: 'direct-vps', publicBindAddress: '100.64.0.10' }).some((error) => error.startsWith('PUBLIC_BIND_ADDRESS must be a public IPv4 address')));
  assert.ok(bindErrors({ publicBindMode: 'unknown', publicBindAddress: '8.8.8.8' }).includes('PUBLIC_BIND_MODE must be set to private-eni or direct-vps.'));
  // Public addresses are rejected for the WireGuard and Admin addresses too.
  assert.ok(bindErrors({ adminBindAddress: '203.0.113.10', wireguardInterfaceAddress: '203.0.113.10' }).some((error) => error.startsWith('WIREGUARD_INTERFACE_ADDRESS must be a private')));
});

test('M-2: the Admin bind address must equal the WireGuard interface address and differ from the public bind address', () => {
  assert.ok(bindErrors({ adminBindAddress: '10.251.0.2', wireguardInterfaceAddress: '10.251.0.1' })
    .includes('ADMIN_BIND_ADDRESS must equal WIREGUARD_INTERFACE_ADDRESS: the Admin Nginx binds only to the WireGuard interface address.'));
  // Admin on the private (public-traffic) interface address instead of wg0.
  assert.ok(bindErrors({ adminBindAddress: '10.250.0.10', wireguardInterfaceAddress: '10.251.0.1' }).length >= 2);
  assert.ok(bindErrors({ publicBindAddress: '10.251.0.1' })
    .includes('PUBLIC_BIND_ADDRESS must differ from ADMIN_BIND_ADDRESS and WIREGUARD_INTERFACE_ADDRESS.'));
});

test('M-2: missing configuration fails closed with no default; errors never echo configured values', () => {
  assert.ok(bindErrors({ publicBindMode: undefined }).includes('PUBLIC_BIND_MODE must be set to private-eni or direct-vps.'));
  assert.ok(bindErrors({ publicBindMode: '' }).includes('PUBLIC_BIND_MODE must be set to private-eni or direct-vps.'));
  for (const [field, name] of [['publicBindAddress', 'PUBLIC_BIND_ADDRESS'], ['adminBindAddress', 'ADMIN_BIND_ADDRESS'], ['wireguardInterfaceAddress', 'WIREGUARD_INTERFACE_ADDRESS']] as const) {
    assert.ok(bindErrors({ [field]: undefined }).includes(`${name} must be set.`), name);
    assert.ok(bindErrors({ [field]: '' }).includes(`${name} must be set.`), name);
  }
  const errors = validateDeploymentConfig({
    ...verifiedTls,
    deploymentMode: 'production',
    apiImage: 'ghcr.io/value-not-echoed/eltnoy-api:1',
    publicBindAddress: '203.0.113.99',
    adminBindAddress: '198.51.100.99',
    wireguardInterfaceAddress: '10.99.99.99',
  });
  const text = JSON.stringify(errors);
  for (const value of ['value-not-echoed', '203.0.113.99', '198.51.100.99', '10.99.99.99']) assert.ok(!text.includes(value), value);
});

// ---------------------------------------------------------------------------
// P1-D.3 (F-8): table-driven address-classification boundaries (production classifier)
// ---------------------------------------------------------------------------

test('F-8: RFC 1918 and shared-range boundaries classify exactly as documented', () => {
  const table: Array<[string, ReturnType<typeof classifyIpv4Address>]> = [
    ['9.255.255.255', 'public'],
    ['10.0.0.0', 'private'],
    ['10.255.255.255', 'private'],
    ['11.0.0.0', 'public'],
    ['172.15.255.255', 'public'],
    ['172.16.0.0', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.0', 'public'],
    ['192.167.255.255', 'public'],
    ['192.168.0.0', 'private'],
    ['192.168.255.255', 'private'],
    ['192.169.0.0', 'public'],
    ['100.63.255.255', 'public'],
    ['100.64.0.0', 'shared'],
    ['100.127.255.255', 'shared'],
    ['100.128.0.0', 'public'],
    ['0.0.0.0', 'unspecified'],
    ['0.255.255.255', 'unspecified'],
    ['126.255.255.255', 'public'],
    ['127.0.0.0', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['169.253.255.255', 'public'],
    ['169.254.0.0', 'link_local'],
    ['169.254.255.255', 'link_local'],
    ['169.255.0.0', 'public'],
    ['223.255.255.255', 'public'],
    ['224.0.0.0', 'multicast_or_reserved'],
    ['255.255.255.255', 'multicast_or_reserved'],
    ['256.0.0.1', 'invalid'],
    ['010.0.0.1', 'invalid'],
    ['10.0.0', 'invalid'],
    ['10.0.0.1/32', 'invalid'],
    [' 10.0.0.1', 'invalid'],
  ];
  for (const [address, expected] of table) assert.equal(classifyIpv4Address(address), expected, address);
});

test('F-8: boundary classification drives the bind-address policy unchanged', () => {
  const accepts = (overrides: Partial<DeploymentConfig>) => validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production', ...overrides });
  // Public bind: RFC 1918 only.
  for (const address of ['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255']) {
    assert.deepEqual(accepts({ publicBindAddress: address }), [], address);
  }
  for (const address of ['172.15.255.255', '172.32.0.0', '100.64.0.0', '100.127.255.255', '100.63.255.255', '100.128.0.0']) {
    assert.ok(accepts({ publicBindAddress: address }).some((error) => error.startsWith('PUBLIC_BIND_ADDRESS')), address);
  }
  // WireGuard / Admin bind: RFC 1918 or shared.
  for (const address of ['100.64.0.0', '100.127.255.255', '172.16.0.0', '192.168.255.255']) {
    assert.deepEqual(accepts({ adminBindAddress: address, wireguardInterfaceAddress: address }), [], address);
  }
  for (const address of ['100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0']) {
    const errors = accepts({ adminBindAddress: address, wireguardInterfaceAddress: address });
    assert.ok(errors.some((error) => error.startsWith('ADMIN_BIND_ADDRESS')), address);
    assert.ok(errors.some((error) => error.startsWith('WIREGUARD_INTERFACE_ADDRESS')), address);
  }
});

// ---------------------------------------------------------------------------
// P1-D.3 (F-4): environment-to-config mapping
// ---------------------------------------------------------------------------

const syntheticEnvironment: Record<string, string> = {
  DEPLOYMENT_MODE: 'production',
  DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
  POSTGRES_CA_FILE: '/certs/ca.crt',
  POSTGRES_TLS_DIR: '/certs/postgres',
  PUBLIC_TLS_CERT_DIR: '/certs/nginx-public',
  ADMIN_TLS_CERT_DIR: '/certs/nginx-admin',
  ELTNOY_API_IMAGE: 'localhost/eltnoy-api:1.0.0',
  PUBLIC_BIND_ADDRESS: '10.250.0.10',
  PUBLIC_BIND_MODE: 'private-eni',
  ADMIN_BIND_ADDRESS: '10.251.0.1',
  WIREGUARD_INTERFACE_ADDRESS: '10.251.0.1',
};

test('F-4: every configuration field is read from its documented environment variable', () => {
  assert.deepEqual(DEPLOYMENT_CONFIG_ENVIRONMENT, {
    deploymentMode: 'DEPLOYMENT_MODE',
    databaseSsl: 'DATABASE_SSL',
    databaseSslRejectUnauthorized: 'DATABASE_SSL_REJECT_UNAUTHORIZED',
    postgresCaFile: 'POSTGRES_CA_FILE',
    postgresTlsDir: 'POSTGRES_TLS_DIR',
    publicTlsCertDir: 'PUBLIC_TLS_CERT_DIR',
    adminTlsCertDir: 'ADMIN_TLS_CERT_DIR',
    apiImage: 'ELTNOY_API_IMAGE',
    publicBindAddress: 'PUBLIC_BIND_ADDRESS',
    publicBindMode: 'PUBLIC_BIND_MODE',
    adminBindAddress: 'ADMIN_BIND_ADDRESS',
    wireguardInterfaceAddress: 'WIREGUARD_INTERFACE_ADDRESS',
  });
  // Distinct marker per variable proves each field reads its own variable (no swaps or typos).
  const marked = Object.fromEntries(Object.values(DEPLOYMENT_CONFIG_ENVIRONMENT).map((name) => [name, `marker-${name}`]));
  const config = deploymentConfigFromEnvironment(marked);
  for (const [field, name] of Object.entries(DEPLOYMENT_CONFIG_ENVIRONMENT)) {
    assert.equal(config[field as keyof DeploymentConfig], `marker-${name}`, field);
  }
});

test('F-4: the mapping returns only the expected fields and ignores unrelated variables', () => {
  const config = deploymentConfigFromEnvironment({ ...syntheticEnvironment, DATABASE_URL: 'unrelated', PATH: '/bin', toString: 'x' });
  assert.deepEqual(Object.keys(config).sort(), Object.keys(DEPLOYMENT_CONFIG_ENVIRONMENT).sort());
  assert.deepEqual(validateDeploymentConfig(config), []);
});

test('F-4: each missing variable maps to undefined and fails validation for that setting', () => {
  for (const name of Object.values(DEPLOYMENT_CONFIG_ENVIRONMENT)) {
    const environment = { ...syntheticEnvironment };
    delete environment[name];
    const config = deploymentConfigFromEnvironment(environment);
    const field = Object.entries(DEPLOYMENT_CONFIG_ENVIRONMENT).find(([, variable]) => variable === name)?.[0] as keyof DeploymentConfig;
    assert.equal(config[field], undefined, name);
    const errors = validateDeploymentConfig(config);
    assert.ok(errors.some((error) => error.includes(name)), `${name}: ${errors.join(' | ')}`);
  }
});

test('F-4: an empty environment fails closed for every setting', () => {
  const config = deploymentConfigFromEnvironment({});
  assert.ok(Object.values(config).every((value) => value === undefined));
  const errors = validateDeploymentConfig(config).join('\n');
  for (const name of Object.values(DEPLOYMENT_CONFIG_ENVIRONMENT)) assert.ok(errors.includes(name), name);
});

test('F-4: the mapping preserves validation behaviour (same errors as a hand-built config)', () => {
  const environment = { ...syntheticEnvironment, PUBLIC_BIND_ADDRESS: '8.8.8.8', ELTNOY_API_IMAGE: 'docker.io/library/eltnoy-api:1' };
  assert.deepEqual(
    validateDeploymentConfig(deploymentConfigFromEnvironment(environment)),
    validateDeploymentConfig({ ...verifiedTls, deploymentMode: 'production', publicBindAddress: '8.8.8.8', apiImage: 'docker.io/library/eltnoy-api:1' }),
  );
});

// ---------------------------------------------------------------------------
// AUTH C1.3-B: SMS limits and claim lifetime in the deployment preflight (pure shared resolver)
// ---------------------------------------------------------------------------

const C13B_SMS_NAMES = [
  'AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS', 'AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS',
  'AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS', 'AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS',
  'AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS', 'AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS',
  'AUTH_SMS_DAILY_MAX_SENDS', 'AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS',
];
// TEST-ONLY distinctive values, so the tests can prove that no value is ever printed.
const C13B_VALID: Record<string, string> = {
  AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS: '36023', AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS: '323',
  AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS: '18023', AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS: '523',
  AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS: '72023', AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS: '423',
  AUTH_SMS_DAILY_MAX_SENDS: '50023', AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '30023',
};

test('AUTH C1.3-B preflight: the eight SMS settings are all-or-nothing; the claim lifetime is validated on its own', async () => {
  const { validateSmsProtectionDeployment } = await import('./smsProtectionConfig.js');
  const ttl = 'AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS';
  assert.deepEqual(validateSmsProtectionDeployment({}), [], 'all unset: accepted (SMS closed)');
  assert.deepEqual(validateSmsProtectionDeployment(Object.fromEntries([...C13B_SMS_NAMES, ttl].map((name) => [name, '']))), [], 'all empty: accepted');
  assert.deepEqual(validateSmsProtectionDeployment(C13B_VALID), [], 'all eight valid, claim lifetime unset: accepted');
  assert.deepEqual(validateSmsProtectionDeployment({ ...C13B_VALID, [ttl]: '623' }), [], 'everything valid');
  // Partial: each missing name is reported.
  for (const present of C13B_SMS_NAMES) {
    const errors = validateSmsProtectionDeployment({ [present]: C13B_VALID[present] });
    assert.equal(errors.length, 7, present);
    assert.ok(!errors.some((error) => error.startsWith(`${present} `)), `${present} itself is valid`);
  }
  const sevenOfEight = { ...C13B_VALID };
  delete sevenOfEight.AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS;
  assert.deepEqual(validateSmsProtectionDeployment(sevenOfEight), ['AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS is missing: the eight AUTH_SMS_* settings must be set together (all of them or none).']);
  for (const bad of ['0', '-5', '1.5', 'ten', '1e3', ' ']) {
    const errors = validateSmsProtectionDeployment({ ...C13B_VALID, AUTH_SMS_DAILY_MAX_SENDS: bad, AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '1' });
    assert.equal(errors.length, 1, JSON.stringify(bad));
    assert.match(errors[0], bad.trim() === '' ? /^AUTH_SMS_DAILY_MAX_SENDS is missing/ : /^AUTH_SMS_DAILY_MAX_SENDS is invalid: it must be a positive whole number\.$/);
  }
  assert.deepEqual(validateSmsProtectionDeployment({ ...C13B_VALID, AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '50024' }), ['AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS is inconsistent: it must not exceed AUTH_SMS_DAILY_MAX_SENDS.']);
  assert.deepEqual(validateSmsProtectionDeployment({ ...C13B_VALID, AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '50023' }), [], 'equal to the total is allowed');
  // The claim lifetime: independent of the SMS group, existing maximum 900 preserved.
  for (const bad of ['0', '901', '7.5', 'x']) {
    for (const sms of [{}, C13B_VALID]) {
      assert.deepEqual(validateSmsProtectionDeployment({ ...sms, [ttl]: bad }), [`${ttl} is invalid: it must be a positive whole number no greater than the verification challenge lifetime.`], `${ttl}=${bad}`);
    }
  }
  assert.deepEqual(validateSmsProtectionDeployment({ [ttl]: '900' }), [], 'the 900 maximum is inclusive; a valid claim lifetime alone does not require the SMS settings');
  // No configured value ever appears in any message.
  const text = [validateSmsProtectionDeployment({ AUTH_SMS_DAILY_MAX_SENDS: '50023', [ttl]: '901' }), validateSmsProtectionDeployment({ ...C13B_VALID, AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS: '50024' })].flat().join('\n');
  for (const value of [...Object.values(C13B_VALID), '50024', '901']) assert.ok(!text.includes(value), `value ${value} is not printed`);
});

test('AUTH C1.3-B preflight: validateDeploymentConfig.ts reports SMS problems by name, never values or the password-file path', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const passwordFile = '/nonexistent/c13b/password-file-marker';
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'server/validateDeploymentConfig.ts'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', DATABASE_PASSWORD_FILE: passwordFile, DATABASE_URL: 'postgresql://marker-user@marker-host/markerdb', AUTH_SMS_DAILY_MAX_SENDS: '50023', AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS: '901' },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 1);
  const output = run.stdout + run.stderr;
  assert.match(output, /Invalid deployment configuration/);
  assert.match(output, /AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS is missing: the eight AUTH_SMS_\* settings must be set together/);
  assert.match(output, /AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS is invalid/);
  for (const secret of ['50023', '901', passwordFile, 'marker-user', 'marker-host', 'markerdb']) assert.ok(!output.includes(secret), `${secret} is never printed`);
});

test('AUTH C1.3-B preflight: the import closure contains no database, credential, Express, dotenv or auth-store module', async () => {
  const { readFile } = await import('node:fs/promises');
  const seen = new Set<string>();
  const bare = new Set<string>();
  const visit = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      if (specifier.startsWith('./')) await visit(specifier.slice(2).replace(/\.js$/, '.ts'));
      else bare.add(specifier);
    }
  };
  await visit('validateDeploymentConfig.ts');
  assert.deepEqual([...seen].sort(), ['deploymentConfig.ts', 'smsProtectionConfig.ts', 'validateDeploymentConfig.ts', 'verificationProviders.ts']);
  assert.ok([...bare].every((specifier) => specifier.startsWith('node:')), `only Node built-ins: ${[...bare].join(', ')}`);
  for (const forbidden of ['db.ts', 'databaseCredentials.ts', 'authVerification.ts', 'authVerificationStore.ts', 'index.ts']) assert.ok(!seen.has(forbidden), forbidden);
});

// ---------------------------------------------------------------------------
// AUTH C1.4-B-2: the six email settings in the deployment preflight (pure shared resolver)
// ---------------------------------------------------------------------------

const C14B_VALID: Record<string, string> = {
  AUTH_EMAIL_UNVERIFIED_DESTINATION_WINDOW_SECONDS: '36071', AUTH_EMAIL_UNVERIFIED_DESTINATION_MAX_SENDS: '371',
  AUTH_EMAIL_ACCOUNT_DESTINATION_WINDOW_SECONDS: '72071', AUTH_EMAIL_ACCOUNT_DESTINATION_MAX_SENDS: '471',
  AUTH_EMAIL_DAILY_MAX_SENDS: '50071', AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS: '30071',
};

test('AUTH C1.4-B-2 preflight rule: all six absent/empty or all six valid; partial, invalid or inconsistent rejected; SMS rule unchanged', async () => {
  const { validateEmailProtectionDeployment, validateSmsProtectionDeployment, resolveEmailProtection } = await import('./smsProtectionConfig.js');
  assert.deepEqual(validateEmailProtectionDeployment({}), []);
  assert.deepEqual(validateEmailProtectionDeployment(Object.fromEntries(Object.keys(C14B_VALID).map((name) => [name, '']))), []);
  assert.deepEqual(validateEmailProtectionDeployment(C14B_VALID), []);
  assert.ok(resolveEmailProtection(C14B_VALID).email, 'the same resolver the API uses accepts it');
  for (const present of Object.keys(C14B_VALID)) assert.equal(validateEmailProtectionDeployment({ [present]: C14B_VALID[present] }).length, 5, present);
  for (const bad of ['0', '-5', '1.5', 'ten', '1e3']) {
    assert.deepEqual(validateEmailProtectionDeployment({ ...C14B_VALID, AUTH_EMAIL_UNVERIFIED_DESTINATION_MAX_SENDS: bad }), ['AUTH_EMAIL_UNVERIFIED_DESTINATION_MAX_SENDS is invalid: it must be a positive whole number.'], bad);
  }
  assert.deepEqual(validateEmailProtectionDeployment({ ...C14B_VALID, AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS: '50072' }), ['AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS is inconsistent: it must not exceed AUTH_EMAIL_DAILY_MAX_SENDS.']);
  assert.deepEqual(validateEmailProtectionDeployment({ ...C14B_VALID, AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS: '50071' }), [], 'equal is allowed');
  // Parity with the resolver, and SMS unaffected by email values.
  for (const env of [{}, C14B_VALID, { AUTH_EMAIL_DAILY_MAX_SENDS: '3' }, { ...C14B_VALID, AUTH_EMAIL_DAILY_MAX_SENDS: '0' }]) {
    assert.equal(validateEmailProtectionDeployment(env).length === 0, resolveEmailProtection(env).email !== null || Object.keys(env).length === 0, JSON.stringify(Object.keys(env)));
  }
  assert.deepEqual(validateSmsProtectionDeployment(C14B_VALID), [], 'email settings never trigger the SMS rule');
  const text = validateEmailProtectionDeployment({ AUTH_EMAIL_DAILY_MAX_SENDS: '50071', AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS: '50072' }).join('\n');
  for (const value of ['50071', '50072']) assert.ok(!text.includes(value));
});

test('AUTH C1.4-B-2 container preflight: validateDeploymentConfig.ts rejects a partial email group by name without printing values', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'server/validateDeploymentConfig.ts'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', DATABASE_PASSWORD_FILE: '/nonexistent/c14b/password-marker', AUTH_EMAIL_DAILY_MAX_SENDS: '50071', AUTH_EMAIL_ACCOUNT_DESTINATION_MAX_SENDS: '1.5' },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 1);
  const output = run.stdout + run.stderr;
  assert.match(output, /AUTH_EMAIL_UNVERIFIED_DESTINATION_WINDOW_SECONDS is missing: the six AUTH_EMAIL_\* settings must be set together/);
  assert.match(output, /AUTH_EMAIL_ACCOUNT_DESTINATION_MAX_SENDS is invalid/);
  for (const secret of ['50071', '1.5', '/nonexistent/c14b/password-marker']) assert.ok(!output.includes(secret), `${secret} never printed`);
  assert.doesNotMatch(output, /AUTH_SMS_/, 'absent SMS settings stay accepted');
});
