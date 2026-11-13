# PostgreSQL role separation plan (S-1 phase 1A, OD-2)

> **Historical plan (P1-D.4).** Commands and the `app` service in this plan predate P1-D.2 and the deployment wrapper; they are kept as a record and are superseded. Current procedures: operator runbook §2, §3 and §14.9.

**Status:** PLAN AND ISOLATED REHEARSAL ONLY. No production database, credential, container, migration, source file or Git state was changed. Prepared 2026-11-04 against `rc/day1-baseline` at `df9b93e` (P0-3) on `5c8dd41` (P0-4). Internal; do not publish.

**Rehearsal run:** `20261104065615-26145f`. Disposable PostgreSQL 17.11 and an API image built from `git archive df9b93e`; synthetic data only. All rehearsal scripts and evidence are in the session scratchpad (`p1a-src/`, `p1a-env-20261104065615-26145f/`). They are not part of the repository.

**Labels:** **[APPROVED]** previously approved (OD-2 authorizes this planning); **[RECOMMENDED]** design recommendation; **[CLIENT]** requires client approval; **[ENG-VALIDATE]** needs further engineering validation; **[REHEARSED]** demonstrated in the isolated rehearsal.

---

## 1. Summary

- **Today the API runs as the PostgreSQL superuser.** The same role runs migrations, the `user:create` CLI and the manual Super Admin promotion SQL. Privileges and triggers therefore do not constrain the application.
- **The API needs no elevated privilege at runtime.** It never runs DDL, `DELETE` or `TRUNCATE`. Every runtime statement can run as a plain, non-owner role with per-table grants. Four security-critical tables can use **column-level** `UPDATE` grants.
- **No source-code change is needed for phase 1A.** [REHEARSED] Migration code works unchanged through `ALTER ROLE eltnoy_migrator SET role = 'eltnoy_owner'`. The API works unchanged with an `eltnoy_app` connection string.
- **Rehearsal outcome** [REHEARSED]:
  - every functional flow worked as `eltnoy_app`, with **zero permission-denied errors**;
  - **86 of 86** direct privilege tests passed;
  - the fresh-install and upgrade paths produced **identical ownership and ACLs**;
  - backup and restore round-tripped;
  - all five rollback scenarios behaved as designed.
- **Production cutover needs:** a maintenance window, new credentials held outside the repository, a Compose and README change for how migrations and Super Admin promotion run, and the open decisions in §9. [CLIENT]

---

## 2. Current-state findings (read-only inspection)

| # | Finding | Evidence |
|---|---|---|
| F-1 | **The API connects as the superuser.** `DATABASE_URL` is built from `POSTGRES_USER`, which the official image creates as the bootstrap **superuser**. | `docker-compose.yml:13`; rehearsal Stage A shows `bootstrap superuser=true` |
| F-2 | **Migrations use the same superuser credentials.** They ran with `docker compose run --rm app npm run db:migrate` (historical finding; superseded — migrations now run through the deployment wrapper, runbook §14.9). The API does **not** migrate at startup. | README §deployment step 5; `docker-compose.yml` app `command` runs only config validation and `npm start` |
| F-3 | **All application objects are owned by the bootstrap superuser:** 24 tables, 78 indexes, 7 trigger functions. No extensions, sequences, identity columns, views or custom types. | Rehearsal Stage A server log (`user=p1a_bootstrap … CREATE TABLE`); `grep` of the three migration files |
| F-4 | **No `GRANT`, `REVOKE`, `OWNER`, role or default-privilege statements exist** in any migration | `grep` of `schema.sql` and both institution migrations |
| F-5 | **The API never deletes or truncates** and runs no DDL. Its only special statements are `set_config('lock_timeout', …, true)` (P0-4) and `to_regclass(...)`. The migration advisory lock is migration-only. | Query inventory (§5) |
| F-6 | **Row locks need `UPDATE` privilege.** PostgreSQL requires `UPDATE` privilege on at least one column for `SELECT … FOR UPDATE` and `FOR SHARE`. That affects `users`, `exams` (`FOR SHARE`), `institute_withdrawals` (`FOR UPDATE OF u, w`) and **`institution_documents`, which the API never updates.** | `server/index.ts`, `institutionDocuments.ts`, `institutionSubmission.ts` |
| F-7 | **Super Admin promotion is a manual SQL `UPDATE users SET is_super_admin = true`.** Today it runs as the superuser. | README "Sensitive Excel data export" |
| F-8 | **`npm run user:create` runs inside the app container** with the app's `DATABASE_URL` (only an `INSERT INTO users`). | README step 7; `server/createUser.ts` |
| F-9 | **Backups are a documented procedure without a script** (encrypted, off-host, restore-verified). There is no dedicated backup role. | README |
| F-10 | **The image's `pg_hba.conf` trusts local-socket and loopback connections** inside the PostgreSQL container. Anyone who can `docker exec` into it is effectively superuser. Network access uses `scram-sha-256`. Production adds TLS (`ssl=on`) but keeps this file. | Rehearsal step 5 printout |
| F-11 | **Test infrastructure stubs the pool**, so no unit test exercises database privileges. The PostgreSQL integration suites are skipped unless configured. | `server/*.test.ts` |
| F-12 | **The API image runs `npm start` as PID 1.** On `docker stop`, npm exits with `npm error signal SIGTERM` (exit 1), and the app's own graceful-shutdown log line did not appear. This is unrelated to roles but is an operational finding. [ENG-VALIDATE] | Rehearsal R3 |

---

## 3. Role architecture

### 3.1 Roles [RECOMMENDED][REHEARSED]

| Role | Login | Purpose | Key attributes |
|---|---|---|---|
| *bootstrap superuser* (existing `POSTGRES_USER`) | Yes | **Break-glass only:** cluster administration, role creation, restores. Not used by the API or migrations after cutover. | Unchanged; credentials held by the operator |
| `eltnoy_owner` | **No** | Owns every application object (tables, indexes, functions) | `NOLOGIN`, not superuser, no `CREATEROLE`/`CREATEDB`/`BYPASSRLS` |
| `eltnoy_migrator` | Yes | Runs migrations and owner-level operator SQL (for example Super Admin promotion) | Member of `eltnoy_owner` **`WITH INHERIT FALSE, SET TRUE`**; `ALTER ROLE … SET role = 'eltnoy_owner'` so every session acts as the owner; **no rights of its own** (`SET ROLE NONE` then `CREATE TABLE` → denied) |
| `eltnoy_app` | Yes | API runtime and the `user:create` CLI | Not owner, not superuser; `CONNECTION LIMIT 40`; per-table and per-column grants (§4) |
| `eltnoy_audit_writer` | No | **S-1, future:** insert-only on audit tables; to be granted to `eltnoy_app` | Created as an empty placeholder; no grants until S-1 |
| `eltnoy_audit_reader` | No | **S-1, future:** read-only audit access for the Super Admin viewer path, if a separate connection is ever used | Placeholder; no grants |
| `eltnoy_audit_verifier` | Yes | **S-1, future:** integrity verification and checkpoint export | Placeholder; **no access to business tables** (tested) |
| `eltnoy_backup` | Yes | `pg_dump` | Member of predefined `pg_read_all_data`; cannot write (tested) |
| *(recommended addition)* `eltnoy_monitor` | Yes | Monitoring of sessions, locks and lag | Member of predefined `pg_monitor` / `pg_read_all_stats`. Needed because **non-privileged roles can't see other roles' wait states** (rehearsal finding, §6.3). [CLIENT OD-P6] |

### 3.2 Ownership versus grants [RECOMMENDED]

Ownership and grants are **not interchangeable**:
- An owner can `ALTER`, `DROP`, disable triggers and `GRANT` regardless of ACLs.
- A role with ordinary grants can do only what is granted.

So the API must never own anything, and the owner role must never log in. The migrator reaches the owner only by `SET ROLE`, and it was shown to have no rights outside that role.

### 3.3 Database- and schema-level access [REHEARSED]

- `REVOKE ALL ON DATABASE <db> FROM PUBLIC`. `GRANT CONNECT` only to `eltnoy_migrator`, `eltnoy_app`, `eltnoy_audit_verifier` and `eltnoy_backup`. No `TEMPORARY` for anyone.
- `REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC`, so the API can't connect to the maintenance database (tested).
- `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `GRANT USAGE, CREATE` to `eltnoy_owner`; `USAGE` only to the others.
- `ALTER DEFAULT PRIVILEGES FOR ROLE eltnoy_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`. Trigger functions don't need `EXECUTE`. **No default table grants:** every new table gets explicit grants (§4.3).

### 3.4 Connection configuration [RECOMMENDED][CLIENT]

| Consumer | Connection | Change from today |
|---|---|---|
| API (`app` service; historical — superseded by `api_public`/`api_admin` in P1-D.2) | `DATABASE_URL` → `eltnoy_app`, TLS as today | New credentials in `.env.production` (never printed or committed) |
| Migrations | (historical plan; superseded — now the wrapper `migrate` operation, runbook §14.9) A separate one-off `docker compose run` with a `DATABASE_URL` override → `eltnoy_migrator` | Compose and README change; **no code change** (rehearsed with an env override) |
| `user:create` CLI | `eltnoy_app` (only `INSERT INTO users`) | None |
| Super Admin promotion SQL | `psql` as `eltnoy_migrator`. **The API role deliberately cannot update `is_super_admin`.** | README procedure change |
| Backups | `pg_dump` as `eltnoy_backup` | New credentials |
| Restores | Bootstrap superuser, then reapply database-level grants (§7, F-R2) | Runbook change |

---

## 4. Required grants

The rehearsal SQL is in the scratchpad as `roles.sql`, `database-setup.sql` and `grants.sql`. [REHEARSED]

### 4.1 Cluster roles (once, as the bootstrap superuser)

```sql
SET log_statement = 'none';               -- keep passwords out of the server log (verified: 0 lines)
CREATE ROLE eltnoy_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE eltnoy_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migrator_pw';
GRANT eltnoy_owner TO eltnoy_migrator WITH INHERIT FALSE, SET TRUE;
ALTER ROLE eltnoy_migrator SET role = 'eltnoy_owner';
CREATE ROLE eltnoy_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40 PASSWORD :'app_pw';
CREATE ROLE eltnoy_audit_writer NOLOGIN;  CREATE ROLE eltnoy_audit_reader NOLOGIN;
CREATE ROLE eltnoy_audit_verifier LOGIN PASSWORD :'verifier_pw';
CREATE ROLE eltnoy_backup LOGIN PASSWORD :'backup_pw';  GRANT pg_read_all_data TO eltnoy_backup;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
```

### 4.2 Per database (as the bootstrap superuser): access and ownership transfer

- Revoke database access from `PUBLIC`; grant `CONNECT` (§3.3); set the schema privileges.
- Transfer ownership **object by object** with a loop of `ALTER TABLE|SEQUENCE|VIEW … OWNER TO eltnoy_owner` and `ALTER FUNCTION … OWNER TO eltnoy_owner`, over objects not already owned by `eltnoy_owner`.
- `REASSIGN OWNED BY <bootstrap>` must **not** be used: the bootstrap superuser also owns system objects.
- Indexes follow their tables.

### 4.3 API grants (as `eltnoy_migrator`; idempotent; derived from the query inventory)

| Grant | Tables |
|---|---|
| `SELECT, INSERT, UPDATE` | `admit_cards`, `answer_key_questions`, `center_checkins`, `exams`, `feedback`, `institute_forms`, `institute_profile_changes`, `institution_submission_capabilities`, `institution_submission_cycles`, `online_exam_attempts`, `online_exam_questions`, `portal_notices`, `published_results` |
| `SELECT, INSERT` + `UPDATE (account_status, display_name, contact_email, registration_number, registered_address, website)` | `users`. **Never** `id`, `login_id`, `role`, `password_hash`, `is_super_admin`. |
| `SELECT, INSERT` + `UPDATE (revoked_at)` | `auth_sessions`. **Never** `token_hash`, `user_id`, `expires_at`. |
| `SELECT, INSERT` + `UPDATE (status, transfer_reference, reviewed_by, reviewed_at)` | `institute_withdrawals`. **Never** `institute_id`, `amount_paise`. |
| `SELECT, INSERT` + `UPDATE (status, user_id, ownership_verified_at, ownership_verified_by, ownership_verification_method)` | `applications` |
| `SELECT, INSERT` only | `institute_status_history`, `institute_resubmissions`, `institute_wallet_entries`, `mock_exam_attempts`, `institution_document_versions`, `institution_document_review_history`. Append-only and ledger tables are now protected by **privilege**, not only by triggers. |
| `SELECT, INSERT` + `UPDATE (created_at)` | `institution_documents`. **Interim, F-6:** the column grant only enables `FOR UPDATE`. Durable fix: an immutability trigger on this table (migration change) [CLIENT OD-P3]. |
| none | `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` on any table; `EXECUTE` on functions |

`REVOKE ALL … FROM PUBLIC` on all tables and functions. The verifier and audit roles get nothing on business tables until S-1.

**Keeping grants in step with the schema** [RECOMMENDED][CLIENT OD-P2]: add the grants as an idempotent fourth migration file. Add a test that fails when a table has no explicit `eltnoy_app` grant entry, the same idea as the P0-3 route registry. Otherwise a future table would be silently inaccessible to the API.

---

## 5. Query compatibility report

From a static inventory of every SQL string in `server/*.ts` (excluding tests), confirmed by the rehearsal's zero-denial run.

| Table | API operations found | Covered by grant |
|---|---|---|
| `users` | SELECT; INSERT (register, center register, CLI); UPDATE `account_status` and profile fields; `FOR UPDATE` (several paths) | ✓ (column UPDATE suffices for `FOR UPDATE`) |
| `auth_sessions` | SELECT (`requireAuth`), INSERT (login and register), UPDATE `revoked_at` (logout) | ✓ |
| `applications` | SELECT, INSERT, UPDATE `status`, ownership columns | ✓ |
| `admit_cards`, `center_checkins` | SELECT, INSERT, upsert | ✓ |
| `exams` | SELECT, INSERT, UPDATE, `FOR UPDATE`/`FOR SHARE` | ✓ |
| `feedback`, `institute_forms`, `institute_profile_changes`, `portal_notices` | SELECT, INSERT, UPDATE (`FOR UPDATE` on profile changes) | ✓ |
| `institute_withdrawals` | SELECT, INSERT, UPDATE review and payment columns, `FOR UPDATE OF u, w` | ✓ |
| `institute_wallet_entries`, `institute_status_history`, `institute_resubmissions`, `mock_exam_attempts` | SELECT, INSERT only | ✓ |
| `published_results`, `answer_key_questions`, `online_exam_questions` | SELECT, INSERT, UPDATE, upserts, `FOR UPDATE` (P0-3 locks) | ✓ |
| `online_exam_attempts` | SELECT, INSERT, UPDATE, `FOR UPDATE` and `FOR UPDATE SKIP LOCKED` (P0-4) | ✓ |
| `institution_documents` | SELECT, INSERT, `FOR UPDATE` | ✓ (interim column grant) |
| `institution_document_versions`, `…_review_history` | SELECT, INSERT | ✓ |
| `institution_submission_cycles`, `…_capabilities` | SELECT, INSERT, UPDATE, `FOR UPDATE` | ✓ |
| Special | `set_config('lock_timeout', …, true)`; `to_regclass(...)` | Allowed for any role ✓ |

**Behaviour differences after the change** [REHEARSED]:
- **Foreign keys still work.** Foreign-key checks run with the referenced table owner's rights, so no `REFERENCES` grant is needed.
- **Append-only triggers still fire for the owner.** Tested: an owner `UPDATE` of `institute_status_history` is rejected.
- **The data export still reads every table** it exports (200, 22,843 bytes).

---

## 6. Isolated rehearsal results [REHEARSED]

### 6.1 Environment and isolation

**Resources created** (all labelled `eltnoy.validation=p1a`, run `20261104065615-26145f`):
- image `eltnoy-p1a-test:…`, built from `git archive df9b93e` (164 files, identical to the commit tree);
- PostgreSQL 17.11 container `eltnoy-p1a-pg-…`: internal network only, **no host port**;
- volume `eltnoy-p1a-pgdata-…`; networks `eltnoy-p1a-db-…` (internal) and `eltnoy-p1a-pub-…`;
- databases `eltnoy_p1a_validation`, `eltnoy_p1a_fresh` and `eltnoy_p1a_restore`.

**API placement:** the API ran on `127.0.0.1:55495` and was later replaced by API2 on `127.0.0.1:55496`. Neither was reachable via the LAN address.

**Isolation checks:**
- Before and after: identical identity records for the live ELTNOY, P0-4 and P0-3 containers and all pre-existing volumes, networks and images (25 records).
- Git state and `.env` metadata unchanged; host port 5432 never used; no `eltnoy` or `eltnoy_dev` database present.
- No credential appears in the server log (0 lines with a literal password, including the role-creation and rotation statements) or in either API log.

### 6.2 Migration stages

| Stage | Result |
|---|---|
| A. Today's model: migrate as the bootstrap superuser, load synthetic fixtures | Exit 0; objects created by the superuser (server log) |
| B. Role separation on that existing database | 24 tables, 78 indexes and 7 functions now owned by `eltnoy_owner`; the migrator session reports `eltnoy_migrator acts as eltnoy_owner` |
| C1. Existing migrations rerun as `eltnoy_migrator`, plus a grants rerun | Exit 0; the schema, ownership and ACL fingerprint (including column ACLs) is **unchanged** (`bfcb36c8…`) |
| C2. Migrations attempted as `eltnoy_app` | **Refused** ("permission denied for schema public"), whole transaction rolled back, fingerprint unchanged |
| D. Fresh install: empty database, migrations as the migrator from the start, then grants | Fingerprint **identical** to the upgraded database (`bfcb36c8…`) |
| API start as `eltnoy_app` | Healthy; recovery scheduler enabled; only connection `eltnoy_app@eltnoy_p1a_validation` |

### 6.3 Functional results (API running as `eltnoy_app`)

**Main run, as recorded: 39 of 48 checks passed.** Every failure was a defect in my harness, not in the product or the grants:

| Area | Result |
|---|---|
| HTTP authorization matrix | 130 refused requests (401/403) with no protected statement; 64 of 64 permitted requests passed the guards |
| Withdrawals | Maker-checker, NULL approver, the two-Super-Admin rule, legacy approver, duplicate reference, already paid, approver rejection: all pass |
| Results, answer keys, online exams | Drafts, refusals of corrections to published content, Super Admin corrections, publishing, P0-4 attempts guard first: all pass |
| Admit cards, helpdesk, ownership linking, documents | All pass |
| Additional flows (new in this rehearsal) | Self-registration, login, `/me`, logout, the revoked session refused, wrong password refused; institute self-registration and **A-01 approval by an ordinary Official** with status history; notice create and publish; exam form create (A-18) and publish; a candidate application; a center withdrawal request; a center check-in; public helpdesk submission; the full data export. **All behaved correctly.** The one recorded failure was my assertion expecting 200 where logout returns **204**. |
| P0-4 regression | Normal flow, grace submit, recovery sweep and the pre-cutoff refusal **correct**. The recorded failures came from splicing in my old P0-3 harness section, with pre-fix attempt IDs, and the known 201-versus-200 assertion. |
| **Privilege errors** | **No permission-denied or must-be-owner error for `eltnoy_app`** across the whole run. Its only database error was the deliberate duplicate-transfer-reference test. |
| Concurrency (rerun with a correct observer) | **4 of 4.** Two payments both waited on the row lock (`Lock/transactionid`, blocked by the holder, then by each other), one succeeded, one debit. Results, answer-key and online-exam imports each waited on the publishing transaction, then returned 403. |

**Observability finding:** the first concurrency run reported "0 waiting" because the observer ran as `eltnoy_migrator`/`eltnoy_owner`. A role without privileges over another role's sessions **cannot see their `query`, `state` or `wait_event`**, and `eltnoy_owner` cannot even see the migrator's own other sessions. A monitoring role with `pg_monitor` or `pg_read_all_stats` is therefore needed (§3.1).

---

## 7. Security test results [REHEARSED]

86 direct SQL tests, each in a rolled-back transaction where applicable. **The first run showed 84 passing; the 2 failures were test-construction errors.** Re-checked:

1. **`GRANT … TO PUBLIC` by `eltnoy_app`** returns success with `WARNING: no privileges were granted`. `has_table_privilege('public','users','SELECT')` stays **false** and the ACL is unchanged, so it's correctly ineffective.
2. **`RESET ROLE` for the migrator** returns to its configured default role, the owner. The correct test, `SET ROLE NONE` then `CREATE TABLE`, is **denied**.

**Corrected result: 86 of 86.**

| Role | Denied (as intended) | Allowed (as intended) |
|---|---|---|
| `eltnoy_app` | `CREATE TABLE`, `CREATE FUNCTION`, `CREATE TEMP TABLE`, `CREATE INDEX`, `ALTER TABLE`, `DROP`, `TRUNCATE`, disabling triggers, effective `GRANT`, `SET ROLE` to the owner, migrator or superuser, `CREATE ROLE`/`DATABASE`/`EXTENSION`, `ALTER SYSTEM`, `COPY TO PROGRAM` or to a file, `pg_read_file`, `pg_reload_conf`, `session_replication_role`, connecting to `postgres`; **`DELETE` on all 24 tables**; `UPDATE` on the 6 append-only and ledger tables; `UPDATE` of `users.is_super_admin`, `role`, `password_hash`, `auth_sessions.expires_at`, `institute_withdrawals.amount_paise`, `applications.exam_code`, `institution_documents.category`; `LOCK TABLE users … ACCESS EXCLUSIVE` | `SELECT`; granted column updates; `FOR UPDATE`/`FOR SHARE` on the locked tables; `INSERT`; `set_config('lock_timeout')`; `to_regclass` |
| `eltnoy_migrator` | `CREATE ROLE`/`DATABASE`, `ALTER SYSTEM`, `pg_read_file`, `COPY TO PROGRAM`, `SET ROLE` to the superuser; `CREATE TABLE` after `SET ROLE NONE`; `UPDATE` of an append-only table (trigger) | `ALTER TABLE` and `CREATE TABLE` as the owner |
| `eltnoy_audit_verifier` | Reading or writing business tables | — |
| `eltnoy_backup` | `INSERT`, `UPDATE` | Reading every table; `pg_dump` (109 KB custom-format dump) |
| `eltnoy_owner`, `eltnoy_audit_reader` | Login (`NOLOGIN`) | — |

**Residual risk:** `eltnoy_app` **can** take `LOCK TABLE feedback IN ACCESS EXCLUSIVE MODE`, because a table-level `UPDATE` grant permits it. A compromised API could stall such tables (denial of service), though not corrupt them. Tables with column-only `UPDATE` (`users`) refuse it. [ENG-VALIDATE] whether to narrow more grants to column level.

**Backup and restore:**
- `pg_dump` as `eltnoy_backup`, then `pg_restore` as the bootstrap superuser into `eltnoy_p1a_restore`, gives an **identical** ownership and ACL fingerprint and identical row contents. The dump file was deleted afterwards.
- **Finding F-R2:** `pg_restore` of a database dump does **not** restore database-level `CONNECT` and `TEMPORARY` grants; the restored database had the default ACL. The restore runbook must reapply §3.3 before the API connects.

---

## 8. Migration sequence (production; each step needs its own approval)

| Step | Action | Who / credentials | Verification |
|---|---|---|---|
| 0 | Encrypted backup **and** a verified restore to a separate test database | Operator | Restore fingerprint and row counts match (§7 method) |
| 1 | Full rehearsal on that restored copy of production, running this plan's scripts unchanged | Engineering | Stages B–D results as §6, plus the functional suite against the restored copy |
| 2 | Generate four strong passwords; store them in the approved secret location; never print them | Operator | File modes and access list checked |
| 3 | **Maintenance window opens.** Stop the application; the database stays up. (Historical: `docker compose stop app` is superseded — there is no `app` service since P1-D.2; use the wrapper `stop` then `start-postgres`, runbook §2.1 and §14.9.) | Operator | No API connections (`pg_stat_activity`) |
| 4 | Run §4.1 (roles), then §4.2 (database access and ownership transfer), as the bootstrap superuser, in one session with `log_statement = 'none'` | Operator | Ownership query: everything owned by `eltnoy_owner`; roles have the expected attributes |
| 5 | Run §4.3 (grants) as `eltnoy_migrator`, then rerun `npm run db:migrate` as `eltnoy_migrator` | Operator | Fingerprint unchanged by the rerun; drift query returns none |
| 6 | Update `.env.production`: `DATABASE_URL` → `eltnoy_app`; a migration env → `eltnoy_migrator` (Compose and README change approved separately) | Operator | (historical plan; superseded — do not run `docker compose config` against production values) `docker compose config` resolves without printing secrets (`--no-interpolate` review) |
| 7 | Start the application (current procedure: wrapper `start`, runbook §14.9) | Operator | Health 200; `pg_stat_activity` shows only `eltnoy_app`; route smoke tests per role; **no `42501` in logs** |
| 8 | Keep the bootstrap superuser credentials sealed for break-glass; switch backups to `eltnoy_backup` | Operator | Next scheduled backup succeeds as `eltnoy_backup` |
| 9 | Observe for an agreed period with the 42501 alert (§8.1) | Operator | Zero permission denials |

Ownership transfer takes brief `ACCESS EXCLUSIVE` locks per table. With the API stopped this is safe; on a large database, measure it during step 1. [ENG-VALIDATE]

### 8.1 Lockout prevention [RECOMMENDED]

- **The superuser is never dropped or altered.** Its credentials stay sealed. The local-socket trust inside the container (F-10) is the last-resort path; restrict `docker exec` on the host accordingly.
- **No automatic credential reversion.** Any fallback is a manual, recorded operator action.
- **Rehearse on a restored production copy before cutover**, not only on synthetic data.
- **Alert on any `ERROR: permission denied` for `eltnoy_app`** in the PostgreSQL log during and after cutover, so a missed grant shows up immediately.
- **Change one credential at a time.** Keep the old API instance running until the new one is healthy (R3 pattern).

---

## 9. Rollback procedure [REHEARSED]

| Scenario | Rehearsal evidence | Procedure |
|---|---|---|
| **R1. A required query is denied** (missing grant) | With `UPDATE` revoked on `online_exam_attempts`, autosave returned **500**; the API log showed `online_exam.request_failed … "sqlState":"42501"`; the server log showed `permission denied for table online_exam_attempts`. After the `GRANT` (no restart), autosave returned **200**. | Identify the table from the server log; apply the narrowest `GRANT` as `eltnoy_migrator`; add it to the grants migration; no restart needed |
| **R2. The API cannot start** (role can't connect) | With `CONNECT` revoked, a new API instance exited **1** (`42501`); the already-running instance kept serving on pooled connections; after the `GRANT CONNECT`, connections succeeded | Read the startup log (setting name and SQLSTATE only); fix the grant or credentials; start again. Running instances are not interrupted by grant changes on `CONNECT`. |
| **R3. Credential rotation and connection switching** | `ALTER ROLE eltnoy_app PASSWORD …` (not logged): the old password got `28P01` on new connections; the new password connected; the old instance kept serving on pooled connections; a second API (`127.0.0.1:55496`) with the new credentials became healthy and served authenticated reads; the old instance was then stopped | Rotate, start the new instance or recreate the service with new env, verify, then stop the old one. Pool idle timeout is 30 s, so the old instance degrades once its connections recycle; switch promptly. |
| **R4. Migration-owner drift** | A table created by the superuser was detected by the drift query, fixed with `ALTER … OWNER TO eltnoy_owner`, then dropped (rehearsal only) | Run the drift query after every migration; fix ownership as the superuser |
| **R5. Break-glass** | Bootstrap superuser over TCP and the local socket: both work | Manual only; record who used it and why |
| **Full revert of phase 1A** (emergency) | Not executed. The procedure is documented. | Point `DATABASE_URL` back to the bootstrap superuser **as a manual, approved operator action**. Ownership by `eltnoy_owner` doesn't block the superuser. Roles and grants can remain; nothing needs to be dropped. |

---

## 10. Open decisions

| ID | Decision | Recommendation |
|---|---|---|
| OD-P1 | Approve the production cutover (§8) and a maintenance window | After a restored-copy rehearsal |
| OD-P2 | Add the grants as an idempotent fourth migration file, plus a test that every table has explicit API grants | Yes |
| OD-P3 | `institution_documents`: keep the interim `UPDATE (created_at)` grant, or add an immutability trigger (migration change) | Add the trigger, then the grant is harmless |
| OD-P4 | Narrow table-level `UPDATE` grants to columns for more tables (limits `LOCK` and update scope) | Do it for financial and publishing tables once stable |
| OD-P5 | `pg_hba.conf` hardening: `hostssl` only for application roles, per-role and per-database rules, removal of loopback trust | Yes, with TLS rehearsal (the rehearsal used no TLS) |
| OD-P6 | Create `eltnoy_monitor` (`pg_monitor`) for monitoring and audit verification | Yes |
| OD-P7 | Who holds the bootstrap superuser credentials; the break-glass procedure | Two-person custody, logged use |
| OD-P8 | Change the README procedures: migrations as `eltnoy_migrator`, Super Admin promotion as `eltnoy_migrator`, backups as `eltnoy_backup`, restore plus database-level grants | Yes, as a separate docs change |
| OD-P9 | `CONNECTION LIMIT` for `eltnoy_app` (40) versus `DATABASE_POOL_SIZE` (10) times instances during switches | 40 covers two instances with headroom |
| OD-P10 | `npm start` as PID 1 (F-12): run node directly or use an init so graceful shutdown runs | Engineering follow-up, separate approval |

---

## 11. Production-readiness checklist

- [ ] A restored copy of production was rehearsed with these scripts; stages B–D and the functional suite pass there.
- [ ] Roles exist with the attributes in §3.1; `rolsuper = false` for every `eltnoy_*` role; `eltnoy_owner` is `NOLOGIN`.
- [ ] Every object in `public` is owned by `eltnoy_owner` (drift query returns none).
- [ ] `eltnoy_app` grants match §4.3 exactly (catalog dump compared with the approved list); there is no `DELETE`/`TRUNCATE`.
- [ ] Database-level `CONNECT` limited to the named roles; `postgres` database not connectable by `eltnoy_app`.
- [ ] Migrations run as `eltnoy_migrator` and are idempotent (fingerprint unchanged on rerun); a migration as `eltnoy_app` is refused.
- [ ] The API starts as `eltnoy_app`; smoke tests pass for every role; zero `42501` in logs over the observation period.
- [ ] Super Admin promotion and the `user:create` CLI work with the new procedure.
- [ ] A backup as `eltnoy_backup` and a restore drill (including database-level grants) pass.
- [ ] Credentials stored only in the approved location; none in logs, Compose output, the repository or shell history.
- [ ] Break-glass procedure documented and owners named (OD-P7).
- [ ] Monitoring role in place and the permission-denied alert active.
- [ ] P0-3 route matrix, P0-4 regression, lint, typecheck and build unchanged and passing.
- [ ] Policy and architecture documents updated in a separate approved change (S-1 proposal §4.1 references this plan).

---

## 12. Rehearsal environment state

The environment is **still running and was not cleaned up**:
- `eltnoy-p1a-pg-…` (no host port) and `eltnoy-p1a-api2-…` on `127.0.0.1:55496` are running;
- the first API (`…-api-…`, stopped in R3) and the one-shot containers (`migrate-super`, `migrate-owner`, `migrate-asapp`, `migrate-fresh`, `startup-denied` and four `conncheck` containers) are kept, in an exited state;
- the image, volume and both networks are kept.

Credential files (mode 600) remain in the run folder. Cleanup needs separate approval, as do the P0-3 and P0-4 environments.
