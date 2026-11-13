// P1-D.3/P1-D.4: deployment wrapper policy (pure functions) and entry-point subprocesses. Docker is
// never invoked: subprocesses run only `preflight`, `--dry-run` or refusals, with a PATH that
// contains no docker executable. Only synthetic values are used; no real .env file is read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_CONFIG_ENVIRONMENT } from './deploymentConfig.js';
import {
  checkDirectoryStatus,
  checkEnvFileStatus,
  checkExecutableStatus,
  checkPrivateDirectoryStatus,
  checkRequiredVariables,
  checkRuntimeEnvironment,
  checkSearchPath,
  checkShellEnvironment,
  COMPOSE_INTERPOLATED_VARIABLES,
  COMPOSE_PROJECT_NAME,
  dockerArgumentsFor,
  GOVERNED_VARIABLES,
  OPERATIONS,
  OPTIONAL_COMPOSE_VARIABLES,
  parseArguments,
  parseEnvFile,
  PASSTHROUGH_SHELL_VARIABLES,
  planDeployment,
  renderComposeEnvFile,
  REQUIRED_COMPOSE_VARIABLES,
  type FileStatus,
} from './deploymentWrapper.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const composeText = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const activeCompose = composeText.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
const wrapperShell = readFileSync(new URL('../scripts/eltnoy-deploy.sh', import.meta.url), 'utf8');

// Synthetic values only. Distinctive markers let tests prove that values are never printed.
const syntheticValues: Record<string, string> = {
  DEPLOYMENT_MODE: 'production',
  ELTNOY_SURFACE_MODE: 'production',
  DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
  DATABASE_POOL_SIZE: '10',
  ELTNOY_SECRETS_DIR: '/synthetic/secrets-marker-a1',
  POSTGRES_DB: 'syntheticdbmarker',
  POSTGRES_USER: 'syntheticusermarker',
  POSTGRES_TLS_DIR: '/synthetic/postgres-tls-marker',
  POSTGRES_CA_FILE: '/synthetic/ca-marker.crt',
  PUBLIC_TLS_CERT_DIR: '/synthetic/public-cert-marker',
  ADMIN_TLS_CERT_DIR: '/synthetic/admin-cert-marker',
  ELTNOY_API_IMAGE: 'localhost/eltnoy-api:synthetic-marker-tag',
  NGINX_IMAGE: 'synthetic.invalid/nginx@sha256:0000',
  POSTGRES_IMAGE: 'synthetic.invalid/postgres@sha256:0000',
  PUBLIC_BIND_ADDRESS: '10.250.0.10',
  ADMIN_BIND_ADDRESS: '10.251.0.1',
  WIREGUARD_INTERFACE_ADDRESS: '10.251.0.1',
  PUBLIC_APP_SUBNET: '172.30.10.0/24',
  ADMIN_APP_SUBNET: '172.30.20.0/24',
  NGINX_PUBLIC_APP_ADDRESS: '172.30.10.2',
  NGINX_ADMIN_APP_ADDRESS: '172.30.20.2',
  API_PUBLIC_APP_ADDRESS: '172.30.10.3',
  API_ADMIN_APP_ADDRESS: '172.30.20.3',
  ELTNOY_MARKETING_HOSTNAME: 'www.synthetic.invalid',
  ELTNOY_EXAM_HOSTNAME: 'exam.synthetic.invalid',
  ELTNOY_INSTITUTION_HOSTNAME: 'institution.synthetic.invalid',
  ELTNOY_ADMIN_HOSTNAME: 'admin.synthetic.invalid',
  ONLINE_EXAM_RECOVERY_SINCE: '',
};
const markers = ['secrets-marker-a1', 'syntheticdbmarker', 'syntheticusermarker', 'postgres-tls-marker', 'ca-marker',
  'public-cert-marker', 'admin-cert-marker', 'synthetic-marker-tag', '10.250.0.10', '10.251.0.1', '172.30.10', 'synthetic.invalid'];
const envText = (values: Record<string, string>) => `# synthetic\n${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n')}\n`;
const assertNoMarkers = (output: string) => {
  for (const marker of markers) assert.ok(!output.includes(marker), `output must not contain a configured value (${marker})`);
};
const validArguments = { envFile: '/synthetic/env', operation: 'start' as const, dryRun: false };
const fileStatus = (overrides: Partial<FileStatus>): FileStatus => ({ isSymbolicLink: false, isFile: true, isDirectory: false, size: 100, mode: 0o100600, uid: 501, ...overrides });
const directoryStatus = (overrides: Partial<FileStatus>): FileStatus => fileStatus({ isFile: false, isDirectory: true, mode: 0o40755, ...overrides });

// ---------------------------------------------------------------------------
// Governed and required variables (D3-1)
// ---------------------------------------------------------------------------

test('governed variables cover every Compose interpolation and every preflight variable', () => {
  const interpolated = [...new Set([...activeCompose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]))].sort();
  assert.deepEqual([...COMPOSE_INTERPOLATED_VARIABLES], interpolated, 'list must equal docker-compose.yml');
  for (const name of [...interpolated, ...Object.values(DEPLOYMENT_CONFIG_ENVIRONMENT)]) assert.ok(GOVERNED_VARIABLES.includes(name), name);
});

test('required variables equal the ${VAR:?} references; optional ones equal the ${VAR:-} references', () => {
  const required = [...new Set([...activeCompose.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)].map((match) => match[1]))].sort();
  const optional = [...new Set([...activeCompose.matchAll(/\$\{([A-Z_][A-Z0-9_]*):-/g)].map((match) => match[1]))].sort();
  assert.deepEqual([...REQUIRED_COMPOSE_VARIABLES].sort(), required);
  assert.deepEqual([...OPTIONAL_COMPOSE_VARIABLES].sort(), optional);
  assert.deepEqual(required.filter((name) => optional.includes(name)), [], 'no variable is both required and optional');
});

test('every missing or empty required variable is named; optional variables may be absent', () => {
  for (const name of REQUIRED_COMPOSE_VARIABLES) {
    const values = new Map(Object.entries(syntheticValues));
    values.delete(name);
    assert.deepEqual(checkRequiredVariables(values), [`${name} must be set in the env file (required by docker-compose.yml).`]);
    values.set(name, '');
    assert.equal(checkRequiredVariables(values).length, 1, `${name} empty`);
  }
  const withoutOptional = new Map(Object.entries(syntheticValues).filter(([name]) => !(OPTIONAL_COMPOSE_VARIABLES as readonly string[]).includes(name)));
  assert.deepEqual(checkRequiredVariables(withoutOptional), []);
});

// ---------------------------------------------------------------------------
// Arguments and fixed operations (F-1, D3-4)
// ---------------------------------------------------------------------------

test('arguments: one absolute --deployment-env-file, one allowlisted operation, optional --dry-run', () => {
  assert.deepEqual(parseArguments(['--deployment-env-file', '/etc/eltnoy/env', 'start']), { ok: true, value: { envFile: '/etc/eltnoy/env', operation: 'start', dryRun: false } });
  assert.deepEqual(parseArguments(['emergency-stop', '--dry-run', '--deployment-env-file', '/x']), { ok: true, value: { envFile: '/x', operation: 'emergency-stop', dryRun: true } });
});

test('arguments: no default env file, no relative path, no extra flags, services or commands', () => {
  const rejected: string[][] = [
    ['start'],
    ['--deployment-env-file', '.env.production', 'start'],
    ['--deployment-env-file', '/x'],
    ['--deployment-env-file', '/x', 'start', 'stop'],
    ['--deployment-env-file', '/x', '--deployment-env-file', '/y', 'start'],
    ['--deployment-env-file', '/x', 'start', '--no-deps'],
    ['--deployment-env-file', '/x', 'start', 'nginx_admin'],
    ['--deployment-env-file', '/x', 'start', 'nginx_public'],
    ['--deployment-env-file', '/x', 'create'],
    ['--deployment-env-file', '/x', 'up'],
    ['--deployment-env-file', '/x', 'down'],
    ['--deployment-env-file', '/x', 'pull'],
    ['--deployment-env-file', '/x', 'start', '--pull', 'always'],
    ['--deployment-env-file', '/x', 'start', '--pull=always'],
    ['--deployment-env-file', '/x', 'stop', '-v'],
    ['--deployment-env-file', '/x', 'emergency-stop', '--volumes'],
    ['--deployment-env-file', '/x', 'start', ';', 'rm', '-rf', '/'],
    ['--deployment-env-file', '/x', 'start$(id)'],
    ['--deployment-env-file', '/x\nstart', 'start'],
    ['--deployment-env-file', '/x', '__proto__'],
    // Node's own CLI inspects a bare --env-file even after the script path, so the wrapper uses a distinct name.
    ['--env-file', '/x', 'start'],
  ];
  for (const argv of rejected) {
    const result = parseArguments(argv);
    assert.equal(result.ok, false, JSON.stringify(argv));
    if (!result.ok) assert.ok(!result.errors.join(' ').includes('rm -rf') && !result.errors.join(' ').includes('$(id)'));
  }
});

test('operations map to fixed Compose arguments with no bypass flags, volume removal or direct Nginx targets', () => {
  assert.deepEqual(Object.keys(OPERATIONS).sort(), ['build', 'emergency-status', 'emergency-stop', 'migrate', 'preflight', 'start', 'start-postgres', 'status', 'stop']);
  assert.deepEqual(OPERATIONS.start.compose, ['up', '-d']);
  assert.deepEqual(OPERATIONS.build.compose, ['build', 'api_public']);
  assert.deepEqual(OPERATIONS.stop.compose, ['down']);
  assert.deepEqual(OPERATIONS['emergency-stop'], { compose: ['stop'], validation: 'syntax' });
  assert.deepEqual(OPERATIONS['emergency-status'], { compose: ['ps'], validation: 'syntax' });
  for (const [name, { compose, validation }] of Object.entries(OPERATIONS)) {
    const text = (compose ?? []).join(' ');
    assert.doesNotMatch(text, /--no-deps|--pull|--ignore-buildable|\bcreate\b|\bstart\b|\bpull\b|nginx_|-v\b|--volumes|--force-recreate|--build|--rmi/, name);
    if (validation === 'syntax') assert.match(name, /^emergency-/, 'only emergency operations skip the semantic preflight');
    if (name.startsWith('emergency-')) assert.ok(['stop', 'ps'].includes(text), `${name} can only stop or list`);
  }
});

test('docker arguments contain only fixed paths and the generated file, never configured values', () => {
  assert.deepEqual(dockerArgumentsFor('/srv/app', '/tmp/eltnoy-deploy-x/compose.env', ['up', '-d']), [
    'compose', '--project-name', 'eltnoy-production', '--project-directory', '/srv/app', '--file', '/srv/app/docker-compose.yml', '--env-file', '/tmp/eltnoy-deploy-x/compose.env', 'up', '-d',
  ]);
  assert.equal(COMPOSE_PROJECT_NAME, 'eltnoy-production');
});

// ---------------------------------------------------------------------------
// Env file parsing (F-5)
// ---------------------------------------------------------------------------

test('env file: unquoted, double-quoted and single-quoted values, comments and blank lines', () => {
  const { values, errors } = parseEnvFile('# c\n\nA=1\nPUBLIC_BIND_ADDRESS="10.0.0.1"\nADMIN_BIND_ADDRESS=\'10.0.0.2\'\nEMPTY=\nONLINE_EXAM_RECOVERY_SINCE=""\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.fromEntries(values), { A: '1', PUBLIC_BIND_ADDRESS: '10.0.0.1', ADMIN_BIND_ADDRESS: '10.0.0.2', EMPTY: '', ONLINE_EXAM_RECOVERY_SINCE: '' });
});

test('env file: interpolation, escapes, whitespace and comment characters are rejected in governed values', () => {
  for (const value of ['${OTHER}', '$OTHER', '"${OTHER:-10.0.0.1}"', '10.0.0.1\\n', '"10.0.0.1 "', ' 10.0.0.1', '10.0.0.1 # note', '10.0.0.1#x', '`id`', '"a\tb"']) {
    const { errors, values } = parseEnvFile(`PUBLIC_BIND_ADDRESS=${value}\n`);
    assert.equal(errors.length, 1, value);
    assert.ok(!values.has('PUBLIC_BIND_ADDRESS'), value);
    assert.ok(errors[0].startsWith('Line 1: PUBLIC_BIND_ADDRESS'), value);
    assert.ok(!errors[0].includes('OTHER') && !errors[0].includes('10.0.0.1'), 'no value in the error');
  }
});

test('env file: malformed, duplicate, multi-line and control-variable lines fail closed', () => {
  const cases: Array<[string, RegExp]> = [
    ['export DEPLOYMENT_MODE=production\n', /expected KEY=VALUE/],
    [' DEPLOYMENT_MODE=production\n', /expected KEY=VALUE/],
    ['DEPLOYMENT_MODE = production\n', /expected KEY=VALUE/],
    ['NOT A LINE\n', /expected KEY=VALUE/],
    ['DEPLOYMENT_MODE=production\nDEPLOYMENT_MODE=development\n', /defined more than once/],
    ['NOTE="multi\nline"\n', /unbalanced/],
    ['NOTE="a"b"\n', /unbalanced or nested/],
    ['NOTE=a"b\n', /quote inside an unquoted value/],
    ['COMPOSE_PROFILES=ops\n', /Compose\/Docker control variable/],
    ['COMPOSE_PROJECT_NAME=x\n', /Compose\/Docker control variable/],
    ['COMPOSE_FILE=/tmp/x.yml\n', /Compose\/Docker control variable/],
    ['DOCKER_HOST=tcp://x\n', /Compose\/Docker control variable/],
    ['DEPLOYMENT_MODE=production\r\n', /LF line endings/],
    ['DEPLOYMENT_MODE=prod\0uction\n', /NUL byte/],
  ];
  for (const [text, pattern] of cases) {
    const { errors } = parseEnvFile(text);
    assert.ok(errors.some((error) => pattern.test(error)), `${JSON.stringify(text)} → ${errors.join(' | ')}`);
    assert.ok(!errors.join(' ').includes('tcp://x') && !errors.join(' ').includes('prod'), 'no value in the error');
  }
});

test('env file: the committed .env.example template is accepted by the wrapper syntax', () => {
  // Template only (placeholders, no secrets); keeps the documented starting point wrapper-compatible.
  const { errors } = parseEnvFile(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// File, directory and executable trust policy (D3-1, D3-5)
// ---------------------------------------------------------------------------

test('env file status: regular, private, bounded, owned by the operator or root', () => {
  assert.deepEqual(checkEnvFileStatus(fileStatus({}), 501), []);
  assert.deepEqual(checkEnvFileStatus(fileStatus({ mode: 0o100640 }), 501), []);
  assert.deepEqual(checkEnvFileStatus(fileStatus({ uid: 0 }), 501), []);
  assert.match(checkEnvFileStatus(fileStatus({ isSymbolicLink: true }), 501).join(), /symbolic link/);
  assert.match(checkEnvFileStatus(fileStatus({ isFile: false }), 501).join(), /regular file/);
  assert.match(checkEnvFileStatus(fileStatus({ size: 64 * 1024 + 1 }), 501).join(), /must not exceed/);
  assert.match(checkEnvFileStatus(fileStatus({ mode: 0o100660 }), 501).join(), /writable by group or others/);
  assert.match(checkEnvFileStatus(fileStatus({ mode: 0o100644 }), 501).join(), /accessible by others/);
  assert.match(checkEnvFileStatus(fileStatus({ mode: 0o100602 }), 501).join(), /writable by group or others/);
  assert.match(checkEnvFileStatus(fileStatus({ uid: 1000 }), 501).join(), /owned by the operator/);
});

test('directory trust model: operator- or root-owned, not group/other writable unless sticky', () => {
  const label = 'Every directory containing the env file';
  assert.deepEqual(checkDirectoryStatus(directoryStatus({}), 501, label), []);
  assert.deepEqual(checkDirectoryStatus(directoryStatus({ uid: 0, mode: 0o41777 }), 501, label), [], 'sticky /tmp');
  assert.deepEqual(checkDirectoryStatus(directoryStatus({ mode: 0o40700 }), 501, label), []);
  assert.match(checkDirectoryStatus(directoryStatus({ mode: 0o40777 }), 501, label).join(), /not be writable by group or others/);
  assert.match(checkDirectoryStatus(directoryStatus({ mode: 0o40775 }), 501, label).join(), /not be writable by group or others/);
  assert.match(checkDirectoryStatus(directoryStatus({ uid: 1000 }), 501, label).join(), /owned by the operator or root/);
  assert.match(checkDirectoryStatus(directoryStatus({ isSymbolicLink: true }), 501, label).join(), /real directory/);
  assert.match(checkDirectoryStatus(fileStatus({}), 501, label).join(), /real directory/);
  for (const error of checkDirectoryStatus(directoryStatus({ mode: 0o40777, uid: 7 }), 501, label)) assert.ok(error.startsWith(label), 'label only, no path');
});

test('private run directory: operator-owned and exactly 0700', () => {
  assert.deepEqual(checkPrivateDirectoryStatus(directoryStatus({ mode: 0o40700 }), 501), []);
  assert.match(checkPrivateDirectoryStatus(directoryStatus({ mode: 0o40750 }), 501).join(), /mode 0700/);
  assert.match(checkPrivateDirectoryStatus(directoryStatus({ mode: 0o40700, uid: 0 }), 501).join(), /owned by the operator/);
});

test('executables: regular, executable, owned by the operator or root, not group/other writable', () => {
  const label = 'The docker executable';
  assert.deepEqual(checkExecutableStatus(fileStatus({ mode: 0o100755 }), 501, label), []);
  assert.deepEqual(checkExecutableStatus(fileStatus({ mode: 0o100555, uid: 0 }), 501, label), []);
  assert.match(checkExecutableStatus(fileStatus({ mode: 0o100775 }), 501, label).join(), /not be writable/);
  assert.match(checkExecutableStatus(fileStatus({ mode: 0o100757 }), 501, label).join(), /not be writable/);
  assert.match(checkExecutableStatus(fileStatus({ mode: 0o100644 }), 501, label).join(), /must be executable/);
  assert.match(checkExecutableStatus(fileStatus({ mode: 0o100755, uid: 1000 }), 501, label).join(), /owned by the operator or root/);
  assert.match(checkExecutableStatus(directoryStatus({}), 501, label).join(), /regular file/);
});

test('PATH must contain only absolute entries; Node/tsx runtime overrides are rejected (NODE_ENV allowed)', () => {
  assert.deepEqual(checkSearchPath('/usr/local/bin:/usr/bin:/bin'), []);
  for (const path of [undefined, '', '.:/usr/bin', '/usr/bin:', ':/usr/bin', '/usr/bin::/bin', 'bin:/usr/bin', '/usr/bin:./node_modules/.bin']) {
    assert.equal(checkSearchPath(path).length, 1, String(path));
  }
  assert.deepEqual(checkRuntimeEnvironment({ NODE_ENV: 'production', PATH: '/bin', NODEX: '1' }), []);
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_PRESERVE_SYMLINKS', 'NODE_V8_COVERAGE', 'TSX_TSCONFIG_PATH']) {
    const errors = checkRuntimeEnvironment({ [name]: '--require /tmp/evil.js' });
    assert.equal(errors.length, 1, name);
    assert.ok(errors[0].startsWith(name) && !errors[0].includes('evil'));
  }
  // P4-4: exported shell functions, including unusual names containing `%`; the name is not echoed.
  for (const name of ['BASH_FUNC_env%%', 'BASH_FUNC_printf%%', 'BASH_FUNC_x', 'BASH_FUNC_[%%', 'weird%name']) {
    const errors = checkRuntimeEnvironment({ [name]: '() { :; }' });
    assert.deepEqual(errors, ['An exported shell function (BASH_FUNC_*) is set in the environment; exported shell functions are not accepted.'], name);
  }
  assert.equal(checkRuntimeEnvironment({ 'BASH_FUNC_a%%': 'x', 'BASH_FUNC_b%%': 'y' }).length, 1, 'reported once');
});

// ---------------------------------------------------------------------------
// Shell overrides, generated file and the plan (F-5, D3-1)
// ---------------------------------------------------------------------------

test('shell overrides of governed variables and Compose/Docker control variables are rejected', () => {
  for (const name of GOVERNED_VARIABLES) {
    const errors = checkShellEnvironment({ [name]: '' });
    assert.equal(errors.length, 1, name);
    assert.ok(errors[0].startsWith(name));
  }
  for (const name of ['COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_ENV_FILES', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    assert.equal(checkShellEnvironment({ [name]: 'x' }).length, 1, name);
  }
  assert.deepEqual(checkShellEnvironment({ PATH: '/bin', HOME: '/home/op', DATABASE_URL: 'ignored' }), []);
});

test('generated file renders only governed, validated values as unambiguous KEY=VALUE lines', () => {
  const rendered = renderComposeEnvFile({ PUBLIC_BIND_ADDRESS: '10.0.0.1', ONLINE_EXAM_RECOVERY_SINCE: '' });
  assert.equal(rendered, 'ONLINE_EXAM_RECOVERY_SINCE=\nPUBLIC_BIND_ADDRESS=10.0.0.1\n');
  assert.deepEqual(Object.fromEntries(parseEnvFile(rendered).values), { ONLINE_EXAM_RECOVERY_SINCE: '', PUBLIC_BIND_ADDRESS: '10.0.0.1' }, 'round-trips');
  assert.throws(() => renderComposeEnvFile({ COMPOSE_PROFILES: 'ops' }), /refusing/);
  assert.throws(() => renderComposeEnvFile({ DATABASE_URL: 'x' }), /refusing/);
  assert.throws(() => renderComposeEnvFile({ PUBLIC_BIND_ADDRESS: '${X}' }), /refusing/);
  assert.throws(() => renderComposeEnvFile({ PUBLIC_BIND_ADDRESS: 'a\nCOMPOSE_PROFILES=ops' }), /refusing/);
});

test('plan: Docker receives allowlisted shell variables plus exactly the validated governed values', () => {
  const result = planDeployment({
    arguments: validArguments,
    envFileText: `${envText(syntheticValues)}UNRELATED=kept-out\nDATABASE_URL=kept-out\n`,
    shellEnvironment: { PATH: '/usr/bin', HOME: '/home/op', SSH_AUTH_SOCK: '/tmp/agent', DATABASE_URL: 'shell-only' },
  });
  assert.ok(result.ok, result.ok ? '' : result.errors.join(' | '));
  if (!result.ok) return;
  assert.deepEqual(result.plan.composeArguments, ['up', '-d']);
  assert.equal(result.plan.validation, 'full');
  assert.deepEqual(result.plan.governedValues, syntheticValues, 'validated values are the parsed file values');
  assert.deepEqual(result.plan.childEnvironment, { PATH: '/usr/bin', HOME: '/home/op', ...syntheticValues });
  for (const name of Object.keys(result.plan.childEnvironment ?? {})) {
    assert.ok(GOVERNED_VARIABLES.includes(name) || (PASSTHROUGH_SHELL_VARIABLES as readonly string[]).includes(name), name);
  }
});

test('plan: preflight runs no Docker command; invalid config, missing required values and overrides are refused', () => {
  const preflight = planDeployment({ arguments: { ...validArguments, operation: 'preflight' }, envFileText: envText(syntheticValues), shellEnvironment: {} });
  assert.ok(preflight.ok && preflight.plan.composeArguments === null && preflight.plan.childEnvironment === null);

  const invalid = planDeployment({ arguments: validArguments, envFileText: envText({ ...syntheticValues, ADMIN_BIND_ADDRESS: '0.0.0.0' }), shellEnvironment: {} });
  assert.ok(!invalid.ok && invalid.errors.some((error) => error.startsWith('ADMIN_BIND_ADDRESS')));
  if (!invalid.ok) assertNoMarkers(invalid.errors.join('\n'));

  const override = planDeployment({ arguments: validArguments, envFileText: envText(syntheticValues), shellEnvironment: { ADMIN_BIND_ADDRESS: '10.251.0.1' } });
  assert.ok(!override.ok && override.errors.some((error) => error.startsWith('ADMIN_BIND_ADDRESS is set in the shell')));

  const runtime = planDeployment({ arguments: validArguments, envFileText: envText(syntheticValues), shellEnvironment: { NODE_OPTIONS: '--inspect' } });
  assert.ok(!runtime.ok && runtime.errors.some((error) => error.startsWith('NODE_OPTIONS')));

  // A required variable that the semantic preflight does not otherwise check (D3-1).
  const missing = { ...syntheticValues };
  delete missing.NGINX_IMAGE;
  const incomplete = planDeployment({ arguments: validArguments, envFileText: envText(missing), shellEnvironment: {} });
  assert.ok(!incomplete.ok && incomplete.errors.includes('NGINX_IMAGE must be set in the env file (required by docker-compose.yml).'));
});

test('plan: emergency operations skip only the semantic and required-variable checks', () => {
  const broken: Record<string, string> = { ...syntheticValues, ADMIN_BIND_ADDRESS: '0.0.0.0' };
  delete broken.NGINX_IMAGE;
  for (const operation of ['emergency-stop', 'emergency-status'] as const) {
    const result = planDeployment({ arguments: { ...validArguments, operation }, envFileText: envText(broken), shellEnvironment: {} });
    assert.ok(result.ok && result.plan.validation === 'syntax', operation);
    if (result.ok) assert.ok(!('NGINX_IMAGE' in result.plan.governedValues), 'absent values stay absent');
  }
  for (const operation of ['stop', 'status'] as const) {
    assert.equal(planDeployment({ arguments: { ...validArguments, operation }, envFileText: envText(broken), shellEnvironment: {} }).ok, false, operation);
  }
  // File, syntax and shell checks still apply.
  assert.equal(planDeployment({ arguments: { ...validArguments, operation: 'emergency-stop' }, envFileText: 'COMPOSE_PROFILES=ops\n', shellEnvironment: {} }).ok, false);
  assert.equal(planDeployment({ arguments: { ...validArguments, operation: 'emergency-stop' }, envFileText: 'PUBLIC_BIND_ADDRESS=${X}\n', shellEnvironment: {} }).ok, false);
  assert.equal(planDeployment({ arguments: { ...validArguments, operation: 'emergency-stop' }, envFileText: envText(syntheticValues), shellEnvironment: { COMPOSE_PROFILES: 'ops' } }).ok, false);
});

// ---------------------------------------------------------------------------
// Shell entry (D3-5, D3-8)
// ---------------------------------------------------------------------------

test('shell wrapper: no eval, no external commands, and the checks run in the required order', () => {
  const active = wrapperShell.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.match(active, /^set -eu$/m);
  assert.doesNotMatch(active, /\beval\b|\bsource\b|^\s*\.\s|\$\*|docker/m);
  // P4-3: only shell built-ins and node run; no PATH lookup of env, grep, sed, tr, dirname or others.
  assert.doesNotMatch(active, /\b(env|grep|sed|tr|dirname|basename|awk|cut|head|stat|ls|cat|readlink|realpath)\b(?!_)/);
  assert.match(active, /exec "\$node_executable" --import tsx "\$repository_root\/server\/deploy\.ts" "\$@"$/m);
  const steps = ['imported_functions=$(export -pf)', 'set -eu', '[ -L "$0" ]', 'search_path=', 'exported=$(export -p)', 'node_executable=$(command -v node', 'exec "$node_executable"'];
  const order = steps.map((needle) => active.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), `all steps present: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'function check, symlink check, PATH, runtime variables, node, exec');
  assert.ok(active.indexOf('refuse() {') > active.indexOf('imported_functions=$(export -pf)'), 'no own function exists during the function check');
});

// ---------------------------------------------------------------------------
// Subprocesses: preflight script, Node entry and shell entry (no Docker)
// ---------------------------------------------------------------------------

const work = realpathSync(mkdtempSync(join(tmpdir(), 'eltnoy-p1d4-wrapper-')));
const emptyPath = join(work, 'empty-path');
const envDirectory = join(work, 'env');
for (const directory of [emptyPath, envDirectory]) {
  mkdirSync(directory);
  chmodSync(directory, 0o700);
}
test.after(() => rmSync(work, { recursive: true, force: true }));

const writePrivate = (name: string, text: string, mode = 0o600) => {
  const path = join(envDirectory, name);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};

let copiedEntryPath: string | undefined;
const copiedEntry = () => {
  if (copiedEntryPath) return copiedEntryPath;
  const server = join(work, 'entry-repo', 'server');
  mkdirSync(server, { recursive: true, mode: 0o700 });
  writeFileSync(join(work, 'entry-repo', 'package.json'), '{ "type": "module" }\n');
  for (const file of ['deploy.ts', 'deploymentRunner.ts', 'deploymentWrapper.ts', 'deploymentConfig.ts']) {
    copyFileSync(join(repositoryRoot, 'server', file), join(server, file));
  }
  copiedEntryPath = join(server, 'deploy.ts');
  return copiedEntryPath;
};

const runNode = (script: string, args: string[], environment: Record<string, string>) => spawnSync(
  process.execPath, ['--import', 'tsx', script, ...args],
  { cwd: repositoryRoot, env: { PATH: emptyPath, ...environment }, encoding: 'utf8', timeout: 30_000 },
);

test('subprocess: validateDeploymentConfig.ts exits non-zero on missing configuration without printing values', () => {
  const missing = runNode('server/validateDeploymentConfig.ts', [], {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Invalid deployment configuration/);
  for (const name of Object.values(DEPLOYMENT_CONFIG_ENVIRONMENT)) assert.match(missing.stderr, new RegExp(name));

  const invalid = runNode('server/validateDeploymentConfig.ts', [], {
    ...syntheticValues, PUBLIC_BIND_ADDRESS: '203.0.113.77', ADMIN_BIND_ADDRESS: 'admin-marker.synthetic.invalid', ELTNOY_API_IMAGE: 'docker.io/marker/image:1',
  });
  assert.equal(invalid.status, 1);
  assertNoMarkers(invalid.stdout + invalid.stderr);
  assert.ok(!(invalid.stdout + invalid.stderr).includes('203.0.113.77') && !invalid.stderr.includes('docker.io/marker'));

  const valid = runNode('server/validateDeploymentConfig.ts', [], syntheticValues);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout + valid.stderr, '');
});

test('subprocess: Node entry preflight and --dry-run never print values and never run Docker', () => {
  const envFile = writePrivate('env.synthetic', envText(syntheticValues));
  const preflight = runNode('server/deploy.ts', ['--deployment-env-file', envFile, 'preflight'], {});
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, /preflight passed/);
  assert.doesNotMatch(preflight.stdout, /would run|running/);
  assertNoMarkers(preflight.stdout + preflight.stderr);

  // P4-5: the real checkout may contain a .env entry, so the dry run uses byte-identical copies of
  // the entry modules in a synthetic repository without one.
  const dryRun = runNode(copiedEntry(), ['--deployment-env-file', envFile, 'start', '--dry-run'], {});
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /would run: docker compose --project-name eltnoy-production --project-directory \S+ --file \S+docker-compose\.yml --env-file <private run directory>\/compose\.env up -d$/m);
  assert.ok(!dryRun.stdout.includes(envFile), 'Compose is never pointed at the operator file');
  assertNoMarkers(dryRun.stdout + dryRun.stderr);

  // In the real checkout, a .env entry (if present; only its existence is checked) blocks it.
  const checkoutHasDotEnv = (() => {
    try { lstatSync(join(repositoryRoot, '.env')); return true; } catch { return false; }
  })();
  const realDryRun = runNode('server/deploy.ts', ['--deployment-env-file', envFile, 'start', '--dry-run'], {});
  if (checkoutHasDotEnv) {
    assert.equal(realDryRun.status, 1);
    assert.match(realDryRun.stderr, /A \.env entry exists at the repository root/);
  } else {
    assert.equal(realDryRun.status, 0, realDryRun.stderr);
  }
  assertNoMarkers(realDryRun.stdout + realDryRun.stderr);
});

test('subprocess: Node entry fails closed on overrides, bad files and bad arguments', () => {
  const envFile = writePrivate('env.checked', envText(syntheticValues));

  const override = runNode('server/deploy.ts', ['--deployment-env-file', envFile, 'start', '--dry-run'], { PUBLIC_BIND_ADDRESS: '10.250.0.10' });
  assert.equal(override.status, 1);
  assert.match(override.stderr, /PUBLIC_BIND_ADDRESS is set in the shell environment/);
  assertNoMarkers(override.stdout + override.stderr);

  const missingFile = runNode('server/deploy.ts', ['--deployment-env-file', join(envDirectory, 'absent'), 'preflight'], {});
  assert.equal(missingFile.status, 1);
  assert.match(missingFile.stderr, /could not be opened \(ENOENT\)/);

  const link = join(envDirectory, 'env.link');
  symlinkSync(envFile, link);
  assert.match(runNode('server/deploy.ts', ['--deployment-env-file', link, 'preflight'], {}).stderr, /must not be a symbolic link/);

  const looseRun = runNode('server/deploy.ts', ['--deployment-env-file', writePrivate('env.loose', envText(syntheticValues), 0o644), 'preflight'], {});
  assert.equal(looseRun.status, 1);
  assert.match(looseRun.stderr, /accessible by others/);

  const interpolatedRun = runNode('server/deploy.ts', ['--deployment-env-file', writePrivate('env.interpolated', envText({ ...syntheticValues, ADMIN_BIND_ADDRESS: '${WIREGUARD_INTERFACE_ADDRESS}' })), 'start', '--dry-run'], {});
  assert.equal(interpolatedRun.status, 1);
  assert.match(interpolatedRun.stderr, /ADMIN_BIND_ADDRESS contains a disallowed character/);

  const badArguments = runNode('server/deploy.ts', ['--deployment-env-file', envFile, 'start', '--no-deps'], {});
  assert.equal(badArguments.status, 1);
  assert.match(badArguments.stderr, /Argument 4 is not an accepted option or operation/);
  assert.doesNotMatch(badArguments.stdout, /running|would run/);

  const relativePath = runNode('server/deploy.ts', ['--deployment-env-file', envFile, 'preflight'], { PATH: `${emptyPath}:relative` });
  assert.equal(relativePath.status, 1);
  assert.match(relativePath.stderr, /PATH must contain only absolute directories/);

  // P4-4: the Node entry refuses exported shell functions independently of the shell entry.
  const exportedFunction = runNode('server/deploy.ts', ['--deployment-env-file', envFile, 'start', '--dry-run'], { 'BASH_FUNC_env%%': '() { :; }' });
  assert.equal(exportedFunction.status, 1);
  assert.match(exportedFunction.stderr, /exported shell functions are not accepted/);
  assert.doesNotMatch(exportedFunction.stdout, /would run|running/);
});

const shellPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
const runShell = (script: string, args: string[], environment: Record<string, string>, cwd = repositoryRoot) => spawnSync(
  '/bin/sh', [script, ...args],
  { cwd, env: { PATH: shellPath, ...environment }, encoding: 'utf8', timeout: 30_000 },
);
const shellIsBash = (spawnSync('/bin/sh', ['-c', 'printf %s "${BASH_VERSION:-}"'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout ?? '') !== '';

// Stand-ins for external commands that write a sentinel if ever executed (P4-3).
const fakeCommands = join(work, 'fake-commands');
const commandSentinel = join(work, 'external-command-ran');
mkdirSync(fakeCommands, { mode: 0o700 });
for (const name of ['env', 'grep', 'sed', 'tr', 'dirname', 'basename', 'cut', 'head', 'cat', 'awk']) {
  writeFileSync(join(fakeCommands, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${commandSentinel}'\nexit 0\n`);
  chmodSync(join(fakeCommands, name), 0o700);
}

test('shell entry: refuses Node/tsx runtime overrides and relative PATH entries before Node starts', () => {
  const envFile = writePrivate('env.shell', envText(syntheticValues));
  const sentinel = join(work, 'sentinel-must-not-exist');
  const preload = join(work, 'preload.cjs');
  writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x');\n`);
  for (const [name, value] of [['NODE_OPTIONS', `--require ${preload}`], ['NODE_PATH', work], ['TSX_TSCONFIG_PATH', '/x']]) {
    const result = runShell('scripts/eltnoy-deploy.sh', ['--deployment-env-file', envFile, 'preflight'], { [name]: value });
    assert.equal(result.status, 2, name);
    assert.match(result.stderr, new RegExp(`refused: Node/tsx runtime variables are set \\(${name}`));
    assert.ok(!result.stderr.includes(value), 'value not printed');
  }
  assert.throws(() => readFileSync(sentinel), 'the preload never ran');
  for (const path of [`.:${shellPath}`, `${shellPath}:`, `${shellPath}::/bin`, `bin:${shellPath}`]) {
    const result = runShell('scripts/eltnoy-deploy.sh', ['--deployment-env-file', envFile, 'preflight'], { PATH: path });
    assert.equal(result.status, 2, path);
    assert.match(result.stderr, /PATH must contain only absolute directories/);
  }
  const allowed = runShell('scripts/eltnoy-deploy.sh', ['--deployment-env-file', envFile, 'preflight'], { NODE_ENV: 'production' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /preflight passed/);
  assertNoMarkers(allowed.stdout + allowed.stderr);
});

test('shell entry: PATH is validated before any external command could run (P4-3)', () => {
  const envFile = writePrivate('env.order', envText(syntheticValues));
  const scriptPath = join(repositoryRoot, 'scripts/eltnoy-deploy.sh');
  // A relative PATH entry that would resolve to the stand-ins: refused, and none of them ran.
  const relative = runShell(scriptPath, ['--deployment-env-file', envFile, 'preflight'], { PATH: `fake-commands:${shellPath}`, NODE_OPTIONS: '--x' }, work);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /PATH must contain only absolute directories/);
  assert.ok(!existsSync(commandSentinel), 'no external command ran before PATH validation');
  // An absolute PATH whose first entry holds the stand-ins: the script still runs no external
  // command except node (the preflight succeeds and the sentinel is never written).
  const absolute = runShell(scriptPath, ['--deployment-env-file', envFile, 'preflight'], { PATH: `${fakeCommands}:${shellPath}` }, work);
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.match(absolute.stdout, /preflight passed/);
  assert.ok(!existsSync(commandSentinel), 'the script uses only built-ins and node');
  assertNoMarkers(absolute.stdout + absolute.stderr);
});

test('shell entry: exported shell functions (BASH_FUNC_*) are refused before anything else runs (P4-4)', () => {
  const envFile = writePrivate('env.functions', envText(syntheticValues));
  const sentinel = join(work, 'imported-function-ran');
  const body = `() { : > '${sentinel}'; }`;
  for (const name of ['BASH_FUNC_env%%', 'BASH_FUNC_export%%', 'BASH_FUNC_printf%%', 'BASH_FUNC_[%%', 'BASH_FUNC_command%%', 'BASH_FUNC_unset%%']) {
    const result = runShell('scripts/eltnoy-deploy.sh', ['--deployment-env-file', envFile, 'start', '--dry-run'], { [name]: body });
    // bash (macOS /bin/sh) refuses in the shell (exit 2); dash imports no functions and the Node
    // entry refuses the variable (exit 1). Either way nothing is planned or run.
    assert.equal(result.status, shellIsBash ? 2 : 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /exported shell functions/, name);
    assert.doesNotMatch(result.stdout, /preflight passed|would run|running/, name);
    assert.ok(!existsSync(sentinel), `${name}: the imported function never ran`);
  }
});

test('shell entry: invocation through a symbolic link is refused', () => {
  const link = join(work, 'eltnoy-deploy-link.sh');
  symlinkSync(join(repositoryRoot, 'scripts/eltnoy-deploy.sh'), link);
  const result = runShell(link, ['--deployment-env-file', '/x', 'preflight'], {});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not through a symbolic link/);
});
