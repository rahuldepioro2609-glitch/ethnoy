# SM-2 Route Security Matrix (Staff Management)

**Status:** Review only. Built from static source inspection plus a read-only enumeration of the live Express route stack (the app was imported with a placeholder `DATABASE_URL`, the same way the existing tests do; nothing listened and no database was contacted). **No deployment or runtime validation was performed.**
**Date:** 2026-11-14 · **Branch:** `rc/day1-baseline` at `a4da0b3` plus the uncommitted SM-1/AUTH-1 working tree.

## 1. Route count reconciliation

| Measure | Value | How it was obtained |
|---|---|---|
| Staff route **registrations** (Express route layers × methods) | **25** | Walk of `app._router.stack` and the five routers mounted at `/api` (`server/index.ts:2735-2743`) |
| Staff **unique method/path pairs** | **25** | The same walk; no path is registered twice and no route layer carries more than one method |
| Staff rows in `ROUTE_POLICY` | **25** | `server/surface.ts:602-633` |
| Registered but missing from policy / policy rows not registered | **0 / 0** | Set difference between the two |
| App-wide API registrations = `ROUTE_POLICY` rows | **114** (+1 `GET *` SPA fallback only when `dist/` exists) | Asserted by the repository's completeness test, `server/surface.test.ts:703-720` (passing) |
| AUTH-1 verification/Google routes (not staff; listed for context) | 8 | Same walk (`server/authVerification.ts`) |

**Registrations versus pairs:** for the staff modules the two numbers are the same (25), so either wording is correct. Three other counts could cause confusion:
- **5:** the number of router *mounts* in `server/index.ts:2736-2743` (Platform `staffRouter` and `adminRouter`; Organization `ownerRouter`, `staffRouter` and `adminRouter`), not routes.
- **35:** counting HEAD separately. Express answers HEAD through the 10 GET routes, but HEAD is not a separate registration and the policy table does not count it (`server/surface.ts:11-12`).
- **14 + 11:** the split by module: Platform Staff has 5 staff routes and 9 Super Admin routes; Organization Staff has 3 Owner, 6 staff and 2 Super Admin routes.

**By method:** 10 GET, 13 POST, 2 PUT (DELETE and PATCH: 0).
**By required identity:** 11 Super Admin, 3 Organization Owner (`center`), 7 staff session, 4 anonymous.

## 2. How a staff request is guarded (three layers)

1. **Surface and listener binding (central):** `identify` maps the trusted listener and the original host to one surface and rejects untrusted peers (`server/surfaceEnforcement.ts:560-588`). An Origin check runs next (`:590-608`). The route policy then denies every staff path on the wrong surface with 404 (`:610-635`).
2. **Central session check:** this runs only for `session`, `candidate`, `center`, `official` and `super_admin` (`SESSION_REQUIREMENTS`, `server/surfaceEnforcement.ts:494-500`). For `platform_staff`, `org_staff` and `anonymous` the gate does **no** session lookup (`:636-640`). The module's own route guard is then the only staff-session control (`server/surface.ts:390-391`).
3. **Route middleware:** the guard chain registered on each route (table below), followed by store-level preconditions inside SQL.

Portal sessions (`elt_session`) go through `authenticateRequest`, which also applies the AUTH-1 gate `portalVerificationGate` (`server/auth.ts:186`, applied at `:328`). For an Official or Super Admin the gate is a no-op. For a `center` (Organization Owner) session it requires verified mobile and email, `institutional_status = 'verified'` and no suspension.

## 3. Matrix

Abbreviations:
- **SA chain:** `requireAuth > requireRoles('official') > requireSuperAdmin` (`ADMIN_GUARDS`, `server/platformStaff.ts:325`, `server/organizationStaff.ts:342`).
- **Owner chain:** `requireAuth > requireRoles('center')` (`OWNER_GUARDS`, `server/organizationStaff.ts:343`).
- **Limiter:** `createStaffAuthLimiter()`, 10 requests per 15 minutes per client address (`server/staffCommon.ts:118-126`).

### 3.1 Platform Staff: 14 routes, Admin surface only

| # | Method and path | Registered | Policy row | Surface | Central check | Route chain (actual) | Identity and store preconditions | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | POST `/api/platform-staff/auth/login` | `platformStaff.ts:380` | `surface.ts:604` | admin | none (anonymous) | Limiter > handler | `status='active'`, bcrypt; equal timing for unknown IDs (`staffCommon.ts:25-29`); generic failure | No per-account lockout; **no MFA** |
| 2 | GET `/api/platform-staff/auth/me` | `:402` | `:605` | admin | none (platform_staff) | `requirePlatformStaffSession` | `elt_platform_staff` cookie, path `/api/platform-staff`; session unrevoked, unexpired, account active (`platformStaff.ts:189-197`) | Allowed while the password must still change |
| 3 | POST `/api/platform-staff/auth/logout` | `:407` | `:606` | admin | none | `requirePlatformStaffSession` | Revokes its own token | — |
| 4 | POST `/api/platform-staff/auth/password` | `:414` | `:607` | admin | none | `requirePlatformStaffSession` | Current password re-checked; other sessions revoked (`:214`) | No limiter on current-password guesses beyond the session itself |
| 5 | GET `/api/platform-staff/dashboard` | `:434` | `:608` | admin | none | `requirePlatformStaff` (blocks while the password must change) | As #2, plus `mustChangePassword = false` | Work queue and activity are deliberately unavailable (D-08, A-12) |
| 6 | GET `/api/admin/platform-staff` | `:447` | `:610` | admin | super_admin | SA chain | `elt_session` Official with `is_super_admin` | **No MFA** (F01) |
| 7 | POST `/api/admin/platform-staff` | `:451` | `:611` | admin | super_admin | SA chain | Strict schema; bcrypt cost 12 | **No MFA**; no step-up |
| 8 | POST `/api/admin/platform-staff/:id/deactivate` | `:471` | `:612` | admin | super_admin | SA chain | Reason of 10–500 characters; every session revoked in the same transaction | No reactivation route (by design) |
| 9 | PUT `/api/admin/platform-staff/:id/assignment` | `:480` | `:613` | admin | super_admin | SA chain | Strict schema; at most 20 roles | Roles carry no permissions (catalogue empty, D-08) |
| 10 | GET `/api/admin/platform-staff/departments` | `:492` | `:614` | admin | super_admin | SA chain | — | — |
| 11 | POST `/api/admin/platform-staff/departments` | `:496` | `:615` | admin | super_admin | SA chain | Strict schema | — |
| 12 | GET `/api/admin/platform-staff/roles` | `:505` | `:616` | admin | super_admin | SA chain | Returns the (empty) catalogue | — |
| 13 | POST `/api/admin/platform-staff/roles` | `:511` | `:617` | admin | super_admin | SA chain | Strict schema rejects a `permissions` field | — |
| 14 | GET `/api/admin/platform-staff/audit` | `:520` | `:618` | admin | super_admin | SA chain | Last 200 events | A-12: Super Admin read only |

### 3.2 Organization Staff: 11 routes

| # | Method and path | Registered | Policy row | Surface | Central check | Route chain (actual) | Identity and store preconditions | Notes |
|---|---|---|---|---|---|---|---|---|
| 15 | GET `/api/center/staff` | `organizationStaff.ts` | `surface.ts:621` | institution | center (plus the AUTH-1 gate) | Owner chain | Organization = the Owner's own `users.id` | Since 2026-11-14 always reports invitations available, with `invitationExpiryHours: 72` |
| 16 | POST `/api/center/staff/invitations` | `organizationStaff.ts` | `:622` | institution | center | Owner chain | `expiresAt` = now + 72 h (fixed, SM2-P01) | F03 resolved; there was a 503 path before 2026-11-14 |
| 17 | PUT `/api/center/staff/:id/roles` | `:411` | `:623` | institution | center | Owner chain | The six Q117 templates only; member scoped to the organization | — |
| 18 | POST `/api/org-staff/invitations/accept` | `:446` | `:625` | institution | none (anonymous) | Limiter (`acceptLimiter`) > handler | Hash match, unused, unexpired, `status='invited'`, organization `center` and `approved` (`:225-242`) | No session is created |
| 19 | POST `/api/org-staff/verification/otp` | `:475` | `:626` | institution | none (anonymous) | Handler only (always 503 `OTP_UNAVAILABLE`) | — | C-18 stub; **no limiter** (none needed while it is static; Q116 requires one once it is implemented) |
| 20 | POST `/api/org-staff/auth/login` | `:479` | `:627` | institution | none (anonymous) | Limiter (`authLimiter`) > handler | `status='active'`, organization approved, password set (`:486`) | Currently unreachable: no member can be active (C-18) |
| 21 | GET `/api/org-staff/auth/me` | `:502` | `:628` | institution | none (org_staff) | `requireOrgStaff` | `elt_org_staff` cookie, path `/api/org-staff`; member active; organization `center` and `approved` (`:263-279`) | Ignores AUTH-1 suspension (F07) |
| 22 | POST `/api/org-staff/auth/logout` | `:508` | `:629` | institution | none | `requireOrgStaff` | — | — |
| 23 | GET `/api/org-staff/dashboard` | `:515` | `:630` | institution | none | `requireOrgStaff` | — | Work queue and activity unavailable (D-08, PERM-01/Q118, D-09/C-20, C-03/A-12) |
| 24 | GET `/api/admin/organization-staff` | `:529` | `:632` | admin | super_admin | SA chain | Members with status `invited`, at most 500 | Expired invitations remain listed (F05); **no MFA** |
| 25 | POST `/api/admin/organization-staff/:id/activate` | `:534` | `:633` | admin | super_admin | SA chain | Needs `accepted_at` and `verified_at`; the database CHECK also requires them (`organizationStaffMigration.sql:53-55`) | Always refuses today (C-18) |

### 3.3 Related Super Admin routes added 2026-11-14: institutional verification and suspension (not staff routes)

These 6 routes are not counted in the 25 staff routes. With them, the app-wide total is **120** API registrations, equal to the policy rows.

| # | Method and path | Registered | Surface | Central check | Route chain | Preconditions and effect |
|---|---|---|---|---|---|---|
| I-1 | GET `/api/admin/institute-verifications` | `server/instituteVerificationAdmin.ts` | admin | super_admin | SA chain | Lists Institutes only; Official approval read-only; contacts masked |
| I-2 | GET `/api/admin/institute-verifications/decisions` | same | admin | super_admin | SA chain | Decision audit read (A-12: Super Admin only) |
| I-3 | POST `…/:institutionId/verify` | same | admin | super_admin | SA chain | Reason 10–500 characters, strict body; status must change; `institutional_*` columns; audit event |
| I-4 | POST `…/:institutionId/reject` | same | admin | super_admin | SA chain | As I-3 |
| I-5 | POST `…/:institutionId/suspend` | same | admin | super_admin | SA chain | Needs an unsuspended institute; `suspended_at/by`; the gate refuses the Institute on its next request |
| I-6 | POST `…/:institutionId/restore` | same | admin | super_admin | SA chain | Needs a suspended institute; clears `suspended_*` |

All six answer 503 `VERIFICATION_NOT_INSTALLED` when the AUTH-1 tables are absent. They are **password-only Super Admin routes (F01)**.

## 4. Separation checks (from code)

- **Cookies:** each module's cookie is path-scoped to its own API prefix: `elt_platform_staff` on `/api/platform-staff` (`platformStaff.ts:41-42`), `elt_org_staff` on `/api/org-staff` (`organizationStaff.ts:45-46`). Both are HttpOnly and SameSite=Strict, with Secure in production (`staffCommon.ts:40-44`).
- **Sessions:** separate session and identity tables per module (`platform_staff_sessions`, `org_staff_sessions`). Neither touches `users` or `auth_sessions`.
- **Surfaces:** Platform Staff routes exist only on admin and Organization Staff routes only on institution. Every other surface is denied (`only(...)`, `surface.ts:464-466`).
- **Tests covering this:** `surface.test.ts:431` (staff session kinds confined to their module, surface and guard), `surface.test.ts:777` (policy levels agree with the registered guards), `platformStaff.test.ts:147`, `organizationStaff.test.ts:221`.

## 5. Gaps called out (details in SM2_EXECUTIVE_REVIEW.md)

| ID | Routes affected | Gap |
|---|---|---|
| F01 | #6–14, #24–25 (11 Super Admin routes) | Password-only Super Admin session; approved mandatory MFA does not exist in code |
| F02 | #15–17 | Owner routes need a `center` session that passes the AUTH-1 gate. No code path ever set `institutional_status='verified'`. **Code resolved 2026-11-14 by I-3 to I-6.** The Owner still needs verified mobile and email (providers fail closed), plus a rollout/backfill decision |
| F03 | #15–16 | Approved 72 h invitation expiry versus a code path that treated an unset TTL as "unavailable". **Resolved 2026-11-14:** fixed 72 h, no environment setting; #16 no longer has a 503 path |
| F04 | #1–14, #24–25 (Admin surface) | WireGuard-only reachability is designed but not validated; there is no Nginx allow-list and no host firewall in the repository |
| F05 | #16, #18, #24 | An expired invitation permanently holds the staff ID and stays in the activation list; no re-issue or revoke route |
| F07 | #20–23 | Organization Staff session and login ignore AUTH-1 institute suspension and institutional status. **Not implemented: awaiting client decision M-20** (approved policy does not require it) |
| F09 | #1, #4 | Per-address limiter only; no per-account lockout; no Platform Staff MFA (scope undecided) |
