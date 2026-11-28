# ELTNOY Project Audit: Project Report vs Current Code

**Date:** 2026-11-27
**Requirements source:** `Project Report.docx` (Project Head: Er. Jitender Ahlawat; Developer: Er. Rahul Dhakad). It has 43 paragraphs of text and 18 dashboard screenshots.
**Code audited:** commit `1dd6145` on `vps-deploy`; live production runs `ee5a049`, which differs only in a test file.
**Earlier audits:** this builds on [ELTNOY_COMPLETE_PROJECT_AUDIT.md](../ELTNOY_COMPLETE_PROJECT_AUDIT.md) (2026-11-16 to 2026-11-21) and the policy documents in [docs/policy](../docs/policy). Where those documents still hold, this file points to them instead of repeating them.

**Verdict: NOT READY.** The audit found three things:

1. A secure foundation: auth, surfaces, MFA, staff, documents, the online-exam engine and deployment.
2. Most of the report's **institute self-service** product is not built.
3. Some report requirements **conflict with client decisions already recorded as IMPLEMENTATION_APPROVED**, so they cannot be built until the client resolves them (section F).

> **Current status (2026-11-27, engineering paused):**
> - The audit log (A-11/A-12), refused and failed money events, and the Merit List foundation are **implemented but not integrated**. They exist only in worktree `audit-log` (branch `audit-log`, base `1dd6145`).
> - **No commits or deployments** have occurred. Live production is unchanged (`ee5a049`).
> - **Workspace integration is pending.** See [INTEGRATION_READINESS.md](INTEGRATION_READINESS.md).
> - **Client approval blockers remain.** See [CLIENT_DECISIONS.md](CLIENT_DECISIONS.md).
> - **ELTNOY is NOT READY for full launch.**

---

## A. Current architecture (from code)

| Layer | What exists |
|---|---|
| Frontend | React 19 + Vite + TypeScript + Tailwind single-page app (`src/`). One bundle (918 kB minified) serves every surface. Shared UI components are in `src/components/ui`. Five languages (English, Hindi, Kannada, Bengali, Marathi). |
| Backend | One Express API (`server/index.ts`, about 3,000 lines) plus modules for auth verification, MFA, Platform Staff, Organization Staff, institution documents and submission cycles, and the online-exam scoring, finalization and recovery code. |
| Surfaces | Four hosts, each pinned in `server/surface.ts` with a route policy and an SPA path allowlist:<br>- `eltnoy.com` (marketing)<br>- `exam.eltnoy.com` (Students)<br>- `institution.eltnoy.com` (Institutes)<br>- `admin.eltnoy.in` (Officials and Super Admin, reachable only over WireGuard)<br>Every route is enforced before any handler runs. Session cookies are host-only, and CORS is not used. |
| Database | PostgreSQL 17 with 12 re-runnable migration files (`server/migrate.ts`) and **52 tables**. The API (`eltnoy_app`) and migrations (`eltnoy_migrator`) use separate roles, with a table-level grant manifest. |
| Auth | Students register with mobile, password and an email one-time code. While `AUTH_MOBILE_VERIFICATION=off`, they sign in with password only.<br>Institutes verify contacts by email, and an Official must approve them.<br>Officials and Super Admins must use MFA (TOTP).<br>Google sign-in is built but not configured. |
| Deployment | One VPS (`64.247.186.46`) with Docker Compose. There are two API instances (public and admin) and two Nginx containers. PostgreSQL runs with TLS and no published port, and the Resend email egress proxy is in place. Deploys use `scripts/eltnoy-deploy.sh`. Migrations are run by hand. |

## B. Module status against the report

Status words: COMPLETE, PARTIALLY COMPLETE, UI ONLY, BACKEND ONLY, BROKEN, NOT IMPLEMENTED, NEEDS SECURITY REVIEW. Unless a row says otherwise, "institute" means the Institute owner account.

| Module | Status | Evidence |
|---|---|---|
| Student registration and sign-in | COMPLETE | `/api/auth/register` and `/api/auth/login`, an email code at sign-up, and password sign-in while mobile verification is off. Verified live on 2026-11-24. |
| Institute registration, contact verification and Official approval | COMPLETE | `/api/center/register`, institute email verification, and admin institute verification with verify, reject, suspend and restore. |
| Institute verification documents | COMPLETE | `institution_documents*` tables, versioned uploads, admin review history, and a capability-link resubmission cycle. |
| Institute profile and profile change requests | PARTIALLY COMPLETE | `/api/center/workspace` and `/api/center/profile-changes`, with Official approval. **Missing:** logo, institute type, board, authorized person, previous-versus-requested values in the UI, and cancel. |
| Institute staff and roles | PARTIALLY COMPLETE | `org_staff_*` tables and the invite, roles and activation flow. Activation needs mobile OTP (Q115), which is blocked because SMS is not configured. |
| Activity log | PARTIALLY COMPLETE | Since 2026-11-27 (not yet deployed): the general `audit_events` trail (A-11) and the Super Admin "Audit log" viewer (A-12). An institute activity view is BLOCKED by A-12 / C-03. |
| Opportunity listings (institute forms) | PARTIALLY COMPLETE | `institute_forms` has only two types, `exam_application` and `teacher_recruitment`. An Official approves each listing. **No form builder:** there are no custom fields, and no separate job, admission, scholarship or webinar types. |
| Candidate applications | PARTIALLY COMPLETE | `POST /api/applications` accepts exam applications only. Officials review applications. **Missing:** application fees, applicant dashboard history, correction requests and document upload. |
| Examination creation and management | PARTIALLY COMPLETE (ELTNOY admin only) | Officials create exams and import them by workbook. **Institutes cannot create or manage exams.** There is no 16-stage lifecycle, templates or duplication. |
| Online CBT exam engine | COMPLETE (P0-4 accepted 2026-11-03) | Server-held `expires_at`, autosave through PATCH, a grace window, recovery and scoring. There is no question or answer randomisation and no attempt-limit configuration. |
| Offline (OMR) exams | NOT IMPLEMENTED | — |
| Mock exams | COMPLETE | `/api/mock-exams/*`. |
| Admit cards | PARTIALLY COMPLETE (ELTNOY admin only) | A Super Admin imports or assigns admit cards; candidates look them up and print them in the browser. **Missing:** institute generation, templates, centre allocation, server-made PDFs, bulk download, and the A-06 draft-then-publish step. |
| Question bank and paper tender | NOT IMPLEMENTED for institutes | Officials can import online-exam questions. The institute screen says it is "not enabled". |
| CBT exam centre portal | NOT IMPLEMENTED | There is no centre role, centre registration, seat allocation or system inventory. |
| Attendance | PARTIALLY COMPLETE | Institute candidate check-ins (`center_checkins`) exist. There is no examiner attendance and no OMR or offline upload. |
| Live monitoring and CCTV | NOT IMPLEMENTED | `src/components/AiProctoringModal.tsx` contains a **simulated webcam viewport** but is **not imported anywhere**. It is dead code and must not be wired into the app as a real feature. |
| Results and merit list | PARTIALLY COMPLETE (ELTNOY admin only; merit-list foundation added 2026-11-27, not deployed; rules BLOCKED, see section I) | Officials import results and a Super Admin publishes them (A-04); candidates look up their own. **Missing:** merit lists, ranks, tie-breaks, category and centre-wise results, cut-offs, scorecards, re-evaluation and PDF output. |
| Reports and analytics | PARTIALLY COMPLETE | The institute dashboard summary uses real queries. The admin side has dashboard stats and a Super Admin data export. Institute exports do not exist. |
| Online interview | NOT IMPLEMENTED | The institute screen says it is "not enabled". |
| Training and LMS | NOT IMPLEMENTED | Same as online interview. |
| Webinar live meet and certificates | NOT IMPLEMENTED | — |
| Username and subdomain (`{name}.eltnoy.com`) | NOT IMPLEMENTED | **Blocked by N-04**; see F-2. |
| Institute public mini-website | NOT IMPLEMENTED | **Blocked by N-04**; see F-2. |
| Subscription plans and usage | NOT IMPLEMENTED | **Blocked by N-03**; see F-1. |
| Fees, UPI and commission | PARTIALLY COMPLETE | The institute wallet ledger, Super Admin credits by payment reference, and withdrawals with maker-checker exist. **No payment gateway and no UPI collection.** Commission rates are pending (D-22 and D-23). |
| Logo scroller on the ELTNOY home page | NOT IMPLEMENTED | Depends on F-1. |
| In-app notifications | NOT IMPLEMENTED | Public notices exist. Email is limited to one-time codes. |
| Institute Workspace backend, uncommitted, by another tool | BACKEND ONLY, **NEEDS SECURITY REVIEW** | See D-1. |

## C. Requirement mapping (every item in the report)

**Priority** follows the master prompt: P0 critical, P1 core product, P2 operational, P3 enhancement. **"Blocked"** means a recorded client decision conflicts with the requirement (section F).

| # | Requirement (report) | Existing implementation | Status | Missing work | Priority |
|---|---|---|---|---|---|
| R-01 | Job Application Form module | `institute_forms` type `teacher_recruitment` (listing only) | PARTIAL | Job application form type, configurable fields, applicant submission and review | P1 |
| R-02 | Admission Form module | — | NOT IMPLEMENTED | Form type, fields, submission and review | P1 |
| R-03 | Scholarship Form module | — | NOT IMPLEMENTED | Form type, fields, submission and review | P1 |
| R-04 | Webinar organizing form | — | NOT IMPLEMENTED | Registration form and webinar record | P2 |
| R-05 | Institute: online form only | Listings plus exam applications | PARTIAL | Form builder (field types, validation, preview, publish, dates, limits, fees) | P1 |
| R-06 | Online/offline exam conduct | Online CBT engine (admin-created exams); no offline | PARTIAL | Institute exam creation wizard (S-08), offline/OMR mode | P1 |
| R-07 | Admit card cum examination-centre management | Admin import and candidate lookup | PARTIAL | Institute generation, centres and seat allocation, templates, PDF, A-06 draft step | P1 |
| R-08 | Attendance for examiner and candidate | Candidate check-ins | PARTIAL | Examiner attendance, offline upload, reports | P2 |
| R-09 | Live monitoring for exam | — | NOT IMPLEMENTED | Infrastructure assessment first (cameras, network); no fake feeds | P3 |
| R-10 | Result and merit list maker with sheet preview | Admin import, Super Admin publish | PARTIAL | Merit and rank engine, tie-breaks, cut-offs, preview, PDF | P1 |
| R-11 | Online interview management | — | NOT IMPLEMENTED | Scheduling, panels, scorecards (video needs infrastructure) | P2 |
| R-12 | Live training for selected candidates | — | NOT IMPLEMENTED | Courses, sessions, enrollment, attendance | P3 |
| R-13 | Webinar live meet and certificate management | — | NOT IMPLEMENTED | Webinar schedule, attendance, certificates with verifiable IDs | P3 |
| R-14 | Web address `https://___.eltnoy.com`, one-year validity | — | **BLOCKED (N-04)** | Client decision first; then wildcard DNS and TLS, tenant resolution, reservation records | P1 if approved |
| R-15 | Username availability check (becomes the web address) | — | **BLOCKED (N-04)** | Same as R-14 | P1 if approved |
| R-16 | Subscription: ₹3000 (2 yr), ₹5000 (5 yr), ₹10000 (15 yr) + GST | — | **BLOCKED (N-03)** | Client decision; also see F-3 (prices differ from screenshot S-03) | — |
| R-17 | After payment, logo and website link on the ELTNOY home-page scroller | — | NOT IMPLEMENTED (depends on F-1) | Paid-institute flag, approved logo, public scroller | P3 |
| R-18 | Domain renewal ₹900 after one year | — | **BLOCKED (N-04, N-03)** | — | — |
| R-19 | Form-filling incentive: Job 12%, Scholarship 5%, Admission 5%, Webinar 12% + GST | Wallet ledger | PARTIAL; **PENDING D-22/D-23** | Commission rules, GST handling, statements | P2 |
| R-20 | Interview fee free; webinar ₹1000 per webinar | — | NOT IMPLEMENTED | Fee records once modules exist | P3 |
| R-21 | Institute registration payment by UPI | Manual credit by payment reference (Super Admin) | PARTIAL | Gateway or approved manual UPI verification; never trust a screenshot | P2 |
| S-01 | My Institute: profile, ELTNOY ID, verified/KYC badges, completion, quick stats, active services | Workspace profile, verification state | PARTIAL | Logo, ELTNOY ID display, completion meter, real quick stats | P1 |
| S-02 | Verification documents (8 types, status, view/download) | Institution documents module | COMPLETE (categories differ) | Align categories with the 8 shown types (needs approval: document policy) | P2 |
| S-03 | Subscription and usage; plans Basic ₹2,500/yr, Standard ₹5,000/yr, Pro ₹8,000/yr, Enterprise | — | **BLOCKED (N-03)** | — | — |
| S-04 | Profile change requests (submit, admin review, approve/reject, cancel) | `institute_profile_changes` | PARTIAL | Request list with history, cancel, typed change kinds, logo change | P1 |
| S-05 | Reserve username (3–30 chars, a–z, 0–9, hyphen; pending, reserved, rejected; expiry) | — | **BLOCKED (N-04)** | — | — |
| S-06 | Institute public website (home, admissions, exams, results, training, notices, contact, logins) | — | **BLOCKED (N-04)** | — | — |
| S-07 | Activity log (filters, export, IP address) | Staff audit tables only | BACKEND ONLY (partial) | General audit events (A-11), institute viewer, export | P1 |
| S-08 | Create examination wizard (6 steps; templates; copy from existing) | — (admin only) | NOT IMPLEMENTED for institutes | Policy check: institute-created exams vs A-01…A-20 (F-4) | P1 |
| S-09 | Exam management list (counts, tabs, filters, calendar, workflow) | Admin exam list | PARTIAL | Institute view (F-4) | P1 |
| S-10 | Online applications (create, templates, form builder, fee configuration) | — | NOT IMPLEMENTED | Form builder (R-05) | P1 |
| S-11 | Applicants and verification (bulk verify, document checklist, notify) | Admin applications review | PARTIAL | Institute review (Q117–Q119: Owner and Application Managers with `application.decide`) | P1 |
| S-12 | Payments and fees (paid, pending, refunds, collections) | Wallet ledger | PARTIAL | Applicant fee payments need a payment provider (client approval) | P2 |
| S-13 | Admit cards (generate, template, notify, print/download) | Admin only | PARTIAL | See R-07 and F-4 | P1 |
| S-14/15 | Paper tender / upload to ELTNOY admin (online, offline, syllabus) | — | NOT IMPLEMENTED | Confidential file storage, admin review, version history | P1 |
| S-16/17 | CBT exam centre dashboard and portal | — | NOT IMPLEMENTED | Centre role, registration, seats, check-in, incidents; no fake CCTV or health | P2 |
| S-18 | Result and merit list management | Admin only | PARTIAL | See R-10 | P1 |

## D. Technical issues

| ID | Severity | Issue | Evidence | Recommended action |
|---|---|---|---|---|
| D-1 | **High** (if deployed) | An uncommitted **Institute Workspace** backend is being written by another tool in this checkout. It has `server/instituteWorkspace.ts` (1,439 lines, about 50 routes), `instituteWorkspaceMigration.sql` (25 tables), new UI files (`InstituteZonePage.tsx`) and edits to the surface, grants and wiring tests. It lets the institute owner **publish results** (`PATCH /center/results/:id/status` can go straight to `published`, without a state check or audit) and **release admit cards** directly. That contradicts A-04 and A-06 (Super Admin publishes) and has no maker-checker. Access is owner-only (`requireRoles('center')`), with no Organization Staff permissions. It is not reviewed. | `git status`; `server/instituteWorkspace.ts:1015` | Do not deploy. Reconcile with F-4 and review before committing. User decided on 2026-11-27: "Abhi mat bhejo" (don't send it yet). |
| D-2 | Medium | The P0-3 policy is only partly enforced. A-08, A-10 and A-16 (admit cards) are not built (conflict C-01 in the register). A-11 and A-12 were implemented on 2026-11-27 but are not deployed yet. | `docs/policy/master-policy-register.md` §A code-status note | Next: A-08 and A-16. |
| D-3 | Medium | `AiProctoringModal.tsx` simulates a webcam view. It is not reachable today, but its existence invites a fake-monitoring feature. | `src/components/AiProctoringModal.tsx:203` | Delete it, or mark it clearly as a non-production demo. Needs approval to delete. |
| D-4 | Medium | The single 918 kB JavaScript bundle loads every surface's code on every host. | Vite build output | Split by route and surface. |
| D-5 | Medium | Backups are manual dumps in `/root` on the same VPS. There is no off-host copy or restore drill. | Production runbook; deploy steps | Automate encrypted off-host backups and a periodic restore test. Needs a storage decision (free-only hosting). |
| D-6 | Medium | Student accounts rely on password only while `AUTH_MOBILE_VERIFICATION=off` (owner decision 2026-11-24). No password reset exists. | `server/index.ts` login route | Add an email-based password reset; record the risk in the register. |
| D-7 | Low | Untracked large media, dumps and zip files sit in the repository root (screenshots, `eltnoy_backup.dump` (ignored), `ELTNOY_PHASE1_SECURITY_REVIEW*.zip`). | `ls` | Move them out of the working tree. The dumps are git-ignored but contain data. |
| D-8 | Low | `render.yaml` and `netlify.toml` remain, but both are marked unsupported. | Root | Remove them once the owner agrees. |
| D-9 | Info | The `DashboardShowcase` page (`/demo`) uses synthetic data. It is **not** reachable on live (404 on both public hosts, checked 2026-11-27). | `src/main.tsx` | Keep it off the production path allowlist. |

## E. Test status (actual run, 2026-11-27)

The run used a clean export of commit `1dd6145`, so the other tool's uncommitted files were excluded. `DATABASE_URL` pointed to a closed port; no database was touched.

| Check | Result |
|---|---|
| `npm test` | **1,189 tests: 1,147 passed, 0 failed, 42 skipped** (PostgreSQL-gated suites) |
| `npx tsc --noEmit` | Passed |
| `vite build` | Passed; warning: the 918 kB chunk is above 500 kB |
| PostgreSQL integration suites | **NOT RUN** (need an isolated database) |
| Browser end-to-end | **NOT RUN.** Manual live checks on 2026-11-24 covered Student sign-up, email code, password sign-in, Institute sign-in and dashboard. |
| Working tree with the other tool's changes | `surfaceWiring` router-count test failed on 2026-11-27; it was later edited by that tool. Not re-verified. |

## F. Conflicts that need a client decision before building

These are **not** decided here. Each needs the client's answer, recorded by the owner (or ChatGPT) in `docs/policy/master-policy-register.md`. Register entries are not invented here.

| ID | Report says | Recorded decision | Question for the client |
|---|---|---|---|
| F-1 | Subscription packages (R-16) and plans with usage limits (S-03) | **N-03 "No institution subscriptions"** (IMPLEMENTATION_APPROVED restriction): no plans, recurring billing or feature gating | Does the report replace N-03? If yes, which price list applies (F-3)? |
| F-2 | `{username}.eltnoy.com` web address, availability check, institute mini-website (R-14, R-15, S-05, S-06) | **N-04 "No custom organization domains or separate institution websites"** (IMPLEMENTATION_APPROVED restriction) | Does the report replace N-04? If yes: wildcard DNS and TLS on the VPS, and whether pages are subdomains or `eltnoy.com/i/{name}`. |
| F-3 | Text: ₹3000/2 yr, ₹5000/5 yr, ₹10000/15 yr + GST; ₹900 renewal | Screenshot S-03: Basic ₹2,500/yr, Standard ₹5,000/yr, Pro ₹8,000/yr, Enterprise custom | Which pricing is correct? |
| F-4 | Institutes create exams, generate admit cards, upload papers, process and **publish results** (S-08 to S-18) | Current model: ELTNOY Officials create exams; **Super Admin publishes results and admit cards** (A-04, A-06, A-16). The institute screens say "managed by ELTNOY". | Should institutes publish their own exams, admit cards and results? If yes, with which approval step (ELTNOY review, maker-checker inside the institute)? |
| F-5 | Paper tender: institutes send papers to "ELTNOY Admin" for review | Not covered | Who at ELTNOY reviews papers, and who may read them before the exam? |
| F-6 | Commission 12% or 5% + GST on form fills (R-19); UPI payment (R-21) | D-22/D-23 PENDING_CONFIRMATION; payment providers need client approval | Which payment provider or UPI process (manual verification or gateway)? GST invoicing? |
| F-7 | Live monitoring, CCTV, biometric/face check-in (S-16, S-17) | Not covered; "no fake functionality" rule | What hardware and network will centres have? Is biometric data collection approved (legal consent)? |

## G. What this audit did not do

- It did not open secrets, `.env` files, dumps or production data.
- It did not change the database, Docker, production or Git history.
- It did not run PostgreSQL integration tests or browser end-to-end tests.
- It did not review the other tool's uncommitted Institute Workspace code line by line (D-1).

## H. Phase 1 update: A-11 audit log (2026-11-27)

**Where the work is:** worktree `.claude/worktrees/audit-log`, branch `audit-log`, based on `1dd6145`. It is uncommitted. It was built away from the main checkout so the other tool's uncommitted Institute Workspace files stay untouched.

**Built:**

| Part | Detail |
|---|---|
| Table and migration | `server/auditEventsMigration.sql` (migration file 12) |
| Writer | `server/audit.ts`, with a per-action allow-list |
| Viewer | `server/auditRoutes.ts`, Super Admin only |
| Screen | The "Audit log" tab (`src/components/admin/AuditLogPanel.tsx`) |
| Hooks | 33 actions across `server/index.ts`, `server/authVerificationStore.ts` and `server/institutionDocuments.ts` |

**Test results (actual):**

| Check | Result |
|---|---|
| `npm test` | 1,212 tests: 1,170 passed, **0 failed**, 42 skipped (baseline 1,189 / 1,147 / 0 / 42; 23 tests are new) |
| `tsc --noEmit` | Passed |
| `vite build` | Passed (same chunk-size warning, now 923 kB) |
| `git diff --check` | Clean |
| Disposable PostgreSQL 17 (`scripts/run-disposable-grants-tests.sh`) | 34 of 35 passed |

On the disposable PostgreSQL 17 run, the new real-database audit test passed. It checks that:

- `eltnoy_app` and even `eltnoy_owner` cannot update, delete or truncate audit rows;
- the row hash is set by the database;
- the secret-key and actor CHECKs work.

The one failure, `AUTH C1.8 factors`, **also fails on the unchanged baseline**, so it is unrelated to this work.

**Not done, and why:** see the "A-11 audit log: open items" table in [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md). Each item there is either a client decision (OD-1, OD-3, OD-5, OD-6, OD-7, C-03, C-10) or a follow-up for refused actions.

## I. Merit List Engine foundation (2026-11-27)

The gap analysis is in [MERIT_LIST_GAP_ANALYSIS.md](MERIT_LIST_GAP_ANALYSIS.md). The work is in the same uncommitted worktree `audit-log`.

**Built:**

| Part | Detail |
|---|---|
| Ordering and checks | Marks order with unresolved tie groups, arithmetic validation of imported scorecards, and a flag for imported ranks that contradict the marks |
| Versions | Append-only draft versions, with duplicate prevention by input fingerprint and a check that the save matches the reviewed preview |
| Export and audit | Formula-safe CSV export; audit events for saves and exports |
| Access and screen | Super Admin-only routes and the "Merit lists" tab |

**BLOCKED:** tie-breaks, rank numbering, cut-offs, qualification, category merit, publication, re-evaluation, Institute merit lists and negative marking (ML-1 to ML-9, register section ML).

**Test results (actual):**

| Check | Result |
|---|---|
| `npm test` | 1,236 tests: 1,193 passed, **0 failed**, 43 skipped (the one extra skip is the new real-PostgreSQL merit test) |
| `tsc --noEmit` | Passed |
| `vite build` | Passed (928 kB chunk warning) |
| `git diff --check` | Clean |
| Disposable PostgreSQL 17 | 35 of 36 passed |

On the PostgreSQL run, the new `merit_list_snapshots` and `audit_events` tests passed. The one failure, `AUTH C1.8 factors`, also failed on the unchanged baseline; it was later found to be a stale test and fixed (section J).

**Follow-up AL-4.8 (same day):** refused withdrawal payments are now recorded as `withdrawal.payment_refused` (denied).

| Check | Result |
|---|---|
| Full suite | 1,237 tests: 1,194 passed, **0 failed**, 43 skipped |
| `tsc --noEmit` | Passed |
| `vite build` | Passed |
| Disposable PostgreSQL | 35 of 36 passed (same unrelated baseline failure) |

## J. Backlog review and finance failure events (2026-11-27)

- **Backlog:** see [BACKLOG.md](BACKLOG.md), which classifies every remaining task by priority, approval, dependency, risk and overlap with the Workspace.
- **Corrected finding:** the PostgreSQL failure `AUTH C1.8 factors`, earlier recorded here as an unrelated baseline failure, was a **stale test**. The database protections were stronger than the test expected:
  - the API role has no grant on `confirmed_at`;
  - O-4-A binds enrolment challenges to their user.

  The test now asserts both, and the disposable PostgreSQL 17 run passes **36 of 36**.
- **Built:** the proposal §7 failure events `wallet.credit_failed` and `withdrawal.payment_failed`.

| Check | Result |
|---|---|
| `npm test` | 1,240 tests: 1,197 passed, **0 failed**, 43 skipped |
| `tsc --noEmit` | Passed |
| `vite build` | Passed |
| PostgreSQL | **36 of 36 passed** |
