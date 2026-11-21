import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import test from 'node:test';

const enabled = process.env.OFFICIAL_AUTH_FOUNDATION_DISPOSABLE === 'YES';
const connectionString = process.env.OFFICIAL_AUTH_FOUNDATION_TEST_DATABASE_URL;
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

const readSql = async (file: string): Promise<string> =>
  readFile(new URL(`./${file}`, import.meta.url), 'utf8');

const files = {
  roles: await readSql('officialAuthFoundationRoles.sql'),
  schema: await readSql('officialAuthFoundationSchemaBootstrap.sql'),
  publicGrants: await readSql('officialAuthFoundationPublicGrants.sql'),
  migration: await readSql('officialAuthFoundationMigration.sql'),
  grants: await readSql('officialAuthFoundationGrants.sql'),
};

test('isolated Official authentication foundation on disposable PostgreSQL 17', { skip: !enabled }, async () => {
  assert.ok(connectionString, 'set OFFICIAL_AUTH_FOUNDATION_TEST_DATABASE_URL only for the disposable test cluster');
  const parsed = new URL(connectionString);
  assert.ok(loopbackHosts.has(parsed.hostname), 'test connection must use a loopback host');
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), 'official_auth_foundation_test');
  assert.equal(parsed.searchParams.has('sslmode') && parsed.searchParams.get('sslmode') !== 'disable', false);

  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("SET official_auth.disposable_test = 'on'");
    await client.query('BEGIN');
    transactionOpen = true;

    const preflight = await client.query<{ version: number; users_table: string | null }>(
      `SELECT current_setting('server_version_num')::integer AS version,
              to_regclass('public.users')::text AS users_table`,
    );
    assert.ok(preflight.rows[0].version >= 170000 && preflight.rows[0].version < 180000, 'server must be PostgreSQL 17');
    assert.equal(preflight.rows[0].users_table, null, 'test database must not contain a pre-existing public.users table');

    await client.query(`
      CREATE TABLE public.users (
        id text PRIMARY KEY,
        login_id text NOT NULL UNIQUE,
        role text NOT NULL CHECK (role IN ('candidate', 'center', 'official')),
        password_hash text NOT NULL,
        account_status text NOT NULL DEFAULT 'approved'
          CHECK (account_status IN ('pending', 'approved', 'rejected'))
      )
    `);
    const syntheticHash = `$2b$12$${'a'.repeat(53)}`;
    await client.query(
      `INSERT INTO public.users (id, login_id, role, password_hash) VALUES
        ('official_foundation_user', 'official_foundation_login', 'official', $1),
        ('official_foundation_target', 'official_foundation_target_login', 'official', $1),
        ('candidate_foundation_user', 'candidate_foundation_login', 'candidate', $1),
        ('center_foundation_user', 'center_foundation_login', 'center', $1)`,
      [syntheticHash],
    );

    await client.query(files.roles);
    await client.query(files.publicGrants);
    await client.query(files.schema);
    await client.query("SET official_auth.apply_foundation = 'on'");
    await client.query('SET LOCAL ROLE official_auth_owner');
    await client.query(files.migration);
    await client.query(files.migration);
    await client.query('RESET ROLE');
    await client.query(files.grants);

    const roleBoundary = await client.query(
      `SELECT
         (SELECT nspowner = 'official_auth_owner'::regrole FROM pg_namespace WHERE nspname = 'official_auth') AS schema_owned,
         NOT EXISTS (
           SELECT 1 FROM pg_class
            WHERE relnamespace = 'official_auth'::regnamespace
              AND relkind IN ('r', 'p', 'v', 'm', 'S')
              AND relowner <> 'official_auth_owner'::regrole
         ) AS relations_owned,
         NOT EXISTS (
           SELECT 1 FROM pg_proc
            WHERE pronamespace = 'official_auth'::regnamespace
              AND proowner <> 'official_auth_owner'::regrole
         ) AS functions_owned,
         NOT EXISTS (
           SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname <> 'official_auth'
              AND c.relowner = 'official_auth_owner'::regrole
         ) AS owner_has_no_outside_relations,
         (SELECT NOT rolsuper AND NOT rolcanlogin AND NOT rolcreatedb AND NOT rolcreaterole
                    AND NOT rolreplication AND NOT rolbypassrls
            FROM pg_roles WHERE rolname = 'official_auth_owner') AS owner_unprivileged,
         EXISTS (
           SELECT 1 FROM pg_auth_members
            WHERE roleid = 'official_auth_owner'::regrole
              AND member = 'official_auth_migrator'::regrole
              AND NOT inherit_option AND set_option
         ) AS migrator_set_role_only,
         NOT pg_has_role('official_verifier', 'official_auth_owner', 'MEMBER')
           AND NOT pg_has_role('official_session_gateway', 'official_auth_owner', 'MEMBER')
           AND NOT pg_has_role('eltnoy_app', 'official_auth_owner', 'MEMBER')
           AND NOT pg_has_role('official_verifier', 'official_auth_migrator', 'MEMBER')
           AND NOT pg_has_role('official_session_gateway', 'official_auth_migrator', 'MEMBER')
           AND NOT pg_has_role('eltnoy_app', 'official_auth_migrator', 'MEMBER') AS runtime_isolated`,
    );
    assert.deepEqual(roleBoundary.rows[0], {
      schema_owned: true,
      relations_owned: true,
      functions_owned: true,
      owner_has_no_outside_relations: true,
      owner_unprivileged: true,
      migrator_set_role_only: true,
      runtime_isolated: true,
    });

    const schemaPrivilegeRows = await client.query<{ role_name: string; privilege: string; granted: boolean }>(
      `SELECT role_name, privilege, has_schema_privilege(role_name, 'official_auth', privilege) AS granted
         FROM unnest(ARRAY[
                'official_auth_owner', 'official_auth_migrator', 'official_verifier',
                'official_session_gateway', 'eltnoy_app'
              ]) AS roles(role_name)
        CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS privileges(privilege)
        ORDER BY role_name, privilege`,
    );
    const schemaPrivileges = new Set(
      schemaPrivilegeRows.rows
        .filter((row) => row.granted)
        .map((row) => `${row.role_name}:${row.privilege}`),
    );
    assert.deepEqual(
      [...schemaPrivileges].sort(),
      [
        'official_auth_owner:CREATE',
        'official_auth_owner:USAGE',
        'official_session_gateway:USAGE',
        'official_verifier:USAGE',
      ],
    );

    const relations = [
      'credentials',
      'credential_events',
      'auth_transactions',
      'assertion_consumptions',
      'mfa_factors',
      'mfa_challenges',
      'enrolment_tickets',
      'recovery_codes',
      'reset_requests',
      'official_sessions',
      'session_mfa_evidence',
      'audit_events',
    ];
    const tablePrivilegeTypes = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const tablePrivilegeRows = await client.query<{
      role_name: string;
      relation_name: string;
      privilege: string;
      granted: boolean;
    }>(
      `SELECT roles.role_name, relations.relname AS relation_name, privileges.privilege,
              has_table_privilege(roles.role_name, relations.oid, privileges.privilege) AS granted
         FROM unnest(ARRAY[
                'official_auth_owner', 'official_auth_migrator', 'official_verifier',
                'official_session_gateway', 'eltnoy_app'
              ]) AS roles(role_name)
         JOIN pg_class AS relations ON relations.relnamespace = 'official_auth'::regnamespace
                                  AND relations.relkind IN ('r', 'p', 'v', 'm')
        CROSS JOIN unnest(ARRAY[
          'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
        ]) AS privileges(privilege)
        ORDER BY roles.role_name, relations.relname, privileges.privilege`,
    );
    const actualTablePrivileges = new Set(
      tablePrivilegeRows.rows
        .filter((row) => row.granted)
        .map((row) => `${row.role_name}:${row.relation_name}:${row.privilege}`),
    );
    const expectedTablePrivileges = new Set<string>();
    for (const relation of relations) {
      for (const privilege of tablePrivilegeTypes) {
        expectedTablePrivileges.add(`official_auth_owner:${relation}:${privilege}`);
      }
    }
    const runtimeTableGrants: Record<string, Record<string, string[]>> = {
      official_verifier: {
        credentials: ['SELECT', 'INSERT'],
        credential_events: ['INSERT'],
        auth_transactions: ['SELECT', 'INSERT'],
        mfa_factors: ['SELECT', 'INSERT'],
        mfa_challenges: ['SELECT', 'INSERT'],
        enrolment_tickets: ['SELECT'],
        recovery_codes: ['SELECT', 'INSERT'],
        audit_events: ['INSERT'],
      },
      official_session_gateway: {
        auth_transactions: ['SELECT'],
        assertion_consumptions: ['SELECT', 'INSERT'],
        official_sessions: ['SELECT', 'INSERT'],
        session_mfa_evidence: ['SELECT', 'INSERT'],
        audit_events: ['INSERT'],
      },
    };
    for (const [role, grants] of Object.entries(runtimeTableGrants)) {
      for (const [relation, privileges] of Object.entries(grants)) {
        for (const privilege of privileges) {
          expectedTablePrivileges.add(`${role}:${relation}:${privilege}`);
        }
      }
    }
    assert.deepEqual([...actualTablePrivileges].sort(), [...expectedTablePrivileges].sort());

    const columnPrivilegeRows = await client.query<{
      role_name: string;
      relation_name: string;
      column_name: string;
      privilege: string;
    }>(
      `SELECT roles.rolname AS role_name, relations.relname AS relation_name,
              attributes.attname AS column_name, expanded.privilege_type AS privilege
         FROM pg_attribute AS attributes
         JOIN pg_class AS relations ON relations.oid = attributes.attrelid
         JOIN pg_namespace AS namespaces ON namespaces.oid = relations.relnamespace
         CROSS JOIN LATERAL aclexplode(attributes.attacl) AS expanded
         JOIN pg_roles AS roles ON roles.oid = expanded.grantee
        WHERE namespaces.nspname = 'official_auth'
          AND attributes.attnum > 0
          AND NOT attributes.attisdropped
          AND roles.rolname IN ('official_auth_migrator', 'official_verifier',
                                'official_session_gateway', 'eltnoy_app')
        ORDER BY role_name, relation_name, column_name, privilege`,
    );
    const actualColumnPrivileges = new Set(
      columnPrivilegeRows.rows.map(
        (row) => `${row.role_name}:${row.relation_name}:${row.column_name}:${row.privilege}`,
      ),
    );
    const expectedColumnPrivileges = new Set([
      ...['password_hash', 'credential_version', 'credential_state', 'updated_at', 'password_changed_at', 'migration_batch_id']
        .map((column) => `official_verifier:credentials:${column}:UPDATE`),
      ...['last_used_step'].map((column) => `official_verifier:mfa_factors:${column}:UPDATE`),
      ...['attempts', 'consumed_at', 'consumed_reason', 'enrolment_ticket_hash']
        .map((column) => `official_verifier:mfa_challenges:${column}:UPDATE`),
      ...['used_at', 'revoked_at'].map((column) => `official_verifier:recovery_codes:${column}:UPDATE`),
      ...['session_token_hash', 'user_id', 'credential_version', 'expires_at', 'revoked_at']
        .map((column) => `official_verifier:official_sessions:${column}:SELECT`),
      ...['state', 'consumed_at'].map((column) => `official_session_gateway:auth_transactions:${column}:UPDATE`),
      ...['revoked_at'].map((column) => `official_session_gateway:official_sessions:${column}:UPDATE`),
      ...['user_id', 'credential_version', 'credential_state']
        .map((column) => `official_session_gateway:credentials:${column}:SELECT`),
      ...['challenge_hash', 'user_id', 'transaction_id', 'purpose', 'session_token_hash', 'expires_at']
        .map((column) => `official_session_gateway:mfa_challenges:${column}:INSERT`),
      ...['factor_id', 'user_id', 'confirmed_at', 'disabled_at']
        .map((column) => `official_session_gateway:mfa_factors:${column}:SELECT`),
    ]);
    assert.deepEqual([...actualColumnPrivileges].sort(), [...expectedColumnPrivileges].sort());

    const functionPrivileges = await client.query<{ role_name: string; function_name: string; granted: boolean }>(
      `SELECT roles.role_name, functions.oid::regprocedure::text AS function_name,
              has_function_privilege(roles.role_name, functions.oid, 'EXECUTE') AS granted
         FROM unnest(ARRAY[
                'official_auth_owner', 'official_auth_migrator', 'official_verifier',
                'official_session_gateway', 'eltnoy_app'
              ]) AS roles(role_name)
         JOIN pg_proc AS functions ON functions.pronamespace = 'official_auth'::regnamespace
        ORDER BY roles.role_name, function_name`,
    );
    assert.ok(functionPrivileges.rows.length > 0);
    for (const row of functionPrivileges.rows) {
      assert.equal(
        row.granted,
        row.role_name === 'official_auth_owner',
        `${row.role_name} EXECUTE ${row.function_name}`,
      );
    }

    const sequenceCount = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM pg_class
        WHERE relnamespace = 'official_auth'::regnamespace AND relkind = 'S'`,
    );
    assert.equal(sequenceCount.rows[0].count, 0);

    let failureProbe = 0;
    const expectSqlError = async (sql: string, expected: string | RegExp): Promise<void> => {
      const savepoint = `expected_failure_${failureProbe++}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      let actual: unknown;
      try {
        await client.query(sql);
      } catch (error) {
        actual = error;
      }
      assert.ok(actual, `expected SQL to fail: ${sql}`);
      if (typeof expected === 'string') {
        assert.equal((actual as { code?: string }).code, expected);
      } else {
        assert.match((actual as Error).message, expected);
      }
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    };

    const preservedUsers = await client.query(
      `SELECT id, role, password_hash FROM public.users
        WHERE id IN ('candidate_foundation_user', 'center_foundation_user', 'official_foundation_user')
        ORDER BY id`,
    );
    assert.deepEqual(preservedUsers.rows, [
      { id: 'candidate_foundation_user', role: 'candidate', password_hash: syntheticHash },
      { id: 'center_foundation_user', role: 'center', password_hash: syntheticHash },
      { id: 'official_foundation_user', role: 'official', password_hash: syntheticHash },
    ]);

    const bcryptHash = `$2b$12$${'b'.repeat(53)}`;
    await client.query(
      `INSERT INTO official_auth.credentials (user_id, password_hash)
       VALUES ('official_foundation_user', $1)`,
      [bcryptHash],
    );
    await client.query(
      `INSERT INTO official_auth.credentials (user_id, password_hash)
       VALUES ('official_foundation_target', $1)`,
      [bcryptHash],
    );
    await expectSqlError(
      `INSERT INTO official_auth.credentials (user_id, password_hash)
       VALUES ('official_foundation_user', '${bcryptHash}')`,
      '23505',
    );
    await expectSqlError(
      `INSERT INTO official_auth.credentials (user_id, password_hash)
       VALUES ('candidate_foundation_user', '${bcryptHash}')`,
      /require an Official user/,
    );

    const transactionId = 'c65e9074-bf0f-42ca-88fb-185b2b29401a';
    await client.query(
      `INSERT INTO official_auth.auth_transactions
        (transaction_id, user_id, purpose, challenge_hash, browser_binding_hash, created_at, expires_at)
       VALUES ($1, 'official_foundation_user', 'official_login', $2, $3, clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
      [transactionId, 'a'.repeat(64), 'b'.repeat(64)],
    );
    const enrolmentTransactionId = 'c65e9074-bf0f-42ca-88fb-185b2b29404a';
    await client.query(
      `INSERT INTO official_auth.auth_transactions
        (transaction_id, user_id, purpose, challenge_hash, browser_binding_hash, created_at, expires_at)
       VALUES ($1, 'official_foundation_user', 'official_enrolment', $2, $3, clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
      [enrolmentTransactionId, 'c'.repeat(64), 'd'.repeat(64)],
    );
    const assertionId = 'c65e9074-bf0f-42ca-88fb-185b2b29405a';
    await client.query(
      `INSERT INTO official_auth.assertion_consumptions
        (assertion_id, transaction_id, user_id, purpose, issued_at, expires_at)
       VALUES ($1, $2, 'official_foundation_user', 'official_login',
               clock_timestamp(), clock_timestamp() + interval '30 seconds')`,
      [assertionId, transactionId],
    );
    await expectSqlError(
      `INSERT INTO official_auth.assertion_consumptions
        (assertion_id, transaction_id, user_id, purpose, issued_at, expires_at)
       VALUES ('c65e9074-bf0f-42ca-88fb-185b2b29406a', '${transactionId}', 'official_foundation_user',
               'official_login', clock_timestamp(), clock_timestamp() + interval '30 seconds')`,
      '23505',
    );
    await expectSqlError(
      `INSERT INTO official_auth.auth_transactions
        (transaction_id, user_id, purpose, challenge_hash, browser_binding_hash, created_at, expires_at)
       VALUES ('c65e9074-bf0f-42ca-88fb-185b2b29402a', 'official_foundation_user', 'invalid',
               '${'a'.repeat(64)}', '${'b'.repeat(64)}', clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
      '23514',
    );
    await expectSqlError(
      `INSERT INTO official_auth.auth_transactions
        (transaction_id, user_id, purpose, challenge_hash, browser_binding_hash, state,
         created_at, expires_at, completed_at)
       VALUES ('c65e9074-bf0f-42ca-88fb-185b2b29407a', 'official_foundation_user',
               'official_login', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'completed',
               clock_timestamp(), clock_timestamp() + interval '1 minute', clock_timestamp())`,
      /must start pending/,
    );
    await expectSqlError(
      `INSERT INTO official_auth.auth_transactions
        (transaction_id, user_id, purpose, challenge_hash, browser_binding_hash, state,
         created_at, expires_at, completed_at, consumed_at)
       VALUES ('c65e9074-bf0f-42ca-88fb-185b2b29408a', 'official_foundation_user',
               'official_login', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'consumed',
               clock_timestamp(), clock_timestamp() + interval '1 minute',
               clock_timestamp(), clock_timestamp())`,
      /must start pending/,
    );

    const sessionHash = 'c'.repeat(64);
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `INSERT INTO official_auth.official_sessions
        (session_token_hash, user_id, credential_version, expires_at)
       VALUES ($1, 'official_foundation_user', 1, clock_timestamp() + interval '1 hour')`,
      [sessionHash],
    );
    await expectSqlError(
      `INSERT INTO official_auth.mfa_challenges
        (challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at)
       VALUES ('${'7'.repeat(64)}', 'official_foundation_user', '${transactionId}',
               'login', NULL, clock_timestamp() + interval '5 minutes')`,
      /may create only step-up/,
    );
    await client.query('RESET ROLE');

    const insertStepUpTransaction = async (id: string): Promise<void> => {
      await client.query(
        `INSERT INTO official_auth.auth_transactions
          (transaction_id, user_id, purpose, challenge_hash, browser_binding_hash, created_at, expires_at)
         VALUES ($1, 'official_foundation_user', 'official_login', $2, $3,
                 clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
        [
           id,
           id.replaceAll('-', '').padEnd(64, 'a'),
           id.replaceAll('-', '').padEnd(64, 'b'),
        ],
      );
    };
    const insertVerifierStepUpChallenge = async (
      challengeHash: string,
      transaction: string,
      userId: string,
      boundSessionHash: string,
    ): Promise<void> => {
      await client.query('SET LOCAL ROLE official_verifier');
      try {
        await client.query(
          `INSERT INTO official_auth.mfa_challenges
            (challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at)
           VALUES ($1, $2, $3, 'step_up', $4, clock_timestamp() + interval '5 minutes')`,
          [challengeHash, userId, transaction, boundSessionHash],
        );
      } finally {
        await client.query('RESET ROLE');
      }
    };
    const expectVerifierStepUpRejected = async (
      sql: string,
      expected: string | RegExp,
    ): Promise<void> => {
      await client.query('SET LOCAL ROLE official_verifier');
      try {
        await expectSqlError(sql, expected);
      } finally {
        await client.query('RESET ROLE');
      }
    };

    const liveStepUpTransaction = 'c65e9074-bf0f-42ca-88fb-185b2b29409a';
    await insertStepUpTransaction(liveStepUpTransaction);
    await insertVerifierStepUpChallenge(
      '8'.repeat(64),
      liveStepUpTransaction,
      'official_foundation_user',
      sessionHash,
    );

    const missingSessionTransaction = 'c65e9074-bf0f-42ca-88fb-185b2b29410a';
    await insertStepUpTransaction(missingSessionTransaction);
    await expectVerifierStepUpRejected(
      `INSERT INTO official_auth.mfa_challenges
        (challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at)
       VALUES ('${'6'.repeat(64)}', 'official_foundation_user', '${missingSessionTransaction}',
               'step_up', '${'e'.repeat(64)}', clock_timestamp() + interval '5 minutes')`,
      /requires a live session/,
    );

    const expiredSessionHash = '3'.repeat(64);
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `INSERT INTO official_auth.official_sessions
        (session_token_hash, user_id, credential_version, expires_at)
       VALUES ($1, 'official_foundation_user', 1, clock_timestamp() + interval '10 milliseconds')`,
      [expiredSessionHash],
    );
    await client.query('RESET ROLE');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.query('SET LOCAL ROLE official_verifier');
    const verifierCannotSeeExpiredSession = await client.query(
      'SELECT session_token_hash FROM official_auth.official_sessions WHERE session_token_hash = $1',
      [expiredSessionHash],
    );
    assert.equal(verifierCannotSeeExpiredSession.rowCount, 0);
    await client.query('RESET ROLE');
    const expiredSessionTransaction = 'c65e9074-bf0f-42ca-88fb-185b2b29411a';
    await insertStepUpTransaction(expiredSessionTransaction);
    await expectVerifierStepUpRejected(
      `INSERT INTO official_auth.mfa_challenges
        (challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at)
       VALUES ('${'4'.repeat(64)}', 'official_foundation_user', '${expiredSessionTransaction}',
               'step_up', '${expiredSessionHash}', clock_timestamp() + interval '5 minutes')`,
      /requires a live session/,
    );

    const revokedSessionHash = '5'.repeat(64);
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `INSERT INTO official_auth.official_sessions
        (session_token_hash, user_id, credential_version, expires_at)
       VALUES ($1, 'official_foundation_user', 1, clock_timestamp() + interval '1 hour')`,
      [revokedSessionHash],
    );
    await client.query(
      `UPDATE official_auth.official_sessions SET revoked_at = clock_timestamp()
        WHERE session_token_hash = $1`,
      [revokedSessionHash],
    );
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_verifier');
    const verifierCannotSeeRevokedSession = await client.query(
      'SELECT session_token_hash FROM official_auth.official_sessions WHERE session_token_hash = $1',
      [revokedSessionHash],
    );
    assert.equal(verifierCannotSeeRevokedSession.rowCount, 0);
    await client.query('RESET ROLE');
    const revokedSessionTransaction = 'c65e9074-bf0f-42ca-88fb-185b2b29412a';
    await insertStepUpTransaction(revokedSessionTransaction);
    await expectVerifierStepUpRejected(
      `INSERT INTO official_auth.mfa_challenges
        (challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at)
       VALUES ('${'5'.repeat(64)}', 'official_foundation_user', '${revokedSessionTransaction}',
               'step_up', '${revokedSessionHash}', clock_timestamp() + interval '5 minutes')`,
      /requires a live session/,
    );

    const crossUserSessionHash = '6'.repeat(64);
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `INSERT INTO official_auth.official_sessions
        (session_token_hash, user_id, credential_version, expires_at)
       VALUES ($1, 'official_foundation_target', 1, clock_timestamp() + interval '1 hour')`,
      [crossUserSessionHash],
    );
    await client.query('RESET ROLE');
    const crossUserStepUpTransaction = 'c65e9074-bf0f-42ca-88fb-185b2b29413a';
    await insertStepUpTransaction(crossUserStepUpTransaction);
    await expectVerifierStepUpRejected(
      `INSERT INTO official_auth.mfa_challenges
        (challenge_hash, user_id, transaction_id, purpose, session_token_hash, expires_at)
       VALUES ('${'7'.repeat(64)}', 'official_foundation_user', '${crossUserStepUpTransaction}',
               'step_up', '${crossUserSessionHash}', clock_timestamp() + interval '5 minutes')`,
      /requires a live session/,
    );

    await client.query('SET LOCAL ROLE official_verifier');
    await expectSqlError(
      `INSERT INTO official_auth.auth_transactions
        (transaction_id, user_id, purpose, challenge_hash, browser_binding_hash, created_at, expires_at)
       VALUES ('c65e9074-bf0f-42ca-88fb-185b2b29403a', 'official_foundation_user', 'official_login',
               '${'a'.repeat(64)}', '${'b'.repeat(64)}', clock_timestamp(), clock_timestamp() - interval '1 minute')`,
      '23514',
    );

    const factorId = 'synthetic_factor_foundation';
    const ticketHash = 'f'.repeat(64);
    await client.query('SET LOCAL ROLE official_auth_owner');
    await client.query(
      `INSERT INTO official_auth.enrolment_tickets
        (ticket_hash, user_id, issued_via, expires_at)
       VALUES ($1, 'official_foundation_user', 'bootstrap_cli', clock_timestamp() + interval '10 minutes')`,
      [ticketHash],
    );
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_verifier');
    await client.query(
      `INSERT INTO official_auth.mfa_challenges
        (challenge_hash, user_id, transaction_id, purpose, enrolment_ticket_hash, created_at, expires_at)
       VALUES ($1, 'official_foundation_user', $2, 'enrol', $3, clock_timestamp(), clock_timestamp() + interval '5 minutes')`,
      ['d'.repeat(64), enrolmentTransactionId, ticketHash],
    );
    await client.query(
      `INSERT INTO official_auth.mfa_factors
        (factor_id, user_id, enrolment_challenge_id, kind, secret_ciphertext, secret_nonce, secret_tag, key_version, aad_version)
       VALUES ($1, 'official_foundation_user', $2, 'totp', $3, $4, $5, 1, 2)`,
      [factorId, 'd'.repeat(64), Buffer.alloc(20, 1), Buffer.alloc(12, 2), Buffer.alloc(16, 3)],
    );
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_auth_owner');
    await client.query(
      `UPDATE official_auth.mfa_factors SET confirmed_at = clock_timestamp() WHERE factor_id = $1`,
      [factorId],
    );
    await client.query('RESET ROLE');
    await client.query(
      `INSERT INTO official_auth.mfa_challenges (challenge_hash, user_id, transaction_id, purpose, created_at, expires_at)
       VALUES ($1, 'official_foundation_user', $2, 'login', clock_timestamp(), clock_timestamp() + interval '5 minutes')`,
      ['9'.repeat(64), transactionId],
    );
    await client.query('SET LOCAL ROLE official_verifier');
    await client.query(
      `UPDATE official_auth.auth_transactions
          SET state = 'completed', completed_at = clock_timestamp()
        WHERE transaction_id = $1`,
      [transactionId],
    );
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `UPDATE official_auth.auth_transactions
          SET state = 'consumed', consumed_at = clock_timestamp()
        WHERE transaction_id = $1`,
      [transactionId],
    );
    await client.query('RESET ROLE');
    await expectSqlError(
      `UPDATE official_auth.auth_transactions
          SET state = 'completed'
        WHERE transaction_id = '${transactionId}'`,
      /state cannot move backwards/,
    );
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `INSERT INTO official_auth.session_mfa_evidence
        (evidence_id, session_token_hash, user_id, factor_id, purpose, method)
       VALUES ('1ba7f795-09c5-4c0a-b262-03f409eb2c08', $1, 'official_foundation_user', $2, 'login', 'totp')`,
      [sessionHash, factorId],
    );
    await client.query('RESET ROLE');

    const resetTicketHash = '5'.repeat(64);
    await client.query('SAVEPOINT reset_ticket_link');
    await client.query('SET CONSTRAINTS official_auth_ticket_reset_request_fkey, official_auth_reset_ticket_fkey DEFERRED');
    await client.query(
      `INSERT INTO official_auth.reset_requests
        (request_id, target_user_id, approval_mode, initiated_by, initiated_evidence_id,
         reason, expires_at, status, decided_by, decided_evidence_id, decided_at, ticket_hash)
       VALUES ('synthetic_reset_request', 'official_foundation_target', 'single_super_admin',
               'official_foundation_user', '1ba7f795-09c5-4c0a-b262-03f409eb2c08',
               'synthetic integration case', clock_timestamp() + interval '10 minutes',
               'executed', 'official_foundation_user', '1ba7f795-09c5-4c0a-b262-03f409eb2c08',
               clock_timestamp(), $1)`,
      [resetTicketHash],
    );
    await client.query(
      `INSERT INTO official_auth.enrolment_tickets
        (ticket_hash, user_id, issued_by, issued_via, reset_request_id, expires_at)
       VALUES ($1, 'official_foundation_target', 'official_foundation_user', 'single_approver_reset',
               'synthetic_reset_request', clock_timestamp() + interval '5 minutes')`,
      [resetTicketHash],
    );
    await client.query('SET CONSTRAINTS official_auth_ticket_reset_request_fkey, official_auth_reset_ticket_fkey IMMEDIATE');
    await client.query('RELEASE SAVEPOINT reset_ticket_link');

    await client.query('SAVEPOINT cross_user_ticket_request_fk');
    await client.query('SET CONSTRAINTS official_auth_ticket_reset_request_fkey, official_auth_reset_ticket_fkey DEFERRED');
    const crossUserTicketHash = '4'.repeat(64);
    await client.query(
      `INSERT INTO official_auth.reset_requests
        (request_id, target_user_id, approval_mode, initiated_by, initiated_evidence_id,
         reason, expires_at, status, decided_by, decided_evidence_id, decided_at, ticket_hash)
       VALUES ('synthetic_cross_user_reset', 'official_foundation_target', 'single_super_admin',
               'official_foundation_user', '1ba7f795-09c5-4c0a-b262-03f409eb2c08',
               'synthetic negative case', clock_timestamp() + interval '10 minutes',
               'executed', 'official_foundation_user', '1ba7f795-09c5-4c0a-b262-03f409eb2c08',
               clock_timestamp(), $1)`,
      [crossUserTicketHash],
    );
    await client.query(
      `INSERT INTO official_auth.enrolment_tickets
        (ticket_hash, user_id, issued_by, issued_via, reset_request_id, expires_at)
       VALUES ($1, 'official_foundation_user', 'official_foundation_target', 'single_approver_reset',
               'synthetic_cross_user_reset', clock_timestamp() + interval '5 minutes')`,
      [crossUserTicketHash],
    );
    await expectSqlError(
      'SET CONSTRAINTS official_auth_ticket_reset_request_fkey IMMEDIATE',
      '23503',
    );
    await client.query('ROLLBACK TO SAVEPOINT cross_user_ticket_request_fk');
    await client.query('RELEASE SAVEPOINT cross_user_ticket_request_fk');

    await client.query('SAVEPOINT cross_user_reset_ticket_fk');
    await client.query('SET CONSTRAINTS official_auth_ticket_reset_request_fkey, official_auth_reset_ticket_fkey DEFERRED');
    const reverseCrossUserTicketHash = '3'.repeat(64);
    await client.query(
      `INSERT INTO official_auth.reset_requests
        (request_id, target_user_id, approval_mode, initiated_by, initiated_evidence_id,
         reason, expires_at, status, decided_by, decided_evidence_id, decided_at, ticket_hash)
       VALUES ('synthetic_reverse_cross_user_reset', 'official_foundation_target', 'single_super_admin',
               'official_foundation_user', '1ba7f795-09c5-4c0a-b262-03f409eb2c08',
               'synthetic reverse negative case', clock_timestamp() + interval '10 minutes',
               'executed', 'official_foundation_user', '1ba7f795-09c5-4c0a-b262-03f409eb2c08',
               clock_timestamp(), $1)`,
      [reverseCrossUserTicketHash],
    );
    await client.query(
      `INSERT INTO official_auth.enrolment_tickets
        (ticket_hash, user_id, issued_by, issued_via, reset_request_id, expires_at)
       VALUES ($1, 'official_foundation_user', 'official_foundation_target', 'single_approver_reset',
               'synthetic_reverse_cross_user_reset', clock_timestamp() + interval '5 minutes')`,
      [reverseCrossUserTicketHash],
    );
    await expectSqlError(
      'SET CONSTRAINTS official_auth_reset_ticket_fkey IMMEDIATE',
      '23503',
    );
    await client.query('ROLLBACK TO SAVEPOINT cross_user_reset_ticket_fk');
    await client.query('RELEASE SAVEPOINT cross_user_reset_ticket_fk');

    await client.query('SAVEPOINT replay_counter');
    await client.query('SET LOCAL ROLE official_verifier');
    await client.query(
      `UPDATE official_auth.mfa_factors SET last_used_step = 5
        WHERE factor_id = $1 AND user_id = 'official_foundation_user'`,
      [factorId],
    );
    await client.query('ROLLBACK TO SAVEPOINT replay_counter');
    await client.query('RELEASE SAVEPOINT replay_counter');
    await client.query('SET LOCAL ROLE official_auth_owner');
    await client.query(`UPDATE official_auth.mfa_factors SET last_used_step = 5 WHERE factor_id = $1`, [factorId]);
    await expectSqlError(
      `UPDATE official_auth.mfa_factors SET last_used_step = 4 WHERE factor_id = '${factorId}'`,
      /replay counter can only increase/,
    );
    await client.query('RESET ROLE');

    const expectDenied = async (role: string, sql: string): Promise<void> => {
      await client.query('SAVEPOINT privilege_probe');
      await client.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(client.query(sql), { code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT privilege_probe');
      await client.query('RELEASE SAVEPOINT privilege_probe');
    };
    const expectAllowed = async (role: string, sql: string): Promise<void> => {
      await client.query('SAVEPOINT privilege_probe');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(sql);
      await client.query('ROLLBACK TO SAVEPOINT privilege_probe');
      await client.query('RELEASE SAVEPOINT privilege_probe');
    };

    await expectAllowed('official_verifier', 'SELECT password_hash FROM official_auth.credentials');
    await expectDenied('official_session_gateway', 'SELECT password_hash FROM official_auth.credentials');
    await expectAllowed(
      'official_verifier',
      'SELECT session_token_hash, user_id, credential_version, expires_at, revoked_at FROM official_auth.official_sessions',
    );
    await expectDenied('official_verifier', 'SELECT created_at FROM official_auth.official_sessions');
    await expectDenied('eltnoy_app', 'SELECT user_id FROM official_auth.credentials');
    await expectDenied('eltnoy_app', 'SELECT secret_ciphertext FROM official_auth.mfa_factors');
    await expectDenied('eltnoy_app', 'SELECT session_token_hash FROM official_auth.official_sessions');
    await expectDenied('official_session_gateway', 'SELECT secret_ciphertext FROM official_auth.mfa_factors');
    await expectAllowed(
      'official_session_gateway',
      'SELECT factor_id, user_id, confirmed_at, disabled_at FROM official_auth.mfa_factors',
    );
    await expectDenied(
      'official_verifier',
      `INSERT INTO official_auth.official_sessions
        (session_token_hash, user_id, credential_version, expires_at)
       VALUES ('${'1'.repeat(64)}', 'official_foundation_user', 1, clock_timestamp() + interval '1 hour')`,
    );
    await expectDenied(
      'official_session_gateway',
      `UPDATE official_auth.official_sessions SET expires_at = clock_timestamp() + interval '2 hours'
        WHERE session_token_hash = '${sessionHash}'`,
    );
    await expectDenied(
      'official_session_gateway',
      `UPDATE official_auth.official_sessions SET credential_version = 2
        WHERE session_token_hash = '${sessionHash}'`,
    );

    await client.query('SET LOCAL ROLE official_auth_owner');
    await expectSqlError(
      `UPDATE official_auth.official_sessions SET expires_at = expires_at + interval '1 minute'
        WHERE session_token_hash = '${sessionHash}'`,
      /identity, credential version, and expiry are immutable/,
    );
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `UPDATE official_auth.official_sessions SET revoked_at = clock_timestamp()
        WHERE session_token_hash = $1`,
      [sessionHash],
    );
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_auth_owner');
    const revokedSession = await client.query(
      'SELECT revoked_at FROM official_auth.official_sessions WHERE session_token_hash = $1',
      [sessionHash],
    );
    assert.equal(revokedSession.rowCount, 1);
    assert.ok(revokedSession.rows[0].revoked_at);
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_session_gateway');
    const restoreRevocation = await client.query(
      `UPDATE official_auth.official_sessions SET revoked_at = NULL
        WHERE session_token_hash = $1`,
      [sessionHash],
    );
    assert.equal(restoreRevocation.rowCount, 0, 'RLS must hide terminal sessions from gateway updates');
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_auth_owner');
    await expectSqlError(
      `UPDATE official_auth.official_sessions SET revoked_at = NULL
        WHERE session_token_hash = '${sessionHash}'`,
      /revocation is terminal/,
    );
    await expectSqlError(
      `UPDATE official_auth.official_sessions SET revoked_at = revoked_at + interval '1 second'
        WHERE session_token_hash = '${sessionHash}'`,
      /revocation is terminal/,
    );
    await client.query('RESET ROLE');

    const staleSessionHash = '2'.repeat(64);
    await client.query('SET LOCAL ROLE official_session_gateway');
    await client.query(
      `INSERT INTO official_auth.official_sessions
        (session_token_hash, user_id, credential_version, expires_at)
       VALUES ($1, 'official_foundation_user', 1, clock_timestamp() + interval '1 hour')`,
      [staleSessionHash],
    );
    const validVersion = await client.query(
      `SELECT s.session_token_hash
         FROM official_auth.official_sessions AS s
         JOIN official_auth.credentials AS c
           ON c.user_id = s.user_id
          AND c.credential_version = s.credential_version
          AND c.credential_state = 'active'
        WHERE s.session_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()`,
      [staleSessionHash],
    );
    assert.equal(validVersion.rowCount, 1);
    await client.query('RESET ROLE');

    await client.query('SET LOCAL ROLE official_verifier');
    const updatedBcryptHash = `$2b$12$${'c'.repeat(53)}`;
    await expectSqlError(
      `UPDATE official_auth.credentials SET password_hash = '${updatedBcryptHash}'
        WHERE user_id = 'official_foundation_user'`,
      /changing the password hash requires a higher credential version/,
    );
    await client.query(
      `UPDATE official_auth.credentials
          SET password_hash = $1, credential_version = 2
        WHERE user_id = 'official_foundation_user'`,
      [updatedBcryptHash],
    );
    await expectSqlError(
      `UPDATE official_auth.credentials SET credential_version = 1
        WHERE user_id = 'official_foundation_user'`,
      /credential version cannot decrease/,
    );
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_session_gateway');
    await expectSqlError(
      `INSERT INTO official_auth.official_sessions
        (session_token_hash, user_id, credential_version, expires_at)
       VALUES ('${'8'.repeat(64)}', 'official_foundation_user', 1, clock_timestamp() + interval '1 hour')`,
      /session credential version must match an active credential/,
    );
    const invalidatedSession = await client.query(
      `SELECT session_token_hash
         FROM official_auth.official_sessions
        WHERE session_token_hash = $1`,
      [staleSessionHash],
    );
    assert.equal(invalidatedSession.rowCount, 0);
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE official_verifier');
    const verifierCannotSeeStaleSession = await client.query(
      `SELECT session_token_hash
         FROM official_auth.official_sessions
        WHERE session_token_hash = $1`,
      [staleSessionHash],
    );
    assert.equal(verifierCannotSeeStaleSession.rowCount, 0);
    await client.query('RESET ROLE');

    await client.query('ROLLBACK');
    transactionOpen = false;
    const rollbackCheck = await client.query(
      `SELECT to_regnamespace('official_auth') AS schema,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'official_auth_owner') AS owner_role,
              to_regclass('public.users')::text AS users_table`,
    );
    assert.equal(rollbackCheck.rows[0].schema, null);
    assert.equal(rollbackCheck.rows[0].owner_role, false);
    assert.equal(rollbackCheck.rows[0].users_table, null);
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    await client.end();
  }
});
