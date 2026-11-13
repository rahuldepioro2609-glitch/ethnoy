# Opportunity data model: architecture proposal

> **SUPERSEDED on 2026-11-03 by [`data-model-final-proposal.md`](data-model-final-proposal.md).** Revision 2 is kept for history. Its decisions D-01 to D-31 continue there, together with D-32 to D-34.

**Status:** PROPOSAL, revision 2, for review. Read-only design. No migration has been written or run, and no schema or record has changed. Internal only; do not publish or share externally.
**Scope:** Decision 4 (2026-11-03), sections 1–12. Revision 2 applies the decisions of 2026-11-03 on staff accounts, applicant statuses, payments, notifications and pending items.
**Authority:** Nothing here is approved for implementation until reviewed. Statuses follow the policy register:
- `DISCUSSION_APPROVED`: the direction is agreed; implementation still needs approval.
- `IMPLEMENTATION_APPROVED`: approved to build.
- `PENDING_CONFIRMATION`: undecided. These items must not be implemented or assumed.

### Pending decisions in this proposal

| ID | Decision | Status |
|---|---|---|
| D-01 | Feature-flag name and default (`OPPORTUNITIES_ENABLED=false`) | PENDING_CONFIRMATION |
| D-02 | Visibility options beyond public and unlisted (for example invite-only) | PENDING_CONFIRMATION |
| D-03 | Whether Super Admin can add categories or the list is fixed | PENDING_CONFIRMATION |
| D-04 | Whether "government" and "private" are categories or an organization attribute | PENDING_CONFIRMATION |
| D-05 | Staff accounts: individual verified accounts, custom roles, granular permissions, never Super Admin authority | **DISCUSSION_APPROVED** |
| D-06 | Adding a `staff` value to the `users.role` CHECK constraint, the only non-additive change in the design | PENDING_CONFIRMATION |
| D-07 | How a staff account is verified (channel and who confirms it) | PENDING_CONFIRMATION |
| D-08 | Permission catalogue contents and the default role templates | PENDING_CONFIRMATION |
| D-09 | Whether invigilators are limited to particular exam centers or sessions | PENDING_CONFIRMATION |
| D-10 | What a non-super `official` may see and do | PENDING_CONFIRMATION |
| D-11 | Named validation formats, replacing user-supplied regular expressions | PENDING_CONFIRMATION |
| D-12 | Form size limits (sections, fields, files, answer size) | PENDING_CONFIRMATION |
| D-13 | Format of the new application number | PENDING_CONFIRMATION |
| D-14 | Whether drafts expire | PENDING_CONFIRMATION |
| D-15 | Applicant status set: draft, submitted, payment pending, payment successful, under verification, correction required, resubmitted, approved, rejected. Module-specific statuses stay separate. | **DISCUSSION_APPROVED** |
| D-16 | Exact status transitions, including whether a correction can require a new payment | PENDING_CONFIRMATION |
| D-17 | Withdrawal by the applicant (not in the approved status set) | PENDING_CONFIRMATION |
| D-18 | Reusing one uploaded file across applications | PENDING_CONFIRMATION (do not implement) |
| D-19 | Retention and deletion periods for applicants' personal data | PENDING_CONFIRMATION (do not implement) |
| D-20 | Whether original file names are kept | PENDING_CONFIRMATION |
| D-21 | Supporting a primary and a backup payment gateway | **DISCUSSION_APPROVED** |
| D-22 | Which payment providers to use | PENDING_CONFIRMATION (client approval) |
| D-23 | Platform commission | PENDING_CONFIRMATION |
| D-24 | In-app notifications | **DISCUSSION_APPROVED** |
| D-25 | Email and SMS providers | PENDING_CONFIRMATION (approval required) |
| D-26 | Editing an opportunity after it's published, and changing its form | PENDING_CONFIRMATION |
| D-27 | Whether some organizations can publish without Super Admin review | PENDING_CONFIRMATION |
| D-28 | Turning the examination module on and off per organization | PENDING_CONFIRMATION |
| D-29 | Bridge from opportunity-based exam applications to the legacy `applications` table | PENDING_CONFIRMATION |
| D-30 | Backfilling the existing institute forms | PENDING_CONFIRMATION (do not implement) |
| D-31 | Row-level security as a further isolation layer | PENDING_CONFIRMATION |

## 0. Ground rules this design follows

1. **Additive only.** New tables only. No existing table, column, constraint or row changes, and none of these are touched: `applications`, `exams`, `admit_cards`, `online_exam_questions`, `online_exam_attempts`, `published_results`, `center_checkins`, `institute_forms`, or the institution and wallet tables.
2. **P0-4 is untouched.** Online exams keep starting from an approved row in the legacy `applications` table (`WHERE user_id = $1 AND exam_code = $2 AND status = 'approved'`).
3. **It reuses existing patterns:**
   - text IDs;
   - `timestamptz`;
   - money as `amount_paise bigint`;
   - append-only history enforced by triggers (as in `institute_status_history`, `institute_resubmissions` and `institution_document_versions`);
   - content-addressed file versions (as in `institution_document_versions`);
   - migrations that can be safely rerun (`CREATE … IF NOT EXISTS`, listed in `server/migrate.ts`).
4. **Isolation in the data.** Every organization-scoped row carries `organization_id`. Composite foreign keys stop a child row pointing at another organization's parent.
5. **Off by default.** The new surface ships behind `OPPORTUNITIES_ENABLED=false` (D-01: the flag name and default are undecided).

## 1. Proposed opportunity entity

`opportunities`: an organization's published call for applications.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `organization_id` | text NOT NULL → `users(id)` | The organization's account (`role = 'center'`, `account_status = 'approved'`, checked by the application). |
| `reference_code` | text UNIQUE | Public, URL-safe, for example `SCH-2027-00042`. |
| `category_code` | text NOT NULL → `opportunity_categories(code)` | |
| `title`, `summary`, `description`, `eligibility` | text with length CHECKs | The same style as `institute_forms`. |
| `apply_mode` | `in_platform` \| `external_link` | `external_link` preserves today's `institute_forms.external_url` behaviour. |
| `external_url` | text NULL | Required if and only if `apply_mode = 'external_link'`. |
| `opens_at`, `closes_at` | timestamptz | CHECK `closes_at > opens_at`. |
| `time_zone` | text, default `Asia/Kolkata` | Matches `exams.time_zone`. |
| `status` | see §9 | Lifecycle state. |
| `visibility` | `public` \| `unlisted` | Other options, such as invite-only, are undecided (D-02). |
| `current_form_version_id` | text NULL | The published form version (§4). |
| `max_applications_per_applicant` | smallint, default 1 | Mirrors today's one-application-per-exam rule. |
| `corrections_allowed` | boolean, default false | Plus `correction_window_days` (§7). |
| `created_by`, `created_at`, `updated_at`, `published_at`, `closed_at` | | |

Constraint: `UNIQUE (id, organization_id)`, so that child tables can use composite foreign keys.

**Open or closed is derived, not stored by a timer.** As in P0-4, "accepting applications" is computed from one database clock reading: `status = 'published' AND now() >= opens_at AND now() < closes_at`. This needs no background job, and there is no window where the stored status and the clock disagree.

## 2. Categories and types

`opportunity_categories` is a reference table controlled by the platform: `code` PK, `label`, `is_active`, `sort_order`, `requires_module` (nullable, for example `examination`).

Proposed seed values:

| code | Covers | Module |
|---|---|---|
| `examination` | exam application forms | `examination` (optional module) |
| `scholarship` | scholarships | none |
| `admission` | admissions | none |
| `job_vacancy` | jobs, vacancies, teacher recruitment | none |
| `government_form` | government organization forms | none |
| `private_form` | private organization forms | none |
| `custom` | anything else | none |

- A free-text `subtype` (for example "Teacher recruitment", "Post-matric scholarship") gives finer labels without schema changes.
- Whether Super Admin can add categories or the list is fixed in code is undecided (D-03).
- Whether "government" and "private" are categories or an attribute of the organization is undecided (D-04).

## 3. Organization ownership and data isolation

- **Today an organization is one login account** (`users.role = 'center'`). Phase 1 keeps that: `organization_id = users.id` of the center account. Nothing about institution approval changes.
- **Staff and invigilator accounts (D-05, DISCUSSION_APPROVED).** Every staff member or invigilator has their **own verified login**; organization accounts are never shared. Each organization defines **custom roles** made of **granular permissions**. No organization role can ever carry Super Admin or platform authority.
  - **The account (D-06, PENDING_CONFIRMATION).** Staff need their own `users` rows so that the existing sessions, password hashing and rate limits apply. That means adding a `staff` value to the `users.role` CHECK constraint, which is the only non-additive change in this design and needs its own approval.
    - The server's existing role checks (`requireRoles('center')` and `requireRoles('official')`) must **never** accept `staff`.
    - Staff reach organization data only through the permission checks below.
  - **`organization_members`:**
    - `id`, `organization_id` → the center account, `user_id` → the staff account, `UNIQUE (organization_id, user_id)`;
    - `status ∈ invited | active | suspended | removed`;
    - `verified_at` and `verification_method` (D-07, PENDING_CONFIRMATION);
    - `invited_by`, `created_at`.

    A member counts only when `status = 'active'` and `verified_at IS NOT NULL`.
  - **`organization_roles`:** `id`, `organization_id`, `name`, `description`, `created_by`, `UNIQUE (organization_id, name)`. Roles are custom per organization. Templates such as Reviewer, Verifier, Invigilator and Viewer can be offered (D-08).
  - **`organization_role_permissions`:** `role_id`, `permission_code`. A CHECK limits `permission_code` to a **fixed catalogue in code**, so nobody can invent a permission by writing a row.
  - **`organization_member_roles`:** `member_id`, `role_id`. A composite foreign key makes the member and the role belong to the same organization.
  - **`organization_member_scopes`** (optional, D-09): `member_id`, `scope_type ∈ exam_center`, `scope_value`. It would limit an invigilator to particular centers.
  - **Proposed permission catalogue** (D-08, PENDING_CONFIRMATION):
    - `opportunity.view`, `opportunity.draft`, `opportunity.submit_for_review`;
    - `application.view`, `application.view_documents`, `application.verify`, `application.request_correction`, `application.decide`;
    - `payment.view`, `payment.verify_offline`;
    - `exam.checkin.view`, `exam.checkin.record`;
    - `member.view`, `member.manage`, `audit.view`.
  - **Never grantable to an organization role**, because these stay with Super Admin:
    - approving organizations;
    - approving and publishing opportunities;
    - approving wallet withdrawals;
    - managing other organizations;
    - managing platform settings;
    - any Super Admin capability.
  - **Rules:**
    - The organization owner (the center account) holds every organization permission.
    - `member.manage` can't grant a permission the granting member doesn't hold.
    - Every change to membership, roles or permissions is written to `audit_events`.
- **Enforcement, in three layers:**
  1. Every org-scoped query goes through one authorization helper, which derives `organization_id` from the session and never from the request body. This extends the P0-3 pattern in `server/authorizationQueries.ts`.
  2. Composite foreign keys:
     - `opportunity_applications (opportunity_id, organization_id)` → `opportunities (id, organization_id)`;
     - `opportunity_form_versions (opportunity_id, organization_id)` → the same.

     This prevents a row being attached across organizations even if the application code is wrong.
  3. PostgreSQL row-level security as a further layer is undecided (D-31). It isn't recommended for Phase 1, because the app connects as a single database role.
- **Who sees what:**
  - Applicants see only their own applications.
  - An organization and its active, verified staff see only their own organization's data, limited further by each member's permissions and scopes.
  - Super Admin sees everything.
  - What a non-super `official` may see and do is undecided (D-10, PENDING_CONFIRMATION).

## 4. Dynamic form field schema

`opportunity_form_versions`: `id`, `opportunity_id`, `organization_id`, `version_number`, `schema jsonb`, `schema_sha256`, `status ∈ draft | published | superseded`, `created_by`, `created_at`, `published_at`.

- A version becomes **immutable once published** (trigger, as for document versions). Every application records the exact form version it answered.
- The schema is validated by a single zod definition shared by the server and the frontend (the pattern P0-4 used for scoring).

```jsonc
{
  "schemaVersion": 1,
  "sections": [{
    "key": "personal",                       // ^[a-z][a-z0-9_]{1,63}$, unique in the form
    "title": { "en": "Personal details", "hi": "…" },
    "fields": [{
      "key": "full_name",                    // stable answer key; never reused within a form
      "type": "short_text",                  // see the list of types below
      "label": { "en": "Full name" },
      "help": { "en": "As on your ID document" },
      "required": true,
      "validation": { "minLength": 2, "maxLength": 120 },
      "dataClass": "personal",               // none | personal | sensitive (drives export masking and retention)
      "profileBinding": "full_name",         // optional: prefill from the applicant profile
      "showIf": { "field": "category", "in": ["SC", "ST"] }   // optional, one level, no expressions
    }]
  }]
}
```

- **Field types:** `short_text`, `long_text`, `email`, `phone`, `number`, `date`, `single_select`, `multi_select`, `checkbox`, `declaration`, `file`, `note` (display only).
- **No user-supplied regular expressions**, to avoid regex denial-of-service and inconsistent behaviour. A fixed list of named formats is used instead (`pincode`, `aadhaar_last4`, `ifsc`, …) (D-11, PENDING_CONFIRMATION).
- **No executable expressions;** `showIf` is plain data.
- **Labels** take an optional map for the five existing UI languages (English, Hindi, Kannada, Bengali, Marathi).
- **Limits** (D-12, PENDING_CONFIRMATION; illustrative values): at most 20 sections, 150 fields and 10 files per form; at most 64 KB of answers per application.

## 5. Application submission model

`opportunity_applications` holds the current state of one applicant's application to one opportunity.

| Column | Notes |
|---|---|
| `id`, `application_number` UNIQUE | The format is undecided (D-13); it must not collide with legacy `applications.application_number`. |
| `opportunity_id`, `organization_id` | Composite FK (§3). |
| `applicant_user_id` → `users(id)` | `role = 'candidate'`. |
| `form_version_id` | The version answered. |
| `status` | See §7. |
| `answers jsonb` | The current answers, validated against `form_version_id`. |
| `current_version_number` | Points to the latest snapshot (§7). |
| `created_at`, `updated_at`, `submitted_at`, `status_changed_at` | |

- **Uniqueness:** a unique index on `(opportunity_id, applicant_user_id)` for active applications, when `max_applications_per_applicant = 1`. This mirrors the existing `applications_user_exam_idx`.
- **Drafts:** the applicant saves drafts before submitting. Whether drafts expire is undecided (D-14).
- **Submit:** one transaction:
  1. lock the row;
  2. check on the database clock that the opportunity is open;
  3. validate the answers against the form version;
  4. write a snapshot;
  5. write the status history.

  This is the P0-4 finalization pattern: lock, then read the clock, then a guarded `UPDATE`.
- **Storage:** answers are stored as `jsonb` (with a GIN index) rather than one row per field, because forms vary per opportunity and every submission is snapshotted anyway. Reporting columns can be added later as indexed views.

## 6. Documents and attachments

This follows the institution document pattern: the server detects the media type from file content, stores files with a size limit, a SHA-256 hash and a UUID storage key in a local storage directory, and keeps every version append-only.

- `applicant_files`:
  - `id`, `owner_user_id`, `storage_key` (UUID);
  - `detected_media_type` ∈ PDF/JPEG/PNG;
  - `file_size_bytes`, `content_sha256`, `uploaded_at`.

  Append-only.
- `opportunity_application_attachments`: `application_id`, `organization_id`, `version_number`, `field_key`, `file_id`.
  - It links a file to one specific submitted snapshot.
  - An organization can read a file **only** through an attachment row on its own application.
- **Reusing a file across applications (D-18): PENDING_CONFIRMATION, not to be implemented.** The design doesn't depend on the answer: each attachment row links one file to one submitted snapshot. Until reuse is decided, the application treats every upload as belonging to a single application.
- **Retention and deletion of personal data (D-19): PENDING_CONFIRMATION, not to be implemented.** No retention period, automatic deletion or anonymization is designed or assumed. The `dataClass` field marking (§4) only records which data is personal, so that an approved policy can later be applied.
- Whether original file names are kept is undecided (D-20).

## 7. Application status and correction history

**Applicant statuses (D-15, DISCUSSION_APPROVED):** `draft`, `submitted`, `payment_pending`, `payment_successful`, `under_verification`, `correction_required`, `resubmitted`, `approved`, `rejected`.

Proposed transitions (D-16, PENDING_CONFIRMATION):

| From | To | By |
|---|---|---|
| `draft` | `submitted` | applicant |
| `submitted` | `payment_pending` | system, when the fee is above zero |
| `submitted` | `under_verification` | system, when there is no fee |
| `payment_pending` | `payment_successful` | system, on a confirmed payment or a recorded offline verification |
| `payment_successful` | `under_verification` | system |
| `under_verification` | `correction_required` \| `approved` \| `rejected` | organization member with the right permission |
| `correction_required` | `resubmitted` | applicant |
| `resubmitted` | `under_verification` | system |

- **Behaviour:**
  - A failed payment leaves the application in `payment_pending`; the failure is recorded on the payment attempt (§8).
  - `approved` and `rejected` are final.
  - **Withdrawal** isn't in the approved status set, so it isn't designed (D-17).
- **Module-specific statuses** stay out of this list. Examples are an admit card becoming available or a result being published. They live in `opportunity_application_module_states(application_id, module_code, state, updated_at)`, owned by the module that sets them.
- **Testing:** the allowed transitions are a fixed table in code and are tested exhaustively, as P0-4 does for attempt states.

**Append-only history** (enforced by triggers, as in `institute_status_history`):
- **`opportunity_application_versions`:** `application_id`, `version_number`, `form_version_id`, `answers jsonb`, `answers_sha256`, `reason ∈ initial | correction_response`, `submitted_by`, `submitted_at`. One row per submission, never updated.
- **`opportunity_application_status_history`:**
  - `application_id`, `from_status`, `to_status`;
  - `actor_user_id`, `actor_kind ∈ applicant | organization | super_admin | system`;
  - `reason` (required when rejecting or requesting a correction, 10–1000 characters, as in institute decisions);
  - `decided_at`.
- **`opportunity_correction_requests`:**
  - `application_id`, `requested_by`, `field_keys text[]`, `message`, `due_at`;
  - `status ∈ open | responded | expired | cancelled` (applies while the application is `correction_required`);
  - `response_version_number`.

  The applicant may change only the listed fields. The server enforces that, so corrections can't silently rewrite other answers.

## 8. Payment and fee relationships

Collecting payment online needs a payment gateway, which is a third-party service and **requires client approval**. The proposal therefore separates the fee *definition* from *collection*.

- **`opportunity_fees`:**
  - `opportunity_id`, `amount_paise` (≥ 0), `currency` (`INR`);
  - `waiver_rules jsonb`, for example a fee by a `category` answer;
  - `refund_policy` text.

  A fee of zero is valid.
- **Primary and backup gateways (D-21, DISCUSSION_APPROVED; providers PENDING client approval, D-22).** The model is provider-neutral. No provider is named, integrated or configured.
  - **`payment_providers`:** `code`, `display_name`, `priority ∈ primary | backup`, `enabled`. **No credentials in the database:** gateway keys belong in the deployment's secret configuration and are never logged.
  - **`opportunity_payment_orders`:** one per application per amount due.
    - `id`, `application_id`, `organization_id`, `amount_paise`, `currency`;
    - `status ∈ open | paid | refunded | waived`;
    - `created_at`, `paid_at`.
  - **`opportunity_payment_attempts`:** one per try with one provider.
    - `order_id`, `provider_code`, `provider_order_ref`;
    - `idempotency_key` UNIQUE;
    - `status ∈ created | pending | succeeded | failed | expired`, `created_at`.
    - **Failover:** when the primary provider is unavailable, a new attempt is created with the backup.
    - **At most one success per order,** enforced by a partial unique index on `(order_id) WHERE status = 'succeeded'`. If a second attempt later reports success, it's flagged for refund and never double-counted.
  - **`opportunity_payment_events`:** an append-only log of provider callbacks.
    - Deduplicated on `(provider_code, provider_event_id)`.
    - It records whether the signature was verified. Only verified events change state.
  - **Offline verification** (`method = offline_verified`, by an organization member with `payment.verify_offline`) needs no provider and can be used before any gateway is approved.
- **Settlement:**
  - When a payment is confirmed, the organization is credited in the **existing** `institute_wallet_entries` table, with `payment_reference` set to the payment's reference.
  - The existing CHECK already requires `payment_reference` for credits, so the current wallet and withdrawal flow works unchanged.
  - Platform commission, if any, is undecided (D-23).
- **Phase 1 proposal:** fees of zero, plus offline payment verification. No gateway until providers are approved.

## 9. Approval and publishing workflow

```
draft ──submit──▶ pending_review ──approve──▶ approved ──publish──▶ published ──(closes_at passes)──▶ closed* ──▶ archived
   ▲                 │  │                                              │
   └──changes_requested┘  └──reject──▶ rejected                     withdraw ──▶ withdrawn
```
\* "closed" is derived from the clock (§1). Only `archived` and `withdrawn` are stored.

- Only an **approved** organization (`account_status = 'approved'`) can create or submit opportunities.
- **Super Admin reviews** before anything is published. This matches the existing moderation of `institute_forms` (`pending | approved | rejected`) and of institute profile changes.
- **`opportunity_review_history`** is append-only: who decided, the decision, a required reason when rejecting or requesting changes, and the time.
- **Edits after publishing (D-26, PENDING_CONFIRMATION):**
  - Wording edits go back to review as a pending revision, while the published version stays live.
  - Form-schema changes after the first submission are limited to adding optional fields, and they create a new form version. Existing applications stay tied to the version they answered.
- Whether some organizations can publish without Super Admin review is undecided (D-27).

## 10. Audit and notification relationships

- **`audit_events`** is a general, append-only log:
  - `id`, `occurred_at`;
  - `actor_user_id`, `actor_kind`, `organization_id` (nullable);
  - `action` (for example `opportunity.published`, `application.status_changed`, `file.downloaded`);
  - `entity_type`, `entity_id`;
  - `metadata jsonb`, which **must not contain answer values, documents or secrets**: IDs, codes and counts only. This follows the P0-4 logging rule.

  Downloads of applicant files by organizations are always audited.
- **`notifications`** are in-app only (D-24, DISCUSSION_APPROVED): `recipient_user_id`, `kind`, `entity_type`, `entity_id`, `title`, `body`, `created_at`, `read_at`.
  - Examples: applicant (submitted, correction requested, decision); organization (new application, review outcome); Super Admin (opportunity awaiting review).
- **`notification_deliveries`** is an outbox for email and SMS later. Provider integration needs approval (D-25, PENDING_CONFIRMATION). No row is written and no provider is contacted until then.
- Membership, role and permission changes, and status changes made by staff, are always written to `audit_events`.

## 11. Compatibility with existing examination applications

| Existing feature | Effect in Phase 1 |
|---|---|
| `applications` + `/api/applications` + admin review | **Unchanged.** Exam applications stay on the legacy path. |
| P0-4 online exams (`online_exam_attempts`, start, autosave, submit, recovery) | **Unchanged.** The start route still requires an approved legacy `applications` row. |
| Admit cards, answer keys, results, mock exams, center check-ins | **Unchanged.** All are keyed by the legacy `applications` row or `exam_code`. |
| `exams` (the public exam catalogue) | **Unchanged.** Optional link through `opportunity_exam_links(opportunity_id, exam_code)` so an exam can also be listed as an `examination` opportunity. |
| `institute_forms` (`exam_application`, `teacher_recruitment`, external link) | **Unchanged.** The backfill is PENDING_CONFIRMATION (D-30) and must not be implemented. If it's approved, a possible mapping is `teacher_recruitment` → `job_vacancy` and `exam_application` → `examination` as `external_link` opportunities. |
| Candidate dashboard | Phase 1 shows legacy exam applications and new opportunity applications in separate sections. A unified view comes later as a read-only union. |
| Institution approval, documents, wallet | **Unchanged.** Reused: the approval status gates creating opportunities, and the wallet receives settlements. |
| Center check-ins (today done by the center account) | **Unchanged.** Invigilators would use the same check-in routes through the `exam.checkin.*` permissions, once staff accounts are implemented. |
| `users.role` | **Unchanged in Phase 1,** unless D-06 is approved. |

**Making exams optional:** the examination module is enabled per organization (`organization_modules(organization_id, module_code, enabled)`; D-28). Exam menus and routes appear only when the module is enabled. The tables stay as they are.

**Later (not Phase 1), D-29:** exam applications could be made through the opportunity form. When such an application is approved, a bridge would write the legacy `applications` row in the same transaction, so admit cards and P0-4 keep working without changes. This is deferred because it touches the path P0-4 depends on.

## 12. Migration and backward-compatibility strategy

1. **One new migration file**, `server/opportunityMigration.sql`, appended to the fixed list in `server/migrate.ts`.
   - It only creates new tables, indexes, triggers and seed reference rows (`INSERT … ON CONFLICT DO NOTHING`).
   - It doesn't change any existing table.
   - Like the P0-2 fix, it runs in one transaction and can be safely run again.
2. **Validated first on a disposable PostgreSQL 17**, with the Phase 7 isolation rules:
   - run twice to prove it can be rerun;
   - check the append-only triggers;
   - check the cross-organization foreign-key rejection;
   - verify that every existing table's definition is byte-identical before and after.
3. **The feature flag stays off** until the API and UI pass review. With the flag off, the new tables exist but nothing reads or writes them.
4. **Rollback** means turning the flag off. No `DROP` is part of any production plan. Dropping the tables is allowed only on disposable databases.
5. **Backfills** are out of scope. The `institute_forms` backfill is PENDING_CONFIRMATION (D-30). Any future backfill would be a separate script with a dry-run mode and its own approval.
6. **Production migration** needs a separate production authorization, which this proposal doesn't ask for.

## Proposed Phase 1 cut (for approval)

- **In:**
  - categories;
  - opportunities with the in-platform and external-link modes;
  - form versions;
  - applications with the approved status set, snapshots, status history and corrections;
  - per-application attachments;
  - Super Admin review;
  - fees of zero plus offline payment verification;
  - the provider-neutral payment tables, with no provider;
  - audit events;
  - in-app notifications.
- **Phase 1b, after D-06, D-07 and D-08 are approved:**
  - staff and invigilator accounts;
  - organization roles and permissions;
  - permission-checked access for staff.
- **Out until decided:**
  - payment providers (D-22) and email or SMS providers (D-25);
  - reusing files across applications (D-18);
  - retention and deletion of personal data (D-19);
  - `institute_forms` backfill (D-30);
  - row-level security (D-31);
  - exam-through-opportunity bridge (D-29);
  - withdrawal (D-17).
