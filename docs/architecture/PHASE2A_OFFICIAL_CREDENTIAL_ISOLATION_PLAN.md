# ELTNOY Phase 2A — Official Credential Isolation & Migration Plan

**Status:** Read-only architecture and migration plan. No implementation, database operation, migration, production access, or test execution was performed for this document.  
**Scope:** Official and Super Admin password/MFA authentication only. Candidate, Center, Platform Staff, and Organization Staff authentication are explicitly out of scope for change.  
**Evidence standard:** “Source-verified” describes code, tests, and SQL files inspected in this repository. It does not assert that a migration has been applied to any live database or that infrastructure matches a repository document.

## 1. Executive summary

The current Official login is not isolated from Express. `POST /api/auth/login` in `server/index.ts` selects `users.password_hash` and calls `bcrypt.compare` in the Express process. After a successful Official password check, Express calls `beginAdminMfaSignIn`. The MFA handlers in `server/adminMfa.ts` use the application database pool and load the AES key from `ADMIN_MFA_ENCRYPTION_KEY_FILE`; they decrypt and verify TOTP, update replay state, insert the session and MFA evidence, and set the `elt_session` cookie. `server/auth.ts` later reads that cookie, hashes it, and checks session and MFA evidence.

Phase 1 adds useful verifier-side primitives, but it does not yet change this flow. The verifier has synthetic bcrypt compatibility, MFA crypto interfaces, transaction/assertion validation, and health/readiness endpoints. It has no credential repository, auth request endpoint, PostgreSQL connection, persistent transaction store, assertion consumer, or session gateway. `/readyz` is deliberately not ready. Therefore the source does **not** yet provide Official credential isolation.

Recommended target: create a dedicated `official_auth` schema, with an owner and runtime roles separate from `eltnoy_app`, in the same PostgreSQL database initially. Same-database foreign keys and transactions allow stable references to `public.users`, current Official account status, and atomic assertion-to-session consumption. This is a logical credential database boundary, not a claim of host-level isolation. Production still requires the separate verifier host/process and network boundary specified by the approved Phase 1 architecture. A physically separate PostgreSQL database or cluster is a valid stronger-isolation alternative, but it removes ordinary foreign keys and atomic updates with `public.users` and needs a separately approved account-state synchronization design.

Recommend **controlled offline migration** for the bcrypt hashes. Move all Official hashes in one controlled migration window, validate by identity and count without exposing hash values in logs or reports, set Official `users.password_hash` values to `NULL`, and make the verifier-only credential row the sole Official password authority before enabling the new login path. Candidate and Center hashes remain in `public.users`; their login code and behavior are not changed by this plan.

MFA ciphertext must not be relabelled as AAD v2. The current Express core and the Phase 1 verifier use different AAD domains and field order; `admin_mfa_factors` stores `key_version` but no AAD-format version. A controlled migration must decrypt each legacy envelope only inside the verifier boundary, then re-encrypt it using the approved verifier-only key and v2 AAD while preserving factor IDs, user IDs, confirmation/disable state, replay counters, challenge/ticket associations, recovery-code state, evidence, and audit history. No production secret or record was read for this plan.

## 2. Existing architecture findings

### Source-verified behavior

| Area | Finding from current source |
|---|---|
| Login request | `POST /api/auth/login` accepts `role: 'candidate' | 'center' | 'official'`. The role is checked against the trusted request surface before lookup. For non-candidate login, the SQL filters by `login_id` and requested role. |
| Password storage | `server/schema.sql` defines one `users.password_hash text NOT NULL` for Candidate, Center, and Official rows. |
| Password verification | `server/index.ts` selects `password_hash` and calls `bcrypt.compare` for the login flow. The Official branch uses the same lookup/comparison and returns before ordinary session creation. Candidate and Center login branches also use bcrypt and must remain unchanged. |
| Official MFA | A correct Official password does not create a session. Express calls `beginAdminMfaSignIn`; the MFA handler later verifies the challenge and TOTP before session creation. |
| Current key custody | Express loads the Base64 encryption key from `ADMIN_MFA_ENCRYPTION_KEY_FILE` into a process-cached key ring. The existing code does not perform restrictive file ownership/mode checks equivalent to the Phase 1 verifier key loader. |
| Current MFA crypto | `adminMfaCore.ts` uses AES-256-GCM. Its AAD is length-prefixed, with legacy domain `eltnoy-admin-mfa-totp-secret-v1` and field order domain, factor ID, user ID, key version. `key_version` is persisted; AAD format version is not. |
| MFA storage | `admin_mfa_factors` stores encrypted secret, nonce, tag, key version, factor/user identity, enrollment association, timestamps, confirmation/disable state, and `last_used_step`. Other tables hold challenges, tickets, recovery-code hashes, session evidence, reset requests, and MFA audit events. |
| Session state | Existing Official login and enrollment verification generate a random session bearer in Express, store only its SHA-256 token hash in `auth_sessions`, and set the raw token in an HttpOnly cookie. Session TTL is currently 12 hours. |
| Session verification | `server/auth.ts` reads `elt_session`, hashes it, joins the session to `users`, and for Official sessions separately requires same-user login/enrollment MFA evidence from a confirmed, active factor. |
| Database access | The current `databaseGrantsMigration.sql` grants `eltnoy_app` table-level `SELECT, INSERT` on `users`, `auth_sessions`, and MFA tables. The `users` SELECT is not column-limited; it includes `password_hash`. MFA `SELECT` includes encrypted factor columns. The API also has explicitly listed state-column updates. |
| Phase 1 verifier | `server/verifier/main.ts` loads keys and starts a health-only HTTP server. Its readiness callback is always false. It does not import the Express auth modules or database pool. |
| Current UI | `RolePortal` posts the Official password to the Express API. It displays the TOTP screen only for `mfa_required`; for `mfa_enrolment_required` it tells the user setup is unavailable and to contact a Super Admin. Enrollment endpoints exist server-side, but the inspected portal does not implement their enrollment UI. |

### Important documentation/source discrepancy

The historical [PostgreSQL role separation plan](postgres-role-separation-plan.md) describes the `users` grant as “Never `password_hash`.” The current `databaseGrantsMigration.sql` manifest grants table-level `SELECT` on `users`, and its grant loop applies that table privilege. In PostgreSQL, table-level `SELECT` includes `password_hash`. The live grant state was not queried; this finding is about the checked-in migration source. This discrepancy must be resolved in the migration and grant tests before cutover.

### Proposed, not currently implemented

The `auth.eltnoy.com` UI, `api.eltnoy.com` session gateway, private verifier protocol, verifier credential repository, verifier-side MFA persistence, production host isolation, and database-backed assertion replay protection are target architecture only. Phase 1 documentation explicitly says no authentication endpoint or database proof mutation was implemented.

## 3. Source-file inventory

The following source and tests were inspected for this plan:

- Authentication/session: [server/auth.ts](../../server/auth.ts), [server/index.ts](../../server/index.ts), [server/auth.test.ts](../../server/auth.test.ts), [server/authTestSupport.ts](../../server/authTestSupport.ts).
- MFA implementation and schema: [server/adminMfa.ts](../../server/adminMfa.ts), [server/adminMfaStore.ts](../../server/adminMfaStore.ts), [server/adminMfaCore.ts](../../server/adminMfaCore.ts), [server/adminMfa.test.ts](../../server/adminMfa.test.ts), [server/adminMfaCore.test.ts](../../server/adminMfaCore.test.ts), [server/adminMfaMigration.sql](../../server/adminMfaMigration.sql), [server/adminMfaMigration.test.ts](../../server/adminMfaMigration.test.ts).
- User/session schema and privileges: [server/schema.sql](../../server/schema.sql), [server/databaseGrantsMigration.sql](../../server/databaseGrantsMigration.sql), [server/databaseGrants.test.ts](../../server/databaseGrants.test.ts), [server/databaseRoleBootstrap.sql](../../server/databaseRoleBootstrap.sql), [server/migrate.ts](../../server/migrate.ts), [server/migrate.test.ts](../../server/migrate.test.ts), [server/databaseGrants.postgres.integration.test.ts](../../server/databaseGrants.postgres.integration.test.ts).
- Other authentication migration/tests: [server/authVerificationMigration.sql](../../server/authVerificationMigration.sql), [server/authVerification.test.ts](../../server/authVerification.test.ts). These primarily support Candidate/Center verification and should not be repurposed as an Official credential store.
- Phase 1 verifier: all source and tests under [server/verifier/](../../server/verifier/), including `config.ts`, `keys.ts`, `passwords.ts`, `mfa.ts`, `transactions.ts`, `assertions.ts`, `httpServer.ts`, `securityEvents.ts`, `rateLimiter.ts`, `main.ts`, and their tests.
- Frontend: [src/components/RolePortal.tsx](../../src/components/RolePortal.tsx), [src/components/AdminMfaChallenge.tsx](../../src/components/AdminMfaChallenge.tsx), [src/components/LoginModal.tsx](../../src/components/LoginModal.tsx), [src/utils/adminMfa.ts](../../src/utils/adminMfa.ts), [src/utils/adminMfa.test.ts](../../src/utils/adminMfa.test.ts), [src/App.tsx](../../src/App.tsx).
- Architecture/configuration documentation: [Phase 1 verifier foundation](phase1-official-verifier-foundation.md), [system architecture](system-architecture.md), [PostgreSQL role separation plan](postgres-role-separation-plan.md), [secure database credentials](secure-database-credentials.md), and `package.json`.

Key source locations include:

- `server/index.ts`: login route at `app.post('/api/auth/login')`; `USER_COLUMNS`; bcrypt comparisons; Official dispatch to `beginAdminMfaSignIn`; session insert; MFA routes.
- `server/adminMfa.ts`: `loadAdminMfaKeyRing`, `beginAdminMfaSignIn`, `beginAdminMfaEnrolment`, enrollment confirmation handler, `checkCode`, and `createAdminMfaVerifyHandler`.
- `server/adminMfaStore.ts`: `createPostgresAdminMfaStore`, `verifyLogin`, per-user advisory lock, challenge/attempt/replay checks, and transactionally coupled session/evidence writes.
- `server/auth.ts`: `newSessionToken`, `setSessionCookie`, `SESSION_TTL_MS`, `OFFICIAL_MFA_SQL`, and `loadSession`.
- `server/verifier/assertions.ts`: 30-second assertion lifetime and five-second clock-skew policy.
- `server/verifier/transactions.ts`: `official_login` and `official_enrolment` purpose validation and required, explicitly supplied transaction maximum lifetime.

No production database was contacted. No password hashes, MFA envelopes, key files, or secret values were read.

## 4. Current authentication data flow

```text
Browser
  └─ password + role/login ID ──> Express POST /api/auth/login
       ├─ reads users.password_hash and compares bcrypt in Express
       └─ Official: creates 5-minute hashed challenge and HttpOnly cookie
            └─ Browser submits six-digit code to Express MFA endpoint
                 ├─ Express reads encrypted factor from admin_mfa_factors
                 ├─ Express decrypts with ADMIN_MFA_ENCRYPTION_KEY_FILE
                 ├─ Express verifies TOTP and last_used_step
                 ├─ one DB transaction consumes challenge, advances replay counter,
                 │  inserts auth_sessions + auth_session_mfa_verifications + audit event
                 └─ Express sets raw elt_session cookie after commit
                      └─ Express auth middleware hashes cookie and checks session/MFA evidence
```

For an active factor, `admin_mfaStore.ts` serializes verification by user with a PostgreSQL advisory lock, reserves attempts, checks the account is still an approved Official, locks the active factor, validates the TOTP callback, advances `last_used_step` only monotonically, consumes the challenge, and inserts the session/evidence/event in one transaction. Login challenge policy in the current code is 300 seconds, five attempts per challenge, and five failed codes per account in a rolling 15-minute window. These existing values are source-verified; they do not establish the future authentication transaction lifetime.

The MFA enrollment endpoint generates a TOTP secret in Express, stores an encrypted factor, and returns both an `otpauth` URI and Base32 secret to the browser. That is a current Express exposure of plaintext MFA secret and must move to the verifier/UI boundary. The browser necessarily receives a provisioning secret to enroll its authenticator; the security requirement is that Express does not receive it.

## 5. Proposed target architecture

```text
eltnoy.com (main app) ── HTTPS ──> api.eltnoy.com (session gateway / API edge)
                                        │
auth.eltnoy.com (Official UI) ── HTTPS ─┼──> independent verifier process
                                        │       ├─ Official password lookup / bcrypt
                                        │       ├─ MFA key custody, provisioning, decrypt, TOTP
                                        │       └─ signed 30-second assertion
                                        │
                                        └──> official_auth schema + Official sessions
                                                (atomic assertion consumption + session create)

Express application behind trusted gateway:
  receives minimal authenticated identity/context only;
  no Official password hash, MFA secret/key, assertion signing key, or raw Official cookie.
Candidate and Center flows remain on their existing route and session behavior.
```

Recommended trust boundaries:

1. Verifier runs as a dedicated service identity on a separate production host/process and private network. A second process on the same VPS is not host isolation.
2. The verifier owns Official bcrypt verification, verifier-only credential data access, TOTP secret provisioning/decryption/verification, MFA encryption/signing key files or approved custody integration, and creation of assertions.
3. The gateway holds only the assertion verification public key(s), validates assertion signature/claims/bindings, atomically consumes assertion IDs, creates/revokes Official sessions, and owns the Official session cookie.
4. The verifier does not create application sessions. Express does not accept a browser-supplied identity header or assertion as trusted; the gateway strips inbound identity headers and conveys authenticated context over an authenticated private connection.
5. Candidate and Center continue using existing `public.users.password_hash`, Student/Institute verification, and current session flow. Changes needed only to make Official hashes `NULL` in `public.users` must not alter Candidate/Center hashes or code paths.
6. Use the same PostgreSQL database with a restricted `official_auth` schema as the initial implementation target. This retains FK and same-transaction semantics. Require separate process/host isolation at production. If a separate database/cluster is mandated, do not copy this design unchanged: identity/status synchronization, FK replacement, audit continuity, and atomic replay/session semantics need a separate approved design.

## 6. Password migration strategy comparison

| Strategy | Security implications | Operational complexity / downtime | Failure handling and consistency | Rollback | Assessment |
|---|---|---|---|---|---|
| **A. Controlled offline migration** | A restricted migration identity reads Official hashes directly from the source table and writes them to the verifier-only store. Express must be stopped or its Official route disabled during the cutover, and Official hashes must be removed from `public.users` before Express resumes. Hashes remain bcrypt hashes; plaintext passwords are never exported. | Medium complexity. Requires an agreed short Official sign-in maintenance window for snapshot, validation, source nulling, grant changes, and routing cutover. Candidate/Center can remain available if the deployment safely separates their route and migration locks permit it. | Lock Official credential/status writes for the migration; use one database transaction where possible. Validate exact Official user-ID set, account status/role, counts, unique mappings, supported bcrypt format/cost range, and byte-for-byte source/destination equality inside the trusted migration process. Log only counts and failure categories, never hashes. Fail closed and do not enable the new Official path if any row is missing, duplicated, invalid, or inconsistent. | Good if rollback means reverting to a previous verifier release against the verifier store. Do **not** restore Express hash access as rollback. If the verifier store is unavailable, disable Official login and restore the verifier-only store from a protected backup. Re-enabling legacy Express authentication would violate the isolation goal and requires a separate, explicit rollback approval. | **Recommended.** One authority at cutover; easiest to audit; avoids first-login migration races and dual-read ambiguity. |
| **B. First-successful-login migration** | Can avoid password resets only if verifier directly verifies the legacy bcrypt hash and writes it to the new store. Express must never read that hash; therefore the Official login path has to move to the verifier before lazy migration begins, and the verifier needs temporary permission to read legacy hashes. | High complexity, indefinite migration period, per-user state and long-tail inactive accounts. Cutover is not complete until every remaining legacy hash is migrated or retired under an approved policy. | Requires per-user row locks, atomic “legacy source → new authority” state, exact-once transfer, retries, rate limits, and protection from simultaneous password change/reset. If the stores are separate databases, copy/consume is not one ordinary SQL transaction. Missing/corrupt hashes need a fail-closed account recovery policy. | Medium/poor: some accounts would have moved and some not. Rollback requires per-account authority tracking and cannot make Express the fallback without re-exposing hashes. | Not recommended for this cutover. It can be designed later only if the operator explicitly accepts a prolonged mixed state and grants the verifier—not Express—temporary source access. |
| **C. Staged dual-read transition** | Highest risk. If both Express and verifier can accept passwords, two authorities may disagree after password changes, account disables, or partial migration. A fallback from verifier failure to Express directly negates isolation. | High complexity, longer validation period, overlapping write and support paths. | Requires a single authoritative version and deterministic routing for every account, with no silent fallback. Stale source hashes and partial updates can permit older passwords. Every write and disable must be coordinated; a failed stage must not cause both systems to accept conflicting credentials. | Poor unless rollback freezes Official login and returns to a single authority. “Try verifier, then Express” is not a safe rollback. | Reject as an operational mode. A staged rollout may be used for testing, but only one verifier is authoritative per request/account and Express must not receive Official hashes. |

### Recommended migration mechanics

Use strategy A in a controlled maintenance window:

1. Stop or disable Official password login and enrollment mutations; Candidate/Center routes are not changed.
2. Provision the restricted schema, owner, migration identity, verifier, and gateway roles. Rehearse on synthetic data first.
3. Copy only `users.role = 'official'` records, preserving `users.id`, login identifier mapping, current account status, `is_super_admin` context, and bcrypt string exactly. No password is reset or rehashed.
4. Validate the entire source and destination account set and hash equality in the restricted runner. Emit aggregate counts and row IDs only if approved; never emit hashes or plaintext.
5. In the same cutover transaction where feasible, set Official `users.password_hash = NULL`, assert all Candidate/Center hashes remain present and byte-identical, and prevent future Official hash inserts into `public.users`. Update provisioning flows so Official credential writes go only through the verifier.
6. Apply new grants and tests so `eltnoy_app` cannot access `official_auth` objects and all Official rows have null legacy hashes.
7. Enable the verifier as the only Official password verifier. If any verification fails, keep Official login closed; do not fall back to Express.

If physical database separation is selected, step 5 cannot be globally atomic with the verifier database. Use an explicit account-state/version cutover ledger and fail-closed routing; no account may be enabled in the verifier until its hash copy is validated and its legacy hash is made inaccessible to Express. This is an operator design choice, not assumed in the recommendation.

## 7. MFA migration matrix

The current `admin_mfa_factors` schema has no `aad_version` column. The legacy Express crypto uses key version 1 and the AAD domain/order described in §2. Phase 1's `VerifierMfaKeys` expects `aadVersion: 2` and a different v2 AAD tuple. A key version identifies key material; it is **not** an AAD format version. Never infer v2 from an existing `key_version`, and never attempt a v2-only decrypt of a legacy row.

| Existing data state | Source representation | Migration treatment | Preservation / validation |
|---|---|---|---|
| No factor for an Official | No `admin_mfa_factors` row | Keep no factor. Future enrollment happens through the approved verifier flow. Existing frontend currently displays an enrollment-unavailable notice; do not enable an unapproved path. | User ID and account state remain unchanged. |
| Confirmed active TOTP factor, legacy ciphertext | Factor ID/user ID, ciphertext, nonce, tag, key_version, `confirmed_at`, `last_used_step` | Temporarily support explicit legacy decrypt (AAD v1) only in a verifier-hosted migration tool. Decrypt into verifier memory, immediately encrypt using approved verifier key/AAD v2; update only ciphertext/nonce/tag, key version if key material changes, and new `aad_version=2`. | Preserve factor ID, user association, kind, creation/confirmation times, active state, replay counter exactly. Verify the new envelope by decrypting within the verifier process and checking expected 20-byte length; zero plaintext buffers. |
| Unconfirmed factor / enrollment in progress | Factor with `confirmed_at IS NULL`, bound `enrolment_challenge_id`; challenge and ticket may be open | Do not silently drop, regenerate, confirm, or rebind. Preserve exact IDs and ticket/challenge association. Because the existing challenge cookie is host/path scoped and the new UI is on another host, either drain/finish the old flow before cutover or approve and test a continuation mechanism. | Reconcile `factor`, `challenge`, `ticket`, and reset request by exact IDs. If continuation cannot be safely preserved, stop cutover for that account and request an explicit supersede/re-enroll decision; retain original records/audit. |
| Disabled factor | `disabled_at`, `disabled_by`, `disabled_via` set; ciphertext retained | Re-encrypt ciphertext just like active factors if the key will be retired, or retain legacy decrypt support for this state until encrypted backup retention expires. Do not reactivate it. | Preserve all disabled fields and timestamps; no new active factor created from it. |
| Factor with legacy `enrolment_challenge_id IS NULL` | Existing migration allows old factor rows with a null association | Preserve null. Do not manufacture an enrollment association. | Validate that old rows remain distinguishable from new enrollment-bound rows. |
| Factor key version not supported by available legacy key custody | `key_version` outside supported migration key ring | Quarantine the row and fail the factor migration/cutover for that account. Do not guess, relabel, or reset the factor. | Require operator recovery/key-escrow decision; preserve row and audit evidence. |
| Recovery code unused | `code_hash`, `used_at IS NULL`, `revoked_at IS NULL` | Preserve opaque digest and exact ID/factor/user association; do not regenerate or expose code. | Validate only digest shape, uniqueness, FK, and state. No plaintext recovery codes exist in the migration source. |
| Recovery code used or revoked | `used_at` or `revoked_at` set | Preserve terminal state and timestamps; never reactivate. | Confirm rows remain linked to the same factor/user. |
| Login/enrollment/step-up challenge open, expired, or consumed | Hash-only ID, purpose, attempts, timestamps, consumed state/reason, optional session/ticket binding | Preserve consumed/expired history. Open login challenges should not become valid across a host/protocol cutover unless cookie and binding continuity is explicitly proven. Open enrollment challenges need the special handling above. | Prefer an orderly drain. If cutover supersedes an open challenge, record the reason and preserve the row/event; this is a security-state change requiring approval. |
| Enrolment ticket open, used, or revoked | Hashed ticket ID, issuer/mode, expiry, user, reset request | Preserve exact state and source IDs. Do not issue replacement tickets automatically. | Validate all reset-request/ticket relations and all terminal states before cutover. |
| MFA session evidence | `auth_session_mfa_verifications` links token hash, user, purpose, method, factor | Preserve as immutable historical evidence. Do not treat old sessions as authenticated by newly-created assertions. Existing Official sessions should be explicitly revoked/expired at cutover unless a separate session-continuity policy is approved. | Validate session/user/factor FKs and purpose/method. Retain the source `verified_at` and evidence ID. |
| Reset request | Pending or terminal request; approval mode, initiator/decision evidence, reasons, timestamps, ticket | Preserve exact record and links. Do not execute, approve, reject, or convert an open request during data movement. | Validate the deferred cross-row invariants and approval evidence. The reset hierarchy/operator workflow remains unresolved. |
| MFA audit event | `auth_verification_events` event with `admin_mfa.*` action | Preserve original immutable event and identity; do not include secret/hash/codes in migration logs. | Compare action/user/time counts and retain event IDs/details without rewriting their history. |

### Safe legacy-to-v2 secret conversion

1. Approve a migration executable that runs only under the verifier service identity or a temporary, isolated migration identity on the verifier host. It must not be part of Express or its deployment unit.
2. Transfer the existing legacy key to verifier-only custody through an approved protected channel. Existing Express processes must be stopped and their environment/file access removed before any migration begins. Do not place the key in source control, SQL, shell history, logs, or an Express environment.
3. Load the legacy key as version 1 and the approved verifier key as a distinct explicit version. The legacy file uses canonical Base64 in current Express code; Phase 1 key loading expects raw 32-byte MFA key material. Convert in memory in the migration tool; never write decoded key bytes to a temporary file.
4. Add and populate an explicit `aad_version` column (`1` for legacy envelopes before conversion, `2` after v2 conversion). Do not alter `key_version` unless the encryption key itself changes.
5. For each factor, verify identity and envelope shape; decrypt only in verifier memory using the exact legacy AAD domain/order and key version; encrypt under v2 with length-prefixed domain, key version, user ID, and factor ID; update the envelope and AAD version atomically without changing state fields.
6. Validate all rows, state counts, IDs, replay counters, FKs, and audit continuity. On any failure, roll back that row/batch and fail closed; never substitute a new factor or clear replay state.
7. Keep the legacy key in tightly controlled offline escrow for encrypted backups made before conversion. Retire it only after the approved backup-retention and restore policy no longer requires legacy decryption. Express must not regain access during rollback.

No production ciphertext was read, decrypted, or modified for this plan.

## 8. Proposed credential database schema

### Logical boundary

Create schema `official_auth` within the existing PostgreSQL database for the first implementation. It is a dedicated logical store with different ownership and grants. Keeping it in the same database permits `user_id` foreign keys to `public.users` and allows assertion consumption, replay recording, MFA counter advancement, and session creation to be made atomic. It is not host-level isolation, and database superusers remain capable of reading it.

Existing official account profile/role/status remain in `public.users` during this phase. The verifier gets a narrow read projection (`id`, `login_id`, `role`, `account_status`) to resolve and reject ineligible accounts; the API keeps its existing app-domain identity/profile access. Official credential bytes move to `official_auth.credentials`; their old `public.users.password_hash` values become `NULL`. Candidate/Center hashes remain unchanged.

### Required tables and key constraints

| Proposed table | Required columns and constraints |
|---|---|
| `official_auth.credentials` | `user_id` PK/FK to `public.users(id)`; bcrypt hash; fixed `hash_scheme='bcrypt'`; positive `credential_version`; `credential_state` (`active`, `disabled`); `created_at`, `updated_at`, `password_changed_at`; optional migration batch ID. One row per Official; verifier validates `users.role='official'` and `account_status='approved'` at authentication time. Never store plaintext or reset secrets. |
| `official_auth.credential_events` | Append-only ID, user ID, event type, actor/context IDs, credential version, timestamp, non-secret details. Never store password, hash, reset token, assertion, or TOTP material. |
| `official_auth.credential_reset_tokens` (only after policy approval) | Token hash PK, user FK, created/expiry/consumed/revoked timestamps; one live token per approved policy scope; no raw reset token. Do not enable until reset authority, delivery, rate-limit, and recovery policies are approved. |
| `official_auth.auth_transactions` | UUID PK, nullable user ID until identity resolution, purpose (`official_login` or `official_enrolment`), challenge hash, browser-binding hash, state, created/expiry timestamps, consumed/completed timestamps; `expires_at > created_at`; a maximum lifetime enforced by verifier policy after approval; indexes on user/state/expiry. No plaintext challenge or browser binding. |
| `official_auth.assertion_consumptions` | Assertion UUID PK (replay key), transaction FK, user FK, purpose, issued/expiry/consumed times; unique transaction/purpose where policy requires one proof. Retain at least through assertion expiry plus approved skew and operational replay retention. |
| `official_auth.mfa_factors` | Preserve current `id`, `user_id`, `kind`, ciphertext, nonce, tag, key version, created/confirmed/disabled fields, `last_used_step`, `enrolment_challenge_id`; add non-null `aad_version` with explicit supported values. Keep composite unique `(id,user_id)`, FK ownership, one-active-factor partial unique index, envelope-length checks, monotonic replay-counter trigger/function. |
| `official_auth.mfa_challenges` | Preserve hashed challenge ID, user, purpose, session/transaction association, enrollment ticket, attempts, created/expiry/consumed timestamps and reason. Keep strict purpose/state constraints and partial indexes for open challenges. Challenge and replay mutations must be transactionally protected. |
| `official_auth.enrolment_tickets` | Preserve hashed ticket ID, user, issuer, issued-via, reset-request link, created/expiry/used/revoked times and single-use constraints. |
| `official_auth.recovery_codes` | Preserve ID, user/factor FK, digest, created/used/revoked times, uniqueness and terminal-state constraints. No clear recovery code. |
| `official_auth.reset_requests` | Preserve current reset ID, target, approval mode, initiator/decision identities and MFA evidence, reasons, status, timestamps, and ticket relation. Existing checks remain; do not implement an unapproved approval hierarchy or break-glass workflow. |
| `official_auth.official_sessions` | Token hash PK only (never raw bearer), user FK, created/expiry/revoked times, credential version/authentication context; indexes on user and expiry. Gateway-only writes/reads. Future lifetime is an operator decision. |
| `official_auth.session_mfa_evidence` | Evidence ID, Official session hash FK, user/factor FK, purpose (`login`, `enrolment`, approved step-up), method, verified time; insert-only and same-user/session/factor constraints. |
| `official_auth.audit_events` | Append-only security event ID/action/user/time/safe structured details. No credentials, hash values, OTPs, secrets, cookies, or raw assertions. Existing `auth_verification_events` history remains preserved; migration records must be traceable without rewriting source IDs. |

### Illustrative SQL — NOT EXECUTED

The following shows only the intended boundary and minimum constraints. It is not a complete migration; object owners, grants, triggers, migration ordering, indexes, status synchronization, and rollback need implementation review and approval.

```sql
-- NOT EXECUTED. Same database so user FK and status checks remain transactional.
CREATE SCHEMA official_auth AUTHORIZATION official_auth_owner;

CREATE TABLE official_auth.credentials (
  user_id text PRIMARY KEY
    REFERENCES public.users(id) ON DELETE RESTRICT,
  password_hash text NOT NULL,
  hash_scheme text NOT NULL DEFAULT 'bcrypt'
    CHECK (hash_scheme = 'bcrypt'),
  credential_version bigint NOT NULL DEFAULT 1
    CHECK (credential_version > 0),
  credential_state text NOT NULL DEFAULT 'active'
    CHECK (credential_state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  password_changed_at timestamptz,
  migration_batch_id text
);

CREATE TABLE official_auth.auth_transactions (
  transaction_id uuid PRIMARY KEY,
  user_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL
    CHECK (purpose IN ('official_login', 'official_enrolment')),
  challenge_hash char(64) NOT NULL,
  browser_binding_hash char(64) NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'completed', 'consumed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE official_auth.assertion_consumptions (
  assertion_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL
    REFERENCES official_auth.auth_transactions(transaction_id) ON DELETE RESTRICT,
  user_id text NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL
    CHECK (purpose IN ('official_login', 'official_enrolment')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at)
);

-- Existing official rows must not retain an Express-readable password hash.
ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE public.users ADD CONSTRAINT users_password_hash_role_check
  CHECK (
    (role = 'official' AND password_hash IS NULL)
    OR (role IN ('candidate', 'center') AND password_hash IS NOT NULL)
  );
```

`official_auth.auth_transactions` is shown as a dependency in the replay table but omitted from this short DDL excerpt; its columns and constraints are specified above. The `password_hash_role_check` is a proposed invariant, not an instruction to run. Any current registration/provisioning path that creates Officials must be changed before enforcing it.

### Credential integrity

- Require exactly one credential row for each in-scope Official account and none for non-Official accounts.
- Compare source and destination `user_id` sets, role, login mapping, account status, and hash bytes inside the trusted migration runner; report counts and pass/fail only.
- Validate bcrypt syntax/cost compatibility without logging hash strings. Never rehash or normalize a stored hash during migration.
- Ensure all Official `public.users.password_hash` fields are null before restoring API access; ensure all Candidate/Center values are unchanged and non-null.
- Enforce account eligibility from current `public.users` state. An unapproved, rejected, missing, or wrong-role account fails closed even when a credential row exists.
- Increment `credential_version` on password change/reset, and revoke or invalidate existing Official sessions in the same database transaction.
- Use a unique constraint for `user_id`; do not store login ID redundantly unless a tested synchronization invariant is designed.

## 9. Database roles and permissions

### Existing roles, source-verified

`databaseRoleBootstrap.sql` defines `eltnoy_owner` (NOLOGIN), `eltnoy_migrator`, `eltnoy_app`, `eltnoy_audit_writer`, `eltnoy_audit_reader`, `eltnoy_audit_verifier`, and `eltnoy_backup`. `eltnoy_migrator` can `SET ROLE eltnoy_owner`; runtime `eltnoy_app` is not meant to own objects. The existing `eltnoy_audit_verifier` is an audit role and is explicitly not an Official credential verifier role.

Application roles in `users.role` are `candidate`, `center`, and `official`; Super Admin is represented by `users.is_super_admin`, not a separate DB login role. Platform Staff and Organization Staff credentials are separate application areas and not part of this migration.

### Proposed least-privilege roles

| Role | Type | Access |
|---|---|---|
| `official_auth_owner` | NOLOGIN owner | Owns only `official_auth` objects and tightly scoped functions. No application connection uses this role directly. |
| `official_auth_migrator` | LOGIN, SET-only membership to owner | Runs reviewed, audited migrations after verified backups. Not used by verifier, gateway, or Express at runtime. |
| `official_verifier` | LOGIN runtime | Reads only necessary `public.users` identity/status columns and credential rows; owns verifier-managed transaction/challenge/factor writes and replay-counter advancement through narrowly granted operations. No access to session bearer values or session creation. No owner/migrator membership. |
| `official_session_gateway` | LOGIN runtime | Validates assertions using public verification keys in process; invokes only a fixed database operation to consume assertion IDs and create/revoke Official sessions/evidence atomically. No access to password hashes, encrypted TOTP secrets, MFA encryption keys, or signing private keys. |
| `eltnoy_app` | Existing API runtime | Retains current Candidate/Center/API grants. No `USAGE` on `official_auth`, no `SELECT` on Official credentials/factors/challenges/session evidence or Official session rows, no assertion-consumption function permission. It may read `public.users`, where Official password hashes are null. |
| Existing backup role | Existing role, separately reviewed | Backup/restore must handle the new schema and its encrypted credentials with approved off-host encryption and access policy. Do not grant the Express runtime backup privileges. |

Required prohibitions: no runtime role may be superuser, owner, migrator, `BYPASSRLS`, or a member of the owner; no PUBLIC schema/table/function access; no schema CREATE for runtime roles; no raw session token column; no direct gateway grants to factor ciphertext or credential hash; no verifier access to session rows except a separately approved proof need. Use `SECURITY DEFINER` only for narrowly scoped atomic operations with fixed `search_path`, strict input checks, owner-only execution, revoked PUBLIC EXECUTE, and explicit role grants. The database function must use database time for consumption and constraints.

Recommended atomic operation: a gateway-only `consume_official_assertion_and_create_session(...)` function inserts the unique assertion ID, checks pending transaction/purpose and state, consumes the transaction, advances any proof state required by purpose, inserts a hashed session token and same-user evidence, and commits as one transaction. The gateway verifies the Ed25519 signature/claims before calling it. PostgreSQL must not be assumed to verify signatures via pgsodium; no pgsodium API/PG17 compatibility is established by current source.

## 10. Future authentication request sequence

1. **Start on `auth.eltnoy.com`.** The browser opens the Official login UI over HTTPS. The UI obtains a fresh transaction from the trusted gateway/verifier boundary. The transaction contains a random UUID, exact purpose, challenge hash, browser-binding hash, created/expiry times, and pending state. The transaction maximum lifetime remains unset until approved.
2. **Bind the browser.** Generate independent high-entropy challenge and browser-binding values. Store only hashes server-side. Keep the browser binding in a host-only, HttpOnly, Secure cookie on the auth origin; never accept it from a URL or untrusted header. Bind expected Origin/host to the transaction. Define cookie name, SameSite policy, expiry, and CORS before implementation.
3. **Send password directly to verifier.** The browser posts login ID/password to the verifier-facing auth service over HTTPS. The verifier validates strict shape/size, resolves login ID to an Official identity, checks current role/account state/credential state, and compares bcrypt inside the verifier process. It returns generic invalid-credential errors and does not send hash or password to Express or gateway.
4. **Require MFA/enrollment purpose.** For existing factors, the verifier loads/decrypts the factor, verifies TOTP against a locked/atomic replay counter, and requires the `official_login` transaction. For no factor, only the separately approved enrollment workflow can use `official_enrolment`; `official_enrolment` must never be accepted as login proof. The verifier returns provisioning material to the auth UI only where required for authenticator setup; no Express hop may see it.
5. **Issue assertion.** On successful proof, the verifier signs strict claims including issuer/audience, key ID, assertion ID, transaction ID, user ID, purpose, challenge/browser-binding hashes, issue and expiry times. Expiry is exactly 30 seconds; validation allows five seconds of clock skew, as in Phase 1. The raw assertion is delivered only over authenticated private service-to-service transport.
6. **Validate and consume at gateway.** Gateway validates signature, key ID, issuer/audience, strict shape, user/purpose/transaction/challenge/browser binding, 30-second lifetime and five-second skew. It atomically consumes the assertion ID and transaction state in the database with session/evidence mutations. Duplicate assertion IDs or consumed transactions fail closed.
7. **Create session.** Gateway creates a random bearer, stores only its one-way hash, and binds session/user/authentication evidence in the same database transaction. If commit fails, it returns no cookie and the assertion cannot be used to mint a second session.
8. **Set cookie.** Gateway returns a host-only Secure, HttpOnly cookie on the API domain; no `Domain` attribute is preferred. Use the `__Host-` cookie prefix if compatible with required path/hosting, `Path=/`, and an approved SameSite setting. Do not choose a new session lifetime here; current legacy TTL is 12 hours, while the future value requires operator approval.
9. **Forward minimal context.** The gateway validates each API request’s session and sends only minimum identity/role/super-admin context to Express using a private authenticated hop. Strip client-supplied identity headers and block direct public access to Express. Express must not receive the browser’s Official cookie or raw session bearer. Continue existing Candidate/Center authentication/session verification independently.

### CSRF, origins, errors, retries

- Require exact allowed `Origin` for state-changing auth and API requests, Fetch Metadata checks where supported, and an approved CSRF token strategy. SameSite cookies are defense-in-depth, not the only control. `server/surfaceEnforcement.ts` provides current exact-surface origin patterns to reuse; target auth/api origins are not yet registered in the current surface config.
- Configure credentialed CORS only for the exact approved frontend/auth origins; never combine wildcard origins with credentials. Validate redirects and return targets against an allowlist.
- Use no-store responses for credential, MFA, transaction, and assertion operations. Do not put credentials, challenges, OTPs, tickets, or assertions in query strings, analytics, logs, or error bodies.
- Invalid password/unknown user responses should be indistinguishable. Rate limits must cover IP, account, transaction, and challenge dimensions, with bounded storage and behavior across verifier instances; Phase 1 in-memory limiter is not distributed protection.
- On timeout, verifier failure, DB failure, assertion validation failure, or ambiguous commit result, issue no session. The browser restarts using a new transaction; never retry the same assertion as a second proof.
- The only fixed future assertion policy in scope is 30 seconds with five seconds skew. No authentication transaction lifetime, session lifetime, or MFA recovery lifetime is introduced here.

## 11. Express isolation plan

| Responsibility that must leave Express | Current location/evidence | Target owner |
|---|---|---|
| Official bcrypt comparison | `server/index.ts` login route (`bcrypt.compare(password, user.password_hash)`) | Independent verifier |
| Official password-hash retrieval | `server/index.ts` login `USER_COLUMNS` from `users`; current `eltnoy_app` table-level `SELECT` | Verifier-only `official_auth.credentials`; Official hash nulled in `public.users` |
| TOTP-factor ciphertext retrieval | `adminMfaStore.ts` and enrollment queries in `adminMfa.ts` | Verifier-only MFA store access |
| MFA decryption and encryption key loading | `adminMfa.ts` `loadAdminMfaKeyRing`; `adminMfaCore.ts` crypto | Verifier-only key interface/custody |
| TOTP verification and replay check | `adminMfa.ts` `checkCode`; `adminMfaStore.ts` serializes and advances `last_used_step` | Verifier, with atomic database replay/counter mutation |
| MFA secret provisioning and storage | `beginAdminMfaEnrolment` creates secret/encrypted row and returns Base32/URI | Verifier; auth UI receives provisioning value directly |
| Assertion signing/private key access | Phase 1 verifier `keys.ts` interface exists but no auth route uses it | Verifier only |
| Raw Official session bearer creation/handling/cookie | `adminMfa.ts` creates token; calls `setSessionCookie`; current API parses `elt_session` | API/session gateway only; Express never receives Official cookie/token |
| Official session/evidence issuance and consumption | `adminMfaStore.verifyLogin`, enrollment handler, `auth.ts` Official evidence query | Gateway and tightly scoped atomic database operation |

After cutover Express may retain: Candidate/Center authentication as-is; application business authorization; access to ordinary user profile/role fields required by the app; and a minimal gateway-authenticated Official identity context for the current request. It must not have a fallback Official login path or access to `official_auth` secrets/session rows.

Any direct provisioning/reset/role-management handler that changes Official eligibility must update the authoritative `public.users` state or call the approved verifier control plane. Keep role and Super Admin authorization decisions in the trusted application/gateway authorization layer; password verification alone does not grant role permissions.

## 12. Frontend and user experience assessment

### Current UI behavior

- `RolePortal` posts credentials to `/api/auth/login`. For Official 202 responses it shows `AdminMfaChallenge` only when `mfa_required`; that component submits only the six-digit code and relies on an HttpOnly challenge cookie.
- After successful verification the UI calls `/api/auth/me`, preserving the existing “session only after server confirmation” behavior.
- `mfa_enrolment_required` currently displays a message that enrollment is unavailable in the portal and tells the user to contact a Super Admin.
- `LoginModal` is a separate component that posts to the same login path and expects an immediate `/api/auth/me`; it has no MFA transition handling. Its usage in the current component tree was not found. If reused, it would need an explicit Official flow or must exclude Official login; do not assume it is active.
- Current UI maps fixed server errors for invalid code, expired challenge, lockout, throttling, invalid ticket, and unavailable MFA. The restart behavior returns expired/locked challenges to sign-in.

### Required future UI changes (not implemented)

- Route Official login through `auth.eltnoy.com`; send no Official password to Express.
- Maintain transaction/challenge state without exposing secret values in URLs or browser storage. Browser cookie binding must be host-only and designed for the cross-subdomain deployment.
- Preserve the six-digit TOTP input, busy/error states, and post-success `/api/auth/me`-equivalent trusted session confirmation.
- Add the already-approved/implemented enrollment user experience only after the verifier enrollment protocol and recovery policy are approved; do not invent recovery, backup-code, helpdesk, or approval options.
- Display generic authentication errors while preserving actionable expired/locked/restart states. Avoid account existence leaks.
- Handle session expiry and logout through the API gateway without exposing the raw bearer to React or Express. Existing session lifetime behavior changes only after explicit approval.
- Candidate and Center screens, providers, login fields, MFA-free behavior, verification flow, and existing session behavior remain unchanged by this Official migration.

## 13. Staged migration and rollback plan

Every stage below is a future proposal and requires its stated approvals. None has been performed.

### Stage A — Infrastructure and verifier preparation

- **Preconditions:** Approve verifier host/process boundary, private network, `auth` and `api` routing, service identities, TLS/service authentication, key custody/rotation, monitoring, and cost.
- **Work:** Build/review verifier auth protocol and repository without enabling it publicly; provision private test endpoints and separate runtime identities.
- **Validation:** Static dependency boundary; synthetic auth flow; no Express/DB-pool imports in verifier; only private test addresses; secret scans and request/log review.
- **Acceptance:** Production verifier has separate host/process identity; Express cannot read key files; health endpoints disclose no sensitive data; no public authentication route before full completion.
- **Rollback:** Remove/disable unused private verifier service; existing Express login remains unchanged before cutover.
- **User impact:** None.
- **Approvals:** Host isolation, network, domain/TLS, key custody, operations/cost.

### Stage B — Dedicated credential storage

- **Preconditions:** Decide same-database `official_auth` schema versus separate database/cluster; approve ownership, roles, migration runner, schema, retention, grants, and backup.
- **Work:** Add credential, transaction, replay, MFA, Official session, evidence, audit, and optional reset structures; update `public.users.password_hash` invariant and Official provisioning paths only after review.
- **Validation:** Synthetic migrations on disposable PostgreSQL 17; exact grant tests, FK/constraint/trigger tests, migration rollback tests, app role denied access to credential/MFA/session objects; Candidate/Center queries still work.
- **Acceptance:** No runtime role owns objects; `eltnoy_app` cannot SELECT Official hashes or MFA ciphertext; no raw session token stored; indexes and constraints cover critical lookups and single-use state.
- **Rollback:** Revert schema only before data cutover; after data exists, use a reviewed reverse migration under maintenance, never grant runtime access back to hashes.
- **User impact:** None before data cutover.
- **Approvals:** Database boundary and roles, ownership, schema, PG17/extension validation, backup/restore plan.

### Stage C — Credential migration

- **Preconditions:** Approved strategy A, verified backup/restore, row counts/validation scripts, prepared verifier, protected maintenance window, and all Official account-provisioning flows updated.
- **Work:** Freeze Official password writes/logins; move bcrypt hashes and stable IDs; verify row completeness and hash equality; null Official hashes in `public.users`; enforce invariant and grants; keep Candidate/Center hashes intact.
- **Validation:** Compare source/destination ID sets and hashes only inside protected process; account/status totals; bcrypt synthetic tests for `$2a$`, `$2b$`, `$2y$` as encountered/approved; tests for 72-byte legacy behavior, invalid credentials and unknown accounts; no logs contain hash/password.
- **Acceptance:** Exactly one active Official credential authority—the verifier store; every Official hash in app table is null; Express code cannot query verifier credentials; Candidate/Center flow regression tests pass.
- **Rollback:** Disable Official login and restore verifier store from restricted backup. Do not revert to Express access. If data integrity fails, keep Official sign-in closed until repair or operator-approved account recovery.
- **User impact:** Official login is briefly unavailable during the window; Candidate/Center operation is unchanged.
- **Approvals:** Migration strategy, maintenance duration, integrity checks, rollback boundary.

### Stage D — MFA migration

- **Preconditions:** Stage C complete; approved legacy-key transfer, v1 AAD compatibility code, v2 key version, `aad_version` schema, pending enrollment handling, recovery/reset authority, and encrypted backup retention.
- **Work:** Mark existing ciphertext AAD v1; decrypt/re-encrypt inside verifier boundary; preserve IDs, state, counters, tickets/challenges/evidence/audit; restrict app grants and remove Express key access.
- **Validation:** Synthetic fixtures for every matrix state; per-row envelope validation; before/after state fingerprints excluding secrets; replay counter equality; recovery/disabled/pending state tests; backup restore under both pre- and post-re-encryption key custody.
- **Acceptance:** Express has neither key nor plaintext/ciphertext access; every supported factor has an explicit AAD version and supported key version; no silently reinterpreted ciphertext; replay counters and audit/history preserved.
- **Rollback:** Pause Official MFA/login. Restore the verifier-only schema/key version using a tested backup. Never return the legacy key to Express. Preserve both ciphertext versions until rollback and backup-retention windows close.
- **User impact:** Existing active MFA should continue with same authenticator; pending enrollment may need an approved drain/continuation procedure. Do not require blanket resets.
- **Approvals:** AAD version/migration plan, key custody/rotation, pending-enrollment transition, reset/recovery policy, retention.

### Stage E — Authentication integration

- **Preconditions:** Stages A-D validated; signed assertion contract, transaction lifetime, session policy, cookie/CORS/CSRF, gateway trust, and atomic consumption operation approved.
- **Work:** Add verifier auth endpoints, gateway assertion verification/consumption, Official session store, trusted Express context, and frontend route. Keep the old Official path disabled, not as fallback.
- **Validation:** End-to-end synthetic credentials and MFA, assertion tamper/purpose/expiry/skew tests, replay concurrency tests, browser binding/CSRF/origin tests, direct-to-Express rejection, session cookie attributes, fail-closed DB/timeout behavior.
- **Acceptance:** Password/MFA secrets never reach Express; gateway rejects invalid/replayed assertions; sessions are issued only after atomic commit; Official surfaces enforce trusted identity; Candidate/Center tests remain unchanged.
- **Rollback:** Route Official sign-in to closed/maintenance state; restore previous verifier/gateway release only. No dual-read or legacy Express fallback.
- **User impact:** Possible short Official-only sign-in interruption during switch.
- **Approvals:** Transaction lifetime, session TTL, error/retry policy, gateway context contract, frontend origin and cookie policy.

### Stage F — Controlled validation

- **Preconditions:** Integrated environment with synthetic accounts only, disposable DB, no production providers/secrets, authorized security review.
- **Work:** Run unit, static, integration, concurrency, migration, restore, permissions, and negative security tests; conduct tabletop key loss/rotation and database restore.
- **Validation:** Verify latest backup restore; test all matrix states; audit logs contain no secrets; review network reachability; run Candidate/Center unchanged regression tests.
- **Acceptance:** Signed test evidence, no unresolved high/critical issue, zero privilege expansion, documented runbooks and support contacts.
- **Rollback:** Fix in test environment; production cutover remains blocked.
- **User impact:** None.
- **Approvals:** Test scope, disposable database permission, security acceptance.

### Stage G — Production cutover

- **Preconditions:** Written go/no-go, verified backup/restore, monitoring, incident and support runbooks, change window, and all policy decisions closed.
- **Work:** Disable Official login; perform final snapshot/count checks; switch to verifier/gateway; rotate/confirm key custody; enable Official login only after end-to-end canary and database acceptance.
- **Validation:** Synthetic/canary Official account, new login and enrollment behavior, session verification/revocation, replay rejection, log/alert checks, Candidate/Center smoke checks.
- **Acceptance:** One authoritative verifier, no legacy Official hash in app table, no Express key/secret/session path, no public direct verifier access, successful restore test.
- **Rollback:** Prefer disable Official sign-in and revert verifier/gateway deployment. Do not reactivate old Express credential path. If compromised/inconsistent, revoke affected sessions and invoke approved incident plan.
- **User impact:** Maintenance window or brief Official sign-in interruption; other roles remain available if operationally separated.
- **Approvals:** Production change authorization, go/no-go, rollback authority, incident decision maker.

### Stage H — Legacy credential-access removal

- **Preconditions:** Stable operation and approved observation period; independent audit of app query paths, roles, keys, and backups.
- **Work:** Remove unused Express Official bcrypt/MFA handlers/imports, remove `ADMIN_MFA_ENCRYPTION_KEY_FILE` from Express service configuration, revoke legacy grants, retire obsolete schemas only after retention approval, and update docs/runbooks.
- **Validation:** Static dependency/SQL query scan, denied-access tests as `eltnoy_app`, deployment config review, full Candidate/Center regression.
- **Acceptance:** No Express Official password check, ciphertext read/decrypt, MFA provisioning, signing, or Official session handling; no old route can authenticate Official.
- **Rollback:** Roll back application code only if it preserves verifier-only boundaries. Do not re-grant the old key or hash access.
- **User impact:** None expected; changes are cleanup after stable cutover.
- **Approvals:** Legacy key retirement and backup expiration; final security review.

### Preventing conflicting authorities

Never use “try verifier, then Express” fallback. Before any new verifier accepts production credentials, disable the legacy Official login route and set legacy Official hashes to `NULL`; ensure verifier storage is complete and verified. During any partial or ambiguous state, Official sign-in is unavailable rather than accepted by either of two inconsistent stores. Candidate/Center routes remain distinct and unchanged. Any staged canary must route only selected synthetic/test identities to the verifier; it must not create dual acceptance for real accounts.

## 14. Security threat analysis

| Threat | Risk | Required mitigation / residual concern |
|---|---|---|
| Express compromise or overly broad DB grant | Current app can read Official hashes and encrypted MFA factors through table-level SELECT; Express also has the legacy decryption key. | Move Official hashes, revoke MFA access, null legacy hashes, remove key from Express, and test role denial. DB superusers and host operators remain trusted. |
| Credential migration leakage | Hashes may appear in SQL logs, dumps, shell output, debug output, or exports. | Offline restricted runner, no row dumps to terminal, no parameter/hash logging, protected backups, access audit, aggregate-only reports. |
| AAD downgrade/mislabel | Legacy ciphertext mislabeled v2 becomes undecryptable or could tempt insecure fallback. | Explicit `aad_version`; per-version decoder; strict v1/v2 dispatch; no fallback guessing; integrity verification before updating metadata. |
| Key compromise | MFA decryption or assertion signing key theft enables factor compromise or forged assertions. | Separate keys and identities, restrictive files/ownership, separate host, no key in Express, rotation/revocation runbook, audit key access. Node KeyObject private memory is not guaranteed zeroized. |
| Assertion replay/race | Stolen assertion or concurrent duplicate consume could mint multiple sessions. | 30-second TTL/five-second skew, private authenticated transport, unique assertion ID, same-transaction consume/session write using DB time, concurrency testing. |
| Browser/transaction substitution | Challenge or browser binding attached to another user, purpose, or browser. | High entropy; hash at rest; strict claim binding; auth-origin cookie; exact Origin checks; purpose binding and test vectors. |
| Stale account state | Approved/disabled status changes race with verifier authentication. | Same-DB status reads/locking or approved synchronous state propagation; check latest `account_status` at password and proof completion; fail closed on stale/outage. |
| MFA replay/factor mutation race | Repeated TOTP step or concurrent factor disable during login. | Lock factor and transactionally advance preserved `last_used_step`; preserve current monotonicity constraints; database-backed concurrency tests. |
| Cookie theft/CSRF | Session bearer used cross-site or exposed to JavaScript/logs. | Host-only Secure HttpOnly cookie, approved SameSite and CSRF controls, no raw bearer in DB/Express, exact CORS/Origin, no-store. Cookie scope and session TTL remain decisions. |
| Untrusted gateway context | Forged forwarded headers or direct access to Express bypasses gateway. | Strip inbound identity headers, private transport authentication, restrict listener/network, bind context to gateway-authenticated request, reject direct ingress. |
| Backup compromise or restore regression | Old DB backup contains legacy hashes/ciphertext; restore could reintroduce Express-readable copies or require retired legacy keys. | Encrypted off-host backups, access separation, restore tests, preserve legacy key custody through backup retention, restore using restricted migration before serving traffic. |
| Recovery/reset abuse | Existing reset schema permits workflow states, but authority and operator identity are unresolved. | Do not invent approver hierarchy; require approved recovery policy, independent operator identity, two-person/break-glass controls, auditable execution. |
| Separate-DB drift | Account disablement/profile state may diverge if identity is replicated asynchronously. | Prefer same database schema for atomic FK/status checks. Separate DB requires reviewed outbox/version protocol and fail-closed staleness behavior. |
| Service co-location | Separate process on the same VPS does not prevent host/root compromise or lateral file access. | Production verifier host/process and dedicated identity as approved in Phase 1; private network, strict egress/ingress, distinct key mount. Infrastructure cost is unresolved. |

## 15. Testing and acceptance criteria

### Existing test evidence inspected

- `server/auth.test.ts`: registration password bound, session parsing/auth gates, roles and trusted origins.
- `server/adminMfaCore.test.ts`: HOTP/TOTP vectors, key/envelope checks, recovery-code primitives, and a static purity check for no Express/database/filesystem/network imports.
- `server/adminMfa.test.ts`: synthetic MFA sign-in/enrollment, key-file decoding, challenge/session transaction behavior, replay/attempt/lockout handling, secret clearing, and static checks against logging.
- `server/adminMfaMigration.test.ts`: static migration structure, factor/replay invariants, no delete/truncate, enrollment ticket checks, and deferred reset consistency.
- `server/databaseGrants.test.ts`: grant-manifest coverage and API privilege expectations; `server/databaseGrants.postgres.integration.test.ts` exists for PostgreSQL integration.
- `src/utils/adminMfa.test.ts`: safe frontend error mapping, six-digit UI behavior, HttpOnly challenge-cookie usage, and Official `RolePortal` handling.
- `server/verifier/*.test.ts`: synthetic bcrypt, config validation, temporary key files, AAD binding, assertions/purpose/expiry/skew, transaction validation, test-local replay fake, TOTP, rate limiting, and health/readiness.

Tests were inspected but **not executed** for this read-only planning task. No production test history is asserted here. Future integration tests require synthetic identities and an explicitly authorized disposable PostgreSQL 17 database; never use real Official credentials or records. No provider/SMS/email calls are required.

### Required future tests

1. **Migration:** source/destination identity-set equality, bcrypt bytes unchanged, all account status and user IDs preserved, all Official hashes null in `public.users`, Candidate/Center hashes unchanged; idempotency and rollback at every boundary.
2. **Bcrypt:** current supported bcrypt variants/costs found in synthetic fixtures; malformed hash; wrong password; empty/oversize input; existing 72-byte compatibility; no hash/password in logs.
3. **MFA migration:** legacy v1 AAD decrypt and v2 decrypt are distinct; wrong user/factor/key version/AAD version fails; preserve IDs, null legacy enrollment association, factor state, `last_used_step`, recovery state, challenge/ticket/reset links, session evidence, audit IDs.
4. **Authorization:** Express/app role denied credential/factor/session/replay data; verifier denied session insert; gateway denied credential/factor/key reads; migrator/owner not usable at runtime.
5. **Protocol:** wrong issuer/audience/key ID/signature/purpose/user/transaction/challenge/browser binding, claim mutation, expiry, 5-second skew boundaries, unknown key version, and transaction max policy unset/invalid all fail closed.
6. **Concurrency:** duplicate assertion consumption, duplicate transaction completion, parallel TOTP use, factor disable race, credential-version change, and account disable during proof cannot mint multiple/invalid sessions.
7. **Browser/API:** exact Origin/CORS and CSRF behavior; cookie attributes; stale/expired transaction; no challenge/assertion in URL/local storage/log; direct Express request and forged forwarded headers rejected.
8. **Operations:** credential database backup/restore, legacy-key retention and retirement, verifier outage, ambiguous commit, host loss, clock drift, key rotation/revocation, and monitoring/alerting tabletop.
9. **Regression:** existing Candidate/Center authentication and Student/Institute verification suites remain behaviorally unchanged; all role/surface authorization tests pass.

## 16. Unresolved operator decisions

The following are blockers, not implied defaults:

1. **Authentication transaction maximum lifetime.** Phase 1 requires an explicit policy argument and intentionally has no default.
2. **Credential migration strategy and window.** Approve controlled offline migration (recommended), maintenance duration, validation reports, and account behavior on mismatch.
3. **Credential database boundary.** Approve same-database `official_auth` schema (recommended first) or a separate database/cluster and the associated identity/status synchronization design.
4. **Password change/reset.** Define who may change/reset, identity proof, reset token lifetime/delivery, rate limits, history/reuse requirements, emergency handling, and session revocation.
5. **MFA recovery approvers/emergency procedure.** Define two-person/single-Super-Admin/break-glass authority, operator identity evidence, and whether current DB constraints match the approved hierarchy. `adminMfaMigration.sql` itself documents unresolved operator identity issue O-1.
6. **AAD version and ciphertext migration.** Approve `aad_version`, v1 compatibility period, v2 key version choice, migration runner, batch/transaction approach, and treatment of pending enrollment.
7. **Key custody and rotation.** Approve production signing and MFA key custody, rotation overlap, revocation, key recovery, legacy key escrow, backup retention, and retirement criteria.
8. **Database ownership/migration runner.** Approve schema owner, migration identity, exact role memberships, function ownership/security-definer policy, grants, and whether `eltnoy_app` table-level SELECT on `users` will be replaced by column-level grants.
9. **Session lifetime and continuity.** Current Express TTL is 12 hours; decide whether it remains, how current sessions are revoked at cutover, and how password change/account disable invalidates Official sessions.
10. **Cookie/origin/CSRF design.** Approve exact auth/API origins, cookie name/scope/SameSite, browser binding cookie, credentialed CORS, CSRF token method, and direct-ingress controls.
11. **Backup and disaster recovery.** Approve encrypted off-host copy, custody, recovery objectives, verifier DB backup role, restore test cadence, legacy ciphertext/key pairing, and incident authorization.
12. **Deployment host isolation and cost.** Confirm separate production verifier host/process/network (not merely a second process on the current VPS), availability, monitoring, and ongoing infrastructure cost.
13. **PostgreSQL 17 and extension policy.** Confirm tested PostgreSQL 17 image and whether pgsodium is actually required. The Phase 1 verifier currently uses Node crypto; no pgsodium function is implemented or validated.
14. **Pending enrollment at cutover.** Decide whether to drain, preserve continuation, or supersede an in-flight factor/challenge. Preserve audit and do not silently reset.
15. **Production canary and rollback authority.** Name approver/operator, define cutover criteria and maximum outage, and confirm rollback is to verifier-only operation or closed Official login—not Express hash access.

## 17. Recommended implementation sequence

1. Resolve operator decisions 1–13 that affect schema, keys, roles, and protocol; in particular choose transaction/session lifetimes and same-DB versus separate-DB boundary.
2. Specify and threat-review the end-to-end protocol, gateway trust model, exact browser binding, cookie/CSRF policy, and atomic assertion-consumption operation.
3. Build only synthetic disposable PostgreSQL 17 migrations and grants; verify Express/app role cannot access Official credential or MFA material.
4. Implement verifier-side credential repository and auth transaction persistence; keep readiness false until required persistence, MFA proof, and atomic consumption are implemented.
5. Implement migration tooling for bcrypt and each MFA state using synthetic fixtures, then validate backup/restore and rollback.
6. Implement gateway session issuance and trusted Express context; add Candidate/Center non-regression tests before changing routing.
7. Complete the Official frontend enrollment/login handoff and approved recovery states; preserve current validation/error states where policy allows.
8. Run independent security review and controlled end-to-end validation; do not use dual-read fallback.
9. Execute approved production cutover only after a separate implementation and operations authorization.
10. After a stable observation period, remove Express Official password/MFA/session paths and retire legacy key custody only after backup retention and restore requirements are satisfied.

## Source evidence and unavailable evidence

All findings above are from checked-in source, migrations, tests, and documentation paths listed in §3. They are not verified against a running database, production environment, access-control catalogs, key files, or deployed DNS/TLS/network configuration. The migration files’ presence and order in `server/migrate.ts` do not prove they have been applied. PostgreSQL 17/pgsodium compatibility, real role ACLs, backup/restore state, production data counts, key ownership, and current infrastructure were not inspected.

This document is a plan only. No source code, package manifest, database schema, database record, credential, MFA record, key, deployment, or infrastructure was modified, and no Phase 2 implementation was started.
