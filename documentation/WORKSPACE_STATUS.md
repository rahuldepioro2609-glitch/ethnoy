# Institute Workspace: development status

**Updated:** 2026-11-28 (every Workspace write route audited; the last 8 added, not yet committed).

- **Location:** committed on `institute-workspace` (`b7efeda`, on `1dd6145`) and integrated with `audit-log` on the local branch `eltnoy-integration` (merge commits `72e0db9` and `7b14e50`). Nothing is pushed, merged into `vps-deploy`/`main`, or deployed.
- **D-01 Option B:** the Workspace stays held until it is complete and isolated on its own branch. Nothing has been committed, branched, merged, pushed or deployed.

## Final status (2026-11-28)

**Institute-side Workspace: implementation complete for the approved scope; integrated with `audit-log` on `eltnoy-integration`; not deployed.** Every Workspace section has a screen backed by real API routes, or an explicit "not available" notice (CBT centre). Nothing is committed: under D-01 the work stays held until it is moved to its own branch and integrated with `audit-log`.

| Module | State |
|---|---|
| Exam management, applications, admit cards (drafts), results (drafts), attendance, question bank and papers, reports (on screen), interviews (schedule, scorecards, cancel, reschedule), training (records) | **Done**: real APIs, server-side validation, tenant isolation, tests |
| Super Admin review (D-02): exam approve, request changes, publish; results approve (reviewed versions), publish, return; admit cards release, revoke | **Done** |
| CBT centre | **Honest notice only**: no online delivery exists |
| Candidate-visible effect of publication, online CBT, training progress and certificates, payments, report export, paper tender, notifications | **Deferred or awaiting a decision** (below) |
| Audit events for Workspace actions (A-11) | **Done** on `eltnoy-integration` for **every** Institute and Super Admin write route (see "Workspace audit events") |

**Routes reachable through the API that have no screen** (each is either honest, refused, or waiting for a decision; none is used by a screen):
- `GET /api/center/overview`, `GET/POST/PATCH /api/center/branches`: real records;
- `GET /api/center/staff/audit` was **removed at integration** (2026-11-28): it let an Institute read staff audit events, but A-12 keeps audit reads with the Super Admin and C-03 is open. `audit-log`'s policy test caught it; no screen or test used it;
- `GET /api/center/settings`: real integration status and existing tickets;
- `POST /api/center/admit-cards/templates`: stores a template, but nothing renders admit cards from it yet;
- `GET/POST/PATCH /api/center/app-forms`: waits for D-11; "published" has no candidate-visible effect;
- `GET /api/center/payments*`, `POST /api/center/payments/refunds`: always empty (no fee transactions); decisions refused;
- `GET /api/center/reports/saved`, `POST /api/center/reports/saved`: no file is generated (PERM-05);
- `GET /api/center/cbt-sessions`, `POST /api/center/cbt-incidents/:id/review`: always empty;
- refused outright: broadcasts (409), support tickets (409/403), certificates (403), admit-card release by an Institute (403).

## Decisions applied

| Decision | Where |
|---|---|
| **D-02 Option B:** Institutes prepare drafts; the ELTNOY Super Admin reviews and officially publishes. A-04 and A-06 are preserved. | Institute routes (`server/instituteWorkspace.ts`) refuse approval and publication (403 `PUBLICATION_REQUIRES_SUPER_ADMIN`). Super Admin routes are in `server/instituteWorkspaceAdmin.ts`. |

## Done

| Area | Status | Evidence |
|---|---|---|
| Attendance regression (P0-1) | Fixed. The real server check-in time is shown again. | `src/utils/instituteDashboard.test.ts` |
| Sample and fake data (P0-2, P0-3) | Removed. The mock screen was replaced by the real-data version. The mock is backed up **outside the repository** at `../eltnoy-workspace-backup-2026-11-27/`. | Regression test: no section renders sample data |
| D-02 on Institute routes (P0-4) | No exam approval, review or publication; no result approval or publication; no admit-card release or revocation; approved or published results can't be overwritten. Exam status changes are compare-and-set. | `server/instituteWorkspace.test.ts` |
| Tenant isolation (P0-5) | 8 routes now check that referenced exams, forms and courses belong to the session's Institute (9 references in total). Routes that take an ID in the URL were already scoped. | Same test file (strict, 404 with nothing written) |
| Exam Management, Results, Admit Cards screens | Connected to the real API, with loading, error and success states | `src/components/workspace/*`; checked in a stubbed preview |
| Admit-card generation | Transactional with a per-exam lock. Only inserted rows are counted. Seats continue from the existing count. A unique (exam, application) index prevents duplicates. | Test, migration |
| Super Admin review routes (D-02) | Review queue; exam approve, request changes, publish; results view, approve, publish, return; admit cards release, revoke. All compare-and-set, Super Admin only, Admin host only. | `server/instituteWorkspaceAdmin.test.ts`, route matrix |
| PostgreSQL grants test (P1-7) | Done. `server/databaseGrants.postgres.integration.test.ts` lists the 25 Workspace tables explicitly, so the catalog test checks every grant against the manifest. Three real-database Workspace tests check:<br>- a second admit card for the same application is refused;<br>- attendance marks can't be updated or deleted;<br>- `institute_settings` doesn't exist;<br>- the 5 Super Admin columns are granted;<br>- results can't be deleted;<br>- one Training enrolment per learner per course, including 8 concurrent requests;<br>- interview cancel and reschedule through the real routes as `eltnoy_app` (see Interviews). | Disposable PostgreSQL 17: 36 of 37 passed. The 1 failure is the stale `AUTH C1.8 factors` test, already fixed on `audit-log` and not duplicated here. |
| Attendance marking | Connected, below the existing exam-day check-in register (unchanged). Institutes mark attendance for their own exams; every mark is a permanent new record with a required reason. The current status is the latest mark, and the history shows all of them. **Manual only:** the server now refuses `qr_scan` and `import` from a browser, because no scanner or import exists (that would be false provenance). | `server/instituteWorkspace.test.ts`; checked in a stubbed preview |
| Settings cleanup (P1-9) | Done. The `institute_settings` table, `PUT /api/center/settings` and its route policy entry are removed. All six stored settings changed nothing in the system (staff MFA, candidate alerts, payment webhook verification, bulk export restriction, academic year), and audit retention contradicted A-13. `GET /api/center/settings` now returns only the real integration status (from the provider configuration) and any existing support tickets (creating tickets is refused, see review fixes). No screen used these settings. | `server/instituteWorkspace.test.ts` (settings test) |
| Applications section | Connected: list with status filter and counts, recording a received application, review (verify, request correction, flag, reject; a reason is required to refuse), and review history. Fee is **unpaid** or **waived** only; the server refuses `paid` from an Institute because no payment is verified (F-6 deferred). The existing public listings block is kept. | `server/instituteWorkspace.test.ts`; checked in a stubbed preview |
| Question Bank | Connected. The Institute writes questions (single choice, multiple choice, true or false, descriptive), sends them for review, approves or rejects them, and builds papers from approved questions only; a paper can be locked (permanent).<br>Server hardening:<br>- unknown fields are refused;<br>- the answer key must fit the question type (2–10 options, the answer names real options; true/false answers only; no options on descriptive);<br>- negative marks can't exceed marks;<br>- moderation follows a state machine (draft → in review → approved or rejected; anything not archived → archived; nothing leaves archived), compare-and-set, 409 `INVALID_TRANSITION` / `QUESTION_CHANGED`;<br>- a question can appear once per paper; ids are validated.<br>The shape rule is shared by the form and the server (`src/utils/workspaceQuestions.ts`). Archiving and locking ask for confirmation. **Not included:** sending papers to ELTNOY (paper tender, S-14/S-15), which waits for F-5. | `server/instituteWorkspace.test.ts` (4 tests); checked in a stubbed preview |
| CBT centre (server only) | **No screen added, deliberately.** Nothing writes CBT sessions or incidents: there is no online delivery of Institute exams (candidate attempt, heartbeat, incident reporting), so a monitoring screen would always be empty. The section keeps the real check-in link and its "not connected" notice. The two existing routes were hardened:<br>- the made-up `deliveryHealth.apiLatencyMs` (the database read time) is removed;<br>- the incident list joins sessions of the same Institute only;<br>- an incident is reviewed **once, from open**, so a later review can't overwrite the decision and its reason; unknown fields and bad ids are refused. | `server/instituteWorkspace.test.ts` (2 tests) |
| Reports | Connected: a "Workspace records" panel below the existing listings and check-in figures shows applications, examinations, attendance marks and results, with counts by status. At most 200 rows; when there are more, the server says so (`truncated`) and the screen warns that the counts are incomplete.<br>Server: the queries are a fixed exported list, each scoped to the session Institute, and joined exams must belong to the same Institute; unknown fields are refused. The **fees** dataset is removed (nothing records fee transactions; F-6). **No export or download:** A-07 keeps full exports with the Super Admin and PERM-05 (may Institutes export applicant data?) is open, so the saved-report routes (which store an output format) have no screen. | `server/instituteWorkspace.test.ts` (2 tests); checked in a stubbed preview |
| Interviews (R-11: scheduling, scorecards, cancel and reschedule) | Connected: schedule an interview (candidate, optional application number, panel, panelists, date, IST times, video or in person), lists for today/upcoming and past, and panelist scorecards (four scores out of 10, remarks, average).<br>Server fixes:<br>- the made-up `meeting_ref` (e.g. `INT-2026-AB12C`) is no longer generated, and `consentRecorded` is no longer accepted: ELTNOY hosts no video and records nothing (BACKLOG: "never fake it");<br>- the overlap check and insert run in one transaction under a per-panel, per-day lock, so two bookings sent together can't double-book; panel names match case-insensitively (409 `PANEL_CONFLICT`);<br>- times must be real 24-hour times; no past dates (Indian calendar);<br>- dates are returned as `YYYY-MM-DD`, not as timestamps that could shift a day;<br>- a scorecard needs this Institute's interview, on or after its date, not cancelled, and one per panelist (409 `INTERVIEW_NOT_HELD` / `INTERVIEW_CANCELLED` / `SCORECARD_EXISTS`);<br>- unknown fields and bad ids are refused.<br>**Cancel and reschedule (client-approved, 2026-11-28):** `POST /api/center/interviews/:id/cancel` and `/:id/reschedule`, Institute only, own interviews only (404 otherwise).<br>- a reason of 5–500 characters is required for both;<br>- only an interview that is `scheduled` and has **no scorecard** can change; a scored (held) or `completed` one answers 409 `INTERVIEW_HELD`, a cancelled one 409 `INTERVIEW_CANCELLED` (rebook instead);<br>- reschedule validates date (not past, real calendar date), 24-hour times, end after start, panel, and an optional `timezone` (must be a real zone; only `Asia/Kolkata` is supported); an unchanged slot answers 409 `NO_CHANGE`;<br>- conflicts now cover the same panel **or any shared panelist** (names compared case-insensitively), for new bookings and moves; the interview being moved is excluded; cancelled interviews never block, so their slots are free again (409 `PANEL_CONFLICT` names the panelist or panel);<br>- concurrency: one advisory lock per Institute and day for every booking or move into that day, plus the interview's own lock (shared with scorecards), and the row is read `FOR UPDATE`;<br>- history: every change writes `institute_interview_changes` (action, reason, earlier details, new details, actor) in the same transaction; the API role can only read and add rows, so history can't be rewritten or deleted;<br>- the screen offers Reschedule and Cancel on scheduled, unscored interviews, each with a reason and a confirmation step, shows the server's answer, labels scored interviews "Held", and lists each interview's history. | `server/instituteWorkspace.test.ts` (7 interview tests); disposable PostgreSQL (real routes, 7 concurrent claims on one panelist's slot → 1 wins); stubbed preview |
| Training (R-12) | Connected as **records only**: add courses (title, category, number of modules), enrol learners (name, optional email), schedule sessions (optional course, date, IST time), with today/upcoming and past lists.<br>Removed because they did nothing or faked something:<br>- `status`/`visibility: published` (there is no learner-facing page);<br>- `completedModules` (typed once at enrolment, never updatable, no upper limit);<br>- **certificates**: `POST /api/center/training/enrollments/:id/certificate` now always answers 403 `CERTIFICATES_NOT_AVAILABLE`, because R-13 requires verifiable certificate IDs and nothing can verify the `CERT-…` codes.<br>Also: unknown fields refused; real 24-hour session times; no past session dates; dates returned as `YYYY-MM-DD`; emails stored lower-case. The generic "unavailable" card in `InstituteAdvancedSection.tsx` is removed: every section now has its own screen. | `server/instituteWorkspace.test.ts` (2 tests); checked in a stubbed preview; disposable PostgreSQL |
| Super Admin review screen | New "Institute reviews" tab (Super Admin only), backed by `src/components/admin/InstituteWorkspaceReviewPanel.tsx`. Publishing and releasing ask for confirmation with exact counts; requesting changes needs a reason; it shows the server's answer. | `adminPermissions.test.ts`; checked in a stubbed preview |

## Review fixes (2026-11-28)

| Finding | Fix | Evidence |
|---|---|---|
| Results approved or published and admit cards released for exams ELTNOY never approved, or that were cancelled or archived | Approve, publish and release need the exam in `approved`, `published`, `registration_open` or `closed` (`OFFICIAL_EXAM_STATES`, shared by screen and server), checked before and again inside the same `UPDATE` (409 `EXAM_NOT_APPROVED`). Revoke and return work in any state. Institutes can't generate cards or write results for cancelled or archived exams (409 `EXAM_CLOSED`). | Admin and Workspace tests |
| Bulk approval could approve results changed after review | Approval now takes the results the Super Admin opened, with their versions, all or nothing in one transaction (409 `RESULTS_CHANGED`, nothing approved). The screen approves from the opened list ("Approve the N shown") and, on a change, reloads the list to review again. | Admin tests; stubbed preview of the change and re-approval |
| A rejected application kept a releasable admit card | Release takes only drafts of still-verified applications; the queue shows held drafts. A review is a compare-and-set on the status read (`FOR UPDATE`), refuses a no-op, refuses un-verifying an application whose card ELTNOY already released (409 `ADMIT_CARD_RELEASED`), and refuses unknown fields. | Workspace and admin tests |
| Broadcasts stored as "recorded" though nothing sends them | `POST /api/center/exams/:id/broadcasts` refuses (409 `BROADCASTS_NOT_AVAILABLE`): no candidate notice page, email or SMS exists for Institute exams. | Workspace test |
| Support tickets nobody at ELTNOY reads; Institutes resolved their own | Creating is refused (409 `SUPPORT_TICKETS_NOT_AVAILABLE`); status changes are refused (403). Grant row: UPDATE removed. | Workspace test; disposable PostgreSQL |
| A corrected candidate name was dropped while reporting success | The correction saves the name (grant row: `candidate_name` added) and answers 200 with `corrected: true`; a new result answers 201. The screen says a correction is a draft again. | Workspace test |
| Also fixed | The admit-card queue keeps exams that only have released cards, so revoke stays reachable. The review screen ignores a slow results answer for another exam. | Admin tests; preview |
| Refund decisions | An Institute may only withdraw its own refund request; approving or marking it processed is refused (403 `REFUND_DECISION_NOT_AVAILABLE`), because no payment system returns money and nobody independent approves (F-6). | Workspace test |
| Exam time and time zone | The start time must be a real 24-hour time (admit cards copy it) and the time zone a real IANA zone. | Workspace test |
| Duplicate Training enrolment (backlog verification) | Was not prevented at all. Now two partial unique indexes allow one enrolment per learner per course: by lower-cased email when given, otherwise by trimmed, lower-cased name. The insert is `ON CONFLICT DO NOTHING`, so concurrent requests are decided by the database; a duplicate answers 409 `ENROLLMENT_EXISTS`. Two people with the same name need an email. | Workspace test; disposable PostgreSQL (8 concurrent requests → 1 row) |

## Not done yet

| Item | Note |
|---|---|
| Candidate access to published Institute results and admit cards | There is no candidate route for Workspace results or admit cards. Publishing currently has no candidate-visible effect. This needs a product decision on where candidates see them. |
| Sections still on the honest "not available" view | CBT centre only (see below) |
| Training: progress, attendance, certificates, live sessions | R-12 lists attendance and R-13 verifiable certificates; neither exists. Progress needs an update route (and grant). Live sessions need video infrastructure ("never fake it"). |
| Interviews: limitations | No route marks an interview `completed`; "held" is inferred from a scorecard. A past interview without a scorecard (e.g. a no-show) can still be cancelled or moved to a future date. Times are India time only. Panelists are free-text names (no panelist accounts), so two spellings of one person are not matched. Scorecards are typed in by the Institute account on the panelist's behalf. The application number is a free-text reference, not checked against applications. No notification is sent to candidates or panelists on a change (none exists for Institute interviews). |
| Report export | PERM-05 is open; A-07 keeps full exports with the Super Admin. `GET/POST /api/center/reports/saved` exist but have no screen, and nothing generates a file from them. |
| Support tickets | Creating and status changes are refused: no ELTNOY queue reads `institute_support_tickets`. The existing helpdesk (`POST /api/feedback`) already accepts Institute accounts and is read by the Super Admin (A-14). Needs a decision: use that channel, or build a Workspace ticket queue. |
| Payments routes (`/api/center/payments*`) | No screen, and nothing records fee transactions, so they only ever return empty lists. Refund approval and processing are refused until payments (F-6) exist; an Institute can only withdraw its own request. |
| Online CBT delivery for Institute exams | Needs a product decision: whether candidates take Institute exams online on ELTNOY, how they reach them (the same open question as candidate access to results and admit cards), and which proctoring data may be recorded. Until then the CBT tables stay empty. |
| Paper tender (S-14/S-15) | Sending papers to ELTNOY for review and upload. Blocked by F-5 (who at ELTNOY reviews papers and who may read them before the exam). The screen says it isn't available yet. |
| Question Bank: single account | The same Institute account writes and approves its questions; there is no separate reviewer role (staff roles wait for Q117–Q119). A rejection has no stored reason because the table has no column for one. |
| Custom application form builder (`/api/center/app-forms`) | No screen. It waits for decision D-11 (form-builder data model), and no candidate page uses these forms yet. |
| `InstituteZonePage.tsx` | **Resolved 2026-11-28 (integration step 1):** moved out of the repository. It was unused, never committed, made no API calls and promised unapproved fees (₹150–₹250 per slot, ₹180/candidate, wallet credit in 72 hours). A byte-identical copy is in `../eltnoy-workspace-backup-2026-11-27/`. |
| `.claude/launch.json` | Created on 2026-11-27 by another process. Not part of the Workspace. Now ignored locally (`.git/info/exclude`, never committed) next to `.claude/worktrees/`, so it can't be staged by mistake. |

## Audit integration points (P1-8)

The audit trail (A-11) is on branch `audit-log`. It is **not** copied here. At integration, each of these actions must write an audit event **in the same transaction**: move the single statement into a transaction and call `recordAuditEvent`.

**Super Admin (`server/instituteWorkspaceAdmin.ts`, `WORKSPACE_AUDIT_POINTS`):**

| Event | Written by |
|---|---|
| `workspace_exam.approved`, `workspace_exam.changes_requested`, `workspace_exam.published` | `POST /api/admin/institute-workspace/exams/:id/decision` |
| `workspace_results.approved`, `workspace_results.published`, `workspace_results.returned` | `POST /api/admin/institute-workspace/exams/:id/results/decision` |
| `workspace_admit_cards.released`, `workspace_admit_cards.revoked` | `POST /api/admin/institute-workspace/exams/:id/admit-cards/decision` |

**Institute (`server/instituteWorkspace.ts`):**

| Area | Actions that need an event |
|---|---|
| Exams | Created; status changed (submitted, back to draft, cancelled, archived) |
| Results | Written or corrected; marked ready for review |
| Admit cards | Draft cards generated (with count) |
| Applications | Created; reviewed (verify, request correction, flag, reject) |
| Refunds | Requested; withdrawn |
| Questions | Created; moderated (sent for review, approved, rejected, archived) |
| Paper blueprints | Locked |
| CBT | Incident reviewed |
| Attendance | Marked |
| Interviews | Scheduled; cancelled (with reason); rescheduled (with reason, old and new slot); scorecard submitted |
| Training | Course created; learner enrolled; session scheduled (and certificate issued, once certificates exist) |
| Branches | Created; updated |

## Overlapping files (shared with `audit-log`) changed in this work

| File | Change | Reason |
|---|---|---|
| `server/index.ts` | Import and mount `createInstituteWorkspaceRouter()` and `createInstituteWorkspaceAdminRouter()` | The Workspace routes and the Super Admin routes (D-02) |
| `server/surface.ts` | The Workspace route policy: 52 `institution(...)` entries (2 for interview cancel and reschedule) and 5 `superAdmin(...)` entries | Every mounted route needs a policy entry |
| `server/databaseGrantsMigration.sql` | Workspace rows only: the `institute_settings` row is removed (table removed). 5 approval and publication columns kept, now commented as assigned only by the Super Admin routes. `institute_training_enrollments` loses its UPDATE on `certificate_code`, `issued_at` (certificates refused). `institute_exam_results` gains UPDATE on `candidate_name` (name corrections); `institute_support_tickets` loses its UPDATE (tickets refused). `institute_interviews` gains UPDATE on `status`, `scheduled_date`, `start_time`, `end_time`, `panel_name`, `panelist_names`, `updated_at` (cancel, reschedule); new row `institute_interview_changes` SELECT, INSERT only (append-only history). | Least privilege |
| `server/adminAuthorization.test.ts` | 5 matrix entries | The route registry test requires every admin route |
| `server/surfaceWiring.test.ts` | Router count 9 → 11 | Two mounted routers (Workspace and Super Admin review) |
| `server/databaseGrants.test.ts` | Table count 77 | The 25 Workspace tables |
| `server/migrate.ts`, `server/migrate.test.ts` | `instituteWorkspaceMigration.sql` runs just before `databaseGrantsMigration.sql` | Grants must run last |
| `server/databaseGrants.postgres.integration.test.ts` | `WORKSPACE_TABLES` list (25), manifest expectation, three Workspace tests | P1-7. At integration, keep both the `audit-log` additions (`AUDIT_TABLE`, `MERIT_TABLE`, audit, merit and MFA tests) and these. |
| `src/components/RolePortal.tsx` | One tab (`institute-reviews`) added to the type, the list and the render | Super Admin review screen |
| `src/utils/adminPermissions.ts`, `.test.ts` | `institute-reviews` is Super Admin only | Same |

### Integration readiness with `audit-log` (checked 2026-11-28, read-only)

- **Branches:** `vps-deploy` = `1dd6145` (the base of this uncommitted work); `audit-log` = `fd5df7f`, one commit on top of `1dd6145`. Merge base `1dd6145`, so both sides start from the same commit.
- **Shared files (both sides change them):** `server/index.ts`, `server/surface.ts`, `server/databaseGrantsMigration.sql`, `server/databaseGrants.test.ts`, `server/databaseGrants.postgres.integration.test.ts`, `server/migrate.ts`, `server/migrate.test.ts`, `server/surfaceWiring.test.ts`, `server/adminAuthorization.test.ts`, `src/components/RolePortal.tsx`, `src/utils/adminPermissions.ts`, `src/utils/adminPermissions.test.ts`, and `documentation/*.md`. `server/instituteWorkspaceMigration.sql` exists only here.
- **No name clashes:** `audit-log` adds the tables `audit_events` and `merit_list_snapshots`, the routes `/api/admin/audit-events` and `/api/admin/merit-lists/*`, and the tabs `audit-log`, `merit-lists`. None overlaps a Workspace table (25 `institute_*` tables, including `institute_interview_changes`), route or tab.

| File | Expected conflict | Resolution |
|---|---|---|
| `server/migrate.ts` | Both insert migrations before `databaseGrantsMigration.sql` | Order: … `studentEmailOtpMigration.sql`, `auditEventsMigration.sql`, `meritListMigration.sql`, `instituteWorkspaceMigration.sql`, `databaseGrantsMigration.sql` (grants last) |
| `server/migrate.test.ts` | Both change the same adjacency assertion | Keep `studentEmailOtp → auditEvents` (audit-log) and `instituteWorkspace → databaseGrants` (here), and add `meritList → instituteWorkspace`; the file list gets all three new files |
| `server/databaseGrants.test.ts` | Same line: 54 (audit-log) vs 77 (here) | **79** = 52 base + 2 audit-log + 25 Workspace |
| `server/databaseGrants.postgres.integration.test.ts` | Same manifest assertion line; both add constants and tests | `[...base, AUDIT_TABLE, MERIT_TABLE, ...WORKSPACE_TABLES]`, message "… + audit_events + merit_list_snapshots + 25 Institute Workspace tables"; keep all tests from both sides. Audit-log's version also fixes the stale `AUTH C1.8` MFA test that fails here. |
| `server/databaseGrantsMigration.sql` | Rows added in different places | Keep both blocks; no table appears twice |
| `server/surfaceWiring.test.ts` | Same line: 11 vs 11 (git merged it silently as 11) | **13** mounted routers (base 9 + 2 + 2) — confirmed on `eltnoy-integration` |
| `server/surface.ts`, `server/index.ts` | Adjacent additions (imports, mounts, policy entries); `audit-log` also wraps existing routes in audited transactions | Keep both; no Workspace route is in `audit-log` |
| `server/adminAuthorization.test.ts` | Both add admin route entries; `audit-log` adds audit capture to the test harness | Keep both |
| `src/components/RolePortal.tsx`, `src/utils/adminPermissions.ts`, `.test.ts` | Same tab type, list and hidden-tab assertion | Union: `audit-log`, `merit-lists`, `institute-reviews`; hidden list keeps all |
| `documentation/*.md` | **Resolved in step 2** (copies moved aside; `audit-log`'s versions will be used). Were untracked here, committed on `audit-log`. `BACKLOG`, `IMPLEMENTATION_TRACKER`, `INTEGRATION_READINESS`, `MERIT_LIST_GAP_ANALYSIS` are identical; `audit-log`'s `CLIENT_DECISIONS.md` is **newer** (records D-01/D-02); `PROJECT_AUDIT.md` differs by a trailing blank line | Keep the `audit-log` versions. The untracked copies here block a checkout or merge of `audit-log` ("untracked working tree files would be overwritten"), so they must be moved aside first. `WORKSPACE_STATUS.md` exists only here: keep it. |

**Safe integration sequence (not performed; needs approval at each step):**
1. ~~Decide on `InstituteZonePage.tsx` and keep `.claude/` out of every commit.~~ **Done 2026-11-28:** the page was moved to the backup folder; `.claude/launch.json` is ignored locally.
2. ~~Move the 6 untracked `documentation/*.md` copies out of the checkout.~~ **Done 2026-11-28:** re-checked first: 4 were identical to `audit-log`; the working copy of `CLIENT_DECISIONS.md` only had the superseded undecided F-4 line, and `PROJECT_AUDIT.md` only a trailing blank line. Each was copied to `../eltnoy-workspace-backup-2026-11-27/documentation-untracked-2026-11-28/`, verified byte for byte, then removed. No untracked path in the checkout now exists on `audit-log`, and the untracked files are exactly the 19 Workspace files plus this document. `npm test` afterwards: 1,252 tests, 0 failed.
3. ~~Create `institute-workspace`~~ **Done:** `b7efeda`, 33 files, explicit staging, full checks passed.
4. ~~Integration branch~~ **Done:** `eltnoy-integration` (`72e0db9`, `7b14e50`); see "Integration result".
5. ~~Full checks on the integration branch~~ **Done:** 79 tables, 13 routers, `AUTH C1.8` passes, PostgreSQL 39/39.
6. Wire the Workspace audit events (section above) into `audit-log`'s `runAuditedTransaction`/`recordAuditEvent`, with tests, before any deployment.
7. Only then: review, PR into `vps-deploy`, and a deployment per the runbook.

**Risk: moderate.** The conflicts are mechanical and well understood (counts, ordering, lists), and there are no schema, route or tab name clashes. The real work is step 6: the Workspace writes no audit events today.

### Integration result (step 4, 2026-11-28)

| Step | Commit | Result |
|---|---|---|
| Branch `eltnoy-integration` from `vps-deploy` | `1dd6145` | |
| Merge `audit-log` (`--no-ff`) | `72e0db9` | No conflicts (tree identical to `audit-log`). `npm test` 1,240 / 0 failed; PostgreSQL 36/36 (the `AUTH C1.8` MFA test passes with `audit-log`'s fix); tsc, build pass. |
| Merge `institute-workspace` (`--no-ff`) | `7b14e50` | 11 files conflicted, all expected; resolved by combining both sides (table above). One **policy conflict** surfaced: `audit-log`'s A-12 test refused the Workspace route `GET /api/center/staff/audit` (Institute read of staff audit events). With approval it was **removed** (no screen or test used it; C-03 open). |
| Final checks | | `npm test` 1,303 tests: 1,257 passed, **0 failed**, 46 skipped; focused Workspace + Super Admin + audit + merit tests 90/90; PostgreSQL **39/39** (79-table catalog, MFA, `audit_events`, `merit_list_snapshots`, 3 Workspace tests); tsc, build, `git diff --check` pass. |

Verified on the merged branch: the audit, merit-list, Workspace and Workspace review routers are mounted (13 router layers in total); migrations end `studentEmailOtp → auditEvents → meritList → instituteWorkspace → databaseGrants`; 79 tables in the manifest, the unit test and the PostgreSQL catalog; `institute_interview_changes` and `audit_events` are SELECT, INSERT only; every `AUTH C1.8` test is byte-identical to `audit-log`'s; `documentation/` now holds `audit-log`'s versions (including the D-01/D-02 record) plus this file.

### Workspace audit events (implemented 2026-11-28, as proposed)

Built on `audit-log`'s writer (`server/audit.ts`): each action gets an `AUDIT_CONTRACTS` entry (category, resource type, retention, allow-listed metadata); each write moves into `runAuditedTransaction(pool, …)` and calls `recordAuditEvent(client, …)` with `auditActor(request)`, `organizationId` = the Institute and `resourceId` = the record id, so the event commits or rolls back with the action. Metadata carries codes, counts, statuses and reasons only: never names, contact details, named scores or question content (the writer also refuses keys such as `answer`, `email`, `mobile`).

| Action | Category / retention | Metadata (allow-list) |
|---|---|---|
| `workspace_exam.created`, `workspace_exam.status_changed` | exam / governance | `exam_code`, `previous_status`, `new_status`, `reason_text` |
| `workspace_exam.approved`, `.changes_requested`, `.published` (Super Admin) | publishing / governance | `exam_code`, `reason_text` |
| `workspace_results.written`, `.marked_ready` | exam / governance | `exam_code`, `roll_number`, `version`, `corrected` |
| `workspace_results.approved`, `.published`, `.returned` (Super Admin) | publishing / governance | `exam_code`, `row_count` |
| `workspace_admit_cards.generated` | exam / governance | `exam_code`, `row_count` |
| `workspace_admit_cards.released`, `.revoked` (Super Admin) | publishing / governance | `exam_code`, `row_count` |
| `workspace_application.created`, `.reviewed` | application, review / governance | `application_number`, `previous_status`, `new_status`, `reason_text` |
| `workspace_question.created`, `.moderated`; `workspace_paper.locked` | exam / governance | `previous_status`, `new_status`, `question_count`, `total_marks` |
| `workspace_attendance.marked` | exam / governance | `exam_code`, `status`, `reason_text` |
| `workspace_interview.scheduled`, `.cancelled`, `.rescheduled`; `workspace_scorecard.submitted` | review / governance | `scheduled_date`, `previous_date`, `new_date`, `reason_text` |
| `workspace_training.course_created`, `.learner_enrolled`, `.session_scheduled` | operations / operational | `module_count`, `session_date` |
| `workspace_cbt_incident.reviewed`; `workspace_refund.withdrawn` | review / governance; finance / financial | `review_status`, `reason_text` |
| Refusals worth recording (D-02 403s, `EXAM_NOT_APPROVED`, `RESULTS_CHANGED`) | as above, outcome `denied` | `reason_code`, via `recordRefusedAuditEvent` |

**Implementation:**
- 39 contracts added to `AUDIT_CONTRACTS` in `server/audit.ts` (prefix `workspace_`); `audit-log`'s registry tests check every one (name format, category and retention against the database CHECKs, no secret-looking keys).
- Super Admin (`server/instituteWorkspaceAdmin.ts`): exam decisions, result decisions and admit-card decisions each record their event in the decision's transaction, only when something changed; `EXAM_NOT_APPROVED` and `RESULTS_CHANGED` are recorded as `denied` through `recordRefusedAuditEvent` (own transaction; never changes the response).
- Institute (`server/instituteWorkspace.ts`): single-statement writes run through `auditedQuery` (one transaction, event only when a row was written); routes already in a transaction call `auditWorkspace`. D-02 refusals (exam approval or publication, result approval or publication, admit-card release) are recorded as `workspace_publication.refused`, `denied`, reason `publication_requires_super_admin`.
- Metadata keeps codes, counts, statuses, dates and reasons only: never candidate, learner or panelist names, contact details, scores or question content. Integer fields are included only when they really are integers.
- Training uses the `operational` retention class; refunds use `financial`; everything else `governance`.
- **Added afterwards (2026-11-28):** the 8 write routes outside the first table: `workspace_branch.created`/`.updated` (branch code and changed field names; never the coordinator's name or email), `workspace_app_form.created`/`.status_changed` (version, status, field count; never the form content), `workspace_admit_card_template.created` (photo and QR flags only), `workspace_paper.created` (question count, duration), `workspace_report.saved` (dataset, format), `workspace_refund.requested` (amount in paise, from the validated request; financial retention).
- **Coverage guard:** a test lists every Institute write route as audited or refused, so a new write route fails the suite until it is classified.

**Tests:** `server/instituteWorkspaceAdmin.test.ts` (every decision's event, no event when nothing changed, `EXAM_NOT_APPROVED` and `RESULTS_CHANGED` recorded as denied, a failing audit insert rolls the decision back); `server/instituteWorkspace.test.ts` (20 Institute actions write exactly one event for the Institute with the expected metadata and no names or contacts; D-02 refusals recorded as denied; nothing recorded when nothing changed; a failing audit insert rolls an attendance mark back; interview, scorecard and application-review events); disposable PostgreSQL (the real interview routes write `audit_events` rows as `eltnoy_app` for the Institute, with no names; the other Institute's refused attempts record nothing).

## Tests (2026-11-28, main checkout, dummy `DATABASE_URL`)

| Check | Result |
|---|---|
| `npm test` | 1,252 tests: 1,208 passed, **0 failed**, 44 skipped (the PostgreSQL tests are skipped outside the disposable runner) |
| Workspace route tests | 44 passed |
| Super Admin review route tests | 10 passed |
| `tsc --noEmit` | Passed |
| `vite build` | Passed |
| `git diff --check` | Clean |
| Disposable PostgreSQL | Final run: 37 tests, 36 passed, 1 failed: `AUTH C1.8` (an MFA grant probe on `admin_mfa_factors`; not a Workspace table, its manifest row is unchanged here, and `audit-log` carries the fix). All 3 Workspace PostgreSQL tests pass. |
| Grants, surface, admin matrix and migration unit tests | 145 passed |

## Client decisions still required

| Decision | Why it matters |
|---|---|
| Candidate access to published Institute results and admit cards | Publishing (D-02) has no candidate-visible effect until candidates can see the records; the existing candidate lookups read only ELTNOY's own tables. |
| Online CBT delivery | Whether candidates sit Institute exams on ELTNOY, how they reach them, and which proctoring data may be kept. |
| Training progress and certificates (R-12, R-13) | How progress and session attendance are recorded; how certificate IDs are verified. |
| Payments (F-6) | Provider or UPI process, GST on commission; until then fees are unpaid or waived and refunds can only be withdrawn. |
| Interview notifications | No email, SMS or portal notice exists for Institute interviews; changes are not communicated by the system. |
| Interview completion / no-show | No status marks an interview completed or missed; "held" is inferred from a scorecard. |
| Panelist identity | Panelists are free-text names; matching spellings is all the system can do without panelist records. |
| Report export (PERM-05), paper tender (F-5), staff roles (Q117–Q119), form builder (D-11), support channel (existing helpdesk vs Workspace tickets) | As in "Not done yet". |

## Remaining deployment steps (none performed)

1. Integration as above, including the Workspace audit events (A-11).
2. Security review of the integrated branch (route policy, grants, Institute host only for `institution(...)` routes, Admin host only for the Super Admin routes).
3. Production backup, then `migrate` per the runbook: `instituteWorkspaceMigration.sql` (25 tables, all new, so the unique indexes cannot meet existing duplicates) and the grants migration.
4. Deploy, then smoke-check one synthetic Institute flow and one Super Admin review on the live hosts.
