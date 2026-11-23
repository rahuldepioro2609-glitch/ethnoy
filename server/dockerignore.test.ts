import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Docker applies the LAST matching .dockerignore rule, so the secret exclusions must come after every
// "!" re-include (for example !public/), or a key placed under public/ would re-enter the build context.
const rules = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

const REQUIRED = ['.local-dev/', '**/.local-dev/', '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx'];

test('.dockerignore excludes local development secrets and private key material', () => {
  for (const rule of REQUIRED) assert.ok(rules.includes(rule), `missing ${rule}`);
});

test('no re-include rule comes after the secret exclusions', () => {
  const firstSecretRule = Math.min(...REQUIRED.map((rule) => rules.indexOf(rule)));
  const lastNegation = rules.reduce((last, rule, index) => (rule.startsWith('!') ? index : last), -1);
  assert.ok(lastNegation < firstSecretRule, 'a "!" rule after the secret block could re-include key files');
});

test('.env files stay excluded except the example', () => {
  assert.ok(rules.includes('.env') && rules.includes('.env.*') && rules.includes('!.env.example'));
});
