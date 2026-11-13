// P1-D.3/P1-D.4: the single operator entry point for ELTNOY Compose deployment operations.
//
// Pure policy and planning logic only: this module performs no I/O, never runs Docker, never reads
// process.env implicitly and has no side effects on import. File handling lives in
// server/deploymentRunner.ts; the executable entry point is server/deploy.ts, invoked through
// scripts/eltnoy-deploy.sh.
//
// Guarantees (by construction; Compose behaviour itself is runtime-unverified until P1-F):
//   - one explicitly named, absolute operator env file; no default file is ever selected;
//   - the operator file is opened once (O_NOFOLLOW), checked with fstat and read from that same
//     descriptor; its directory chain must not be writable by untrusted users (D3-1);
//   - every Compose `${VAR:?}` variable must be present (D3-1); governed values are restricted to
//     a character set with no interpolation, quoting, escapes or whitespace;
//   - Compose never reads the operator file: it receives a generated private file containing only
//     the validated governed values, plus the same values in its environment (D3-1);
//   - governed, Compose/Docker control and Node runtime variables set in the shell are rejected;
//   - a fixed allowlist of operations maps to fixed Compose arguments; no user argument reaches
//     Docker, so --no-deps, --pull, create/start or single-service Nginx startup cannot be requested;
//   - messages name settings, keys and line numbers only, never values.
//
// It is an operator-enforcement tool, not a security boundary: anyone with Docker access can still
// run Compose or Docker directly. The host firewall (L-5) remains a separate, required control.
import { isAbsolute, join } from 'node:path';
import {
  DEPLOYMENT_CONFIG_ENVIRONMENT,
  deploymentConfigFromEnvironment,
  validateDeploymentConfig,
} from './deploymentConfig.js';

/** Compose variables declared `${VAR:?…}` (required). Kept equal to docker-compose.yml by a test. */
export const REQUIRED_COMPOSE_VARIABLES = [
  'ADMIN_APP_SUBNET', 'ADMIN_BIND_ADDRESS', 'ADMIN_TLS_CERT_DIR', 'API_ADMIN_APP_ADDRESS',
  'API_PUBLIC_APP_ADDRESS', 'DATABASE_SSL', 'DEPLOYMENT_MODE', 'ELTNOY_API_IMAGE', 'ELTNOY_SECRETS_DIR',
  'ELTNOY_SURFACE_MODE', 'NGINX_ADMIN_APP_ADDRESS', 'NGINX_IMAGE', 'NGINX_PUBLIC_APP_ADDRESS',
  'POSTGRES_CA_FILE', 'POSTGRES_DB', 'POSTGRES_IMAGE', 'POSTGRES_TLS_DIR', 'POSTGRES_USER',
  'PUBLIC_APP_SUBNET', 'PUBLIC_BIND_ADDRESS', 'PUBLIC_TLS_CERT_DIR', 'WIREGUARD_INTERFACE_ADDRESS',
] as const;

/** Compose variables with a default (`${VAR:-…}`). Absent values stay absent: Compose uses the default. */
export const OPTIONAL_COMPOSE_VARIABLES = [
  'DATABASE_POOL_SIZE', 'ELTNOY_ADMIN_HOSTNAME', 'ELTNOY_EXAM_HOSTNAME', 'ELTNOY_INSTITUTION_HOSTNAME',
  'ELTNOY_MARKETING_HOSTNAME', 'ONLINE_EXAM_RECOVERY_SINCE',
] as const;

/** Every variable docker-compose.yml interpolates (kept equal to the file by a static test). */
export const COMPOSE_INTERPOLATED_VARIABLES: readonly string[] = [...REQUIRED_COMPOSE_VARIABLES, ...OPTIONAL_COMPOSE_VARIABLES].sort();

/** Governed variables: everything Compose interpolates plus everything the preflight validates. */
export const GOVERNED_VARIABLES: readonly string[] = [...new Set<string>([
  ...COMPOSE_INTERPOLATED_VARIABLES,
  ...Object.values(DEPLOYMENT_CONFIG_ENVIRONMENT),
])].sort();

const governed = new Set(GOVERNED_VARIABLES);

/** Shell variables passed to the Docker CLI. Everything else (including governed names) is dropped. */
export const PASSTHROUGH_SHELL_VARIABLES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR'] as const;

/** Prefixes that change which daemon, project, files or profiles Compose uses. */
const COMPOSE_CONTROL_PREFIXES = ['COMPOSE_', 'DOCKER_'] as const;

export const MAX_ENV_FILE_BYTES = 64 * 1024;

/**
 * P4-8: the Compose project name. It is declared as the top-level `name:` in docker-compose.yml
 * (a test keeps them equal) and passed explicitly with --project-name on every wrapper call.
 */
export const COMPOSE_PROJECT_NAME = 'eltnoy-production';

/** Name of the generated interpolation file inside its private per-run directory. */
export const GENERATED_ENV_FILE_NAME = 'compose.env';

/**
 * The approved operations and their fixed Compose arguments. No operation takes a service name or
 * a flag from the operator. `start` is a full `up -d`, so each Nginx starts only after its API
 * reports healthy (depends_on: service_healthy) and the API has passed the in-container preflight.
 *
 * `validation: 'full'` runs the complete preflight. `validation: 'syntax'` (emergency operations
 * only, D3-4) keeps every file, syntax, character and shell check but skips the semantic preflight
 * and the required-variable check, so a stack can be inspected or stopped while its configuration
 * is invalid. Emergency operations can only list or stop containers: `stop` never removes
 * containers, networks or volumes and cannot create, start or publish anything.
 */
export const OPERATIONS = {
  preflight: { compose: null, validation: 'full' },
  build: { compose: ['build', 'api_public'], validation: 'full' },
  'start-postgres': { compose: ['up', '-d', 'postgres'], validation: 'full' },
  migrate: { compose: ['--profile', 'ops', 'run', '--rm', 'migrate'], validation: 'full' },
  start: { compose: ['up', '-d'], validation: 'full' },
  status: { compose: ['ps'], validation: 'full' },
  stop: { compose: ['down'], validation: 'full' },
  'emergency-status': { compose: ['ps'], validation: 'syntax' },
  'emergency-stop': { compose: ['stop'], validation: 'syntax' },
} as const satisfies Record<string, { compose: readonly string[] | null; validation: 'full' | 'syntax' }>;

export type Operation = keyof typeof OPERATIONS;

const isOperation = (value: string): value is Operation => Object.prototype.hasOwnProperty.call(OPERATIONS, value);

export interface ParsedArguments {
  envFile: string;
  operation: Operation;
  dryRun: boolean;
}

export const USAGE = `Usage: scripts/eltnoy-deploy.sh --deployment-env-file <absolute path> <operation> [--dry-run]
Operations: ${Object.keys(OPERATIONS).join(', ')}
Every operation runs the host preflight first (emergency-* run the file and syntax checks only).`;

/** Strict argument parser: exactly one --deployment-env-file, one operation and an optional --dry-run. */
export function parseArguments(argv: readonly string[]): { ok: true; value: ParsedArguments } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let envFile: string | undefined;
  let operation: Operation | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--deployment-env-file') {
      const next = argv[index + 1];
      if (envFile !== undefined) errors.push('--deployment-env-file may be given only once.');
      else if (next === undefined || next === '') errors.push('--deployment-env-file requires a path.');
      else envFile = next;
      index += 1;
    } else if (argument === '--dry-run') {
      if (dryRun) errors.push('--dry-run may be given only once.');
      dryRun = true;
    } else if (isOperation(argument)) {
      if (operation !== undefined) errors.push('Exactly one operation is allowed.');
      operation = argument;
    } else {
      // The argument itself is not echoed: it may be a mistyped value.
      errors.push(`Argument ${index + 1} is not an accepted option or operation.`);
    }
  }
  if (envFile === undefined) errors.push('--deployment-env-file <absolute path> is required; no default file is used.');
  else if (!isAbsolute(envFile)) errors.push('--deployment-env-file must be an absolute path.');
  else if (/[\0\r\n]/.test(envFile)) errors.push('--deployment-env-file contains a control character.');
  if (operation === undefined) errors.push('An operation is required.');
  if (errors.length > 0 || envFile === undefined || operation === undefined) return { ok: false, errors };
  return { ok: true, value: { envFile, operation, dryRun } };
}

/** The subset of fs.Stats the policy checks use (from fstat of the opened descriptor, or lstat). */
export interface FileStatus {
  isSymbolicLink: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mode: number;
  uid: number;
}

const S_ISVTX = 0o1000;
const trustedOwner = (uid: number, currentUid: number | undefined) => currentUid === undefined || uid === currentUid || uid === 0;

/**
 * Operator env file (fstat of the opened descriptor): a regular file, bounded size, not writable by
 * group or others, no access for others, owned by the operator or root.
 */
export function checkEnvFileStatus(status: FileStatus, currentUid: number | undefined): string[] {
  const errors: string[] = [];
  if (status.isSymbolicLink) errors.push('The env file must not be a symbolic link.');
  else if (!status.isFile) errors.push('The env file must be a regular file.');
  if (status.size > MAX_ENV_FILE_BYTES) errors.push(`The env file must not exceed ${MAX_ENV_FILE_BYTES} bytes.`);
  if ((status.mode & 0o022) !== 0) errors.push('The env file must not be writable by group or others (use mode 0600 or 0640).');
  if ((status.mode & 0o007) !== 0) errors.push('The env file must not be accessible by others (use mode 0600 or 0640).');
  if (!trustedOwner(status.uid, currentUid)) errors.push('The env file must be owned by the operator running the wrapper or by root.');
  return errors;
}

/**
 * D3-1 trust model for every directory from the filesystem root down to the env file (and to the
 * generated file's parent): a real directory owned by root or the operator, and not writable by
 * group or others unless the sticky bit is set (then only an entry's owner can rename or remove it).
 * `label` is a fixed description, never a path.
 */
export function checkDirectoryStatus(status: FileStatus, currentUid: number | undefined, label: string): string[] {
  const errors: string[] = [];
  if (status.isSymbolicLink || !status.isDirectory) errors.push(`${label} must be a real directory.`);
  if (!trustedOwner(status.uid, currentUid)) errors.push(`${label} must be owned by the operator or root.`);
  if ((status.mode & 0o022) !== 0 && (status.mode & S_ISVTX) === 0) {
    errors.push(`${label} must not be writable by group or others (unless sticky).`);
  }
  return errors;
}

/** The generated file's private directory: owned by the operator, mode exactly 0700. */
export function checkPrivateDirectoryStatus(status: FileStatus, currentUid: number | undefined): string[] {
  const errors: string[] = [];
  if (status.isSymbolicLink || !status.isDirectory) errors.push('The private run directory must be a real directory.');
  if (currentUid !== undefined && status.uid !== currentUid) errors.push('The private run directory must be owned by the operator.');
  if ((status.mode & 0o777) !== 0o700) errors.push('The private run directory must have mode 0700.');
  return errors;
}

/**
 * D3-5: an executable used by the wrapper (node, docker), after symbolic links are resolved: a
 * regular file owned by root or the operator and not writable by group or others; its directory
 * is checked with checkDirectoryStatus. Ancestors of that directory are not checked (package
 * managers such as Homebrew use group-writable parents); see runbook §14.9.
 */
export function checkExecutableStatus(status: FileStatus, currentUid: number | undefined, label: string): string[] {
  const errors: string[] = [];
  if (!status.isFile) errors.push(`${label} must resolve to a regular file.`);
  if (!trustedOwner(status.uid, currentUid)) errors.push(`${label} must be owned by the operator or root.`);
  if ((status.mode & 0o022) !== 0) errors.push(`${label} must not be writable by group or others.`);
  if ((status.mode & 0o111) === 0) errors.push(`${label} must be executable.`);
  return errors;
}

/** D3-5: PATH must contain only absolute entries (no empty, "." or relative entries). */
export function checkSearchPath(path: string | undefined): string[] {
  if (path === undefined || path === '') return ['PATH must be set to absolute directories.'];
  return path.split(':').some((entry) => !isAbsolute(entry))
    ? ['PATH must contain only absolute directories (no empty, "." or relative entries).']
    : [];
}

/**
 * D3-5/P4-4: variables that change what code the wrapper or its shell entry runs. Node/tsx runtime
 * variables (NODE_*, except NODE_ENV, and TSX_*) and exported shell functions (BASH_FUNC_*, or any
 * name containing `%`, which bash uses to export functions) are refused. The shell entry refuses
 * them before Node starts; this is the independent in-process check.
 */
export function checkRuntimeEnvironment(environment: Readonly<Record<string, string | undefined>>): string[] {
  const errors: string[] = [];
  for (const name of Object.keys(environment).sort()) {
    if (name.startsWith('BASH_FUNC_') || name.includes('%')) {
      errors.push('An exported shell function (BASH_FUNC_*) is set in the environment; exported shell functions are not accepted.');
    } else if ((name.startsWith('NODE_') && name !== 'NODE_ENV') || name.startsWith('TSX_')) {
      errors.push(`${name} is set in the shell environment; Node and tsx runtime overrides are not accepted.`);
    }
  }
  return [...new Set(errors)];
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/** Governed values: no whitespace, quotes, `$`, backslash, backtick, `#` or control characters. */
const SAFE_GOVERNED_VALUE = /^[^\s"'`$\\#\x00-\x1f\x7f]*$/;

/**
 * Parses the env-file subset on which Compose and this wrapper agree: `KEY=VALUE` lines, an
 * optional single pair of matching double or single quotes around the whole value, blank lines and
 * full-line `#` comments. Anything else fails closed. Errors cite line numbers and key names only.
 */
export function parseEnvFile(text: string): { values: Map<string, string>; errors: string[] } {
  const values = new Map<string, string>();
  const errors: string[] = [];
  if (text.includes('\0')) errors.push('The env file contains a NUL byte.');
  if (text.includes('\r')) errors.push('The env file must use LF line endings (CR found).');
  if (errors.length > 0) return { values, errors };

  text.split('\n').forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === '') return;
    if (line.startsWith('#')) return;
    const match = KEY_LINE.exec(line);
    if (!match) {
      errors.push(`Line ${lineNumber}: expected KEY=VALUE with no leading whitespace, "export" or spaces around "=".`);
      return;
    }
    const [, key, rawValue] = match;
    if (values.has(key)) {
      errors.push(`Line ${lineNumber}: ${key} is defined more than once.`);
      return;
    }
    if (COMPOSE_CONTROL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      errors.push(`Line ${lineNumber}: ${key} must not be set in the env file (Compose/Docker control variable).`);
      return;
    }
    let value = rawValue;
    const quote = rawValue[0];
    if (quote === '"' || quote === "'") {
      if (rawValue.length < 2 || rawValue[rawValue.length - 1] !== quote || rawValue.slice(1, -1).includes(quote)) {
        errors.push(`Line ${lineNumber}: ${key} has unbalanced or nested quotes (multi-line values are not accepted).`);
        return;
      }
      value = rawValue.slice(1, -1);
    } else if (/["'`]/.test(rawValue)) {
      errors.push(`Line ${lineNumber}: ${key} contains a quote inside an unquoted value.`);
      return;
    }
    if (governed.has(key) && !SAFE_GOVERNED_VALUE.test(value)) {
      errors.push(`Line ${lineNumber}: ${key} contains a disallowed character (whitespace, quote, "$" interpolation, backslash, "#" or control character).`);
      return;
    }
    values.set(key, value);
  });
  return { values, errors };
}

/** Rejects governed and Compose/Docker control variables already set in the operator's shell. */
export function checkShellEnvironment(shellEnvironment: Readonly<Record<string, string | undefined>>): string[] {
  const errors: string[] = [];
  for (const name of Object.keys(shellEnvironment).sort()) {
    if (governed.has(name)) {
      errors.push(`${name} is set in the shell environment; unset it so the env file is the only source.`);
    } else if (COMPOSE_CONTROL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      errors.push(`${name} is set in the shell environment; Compose/Docker control variables are not accepted.`);
    }
  }
  return errors;
}

/** D3-1: every required Compose variable must be present and non-empty in the operator file. */
export function checkRequiredVariables(values: ReadonlyMap<string, string>): string[] {
  return REQUIRED_COMPOSE_VARIABLES
    .filter((name) => !values.get(name))
    .map((name) => `${name} must be set in the env file (required by docker-compose.yml).`);
}

/**
 * D3-1: the generated Compose interpolation file. Only governed keys, only validated values; the
 * character policy guarantees an unquoted `KEY=VALUE` line has one meaning for every parser.
 */
export function renderComposeEnvFile(governedValues: Readonly<Record<string, string>>): string {
  const lines = Object.keys(governedValues).sort().map((name) => {
    if (!governed.has(name) || !SAFE_GOVERNED_VALUE.test(governedValues[name])) {
      throw new Error('Internal error: refusing to render an ungoverned or unsafe value.');
    }
    return `${name}=${governedValues[name]}`;
  });
  return `${lines.join('\n')}\n`;
}

export interface DeploymentPlan {
  operation: Operation;
  validation: 'full' | 'syntax';
  /** Governed values from the env file (validated for full operations); exactly what Compose receives. */
  governedValues: Readonly<Record<string, string>>;
  /** Fixed Compose arguments for the operation, or null for preflight. */
  composeArguments: readonly string[] | null;
  /** Docker child environment: allowlisted shell variables plus governed values. */
  childEnvironment: Record<string, string> | null;
}

/** Full Docker argument vector. Contains fixed paths only, never configured values. */
export function dockerArgumentsFor(repositoryRoot: string, generatedEnvFile: string, composeArguments: readonly string[]): string[] {
  return [
    'compose',
    '--project-name', COMPOSE_PROJECT_NAME,
    '--project-directory', repositoryRoot,
    '--file', join(repositoryRoot, 'docker-compose.yml'),
    '--env-file', generatedEnvFile,
    ...composeArguments,
  ];
}

/**
 * Builds the plan from already-read inputs. Returns errors (no values) if anything fails; Docker
 * is never invoked here.
 */
export function planDeployment(input: {
  arguments: ParsedArguments;
  envFileText: string;
  shellEnvironment: Readonly<Record<string, string | undefined>>;
}): { ok: true; plan: DeploymentPlan } | { ok: false; errors: string[] } {
  const errors = [...checkShellEnvironment(input.shellEnvironment), ...checkRuntimeEnvironment(input.shellEnvironment)];
  const parsed = parseEnvFile(input.envFileText);
  errors.push(...parsed.errors);
  if (errors.length > 0) return { ok: false, errors };

  const { compose, validation } = OPERATIONS[input.arguments.operation];
  const governedValues: Record<string, string> = {};
  for (const name of GOVERNED_VARIABLES) {
    const value = parsed.values.get(name);
    if (value !== undefined) governedValues[name] = value;
  }
  if (validation === 'full') {
    const validationErrors = [
      ...checkRequiredVariables(parsed.values),
      ...validateDeploymentConfig(deploymentConfigFromEnvironment(governedValues)),
    ];
    if (validationErrors.length > 0) return { ok: false, errors: validationErrors };
  }

  if (compose === null) {
    return { ok: true, plan: { operation: input.arguments.operation, validation, governedValues, composeArguments: null, childEnvironment: null } };
  }
  const childEnvironment: Record<string, string> = {};
  for (const name of PASSTHROUGH_SHELL_VARIABLES) {
    const value = input.shellEnvironment[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  Object.assign(childEnvironment, governedValues);
  return { ok: true, plan: { operation: input.arguments.operation, validation, governedValues, composeArguments: compose, childEnvironment } };
}
