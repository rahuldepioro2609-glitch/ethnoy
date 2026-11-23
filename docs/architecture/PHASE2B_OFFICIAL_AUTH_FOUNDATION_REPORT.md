# ELTNOY Phase 2B — Official Authentication Isolation Foundation

**Status: BLOCKED — PostgreSQL 17 runtime validation has not run.** After explicit user approval and subsequent confirmation that the sandbox policy was updated, PostgreSQL 17.11 initialization succeeded but startup still failed with sandbox `EPERM` on System V shared-memory creation (`shmget`, `Operation not permitted`). The guarded integration suite was not reached. The effective runtime policy still does not permit the required call. Prior guarded-test output is 1 skipped test because no database connection could be made; repository tests have also reported `listen EPERM` when binding `127.0.0.1`. Do not retry these denied operations or route around the sandbox. The sandbox runtime must actually permit PostgreSQL's shared-memory system call (`shmget`) and, for the later loopback-only test connection, binding to `127.0.0.1`/`::1`. Both failed disposable data directories were removed. Static (12/12), focused auth/MFA (118/118), verifier (27/27), TypeScript, and build checks pass, but SQL runtime behavior is unverified and Phase 2B completion criteria are not met.

**Scope:** `official_auth` schema, proposed role definitions, least-privilege manifest, and test coverage. The approved Phase 2A architecture remains authoritative. Nothing here changes or routes production authentication.

## 1. Executive summary

This phase adds an opt-in SQL foundation for a logically isolated Official credential store in the existing PostgreSQL database. The artifacts define the 12 requested tables, identity and purpose checks, hash-only bearer representations, append-only evidence, monotonic MFA replay state, immutable MFA identity/state boundaries, and separate verifier/gateway permissions.

The schema migration is deliberately absent from `server/migrate.ts` and `MIGRATION_FILES`. It additionally requires execution as `official_auth_owner` and the explicit session setting `official_auth.apply_foundation = 'on'`. Role, schema-bootstrap, and grant artifacts are separately restricted to an explicitly marked loopback PostgreSQL 17 test database. No explicit disposable database URL/opt-in was provided. PostgreSQL 17 binaries were present, but a disposable local cluster could not start because the sandbox denied shared-memory creation; no test database connection occurred.

Existing Express Official authentication, MFA enrollment/verification, Candidate and Center authentication, session cookies, frontend screens, schema, current application grants, and production configuration remain unchanged. No real data was accessed or moved.

## 2. Source-verified baseline and compatibility

- `server/schema.sql` keeps `public.users.password_hash text NOT NULL` for all existing roles. This phase does not change it.
- The current Official login and MFA code remains in `server/index.ts`, `server/adminMfa.ts`, `server/adminMfaStore.ts`, and `server/adminMfaCore.ts`. Express continues to read/verify Official hashes and read/decrypt MFA envelopes under the existing flow.
- Existing Candidate and Center login paths remain untouched.
- The checked-in `server/databaseGrantsMigration.sql` grants table-level `SELECT` on `users` to `eltnoy_app`, which includes `password_hash`. The existing MFA grants also include encrypted-factor columns. This is a known source-level exposure; this phase does not alter current grants because doing so could break existing login behavior.
- At the Phase 2B baseline, `server/migrate.ts` had not been changed by that phase; the Phase 2B SQL files remain excluded from its migration list. A later 2026-11-17 change wired only the two reviewed Staff migrations; it did not wire the Phase 2B Official-auth foundation.
- The Phase 1 verifier remains independent and is not connected to this schema. No verifier endpoint, assertion consumer, production session gateway, or new session issuer was added.

The logical schema boundary is not physical database or host isolation. Database superusers and the schema owner can still access the data. A future cutover must separately establish the approved host/network boundary and remove Express access to Official hashes and MFA envelopes.

## 3. Files created or modified

### Created

- `server/officialAuthFoundationMigration.sql` — additive 12-table schema, checks, indexes, state guards, and explicit migration opt-in.
- `server/officialAuthFoundationRoles.sql` — test-only role definitions and non-inheriting migrator membership.
- `server/officialAuthFoundationSchemaBootstrap.sql` — guarded test-only `official_auth` schema creation.
- `server/officialAuthFoundationPublicGrants.sql` — guarded narrow `public.users` projection and FK grants for the isolated roles.
- `server/officialAuthFoundationGrants.sql` — guarded verifier/gateway privilege manifest.
- `server/officialAuthFoundation.test.ts` — static artifact and boundary tests.
- `server/officialAuthFoundation.postgres.integration.test.ts` — opt-in PostgreSQL 17 integration tests using synthetic data and transactional rollback.
- `docs/architecture/PHASE2B_OFFICIAL_AUTH_FOUNDATION_REPORT.md` — this implementation and deferral report.

### Modified

- `package.json` — adds `test:official-auth-foundation` and `test:official-auth-foundation:postgres`; no dependencies changed.

No existing application auth, database schema, grant migration, migration runner, frontend, key, credential, or deployment file was modified.

## 4. Schema objects implemented

The additive migration defines:

1. `official_auth.credentials`
2. `official_auth.credential_events`
3. `official_auth.auth_transactions`
4. `official_auth.assertion_consumptions`
5. `official_auth.mfa_factors`
6. `official_auth.mfa_challenges`
7. `official_auth.enrolment_tickets`
8. `official_auth.recovery_codes`
9. `official_auth.reset_requests`
10. `official_auth.official_sessions`
11. `official_auth.session_mfa_evidence`
12. `official_auth.audit_events`

Key constraints include:

- Credential rows retain bcrypt hashes verbatim in a `password_hash` column, fixed `hash_scheme = 'bcrypt'`, positive credential version, and active/disabled state. A shape check rejects non-bcrypt encodings; plaintext is not represented.
- All user references retain the existing `public.users(id)` identity. Triggers reject non-Official users for Official-auth records, including actor/issuer/decision references where present.
- Challenge, browser-binding, assertion/session, enrollment-ticket, and recovery-code bearer values are represented by SHA-256-sized hashes, not raw token columns.
- MFA rows preserve key and AAD format versions (`aad_version` 1 or 2), factor/user composite ownership, envelope shape, one active factor, enrollment challenge association, terminal disablement, and monotonically increasing `last_used_step`.
- MFA challenge purpose is constrained and cross-checked against its transaction purpose. Step-up challenges require a same-user, unrevoked, unexpired session whose credential version matches the current active credential. `official_verifier` can create step-up challenges after this trigger validation; its session SELECT privilege is limited to `(session_token_hash, user_id, credential_version, expires_at, revoked_at)`. It cannot insert, update, revoke, or delete session rows. `official_session_gateway` remains the only runtime role that can create or mutate Official sessions and may insert only step-up challenges.
- Authentication transactions are forced to start `pending`; a direct `completed`/`consumed` insert is rejected. Identity and lifetime are immutable after creation; state advances pending → completed → consumed. The database enforces `expires_at > created_at` only. It does not choose a maximum transaction lifetime.
- Official session identity, credential version, and expiry are immutable. Revocation is terminal and database-clock stamped. A session can only be inserted for an active credential at the same version. Row-level security restricts verifier/gateway session reads to unrevoked, unexpired sessions whose version matches the current active credential; the gateway additionally gets only the credential metadata projection needed for session validation. A credential-version bump immediately hides older sessions from runtime roles. No session TTL is chosen.
- Credential versions cannot decrease. A password-hash or active/disabled-state change requires an increased version, supporting session invalidation without rewriting existing session rows.
- Reset requests have `UNIQUE (request_id, target_user_id)` and the corresponding ticket has a composite FK `(reset_request_id, user_id)`. The reverse FK is also composite `(ticket_hash, target_user_id)`. Both sides are initially deferred to support their existing bidirectional reset-request/ticket relationship in one transaction. This prevents a ticket issued for one user from being attached to another user's reset request.
- Audit events, credential events, and session-MFA evidence reject update/delete/truncate. MFA evidence timestamps are set from the database clock and require a live same-user session and confirmed active factor.
- No table stores raw passwords, raw session tokens, raw challenges, raw assertions, TOTP plaintext, or raw recovery codes.
- No reset/recovery workflow is enabled. Reset requests have structural relationships/checks only and receive no runtime role grants.

`aad_version` makes legacy versus AAD-v2 interpretation explicit. This phase does not decrypt, relabel, or migrate any ciphertext.

## 5. Roles, ownership, and exact privileges

All role definitions in `officialAuthFoundationRoles.sql` use `NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`. Runtime login credentials are intentionally not provisioned. The role and schema bootstrap scripts require:

- database name `official_auth_foundation_test`;
- loopback TCP server address;
- PostgreSQL 17;
- session setting `official_auth.disposable_test = 'on'`; and
- a superuser session.

The foundation migration itself requires `current_user = 'official_auth_owner'` and `official_auth.apply_foundation = 'on'`.

| Identity | Implemented boundary |
|---|---|
| `official_auth_owner` | Owns only the dedicated schema and its objects. The isolated public-grants artifact separately grants `REFERENCES(public.users.id)` and a narrow `(id, role)` projection needed by Official-identity guards. Owner-only envelope mutation represents a future controlled migration/key-rotation path. |
| `official_auth_migrator` | `NOLOGIN`, `NOINHERIT`; can `SET ROLE official_auth_owner` but does not inherit owner privileges. No runtime membership. |
| `official_verifier` | Reads/inserts credentials and updates only credential hash/version/state/timestamp columns; inserts credential events; creates/reads transactions and completes them; reads/inserts MFA factors and can update only `last_used_step`; reads/inserts/updates challenge attempt/consumption fields; reads enrollment-ticket metadata; reads/inserts/consumes recovery-code rows; inserts audit events. It has column-limited SELECT on session hash, user ID, credential version, expiry, and revocation timestamp solely for trigger-enforced step-up validation. RLS exposes only live sessions at the current active credential version. It cannot create, update, revoke, or delete session rows and has no assertion-consumption, session-evidence, reset-request, or ticket-issuance grants. |
| `official_session_gateway` | Reads/consumes transactions; reads/inserts assertion-consumption records; reads/inserts/revokes Official sessions; reads/inserts session-MFA evidence; reads only MFA factor identity/confirmation/disablement metadata; reads only `(user_id, credential_version, credential_state)` from credentials for session-version validation; may insert only the specified challenge columns, with a trigger enforcing `purpose = 'step_up'`; inserts audit events. No credential hash, MFA ciphertext, or enrollment-ticket/recovery-code/reset-request grants. |
| `eltnoy_app` | No `official_auth` schema usage or object privileges. The isolated test role does not change the existing production/application role. |

`PUBLIC` receives no schema/table/function access. No `SECURITY DEFINER` routine is introduced and no broad schema/table grants are used. Existing privileges on `public.users` are not revoked or rewritten; only the test-only manifest gives the new roles narrow identity/status projections.

The integration test requires one synthetic `public.users` table in a dedicated empty database. It refuses to run if that table already exists, so it cannot load or inspect an existing user table.

## 6. Tests and validation

### Executed (latest correction pass)

- `npm run test:official-auth-foundation` — **12 tests, 12 passed, 0 failed, 0 skipped**.
- `node --import tsx --test server/loginFlow.test.ts server/auth.test.ts server/adminMfa.test.ts server/adminMfaMigration.test.ts server/adminMfaCore.test.ts` — **118 tests, 118 passed, 0 failed, 0 skipped**.
- `npm run test:verifier` — **27 tests, 27 passed, 0 failed, 0 skipped**.
- Historical `npm test` run before loopback permission was granted — **1,119 tests, 1,004 passed, 76 failed, 39 skipped**. All **76/76** failures reported `Error: listen EPERM: operation not permitted 127.0.0.1`; they were sandbox loopback-listener denials, not demonstrated application assertion failures. The current follow-up result is recorded below.
- `npm run lint` (`tsc --noEmit`) — **passed**, exit code 0.
- `npm run build` — **passed**, exit code 0; Vite warned about `__dirname` with the native config loader and the 1,144.85 kB minified JS chunk.
- `npm run test:official-auth-foundation:postgres` — **1 test, 0 passed, 0 failed, 1 skipped**. Disposable-cluster opt-in and test database URL were not configured; this guarded run made no database connection. A separate local PG17 cluster startup attempt failed with sandbox `EPERM` creating shared memory, before accepting connections. This is not SQL runtime validation.
- Latest authorized runtime attempt — **integration suite not invoked; 0 integration tests executed**. The second PostgreSQL startup attempt failed at `shmget` before the server was available. This is a startup-blocked run, not a passing, failing, or skipped result from the integration test runner.

The prior guarded PostgreSQL integration command (run without the disposable opt-in/URL) produced:

```text
> react-example@0.0.0 test:official-auth-foundation:postgres
> node --import tsx --test server/officialAuthFoundation.postgres.integration.test.ts

﹣ isolated Official authentication foundation on disposable PostgreSQL 17 (0.586541ms) # SKIP
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 908.391292
```

This is the complete output of that guarded test invocation, not PostgreSQL runtime evidence: its test body did not execute and it did not connect to a database. Two temporary-cluster attempts failed before the guarded test could be invoked. No successful PostgreSQL server startup, SQL execution, or privilege check is claimed.

### Additional verification (2026-11-17)

After local loopback access was granted for this turn, the current working tree was verified again:

- `npm test` — **1,133 tests, 1,093 passed, 0 failed, 40 skipped**.
- `npm run test:verifier` — **27 passed, 0 failed, 0 skipped**.
- `npm run test:official-auth-foundation` — **12 passed, 0 failed, 0 skipped**.
- `npm run lint` (`tsc --noEmit`) — passed.
- `npm run build` — passed; Vite still reports the existing `__dirname` configuration warning and a 1,145.81 kB minified JavaScript chunk.

The 39 skips are opt-in/integration cases. These results do not include PostgreSQL runtime validation; the guarded PostgreSQL suite was not run in this follow-up. The current source also wires the two Staff migrations before the grants migration; their schema/grant validation is static only.

The guarded PostgreSQL integration test now compares actual effective schema and table privileges for owner, migrator, verifier, gateway, and app roles; compares explicit column ACLs; and checks function EXECUTE privileges and absence of sequences. It also exercises RLS filtering of expired, revoked, and credential-version-stale sessions. These checks are authored but have not run against PostgreSQL.

The existing auth/MFA test run provides regression evidence for current Official auth/session/MFA behavior. The user table schema and Candidate/Center login implementation were not changed. The new PostgreSQL harness includes synthetic Candidate/Center rows and checks they remain unchanged, but that assertion was not executed because PostgreSQL runtime testing was unavailable.

### Not executed / blocked

- PostgreSQL 17 creation, constraints, role-denial, ownership, idempotency, rollback, verifier step-up challenge (positive and missing/expired/revoked/cross-user session negatives), terminal revocation, credential-version invalidation, and both cross-user reset-ticket FK directions.
- After explicit user approval, PostgreSQL 17.11 tools were confirmed at `/opt/homebrew/bin/pg_ctl`, `/opt/homebrew/bin/initdb`, and `/opt/homebrew/bin/createdb`. `initdb` successfully initialized a fresh directory under `$TMPDIR` with local-only synthetic-test authentication. The first `pg_ctl` attempt failed before server startup:

```text
2026-11-16 19:00:08.635 IST [84435] FATAL:  could not create shared memory segment: Operation not permitted
2026-11-16 19:00:08.635 IST [84435] DETAIL:  Failed system call was shmget(key=27408617, size=56, 03600).
child process exited with exit code 1
initdb: removing contents of data directory "/var/folders/nm/tg77w3jx5ln7q4b44llnhl5m0000gn/T/official-auth-pg17.xqLR11"
```

`createdb` and `npm run test:official-auth-foundation:postgres` were not reached; no database connection or SQL test execution occurred. The disposable directory was then removed. This is the current PostgreSQL startup failure, not a passed or skipped SQL runtime test.
- After the user confirmed the sandbox policy had been updated, one guarded retry with a fresh disposable directory failed at the same OS permission boundary:

```text
2026-11-16 19:01:47.545 IST [84756] FATAL:  could not create shared memory segment: Operation not permitted
2026-11-16 19:01:47.545 IST [84756] DETAIL:  Failed system call was shmget(key=27409058, size=56, 03600).
child process exited with exit code 1
initdb: removing contents of data directory "/var/folders/nm/tg77w3jx5ln7q4b44llnhl5m0000gn/T/official-auth-pg17.cyN8HF"
```

The second directory was removed. Neither attempt reached database creation, loopback listening, or the integration test command. No further retry or alternate startup mode was attempted.
- Prior repository-wide tests failed to bind loopback with `listen EPERM: operation not permitted 127.0.0.1`. The user approved local testing, but the sandbox still denied `shmget`. Do not retry either operation or use a workaround until the effective sandbox policy is updated to permit the shared-memory system call and loopback binding in a disposable test environment. No production or existing database access is requested.

The production build emitted `dist/index.html`, `dist/assets/index-DgMQT295.css`, and `dist/assets/index-Bz2PDLFu.js`. These are generated build outputs, not source changes. Git tracking status was not checked because Git operations were not authorized.
- Any production/database operation, SQL migration, role change, database connection, Docker command, or database-backed test.

## 7. Implemented versus deferred

### Implemented in this phase

- Additive schema, role, schema-bootstrap, and permission SQL artifacts.
- Static schema/privilege/migration-runner checks.
- An opt-in integration harness that validates loopback host, dedicated DB name, PostgreSQL 17, and an explicit environment opt-in before opening a database connection. It uses synthetic rows inside one transaction and rolls the entire test setup back.
- Test scripts and documentation.

### Explicitly deferred

- Applying any artifact to an existing or production database.
- Creating or changing roles outside the guarded disposable test artifacts.
- Moving password hashes or changing `public.users.password_hash`.
- MFA ciphertext migration, decryption, re-encryption, key transfer, or AAD relabeling.
- Authentication endpoints, persistent verifier connectivity, assertion consumption/session creation in production, and new session cookies.
- Reset approvals, reset tokens, recovery policy, ticket issuance, or user-facing enrollment/recovery options.
- Changing Official, Candidate, Center, Platform Staff, or Organization Staff login behavior.
- Changing existing database grants, including Express access to `users.password_hash` and encrypted MFA factors.
- Deployment, auth-domain, CORS, CSRF, cookie, host-isolation, backup, or cutover work.
- Phase 2C.

## 8. Deviations and remaining security gaps

- **No PostgreSQL runtime evidence:** the SQL and grant behavior remain unverified against PostgreSQL 17. The deliverables should not be applied until the dedicated integration suite passes in an explicitly disposable PG17 cluster and the SQL is independently reviewed.
- **Legacy Express access remains:** Express still handles Official password verification and MFA cryptography. Existing table-level grants continue to expose Official `password_hash` and encrypted MFA columns to the application role. This is unchanged by design for compatibility.
- **Logical, not physical, isolation:** the same PostgreSQL superuser and host can access both application and Official-auth data.
- **Atomic gateway operations are not implemented:** the schema provides uniqueness and transaction boundaries, but assertion consume + session issuance must later be one transaction with concurrency/replay tests. No unsafe `SECURITY DEFINER` function was added.
- **Session access remains dependent on the database policy:** verifier/gateway queries are RLS-filtered to current live sessions. The table owner and superusers bypass ordinary RLS; they remain trusted administrative principals.
- **Verifier receives narrow session reads for step-up:** avoiding `SECURITY DEFINER` requires the trigger's invoker role to read the columns it compares. The verifier can read the five granted columns only for sessions visible through RLS, including stored session-token hashes, but has no session mutation privilege. The gateway retains session issuance/revocation authority. This exposure is documented and must be considered in independent SQL/runtime review.
- **MFA confirmation/disablement are not granted as direct verifier updates:** future enrollment confirmation and recovery/reset-sensitive factor state changes need an approved atomic authorization path. The current schema owner remains the only role permitted to re-encrypt an existing factor envelope.
- **Existing AAD compatibility remains unresolved:** old ciphertext is not automatically compatible with AAD v2. Each row must retain an explicit verified format version and be re-encrypted only under a separately approved migration.
- **Migration artifact is not automatically wired:** manual execution still requires the explicit owner role and session opt-in, plus the separately provisioned schema and public-user grants.

## 9. Outstanding operator decisions

Before any later integration or production work, obtain explicit decisions on:

1. Maximum authentication transaction lifetime.
2. Official password change/reset policy and migration strategy.
3. MFA recovery approvers, emergency/break-glass procedure, and which legacy recovery/reset states remain valid.
4. AAD v1/v2 row mapping and ciphertext migration/re-encryption procedure.
5. Verifier encryption/signing key custody, rotation, backup, and compromise response.
6. Database owner, migration runner, role login provisioning, authentication method, and `public.users` projection grants.
7. Official session lifetime and revocation semantics.
8. Backup/restore, disaster recovery, and credential/MFA data integrity checks.
9. Verifier/gateway host isolation, network controls, operational cost, and deployment ownership.
10. The exact point at which Express access to Official hashes and MFA data is removed without interrupting Candidate/Center authentication.
11. Whether and how future atomic database operations are implemented and independently reviewed.

## 10. Recommended next sequence

1. Independently review the SQL artifacts.
2. Obtain access to a dedicated disposable PostgreSQL 17 loopback test instance; run the opt-in integration suite and preserve the exact output.
3. Correct any runtime SQL/permission issues and repeat static plus regression tests.
4. Obtain explicit approvals for the open decisions above.
5. Only then plan a separately authorized deployment/migration stage. Do not treat this foundation as a cutover or as permission to begin Phase 2C.

## 11. Safety confirmation

No database connection or Docker command was made. A disposable local PostgreSQL 17 cluster startup attempt was blocked by sandbox `EPERM` before the server accepted connections; no test SQL or migration ran. No existing or production database, password/hash, MFA record, recovery code, encryption key, secret, credential, frontend behavior, production authentication permission, deployment, or infrastructure was accessed or changed. No migration was executed, and no Phase 2C work occurred.

## 12. Security-review correction pass

### Files changed in this correction pass

- `server/officialAuthFoundationMigration.sql`
- `server/officialAuthFoundationGrants.sql`
- `server/officialAuthFoundation.test.ts`
- `server/officialAuthFoundation.postgres.integration.test.ts`
- `docs/architecture/PHASE2B_OFFICIAL_AUTH_FOUNDATION_REPORT.md`

`package.json`, the other three SQL support artifacts, `server/migrate.ts`, and all existing application authentication/frontend files were unchanged in this pass.

### Change rationale

1. **Step-up challenge permission mismatch:** the initial correction kept step-up insertion gateway-only. The follow-up correction below supersedes that approach: the verifier now receives only the session columns required for trigger validation and can create verifier-side step-up challenges; it still cannot mutate sessions.
2. **Terminal sessions:** a trigger now makes session identity/version/expiry immutable, rejects deletion, and makes `revoked_at` one-way. New sessions must match an active credential's current version. The gateway gets only the current credential metadata projection needed for session checks, not password hashes. Tests cover revocation reversal, timestamp substitution, immutable expiry, unauthorized version updates, stale session invalidation, and denial of verifier access to session columns outside its narrow step-up projection.
3. **Reset request/ticket ownership:** composite unique/FK pairs bind a ticket's `user_id` to the request's `target_user_id` in both directions. The mutually referencing constraints are deferrable initially deferred so the linked rows can be created atomically. PostgreSQL coverage includes a valid same-user link and a cross-user negative case.
4. **Transaction lifecycle:** a `BEFORE INSERT` guard assigns the database creation time and requires new authentication transactions to start pending, disallowing direct insertion into completed/consumed states. The integration case attempts a completed insert.
5. **Credential-version integrity:** a credential trigger disallows version decreases and requires version increases for hash or state changes. Session creation and step-up challenge checks compare the stored session version to the active credential version; narrow verifier/gateway read privileges support the same comparison on future session validation. A database cannot enforce arbitrary future read-path logic, so this remains an explicit implementation/acceptance requirement.

No `SECURITY DEFINER` function was introduced. The PostgreSQL cases above are present but were **not executed**: the guarded test reported one skip because explicit disposable-cluster configuration was absent. Do not treat static checks as runtime validation.

## 13. Follow-up correction pass

The latest requested review corrections update the same SQL/test artifacts:

- The verifier trigger is now permitted to create a step-up challenge only after confirming a live, unrevoked, same-user session at the current active credential version. The grants add only SELECT on `session_token_hash`, `user_id`, `credential_version`, `expires_at`, and `revoked_at`; session insert/update/revocation remains gateway-only. Tests include a verifier-created valid challenge, denied access to other session columns, and missing, expired, revoked, and cross-user session negatives.
- The reset-request/ticket FKs remain composite in both directions. Integration cases now force each deferred composite constraint separately with cross-user rows, in addition to the valid same-user relationship.
- The transaction insertion guard is exercised with both direct `completed` and `consumed` inserts.
- Credential tests reject a password-hash change without version advancement, accept a coordinated hash/version increase, reject version rollback, and verify that the old session no longer matches the current credential version.
- Session RLS now filters stale, expired, and revoked sessions for verifier/gateway runtime roles, and the PostgreSQL suite checks catalog privilege matrices for schema/table/column/function boundaries across all five proposed roles.
- Session tests revoke once through the gateway and attempt both clearing and altering the timestamp through the gateway; trigger rejection is required.
- Static checks inspect the relevant function bodies/table constraints/grant columns and verify the corresponding integration cases rather than only checking generic migration strings.

This follow-up did not alter Candidate/Center or Express authentication, production grants, frontend behavior, credentials, MFA data, keys, deployment, or migration-runner wiring. Latest validation totals are recorded above; PostgreSQL runtime behavior remains unvalidated unless its guarded PG17 integration run actually executes.
