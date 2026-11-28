# ELTNOY Implementation Tracker

**Last updated:** 2026-11-27 (after the A-11 audit log and the Merit List Engine foundation). See [PROJECT_AUDIT.md](PROJECT_AUDIT.md) for the evidence behind each row.

**Status words:** NOT STARTED, IN PROGRESS, IMPLEMENTED, TESTING, VERIFIED, BLOCKED.
- **VERIFIED** means tested and checked on the live site.
- **IMPLEMENTED** means it is in the code and passes its tests, but has not been checked live.
- **BLOCKED** means a client decision is needed first (audit section F).

**Column abbreviations:**
- **Prio:** priority, P0 (most urgent) to P3.
- **BE, FE, DB:** backend, frontend, database.
- **Sec:** security review.
- **"—"** means there is nothing to build yet in that column.

> **Current status (2026-11-27, engineering paused):**
> - The audit log (A-11/A-12), refused and failed money events, and the Merit List foundation are **implemented but not integrated**. They exist only in worktree `audit-log` (branch `audit-log`, base `1dd6145`).
> - **No commits or deployments** have occurred. Live production is unchanged (`ee5a049`).
> - **Workspace integration is pending.** See [INTEGRATION_READINESS.md](INTEGRATION_READINESS.md).
> - **Client approval blockers remain.** See [CLIENT_DECISIONS.md](CLIENT_DECISIONS.md).
> - **ELTNOY is NOT READY for full launch.**

## Foundation (Phase 1)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Student sign-up and sign-in | Secure login and registration | VERIFIED | Done | Done | Done | Reviewed | Pass | Password reset by email (D-6) | P0 | — |
| Institute registration and contact verification | Onboarding | VERIFIED | Done | Done | Done | Reviewed | Pass | Institute type, authorized person, logo fields | P1 | — |
| Official/Super Admin MFA and private admin host | Admin protection | VERIFIED | Done | Done | Done | Reviewed | Pass | — | P0 | — |
| Surface isolation and route policy | Tenant and host separation | VERIFIED | Done | Done | — | Reviewed | Pass | — | P0 | — |
| General audit events (A-11) and Super Admin viewer (A-12) | Audit records | IMPLEMENTED (worktree `audit-log`, not committed, not deployed) | Done | Done | Done (migration file 12) | Reviewed in tests | Pass (unit, route matrix, real PostgreSQL) | Commit, deploy with `migrate`, then check live; open items below | P0 | — |
| P0-3 policy gaps (A-08, A-10, A-16 for admit cards) | RBAC | NOT STARTED | Partial | — | Partial | Open | Partial | Build the missing rules | P0 | — (A-11 now in place) |
| Off-host encrypted backups and restore drill | Backup/restore | NOT STARTED | — | — | — | Open | — | Storage choice (free-only hosting) | P0 | Owner decision |
| Bundle splitting by surface | Performance | NOT STARTED | — | — | — | — | — | Route-level code splitting | P2 | — |

## Institute management (Phase 2)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Verification documents | S-02 | IMPLEMENTED | Done | Done | Done | Reviewed | Pass | Align the 8 document types (approval needed) | P2 | Client |
| Profile and change requests | S-01, S-04 | IN PROGRESS (partial) | Partial | Partial | Partial | OK | Partial | Logo, typed change kinds, history, cancel, previous vs requested values | P1 | — |
| Staff and roles | Staff module | IMPLEMENTED (activation blocked) | Done | Done | Done | Reviewed | Pass | Activation needs mobile OTP (Q115); SMS not configured | P1 | SMS provider |
| Institute activity log | S-07 | BLOCKED | — | — | — | — | — | A-12 says audit reads are Super Admin only; an institute view needs client decision C-03 | P1 | C-03 |
| Username reservation | R-14, R-15, S-05 | BLOCKED | — | — | — | — | — | Client decision F-2 (conflicts with N-04) | — | F-2 |
| Institute public website | S-06 | BLOCKED | — | — | — | — | — | Client decision F-2 | — | F-2 |
| Subscription and usage | R-16, S-03 | BLOCKED | — | — | — | — | — | Client decisions F-1 and F-3 (conflicts with N-03) | — | F-1, F-3 |
| Institute Workspace backend (other tool, uncommitted) | S-08 to S-18 | IN PROGRESS (not ours) | Draft | Draft | Draft | **Not reviewed** | Partial | Review; fix result/admit-card publishing (audit D-1); decide F-4 | P1 | F-4 |

## Examinations (Phase 3)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Exam creation (ELTNOY admin) | — | IMPLEMENTED | Done | Done | Done | Reviewed | Pass | — | — | — |
| Institute exam creation wizard and management | S-08, S-09, R-06 | BLOCKED | Draft (D-1) | — | Draft (D-1) | — | — | Client decision F-4 (who creates and publishes) | P1 | F-4 |
| Offline (OMR) exams | R-06 | NOT STARTED | — | — | — | — | — | — | P2 | F-4 |

## Applications (Phase 4)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Exam applications (candidate) | — | IMPLEMENTED | Done | Done | Done | Reviewed | Pass | Fees, correction requests, history | P1 | — |
| Form builder: job, admission, scholarship, webinar | R-01 to R-05, S-10 | NOT STARTED | — | — | — | — | — | Data model needs approval (docs/architecture/data-model-final-proposal.md, D-01…D-34) | P1 | Model approval |
| Institute applicant review | S-11 | NOT STARTED | — | — | — | — | — | Q117–Q119 (Owner and Application Managers) are DISCUSSION_APPROVED; needs IMPLEMENTATION_APPROVED | P1 | Approval |

## Payments and admit cards (Phase 5)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Institute wallet, credits, withdrawals | — | IMPLEMENTED | Done | Done | Done | Reviewed | Pass | — | — | — |
| Applicant fee payment, UPI, refunds | R-21, S-12 | BLOCKED | — | — | — | — | — | Payment provider and UPI process (F-6) | P2 | F-6 |
| Commission (12% / 5% + GST) | R-19 | BLOCKED | — | — | — | — | — | D-22/D-23 pending (F-6) | P2 | F-6 |
| Admit cards: admin import and candidate lookup | — | IMPLEMENTED | Done | Done | Done | Reviewed | Pass | A-06 draft step | P1 | — |
| Admit cards: institute generation, centres, templates, PDF | R-07, S-13 | BLOCKED | — | — | — | — | — | F-4 | P1 | F-4 |

## Question bank and exam engine (Phase 6)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Online CBT engine | Server-held timing, autosave, recovery | VERIFIED (P0-4) | Done | Done | Done | Reviewed | Pass | Randomisation, attempt limits | P2 | — |
| Question bank and paper tender | S-14, S-15 | BLOCKED | — | — | — | — | — | F-5 (who reviews and reads papers) | P1 | F-5 |

## CBT centre (Phase 7)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| CBT centre portal, seats, check-in, incidents | S-16, S-17 | NOT STARTED | — | — | — | — | — | Centre role and data model | P2 | F-4 |
| Live monitoring, CCTV, biometric | R-09 | BLOCKED | — | — | — | — | — | F-7 (hardware, consent); never fake feeds | P3 | F-7 |
| Candidate check-ins (attendance) | R-08 | IMPLEMENTED | Done | Done | Done | Reviewed | Pass | Examiner attendance, offline upload | P2 | — |

## Results (Phase 8)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Results import and publish (admin) | — | IMPLEMENTED | Done | Done | Done | Reviewed | Pass | — | — | — |
| Merit list foundation: marks order, unresolved tie groups, validation, draft versions, CSV export | R-10, S-18 | IMPLEMENTED (worktree `audit-log`, not committed or deployed) | Done | Done (Super Admin "Merit lists" tab) | Done (migration file 13) | Super Admin only; audited | Pass (unit, routes, real PostgreSQL) | Commit, deploy with `migrate`, live check | P1 | — |
| Tie-breaks, rank numbering, cut-offs, qualification, category merit | R-10, S-18 | BLOCKED | — | — | — | — | — | Client decisions ML-1 to ML-5 (register section ML) | P1 | ML-1–ML-5 |
| Merit-list approval and publication; re-evaluation | S-18 | BLOCKED | — | — | — | — | — | ML-6, ML-7 | P1 | ML-6, ML-7 |
| Institute merit lists | S-18 | BLOCKED | — | — | — | — | — | ML-8 / F-4 | P1 | F-4 |
| Negative marking (online exams) | — | BLOCKED | — | — | — | — | — | R-10 forbids changes; ML-9 | — | ML-9 |
| Candidate scorecards (published lookup) | — | IMPLEMENTED (existing) | Done | Done | Done | Reviewed | Pass | — | — | — |

## Interviews, training, webinars (Phase 9)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| Online interview | R-11 | NOT STARTED | — | — | — | — | — | Scheduling and scorecards; video needs infrastructure | P2 | — |
| Training / LMS | R-12 | NOT STARTED | — | — | — | — | — | — | P3 | — |
| Webinar and certificates | R-04, R-13, R-20 | NOT STARTED | — | — | — | — | — | Verifiable certificate IDs | P3 | — |
| Logo scroller on the ELTNOY home page | R-17 | BLOCKED | — | — | — | — | — | F-1 | P3 | F-1 |

## Notifications, reports, admin (Phase 10)

| Feature | Requirement | Overall | BE | FE | DB | Sec | Tests | Remaining | Prio | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|
| In-app notifications | Notifications | NOT STARTED | — | — | — | — | — | In-app is approved; email/SMS providers beyond one-time codes need approval | P2 | — |
| Institute reports and exports | Reports | NOT STARTED | — | — | — | — | — | CSV/PDF exports of real data | P2 | — |

## Change log

| Date | Change |
|---|---|
| 2026-11-27 | Tracker created from the Phase 0 audit. |
| 2026-11-27 | A-11/A-12 audit log implemented in worktree `.claude/worktrees/audit-log` (branch `audit-log`, uncommitted). |
| 2026-11-27 | Policy register: sections AL (audit log) and ML (merit list) added as implementation records; open decisions are listed as PENDING_CONFIRMATION. |
| 2026-11-27 | Merit List Engine foundation implemented in the same worktree; business rules BLOCKED (ML-1 to ML-9). |
| 2026-11-27 | Backlog review (`BACKLOG.md`). Fixed the stale PostgreSQL MFA test (36/36 now; security was correct). Added the §7 finance failure audit events. |
| 2026-11-27 | Engineering paused for integration. Added `INTEGRATION_READINESS.md` (merge plan) and `CLIENT_DECISIONS.md`. No commits or deployments. |

## A-11 audit log: open items

| Item | Why it is open | Needs |
|---|---|---|
| Refused and failed actions | **Money actions done 2026-11-27:** `withdrawal.payment_refused`, `wallet.credit_failed` and `withdrawal.payment_failed`. Other refusals (authorization denials, published-content refusals, failed sign-ins) wait for OD-5. | Client decision OD-5 |
| Failed sign-in logging | OD-5: what to record, and whether to store a login ID for an unknown account | Client decision OD-5 |
| Source IP and user agent | OD-3: collection and privacy-notice disclosure | Client decision OD-3 |
| Sealing chain and off-host checkpoints | OD-6: who controls the checkpoint copy | Client decision OD-6 |
| Export of audit events | OD-7: format and limits | Client decision OD-7 |
| Retention period | A-13 / OD-1: no automatic deletion until decided | Client and legal decision OD-1 |
| Institute view of its own activity | A-12 vs C-03 | Client decision C-03 |
| Audit rows from the P0-4 exam finalization | C-10: changes accepted P0-4 code | Client approval C-10 |
| Sign-in, MFA and registration events | Already in append-only `auth_verification_events`; not copied into `audit_events` | Decide whether the viewer should also show them |
| Policy register update (A-11, A-12 built; OD/C items) | **Done 2026-11-27** on the owner's instruction: register section AL (implementation record only; policy statuses unchanged) | — |
