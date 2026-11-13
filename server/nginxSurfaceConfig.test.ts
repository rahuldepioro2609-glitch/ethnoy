// P1-C static tests for the public and Admin Nginx configurations.
//
// The configurations are parsed into a directive tree (a small tokenizer/parser below; the
// repository has no Nginx parser dependency), includes are expanded from deploy/nginx/includes/,
// and each proxied location's EFFECTIVE proxy_set_header set is computed with Nginx's inheritance
// rule (a level that defines any proxy_set_header inherits none from outer levels).
// No Nginx process is started, nothing is mounted and no network request is made: these tests do
// not prove runtime, TLS, DNS, Docker or network behaviour (P1-D/P1-F).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

process.env.DOTENV_CONFIG_PATH ??= '/dev/null';
process.env.DATABASE_URL ??= 'postgresql://127.0.0.1:1/p1c_nginx_static_tests';

const [{ PINNED_SURFACE_HOSTNAMES, parseOriginalHost }, { DEFAULT_LISTENER_PORTS, ORIGINAL_HOST_HEADER }] = await Promise.all([
  import('./surface.js'),
  import('./surfaceEnforcement.js'),
]);

// ---------------------------------------------------------------------------
// Minimal Nginx configuration parser
// ---------------------------------------------------------------------------

interface Directive {
  name: string;
  args: string[];
  block?: Directive[];
  file: string;
  line: number;
}

type Token = { type: 'word' | '{' | '}' | ';'; value: string; line: number; quoted: boolean };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '\n') { line += 1; i += 1; continue; }
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (char === '{' || char === '}' || char === ';') { tokens.push({ type: char, value: char, line, quoted: false }); i += 1; continue; }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) { value += text[i] + text[i + 1]; i += 2; continue; }
        if (text[i] === '\n') line += 1;
        value += text[i];
        i += 1;
      }
      assert.ok(i < text.length, `unterminated string at line ${line}`);
      i += 1;
      tokens.push({ type: 'word', value, line, quoted: true });
      continue;
    }
    let value = '';
    while (i < text.length && !/[\s{};"'#]/.test(text[i])) { value += text[i]; i += 1; }
    tokens.push({ type: 'word', value, line, quoted: false });
  }
  return tokens;
}

function parse(text: string, file: string): Directive[] {
  const tokens = tokenize(text);
  let position = 0;
  const parseBlock = (nested: boolean): Directive[] => {
    const directives: Directive[] = [];
    while (position < tokens.length) {
      const token = tokens[position];
      if (token.type === '}') {
        assert.ok(nested, `${file}:${token.line}: unexpected }`);
        position += 1;
        return directives;
      }
      assert.equal(token.type, 'word', `${file}:${token.line}: expected a directive name`);
      const name = token.value;
      const args: string[] = [];
      position += 1;
      while (position < tokens.length && tokens[position].type === 'word') { args.push(tokens[position].value); position += 1; }
      const end = tokens[position];
      assert.ok(end, `${file}: directive ${name} is not terminated`);
      position += 1;
      if (end.type === ';') directives.push({ name, args, file, line: token.line });
      else if (end.type === '{') directives.push({ name, args, block: parseBlock(true), file, line: token.line });
      else assert.fail(`${file}:${end.line}: unexpected ${end.value}`);
    }
    assert.ok(!nested, `${file}: unterminated block`);
    return directives;
  };
  return parseBlock(false);
}

const ROOT = new URL('../', import.meta.url);
const CONTAINER_INCLUDES = '/etc/nginx/includes/';
const referencedIncludes = new Set<string>();

/** Expands include directives; only /etc/nginx/includes/<file> (mounted from deploy/nginx/includes/). */
function expand(directives: Directive[]): Directive[] {
  return directives.flatMap((directive): Directive[] => {
    if (directive.name === 'include') {
      assert.equal(directive.args.length, 1, `${directive.file}:${directive.line}: include takes one path`);
      const target = directive.args[0];
      assert.ok(target.startsWith(CONTAINER_INCLUDES), `${directive.file}:${directive.line}: include ${target} is outside ${CONTAINER_INCLUDES}`);
      assert.ok(!/[*?[]/.test(target), `${directive.file}:${directive.line}: glob includes are not allowed`);
      const local = `deploy/nginx/includes/${target.slice(CONTAINER_INCLUDES.length)}`;
      assert.ok(existsSync(new URL(local, ROOT)), `${directive.file}:${directive.line}: included file ${local} does not exist`);
      referencedIncludes.add(local);
      return expand(parse(readFileSync(new URL(local, ROOT), 'utf8'), local));
    }
    return [directive.block ? { ...directive, block: expand(directive.block) } : directive];
  });
}

function load(path: string): Directive[] {
  return expand(parse(readFileSync(new URL(path, ROOT), 'utf8'), path));
}

const CONFIGS = {
  public: { path: 'deploy/nginx/public.conf', tree: load('deploy/nginx/public.conf') },
  admin: { path: 'deploy/nginx/admin.conf', tree: load('deploy/nginx/admin.conf') },
} as const;
type ConfigName = keyof typeof CONFIGS;

const EXPECTED_HOSTS: Record<ConfigName, string[]> = {
  public: [PINNED_SURFACE_HOSTNAMES.marketing, PINNED_SURFACE_HOSTNAMES.exam, PINNED_SURFACE_HOSTNAMES.institution],
  admin: [PINNED_SURFACE_HOSTNAMES.admin],
};
const EXPECTED_UPSTREAM: Record<ConfigName, { name: string; server: string }> = {
  public: { name: 'eltnoy_public_listener', server: `app:${DEFAULT_LISTENER_PORTS.public}` },
  admin: { name: 'eltnoy_admin_listener', server: `app:${DEFAULT_LISTENER_PORTS.admin}` },
};

const children = (directive: Directive, name: string) => (directive.block ?? []).filter((child) => child.name === name);
const servers = (tree: Directive[]) => tree.filter((directive) => directive.name === 'server');
const listenOf = (server: Directive) => children(server, 'listen').map((listen) => listen.args.join(' '));
const isDefault = (server: Directive) => listenOf(server).some((listen) => /\bdefault_server\b/.test(listen));
const isTls = (server: Directive) => listenOf(server).some((listen) => /\bssl\b/.test(listen));

function* walk(directives: Directive[], ancestors: Directive[] = []): Generator<{ directive: Directive; ancestors: Directive[] }> {
  for (const directive of directives) {
    yield { directive, ancestors };
    if (directive.block) yield* walk(directive.block, [...ancestors, directive]);
  }
}

/** Effective proxy_set_header map for a location, following Nginx inheritance. */
function effectiveProxyHeaders(tree: Directive[], ancestors: Directive[], location: Directive): Map<string, string> {
  const levels = [location, ...[...ancestors].reverse().filter((level) => level.name === 'location' || level.name === 'server')];
  for (const level of levels) {
    const own = children(level, 'proxy_set_header');
    if (own.length > 0) return new Map(own.map((header) => [header.args[0].toLowerCase(), header.args[1] ?? '']));
  }
  return new Map(tree.filter((directive) => directive.name === 'proxy_set_header').map((header) => [header.args[0].toLowerCase(), header.args[1] ?? '']));
}

function proxiedLocations(name: ConfigName) {
  const { tree } = CONFIGS[name];
  return [...walk(tree)].filter(({ directive }) => directive.name === 'location' && children(directive, 'proxy_pass').length > 0);
}

/** Evaluates the original-host map like Nginx: exact strings first, then regexes in order. */
function evaluateMap(name: ConfigName, host: string): string {
  const map = CONFIGS[name].tree.find((directive) => directive.name === 'map');
  assert.ok(map?.block);
  const entries = map.block.filter((entry) => entry.name !== 'default' && entry.name !== 'hostnames');
  const exact = entries.find((entry) => !entry.name.startsWith('~') && entry.name === host);
  if (exact) return exact.args[0];
  for (const entry of entries.filter((candidate) => candidate.name.startsWith('~'))) {
    const regex = entry.name.startsWith('~*') ? new RegExp(entry.name.slice(2), 'i') : new RegExp(entry.name.slice(1));
    if (regex.test(host)) return entry.args[0];
  }
  return map.block.find((entry) => entry.name === 'default')?.args[0] ?? '';
}

const REQUIRED_HEADERS: Record<string, string> = {
  'host': '$eltnoy_original_host',
  'x-forwarded-host': '$eltnoy_original_host',
  'x-forwarded-proto': '$scheme',
  'x-forwarded-for': '$remote_addr',
  [ORIGINAL_HOST_HEADER]: '$eltnoy_original_host',
};
const STRIPPED_HEADERS = ['x-eltnoy-listener', 'x-eltnoy-surface', 'forwarded', 'x-forwarded-port', 'x-forwarded-prefix', 'upgrade', 'connection'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('includes: every referenced include exists, is local to deploy/nginx/includes and is used', () => {
  // Loading above already asserted existence; both include files are referenced.
  assert.deepEqual([...referencedIncludes].sort(), ['deploy/nginx/includes/eltnoy-proxy.conf', 'deploy/nginx/includes/eltnoy-tls.conf']);
});

test('hostnames: public serves only the three public hostnames; Admin only admin.eltnoy.com', () => {
  for (const name of ['public', 'admin'] as const) {
    const named = servers(CONFIGS[name].tree).filter((server) => !isDefault(server));
    const hostnames = named.flatMap((server) => children(server, 'server_name').flatMap((directive) => directive.args));
    assert.deepEqual([...new Set(hostnames)].sort(), [...EXPECTED_HOSTS[name]].sort(), name);
    for (const server of named) {
      const serverNames = children(server, 'server_name').flatMap((directive) => directive.args);
      assert.equal(serverNames.length, 1, `${name}: one explicit hostname per server`);
      assert.ok(!/[*~]/.test(serverNames[0]), `${name}: no wildcard or regex server_name`);
    }
  }
  const publicNames = servers(CONFIGS.public.tree).flatMap((server) => children(server, 'server_name').flatMap((directive) => directive.args));
  const adminNames = servers(CONFIGS.admin.tree).flatMap((server) => children(server, 'server_name').flatMap((directive) => directive.args));
  assert.ok(!publicNames.includes(PINNED_SURFACE_HOSTNAMES.admin), 'the Admin hostname is not served by the public configuration');
  for (const host of EXPECTED_HOSTS.public) assert.ok(!adminNames.includes(host), `${host} is not served by the Admin configuration`);
});

test('upstreams: public proxies only to the public listener; Admin only to the Admin listener', () => {
  for (const name of ['public', 'admin'] as const) {
    const { tree } = CONFIGS[name];
    const upstreams = tree.filter((directive) => directive.name === 'upstream');
    assert.deepEqual(upstreams.map((upstream) => upstream.args[0]), [EXPECTED_UPSTREAM[name].name], `${name}: exactly one upstream`);
    assert.deepEqual(children(upstreams[0], 'server').map((server) => server.args.join(' ')), [EXPECTED_UPSTREAM[name].server]);
    const targets = [...walk(tree)].filter(({ directive }) => directive.name === 'proxy_pass').map(({ directive }) => directive.args.join(' '));
    assert.ok(targets.length > 0);
    for (const target of targets) assert.equal(target, `http://${EXPECTED_UPSTREAM[name].name}`, `${name}: proxy_pass ${target}`);
    const other = name === 'public' ? 'admin' : 'public';
    const otherPort = String(DEFAULT_LISTENER_PORTS[other]);
    for (const { directive } of walk(tree)) {
      assert.ok(!directive.args.some((arg) => arg.includes(`:${otherPort}`) || arg.includes(EXPECTED_UPSTREAM[other].name)), `${name}: ${directive.name} refers to the ${other} listener`);
    }
  }
});

test('headers: every proxied location carries the full trusted forwarding set after inheritance', () => {
  for (const name of ['public', 'admin'] as const) {
    const locations = proxiedLocations(name);
    assert.equal(locations.length, EXPECTED_HOSTS[name].length, `${name}: one proxied location per HTTPS hostname server`);
    for (const { directive, ancestors } of locations) {
      const headers = effectiveProxyHeaders(CONFIGS[name].tree, ancestors, directive);
      const label = `${name} ${directive.file}:${directive.line}`;
      for (const [header, value] of Object.entries(REQUIRED_HEADERS)) {
        assert.equal(headers.get(header), value, `${label}: ${header}`);
      }
      for (const header of STRIPPED_HEADERS) assert.equal(headers.get(header), '', `${label}: ${header} stripped`);
      // The complete set is defined in the location itself, so nothing depends on inheritance.
      assert.ok(children(directive, 'proxy_set_header').length >= Object.keys(REQUIRED_HEADERS).length + STRIPPED_HEADERS.length, label);
      assert.deepEqual(children(directive, 'proxy_http_version').map((version) => version.args[0]), ['1.1'], label);
    }
  }
});

test('headers: X-Forwarded-For is overwritten, never appended; no raw client host is forwarded', () => {
  for (const name of ['public', 'admin'] as const) {
    for (const { directive } of walk(CONFIGS[name].tree)) {
      assert.ok(!directive.args.some((arg) => arg.includes('$proxy_add_x_forwarded_for')), `${name}: ${directive.name} appends X-Forwarded-For`);
      if (directive.name === 'proxy_set_header') {
        const value = directive.args[1] ?? '';
        // No incoming forwarding header or raw Host is ever copied upstream.
        assert.ok(!/\$(http_host|host|http_x_forwarded_host|http_x_forwarded_for|http_x_eltnoy_original_host|http_forwarded)\b/i.test(value), `${name}: ${directive.args[0]} copies a client value`);
      }
    }
    // No proxy_set_header outside locations that a location could silently shadow or lose.
    for (const { directive, ancestors } of walk(CONFIGS[name].tree)) {
      if (directive.name === 'proxy_set_header') assert.equal(ancestors.at(-1)?.name, 'location', `${name}: proxy_set_header outside a location`);
    }
  }
});

test('hosts: the original-host map is an exact, case-insensitive, port-free allow-list', () => {
  for (const name of ['public', 'admin'] as const) {
    const map = CONFIGS[name].tree.find((directive) => directive.name === 'map');
    assert.ok(map);
    assert.deepEqual(map.args, ['$http_host', '$eltnoy_original_host']);
    assert.equal(map.block!.find((entry) => entry.name === 'default')?.args[0], '');
    const values = map.block!.filter((entry) => entry.name !== 'default').map((entry) => entry.args[0]).sort();
    assert.deepEqual(values, [...EXPECTED_HOSTS[name]].sort(), `${name}: map outputs are exactly the allow-listed hostnames`);
    for (const host of EXPECTED_HOSTS[name]) {
      assert.equal(evaluateMap(name, host), host);
      assert.equal(evaluateMap(name, host.toUpperCase()), host, 'case-insensitive, normalised');
      // Agrees with the P1-B gate's host parser.
      assert.deepEqual(parseOriginalHost(evaluateMap(name, host)), { ok: true, hostname: host });
      for (const bad of [`${host}:443`, `${host}:8443`, `${host}.`, ` ${host}`, `${host},${host}`, `x.${host}`, `${host}.evil.com`, `${host}x`]) {
        assert.equal(evaluateMap(name, bad), '', `${name}: ${JSON.stringify(bad)} rejected`);
      }
    }
    for (const bad of ['', 'evil.com', 'localhost', '127.0.0.1', 'www.eltnoy.com', name === 'public' ? 'admin.eltnoy.com' : 'exam.eltnoy.com']) {
      assert.equal(evaluateMap(name, bad), '', `${name}: ${JSON.stringify(bad)} rejected`);
    }
  }
});

test('hosts: every hostname server rejects a Host that is not its own before any location runs', () => {
  for (const name of ['public', 'admin'] as const) {
    for (const server of servers(CONFIGS[name].tree).filter((candidate) => !isDefault(candidate))) {
      const host = children(server, 'server_name')[0].args[0];
      const guards = children(server, 'if');
      assert.equal(guards.length, 1, `${name} ${host}: one host guard`);
      assert.equal(guards[0].args.join(' ').replace(/\(\s*/, '(').replace(/\s*\)$/, ')'), `($eltnoy_original_host != ${host})`);
      assert.deepEqual(guards[0].block!.map((directive) => [directive.name, ...directive.args]), [['return', '421']]);
      const guardIndex = server.block!.indexOf(guards[0]);
      const firstLocation = server.block!.findIndex((directive) => directive.name === 'location');
      assert.ok(guardIndex < firstLocation, `${name} ${host}: guard precedes locations`);
      if (!isTls(server)) {
        // HTTP servers only redirect, to a literal URL of their own hostname.
        assert.deepEqual(children(server, 'location').map((location) => [location.args.join(' '), ...children(location, 'return').flatMap((ret) => ret.args)]), [['/', '301', `https://${host}$request_uri`]]);
      }
    }
  }
});

test('hosts: default servers drop unknown hosts, refuse unknown SNI and proxy nothing', () => {
  for (const name of ['public', 'admin'] as const) {
    const defaults = servers(CONFIGS[name].tree).filter(isDefault);
    assert.equal(defaults.length, 2, `${name}: HTTP and HTTPS default servers`);
    for (const server of defaults) {
      assert.deepEqual(children(server, 'server_name').flatMap((directive) => directive.args), ['_']);
      assert.equal([...walk(server.block!)].filter(({ directive }) => directive.name === 'proxy_pass').length, 0, `${name}: default server proxies nothing`);
      if (isTls(server)) {
        assert.deepEqual(children(server, 'ssl_reject_handshake').map((directive) => directive.args[0]), ['on']);
        assert.deepEqual(children(server, 'return').map((directive) => directive.args[0]), ['444']);
      } else {
        const catchAll = children(server, 'location').find((location) => location.args.join(' ') === '/');
        assert.deepEqual(children(catchAll!, 'return').map((directive) => directive.args[0]), ['444']);
      }
    }
  }
});

test('health: no public API health route; only a loopback-only Nginx-local probe that is never proxied', () => {
  for (const name of ['public', 'admin'] as const) {
    const locations = [...walk(CONFIGS[name].tree)].filter(({ directive }) => directive.name === 'location');
    const healthLocations = locations.filter(({ directive }) => directive.args.join(' ').includes('health'));
    assert.deepEqual(healthLocations.map(({ directive }) => directive.args.join(' ')), ['= /_internal-health'], name);
    const [{ directive: probe, ancestors }] = healthLocations;
    assert.ok(isDefault(ancestors.at(-1)!) && !isTls(ancestors.at(-1)!), `${name}: probe lives in the HTTP default server`);
    assert.deepEqual(children(probe, 'allow').map((directive) => directive.args[0]), ['127.0.0.1']);
    assert.deepEqual(children(probe, 'deny').map((directive) => directive.args[0]), ['all']);
    assert.deepEqual(children(probe, 'return').map((directive) => directive.args[0]), ['200']);
    assert.equal(children(probe, 'proxy_pass').length, 0);
    // Every proxied location is the plain catch-all: /api/health reaches the API like any other
    // path and is refused there (P1-B internal-only).
    for (const { directive } of proxiedLocations(name)) assert.equal(directive.args.join(' '), '/');
  }
});

test('routing: no named, fallback, error-page or variable routing can reach another listener', () => {
  for (const name of ['public', 'admin'] as const) {
    for (const { directive } of walk(CONFIGS[name].tree)) {
      assert.ok(!(directive.name === 'location' && directive.args[0]?.startsWith('@')), `${name}: named location`);
      for (const forbidden of ['error_page', 'try_files', 'rewrite', 'proxy_intercept_errors', 'resolver', 'set']) {
        assert.notEqual(directive.name, forbidden, `${name}: ${forbidden}`);
      }
      if (directive.name === 'proxy_pass') assert.ok(!/\$/.test(directive.args.join(' ')), `${name}: variable proxy_pass`);
      // Headers with underscores stay dropped by Nginx's default (no X_ELTNOY_* smuggling).
      if (directive.name === 'underscores_in_headers') assert.equal(directive.args[0], 'off');
      if (directive.name === 'ignore_invalid_headers') assert.equal(directive.args[0], 'on');
    }
  }
});

test('TLS: every HTTPS hostname server uses the shared TLS policy; no TLS verification is disabled', () => {
  for (const name of ['public', 'admin'] as const) {
    for (const server of servers(CONFIGS[name].tree).filter((candidate) => isTls(candidate) && !isDefault(candidate))) {
      assert.deepEqual(children(server, 'ssl_certificate').map((directive) => directive.args[0]), ['/etc/nginx/tls/fullchain.pem']);
      assert.deepEqual(children(server, 'ssl_certificate_key').map((directive) => directive.args[0]), ['/etc/nginx/tls/privkey.pem']);
      assert.deepEqual(children(server, 'ssl_protocols').flatMap((directive) => directive.args), ['TLSv1.2', 'TLSv1.3']);
    }
    for (const { directive } of walk(CONFIGS[name].tree)) {
      assert.ok(!(directive.name === 'proxy_ssl_verify' && directive.args[0] === 'off'), `${name}: proxy_ssl_verify off`);
      assert.ok(!(directive.name === 'listen' && directive.args.includes('http2')), `${name}: HTTP/2 not enabled in P1-C (Host handling validated for HTTP/1.1 only)`);
    }
  }
});

test('no placeholders, guessed addresses or environment substitution', () => {
  for (const name of ['public', 'admin'] as const) {
    for (const { directive } of walk(CONFIGS[name].tree)) {
      for (const arg of [directive.name, ...directive.args]) {
        assert.ok(!/\$\{|<[A-Z_]+>|TODO|CHANGEME|example\./i.test(arg), `${name}: placeholder in ${directive.name} ${arg}`);
        const ipv4 = arg.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
        for (const address of ipv4) {
          assert.ok(address === '127.0.0.1' && directive.name === 'allow', `${name}: unexpected IP address in ${directive.name}`);
        }
      }
    }
  }
});

test('the two configurations cannot be loaded together: both declare default servers on the same ports', () => {
  // The real guard (P1-C audit L-1): a combined load fails with a duplicate default server for
  // 8080 and 8443. A duplicate map variable alone would NOT fail (the later map silently wins).
  const defaultListens = (name: 'public' | 'admin') => servers(CONFIGS[name].tree).filter(isDefault)
    .flatMap((server) => listenOf(server).map((listen) => listen.split(/\s+/)[0])).sort();
  assert.deepEqual(defaultListens('public'), ['8080', '8443']);
  assert.deepEqual(defaultListens('admin'), ['8080', '8443']);
  for (const name of ['public', 'admin'] as const) {
    assert.equal(CONFIGS[name].tree.filter((directive) => directive.name === 'map' && directive.args[1] === '$eltnoy_original_host').length, 1);
  }
  // The legacy single-host template (still mounted by the current Compose file until P1-D) is not
  // part of this policy and is not referenced by the new configurations.
  for (const name of ['public', 'admin'] as const) {
    assert.ok(![...walk(CONFIGS[name].tree)].some(({ directive }) => directive.args.some((arg) => arg.includes('default.conf.template'))));
  }
});

test('P1-D.2: server_tokens off at http level in both configurations (no version disclosure)', () => {
  for (const name of ['public', 'admin'] as const) {
    const topLevel = CONFIGS[name].tree.filter((directive) => directive.name === 'server_tokens');
    assert.deepEqual(topLevel.map((directive) => directive.args), [['off']], name);
    // No server or location re-enables it.
    for (const { directive } of walk(CONFIGS[name].tree)) {
      if (directive.name === 'server_tokens') assert.equal(directive.args[0], 'off', `${name}: ${directive.file}:${directive.line}`);
    }
  }
});
