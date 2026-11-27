# Integration readiness: `audit-log` worktree

**Date:** 2026-11-27. **Engineering is paused.** Nothing has been committed, merged or deployed. This document prepares the next integration stage. It does not perform it.

## 1. Frozen state (verified 2026-11-27)

| Item | Value |
|---|---|
| Worktree | `/Users/rahuldhakad/ethonoy/ethnoy/.claude/worktrees/audit-log` |
| Branch | `audit-log` (local only, never pushed) |
| Base commit | `1dd6145`, "test(auth): type the password sign-in refusal cases". This equals `origin/vps-deploy` and the main checkout's `HEAD`. Live production runs `ee5a049`, which differs only in a test file. |
| Commits on `audit-log` | **None.** All changes are uncommitted in the working tree. |
| Tracked files changed | 21 (853 insertions, 96 deletions) |
| New files | 16 (12 code and test files, plus `documentation/`) |
| Untracked symlink | `node_modules` → the main checkout's `node_modules`, so tests can run here. **Never commit it.** The `.gitignore` rule `node_modules/` does not match a symlink. |
| Stash | `stash@{0}`, an old local-preview copy owned by an earlier session. Untouched. |
| Other worktrees (not ours, untouched) | `/private/tmp/eltnoy-head-check` (`c130b46`, prunable); `.claude/worktrees/eltnoy-portal-completion-134a7a` (`ee5a049`, clean, created 2026-11-27 19:36 by another session) |
| Workspace work (another tool) | **Uncommitted changes in the main checkout** on `vps-deploy`. It is not a branch. See section 4. |

## 2. Every changed file

### 2.1 New files

| File | Lines | Purpose |
|---|---|---|
| `server/audit.ts` | 263 | A-11 writer: contracts and allow-lists, transactional writer, separate writer for refusals |
| `server/auditRoutes.ts` | 147 | A-12 Super Admin viewer `GET /api/admin/audit-events` |
| `server/auditEventsMigration.sql` | 110 | `audit_events` table, append-only triggers, row hash, indexes |
| `server/audit.test.ts` | 323 | Writer, redaction, viewer, migration and refusal tests |
| `server/meritList.ts` | 222 | Merit ordering, tie groups, validation, fingerprint, CSV |
| `server/meritListRoutes.ts` | 207 | Five Super Admin merit routes |
| `server/meritListMigration.sql` | 46 | `merit_list_snapshots` (append-only, draft-only) |
| `server/meritList.test.ts` | 293 | Computation, CSV, route transaction and duplicate tests |
| `src/components/admin/AuditLogPanel.tsx` | 140 | "Audit log" tab |
| `src/components/admin/MeritListPanel.tsx` | 162 | "Merit lists" tab |
| `src/utils/auditLogSearch.ts`, `.test.ts` | 25, 22 | Viewer query builder and its tests |
| `documentation/*.md` | — | Project audit, tracker, backlog, merit gap analysis, this file, client decisions |

### 2.2 Modified tracked files

| File | Change |
|---|---|
| `server/index.ts` | 33 handlers write audit events in their transaction. Single-statement handlers were moved into `inAuditedTransaction`. The audit and merit routers are mounted. Refused and failed money events are recorded. Adds `CREDIT_REFERENCE_EXISTS_SQL`. |
| `server/authVerificationStore.ts` | Institutional verification decisions also write `institution.verification_decided` (same transaction) |
| `server/institutionDocuments.ts` | A document review note and its audit row commit together. The response shape is unchanged. |
| `server/surface.ts` | 6 Super Admin routes added to `ROUTE_POLICY` |
| `server/migrate.ts` | `auditEventsMigration.sql` and `meritListMigration.sql` added before the grants migration |
| `server/databaseGrantsMigration.sql` | `audit_events` and `merit_list_snapshots`: `SELECT, INSERT` only |
| `src/components/RolePortal.tsx` | Two Super Admin tabs |
| `src/utils/adminPermissions.ts` | `audit-log` and `merit-lists` tabs are Super Admin only |
| Tests | `adminAuthorization`, `instituteApproval`, `instituteResubmission`, `institutionDocuments`, `roleLookupSecurity`, `migrate`, `databaseGrants`, `databaseGrants.postgres.integration`, `surfaceWiring`, `adminPermissions` |
| Docs | `README.md` (migration list), runbook (§3.1 table, §3.13 audit, §3.14 merit), `docs/policy/master-policy-register.md` (sections AL and ML; A-11 and A-12 marked "Code only") |

## 3. What the integration brings

### 3.1 Database

| Item | Detail |
|---|---|
| New tables | `audit_events`, `merit_list_snapshots` (52 → 54 tables) |
| New functions | `audit_events_reject_mutation`, `audit_events_set_row_hash`, `merit_list_snapshots_reject_mutation`, all owned by `eltnoy_owner` |
| Triggers | Both tables reject `UPDATE`, `DELETE` and `TRUNCATE` for every role. `audit_events` sets the row hash on insert. |
| Sequences | None (the grants manifest allows none) |
| Grants | `eltnoy_app`: `SELECT, INSERT` on both tables. No `UPDATE` or `DELETE`. |
| Data changes | **None.** Additive and re-runnable. |
| Migration order (this branch) | … `studentEmailOtpMigration.sql` → `auditEventsMigration.sql` → `meritListMigration.sql` → `databaseGrantsMigration.sql` (14 files) |

### 3.2 Routes and surfaces

All new routes are on the Admin host only and are Super Admin only (`requireAuth`, `requireRoles('official')`, `requireSuperAdmin`, plus a `ROUTE_POLICY` entry):

- `GET /api/admin/audit-events`
- `GET /api/admin/merit-lists/:examCode/preview`
- `GET /api/admin/merit-lists/:examCode/snapshots`
- `POST /api/admin/merit-lists/:examCode/snapshots`
- `GET /api/admin/merit-lists/snapshots/:snapshotId`
- `GET /api/admin/merit-lists/snapshots/:snapshotId/export`

Nothing changes on the Exam, Institution or Marketing hosts. The mounted router count goes from 9 to 11.

### 3.3 Behaviour changes to existing routes

- Many admin and institute writes now run in a transaction with an audit insert. **If an audit insert fails, the action fails (500) and rolls back.** This is A-11, by design.
- `PATCH /api/admin/institute-forms/:id` now reads `institute_id` internally. Its response is unchanged.
- The responses for credits and withdrawals are unchanged. Refusals are now also recorded.

### 3.4 Security implications

| Area | Effect |
|---|---|
| Access | Only Super Admin reads audit or merit data. Ordinary Officials gain nothing. Institutes and Students have no new route. |
| Privacy | No passwords, codes, tokens, contact details, dates of birth, answers, scores or document text are recorded (allow-lists plus a CHECK). No IP or user agent is collected. |
| Integrity | Append-only tables and row hashes make tampering by the application impossible. Tampering by a database superuser is detectable, not preventable. |
| Availability | An audit outage blocks audited actions (fail closed). Watch the `audit.write_failed` logs. |

### 3.5 Tests (last full run, 2026-11-27)

| Check | Result |
|---|---|
| `npm test` | 1,240 tests: 1,197 passed, **0 failed**, 43 skipped |
| `tsc --noEmit` | Passed |
| `vite build` | Passed (928 kB chunk warning, as before) |
| `git diff --check` | Clean |
| `scripts/run-disposable-grants-tests.sh` (disposable PostgreSQL 17) | **36 of 36 passed** |

## 4. Merge plan with the Workspace work (do not perform yet)

**Facts:**
- The Workspace work is **uncommitted** in the main checkout. It has no branch and no commit.
- It is based on the same commit, `1dd6145`.
- It was last edited 2026-11-27 16:04, and nobody has reviewed it.

**Recommended sequence:**

1. The owner decides F-4, the client decision on whether institutes may publish their own results and admit cards (A-04/A-06).
2. The Workspace author finishes, and the owner commits the Workspace to **its own branch** (for example `institute-workspace`) without touching `vps-deploy`.
3. The owner commits `audit-log` to its branch.
4. Merge into a **new integration branch** cut from `vps-deploy`: `audit-log` first (smaller, fully tested), then `institute-workspace`.
5. Resolve the conflicts in the table below.
6. Run every test in section 5 before any deploy.

### 4.1 Overlapping files

| File | `audit-log` changes | Workspace changes | Conflict | Reconciliation | Tests after merge |
|---|---|---|---|---|---|
| `server/index.ts` | +330 lines: audit imports, transactions in 33 handlers, two routers mounted after `createInstituteVerificationAdminRouter()` | +2 lines: an import after the `instituteVerificationAdmin` import, and `app.use('/api', createInstituteWorkspaceRouter())` after `organizationStaff.adminRouter` | **Textual** in the import block (both insert after the same line). The `app.use` lines are in different places. | Keep both imports and both mounts. Mount order does not matter for policy, since the route-policy gate runs first. | `surfaceWiring`, `adminAuthorization`, full suite |
| `server/surface.ts` | +6 `superAdmin(...)` entries after `data-export` | +51 `institution(...)` entries after the documents routes | Probably none (different hunks) | Keep both | `surface`, `surfaceEnforcement`, `surfaceWiring`, route registry test |
| `server/migrate.ts` | `auditEventsMigration.sql`, `meritListMigration.sql` after `studentEmailOtpMigration.sql` | `instituteWorkspaceMigration.sql` at the same place | **Textual** (same insertion point) | Order: `studentEmailOtp` → `auditEvents` → `meritList` → `instituteWorkspace` → `databaseGrants` (15 files). None depends on another; grants must stay last. | `migrate.test`, disposable PostgreSQL run |
| `server/migrate.test.ts` | Expected list plus the adjacency assertion `studentEmailOtp == auditEvents - 1` | Expected list plus `studentEmailOtp == instituteWorkspace - 1` and `instituteWorkspace == grants - 1` | **Textual and logical**: the adjacency assertions contradict each other | Rewrite to the order above: `studentEmailOtp == auditEvents - 1`, `meritList == instituteWorkspace - 1`, `instituteWorkspace == grants - 1` | `migrate.test` |
| `server/databaseGrantsMigration.sql` | +2 manifest rows after `auth_verification_events` | +25 manifest rows after `org_staff_audit_events` | Probably none (different hunks) | Keep both | `databaseGrants.test`, PostgreSQL catalog test |
| `server/databaseGrants.test.ts` | Table count 52 → 54 | Table count 52 → 77 | **Textual** (same line) | Count becomes **79**, with a message listing both | `databaseGrants.test` |
| `server/surfaceWiring.test.ts` | Router count 9 → 11, plus a comment | Router count 9 → 10, plus a comment | **Textual** (same lines) | Count becomes **12**. Merge the comments. | `surfaceWiring.test` |
| `server/databaseGrants.postgres.integration.test.ts` | Manifest expectation includes `audit_events` and `merit_list_snapshots`; new audit, merit and MFA assertions | **Not updated.** Its manifest expectation lacks the 25 Workspace tables. | Logical: the catalog test **will fail** once the Workspace migration exists | Add the Workspace tables (and their grant expectations) to the expectation | Disposable PostgreSQL run |
| `src/components/InstituteAdvancedSection.tsx`, `InstituteZonePage.tsx` | Not touched | +2,133 lines, plus a new file | None | — | Frontend tests, build, browser check |

### 4.2 Semantic conflicts (not visible as textual conflicts)

1. **Workspace writes are not audited.** `server/instituteWorkspace.ts` has 0 `recordAuditEvent` calls. After the merge, A-11 requires audit events for:
   - Workspace result status changes and publication;
   - hall-ticket release;
   - refunds;
   - application reviews;
   - staff-related actions.
2. **A-04 / A-06 conflict.** The Workspace lets an institute owner set results to `published` directly (no state check, no Super Admin) and release admit cards. It must not ship until F-4 is decided and the code follows it.
3. **Workspace permissions.** Workspace routes use `requireRoles('center')` only (owner-only), with no Organization Staff permissions. This is a decision for Q117–Q119.
4. **Workspace results versus the merit foundation.** `institute_exam_results` is a separate results table from `published_results`. The merit foundation reads only `published_results`. Institute merit lists remain ML-8 / F-4.

## 5. Required verification after integration

1. `npm test`: 0 failures.
2. `npx tsc --noEmit` and `vite build`.
3. `git diff --check`.
4. `scripts/run-disposable-grants-tests.sh`: all pass, with the catalog test including all 79 tables.
5. Rehearse the migration on a **restored copy of production** (runbook §3) with the 15-file order, and confirm it is re-runnable.
6. Browser check on staging or a local preview:
   - Super Admin "Audit log" and "Merit lists" tabs;
   - Institute dashboard;
   - ordinary Officials do not see the new tabs.
7. After deploy:
   - `migrate` ran;
   - one audited action creates an `audit_events` row (Super Admin viewer);
   - no `audit.write_failed` lines in the API logs.

## 6. Rollback considerations

- **Code:** redeploy the previous release folder (the runbook rollback). Old code ignores the new tables.
- **Database:** both migrations are additive. **Never drop `audit_events` or `merit_list_snapshots` in production.** The triggers block deletion, and keeping them is harmless to old code. Take a backup before `migrate`, as for every migration.
- **Mixed versions:** new and old API code can run against the migrated schema. Old code writes no audit rows during the overlap. Deploy both API instances together.
- **Workspace:** its migration adds 25 tables. Roll it back the same way (leave the tables; redeploy old code).
