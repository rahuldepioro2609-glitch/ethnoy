import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const TEST_DATABASE = 'eltnoy_security_test';
const ADMIN_DATABASE = 'postgres';
const DEVELOPMENT_DATABASE = 'eltnoy_dev';
const DOCKER_DATABASE_HOST = 'postgres';
const DOCKER_CA_FILE = '/run/postgresql-ca/ca.crt';
const INTEGRATION_TEST = fileURLToPath(new URL('./roleLookupPostgres.integration.test.ts', import.meta.url));
const SCHEMA_FILE = fileURLToPath(new URL('./schema.sql', import.meta.url));

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

function assertExpectedDatabase(actual: unknown, expected: string): asserts actual is string {
  if (actual !== expected) {
    throw new Error('Database safety check failed; no further database operation will be attempted.');
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return ` (code ${String(error.code)})`;
  }
  return '';
}

async function main(): Promise<void> {
  const dockerTestMode = process.env.ELTNOY_SECURITY_DOCKER_TEST === '1';
  let adminConnectionString: string;
  let testConnectionStringBase: string;
  let adminSsl: { ca?: Buffer; rejectUnauthorized: boolean } | undefined;
  let childDatabaseSsl = 'false';
  let childDatabaseSslRejectUnauthorized = 'true';
  let childCaFile: string | undefined;

  if (dockerTestMode) {
    const applicationConnectionString = process.env.DATABASE_URL;
    if (!applicationConnectionString) {
      throw new Error('Docker test mode requires the existing DATABASE_URL environment.');
    }

    const applicationUrl = new URL(applicationConnectionString);
    if (
      !['postgres:', 'postgresql:'].includes(applicationUrl.protocol)
      || applicationUrl.hostname !== DOCKER_DATABASE_HOST
      || applicationUrl.port !== '5432'
      || !applicationUrl.username
      || !applicationUrl.password
      || [...applicationUrl.searchParams.keys()].some((key) => key.toLowerCase().startsWith('ssl'))
    ) {
      throw new Error('Docker test mode accepts only the existing postgres service connection.');
    }
    assertExpectedDatabase(decodeURIComponent(applicationUrl.pathname.slice(1)), DEVELOPMENT_DATABASE);
    if (
      process.env.DATABASE_SSL !== 'true'
      || process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'true'
    ) {
      throw new Error('Docker test mode requires PostgreSQL TLS and certificate verification.');
    }

    childCaFile = DOCKER_CA_FILE;
    const ca = await readFile(DOCKER_CA_FILE);
    adminSsl = { ca, rejectUnauthorized: true };
    const applicationTarget = new Client({
      connectionString: applicationConnectionString,
      ssl: adminSsl,
    });
    try {
      await applicationTarget.connect();
      const applicationIdentity = await applicationTarget.query<{ database: string }>(
        'SELECT current_database() AS database',
      );
      assertExpectedDatabase(applicationIdentity.rows[0]?.database, DEVELOPMENT_DATABASE);
    } finally {
      await applicationTarget.end();
    }

    const adminUrl = new URL(applicationUrl);
    adminUrl.pathname = `/${ADMIN_DATABASE}`;
    adminConnectionString = adminUrl.toString();
    const testUrl = new URL(applicationUrl);
    testUrl.pathname = `/${TEST_DATABASE}`;
    testConnectionStringBase = testUrl.toString();
    childDatabaseSsl = 'true';
  } else {
    const localAdminConnectionString = process.env.ELTNOY_SECURITY_ADMIN_URL;
    if (!localAdminConnectionString) {
      throw new Error('Set ELTNOY_SECURITY_ADMIN_URL to a local PostgreSQL maintenance database URL.');
    }

    const adminUrl = new URL(localAdminConnectionString);
    if (
      !['postgres:', 'postgresql:'].includes(adminUrl.protocol)
      || !isLoopbackHost(adminUrl.hostname)
      || !adminUrl.username
    ) {
      throw new Error('The admin URL must target a local PostgreSQL server and include a username.');
    }
    assertExpectedDatabase(decodeURIComponent(adminUrl.pathname.slice(1)), ADMIN_DATABASE);
    adminConnectionString = localAdminConnectionString;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${TEST_DATABASE}`;
    testConnectionStringBase = testUrl.toString();
  }

  const admin = new Client({
    connectionString: adminConnectionString,
    ...(adminSsl ? { ssl: adminSsl } : {}),
  });
  let createdTestDatabase = false;
  let testDatabaseClient: Client | undefined;
  let testExitCode = 1;

  try {
    await admin.connect();
    const adminIdentity = await admin.query<{ database: string }>('SELECT current_database() AS database');
    assertExpectedDatabase(adminIdentity.rows[0]?.database, ADMIN_DATABASE);

    const existing = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [TEST_DATABASE],
    );
    if (existing.rowCount !== 0) {
      throw new Error('The dedicated security test database already exists; refusing to reuse or remove it.');
    }

    const databaseNameToCreate = TEST_DATABASE;
    assertExpectedDatabase(databaseNameToCreate, TEST_DATABASE);
    await admin.query(`CREATE DATABASE "${databaseNameToCreate}"`);
    createdTestDatabase = true;

    testDatabaseClient = new Client({
      connectionString: testConnectionStringBase,
      ...(adminSsl ? { ssl: adminSsl } : {}),
    });
    await testDatabaseClient.connect();
    const testIdentity = await testDatabaseClient.query<{ database: string }>(
      'SELECT current_database() AS database',
    );
    assertExpectedDatabase(testIdentity.rows[0]?.database, TEST_DATABASE);

    const schema = await readFile(SCHEMA_FILE, 'utf8');
    const schemaTarget = await testDatabaseClient.query<{ database: string }>(
      'SELECT current_database() AS database',
    );
    assertExpectedDatabase(schemaTarget.rows[0]?.database, TEST_DATABASE);
    await testDatabaseClient.query(schema);
    await testDatabaseClient.end();
    testDatabaseClient = undefined;

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', INTEGRATION_TEST],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          DATABASE_URL: testConnectionStringBase,
          DATABASE_SSL: childDatabaseSsl,
          DATABASE_SSL_REJECT_UNAUTHORIZED: childDatabaseSslRejectUnauthorized,
          ...(childCaFile ? { NODE_EXTRA_CA_CERTS: childCaFile } : {}),
          ELTNOY_SECURITY_INTEGRATION: '1',
          ELTNOY_SECURITY_DOCKER_TEST: dockerTestMode ? '1' : '0',
        },
        stdio: 'inherit',
      },
    );
    if (child.error) {
      throw child.error;
    }
    testExitCode = child.status ?? 1;
  } finally {
    try {
      if (testDatabaseClient) {
        await testDatabaseClient.end().catch(() => undefined);
      }

      if (createdTestDatabase) {
        const currentIdentity = await admin.query<{ database: string }>(
          'SELECT current_database() AS database',
        );
        assertExpectedDatabase(currentIdentity.rows[0]?.database, ADMIN_DATABASE);

        const databaseNameToDrop = TEST_DATABASE;
        assertExpectedDatabase(databaseNameToDrop, TEST_DATABASE);
        const stillExists = await admin.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE datname = $1',
          [databaseNameToDrop],
        );
        if (stillExists.rowCount === 1) {
          const confirmedName = stillExists.rows[0]?.datname;
          assertExpectedDatabase(confirmedName, TEST_DATABASE);
          await admin.query(`DROP DATABASE "${confirmedName}"`);
        }
      }
    } finally {
      await admin.end();
    }
  }

  if (testExitCode !== 0) {
    process.exitCode = testExitCode;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(`Security integration runner stopped safely${safeErrorCode(error)}.`);
    process.exitCode = 1;
  });
}
