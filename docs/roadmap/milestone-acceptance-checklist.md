# ELTNOY milestone acceptance checklist

**Status:** Template for review. Each milestone is accepted only when every item is checked **with evidence** (a test name, a report path or a reviewer note). Anything unproven is marked **NOT PROVEN**, never assumed. Last updated 2026-11-03.

## Every milestone (gate items)

- [ ] Explicit approval to start was recorded (S-10).
- [ ] P0-4 checksum manifest verified at the start and the end, until P0-4 is committed.
- [ ] No connection to `eltnoy` or `eltnoy_dev`; port 5432 not used (S-02).
- [ ] Existing containers and volumes unchanged: identity before and after recorded (S-03).
- [ ] Nothing staged or committed without approval (S-04).
- [ ] No secrets or personal data in logs, reports or test output (S-05, E-07).
- [ ] Synthetic data only (S-06); no third-party service called (S-07). For browser tests, external requests are blocked and counted.
- [ ] Full test suite passes; lint, typecheck and build pass; the count of skipped tests is explained.
- [ ] Changed-file list reported. New screens or changes to existing screens listed for review (P-08).
- [ ] Policy register updated. New decisions recorded with their status; no decision invented (S-11).

## M1: Policy and architecture freeze
- [ ] Q1–Q114 and Q115–Q125 merged, or explicitly deferred (M-01, M-02).
- [ ] Revised P0-3 plan finally approved (M-03).
- [ ] D-04, D-06, D-07, D-08, D-10, D-16, D-32 decided or deferred.
- [ ] Recommendations for C-02, C-03, C-04, C-16 accepted or replaced.
- [ ] P0-4 committed, and the commit matches the 21-file manifest (C-17).
- [ ] Test-environment cleanup approved and verified (R-14).

## M2: Database design and isolated validation
- [ ] Migration runs twice on disposable PostgreSQL 17 without error.
- [ ] Existing table definitions byte-identical before and after, except the approved X items.
- [ ] Cross-organization foreign-key rejection proven for every composite key.
- [ ] Append-only triggers reject UPDATE, DELETE and TRUNCATE on every history table.
- [ ] Seed rows correct; the provider table is empty.
- [ ] With the flag off, the legacy flows (applications, P0-4, institution onboarding) pass their suites.
- [ ] Disposable resources removed by exact name; removal verified.

## M3: Authentication, organizations and P0-3
- [ ] Route matrix (unauthenticated, wrong role, Official, Super Admin) green for every `/api/admin/*` route (A-19).
- [ ] A-02 to A-17 enforced on the backend. Ordinary Officials get 403 where section A requires it.
- [ ] A-01 and A-18 regression: Officials still approve institutions and create exams.
- [ ] Maker-checker: the approver can't mark paid, including legacy rows (A-03).
- [ ] An audit failure rolls back the action (A-11). The audit is readable by Super Admin only (A-12).
- [ ] Email and phone hidden from ordinary Officials (A-08).
- [ ] Controlled deployment note for the admit-card draft change (A-20).

## M4: Opportunity management and publishing
- [ ] Every review transition tested; a reason required where specified.
- [ ] Unpublished, unapproved or other organizations' opportunities never appear publicly.
- [ ] Open and closed boundaries correct by the database clock.
- [ ] Accessibility tests on the new screens (labels, contrast, keyboard).

## M5: Dynamic form builder
- [ ] Schema validator: valid and invalid fixtures; no regular expressions or executable expressions accepted.
- [ ] A published version is immutable (trigger test).
- [ ] Server and client validate answers identically (shared fixtures).
- [ ] Generated forms are accessible (labels, descriptions, error links).

## M6: Applicant application lifecycle
- [ ] Every status pair tested for every actor; disallowed moves leave no write.
- [ ] Simultaneous transitions produce exactly one change.
- [ ] Changing fields outside a correction request is rejected.
- [ ] Status history is append-only; one row per transition.
- [ ] P0-4 and legacy application suites unchanged and passing.

## M7: Document verification
- [ ] Spoofed file types rejected; size limit enforced.
- [ ] No cross-organization file access; no reuse across applications (P-12 not implemented).
- [ ] Every download audited.

## M8: Payments and financial workflows
- [ ] At most one successful attempt per order (unique index plus concurrency test).
- [ ] Refunds can't exceed the amount paid; maker-checker enforced (if M-07 is approved).
- [ ] Settlement and wallet entry in one transaction; Super Admin approval (if C-02 is approved).
- [ ] No provider code is called; the provider table is empty.

## M9: Staff roles and task management
- [ ] Every existing role route returns 403 to staff; `requireSuperAdmin` returns 403 to staff.
- [ ] Unverified, suspended or removed members get 403; their sessions are revoked.
- [ ] Escalation guards (granting beyond one's own permissions, changing one's own roles) are rejected.
- [ ] A staff row created without a status can't sign in (C-16).
- [ ] X-01 one-way rollback documented and rehearsed on a disposable database.

## M10: Notifications
- [ ] A rolled-back event leaves no notification.
- [ ] Recipients see only their own notifications.
- [ ] No outbox rows and no outbound network calls.

## M11: Super Admin command center
- [ ] Every section A action is reachable by Super Admin, audited, and refused to ordinary Officials.
- [ ] Report figures equal the source counts on fixtures; aggregates contain no personal data.
- [ ] Official management (A-10) only after its own design approval.

## M12: Optional examination modules
- [ ] Full P0-4 suite and Phase 7 scenarios rerun in isolation and green.
- [ ] Module gating hides exam features for organizations without the module (if D-28 is approved).
- [ ] Linking an exam doesn't change the legacy application flow.

## M13: Security, audit and performance testing
- [ ] No critical or high security findings open.
- [ ] Every A-11 category produces audit events.
- [ ] Performance targets (set in M1) met on synthetic volume; query plans use the intended indexes.
- [ ] Accessibility audit to the M-15 target.
- [ ] Build-context verification repeated (P-19); restore rehearsal passed (M-10).

## M14: Demo-ready release
- [ ] Demo environment on hosting approved by the client (S-12), with synthetic data only.
- [ ] Runbooks: migration, rollback by flag, restore, cleanup.
- [ ] Browser checks on target devices, including Windows and Android font fallbacks.
- [ ] Client demo sign-off recorded. **No production release is implied** (S-01).
