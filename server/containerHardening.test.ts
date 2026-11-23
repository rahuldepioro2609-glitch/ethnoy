// UD-1-B: static checks of the container identities, secret wiring and filesystem hardening in
// Dockerfile, docker-compose.yml, .dockerignore and .gitignore. No Docker command is run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
const noComments = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} exists`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n|\n[a-z]/);
  return noComments(next >= 0 ? rest.slice(0, next + 1) : rest);
}

/** The "- item" entries directly under `    key:` in a service block. */
function list(block: string, key: string): string[] {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line === `    ${key}:`);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {6}- (.*)$/.exec(line);
    if (!match) break;
    items.push(match[1].trim());
  }
  return items;
}

const env = (block: string, key: string) => new RegExp(`^ {6}${key}: (.*)$`, 'm').exec(block)?.[1];

test('Dockerfile: locked, non-login, home-less identities 10001 (API) and 10002 (migrations), no extra groups', () => {
  assert.match(runtime, /groupadd --system --gid 10001 eltnoy-api/);
  assert.match(runtime, /useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir \/nonexistent --shell \/usr\/sbin\/nologin eltnoy-api/);
  assert.match(runtime, /groupadd --system --gid 10002 eltnoy-migrate/);
  assert.match(runtime, /useradd --system --uid 10002 --gid 10002 --no-create-home --home-dir \/nonexistent --shell \/usr\/sbin\/nologin eltnoy-migrate/);
  assert.match(runtime, /usermod --lock eltnoy-api && usermod --lock eltnoy-migrate/);
  assert.doesNotMatch(runtime, /useradd[^\n]*(\s-G\s|--groups|--append)|usermod[^\n]*(-aG|-G\s|--groups)/, 'no supplementary groups');
  assert.doesNotMatch(runtime, /gpasswd|adduser/);
});

test('Dockerfile: application files stay root-owned; private document root 10001:10001 0700; node is PID 1', () => {
  assert.match(runtime, /install -d -o 10001 -g 10001 -m 0700 \/var\/lib\/eltnoy\/documents/);
  for (const line of runtime.split('\n').filter((entry) => entry.startsWith('COPY'))) {
    assert.doesNotMatch(line, /--chown|--chmod/, `runtime COPY must not change ownership: ${line}`);
  }
  assert.doesNotMatch(noComments(runtime), /chown|chmod (-R )?[0-7]*7[0-7]?\b|USER node/);
  assert.match(runtime, /^USER 10001:10001$/m);
  assert.match(runtime, /^CMD \["node", "--import", "tsx", "server\/index\.ts"\]$/m);
  assert.doesNotMatch(noComments(runtime), /npm start/);
  assert.match(runtime, /RUN npm ci --omit=dev/, 'tsx is a production dependency and is installed in the runtime image');
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies.tsx && pkg.dependencies.pg, 'tsx and pg are runtime dependencies');
});

// P1-D.2: the single "app" service became two instances of the same image, api_public (port 4000)
// and api_admin (port 4001); every hardening assertion applies to both.
for (const [service, port] of [['api_public', 4000], ['api_admin', 4001]] as const) test(`Compose ${service}: 10001, read-only root, tmpfs /tmp, no capabilities, no-new-privileges, only the app secret`, () => {
  const app = serviceBlock(service);
  assert.match(app, /^ {4}user: "10001:10001"$/m);
  assert.match(app, /^ {4}read_only: true$/m);
  assert.deepEqual(list(app, 'tmpfs'), ['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']);
  assert.deepEqual(list(app, 'cap_drop'), ['ALL']);
  assert.deepEqual(list(app, 'security_opt'), ['no-new-privileges:true']);
  assert.deepEqual(list(app, 'secrets'), ['eltnoy_app_password']);
  assert.equal(env(app, 'DATABASE_URL'), 'postgresql://eltnoy_app@postgres:5432/${POSTGRES_DB:?Set POSTGRES_DB in .env.production}');
  assert.equal(env(app, 'DATABASE_PASSWORD_FILE'), '/run/secrets/eltnoy_app_password');
  assert.equal(env(app, 'INSTITUTION_DOCUMENT_STORAGE_DIR'), '/var/lib/eltnoy/documents');
  assert.ok(list(app, 'volumes').includes('institution_documents:/var/lib/eltnoy/documents'));
  assert.deepEqual(list(app, 'command'), ['sh', '-ec', 'node --import tsx server/validateDeploymentConfig.ts && exec node --import tsx server/index.ts'], 'node replaces the shell as PID 1');
  assert.doesNotMatch(app, /npm (start|run)|cap_add|privileged|group_add|PASSWORD\}|:\$\{POSTGRES_PASSWORD/);
  assert.doesNotMatch(app, /eltnoy_migrator|ports:/, 'no migrator credential and no published port');
  assert.ok(app.includes(`fetch('http://127.0.0.1:${port}/api/health')`), 'health check on its own listener');
});

test('Compose migrate: profile ops, 10002, same hardening, only the migrator secret, direct node', () => {
  const migrate = serviceBlock('migrate');
  assert.deepEqual(list(migrate, 'profiles'), ['ops']);
  assert.match(migrate, /^ {4}user: "10002:10002"$/m);
  assert.match(migrate, /^ {4}read_only: true$/m);
  assert.match(migrate, /^ {4}restart: "no"$/m);
  assert.deepEqual(list(migrate, 'tmpfs'), ['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']);
  assert.deepEqual(list(migrate, 'cap_drop'), ['ALL']);
  assert.deepEqual(list(migrate, 'security_opt'), ['no-new-privileges:true']);
  assert.deepEqual(list(migrate, 'secrets'), ['eltnoy_migrator_password']);
  assert.deepEqual(list(migrate, 'command'), ['node', '--import', 'tsx', 'server/migrate.ts']);
  assert.match(migrate, /^ {4}networks:\n {6}db_ops: \{\}\n(?! {6}\S)/m, 'operations database network only');
  assert.equal(env(migrate, 'DATABASE_URL'), 'postgresql://eltnoy_migrator@postgres:5432/${POSTGRES_DB:?Set POSTGRES_DB in .env.production}');
  assert.equal(env(migrate, 'DATABASE_PASSWORD_FILE'), '/run/secrets/eltnoy_migrator_password');
  assert.doesNotMatch(migrate, /ports:|expose:|group_add|cap_add|privileged|npm /);
});

test('Compose postgres/nginx_public/nginx_admin: superuser password only from a file secret; Nginx gets no secret', () => {
  const postgres = serviceBlock('postgres');
  assert.equal(env(postgres, 'POSTGRES_PASSWORD_FILE'), '/run/secrets/postgres_superuser_password');
  assert.equal(env(postgres, 'POSTGRES_PASSWORD'), undefined);
  assert.deepEqual(list(postgres, 'secrets'), ['postgres_superuser_password']);
  assert.doesNotMatch(postgres, /ports:/, 'database port is never published');
  for (const nginx of ['nginx_public', 'nginx_admin']) assert.deepEqual(list(serviceBlock(nginx), 'secrets'), [], nginx);
});

test('Compose: secret files come from ELTNOY_SECRETS_DIR; no password variable, no group_add anywhere', () => {
  const active = noComments(compose);
  assert.doesNotMatch(active, /POSTGRES_PASSWORD\b(?!_FILE)|\$\{[A-Z_]*PASSWORD[A-Z_]*[:}]/, 'no password is interpolated from the environment');
  assert.doesNotMatch(active, /group_add|privileged: true|cap_add/);
  const secrets = active.slice(active.indexOf('\nsecrets:\n'));
  for (const name of ['postgres_superuser_password', 'eltnoy_app_password', 'eltnoy_migrator_password']) {
    assert.match(secrets, new RegExp(`\\n {2}${name}:\\n {4}file: \\$\\{ELTNOY_SECRETS_DIR:\\?[^}]+\\}/${name}\\n`), `${name} file secret`);
  }
});

const SECRET_PATHS = ['secrets/eltnoy_app_password', 'deploy/secrets/eltnoy_migrator_password', 'eltnoy_app_password',
  'ops/backup.pgpass', '.pgpass', 'pgpass.conf', 'db.secret', 'eltnoy_app_password.txt', '.env.production', '.local-dev/secrets/x'];

test('.dockerignore: credential rules present and after every "!" re-include', () => {
  const rules = read('.dockerignore').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const required = ['secrets/', '**/secrets/', '**/*.secret', '**/*_password', '**/*_password.txt', '**/*.pgpass', '**/.pgpass', '**/pgpass.conf'];
  for (const rule of required) assert.ok(rules.includes(rule), `missing ${rule}`);
  const lastNegation = rules.reduce((last, rule, index) => (rule.startsWith('!') ? index : last), -1);
  assert.ok(lastNegation < Math.min(...required.map((rule) => rules.indexOf(rule))), 'no "!" rule may follow the credential rules');
});

test('.gitignore: synthetic credential paths are ignored, application and migration files are not', (t) => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const probe = spawnSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('not a Git checkout'); return; }
  const ignored = (path: string) => spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--no-index', path]).status === 0;
  for (const path of SECRET_PATHS) assert.ok(ignored(path), `${path} must be ignored`);
  for (const path of ['server/databaseCredentials.ts', 'server/databaseGrantsMigration.sql', 'server/migrate.ts', 'server/schema.sql',
    'docker-compose.yml', 'Dockerfile', '.env.example', 'public/assets/eltnoy-logo.png', 'src/main.tsx']) {
    assert.ok(!ignored(path), `${path} must not be ignored`);
  }
});
