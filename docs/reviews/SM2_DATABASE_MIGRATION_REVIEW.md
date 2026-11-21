# SM-2 Database Migration Review

**Status:** Static inspection only. **No database was accessed, no migration was executed and no DB integration test was run.** Nothing in this document has been rehearsed.
**Date:** 2026-11-14.

**Implementation update (2026-11-17):** `platformStaffMigration.sql` and `organizationStaffMigration.sql` are now included in `MIGRATION_FILES` before the final grants migration. The manifest contains least-privilege rows for all 14 Staff tables; static runner and grant tests pass. This is source-level evidence only: no PostgreSQL migration or runtime grant test was executed.

**Files reviewed:**
- `server/authVerificationMigration.sql` (AUTH-1, 139 lines)
- `server/platformStaffMigration.sql` (SM-1, 124 lines)
- `server/organizationStaffMigration.sql` (SM-1, 134 lines)
- `server/databaseGrantsMigration.sql` (grants manifest, 206 lines)
- `server/migrate.ts` (runner, 116 lines)
- `server/staffMigrations.test.ts`

## 1. Original runner and grants findings (2026-11-14)

- **At review time (2026-11-14),** `MIGRATION_FILES` was `schema.sql`, the three institution files, then `databaseGrantsMigration.sql`. The AUTH-1 migration was listed; the two Staff proposals were not. The Staff files were wired later on 2026-11-17 (see the implementation update above).
- **Runner:** every file runs in **one transaction** under an advisory lock, and any failure rolls back all of them (`migrate.ts:52-74`). Wiring a proposal in therefore makes it all-or-nothing together with the existing files.
- **The grants migration must stay last** (`migrate.ts:13-18`):
  - Before `databaseRoleBootstrap.sql` has provisioned the `eltnoy_*` roles, it only raises a NOTICE (`databaseGrantsMigration.sql:53`).
  - Afterwards it **fails closed** on any public table missing from the manifest (`:140`), any stale manifest entry (`:146`), objects or functions not owned by `eltnoy_owner` (`:86-96`), and privileges other than SELECT, INSERT and column UPDATE (`:187-202`).
- **At review time (2026-11-14),** the manifest had 24 tables and none of the 14 tables created by the two Staff proposals. The current manifest and static test coverage are recorded in the 2026-11-17 implementation update.
  - Wiring any proposal in without manifest entries, once roles exist, makes `db:migrate` fail and roll back everything. That is safe, but it is a hard ordering requirement.
  - The trigger functions created by the proposals (`reject_*_mutation()`) must be owned by `eltnoy_owner`, so the proposals must run as the owner (through `eltnoy_migrator`), as the existing files do.

## 2. Per-migration findings (review-time snapshot)

### 2.1 `authVerificationMigration.sql` (AUTH-1, 7 tables)

**Tables:** `account_contacts`, `verification_challenges`, `auth_session_verifications`, `institute_verifications`, `google_identities`, `oauth_states`, `auth_verification_events`.

**Strengths:**
- Additive and idempotent.
- Only hashed codes, with a 64-hex CHECK.
- Single-use challenges and OAuth state.
- E.164 CHECK for SMS contacts.
- Append-only audit (row and TRUNCATE triggers).

**Findings:**
- **M-A1 (High, cross-module):** `institute_verifications.institutional_status` defaults to `pending` and `suspended_at` to NULL, and **no application code ever sets `verified`, `rejected` or a suspension**. The only writes are the INSERT at registration and the contact-verification UPDATEs (`authVerificationStore.ts:221-224`). Once installed:
  - every Organization Owner session is refused by `portalVerificationGate` (`auth.ts:186`);
  - existing approved institutes have **no row at all** and are refused as well;
  - so the SM-1 Owner staff routes become unreachable.
  - Needs: an institutional-verification and suspension route (Super Admin), plus a backfill decision for existing institutes. (Policy item OI-5.)
  - **Update 2026-11-14:** the route now exists (`server/instituteVerificationAdmin.ts`; store `authVerificationStore.ts:339-396`). It uses **only existing columns** (`institutional_status`, `institutional_decided_at/by`, `suspended_at/by`, `updated_at`) and audits to `auth_verification_events`. **The migration file was not changed.** A decision on an Institute without a row creates it with defaults inside the decision transaction, so no backfill is technically required. Whether to pre-verify existing institutes remains a rollout decision.
- **M-A2 (Low):** `account_contacts` has no cross-account uniqueness for a mobile number. This is intentional and documented as an open decision.

### 2.2 `platformStaffMigration.sql` (SM-1, 9 tables)

**Tables:** `platform_staff_departments`, `_roles`, `_permission_catalogue`, `_role_permissions`, `_accounts`, `_account_roles`, `_sessions`, `_audit_events`.

**Strengths:**
- Never alters `users`.
- Catalogue created empty (D-08).
- Deactivation CHECK ties `status` to `deactivated_at`/`deactivated_by` (`:63-66`).
- Role grants are revoked rather than deleted, with a partial unique index on active grants (`:72-82`).
- Append-only audit (`:107-124`).

**Findings:**
- **M-P1 (Info):** `platform_staff_audit_events.actor_id` and `target_account_id` have no foreign keys. That is acceptable for an append-only log, but readers must not trust them as references.
- **M-P2 (Low):** nothing in the schema stops a future seed of `platform_staff_role_permissions`. The empty catalogue plus the foreign key is the control, so the grants manifest should give the app **SELECT only** on both permission tables (§3).

### 2.3 `organizationStaffMigration.sql` (SM-1, 6 tables)

**Tables:** `org_staff_role_templates` (seeded with the six Q117 templates), `org_staff_members`, `org_staff_invitations`, `org_staff_member_roles`, `org_staff_sessions`, `org_staff_audit_events`.

**Strengths:**
- Composite `(id, organization_id)` keys keep invitations, roles and sessions inside one organization (`:56`, `:68-69`, `:85-86`, `:98-99`).
- The CHECK makes `active` impossible without verification, activation and a password (`:53-55`).
- Code hash is unique (`:72`).
- One live invitation per member (`:73`).

**Findings:**
- **M-O1 (Medium): expired invitations never release their slot.**
  - `org_staff_invitations_one_live_idx` is `WHERE used_at IS NULL` and ignores `expires_at` (`:73`).
  - `(organization_id, staff_id)` is unique (`:58`).
  - `createInvitation` always inserts a new member (`organizationStaff.ts:192-204`), and there is no revoke or re-issue route.
  - Result: once a 72 h code expires unused, that staff ID can never be invited again in that organization, and the stale `invited` member stays in the Super Admin activation list (`organizationStaff.ts:284-293`).
  - Needs a policy (Q115 remainder) and a re-issue or revoke design; the schema index itself can stay.
- **M-O2 (Low):** `organization_id` references `users(id)` but the schema does not enforce `role = 'center'`. It is enforced in code (Owner guards; the `o.role = 'center'` joins at `organizationStaff.ts:233`, `:247`, `:272`). Optional hardening: a trigger or a composite FK on a role-qualified key.
- **M-O3 (Low):** `verification_method` has no CHECK and `code_hash` has no format CHECK (the AUTH-1 file has one). Add them before first use.
- **M-O4 (Positive):** if the manifest below withholds UPDATE on `org_staff_members.verified_at` / `verification_method`, the database itself prevents the app from marking a member verified until OTP exists. That is a useful fail-closed layer under C-18.

## 3. Proposed grants-manifest entries (derived from the SQL each store actually issues)

Same format as the existing manifest: `(table, table privileges, column-UPDATE list)`. Column lists come from every `UPDATE … SET` in the stores (`authVerificationStore.ts`, `platformStaff.ts:199-261`, `organizationStaff.ts:211-303`). Read and INSERT needs come from the same files. **Proposals only; not applied.**

| Table | Privileges | UPDATE columns | Basis |
|---|---|---|---|
| account_contacts | SELECT, INSERT | destination, verified_at | ON CONFLICT DO UPDATE (`authVerificationStore.ts:200`, `:228`) |
| verification_challenges | SELECT, INSERT | destination, code_hash, code_expires_at, send_count, last_sent_at, attempts, consumed_at | recordSend, reserveAttempt, invalidate, complete* |
| auth_session_verifications | SELECT, INSERT | — | Insert; read in the session join (`auth.ts`) |
| institute_verifications | SELECT, INSERT | mobile_destination, mobile_verified_at, email_destination, email_verified_at, updated_at, **institutional_status, institutional_decided_at, institutional_decided_by, suspended_at, suspended_by** | Contact verification, plus the Super Admin decision route (added 2026-11-14; `authVerificationStore.ts:362-368`) |
| google_identities | SELECT, INSERT | — | link and lookup |
| oauth_states | SELECT, INSERT | consumed_at | consumeOAuthState |
| auth_verification_events | SELECT, INSERT | — | INSERT for all events. SELECT since 2026-11-14 for the Super Admin decision history (`GET /api/admin/institute-verifications/decisions`; A-12 Super Admin read). Still append-only by trigger |
| platform_staff_departments | SELECT, INSERT | — | |
| platform_staff_roles | SELECT, INSERT | — | |
| platform_staff_permission_catalogue | SELECT | — | D-08: never written by the app |
| platform_staff_role_permissions | SELECT | — | D-08: never written by the app |
| platform_staff_accounts | SELECT, INSERT | password_hash, must_change_password, status, deactivated_at, deactivated_by, department_id | `platformStaff.ts:208`, `:239`, `:258` |
| platform_staff_account_roles | SELECT, INSERT | revoked_at, revoked_by | `:261` |
| platform_staff_sessions | SELECT, INSERT | revoked_at | `:199`, `:214`, `:242` |
| platform_staff_audit_events | SELECT, INSERT | — | SELECT for the Super Admin audit view (`:299-306`) |
| org_staff_role_templates | SELECT | — | Seeded by the migration |
| org_staff_members | SELECT, INSERT | password_hash, accepted_at, status, activated_at, activated_by | `organizationStaff.ts:239`, `:303`. **`verified_at` and `verification_method` withheld until C-18 is resolved** |
| org_staff_invitations | SELECT, INSERT | used_at | `:238` |
| org_staff_member_roles | SELECT, INSERT | revoked_at, revoked_by | `:211` |
| org_staff_sessions | SELECT, INSERT | revoked_at | `:281` |
| org_staff_audit_events | INSERT | — | No read path in code (C-03/A-12) |

A future Super Admin MFA migration (see the MFA plan) adds its own entries. `databaseGrants.test.ts` must be extended so that every new table appears exactly once.

## 4. Recommended application order (when separately approved)

1. Disposable-database rehearsal of each proposal individually, then together, on a dedicated test database (G1.0 pattern; never `eltnoy`/`eltnoy_dev`, never host port 5432; S-02).
2. Proposed order in `MIGRATION_FILES`:
   1. existing files;
   2. `authVerificationMigration.sql`;
   3. `platformStaffMigration.sql`;
   4. `organizationStaffMigration.sql`;
   5. (future) Super Admin MFA migration;
   6. `databaseGrantsMigration.sql` (last, with the manifest above).
   The three proposals are independent of each other; all depend on `users` and `auth_sessions` from `schema.sql`.
3. Before AUTH-1 goes live: resolve M-A1, including a backfill decision for existing institutes. Otherwise installing it locks out every Organization Owner.
4. Rehearsal checks:
   - re-run each file twice (idempotency);
   - `db:migrate` with roles provisioned, confirming the grants migration passes;
   - append-only triggers reject UPDATE, DELETE and TRUNCATE;
   - the CHECK rejects `active` without verification;
   - the app role cannot UPDATE withheld columns.

## 5. What was not done

- No SQL was executed.
- No database was contacted.
- No migration file, manifest or runner was edited.
- The DB integration tests (`*.postgres.integration.test.ts`, `institutionSubmission.http.integration.test.ts`) were not run.
