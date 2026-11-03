import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDeploymentConfig, type DeploymentConfig } from './deploymentConfig.js';

const verifiedTls: DeploymentConfig = {
  databaseSsl: 'true',
  databaseSslRejectUnauthorized: 'true',
  postgresCaFile: '/certs/ca.crt',
  postgresTlsDir: '/certs/postgres',
  tlsCertDir: '/certs/nginx',
};

test('production rejects development paths for every certificate source', () => {
  const cases: Array<Pick<DeploymentConfig, 'postgresCaFile' | 'postgresTlsDir' | 'tlsCertDir'>> = [
    { postgresCaFile: './.local-dev/certs/ca/ca.crt' },
    { postgresTlsDir: './.local-dev/certs/postgres' },
    { tlsCertDir: './.local-dev/certs/nginx' },
  ];

  for (const certificatePaths of cases) {
    const errors = validateDeploymentConfig({
      ...verifiedTls,
      deploymentMode: 'production',
      ...certificatePaths,
    });

    assert.ok(errors.some((error) => error.includes('.local-dev')));
  }
});

test('production accepts separately supplied verified certificates', () => {
  assert.deepEqual(validateDeploymentConfig({
    ...verifiedTls,
    deploymentMode: 'production',
  }), []);
});

test('development explicitly allows local development certificate paths', () => {
  assert.deepEqual(validateDeploymentConfig({
    ...verifiedTls,
    deploymentMode: 'development',
    postgresCaFile: './.local-dev/certs/ca/ca.crt',
    postgresTlsDir: './.local-dev/certs/postgres',
    tlsCertDir: './.local-dev/certs/nginx',
  }), []);
});

test('missing deployment mode and disabled TLS are rejected', () => {
  const errors = validateDeploymentConfig({
    ...verifiedTls,
    databaseSsl: 'false',
  });

  assert.ok(errors.some((error) => error.includes('DEPLOYMENT_MODE')));
  assert.ok(errors.some((error) => error.includes('DATABASE_SSL')));
});
