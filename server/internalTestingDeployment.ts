import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isProductionDomainHostname } from './surface.js';

export const INTERNAL_TEST_PROJECT = 'eltnoy-internal-testing';
export const INTERNAL_TEST_COMPOSE_FILE = 'internal-testing.compose.yml';
export const INTERNAL_TEST_ENV_BASENAME = '.env.internal-testing';
export const INTERNAL_TEST_COMPOSE_VARIABLES = [
  'INTERNAL_TEST_DATABASE_NAME',
  'INTERNAL_TEST_POSTGRES_USER',
  'INTERNAL_TEST_ROLE_BOOTSTRAP_APPROVAL',
  'INTERNAL_TEST_ROLE_PASSWORDS_CONFIGURED',
  'INTERNAL_TEST_ROOT_DIR',
  'INTERNAL_TEST_SECRETS_DIR',
  'INTERNAL_TEST_POSTGRES_TLS_DIR',
  'INTERNAL_TEST_POSTGRES_CA_FILE',
  'INTERNAL_TEST_PUBLIC_TLS_CERT_DIR',
  'INTERNAL_TEST_ADMIN_TLS_CERT_DIR',
  'INTERNAL_TEST_NGINX_RENDERED_DIR',
  'INTERNAL_TEST_API_IMAGE',
  'INTERNAL_TEST_NGINX_IMAGE',
  'INTERNAL_TEST_POSTGRES_IMAGE',
  'INTERNAL_TEST_MARKETING_HOSTNAME',
  'INTERNAL_TEST_EXAM_HOSTNAME',
  'INTERNAL_TEST_INSTITUTION_HOSTNAME',
  'INTERNAL_TEST_ADMIN_HOSTNAME',
  'INTERNAL_TEST_PUBLIC_BIND_ADDRESS',
  'INTERNAL_TEST_ADMIN_BIND_ADDRESS',
  'INTERNAL_TEST_WIREGUARD_INTERFACE_ADDRESS',
  'INTERNAL_TEST_PUBLIC_APP_SUBNET',
  'INTERNAL_TEST_ADMIN_APP_SUBNET',
  'INTERNAL_TEST_NGINX_PUBLIC_APP_ADDRESS',
  'INTERNAL_TEST_NGINX_ADMIN_APP_ADDRESS',
  'INTERNAL_TEST_API_PUBLIC_APP_ADDRESS',
  'INTERNAL_TEST_API_ADMIN_APP_ADDRESS',
  'INTERNAL_TEST_MIGRATION_APPROVAL',
  'INTERNAL_TEST_PHASE2B_SOURCE_REVIEW',
  'INTERNAL_TEST_PHASE2B_POSTGRES17_RUNTIME',
  'INTERNAL_TEST_SCHEMA_MIGRATIONS',
] as const;

export type InternalTestingVariable = typeof INTERNAL_TEST_COMPOSE_VARIABLES[number];
export type InternalTestingOperation = 'preflight' | 'render-nginx' | 'config' | 'build' | 'start-postgres' | 'bootstrap-roles' | 'set-role-passwords' | 'migrate' | 'start' | 'status' | 'stop';
export type InternalTestingValues = ReadonlyMap<string, string>;

const SECRET_FILES = ['postgres_superuser_password', 'eltnoy_app_password', 'eltnoy_migrator_password'];
const HOSTS = [
  'INTERNAL_TEST_MARKETING_HOSTNAME',
  'INTERNAL_TEST_EXAM_HOSTNAME',
  'INTERNAL_TEST_INSTITUTION_HOSTNAME',
  'INTERNAL_TEST_ADMIN_HOSTNAME',
] as const;
const PATHS = [
  'INTERNAL_TEST_ROOT_DIR',
  'INTERNAL_TEST_POSTGRES_TLS_DIR',
  'INTERNAL_TEST_POSTGRES_CA_FILE',
  'INTERNAL_TEST_PUBLIC_TLS_CERT_DIR',
  'INTERNAL_TEST_ADMIN_TLS_CERT_DIR',
  'INTERNAL_TEST_NGINX_RENDERED_DIR',
] as const;
const TEMPLATE_FILES = [
  ['internal-testing-public.conf.template', 'public.conf'],
  ['internal-testing-admin.conf.template', 'admin.conf'],
] as const;

export function parseInternalTestingEnv(text: string): { values: Map<string, string>; errors: string[] } {
  const values = new Map<string, string>();
  const errors: string[] = [];
  const allowed = new Set<string>(INTERNAL_TEST_COMPOSE_VARIABLES);

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      errors.push(`line ${index + 1} must be a plain KEY=VALUE assignment.`);
      continue;
    }
    const [, name, rawValue] = match;
    if (!allowed.has(name)) {
      errors.push(`${name} is not an allowed internal-testing setting.`);
      continue;
    }
    if (values.has(name)) {
      errors.push(`${name} must appear only once.`);
      continue;
    }
    let value = rawValue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);
    if (/[\\$`\r\n]/.test(value) || /\s/.test(value) || /["']/.test(value)) {
      errors.push(`${name} contains unsupported syntax.`);
      continue;
    }
    values.set(name, value);
  }

  for (const name of INTERNAL_TEST_COMPOSE_VARIABLES) {
    if (!values.has(name) || values.get(name) === '') errors.push(`${name} must be set.`);
  }
  return { values, errors };
}

function value(values: InternalTestingValues, key: string): string {
  return values.get(key) ?? '';
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path));
}

function ipv4Number(text: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text)) return null;
  const octets = text.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((result, octet) => result * 256 + octet, 0);
}

function subnet(text: string): { start: number; end: number; prefix: number } | null {
  const match = /^(.+)\/(8|9|1\d|2\d|3[0-2])$/.exec(text);
  if (!match) return null;
  const address = ipv4Number(match[1]);
  if (address === null) return null;
  const prefix = Number(match[2]);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(address / size) * size;
  return { start, end: start + size - 1, prefix };
}

function inRange(address: number, start: number, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(start / size);
}

function isPrivateOrShared(address: number): boolean {
  return inRange(address, 0x0a000000, 8)
    || inRange(address, 0xac100000, 12)
    || inRange(address, 0xc0a80000, 16)
    || inRange(address, 0x64400000, 10);
}

function hostInSubnet(host: number, network: { start: number; end: number }): boolean {
  return host > network.start && host < network.end;
}

function isPrivateSubnet(network: { start: number; end: number }): boolean {
  return [
    { start: 0x0a000000, end: 0x0affffff },
    { start: 0xac100000, end: 0xac1fffff },
    { start: 0xc0a80000, end: 0xc0a8ffff },
  ].some((range) => network.start >= range.start && network.end <= range.end);
}

export function validateInternalTestingConfiguration(
  values: InternalTestingValues,
  envFilePath: string,
  repositoryRoot: string,
): string[] {
  const errors: string[] = [];
  const envFile = resolve(envFilePath);
  const repo = resolve(repositoryRoot);
  if (!isAbsolute(envFilePath) || basename(envFilePath) !== INTERNAL_TEST_ENV_BASENAME) {
    errors.push(`Use an absolute ${INTERNAL_TEST_ENV_BASENAME} file path.`);
  }
  if (isWithin(repo, envFile)) errors.push('The internal-testing environment file must be outside the repository.');

  if (value(values, 'INTERNAL_TEST_DATABASE_NAME') !== 'eltnoy_internal_test') {
    errors.push('INTERNAL_TEST_DATABASE_NAME must be the dedicated eltnoy_internal_test database.');
  }
  if (value(values, 'INTERNAL_TEST_POSTGRES_USER') !== 'eltnoy_internal_test_bootstrap') {
    errors.push('INTERNAL_TEST_POSTGRES_USER must be the dedicated testing bootstrap role.');
  }

  const apiImage = value(values, 'INTERNAL_TEST_API_IMAGE');
  if (!/^localhost\/eltnoy-api:internal-testing-[A-Za-z0-9_.-]{1,100}$/.test(apiImage)) {
    errors.push('INTERNAL_TEST_API_IMAGE must use a unique localhost/eltnoy-api:internal-testing-* tag.');
  }
  const nginxImage = /^nginxinc\/nginx-unprivileged:(\d+)\.(\d+)\.(\d+)(?:[-.][A-Za-z0-9_.-]+)?@sha256:[a-f0-9]{64}$/.exec(value(values, 'INTERNAL_TEST_NGINX_IMAGE'));
  if (!nginxImage) {
    errors.push('INTERNAL_TEST_NGINX_IMAGE must be a digest-pinned nginxinc/nginx-unprivileged image with a numeric version tag.');
  } else if (Number(nginxImage[1]) < 1 || (Number(nginxImage[1]) === 1
    && (Number(nginxImage[2]) < 19 || (Number(nginxImage[2]) === 19 && Number(nginxImage[3]) < 4)))) {
    errors.push('INTERNAL_TEST_NGINX_IMAGE must use Nginx 1.19.4 or newer for unknown-SNI rejection.');
  }
  if (!/^postgres:17(?:[.-][A-Za-z0-9_.-]+)?@sha256:[a-f0-9]{64}$/.test(value(values, 'INTERNAL_TEST_POSTGRES_IMAGE'))) {
    errors.push('INTERNAL_TEST_POSTGRES_IMAGE must be a digest-pinned PostgreSQL 17 image.');
  }

  const hosts = HOSTS.map((name) => value(values, name));
  const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
  // Neither production domain (public eltnoy.com, private Admin eltnoy.in) nor any subdomain of one.
  if (hosts.some((host) => !hostnamePattern.test(host) || isProductionDomainHostname(host))) {
    errors.push('All INTERNAL_TEST_*_HOSTNAME values must be valid lower-case non-production hostnames.');
  }
  if (new Set(hosts).size !== hosts.length) errors.push('All four internal-testing hostnames must be distinct.');

  const testingRoot = value(values, 'INTERNAL_TEST_ROOT_DIR');
  if (!isAbsolute(testingRoot) || isWithin(repo, testingRoot) || !/(^|[\\/])internal-testing([\\/]|$)/.test(testingRoot)) {
    errors.push('INTERNAL_TEST_ROOT_DIR must be an absolute, external path with an internal-testing directory component.');
  }
  const resourcePaths = [
    'INTERNAL_TEST_SECRETS_DIR',
    'INTERNAL_TEST_POSTGRES_TLS_DIR',
    'INTERNAL_TEST_POSTGRES_CA_FILE',
    'INTERNAL_TEST_PUBLIC_TLS_CERT_DIR',
    'INTERNAL_TEST_ADMIN_TLS_CERT_DIR',
    'INTERNAL_TEST_NGINX_RENDERED_DIR',
  ] as const;
  for (const name of resourcePaths) {
    const path = value(values, name);
    if (!isAbsolute(path) || isWithin(repo, path) || !isWithin(testingRoot, path) || path === testingRoot
      || /(^|[/.])(?:prod|production)(?:[/.]|$)/i.test(path)) {
      errors.push(`${name} must be a dedicated path below INTERNAL_TEST_ROOT_DIR and outside production paths.`);
    }
  }
  if (value(values, 'INTERNAL_TEST_PUBLIC_TLS_CERT_DIR') === value(values, 'INTERNAL_TEST_ADMIN_TLS_CERT_DIR')) {
    errors.push('Testing public and Admin certificate directories must be different.');
  }

  const publicNetwork = subnet(value(values, 'INTERNAL_TEST_PUBLIC_APP_SUBNET'));
  const adminNetwork = subnet(value(values, 'INTERNAL_TEST_ADMIN_APP_SUBNET'));
  if (!publicNetwork) errors.push('INTERNAL_TEST_PUBLIC_APP_SUBNET must be a valid IPv4 CIDR.');
  if (!adminNetwork) errors.push('INTERNAL_TEST_ADMIN_APP_SUBNET must be a valid IPv4 CIDR.');
  if (publicNetwork && (!isPrivateSubnet(publicNetwork) || publicNetwork.prefix < 16 || publicNetwork.prefix > 28)) {
    errors.push('INTERNAL_TEST_PUBLIC_APP_SUBNET must be an RFC1918 subnet between /16 and /28.');
  }
  if (adminNetwork && (!isPrivateSubnet(adminNetwork) || adminNetwork.prefix < 16 || adminNetwork.prefix > 28)) {
    errors.push('INTERNAL_TEST_ADMIN_APP_SUBNET must be an RFC1918 subnet between /16 and /28.');
  }
  if (publicNetwork && adminNetwork && publicNetwork.start <= adminNetwork.end && adminNetwork.start <= publicNetwork.end) {
    errors.push('The internal-testing Docker subnets must not overlap.');
  }

  const addressPairs = [
    ['INTERNAL_TEST_NGINX_PUBLIC_APP_ADDRESS', publicNetwork],
    ['INTERNAL_TEST_API_PUBLIC_APP_ADDRESS', publicNetwork],
    ['INTERNAL_TEST_NGINX_ADMIN_APP_ADDRESS', adminNetwork],
    ['INTERNAL_TEST_API_ADMIN_APP_ADDRESS', adminNetwork],
  ] as const;
  const addresses: number[] = [];
  for (const [name, network] of addressPairs) {
    const parsed = ipv4Number(value(values, name));
    if (parsed === null || !network || !hostInSubnet(parsed, network)) {
      errors.push(`${name} must be a usable host address inside its testing subnet.`);
    } else {
      addresses.push(parsed);
    }
  }
  if (new Set(addresses).size !== addresses.length) errors.push('All internal-testing static container addresses must be distinct.');

  const publicBind = ipv4Number(value(values, 'INTERNAL_TEST_PUBLIC_BIND_ADDRESS'));
  const adminBind = ipv4Number(value(values, 'INTERNAL_TEST_ADMIN_BIND_ADDRESS'));
  const wireguard = ipv4Number(value(values, 'INTERNAL_TEST_WIREGUARD_INTERFACE_ADDRESS'));
  if (publicBind === null || !isPrivateOrShared(publicBind)) errors.push('INTERNAL_TEST_PUBLIC_BIND_ADDRESS must be a private RFC1918 IPv4 address.');
  if (adminBind === null || !isPrivateOrShared(adminBind)) errors.push('INTERNAL_TEST_ADMIN_BIND_ADDRESS must be private or shared IPv4.');
  if (wireguard === null || !isPrivateOrShared(wireguard)) errors.push('INTERNAL_TEST_WIREGUARD_INTERFACE_ADDRESS must be private or shared IPv4.');
  if (adminBind !== null && wireguard !== null && adminBind !== wireguard) {
    errors.push('INTERNAL_TEST_ADMIN_BIND_ADDRESS must equal INTERNAL_TEST_WIREGUARD_INTERFACE_ADDRESS.');
  }
  if (publicBind !== null && adminBind !== null && publicBind === adminBind) errors.push('Public and Admin testing bind addresses must differ.');
  const migrationApproval = value(values, 'INTERNAL_TEST_MIGRATION_APPROVAL');
  const sourceReview = value(values, 'INTERNAL_TEST_PHASE2B_SOURCE_REVIEW');
  const postgresRuntime = value(values, 'INTERNAL_TEST_PHASE2B_POSTGRES17_RUNTIME');
  const schemaMigrations = value(values, 'INTERNAL_TEST_SCHEMA_MIGRATIONS');
  const roleBootstrapApproval = value(values, 'INTERNAL_TEST_ROLE_BOOTSTRAP_APPROVAL');
  const rolePasswordsConfigured = value(values, 'INTERNAL_TEST_ROLE_PASSWORDS_CONFIGURED');
  if (migrationApproval && !['PENDING', 'APPROVED'].includes(migrationApproval)) errors.push('INTERNAL_TEST_MIGRATION_APPROVAL must be PENDING or APPROVED.');
  if (sourceReview && !['PENDING', 'APPROVED'].includes(sourceReview)) errors.push('INTERNAL_TEST_PHASE2B_SOURCE_REVIEW must be PENDING or APPROVED.');
  if (postgresRuntime && !['PENDING', 'PASSED'].includes(postgresRuntime)) errors.push('INTERNAL_TEST_PHASE2B_POSTGRES17_RUNTIME must be PENDING or PASSED.');
  if (schemaMigrations && !['PENDING', 'APPLIED'].includes(schemaMigrations)) errors.push('INTERNAL_TEST_SCHEMA_MIGRATIONS must be PENDING or APPLIED.');
  if (roleBootstrapApproval && !['PENDING', 'APPROVED'].includes(roleBootstrapApproval)) errors.push('INTERNAL_TEST_ROLE_BOOTSTRAP_APPROVAL must be PENDING or APPROVED.');
  if (rolePasswordsConfigured && !['NO', 'YES'].includes(rolePasswordsConfigured)) errors.push('INTERNAL_TEST_ROLE_PASSWORDS_CONFIGURED must be NO or YES.');
  return errors;
}

export function validateInternalTestingFiles(
  values: InternalTestingValues,
  repositoryRoot: string,
  operation: InternalTestingOperation,
): string[] {
  const errors: string[] = [];
  const repo = resolve(repositoryRoot);
  let testingRoot = resolve(value(values, 'INTERNAL_TEST_ROOT_DIR'));
  try {
    testingRoot = realpathSync(testingRoot);
  } catch {
    errors.push('INTERNAL_TEST_ROOT_DIR must exist and resolve safely.');
  }
  const checkPath = (path: string, label: string, kind: 'file' | 'directory', keyMode?: number, owner?: number, group?: number) => {
    try {
      const status = lstatSync(path);
      if (status.isSymbolicLink() || (kind === 'file' ? !status.isFile() : !status.isDirectory())) {
        errors.push(`${label} must be a regular ${kind}, not a symlink.`);
        return;
      }
      let actualPath = path;
      try {
        actualPath = realpathSync(path);
      } catch {
        errors.push(`${label} cannot be resolved safely.`);
        return;
      }
      if (isWithin(repo, actualPath)) errors.push(`${label} must remain outside the repository.`);
      if (!isWithin(testingRoot, actualPath)) errors.push(`${label} must remain inside INTERNAL_TEST_ROOT_DIR.`);
      if (keyMode !== undefined && (status.mode & 0o777) !== keyMode) errors.push(`${label} must have mode ${keyMode.toString(8)}.`);
      if (owner !== undefined && status.uid !== owner) errors.push(`${label} must have owner UID ${owner}.`);
      if (group !== undefined && status.gid !== group) errors.push(`${label} must have group GID ${group}.`);
    } catch {
      errors.push(`${label} is missing or unreadable.`);
    }
  };
  const secrets = value(values, 'INTERNAL_TEST_SECRETS_DIR');
  checkPath(value(values, 'INTERNAL_TEST_ROOT_DIR'), 'INTERNAL_TEST_ROOT_DIR', 'directory');
  checkPath(secrets, 'INTERNAL_TEST_SECRETS_DIR', 'directory');
  checkPath(resolve(secrets, SECRET_FILES[0]), 'postgres_superuser_password', 'file', 0o400, 0, 0);
  checkPath(resolve(secrets, SECRET_FILES[1]), 'eltnoy_app_password', 'file', 0o440, 0, 10001);
  checkPath(resolve(secrets, SECRET_FILES[2]), 'eltnoy_migrator_password', 'file', 0o440, 0, 10002);
  const pgTls = value(values, 'INTERNAL_TEST_POSTGRES_TLS_DIR');
  checkPath(pgTls, 'INTERNAL_TEST_POSTGRES_TLS_DIR', 'directory');
  checkPath(resolve(pgTls, 'server.crt'), 'PostgreSQL server certificate', 'file');
  checkPath(resolve(pgTls, 'server.key'), 'PostgreSQL server private key', 'file', 0o600, 999);
  checkPath(value(values, 'INTERNAL_TEST_POSTGRES_CA_FILE'), 'INTERNAL_TEST_POSTGRES_CA_FILE', 'file');
  for (const [directoryKey, keyLabel] of [
    ['INTERNAL_TEST_PUBLIC_TLS_CERT_DIR', 'Public testing TLS'],
    ['INTERNAL_TEST_ADMIN_TLS_CERT_DIR', 'Admin testing TLS'],
  ] as const) {
    const directory = value(values, directoryKey);
    checkPath(directory, directoryKey, 'directory');
    checkPath(resolve(directory, 'fullchain.pem'), `${keyLabel} certificate`, 'file');
    checkPath(resolve(directory, 'privkey.pem'), `${keyLabel} private key`, 'file', 0o600, 101);
  }
  const rendered = value(values, 'INTERNAL_TEST_NGINX_RENDERED_DIR');
  checkPath(rendered, 'INTERNAL_TEST_NGINX_RENDERED_DIR', 'directory');
  if (operation !== 'render-nginx') {
    checkPath(resolve(rendered, 'public.conf'), 'Rendered public Nginx config', 'file');
    checkPath(resolve(rendered, 'admin.conf'), 'Rendered Admin Nginx config', 'file');
  }
  if (operation === 'bootstrap-roles' || operation === 'set-role-passwords' || operation === 'migrate' || operation === 'start') {
    if (value(values, 'INTERNAL_TEST_ROLE_BOOTSTRAP_APPROVAL') !== 'APPROVED') errors.push('Database role bootstrap is blocked until INTERNAL_TEST_ROLE_BOOTSTRAP_APPROVAL=APPROVED.');
  }
  if (operation === 'migrate' || operation === 'start') {
    if (value(values, 'INTERNAL_TEST_ROLE_PASSWORDS_CONFIGURED') !== 'YES') errors.push('Database operations are blocked until testing role passwords are set from the dedicated secret files.');
    if (value(values, 'INTERNAL_TEST_MIGRATION_APPROVAL') !== 'APPROVED') errors.push('Migration is blocked until INTERNAL_TEST_MIGRATION_APPROVAL=APPROVED.');
    if (value(values, 'INTERNAL_TEST_PHASE2B_SOURCE_REVIEW') !== 'APPROVED') errors.push('Migration is blocked until the independent Phase 2B source review is approved.');
    if (value(values, 'INTERNAL_TEST_PHASE2B_POSTGRES17_RUNTIME') !== 'PASSED') errors.push('Migration is blocked until Phase 2B PostgreSQL 17 runtime validation has passed.');
  }
  if (operation === 'start' && value(values, 'INTERNAL_TEST_SCHEMA_MIGRATIONS') !== 'APPLIED') {
    errors.push('Application start is blocked until the approved internal-testing migrations are marked APPLIED.');
  }
  return errors;
}

export function renderInternalTestingNginx(
  values: InternalTestingValues,
  repositoryRoot: string,
  outputDirectory: string,
): string[] {
  const output = resolve(outputDirectory);
  const repo = resolve(repositoryRoot);
  let testingRoot = resolve(value(values, 'INTERNAL_TEST_ROOT_DIR'));
  try {
    testingRoot = realpathSync(testingRoot);
  } catch {
    return ['INTERNAL_TEST_ROOT_DIR must exist and resolve safely.'];
  }
  if (!isAbsolute(outputDirectory) || isWithin(repo, output)) return ['INTERNAL_TEST_NGINX_RENDERED_DIR must be absolute and outside the repository.'];
  try {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const outputStatus = lstatSync(output);
    const actualOutput = realpathSync(output);
    if (outputStatus.isSymbolicLink() || !outputStatus.isDirectory() || isWithin(repo, actualOutput) || !isWithin(testingRoot, actualOutput)) {
      return ['INTERNAL_TEST_NGINX_RENDERED_DIR must be a non-symlink directory outside the repository.'];
    }
    chmodSync(output, 0o755);
    for (const [templateName, outputName] of TEMPLATE_FILES) {
      const outputPath = resolve(output, outputName);
      try {
        const existing = lstatSync(outputPath);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          return [`${outputName} already exists and is not a regular file.`];
        }
      } catch {
        // A missing destination is expected on the first render.
      }
      let text = readFileSync(resolve(repo, 'deploy/nginx', templateName), 'utf8');
      for (const host of HOSTS) {
        const shortName = host.replace('INTERNAL_TEST_', '').replace('_HOSTNAME', '');
        const hostname = value(values, host);
        text = text.replaceAll(`@@${host}@@`, hostname);
        text = text.replaceAll(`@@INTERNAL_TEST_${shortName}_REGEX@@`, hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
      if (/@@INTERNAL_TEST_[A-Z_]+@@/.test(text)) return [`${templateName} has an unresolved hostname token.`];
      writeFileSync(outputPath, text, { mode: 0o644 });
      chmodSync(outputPath, 0o644);
    }
  } catch {
    return ['Internal-testing Nginx configuration could not be rendered.'];
  }
  return [];
}

export function internalTestingComposeArguments(operation: InternalTestingOperation, envFile: string, repo: string): string[] | null {
  const common = ['--host', 'unix:///var/run/docker.sock', 'compose', '--project-name', INTERNAL_TEST_PROJECT, '-f', resolve(repo, INTERNAL_TEST_COMPOSE_FILE), '--env-file', envFile];
  switch (operation) {
    case 'config': return [...common, 'config', '--quiet'];
    case 'build': return [...common, 'build', 'it_api_public'];
    case 'start-postgres': return [...common, 'up', '-d', 'it_postgres'];
    case 'bootstrap-roles': return [...common, 'exec', '-T', 'it_postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'eltnoy_internal_test_bootstrap', '-d', 'eltnoy_internal_test', '-f', '/run/internal-testing-role-bootstrap.sql'];
    case 'set-role-passwords': return [...common, 'exec', '-it', 'it_postgres', 'psql', '-X', '-U', 'eltnoy_internal_test_bootstrap', '-d', 'eltnoy_internal_test'];
    case 'migrate': return [...common, '--profile', 'ops', 'run', '--rm', 'it_migrate'];
    case 'start': return [...common, 'up', '-d'];
    case 'status': return [...common, 'ps'];
    case 'stop': return [...common, 'stop'];
    case 'preflight':
    case 'render-nginx': return null;
  }
}

export interface InternalTestingRunnerOptions {
  envFilePath: string;
  operation: InternalTestingOperation;
  envText: string;
  repositoryRoot: string;
  environment: Readonly<Record<string, string | undefined>>;
  docker?: (args: readonly string[], environment: NodeJS.ProcessEnv) => number;
  log?: (message: string) => void;
}

export function runInternalTestingOperation(options: InternalTestingRunnerOptions): { code: number; errors: string[] } {
  const parsed = parseInternalTestingEnv(options.envText);
  const errors = [...parsed.errors, ...validateInternalTestingConfiguration(parsed.values, options.envFilePath, options.repositoryRoot)];
  if (Object.keys(options.environment).some((key) => /^(INTERNAL_TEST_|COMPOSE_|DOCKER_)/.test(key))) {
    errors.push('Unset INTERNAL_TEST_*, COMPOSE_*, and DOCKER_* shell variables before using this wrapper.');
  }
  if (Object.keys(options.environment).some((key) => /^(NODE_|TSX_)/.test(key) && key !== 'NODE_ENV')) {
    errors.push('Unset NODE_*/TSX_* runtime override variables before using this wrapper.');
  }
  errors.push(...validateInternalTestingFiles(parsed.values, options.repositoryRoot, options.operation));
  if (errors.length > 0) return { code: 2, errors };

  if (options.operation === 'preflight') {
    options.log?.(`internal-testing preflight passed (${parsed.values.size} settings present; values not shown).`);
    return { code: 0, errors: [] };
  }
  if (options.operation === 'render-nginx') {
    const renderErrors = renderInternalTestingNginx(
      parsed.values,
      options.repositoryRoot,
      value(parsed.values, 'INTERNAL_TEST_NGINX_RENDERED_DIR'),
    );
    if (renderErrors.length > 0) return { code: 2, errors: renderErrors };
    options.log?.('Internal-testing Nginx configuration rendered; no service was started.');
    return { code: 0, errors: [] };
  }

  const dockerArgs = internalTestingComposeArguments(options.operation, resolve(options.envFilePath), options.repositoryRoot);
  if (!dockerArgs) return { code: 2, errors: ['Unsupported internal-testing operation.'] };
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']) {
    const setting = options.environment[name];
    if (setting !== undefined) safeEnvironment[name] = setting;
  }
  if (!options.docker) return { code: 2, errors: ['Docker execution is unavailable in this invocation.'] };
  return { code: options.docker(dockerArgs, safeEnvironment), errors: [] };
}

export function loadInternalTestingEnvFile(path: string, repositoryRoot: string): { text?: string; errors: string[] } {
  const absolute = resolve(path);
  if (!isAbsolute(path) || basename(path) !== INTERNAL_TEST_ENV_BASENAME || isWithin(repositoryRoot, absolute)) {
    return { errors: [`Provide an absolute ${INTERNAL_TEST_ENV_BASENAME} file outside the repository.`] };
  }
  try {
    const status = lstatSync(absolute);
    if (!status.isFile() || status.isSymbolicLink()) return { errors: ['The internal-testing env file must be a regular, non-symlink file.'] };
    if (isWithin(repositoryRoot, realpathSync(absolute))) return { errors: ['The internal-testing env file must resolve outside the repository.'] };
    if ((status.mode & 0o077) !== 0) return { errors: ['The internal-testing env file must not be readable or writable by group or others.'] };
    const uid = process.getuid?.();
    if (uid !== undefined && status.uid !== uid) return { errors: ['The internal-testing env file must be owned by the invoking operator.'] };
    return { text: readFileSync(absolute, 'utf8'), errors: [] };
  } catch {
    return { errors: ['The internal-testing env file could not be read.'] };
  }
}

export function internalTestingMain(argv: readonly string[], repositoryRoot: string): number {
  let envFilePath = '';
  let operation: InternalTestingOperation | '' = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--env-file' && envFilePath === '' && argv[index + 1]) {
      envFilePath = argv[index + 1];
      index += 1;
    } else if (operation === '') {
      operation = argv[index] as InternalTestingOperation;
    } else {
      console.error('internal-testing: refused: invalid arguments.');
      return 2;
    }
  }
  const allowedOperations = new Set<InternalTestingOperation>(['preflight', 'render-nginx', 'config', 'build', 'start-postgres', 'bootstrap-roles', 'set-role-passwords', 'migrate', 'start', 'status', 'stop']);
  if (!envFilePath || !allowedOperations.has(operation as InternalTestingOperation)) {
    console.error('Usage: scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing <preflight|render-nginx|config|build|start-postgres|bootstrap-roles|set-role-passwords|migrate|start|status|stop>');
    return 2;
  }
  const loaded = loadInternalTestingEnvFile(envFilePath, repositoryRoot);
  if (!loaded.text) {
    console.error(`internal-testing: refused:\n${loaded.errors.map((error) => `- ${error}`).join('\n')}`);
    return 2;
  }
  const result = runInternalTestingOperation({
    envFilePath,
    operation: operation as InternalTestingOperation,
    envText: loaded.text,
    repositoryRoot,
    environment: process.env,
    docker: (args, environment) => {
      const child = spawnSync('docker', args, { cwd: repositoryRoot, env: environment, stdio: 'inherit', shell: false });
      if (child.error) {
        console.error('internal-testing: Docker command could not be started.');
        return 1;
      }
      return child.status ?? 1;
    },
    log: console.log,
  });
  if (result.errors.length > 0) console.error(`internal-testing: refused:\n${result.errors.map((error) => `- ${error}`).join('\n')}`);
  return result.code;
}
