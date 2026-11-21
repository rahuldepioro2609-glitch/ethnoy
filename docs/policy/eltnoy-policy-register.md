# ELTNOY policy register

> **SUPERSEDED on 2026-11-03 by [`master-policy-register.md`](master-policy-register.md).** Every entry here is carried over there with the same ID. This file is kept unchanged for history; update only the master register.

**Status:** Internal working register; do not publish or share externally. Last updated 2026-11-03.
**Statuses:**
- `DISCUSSION_APPROVED`: the direction is agreed; implementation still needs approval.
- `IMPLEMENTATION_APPROVED`: approved to build.
- `PENDING_CONFIRMATION`: undecided, or the record is incomplete. Never implemented or assumed.

**Source rule:** each entry cites where it was recorded. Questions 1–114 (the earlier decisions recovered by ChatGPT) **have not yet been supplied**, so no entry carries a question number and none of those decisions is reproduced from memory. When the recovered register arrives, its entries are merged here with their numbers. Any conflict with an entry below is listed under "Conflicts" for confirmation, not resolved silently.

## A. Standing safety restrictions (always in force)

| ID | Restriction | Status | Source |
|---|---|---|---|
| S-01 | No production deployment, and no production database migration or change | IMPLEMENTATION_APPROVED (as a restriction) | Repeated in every phase; 2026-11-03 instructions |
| S-02 | Never connect to or change the `eltnoy` or `eltnoy_dev` databases; never use host port 5432 | IMPLEMENTATION_APPROVED (as a restriction) | P0-2 to P0-4 phase instructions |
| S-03 | Never start, stop, recreate or change the existing Docker containers (`ethnoy-app-1`, `ethnoy-nginx-1`, `ethnoy-postgres-1`) or the `ethnoy_postgres_data` volume; no Compose, no prune; no cleanup of existing Docker resources | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| S-04 | No Git staging, commits or pushes without separate approval; no `git add .` or `-A`; no destructive Git commands | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| S-05 | Never expose secrets, passwords, tokens, session cookies, private keys or `.env` values in logs or reports | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| S-06 | Synthetic data only in test environments | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| S-07 | No third-party SaaS without client approval | IMPLEMENTATION_APPROVED (as a restriction) | 2026-11-03 build instruction |
| S-08 | No destructive changes to existing files or records; preserve existing functionality and data | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| S-09 | Never build a Docker image from the repository root unless the build context is verified to exclude private material | IMPLEMENTATION_APPROVED (as a restriction) | Phase 7 Step 3B; 2026-11-03 decision 8 |
| S-10 | Stop for review whenever a policy, architecture or production-authorization decision is needed | IMPLEMENTATION_APPROVED (as a restriction) | 2026-11-03 build instruction |

## B. Delivered release-candidate work

| ID | Decision | Status | Evidence |
|---|---|---|---|
| R-01 | P0-1 Git safety baseline | IMPLEMENTATION_APPROVED (done) | Commit `419e6ff` |
| R-02 | P0-2 institution migrations made atomic and safely rerunnable | IMPLEMENTATION_APPROVED (done) | Commit `29fb928` |
| R-03 | P0-3 authorization work | PENDING_CONFIRMATION | The audit and plans are recorded in the session, but the approval and implementation status isn't recorded clearly enough to state |
| R-04 | P0-4 online exam expiry and automatic scoring; Phase 7 accepted for documented acceptance | IMPLEMENTATION_APPROVED (accepted, uncommitted) | Phase 7 consolidated report; 21-file checksum manifest |
| R-05 | P0-4 policy: a 30-second grace period that applies only to delivering the final submit | IMPLEMENTATION_APPROVED | P0-4 design approval |
| R-06 | P0-4 policy: autosave accepted strictly before expiry | IMPLEMENTATION_APPROVED | Same |
| R-07 | P0-4 policy: answers held on screen are scored if the lock is obtained within the grace period; after it, saved answers are scored with `submitted_at = expires_at` | IMPLEMENTATION_APPROVED | Same |
| R-08 | P0-4 policy: recovery runs only when `ONLINE_EXAM_RECOVERY_SINCE` is set; attempts that expired before the cutoff stay `expired_unscored` | IMPLEMENTATION_APPROVED | Same |
| R-09 | P0-4 policy: no schema migration (Option A); audit by recording completion details in the stored score, plus structured logs | IMPLEMENTATION_APPROVED | Same |
| R-10 | Scoring formula, exam duration, negative marking and one attempt per exam stay unchanged | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| R-11 | Phase 7 acceptance does **not** authorize production deployment, a production migration, enabling recovery on real records, changes to existing containers, Git actions, or cleanup of the test environment | IMPLEMENTATION_APPROVED (as a restriction) | Phase 7 report §13 |
| R-12 | Whether a grace period other than 30 seconds may be used at release | PENDING_CONFIRMATION | Phase 7 report §10 |
| R-13 | Disposition of the open P0-4 items N3, N4, N5, R1 and S1, the retry window and the `0.0.0.0` bind | PENDING_CONFIRMATION | Phase 7 report §11 |
| R-14 | Cleaning up the isolated test environment (run `20261103140212-96b1f2`) | PENDING_CONFIRMATION | Not authorized |

## C. Product direction and design (2026-11-03)

| ID | Decision | Status | Source |
|---|---|---|---|
| P-01 | ELTNOY is a centralized Institution-to-Applicant Application & Opportunity Platform (exam, scholarship, admission, job and vacancy, government and private, and custom forms) | DISCUSSION_APPROVED | Build instruction |
| P-02 | Examination services remain optional modules | DISCUSSION_APPROVED | Same |
| P-03 | Preserve existing ELTNOY branding and behaviour; don't replace working interfaces without understanding their purpose | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| P-04 | Deep navy stays the primary brand colour; emerald stays in the wordmark; teal `#0D9488` is the interface accent; `#0F766E` is used where accessible text contrast is needed; white and slate surfaces; the logo isn't redesigned | IMPLEMENTATION_APPROVED | Decision 2 |
| P-05 | Plus Jakarta Sans bundled locally (WOFF2, OFL licence included, no Google CDN, system-font fallbacks) | IMPLEMENTATION_APPROVED (done) | Decision 3 |
| P-06 | Indic scripts (Devanagari, Kannada, Bengali, Marathi and others not supported) use system fonts | IMPLEMENTATION_APPROVED (done) | 2026-11-03 decision 1 |
| P-07 | Shared component foundation (button, card, status badge, table, empty, loading and error states, form controls) | IMPLEMENTATION_APPROVED (done) | Decision 4, design system section |
| P-08 | Existing screens are not moved to the new components without listing the affected screens and getting review | IMPLEMENTATION_APPROVED (as a restriction) | Same |
| P-09 | Opportunity data model: read-only architecture design only; no database changes, migrations, backfills or writes | DISCUSSION_APPROVED (design only) | Decision 4; 2026-11-03 decision 9 |
| P-10 | Staff and invigilator accounts: individual verified accounts, custom roles, granular permissions, never Super Admin authority | DISCUSSION_APPROVED | 2026-11-03 decision 3 |
| P-11 | Applicant statuses: draft, submitted, payment pending, payment successful, under verification, correction required, resubmitted, approved, rejected; optional statuses such as an admit card being available stay module-specific | DISCUSSION_APPROVED | 2026-11-03 decision 5 |
| P-12 | Reusing files across applications | PENDING_CONFIRMATION (do not implement) | 2026-11-03 decision 6 |
| P-13 | Retention of applicants' personal data | PENDING_CONFIRMATION (do not implement) | Same |
| P-14 | Backfilling the existing institute forms | PENDING_CONFIRMATION (do not implement) | Same |
| P-15 | The payment design may support primary and backup gateways | DISCUSSION_APPROVED | 2026-11-03 decision 7 |
| P-16 | Payment provider selection | PENDING_CONFIRMATION (client approval) | Same |
| P-17 | In-app notifications | DISCUSSION_APPROVED | Same |
| P-18 | SMS and email provider integration | PENDING_CONFIRMATION (approval required) | Same |
| P-19 | Narrow `.dockerignore` fix that excludes `.local-dev/` and private TLS key material | IMPLEMENTATION_APPROVED (done, verified) | 2026-11-03 decision 8 |
| P-20 | Don't publish or share the data-model proposal externally | IMPLEMENTATION_APPROVED (as a restriction) | 2026-11-03 decision 10 |
| P-21 | The 31 pending design decisions (D-01 to D-31) in `docs/architecture/opportunity-data-model-proposal.md` | See that document | Proposal revision 2 |

## D. Unresolved items

1. **Questions 1–114** have not been received. Every earlier decision outside this register is PENDING_CONFIRMATION until supplied.
2. **R-03:** the status of the P0-3 authorization work.
3. **R-12 to R-14:** the grace-period policy at release, the open P0-4 items, and test-environment cleanup.
4. **D-01 to D-31** in the data-model proposal. D-05, D-15, D-21 and D-24 are DISCUSSION_APPROVED; all the others are PENDING_CONFIRMATION.
5. **Build-context hygiene, outside the approved narrow fix:**
   - `.vscode/settings.json` and 33 `.aistudio/**.png` screenshots still enter the Docker build context. The existing `*.png` rule only matches files at the top level.
   - Neither is a secret, and both are carried only in the build stage, not the runtime image.
   - Excluding them needs a separate approval.

## E. Conflicts

None recorded yet. This section is filled in when the Questions 1–114 register is merged.
