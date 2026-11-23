# SM-2 Executive Review: Staff Management

**Type:** Review only. Static inspection of source, migrations and existing policy documents, plus isolated local tests. **No deployment or live validation. No database access, migration, infrastructure change, source change or Git operation.**
**Date:** 2026-11-14 · **Branch:** `rc/day1-baseline` at `a4da0b3`. SM-1 and AUTH-1 are uncommitted in the working tree.

**Companion documents (`docs/reviews/`):**
- SM2_ROUTE_SECURITY_MATRIX.md
- SM2_POLICY_DECISION_REGISTER.md
- SM2_DATABASE_MIGRATION_REVIEW.md
- SM2_MFA_IMPLEMENTATION_PLAN.md
- SM2_WIREGUARD_DEPLOYMENT_PLAN.md
- SM2_TEST_AND_RELEASE_PLAN.md

## 1. Summary

**What is in place:**
- Two **independent** staff identity systems:
  - Platform Staff, managed by the Super Admin;
  - Organization Staff, managed by the Organization Owner under Q115–Q117.
- Each has its own tables, path-scoped cookie, guards and append-only audit.
- Neither touches `users` or the portal session.
- Every staff route is bound to exactly one surface.
- Undecided features fail closed instead of being guessed: no permission catalogue, no OTP, no work modules.
- Isolated tests pass: 155/155 for the staff, surface, grants and migration files today; 844/844 for the full unit suite earlier the same day.

> **Implementation update (2026-11-14, later the same day):** F03 and the code part of F02 are now implemented in the working tree (uncommitted, not deployed, no database used). See §7. The original review findings below are kept as written, with status notes.

**Staff Management is not ready for go-live.** The three SM-2 policy approvals are not yet met in code or infrastructure, and a cross-module dependency on AUTH-1 would stop Organization Owners from using staff management at all:

1. **Super Admin MFA (approved, mandatory):** not implemented. All 11 Super Admin staff-management routes run on a password-only session.
2. **Admin over WireGuard only (approved):** designed in Compose and the preflight. The host firewall (L-5) and the runtime checks (P1-F) are outstanding; nothing is validated.
3. **72-hour invitation expiry (approved):** the code treats an unset expiry as "invitations unavailable", the stale text says no period is approved, and Compose cannot pass the setting.
4. **AUTH-1 dependency:** no code ever marks an institute "institutionally verified". Once the AUTH-1 tables are installed, no Organization Owner can hold a session, so the Owner staff routes are unreachable.

## 2. Route count (reconciled)

- **25 staff routes.** Registrations and unique method/path pairs are the same number (25); there are no duplicates and no multi-method routes.
- **Split:** Platform Staff 14 (5 staff, 9 Super Admin); Organization Staff 11 (3 Owner, 6 staff, 2 Super Admin).
- **By method:** 10 GET, 13 POST, 2 PUT.
- **By identity:** 11 Super Admin, 3 Owner, 7 staff session, 4 anonymous.
- **Policy agreement:** all 25 have exactly one `ROUTE_POLICY` row (`server/surface.ts:602-633`), and none is unclassified or stale.
- **App-wide:** 114 API method/path registrations equal 114 policy rows, plus `GET *` when `dist/` exists. This is asserted by `server/surface.test.ts:703-720`. **After the §7 update: 120** (6 Super Admin institutional-verification routes added; still 25 staff routes).
- **Other numbers that can appear:** 5 is the router mounts (`server/index.ts:2736-2743`); 35 counts implicit HEAD on the 10 GET routes. Neither is a route count.

## 3. Findings

| ID | Severity | Finding | Evidence | Go-live blocker |
|---|---|---|---|---|
| F01 | High | Super Admin MFA (approved, mandatory) does not exist; the Super Admin session is password-only | `server/auth.ts:380-390`; `server/index.ts:2078`; matrix #6–14, #24–25 | **Yes** |
| F02 | High | `institute_verifications.institutional_status` / `suspended_at` are never set by any code. With AUTH-1 installed, every Owner session is refused (gate `auth.ts:186`), existing institutes have no row, and the Owner staff routes become unreachable | Original evidence: only contact writes in `authVerificationStore.ts` | **Code: RESOLVED** (§7). Still open: backfill/rollout decision for existing institutes; Owners also need verified mobile and email, which stay fail-closed (no SMS/email provider) |
| F03 | High | Approved 72 h invitation expiry versus code: unset TTL means 503 `INVITATIONS_NOT_CONFIGURED`; stale "no period is approved" text; variable absent from Compose, `.env.example` and the preflight | Original evidence: the former `invitationTtlHours()` in `organizationStaff.ts` | **RESOLVED** (§7): fixed 72 h, no environment setting |
| F04 | High | WireGuard-only Admin is not validated. No host firewall (L-5) or Nginx allow-list in the repository; P1-F checks not performed | `docker-compose.yml:228-230`; `deploymentConfig.ts:173-185`; `admin.conf:8-10`; runbook `:543`, `:562`, `:626` | **Yes** |
| F05 | Medium | An expired, unused invitation permanently holds the staff ID (unique per organization; the live-invitation index ignores expiry). No revoke or re-issue route; the stale member stays in the Super Admin activation list | `organizationStaffMigration.sql:58`, `:73`; `organizationStaff.ts:192-204`, `:284-293` | Recommended before invitations |
| F06 | Medium | The 22 tables from the three proposals are absent from the grants manifest. Wiring any proposal in without entries makes `db:migrate` fail and roll back once roles exist (fail closed, but an ordering requirement) | `databaseGrantsMigration.sql:101-124`, `:140`; `migrate.ts:20-26` | Yes (for installation) |
| F07 | Medium (latent) | Organization Staff sign-in and session check only `users.account_status`; they ignore AUTH-1 institute suspension and institutional status. Latent because no member can be active (C-18) | `organizationStaff.ts` `findLoginRecord` and `loadSession` | Before any member is active. **2026-11-14: not implemented. Approved policy does not require it** (SEC-09 covers member suspension only; Q115 and Q118 are silent). Blocked on client decision **M-20** (§8) |
| F08 | Medium | C-18: OTP endpoint is a fixed 503; `verified_at` is never set; activation always refused. Correct per policy, but **no Organization Staff member can become active** | `organizationStaff.ts:474-477`, `:294-301` | Blocks Organization Staff operation, not Platform Staff |
| F09 | Low | Staff sign-in: per-address limiter only (10 per 15 min); no per-account lockout; Platform Staff have no MFA (scope undecided, OI-1) | `staffCommon.ts:118-126`; `platformStaff.ts:380-400` | No |
| F10 | Low | Staff session lifetime inherits the 12 h portal value; a staff-specific value is pending | `staffCommon.ts:17-18`; `auth.ts:29` | No |
| F11 | Low | Schema hardening: organization FK does not enforce the `center` role at the database level; `verification_method` and `code_hash` lack CHECKs | `organizationStaffMigration.sql:39`, `:48`, `:64` | No |
| F12 | Info | Platform Staff is a shell: the permission catalogue is empty (D-08); work queue and activity are unavailable (A-01, A-08, A-05/A-17, C-03/A-12) | `platformStaffMigration.sql:36-41`; `platformStaff.ts:45-48` | No (by design) |

**Positive controls verified in source:**
- Equal-time failure for unknown staff IDs (`staffCommon.ts:25-29`).
- Deactivation revokes every session in the same transaction (`platformStaff.ts:239-243`).
- Composite organization keys prevent cross-tenant rows (`organizationStaffMigration.sql:56`, `:68-99`).
- A CHECK makes `active` impossible without verification and activation (`:53-55`).
- The empty permission catalogue cannot be filled through the API (`platformStaff.ts:509-512`).
- Central enforcement never lets a portal session satisfy a staff route, or the reverse (`surfaceEnforcement.ts:494-500`; `surface.test.ts:431`).

## 4. Policy versus implementation

| Item | Policy | Implementation |
|---|---|---|
| 72 h invitation expiry | **Approved** (SM-2) | Not as approved (F03) |
| Platform Staff on Admin, WireGuard only | **Approved** (SM-2) | Surface binding done; network control designed, not validated (F04) |
| Super Admin MFA before go-live | **Approved** (SM-2) | Not implemented (F01); self-hosted TOTP plan prepared, no provider chosen |
| C-18, D-08, A-01, A-08, A-05/A-17, D-09/C-20, PERM-01/Q118, Q115, C-03/A-12 | **UNRESOLVED** for SM-2 | Fail-closed in code; see the policy register §3 |

At review time, none of the three SM-2 approvals was recorded in `docs/policy/master-policy-register.md`. **Since 2026-11-14 (§8) they are recorded there, with SM2-P04, in section SM.**

## 5. Recommended next steps (each needs separate approval)

1. Record SM2-P01 to P03 in the master register.
2. Build phase:
   - F03: 72 h default, plus the text and test update;
   - F02: Super Admin institutional verification and suspension route, plus the backfill decision;
   - F01: TOTP MFA per the plan;
   - F05 and F07 after the Q115 and OI-4 decisions.
3. Extend the grants manifest and rehearse all migrations on a disposable database.
4. Infrastructure: WireGuard peers, L-5 firewall, the optional Nginx allow-list, and MFA key files; then execute the P1-F checklist.
5. Go-live only when release gates G1–G8 (test and release plan §4) are met.

## 7. Implementation update (2026-11-14)

Built in the working tree on instruction. Not committed, not deployed, no database used, no migration executed, and no schema change.

**A: fixed 72-hour invitation expiry (SM2-P01): implemented.**
- `ORG_STAFF_INVITATION_TTL_HOURS = 72` and `ORG_STAFF_INVITATION_TTL_MS` are constants (`server/organizationStaff.ts:54-56`). The former `invitationTtlHours()`, its environment variable, the `env` router option and the 503 `INVITATIONS_NOT_CONFIGURED` path are removed.
- `GET /api/center/staff` always reports invitations available and adds `invitationExpiryHours: 72`.
- The Owner panel states the 72-hour expiry.
- Comments updated. Revoke and re-issue were deliberately **not** added (F05 stays open).
- Test: `organizationStaff.test.ts` checks an exact 72 h `expiresAt`, acceptance 1 ms before expiry, rejection at exactly 72 h, and that the old environment variable is ignored.

**B: Super Admin institutional verification and suspension (resolves the code part of F02 and OI-5): implemented.**
- **Routes** (`server/instituteVerificationAdmin.ts`, mounted in `server/index.ts`; Admin surface; `ADMIN_GUARDS`):
  - `GET /api/admin/institute-verifications`
  - `GET …/decisions`
  - `POST …/:institutionId/verify`, `…/reject`, `…/suspend`, `…/restore`
- **Policy rows:** `server/surface.ts` (6 `superAdmin` rows). **P0-3 matrix:** `server/adminAuthorization.test.ts`.
- **Separate from Official approval:** `users.account_status` is reported but never read for a decision or written. A pending Institute can be verified institutionally and stays pending.
- **Existing schema only:**
  - verify/reject set `institutional_status`, `institutional_decided_at`, `institutional_decided_by`;
  - suspend sets `suspended_at`, `suspended_by`; restore clears both;
  - a missing state row is created with defaults inside the same transaction (`authVerificationStore.ts:350-384`).
- **Transitions:** verify and reject must change the status; suspend needs an unsuspended institute and restore a suspended one. Anything else is a 409 that writes nothing (rolled back).
- **Audit:** one append-only `auth_verification_events` row per decision. `user_id` holds the target; `details` holds `actorId`, `actorKind`, `targetInstitutionId`, `decision`, `reason` and the previous state. The reason (10–500 characters, strict body) is mandatory.
- **Effect:** enforced by the existing gate on every request (`portalVerificationGate`). Suspension gives `INSTITUTE_SUSPENDED`; rejected or pending status gives `INSTITUTE_VERIFICATION_INCOMPLETE`.
- **Fails closed:** if the AUTH-1 tables are missing, every route answers 503 `VERIFICATION_NOT_INSTALLED` and nothing is written.
- **UI:** a new Super Admin-only tab, "Institutional verification" (`src/components/admin/InstituteVerificationPanel.tsx`; tab gate `canSeeAdminTab`, `src/utils/adminPermissions.ts`). It shows Official approval read-only, masked contact status, and the offered decisions (`src/utils/instituteVerification.ts`), asks for a reason, and shows the decision history.
- **Unchanged:** SMS and email remain fail-closed; no provider was added.

**Verification:**
- `node --import tsx --test` on every unit test file with `*integration*` excluded: 859 tests, 859 pass.
- `npx tsc --noEmit`: passed. `npm run build`: passed.
- The new `server/instituteVerificationAdmin.test.ts` has 8 tests: Super Admin-only for all 6 routes; transitions; audit fields; Official approval untouched; strict reason; 404 for non-Institutes; gate effect; 503 when not installed; PostgreSQL store against a scripted pool (one transaction, `FOR UPDATE`, rollback on refusal, no schema); and a static check.

**Still open after this update:**
- F01 (MFA). The 6 new routes are also password-only Super Admin routes.
- F04 (WireGuard validation), F05, F06 (manifest; the column list changed, see the database review §3), F07.
- Backfill/rollout for existing institutes.
- Recording SM2-P01 to P03 in the master register (done in §8).

## 8. F07 assessment and policy recording (2026-11-14)

**F07 was not implemented, because policy does not settle it.** Policy texts checked:
- **Q115** (`master-policy-register.md:85-94`): no access before *member* activation.
- **Q118** (`:129-140`): access restricted to the member's own organization.
- **SEC-09** (`policy-conflict-and-gap-register.md:75`), roadmap (`implementation-roadmap.md:250`, `:262`) and checklist (`milestone-acceptance-checklist.md:76`): revoke sessions and refuse access when a *member* is suspended or removed.

None of these says what an **Institute's** suspension or failed institutional verification means for its staff. Implementing a cascade would decide policy, so it is registered as missing decision **M-20** with options:
- **(A)** refuse staff whenever the Institute is suspended or not institutionally `verified`, mirroring the Owner gate. Recommended: fail closed.
- **(B)** suspension only.
- **(C)** no effect.

Current behaviour is unchanged: staff sign-in and sessions require the organization's `users.account_status = 'approved'`. The gap is still latent, because no member can be active (C-18).

**Next safe task done instead: release gate G6.** This is documentation only; no code changed.
- **Master register:** new section **SM** (`master-policy-register.md`) with SM2-P01 and SM2-P04 as IMPLEMENTATION_APPROVED (built, uncommitted), and SM2-P02 and SM2-P03 as DISCUSSION_APPROVED (policy approved; infrastructure and MFA implementation need separate approval).
- **Gap register:** M-14 and SEC-07 marked partly settled by SM2-P03. New missing decisions **M-20 to M-27**:

| ID | Decision | SM-2 item |
|---|---|---|
| M-20 | Institute status cascades to staff | F07 / OI-4 |
| M-21 | Who suspends or removes staff; revoke or re-issue invitations | F05 / Q115 remainder |
| M-22 | Staff session lifetime | OI-2 |
| M-23 | Per-account lockout | OI-3 |
| M-24 | MFA recovery and step-up window | OI-6 |
| M-25 | WireGuard key rotation; Admin certificate issuance | OI-7 |
| M-26 | Rollout for existing institutes | — |
| M-27 | Confirm the SM2-P04 transition rule | — |

**Verification after this step:** see SM2_TEST_AND_RELEASE_PLAN.md §1.

## 6. Constraints and assurances for this review

- **Inspected:** source, SQL files, Compose, Nginx and policy documents.
- **Run:**
  - the isolated tests listed above;
  - a read-only route enumeration script kept in the session scratchpad, outside the repository. It imported the app with a placeholder `DATABASE_URL` (no connection, no listener).
- **Not done:**
  - no database contact;
  - no migration execution;
  - no DB integration test;
  - no change to application source, migrations, env or secrets, Docker, Compose, Nginx or deployment files;
  - no Git staging, commit, push, reset, branch switch, stash or clean.
- **The only files created by the review itself were the seven documents in `docs/reviews/`.** The §7 implementation later changed source and tests as listed there. It did not change migrations, env/secrets, Docker, Nginx, deployment files or Git history.
