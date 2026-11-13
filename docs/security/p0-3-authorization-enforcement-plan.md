# P0-3 authorization enforcement plan

**Status:** REVIEW ONLY. No code, database, Docker, Git or deployment change has been made. Internal only. Prepared 2026-11-03.

**Policy source:** the client-approved P0-3 policy (instructions of 2026-11-03 at 03:17Z and 03:22Z), recorded as A-01 to A-20 in `../policy/master-policy-register.md`.

**Evidence:** current code read on 2026-11-03. Line numbers refer to the working tree at that time:
- `server/index.ts`, `server/auth.ts`, `server/institutionDocuments.ts`, `server/institutionSubmission.ts`;
- `src/components/RolePortal.tsx`, `src/components/InstitutionDocumentManagement.tsx`, `src/components/FeedbackSlideOut.tsx`.

---

## 0. Key findings

1. **No P0-3 policy is enforced today.** Every `/api/admin/*` route is guarded only by `requireAuth, requireRoles('official')`. The one exception is `GET /api/admin/data-export` (`index.ts:263`), which also uses `requireSuperAdmin`. The only Super Admin check in the frontend hides the "Excel data" tab (`RolePortal.tsx:946`, `:1166`).
2. **Most of the policy can be enforced on the backend without any schema change.** The existing `requireSuperAdmin` middleware (`auth.ts:193`) plus a few conditional checks inside handlers are enough.
3. **Three policies can't be fully enforced without a schema change:**
   - **Admit-card drafts (A-06).** `admit_cards` has no draft state, and both admit-card routes publish immediately.
   - **Maker-checker enforced by the database, legacy rows included (A-03).** The approver is overwritten when a withdrawal is paid.
   - **Audit trail and audit-log access (A-11, A-12).** There's no audit table.

   Interim measures that need no schema change are proposed for each (§6).
4. **P0-3 edits touch two files under the P0-4 checksum manifest:** `server/index.ts` (`7bdbcf40`) and `src/components/RolePortal.tsx` (`3b8386a8`). **P0-4 must be committed first** (C-17), or the accepted P0-4 state can't be told apart from P0-3 changes.
5. **Policy tension, not resolved here:**
   - All Officials keep institution approval (A-01), but institution document downloads become Super Admin only (A-09). Ordinary Officials would then approve institutions without being able to open their documents (§3.9, decision P3-D5).

---

## 0a. How the confirmed decisions Q115–Q125 relate to this plan (updated 2026-11-03)

Q115–Q125 are confirmed client decisions (master register, section QD). They govern **organization staff and the new application lifecycle**, not the legacy Official and Super Admin routes this plan covers. So **they don't change any route, guard or test in §3–§5.**

**Where they matter:**

| Decision | Effect on P0-3 |
|---|---|
| **Q117:** Finance Viewer "cannot credit wallets, approve withdrawals or execute payments"; "Super Admin permissions cannot be delegated" | **Consistent with §3.1 and §3.2.** Wallet credits, withdrawal approval and payment stay Super Admin only (A-02, A-03), and no organization role can ever reach those routes. The future staff permission catalogue must exclude them (conflict register D-08 row). |
| **Q115:** "Super Admin reviews and activates each staff account" | Adds a **future Super Admin-only action** (staff activation). There's no route yet; when it's built it joins the §4 matrix with `requireSuperAdmin`. It also adds to the operational need for enough Super Admin accounts (P3-D3). |
| **Q122 / Q124:** Super Admin sets the platform limits for appeal and withdrawal deadlines | **Future Super Admin-only platform settings.** No route exists yet; same treatment. |
| **Q120:** Super Admin "can review platform-level disputes without automatically replacing organizational decision authority" | A future Super Admin review capability with **no override power** over organization decisions. What it may do is gap M-17. |
| **Q115, Q118, Q119, Q121, Q123** require audited actions (actor, timestamp, reason; complete assignment history; "every action is audited") | **Strengthens the case for S-1 (`audit_events`).** It's now needed by both P0-3 (A-11, A-12) and these staff and lifecycle decisions. The interim log lines in §2 are **not** acceptable for the new staff and lifecycle features, which should wait for S-1. |
| **Q118:** "Super Admin retains platform-level publishing and control powers where applicable" | Consistent with §3.3 to §3.6 (publishing stays with Super Admin under A-04 to A-06). |

**No conflict between Q115–Q125 and the P0-3 policy (A-01 to A-20) was found.** The remaining conflicts these decisions raise (C-18 to C-21) concern staff onboarding, the status set and session records, and are tracked in the conflict register.

---

## 1. Constraints for this work

- Super Admin-only actions are enforced on the **backend** (A-19). Frontend hiding only reflects that.
- **Preserved:**
  - institution approval and rejection by all authorized Officials (A-01);
  - exam creation and draft imports by all Officials (A-18), except where §6 needs an interim restriction;
  - all existing data and workflows.
- No audit table and no schema change without separate approval.
- No production database, no existing containers, no Git actions.

## 2. Shared enforcement mechanism (code only, no schema)

- **Super Admin guard:** add `requireSuperAdmin` after `requireRoles('official')` on the Super Admin-only routes, exactly as `data-export` does today (`index.ts:263`). `requireSuperAdmin` already requires `role === 'official' && isSuperAdmin === true` (`auth.ts:193–203`). It returns 403 before the handler runs, so a refused request never touches the database.
- **Mixed routes** (allowed for Officials, but some cases need Super Admin): the check goes **inside the handler's transaction, after the row lock**, so the decision uses the locked state. Refusal returns `403` with a fixed message and rolls back.
- **Interim audit, until the audit table is approved:** after each successful protected action, write one structured log line `{"event":"admin.action","action":…,"actorId":…,"targetType":…,"targetId":…,"outcome":…}`.
  - It contains no personal data, amounts in paise only, and no secrets (E-07).
  - **This does not meet A-11**, which requires the audit entry in the same transaction. It's a stopgap, labelled as such.
- **Frontend:** the dashboard already receives `user.isSuperAdmin` (`RolePortal.tsx:44`). Super Admin-only controls are hidden or disabled for ordinary Officials, with a short "Super Admin only" note, and every 403 shows the existing error banner.

---

## 3. Policy-by-policy plan

### 3.1 Wallet credits (A-02: Super Admin only)

| Item | Detail |
|---|---|
| Current route and check | `POST /api/admin/institutes/:id/credits`, guarded by `requireAuth, requireRoles('official')` (`index.ts:1371`) |
| Current frontend | Credit form in the "Institute approvals & wallet" tab (`RolePortal.tsx:846`, tab at `:1269`), shown to every Official |
| Gap | Any Official can credit any approved institute's wallet |
| Backend change | Add `requireSuperAdmin` |
| Frontend change | Show the credit form only when `user.isSuperAdmin`; ordinary Officials see balances read-only |
| Audit | The row already records the actor (`institute_wallet_entries.created_by`), time, amount and payment reference. Add the interim log line. A-11's same-transaction audit needs the audit table (S-1). |
| Tests | No session 401; candidate or center 403; ordinary Official 403 **with no INSERT made**; Super Admin 201; duplicate payment reference 409 (regression) |
| Regression risk | Officials who credit wallets today lose that ability; an operational change to communicate |
| Rollback | Remove the middleware (code only; no data affected) |

### 3.2 Withdrawals: approval and payment maker-checker (A-03)

| Item | Detail |
|---|---|
| Current route and check | `PATCH /api/admin/institute-withdrawals/:id` (status `approved`, `rejected` or `paid`), guarded by `requireAuth, requireRoles('official')` (`index.ts:1399`). It locks the row (`FOR UPDATE`). On every transition it sets `reviewed_by` to the current user, so **once paid, the approver is overwritten by the payer** (`index.ts:1442–1447`). |
| Current frontend | Approve, reject and mark-paid controls (`RolePortal.tsx:819–831`), shown to every Official |
| Gaps | (1) Any Official can approve, reject or pay. (2) No maker-checker: one person can approve and pay. (3) After payment the approver can't be identified. |
| Backend change (no schema) | (a) Add `requireSuperAdmin`. (b) **Maker-checker in code:** in the existing locked transaction, on `paid`, refuse with 409 when `withdrawal.reviewed_by = current user`; while a withdrawal is `approved`, `reviewed_by` holds the approver, including on legacy approved rows. (c) **Keep the approver from now on:** on `paid`, stop overwriting `reviewed_by` and `reviewed_at`. The payer is already recorded as `created_by` on the debit wallet entry inserted in the same transaction (`index.ts:1434–1439`). (d) Rejection is allowed for any Super Admin, the approver included, before payment (03:22Z decision). |
| What needs a schema change | A **database-enforced** rule that payer ≠ approver, as the policy states ("database constraint … including legacy records"). The approver lives on `institute_withdrawals` and the payer on `institute_wallet_entries`, so a constraint needs either new columns (`approved_by`, `approved_at`, `paid_by`, `paid_at`) or a cross-table trigger. **S-2.** |
| Legacy data | Rows already `paid`: `reviewed_by` holds the **payer**, and the approver is lost and can't be recovered. Under a schema change these rows would get `approved_by = NULL` ("unknown, before maker-checker"). Rows still `approved` keep their approver in `reviewed_by`. **Decision P3-D2:** an `approved` row whose `reviewed_by` is NULL (approver account deleted, `ON DELETE SET NULL`): block payment, or allow it? Recommended: block, and have the request rejected and filed again. |
| Frontend change | Withdrawal controls for Super Admin only. "Mark paid" disabled when the current Super Admin approved it (needs `reviewed_by` in `/api/admin/institute-management`, which currently isn't returned; adding it is a code change). |
| Audit | Approver, payer and payment reference are kept (after change c). Interim log line per transition. |
| Tests | Ordinary Official 403 for every status; Super Admin A approves, then A pays → 409, **no debit inserted**, status still `approved`; Super Admin B pays → 200, debit `created_by = B`, `reviewed_by` still A; an approver may reject before payment; legacy approved row (`reviewed_by = X`): X can't pay, Y can; the P3-D2 case; two people paying at once → one succeeds; duplicate transfer reference 409 (regression) |
| Regression risk | A deployment with a single Super Admin can no longer pay any withdrawal they approved. **It needs at least two Super Admins** (operational dependency, P3-D3). The meaning of `reviewed_by` changes for rows paid after deployment (approver, not payer). Reports must use the debit entry for the payer. |
| Rollback | Revert the code. Data written in the meantime stays valid: `reviewed_by` = approver on rows paid afterwards, which is the more informative value. |

### 3.3 Results publishing and corrections (A-04, A-16)

| Item | Detail |
|---|---|
| Current routes and checks | All guarded by `requireAuth, requireRoles('official')`: (1) `POST /api/admin/results` (`index.ts:2266`) inserts **or overwrites** with `is_published = true`, so it **publishes immediately**. (2) `PATCH /api/admin/results/:id` (`:2305`) toggles `is_published`. (3) `POST /api/admin/results/import` (`:521`) inserts drafts and, on conflict, **overwrites an existing row and sets it back to draft**, which unpublishes a live result. (4) `GET /api/admin/results` (`:2323`). |
| Current frontend | Results tab (`RolePortal.tsx:1561`): workbook import (`:1570`) and publish/unpublish buttons through `publishAdminRecord` (`:901`). No frontend calls `POST /api/admin/results`; it's API-only. |
| Gaps | Any Official can publish, unpublish or overwrite a published result, and can publish immediately through the direct route |
| Backend change (no schema) | (1) `PATCH …/results/:id`: add `requireSuperAdmin`. (2) `POST /api/admin/results`: **always writes a draft** (`is_published = false`) for everyone. If the target `(exam_code, roll_number)` row is **published**, it's a correction (A-16), so Super Admin only: 403 for ordinary Officials; for Super Admin the row returns to draft and must be republished. (3) `POST …/results/import`: inside the existing transaction, if any imported row matches a **published** row, ordinary Officials get **403 for the whole import** (no partial write); Super Admin may import, and those rows return to draft (existing behaviour, matching A-16). Draft imports of new rows stay open to all Officials (A-18). (4) GET unchanged. |
| Frontend change | Publish and unpublish buttons for Super Admin only. Import stays, with a note that corrections to published results need Super Admin. |
| Audit | `published_results` doesn't record who published (only `published_at`, which the import also sets on drafts). Interim log line. Recording the publisher in the database needs S-3. |
| Tests | Ordinary Official: PATCH 403; direct POST creating a new row → stored `is_published = false`; direct POST over a published row → 403, row unchanged; import with one row matching a published row → 403 and **no rows written**; import of new rows → drafts. Super Admin: PATCH publishes and unpublishes; correction through POST or import → draft. Candidate lookup never returns drafts (regression). |
| Regression risk | The direct POST no longer publishes for anyone. Any external script that relied on immediate publishing must add a Super Admin PATCH. No frontend uses it. |
| Rollback | Revert the code. Rows written as drafts stay drafts; a Super Admin publishes them. |

### 3.4 Answer-key publishing (A-05, A-16)

| Item | Detail |
|---|---|
| Current routes and checks | `PATCH /api/admin/answer-keys/:examCode` (`index.ts:604`) toggles publication for the whole exam. `POST /api/admin/answer-keys/import` (`:382`) **sets the whole exam back to unpublished** (`:413`) and upserts drafts. Both are guarded only by the Official role. |
| Current frontend | Answer-keys tab (`RolePortal.tsx:1145`): import (`:1154`) and a publish toggle per exam (`:1160`) |
| Gap | Any Official can publish, unpublish, or take a live key offline by re-importing |
| Backend change (no schema) | PATCH: `requireSuperAdmin`. Import: under the transaction, if the exam currently has **any published** answer-key row, ordinary Officials get 403 and nothing is written; Super Admin may import, returning the exam to draft (A-16). Imports for unpublished exams stay open to all Officials. |
| Frontend change | Publish toggle for Super Admin only; an import note for published exams |
| Audit | No publisher is recorded today. Interim log line. Database record: S-3. |
| Tests | Ordinary Official PATCH 403; ordinary Official import into a published exam → 403, keys still published and unchanged; import into an unpublished exam → drafts; Super Admin publish and unpublish; Super Admin correction → whole exam returns to draft; the public `/api/answer-keys` lists only published exams (regression) |
| Regression risk | Officials can no longer correct a published key on their own |
| Rollback | Revert the code |

### 3.5 Online exam publishing (A-05, A-16, with P0-4 constraints)

| Item | Detail |
|---|---|
| Current routes and checks | `PATCH /api/admin/online-exams/:examCode` (`index.ts:621`) toggles `online_exam_questions.is_published`. `POST /api/admin/online-exams/import` (`:439`) refuses an exam that already has attempts (`:485–490`, P0-4 history protection), then unpublishes and upserts drafts. Both are guarded only by the Official role. |
| Current frontend | Online-exams tab (`RolePortal.tsx:1124`): import (`:1133`) and a publish toggle (`:1139`) |
| Gap | Any Official can publish or unpublish an online exam paper |
| Backend change (no schema) | PATCH: `requireSuperAdmin`. Import: if the exam is currently **published**, ordinary Officials get 403; the existing attempts guard (409) stays first and is unchanged. Super Admin re-imports return the paper to draft. **The P0-4 start, autosave, submit and recovery logic is untouched.** |
| P0-4 interaction | Unpublishing while candidates are mid-attempt keeps today's behaviour (no change). `server/index.ts` is a P0-4 manifest file, so commit P0-4 first. |
| Frontend change | Publish toggle for Super Admin only |
| Audit | Interim log line. Database record: S-3. |
| Tests | Ordinary Official PATCH 403; ordinary Official import into a published exam 403; an exam with attempts still 409 for everyone; the **full P0-4 suite and focused session tests unchanged and green** |
| Regression risk | Low. P0-4 behaviour is protected by its suite. |
| Rollback | Revert the code |

### 3.6 Admit-card approval (A-06, A-16, A-20)

| Item | Detail |
|---|---|
| Current routes and checks | `POST /api/admin/admit-cards/import` (`index.ts:316`) and `PUT /api/admin/applications/:id/admit-card` (`:2086`). Both upsert `admit_cards` with `published_at = now()`. **`admit_cards` has no draft column**, so every write is immediately visible to candidates through the admit-card lookup. Both are guarded only by the Official role. |
| Current frontend | Admit-cards tab (`RolePortal.tsx:1105`), with the workbook import (`:1116`). No frontend calls the single-assignment route. |
| Gap | Any Official publishes admit cards instantly. The required draft step doesn't exist. |
| **Can't be enforced as approved without a schema change** | "Import must create a draft; publishing requires Super Admin" needs a draft state on `admit_cards` (**S-4**), a candidate lookup that filters on it, and a controlled deployment (A-20: old code ignores the flag and would expose drafts). |
| Interim option A, recommended (no schema) | Restrict **both** admit-card routes to Super Admin (`requireSuperAdmin`). Publishing then needs Super Admin, as approved, but ordinary Officials temporarily lose admit-card imports. That's a **temporary departure from A-18** ("draft imports by all Officials") for admit cards only, until S-4. **Decision P3-D1.** |
| Interim option B | Leave the routes unchanged until S-4 is approved. The gap stays open. |
| Frontend change (option A) | Admit-card import for Super Admin only, with an explanation |
| Audit | No publisher is recorded. Interim log line. Database record: S-4. |
| Tests (option A) | Ordinary Official 403 on both routes with no write; Super Admin 201/200; candidate lookup regression |
| Rollback | Revert the code |

### 3.7 Helpdesk access (A-14: Super Admin only)

| Item | Detail |
|---|---|
| Current routes and checks | `GET /api/admin/feedback` (`index.ts:1856`, returns `SELECT *`, including name, email and application number) and `PATCH /api/admin/feedback/:id` (`:1861`), guarded only by the Official role. The public `POST /api/feedback` is unchanged. |
| Current frontend | Helpdesk tab (`RolePortal.tsx:1557`). `FeedbackSlideOut.tsx:80–91` loads `/api/admin/feedback` for **every** Official. `dashboard-stats` shows the `openHelpdesk` count. |
| Gap | Every Official reads tickets containing applicants' personal data and changes their status |
| Backend change | Add `requireSuperAdmin` to both routes. `GET /api/admin/dashboard-stats`: return `openHelpdesk: null` for ordinary Officials (**decision P3-D4**: is the count itself restricted?). |
| Frontend change | Helpdesk tab and the admin view in `FeedbackSlideOut` for Super Admin only. The `isOfficial` condition at `:80` becomes Super Admin only, so ordinary Officials see the submit form only. |
| Audit | Ticket updates record no actor. Interim log line. |
| Tests | Ordinary Official 403 on GET and PATCH with no database read of `feedback`; Super Admin 200; public submission unchanged; slide-out doesn't call the admin route for ordinary Officials (unit test on the condition) |
| Regression risk | Officials who triaged tickets lose access |
| Rollback | Revert the code |

### 3.8 Linking legacy application ownership (A-15: Super Admin only)

| Item | Detail |
|---|---|
| Current route and check | `POST /api/admin/applications/:id/verify-ownership` (`index.ts:2039`), guarded only by the Official role |
| Current frontend | None (API only) |
| Gap | Any Official can attach a legacy application to a candidate account |
| Backend change | Add `requireSuperAdmin` |
| Frontend change | None |
| Audit | Already recorded in the row: `applications.ownership_verified_by`, `ownership_verified_at`, `ownership_verification_method`. Interim log line for refusals and successes. |
| Tests | Ordinary Official 403 with no update; Super Admin success; existing ownership tests unchanged (`authorizationQueries.test.ts`, `roleLookupSecurity.test.ts`) |
| Regression risk | Low (no UI) |
| Rollback | Revert the code |

### 3.9 Institution document download and review (A-09)

| Item | Detail |
|---|---|
| Current routes and checks | In `server/institutionDocuments.ts`, every route uses `officialAccess = [requireAuth, requireRoles('official')]` (`:605`): `GET /api/admin/institution-documents` (list), `GET …/policy`, **`GET …/versions/:versionId/content` (download)**, **`POST …/versions/:versionId/reviews` (review decision)**. Also `GET /api/institution-document-submission/admin/cycles` (`institutionSubmission.ts:394`). |
| Current frontend | The `InstitutionDocumentManagement role="official"` component (`RolePortal.tsx:1051`) offers download (`:61`) and review (`:245`) to every Official |
| Gap | Every Official downloads institution documents and records review decisions |
| Backend change | Add a `superAdminAccess = [requireAuth, requireRoles('official'), requireSuperAdmin]` set and use it for **download** and **reviews**. List, policy and cycles stay with all Officials (**decision P3-D5**). |
| Frontend change | Pass `isSuperAdmin` into `InstitutionDocumentManagement`; hide download and review controls for ordinary Officials |
| Audit | Review decisions are already recorded (`institution_document_review_history.reviewer_user_id`). **Downloads aren't recorded anywhere**: interim log line; a database record needs the audit table (S-1). |
| Policy tension (P3-D5) | Under A-01 every Official approves institutions (`PATCH /api/admin/institutes/:id`, `index.ts:1056`, which doesn't check document review). Once A-09 applies, ordinary Officials approve without being able to open the documents. Options: (a) accept it, with Super Admin reviewing documents first by process; (b) the approval route requires a recorded Super Admin document review (no schema; a code check against `institution_document_review_history`), which changes A-01's workflow and needs client approval; (c) leave it to the client. **Not resolved here.** |
| Tests | Ordinary Official 403 on download and review, with no file opened and no row inserted; Super Admin success; list, policy and cycles unchanged for ordinary Officials; center document routes unchanged; existing `institutionDocuments.test.ts` green |
| Regression risk | Officials reviewing documents today lose that ability |
| Rollback | Revert the code |

### 3.10 Audit-log access (A-11, A-12)

| Item | Detail |
|---|---|
| Current state | **There's no audit log.** No `audit_events` table and no audit route. Only per-row actor columns on some tables, and the P0-4 structured logs. |
| Gap | A-11 (atomic audit entries for financial, approval, publishing and permission actions) and A-12 (read access for Super Admin only) have nothing to enforce against. The confirmed decisions Q115, Q118, Q119, Q121 and Q123 add further audit requirements for staff activation, decisions, assignments, overrides and reopening (§0a). |
| **Can't be enforced without a schema change** | It needs the `audit_events` table (**S-1**), writes in the same transaction in every protected handler, and a Super Admin-only read route |
| Interim | The `admin.action` log lines (§2), readable only by whoever operates the host. They **don't** meet A-11's atomicity or A-12's in-app access control. |
| After S-1 | `GET /api/admin/audit-events` (paged, filtered) with `requireSuperAdmin`; append-only triggers; tests that an audit failure rolls back the action (A-11) |

### Appendix: other approved P0-3 items found during the route survey (not in the requested list)

These are approved, need no schema change, and are recommended for the same batch. **Decision P3-D6:** include them, or keep them for later?

| Policy | Route | Current | Proposed |
|---|---|---|---|
| A-05: exam form publishing | `PATCH /api/admin/exams/:id` (`index.ts:1503`, toggles `is_published`) | Official | `requireSuperAdmin`. Creation `POST /api/admin/exams` stays with all Officials (A-18). |
| A-17: notice publishing | `POST /api/admin/notices` (`:156`, can publish immediately; the UI says "Publishing is immediate", `RolePortal.tsx:1079`); `PATCH /api/admin/notices/:id` (`:181`) | Official | POST always creates a draft for ordinary Officials (Super Admin may publish); PATCH `requireSuperAdmin` |
| A-08: hide applicant contact details | `GET /api/admin/applications` (`:2009`, returns `email`, `phone`) | Official | Remove `email` and `phone` from the response for ordinary Officials |
| A-10: Official management | CLI only (`server/createUser.ts`) | — | No change (separate milestone) |

**Not covered by the policy (unchanged; flagged as PERM gaps):**
- `PATCH /api/admin/institute-forms/:id` (approving organization forms for the public site);
- `PATCH /api/admin/institute-profile-changes/:id`;
- `PATCH /api/admin/applications/:id` (status workflow, which stays with all Officials under A-08).

---

## 4. Route-by-route authorization matrix

Key: **O** = ordinary Official; **SA** = Super Admin; **C** = conditional check inside the handler.

| Route | Policy | Current | Proposed | Schema needed? |
|---|---|---|---|---|
| `POST /api/admin/institutes/:id/credits` | A-02 | O | SA | No |
| `PATCH /api/admin/institute-withdrawals/:id` | A-03 | O | SA + C (payer ≠ approver; approver kept) | Only for database enforcement and recording legacy approvers (S-2) |
| `GET /api/admin/institute-management` | A-03 support | O | O (add `reviewed_by` to withdrawals for the UI) | No |
| `POST /api/admin/results` | A-04, A-16 | O (publishes immediately) | O for new drafts; SA for corrections to published rows (C); never publishes | No |
| `PATCH /api/admin/results/:id` | A-04 | O | SA | No |
| `POST /api/admin/results/import` | A-04, A-16, A-18 | O | O for new drafts; SA when touching published rows (C) | No |
| `GET /api/admin/results` | — | O | O | No |
| `PATCH /api/admin/answer-keys/:examCode` | A-05 | O | SA | No |
| `POST /api/admin/answer-keys/import` | A-05, A-16, A-18 | O | O for unpublished exams; SA when published (C) | No |
| `PATCH /api/admin/online-exams/:examCode` | A-05 | O | SA | No |
| `POST /api/admin/online-exams/import` | A-05, A-16, A-18 | O (409 when attempts exist) | O for unpublished exams; SA when published (C); attempts guard unchanged | No |
| `POST /api/admin/admit-cards/import` | A-06 | O (live immediately) | **Interim: SA** (P3-D1); after S-4: O for drafts, SA to publish | **Yes for the draft model (S-4)** |
| `PUT /api/admin/applications/:id/admit-card` | A-06 | O (live immediately) | **Interim: SA**; after S-4: O for drafts | **Yes (S-4)** |
| `GET /api/admin/feedback` | A-14 | O | SA | No |
| `PATCH /api/admin/feedback/:id` | A-14 | O | SA | No |
| `GET /api/admin/dashboard-stats` | A-14 (count) | O | O, with `openHelpdesk` null for O (P3-D4) | No |
| `POST /api/admin/applications/:id/verify-ownership` | A-15 | O | SA | No |
| `GET /api/admin/institution-documents/versions/:versionId/content` | A-09 | O | SA | No |
| `POST /api/admin/institution-documents/versions/:versionId/reviews` | A-09 | O | SA | No |
| `GET /api/admin/institution-documents`, `…/policy` | A-09 (list) | O | O (P3-D5) | No |
| `GET /api/institution-document-submission/admin/cycles` | A-01 support | O | O | No |
| Audit-log read (doesn't exist) | A-12 | — | SA, after S-1 | **Yes (S-1)** |
| `PATCH /api/admin/institutes/:id` | **A-01 (preserve)** | O | **O (unchanged)** | No |
| `POST /api/admin/exams` | **A-18 (preserve)** | O | **O (unchanged)** | No |
| `PATCH /api/admin/exams/:id` | A-05 (appendix) | O | SA (P3-D6) | No |
| `POST /api/admin/notices` | A-17 (appendix) | O (can publish) | O draft only; SA may publish (P3-D6) | No |
| `PATCH /api/admin/notices/:id` | A-17 (appendix) | O | SA (P3-D6) | No |
| `GET /api/admin/applications` | A-08 (appendix) | O (contact details shown) | O without email or phone (P3-D6) | No |
| `GET /api/admin/data-export` | A-07 | SA | SA (unchanged) | No |
| `PATCH /api/admin/applications/:id`; `/api/admin/institute-forms/:id`; `/api/admin/institute-profile-changes/:id`; `GET /api/admin/mock-exams/attempts`; `/api/admin/workbook-template`; `GET /api/admin/{exams,notices,institutes,answer-keys,online-exams}` | none | O | O (unchanged) | No |

## 5. Before and after permission matrix

| Action | Ordinary Official, before | Ordinary Official, after | Super Admin, before | Super Admin, after |
|---|---|---|---|---|
| Approve or reject institution registration | ✅ | ✅ (A-01) | ✅ | ✅ |
| Credit an institute wallet | ✅ | ❌ | ✅ | ✅ |
| Approve or reject a withdrawal | ✅ | ❌ | ✅ | ✅ |
| Mark a withdrawal paid | ✅ (even after approving it) | ❌ | ✅ (even after approving it) | ✅ **only if they didn't approve it** |
| Create a result draft | — (direct POST published) | ✅ (new rows) | — | ✅ |
| Publish or unpublish results | ✅ | ❌ | ✅ | ✅ |
| Correct a published result | ✅ (stays or becomes live) | ❌ | ✅ | ✅ (returns to draft) |
| Import answer keys (unpublished exam) | ✅ | ✅ | ✅ | ✅ |
| Import answer keys (published exam) | ✅ (unpublishes it) | ❌ | ✅ | ✅ (returns to draft) |
| Publish or unpublish answer keys | ✅ | ❌ | ✅ | ✅ |
| Import an online exam (unpublished, no attempts) | ✅ | ✅ | ✅ | ✅ |
| Publish or unpublish an online exam | ✅ | ❌ | ✅ | ✅ |
| Import or assign admit cards | ✅ (live) | ❌ interim (P3-D1); ✅ drafts after S-4 | ✅ | ✅ |
| Read or update helpdesk tickets | ✅ | ❌ | ✅ | ✅ |
| Link legacy application ownership | ✅ | ❌ | ✅ | ✅ |
| Download institution documents | ✅ | ❌ | ✅ | ✅ |
| Record a document review decision | ✅ | ❌ | ✅ | ✅ |
| List institution documents (metadata) | ✅ | ✅ (P3-D5) | ✅ | ✅ |
| Read the audit log | n/a | ❌ | n/a | ✅ after S-1 |
| Create exam forms; draft imports | ✅ | ✅ (A-18) | ✅ | ✅ |
| Full Excel export | ❌ | ❌ | ✅ | ✅ |

Center and candidate accounts: unchanged; they get 403 on every `/api/admin/*` route, as today.

---

## 6. Policies that can't be enforced safely without a schema change

| Policy | What can be enforced now (code only) | What needs a schema change |
|---|---|---|
| A-06 admit-card drafts | Super Admin-only admit-card writes (interim, P3-D1) | The draft state, candidate filtering and controlled deployment (S-4, A-20) |
| A-03 maker-checker "by database constraint, including legacy" | Maker-checker in code under the row lock; keep the approver on newly paid rows | A database rule and approver and payer columns, with legacy rows marked unknown (S-2) |
| A-11 atomic audit trail | Interim log lines (not atomic) | `audit_events` and writes in the same transaction (S-1) |
| A-12 audit-log access | — | S-1 plus a Super Admin-only read route |
| A-04, A-05, A-16, A-17 publisher identity | Interim log lines | `published_by` and `published_at` columns, or `audit_events` (S-3, or covered by S-1) |

## 7. Schema changes requiring approval (exact list)

None of these will be made without separate approval. Each is additive to an **existing** table (or is a new table), runs in one transaction, can be safely rerun, and is validated on a disposable database first.

| ID | Change | Enables | Notes |
|---|---|---|---|
| **S-1** | New table `audit_events` (append-only triggers; columns as in `data-model-final-proposal.md` §4.7) plus indexes | A-11, A-12; download auditing for A-09; **also the audit requirements of Q115, Q118, Q119, Q121 and Q123** | New table; an existing-table change only if foreign keys point at `users` (additive). **Recommended as the first schema approval**, because it unblocks both P0-3 and the staff and lifecycle work. |
| **S-2** | `institute_withdrawals`: add `approved_by text REFERENCES users(id)`, `approved_at timestamptz`, `paid_by text REFERENCES users(id)`, `paid_at timestamptz`, plus `CHECK (paid_by IS NULL OR approved_by IS NULL OR paid_by <> approved_by)`. Backfill: rows still `approved` get `approved_by = reviewed_by`; rows already `paid` get `paid_by = reviewed_by` and `approved_by = NULL` (unknown, before maker-checker). | Database-enforced A-03 | The NULL clause is needed because legacy approvers are lost. **Decision P3-D2** on NULL approvers. |
| **S-3** | `published_results`, `answer_key_questions`, `online_exam_questions`, `exams`, `portal_notices`: add `published_by text REFERENCES users(id)` (nullable) | Publisher recorded in the database (A-04, A-05, A-17) | Optional if S-1 is approved (audit events would carry it) |
| **S-4** | `admit_cards`: add `is_published boolean NOT NULL DEFAULT true` (existing rows stay visible), `published_by`, and draft semantics for new imports; candidate lookups filter `is_published = true` | A-06 as approved (Official drafts, Super Admin publishes) | **Controlled deployment needed** (A-20). Old code would show new drafts, so stop, migrate and start; no mixed versions. |

**No change** to `users`, sessions, the P0-4 tables or any other existing table is needed for P0-3.

## 8. Implementation sequence (after approval)

0. **Prerequisite:** commit P0-4 against its 21-file manifest (C-17), with Git approval. Otherwise P0-3 edits to `server/index.ts` and `RolePortal.tsx` mix into the accepted P0-4 files.
1. **Test scaffolding first:** a table-driven route-matrix test (§9.1) committed **red**, showing every gap in §4 as a failing assertion.
2. **Pure Super Admin guards (no logic changes):** credits; withdrawals; result, answer-key and online-exam PATCH; helpdesk GET and PATCH; ownership linking; document download and review. The matrix turns green for these.
3. **Conditional checks inside handlers:** withdrawal maker-checker and keeping the approver; results POST and import; answer-key and online-exam import over published content.
4. **Admit cards:** interim option A or B (P3-D1).
5. **Appendix items** if P3-D6 is approved (exam PATCH, notices, A-08 contact hiding).
6. **Frontend:** hide or disable controls (`RolePortal.tsx`, `InstitutionDocumentManagement.tsx`, `FeedbackSlideOut.tsx`); list the affected screens for review (P-08).
7. **Interim `admin.action` log lines.**
8. **Schema work only after approval:** S-1, then S-2, S-4 and S-3, each with its own isolated validation (§10) and code change.

## 9. Regression test plan

### 9.1 Route-matrix test (new, table-driven)
- **Harness:** the existing pattern in `server/roleLookupSecurity.test.ts` (import `app`, stub `pool.query` by session token for candidate, center, ordinary Official and Super Admin).
- **For every route in §4:** no session → 401; candidate → 403; center → 403; ordinary Official → expected (403 or allowed); Super Admin → allowed.
- **When the outcome is 403, assert that no query other than the session lookup ran** (proves the guard runs before the handler).
- **A registry check fails the test when a new `/api/admin/*` route appears without a matrix entry**, so future routes can't slip past review.

### 9.2 Behaviour tests (per section)
- Maker-checker: same approver and payer → 409 with no debit; different people succeed; approver kept; legacy approved row; P3-D2 case; two simultaneous payments.
- Results, answer keys and online exams: drafts versus corrections; a whole import refused with nothing written; Super Admin corrections return to draft; public and candidate lookups show only published content.
- Admit cards: the chosen interim option.
- Helpdesk: the `FeedbackSlideOut` condition; the `openHelpdesk` behaviour (P3-D4).
- Documents: download and review refused for ordinary Officials with no file opened; list unchanged.

### 9.3 Preservation tests
- A-01: an ordinary Official still approves and rejects institutions (`instituteApproval.test.ts` green).
- A-18: an ordinary Official still creates exam forms and draft imports for unpublished content.
- A-07: data export unchanged.
- **The full P0-4 suite, focused session tests and the Phase 7 scenario harness unchanged.**
- All existing suites (416 tests, 2 skipped), lint, typecheck and build.

### 9.4 Frontend tests
- Unit tests for any extracted visibility helper (for example `canPublish(user)`).
- A rendered-markup check that Super Admin-only controls aren't rendered for ordinary Officials (the `renderToStaticMarkup` approach used in `src/components/ui/ui.test.tsx`).

## 10. Isolated validation plan

1. **Environment:** a fresh disposable PostgreSQL 17 container and an API container built from an **allowlisted** build context (the Phase 7 Step 3C pattern):
   - unique per-run names and labels;
   - no host port for the database; API on `127.0.0.1` only;
   - not port 5432;
   - existing ELTNOY containers and volumes untouched and their identity checked before and after.
2. **Data:** synthetic only.
   - Accounts: one candidate, one center, one ordinary Official, **two** Super Admins (needed for maker-checker).
   - Institutes, withdrawals (pending, approved with a known approver, approved with a NULL approver, paid), results, answer keys and online exams in both draft and published states, admit cards, helpdesk tickets, legacy applications, institution documents.
3. **Runs:**
   - (a) the matrix test against the real database;
   - (b) scripted HTTP calls for every §5 row with each account;
   - (c) a browser check of the affected screens for an ordinary Official versus a Super Admin;
   - (d) the P0-4 Phase 7 scenarios repeated.
4. **Schema items (only if approved):** run each migration twice; byte-identical definitions for unaffected tables; backfill correctness for S-2 on the legacy rows; for S-4, a controlled-deployment rehearsal proving drafts never show to candidates.
5. **Evidence:** before and after snapshots; request results by account; counts per table; no secrets or personal data in the report.
6. **Cleanup:** by exact name and label only, with approval, verified afterwards.

## 11. Rollback strategy

- **Code-only changes (§2–§3):** revert the commit. They store no data that old code can't read, so rollback is safe at any time. Rows written in the meantime stay valid: drafts stay drafts (a Super Admin publishes them), and withdrawals paid in the meantime keep the approver in `reviewed_by`.
- **Schema changes S-1 to S-4:** additive. Rolling back means deploying the previous code with the new columns or table left in place, never dropping them in production.
  - **S-4 is the exception:** with the previous code running, any admit-card drafts would become visible. Before rolling back S-4, publish or remove those drafts (operational step, with approval), or keep the new code.
- **Feature switch (optional):** an environment flag `P0_3_ENFORCEMENT` could switch the new guards off, but that makes it possible to disable a security control. **Not recommended**; revert instead.

## 12. Decisions needed before implementation

| ID | Decision |
|---|---|
| P3-D1 | Admit cards: interim option A (Super Admin-only writes, a temporary departure from A-18) or option B (wait for S-4) |
| P3-D2 | Withdrawals approved with an unknown (NULL) approver: block payment, or allow it? |
| P3-D3 | Confirm at least two Super Admin accounts will exist (maker-checker needs them operationally). Q115 staff activation and the Q122 / Q124 limit settings add to Super Admin workload. |
| P3-D4 | Whether ordinary Officials may see the open helpdesk ticket count |
| P3-D5 | Institution approval (A-01) without document access (A-09): accept, add a Super Admin review prerequisite, or another approach |
| P3-D6 | Include the appendix items (exam form publishing, notices, A-08 contact hiding) in this batch? |
| P3-D7 | Proceed with code-only enforcement before the audit table (S-1), accepting the interim, non-atomic log lines? |
| P3-D8 | Approve the P0-4 commit as step 0 |
| P3-D9 | Approve S-1, S-2, S-3 and S-4 individually (each is optional for the code-only phase) |
