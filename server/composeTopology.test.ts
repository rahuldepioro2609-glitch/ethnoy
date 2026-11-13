// P1-D.2 static tests of the Docker Compose topology (Option B: isolated public and Admin API
// instances). docker-compose.yml is parsed with a strict YAML-subset parser (below; no YAML
// dependency is installed) that throws on any construct it does not understand, so nothing is
// silently misread. No Docker or Compose command is run: these tests prove the declared topology,
// not runtime network behaviour, Docker isolation rules or published-port behaviour (P1-F).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type Yaml = string | null | Yaml[] | { [key: string]: Yaml };
type YamlMap = { [key: string]: Yaml };

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\' && quote === '"') { i += 1; continue; }
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

function scalar(value: string, line: number): Yaml {
  if (value === '{}') return {};
  if (value === '[]') return [];
  if (/^[|>]/.test(value) || /^[[{&*!]/.test(value)) throw new Error(`line ${line}: unsupported YAML value ${value}`);
  if (value.startsWith('"')) return JSON.parse(value) as string;
  if (value.startsWith("'")) {
    assert.ok(value.endsWith("'"), `line ${line}: unterminated string`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseYaml(text: string): YamlMap {
  const lines: Array<{ indent: number; text: string; n: number }> = [];
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const leading = raw.slice(0, raw.length - raw.trimStart().length);
    if (leading.includes('\t')) throw new Error(`line ${index + 1}: tab indentation`);
    lines.push({ indent: leading.length, text: stripComment(trimmed), n: index + 1 });
  });
  let i = 0;
  const parseNode = (indent: number): Yaml => (lines[i].text.startsWith('- ') ? parseSeq(indent) : parseMap(indent));
  function parseMap(indent: number): YamlMap {
    const map: YamlMap = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const line = lines[i];
      const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line.text);
      if (!match) throw new Error(`line ${line.n}: unsupported YAML: ${line.text}`);
      const [, key, rest] = match;
      if (Object.prototype.hasOwnProperty.call(map, key)) throw new Error(`line ${line.n}: duplicate key ${key}`);
      i += 1;
      if (rest === undefined || rest === '') {
        map[key] = i < lines.length && lines[i].indent > indent ? parseNode(lines[i].indent) : null;
      } else {
        map[key] = scalar(rest, line.n);
      }
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].n}: unexpected indentation`);
    return map;
  }
  function parseSeq(indent: number): Yaml[] {
    const items: Yaml[] = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const line = lines[i];
      const content = line.text.slice(2);
      if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(content)) {
        lines[i] = { indent: indent + 2, text: content, n: line.n };
        items.push(parseMap(indent + 2));
      } else {
        i += 1;
        items.push(scalar(content, line.n));
      }
    }
    return items;
  }
  const root = parseMap(0);
  if (i !== lines.length) throw new Error(`line ${lines[i].n}: could not be parsed`);
  return root;
}

const composeText = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const compose = parseYaml(composeText);
const services = compose.services as Record<string, YamlMap>;
const networks = compose.networks as Record<string, YamlMap>;
const service = (name: string) => {
  assert.ok(services[name], `service ${name} exists`);
  return services[name];
};
const asMap = (value: Yaml | undefined): YamlMap => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asList = (value: Yaml | undefined): string[] => (Array.isArray(value) ? value.map(String) : []);
const networksOf = (name: string) => Object.keys(asMap(service(name).networks)).sort();
const env = (name: string) => asMap(service(name).environment) as Record<string, string>;
/** The variable name of a required interpolation `${NAME:?message}` (and nothing else). */
const requiredVariable = (value: unknown) => /^\$\{([A-Z0-9_]+):\?[^}]+\}$/.exec(String(value))?.[1];

const EXPECTED_MEMBERSHIP: Record<string, string[]> = {
  nginx_public: ['public_app', 'public_ingress'],
  api_public: ['db_public', 'public_app'],
  nginx_admin: ['admin_app', 'admin_ingress'],
  api_admin: ['admin_app', 'db_admin'],
  postgres: ['db_admin', 'db_ops', 'db_public'],
  migrate: ['db_ops'],
};

test('parser: the whole Compose file is understood (services, secrets, networks, volumes)', () => {
  assert.deepEqual(Object.keys(compose).sort(), ['name', 'networks', 'secrets', 'services', 'volumes']);
  assert.equal(compose.name, 'eltnoy-production', 'P4-8: explicit, stable project name');
  assert.deepEqual(Object.keys(services).sort(), Object.keys(EXPECTED_MEMBERSHIP).sort());
  assert.throws(() => parseYaml('a:\n  b: |\n    x\n'), /unsupported/);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate/);
});

test('networks: exactly the approved networks; application and database networks are internal', () => {
  assert.deepEqual(Object.keys(networks).sort(), ['admin_app', 'admin_ingress', 'db_admin', 'db_ops', 'db_public', 'public_app', 'public_ingress']);
  for (const name of ['public_app', 'admin_app', 'db_public', 'db_admin', 'db_ops']) assert.equal(networks[name].internal, 'true', name);
  for (const name of ['public_ingress', 'admin_ingress']) assert.equal(networks[name].internal, undefined, `${name} must allow port publishing`);
  for (const name of Object.keys(networks)) assert.equal(networks[name].driver, 'bridge', name);
  for (const [name, variable] of [['public_app', 'PUBLIC_APP_SUBNET'], ['admin_app', 'ADMIN_APP_SUBNET']] as const) {
    const config = asMap(networks[name].ipam).config as YamlMap[];
    assert.equal(config.length, 1);
    assert.equal(requiredVariable(config[0].subnet), variable, `${name}: subnet from a required variable`);
  }
});

test('membership: the exact approved matrix (isolation by network membership)', () => {
  for (const [name, expected] of Object.entries(EXPECTED_MEMBERSHIP)) assert.deepEqual(networksOf(name), expected, name);
  const members = (network: string) => Object.keys(services).filter((name) => networksOf(name).includes(network)).sort();
  assert.deepEqual(members('public_app'), ['api_public', 'nginx_public'], 'public_app: one Nginx and one API');
  assert.deepEqual(members('admin_app'), ['api_admin', 'nginx_admin'], 'admin_app: one Nginx and one API');
  assert.deepEqual(members('public_ingress'), ['nginx_public']);
  assert.deepEqual(members('admin_ingress'), ['nginx_admin']);
  assert.deepEqual(members('db_public'), ['api_public', 'postgres']);
  assert.deepEqual(members('db_admin'), ['api_admin', 'postgres']);
  assert.deepEqual(members('db_ops'), ['migrate', 'postgres']);
});

test('reachability: the API services share no network; the Nginx services share no network; no Nginx on a database network', () => {
  const shared = (a: string, b: string) => networksOf(a).filter((network) => networksOf(b).includes(network));
  assert.deepEqual(shared('api_public', 'api_admin'), []);
  assert.deepEqual(shared('nginx_public', 'nginx_admin'), []);
  assert.deepEqual(shared('nginx_public', 'api_admin'), [], 'public Nginx cannot reach the Admin API');
  assert.deepEqual(shared('nginx_admin', 'api_public'), [], 'Admin Nginx cannot reach the public API');
  assert.deepEqual(shared('nginx_public', 'api_public'), ['public_app']);
  assert.deepEqual(shared('nginx_admin', 'api_admin'), ['admin_app']);
  for (const nginx of ['nginx_public', 'nginx_admin']) {
    assert.deepEqual(shared(nginx, 'postgres'), [], `${nginx} cannot reach PostgreSQL`);
    assert.ok(!networksOf(nginx).some((network) => network.startsWith('db_')), nginx);
  }
  for (const name of Object.keys(services)) {
    assert.equal(service(name).network_mode, undefined, name);
    for (const key of ['pid', 'ipc', 'privileged', 'cap_add', 'extra_hosts', 'group_add']) assert.equal(service(name)[key], undefined, `${name}: ${key}`);
  }
});

test('aliases and static addresses: "app" resolves only on each application network; addresses come from required variables', () => {
  const nets = (name: string) => asMap(service(name).networks);
  assert.deepEqual(asList(asMap(nets('api_public').public_app).aliases), ['app']);
  assert.deepEqual(asList(asMap(nets('api_admin').admin_app).aliases), ['app']);
  for (const [name, network] of [['api_public', 'db_public'], ['api_admin', 'db_admin']] as const) assert.deepEqual(asMap(nets(name)[network]), {}, `${name}: no alias on ${network}`);
  assert.equal(requiredVariable(asMap(nets('api_public').public_app).ipv4_address), 'API_PUBLIC_APP_ADDRESS');
  assert.equal(requiredVariable(asMap(nets('api_admin').admin_app).ipv4_address), 'API_ADMIN_APP_ADDRESS');
  assert.equal(requiredVariable(asMap(nets('nginx_public').public_app).ipv4_address), 'NGINX_PUBLIC_APP_ADDRESS');
  assert.equal(requiredVariable(asMap(nets('nginx_admin').admin_app).ipv4_address), 'NGINX_ADMIN_APP_ADDRESS');
  // Each API trusts exactly the Nginx addresses it is given: the same variables, in both instances.
  for (const name of ['api_public', 'api_admin']) {
    assert.equal(requiredVariable(env(name).ELTNOY_PUBLIC_PROXY_CIDRS), 'NGINX_PUBLIC_APP_ADDRESS', name);
    assert.equal(requiredVariable(env(name).ELTNOY_ADMIN_PROXY_CIDRS), 'NGINX_ADMIN_APP_ADDRESS', name);
  }
  // The only literal address allowed is the in-container loopback used by the health probes.
  const literals = composeText.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d+)?\b/g) ?? [];
  assert.deepEqual([...new Set(literals)], ['127.0.0.1'], 'no literal network address or subnet');
});

test('ports: no application or PostgreSQL port is published; Nginx binds only to required interface addresses', () => {
  for (const name of ['api_public', 'api_admin', 'postgres', 'migrate']) {
    assert.equal(service(name).ports, undefined, `${name} publishes nothing`);
    assert.equal(service(name).expose, undefined, `${name} declares no extra exposure`);
  }
  const publicPorts = asList(service('nginx_public').ports);
  assert.equal(publicPorts.length, 2);
  for (const [port, target] of [['80', '8080'], ['443', '8443']]) {
    assert.ok(publicPorts.some((entry) => new RegExp(`^\\$\\{PUBLIC_BIND_ADDRESS:\\?[^}]+\\}:${port}:${target}$`).test(entry)), `public ${port}`);
  }
  assert.deepEqual(asList(service('nginx_admin').ports).map((entry) => entry.replace(/^\$\{ADMIN_BIND_ADDRESS:\?[^}]+\}/, '<ADMIN_BIND_ADDRESS>')), ['<ADMIN_BIND_ADDRESS>:443:8443'], 'Admin: HTTPS only, on the WireGuard address');
});

test('images: both API services use the same image; Nginx and PostgreSQL need digest-pinned references; no invented digest', () => {
  assert.equal(requiredVariable(service('api_public').image), 'ELTNOY_API_IMAGE');
  assert.equal(service('api_admin').image, service('api_public').image, 'same API image');
  assert.ok(service('api_public').build, 'api_public builds the image');
  assert.equal(service('api_public').pull_policy, 'build', 'M-1: api_public always builds and never pulls');
  assert.equal(service('api_admin').build, undefined, 'api_admin reuses it');
  assert.equal(service('api_admin').pull_policy, 'never', 'M-1: api_admin never pulls');
  assert.equal(requiredVariable(service('nginx_public').image), 'NGINX_IMAGE');
  assert.equal(service('nginx_admin').image, service('nginx_public').image);
  assert.equal(requiredVariable(service('postgres').image), 'POSTGRES_IMAGE');
  assert.doesNotMatch(composeText, /@sha256:|:stable-alpine|postgres:17\b(?![^\n]*#)/, 'no literal tag or invented digest');
});

test('API instances: identical hardening; one listener each; recovery only on api_public; application role only', () => {
  const hardening = (name: string) => ['restart', 'user', 'read_only', 'tmpfs', 'cap_drop', 'security_opt', 'secrets', 'command', 'depends_on'].map((key) => JSON.stringify(service(name)[key]));
  assert.deepEqual(hardening('api_admin'), hardening('api_public'));
  assert.equal(service('api_public').user, '"10001:10001"'.slice(1, -1));
  assert.equal(service('api_public').read_only, 'true');
  assert.deepEqual(asList(service('api_public').cap_drop), ['ALL']);
  assert.deepEqual(asList(service('api_public').security_opt), ['no-new-privileges:true']);
  assert.equal(env('api_public').ELTNOY_API_LISTENERS, 'public');
  assert.equal(env('api_admin').ELTNOY_API_LISTENERS, 'admin');
  assert.equal(env('api_public').ONLINE_EXAM_RECOVERY_SINCE, '${ONLINE_EXAM_RECOVERY_SINCE:-}');
  assert.equal(env('api_admin').ONLINE_EXAM_RECOVERY_SINCE, undefined, 'api_admin never receives the recovery cutoff');
  for (const name of ['api_public', 'api_admin']) {
    assert.equal(env(name).PORT, '4000');
    assert.equal(env(name).ADMIN_PORT, '4001');
    assert.match(env(name).DATABASE_URL, /^postgresql:\/\/eltnoy_app@postgres:5432\//);
    assert.equal(env(name).DATABASE_PASSWORD_FILE, '/run/secrets/eltnoy_app_password');
    assert.deepEqual(asList(service(name).secrets), ['eltnoy_app_password']);
    assert.ok(!JSON.stringify(service(name)).includes('migrator'), `${name}: no migration credential`);
    for (const legacy of ['APP_ORIGIN', 'APP_HOSTNAME', 'TLS_CERT_DIR', 'ELTNOY_TRUSTED_PROXY_CIDRS']) assert.equal(env(name)[legacy], undefined, `${name}: ${legacy}`);
    assert.ok(!asList(service(name).volumes).some((volume) => volume.includes('/etc/nginx')), `${name}: no Nginx TLS mount`);
    // Document storage: read-write in both for now (the Admin read path creates directories).
    assert.ok(asList(service(name).volumes).includes('institution_documents:/var/lib/eltnoy/documents'), name);
  }
});

test('credentials: the migrator secret is isolated to migrate; the superuser secret to postgres', () => {
  const holders = (secret: string) => Object.keys(services).filter((name) => asList(service(name).secrets).includes(secret)).sort();
  assert.deepEqual(holders('eltnoy_migrator_password'), ['migrate']);
  assert.deepEqual(holders('eltnoy_app_password'), ['api_admin', 'api_public']);
  assert.deepEqual(holders('postgres_superuser_password'), ['postgres']);
  assert.match(env('migrate').DATABASE_URL, /^postgresql:\/\/eltnoy_migrator@postgres:5432\//);
  assert.deepEqual(asList(service('migrate').profiles), ['ops']);
});

test('TLS: each Nginx mounts only its own certificate directory; nothing else mounts a TLS directory', () => {
  const tlsMounts = (name: string) => asList(service(name).volumes).filter((volume) => volume.endsWith(':/etc/nginx/tls:ro'));
  assert.deepEqual(tlsMounts('nginx_public').map((volume) => requiredVariable(volume.slice(0, volume.indexOf('}') + 1))), ['PUBLIC_TLS_CERT_DIR']);
  assert.deepEqual(tlsMounts('nginx_admin').map((volume) => requiredVariable(volume.slice(0, volume.indexOf('}') + 1))), ['ADMIN_TLS_CERT_DIR']);
  for (const name of Object.keys(services)) {
    const volumes = asList(service(name).volumes).join('\n');
    if (name !== 'nginx_public') assert.ok(!volumes.includes('PUBLIC_TLS_CERT_DIR'), `${name} mounts the public certificate`);
    if (name !== 'nginx_admin') assert.ok(!volumes.includes('ADMIN_TLS_CERT_DIR'), `${name} mounts the Admin certificate`);
  }
});

test('Nginx: P1-C configuration at the exact default path; includes read-only; no legacy template or substitution', () => {
  for (const [name, file] of [['nginx_public', 'public.conf'], ['nginx_admin', 'admin.conf']] as const) {
    const volumes = asList(service(name).volumes);
    assert.ok(volumes.includes(`./deploy/nginx/${file}:/etc/nginx/conf.d/default.conf:ro`), `${name}: ${file}`);
    assert.ok(volumes.includes('./deploy/nginx/includes:/etc/nginx/includes:ro'), name);
    assert.equal(volumes.length, 3, `${name}: configuration, includes and its own TLS directory only`);
    assert.equal(service(name).environment, undefined, `${name}: no environment substitution`);
    assert.equal(service(name).user, '101:101');
    assert.deepEqual(asList(service(name).secrets), []);
  }
  const otherFile = (name: string) => (name === 'nginx_public' ? 'admin.conf' : 'public.conf');
  for (const name of ['nginx_public', 'nginx_admin']) assert.ok(!asList(service(name).volumes).some((volume) => volume.includes(otherFile(name))), name);
  const active = composeText.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(active, /default\.conf\.template|\/etc\/nginx\/templates|NGINX_ENVSUBST|APP_HOSTNAME|APP_ORIGIN|(?<!PUBLIC_|ADMIN_)TLS_CERT_DIR/);
});

test('health and ordering: correct probes; Nginx after its own healthy API; APIs and migrate after healthy PostgreSQL', () => {
  const testOf = (name: string) => asList(asMap(service(name).healthcheck).test);
  assert.deepEqual(testOf('api_public').slice(0, 3), ['CMD', 'node', '-e']);
  assert.ok(testOf('api_public')[3].includes("fetch('http://127.0.0.1:4000/api/health')"));
  assert.ok(testOf('api_admin')[3].includes("fetch('http://127.0.0.1:4001/api/health')"));
  for (const name of ['nginx_public', 'nginx_admin']) {
    assert.deepEqual(testOf(name), ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:8080/_internal-health'], `${name}: no Host override`);
  }
  assert.deepEqual(testOf('postgres'), ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"']);
  const dependsOn = (name: string) => Object.fromEntries(Object.entries(asMap(service(name).depends_on)).map(([key, value]) => [key, asMap(value).condition]));
  assert.deepEqual(dependsOn('nginx_public'), { api_public: 'service_healthy' });
  assert.deepEqual(dependsOn('nginx_admin'), { api_admin: 'service_healthy' });
  for (const name of ['api_public', 'api_admin', 'migrate']) assert.deepEqual(dependsOn(name), { postgres: 'service_healthy' }, name);
  assert.doesNotMatch(composeText, /--header|--no-check-certificate|NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('M-1/M-2: both API services receive the preflight inputs from required variables (no defaults)', () => {
  for (const name of ['api_public', 'api_admin']) {
    assert.equal(requiredVariable(env(name).ELTNOY_API_IMAGE), 'ELTNOY_API_IMAGE', name);
    assert.equal(env(name).ELTNOY_API_IMAGE, service('api_public').image, `${name}: the validated reference is the image both services run`);
    for (const variable of ['PUBLIC_BIND_ADDRESS', 'ADMIN_BIND_ADDRESS', 'WIREGUARD_INTERFACE_ADDRESS']) {
      assert.equal(requiredVariable(env(name)[variable]), variable, `${name}: ${variable}`);
    }
    // The preflight runs before the API starts, so an invalid value keeps this API unhealthy.
    assert.equal(asList(service(name).command)[2], 'node --import tsx server/validateDeploymentConfig.ts && exec node --import tsx server/index.ts');
  }
  // Each Nginx publishes on exactly the address the API preflight validated, and only after that
  // API is healthy.
  assert.ok(asList(service('nginx_admin').ports).every((entry) => entry.startsWith('${ADMIN_BIND_ADDRESS:?')));
  assert.ok(asList(service('nginx_public').ports).every((entry) => entry.startsWith('${PUBLIC_BIND_ADDRESS:?')));
  assert.equal(asMap(asMap(service('nginx_admin').depends_on).api_admin).condition, 'service_healthy');
  assert.equal(asMap(asMap(service('nginx_public').depends_on).api_public).condition, 'service_healthy');
});
