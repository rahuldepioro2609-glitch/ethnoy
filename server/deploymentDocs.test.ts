// P1-B.1 M-A / L-B: static checks that deployment configuration and operator documentation match
// the P1-B code. Reads files only; nothing is deployed, executed or connected. Only variable NAMES
// are inspected in environment templates, never values.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { SURFACE_ENV } from './surfaceEnforcement.js';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const RUNBOOK = 'docs/operations/production-operator-runbook.md';
const runbookPresent = existsSync(new URL(RUNBOOK, root));

test('render.yaml: marked unsupported for P1-B, with its operational configuration unchanged', () => {
  const text = read('render.yaml');
  const lines = text.split('\n');
  assert.match(lines[0], /^# UNSUPPORTED — DO NOT DEPLOY THE CURRENT APPLICATION WITH THIS FILE\.$/);
  assert.match(text, /incompatible with P1-B surface isolation/);
  assert.match(text, /explicit approval/);
  // The non-comment content is byte-identical to the reviewed legacy configuration.
  const operational = lines.filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.equal(createHash('sha256').update(operational).digest('hex'), 'c67947ca3e506698fc1f2ad0b5f8ae710b40ea9084602349ef28a3d7a08e643f');
  // It provides none of the P1-B settings, which is why it is unsupported.
  assert.doesNotMatch(operational, /ELTNOY_|ADMIN_PORT/);
});

test('.env.example documents both proxy lists and does not assign the removed shared list', () => {
  const names = read('.env.example').split('\n').map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter(Boolean);
  for (const name of [SURFACE_ENV.mode, SURFACE_ENV.publicProxyCidrs, SURFACE_ENV.adminProxyCidrs, SURFACE_ENV.adminPort]) {
    assert.ok(names.includes(name), `${name} documented`);
  }
  assert.ok(!names.includes(SURFACE_ENV.legacyTrustedProxyCidrs), 'removed variable is not assigned');
  const text = read('.env.example');
  assert.match(text, /no longer supported and is rejected if set/);
  assert.match(text, /two DISTINCT loopback addresses/);
  assert.doesNotMatch(text, /gateways \(\.1\)/, 'no suffix-based address rule is documented');
});

test('README and the operator runbook describe the current proxy model and Render status', { skip: runbookPresent ? false : `${RUNBOOK} not present` }, () => {
  for (const path of ['README.md', RUNBOOK]) {
    const text = read(path);
    for (const name of [SURFACE_ENV.publicProxyCidrs, SURFACE_ENV.adminProxyCidrs, SURFACE_ENV.legacyTrustedProxyCidrs]) {
      assert.ok(text.includes(name), `${path} mentions ${name}`);
    }
    assert.match(text, /render\.yaml/);
    assert.match(text, /AWS\/WireGuard/);
  }
});

test('no documentation still describes the obsolete hop-count trust proxy', () => {
  const files = ['README.md', ...(existsSync(new URL('docs/', root))
    ? readdirSync(new URL('docs/', root), { recursive: true }).map(String).filter((path) => path.endsWith('.md')).map((path) => `docs/${path}`)
    : [])];
  for (const path of files) {
    assert.doesNotMatch(read(path), /trust proxy['"]?,\s*NODE_ENV\s*===\s*['"]production['"]\s*\?\s*1/, path);
  }
  assert.doesNotMatch(read('server/index.ts'), /'trust proxy',\s*process\.env\.NODE_ENV/);
});
