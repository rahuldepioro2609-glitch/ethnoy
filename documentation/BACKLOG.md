# ELTNOY dependency-aware backlog

**Date:** 2026-11-27. Checked against the code in worktree `audit-log` (branch `audit-log`, base `1dd6145`, uncommitted), the main checkout, the policy register, the client report and actual test runs.

## How to read this document

**Approval:**
- **IMP** means IMPLEMENTATION_APPROVED, or approved by the owner's instruction in this session.
- **DISC** means DISCUSSION_APPROVED: the direction is agreed, but implementation needs separate approval.
- **PEND** means PENDING_CONFIRMATION: no client decision yet.
- **—** means no client decision is needed (engineering work).

**WS conflict** means the task touches files that the other tool is editing for the unfinished Institute Workspace.

## 0. Verified state (not historical claims)

| Check | Result (2026-11-27) |
|---|---|
| Live production | `ee5a049`. Student sign-up and email code, password sign-in, Institute sign-in and the Resend egress proxy were all checked live on 2026-11-24. |
| Worktree `audit-log` | A-11/A-12 audit log, AL-4.8 (refused payments), the Merit List foundation, and the MFA test fix (below). **Not committed or deployed.** |
| `npm test` (worktree) | 1,237 tests: 1,194 passed, 0 failed, 43 skipped (the PostgreSQL-only suites) |
| Disposable PostgreSQL 17 | **36 of 36 passed.** The "known baseline failure" `AUTH C1.8 factors` was a **stale test**, not a defect. The API role had since lost its `UPDATE` grant on `confirmed_at`, and a later rule (O-4-A) forbids reusing another user's enrolment challenge. Both protections are now asserted. |
| Other tool's Workspace (main checkout, uncommitted) | `server/instituteWorkspace.ts`, `instituteWorkspaceMigration.sql`, `InstituteZonePage.tsx`, plus edits to `index.ts`, `surface.ts`, `migrate.ts`, the grants files, `surfaceWiring.test.ts` and `InstituteAdvancedSection.tsx`. Last edited 2026-11-27 16:04. **Not reviewed. It lets an institute publish results directly (conflicts with A-04).** |
| Integration risk | The worktree and the Workspace both change `index.ts`, `surface.ts`, `migrate.ts`, `databaseGrantsMigration.sql`, the grants and migrate tests, and `surfaceWiring.test.ts`. Combining them later needs a careful merge. Neither should be deployed on its own without the other being reconciled. |

## A. ALREADY COMPLETE (verified)

| Item | Evidence |
|---|---|
| Student and Institute registration and sign-in, email verification, admin MFA, private admin host, surface isolation | Live, plus tests |
| Institution documents and verification decisions | Tests, live |
| Online CBT engine with server-held timing (P0-4) | Tests |
| Wallet credits and withdrawals with maker-checker (A-02, A-03) | Route tests |
| Results and admit-card import and publication rules (A-04, A-05, A-06 interim, A-16 for results) | Route tests |
| A-11 audit trail and A-12 Super Admin viewer | Worktree, tests and real PostgreSQL |
| Merit List foundation (ordering, ties, validation, draft versions, export) | Worktree, tests and real PostgreSQL |
| MFA factor database protections verified on real PostgreSQL | Fixed test, 36/36 |

## B. APPROVED AND IMPLEMENTABLE (safe now, no client rule needed)

| Priority | Task | Approval | Dependencies | Files | Risk | WS conflict | External infra |
|---|---|---|---|---|---|---|---|
| **P0** | **Finance failure events from the approved audit design (§7):** `wallet.credit_failed` (duplicate payment reference, or the institute is not eligible) and `withdrawal.payment_failed` (duplicate transfer reference) | A-11 (IMP by owner), proposal §7 contracts | A-11 (done) | `server/audit.ts`, `server/index.ts` (credits and withdrawal routes), tests | Low: written only after the rollback, and never changes the response | Same file (`index.ts`) but different routes | No |
| P2 | Merit lists above 20,000 results: a streaming or batched computation | Merit foundation (owner instruction) | Only needed once an exam is that large; none is today | `server/meritListRoutes.ts` | Medium (memory, timeouts) | No | No |
| P2 | Split the 928 kB bundle by surface (lazy-load admin and institute code) | — | None | `src/App.tsx`, `src/main.tsx` | Medium (routing regressions) | **Yes**: the Workspace changes the institute dashboard components | No |
| P2 | Merge plan for the worktree and the Workspace (a reconciliation document) | — | The other tool must finish | Docs only | Low | — | No |
| P3 | Remove the unused simulated-webcam component `AiProctoringModal.tsx` | — | Owner OK to delete | 1 file | Low | No | No |

## C. APPROVAL REQUIRED (do not build until the client decides)

| Priority | Task | Status | Blocking decision |
|---|---|---|---|
| P0 | Off-host encrypted backups and restore drill | PEND | Storage location (free-only hosting rule), M-10 |
| P0 | Email password reset for Students (password-only sign-in since 2026-11-24) | PEND | Not decided; affects AU policy |
| P0 | A-08: hide contact details from ordinary Officials | DISC | Implementation approval |
| P0 | A-16 for admit cards (draft step) and A-20 controlled deployment | DISC | Implementation approval |
| P0 | Other denial and refusal logging (authorization denials, published-content refusals, failed sign-ins) | PEND | OD-5 |
| P1 | A-10: Official management (create, grant or revoke Super Admin, disable) | DISC | Separate milestone approval |
| P1 | IP and user-agent capture, sealing chain, audit export, retention | PEND | OD-3, OD-6, OD-7, OD-1 |
| P1 | Institute activity view (S-07) | PEND | C-03 versus A-12 |
| P1 | Merit rules: tie-break, numbering, qualification, cut-off, category, publication, re-evaluation, institute merit, negative marking | PEND | ML-1 to ML-9 |
| P1 | Form builder: job, admission, scholarship and webinar forms (R-01 to R-05) | DISC/PEND | Data-model approval (D-01 to D-34) |
| P1 | Institute-run exams, admit cards, paper tender and results (S-08 to S-18) | PEND | F-4, F-5 |
| P1 | Applicant review by Institute staff (Q117 to Q119) | DISC | Implementation approval |
| P1 | Subscriptions, plans and pricing (R-16, S-03) | Conflicts with N-03 | F-1, F-3 |
| P1 | `{username}.eltnoy.com` and the institute website (R-14, R-15, S-05, S-06) | Conflicts with N-04 | F-2, plus wildcard DNS and TLS |
| P2 | Payments: UPI, gateway, commission and GST (R-19, R-21, S-12) | PEND | F-6, provider approval |
| P2 | Notifications beyond one-time codes | PEND | Provider approval (in-app is approved but its design isn't) |
| P2 | SMS (Twilio) activation, and staff activation by mobile OTP (Q115) | PEND | Provider limits and owner approval |
| P3 | Live monitoring, CCTV and biometrics (R-09, S-16, S-17) | PEND | F-7, hardware, consent |
| P3 | Interviews, training, webinars and certificates (R-11 to R-13) | PEND | Product decisions |

## D. BLOCKED BY DEPENDENCY

| Task | Waiting for |
|---|---|
| Deploying the worktree (A-11, A-12, merit, MFA test fix) | The owner's commit and deploy decision, a backup before `migrate`, and reconciliation with the Workspace edits to the same files |
| Institute Workspace backend review and fixes | The other tool finishing its work; F-4 (who publishes results and admit cards) |
| Merit batch processing | An exam with more than 20,000 results (none known) |

## E. NOT REQUIRED / OUT OF SCOPE now

| Item | Why |
|---|---|
| Render and Netlify configs | Marked unsupported; the owner can delete them |
| Live video for interviews and webinars | Needs infrastructure and a product decision; never fake it |
| Changing the online scoring formula or adding negative marking | Forbidden by R-10 |

## F. Selected next task

**P0: finance failure events from the approved audit design (§7).** Why this one:

- **Approved:** it is approved through A-11 and the owner's instruction, with exact contracts in proposal §7.
- **No new rules:** it invents no client rule. Duplicate references are already refused today; this only records the refusal.
- **Touches the right code:** only the credit and withdrawal-payment routes plus the audit writer. None of the Workspace's routes.
- **Highest-priority safe item:** it is the highest-priority item in section B, because it covers financial integrity.
