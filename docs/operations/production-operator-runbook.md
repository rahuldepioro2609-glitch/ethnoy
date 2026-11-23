# ELTNOY production operator runbook: PostgreSQL roles, migrations, backup, monitoring and recovery

**Status:** documentation (OD-P8), updated for the UD-1-B implementation (separate credentials, dedicated container identities; validated in isolated rehearsal `20261104071404-ad7667` only). Nothing in this runbook has been executed against production, Ubuntu staging or a restored copy of production. Internal; do not publish.

**Applies to:** branch `rc/day1-baseline`. These files are committed (no uncommitted changes to them as of 2026-11-14):
- committed in `9e62f7b` (2026-11-13):
  - `server/databaseRoleBootstrap.sql`
  - `server/institutionDocumentsImmutabilityMigration.sql`
  - `server/databaseGrantsMigration.sql`
  - `server/databaseMonitoringSetup.sql`
  - the matching `server/migrate.ts` change;
- UD-1-B (see `docs/architecture/secure-database-credentials.md`):
  - `server/db.ts`, `server/databaseCredentials.ts` and `.gitignore`, committed in `9e62f7b`;
  - `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` and `scripts/test-local-dev-db.sh`, last changed in `9c20baa` (P1-D.2 topology).

Committed is not deployed or approved: the §10 checklist still applies in full.

> **Deploying the UD-1-B `docker-compose.yml` is the role-separation cutover.** The API now logs in as `eltnoy_app` and the `migrate` service as `eltnoy_migrator`, each with a password from its own file secret. Neither role exists until the bootstrap (§2) has run and their passwords are set, so the new Compose file must not be deployed to an existing environment before OD-P1 approval and the §10 checklist. The previous Compose file (API as the superuser) remains the fallback (§9).

If those files change, re-check this runbook.

## 0. How to read this runbook

Every procedure carries one label.

| Label | Meaning |
|---|---|
| **[TESTED-ISOLATED]** | Executed successfully in a disposable, isolated PostgreSQL 17.11 environment with synthetic data (run IDs in §12). **Not** production evidence. |
| **[DERIVED]** | Follows directly from tested behaviour, but this exact sequence was not executed. |
| **[PROPOSED]** | Not executed anywhere. Needs a rehearsal on a restored copy of production, and usually an approval or configuration change, before use. |
| **[STANDARD]** | A standard PostgreSQL or psql feature, not rehearsed in this project. |

Placeholders are written `<LIKE_THIS>`. **Never** type passwords, tokens or `.env` values on a command line, into a script, into chat or into a ticket.

> **Cluster-wide effects.** PostgreSQL roles belong to the whole cluster, not to one database.
> - The bootstrap creates or normalizes `eltnoy_*` roles **cluster-wide**.
> - It revokes `CONNECT` and `TEMPORARY` on the `postgres` maintenance database from `PUBLIC` **cluster-wide**.
> - The monitoring setup creates `eltnoy_monitor` and `eltnoy_monitor_reader` **cluster-wide**.
>
> If the cluster hosts any other database, assess the impact on it first.

---

## 1. Roles and their responsibilities

| Role | Login | Used by | Holds | Must never |
|---|---|---|---|---|
| Bootstrap superuser (the `POSTGRES_USER` from `.env.production`) | yes | Break-glass, bootstrap, restore, monitoring setup | Superuser | Be used by the API or for routine migrations after cutover |
| `eltnoy_owner` | **no** | (owner only) | Owns schema `public` and every application object | Log in |
| `eltnoy_migrator` | yes | `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production migrate` (wrapper, §14.9; container identity `eltnoy-migrate` 10002:10002, secret `eltnoy_migrator_password` only); owner-level operator SQL (Super Admin promotion) | Membership in `eltnoy_owner` with `SET` only, no `INHERIT`; sessions start as `eltnoy_owner` | Be used by the API |
| `eltnoy_app` | yes, connection limit 40 | The API and `server/createUser.ts` (container identity `eltnoy-api` 10001:10001, secret `eltnoy_app_password` only) | `SELECT`, `INSERT` and column-level `UPDATE` exactly per `server/databaseGrantsMigration.sql`; no `DELETE` or `TRUNCATE`; no table-wide `UPDATE` | Own anything, run DDL, update protected columns (for example `users.is_super_admin`) |
| `eltnoy_backup` | yes | `pg_dump` | `pg_read_all_data` (read-only) | Write |
| `eltnoy_audit_writer`, `eltnoy_audit_reader` | no | Reserved for S-1 (audit) | Nothing yet | — |
| `eltnoy_audit_verifier` | yes | Reserved for S-1 | `CONNECT` only | Read business tables |
| `eltnoy_monitor` | yes, connection limit 3 | Monitoring | `CONNECT`, `USAGE` on `eltnoy_monitoring`, `EXECUTE` on its functions; **no role memberships** | Read business tables, see query text, write, signal backends |
| `eltnoy_monitor_reader` | **no** | Definer of the monitoring functions | `pg_read_all_stats` | Log in |

Evidence: [TESTED-ISOLATED]
- Role attributes and memberships: P1A, OD-P2 and OD-P6.
- 86 direct privilege tests: P1A and OD-P2.
- 26 monitor denials: OD-P6.

---

## 2. Database bootstrap (`server/databaseRoleBootstrap.sql`)

### 2.1 Prerequisites
1. Explicit approval for the cutover (OD-P1) and a maintenance window.
2. A **verified backup and restore** (§6) taken immediately before.
3. The full procedure rehearsed on a **restored copy of production** (pre-cutover checklist, §10). **Not done yet.**
4. Secret storage ready for the new login passwords (decision UD-3).
5. The application stopped with only PostgreSQL running: `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production stop`, then `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production start-postgres` (§14.9). Since P1-D.2 the former `app` service is superseded by `api_public` and `api_admin`; `stop` is Compose `down` (never `-v`), so the database and document volumes are preserved. [PROPOSED: wrapper not yet run against Docker]

The maintenance commands in this runbook (`exec postgres psql`, `exec postgres pg_dump`, `cp`, `restart`) have no wrapper operation and call Compose directly, so Compose reads the operator env file itself. Run them only after a passing `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production preflight`, with no `.env` entry at the repository root, with none of the deployment, `COMPOSE_*`, `DOCKER_*`, `NODE_*` (other than `NODE_ENV`) or `TSX_*` variables set in the shell, and always with the full scoping prefix `docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production` so that they target the `eltnoy-production` project (§14.9, *Maintenance commands*). `<repository>` is the absolute path of the checkout.

### 2.2 What it does
The file is idempotent. It never drops anything and never changes data.
- **Refuses to run** unless the session user is a superuser, and refuses the `postgres`, `template0` and `template1` databases.
- **Roles:** creates or normalizes the 7 `eltnoy_*` roles with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Login roles are created **without passwords**.
- **Memberships:** grants `eltnoy_owner` to `eltnoy_migrator` `WITH INHERIT FALSE, SET TRUE, ADMIN FALSE` and sets `ALTER ROLE eltnoy_migrator SET role = 'eltnoy_owner'`. Grants `pg_read_all_data` to `eltnoy_backup`.
- **Database access:** `REVOKE ALL ON DATABASE <current> FROM PUBLIC`; `GRANT CONNECT` to the migrator, app, audit-verifier and backup roles; `REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC` (**cluster-wide**).
- **Ownership:** transfers the `public` schema and every table, sequence, view and routine in it to `eltnoy_owner`, object by object.

### 2.3 Execution
The underlying `psql` invocation is [TESTED-ISOLATED]: it was run with `docker exec -i <container> psql … -f /dev/stdin < file` over the container's local socket in P1A, OD-P2, OD-P3, OD-P4 and OD-P6. The Compose wrapper below is [PROPOSED].

```sh
# Run from the repository checkout on the server. <POSTGRES_USER> and <POSTGRES_DB> are the
# non-secret names from the production env file; do not paste the password anywhere.
docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U <POSTGRES_USER> -d <POSTGRES_DB> -f - < server/databaseRoleBootstrap.sql
```

Expected output: a NOTICE beginning `databaseRoleBootstrap: roles normalized; eltnoy_owner now owns schema public and all its objects.` and ending with the instruction to set passwords and run migrations as `eltnoy_migrator`. Any `ERROR` means nothing was committed for that statement. Stop and investigate; do not continue to migrations.

> The official `postgres` image trusts **local-socket** connections inside the container (`local all all trust`), so this command does not prompt for a password. Anyone who can run `docker exec` on the host is effectively a superuser. Restrict host access accordingly (OD-P5).

### 2.4 Verification (read-only)
All of these queries were used in the isolated runs. [TESTED-ISOLATED]

```sql
-- every application object owned by eltnoy_owner (expect a single row: eltnoy_owner)
SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace = 'public'::regnamespace;
SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public';           -- eltnoy_owner
-- role attributes (expect super/createrole/createdb/bypassrls all false; owner not login)
SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolconnlimit
  FROM pg_roles WHERE rolname LIKE 'eltnoy\_%' ORDER BY 1;
-- migrator membership (expect inherit=false, set=true, admin=false)
SELECT inherit_option, set_option, admin_option FROM pg_auth_members
 WHERE roleid = 'eltnoy_owner'::regrole AND member = 'eltnoy_migrator'::regrole;
```

Rerunning the bootstrap leaves ownership and permissions unchanged. [TESTED-ISOLATED, OD-P2]

### 2.5 Passwords
Set each login role's password **interactively** in a superuser `psql` session. [STANDARD: psql's `\password` sends a SCRAM verifier, never the plain text.]

```sh
docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production exec postgres psql -X -U <POSTGRES_USER> -d <POSTGRES_DB>
```
```
\password eltnoy_migrator
\password eltnoy_app
\password eltnoy_backup
\password eltnoy_monitor        -- only after §5.1
```

Store each password **only** in the approved secret store (UD-3). `\password` itself was not rehearsed.

**With UD-1-B the database password must equal the secret file** that Compose mounts (`eltnoy_app_password`, `eltnoy_migrator_password` in `ELTNOY_SECRETS_DIR`; ownership in `docs/architecture/secure-database-credentials.md` §6). Two ways to keep them equal without displaying the value:
- [STANDARD] copy the file content into `\password` from the approved secret store (the operator handles the plain text);
- [TESTED-ISOLATED, UD-1-B] compute a SCRAM-SHA-256 verifier from the file on the host and pipe `ALTER ROLE <role> PASSWORD '<verifier>'` into the superuser `psql` over stdin. This is what `\password` sends, the plain text never reaches SQL, logs or `pg_stat_activity`. The rehearsal used a scratch helper (`setpw.mjs`); adding such a helper to the repository needs separate approval.

In the earlier OD rehearsals passwords were set with `ALTER ROLE … PASSWORD` and `log_statement = 'none'`, or not at all.

---

## 3. Migrations

### 3.1 Exact order
From `server/migrate.ts`, `MIGRATION_FILES`:

| # | File | Purpose |
|---|---|---|
| 1 | `schema.sql` | Core tables |
| 2 | `institutionDocumentsMigration.sql` | Milestone 1: institution documents |
| 3 | `institutionDocumentSubmissionMigration.sql` | Milestone 2: submission cycles and capabilities |
| 4 | `institutionDocumentsImmutabilityMigration.sql` | OD-P3: `institution_documents` rejects `UPDATE`, `DELETE` and `TRUNCATE` for **every** role |
| 5 | `authVerificationMigration.sql` | AUTH-1: 7 additive tables (`account_contacts`, `verification_challenges`, `auth_session_verifications`, `institute_verifications`, `google_identities`, `oauth_states`, append-only `auth_verification_events`). Needs `users` and `auth_sessions` from file 1 |
| 6 | `studentEmailVerificationMigration.sql` | Adds `student_email_capture` to the allowed verification challenge purposes |
| 7 | `studentRegistrationClaimsMigration.sql` | AUTH C1: `student_registration_claims` (temporary, non-exclusive Student registration claims), nullable `verification_challenges.registration_claim_id` (FK `ON DELETE CASCADE`), `user_id` made nullable, the ownership CHECK `verification_challenges_owner_check`, and indexes. Needs file 5 (§3.8) |
| 8 | `adminMfaMigration.sql` | AUTH C1.8 (MFA Phase 2): the 6 privileged-MFA tables (§3.12). Needs files 1 and 5 |
| 9 | `platformStaffMigration.sql` | SM-1: separate Platform Staff identities, sessions and append-only audit |
| 10 | `organizationStaffMigration.sql` | SM-1: tenant-scoped Organization Staff identities, invitations, roles, sessions and append-only audit |
| 11 | `studentEmailOtpMigration.sql` | `AUTH_MOBILE_VERIFICATION=off` (owner decision, 2026-11-23): allows the `email_otp` Student session method in `auth_session_verifications_method_check`. Constraint only, no data. Needs file 5 |
| 12 | `databaseGrantsMigration.sql` | OD-P2/P4: `eltnoy_app` least-privilege grants for every table above, **always last** |

`npm run db:migrate` runs all twelve on **one connection, in one transaction**, under advisory lock `7342519086`. If any file fails, every change from the run is rolled back. There is no migration ledger; every file is safe to re-run. The Platform Staff and Organization Staff routes use the two Staff migrations in this list; those schemas still require runtime PostgreSQL rehearsal before release.

**Prerequisites for any run:** the role bootstrap (§2) on that database; the run as `eltnoy_migrator` (sessions act as `eltnoy_owner`) through the deployment wrapper; for an existing database, a verified backup and restore first (§6) and the application stopped (§3.4), because creating the AUTH-1 foreign keys briefly blocks writes to `users` and `auth_sessions`.

**A production migration is a separate, controlled operation:** it needs its own approval (OD-P1, UD-10) and the §10 pre-cutover checklist. Wiring a file into `MIGRATION_FILES` does not authorize running it anywhere.

Evidence [TESTED-ISOLATED] (the five pre-AUTH-1 files):
- **Order and single transaction:** one session sent `BEGIN`, the lock, the files in order, then `COMMIT`, in one transaction (OD-P2-W).
- **Idempotency:** OD-P2, OD-P2-W, OD-P3 and OD-P4.
- **Rollback of all files when the grants file fails:** OD-P2-W, where `schema.sql`'s 24 tables were rolled back too.

**`authVerificationMigration.sql` has not been rehearsed on any database yet** [PROPOSED]: its order, idempotency and the 7 grants are checked statically by `server/migrate.test.ts` and `server/databaseGrants.test.ts` only. A disposable-database rehearsal needs separate approval.

**`studentRegistrationClaimsMigration.sql` (AUTH C1) has not been run on any database** [PROPOSED]: its order, re-runnability and grants are checked statically (`server/migrate.test.ts`, `server/databaseGrants.test.ts`). The PostgreSQL tests for it in `server/databaseGrants.postgres.integration.test.ts` are prepared but **not executed**; running them on a disposable cluster needs separate approval. **No production migration is part of AUTH C1.**

### 3.2 Why the grants migration must stay last
- It grants privileges **for the tables the earlier files create**.
- It refuses (fails closed on) any table or sequence missing from its manifest.
- It refuses objects not owned by `eltnoy_owner`.
- It refuses the `institution_documents` lock-only grant unless file 4's triggers exist and are enabled.

`server/databaseGrants.test.ts` and `server/migrate.test.ts` enforce the order.

### 3.3 Behaviour before and after the bootstrap
| State | `db:migrate` run as | Result | Evidence |
|---|---|---|---|
| **Before the cutover: no `eltnoy_*` roles on the cluster** | The superuser (previous Compose; the UD-1-B Compose cannot connect before the bootstrap) | Files 1–10 apply. **File 4 makes `institution_documents` immutable immediately.** File 11 (grants) is a no-op with a NOTICE. | [TESTED-ISOLATED] OD-P2-W, OD-P3 (files 1–4 and the grants file); files 5–10 [PROPOSED] |
| Roles exist, database bootstrapped | `eltnoy_migrator` (sessions act as `eltnoy_owner`) | All twelve apply, including the AUTH-1, Student email and Student registration migrations; grants are set exactly | [TESTED-ISOLATED] P1A (as the migrator login), OD-P2, for the five pre-AUTH-1 files; files 5–10 not yet rehearsed [PROPOSED] |
| Roles exist, **this database not bootstrapped** (for example a new database on the same cluster) | The superuser | **Refused**: "objects not owned by eltnoy_owner", whole run rolled back | [TESTED-ISOLATED] OD-P4 |
| Any state | `eltnoy_app` | Refused ("permission denied for schema public"), rolled back | [TESTED-ISOLATED] P1A, OD-P2-W |

> **Warning about file 4 today:** the next `db:migrate`, even before any cutover, will make institution document rows immutable. No application code updates or deletes them, but any later correction or erasure will need an approved migration that temporarily disables the trigger (UD-11).

### 3.4 Upgrade procedure (existing production database)
| Step | Action | Status |
|---|---|---|
| 1 | Verified backup and restore (§6) | Procedure [TESTED-ISOLATED]; production [PROPOSED] |
| 2 | Stop the application, keep PostgreSQL (`scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production stop`, then `… start-postgres`; §2.1 item 5) | [PROPOSED] |
| 3 | Bootstrap (§2.3), verify (§2.4), set passwords (§2.5) | Bootstrap and verification [TESTED-ISOLATED]; `\password` [STANDARD] |
| 4 | `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production migrate` (Compose `--profile ops run --rm migrate`, **as `eltnoy_migrator`**, UID 10002) | [TESTED-ISOLATED, UD-1-B]; production [PROPOSED] |
| 5 | Verify (§3.6) | Queries [TESTED-ISOLATED] |
| 6 | Deploy the UD-1-B Compose and start the API (`eltnoy_app`, UID 10001) | [TESTED-ISOLATED, UD-1-B]; production [PROPOSED] |
| 7 | Smoke-test every role; check logs for `42501` | [TESTED-ISOLATED] functional suites |

**UD-1 is implemented in the repository (UD-1-B), validated in isolation only.** Before step 4: create the secret files (`docs/architecture/secure-database-credentials.md` §5.2), add `ELTNOY_SECRETS_DIR` to `.env.production` and remove `POSTGRES_PASSWORD` from it. `POSTGRES_PASSWORD_FILE` is read only when a data volume is first initialised, so on an existing cluster put the **current** superuser password in `postgres_superuser_password` (or rotate it with `\password` and update the file).
- The `migrate` service mounts only the migrator secret and runs as 10002 with a read-only root; it never goes through the API service or its identity.
- **Do not** pass a credential on the command line (for example `-e DATABASE_URL=…`): it would land in shell history and the process list.
- Rehearsal on Ubuntu staging and on a restored copy of production is still required (§10).

### 3.5 Fresh installation
1. Start the database.
2. Bootstrap the empty application database (§2.3).
3. Set passwords (§2.5).
4. `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production migrate` (as `eltnoy_migrator`).
5. Verify (§3.6).

Result [TESTED-ISOLATED, OD-P2/P3/P4]: a fresh install's ownership, permissions and triggers are byte-identical to an upgraded database. Steps 1–4 with the UD-1-B Compose: [TESTED-ISOLATED, UD-1-B].

### 3.6 Post-migration verification (read-only) [TESTED-ISOLATED]
```sql
-- no table-wide UPDATE for the API (expect 0)
SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
   AND has_table_privilege('eltnoy_app', c.oid, 'UPDATE');
-- no TRUNCATE for the API (expect 0)
SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
   AND has_table_privilege('eltnoy_app', c.oid, 'TRUNCATE');
-- DELETE only on the AUTH C1 claims table (expect exactly one row: student_registration_claims)
SELECT relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
   AND has_table_privilege('eltnoy_app', c.oid, 'DELETE');
-- protected column (expect false)
SELECT has_column_privilege('eltnoy_app', 'users', 'is_super_admin', 'UPDATE');
-- OD-P3 triggers enabled (expect 3 rows, all enabled)
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'institution_documents'::regclass AND NOT tgisinternal;
-- ownership drift (expect no rows)
SELECT relname, pg_get_userbyid(relowner) FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','S','v','m') AND pg_get_userbyid(relowner) <> 'eltnoy_owner';
```

### 3.7 Adding a table or changing SQL (engineering rule)
- **Add every new table** to the manifest in `server/databaseGrantsMigration.sql`, with `SELECT`/`INSERT` and exact column-level `UPDATE` only. Never `TRUNCATE` or table-wide `UPDATE`. `DELETE` exists on exactly one table, `student_registration_claims` (AUTH C1, approved, §3.8); the grants migration refuses `DELETE` on any other table.
- **Update the table count** in `server/databaseGrants.test.ts`.
- **Sequences:** a new sequence (`serial` or identity column) needs a sequence-manifest entry.
- **New `UPDATE` columns:** any new `UPDATE … SET` column in server code must be granted. `npm test` fails otherwise, and in production the API would get `42501` at runtime.
- **Missing manifest entry:** once roles exist, `db:migrate` **fails closed and rolls back** for any table without one.

### 3.8 AUTH C1: Student registration claims [PROPOSED: unit-tested only; PostgreSQL tests prepared, not executed]
**What changed.** Student registration no longer creates a `users` row. `POST /api/auth/register` stores a temporary claim (normalised `+91` mobile, display name, bcrypt hash at the existing cost 12, `created_at`, `expires_at`, `consumed_at`) and sends the code through the existing OTP lifecycle, with a challenge owned by the claim (`user_id` NULL, `registration_claim_id` set). Claims are **not exclusive**: any number may exist for one mobile, and a claim reserves no login ID. The permanent account (mobile-derived login ID, verified contact, session and session verification) is created **only** when a correct code is verified, in one transaction that:
1. locks the claim, consumes the challenge, and takes a transaction-level advisory lock keyed by the mobile;
2. refuses generically if any Student already has that mobile as a verified contact, or if the derived login ID exists;
3. otherwise inserts everything and **deletes the claim** (AUTH C1.1; its registration-only challenge goes with it through the cascade). Any error rolls the whole completion back, including the deletion.

A permanent refusal (step 2) marks the claim consumed in the same transaction that consumed its only challenge, so it cannot be replayed. A transient database failure is not a refusal: everything rolls back, the claim stays unconsumed, the challenge stays usable, and the same code can be verified again (within the existing attempt limit).

The existing mobile-capture step (a Student ID account adding its first mobile) takes the **same** advisory lock and is refused if the number belongs to a mobile-first Student (approved rule). Capturing a number held by another Student ID account is unchanged (existing, unresolved policy).

The answer to registration is the same `202` for a new, an already registered and an already claimed number. Only the holder of the phone, after verifying the code, learns that no account was created (`409 ACCOUNT_NOT_CREATED`).

> **Warning: do not rotate `AUTH_OTP_HMAC_KEY_FILE` (AUTH C1.1-a).** Until a durable account-origin identifier exists and is approved, the key must not be changed.
> - **What depends on it.** The mobile-capture rule above recognises a mobile-first Student only by recomputing that Student's login ID: `M-` + HMAC(`AUTH_OTP_HMAC_KEY_FILE` key, mobile). The database stores no separate marker of how an account was created.
> - **What rotation breaks.** After a rotation, the recomputed ID for a number no longer matches the login ID of a mobile-first Student created under the old key. The capture rule then no longer recognises that Student.
> - **How the risk arises.** A Student ID account without a mobile could then capture that Student's number. It still needs the code, so it must be the holder of the phone, for example on a shared family phone.
> - **The consequence.** The number becomes tied to two Students, and sign-in by mobile is then refused for both. The mobile-first Student has no Student ID to fall back on, so they lose sign-in entirely until support intervenes.
> - **What still holds.** Registration itself is not affected: it refuses on any verified Student contact, not on the derived ID.
> - **Other effects of rotation.** It also resets per-number SMS history and changes the login IDs derived for new registrations.
> - **Until a durable fix exists.** Treat the key as non-rotatable. If it is ever compromised, close Student registration and capture before acting, and get a separately approved plan for a durable account-origin identifier.

**Grants (manifest).** `student_registration_claims`: `SELECT, INSERT, DELETE` and `UPDATE (consumed_at)`. This is the **only** table on which `eltnoy_app` has `DELETE`.

**Locking (PostgreSQL 17) [DOCUMENTED; harness assertion prepared, not executed].**
- The application's own DELETE statements (completion and cleanup) take a `ROW EXCLUSIVE` table-level lock plus row-level locks on the rows they delete. Completion and cleanup also take `SELECT … FOR UPDATE` row locks (cleanup with `SKIP LOCKED`), which take `ROW SHARE` on the table. None of these is `ACCESS EXCLUSIVE`.
- However, an explicit `LOCK TABLE` in any mode other than `ACCESS SHARE` or `ROW EXCLUSIVE` needs table-level `UPDATE`, `DELETE`, `TRUNCATE` or `MAINTAIN`. So this `DELETE` grant **does** let `eltnoy_app` run `LOCK TABLE student_registration_claims IN ACCESS EXCLUSIVE MODE`.
- Application code never issues `LOCK TABLE`. A misused or compromised application role could block every read and write on this table until the end of its transaction: claim inserts, foreign-key checks for claim-backed challenges, completion and cleanup, that is Student registration.
- No other table is affected: column-level `UPDATE` does not permit these lock modes. `verification_challenges` grants are unchanged; `registration_claim_id` is written only on `INSERT`.

**Settings (AUTH C1 / C1.1-b) — values PENDING OWNER APPROVAL; there are no defaults.**
- If any SMS setting is missing, invalid or inconsistent, **every SMS is refused** (`503 SMS_PROTECTION_NOT_CONFIGURED`). That covers Student sign-in, mobile capture, Student registration, Institute registration and Institute mobile verification, resends included.
- If the claim lifetime is missing, Student registration is refused (`503 REGISTRATION_NOT_CONFIGURED`).
- Every value must be a positive whole number.

| Setting | Meaning | Rule |
|---|---|---|
| `AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS` | Lifetime of a pending claim | At most the 15-minute challenge lifetime (900) |
| `AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS` | Rolling window for the per-number limit on **unverified** SMS | Positive whole number |
| `AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS` | Unverified SMS allowed to one number per window (`429 SMS_DESTINATION_LIMITED` beyond) | Positive whole number |
| `AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS` | Rolling window for the per-number limit on **verified** (sign-in) SMS | Positive whole number |
| `AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS` | Sign-in SMS allowed to one verified number per window (`429 SMS_DESTINATION_LIMITED` beyond) | Positive whole number |
| `AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS` | Rolling window for the **account** allowance: one approved Institute's own recorded mobile | Positive whole number |
| `AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS` | SMS allowed to that Institute's recorded mobile per window, for that Institute only (`429 SMS_DESTINATION_LIMITED` beyond) | Positive whole number |
| `AUTH_SMS_DAILY_MAX_SENDS` | **All** SMS, every purpose and bucket, in any rolling 24 hours: the spend guard (`503 SMS_DAILY_LIMIT_REACHED` beyond) | Positive whole number |
| `AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS` | **Anonymous (unverified-bucket)** SMS in any rolling 24 hours (`503 SMS_DAILY_LIMIT_REACHED` beyond). Verified and account sends never count here, so the rest of the total stays available for sign-in and approved Institutes | Positive whole number, **not above** `AUTH_SMS_DAILY_MAX_SENDS` |

The AUTH C1 settings `AUTH_SMS_DESTINATION_WINDOW_SECONDS` and `AUTH_SMS_DESTINATION_MAX_SENDS` are **no longer read**: they are replaced by the unverified pair, and no old value is reused. **Container forwarding and preflight (C1.3-B) [TESTED-ISOLATED: unit and static tests only; never run against Docker].**
- **Forwarding:** `docker-compose.yml` forwards the nine settings to **`api_public` only**, each as `${NAME:-}` (optional, empty when unset). SMS flows are served only on the Exam and Institution surfaces, which `api_public` listens for.
- **`api_admin` receives none of them.** It therefore logs `smsProtectionConfigured: false` at startup, which is expected.
- **No defaults, no required substitutions.** Values are pending owner approval; `.env.example` lists the names with empty values.
- **Preflight, fail-fast, the same rule in both places:** in the **host** wrapper (`scripts/eltnoy-deploy.sh … preflight`, and before every non-emergency operation), and in the **container** (`server/validateDeploymentConfig.ts`, before `api_public` starts):
  - All eight `AUTH_SMS_*` empty: accepted.
  - All eight valid and consistent: accepted.
  - Partial, invalid or inconsistent: **the deployment stops**, with setting names and statuses only.
  - The claim lifetime is validated **independently**: empty is accepted, a set but invalid value stops the deployment (positive whole number, at most 900).
- **Missing claim lifetime:** accepted by both preflights, but Student registration stays closed at runtime (`503 REGISTRATION_NOT_CONFIGURED`, nothing written or sent). Sign-in and other SMS flows are unaffected by it.
- **Emergency operations** skip this rule (syntax-only validation, unchanged).
- **Dependencies:** the preflight imports only the pure resolver module (`server/smsProtectionConfig.ts` and `server/verificationProviders.ts`, Node built-ins only). It never loads the database, credentials, Express, dotenv or the auth stores.
- **Provider wiring:** `api_public` receives `AUTH_SMS_PROVIDER`, Twilio's account/Messaging Service SIDs and fixed in-container secret-file paths. The host secret files are mounted read-only only into `api_public`; `api_admin` receives neither settings nor mounts. Empty host paths mount `/dev/null`, which cannot pass secret validation, so SMS stays disabled by default.

**Startup validation (C1.3-A) [TESTED-ISOLATED: unit tests only].**
- The API validates these settings **once at startup**, with the same resolver every request uses, and installs the result, so startup and request time can never disagree.
- Changing a value needs an API restart.
- An invalid configuration **does not stop the API**: every SMS simply stays refused.
- Startup logs one structured line in addition to `auth.verification_providers`:

```json
{"event":"auth.sms_protection","smsProtectionConfigured":false,"registrationClaimTtlConfigured":false,
 "smsSettings":{"AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS":"missing", "…":"valid|missing|invalid|inconsistent"},
 "registrationClaimTtlSetting":{"AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS":"missing"},
 "smsProviderAvailable":false,"smsDeliveryEnabled":false}
```

- **Statuses:** `valid`; `missing` (unset or empty); `invalid` (not a positive whole number, or the claim lifetime above 900); `inconsistent` (the unverified daily cap above the shared total).
- **What is never logged:** no value, number, path, provider name, secret, key, phone number or connection string.
- **Two separate flags:** `smsProtectionConfigured` means only that the limits are valid. `smsDeliveryEnabled` is true only when the limits are valid **and** the configured Twilio provider is available (`smsProviderAvailable`).
- **Before opening SMS**, check `smsProtectionConfigured: true` and that every setting is `valid`.
- **Not changed in this phase:** `/api/auth/providers` and `/api/health` do not reflect these settings.
- **`OTP_POLICY`** (code length, lifetime, attempts, resend cooldown, sends per challenge, challenge lifetime) is fixed in code, not configuration, and is not part of this log. Its values are still pending owner approval.

**To activate SMS with Twilio Verify:** set `AUTH_SMS_PROVIDER=twilio-verify`, `TWILIO_VERIFY_SERVICE_SID` (`VA…`), `TWILIO_VERIFY_API_KEY_SID` (`SK…`), and `TWILIO_VERIFY_API_KEY_SECRET_FILE` in the deployment env file. Store only the API key secret in the referenced host file, owned `root:10001`, mode `0440`; retain `AUTH_OTP_HMAC_KEY_FILE` as configured because the application uses it for challenge binding and abuse controls. A Verify service generates and checks the OTP; the application does not store a local hash for provider-managed codes. Registration also requires `AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS`. Run the deployment preflight, start the release, and confirm startup reports `smsProtectionConfigured: true`, all settings `valid`, `smsProviderAvailable: true`, and `smsDeliveryEnabled: true`. For a Twilio trial, only verified recipients can receive a code and Twilio supplies the fixed trial template; keep `AUTH_SMS_DAILY_MAX_SENDS` within the trial allowance and test using a verified phone.

**Legacy Twilio Messaging integration:** `AUTH_SMS_PROVIDER=twilio` uses a Twilio Account SID, Messaging Service SID, and `TWILIO_AUTH_TOKEN_FILE`; it sends locally generated OTP messages and is not the Twilio Verify trial flow.

**Email-only verification while SMS is unavailable (`AUTH_MOBILE_VERIFICATION`, owner decision 2026-11-23):**
- **Values:** `required` (the default when the setting is empty or absent) or `off`. Any other value fails the host and container preflight.
- **Effect of `off`:**
  - Institutes verify only their email; the contact mobile is still recorded, unverified.
  - Students still sign in with mobile + password, but the one-time code goes to their verified email. A Student without one enters an email at sign-in, and it is stored as verified only after the code is confirmed.
  - Registration asks for an email and sends the code there. The mobile-derived login ID is unchanged, but the mobile is not proven while the setting is off.
  - Student sessions are recorded with method `email_otp` (migration `studentEmailOtpMigration.sql`).
  - Google sign-in stays unavailable, because it still ends with an SMS code.
- **Needs:** the email provider, the six `AUTH_EMAIL_*` limits and, for Student registration, `AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS`.
- **Switching back to `required`** once SMS works: email-verified Student sessions stop counting and must sign in again, and Institutes are asked to verify their mobile at their next sign-in.

**Buckets (decided by the server for every send, resends included, from fresh database data; nothing from the client is used).**
- **Verified:** an account's `student_login` to exactly its **current** verified SMS contact (`account_contacts`).
- **Account (AUTH C1.1-b C-1):** an `institute_mobile` send where all of these hold:
  - the account is an Institute (`users.role = 'center'`);
  - it is **approved** (`account_status = 'approved'`);
  - the destination is exactly its recorded `institute_verifications.mobile_destination`.

  Its allowance is keyed to **that Institute and that number together**: `HMAC(key, "sms-account-destination:" + account + number)`, kept separate from the per-number key. Anonymous traffic to the same number, and other Institutes, cannot use it up. A **pending** Institute's registration-time send is **not** account-bucket (the Institute is not yet approved).
- **Unverified (anonymous):** everything else:
  - registration claims;
  - Student mobile capture, including after Google sign-in (unchanged, even for approved legacy Students);
  - Institute registration and any pending Institute;
  - any destination mismatch.

  Every unverified purpose shares one per-number allowance, so switching purpose or route does not evade it.

**Daily accounting.** The shared total (`AUTH_SMS_DAILY_MAX_SENDS`) counts **every** SMS: verified, account and unverified. The anonymous cap (`AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS`) counts **only unverified** sends. So anonymous traffic can never use the share of the total that remains for Student sign-in and approved Institutes, provided the cap is configured below the total.

**Early fail-closed checks (before any account lookup, password check or write).** These make a closed or exhausted SMS service answer the same for every credential:

| Route | What is checked early |
|---|---|
| Student sign-in | Configuration, and advisory: shared total not used up |
| Student registration | Configuration, claim lifetime, and advisory: unverified cap and shared total |
| Institute registration | Configuration, advisory unverified cap and shared total, and (C-2) advisory: the submitted `contactMobile`'s unverified per-number allowance. When used up: `429 SMS_DESTINATION_LIMITED` **before** any account, submission cycle, capability or verification record is written |
| Institute sign-in | Configuration only: a verified Institute needs no SMS, so exhaustion must not lock it out |

The advisory reads take no lock. The serialized reservation in `deliverCode` is always the final enforcement.

**Residual risks after C1.1-b C-1/C-2 (documented, not decided) [PROPOSED].**
- **Password correctness is visible by design.** Both sign-in flows show whether a password is correct: a correct password gets `202` (or a `403` for a pending, rejected or suspended Institute), a wrong one `401`. Exhaustion answers given after a correct password therefore add **no new oracle**.
- **The one marginal effect is *silent* confirmation:** during exhaustion, a correct guess for an Institute whose mobile is still unverified gets `503 SMS_DAILY_LIMIT_REACHED` or `429` instead of `202`, so **no SMS reaches the Institute** as a warning. This is limited by per-IP sign-in limits. With C-1, anonymous flooding of that Institute's recorded mobile no longer causes it, because those sends use the account allowance.
- **Student sign-in is not affected in this way:**
  - A Student that needs mobile capture receives no SMS at sign-in. The first capture SMS is sent from `/auth/verification/destination`, which needs the verification cookie that only a correct password produces.
  - A verified Student's own allowance can be used up only by sign-ins with the correct password.
  - (The earlier statement that Student capture created an exhaustion oracle was **incorrect** and is withdrawn.)
- **Advisory race:** at the exact moment a budget runs out, an advisory check can pass and the serialized reservation then refuse with the same codes after the password check. No budget can ever be exceeded.
- **Still open (UD-12):**
  - Anonymous flooding can still block a person's own Student **registration** or legacy **capture** of their number, and pending Institute registrations, for one window.
  - Refused reservations still use up the account's hourly challenge allowance (C-5, not implemented).
  - The login-ID sign-in path can reveal whether an account exists through timing (C-4, not implemented).

**SMS accounting.**
- **What every SMS records:** an `sms.send_reserved` event in the append-only `auth_verification_events`, before a code is generated or delivered. The event holds the bucket, the purpose, a keyed hash of the number (`HMAC(AUTH_OTP_HMAC_KEY_FILE key, "sms-destination:" + number)`, truncated) and a random reservation ID, which is also the event ID. It never holds the number or the code.
- **Correlation (C1.4-A):** `verification.code_sent` and `verification.delivery_failed` carry `correlationId`. For SMS it **equals** the reservation's `reservationId`, so a reservation joins its outcome.
- **Serialization:** all reservations are serialized by one advisory lock, so parallel requests cannot exceed any limit.
- **Timing:** event times and all windows use `clock_timestamp()` (the actual moment of the reservation, after the lock), not the transaction start.
- **Failed sends count:** a reservation counts even if delivery then fails or times out, or if a concurrent request wins the challenge's compare-and-set. This errs towards fewer messages.
- **Refusals** are recorded as `sms.send_refused` with reason, bucket, purpose and reservation ID only. Reasons: `destination_limit`, `unverified_daily_limit`, `daily_limit`.
- **Older reservations:** C1 reservations, which have no bucket, count as unverified (they were all registration).
- **OTP key:** rotating it resets per-number history, not the daily counts; rotation is prohibited anyway (warning above).
- **Email is not limited:** Institute email codes have no destination or daily limits (open decision, §13).

**Cleanup and retention.**
- **Completed claims are deleted inside the completion transaction** (AUTH C1.1), not by cleanup.
- Each registration first deletes at most 50 claims that are **expired or consumed (refused)** and have **no live challenge** (none unconsumed and unexpired). It skips claims row-locked by a completion in progress (`FOR UPDATE SKIP LOCKED`). Lock order is the same as completion (claim, then its challenges via the cascade), so the two cannot deadlock. It is idempotent and best effort: a failure never blocks registration.
- The claim's registration-only challenges are removed with it through the foreign key (`ON DELETE CASCADE`, executed by PostgreSQL as the table owner; `eltnoy_app` still has no `DELETE` on `verification_challenges`). Account challenges are never touched.
- Cleanup never lowers the SMS counters, which live in the append-only events.
- **Retention (AUTH C1.1):** a completed registration leaves no claim. Its name and password hash remain only in the new `users` row. Refused and expired claims stay only until the next registration triggers cleanup (a consumed claim whose challenge is somehow still live stays until that challenge expires). There is no retention period. Audit events are append-only by design and hold no claim contents.
- To check the backlog read-only: `SELECT count(*) FILTER (WHERE consumed_at IS NULL AND expires_at <= now()) AS expired_pending, count(*) FILTER (WHERE consumed_at IS NOT NULL) AS refused_pending FROM student_registration_claims;`

**Safe deployment prerequisites.**
1. Owner approval of the four values above.
2. An approved SMS provider adapter and `AUTH_OTP_HMAC_KEY_FILE`. Registration is closed without them, as today.
3. The disposable-cluster run of the prepared PostgreSQL tests (separate approval).
4. The full §3.4 procedure with backup and restore. Adding the column, dropping `NOT NULL` and adding the CHECK briefly lock `verification_challenges`, so stop the application.

The release that contains this code must not be deployed without this migration. The new registration code writes `registration_claim_id` and the claims table. Without them, registration answers `503 VERIFICATION_NOT_INSTALLED`, or fails if the table exists but the column does not.

**Rollback considerations.**
- The migration is additive. Rolling back the **application** to the previous release is not safe while registration is open: the old code creates accounts before verification (the defect C1 fixes).
- Close registration first (leave the settings unset, which refuses it).
- Do **not** restore `NOT NULL` on `verification_challenges.user_id` while claim-backed rows exist. Remove all claims first (completed claims are already gone; refused and expired ones go with cleanup), because each remaining claim's challenges keep `registration_claim_id`.
- Schema reversal would be a new, separately approved migration. There is none.

**Not part of AUTH C1:** any production or staging migration, any database connection, provider integration, and changes to the existing OTP policy (`OTP_POLICY`).

### 3.9 Provider adapter contract (AUTH C1.4-A) [TESTED-ISOLATED: local test doubles only]
**Owner-selected integrations:** `server/verificationProviderAdapters.ts` registers Resend for email and Twilio Messaging for SMS. They implement the adapter contract below and use Node's built-in `fetch`; there is no SDK dependency. Compose and the deployment wrapper now forward provider settings and mount host secret files read-only into `api_public` only. Neither channel becomes available without provider selection, required settings, secret files, OTP HMAC key, and the independent channel abuse limits. No live vendor delivery has been exercised yet.

**Interface.** One request object per delivery attempt:
- `sendOtp(request)` / `sendVerificationCode(request)`, where `request = { destination, code, purpose, correlationId, signal }`.
- `signal` is always supplied.
- `deliverCode` is the only caller of either method, and it makes exactly **one** adapter call per attempt.

**Correlation IDs.**
- One `correlationId` identifies exactly one code, one destination and one delivery attempt.
- **SMS:** it is the send reservation's ID. **Email:** a fresh UUID per delivery. Both are fixed before the code is generated.
- Core never retries. A user resend is a new attempt, with a new code and a new ID.
- Adapters pass it to the vendor as the idempotency key where the vendor supports one, and must never reuse it for another code.
- It appears in `verification.code_sent` and `verification.delivery_failed`.

**Failure categories (fixed).** `verification.delivery_failed.details` is exactly `{ channel, correlationId, failure }`:

| `failure` | Set when |
|---|---|
| `timeout` | Core's 10 s deadline fired (signal aborted). There is no separate "aborted" category |
| `throttled`, `rejected_destination`, `authentication`, `provider_unavailable` | Declared by the adapter with `ProviderDeliveryError(category)` |
| `unknown` | Anything else: a plain error, an unknown category, a thrown non-error |

- Raw messages, causes and vendor payloads are **never** stored, logged or returned.
- **Users always get the same generic `503 PROVIDER_DELIVERY_FAILED`**, whatever the category.

**Who guarantees what.**

| Property | Owner |
|---|---|
| Request ends within the fixed 10 s deadline, even if the adapter ignores the signal; the signal is aborted at the deadline | **Core** |
| Every failure or timeout invalidates the challenge, so **a code the vendor delivers late can never verify** | **Core** (tested) |
| A failed or timed-out attempt still counts against the SMS limits; one adapter call per attempt; no core retries | **Core** |
| Late adapter settlement is ignored safely (no unhandled rejection) | **Core** |
| Honour the abort signal; start no new vendor request after abort; no internal retries; never put codes, destinations or credentials in errors | **Adapter** (the local contract kit can detect a retry after abort) |
| Whether an accepted message can still be delivered late or cancelled; whether idempotency keys are honoured | **Vendor**. Not assumed: **no cancellation or idempotency guarantee is claimed without vendor evidence** |

**Restricted adapter configuration.** An adapter is registered with a declaration (`settings`, `secretFiles: { name: { env, minBytes } }`, `create(config)`) and **never receives the environment**.
- Core passes `create` only `{ settings: <declared names → values>, secrets: <logical name → Buffer> }`.
- **Secret files:** declared names must end in `_FILE`. Core reads them with the existing reader (absolute path, at least `minBytes`, trimmed). The adapter gets the contents, **never the path**.
- **Refused declarations:** ordinary settings whose name contains the whole word `KEY`, `SECRET`, `TOKEN` or `PASSWORD` (boundary-aware, so `MONKEY` is fine), plain settings ending in `_FILE`, duplicate names, non-positive `minBytes`, and badly formed names.
- **Fail-closed cases:** a missing setting, or a missing, relative, unreadable or undersized secret file. So does a `create()` that throws.
- Every reason is fixed text. Secret contents, paths and raw factory errors are never logged or exposed.
- Compose bind mounts host secret files read-only at fixed paths under `/run/secrets`; empty host paths map to `/dev/null`, which cannot satisfy provider or OTP-key minimum lengths. The wrapper allowlists only provider setting names and host secret-file paths. It never receives token contents.

### 3.10 Email abuse protection (AUTH C1.4-B-1) [TESTED-ISOLATED: local doubles and an in-memory guard only; PostgreSQL validation pending (C1.4-B-3)]
**Resend adapter.** The implementation sends a plain-text and HTML verification message to the requested address and uses the attempt correlation ID as Resend's `Idempotency-Key`. `RESEND_API_KEY_FILE` is a host-side path to a protected file; Compose mounts it at `/run/secrets/resend_api_key`. `RESEND_FROM_EMAIL` must be a verified sender address. Resend free-tier quotas and availability can change. Email stays disabled until all six email limits, an OTP HMAC key, sender verification, and provider credentials are configured.

**Email egress (resend_egress).** `api_public` sits only on internal networks and has no route to the internet. Compose sets `RESEND_EGRESS_ADDRESS=resend-egress:8443`, so the adapter opens TCP to the `resend_egress` service and negotiates TLS end to end with `api.resend.com` (SNI and certificate check use Resend's name). The proxy (`deploy/nginx/resend-egress.conf`, same `NGINX_IMAGE`) only relays encrypted bytes, forwards only the SNI name `api.resend.com` and refuses every other name; it never sees the API key, recipient or code. It is the only service on the non-internal `email_egress` network. Its log shows connection metadata only (`docker logs eltnoy-production-resend_egress-1`). Without the proxy every send fails with failure category `unknown` (`auth_verification_events`, action `verification.delivery_failed`). Local development leaves `RESEND_EGRESS_ADDRESS` unset and connects directly.

**Student email capture.** An authenticated Student can add or change an email from the dashboard. The address becomes the account's verified email only after the Student confirms the code; the existing verified address remains in place until then. This is optional for Student sign-in, which continues to require the verified mobile OTP.

**Twilio adapter.** The implementation sends the generated OTP through the configured Twilio Messaging Service. `TWILIO_AUTH_TOKEN_FILE` is a host-side path to a protected file; Compose mounts it at `/run/secrets/twilio_auth_token`. Account SID and Messaging Service SID are non-secret settings. Delivery in India also depends on Twilio account eligibility, approved sender/route configuration and applicable DLT requirements. SMS stays disabled until all eight SMS limits plus the Student claim lifetime (for registration), the OTP HMAC key, provider configuration and approved account setup are present.

**Settings — values PENDING OWNER APPROVAL; there are no defaults.** One all-or-nothing group, **independent of the SMS group**:

| Setting | Meaning |
|---|---|
| `AUTH_EMAIL_UNVERIFIED_DESTINATION_WINDOW_SECONDS` | Rolling window for each address in the anonymous bucket |
| `AUTH_EMAIL_UNVERIFIED_DESTINATION_MAX_SENDS` | Sends allowed to one address per window, anonymous bucket |
| `AUTH_EMAIL_ACCOUNT_DESTINATION_WINDOW_SECONDS` | Rolling window for an approved Institute's own recorded address |
| `AUTH_EMAIL_ACCOUNT_DESTINATION_MAX_SENDS` | Sends allowed per window to that Institute and address |
| `AUTH_EMAIL_DAILY_MAX_SENDS` | Every email send, both buckets, in any rolling 24 hours |
| `AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS` | Anonymous email sends in any rolling 24 hours; not above the total |

- **Validation:** every value must be a positive whole number, and the unverified cap must not exceed the total. If **any** is missing, invalid or inconsistent, **every email is refused** (`503 EMAIL_PROTECTION_NOT_CONFIGURED`).
- **Startup:** the API logs `auth.email_protection` with statuses only: `emailProtectionConfigured`, `emailSettings`, `emailProviderAvailable`, and `emailDeliveryEnabled` (true only when a provider **and** valid limits exist).
- **Deployment wiring (C1.4-B-2) [TESTED-ISOLATED: unit, static and subprocess tests; never run against Docker]:**
  - `docker-compose.yml` forwards the six settings to **`api_public` only**, as `${NAME:-}` (optional, empty when unset, no defaults). `api_admin` receives none of them.
  - The host wrapper governs them (safe-character checks) and passes them to Compose only when set.
  - **Both preflights** apply the same all-or-nothing rule (`validateEmailProtectionDeployment`, built on the same pure resolver the API uses), independently of the SMS rule:
    - all six absent or empty is accepted, and email stays closed;
    - all six valid and consistent is accepted;
    - a partial set, an invalid value or an inconsistent value stops the deployment, with setting names and statuses only.
  - Emergency operations skip this rule, like the rest of the semantic preflight.
  - `.env.example` lists the six limits and provider settings with empty values; host secret-file paths are also empty by default.
- **To activate email:** set **all six** limits, `AUTH_EMAIL_PROVIDER=resend`, `RESEND_FROM_EMAIL`, `RESEND_API_KEY_FILE`, and `AUTH_OTP_HMAC_KEY_FILE` in the deployment env file; store the secret files with owner `root:10001`, mode `0440`, and at least 16 bytes for the Resend key and 32 random bytes for the OTP key. Run `scripts/eltnoy-deploy.sh --deployment-env-file /etc/eltnoy/.env.production preflight`, then restart `api_public`. Startup must log `auth.email_protection` with `emailProtectionConfigured: true`, every setting `valid`, and `emailDeliveryEnabled: true`.

**Buckets (decided per send and per resend, from fresh server data).**
- **`account`:** a fresh `findPortalUser` shows an **approved** Institute, the purpose is `institute_email`, and the address is exactly its recorded `institute_verifications.email_destination`. Keyed per Institute and address, so anonymous traffic to the same address can't use it up.
- **`unverified`:** everything else:
  - new registrations;
  - pending Institutes, including the email that follows mobile verification;
  - their resends;
  - any mismatch.
- **A stored address is never treated as verified.** There is no email "verified" bucket.

**Accounting.** It reuses the SMS mechanism with its **own** actions (`email.send_reserved`, `email.send_refused`) and its **own** advisory lock. Every email is reserved before its code exists.
- **Keys:** keyed hashes only, `HMAC(key, "email-destination:"+address)` for the anonymous bucket and an account-bound label for the account bucket. No raw address or code is recorded.
- **Correlation:** the reservation ID is the delivery's `correlationId`, and each resend gets a new one.
- **Failures count:** failed and timed-out sends still count, and the challenge is invalidated, so a late code is useless.
- **No schema change:** no new grants and no migration. Per-address counts use the existing action/time index; a dedicated index is optional (C1.4-B-3).

**Early gates (advisory reads only; the reservation stays authoritative, and the gates never reserve).**
- **Institute registration:** refused **before any write** when the email limits are unset (`503 EMAIL_PROTECTION_NOT_CONFIGURED`), the email budgets are used up (`503 EMAIL_DAILY_LIMIT_REACHED`), or `contactEmail`'s anonymous allowance is used up (`429 EMAIL_DESTINATION_LIMITED`).
- **Institute sign-in:** refused **before any lookup** while the email limits are unset, with one answer for every credential.

**Unchanged.** Email normalisation (trim and lower-case only) and the delivery address are unchanged. Plus-address tags are **not** stripped, which is an open owner decision. SMS behaviour, `OTP_POLICY` and permissions are unchanged.

### 3.11 Disposable PostgreSQL runner for the grants integration tests (AUTH C1.4-B-3.2) [PROPOSED: written and statically checked; never executed]
`scripts/run-disposable-grants-tests.sh --scratch-dir /absolute/approved/scratch` is the **only** supported way to run `server/databaseGrants.postgres.integration.test.ts`.
- It never uses Docker.
- It never reads `.env` or `.env.production`.
- It never connects to any other PostgreSQL server.
- **Running it needs separate, explicit approval each time.**

**What it does.**
1. **Refuses unless the setup is safe:** `--scratch-dir` must be an existing, absolute, real directory owned by you (there is no default), and the PostgreSQL tools and `node` must be on `PATH`.
2. **Records the existing listeners on port 5432:** process IDs and start times. It never signals them.
3. **Creates its workspace and installs cleanup:** it creates `<scratch>/pg-grants-XXXXXXXX`, which must be new and empty, then installs **cleanup on EXIT, INT and TERM**.
4. **Picks the port and credentials:**
   - a random free port in 20000–59999, **never 5432**, checked free with `lsof`;
   - a test-only superuser `it_super` with a random password in a **0600** file, plus a 0600 `pgpass` file for its own `psql` calls;
   - the password is never put in an argument, a URL or an environment variable.
5. **Starts the cluster and proves its identity:**
   - `initdb` with `scram-sha-256` for local and host, `listen_addresses='127.0.0.1'` and `unix_socket_directories=''`, started with `LC_ALL=en_US.UTF-8`;
   - the process must listen on **exactly** `127.0.0.1:<port>` with no Unix socket;
   - the server's reported `port` and `data_directory` must match.
6. **Creates the database:** `CREATE DATABASE eltnoy_grants_test`; the cluster must then hold exactly `eltnoy_grants_test` and `postgres`.
7. **Runs only that test file**, with a **clean environment** (`env -i`):
   - `DOTENV_CONFIG_PATH=/dev/null` and the placeholder `DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:9/placeholder`;
   - `ELTNOY_GRANTS_INTEGRATION=1`, `ELTNOY_GRANTS_TEST_EXPECTED_PORT`, `ELTNOY_GRANTS_TEST_EXPECTED_DATA_DIR`, `ELTNOY_GRANTS_TEST_PASSWORD_FILE`;
   - `ELTNOY_GRANTS_TEST_DATABASE_URL` with **no password** in it;
   - nothing else is inherited, so `ELTNOY_GRANTS_TEST_ALLOWED_HOST` and `DATABASE_PASSWORD_FILE` are absent.
8. **Prints the results** only after checking that the password doesn't appear in them (the check reads the pattern from the file), followed by the server log's deadlock count.

**Harness guards (fail closed before any connection, application import or test).** When enabled, the harness refuses to run unless all of these hold:
- the variables above are exactly as described;
- the URL is `postgres://<user>@127.0.0.1:<expected port>/eltnoy_grants_test`, with no password, no options and never port 5432;
- the password file is absolute, regular, owned by you and mode 0600;
- once connected, the server reports the expected port and data directory.

Errors name variables and rules only. The earlier checks (superuser, the database name, an empty schema) are kept.

**Cleanup guarantees (EXIT, INT, TERM).**
- It stops **only** its own cluster (`pg_ctl -D <its data directory> -m fast`).
- It deletes the directory only if the process has exited, the port is free and the path matches `<scratch>/pg-grants-????????`.
- Otherwise it **preserves** the directory and prints its path, process ID and port (exit status 3).
- It confirms the port-5432 listeners are unchanged (exit 3 if not).
- It never terminates any other process.

**SIGKILL recovery (traps cannot run on SIGKILL).**
1. List `<scratch>/pg-grants-*`.
2. For each, read `data/postmaster.pid`, and confirm that PID's command line contains **that** data directory and that its port isn't 5432.
3. Then run `pg_ctl -D <that>/data -m fast stop`, verify the PID and port are gone, and delete only that directory.

Never stop the Homebrew server or any process whose data directory is not under the scratch directory.

**Coverage added for C1.4-B-3:**
- Email reservations as `eltnoy_app`: per-address limits under concurrency, an account bucket isolated from the anonymous one, independent addresses, the email total and unverified cap with account headroom, email/SMS separation, accounting shape, and no new grants.
- An **end-to-end `deliverCode`** test using the real PostgreSQL stores and a local adapter double, with no provider, no network and no real email. It covers:
  - the reservation is committed before delivery;
  - `correlationId` equals the reservation ID;
  - a failure consumes the reservation, invalidates the challenge and records its category;
  - success records `code_sent`;
  - SMS accounting is unchanged.

**Disclosure.** The earlier approved harness runs (C1.1-e, C1.1-b) set neither `DOTENV_CONFIG_PATH` nor the placeholder. The store import therefore loaded the repository `.env` into the test process and built an **unused** application pool. No query used it. The guards above make that impossible from now on.

### 3.12 AUTH C1.8: privileged MFA schema (MFA Phase 2) [TESTED-ISOLATED for the C1.8 schema (disposable run, 25/25, 2026-11-15); the AUTH C1.8.4 integrity amendment is statically tested only, its PostgreSQL tests prepared, not executed]

**What it is.** `server/adminMfaMigration.sql` adds the storage for mandatory TOTP MFA for all Officials and Super Admins. It follows `docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md` (revision 2) §9, plus the owner decision of 2026-11-15 (D-1):
- a Super Admin target is reset only with **two different Super Admins**;
- an ordinary Official target is reset by **one Super Admin other than the target**.

**No application code uses these tables yet.** Phases 3 to 7 add it. Applying the migration therefore changes no sign-in behaviour.

| Table | Holds | Final states and guards |
|---|---|---|
| `admin_mfa_factors` | AES-256-GCM ciphertext, nonce and tag of the TOTP secret, plus key version (never plaintext); `last_used_step` for the replay guard | One active factor per user and kind; Officials only; `last_used_step` only rises; `confirmed_at` set once; disabled is final |
| `admin_mfa_recovery_codes` | HMAC-SHA256 hex digests only, tied to the owner's factor | Used or revoked once, then final |
| `admin_mfa_challenges` | SHA-256 hex of the challenge token; attempts | Single use; expiring; attempts rise one at a time and not after expiry; a step-up challenge belongs to a live session of the same user (one open per session) |
| `admin_mfa_enrolment_tickets` | SHA-256 hex of the ticket | One open per user; Officials only; not self-issued; used before expiry or revoked, then final |
| `auth_session_mfa_verifications` | Session MFA evidence (login, enrolment, step-up) | **Insert-only**; many rows per session; `verified_at` is always the database clock; requires a live session of the same user and a confirmed, active factor; step-up and enrolment need TOTP (a recovery code counts only for sign-in) |
| `admin_mfa_reset_requests` | Reset workflow: target, approval mode, initiator, decision, evidence references, issued ticket | `pending` → `executed`, `rejected`, `cancelled`, `expired` or `superseded`, then final; one pending per target; no self-target; decisions need TOTP evidence from a live session; two-person: approver ≠ initiator, approver evidence newer than the request, initiator re-checked; single-approver: the initiating Super Admin executes; an executed request names the open ticket its decider issued |

**Every MFA table** refuses `DELETE` and `TRUNCATE` for **every** role, by trigger as well as by grants.

**Audit.**
- There is no new audit table. MFA events go to the existing append-only `auth_verification_events`, with `admin_mfa.*` actions; the approved list is in the migration header.
- Details never contain a secret, code, token, ticket, key or hash.

**Grants (manifest).** `SELECT, INSERT` on all six tables, plus column `UPDATE` only on these state columns. There is no `DELETE` and no table-wide `UPDATE`.

| Table | Column `UPDATE` |
|---|---|
| `admin_mfa_factors` | `last_used_step`, `confirmed_at`, `disabled_at`, `disabled_by`, `disabled_via` |
| `admin_mfa_recovery_codes` | `used_at`, `revoked_at` |
| `admin_mfa_challenges` | `attempts`, `enrolment_ticket_id`, `consumed_at`, `consumed_reason` |
| `admin_mfa_enrolment_tickets` | `used_at`, `revoked_at` |
| `admin_mfa_reset_requests` | `status`, `decided_by`, `decided_verification_id`, `decision_reason`, `ticket_id` (the trigger sets `decided_at`) |
| `auth_session_mfa_verifications` | none (insert-only) |

`server/databaseGrants.test.ts` exempts these columns from its "every granted column is used by server code" rule **only while no server code touches an MFA table**. The exemption fails the build as soon as Phase 3 code does, and must then be removed.

**Limits of the database guards.** They re-check roles, evidence ownership and session liveness at write time. They do **not** enforce the step-up freshness window, attempt limits, throttles or ticket lifetimes, which are owner values (D-2). Those remain application duties in Phases 3 to 7.

**Key rotation (future, separately approved).** The secret columns and `key_version` are not granted to `eltnoy_app`. A rotation script would run as the owner.

**Commit-time integrity (AUTH C1.8.4).** The migration (amended in place; it has never been deployed) adds three deferred constraint triggers. At `COMMIT` they refuse, and so roll back the **whole** transaction, unless:
- every reset ticket commits together with its executed reset request (same target, ticket, decider and mode);
- every executed reset, and every break-glass ticket, leaves the target with no active factor, no unused recovery code, no open challenge, no other open ticket and no unexpired session, with an open replacement ticket and its audit event (`admin_mfa.reset_executed` with `requestId`, or `admin_mfa.break_glass_reset`);
- every reset-labelled or break-glass factor disable belongs to such a reset later in the same transaction.

At ticket `INSERT` the database also checks:
- the issuer is an approved Super Admin with an active factor;
- a reset ticket's request is `pending` and unexpired, for the same target, of the matching mode, and issued by the right person (two-person: never the initiator; single Super Admin: the initiator);
- first-time tickets go only to users who have never enrolled;
- bootstrap tickets pass only under `READ COMMITTED` and a transaction-level advisory lock (`7342519187`), only while no Super Admin has enrolled and no other bootstrap ticket is open.

**Operator consequence:** an MFA reset, or a misconfigured application, can now fail at `COMMIT` with one of these messages. Nothing persists; the operation can be retried.

> **O-1, open: operator identity (SEC-11).** The MFA operator CLI and the API share database credentials, so no trigger can tell which of them issued a bootstrap or break-glass ticket. The database checks the workflow, not the caller, and application-supplied event details (operator identity, host, incident reference) are not proof of identity. **This must be resolved before MFA Phase 7.** Until then, rely on the detection controls (§8, the break-glass banner and review). **O-4 (SEC-12):** factor creation without a ticket is not yet refused by the database; this is a mandatory Phase 4 requirement.

**Disposable validation.**
- **Run so far:** the C1.8 schema tests passed 25/25 in one approved disposable run on 2026-11-15, with 0 deadlocks, verified cleanup and the port-5432 server unchanged.
- **Prepared, NOT executed:** the AUTH C1.8.4 tests, which need a separately approved run. They add:
  - F1 ticket integrity;
  - F2 complete resets in both modes, each missing effect, rollback after every intermediate write, a late session, a revoked replacement ticket, lost-ticket recovery, and retry after success;
  - O-3 factor-disable linkage and break-glass;
  - bootstrap, including two committed concurrent bootstrap attempts and the refusal of `REPEATABLE READ`.

All of these run only through `scripts/run-disposable-grants-tests.sh` (§3.11, unchanged). They cover:
- exact grants, and `DELETE` and `TRUNCATE` refused;
- factor uniqueness, envelope shape, the atomic replay guard and terminal disable;
- recovery-code and ticket single use, and expiry;
- step-up challenge binding;
- insert-only, clock-stamped evidence;
- every reset rule (both modes, rejection, cancellation, expiry, revoked deciders, demoted initiators, finished-state immutability);
- **concurrency** as `eltnoy_app`: replayed TOTP step, double recovery-code use, two open step-up challenges, duplicate initiation and duplicate approval each succeed exactly once.

The concurrency and bootstrap tests commit synthetic rows. They remove them, including their audit events, as the superuser with `session_replication_role = replica` (for that transaction only), because MFA rows and audit events otherwise refuse `DELETE`. They then assert that none persist.

**Production.** No production migration is part of AUTH C1.8 or C1.8.4.

---

## 4. Credential management

| Credential | Custodian | Stored in | Rotation |
|---|---|---|---|
| Bootstrap superuser | Break-glass custodians (UD-2) | Sealed; approved secret store | After every break-glass use (§8) and on a schedule (UD-3) |
| `eltnoy_migrator` | Release operator | Secret store and `ELTNOY_SECRETS_DIR/eltnoy_migrator_password` (`root:10002 0440`) | Per release window or schedule |
| `eltnoy_app` | Platform operator | Secret store and `ELTNOY_SECRETS_DIR/eltnoy_app_password` (`root:10001 0440`) | §4.1 |
| `eltnoy_backup` | Backup operator | Secret store | Schedule |
| `eltnoy_monitor` | Monitoring operator | Secret store | Schedule |

Rules:
- **`AUTH_OTP_HMAC_KEY_FILE` (the API's OTP key) must not be rotated** until a durable account-origin identifier is approved and implemented. See the §3.8 warning.
- Set passwords only with `\password` or a SCRAM verifier (§2.5); keep each database password equal to its secret file.
- Never put a password in a script, a SQL file, `docker compose` arguments, logs, Git, chat or tickets.
- `.env*` files stay out of Git (the repository's `.gitignore` already excludes `.env*`).
- The repository SQL files contain no passwords; the static tests enforce this.

### 4.1 Rotating `eltnoy_app` without restarting the API [TESTED-ISOLATED, UD-1-B; Ubuntu staging PROPOSED]
1. Generate the new value into a new file next to the secret, without echoing it.
2. Set it in PostgreSQL (§2.5). Existing pooled API connections keep working; **new** connections with the old file content fail (`28P01`, health 500).
3. **Immediately rewrite the mounted file in place** (same inode, owner `root:10001`, mode `0440` unchanged), for example `sh -c 'cat <new> > <ELTNOY_SECRETS_DIR>/eltnoy_app_password'`. The API reads the file for every new connection and recovers without a restart.
4. **Never replace the file by rename** (`mv`, `sed -i`, editors, `install`, Ansible `copy`/`template`): a single-file bind mount keeps the old inode, so the running container keeps reading the old password until it is restarted (observed on native Linux semantics in UD-1-A and UD-1-B). If that happens, restart both API containers: `docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production restart api_public api_admin` (maintenance command, §2.1). The former `docker compose restart app` is superseded: there is no `app` service since P1-D.2.
5. Verify health and that `pg_stat_activity` shows only `eltnoy_app` from the API.

Migrator rotation: the same steps; no restart concern (one-off container).

---

## 5. Monitoring (`server/databaseMonitoringSetup.sql`)

### 5.1 Setup [TESTED-ISOLATED, OD-P6]
Run once, **after the bootstrap**, as the bootstrap superuser, connected to the application database. It is idempotent.

```sh
docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U <POSTGRES_USER> -d <POSTGRES_DB> -f - < server/databaseMonitoringSetup.sql
```

Then run `\password eltnoy_monitor` (§2.5). The Compose wrapper is [PROPOSED]; the `psql` invocation is [TESTED-ISOLATED].

It creates:
- `eltnoy_monitor`: login, connection limit 3, **no role memberships**;
- `eltnoy_monitor_reader`: no login, holds `pg_read_all_stats`;
- schema `eltnoy_monitoring`, with five functions owned by the no-login role.

Re-running the bootstrap afterwards keeps the monitor's `CONNECT`. [TESTED-ISOLATED]

### 5.2 Functions and queries (connect as `eltnoy_monitor`) [TESTED-ISOLATED]
| Question | Query |
|---|---|
| Who is connected, and in what state or wait? | `SELECT pid, usename, state, wait_event_type, wait_event, statement_kind, xact_age FROM eltnoy_monitoring.sessions() WHERE backend_type = 'client backend';` |
| What is blocked, and by whom? | `SELECT * FROM eltnoy_monitoring.blocking();` |
| Which transactions are long or idle in transaction? | `SELECT * FROM eltnoy_monitoring.long_transactions(interval '5 minutes');` |
| How close are we to the connection limit? | `SELECT * FROM eltnoy_monitoring.connection_capacity();` (max, reserved, in use, by role and state) |
| Database activity | `SELECT numbackends, xact_commit, xact_rollback, deadlocks, blks_hit, blks_read, temp_files FROM pg_stat_database WHERE datname = current_database();` |
| Table statistics (no row data) | `SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables;` |

### 5.3 Investigating blocking [DERIVED from the tested functions]
1. Run `blocking()`: it shows each blocked pid, its wait, how long it has waited, and the blocking pid with that pid's state and transaction age.
2. Run `long_transactions()` to see whether the blocker is idle in a transaction.
3. **The monitor cannot cancel or terminate anything** (by design; tested). Escalate to an operator with an appropriate role. Terminating a session requires the superuser (break-glass, §8), or the session's own role.

### 5.4 Access limits and privacy [TESTED-ISOLATED]
- **Refused:** business tables, any write, DDL, temporary tables, role changes, `pg_terminate_backend`/`pg_cancel_backend`, file and program access, and the `postgres` database.
- **No query text:** the functions return the **statement keyword only**. Raw `pg_stat_activity.query` for other roles shows `<insufficient privilege>`. A synthetic sensitive literal in a running query appeared in **0** monitor rows.
- **Still visible (metadata, not row data):** usernames, database names, client IPs, application names (truncated to 64 characters), timings, table names and row counts.
- `pg_stat_statements` is not installed; slow-query analysis is not available.
- Alerting destinations must use client-approved, self-hosted tooling (S-07; UD-5).

---

## 6. Backup and restore

### 6.1 Backup [TESTED-ISOLATED: `pg_dump` as `eltnoy_backup`, custom format, inside the container, P1A/OD-P2]
```sh
# custom-format dump written inside the container, then copied out and encrypted per the client's approved method (UD-3)
docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production exec -T postgres \
  pg_dump -U eltnoy_backup -d <POSTGRES_DB> -Fc -f /tmp/<BACKUP_NAME>.dump
```

[PROPOSED]: copy the file off the container (`docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production cp postgres:/tmp/<BACKUP_NAME>.dump <destination>`), encrypt it, delete the in-container copy, and store it off-host. The encryption tool, location, schedule and retention are **not decided** (UD-3, M-10, A-13/M-09).

**Verify every backup by restoring it** (§6.2) into a separate database, then comparing it with the source (§6.3).

### 6.2 Restore [TESTED-ISOLATED: same cluster, into a new database, P1A/OD-P2]
1. Create an **empty** target database. Never restore over the live database without a verified copy and an approval.
2. `pg_restore -U <POSTGRES_USER> -d <TARGET_DB> --exit-on-error <file>`, as the superuser.
3. **Reapply database-level grants.** `pg_restore` does **not** restore `CONNECT`/`TEMPORARY` grants on the database: the restored database had the default ACL [TESTED-ISOLATED].
   - Run the bootstrap (§2.3) against the restored database [DERIVED: it re-creates exactly these grants and is idempotent].
   - Then run the monitoring setup (§5.1) [DERIVED].
4. Verify (§6.3).

**Restoring into a different (new) cluster is [PROPOSED].** The roles must exist before objects owned by `eltnoy_owner` can be restored with their owners. Run the bootstrap on an empty database first, then restore, then rerun the bootstrap and monitoring setup. This sequence is untested; rehearse it.

### 6.3 Restore validation [TESTED-ISOLATED method]
- The ownership and permission fingerprint, and the row-content fingerprint, of the restored database equal the source's (both matched in P1A and OD-P2).
- §2.4 and §3.6 queries pass.
- `has_database_privilege('eltnoy_app', '<TARGET_DB>', 'CONNECT')` is true.
- `datacl` on the restored database is not the default.

---

## 7. Super Admin promotion

**Approved procedure** (README "Self-hosted deployment"): promote only the explicitly approved official account. No self-service endpoint. No bulk promotion.

**After cutover**, run it as `eltnoy_migrator` (whose sessions act as `eltnoy_owner`). **`eltnoy_app` deliberately cannot update `is_super_admin`.** That `UPDATE` as the migrator was exercised in P1A [TESTED-ISOLATED]; this exact transcript is [DERIVED]. Before cutover, it runs as the current superuser, as the README describes.

```sql
BEGIN;
UPDATE users
SET is_super_admin = true
WHERE login_id = upper('<EXPLICIT_APPROVED_OFFICIAL_LOGIN_ID>')
  AND role = 'official'
  AND account_status = 'approved';
-- Must report UPDATE 1. Otherwise: ROLLBACK;
COMMIT;
```

**Preconditions**
- Written approval naming the login ID.
- The account is an approved `official`.
- A verified backup.

**Verification**
- That account can download the data export.
- An ordinary Official receives 403.
- Withdrawal **payments** need at least two active Super Admins (P3-D3), counted as `role = 'official' AND is_super_admin AND account_status = 'approved'`.

**Revocation:** the same statement with `is_super_admin = false`.

**Never** promote through the API role, expose credentials, or bypass the P0-3 authorization rules.

---

## 8. Break-glass access [PROPOSED: custodians and process need approval, UD-2]

- **Who:** named custodians of the bootstrap superuser credential, with two-person rule recommended (OD-P7, unresolved).
- **When:** only when a normal role can't resolve an incident:
  - a lockout;
  - a failed migration needing superuser repair;
  - terminating a runaway session;
  - a restore.

**Process**
1. Open an incident record **outside** the database: time, custodian(s), reason, approval. There is no in-database audit trail until S-1.
2. Use the narrowest action, through `docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production exec postgres psql -U <POSTGRES_USER> …` (maintenance command, §2.1).
3. Record every statement run.
4. Close the session.

**Afterwards**
- Rotate the superuser password (`\password <POSTGRES_USER>`), plus any credential that may have been exposed.
- Run §2.4 and §3.6.
- Review the PostgreSQL log for the session.
- Run a post-incident review.

> A superuser can bypass every protection in this runbook: triggers (via `session_replication_role`), privileges and ownership. Break-glass use must therefore be rare, recorded and reviewed.

---

## 9. Rollback and incident recovery

| Situation | Symptoms | Action | Evidence |
|---|---|---|---|
| **A required query is denied** (missing grant) | HTTP 500; API log `online_exam.request_failed` or similar with `sqlState 42501`; server log `permission denied for table …` | Identify the table and column from the server log. Add the exact column to the grants manifest (engineering change), or as an emergency `GRANT` as `eltnoy_migrator`. No restart needed. | [TESTED-ISOLATED] P1A R1: revoke → 500 → grant → 200 |
| **API cannot connect or start** | New instance exits 1 (`42501` for missing `CONNECT`, `28P01` for a wrong password); running instances continue on pooled connections | Fix the `CONNECT` grant (rerun the bootstrap) or the credential, then start again | [TESTED-ISOLATED] P1A R2, R3 |
| **Migration failure** | `Database migration failed at <file>; all changes were rolled back.` | The database is unchanged. Read the cause (for example "tables without an entry in the grant manifest", "objects not owned by eltnoy_owner", or "requires enabled immutability triggers"), fix, re-run. | [TESTED-ISOLATED] OD-P2-W, OD-P4 |
| **Object owned by the wrong role** | Migration refused: "objects not owned by eltnoy_owner: …" | As the superuser: `ALTER TABLE <name> OWNER TO eltnoy_owner;` then re-run | [TESTED-ISOLATED] P1A R4 |
| **Credential rotation went wrong** | `28P01` on new connections | Set the intended password again (`\password`), restart the affected service | [TESTED-ISOLATED] P1A R3 |
| **Need to revert the cutover** | — | **Manual, approved operator action only:** redeploy the previous `docker-compose.yml` and `.env.production` (API as the superuser). Roles, grants and ownership can stay; nothing needs dropping. Never automatic. | [PROPOSED] (documented in P1A; not executed) |
| **Data loss or corruption** | — | Restore into a new database (§6.2), validate (§6.3), switch over with approval | Restore [TESTED-ISOLATED]; switchover [PROPOSED] |
| **Blocking or capacity** | Slow requests, 503 `busy` | §5.3; escalate to break-glass if a session must be terminated | Monitoring [TESTED-ISOLATED] |

**Escalation:** the platform operator, then the database custodian, then the engineering lead and client. Names and contact paths are UD-2.

**Graceful shutdown (OD-P10, resolved in UD-1-B):** the image and Compose now run node directly as PID 1. In the isolated rehearsal `docker stop` exited 0 within 0.1 s and logged `api.shutdown_started`; with `npm start` it had exited 1 without the graceful shutdown.

**Secret-file failures (UD-1-B):** the API exits 1 with a non-secret message, for example `DATABASE_PASSWORD_FILE (/run/secrets/eltnoy_app_password) cannot be read (EACCES).` Fix ownership/mode (`root:10001 0440`) and start again; never make the file world-readable (the API refuses it). Table of messages: `docs/architecture/secure-database-credentials.md` §8.4.

---

## 10. Pre-cutover checklist

- [ ] OD-P1 cutover approval and a maintenance window recorded.
- [ ] UD-1-B changes reviewed, committed and approved for deployment (implemented and validated in isolation only).
- [ ] Ubuntu staging rehearsal of UD-1-B: host secret ownership (`root:10001`/`root:10002 0440`), bind-mount inode behaviour, UID 10001/10002 not used by any host account or group member, AppArmor default profile, document volume ownership, graceful shutdown, `server/createUser.ts` with `-it`.
- [ ] Secret files created in `ELTNOY_SECRETS_DIR` outside the repository; `.env.production` has `ELTNOY_SECRETS_DIR` and no `POSTGRES_PASSWORD`; database passwords equal the files (§2.5).
- [ ] UD-2 resolved: break-glass custodians named.
- [ ] UD-3 resolved: secret store, backup encryption, location, schedule and retention.
- [ ] Encrypted backup taken and **restored into a separate database**; §6.3 validation passed.
- [ ] Full cutover rehearsed on that **restored copy of production**: bootstrap, `\password`, twelve-file `db:migrate` (including the AUTH-1 and Student registration/email migrations) as `eltnoy_migrator`, API as `eltnoy_app`, functional smoke tests for every role, zero `42501` errors.
- [ ] Impact on any other database in the cluster assessed (cluster-wide effects, §0).
- [ ] Stakeholders aware that `institution_documents` rows become immutable after migration file 4 (UD-11).
- [ ] At least two active Super Admins identified (P3-D3), with the promotion approvals on file.
- [ ] Monitoring setup planned (§5) and an alert destination chosen (UD-5).
- [ ] Rollback owner and the manual revert path (§9) agreed.
- [ ] P1-B surface isolation configured per §14: P1-C (Nginx) and P1-D (Docker/Compose) completed and approved; `ELTNOY_PUBLIC_PROXY_CIDRS` and `ELTNOY_ADMIN_PROXY_CIDRS` set to the proxy addresses verified in P1-F; `ELTNOY_TRUSTED_PROXY_CIDRS` absent.
- [ ] Not deploying with `render.yaml` (unsupported, §14.5).

## 11. Restore and recovery checklist

- [ ] Incident record opened (time, operator, reason, approval).
- [ ] Target is a **new, empty** database (never overwrite live data without a verified copy).
- [ ] `pg_restore --exit-on-error` completed as the superuser.
- [ ] Bootstrap re-run against the restored database (`CONNECT` grants re-applied).
- [ ] Monitoring setup re-run.
- [ ] §2.4, §3.6 and §6.3 checks passed (ownership, permissions, triggers, `CONNECT`, fingerprints and row counts).
- [ ] API pointed at the restored database only with approval; health and role smoke tests passed; zero `42501`.
- [ ] Restore into a **new cluster**: the bootstrap creates `eltnoy_app`/`eltnoy_migrator` without passwords; set them again from the existing secret files (§2.5). Secret files are not in any dump; `pg_dumpall --roles-only` contains SCRAM verifiers and must be treated as a secret.
- [ ] Credentials rotated if break-glass was used.
- [ ] Post-incident review written.

---

## 12. Evidence register (isolated rehearsals; evidence held in the session scratchpad, not in this repository)

| Run | Scope | Key results |
|---|---|---|
| P1A `20261104065615-26145f` | Role separation, rollback scenarios R1–R5, backup and restore | 86 of 86 privilege tests; zero `42501`; restore with identical fingerprints |
| OD-P2 `20261104071914-91982f` | Bootstrap and grants migration | Pre-bootstrap no-op; fresh == upgrade; grant fingerprint `49e37eb9…` |
| OD-P2-W `20261104072634-5af7bc` | Wiring into `MIGRATION_FILES` | One transaction across files; failure in file 5 rolls back all |
| OD-P3 `20261104073417-e3b9da` | Immutability trigger | `UPDATE`, `DELETE` and `TRUNCATE` rejected for app, owner and superuser; row locks work |
| OD-P4 `20261104074341-13b19d` | Column-level `UPDATE` | 0 table-wide `UPDATE`; observed `UPDATE` columns == granted; `LOCK TABLE` denied on 24 tables |
| OD-P6 `20261104075603-f67477` | Monitoring role | 26 of 26 denials; no query text exposed; monitoring under live API load |
| UD-1 `20261104061701-b77055` | Password-file design (scratch patch) | 52/52; functional 46/46 |
| UD-1-A `20261104064404-be1099` | Dedicated UIDs (scratch) | 50/50; native-Linux permission and inode semantics |
| UD-1-B `20261104071404-ad7667` | **Implemented** Dockerfile/Compose/db.ts in production mode with TLS and nginx | 80/80; functional 46/46 via nginx; PG17 integration: credentials 4/4, institution 2/2, grants 8/8; local-dev script PASS |

**No rehearsal has used production data, a production host or a restored production copy.**

## 13. Unresolved operational decisions and approvals

| ID | Decision | Owner |
|---|---|---|
| UD-1 | **Implemented in the repository (UD-1-B), isolated validation only**: Compose file secrets, `DATABASE_PASSWORD_FILE`, identities 10001/10002. Remaining: Ubuntu staging rehearsal, secret store (UD-3), deployment approval (OD-P1) | Client / Engineering |
| UD-2 | Break-glass custodians, two-person rule, escalation contacts (OD-P7) | Client |
| UD-3 | Secret store; backup encryption tool, off-host location, schedule, retention; credential rotation schedule (M-10) | Client |
| UD-4 | `pg_hba.conf` hardening: TLS-only (`hostssl`) for application roles, removal of in-container trust (OD-P5) | Client / Engineering |
| UD-5 | Monitoring and alerting tooling and destination (self-hosted only, S-07) | Client |
| UD-6 | S-1 audit trail. Until it exists, break-glass and promotions are recorded outside the database. | Client |
| UD-7 | ~~`npm start` as PID 1~~ resolved in UD-1-B (node is PID 1; graceful shutdown verified in isolation). Ubuntu staging confirmation pending | Engineering |
| UD-8 | Production log settings (the rehearsals used `log_statement = all`; production must not log statement text containing personal data) | Engineering / Client |
| UD-9 | `eltnoy_app` connection limit 40 versus `DATABASE_POOL_SIZE` × instances (OD-P9) | Engineering |
| UD-10 | Approval workflow for running migrations and promotions (who may approve, how it's recorded) | Client |
| UD-11 | Procedure for correcting or erasing immutable institution document rows (needs a migration that disables the trigger) | Client / legal |
| UD-12 | AUTH C1 / C1.1-b (§3.8): values for `AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS`, `AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS`, `AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS`, `AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS`, `AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS`, `AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS`, `AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS`, `AUTH_SMS_DAILY_MAX_SENDS`, `AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS` (every SMS flow stays closed until set). ~~Retention of consumed claims~~ resolved in C1.1. A durable account-origin identifier so `AUTH_OTP_HMAC_KEY_FILE` can be rotated. Open: email limits for Institute email codes; a cap on Institute registration attempts per number (each attempt still writes a pending Institute); whether `/api/auth/providers` should report SMS unavailable while the limits are unset (it does not today); whether Student sign-in should refuse a number that differs from the verified contact (today it is only classified as unverified); an optional bucket index; C-4 (dummy bcrypt on the login-ID path) and C-5 (reserve before creating a challenge), not implemented | Client / Engineering |
| Legal | Retention periods (A-13/M-09), DPDP Act 2023 obligations, CERT-In log retention, statutory financial-record retention; to be confirmed by the client's counsel | Client / legal |

## 14. API surface isolation and proxy trust (P1-B) [PROPOSED: unit-tested code only; no Nginx, Docker or staging validation yet]

### 14.1 What the API enforces

- Two listeners: **public** (`PORT`, default 4000) serves Marketing, Exam and Institution; **Admin** (`ADMIN_PORT`, default 4001) serves Admin only. Each listener's identity is assigned by server code and checked against the actual local port.
- A request is accepted only from a proxy trusted **by the receiving listener**, and its surface comes from that listener plus the proxy-supplied `X-ELTNOY-Original-Host` header (never from `Host` or `X-Forwarded-Host`). Anything else is answered `421`.
- Express `trust proxy` trusts only the direct peer, and only when it is a configured proxy; `req.ip` (used by rate limiting) is the address that proxy appended to `X-Forwarded-For`. The proxy must therefore always set `X-Forwarded-For` (P1-C).
- `/api/health` answers only a loopback request inside the API container (`503` until both listeners are ready); through any hostname it returns `404`.

### 14.2 Settings (validated at startup; invalid or missing values stop the API, logging setting names and rules only)

| Setting | Rule |
|---|---|
| `ELTNOY_SURFACE_MODE` | `production`, `staging` or `development`; required, no default. `development` is refused when `NODE_ENV=production`. |
| `ELTNOY_PUBLIC_PROXY_CIDRS` | Required. Comma-separated proxy addresses trusted by the public listener only. |
| `ELTNOY_ADMIN_PROXY_CIDRS` | Required. Comma-separated proxy addresses trusted by the Admin listener only. |
| `ELTNOY_TRUSTED_PROXY_CIDRS` | Removed. Startup is refused if it is set. |
| `ADMIN_PORT` | Default 4001; must differ from `PORT`. |
| `ELTNOY_{MARKETING,EXAM,INSTITUTION,ADMIN}_HOSTNAME` | Production: leave unset (pinned hostnames). Staging/development: all four required, lower-case, no ports, not the production hostnames. |
| `ELTNOY_DEV_ORIGIN_SCHEME`, `ELTNOY_DEV_ORIGIN_PORT` | Development only. |

Each proxy entry must be **one address** (IPv4 `/32` or IPv6 `/128`). Rejected: subnets, host bits, duplicates, an address present in both lists, IPv4-mapped IPv6, link-local, multicast/reserved, unspecified and — outside development — loopback addresses. Addresses are not judged by their last octet: whether a `/32` is a network, gateway or broadcast address depends on the real subnet.

### 14.3 Establishing the production addresses (P1-D/P1-F)

1. P1-D assigns each proxy container (public Nginx, Admin Nginx) a static address on its network.
2. In P1-F, record each proxy's own address from the container/network inspection and confirm that it is **not** the network's gateway, network or broadcast address, and that the two proxies differ.
3. Measure the actual source address the API observes from each proxy (Docker NAT can rewrite it); configure exactly that address in the matching list. Do not configure subnets or guess addresses.
4. Verify: a request through each proxy reaches only its own listener; a request from any other peer gets `421`.

### 14.4 `APP_ORIGIN`

Since P1-B the API derives each surface's exact Origin from its hostname and no longer uses `APP_ORIGIN` for Origin enforcement. Since P1-D.2 the Compose configuration no longer reads `APP_ORIGIN`, `APP_HOSTNAME` or `TLS_CERT_DIR` (they remain in `.env.example` for reference only).

### 14.5 Render

`render.yaml` is **unsupported** for the current application: it has one port, no surface or proxy settings and a platform health check on the internal-only `/api/health`. Do not use it. A future Render deployment requires a separately reviewed architecture and explicit approval. Current release planning targets the private AWS/WireGuard architecture.

### 14.6 Nginx configuration (P1-C) [PROPOSED: static validation only — no Nginx was started, nothing is mounted]

Files: `deploy/nginx/public.conf`, `deploy/nginx/admin.conf`, and the shared `deploy/nginx/includes/eltnoy-proxy.conf` (forwarding policy) and `deploy/nginx/includes/eltnoy-tls.conf` (TLS policy). Since P1-D.2, `docker-compose.yml` mounts `public.conf` into `nginx_public` and `admin.conf` into `nginx_admin` (§14.7); the legacy single-host `deploy/nginx/default.conf.template` is retained in the repository but is no longer mounted. Static tests: `server/nginxSurfaceConfig.test.ts`.

- **Public Nginx** (`public.conf`) serves only `eltnoy.com`, `exam.eltnoy.com` and `institution.eltnoy.com`, one explicit server per hostname, and proxies only to the API's public listener (`app:4000`). It never references the Admin hostname or the Admin listener.
- **Public site vs private Admin domain (owner decision 2026-11-21).** `eltnoy.com` is the public site for Students and Institutes only. Admin, Super Admin and Platform Staff access is private on the separate `eltnoy.in` domain (`admin.eltnoy.in`), pinned in `server/surface.ts` and `admin.conf`. The legacy `admin.eltnoy.com` is served by neither Nginx and maps to no surface. Public surfaces never disclose the Admin hostname (`GET /api/surface-hostnames` returns only the three public hostnames there), the public navigation has no Admin or Staff link, and the SPA renders Admin pages only when the server confirms the Admin host. `admin.eltnoy.in` must have no public A/AAAA record: resolve it only for WireGuard clients (split-horizon), and obtain its certificate from a private CA or a DNS-01 challenge that needs no public address record. Owning `eltnoy.in` and controlling its DNS is an owner prerequisite; no DNS was changed.
- **Admin Nginx** (`admin.conf`) serves only `admin.eltnoy.in` and proxies only to the API's Admin listener (`app:4001`). It is a separate configuration for a separate Nginx; the two files must never be loaded together (both declare `default_server` on 8080 and 8443, so a combined load fails with a duplicate default server; a duplicate map variable alone would not fail). Both set `server_tokens off`.
- **Original host.** A map turns `Host` into the validated original host: only the exact allow-listed hostnames (case-insensitive, no port) are accepted; unknown, port-qualified, multi-valued or empty values become empty. Each hostname server returns `421` unless the validated host is its own name, before any location runs. Unknown hosts reach the default servers: HTTP `444`, HTTPS unknown SNI refused at the handshake (`ssl_reject_handshake`) and `444`.
- **Forwarding headers (every proxied location, set inside the location by the shared include):** `Host`, `X-Forwarded-Host` and `X-ELTNOY-Original-Host` = the validated original host; `X-Forwarded-Proto` = `$scheme`; `X-Forwarded-For` and `X-Real-IP` **overwritten** with the direct client address (`$remote_addr`; the incoming chain is never appended). Client-supplied `X-ELTNOY-Listener`, `X-ELTNOY-Surface`, `Forwarded`, `X-Forwarded-Port`, `X-Forwarded-Prefix`, `Upgrade` and `Connection` are stripped. Because the include is inside each proxied location, no location depends on `proxy_set_header` inheritance.
- **Locations.** Each HTTPS hostname server has a single proxied location (`/`): the API serves API routes, static assets, fonts and the SPA shell, and its P1-B gate enforces the per-surface policy for every path. There are no named, fallback, error-page, upload-specific or WebSocket locations. HTTP (8080) only redirects known hosts to HTTPS (literal URLs).
- **Health.** `/api/health` is not exposed: through a hostname it reaches the API, which answers `404` (P1-B internal-only). Each configuration has an Nginx-local `/_internal-health` on the HTTP default server, loopback-only (`allow 127.0.0.1; deny all`), answered by Nginx and never proxied — used by the P1-D.2 Compose health checks (`wget -q -O /dev/null http://127.0.0.1:8080/_internal-health`, no Host header).
- **Listen ports** stay at the existing in-container 8080/8443; how they are bound to host interfaces (public ENI address, `wg0` for Admin) is P1-D. HTTP/2 is not enabled (Host handling validated for HTTP/1.1 only).
- **TLS/DNS (unresolved).** Both files use the existing pattern (`/etc/nginx/tls/fullchain.pem` and `privkey.pem`, TLSv1.2/1.3, HSTS). Whether a certificate covers every public hostname, the separate Admin certificate, and split-horizon DNS for `admin.eltnoy.in` (not published externally) are unresolved and belong to a separately approved P1-D/P1-F step. No certificate was generated, requested or installed, and DNS was not changed.
- **Not yet established:** the static proxy addresses for `ELTNOY_PUBLIC_PROXY_CIDRS` / `ELTNOY_ADMIN_PROXY_CIDRS` (P1-F); Admin network isolation and no public route to port 4001 (P1-D). Nginx is not the network boundary.

### 14.7 Docker Compose topology (P1-D.2, Option B) [PROPOSED: statically tested only — no container, network or volume was created or started]

Two instances of the same API image, each reachable only through its own Nginx. Network **membership** is the isolation boundary (`internal: true` is not relied on alone). Static tests: `server/composeTopology.test.ts`, `server/containerHardening.test.ts`, `server/nginxHealthcheck.test.ts`, `server/startApi.test.ts`.

| Service | Networks | Listens / publishes | Credentials |
|---|---|---|---|
| `nginx_public` | `public_ingress`, `public_app` | publishes `PUBLIC_BIND_ADDRESS:80→8080`, `:443→8443` | none; mounts `public.conf`, includes, `PUBLIC_TLS_CERT_DIR` (read-only) |
| `api_public` | `public_app` (alias `app`), `db_public` | 4000 only (`ELTNOY_API_LISTENERS=public`); not published | `eltnoy_app` secret only |
| `nginx_admin` | `admin_ingress`, `admin_app` | publishes `ADMIN_BIND_ADDRESS:443→8443` only (the `wg0` address; fails to start if absent) | none; mounts `admin.conf`, includes, `ADMIN_TLS_CERT_DIR` (read-only) |
| `api_admin` | `admin_app` (alias `app`), `db_admin` | 4001 only (`ELTNOY_API_LISTENERS=admin`); not published | `eltnoy_app` secret only |
| `postgres` | `db_public`, `db_admin`, `db_ops` (all internal) | 5432, never published | superuser secret only |
| `migrate` (profile `ops`) | `db_ops` | — | `eltnoy_migrator` secret only |

- **Expected reachability (to be proven in P1-F):** public Nginx → public API 4000 allowed; public Nginx → Admin API, Admin Nginx → public API, either Nginx → PostgreSQL, and public API ↔ Admin API have **no shared network**. The P1-B per-listener proxy lists are the second layer.
- **Listener selection.** `ELTNOY_API_LISTENERS` is required: `public` or `admin`; `public,admin` only in `development`. Readiness (`/api/health` 200) only after all configured listeners bind. Each instance shuts down its own listener and pool.
- **Recovery ownership.** Only `api_public` receives `ONLINE_EXAM_RECOVERY_SINCE`; an instance without the public listener refuses to start if it is set, and never starts recovery. P0-4 semantics are unchanged (and recovery is also safe against a duplicate sweep: `FOR UPDATE SKIP LOCKED` plus the conditional finalize).
- **Database roles.** Both APIs use `eltnoy_app` (connection limit 40; two pools of `DATABASE_POOL_SIZE`, default 10). Only `migrate` holds the migrator secret. Monitoring stays manual (`eltnoy_monitor` through `psql` in the `postgres` container); never attach monitoring to an Nginx network.
- **Health.** `api_public`: `fetch('http://127.0.0.1:4000/api/health')`; `api_admin`: the same on 4001; both Nginx: `wget -q -O /dev/null http://127.0.0.1:8080/_internal-health` (no Host header); `postgres`: `pg_isready`. Order: PostgreSQL healthy → each API → its Nginx.
- **TLS.** `PUBLIC_TLS_CERT_DIR` (SANs exactly the three public hostnames) and `ADMIN_TLS_CERT_DIR` (SAN `admin.eltnoy.in` only; private/internal CA or another approved private-hostname approach; split-horizon DNS) must be different directories — the API refuses to start otherwise. Files `fullchain.pem` and `privkey.pem`, owned `101:101`, key mode `0600`.
- **Static addresses (placeholders).** `PUBLIC_APP_SUBNET`, `ADMIN_APP_SUBNET`, `NGINX_PUBLIC_APP_ADDRESS`, `NGINX_ADMIN_APP_ADDRESS`, `API_PUBLIC_APP_ADDRESS`, `API_ADMIN_APP_ADDRESS` have no defaults. Choose two private subnets that do not overlap each other, the host, the VPC, the WireGuard range or other Docker networks; pick addresses inside them that are not the network, gateway or broadcast address. The proxy lists given to both APIs are derived from the two Nginx addresses. Verify the observed peer addresses in P1-F.
- **Document volume.** `institution_documents` is mounted read-write in both APIs: the Admin read path calls `ensurePrivateDirectories()` (recursive `mkdir`), and safe read-only operation could not be established statically — **open hardening item**. **Backup gap:** this runbook covers PostgreSQL dumps only; a procedure that backs up and restores `institution_documents` consistently with the database still needs approval.
- **Image digests (deployment blocker).** `NGINX_IMAGE` (nginx-unprivileged, Nginx ≥ 1.19.4) and `POSTGRES_IMAGE` (PostgreSQL 17) must be operator-verified `name@sha256:…` references; none is preconfigured. The Dockerfile's `node:22-bookworm-slim` base is not yet digest-pinned (separate change). `ELTNOY_API_IMAGE` names the locally built API image used by both API services: it must be `localhost/eltnoy-api:<tag>`; `api_public` uses `pull_policy: build` and `api_admin` `pull_policy: never` (§14.8).
- **Staging.** The Nginx files pin the production hostnames; reviewed staging variants are still required before a staging rehearsal.
- **P1-F runtime checks (none performed yet):** TCP refusals from inside each container (Nginx → other API, Nginx → PostgreSQL, API ↔ API, APIs have no internet egress); `ss -ltnp` on the host shows no 4000/4001/5432 and Nginx only on the two bind addresses; the Admin Nginx fails to start without `wg0`; observed proxy source addresses equal the configured static addresses; `$remote_addr` is the real client / WireGuard peer; all health checks pass, including after an API container is recreated; recovery logs only from `api_public`; end-to-end surface isolation, cross-surface session and Origin rejection, 421/444 handling; certificate SANs per Nginx; split-horizon DNS; image build/pull behaviour with `pull_policy: never`; database and document backup/restore rehearsal.

### 14.8 Deployment preflight: API image and bind addresses (P1-D.2 audit M-1, M-2) [PROPOSED: unit-tested only]

`server/validateDeploymentConfig.ts` (rules in `server/deploymentConfig.ts`) checks the settings below. It runs **inside each API container** before the API starts; an invalid value keeps that API unhealthy, so the Nginx that depends on it never starts or publishes. It must **also pass on the host before** any build or start. Since P1-D.3 the host preflight is run **only through the deployment wrapper** (§14.9), which validates exactly the values Compose then receives:

```sh
scripts/eltnoy-deploy.sh --deployment-env-file /absolute/path/.env.production preflight
```

The former direct command (`node --env-file=… server/validateDeploymentConfig.ts`) is withdrawn for host use: Node and Compose parse env files differently, and shell variables override the file in both, so it could validate different values from those Compose uses (P1-D.2 M-1/M-2 audit, F-5).

- **`ELTNOY_API_IMAGE` (M-1).** Only `localhost/eltnoy-api:<tag>` is accepted (tag: letters, digits, `_`, `.`, `-`; up to 128 characters). Registry-qualified (`ghcr.io/…`, `localhost:5000/…`), Docker Hub (`eltnoy-api:…`, `user/eltnoy-api:…`), digest and untagged references are rejected; there is no default. `api_public` builds it from this repository with `pull_policy: build` (never pulled); `api_admin` reuses the exact same reference with `pull_policy: never`.
- **`PUBLIC_BIND_MODE` (BigRock direct-VPS adaptation).** Required. Use `private-eni` for the VPC deployment rule below. `direct-vps` is an explicit opt-in for a server whose public IPv4 is assigned directly to a host interface; use it only after confirming the exact address with `ip -4 address` and enabling the host firewall. Missing or invalid values fail the preflight.
- **`PUBLIC_BIND_ADDRESS` (M-2).** With the default `private-eni` mode, a literal RFC 1918 address on the host's private interface; public, shared, wildcard, loopback, link-local, multicast/reserved and IPv6 values are rejected. With the explicit `direct-vps` mode, it must be a public IPv4 assigned to the VPS interface; private/shared, wildcard, loopback, link-local, multicast/reserved and IPv6 values are rejected. The direct-VPS mode does not replace UFW or the `DOCKER-USER` Admin firewall guard.
- **`WIREGUARD_INTERFACE_ADDRESS` (M-2, new).** The literal IPv4 address assigned to the host's `wg0` interface, copied by the operator from the WireGuard configuration (private RFC 1918 or 100.64.0.0/10). It is a declaration: the preflight does not inspect the host or resolve names.
- **`ADMIN_BIND_ADDRESS` (M-2).** Must **equal** `WIREGUARD_INTERFACE_ADDRESS`, and must differ from `PUBLIC_BIND_ADDRESS`. The same wildcard/loopback/public/IPv6 rejections apply.
- IPv6 bind addresses are not supported: the Compose port syntax `${VAR}:443:8443` cannot carry an unbracketed IPv6 literal.
- Errors name the setting and the rule only; configured values are never printed.

**Limits (P1-F / other findings).** Static validation cannot prove that the declared address is really on `wg0` (if it is not, Docker cannot bind and the Admin Nginx does not start). The wrapper (§14.9) removes the routine paths that skip the preflight, but it cannot stop an operator with Docker access from running Compose or Docker directly (for example `docker compose up --no-deps nginx_admin`). P1-F must verify the listening sockets (`ss -ltnp`) and the image actually used; the `wg0`-only host firewall rule is audit item L-5 (separate, still required).

### 14.9 Deployment wrapper: one env file, validated values only (P1-D.3/P1-D.4; audit F-1, F-2, F-5, D3-1–D3-8) [PROPOSED: unit-tested only — never run against Docker]

`scripts/eltnoy-deploy.sh` (policy in `server/deploymentWrapper.ts`, file and process handling in `server/deploymentRunner.ts`, entry `server/deploy.ts`) is the **only approved operator entry point** for the host preflight and the deployment Compose operations:

```sh
scripts/eltnoy-deploy.sh --deployment-env-file /absolute/path/.env.production <operation> [--dry-run]
```

| Operation | Compose arguments (fixed) | Validation | Purpose |
|---|---|---|---|
| `preflight` | none — Docker is not invoked | full | Host preflight only |
| `build` | `build api_public` | full | Build the local API image (`ELTNOY_API_IMAGE`) |
| `start-postgres` | `up -d postgres` | full | Start PostgreSQL alone (README step 7, §2.1) |
| `migrate` | `--profile ops run --rm migrate` | full | Run migrations as `eltnoy_migrator` (after approval and backup) |
| `start` | `up -d` | full | Start the whole stack; each Nginx waits for its healthy API |
| `status` | `ps` | full | Show service status |
| `stop` | `down` | full | Stop and remove containers and the Compose networks; never `-v`, volumes are kept |
| `emergency-status` | `ps` | file + syntax only | List containers while the configuration is invalid |
| `emergency-stop` | `stop` | file + syntax only | Stop containers while the configuration is invalid; nothing is removed |

Every Compose call is `docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file <private run directory>/compose.env <fixed arguments>`. `--dry-run` runs the checks and prints that command (paths only, the generated file as a placeholder) without creating the file or running anything.

**Trust model (D3-1).** The operator account running the wrapper and root are trusted; no other account is. Under that model:
- every directory from `/` to the env file (after resolving symbolic links in directory components) must be owned by root or the operator and must not be writable by group or others, unless it has the sticky bit (`/tmp`-style: only an entry's owner can rename or delete it);
- the same rule applies to the temporary root (`$TMPDIR`, else the system default);
- the env file itself must be a regular file owned by root or the operator, mode `0600` or `0640`, at most 64 KiB, valid UTF-8.
Ownership and mode checks do not make a file immutable: the operator and root can still change it. That is why Compose never reads it (below).

**How the values are kept identical (F-5, D3-1).**
- **One explicit file.** An absolute path is required; no default file (`.env`, `.env.production`) is ever chosen. The option is called `--deployment-env-file` because Node's own CLI intercepts a bare `--env-file` argument.
- **One descriptor.** The file is opened once with `O_NOFOLLOW` (a symbolic link at the final component is refused; the wrapper refuses to run on a platform without `O_NOFOLLOW`) and `O_NONBLOCK`; type, size, owner and mode are checked with `fstat` on that descriptor, and the content is read from the same descriptor. Replacing or relinking the path after it is opened has no effect on what is validated.
- **Strict syntax.** `KEY=VALUE` lines, optionally with the whole value in one pair of `"` or `'` quotes, blank lines and full-line `#` comments. Everything else fails closed: `export`, spaces around `=`, leading whitespace, duplicate keys, multi-line or unbalanced quotes, CRLF and NUL. `COMPOSE_*` and `DOCKER_*` keys are rejected.
- **Governed variables** are every variable `docker-compose.yml` interpolates plus every preflight variable (tests keep the lists equal to the Compose file). Their values must not contain whitespace, quotes, `$` (so `${…}` and `$VAR` are rejected), backslashes, backticks, `#` or control characters. Every `${VAR:?}` variable (22) must be present and non-empty; the twenty-one `${VAR:-}` variables may be absent, and then Compose uses its default. Those twenty-one are the six earlier ones, the nine AUTH C1.3-B settings and the six AUTH C1.4-B-2 email settings, all with an empty default.
- **AUTH C1.3-B / C1.3-B.2 SMS settings:** the host wrapper **governs** these nine (safe-character checks), forwards them to Compose when set, and **applies the §3.8 SMS rule** in the host `preflight` and in the full validation that precedes every non-emergency operation. It uses the same pure resolver (`server/smsProtectionConfig.ts`) as the in-container preflight and the API, applied to the parsed env-file values only.
  - The eight `AUTH_SMS_*` settings are **all-or-nothing:** all absent or empty is accepted (SMS stays closed); all eight valid and consistent is accepted; a partial set, an invalid value or an inconsistent value **fails**, with setting names and statuses only and never values.
  - `AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS` is validated **independently:** absent or empty is accepted (Student registration then stays closed at runtime with `503 REGISTRATION_NOT_CONFIGURED`); a set but invalid value fails.
  - No numeric defaults exist.
  - **Emergency operations** (`emergency-stop`, `emergency-status`: syntax-only validation) are unchanged: they keep the file, syntax and character checks and skip this rule, like the rest of the semantic preflight.
  - The entry's module set grows by two side-effect-free files (`smsProtectionConfig.ts`, `verificationProviders.ts`, Node built-ins only); no database, credential, dotenv or Express module is loaded on the host.
- **AUTH C1.4-B-2 email settings:** the six `AUTH_EMAIL_*` settings (§3.10) are governed the same way, forwarded to `api_public` only, and checked by the same all-or-nothing rule in the host preflight, the full validation before every non-emergency operation, and the container preflight. The rule is independent of the SMS rule, which is unchanged. Emergency operations skip it.
- **Shell overrides.** A governed variable, or any `COMPOSE_*` or `DOCKER_*` variable (for example `COMPOSE_PROFILES`, `COMPOSE_FILE`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`), already set in the operator's shell causes a refusal.
- **Generated file.** After validation, the wrapper writes the validated governed values — and nothing else — to `compose.env` in a new private run directory: `mkdtemp` under the checked temporary root (mode `0700`, unpredictable name, so it cannot be pre-created), file created with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600`, flushed with `fsync`. Compose receives only this file through `--env-file`; it never reads the operator file. The same values are also passed in Docker's environment, which otherwise contains only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM` and `TMPDIR`.
- **Cleanup.** The run directory is removed after Docker exits, fails to start or the run throws; `SIGINT`, `SIGTERM` and `SIGHUP` are deferred until cleanup is done. A `SIGKILL` or power loss can leave `eltnoy-deploy-*/compose.env` (mode `0600`, no passwords — passwords live in the secret files) in the temporary root; delete it manually. The wrapper never prints the generated file's path or content.
- **Cancellation (P4-6).** Immediately before Docker would start, the wrapper yields to the event loop so that a `SIGINT`, `SIGTERM` or `SIGHUP` received earlier is delivered; if one was received, Docker is not started, the run directory is removed and the wrapper exits with 128 + the signal number. A signal that arrives after Docker has started is deferred until Docker exits (a terminal interrupt also reaches Docker directly). This is covered by a subprocess test of the real entry point with a stand-in `docker`; it has not been exercised against real Docker.
- **Project name (P4-8).** `docker-compose.yml` declares the top-level `name: eltnoy-production`, and every wrapper call also passes `--project-name eltnoy-production`, so the project does not depend on the checkout directory name. All containers, networks and volumes of this deployment carry the Compose label `com.docker.compose.project=eltnoy-production`. A project started earlier under a directory-derived name (for example a local development stack) is a **different** project: its containers and volumes are neither adopted nor touched, and data in its volumes is not visible to `eltnoy-production`. Do not rename, stop or remove such a project as part of this change.
- **Repository `.env` (P4-5).** Compose may load `<repository>/.env` in addition to an explicit `--env-file` (to be verified in P1-F). Until then, every Compose operation — including `--dry-run` and the emergency operations — is refused while any entry named `.env` (file, symbolic link, directory or FIFO) exists at the repository root. The wrapper only checks that the entry exists: it never opens, reads, moves or deletes it. `preflight` still validates the env file and prints a warning. Move the `.env` out of the production checkout yourself (local development uses `.env` in a development checkout, not on the server).
- Messages name settings, keys and line numbers only. Values are never printed by the wrapper.

**Emergency operations (D3-4).** `emergency-status` and `emergency-stop` exist so that a stack can be inspected and stopped when its configuration has become invalid (for example a changed bind address). They keep every file, syntax, character and shell check and the generated file, but skip the semantic preflight and the required-variable check, and print a warning. They can only list (`ps`) or stop (`stop`) containers: `stop` does not remove containers, networks or volumes and cannot create, start, build, pull or publish anything. The warning they print states exactly this: they skip deployment configuration validation and the required-variable check, only the file, syntax, character and shell checks run, and they can only list (`ps`) or stop (`stop`) containers. Both target the `eltnoy-production` project (`--project-name`), never a project derived from the directory name, and both are refused while a repository `.env` entry exists. If Compose cannot load the project (for example a required variable is missing) or the env file fails its file or syntax checks, `emergency-stop` fails; as a last resort, list exactly this project's containers with `docker ps --filter label=com.docker.compose.project=eltnoy-production` and stop them individually with `docker stop <container>`. Never use `docker compose down -v`, `docker volume rm` or volume pruning: `postgres_data` and `institution_documents` must be preserved. Fix the env file and run `preflight` before any further `start`.

**Executables and the runtime environment (D3-5, P4-3, P4-4, P4-7, P4-10).**
- **Shell start-up order.** Until `PATH` has been validated, the shell entry runs only reserved words and shell built-ins: (1) under bash (macOS `/bin/sh`), `export -pf` — a POSIX special built-in that an imported function cannot shadow in POSIX mode — lists imported functions, and any exported shell function (`BASH_FUNC_*`) is refused; (2) invocation through a symbolic link is refused; (3) `PATH` must contain only absolute entries; (4) `NODE_*` variables except `NODE_ENV`, and `TSX_*` variables, are refused, read from the built-in `export -p`; (5) `node` is resolved with the built-in `command -v` on the validated `PATH` and run by absolute path. No external command (`env`, `grep`, `sed`, `tr`, `dirname`) is used. dash (Ubuntu `/bin/sh`) imports no functions. Invoke the script as `/bin/sh` does (directly or with `sh`); running it with a non-POSIX `bash` is not supported, because special built-ins are not protected there.
- **Node entry.** The Node entry repeats the checks independently: `NODE_*` (except `NODE_ENV`), `TSX_*`, `BASH_FUNC_*` and any variable name containing `%` are refused, and `PATH` must contain only absolute entries.
- **What the Node.js check does not do (P4-7).** The shell does not validate the `node` binary's owner or mode before `exec`; it only requires an absolute path from the validated `PATH`. The Node entry checks the running executable (`process.execPath`, after resolving symbolic links: a regular executable file owned by root or the operator, not writable by group or others, in a directory with the same properties) **after** the interpreter has started. That check detects a misconfigured installation; it cannot protect the launch of the interpreter itself, because a substituted `node` would already be running. Protect the `node` binary through the host's package management and file permissions.
- **Docker executable.** `docker` (the first match on the validated `PATH`) is resolved through symbolic links and checked the same way **before** it is started, by that absolute path with `shell: false`. Between the check and the start, only the owner of the file or its directory (the operator or root), or a writer to an unchecked ancestor directory, could replace it.
- **Limits of the executable checks (P4-10).** Only the executable and its **immediate** containing directory are checked, not every ancestor directory. On macOS, ancestors such as `/Applications` (Docker Desktop: `/Applications/Docker.app/Contents/Resources/bin/docker`) and Homebrew's `Cellar` (for example `/opt/homebrew/Cellar/node/<version>/bin/node`) are writable by the `admin` group and are outside the check. Docker credential helpers (`docker-credential-*`) are found through `PATH`, and CLI plugins — including `docker compose` itself and `buildx` — through `~/.docker/cli-plugins` or the system plugin directories; none of them is checked by the wrapper. On the Ubuntu production host, use the distribution's root-owned `/usr/bin/node` and `/usr/bin/docker` (and root-owned plugin directories) wherever applicable. `HOME`, the Docker context, the credential-store configuration and the plugins remain part of the operator's trust boundary; the current implementation does not eliminate these limits.
- `tsx` and the wrapper's own code are loaded from the repository checkout (`node_modules`, `server/`); the checkout itself must be trusted and not writable by other accounts.

**Docker context and configuration (D3-6).** `DOCKER_HOST`, `DOCKER_CONTEXT` and `DOCKER_CONFIG` are refused in the shell, but `HOME` is passed to Docker, so the Docker CLI still reads `~/.docker/config.json`: its `currentContext` selects the daemon, and its credential store and CLI plugins (including `docker compose` itself) come from there or from the system plugin directories. Before deploying, confirm `docker context show` prints `default` (or the reviewed context for this host) and that the configuration file is owned by the operator and not writable by others. The wrapper does not pin the daemon.

**Docker and Compose output (D3-7).** The wrapper's own messages contain no configured values, but Docker and Compose output is passed through unfiltered. It can show operational metadata: bind addresses and published ports (`status`, `emergency-status`), image names and tags, container, network and volume names, and Compose's own error messages. Treat terminal logs and CI transcripts of wrapper runs as internal operational data. Secret values are not part of the Compose configuration (passwords are file secrets).

**Canonical invocation (D3-8).** Invoke the wrapper by its repository path (`<repository>/scripts/eltnoy-deploy.sh`, or `scripts/eltnoy-deploy.sh` from the repository root). Invocation through a symbolic link (for example one placed in `/usr/local/bin`) is refused, because the script locates the repository from its own path.

**Bypass scenarios.**
- **`--no-deps`, `create`, `start`, `--pull`, `-v` and service names** are not accepted. Operations take no service or flag from the operator, and any extra argument is refused.
- **Direct Nginx startup** (`docker compose up nginx_admin`, `docker compose up --no-deps nginx_public`, `docker compose create` followed by `docker compose start`, `docker start <nginx container>`) is **prohibited**. Nginx publishes its host ports as soon as its container starts, so these commands can bind before any preflight. Use `start`, which brings up each Nginx only after its API has passed the in-container preflight and reports healthy.
- **Direct Compose invocation** for deployment operations (build, start, pull, migrate, stop) is **prohibited**. Use the wrapper.
- **Maintenance commands without a wrapper operation** (`exec postgres psql`, `exec postgres pg_dump`, `run --rm api_public … createUser.ts`, `cp`, `restart api_public api_admin`, `logs`) still use Compose directly and therefore **read the operator env file themselves**: none of the wrapper's descriptor, generated-file or shell-environment protections applies to them. Run them only after a passing `preflight` with the same file, with no `.env` entry at the repository root, with no governed, `COMPOSE_*`, `DOCKER_*`, `NODE_*` (other than `NODE_ENV`) or `TSX_*` variable set in the shell, and always with the exact prefix `docker compose --project-name eltnoy-production --project-directory <repository> --file <repository>/docker-compose.yml --env-file /etc/eltnoy/.env.production` (replace `<repository>` with the checkout's absolute path and the env file path with yours). Never target `nginx_public` or `nginx_admin`, and never add `--no-deps`, `--pull` or `-v`. Note that `run --rm api_public …` may rebuild the API image (§14.10).
- **The wrapper's role is operator enforcement, not a security boundary.** Anyone with Docker access (the `docker` group is root-equivalent) can bypass it. The host firewall restricting the Admin port to `wg0` (audit item **L-5**) remains a separate, required control, as do the P1-F socket checks.
- **Not verified at runtime (D3-9, P1-F).** The wrapper has never been run against Docker. Compose's handling of the generated `--env-file`, the precedence of environment values, `emergency-stop` behaviour with an invalid project, exit codes and the effect of each operation are P1-F items.

### 14.10 Image pull and build safety (P1-D.3/P1-D.4; audit F-3, D3-3) [PROPOSED: Compose semantics as documented; not runtime-verified]

- **Intended protections for normal use.** `api_public` has `pull_policy: build`: Compose builds `ELTNOY_API_IMAGE` from this repository instead of pulling it. `api_admin` has `pull_policy: never` and no build of its own: it runs only the image with that name already present on this host (normally the one `api_public` built) and fails to start if it is absent. Together with the preflight rule that `ELTNOY_API_IMAGE` is `localhost/eltnoy-api:<tag>`, the API image never comes from a registry in the normal sequence.
- **When images are built (D3-3).** Images are **not** changed only by the `build` operation:
  - `build` builds `api_public` explicitly;
  - `start` (`up -d`) can rebuild `api_public` as well, because `pull_policy: build` builds the image whenever the service is brought up. The tag is then reassigned to the new build, and `api_admin` uses whatever image carries the tag when its container is (re)created;
  - `migrate` builds and runs the separate `migrate` service image (its own `build:`; audit item L-2, still open), and maintenance `run --rm api_public …` commands can rebuild `api_public`;
  - each build fetches the Dockerfile base image unless it is cached.
  Run `build`, `start` and `migrate` only from a reviewed checkout, and treat any of them as a possible image change. Whether `up` rebuilds on every run or only when needed is a P1-F verification item; no Compose build behaviour was changed in P1-D.4.
- **Not approved as routine deployment operations:**
  - `docker compose pull` (with or without `--ignore-buildable`). Its interaction with `pull_policy: never` is unverified, and it can fetch `NGINX_IMAGE` and `POSTGRES_IMAGE` outside the reviewed procedure.
  - `docker compose up --pull always` (or any `--pull` value). The command-line policy can override the per-service `pull_policy`, so `api_admin` could be resolved from a registry.
  - Manual `docker pull` of any `eltnoy-api` reference, including a registry listening on `localhost`. `localhost/` is a naming convention, not a registry restriction: Docker treats `localhost` as a registry host.
  - `docker tag` or retagging an image to `localhost/eltnoy-api:<tag>`. Compose and the preflight check names only, so any image carrying that name would run on both APIs.
  - `docker load` of an image archive. Same effect as retagging: the origin of the loaded image is not established.
  - Prefer an immutable, versioned tag per release (not `latest`).
- **Still unresolved:**
  - **Base-image provenance.** The Dockerfile `FROM node:22-bookworm-slim` is fetched during builds and is not digest-pinned (I-5 / separate change).
  - **Digest pinning.** The locally built API image is identified by tag, not digest, so a rebuild under the same tag replaces what `api_admin` runs. `NGINX_IMAGE` and `POSTGRES_IMAGE` digests must still be operator-verified (deployment blocker, §14.7).
  - **Runtime behaviour.** The actual Compose behaviour of `pull_policy: build` / `never` under `up`, `run`, `pull` and `--pull` is a P1-F item, to be checked against a disposable project. No pull or build command was run.
