# ELTNOY master policy register

**Status:** Internal working register. Do not publish or share externally. Last updated 2026-11-03.
**Supersedes:** `docs/policy/eltnoy-policy-register.md`. Every entry there is carried over below with its ID unchanged.
**Companion documents:** `policy-conflict-and-gap-register.md`, `../architecture/data-model-final-proposal.md`.

## How to read this register

**Status:**

| Status | Meaning |
|---|---|
| `IMPLEMENTATION_APPROVED` | Approved to build, or approved as a standing restriction. The "Built?" column says whether it exists in code. |
| `DISCUSSION_APPROVED` | Direction or policy agreed. Implementation needs a separate approval. |
| `PENDING_CONFIRMATION` | Undecided, or the record is incomplete. Must not be implemented or assumed. |
| `SUPERSEDED` | Replaced by a later decision, named in the entry. |
| `CONFLICTING` | Contradicts another approved entry or the current code. Listed in the conflict register and not resolved here. |

**Verification:**

| Code | Meaning |
|---|---|
| **Q** | Confirmed client decision, recorded verbatim from the client-supplied record of the ChatGPT conversation (pasted into the Claude Code session on 2026-11-03). Selected option letters preserved. |
| **V** | Verified verbatim. The wording comes from a dated client instruction in the project's Claude Code session log (`~/.claude/projects/…/8a3c8dd5….jsonl`), re-read for this register. |
| **V-code** | Verified from repository evidence (code, commit or test). |
| **R** | Reconstructed summary. It rests on the session's working summary rather than a re-read of the original wording. Confirm before relying on it. |
| **U** | Unverifiable: no source is available. |

**Responsible roles:**
- **Client:** the product owner who approves policy.
- **SA:** Super Admin, an Official with `is_super_admin`.
- **Official:** an ordinary Official.
- **Org:** the organization owner, which is today's center account.
- **Eng:** the engineering lead.

**Sources searched for this register:**
- `docs/` (the two earlier documents);
- `README.md`, `metadata.json` and `.aistudio/`, which holds images only;
- Claude Code project files: the session log, memory and plans (none exist);
- Git history (`419e6ff`, `29fb928`).

No document anywhere records numbered questions. The only mention of "Q1–Q114" or "Q115–Q125" is in the 2026-11-03 instructions themselves.

---

## Q. Numbered question coverage (Q1–Q125)

| Range | Status | Finding |
|---|---|---|
| **Q1–Q114** | PENDING_CONFIRMATION (**U**) | The original question-and-answer transcript isn't available in the repository, the decision records, or the Claude Code session history. None of its wording or answers is reproduced here. The "recovered summaries" said to be coming from ChatGPT haven't been received. Decisions recorded in this session (sections S, R, A, E, P, N) may overlap with Q1–Q114, but that overlap isn't assumed. |
| **Q115** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Staff account activation, **option C**. Full text in section QD. |
| **Q116** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Staff invitation and verification, **option C**. Full text in section QD. |
| **Q117** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Staff roles, **option B**. Full text in section QD. |
| **Q118** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Application approval and rejection authority, **option B**. Full text in section QD. |
| **Q119** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Application Manager allocation, **option C**. Full text in section QD. |
| **Q120** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Application rejection and appeal, **option C**. Full text in section QD. |
| **Q121** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Rejection override, **option C**. Full text in section QD. |
| **Q122** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Appeal deadline configuration, **option C**. Full text in section QD. |
| **Q123** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Reopening rejected applications, **option B**. Full text in section QD. |
| **Q124** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Applicant withdrawal, **option C**. Full text in section QD. |
| **Q125** | **CONFIRMED**, DISCUSSION_APPROVED (**Q**) | Withdrawal after approval, **option C**. Full text in section QD. |

**About Q115–Q125:**
- Confirmed client decisions, sourced from the ChatGPT conversation and recorded verbatim in section QD from the client-supplied text of 2026-11-03.
- **Confirmation isn't authorization to implement.** They are `DISCUSSION_APPROVED`. Any database or application change needs separate approval.
- They don't correspond to P-04 to P-21 or N-01 to N-06; no mapping is applied.

**About Q1–Q114:** unverifiable where the original wording is unavailable. No historical decision is overwritten or invented.


---

## QD. Confirmed decisions Q115–Q125 (verbatim)

**Source:** the client-supplied record "ELTNOY — Confirmed Policy Decisions Q115–Q125", from the ChatGPT conversation. It was pasted into the Claude Code session on 2026-11-03.

**Status of all eleven:** **CONFIRMED** (not pending, not unverifiable); `DISCUSSION_APPROVED`, because implementation needs separate approval (the client's registering instruction).

**Verification:** **Q**.

**Terms used below:**
- *Organization Owner* is today's center account (`users.role = 'center'`).
- *Super Admin* is an Official with `is_super_admin`.

### Q115: Staff account activation (option C)
> The Organization Owner invites staff members. Staff must verify their identity. Super Admin reviews and activates each staff account.
> - Staff cannot access the organization portal before Super Admin activation.
> - Staff accounts are individual accounts.
> - All activation actions are audited.
> - Verification-provider integration requires separate client approval.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Org (invites); staff member (verifies); **SA (activates)** | Organizations, staff, audit | P-10, D-05, **D-07 (decided by Q115/Q116)**, D-06, C-16, A-11, S-07 | Activation is a **Super Admin-only** action. No staff access before it, so it needs a database or code guard (C-16). Audit entries are needed (the audit table, S-1 in the P0-3 plan). A verification provider needs approval (S-07). |

### Q116: Staff invitation and verification (option C)
> Staff onboarding uses an Organization Owner invitation code plus mobile OTP verification.
> - Invitation codes are unique, single-use, expiring and stored hashed.
> - Staff accepts the invitation and completes mobile OTP verification.
> - Super Admin reviews and activates the account.
> - No access before activation.
> - Invitation codes cannot be reused across organizations.
> - OTP attempts must be rate-limited.
> - SMS provider integration requires separate client approval.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Org; staff member; SA | Staff onboarding, notifications | Q115, **D-07**, P-18, NOT-03, S-07 | Invitation-token table (hashed, single use, expiring, tied to one organization). OTP challenge with rate limiting. **Mobile OTP needs an SMS provider, which isn't approved yet (P-18), so staff onboarding can't complete until it is** (conflict register C-18). |

### Q117: Staff roles (option B)
> Six predefined roles are supported:
> 1. Reviewer — reviews applications.
> 2. Verifier — verifies application details and documents.
> 3. Application Manager — manages assigned application workflows.
> 4. Finance Viewer — read-only financial reports.
> 5. Invigilator — assigned examination sessions only.
> 6. Viewer — read-only access to permitted modules.
>
> Custom roles are also supported.
> - Finance Viewer cannot credit wallets, approve withdrawals or execute payments.
> - Invigilators are restricted to assigned examination sessions.
> - Super Admin permissions cannot be delegated.
> - Custom permissions must respect platform-level privilege boundaries.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Org (assigns roles); SA (platform boundaries) | Staff permissions, finance reports, exam module | P-10, **D-08** (templates decided; catalogue still open), **D-09** (scope = examination sessions), A-02, A-03, C-03 | Six predefined role templates plus custom roles from a fixed catalogue. Finance Viewer is read-only and consistent with A-02 and A-03 (credits and withdrawals stay Super Admin only). **"Examination sessions" doesn't exist as a record in the current schema** (C-20). |

### Q118: Application approval and rejection authority (option B)
> Organization Owner and explicitly authorized Application Managers may approve or reject applications.
> - Reviewer checks applications.
> - Verifier verifies information and documents.
> - Application Manager can decide only when explicitly granted application.decide permission.
> - Organization Owner retains overall organizational authority and oversight.
> - Super Admin retains platform-level publishing and control powers where applicable.
> - Reviewer and Verifier do not receive approval authority by default.
> - Decisions record actor, timestamp and reason.
> - Access is restricted to the member's own organization.
> - Rejected application history is retained.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Org; Application Manager with `application.decide`; SA (platform) | Application lifecycle, permissions | **PERM-01 (decided)**, D-08, D-16, A-11, §6 tenant isolation | `application.decide` is granted explicitly, never by default to Reviewer or Verifier. Every decision records actor, time and reason. Tenant isolation is mandatory. History is append-only. |

### Q119: Application Manager allocation (option C)
> Multiple Application Managers are permitted, with:
> - Form-wise assignment.
> - Workload limits.
> - Manual and automatic task allocation.
> - Organization Owner assignment and reassignment authority.
> - Overdue alerts.
> - Individual performance reports.
> - Complete assignment and reassignment audit history.
>
> Application Managers can decide only on assigned forms and within their permitted actions. The Organization Owner retains overall authority.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Org (assigns and reassigns); Application Manager | Task allocation, notifications, reports | Q118, D-08, P-17, A-11 | New assignment model (per form, workload limit, allocation history) that **isn't in the current data-model proposal** (gap G-Q119). Overdue alerts use in-app notifications (P-17). What counts as "overdue" isn't defined (M-18). |

### Q120: Application rejection and appeal (option C)
> Application rejection is recorded immediately, but the applicant can appeal to the Organization Owner within a configurable deadline.
> - Application Manager records rejection with a mandatory reason.
> - Applicant receives rejection notification and reason.
> - Applicant can appeal within the configured deadline.
> - Organization Owner reviews the appeal and records the final decision with remarks.
> - All previous statuses, decisions and appeal history are preserved.
> - Super Admin can review platform-level disputes without automatically replacing organizational decision authority.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Application Manager (rejects); applicant (appeals); **Org (decides the appeal)**; SA (reviews disputes) | Application lifecycle, appeals, notifications | P-11, **D-16 ("rejected is final" superseded)**, Q122, P-17 | An appeal record and an appeal state are needed. **The approved status set (P-11) has no appeal state** (C-19). Super Admin's dispute powers beyond reviewing are undefined (M-17). |

### Q121: Rejection override (option C)
> Organization Owner can overturn an Application Manager's rejection.
> - Owner can approve the application or restore it for further review.
> - Mandatory reason for every override.
> - Original rejection remains in application history.
> - Applicant receives an updated notification.
> - Actor, timestamp and reason are recorded.
> - No silent status changes or deletion of previous decisions.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| **Org only** | Application lifecycle | Q118, Q120, D-16, A-11 | New transitions from `rejected` to `approved` or back to review, Owner only, with a mandatory reason. Append-only history. |

### Q122: Appeal deadline configuration (option C)
> Super Admin sets the platform default and permitted limits. Organization Owner configures the deadline for each form within those limits.
> - Super Admin defines minimum and maximum permitted appeal periods.
> - Organization Owner configures the form-specific deadline within those limits.
> - Deadline is clearly displayed to applicants.
> - Deadline uses the configured timezone.
> - Expired appeals cannot be submitted through the normal workflow.
> - Exceptional reopening requires authorized approval and an audit record.
> - Published deadline changes must not silently affect existing applications.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| **SA (platform default and limits)**; Org (per-form value) | Platform settings, form configuration, appeals | Q120, Q123, D-26, E-02 (database time) | A platform setting (Super Admin) plus a per-form setting kept within it. **Each application keeps the deadline that applied to it**, so later changes don't affect existing applications. Expiry is decided by database time in the configured time zone. |

### Q123: Reopening rejected applications (option B)
> Organization Owner can reopen a rejected application even after the appeal deadline.
> - Only Organization Owner or explicitly authorized authority may reopen.
> - Mandatory reopening reason.
> - Original rejection and appeal history remain intact.
> - Applicant receives notification.
> - Application returns to the appropriate review stage.
> - Reopening does not automatically waive fees or deadlines.
> - Every action is audited.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Org, or "explicitly authorized authority" | Application lifecycle | Q120, Q122, D-16, A-11, M-07 | New transition from `rejected` to the review stage, with a mandatory reason, audited. "Explicitly authorized authority" would need a dedicated permission (D-08 catalogue). "The appropriate review stage" needs defining (M-19). |

### Q124: Applicant withdrawal (option C)
> Applicants can withdraw applications within a configurable deadline. After that deadline, organizational exceptions are possible.
> - Applicant can withdraw within the configured withdrawal period.
> - Organization Owner sets the deadline within Super Admin limits.
> - After the deadline, withdrawal requires an authorized organizational decision.
> - Exceptional withdrawal requires a mandatory reason.
> - Withdrawn applications retain complete history.
> - Applicant receives confirmation.
> - Withdrawal does not automatically trigger a refund.
> - Refund eligibility follows the separate payment and refund policy.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Applicant; Org (deadline, exceptions); SA (limits) | Application lifecycle, payments | **D-17 (decided)**, P-11, Q122 (same pattern of limits), M-07, D-33 | Needs a `withdrawn` status and a withdrawal request, **neither of which is in the approved status set (P-11)** (C-19). No automatic refund; refunds wait for M-07. |

### Q125: Withdrawal after approval (option C)
> An applicant may request withdrawal even after an application has been approved. The Organization Owner decides the request based on the opportunity's rules.

| Responsible roles | Modules | Links | Implementation implications |
|---|---|---|---|
| Applicant (requests); **Org (decides)** | Application lifecycle | Q124, **D-16 ("approved is final" superseded)**, D-17 | A transition from `approved` to `withdrawn`, by Owner decision only. **"The opportunity's rules" for withdrawal aren't yet defined as an opportunity setting** (M-16). |

---

## S. Standing safety restrictions

| ID | Policy meaning | Status | Role | Modules | Implementation implications | Source | Ver. |
|---|---|---|---|---|---|---|---|
| S-01 | No production deployment, and no production database migration or change | IMPLEMENTATION_APPROVED (restriction) | Client | All | Every milestone stops before production. Production needs its own authorization. | Phase instructions P0-1 to P0-4; 2026-11-03 | V |
| S-02 | Never connect to or change `eltnoy` or `eltnoy_dev`; never use host port 5432 | IMPLEMENTATION_APPROVED (restriction) | Eng | Database | Validation only on disposable PostgreSQL with no published port or a loopback-only one | P0-2 to P0-4 instructions | V |
| S-03 | Don't touch the existing containers (`ethnoy-app-1`, `ethnoy-nginx-1`, `ethnoy-postgres-1`) or the `ethnoy_postgres_data` volume; no Compose, no prune, no cleanup | IMPLEMENTATION_APPROVED (restriction) | Eng | Deployment | Test resources are named and labelled per run, and removed by exact name | Same | V |
| S-04 | No Git staging, commits or pushes without separate approval; no `git add .` or `-A`; no destructive Git | IMPLEMENTATION_APPROVED (restriction) | Client | All | Each commit needs an explicit file list and approval | Same | V |
| S-05 | Never expose secrets, passwords, tokens, cookies, private keys or `.env` values | IMPLEMENTATION_APPROVED (restriction) | Eng | All | Logs and reports carry IDs and counts only | Same | V |
| S-06 | Synthetic data only in test environments | IMPLEMENTATION_APPROVED (restriction) | Eng | Testing | Fixtures use `example.invalid` addresses and fictional names | Same | V |
| S-07 | No third-party SaaS without explicit client approval | IMPLEMENTATION_APPROVED (restriction) | Client | Payments, notifications, storage, monitoring | Payment, email and SMS providers are blocked until approved | 2026-11-03 instructions | V |
| S-08 | No destructive changes to existing files or records; preserve all functionality and data | IMPLEMENTATION_APPROVED (restriction) | Eng | All | Migrations are additive; any change to an existing table needs explicit approval | Same | V |
| S-09 | No Docker build from the repository root unless the build context is verified | IMPLEMENTATION_APPROVED (restriction) | Eng | Deployment | `.dockerignore` fix verified on 2026-11-03 (P-19) | Phase 7 Step 3B; 2026-11-03 decision 8 | V |
| S-10 | Stop for review when a policy, architecture or production decision is needed | IMPLEMENTATION_APPROVED (restriction) | Eng | All | Every milestone has an approval gate | 2026-11-03 build instruction | V |
| S-11 | Don't invent missing policy decisions; keep verified decisions separate from reconstructed ones | IMPLEMENTATION_APPROVED (restriction) | Eng | Documentation | Applied throughout this register | 2026-11-03 master instruction | V |
| S-12 | Cloud hosting must not be assumed to be approved | IMPLEMENTATION_APPROVED (restriction) | Client | Deployment, storage | The architecture must run on the existing Docker Compose stack (app, nginx, PostgreSQL) on any host. Files stay on local storage, with no cloud object store. | 2026-11-03 master instruction | V |

## R. Delivered release-candidate work

| ID | Policy meaning | Status | Built? | Role | Modules | Implications | Source | Ver. |
|---|---|---|---|---|---|---|---|---|
| R-01 | P0-1 Git safety baseline | IMPLEMENTATION_APPROVED | Yes, commit `419e6ff` | Eng | Repository | none | Git history | V-code |
| R-02 | P0-2 institution migrations atomic and safely rerunnable | IMPLEMENTATION_APPROVED | Yes, commit `29fb928` | Eng | Database | The migration pattern all new migrations must follow | Git history; P0-2 approval 02:49Z | V |
| R-03 | P0-3 authorization: implementing the approved policy (section A) | **CONFLICTING** | **No** | Eng / Client | All admin routes | The policy is approved (A-01 to A-20), but the revised implementation plan never received final approval, and the current code doesn't enforce it. See conflict register C-01. | Instructions 03:17Z and 03:22Z; code inspection | V, V-code |
| R-04 | P0-4 online exam expiry and automatic scoring; Phase 7 ready for documented acceptance | IMPLEMENTATION_APPROVED | Yes, **uncommitted** (21-file checksum manifest) | Client | Online exams | It must be committed before any milestone that touches online exams | Phase 7 consolidated report | V |
| R-05 | 30-second grace period, only for delivering the final submit | IMPLEMENTATION_APPROVED | Yes | Client | Online exams | Merged with E-01 | Instruction 03:48Z, decision 1 | V |
| R-06 | Autosave accepted strictly before expiry; grace is never extra answering time | IMPLEMENTATION_APPROVED | Yes | Client | Online exams | — | 03:41Z, 03:48Z | V |
| R-07 | **Lenient grace:** answers held on screen are accepted if the lock is obtained within grace. **After grace:** saved answers are scored, late answers ignored, and the stored score returned. | IMPLEMENTATION_APPROVED | Yes | Client | Online exams | — | 03:48Z, decisions 2, 3 and 5 | V |
| R-08 | Attempts that expired before `ONLINE_EXAM_RECOVERY_SINCE` are never scored automatically; with recovery disabled they show as expired and unscored, never pending | IMPLEMENTATION_APPROVED | Yes | Client | Online exams | — | 03:41Z; 03:48Z, decision 4 | V |
| R-09 | No schema migration (Option A). Audit through completion details stored in the score, plus structured logs, without depending on the P0-3 audit migration. | IMPLEMENTATION_APPROVED | Yes | Client | Online exams | It must be reconciled with the future audit table (A-11) | 03:48Z, decision 7 | V |
| R-10 | Scoring formula, exam duration, negative marking and one attempt per exam unchanged; existing student data, saved responses and historical scores unchanged | IMPLEMENTATION_APPROVED (restriction) | Yes | Client | Online exams | — | 03:48Z, items 11–12 | V |
| R-11 | Phase 7 acceptance doesn't authorize production, a production migration, recovery on real records, container changes, Git actions or cleanup | IMPLEMENTATION_APPROVED (restriction) | — | Client | — | — | Phase 7 report §13 | V |
| R-12 | Whether a grace period other than 30 seconds may be used at release (the setting allows 0–120 s) | PENDING_CONFIRMATION | — | Client | Online exams | Conflict register C-08 | Phase 7 report §10 | V |
| R-13 | Disposition of N3, N4, N5, R1, S1, the retry window and the `0.0.0.0` bind | PENDING_CONFIRMATION | — | Client / Eng | Online exams, deployment | Gap register | Phase 7 report §11 | V |
| R-14 | Cleaning up the isolated test environment (run `20261103140212-96b1f2`) | PENDING_CONFIRMATION | — | Client | Testing | It holds credential files that need removal | Not authorized | V |

## E. Further P0-4 decisions (verified)

| ID | Policy meaning | Status | Built? | Role | Source | Ver. |
|---|---|---|---|---|---|---|
| E-01 | The candidate sees the score immediately after a successful finalization | IMPLEMENTATION_APPROVED | Yes | Client | 03:48Z, decision 6 | V |
| E-02 | The row lock is taken first, then `clock_timestamp()` is read for the expiry decision. The deadline is decided by database time, never browser time. | IMPLEMENTATION_APPROVED | Yes | Eng | 03:41Z; 03:48Z | V |
| E-03 | A record with `submitted_at` set but no score is an inconsistent legacy record: a safe invariant error is raised and the record isn't changed (the SQL guard includes `AND score IS NULL`) | IMPLEMENTATION_APPROVED | Yes | Eng | 04:07Z; 04:33Z (F7 accepted permanently) | V |
| E-04 | An attempt is eligible for recovery when `expires_at >= cutoff`; below the cutoff it's excluded and unchanged; attempts skipped because they're locked stay eligible | IMPLEMENTATION_APPROVED | Yes | Eng | 04:07Z | V |
| E-05 | The user ID comes from the session, never the request body; `{ submittedAt, score }` stays compatible; repeat submits return the stored score | IMPLEMENTATION_APPROVED | Yes | Eng | 04:33Z | V |
| E-06 | Never claim success unless finalization committed; never show "Submitted" without a confirmed server response; never overwrite saved answers because of an invalid payload | IMPLEMENTATION_APPROVED | Yes | Eng | 03:48Z; 04:33Z | V |
| E-07 | Never log answers, score contents, user identifiers, session tokens or secrets | IMPLEMENTATION_APPROVED | Yes | Eng | 04:07Z; 04:33Z | V |
| E-08 | Settings: grace 30 s by default (0–120); the cutoff needs an explicit time zone offset and must not be too far in the future; interval 60 s (0 means a startup sweep only); batch 50 (1–200) | IMPLEMENTATION_APPROVED | Yes | Eng | 03:48Z | V |

## A. P0-3 authorization policy (client-approved, not implemented)

The source is the client instruction of 2026-11-03 03:17Z ("The client has approved the complete recommended policy"), refined by the instruction of 03:22Z (policy decisions and technical corrections). The revised implementation plan never received its final review, and **none of A-02 to A-17 is enforced in the current code**. All of `/api/admin/*` uses only `requireRoles('official')`. The single exception is `GET /api/admin/data-export`, which also requires Super Admin.

| ID | Policy meaning | Status | Built? | Role | Modules | Implications | Ver. |
|---|---|---|---|---|---|---|---|
| A-01 | Approving or rejecting institution registrations stays with **all** currently authorized Officials. Preserve exactly. | IMPLEMENTATION_APPROVED (preserve) | Yes | Official | Organizations | The new organization approval keeps this rule | V |
| A-02 | Wallet credits: Super Admin only | DISCUSSION_APPROVED | **No** | SA | Finance | The proposal's automatic credits on settlement conflict with this (C-02) | V |
| A-03 | **Withdrawals:** Super Admin only, to approve, reject or mark paid. **Maker-checker:** the approver can't be the person who marks it paid; this is enforced by the database, legacy rows included. The approver may reject before payment. | DISCUSSION_APPROVED | **No** | SA | Finance | Needs a change to `institute_withdrawals` (approver and payer columns plus a constraint), which requires approval | V |
| A-04 | **Results:** Super Admin only to publish, unpublish or correct. Direct creation or overwriting must not publish immediately. Draft workflows are preserved. | DISCUSSION_APPROVED | **No** | SA | Exam module | Draft state on `published_results` | V |
| A-05 | **Exam, answer-key and online-exam-paper publishing:** Super Admin only | DISCUSSION_APPROVED | **No** | SA | Exam module | Affects the P0-4 publishing routes; coordinate with R-10 | V |
| A-06 | **Admit cards:** importing creates a draft; publishing needs Super Admin; both the bulk import and the single-assignment routes are covered | DISCUSSION_APPROVED | **No** | SA | Exam module | Needs a draft/published flag on `admit_cards`. Old code ignores that flag, so mixed-version deployment isn't safe (A-20). | V |
| A-07 | Full Excel export: Super Admin only | IMPLEMENTATION_APPROVED | Yes (`index.ts:263`) | SA | Reports | — | V, V-code |
| A-08 | All Officials keep the candidate application list and status workflow, but **email and phone are hidden from ordinary Officials** | DISCUSSION_APPROVED | **No** | Official / SA | Applications | Applies to legacy applications. The rule for new opportunity applications is D-10. | V |
| A-09 | Institution document downloads and document review decisions: Super Admin only | DISCUSSION_APPROVED | **No** | SA | Documents | `institutionDocuments.ts` uses an official-only guard | V |
| A-10 | **Official management** (create, grant or revoke Super Admin, disable, revoke sessions): Super Admin only, as a separate follow-up milestone. The CLI bootstrap stays for now. | DISCUSSION_APPROVED | Partly (CLI only) | SA | Platform admin | Roadmap milestone 11 | V |
| A-11 | **Audit trail:** acting Official, action, target, time, and before and after state, for financial, approval, publishing and permission actions. No passwords, tokens, secrets or unnecessary personal data. **Written in the same transaction as the action; an audit failure rolls the action back.** | DISCUSSION_APPROVED | **No** | Eng | All | A new `audit_events` table, shared with the opportunity platform | V |
| A-12 | Reading the audit log: Super Admin only | DISCUSSION_APPROVED | **No** | SA | Audit | The proposed organization permission `audit.view` conflicts with this (C-03) | V |
| A-13 | Audit retention: append-only, no automatic deletion this release; retention is a future client decision | DISCUSSION_APPROVED | — | Client | Audit | Append-only triggers | V |
| A-14 | Helpdesk tickets: Super Admin only | DISCUSSION_APPROVED | **No** | SA | Helpdesk | — | V |
| A-15 | Linking legacy application ownership: Super Admin only | DISCUSSION_APPROVED | **No** | SA | Applications | Affects `/api/admin/applications/:id/verify-ownership` | V |
| A-16 | Correcting a published result or admit card returns it to draft and requires republishing | DISCUSSION_APPROVED | **No** | SA | Exam module | — | V |
| A-17 | Publishing public notices: Super Admin only. All Officials may create notices as drafts. | DISCUSSION_APPROVED | **No** | SA / Official | Notices | — | V |
| A-18 | Exam creation and draft imports stay open to all Officials (subject to A-16) | IMPLEMENTATION_APPROVED (preserve) | Yes | Official | Exam module | — | V |
| A-19 | Authorization is enforced on the backend; frontend visibility alone is never enough. Route tests cover unauthenticated users, wrong roles, ordinary Officials and Super Admin. | IMPLEMENTATION_APPROVED (standard) | Partly | Eng | All | Applies to every milestone | V |
| A-20 | Don't claim mixed-version safety for the admit-card draft change; use a controlled deployment | DISCUSSION_APPROVED | — | Eng | Deployment | — | V |
| A-21 | ~~Restrict candidate personal-data access to Super Admin~~ | SUPERSEDED by A-08 | — | — | — | — | V |
| A-22 | ~~Don't assume every financial or publishing action becomes Super Admin-only~~ (audit-stage instruction) | SUPERSEDED by A-02 to A-06 | — | — | — | — | V |

## P. Product direction and design (2026-11-03)

| ID | Policy meaning | Status | Built? | Role | Modules | Source | Ver. |
|---|---|---|---|---|---|---|---|
| P-01 | ELTNOY is a centralized Institution-to-Applicant Application & Opportunity Platform | DISCUSSION_APPROVED | No | Client | All | Build instruction 11:11Z; master instruction 12:03Z | V |
| P-02 | Examination services remain optional modules | DISCUSSION_APPROVED | No | Client | Exam module | Same | V |
| P-03 | Preserve existing branding and behaviour; don't replace working interfaces without understanding them | IMPLEMENTATION_APPROVED (restriction) | — | Client | Frontend | 11:11Z | V |
| P-04 | **Colours:** deep navy primary, emerald wordmark, teal `#0D9488` accent, `#0F766E` for accessible text, white and slate surfaces. **Logo** isn't redesigned. | IMPLEMENTATION_APPROVED | Yes (tokens) | Client | Design system | Decision 2, 11:16Z | V |
| P-05 | Plus Jakarta Sans bundled locally (WOFF2, OFL licence, no Google CDN, system-font fallbacks) | IMPLEMENTATION_APPROVED | Yes | Client | Design system | Decision 3, 11:16Z | V |
| P-06 | Indic scripts fall back to system fonts; rendering and line wrapping verified | IMPLEMENTATION_APPROVED | Yes | Client | Design system | Decision 1, 11:29Z | V |
| P-07 | Shared component foundation | IMPLEMENTATION_APPROVED | Yes | Client | Design system | 11:16Z | V |
| P-08 | Existing screens aren't moved to the new components without listing the affected screens and getting review | IMPLEMENTATION_APPROVED (restriction) | — | Client | Frontend | 11:16Z | V |
| P-09 | The opportunity data model is design only, with no database changes, migrations, backfills or writes | DISCUSSION_APPROVED (design only) | — | Client | Database | 11:16Z; 11:29Z decision 9 | V |
| P-10 | Staff and invigilator accounts: individual verified accounts, custom roles, granular permissions, never Super Admin authority | DISCUSSION_APPROVED | No | Client | Organizations | 11:29Z decision 3 | V |
| P-11 | **Applicant statuses:** draft, submitted, payment pending, payment successful, under verification, correction required, resubmitted, approved, rejected. **Optional statuses,** such as an admit card being available, stay module-specific. | DISCUSSION_APPROVED | No | Client | Applications | 11:29Z decision 5 | V |
| P-12 | Reusing files across applications | PENDING_CONFIRMATION (don't implement) | — | Client | Documents | 11:29Z decision 6 | V |
| P-13 | Retention of applicants' personal data | PENDING_CONFIRMATION (don't implement) | — | Client | Documents, privacy | Same | V |
| P-14 | Backfilling existing institute forms | PENDING_CONFIRMATION (don't implement) | — | Client | Migration | Same | V |
| P-15 | The payment design may support primary and backup gateways | DISCUSSION_APPROVED | No | Client | Payments | 11:29Z decision 7 | V |
| P-16 | Payment provider selection | PENDING_CONFIRMATION (client approval) | — | Client | Payments | Same | V |
| P-17 | In-app notifications | DISCUSSION_APPROVED | No | Client | Notifications | Same | V |
| P-18 | SMS and email provider integration | PENDING_CONFIRMATION (approval required) | — | Client | Notifications | Same | V |
| P-19 | Narrow `.dockerignore` fix (`.local-dev/` and private key material) | IMPLEMENTATION_APPROVED | Yes, verified | Client | Deployment | 11:29Z decision 8 | V |
| P-20 | Don't publish or share the data-model proposal externally | IMPLEMENTATION_APPROVED (restriction) | — | Client | Documentation | 11:29Z decision 10 | V |
| P-21 | The 31 proposal decisions D-01 to D-31 (section D) | See section D | — | Client | Architecture | Proposal revision 2 | V |

## N. New direction in the master instruction of 2026-11-03 12:03Z

| ID | Policy meaning | Status | Role | Modules | Implications | Ver. |
|---|---|---|---|---|---|---|
| N-01 | Core opportunity types: examinations, scholarships, admissions, vacancies, **registrations**, and custom applications and forms | DISCUSSION_APPROVED | Client | Opportunities | Adds `registration`. Replaces the proposal's `government_form` and `private_form` categories; see D-04 and C-12. | V |
| N-02 | Organization types *include* educational institutions, government departments, private companies, NGOs and recruitment organizations | DISCUSSION_APPROVED (list may be incomplete) | Client | Organizations | An organization attribute. Whether there's an "other" type is unconfirmed (C-13). | V |
| N-03 | No institution subscriptions | IMPLEMENTATION_APPROVED (restriction) | Client | Finance | No subscription plans, recurring billing or feature gating by plan | V |
| N-04 | No custom organization domains or separate institution websites | IMPLEMENTATION_APPROVED (restriction) | Client | Public site | Every organization page is served by ELTNOY under ELTNOY's domain. Whether an in-platform public profile page is allowed is C-14. | V |
| N-05 | The architecture scope covers: public discovery; organization registration and portal; form builder; applicant portal; application lifecycle; documents; payments and finance; staff and permissions; Super Admin command center; notifications; reports and analytics; security and audit; optional exam modules | DISCUSSION_APPROVED (design scope) | Client | All | `system-architecture.md` | V |
| N-06 | Cloud hosting isn't assumed to be approved | IMPLEMENTATION_APPROVED (restriction) | Client | Deployment | The same rule as S-12 | V |

## D. Data-model proposal decisions (status at 2026-11-03)

The full text is in `../architecture/data-model-final-proposal.md` §13. Status changes since revision 2:

| ID | Topic | Status | Change since revision 2 |
|---|---|---|---|
| D-01 | Feature-flag name and default | PENDING_CONFIRMATION | — |
| D-02 | Visibility options beyond public and unlisted | PENDING_CONFIRMATION | — |
| D-03 | Super Admin-managed categories versus a fixed list | PENDING_CONFIRMATION | — |
| D-04 | "Government" and "private" as categories or as an organization attribute | PENDING_CONFIRMATION | **Recommended:** an organization attribute, following N-01 and N-02. Not decided. |
| D-05 | Staff accounts (direction) | DISCUSSION_APPROVED | — |
| D-06 | `staff` value in `users.role` | PENDING_CONFIRMATION | Conflicts with the "additive only" rule (C-04) |
| D-07 | How staff accounts are verified | **DECIDED by Q115 and Q116** (DISCUSSION_APPROVED) | Owner invitation code, then mobile OTP, then Super Admin activation. **Depends on SMS provider approval (P-18)** (C-18). |
| D-08 | Permission catalogue and templates | **Partly decided by Q117 and Q118** | Six role templates plus custom roles (Q117); `application.decide` granted explicitly (Q118). The permission catalogue itself is still PENDING_CONFIRMATION; `audit.view` still conflicts with A-12 (C-03). |
| D-09 | Invigilator scopes | **DECIDED by Q117**: assigned examination sessions only | The session record is now designed: **C-20 is DISCUSSION_APPROVED with Option C** (see N-07) |
| D-10 | What non-super Officials may do on the new platform | PENDING_CONFIRMATION | A-08 decides it for legacy applications only. Recommended to extend A-08 by analogy; not decided. |
| D-11 to D-14 | Validation formats, form limits, application number format, draft expiry | PENDING_CONFIRMATION | — |
| D-15 | Applicant status set | DISCUSSION_APPROVED | The same as P-11 |
| D-16 | Status transitions | PENDING_CONFIRMATION, **partly superseded** | Q120, Q121, Q123 and Q125 replace "approved and rejected are final" with appeal, override, reopening and withdrawal-after-approval transitions. The remaining open questions are in the gap register. |
| D-17 | Withdrawal | **DECIDED by Q124 and Q125** (DISCUSSION_APPROVED) | Status-set extension needed (C-19) |
| D-18 / D-19 / D-20 | File reuse, retention, original file names | PENDING_CONFIRMATION | D-18 is the same as P-12, D-19 as P-13 |
| D-21 | Primary and backup gateways | DISCUSSION_APPROVED | The same as P-15 |
| D-22 / D-23 | Providers, platform commission | PENDING_CONFIRMATION | N-03 rules out subscriptions as a revenue model |
| D-24 / D-25 | In-app notifications, email and SMS | DISCUSSION_APPROVED / PENDING_CONFIRMATION | — |
| D-26 / D-27 | Editing after publishing; publishing without review | PENDING_CONFIRMATION | D-27 relates to A-05 (C-05) |
| D-28 / D-29 / D-30 / D-31 | Module enablement, exam bridge, backfill, row-level security | PENDING_CONFIRMATION | D-30 is the same as P-14 |

## ES. Examination Session Management (2026-11-03)

| ID | Policy meaning | Status | Role | Modules | Implications | Ver. |
|---|---|---|---|---|---|---|
| N-07 | **C-20 resolved by the client: Option C, a structured Examination Session Management module** supporting: (1) structured sessions; (2) multiple invigilators per session; (3) multiple assigned centers; (4) session-specific role permissions; (5) candidate allocation; (6) QR and manual attendance; (7) session monitoring; (8) emergency pause and incident reporting; (9) assignment and reassignment audit history; (10) session-wise reports. **Mandatory rules:** invigilators access only assigned sessions; backend enforcement; assignment and reassignment need authorized permissions; existing exam workflows preserved; free-text shifts not silently migrated; existing center-based attendance records preserved; backward compatibility and data mapping defined; optional and modular; no student data exposed across unauthorized centers. | DISCUSSION_APPROVED (design only; schema implementation needs separate approval) | Client | Exam module, staff, attendance | Design in `../architecture/examination-session-module.md`. Decisions ES-D1 to ES-D12; conflict C-22. | V |

## Superseded records

| Old | Replaced by | Note |
|---|---|---|
| Proposal revision 1 statuses: `under_review`, `correction_requested`, `shortlisted`, `accepted`, `withdrawn` | P-11 / D-15 | — |
| Proposal revision 1 "Staff later: `organization_members(member_role …)`" | P-10 / D-05 to D-08 | — |
| Proposal revision 1 and 2 categories `government_form` and `private_form` | N-01 (recommended, D-04 pending) | — |
| A-21, A-22 | A-08; A-02 to A-06 | — |
| `docs/policy/eltnoy-policy-register.md` | This register | IDs kept |
| `docs/architecture/opportunity-data-model-proposal.md` (revision 2) | `docs/architecture/data-model-final-proposal.md` | Kept for history |
