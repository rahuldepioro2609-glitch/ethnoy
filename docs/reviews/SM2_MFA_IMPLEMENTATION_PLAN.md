# Privileged MFA Specification: Super Admin and Officials (self-hosted)

**Status:** Final design specification (AUTH C1.6.1), amended by AUTH C1.8.4. Phases P1 (TOTP core) and P2 (schema and grants, with the C1.8.4 integrity amendment) exist in the working tree only. **Nothing is deployed and no application code uses MFA yet.** Each phase in §11 needs its own owner approval.
**Revision:** 2, dated 2026-11-15. It replaces revision 1 (2026-11-14, "SM-2 Super Admin MFA Implementation Plan"). Differences from revision 1 are listed in §14; the AUTH C1.8.4 amendment (same date) is listed in §14.1.
**Policy:**
- SM2-P03 (Super Admin MFA mandatory before Staff Management go-live).
- SM2-P05 (owner decisions of 2026-11-15: scope, method, recovery, break-glass), in `docs/policy/master-policy-register.md`.

**Constraint:** no SaaS or third-party identity provider (S-07). Only the Node.js standard library and the existing PostgreSQL database. No new dependency is introduced by this specification.

**Labels:**

| Label | Meaning |
|---|---|
| **[code]** | Confirmed current behaviour, with a file reference |
| **[approved]** | Owner decision of 2026-11-15 |
| **[spec]** | This design |
| **[assume]** | Not verified |
| **[owner]** | Still needs a decision (§13) |

---

## 1. Current state (evidence) [code]

**Accounts and roles**
- A Super Admin is an Official with `users.is_super_admin = true` (`server/schema.sql`).
- Promotion happens only through SQL run by `eltnoy_migrator`. `eltnoy_app` cannot update `is_super_admin` (runbook §7).

**Sign-in issues a full session on the password alone**
- `POST /api/auth/login` with `role: 'official'` (`server/index.ts:2028`) issues `elt_session` after the password alone: `INSERT INTO auth_sessions` and `setSessionCookie` (`server/index.ts:2172-2181`).
- `elt_session` is HttpOnly, SameSite=Lax and lasts 12 hours (`server/auth.ts:28-29`, `:103`).
- There is no idle timeout.

**Per-request checks**
- `authorizeRequest` runs on every request (`server/auth.ts:300-345`), in this order:
  1. surface;
  2. session (`loadSession`, SQL at `:200` and `:211`);
  3. account status;
  4. `portalVerificationGate` (`:186`), which states that **Officials and Super Admins are unaffected** (`:185`);
  5. role (`super_admin` means `official` plus the flag, `:335`).
- `ROUTE_POLICY` (`server/surface.ts:483`) maps every route.
  - Unmapped routes fail closed.
  - Official routes are bound to the Admin surface only (`:476`).
  - The central enforcement is in `server/surfaceEnforcement.ts`.

**Privileged routes in `server/index.ts`**
- 12 routes carry `requireSuperAdmin` (`:373, :428, :751, :769, :1547, :1614, :2256, :2261, :2440, :2488, :2713`, among others).
- 34 routes carry `requireRoles('official')`.
- Admin routers are mounted at `:2827` (Platform Staff), `:2831` (institute verification) and `:2835` (Organization Staff).

**Audit storage**
- `auth_verification_events` (`server/authVerificationMigration.sql:116-145`) is append-only: UPDATE, DELETE and TRUNCATE triggers reject changes.
- It is indexed by user and by action, and SM2-P04 Super Admin decisions are already audited there.

**Migrations and grants**
- Migration order is set by `MIGRATION_FILES` (`server/migrate.ts:33-41`).
- `databaseGrantsMigration.sql` refuses any table missing from its manifest (`:150-158`).

**No MFA code exists anywhere.**

---

## 2. Final MFA policy [approved]

| Subject | Rule |
|---|---|
| **Super Admin** | Mandatory TOTP MFA. |
| **All Officials** | Mandatory TOTP MFA. This is one rule for the `official` role, so the sign-in response never reveals who is a Super Admin. |
| **Platform Staff** | A separate future phase. Not covered here. |
| **Institute and Organization Staff** | Outside this phase. |
| **Factor** | TOTP (RFC 6238) in an authenticator application the user chooses (ELTNOY names no vendor), plus single-use recovery codes. |
| **Excluded** | Email OTP and SMS OTP can **never** substitute for privileged MFA, in any flow (sign-in, step-up, recovery or reset). |
| **WebAuthn** | A future enhancement. Not in this specification. |
| **Recovery** | Initiated by an MFA-verified Super Admin other than the target. **A Super Admin target needs two-person authorization**: the initiator and the approver are different Super Admins, neither of them the target. **An ordinary Official target needs one Super Admin other than the target**, MFA-verified with fresh step-up (D-1). Nobody resets or approves for themselves. Reason, initiator, approver, target and time are audited. A reset revokes every session of the target and makes fresh enrolment mandatory. |
| **No disable switch** | No API, frontend path, setting or environment variable disables MFA for any Official. Enforcement is unconditional in code (§10). |
| **Break-glass** | An operator CLI, only when a second Super Admin is unavailable. It requires strict host access, a reason and an incident reference, and it is audited (§7). |

**Reset modes (D-1, owner decision approved for AUTH C1.8).** The approval mode follows the target and is checked by the database:

| Target | Mode | Who acts |
|---|---|---|
| Super Admin | `two_person` | An initiating Super Admin, then a **different** approving Super Admin, who issues the ticket and executes |
| Ordinary Official | `single_super_admin` | One Super Admin other than the target, who initiates, issues the ticket and executes |

(Earlier text of this revision applied two-person resets to every Official; D-1 replaced that reading.)

---

## 3. Factor and cryptography [spec]

**TOTP**
- Parameters: RFC 6238 with HMAC-SHA1, 6 digits and a 30-second step. These are the parameters authenticator applications support universally.
- Step window: accepted steps are `t-w … t+w`; the value `w` is in §12.
- Secret: 20 random bytes from `crypto.randomBytes`, shown in Base32 exactly **once**, during enrolment.

**Secret at rest**
- Encrypted with AES-256-GCM (`node:crypto`), with a random 12-byte nonce per encryption and the 16-byte tag stored separately.
- Additional authenticated data: `factor id ‖ user id ‖ key_version`, so ciphertext cannot be moved between rows.
- `key_version` selects the key from a key ring. Rotation is a separately approved maintenance script.

**Recovery codes**
- A batch is generated at enrolment confirmation and on regeneration. The batch size and code length are in §12.
- Each code is stored as `HMAC-SHA256(ADMIN_MFA_HMAC_KEY, user_id ‖ normalised code)`.
- Codes are compared in constant time. They are shown once.

**Tokens**
- Challenge tokens and enrolment tickets are 32 random bytes, Base64url encoded.
- Only their SHA-256 is stored, as with `elt_session` (`server/auth.ts:95`).

**Keys**
- `ADMIN_MFA_ENCRYPTION_KEY_FILE`: exactly 32 bytes.
- `ADMIN_MFA_HMAC_KEY_FILE`: at least 32 bytes.
- Both are read from files only, never from environment values, with a minimum length; they fail closed (§10.3) and are never logged.
- They are present **only** in the `api_admin` container.

**Comparisons and time**
- All comparisons use `timingSafeEqual`.
- No fixed, development or bypass code exists. The static test in `server/authVerification.test.ts` is extended to scan the MFA files.
- The clock is injectable for tests. Freshness checks use the database clock (`clock_timestamp()`), so skew between the application and the database cannot extend a window.

---

## 4. Sign-in, gate and session evidence [spec]

### 4.1 Sign-in for any Official
1. `POST /api/auth/login` (Admin surface, role `official`).
   - The password check is unchanged.
   - On success **no `elt_session` is created.** The server creates an `admin_mfa_challenges` row and sets the pending cookie `elt_admin_mfa`: HttpOnly, Secure in production, SameSite=Strict, `Path=/api/auth/mfa`, and lasting only as long as the challenge.
   - Response `202`:
     - `{ status: 'mfa_required' }` if the user has a confirmed active factor (challenge purpose `login`);
     - `{ status: 'mfa_enrolment_required' }` otherwise (challenge purpose `enrol`).
2. `POST /api/auth/mfa/verify { code }`. One transaction under the per-user MFA advisory lock (§4.4):
   1. load the open `login` challenge by the cookie's hash;
   2. reserve one attempt atomically (`UPDATE … SET attempts = attempts + 1 WHERE … attempts < max RETURNING`);
   3. check the per-account throttle;
   4. verify TOTP against the active confirmed factor;
   5. **replay guard:** `UPDATE admin_mfa_factors SET last_used_step = $s WHERE id = $f AND disabled_at IS NULL AND last_used_step < $s`, which must affect exactly one row;
   6. consume the challenge (`consumed_at`, `consumed_reason = 'verified'`);
   7. insert `auth_sessions`;
   8. insert `auth_session_mfa_verifications` (purpose `login`, method `totp`);
   9. append the audit event.

   **Only after the commit** does the server set a newly minted `elt_session` and clear `elt_admin_mfa`.
3. `POST /api/auth/mfa/recovery { code }` follows the same steps with a recovery code (method `recovery_code`).
   - The code is marked used with `UPDATE … SET used_at WHERE id AND used_at IS NULL AND revoked_at IS NULL`, which must affect exactly one row.
   - A recovery-code session **never satisfies step-up** (§5).
4. A failed code returns `400 MFA_CODE_INVALID` with the attempts remaining. When attempts are exhausted the challenge is consumed (`consumed_reason = 'locked'`) and the response is `429 MFA_CHALLENGE_LOCKED`. When the per-account throttle is hit the response is `429 MFA_THROTTLED`. An expired or unknown challenge returns `410 MFA_CHALLENGE_EXPIRED`.

### 4.2 Session evidence: append-only rows
`auth_session_mfa_verifications` is insert-only. A session has one row per MFA verification: the sign-in, the enrolment confirmation, and every step-up.

### 4.3 Gate (every request)
- `loadSession` (`server/auth.ts:200`) is extended with one lateral subquery returning:
  - `mfa_verified`: any evidence row for the token hash;
  - `last_totp_age_seconds`: `clock_timestamp() - max(verified_at) FILTER (WHERE method = 'totp')`;
  - `has_active_factor`: whether a confirmed factor with `disabled_at IS NULL` exists for the user.
- `portalVerificationGate` (`server/auth.ts:186`) refuses **every `official` session** unless `mfa_verified AND has_active_factor`.
  - The refusal is `403 ADMIN_MFA_REQUIRED`, the session cookie is cleared, and the comment at `:185` is replaced.
- Consequences:
  - Every session issued before deployment has no evidence row, so it is **refused on its next request** (§10.4).
  - Even if a session row somehow survived a reset, `has_active_factor` is false until re-enrolment, so the session is refused (defence in depth behind §6.4).
  - A missing MFA table (`42P01`) or any lookup error means no evidence, so the session is refused (fail closed). The mechanism is the same one AUTH-1 uses.

### 4.4 Concurrency primitives
- **Per-user MFA lock:** `pg_advisory_xact_lock(<MFA namespace>, hashtext(user_id))`. It is taken by sign-in verify, recovery, enrolment confirm, step-up verify, reset execution, break-glass and ticket issue. Lock order: user lock first, then row locks.
- **Per-account throttle:** count `admin_mfa.code_rejected` events for the user within the throttle window, under the same lock. This is the same pattern as the C1 SMS buckets, so concurrent requests cannot both pass the limit.
- The existing per-address `authLimiter` (`server/index.ts:103-109`) also applies to `/api/auth/mfa/*`.

---

## 5. Step-up authentication [spec]

### 5.1 Which actions require step-up
Step-up is declared **per route in `ROUTE_POLICY`** with a new field `stepUp?: true`.

| Group | Routes |
|---|---|
| Super Admin mutations in `server/index.ts` | `:428` admit-card import, `:751` answer keys, `:769` online exams, `:1547` institute credits, `:1614` withdrawals, `:2261` feedback update, `:2440` ownership verification, `:2488` admit card, `:2713` results |
| Super Admin bulk read | `:373` data export |
| Institutional verification and suspension | `POST`/`PUT`/`PATCH` routes of the institute-verification admin router (`:2831`) |
| Staff management | `POST`/`PUT`/`PATCH` routes of the Platform Staff (`:2827`) and Organization Staff (`:2835`) admin routers |
| MFA administration (§8) | Ticket issue, recovery-code regeneration, and reset initiation, approval, rejection and cancellation |

Whether ordinary Official mutations (the 34 `requireRoles('official')` routes) also need step-up is decision **D-3**. The default is no: they need sign-in MFA only.

A static test fails the build if any route carrying `requireSuperAdmin` with a mutating method, or any MFA-administration route, lacks `stepUp: true` in `ROUTE_POLICY`.

### 5.2 Creating a fresh challenge
- `POST /api/auth/mfa/step-up/start` needs a valid, MFA-verified `elt_session` and a confirmed active factor.
- In one transaction under the per-user lock:
  1. close any open `step_up` challenge for this session (`consumed_reason = 'superseded'`);
  2. insert a new `admin_mfa_challenges` row with `purpose = 'step_up'`, `user_id` and `session_token_hash` = the current session's hash.
- No cookie or token is returned. The challenge is found again through the session.
- A partial unique index allows at most one open `step_up` challenge per session.

### 5.3 Binding to user and session
- `POST /api/auth/mfa/step-up/verify { code }` looks up the challenge `WHERE session_token_hash = <current session> AND user_id = <session user> AND purpose = 'step_up' AND consumed_at IS NULL AND expires_at > clock_timestamp()`.
- Another user's or another session's challenge can never match.
- A `CHECK` requires `session_token_hash IS NOT NULL` exactly when `purpose = 'step_up'`.

### 5.4 Updating evidence on success
The steps are the same as §4.1, in one transaction:
1. reserve an attempt;
2. check the throttle;
3. verify TOTP;
4. apply the **shared** `last_used_step` replay guard;
5. consume the challenge;
6. insert an `auth_session_mfa_verifications` row (purpose `step_up`, method `totp`, `factor_id`);
7. append the event.

The session token is **not** changed. The evidence is attached to the existing session.

### 5.5 Freshness and expiry
- Step-up is satisfied when `last_totp_age_seconds <= STEP_UP_WINDOW` (value in §12). The age is computed on every request by the database clock (§4.3), so nothing stored has to expire.
- The sign-in TOTP counts as a step-up verification. A recovery-code sign-in does **not**.
- When the window lapses, the route answers `401 MFA_STEP_UP_REQUIRED` before the handler runs, so there is no side effect. The user starts a new step-up.

### 5.6 Replay and concurrency
- **Same code, two requests:** the `last_used_step` guard is shared by sign-in and step-up, so a TOTP code used once (for either) is rejected at every later use, including concurrent requests. Exactly one transaction can raise `last_used_step` to `s`.
- **Parallel verifies of one challenge:** attempt reservation is atomic, and consumption is conditional (`WHERE consumed_at IS NULL`), so only one succeeds.
- **Old step-up evidence:** it is time-bound and session-bound, so it cannot be moved to another session.

### 5.7 Direct API calls cannot bypass step-up
- Enforcement lives in the **central** enforcement path (`server/surfaceEnforcement.ts` and `authorizeRequest`).
- Order of checks:
  1. surface;
  2. session;
  3. account status;
  4. MFA gate;
  5. role;
  6. `stepUp`.
- It runs before any route middleware or handler. Frontend state is never consulted.
- Tests iterate every `ROUTE_POLICY` entry with `stepUp: true` and call it directly, with an MFA session whose TOTP evidence is (a) missing, (b) older than the window, or (c) from a recovery code only. Each must give 401 and leave the stubbed store untouched.

### 5.8 Revocation and reset
- A revoked session fails `loadSession` before any step-up check. Its open step-up challenge can no longer be found, because the verify call itself needs the session.
- A reset (§6.4) revokes all the target's sessions and consumes the target's open challenges (`consumed_reason = 'revoked'`) in the same transaction.
- **Recovery codes never satisfy step-up** [approved]. Changing that needs a separate owner approval (D-4).

---

## 6. MFA reset: two-person for Super Admins, single Super Admin for ordinary Officials [spec, implementing the approved policy]

### 6.1 Eligibility
- **Initiator, approver and rejecter:** an approved Super Admin (`role = 'official' AND is_super_admin AND account_status = 'approved'`) with a confirmed active factor, an MFA-verified session and **fresh TOTP step-up**.
- **Target:** an approved or suspended `official` (Super Admin or not) who is neither the initiator nor the approver.
- **Mode (D-1):** `two_person` when the target is a Super Admin (approver ≠ initiator); `single_super_admin` when the target is an ordinary Official (the initiating Super Admin executes). The database refuses a request whose mode does not match the target, and refuses execution in `single_super_admin` mode if the target has since become a Super Admin.
- **Self-service:** nobody can reset their own MFA through this workflow.

### 6.2 States

```
            initiate
               │
               ▼
          ┌─────────┐  approve (two_person: a different eligible SA;
          │         │           single_super_admin: the initiator) ─► executed
          │ pending │  reject  (eligible SA other than initiator) ► rejected
          └─────────┘  cancel  (initiator) ───────────────────────► cancelled
               │       expires_at passed (closed lazily) ─────────► expired
               │       break-glass reset of the same target ──────► superseded
```

All end states are terminal. Only `pending` can change.

### 6.3 Operations

| Step | Endpoint | Atomic rule |
|---|---|---|
| **Initiate** | `POST /api/admin/mfa/reset-requests { targetUserId, reason }` | Under the **target's** per-user lock: close stale pending rows (`status = 'expired'` where `expires_at <= clock_timestamp()`), then insert `pending`. A partial unique index allows one `pending` per target. A second request gets `409 MFA_RESET_REQUEST_EXISTS`. Refused if the target is the initiator (`403 MFA_RESET_SELF_FORBIDDEN`). |
| **Approve** | `POST /api/admin/mfa/reset-requests/:id/approve` | See below. |
| **Reject** | `POST /api/admin/mfa/reset-requests/:id/reject { reason }` | Conditional update to `rejected`. The rejecter must not be the initiator, who uses cancel instead. |
| **Cancel** | `POST /api/admin/mfa/reset-requests/:id/cancel` | Initiator only; conditional update to `cancelled`. |
| **List** | `GET /api/admin/mfa/reset-requests` | Super Admins; MFA session (no step-up). Shows pending and recent requests, never tickets. |

**Approve** runs in one transaction under the target's per-user lock:
1. Lock the request:
   ```sql
   SELECT … FROM admin_mfa_reset_requests
    WHERE id = $1 AND status = 'pending' AND expires_at > clock_timestamp()
      FOR UPDATE
   ```
   - No row: `409 MFA_RESET_REQUEST_NOT_PENDING`.
   - Approver equal to the initiator or the target: `403 MFA_RESET_SELF_APPROVAL_FORBIDDEN`. This is checked in the application **and** by a database `CHECK`.
2. **Re-check the initiator** at approval time (two-person): still an approved Super Admin with an active factor. Otherwise the request is refused and closed as `rejected` with the system reason `initiator_ineligible`.
3. **Freshness.** Two-person: the approver's latest TOTP evidence must be **newer than the request's `created_at`** as well as within the step-up window, so the approver proves possession after seeing the request. Single Super Admin: the initiator's evidence must be within the step-up window (an application check; the database requires TOTP evidence from a live session but cannot know the window).
4. Execute the reset (§6.4), which issues the new ticket. The executing Super Admin is the approver (two-person) or the initiator (single Super Admin), and must also be the ticket's issuer.
5. Close the request:
   ```sql
   UPDATE admin_mfa_reset_requests
      SET status = 'executed', decided_by = $approver, decided_at = clock_timestamp(), ticket_id = $ticket
    WHERE id = $1 AND status = 'pending'
   ```
   It must affect exactly one row, otherwise the whole transaction rolls back. The status and the ticket are written in one statement, so the `CHECK` that an executed request has a ticket always holds.

Duplicate or concurrent approve, reject and cancel calls serialise on the target's per-user lock and the row lock, and each re-checks `status = 'pending'`. Exactly one wins; the others get `409`.

### 6.4 Reset execution
This is the single atomic store function `executeMfaReset(target, via, actor…)`, shared with break-glass. In the same transaction as the state change, it:
1. disables the active factor (`disabled_at`, `disabled_by` = the executing Super Admin, `disabled_via = 'two_person_reset' | 'single_approver_reset'`; for break-glass `disabled_via = 'break_glass'` with no `disabled_by`);
2. revokes every unused recovery code of the target (`revoked_at`);
3. revokes every unused enrolment ticket of the target (`revoked_at`);
4. consumes every open challenge of the target (`consumed_reason = 'revoked'`);
5. **revokes every session of the target**: `UPDATE auth_sessions SET revoked_at = clock_timestamp() WHERE user_id = $target AND revoked_at IS NULL`. The number of sessions revoked is recorded in the audit event;
6. issues one new enrolment ticket (`issued_via = 'two_person_reset' | 'single_approver_reset'`, issued by the executing Super Admin, with `reset_request_id`; or `'break_glass'` with no issuer and no request) and returns its id to the caller, which records it on the request (§6.3, step 5);
7. appends the audit events (§9), including `admin_mfa.reset_executed` with `details.requestId` (or `admin_mfa.break_glass_reset` for break-glass).

The order matters: the factor is disabled **before** the ticket is issued and the request is closed (steps 1 to 7, then §6.3 step 5).

**Commit-time integrity (AUTH C1.8.4, enforced by the database).** Deferred constraint triggers re-read the final state at `COMMIT` and refuse it, so PostgreSQL rolls back the **whole** transaction, unless:
- the reset ticket's request is `executed`, names this ticket, and has the same target, the same decider as issuer, and the matching mode (a ticket can therefore never outlive a reset that did not complete);
- for the target: no active factor, no unused recovery code, no open challenge, no other open ticket and no unexpired session; the replacement ticket is still open; and the `admin_mfa.reset_executed` event for this request exists;
- every reset-labelled factor disable belongs to a matching reset decided **later in the same transaction** by the same Super Admin (so a factor can never be disabled outside a reset); `enrolment_superseded` applies only to an unconfirmed factor.

Consequences for the application (Phases 3 to 7): a `COMMIT` can now fail, and must be treated as a full rollback and reported. Retries after a failure start from the unchanged state; a retry after a success finds nothing pending. Concurrent approvals serialise on the factor row, the request row and the one-open-ticket index: one commits, the other is refused.

**Fresh enrolment is then mandatory.** The target signs in with their password, receives `mfa_enrolment_required`, and enrols with the ticket (§8.1). The account has no MFA-verified session until that is done.

**Ticket handover.** The ticket token is returned **once**, in the executing Super Admin's response, and handed to the target out-of-band. The channel is decision D-6.

**A concurrent sign-in by the target** is serialised by the per-user lock:
- if the sign-in commits first, its new session is revoked by the reset;
- if the reset commits first, the factor is disabled and the code is refused.

### 6.5 Session loss during the workflow

| Situation | Behaviour |
|---|---|
| The initiator loses their session | The request lives on independently of sessions and stays `pending` until approval, rejection, cancellation or expiry. The initiator may sign in again and cancel. |
| The approver loses their session before approving | Nothing has changed. Any eligible Super Admin may approve later. |
| The approver loses the response after a committed approval (ticket lost) | The reset has executed and the target has no factor. Tickets cannot be retrieved, because only hashes are stored. Recovery is a **new** reset request for the same target, in the mode that target requires (two-person for a Super Admin, single Super Admin for an ordinary Official). It then only revokes the lost ticket and issues a new one (the factor is already disabled). There is no other re-issue path: a first-time ticket is refused because the target has enrolled before. |
| The target is mid-sign-in or mid-step-up | Revoked or refused, as in §6.4. |
| The approver's or initiator's step-up expires | The request returns `401 MFA_STEP_UP_REQUIRED`. Nothing changes; repeat after step-up. |

### 6.6 First-time tickets (not a reset)
- A single Super Admin with step-up may issue an enrolment ticket **only** for an Official who has **never** had a confirmed factor (`issued_via = 'super_admin'`).
- If the target has ever had a confirmed factor, ticket issue is refused with `409 MFA_RESET_REQUIRED`, and the reset workflow of §6 (in the target's mode) must be used. Reset is therefore the only way to replace an existing factor.
- **Database enforcement (AUTH C1.8.4).** At ticket `INSERT`, the database refuses:
  - an issuer who is not an approved Super Admin with a confirmed, active factor (any ticket with an issuer);
  - a first-time ticket for anyone who has ever had a confirmed factor (disabled factors keep `confirmed_at`);
  - a reset ticket whose request is missing, not `pending`, expired, for another target, of the other mode, or issued by the wrong person (two-person: never the initiator; single Super Admin: only the initiator).
- **O-4 (mandatory Phase 4 requirement, not yet enforced by the database):** creating a factor must require an open, unexpired enrolment ticket of the same user bound to the enrolment challenge, and confirming it must mark that ticket used in the same transaction. Until Phase 4 adds this, the database does not stop the application role from enrolling a factor without a ticket.

---

## 7. Break-glass procedure [spec, implementing the approved policy]

### 7.1 When
- Only when the two-person workflow **cannot** be completed because a second eligible Super Admin is unavailable. Examples: only one eligible Super Admin exists besides the target, or the target is the only Super Admin.
- It is never a convenience alternative.

### 7.2 Commands
The CLI is a new `server/adminMfaCli.ts` with `package.json` scripts. There is **no HTTP route**.

| Command | Purpose | Refuses unless |
|---|---|---|
| `admin-mfa:bootstrap-ticket --target <LOGIN_ID>` | First enrolment of the first Super Admin | The target is an approved Super Admin who has never had a confirmed factor, **and no Super Admin anywhere has a confirmed factor**. After the first enrolment, tickets come only from §6.6 or §6. |
| `admin-mfa:break-glass-reset --target <LOGIN_ID> --incident <REF> --reason <TEXT> --attest-no-second-super-admin` | Lost factor with no second approver | All flags are present; there is an interactive TTY (non-TTY is refused); the operator retypes the target login ID; the target is an approved or suspended Official. |

### 7.3 Controls
- **Host access.** The command runs only inside the `api_admin` container on the production host. The operator reaches it over WireGuard with host `sudo` (runbook §8 custodians; UD-2 and D-7). It uses the API's existing database credential file and MFA key files. It accepts no network input.
- **O-1, open and to be resolved before Phase 7.** Because the CLI and the API share database credentials, **no database trigger can tell which of them issued a bootstrap or break-glass ticket**. The application role can therefore insert such tickets. The database checks the **workflow** (below), not the caller; application-supplied event details (operator identity, host, incident) are records, never proof of identity. Restricting these paths at the database level needs a separately approved design (for example a dedicated operator database role).
- **Database workflow checks (AUTH C1.8.4).**
  - *Bootstrap ticket:* only for an approved Super Admin, while no Super Admin has a confirmed factor and no other bootstrap ticket is open and unexpired. The check runs after a transaction-level advisory lock (`pg_advisory_xact_lock(7342519187)`, released at `COMMIT` or `ROLLBACK`), and only under `READ COMMITTED` (other isolation levels are refused, because their snapshot would predate the lock). Two concurrent bootstrap commands therefore cannot both pass. Ordinary enrolment and resets never take this lock.
  - *Break-glass reset:* at `COMMIT`, the factor disable (`break_glass`, no `disabled_by`) must be followed in the same transaction by a break-glass ticket; any `pending` request for the target must be `superseded`; an `admin_mfa.break_glass_reset` event for the target must exist; and every reset invariant of §6.4 must hold.
- **Same atomic path.** It calls the same `executeMfaReset` (§6.4) with `via = 'break_glass'`, so it revokes all sessions and issues a fresh ticket. Any `pending` reset request for the target is closed as `superseded`.
- **Evidence the CLI records.** It records the following but **does not trust them for authorization**:
  - the OS operator identity (`SUDO_USER` or `USER`, labelled self-asserted);
  - the hostname;
  - the incident reference and reason;
  - the **number of other eligible Super Admins at that moment**.

  A non-zero count is allowed, because "unavailable" cannot be proved by software, but it is highlighted in the event and the review.
- **Output.** The ticket is printed once to the TTY and never written to logs. Logs carry only the event id.
- **Detection.**
  - Every Super Admin dashboard shows an unacknowledged-break-glass banner listing each `admin_mfa.break_glass_reset` event.
  - The incident is recorded **outside** the database (runbook §8).
  - A post-incident review is mandatory.
  - A recurring review counts break-glass events.
- **Optional two-operator rule:** decision D-7.

---

## 8. API and frontend specification [spec]

All routes are Admin-surface only (`only('admin', …)` in `ROUTE_POLICY`) and behind WireGuard (SM2-P02).

### 8.1 Endpoints

**Pre-session** (authenticated by the `elt_admin_mfa` challenge cookie; per-address limiter):

| Method and path | Purpose | Success | Errors |
|---|---|---|---|
| `POST /api/auth/login` (official) | Password step | `202 {status:'mfa_required'}` or `202 {status:'mfa_enrolment_required'}`; never `elt_session` | Existing codes; `503 ADMIN_MFA_UNAVAILABLE` if keys or schema are missing |
| `POST /api/auth/mfa/verify {code}` | TOTP sign-in | `200 {user}` and a new `elt_session` | `400 MFA_CODE_INVALID`, `410 MFA_CHALLENGE_EXPIRED`, `429 MFA_CHALLENGE_LOCKED`, `429 MFA_THROTTLED` |
| `POST /api/auth/mfa/recovery {code}` | Recovery-code sign-in | `200 {user, recoveryCodesRemaining}` | As above |
| `POST /api/auth/mfa/enrol/start {ticket}` | Bind the ticket to the `enrol` challenge and create an unconfirmed factor | `200 {otpauthUri, secretBase32}`, **once** | `400 MFA_TICKET_INVALID` (unknown, used, expired, revoked or another user's, all one code) |
| `POST /api/auth/mfa/enrol/confirm {code}` | Confirm the factor; mark the ticket used; issue recovery codes; create the session with `enrol` evidence | `200 {user, recoveryCodes}` (codes **once**) and a new `elt_session` | `MFA_CODE_INVALID`, `MFA_CHALLENGE_EXPIRED` |

**MFA session** (`elt_session` with evidence):

| Method and path | Step-up | Purpose |
|---|---|---|
| `GET /api/auth/mfa/status` | No | Own state: enrolled, recovery codes remaining, last TOTP age. Never secrets |
| `POST /api/auth/mfa/step-up/start` | — | §5.2 |
| `POST /api/auth/mfa/step-up/verify {code}` | — | §5.4. Errors as for sign-in verify |
| `POST /api/admin/mfa/recovery-codes` | **Yes** | Regenerate own batch; revokes the previous batch; codes shown once |
| `POST /api/admin/mfa/enrolment-tickets {userId}` | **Yes**, Super Admin | §6.6 (never-enrolled only) |
| `GET /api/admin/mfa/reset-requests` | No, Super Admin | §6.3 |
| `POST /api/admin/mfa/reset-requests` | **Yes**, Super Admin | Initiate |
| `POST /api/admin/mfa/reset-requests/:id/approve` | **Yes** (TOTP after `created_at`), Super Admin | Approve and execute |
| `POST /api/admin/mfa/reset-requests/:id/reject` | **Yes**, Super Admin | Reject |
| `POST /api/admin/mfa/reset-requests/:id/cancel` | **Yes**, initiator | Cancel |
| `POST /api/admin/mfa/break-glass/:eventId/acknowledge` | **Yes**, Super Admin | Acknowledge the banner. This appends an event; it changes no state |

**Endpoints that do not exist (by design):** disable, delete factor, change enforcement, self-reset, and any SMS or email MFA route. A test asserts that no `ROUTE_POLICY` entry under `/api/auth/mfa` or `/api/admin/mfa` matches `disable|off|bypass|skip`, and that the only factor-disabling SQL lives in `executeMfaReset` and enrolment supersession.

### 8.2 Frontend
Built with the existing `src/api.ts` helpers and the `RolePortal` / `LoginModal` patterns (official sign-in at `src/components/RolePortal.tsx:183`, `src/components/LoginModal.tsx:32`).

| Screen or component (new) | States |
|---|---|
| `AdminMfaChallenge.tsx` | Code entry (6 digits, numeric, `autocomplete="one-time-code"`); invalid code with attempts left; locked; throttled; expired (back to password); "Use a recovery code" |
| `AdminMfaEnrolment.tsx` | Ticket entry; secret shown as text URI and Base32 (QR only if D-8 approves a dependency); confirmation code; recovery codes shown once, with copy, download and print, and an "I have saved these" acknowledgement required before continuing |
| `AdminMfaStepUpDialog.tsx` | Opened by a central handler in `src/api.ts` when any call returns `401 MFA_STEP_UP_REQUIRED`. Code entry, then **re-issue the original request**. The frontend never decides freshness itself |
| `AdminMfaManagement.tsx` (Super Admin) | Issue a first-time ticket; reset requests list (pending, executed, rejected, cancelled, expired, superseded); initiate (target and reason); approve or reject (shows initiator, reason, age); one-time ticket display after approval; break-glass banner with acknowledgement |
| Profile area in `RolePortal.tsx` | MFA status, codes remaining, regenerate codes (step-up). "Lost your device? Ask a Super Admin to start an MFA reset." No self-service reset |
| Session handling | `403 ADMIN_MFA_REQUIRED` or a revoked session returns to sign-in with a neutral message |

Frontend state is presentation only. Every rule is enforced by the API (§5.7, §10).

---

## 9. Database design [spec]

New migration `server/adminMfaMigration.sql`: additive and idempotent (`CREATE … IF NOT EXISTS`). Every foreign key is `ON DELETE RESTRICT`. Every timestamp is `timestamptz`.

| Table | Columns | Constraints and indexes | Application grants (`eltnoy_app`) |
|---|---|---|---|
| `admin_mfa_factors` | `id`, `user_id → users`, `kind` (`'totp'`), `secret_ciphertext bytea`, `secret_nonce bytea`, `secret_tag bytea`, `key_version int`, `created_at`, `confirmed_at`, `last_used_step bigint NOT NULL DEFAULT -1`, `disabled_at`, `disabled_by → users` (null for CLI), `disabled_via` (`'two_person_reset'`, `'break_glass'`, `'enrolment_superseded'`) | Partial unique `(user_id, kind) WHERE disabled_at IS NULL`; `CHECK ((disabled_at IS NULL) = (disabled_via IS NULL))` | SELECT, INSERT; UPDATE (`last_used_step`, `confirmed_at`, `disabled_at`, `disabled_by`, `disabled_via`) |
| `admin_mfa_recovery_codes` | `id`, `user_id`, `factor_id → admin_mfa_factors`, `code_hash`, `created_at`, `used_at`, `revoked_at` | Unique `code_hash`; index `(user_id) WHERE used_at IS NULL AND revoked_at IS NULL`; `CHECK (used_at IS NULL OR revoked_at IS NULL)` | SELECT, INSERT; UPDATE (`used_at`, `revoked_at`) |
| `admin_mfa_challenges` | `id` (SHA-256 of the token, or random for step-up), `user_id`, `purpose` (`'login'`, `'enrol'`, `'step_up'`), `session_token_hash → auth_sessions`, `enrolment_ticket_id`, `attempts int`, `created_at`, `expires_at`, `consumed_at`, `consumed_reason` (`'verified'`, `'locked'`, `'superseded'`, `'revoked'`) | `CHECK ((purpose = 'step_up') = (session_token_hash IS NOT NULL))`; `CHECK (expires_at > created_at)`; partial unique `(session_token_hash) WHERE purpose = 'step_up' AND consumed_at IS NULL`; `CHECK ((consumed_at IS NULL) = (consumed_reason IS NULL))` | SELECT, INSERT; UPDATE (`attempts`, `enrolment_ticket_id`, `consumed_at`, `consumed_reason`) |
| `admin_mfa_enrolment_tickets` | `id` (hash), `user_id`, `issued_by → users` (null for CLI), `issued_via` (`'super_admin'`, `'bootstrap_cli'`, `'two_person_reset'`, `'break_glass'`), `reset_request_id`, `created_at`, `expires_at`, `used_at`, `revoked_at` | Partial unique `(user_id) WHERE used_at IS NULL AND revoked_at IS NULL`; `CHECK (used_at IS NULL OR revoked_at IS NULL)` | SELECT, INSERT; UPDATE (`used_at`, `revoked_at`) |
| `auth_session_mfa_verifications` | `id`, `token_hash → auth_sessions`, `user_id`, `purpose` (`'login'`, `'enrol'`, `'step_up'`), `method` (`'totp'`, `'recovery_code'`), `factor_id`, `verified_at DEFAULT clock_timestamp()` | `CHECK (purpose <> 'step_up' OR method = 'totp')`; index `(token_hash, verified_at DESC)` | SELECT, INSERT (insert-only) |
| **`admin_mfa_reset_requests`** (new in this revision) | `id`, `target_user_id`, `initiated_by`, `reason`, `created_at`, `expires_at`, `status` (`'pending'`, `'executed'`, `'rejected'`, `'cancelled'`, `'expired'`, `'superseded'`), `decided_by`, `decided_at`, `decision_reason`, `ticket_id` | `CHECK (initiated_by <> target_user_id)`; `CHECK (decided_by IS NULL OR (decided_by <> target_user_id AND (status <> 'executed' OR decided_by <> initiated_by)))`; `CHECK ((status = 'pending') = (decided_at IS NULL))`; `CHECK (status <> 'executed' OR ticket_id IS NOT NULL)`; partial unique `(target_user_id) WHERE status = 'pending'`; bounded `reason` length | SELECT, INSERT; UPDATE (`status`, `decided_by`, `decided_at`, `decision_reason`, `ticket_id`) |

**Not granted to anyone:** DELETE or TRUNCATE on any of these tables. A transition-guard trigger on `admin_mfa_reset_requests` rejects any `UPDATE` whose `OLD.status <> 'pending'`, so a terminal state cannot change even through a bug.

**Commit-time integrity (AUTH C1.8.4).** Three `DEFERRABLE INITIALLY DEFERRED` constraint triggers share one function, `check_admin_mfa_reset_commit()`:

| Trigger | Fires at commit for | Refuses unless |
|---|---|---|
| `admin_mfa_reset_requests_commit_check` | a request moving `pending` → `executed` | it is linked to the open replacement ticket its decider issued, its `admin_mfa.reset_executed` event exists, and the §6.4 invariants hold for the target |
| `admin_mfa_enrolment_tickets_commit_check` | a new reset or break-glass ticket | a reset ticket's request is `executed` with this ticket, target, issuer and mode; a break-glass ticket is open, supersedes any pending request, is audited, and the §6.4 invariants hold |
| `admin_mfa_factors_commit_check` | a factor disabled with a reset or break-glass label | a matching reset (same Super Admin, same mode) was decided, or a break-glass ticket issued, after the disable in the same transaction |

- **Fresh reads.** The function re-reads the current rows by id instead of trusting the `NEW` image of an earlier statement.
- **Same-transaction tests.** It decides "in this transaction" from trigger-stamped `clock_timestamp()` values compared with `now()` (the transaction start).
- **No helper functions.** It calls none, because the grants migration revokes EXECUTE on every function.
- **Cannot be skipped.** `SET CONSTRAINTS … IMMEDIATE` can only run these checks earlier. Disabling triggers needs ownership, and `session_replication_role` is denied to the application role.
- **No table, column or grant changes.** The amendment is limited to functions and triggers.

**Existing tables touched (data only, no structural change):**
- `auth_sessions.revoked_at`: already updated by logout (`server/index.ts:2206`).
- `auth_verification_events`: INSERT.

**Audit: reuse `auth_verification_events`, with no new audit table.**
- It is already append-only (triggers), indexed by `(user_id, occurred_at)` and `(action, occurred_at)`, granted SELECT and INSERT only, and already holds Super Admin decisions (SM2-P04).
- A second append-only table would duplicate the triggers, grants and tests for no gain.
- This replaces revision 1's `admin_mfa_events`.

Events (`user_id` = the account concerned; `details` = `actorId`, `actorKind` (`user` or `operator`), `requestId`, `reason`, counts, `incidentRef`, `operatorIdentity` (self-asserted), `host`, `eligibleSuperAdmins`):
- Challenges and codes: `admin_mfa.challenge_created`, `.verified`, `.code_rejected`, `.challenge_locked`, `.throttled`.
- Recovery codes: `.recovery_code_used`, `.recovery_codes_regenerated`.
- Enrolment: `.ticket_issued`, `.ticket_used`, `.enrolment_started`, `.enrolled`.
- Step-up: `.step_up_verified`, `.step_up_refused`.
- Reset requests: `.reset_initiated`, `.reset_approved`, `.reset_rejected`, `.reset_cancelled`, `.reset_expired`, `.reset_refused` (self-approval or ineligible).
- Reset execution: `.reset_executed` (with `sessionsRevoked`).
- Break-glass: `.break_glass_reset`, `.break_glass_acknowledged`, `.bootstrap_ticket_issued`.

**Never stored:** a secret, code, ticket, token or hash.

**Migration ordering**
- `MIGRATION_FILES` becomes: `schema.sql` → … → `authVerificationMigration.sql` → `studentRegistrationClaimsMigration.sql` → **`adminMfaMigration.sql`** → `databaseGrantsMigration.sql`.
- It depends on `users` and `auth_sessions` (`schema.sql`) and `auth_verification_events` (`authVerificationMigration.sql`).
- The grants manifest entries ship **in the same phase**, because the manifest refuses unlisted tables (`databaseGrantsMigration.sql:150-158`).
- Platform Staff is a separate identity system and does not affect Official MFA. The Staff migrations were wired before the grants migration on 2026-11-17; this does not alter the MFA flow.

---

## 10. Fail-closed rules and enforcement activation [spec]

1. **No enforcement flag.**
   - The gate (§4.3) and the step-up check (§5.7) are unconditional code, with no setting, environment variable or route to turn them off.
   - Turning MFA off would need a code change through the normal approval process.
2. **Enrolment works under enforcement.**
   - Enrolment is pre-session (challenge cookie and ticket), so enforcement and enrolment ship together.
   - No "grace" mode is needed.
3. **Missing keys** (absent, unreadable or short files):
   - `api_admin` refuses to start (deployment preflight, P9);
   - at runtime, the official sign-in returns `503 ADMIN_MFA_UNAVAILABLE`, and no session or challenge is created.
   - Keys are never in an error message or log.
4. **Missing schema** (`42P01`): official sign-in returns `503 ADMIN_MFA_UNAVAILABLE`; the gate refuses every official session.
5. **Existing sessions** issued before deployment have no evidence rows, so they are refused on their next request. An optional, separately approved operator SQL statement may also revoke them at cutover, for tidiness.

---

## 11. Bounded implementation phases

Every phase needs **separate owner approval**, with an exact file list confirmed in a read-only pre-phase audit. A file outside the list means stop and ask. The disposable-PostgreSQL runs are **separate approvals** that follow their phase.

| Phase | Scope | Files expected to change | Depends on | Unit tests | Disposable PostgreSQL | Acceptance |
|---|---|---|---|---|---|---|
| **P1 TOTP core** | Pure functions: Base32; HOTP and TOTP; window verify returning the matched step; AES-256-GCM wrap and unwrap with AAD and key ring; recovery-code generation and HMAC; token hashing; key-file loader (fail closed, minimum length); constant-time compare | **New** `server/adminMfaCore.ts`, `server/adminMfaCore.test.ts` | Owner values §12 (window) | RFC 6238 Appendix B vectors (SHA-1, truncated to 6); window ±w accepted and ±(w+1) rejected; GCM tamper, wrong AAD and wrong key rejected; short or missing key refused with a fixed message containing no key material; codes unique and normalised | None | No I/O except the key loader; no dependency added; static no-bypass scan covers the file |
| **P2 schema and grants** | §9 tables, constraints, transition trigger, indexes; manifest entries | **New** `server/adminMfaMigration.sql`, **new** `server/adminMfaMigration.test.ts`; `server/migrate.ts`, `server/migrate.test.ts`, `server/databaseGrantsMigration.sql`, `server/databaseGrants.test.ts`, `server/databaseGrants.postgres.integration.test.ts` | P1 not required | Static: order, idempotency, no DELETE grant, every CHECK and partial unique index present | **P2-R (separate approval)** with `scripts/run-disposable-grants-tests.sh` (unchanged): grants equal the manifest; app cannot DELETE or TRUNCATE; terminal reset states are immutable; self-approval CHECK; one pending per target and one open step-up per session under concurrency; one open ticket per user | Migration applies twice cleanly; the grants migration passes; disposable cleanup verified |
| **P3 sign-in, session and step-up enforcement** | Official sign-in branch (202, challenge cookie); `/mfa/verify`; evidence insert; gate in `loadSession` and `portalVerificationGate`; `stepUp` field and central check; step-up start and verify; per-user lock; throttle; fail-closed 503 | **New** `server/adminMfaStore.ts`, **new** `server/adminMfa.ts` (router), **new** `server/adminMfa.test.ts`; `server/auth.ts`, `server/surface.ts`, `server/surfaceEnforcement.ts`, `server/index.ts`; tests `server/loginFlow.test.ts`, `server/surface.test.ts`, `server/surfaceEnforcement.test.ts`, `server/surfaceWiring.test.ts`, `server/adminAuthorization.test.ts`, `server/roleLookupSecurity.test.ts`, `server/authVerification.test.ts` (static scan). **[assume]** Other tests that create Official sessions through the login route (for example `adminDashboardStats`, `instituteApproval`, `onlineExamRoutes`) are confirmed in the pre-phase audit | P1, P2 | §12 criteria 1–3, 4 (sign-in and step-up replay), 11, 13; every `ROUTE_POLICY` official, Super Admin and `stepUp` entry iterated | **P3-R (separate)**: concurrent verify of one code means one success; concurrent step-up and sign-in with the same step means one success; attempt reservation under parallel requests; throttle under the lock | No session without evidence; no route without central enforcement |
| **P4 enrolment and bootstrap** | `enrol/start` and `enrol/confirm`; first-time ticket issue (§6.6); recovery-code issue at confirmation; `admin-mfa:bootstrap-ticket` CLI | `server/adminMfa.ts`, `server/adminMfaStore.ts`, `server/adminMfa.test.ts`, `server/surface.ts` (+ tests); **new** `server/adminMfaCli.ts`, **new** `server/adminMfaCli.test.ts`; `package.json` (script entry only) | P3 | Criterion 6; secret returned once only; unconfirmed factor superseded on restart; ticket single use, expired and revoked; another user's ticket refused; §6.6 refusal when a factor ever existed; bootstrap refused once any Super Admin is enrolled; CLI refuses non-TTY. **Mandatory (O-4):** database enforcement that a factor is created only with an open, unexpired ticket of the same user bound to the enrolment challenge, and that confirmation marks the ticket used in the same transaction | **P4-R**: concurrent confirm and ticket use means one success; factor creation without a ticket refused by the database | A password alone never enrols, and neither does the application role without a ticket |
| **P5 recovery codes** | `/mfa/recovery` sign-in; regeneration (step-up); status endpoint | `server/adminMfa.ts`, `server/adminMfaStore.ts`, `server/adminMfa.test.ts`, `server/surface.ts` (+ tests) | P4 | Criterion 5; a recovery session never satisfies step-up; regeneration revokes the old batch | **P5-R**: parallel use of one code means one success | Codes are never logged or re-shown |
| **P6 reset (both modes)** | §6 endpoints for two-person (Super Admin target) and single-Super-Admin (ordinary Official target) resets; `executeMfaReset` in the §6.4 order, writing `admin_mfa.reset_executed` with `requestId`; handling of a refused `COMMIT` as a full rollback; approver freshness after `created_at`, initiator re-check, lazy expiry | `server/adminMfa.ts`, `server/adminMfaStore.ts`, `server/adminMfa.test.ts`, `server/surface.ts` (+ tests) | P5 | Criteria 7–9; reject, cancel and expire paths; ineligible initiator; self-target | **P6-R**: concurrent approve, approve, reject means one winner; reset versus target sign-in race; all target sessions revoked | Every outcome audited (§9 events) |
| **P7 break-glass CLI** | `admin-mfa:break-glass-reset`; dashboard banner data; acknowledge endpoint | `server/adminMfaCli.ts`, `server/adminMfaCli.test.ts`, `server/adminMfa.ts`, `server/adminMfaStore.ts`, `server/surface.ts` (+ tests), `package.json` (script entry) | P6, D-7, **O-1 resolved first** (database-level restriction of operator-only tickets) | Criterion 12; missing flags, non-TTY and retype mismatch refused; pending request superseded; eligible-count recorded; no ticket in logs | **P7-R** | No HTTP path reaches break-glass |
| **P8 frontend** | §8.2 components; central `401 MFA_STEP_UP_REQUIRED` handler | **New** `src/components/AdminMfaChallenge.tsx`, `AdminMfaEnrolment.tsx`, `AdminMfaStepUpDialog.tsx`, `AdminMfaManagement.tsx`; `src/components/RolePortal.tsx`, `src/components/LoginModal.tsx`, `src/api.ts`, `src/utils/uiTranslations.ts`; **new** `src/utils/adminMfa.ts` and `src/utils/adminMfa.test.ts` (pure state logic) | P3–P7 | State transitions; codes acknowledged before continuing; step-up re-issues the original request once | None | No authorization decision in the frontend; criterion 10 |
| **P9 deployment key wiring** | Key files as Compose secrets on `api_admin` **only**; preflight (presence, length, permissions); startup refusal | `docker-compose.yml`, `server/deploymentWrapper.ts`, `server/validateDeploymentConfig.ts`, `.env.example` (file paths only); tests `server/composeTopology.test.ts`, `server/deploymentWrapper.test.ts`, `server/deploymentRunner.test.ts`, `server/deploymentConfig.test.ts`, `server/startApi.test.ts` | P1; D-9 | Keys absent from every other service; missing or short key refuses startup; no key value in output | None | Criterion 13 (keys) |
| **P10 rollout** | Runbook section (bootstrap, ticket issue, reset, break-glass, incident); staging rehearsal; production cutover | `docs/operations/production-operator-runbook.md` (new section; §8 cross-reference) | P1–P9; staging approval | — | Staging rehearsal (separate approval) | Order: keys provisioned; migration; deploy (enforcement live; all old official sessions refused); bootstrap the first Super Admin by CLI; that Super Admin issues first-time tickets; every Official enrols; **then** Staff Management go-live (SM2-P03) |

---

## 12. Security acceptance criteria

All of these must pass before P10. Each is an automated test unless it is marked "procedure".

| # | Criterion | Test (phase) |
|---|---|---|
| 1 | A password-only sign-in never creates a privileged session | Correct password returns 202 with no `Set-Cookie: elt_session` and no `auth_sessions` insert, for Super Admin and Official, enrolled and not (P3) |
| 2 | Every Official and Super Admin route requires MFA evidence | Iterate every `ROUTE_POLICY` entry whose admin access is `official` or `super_admin`: a session with no evidence gets 403 `ADMIN_MFA_REQUIRED` and the handler store is untouched (P3) |
| 3 | Existing sessions cannot bypass enforcement | A pre-existing session row without evidence is refused; a session whose user has no active factor is refused (P3) |
| 4 | TOTP replay fails, including concurrently | Same code twice gives the second one 400; two parallel verifies with the same step give exactly one success (unit, stale-snapshot technique, plus P3-R); a sign-in code reused for step-up is refused |
| 5 | Recovery codes are single use | Second use refused; parallel use gives one success (P5, P5-R); regenerated batch revokes the old one |
| 6 | Unauthorised enrolment fails | No ticket, a used, expired or revoked ticket, another user's ticket, or a ticket without a password challenge: all refused; §6.6 refusal when a factor has existed (P4) |
| 7 | Reset requires two different administrators | Execution only via approve by an eligible Super Admin other than the initiator; database `CHECK` tested directly (P2-R, P6) |
| 8 | Initiator cannot self-approve; target cannot initiate or approve | 403 plus a `CHECK` violation when forced at the store level (P6) |
| 9 | Reset revokes all target sessions | N sessions before, all `revoked_at` after; their next request refused; open challenges consumed; codes and tickets revoked (P6, P6-R) |
| 10 | No API or frontend path can disable mandatory MFA | Route-policy scan (§8.1); static scan that factor-disabling SQL appears only in `executeMfaReset` and enrolment supersession; no enforcement setting exists (grep of config and env schemas) (P3, P8) |
| 11 | Step-up expires and cannot be replayed | Evidence older than the window gives 401; recovery-only session gives 401; step-up challenge of another session or user cannot be verified; the same step-up code twice is refused (P3) |
| 12 | Break-glass is restricted and auditable | No HTTP route; non-TTY, missing flags and retype mismatch refused; event contains incident, reason, operator, host and eligible count; the banner appears; procedure: runbook incident record outside the database (P7, P10) |
| 13 | Missing keys or schema fail closed | Missing or short key file gives `api_admin` startup refusal and runtime 503 with no session; missing table gives 503 at sign-in and refusal of existing sessions; no key material in output (P1, P3, P9) |
| 14 | No secret, code, ticket or token in logs, events or later responses | Capture logs and events in every test; assert absence (all phases) |
| 15 | The sign-in response does not reveal Super Admin status before MFA | Identical 202 shapes for Super Admin and Official (P3) |
| 16 | A reset ticket never survives without its executed reset (F1) | Disposable PostgreSQL tests (AUTH C1.8.4): invalid, mismatched and non-pending requests refused at insert; a pending reset with a ticket refused at commit |
| 17 | A reset is all or nothing (F2) | Each missing effect refused at commit; rollback after every intermediate write leaves the target unchanged; both modes and lost-ticket recovery commit; concurrent approvals: exactly one |
| 18 | A factor is disabled only by its workflow (O-3); bootstrap is single-winner | No, mismatched or wrong-label reset refused at commit; superseding a confirmed factor refused; concurrent bootstrap: exactly one |

---

## 13. Remaining owner decisions

**Settled on 2026-11-15** (no longer open): scope (Super Admin and all Officials), method (TOTP plus recovery codes), exclusion of SMS and email, two-person reset for Super Admin targets, **D-1: single-Super-Admin reset for ordinary Official targets**, break-glass conditions, no disable switch, WebAuthn deferred. AUTH C1.8.4 decisions: O-2 (amend the undeployed migration in place), O-3 (link factor disabling to its workflow), O-5 (this documentation update).

**Open from AUTH C1.8.4:** **O-1**, database-level restriction of bootstrap and break-glass tickets to the operator CLI. It is deferred and must be resolved before Phase 7 (§7.3). **O-4**, ticket-required factor enrolment in the database, is a mandatory Phase 4 requirement (§6.6, §11).

| ID | Decision | Default in this specification |
|---|---|---|
| D-1 | ~~Two-person reset for ordinary Official targets too~~ | **Settled:** single Super Admin for ordinary Officials, two-person for Super Admins |
| D-2 | **Numeric values:** TOTP window `w`; challenge lifetime; attempts per challenge; per-account throttle (count and window); step-up window; enrolment-ticket lifetime; reset-request lifetime; recovery batch size and code length; admin session lifetime and idle timeout | None chosen. Revision 1 *suggested* (not approved): `w = 1`, 5 minutes, 5 attempts, 10 failures in 15 minutes, 15-minute step-up, 30-minute ticket, 10 codes |
| D-3 | Step-up for ordinary Official mutations | No |
| D-4 | May a recovery code ever satisfy step-up, or allow self re-enrolment? | No (both refused) |
| D-5 | Concurrent admin session limit | None |
| D-6 | Out-of-band channel for handing a reset ticket to the target | Not specified |
| D-7 | Break-glass custodians and an optional two-operator rule (ties to UD-2 and OD-P7) | Single operator with host `sudo` |
| D-8 | QR dependency for enrolment | Text-only URI and Base32 |
| D-9 | Key custody, generation ceremony and rotation schedule | Not specified |
| D-10 | NTP requirement on hosts (operational) | Required [assume] |
| D-11 | Whether the existing C-4 login-ID timing fix must precede P3 | Recommended, separate approval |

---

## 14. Changes from revision 1
- **Scope:** all Officials, not Super Admins only [approved].
- **Recovery:** two-person reset, with a new `admin_mfa_reset_requests` table and state machine [approved policy, specified here].
- **Break-glass:** narrowed to an unavailable second Super Admin, with an incident reference and an eligible-count record.
- **Bootstrap:** the CLI works only before any Super Admin is enrolled.
- **Session evidence:** single-row `auth_session_mfa` is replaced by append-only `auth_session_mfa_verifications`, so step-up freshness needs no UPDATE grant.
- **Step-up:** fully specified (§5). It is declared in `ROUTE_POLICY`, and recovery codes are excluded.
- **Audit:** `admin_mfa_events` is dropped in favour of the existing append-only `auth_verification_events`.
- **Other additions:** `revoked_at` on recovery codes and tickets; `consumed_reason` on challenges; `disabled_via` on factors.
- **Enforcement:** no enforcement flag. Revision 1's "rollback by disabling enforcement" is withdrawn.
- **Numeric values:** all are now explicit owner decisions (D-2).
- **Stale references corrected:** session issue is at `server/index.ts:2172-2181`.

### 14.1 AUTH C1.8.4 amendment (2026-11-15)
- **Reset modes:** the text now reflects D-1 (two-person for Super Admin targets, single Super Admin for ordinary Officials) in §2, §6.1-§6.6 and §11. The policy is unchanged; earlier text had kept the superseded two-person-for-all reading.
- **F1:** ticket issuance integrity at `INSERT` (§6.6), plus the commit-time link between a reset ticket and its executed request (§6.4, §9).
- **F2:** all-or-nothing resets enforced at `COMMIT` (§6.4, §9).
- **O-3:** factor disabling linked to its workflow (§6.4, §9).
- **Bootstrap:** serialised by a transaction-level advisory lock, under `READ COMMITTED` only (§7.3).
- **O-1:** operator caller identity documented as open; it must be resolved before Phase 7 (§7.3, §11).
- **O-4:** ticket-required enrolment recorded as a mandatory Phase 4 requirement (§6.6, §11).
- **Acceptance criteria:** 16-18 added (§12).
- **Migration:** `server/adminMfaMigration.sql` amended in place (O-2: never deployed). Only functions and triggers changed; no table, column or grant changes.

## 15. Unverified assumptions [assume]
- The WireGuard and Admin Nginx path is deployed as designed. It has not been run.
- Host clocks are synchronised.
- Every Official can use an authenticator application.
- The list of existing tests that sign in as an Official (P3) is complete only after the P3 pre-phase audit.
