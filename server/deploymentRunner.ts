// P1-D.4: file and process handling for the deployment wrapper (D3-1, D3-5). All policy decisions
// are delegated to server/deploymentWrapper.ts. Docker is invoked only through the injected
// `runDocker` function, so tests never start Docker. Nothing here prints a configured value.
//
// Trust model (runbook §14.9): the operator account and root are trusted. Every directory from the
// filesystem root to the operator env file and to the temporary root must be owned by one of them
// and must not be writable by group or others unless sticky. Under that model no other account
// can replace the env file, a directory on its path or the generated file during a run.
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync,
  readSync, realpathSync, rmSync, statSync, writeSync, type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  checkDirectoryStatus, checkEnvFileStatus, checkExecutableStatus, checkPrivateDirectoryStatus,
  checkRuntimeEnvironment, checkSearchPath, dockerArgumentsFor, GENERATED_ENV_FILE_NAME,
  GOVERNED_VARIABLES, MAX_ENV_FILE_BYTES, parseArguments, planDeployment, renderComposeEnvFile, USAGE,
  type FileStatus,
} from './deploymentWrapper.js';

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const toStatus = (stats: Stats): FileStatus => ({
  isSymbolicLink: stats.isSymbolicLink(),
  isFile: stats.isFile(),
  isDirectory: stats.isDirectory(),
  size: stats.size,
  mode: stats.mode,
  uid: stats.uid,
});

/** Error code only: messages of fs errors contain paths. */
const errorCode = (error: unknown) => (error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'unknown');

/** Checks every directory from `realDirectory` (already canonical) up to the filesystem root. */
export function checkDirectoryChain(realDirectory: string, currentUid: number | undefined, label: string): string[] {
  const errors = new Set<string>();
  let current = realDirectory;
  for (;;) {
    try {
      for (const error of checkDirectoryStatus(toStatus(lstatSync(current)), currentUid, label)) errors.add(error);
    } catch (error) {
      errors.add(`${label} could not be inspected (${errorCode(error)}).`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...errors];
}

function noFollowFlag(): number | undefined {
  return typeof constants.O_NOFOLLOW === 'number' && constants.O_NOFOLLOW !== 0 ? constants.O_NOFOLLOW : undefined;
}

export interface LoadHooks {
  /** Test seam: runs after the descriptor is opened and before it is checked and read. */
  afterOpen?: () => void;
}

/**
 * D3-1: opens the operator env file once with O_NOFOLLOW (no symbolic link is followed for the
 * final component), checks the opened descriptor with fstat and reads from that same descriptor,
 * bounded to MAX_ENV_FILE_BYTES. Directory components are canonicalised first and the whole
 * directory chain is checked against the trust model.
 */
export function loadOperatorEnvFile(path: string, currentUid: number | undefined, hooks: LoadHooks = {}): Result<string> {
  const noFollow = noFollowFlag();
  if (noFollow === undefined) return { ok: false, errors: ['This platform does not support O_NOFOLLOW; the wrapper refuses to run.'] };

  let realDirectory: string;
  try {
    realDirectory = realpathSync(dirname(path));
  } catch (error) {
    return { ok: false, errors: [`The env file directory could not be resolved (${errorCode(error)}).`] };
  }
  const directoryErrors = checkDirectoryChain(realDirectory, currentUid, 'Every directory containing the env file');
  if (directoryErrors.length > 0) return { ok: false, errors: directoryErrors };

  let descriptor: number;
  try {
    descriptor = openSync(join(realDirectory, basename(path)), constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, errors: [code === 'ELOOP' || code === 'EMLINK' ? 'The env file must not be a symbolic link.' : `The env file could not be opened (${code}).`] };
  }
  try {
    hooks.afterOpen?.();
    const statusErrors = checkEnvFileStatus(toStatus(fstatSync(descriptor)), currentUid);
    if (statusErrors.length > 0) return { ok: false, errors: statusErrors };
    const buffer = Buffer.alloc(MAX_ENV_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_ENV_FILE_BYTES) return { ok: false, errors: [`The env file must not exceed ${MAX_ENV_FILE_BYTES} bytes.`] };
    }
    try {
      return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) };
    } catch {
      return { ok: false, errors: ['The env file must be valid UTF-8.'] };
    }
  } catch (error) {
    return { ok: false, errors: [`The env file could not be read (${errorCode(error)}).`] };
  } finally {
    closeSync(descriptor);
  }
}

export interface GeneratedEnvFile {
  directory: string;
  file: string;
}

/**
 * D3-1: writes the validated values to `<private run directory>/compose.env`. The run directory is
 * created fresh by mkdtemp (mode 0700, unpredictable name, so it cannot be pre-created) under the
 * canonicalised temporary root, whose directory chain must satisfy the trust model; the file is
 * created exclusively (O_CREAT|O_EXCL|O_NOFOLLOW) with mode 0600. On any failure the directory is
 * removed before returning.
 */
export function createGeneratedEnvFile(temporaryRoot: string, content: string, currentUid: number | undefined): Result<GeneratedEnvFile> {
  const noFollow = noFollowFlag();
  if (noFollow === undefined) return { ok: false, errors: ['This platform does not support O_NOFOLLOW; the wrapper refuses to run.'] };
  let realRoot: string;
  try {
    realRoot = realpathSync(temporaryRoot);
  } catch (error) {
    return { ok: false, errors: [`The temporary directory could not be resolved (${errorCode(error)}).`] };
  }
  const rootErrors = checkDirectoryChain(realRoot, currentUid, 'Every directory containing the temporary directory');
  if (rootErrors.length > 0) return { ok: false, errors: rootErrors };

  let directory: string;
  try {
    directory = mkdtempSync(join(realRoot, 'eltnoy-deploy-'));
  } catch (error) {
    return { ok: false, errors: [`The private run directory could not be created (${errorCode(error)}).`] };
  }
  const file = join(directory, GENERATED_ENV_FILE_NAME);
  try {
    const directoryErrors = checkPrivateDirectoryStatus(toStatus(lstatSync(directory)), currentUid);
    if (directoryErrors.length > 0) throw Object.assign(new Error('untrusted'), { policy: directoryErrors });
    const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
      fchmodSync(descriptor, 0o600);
      const bytes = Buffer.from(content, 'utf8');
      let written = 0;
      while (written < bytes.length) written += writeSync(descriptor, bytes, written, bytes.length - written);
      fsyncSync(descriptor);
      const status = fstatSync(descriptor);
      if (!status.isFile() || (status.mode & 0o777) !== 0o600) throw Object.assign(new Error('untrusted'), { policy: ['The generated env file must be a regular file with mode 0600.'] });
    } finally {
      closeSync(descriptor);
    }
    return { ok: true, value: { directory, file } };
  } catch (error) {
    removeGeneratedEnvFile({ directory, file });
    const policy = (error as { policy?: string[] }).policy;
    return { ok: false, errors: policy ?? [`The generated env file could not be written (${errorCode(error)}).`] };
  }
}

/** Removes the private run directory and its file. Returns false (no path printed) on failure. */
export function removeGeneratedEnvFile(generated: GeneratedEnvFile): boolean {
  try {
    rmSync(generated.directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * D3-5: checks an executable after resolving symbolic links: the file (checkExecutableStatus) and
 * the directory that really contains it (checkDirectoryStatus).
 */
export function checkTrustedExecutable(path: string, currentUid: number | undefined, label: string): Result<string> {
  try {
    const real = realpathSync(path);
    const errors = [
      ...checkExecutableStatus(toStatus(statSync(real)), currentUid, label),
      ...checkDirectoryStatus(toStatus(lstatSync(dirname(real))), currentUid, `The directory containing ${label}`),
    ];
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: real };
  } catch (error) {
    return { ok: false, errors: [`${label} could not be inspected (${errorCode(error)}).`] };
  }
}

/** D3-5: resolves `name` on an absolute-only PATH (first match, as a shell would) and checks it. */
export function resolveTrustedExecutable(name: string, searchPath: string | undefined, currentUid: number | undefined, label: string): Result<string> {
  const pathErrors = checkSearchPath(searchPath);
  if (pathErrors.length > 0) return { ok: false, errors: pathErrors };
  for (const directory of (searchPath as string).split(':')) {
    const candidate = join(directory, name);
    try {
      lstatSync(candidate);
    } catch {
      continue;
    }
    return checkTrustedExecutable(candidate, currentUid, label);
  }
  return { ok: false, errors: [`${label} was not found on PATH.`] };
}

/**
 * P4-5: Compose may load `<project directory>/.env` in addition to an explicit --env-file (to be
 * verified in P1-F). Until then the wrapper refuses to run Compose while any entry named `.env`
 * exists at the repository root, whatever its type (file, symbolic link, directory, FIFO). The
 * entry is only lstat-ed: never opened, read, followed, moved or deleted.
 */
export function checkRepositoryEnvEntry(repositoryRoot: string): string[] {
  try {
    lstatSync(join(repositoryRoot, '.env'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    return [`The repository root could not be checked for a .env entry (${errorCode(error)}).`];
  }
  return ['A .env entry exists at the repository root. Compose may load it in addition to the validated configuration, so the wrapper will not run Compose. Move it out of the checkout (its contents are not read by the wrapper) and run the operation again.'];
}

export interface DockerResult {
  status: number | null;
  errorCode?: string;
}

export interface RunOptions {
  argv: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  currentUid: number | undefined;
  repositoryRoot: string;
  temporaryRoot: string;
  nodeExecutable: string;
  runDocker: (dockerPath: string, dockerArguments: readonly string[], environment: Record<string, string>) => DockerResult;
  log: (line: string) => void;
  error: (line: string) => void;
  hooks?: LoadHooks;
  /**
   * P4-6: yields to the event loop immediately before Docker would start, so that termination
   * signals received earlier are delivered; then `cancellationRequested` is consulted.
   */
  beforeDocker?: () => Promise<void>;
  cancellationRequested?: () => boolean;
}

/** P4-9: the exact warning printed by the emergency operations (no values). */
export function emergencyWarning(operation: string, present: string): string {
  return `eltnoy-deploy: WARNING: ${operation} skips deployment configuration validation and the required-variable check; `
    + `only the file, syntax, character and shell checks ran (${present}). It can only list (ps) or stop (stop) containers.`;
}

/** Runs one wrapper invocation and returns the exit code. Cleans up the generated file on every path. */
export async function runDeployment(options: RunOptions): Promise<number> {
  const refuse = (errors: readonly string[]) => {
    options.error(`eltnoy-deploy: refused:\n${errors.map((line) => `- ${line}`).join('\n')}`);
    return 1;
  };

  const environmentErrors = [...checkRuntimeEnvironment(options.environment), ...checkSearchPath(options.environment.PATH)];
  if (environmentErrors.length > 0) return refuse(environmentErrors);

  const parsedArguments = parseArguments(options.argv);
  if (!parsedArguments.ok) return refuse([...parsedArguments.errors, USAGE]);
  const { envFile, dryRun } = parsedArguments.value;

  const node = checkTrustedExecutable(options.nodeExecutable, options.currentUid, 'The Node.js executable');
  if (!node.ok) return refuse(node.errors);

  const loaded = loadOperatorEnvFile(envFile, options.currentUid, options.hooks);
  if (!loaded.ok) return refuse(loaded.errors);

  const result = planDeployment({ arguments: parsedArguments.value, envFileText: loaded.value, shellEnvironment: options.environment });
  if (!result.ok) return refuse(result.errors);
  const { plan } = result;

  const present = `${Object.keys(plan.governedValues).length} of ${GOVERNED_VARIABLES.length} governed settings present; values not shown`;
  if (plan.validation === 'full') options.log(`eltnoy-deploy: preflight passed (${present}).`);
  else options.error(emergencyWarning(plan.operation, present));

  const repositoryEnvErrors = checkRepositoryEnvEntry(options.repositoryRoot);
  if (plan.composeArguments === null || plan.childEnvironment === null) {
    // preflight: no Compose call, so a repository .env is reported but does not fail the preflight.
    if (repositoryEnvErrors.length > 0) options.error(`eltnoy-deploy: WARNING: ${repositoryEnvErrors.join(' ')} Every Docker operation will be refused until then.`);
    return 0;
  }
  // P4-5: applies to every Compose operation, including dry runs and the emergency operations.
  if (repositoryEnvErrors.length > 0) return refuse(repositoryEnvErrors);

  const placeholder = dockerArgumentsFor(options.repositoryRoot, `<private run directory>/${GENERATED_ENV_FILE_NAME}`, plan.composeArguments);
  if (dryRun) {
    options.log(`eltnoy-deploy: would run: docker ${placeholder.join(' ')}`);
    return 0;
  }

  const docker = resolveTrustedExecutable('docker', options.environment.PATH, options.currentUid, 'The docker executable');
  if (!docker.ok) return refuse(docker.errors);

  const generated = createGeneratedEnvFile(options.temporaryRoot, renderComposeEnvFile(plan.governedValues), options.currentUid);
  if (!generated.ok) return refuse(generated.errors);
  try {
    // P4-6: deliver deferred signals, then never start Docker once cancellation was requested.
    await options.beforeDocker?.();
    if (options.cancellationRequested?.()) {
      return refuse(['A termination signal was received before Docker started; Docker was not run.']);
    }
    options.log(`eltnoy-deploy: running: docker ${placeholder.join(' ')}`);
    const outcome = options.runDocker(docker.value, dockerArgumentsFor(options.repositoryRoot, generated.value.file, plan.composeArguments), plan.childEnvironment);
    if (outcome.errorCode !== undefined) return refuse([`Docker could not be started (${outcome.errorCode}).`]);
    return outcome.status ?? 1;
  } finally {
    if (!removeGeneratedEnvFile(generated.value)) options.error('eltnoy-deploy: WARNING: the private run directory could not be removed; delete it manually.');
  }
}
