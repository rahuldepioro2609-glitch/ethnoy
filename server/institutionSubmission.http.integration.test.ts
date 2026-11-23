import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildInstitutionIntegrationSchemaUrl,
  INSTITUTION_INTEGRATION_DATABASE,
  validateInstitutionIntegrationDatabaseUrl,
} from './institutionSubmission.integrationTestSafety.js';

const optedIn = process.env.ELTNOY_INSTITUTION_INTEGRATION === '1';

test('institution integration preflight rejects non-dedicated or non-local targets', () => {
  const valid = `postgresql://test:test@127.0.0.1:55439/${INSTITUTION_INTEGRATION_DATABASE}`;
  const target = validateInstitutionIntegrationDatabaseUrl(valid);
  assert.equal(target.pathname, `/${INSTITUTION_INTEGRATION_DATABASE}`);
  assert.equal(
    new URL(buildInstitutionIntegrationSchemaUrl(target, `it_${'a'.repeat(32)}`))
      .searchParams.get('options'),
    `-c search_path=it_${'a'.repeat(32)}`,
  );
  assert.throws(() => buildInstitutionIntegrationSchemaUrl(target, 'public'));

  for (const unsafeUrl of [
    'postgresql://test:test@127.0.0.1:55439/eltnoy',
    'postgresql://test:test@127.0.0.1:55439/eltnoy_dev',
    `postgresql://test:test@127.0.0.1:5432/${INSTITUTION_INTEGRATION_DATABASE}`,
    `postgresql://test:test@db.example.test:55439/${INSTITUTION_INTEGRATION_DATABASE}`,
    `postgresql://test:test@127.0.0.1:55439/${INSTITUTION_INTEGRATION_DATABASE}?host=production`,
  ]) {
    assert.throws(() => validateInstitutionIntegrationDatabaseUrl(unsafeUrl));
  }

  assert.throws(() => validateInstitutionIntegrationDatabaseUrl(undefined));
});

test('institution submission HTTP integration workflow', {
  skip: optedIn ? false : 'Set ELTNOY_INSTITUTION_INTEGRATION=1 to run against the dedicated disposable test database.',
}, async () => {
  const databaseUrl = process.env.ELTNOY_INSTITUTION_TEST_DATABASE_URL;
  validateInstitutionIntegrationDatabaseUrl(databaseUrl);

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const tempWorkingDirectory = await mkdtemp(join(tmpdir(), 'eltnoy-institution-test-'));
  const loaderPath = resolve(projectRoot, 'node_modules/tsx/dist/loader.mjs');
  const workerPath = resolve(projectRoot, 'server/institutionSubmission.http.integration.worker.ts');

  try {
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', loaderPath, workerPath],
        {
          cwd: tempWorkingDirectory,
          env: {
            PATH: process.env.PATH ?? '',
            TMPDIR: tmpdir(),
            NODE_ENV: 'test',
            ELTNOY_INSTITUTION_INTEGRATION: '1',
            ELTNOY_INSTITUTION_TEST_DATABASE_URL: databaseUrl,
          },
          stdio: 'ignore',
        },
      );
      child.once('error', reject);
      child.once('exit', (code) => resolveExit(code ?? 1));
    });

    assert.equal(exitCode, 0, 'The isolated institution submission HTTP worker failed.');
  } finally {
    await rm(tempWorkingDirectory, { recursive: true, force: true });
  }
});
