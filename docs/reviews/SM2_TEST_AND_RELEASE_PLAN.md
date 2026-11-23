# SM-2 Test and Release Plan (Staff Management)

**Status:** Plan. Test results quoted here come from local isolated runs on 2026-11-14 with no database. **No deployment, staging or live validation has been performed.**
**Date:** 2026-11-14.

**Implementation and verification update (2026-11-17):** The two Staff migrations are now in the supported runner and have exact grants for all 14 Staff tables. Static grant/runner tests pass. The current full test suite passes 1,093 tests with 40 skipped, plus 27 verifier tests and 12 Official-auth foundation static tests; type-check and build pass. PostgreSQL migration/runtime tests, staging, and production have not been run, so the deployment gates below remain open.

## 1. Evidence available today (isolated tests only)

| Command | Result (2026-11-14) | Notes |
|---|---|---|
| `node --import tsx --test server/platformStaff.test.ts server/organizationStaff.test.ts server/staffMigrations.test.ts server/surface.test.ts server/surfaceWiring.test.ts server/surfaceEnforcement.test.ts server/databaseGrants.test.ts server/migrate.test.ts` | 155 tests, 155 pass, 0 fail | Run during this review; read-only |
| Full unit suite (the `npm test` file list **with every `*integration*` file excluded**) | 844 pass, 0 fail | Run earlier the same day in the AUTH-1 session; no source changed since |
| Same full unit suite after the 2026-11-14 implementation (72 h expiry, institutional verification) | **859 pass, 0 fail**; `tsc --noEmit` and `npm run build` passed | Integration files excluded; no database |
| `npx tsc --noEmit`; `npm run build` | Passed | Same AUTH-1 session |

**How these tests isolate themselves:**
- Stores are in memory, or the pool is stubbed; the DB integration tests are opt-in (`ELTNOY_*_INTEGRATION=1`) and were not run.
- The `npm test` glob `server/*.test.ts` also matches the four `*.integration.test.ts` files. They skip without their opt-in variable, but **release runs should exclude them explicitly** so a stray environment variable can never reach a database.

**Existing coverage relevant to SM-2:**
- Route completeness and guard agreement: `surface.test.ts:703`, `:777`.
- Staff confinement: `surface.test.ts:431`.
- Platform Staff (Super Admin-only management, sign-in, forced password change, deactivation, separation, no self-granted permissions, A-12 audit, not installed): `platformStaff.test.ts:46-258`.
- Organization Staff (TTL required, Owner-only, codes, C-18, tenant isolation, Q117, separation): `organizationStaff.test.ts:43-221`.
- Static migration checks: `staffMigrations.test.ts:12-87`.

## 2. Tests to add before go-live (by finding)

| Finding | Test (isolated unless stated) |
|---|---|
| F01 MFA | Every item in SM2_MFA_IMPLEMENTATION_PLAN.md §8; plus "all 11 staff-management Super Admin routes refuse a session without MFA evidence" |
| F02 Institutional verification | **Added 2026-11-14:** `server/instituteVerificationAdmin.test.ts` (8 tests: Super Admin-only on all 6 routes; transitions; audit actor, target, action and reason; Official approval untouched; strict reason; 404 for non-Institutes; gate effect; 503 when not installed; PostgreSQL store transaction and rollback against a scripted pool; static no-schema check), `src/utils/instituteVerification.test.ts`, 6 P0-3 matrix entries. Still to add: a disposable-database run of the decision transaction |
| F03 72 h TTL | **Added 2026-11-14:** exact `expiresAt` = now + 72 h, accepted 1 ms before expiry, rejected at exactly 72 h, and the former environment variable ignored (`organizationStaff.test.ts`) |
| F05 Expired invitation | Re-issue or revoke behaviour once Q115 is decided. An expired, unused invitation does not block a new invitation forever. The activation list excludes or labels expired invitations |
| F07 Suspension | **Blocked on decision M-20** (not implemented 2026-11-14; policy does not require it). Once decided: Organization Staff login and every staff request refused per the chosen option (suspended, and/or not institutionally `verified`), including existing sessions; Owner gate unchanged |
| F06 Grants | `databaseGrants.test.ts` covers all 22 proposed tables exactly once with the column lists in SM2_DATABASE_MIGRATION_REVIEW.md §3. The withheld columns (`org_staff_members.verified_at`, `verification_method`) are absent until C-18 is resolved. `institute_verifications.institutional_*` and `suspended_*` are now granted for SM2-P04 |
| Concurrency | Stale-snapshot technique (`authVerification.test.ts`, concurrency test): parallel invitation acceptance with the same code (exactly one wins), parallel activation, parallel deactivate versus login |
| C-18 OTP (when approved) | Q116 OTP rate limiting, attempts and expiry; no fixed code (extend the static scan) |

## 3. Database rehearsal (disposable database only; separately approved)

1. Use only a dedicated, disposable database. Never `eltnoy` or `eltnoy_dev`, never host port 5432 (S-02).
2. Apply the existing `MIGRATION_FILES`, then each proposal individually, twice (idempotency).
3. Provision roles (`databaseRoleBootstrap.sql`) and run `db:migrate` with the extended manifest. Expect success. Expect **failure** with a manifest entry removed (fail closed).
4. Verify:
   - append-only triggers on all three audit tables;
   - the active-member CHECK;
   - the app role cannot update the withheld columns.
5. Run the opt-in DB integration tests **only against that disposable database** and only with approval.

## 4. Release gates (all required before Staff Management go-live)

| Gate | Requirement | Current state |
|---|---|---|
| G1 | **Super Admin MFA implemented, every Super Admin enrolled, enforcement on** (SM2-P03) | Not started (F01) |
| G2 | **Admin reachable only over WireGuard:** host firewall L-5 in place and the §5 checklist of the WireGuard plan executed and recorded (SM2-P02) | Designed in Compose and preflight; not validated (F04) |
| G3 | 72 h invitation expiry implemented as approved, and reachable in the deployed configuration (SM2-P01) | **Met in code 2026-11-14** (fixed constant, no environment dependency); uncommitted |
| G4 | AUTH-1 institutional verification and suspension route exists; backfill decided for existing institutes | **Route and UI implemented 2026-11-14** (SM2-P04); rollout/backfill decision still open |
| G5 | Migrations rehearsed; manifest extended; `MIGRATION_FILES` order approved | Proposals only (F06) |
| G6 | Policy approvals SM2-P01 to P03 recorded in `master-policy-register.md` | **Met 2026-11-14:** section SM (with SM2-P04); open decisions M-20 to M-27 in the gap register |
| G7 | Unresolved items handled: each stays fail-closed, and the UI states unavailability (C-18, D-08, A-01, A-08, A-05/A-17, D-09/C-20, PERM-01/Q118, Q115, C-03/A-12) | Fail-closed in code today |
| G8 | Full isolated suite, TypeScript check and build green on the release commit; integration files excluded or run only against the disposable database | Green on the working tree; nothing committed |

**What can go live without C-18 being resolved:**
- **Platform Staff:** account management, sign-in and dashboard shell, once G1, G2, G5 and G6 are met.
- **Organization Staff** can at most issue and accept invitations (with G3 and G4). **No member can become active** until an SMS provider is approved. Communicate this clearly.

## 5. Release sequence (each step needs its own approval; none is authorized by this review)

1. Code changes for F01, F02, F03 (and F05 and F07 once decided), with the tests in §2.
2. Commit on a branch after review (no commit was made during SM-2).
3. Disposable-database rehearsal (§3).
4. Infrastructure: WireGuard peers, L-5 firewall, the optional Nginx allow-list, key files for MFA, and Compose variables. Then the P1-F validation checklist.
5. Production migration in the approved order, run by the operator through the deployment wrapper.
6. Enrol every Super Admin in MFA, then enable enforcement.
7. Enable Staff Management. Monitor the audit events (`platform_staff_audit_events`, `org_staff_audit_events`), MFA events and WireGuard handshakes.

**Rollback:**
- Application rollback by redeploying the previous image.
- The migrations are additive, so the tables remain. The API never deletes rows, and rolling back code leaves the staff routes answering according to the older code.
- **Do not drop tables** without a separately approved and rehearsed plan.

## 6. Known constraints

- No provider of any kind is configured: no SMS, email or Google (AUTH-1). Student and Institute sign-in fail closed until providers exist.
- All staff routes answer 503 `STAFF_NOT_INSTALLED` until the staff migrations are applied (`server/index.ts:2733-2734`; `staffCommon.ts:100-102`).
- Compose passes no `AUTH_*` or `GOOGLE_OAUTH_*` variables (explicit `environment:` lists, no `env_file`). Enabling them is an infrastructure change. Since 2026-11-14 the invitation expiry needs no variable (fixed 72 h), so `ORG_STAFF_*` is no longer relevant.
- The staff session lifetime equals the portal lifetime (12 h) until OI-2 is decided.
- Nothing in SM-1, AUTH-1 or SM-2 has been committed; the working tree holds the changes.
