// P1-D.4 (D3-2, D3-3, P4-1, P4-2): operational and architecture documentation must match the
// deployment wrapper. Static text checks only. Audit reports (docs/audits) are historical records
// and are excluded. Any other historical command must be labelled on its line (superseded,
// historical, rehearsal evidence) or be a local-development command (.env.development).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPOSE_PROJECT_NAME, OPERATIONS } from './deploymentWrapper.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function markdownFiles(directory: string): string[] {
  if (!existsSync(join(root, directory))) return [];
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return path === 'docs/audits' ? [] : markdownFiles(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

const files = ['README.md', ...markdownFiles('docs')];
const lines = files.flatMap((file) => readFileSync(join(root, file), 'utf8').split('\n').map((text, index) => ({ where: `${file}:${index + 1}`, text })));

/** The canonical scoping every current production maintenance command must carry. */
export const PRODUCTION_SCOPE = [
  `--project-name ${COMPOSE_PROJECT_NAME}`,
  '--project-directory <repository>',
  '--file <repository>/docker-compose.yml',
];

const LABELLED = /superseded|historical|rehearsal evidence|local development only/i;
const DEVELOPMENT = /\.env\.development/;
const PROHIBITION = /prohibit|do not|never|bypass|cannot stop/i;

/**
 * Returns rule names violated by one documentation line. Rules apply to `docker compose` command
 * segments (inside backticks, or the rest of a code-block line) and to references to the former
 * `app` service; labelled historical lines and local-development commands are exempt.
 */
export function violations(text: string): string[] {
  if (LABELLED.test(text)) return [];
  const found = new Set<string>();
  // The former production `app` service (not the network alias `app` or an Express `app` import).
  if (/`app` service|\bapp service\b/.test(text)) found.add('app-service');
  const segments = [...text.matchAll(/docker compose[^`\n]*/g)].map((match) => match[0]);
  for (const segment of segments) {
    if (DEVELOPMENT.test(segment)) continue;
    if (/\s(stop|restart|run|exec|logs|up|start)\b[^`]*\bapp\b(?!_)/.test(segment)) found.add('app-service');
    if (/\bmigrate\b/.test(segment)) found.add('direct-migrate');
    if (/--env-file \.?\.?\/?\.env\.production/.test(segment)) found.add('relative-env-file');
    // Placeholders such as `<private run directory>` are not Compose subcommands.
    const maintenance = /\s(exec|run|cp|restart|logs)\b/.test(segment.replace(/<[^>]*>/g, '<placeholder>'));
    if (maintenance && !/--env-file \//.test(segment)) found.add('maintenance-without-env-file');
    if (/--env-file \//.test(segment) && !PRODUCTION_SCOPE.every((part) => segment.includes(part))) found.add('production-without-project-scope');
    if (/^docker compose (up|create|start)\b[^`]*(nginx_|--no-deps)|--no-deps[^`]*nginx_/.test(segment) && !PROHIBITION.test(text)) found.add('direct-nginx-startup');
  }
  return [...found].sort();
}

test('documentation scan covers the README, the runbook and the architecture documents', () => {
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('docs/operations/production-operator-runbook.md'));
  assert.ok(files.some((file) => file.startsWith('docs/architecture/')));
  assert.ok(!files.some((file) => file.startsWith('docs/audits/')));
});

test('regression fixtures: each stale P4-1 example is detected', () => {
  const cases: Array<[string, string[]]> = [
    ['4. **Never replace the file by rename** … If that happens, `docker compose restart app`.', ['app-service', 'maintenance-without-env-file']],
    ['2. Use the narrowest action, through `docker compose exec postgres psql -U <POSTGRES_USER> …`.', ['maintenance-without-env-file']],
    ['Automatic recovery is controlled by one optional setting, which Docker Compose passes to the `app` service:', ['app-service']],
    ['| API (`app` service) | `DATABASE_URL` → `eltnoy_app`, TLS as today | New credentials |', ['app-service']],
    ['| Migrations | A separate one-off `docker compose run` with a `DATABASE_URL` override → `eltnoy_migrator` |', ['maintenance-without-env-file']],
    ['[PROPOSED]: copy the file off the container (`docker compose cp`), encrypt it', ['maintenance-without-env-file']],
    ['docker compose --env-file .env.production exec -T postgres \\', ['maintenance-without-env-file', 'relative-env-file']],
    ['these `docker compose --env-file /etc/eltnoy/.env.production exec postgres …` maintenance commands', ['production-without-project-scope']],
    ['docker compose --project-directory <repository> --env-file /etc/eltnoy/.env.production exec -T postgres \\', ['production-without-project-scope']],
    ['Migrations: `docker compose --env-file .env.production --profile ops run --rm migrate`.', ['direct-migrate', 'maintenance-without-env-file', 'relative-env-file']],
    ['5. The API stopped: `docker compose --env-file .env.production stop app`. [STANDARD Docker Compose]', ['app-service', 'relative-env-file']],
    ['| 2 | Stop the API (`docker compose … stop app`) | [STANDARD] |', ['app-service']],
    ['Start everything with `docker compose up --no-deps nginx_admin` first.', ['direct-nginx-startup']],
    ['Compose call: `docker compose --project-name eltnoy-production --project-directory <repository> run --rm x`', ['maintenance-without-env-file']],
  ];
  for (const [text, expected] of cases) assert.deepEqual(violations(text), expected, text);
});

test('regression fixtures: legitimate current, historical and unrelated lines are accepted', () => {
  const accepted = [
    '| `api_public` | `public_app` (alias `app`), `db_public` | 4000 only | `eltnoy_app` secret only |',
    '- **Harness:** the existing pattern in `server/roleLookupSecurity.test.ts` (import `app`, stub `pool.query`).',
    'If that happens, restart both API containers: `docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production restart api_public api_admin`.',
    'The former `docker compose restart app` is superseded: there is no `app` service since P1-D.2.',
    'then run `docker compose --env-file .env.development --profile ops run --rm migrate` (local development only).',
    'docker compose --env-file .env.development config',
    '- **Direct Nginx startup** (`docker compose up nginx_admin`, `docker compose up --no-deps nginx_public`) is **prohibited**.',
    'Run `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production migrate`.',
    '`docker compose down` preserves the named volume; never use `docker compose down -v`.',
    '- Never put a password in a script, a SQL file, `docker compose` arguments, logs, Git, chat or tickets.',
    'Every Compose call is `docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file <private run directory>/compose.env <fixed arguments>`.',
  ];
  for (const text of accepted) assert.deepEqual(violations(text), [], text);
});

test('no documentation line violates the production command rules', () => {
  const offending = lines.map(({ where, text }) => ({ where, rules: violations(text) })).filter(({ rules }) => rules.length > 0);
  assert.deepEqual(offending, []);
});

test('documents that still use pre-P1-D.2 service names carry a historical note', () => {
  for (const file of ['docs/architecture/secure-database-credentials.md', 'docs/architecture/postgres-role-separation-plan.md']) {
    const head = readFileSync(join(root, file), 'utf8').split('\n').slice(0, 5).join('\n');
    assert.match(head, /predate P1-D\.2/, file);
  }
});

test('every documented wrapper invocation uses an existing operation and an absolute env file', () => {
  const invocations = lines.flatMap(({ where, text }) => [...text.matchAll(/eltnoy-deploy\.sh(?: --deployment-env-file (\S+))?(?: ([a-z<][a-z-]*>?))?/g)]
    .map((match) => ({ where, path: match[1], operation: match[2] })));
  assert.ok(invocations.length >= 10, 'the README and runbook document the wrapper');
  for (const { where, path, operation } of invocations) {
    if (path === undefined) continue; // a reference to the script itself
    assert.ok(path.startsWith('/') || path.startsWith('<'), `${where}: absolute env file`);
    if (path.startsWith('<') || operation === undefined || operation.startsWith('<')) continue; // placeholders
    assert.ok(Object.prototype.hasOwnProperty.call(OPERATIONS, operation), `${where}: unknown operation ${operation}`);
  }
});

test('the runbook documents the project name, the maintenance prefix and the emergency fallback', () => {
  const runbook = readFileSync(join(root, 'docs/operations/production-operator-runbook.md'), 'utf8');
  assert.match(runbook, /`name: eltnoy-production`/);
  assert.match(runbook, new RegExp(`\`docker compose ${PRODUCTION_SCOPE.join(' ').replace(/[.*+?^${}()|[\]\\/<>-]/g, '\\$&')} --env-file /etc/eltnoy/\\.env\\.production\``));
  assert.match(runbook, /docker ps --filter label=com\.docker\.compose\.project=eltnoy-production/);
});

test('build semantics are not overstated (D3-3)', () => {
  const offending = lines.filter(({ text }) => /images? (change|changes) (are made )?only (by|through) the (wrapper )?`?build/i.test(text));
  assert.deepEqual(offending.map(({ where }) => where), []);
  const runbook = readFileSync(join(root, 'docs/operations/production-operator-runbook.md'), 'utf8');
  assert.match(runbook, /`start` \(`up -d`\) can rebuild `api_public`/);
  assert.match(runbook, /audit item L-2, still open/);
});

test('executable-trust limitations are stated, not claimed away (P4-7, P4-10)', () => {
  const runbook = readFileSync(join(root, 'docs/operations/production-operator-runbook.md'), 'utf8');
  assert.match(runbook, /cannot protect the launch of the interpreter itself/);
  assert.match(runbook, /Only the executable and its \*\*immediate\*\* containing directory are checked/);
  assert.match(runbook, /`\/Applications`/);
  assert.match(runbook, /Homebrew's `Cellar`/);
  assert.match(runbook, /credential helpers \(`docker-credential-\*`\) are found through `PATH`/);
  assert.match(runbook, /root-owned `\/usr\/bin\/node` and `\/usr\/bin\/docker`/);
  assert.match(runbook, /does not eliminate these limits/);
  assert.doesNotMatch(runbook, /The running Node\.js executable and `docker` \(the first match on `PATH`\) are checked/);
});
