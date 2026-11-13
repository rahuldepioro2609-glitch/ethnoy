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
    .filter((error) => /BIND_ADDRESS|WIREGUARD_INTERFACE_ADDRESS/.test(error));

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

test('M-2: a public (non-RFC 1918) address is rejected as the public bind address', () => {
  for (const address of ['203.0.113.10', '198.51.100.7', '8.8.8.8', '100.64.0.10']) {
    assert.ok(bindErrors({ publicBindAddress: address }).some((error) => error.startsWith('PUBLIC_BIND_ADDRESS must be a private (RFC 1918) host address')), address);
  }
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
