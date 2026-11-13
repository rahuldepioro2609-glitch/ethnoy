// P1-D.4 (D3-1, D3-4, D3-5; P4-5, P4-6, P4-8, P4-9): deployment runner file handling, race
// behaviour, cleanup and cancellation. Real Docker is never started: runDeployment receives an
// injected runDocker, and the one subprocess test of the real entry point uses a stand-in `docker`
// script in a private directory that only records that it was invoked. Synthetic values only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkDirectoryChain, checkRepositoryEnvEntry, createGeneratedEnvFile, emergencyWarning, loadOperatorEnvFile,
  resolveTrustedExecutable, runDeployment, type DockerResult, type RunOptions,
} from './deploymentRunner.js';
import { COMPOSE_PROJECT_NAME, GENERATED_ENV_FILE_NAME, GOVERNED_VARIABLES, MAX_ENV_FILE_BYTES, renderComposeEnvFile } from './deploymentWrapper.js';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const uid = process.getuid?.();

const synthetic: Record<string, string> = {
  DEPLOYMENT_MODE: 'production', ELTNOY_SURFACE_MODE: 'production', DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
  ELTNOY_SECRETS_DIR: '/synthetic/secrets-marker-r1', POSTGRES_DB: 'syntheticdbmarkerr', POSTGRES_USER: 'syntheticusermarkerr',
  POSTGRES_TLS_DIR: '/synthetic/pg-tls-r', POSTGRES_CA_FILE: '/synthetic/ca-r.crt', PUBLIC_TLS_CERT_DIR: '/synthetic/public-r',
  ADMIN_TLS_CERT_DIR: '/synthetic/admin-r', ELTNOY_API_IMAGE: 'localhost/eltnoy-api:runner-marker', NGINX_IMAGE: 'synthetic.invalid/nginx@sha256:1',
  POSTGRES_IMAGE: 'synthetic.invalid/postgres@sha256:1', PUBLIC_BIND_ADDRESS: '10.250.0.20', ADMIN_BIND_ADDRESS: '10.251.0.2',
  WIREGUARD_INTERFACE_ADDRESS: '10.251.0.2', PUBLIC_APP_SUBNET: '172.30.10.0/24', ADMIN_APP_SUBNET: '172.30.20.0/24',
  NGINX_PUBLIC_APP_ADDRESS: '172.30.10.2', NGINX_ADMIN_APP_ADDRESS: '172.30.20.2', API_PUBLIC_APP_ADDRESS: '172.30.10.3',
  API_ADMIN_APP_ADDRESS: '172.30.20.3',
};
const markers = ['secrets-marker-r1', 'syntheticdbmarkerr', 'syntheticusermarkerr', 'runner-marker', '10.250.0.20', '10.251.0.2', 'synthetic.invalid'];
const envText = (values: Record<string, string>) => `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;

// Private workspace: <tmp>/eltnoy-p1d4-runner-*/{env,bin,tmp,repo} (0700 except where a test loosens one).
const work = realpathSync(mkdtempSync(join(tmpdir(), 'eltnoy-p1d4-runner-')));
const privateDirectory = (...parts: string[]) => {
  const path = join(work, ...parts);
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);
  return path;
};
const envDirectory = privateDirectory('env');
const binDirectory = privateDirectory('bin');
const temporaryRoot = privateDirectory('tmp');
// A synthetic repository root with no `.env` entry (the real checkout may have one; P4-5).
const repositoryRoot = privateDirectory('repo');
// Placeholder only: never executed by these unit tests (runDocker is injected).
writeFileSync(join(binDirectory, 'docker'), '#!/bin/sh\nexit 99\n');
chmodSync(join(binDirectory, 'docker'), 0o700);
test.after(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
const writeEnv = (text: string, mode = 0o600, directory = envDirectory) => {
  counter += 1;
  const path = join(directory, `env-${counter}`);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};

interface Captured {
  dockerPath: string;
  args: readonly string[];
  environment: Record<string, string>;
  file: string;
  content: string;
  fileMode: number;
  directoryMode: number;
}

const run = async (argv: string[], overrides: Partial<RunOptions> = {}, docker: (captured: Captured) => DockerResult = () => ({ status: 0 })) => {
  const out: string[] = [];
  const err: string[] = [];
  let captured: Captured | undefined;
  let code: number | undefined;
  let thrown: unknown;
  try {
    code = await runDeployment({
      argv,
      environment: { PATH: `${binDirectory}:/usr/bin:/bin`, HOME: '/synthetic-home' },
      currentUid: uid,
      repositoryRoot,
      temporaryRoot,
      nodeExecutable: process.execPath,
      runDocker: (dockerPath, args, environment) => {
        const file = args[args.indexOf('--env-file') + 1];
        captured = {
          dockerPath, args, environment, file,
          content: readFileSync(file, 'utf8'),
          fileMode: lstatSync(file).mode & 0o7777,
          directoryMode: lstatSync(dirname(file)).mode & 0o7777,
        };
        return docker(captured);
      },
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      ...overrides,
    });
  } catch (error) {
    thrown = error;
  }
  const output = [...out, ...err].join('\n');
  for (const marker of markers) assert.ok(!output.includes(marker), `output must not contain a configured value (${marker})`);
  return { code, out: out.join('\n'), err: err.join('\n'), captured, thrown };
};
const leftovers = () => readdirSync(temporaryRoot);

// ---------------------------------------------------------------------------
// Generated file (D3-1) and project name (P4-8)
// ---------------------------------------------------------------------------

test('Compose receives a private generated file with exactly the validated values, then it is removed', async () => {
  const envFile = writeEnv(`${envText(synthetic)}UNRELATED=not-forwarded\n# comment\n`);
  const result = await run(['--deployment-env-file', envFile, 'start']);
  assert.equal(result.code, 0, result.err);
  const captured = result.captured as Captured;
  assert.ok(captured, 'runDocker was called');
  assert.equal(captured.dockerPath, realpathSync(join(binDirectory, 'docker')), 'docker resolved to an absolute trusted path');
  assert.deepEqual(captured.args, [
    'compose', '--project-name', COMPOSE_PROJECT_NAME, '--project-directory', repositoryRoot, '--file', join(repositoryRoot, 'docker-compose.yml'),
    '--env-file', captured.file, 'up', '-d',
  ]);
  assert.ok(!captured.args.includes(envFile), 'Compose never reads the operator file');
  assert.equal(dirname(dirname(captured.file)), realpathSync(temporaryRoot));
  assert.equal(captured.file.endsWith(`/${GENERATED_ENV_FILE_NAME}`), true);
  assert.equal(captured.fileMode, 0o600);
  assert.equal(captured.directoryMode, 0o700);
  assert.equal(captured.content, renderComposeEnvFile(synthetic), 'generated file = validated values');
  const generatedNames = captured.content.trim().split('\n').map((line) => line.slice(0, line.indexOf('=')));
  assert.ok(generatedNames.every((name) => GOVERNED_VARIABLES.includes(name)), 'only governed variable names');
  assert.ok(!captured.content.includes('UNRELATED') && !captured.content.includes('COMPOSE_'));
  for (const [name, value] of Object.entries(synthetic)) assert.equal(captured.environment[name], value, `${name}: same value in the environment`);
  assert.equal(captured.environment.PATH, `${binDirectory}:/usr/bin:/bin`);
  assert.ok(!existsSync(captured.file) && !existsSync(dirname(captured.file)), 'cleaned up after success');
  assert.deepEqual(leftovers(), []);
  assert.ok(!result.out.includes(captured.file), 'the generated path is not printed (placeholder only)');
});

test('the Compose project name is pinned in docker-compose.yml and on every wrapper call (P4-8)', async () => {
  const composeText = readFileSync(join(sourceRoot, 'docker-compose.yml'), 'utf8');
  assert.deepEqual(composeText.split('\n').filter((line) => /^name:/.test(line)), [`name: ${COMPOSE_PROJECT_NAME}`]);
  assert.match(COMPOSE_PROJECT_NAME, /^eltnoy-production$/);
  const envFile = writeEnv(envText(synthetic));
  for (const operation of ['build', 'start-postgres', 'migrate', 'start', 'status', 'stop', 'emergency-status', 'emergency-stop']) {
    const result = await run(['--deployment-env-file', envFile, operation]);
    assert.deepEqual(result.captured?.args.slice(0, 3), ['compose', '--project-name', COMPOSE_PROJECT_NAME], operation);
  }
  assert.deepEqual(leftovers(), []);
});

test('the generated file is removed when Docker fails, cannot start, or the runner throws', async () => {
  const envFile = writeEnv(envText(synthetic));
  const failed = await run(['--deployment-env-file', envFile, 'start'], {}, () => ({ status: 17 }));
  assert.equal(failed.code, 17);
  const notStarted = await run(['--deployment-env-file', envFile, 'start'], {}, () => ({ status: null, errorCode: 'ENOENT' }));
  assert.equal(notStarted.code, 1);
  assert.match(notStarted.err, /Docker could not be started \(ENOENT\)/);
  const signalled = await run(['--deployment-env-file', envFile, 'stop'], {}, () => ({ status: null }));
  assert.equal(signalled.code, 1);
  const thrown = await run(['--deployment-env-file', envFile, 'start'], {}, () => { throw new Error('synthetic failure'); });
  assert.match(String(thrown.thrown), /synthetic failure/);
  for (const result of [failed, notStarted, signalled, thrown]) assert.ok(result.captured && !existsSync(dirname(result.captured.file)));
  assert.deepEqual(leftovers(), []);
});

test('a later change to the operator file cannot reach Compose', async () => {
  const envFile = writeEnv(envText(synthetic));
  const result = await run(['--deployment-env-file', envFile, 'start'], {}, (captured) => {
    // While "Compose" runs: rewrite the operator file with an extra profile and a changed bind address.
    writeFileSync(envFile, `${envText({ ...synthetic, PUBLIC_BIND_ADDRESS: '0.0.0.0' })}COMPOSE_PROFILES=ops\n`);
    const content = readFileSync(captured.file, 'utf8');
    assert.equal(content, renderComposeEnvFile(synthetic), 'generated file unchanged');
    return { status: 0 };
  });
  assert.equal(result.code, 0, result.err);
});

test('absent optional values stay absent; COMPOSE_PROFILES is refused in the file and in the shell', async () => {
  const envFile = writeEnv(envText(synthetic));
  const result = await run(['--deployment-env-file', envFile, 'start']);
  assert.ok(result.captured && !/^ONLINE_EXAM_RECOVERY_SINCE=/m.test(result.captured.content) && !('ONLINE_EXAM_RECOVERY_SINCE' in result.captured.environment));

  const inFile = await run(['--deployment-env-file', writeEnv(`${envText(synthetic)}COMPOSE_PROFILES=ops\n`), 'start']);
  assert.equal(inFile.code, 1);
  assert.match(inFile.err, /COMPOSE_PROFILES must not be set in the env file/);
  assert.equal(inFile.captured, undefined);

  const inShell = await run(['--deployment-env-file', envFile, 'start'], { environment: { PATH: `${binDirectory}:/usr/bin:/bin`, COMPOSE_PROFILES: 'ops' } });
  assert.equal(inShell.code, 1);
  assert.match(inShell.err, /COMPOSE_PROFILES is set in the shell environment/);
  assert.equal(inShell.captured, undefined);
  assert.deepEqual(leftovers(), []);
});

test('missing required values are refused for deployment operations', async () => {
  const values = { ...synthetic };
  delete values.POSTGRES_IMAGE;
  delete values.ADMIN_APP_SUBNET;
  const result = await run(['--deployment-env-file', writeEnv(envText(values)), 'start']);
  assert.equal(result.code, 1);
  assert.match(result.err, /POSTGRES_IMAGE must be set in the env file/);
  assert.match(result.err, /ADMIN_APP_SUBNET must be set in the env file/);
  assert.equal(result.captured, undefined);
});

// ---------------------------------------------------------------------------
// Repository .env (P4-5)
// ---------------------------------------------------------------------------

test('a .env entry at the repository root (file, symlink, directory, FIFO) blocks every Compose operation', async () => {
  const envFile = writeEnv(envText(synthetic));
  assert.deepEqual(checkRepositoryEnvEntry(repositoryRoot), [], 'absent .env');
  const dotEnv = join(repositoryRoot, '.env');
  const secretLike = 'REPOSITORY_DOTENV_CONTENT_MARKER';
  const variants: Array<[string, () => void]> = [
    ['regular file', () => writeFileSync(dotEnv, `X=${secretLike}\n`, { mode: 0o600 })],
    ['symbolic link', () => symlinkSync(join(envDirectory, 'missing-target'), dotEnv)],
    ['directory', () => mkdirSync(dotEnv)],
    ['FIFO', () => { assert.equal(spawnSync('/usr/bin/mkfifo', [dotEnv]).status, 0); }],
  ];
  for (const [kind, create] of variants) {
    create();
    try {
      assert.equal(checkRepositoryEnvEntry(repositoryRoot).length, 1, kind);
      for (const argv of [['start'], ['build'], ['migrate'], ['start', '--dry-run'], ['emergency-stop'], ['emergency-status'], ['stop']]) {
        const result = await run(['--deployment-env-file', envFile, ...argv]);
        assert.equal(result.code, 1, `${kind}: ${argv.join(' ')}`);
        assert.match(result.err, /A \.env entry exists at the repository root/, `${kind}: ${argv.join(' ')}`);
        assert.equal(result.captured, undefined, 'Docker is not called');
        assert.ok(!result.err.includes(secretLike), 'the .env content is never read or printed');
      }
      const preflight = await run(['--deployment-env-file', envFile, 'preflight']);
      assert.equal(preflight.code, 0, `${kind}: preflight still validates the configuration`);
      assert.match(preflight.err, /WARNING: A \.env entry exists at the repository root.*Every Docker operation will be refused/);
      assert.ok(existsSync(dotEnv) || lstatSync(dotEnv), 'the entry is left in place');
    } finally {
      rmSync(dotEnv, { recursive: true, force: true });
    }
  }
  assert.deepEqual(leftovers(), []);
});

// ---------------------------------------------------------------------------
// Operator file loading and races (D3-1)
// ---------------------------------------------------------------------------

test('loading reads the opened descriptor: replacing the path after open does not change what is validated', async () => {
  const original = envText(synthetic);
  const envFile = writeEnv(original);
  const replacement = writeEnv(`${envText({ ...synthetic, PUBLIC_BIND_ADDRESS: '0.0.0.0' })}COMPOSE_PROFILES=ops\n`);
  const loaded = loadOperatorEnvFile(envFile, uid, { afterOpen: () => renameSync(replacement, envFile) });
  assert.deepEqual(loaded, { ok: true, value: original });

  const second = writeEnv(original);
  const loadedAfterSymlinkSwap = loadOperatorEnvFile(second, uid, {
    afterOpen: () => { unlinkSync(second); symlinkSync('/etc/hosts', second); },
  });
  assert.deepEqual(loadedAfterSymlinkSwap, { ok: true, value: original }, 'a symlink swapped in after open is never followed');

  // End to end: the replacement during loading never reaches Compose.
  const third = writeEnv(original);
  const swap = writeEnv(`${envText({ ...synthetic, ADMIN_BIND_ADDRESS: '0.0.0.0' })}`);
  const result = await run(['--deployment-env-file', third, 'start'], { hooks: { afterOpen: () => renameSync(swap, third) } });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.captured?.content, renderComposeEnvFile(synthetic));
});

test('a symbolic link at the env file path is refused (O_NOFOLLOW)', async () => {
  const target = writeEnv(envText(synthetic));
  const link = join(envDirectory, 'env-link');
  symlinkSync(target, link);
  const loaded = loadOperatorEnvFile(link, uid);
  assert.deepEqual(loaded, { ok: false, errors: ['The env file must not be a symbolic link.'] });
  const result = await run(['--deployment-env-file', link, 'start']);
  assert.equal(result.code, 1);
  assert.equal(result.captured, undefined);
});

test('a symbolic link in a directory component is canonicalised and the real chain is checked', () => {
  const realDirectory = privateDirectory('real-env');
  const envFile = join(realDirectory, 'env');
  writeFileSync(envFile, envText(synthetic), { mode: 0o600 });
  const linkedDirectory = join(work, 'linked-env');
  symlinkSync(realDirectory, linkedDirectory);
  assert.equal(loadOperatorEnvFile(join(linkedDirectory, 'env'), uid).ok, true);
  chmodSync(realDirectory, 0o777);
  try {
    const loaded = loadOperatorEnvFile(join(linkedDirectory, 'env'), uid);
    assert.ok(!loaded.ok && loaded.errors.some((error) => /must not be writable by group or others/.test(error)));
  } finally {
    chmodSync(realDirectory, 0o700);
  }
});

test('permission failures: group/other access, non-regular files and oversize files are refused', () => {
  for (const mode of [0o644, 0o660, 0o604, 0o620, 0o666]) {
    const loaded = loadOperatorEnvFile(writeEnv(envText(synthetic), mode), uid);
    assert.equal(loaded.ok, false, mode.toString(8));
  }
  assert.equal(loadOperatorEnvFile(writeEnv(envText(synthetic), 0o640), uid).ok, true, '0640 is allowed');
  const directory = privateDirectory('env', 'not-a-file');
  const loadedDirectory = loadOperatorEnvFile(directory, uid);
  assert.ok(!loadedDirectory.ok && loadedDirectory.errors.join().includes('regular file'));
  const oversize = loadOperatorEnvFile(writeEnv(`A=${'x'.repeat(MAX_ENV_FILE_BYTES)}\n`), uid);
  assert.ok(!oversize.ok && oversize.errors.join().includes('must not exceed'));
  const invalidUtf8 = writeEnv('');
  writeFileSync(invalidUtf8, Buffer.from([0x41, 0x3d, 0xff, 0x0a]));
  const decoded = loadOperatorEnvFile(invalidUtf8, uid);
  assert.ok(!decoded.ok && decoded.errors.join().includes('UTF-8'));
  const unreadable = writeEnv(envText(synthetic), 0o000);
  if (uid !== 0) {
    const loaded = loadOperatorEnvFile(unreadable, uid);
    assert.ok(!loaded.ok && /could not be opened \(EACCES\)/.test(loaded.errors.join()));
  }
  const foreignOwner = loadOperatorEnvFile(writeEnv(envText(synthetic)), uid === undefined ? undefined : uid + 1);
  assert.ok(uid === 0 || uid === undefined || (!foreignOwner.ok && /owned by the operator/.test(foreignOwner.errors.join())));
});

test('parent-directory write permissions: group/other writable directories are refused unless sticky', () => {
  const directory = privateDirectory('env-perm');
  const envFile = writeEnv(envText(synthetic), 0o600, directory);
  try {
    for (const mode of [0o777, 0o775, 0o757, 0o770]) {
      chmodSync(directory, mode);
      const loaded = loadOperatorEnvFile(envFile, uid);
      assert.ok(!loaded.ok && loaded.errors.some((error) => /Every directory containing the env file must not be writable/.test(error)), mode.toString(8));
      assert.ok(!loaded.ok && !loaded.errors.join().includes(directory), 'no path in the error');
    }
    chmodSync(directory, 0o1777);
    assert.equal(loadOperatorEnvFile(envFile, uid).ok, true, 'a sticky directory is allowed');
    chmodSync(directory, 0o755);
    assert.equal(loadOperatorEnvFile(envFile, uid).ok, true);
  } finally {
    chmodSync(directory, 0o700);
  }
  assert.deepEqual(checkDirectoryChain(realpathSync(envDirectory), uid, 'x'), [], 'the test workspace chain is trusted');
});

test('the temporary root must satisfy the same trust model; nothing is created otherwise', async () => {
  const root = privateDirectory('tmp-untrusted');
  chmodSync(root, 0o777);
  try {
    const created = createGeneratedEnvFile(root, 'A=1\n', uid);
    assert.ok(!created.ok && created.errors.some((error) => /temporary directory must not be writable/.test(error)));
    assert.deepEqual(readdirSync(root), []);
    const result = await run(['--deployment-env-file', writeEnv(envText(synthetic)), 'start'], { temporaryRoot: root });
    assert.equal(result.code, 1);
    assert.equal(result.captured, undefined, 'Docker is not called');
  } finally {
    chmodSync(root, 0o700);
  }
  const created = createGeneratedEnvFile(temporaryRoot, 'A=1\n', uid);
  assert.ok(created.ok);
  if (created.ok) {
    assert.equal(statSync(created.value.directory).mode & 0o777, 0o700);
    assert.equal(statSync(created.value.file).mode & 0o777, 0o600);
    rmSync(created.value.directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emergency operations (D3-4, P4-9)
// ---------------------------------------------------------------------------

test('emergency-stop works with an invalid configuration, uses `stop` only and prints the complete warning', async () => {
  const broken: Record<string, string> = { ...synthetic, ADMIN_BIND_ADDRESS: '0.0.0.0' };
  delete broken.NGINX_IMAGE;
  const envFile = writeEnv(envText(broken));
  const emergency = await run(['--deployment-env-file', envFile, 'emergency-stop']);
  assert.equal(emergency.code, 0, emergency.err);
  assert.equal(emergency.err, emergencyWarning('emergency-stop', `${Object.keys(broken).length} of ${GOVERNED_VARIABLES.length} governed settings present; values not shown`));
  assert.match(emergency.err, /skips deployment configuration validation and the required-variable check/);
  assert.match(emergency.err, /only the file, syntax, character and shell checks ran/);
  assert.match(emergency.err, /It can only list \(ps\) or stop \(stop\) containers\./);
  assert.deepEqual(emergency.captured?.args.slice(-1), ['stop']);
  assert.ok(emergency.captured && !/^NGINX_IMAGE=/m.test(emergency.captured.content));
  const status = await run(['--deployment-env-file', envFile, 'emergency-status']);
  assert.deepEqual(status.captured?.args.slice(-1), ['ps']);
  assert.match(status.err, /emergency-status skips deployment configuration validation and the required-variable check/);
  for (const operation of ['stop', 'status', 'start']) {
    const refused = await run(['--deployment-env-file', envFile, operation]);
    assert.equal(refused.code, 1, operation);
    assert.equal(refused.captured, undefined, operation);
  }
  const unsafe = await run(['--deployment-env-file', writeEnv(`${envText(broken)}COMPOSE_PROFILES=ops\n`), 'emergency-stop']);
  assert.equal(unsafe.code, 1, 'file checks still apply');
  assert.deepEqual(leftovers(), []);
});

// ---------------------------------------------------------------------------
// Cancellation before Docker starts (P4-6)
// ---------------------------------------------------------------------------

test('a cancellation requested before Docker starts prevents the launch and cleans up', async () => {
  const envFile = writeEnv(envText(synthetic));
  const order: string[] = [];
  let generatedDirectory: string | undefined;
  const cancelled = await run(['--deployment-env-file', envFile, 'start'], {
    beforeDocker: async () => {
      order.push('yield');
      generatedDirectory = readdirSync(temporaryRoot).map((name) => join(temporaryRoot, name))[0];
    },
    cancellationRequested: () => { order.push('check'); return true; },
  });
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.err, /termination signal was received before Docker started; Docker was not run/);
  assert.equal(cancelled.captured, undefined, 'Docker is not called');
  assert.deepEqual(order, ['yield', 'check'], 'the check follows the yield');
  assert.ok(generatedDirectory && !existsSync(generatedDirectory), 'the generated file existed and was removed');
  assert.deepEqual(leftovers(), []);

  const notCancelled = await run(['--deployment-env-file', envFile, 'start'], { beforeDocker: async () => {}, cancellationRequested: () => false });
  assert.equal(notCancelled.code, 0);
  assert.ok(notCancelled.captured);
});

test('subprocess: a signal received before Docker launch stops the real entry point from starting docker', () => {
  // Byte-for-byte copies of the entry point and its modules in a synthetic repository (the real
  // checkout may contain a .env, which P4-5 refuses). The stand-in docker only records invocation.
  const repo = privateDirectory('entry-repo');
  const server = privateDirectory('entry-repo', 'server');
  for (const file of ['deploy.ts', 'deploymentRunner.ts', 'deploymentWrapper.ts', 'deploymentConfig.ts']) {
    copyFileSync(join(sourceRoot, 'server', file), join(server, file));
    assert.equal(readFileSync(join(server, file), 'utf8'), readFileSync(join(sourceRoot, 'server', file), 'utf8'));
  }
  // Same module type as the repository (package.json "type": "module"), required for top-level await.
  writeFileSync(join(repo, 'package.json'), '{ "type": "module" }\n');
  const fakeBin = privateDirectory('entry-bin');
  const invoked = join(fakeBin, 'invoked');
  const keys = join(fakeBin, 'generated-keys');
  // Records the generated file's variable NAMES only (never values), then exits 0.
  writeFileSync(join(fakeBin, 'docker'), [
    '#!/bin/sh',
    `: > '${invoked}'`,
    'previous=',
    'for argument in "$@"; do',
    `  if [ "$previous" = --env-file ]; then /usr/bin/sed 's/=.*//' "$argument" > '${keys}'; fi`,
    '  previous=$argument',
    'done',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(fakeBin, 'docker'), 0o700);
  const runTemp = privateDirectory('entry-tmp');
  const preload = join(work, 'signal-before-docker.cjs');
  // Sends SIGTERM to the process itself while the generated file is being created (after the
  // signal handlers are registered, before Docker would start).
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    'const original = fs.mkdtempSync;',
    "fs.mkdtempSync = function (prefix, ...rest) { if (String(prefix).includes('eltnoy-deploy-')) process.kill(process.pid, 'SIGTERM'); return original.call(this, prefix, ...rest); };",
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  // tsx keeps its own cache in TMPDIR; only the wrapper's run directories matter here.
  const runDirectories = () => readdirSync(runTemp).filter((name) => name.startsWith('eltnoy-deploy-'));
  const envFile = writeEnv(envText(synthetic));
  const environment = { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: runTemp };
  const entry = (extra: string[]) => spawnSync(process.execPath, [...extra, '--import', 'tsx', join(server, 'deploy.ts'), '--deployment-env-file', envFile, 'start'],
    { cwd: sourceRoot, env: environment, encoding: 'utf8', timeout: 30_000 });

  const signalled = entry(['--require', preload]);
  assert.equal(signalled.status, 128 + 15, signalled.stderr);
  assert.match(signalled.stderr, /termination signal was received before Docker started; Docker was not run/);
  assert.ok(!existsSync(invoked), 'docker was not started');
  assert.deepEqual(runDirectories(), [], 'the generated file and its directory were removed');
  for (const marker of markers) assert.ok(!(signalled.stdout + signalled.stderr).includes(marker));

  const control = entry([]);
  assert.equal(control.status, 0, control.stderr);
  assert.ok(existsSync(invoked), 'without a signal, the stand-in docker is started');
  const names = readFileSync(keys, 'utf8').trim().split('\n');
  assert.deepEqual(names, Object.keys(synthetic).sort(), 'the generated file held exactly the validated governed names');
  assert.deepEqual(runDirectories(), [], 'cleaned up after the run');
  for (const marker of markers) assert.ok(!(control.stdout + control.stderr).includes(marker));
});

// ---------------------------------------------------------------------------
// Executables and runtime environment (D3-5, P4-4)
// ---------------------------------------------------------------------------

test('docker is resolved on an absolute-only PATH to a trusted executable; dry-run and preflight never resolve it', async () => {
  const resolved = resolveTrustedExecutable('docker', `${binDirectory}:/usr/bin`, uid, 'The docker executable');
  assert.deepEqual(resolved, { ok: true, value: realpathSync(join(binDirectory, 'docker')) });
  assert.equal(resolveTrustedExecutable('docker', `relative:${binDirectory}`, uid, 'The docker executable').ok, false);
  const missing = resolveTrustedExecutable('docker', privateDirectory('nothing-here'), uid, 'The docker executable');
  assert.deepEqual(missing, { ok: false, errors: ['The docker executable was not found on PATH.'] });

  const looseBin = privateDirectory('loose-bin');
  writeFileSync(join(looseBin, 'docker'), '#!/bin/sh\nexit 99\n');
  chmodSync(join(looseBin, 'docker'), 0o777);
  const loose = resolveTrustedExecutable('docker', looseBin, uid, 'The docker executable');
  assert.ok(!loose.ok && loose.errors.some((error) => /must not be writable by group or others/.test(error)));
  chmodSync(join(looseBin, 'docker'), 0o700);
  chmodSync(looseBin, 0o777);
  const looseDirectory = resolveTrustedExecutable('docker', looseBin, uid, 'The docker executable');
  assert.ok(!looseDirectory.ok && looseDirectory.errors.some((error) => /directory containing The docker executable/.test(error)));
  chmodSync(looseBin, 0o700);

  const envFile = writeEnv(envText(synthetic));
  const noDocker = { environment: { PATH: privateDirectory('no-docker') } };
  assert.equal((await run(['--deployment-env-file', envFile, 'start', '--dry-run'], noDocker)).code, 0);
  assert.equal((await run(['--deployment-env-file', envFile, 'preflight'], noDocker)).code, 0);
  const refused = await run(['--deployment-env-file', envFile, 'start'], noDocker);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /docker executable was not found on PATH/);
  assert.deepEqual(leftovers(), [], 'no generated file when docker cannot be resolved');
});

test('Node runtime overrides, exported shell functions and an untrusted Node executable are refused before the env file is read', async () => {
  const envFile = writeEnv(envText(synthetic));
  const runtime = await run(['--deployment-env-file', envFile, 'start'], { environment: { PATH: binDirectory, NODE_OPTIONS: '--require /x' } });
  assert.equal(runtime.code, 1);
  assert.match(runtime.err, /NODE_OPTIONS is set in the shell environment/);
  for (const name of ['BASH_FUNC_env%%', 'BASH_FUNC_x', 'odd%name']) {
    const exported = await run(['--deployment-env-file', envFile, 'start'], { environment: { PATH: binDirectory, [name]: '() { :; }' } });
    assert.equal(exported.code, 1, name);
    assert.match(exported.err, /exported shell functions are not accepted/, name);
    assert.equal(exported.captured, undefined);
  }

  const looseNode = privateDirectory('loose-node');
  writeFileSync(join(looseNode, 'node'), '');
  chmodSync(join(looseNode, 'node'), 0o777);
  const untrusted = await run(['--deployment-env-file', envFile, 'preflight'], { nodeExecutable: join(looseNode, 'node') });
  assert.equal(untrusted.code, 1);
  assert.match(untrusted.err, /The Node\.js executable must not be writable by group or others/);
  assert.equal((await run(['--deployment-env-file', envFile, 'preflight'])).code, 0, 'the running Node.js passes');
});
