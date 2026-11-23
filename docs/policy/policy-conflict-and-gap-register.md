# ELTNOY policy conflict and gap register

**Status:** Internal working register. Do not publish externally. Last updated 2026-11-14.

**Rule:** no conflict is resolved here. Each item has a recommended resolution marked **PENDING_CONFIRMATION**, which applies only once the client authorizes it.

**IDs:** entries in the master register are cited as S-, R-, E-, A-, P- and N-; proposal decisions as D-. The confirmed decisions Q115–Q125 are cited as Q115 to Q125 (master register, section QD).

**Code-status note (2026-11-14):** C-01/SEC-01 are largely addressed by commit `df9b93e` (P0-3; still open: A-08, A-10, A-11, A-12, A-17), and C-17 by commit `5c8dd41` (P0-4 committed). The rows below keep their 2026-11-03 wording. AU-01 to AU-03 (Student login) are recorded in the master register; M-28 is new.

**Update of 2026-11-14:** SM-2 decisions SM2-P01 to SM2-P04 recorded in the master register (section SM). M-14 and SEC-07 are partly settled by SM2-P03. New missing decisions M-20 to M-27 come from the SM-2 review (`docs/reviews/SM2_POLICY_DECISION_REGISTER.md`, OI-1 to OI-7).

**Update of 2026-11-03:** Q115–Q125 recorded. C-11, PERM-01 and PERM-06 are settled by them. New conflicts C-18 to C-21 and gaps M-16 to M-19 and G-Q119 were added.

## 1. Conflicting policies

| ID | Conflict | Evidence | Severity | Recommended resolution (PENDING_CONFIRMATION) |
|---|---|---|---|---|
| **C-01** | **The approved P0-3 authorization policy (A-02 to A-17) isn't enforced by the current code.** Every Official can credit wallets, approve or pay withdrawals, publish results, answer keys and online exams, publish admit cards, read the helpdesk, link application ownership and download institution documents. | Every `/api/admin/*` route uses `requireRoles('official')` only. `requireSuperAdmin` is used only at `server/index.ts:263` (data export). `institutionDocuments.ts:605` uses `officialAccess = [requireAuth, requireRoles('official')]`. There's no audit table and no maker-checker. | **Critical** (security) | Finish P0-3 as the first engineering work of milestone 3, **before** any new opportunity feature. Implement the revised P0-3 plan (03:22Z corrections) after its final review. |
| **C-02** | **A-02 ("wallet credits: Super Admin only") versus proposal §8**, where a confirmed applicant payment automatically credits the organization's wallet | Proposal revision 2 §8 "Settlement" | High (finance) | Treat platform settlement credits as **system entries that Super Admin approves** in batches, with maker-checker. Alternatively, the client confirms that A-02 covers manual credits only. |
| **C-03** | **A-12 ("audit-log read: Super Admin only") versus the proposed organization permission `audit.view`** (D-08) | Proposal revision 2 §3 | Medium | Remove `audit.view`. Give organizations a separate, filtered **organization activity history** (their own staff's actions, no platform data), named differently from the audit log. |
| **C-04** | **D-06 (add `staff` to the `users.role` check) versus the proposal's ground rule 1** ("Additive only … no existing … constraint … changes") and S-08 | Proposal §0.1 versus §3 | High (architecture) | Record D-06 as an **explicit, named exception** to ground rule 1, approved separately, validated on a disposable database, with a one-way rollback note. The additive alternative (a separate staff account table) is costlier and riskier. |
| **C-05** | **A-05 (exam and answer-key publishing: Super Admin only) versus organizations running optional exam modules,** and D-27 (publishing without review) | A-05; P-02; D-27 | Medium | Keep A-05. Organizations prepare exam content as drafts; Super Admin publishes. D-27 stays "no" for exam content until the client decides otherwise. |
| **C-06** | **Product naming:** "ELTNOY Examination Portal" (`index.html` title and meta, `metadata.json`, the `BrandLogo` subtitle "Examination Portal") versus P-01 (an opportunity platform). Changes are limited by P-03, P-04 and "don't redesign the logo". | `index.html`; `metadata.json`; `src/components/BrandLogo.tsx:20` | Low (branding) | The client decides the platform name and subtitle wording. The logo image doesn't change; only text would, once approved. |
| **C-07** | **The legacy `exams.category` list includes `Scholarship`** (an exam category) **versus N-01 scholarships** (an opportunity type) | `server/schema.sql` (the `exams` table) | Low | Leave the legacy list unchanged. In the new platform a scholarship *exam* is an `examination` opportunity linked to the exam; a scholarship application is a `scholarship` opportunity. Document both for users. |
| **C-08** | **R-05 (30-second grace) versus the configurable range (0–120 s)** | E-08; Phase 7 §10 | Medium | Pin 30 s for release, and refuse non-default values in production configuration unless the client approves. Decision R-12. |
| **C-09** | **The legacy application statuses** (`submitted`, `under_review`, `approved`, `rejected`) **use different words from P-11** (`under_verification` and others) | `applications.status` CHECK | Low | Don't migrate legacy rows. Use a display mapping only (`under_review` shown as "Under verification") and never write the mapping back. P0-4 depends on `status = 'approved'`. |
| **C-10** | **R-09 (P0-4 audit inside the score) versus A-11 (a single audit trail)** | R-09; A-11 | Low | Keep P0-4 as it is. When `audit_events` exists, add a matching system event for each finalization in the same transaction. That would change P0-4 code, so it needs approval. |
| **C-11** | ~~D-07 (verified staff) depends on email or SMS~~ | — | — | **SUPERSEDED by Q115 and Q116.** The client chose an Owner invitation code, then mobile OTP, then Super Admin activation. The out-of-band activation code recommended here is withdrawn. The remaining provider dependency is C-18. |
| **C-12** | **The proposal's categories** (`government_form`, `private_form`, no `registration`) **versus N-01** | Proposal revision 2 §2 | Low | Use N-01's six types (examination, scholarship, admission, vacancy, registration, custom) and move "government" and "private" to the organization type. D-04 is still to be confirmed. |
| **C-13** | **N-02 says the organization types "include" five types**, so the list may be incomplete | N-02 | Low | The client confirms whether there's an `other` type or a closed list of five. |
| **C-14** | **N-04 (no separate institution websites)** versus a possible in-platform public page for each organization | N-04 | Low | Allow an **in-platform** organization profile page under ELTNOY's domain, listing its opportunities, with no custom domain, custom theme or separate site. Needs confirmation. |
| **C-15** | **D-16 payment transitions** versus P-16 (providers pending) | D-16; P-16 | Medium | Phase 1: fees of zero and offline verification only. Provider-confirmed transitions are switched off until providers are approved. |
| **C-16** | **The `users.account_status` default of `'approved'`** versus P-10 and **Q115/Q116 ("no access before Super Admin activation")** | `schema.sql`; `auth.ts:146` | High (security) | Staff accounts are always created with an explicit `'pending'`, and only Super Admin activation (Q115) makes them active. A database trigger or check prevents `role = 'staff' AND account_status = 'approved'` without an activated membership. Part of the D-06 approval. |
| **C-17** | **P0-4 is accepted but uncommitted, and milestone work will touch the same files** (`RolePortal.tsx`, `server/index.ts`, `src/api.ts`) | R-04; checksum manifest | High (process) | Commit P0-4 against the manifest **before** milestone 3 starts. This needs Git approval (S-04). |
| **C-18** | **Q116 requires mobile OTP for staff onboarding, but the SMS provider integration isn't approved** (P-18, S-07; Q116 says itself that SMS integration needs separate approval) | Q116; P-18 | High (blocks milestone 9) | Staff onboarding can't complete until an SMS provider is approved. Recommended: build invitations and Super Admin activation behind an OTP interface with no provider. Staff stay inactive (Q115) until the OTP step can run. **No alternative verification is assumed in place of OTP.** |
| **C-19** | **The approved status set (P-11 / D-15) has no state for appeals (Q120) or withdrawal (Q124, Q125)** | P-11 lists nine statuses; Q120, Q124 and Q125 need appeal and withdrawal states | Medium | Either (a) add statuses (for example `appeal_pending`, `withdrawal_requested`, `withdrawn`), which **extends P-11 and needs client confirmation**, or (b) keep the nine statuses and model appeals and withdrawal requests as separate records whose outcome changes the status. Recommended: `withdrawn` as a status (it's a terminal state applicants see), with appeals and withdrawal requests as records. |
| **C-20** | ~~Q117 limits invigilators to "assigned examination sessions", but no examination-session record exists~~ | — | — | **RESOLVED: DISCUSSION_APPROVED with Option C** (client, 2026-11-03; master register N-07). Designed in `../architecture/examination-session-module.md`, with 13 new tables and no existing-table change. Open sub-decisions ES-D1 to ES-D12. |
| **C-21** | **Proposal D-16 says "approved and rejected are final", but Q120, Q121, Q123 and Q125 allow appeals, overrides, reopening and withdrawal after approval** | `data-model-final-proposal.md` §8 | Medium | The final statements in D-16 are superseded. The transition table must add Owner-only transitions: `rejected` to `approved` or back to review (Q121, Q123, and the appeal outcome in Q120); `approved` to `withdrawn` (Q125), each with a mandatory reason and audit. **`data-model-final-proposal.md` hasn't been updated yet** (outside this documentation scope). |
| **C-22** | **Emergency pause (N-07, capability 8) versus P0-4 for online exams.** Pausing or extending an online attempt would change `expires_at`, the 30-second grace and saved-answer scoring (R-05 to R-09), and the policy that exam duration is unchanged (R-10). | `examination-session-module.md` §6.2 | High (P0-4 integrity) | Pausing an online or hybrid session is **informational only** and P0-4 timers are untouched, until the client decides on pausing or extending online attempt time and separately approves a P0-4 change. |

## 2. Missing decisions

| ID | Missing decision | Blocks | Owner |
|---|---|---|---|
| M-01 | **Q1–Q114** wording and answers | Final verification of the whole register | Client |
| M-02 | **Q115–Q125** wording and answers | The same | Client |
| M-03 | Final review of the revised P0-3 implementation plan | C-01, milestone 3 | Client |
| M-04 | D-06 (`staff` in `users.role`) and the D-08 permission catalogue. **D-07 is decided by Q115/Q116; the D-08 templates by Q117.** | Milestone 9 | Client |
| M-05 | D-16 transitions: the open questions in §7, after Q120–Q125 | Milestone 6 | Client |
| M-06 | D-10: what non-super Officials may do on the new platform | Milestones 4, 6 and 11 | Client |
| M-07 | Refund policy: who may refund, whether maker-checker applies (by analogy with A-03), whether a rejection triggers a refund, partial refunds | Milestone 8 | Client |
| M-08 | Platform revenue model with no subscriptions (N-03): a per-application fee, a commission (D-23), or nothing | Milestone 8 | Client |
| M-09 | Data retention and deletion (P-13 / D-19), including for audit (A-13) | Milestones 7 and 13 | Client |
| M-10 | Production hosting, backups, document storage location and encryption at rest (S-12) | Milestone 14 | Client |
| M-11 | Platform name and subtitle wording (C-06) | Milestone 14 | Client |
| M-12 | Organization public profile page (C-14) and an `other` organization type (C-13) | Milestones 3 and 4 | Client |
| M-13 | Malware scanning of uploaded documents. A local open-source scanner is not SaaS, but it's a new dependency. | Milestone 7 | Client / Eng |
| M-14 | Two-factor authentication for Super Admin and staff (no provider needed for an authenticator app). **Super Admin part settled by SM2-P03 (mandatory before Staff Management go-live). Ordinary Officials settled by SM2-P05 (mandatory TOTP, 2026-11-15).** Platform Staff: a separate future phase. Still open: Organization Owners and Organization Staff (outside the current phase; SM-2 OI-1) | Milestones 3 and 9 | Client |
| M-15 | Accessibility conformance target (for example WCAG 2.1 AA) for the whole platform | Milestone 13 | Client |
| M-16 | **Q125:** what "the opportunity's rules" for withdrawal after approval are, and where they're configured | Milestone 6 | Client |
| M-17 | **Q120:** what Super Admin may do in a platform-level dispute beyond reviewing it (for example, recommend or escalate), given it "does not automatically replace" the organization's decision | Milestones 6 and 11 | Client |
| M-18 | **Q119:** what counts as "overdue" for assignments, and who receives the alert | Milestone 9 | Client |
| M-19 | **Q123:** what "the appropriate review stage" is after reopening (for example `under_verification`), and who counts as "explicitly authorized authority" | Milestone 6 | Client |
| M-20 | **Institute status and its Organization Staff (SM-2 OI-4, finding F07):** when an Institute is suspended (`institute_verifications.suspended_at`) or its institutional verification is not `verified` (pending or rejected), must its Organization Staff be refused at sign-in and on every request (existing sessions refused)? Options: (A) yes, for suspension and for any non-`verified` status, mirroring the Owner gate (recommended; fail closed); (B) suspension only; (C) no effect. SEC-09 covers only the suspension of an individual member, and Q115/Q118 do not decide this. Today staff check only `users.account_status = 'approved'` | Organization Staff go-live (after C-18) | Client |
| M-21 | **Q115 remainder (finding F05):** who may suspend or remove Organization Staff (Owner, Super Admin, both), and whether an Owner may revoke or re-issue an unaccepted invitation. An expired code currently holds the staff ID permanently | Organization Staff offboarding; invitation hygiene | Client |
| M-22 | Staff session lifetime (currently the 12-hour portal lifetime) (SM-2 OI-2) | Staff go-live | Client |
| M-23 | Per-account lockout for staff sign-in (only a per-address limiter exists) (SM-2 OI-3) | Staff go-live | Client |
| M-24 | Super Admin MFA recovery process (lost factor) and the step-up window for sensitive actions (SM-2 OI-6). **Recovery process settled by SM2-P05** (two-person reset for Super Admin targets; one Super Admin other than the target for ordinary Officials, D-1; break-glass CLI only when a second Super Admin is unavailable). Still open: the step-up window and the other numeric values, and D-3 to D-11 (`docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md` §13). Database integrity of resets: AUTH C1.8.4. Operator identity for break-glass and bootstrap: SEC-11 | SM2-P03 implementation | Client |
| M-25 | WireGuard peer-key rotation period, and how the Admin TLS certificate is issued while Admin is not publicly reachable (SM-2 OI-7) | SM2-P02 implementation | Client / Eng |
| M-26 | Rollout of institutional verification (SM2-P04) for existing approved Institutes: pre-verify them, or require a Super Admin decision for each before AUTH-1 is enforced | AUTH-1 go-live | Client |
| M-27 | Confirm the SM2-P04 transition rule: verify and reject must change the status (either may follow the other); suspend needs an unsuspended Institute, lift needs a suspended one; suspension is independent of the verification status | SM2-P04 sign-off | Client |
| M-28 | **Student mobile numbers across accounts (AU-03):** may one mobile number belong to several Student accounts? Today none is prevented; mobile sign-in is refused generically when more than one account is tied to a number, and those students must use the Student ID path (accounts created mobile-first have no usable Student ID, so they are stuck until this is decided). Options: (A) one verified mobile per Student account, enforced at registration and capture (needs a reviewed constraint or check); (B) allow sharing and add an account chooser after the code is verified; (C) keep refusing ambiguous numbers | Student launch | Client |
| G-Q119 | **Q119** needs form-wise assignment, workload limits, manual and automatic allocation, reassignment history and performance reports. None of this is in `data-model-final-proposal.md`; a design addition is needed. | Milestone 9 | Eng |

## 3. Security gaps

| ID | Gap | Evidence | Recommended action (PENDING_CONFIRMATION) |
|---|---|---|---|
| SEC-01 | The approved P0-3 authorization isn't enforced (C-01) | See C-01 | Milestone 3, first task |
| SEC-02 | No audit table; important admin actions leave no record (A-11 not built) | No `audit_events` in `schema.sql` | Milestone 2: design and validation. Milestone 3: implementation. |
| SEC-03 | No HTTP request logging, so request-level evidence can't be produced (Phase 7 finding) | Phase 7 §7 | Structured request logs (method, route pattern, status, duration, request ID; no bodies, cookies or personal data) |
| SEC-04 | The API binds `0.0.0.0` outside Docker (R-13) | `server/index.ts` | Bind to a configured host, defaulting to loopback outside containers |
| SEC-05 | Unnecessary files in the Docker build context (`.vscode/settings.json`, 33 `.aistudio` images); no secrets | Build-context verification, 2026-11-03 | Separate narrow `.dockerignore` approval |
| SEC-06 | The isolated test environment still holds credential files (`pg.env`, `api.env`) | R-14 | Approve the cleanup with `down.sh` |
| SEC-07 | No second sign-in factor for privileged accounts | M-14 | Super Admin and all Officials: decided by SM2-P03 and SM2-P05 (mandatory TOTP; not built; specification in `docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md`). Others: M-14 |
| SEC-08 | Uploaded files aren't scanned for malware | M-13 | Decide M-13 |
| SEC-09 | Staff sessions must be revoked when a member is suspended or removed (not yet designed in code) | D-07 analysis | Part of milestone 9's acceptance criteria |
| SEC-10 | `is_super_admin` isn't limited to the `official` role in the database (application checks guard it today) | `schema.sql` | Optional `CHECK (is_super_admin = false OR role = 'official')`, which needs approval (it changes an existing table) |
| SEC-11 | **MFA O-1 (deferred by the owner, AUTH C1.8.4):** the MFA operator CLI (bootstrap and break-glass) and the API use the same database credentials, so the database cannot tell which one issued a bootstrap or break-glass enrolment ticket. The application role can therefore insert such tickets. The database checks only the workflow (bootstrap preconditions under an advisory lock; break-glass reset completeness and audit event), and application-supplied event details are not proof of operator identity | `docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md` §7.3; `server/adminMfaMigration.sql` | Resolve before MFA Phase 7 (for example a dedicated operator database role); needs a separately approved design |
| SEC-12 | **MFA O-4 (AUTH C1.8.4):** the database does not yet require an enrolment ticket to create an MFA factor, so the application role could enrol a factor for a user who has none | `docs/reviews/SM2_MFA_IMPLEMENTATION_PLAN.md` §6.6, §11 | Mandatory part of MFA Phase 4 |

## 4. Unresolved permissions

| ID | Question | Related |
|---|---|---|
| PERM-01 | ~~Can organization staff approve or reject applicants?~~ **DECIDED by Q118:** the Organization Owner, and Application Managers explicitly granted `application.decide`, limited to their assigned forms (Q119). Not Reviewer or Verifier by default. | D-08, Q118, Q119 |
| PERM-02 | Does offline payment verification need two people? | D-08 (`payment.verify_offline`); A-03 by analogy |
| PERM-03 | What may ordinary Officials see of new applicants' personal data? | D-10, A-08 |
| PERM-04 | Who approves organization *opportunities* for publishing: all Officials (like institution approval, A-01) or Super Admin only (like exam publishing, A-05)? | D-27; A-01 versus A-05 |
| PERM-05 | Can staff export their organization's applicant data, and in what form? | A-07 (full export is Super Admin only) |
| PERM-06 | ~~Are invigilators limited by center or session?~~ **DECIDED by Q117:** assigned examination sessions only. A session record doesn't exist yet (C-20). | D-09, Q117 |
| PERM-07 | Can one staff account serve several organizations? | D-06 analysis |

## 5. Payment-provider dependencies

| ID | Dependency | Status | Notes |
|---|---|---|---|
| PAY-01 | Choice of primary and backup gateways | PENDING (P-16) | The model is provider-neutral; no SDK and no credentials |
| PAY-02 | Webhook endpoint exposure, needing a reachable public HTTPS host | Depends on M-10 hosting | No cloud assumed (S-12) |
| PAY-03 | Settlement, reconciliation and refund workflow | Depends on M-07 and C-02 | — |
| PAY-04 | Before providers are approved | Allowed: fees of zero and offline verification | Organization staff with permission record offline payments; audited |

## 6. Notification-provider dependencies

| ID | Dependency | Status |
|---|---|---|
| NOT-01 | In-app notifications | DISCUSSION_APPROVED (P-17); no provider needed |
| NOT-02 | Email provider | PENDING (P-18) |
| NOT-03 | SMS provider | PENDING (P-18) |
| NOT-04 | Staff verification by mobile OTP (Q116); staff password reset by email or SMS | **Mobile OTP is the confirmed method (Q116) and needs the SMS provider (C-18).** Password reset stays blocked by NOT-02 and NOT-03. |
| NOT-05 | Applicant password reset (none exists today) | Missing decision. Without email or SMS, only an administrator-assisted reset is possible. |

## 7. Focus decisions: D-06, D-07, D-08, D-16

| Decision | Conflicts | Gaps | Recommended next step (PENDING_CONFIRMATION) |
|---|---|---|---|
| **D-06** `staff` in `users.role` | C-04 (additive rule); C-16 (default approved status); C-17 (frontend files under P0-4) | The frontend crashes on an unknown role (`App.tsx:201`); the `role` list must be updated in sign-in, the CLI and the test fixture; one-way rollback | Approve as a named exception, with a test on a disposable database for: the migration running twice, the constraint text, a 403 on every existing role route, and a staff row created without a status being unable to sign in |
| **D-07** verification | **Decided by Q115 and Q116.** C-18 (SMS provider); C-16 | No `verified_by` or `activated_by` column yet; session revocation on suspension (SEC-09); OTP rate limiting (Q116) | Design an invitation table (hashed, single-use, expiring, one organization), an OTP challenge with rate limits, and **Super Admin activation recorded with actor and time** (Q115). Implementation still needs separate approval. |
| **D-08** permissions | C-03 (`audit.view`); C-02 by analogy for `payment.verify_offline` | Templates decided by **Q117** (Reviewer, Verifier, Application Manager, Finance Viewer, Invigilator, Viewer, plus custom roles); `application.decide` explicit only (**Q118**). Still open: the permission catalogue, PERM-02, PERM-05. | Seeded `permission_catalogue` table; drop `audit.view`; escalation guards; Finance Viewer can never hold credit, withdrawal or payment permissions (Q117); Super Admin permissions not delegable (Q117). |
| **D-16** transitions | C-09 (legacy words); C-15 (providers); **C-19, C-21** | **Settled by Q120–Q125:** appeals, override, reopening, withdrawal and withdrawal after approval. **Still open:** a correction requiring a new payment; whether `submitted` persists; whether `resubmitted` persists; an expired correction deadline; unpaid applications at closing; fee changes; M-16, M-17, M-19. | Update the transition table with the Owner-only transitions of Q120, Q121, Q123 and Q125; then every status pair and every actor is tested exhaustively in isolation |

## 8. Database migration risks

| ID | Risk | Mitigation |
|---|---|---|
| DB-01 | Changing the `users.role` constraint locks the `users` table and can't be undone once staff rows exist | `NOT VALID` then `VALIDATE`; disposable rehearsal; one-way rollback documented; production only with S-01 authorization |
| DB-02 | P0-3 needs new columns on existing tables (`institute_withdrawals` approver and payer, `admit_cards` and `published_results` draft state) | Add columns only, with safe defaults; the legacy maker-checker backfill as planned at 03:22Z; controlled deployment (A-20) |
| DB-03 | Large additive migrations aren't atomic if split across files | One migration file per milestone, one transaction, rerunnable (the R-02 pattern) |
| DB-04 | A CHECK-based list (statuses, permissions) needs a constraint replacement every time it changes | Seeded reference tables with foreign keys |
| DB-05 | `jsonb` answers grow without limit | Size limit (D-12); a GIN index only where needed |
| DB-06 | Append-only triggers block legitimate fixes | Corrections are new rows, never updates (the existing pattern); documented in a runbook |
| DB-07 | No validated backup and restore procedure for production | M-10; restore rehearsal before any production migration |

## 9. Existing-system compatibility risks

| ID | Risk | Mitigation |
|---|---|---|
| COMP-01 | The P0-4 start route depends on legacy `applications.status = 'approved'` | Legacy exam applications untouched in Phase 1; the bridge (D-29) is deferred |
| COMP-02 | The frontend role types and routing are hard-coded for three roles | Update them in the same change as D-06; table-driven routing tests |
| COMP-03 | `institute_forms` and the new opportunities coexist | No backfill (P-14); the public site lists both, separately marked, until a decision |
| COMP-04 | The admit-card draft flag isn't understood by old code (A-20) | Controlled deployment: stop, migrate, start; no mixed versions |
| COMP-05 | `StatusBadge` doesn't map five of the new statuses | Add them when milestone 6 is built |
| COMP-06 | Existing center routes would move to permission checks for staff | Before-and-after authorization tests per route; list affected screens (P-08) |
