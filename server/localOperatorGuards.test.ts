import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LocalOperatorGuardError, loopbackDatabaseHost } from './localOperatorGuards.js';

test('loopbackDatabaseHost accepts only loopback hosts', () => {
  assert.equal(loopbackDatabaseHost('postgresql://dev@localhost:5433/eltnoy_local'), 'localhost');
  assert.equal(loopbackDatabaseHost('postgresql://dev@127.0.0.1/eltnoy_local'), '127.0.0.1');
  assert.equal(loopbackDatabaseHost('postgres://dev@[::1]:5433/eltnoy_local'), '::1');
  assert.equal(loopbackDatabaseHost('postgresql://dev@LOCALHOST/eltnoy_local?sslmode=disable'), 'localhost');
  for (const remote of [
    'postgresql://dev@db.example.com/eltnoy',
    'postgresql://dev@10.0.0.5/eltnoy',
    'postgresql://dev@127.0.0.2/eltnoy',
    'postgresql://dev@localhost.example.com/eltnoy',
    'postgresql://dev@[::2]/eltnoy',
    'postgresql://dev@/eltnoy',
  ]) {
    assert.throws(() => loopbackDatabaseHost(remote), LocalOperatorGuardError, remote);
  }
});

test('loopbackDatabaseHost refuses query parameters that override the URL host', () => {
  for (const url of [
    'postgresql://dev@localhost/eltnoy?host=db.example.com',
    'postgresql://dev@localhost/eltnoy?HOST=db.example.com',
    'postgresql://dev@127.0.0.1/eltnoy?hostaddr=203.0.113.9',
    'postgresql://dev@127.0.0.1/eltnoy?sslmode=disable&host=%2Fvar%2Frun%2Fpostgresql',
  ]) {
    assert.throws(() => loopbackDatabaseHost(url), /must not override its host/, url);
  }
});

test('loopbackDatabaseHost refuses missing, malformed and non-PostgreSQL URLs without echoing them', () => {
  assert.throws(() => loopbackDatabaseHost(undefined), /DATABASE_URL is required/);
  assert.throws(() => loopbackDatabaseHost(''), /DATABASE_URL is required/);
  assert.throws(() => loopbackDatabaseHost('not a url with secret-value'), (error: unknown) =>
    error instanceof LocalOperatorGuardError && !error.message.includes('secret-value'));
  assert.throws(() => loopbackDatabaseHost('mysql://dev:secret-value@localhost/eltnoy'), (error: unknown) =>
    error instanceof LocalOperatorGuardError && !error.message.includes('secret-value'));
});

test('both local operator tools check the database target with the shared guard before connecting', async () => {
  for (const file of ['adminMfaLocalBootstrap.ts', 'resetSuperAdminPassword.ts']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /import \{[^}]*\bloopbackDatabaseHost\b[^}]*\} from '\.\/localOperatorGuards\.js'/, file);
    const guard = source.indexOf('loopbackDatabaseHost(process.env.DATABASE_URL)');
    assert.ok(guard > 0, `${file} checks DATABASE_URL`);
    const firstUse = Math.min(...['pool.query(', 'pool.connect('].map((call) => source.indexOf(call)).filter((index) => index >= 0));
    assert.ok(guard < firstUse, `${file} checks the target before using the pool`);
    assert.match(source, /NODE_ENV/, `${file} has an explicit NODE_ENV gate`);
  }
});

test('local operator tools are standalone CLIs that no server module imports', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('./', import.meta.url))).filter((file) => file.endsWith('.ts') && !file.includes('.test.'));
  for (const file of files) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from '\.\/(?:adminMfaLocalBootstrap|resetSuperAdminPassword)\.js'/, `${file} must not import a local operator tool`);
  }
});
