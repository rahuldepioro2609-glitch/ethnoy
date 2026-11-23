# S-1 audit infrastructure proposal (`audit_events`)

**Status:** DESIGN ONLY. Nothing here has been implemented, migrated or executed. Prepared 2026-11-04 against `rc/day1-baseline` at `df9b93e` (P0-3) on top of `5c8dd41` (P0-4). Internal; do not publish.

**Labels used throughout**

| Label | Meaning |
|---|---|
| **[APPROVED]** | Previously approved policy, cited by register ID. Not reopened here. |
| **[RECOMMENDED]** | Design recommendation from this proposal. Needs review, not a client decision. |
| **[CLIENT]** | Requires client approval before implementation. |
| **[ENG-VALIDATE]** | Requires engineering validation on a disposable PostgreSQL 17 environment before it is relied on. |

---

## 1. Executive summary

ELTNOY needs one platform audit trail (A-11, A-12, A-13; gap SEC-02). This proposal designs it as an append-only PostgreSQL table, `audit_events`, written **in the same transaction as the action it records**, readable **only by Super Admins**, and made **tamper-evident** (not immutable) by per-row hashes, a sealing chain and externally stored checkpoints.

The key findings and recommendations:

1. **The database role model must change first.** [RECOMMENDED][CLIENT] Today the API and the migration runner both connect as the Compose `POSTGRES_USER`, which the official `postgres` image creates as a **superuser**. A superuser ignores privileges and can disable triggers, so no database-side protection of the audit table means anything until the API runs as a separate, non-owner, non-superuser role. This is a deployment change and is the first dependency of S-1.
2. **Same-transaction writes for successful actions.** [APPROVED A-11] An action and its audit event commit or roll back together. Refused and failed actions are recorded separately (they have no business transaction to join), with a defined, non-silent fallback (§9.3).
3. **Text identifiers, no foreign keys.** [RECOMMENDED] All existing primary keys are `text` holding UUID strings. Audit references (`actor_user_id`, `organization_id`, `resource_id`) are `text` and deliberately **not** foreign keys, because an `ON DELETE SET NULL` or `CASCADE` would have to modify or delete audit rows. The audit row's own `id` is a native `uuid`.
4. **No secrets, no document content, minimal personal data.** [APPROVED A-11, S-05, E-07] Payloads are per-action allow-listed; passwords, OTPs, tokens, session data, raw payment credentials, exam answers and document contents are never stored.
5. **Tamper-evident integrity, honestly scoped.** [RECOMMENDED][ENG-VALIDATE] Database privileges and triggers stop the application and ordinary users. Per-row hashes, a sealing chain and checkpoints exported off the database host let tampering by a database operator be **detected**. They cannot **prevent** it. No design on a self-hosted database the operator controls is genuinely immutable.
6. **Retention is not decided.** [APPROVED A-13] No automatic deletion this release. The "seven-year" figure is an earlier proposal that is **not recorded anywhere in the repository** and is **not** approved policy; it needs client and legal approval (§8).
7. **The controlled document review panel for institution-approval Officials (P3-D5/P3-D10) stays blocked** until this mechanism is implemented, tested and separately approved (§6).
8. **Release 1 covers existing features only.** Staff management, the opportunity platform, payments, appeals and examination sessions are future extensions with reserved event names (§3).

---

## 2. Current architecture findings

Verified by reading the repository at `df9b93e` (no database was contacted).

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F-1 | **No audit table exists.** Important admin actions leave no platform record. | No `audit_events` in `server/schema.sql` or the two migration files; gap SEC-02 | S-1 is a new table plus integration work |
| F-2 | **The API connects as the database superuser.** | `docker-compose.yml:13` builds `DATABASE_URL` from `POSTGRES_USER`; the postgres image makes `POSTGRES_USER` a superuser; `npm run db:migrate` uses the same URL | Privileges and triggers cannot bind the application today (§4.1) |
| F-3 | **All primary keys are `text`.** | 22 `id text PRIMARY KEY` columns across `schema.sql` and both migrations; IDs are generated with `randomUUID()` | Audit references must be `text`; the audit row ID can still be `uuid` |
| F-4 | **An append-only pattern already exists.** | `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers on `institute_status_history`, `institute_resubmissions`, `institution_document_versions`, `institution_document_review_history`; immutability triggers on submission cycles and capabilities | Reuse the same pattern; it only works once F-2 is fixed |
| F-5 | **Migrations are one transaction with an advisory lock and must be rerunnable.** | `server/migrate.ts` (`MIGRATION_FILES`, `MIGRATION_ADVISORY_LOCK_KEY`) | The S-1 migration is a fourth, idempotent file appended to `MIGRATION_FILES` |
| F-6 | **Existing per-domain histories partially overlap.** | `institute_status_history`, `institution_document_review_history`, `institute_wallet_entries.created_by`, `institute_withdrawals.reviewed_by`, `applications.ownership_verified_*`, P0-4 `score.completion` | These stay authoritative for their domains; `audit_events` records *who did what* across domains, and does not replace them |
| F-7 | **No request or correlation ID.** No HTTP request logging. | No `request_id` in `server/*.ts`; gap SEC-03 | A request-ID middleware is a prerequisite for correlation (§9) |
| F-8 | **Only structured application logs exist,** mainly P0-4 online-exam events. | `online_exam.*` and `api.shutdown_*` log events | Logs are not an audit trail (not transactional, not access-controlled) |
| F-9 | **Client IP is available only behind a configured proxy.** | Since P1-B, `trust proxy` is a function that trusts only the direct peer when it is a configured proxy of either listener (`ELTNOY_PUBLIC_PROXY_CIDRS` / `ELTNOY_ADMIN_PROXY_CIDRS`, single addresses; `createExpressProxyTrust` in `server/surfaceEnforcement.ts`); `req.ip` is the address that proxy appended to `X-Forwarded-For` | `source_ip` is meaningful only behind a configured proxy that sets `X-Forwarded-For` (P1-C); collection needs approval (OD-3) |
| F-10 | **Some protected writes use single `pool.query` calls, not transactions.** | E.g. `PATCH /api/admin/results/:id`, `PATCH /api/admin/answer-keys/:examCode`, credits, feedback updates | Each integration point must move to an explicit transaction so the audit insert is atomic with the action |
| F-11 | **Super Admins and Officials are created only by the CLI.** | `server/createUser.ts` | Super Admin management events come from the CLI (actor type `operator`) in release 1 |
| F-12 | **P0-4 is accepted, committed code.** | `5c8dd41`; R-04, R-09 | Adding audit writes to P0-4 finalization changes accepted code and needs approval (C-10, X-08) |
| F-13 | **Documentation is not fully synchronized.** | The data-model proposal still lists `audit_events` with `before_state`/`after_state` and no integrity fields; it doesn't reflect P3-D5/P3-D10; the register still shows C-17 as open although P0-4 is committed | This proposal supersedes the data-model proposal's §4.7 `audit_events` row **only if approved**; no other document was edited |

---

## 3. Event taxonomy

### 3.1 Naming and envelope [RECOMMENDED]

- `category` is one of a closed set (below). `action` is `"<resource>.<verb>"`, lower case, for example `withdrawal.paid`.
- Every event has an `outcome`: `succeeded`, `denied` (authorization or policy refusal) or `failed` (validation or system error after authorization).
- `reason_code` is a short machine code from a per-action list, for example `maker_checker`, `approver_unknown`, `insufficient_super_admins`, `published_content_super_admin_only`. Free-text reasons supplied by people (for example a rejection reason) go in `metadata.reason_text`, length-limited, only where policy requires a reason.
- Each action has a **payload contract**: an allow-list of `metadata` keys with types. Anything outside the contract is rejected by the writer.

Categories: `auth`, `account`, `organization`, `permission`, `application`, `review`, `publishing`, `document`, `exam`, `finance`, `payment`, `admin`, `security`, `audit`, `operations`.

### 3.2 Release 1: existing features

"Txn" means the event is written in the same transaction as the action (A-11). "Separate" means it is written by the out-of-band writer (§9.3).

| Category | Action | Trigger point today | Write mode | Key metadata (allow-listed) |
|---|---|---|---|---|
| auth | `session.login_succeeded` | `POST /api/auth/login` | Txn with session insert | `account_role`, `login_method: password` |
| auth | `session.login_failed` | Same | Separate, rate-limited | `reason_code: invalid_credentials \| account_not_approved \| rate_limited`; **no** submitted login ID if the account doesn't exist (OD-3) |
| auth | `session.logged_out` | `POST /api/auth/logout` | Txn with revoke | — |
| account | `account.registered` | `POST /api/auth/register`, `POST /api/center/register` | Txn | `account_role`, `initial_status` |
| account | `account.created_by_operator` | `server/createUser.ts` | Txn (CLI) | `account_role`, `is_super_admin` |
| organization | `institution.approved` / `.rejected` | `PATCH /api/admin/institutes/:id` (A-01) | Txn with `institute_status_history` | `previous_status`, `new_status`, `reason_text?` |
| organization | `institution.resubmitted` | `POST /api/center/resubmit` | Txn | `submission_version` |
| organization | `institution.profile_change_decided` | `PATCH /api/admin/institute-profile-changes/:id` | Txn | `change_id`, `decision`, `changed_fields[]` (names only) |
| organization | `institution.form_decided` | `PATCH /api/admin/institute-forms/:id` | Txn | `form_id`, `decision` |
| application | `application.submitted` | `POST /api/applications` | Txn | `exam_code` |
| application | `application.status_changed` | `PATCH /api/admin/applications/:id` | Txn | `previous_status`, `new_status` |
| application | `application.ownership_linked` | `POST …/verify-ownership` (A-15) | Txn | `verification_method`, `candidate_user_id` |
| publishing | `results.imported` / `result.written` | Results import / POST (A-04) | Txn | `exam_code`, `row_count`, `corrected_published_count` |
| publishing | `result.publication_changed` | `PATCH /api/admin/results/:id` | Txn | `is_published` |
| publishing | `answer_key.imported` / `.publication_changed` | Answer-key routes (A-05) | Txn | `exam_code`, `row_count`, `returned_to_draft` |
| publishing | `online_exam.imported` / `.publication_changed` | Online-exam routes (A-05) | Txn | `exam_code`, `row_count`, `returned_to_draft` |
| publishing | `admit_cards.imported` / `admit_card.assigned` | Admit-card routes (A-06) | Txn | `exam_code`, `row_count` |
| publishing | `exam_form.created` / `.publication_changed`, `notice.created` / `.publication_changed` | Exam and notice routes | Txn | `exam_code` or `notice_id`, `is_published` |
| document | `document.uploaded` | Center upload routes | Txn with version insert | `document_id`, `version_id`, `category`, `media_type`, `size_bytes`, `content_sha256` |
| document | `document.content_viewed` | Super Admin content route (A-09, P3-D10) | Separate (read, no business txn) | `version_id`, `mode: preview \| download` |
| document | `document.review_recorded` | Super Admin review route (A-09) | Txn with review history | `version_id`, `decision_code?` |
| exam | `checkin.recorded` | `POST /api/center/checkins` | Txn | `application_id`, `status` |
| exam | `online_exam.finalized` | P0-4 finalization | **Not in release 1 unless C-10 is approved** | `reason`, `finalized_by` (never answers or score contents, E-07) |
| finance | `wallet.credited` | Credits route (A-02) | Txn with ledger insert | §7 |
| finance | `withdrawal.requested` / `.approved` / `.rejected` / `.paid` | Withdrawal routes (A-03) | Txn with ledger change | §7 |
| admin | `helpdesk.ticket_updated` | `PATCH /api/admin/feedback/:id` (A-14) | Txn | `previous_status`, `new_status` |
| admin | `data_export.generated` | `GET /api/admin/data-export` (A-07) | Separate, before streaming | `sheet_names[]`, `row_counts{}` |
| security | `authorization.denied` | `requireSuperAdmin` refusals on Super Admin routes | Separate, aggregated (§9.4) | `route_pattern`, `method`, `required: super_admin` |
| audit | `audit.searched` / `audit.exported` | Audit viewer (§5) | Separate | `filters` (allow-listed), `result_count` |

### 3.3 Future extensions (names reserved, not built)

| Area | Reserved actions | Blocked by |
|---|---|---|
| Staff and Super Admin management | `staff.invited`, `staff.otp_verified` (never the OTP), `staff.activated`, `staff.suspended`, `staff.removed`, `staff.sessions_revoked`, `super_admin.granted` / `.revoked` | Q115/Q116 (DISCUSSION_APPROVED), D-06, C-18 (SMS), A-10 milestone |
| Roles and permissions | `role.created` / `.changed`, `permission.granted` / `.revoked`, `assignment.created` / `.reassigned` | D-08, Q117–Q119 |
| Opportunity platform | `opportunity.created`, `opportunity.published`, `form.version_published` | Opportunity milestones, PERM-04 |
| Application lifecycle | `application.decided`, `application.appealed`, `appeal.decided`, `application.reopened`, `decision.overridden`, `application.withdrawn` | Q118–Q125, M-16–M-19 |
| Payments | `payment.initiated`, `payment.callback_verified`, `payment.reconciled`, `refund.requested` / `.approved` / `.paid`, `settlement.*` | P-15/D-21 provider approval, M-07, C-02 |
| Examination sessions | `exam_session.*`, `exam_assignment.*`, `attendance.recorded`, `incident.reported` | ES-D1–ES-D12, C-22 |
| Document review panel | `document.review_panel_opened`, `document.page_viewed` | P3-D5 (§6) |
| Security incidents | `incident.opened`, `incident.updated`, `incident.closed` | Incident process (OD-9) |
| Operations | `backup.completed` / `.failed`, `restore.started` / `.completed`, `deployment.applied`, `migration.applied`, `audit.seal_verified` / `.verification_failed` | Operator tooling; M-10 |

---

## 4. SQL proposal

**Do not run this.** It is a design artefact for review. [RECOMMENDED][ENG-VALIDATE] It must be validated on a disposable PostgreSQL 17 database before any approval to migrate.

### 4.1 Roles (prerequisite, deployment change) [CLIENT][ENG-VALIDATE]

```sql
-- Owner of all application objects. NOLOGIN: used only through SET ROLE by the migration login.
CREATE ROLE eltnoy_owner NOLOGIN;
-- Migration login: member of the owner role. Used only by the migration job, never by the API.
CREATE ROLE eltnoy_migrator LOGIN IN ROLE eltnoy_owner;
-- API runtime login: no ownership, no superuser, no CREATE on schemas.
CREATE ROLE eltnoy_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- Optional, recommended: an integrity verifier that can only read audit tables.
CREATE ROLE eltnoy_audit_verifier LOGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO eltnoy_app, eltnoy_audit_verifier;
```

Today every table is owned by the Compose superuser. Moving ownership to `eltnoy_owner` (`ALTER TABLE … OWNER TO`) and granting `eltnoy_app` the existing business privileges is a separate, carefully rehearsed migration (§10, phase 1a). **Until it is done, everything in §4.3 and §4.4 is advisory only.**

### 4.2 Table

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                  bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  occurred_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_started_at timestamptz NOT NULL DEFAULT now(),
  schema_version       smallint    NOT NULL DEFAULT 1 CHECK (schema_version >= 1),

  category             text        NOT NULL CHECK (category IN (
                         'auth','account','organization','permission','application','review','publishing',
                         'document','exam','finance','payment','admin','security','audit','operations')),
  action               text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(action) <= 80),
  outcome              text        NOT NULL CHECK (outcome IN ('succeeded','denied','failed')),
  reason_code          text        CHECK (reason_code IS NULL OR (reason_code ~ '^[a-z][a-z0-9_]*$' AND length(reason_code) <= 64)),

  actor_type           text        NOT NULL CHECK (actor_type IN ('user','system','operator','anonymous')),
  actor_user_id        text,       -- users.id (text UUID); deliberately NOT a foreign key
  actor_role           text        CHECK (actor_role IS NULL OR actor_role IN (
                         'candidate','center','official','super_admin','staff','system','operator')),
  organization_id      text,       -- users.id of the institution today; organizations.id later; NOT a foreign key

  resource_type        text        NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]*$' AND length(resource_type) <= 64),
  resource_id          text        CHECK (resource_id IS NULL OR length(resource_id) <= 200),

  request_id           uuid,       -- one per HTTP request (F-7 prerequisite)
  correlation_id       uuid,       -- groups related events across requests or jobs
  source_ip            inet,       -- only for categories approved in OD-3; NULL otherwise
  user_agent_summary   text        CHECK (user_agent_summary IS NULL OR length(user_agent_summary) <= 120),

  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  before_state         jsonb,      -- changed fields only, allow-listed per action
  after_state          jsonb,

  retention_class      text        NOT NULL CHECK (retention_class IN ('security','financial','governance','access','operational')),

  row_hash             bytea       NOT NULL,     -- set by trigger (§4.4); client-supplied values are overwritten
  CONSTRAINT audit_events_actor_consistency CHECK (
    (actor_type = 'user'      AND actor_user_id IS NOT NULL AND actor_role IS NOT NULL) OR
    (actor_type = 'operator'  AND actor_role = 'operator') OR
    (actor_type = 'system'    AND actor_user_id IS NULL AND actor_role = 'system') OR
    (actor_type = 'anonymous' AND actor_user_id IS NULL AND actor_role IS NULL)),
  CONSTRAINT audit_events_reason_for_refusals CHECK (outcome = 'succeeded' OR reason_code IS NOT NULL),
  CONSTRAINT audit_events_json_shapes CHECK (
    jsonb_typeof(metadata) = 'object'
    AND (before_state IS NULL OR jsonb_typeof(before_state) = 'object')
    AND (after_state  IS NULL OR jsonb_typeof(after_state)  = 'object')),
  CONSTRAINT audit_events_payload_size CHECK (
    pg_column_size(metadata) <= 8192
    AND coalesce(pg_column_size(before_state), 0) <= 8192
    AND coalesce(pg_column_size(after_state), 0)  <= 8192),
  -- Defence in depth only; the writer's per-action allow-list is the real control.
  CONSTRAINT audit_events_no_secret_keys CHECK (NOT (
    metadata ?| ARRAY['password','password_hash','otp','token','session_token','token_hash','cookie',
                      'secret','api_key','card_number','cvv','upi_pin','responses','answers','file_content'])),
  CONSTRAINT audit_events_hash_length CHECK (octet_length(row_hash) = 32)
);
```

Notes:
- `occurred_at` uses `clock_timestamp()` (the actual write time); `transaction_started_at` uses `now()`. Both are `timestamptz`, stored in UTC; display converts. [RECOMMENDED]
- `seq` orders events for sealing and verification. Sequence gaps are normal (rolled-back transactions), so gaps alone never prove deletion; the seal chain does (§4.4).
- Actor display names and login IDs are **not** copied into the row (data minimization). The viewer resolves them at read time from `users` and shows "unknown account" if one no longer exists. [RECOMMENDED][CLIENT OD-4]
- `user_agent_summary` is a reduced form (browser family and major version, OS family), never the raw header. [CLIENT OD-3]

### 4.3 Privileges [RECOMMENDED][ENG-VALIDATE]

```sql
ALTER TABLE audit_events OWNER TO eltnoy_owner;
REVOKE ALL ON audit_events FROM PUBLIC;
GRANT INSERT (category, action, outcome, reason_code, actor_type, actor_user_id, actor_role, organization_id,
              resource_type, resource_id, request_id, correlation_id, source_ip, user_agent_summary,
              metadata, before_state, after_state, retention_class, schema_version)
  ON audit_events TO eltnoy_app;          -- no id, seq, occurred_at or row_hash: those are server-assigned
GRANT SELECT ON audit_events TO eltnoy_app, eltnoy_audit_verifier;
-- No UPDATE, DELETE or TRUNCATE for anyone except the owner, and the owner is blocked by triggers.
```

The API needs `SELECT` for the Super Admin viewer. A-12 (Super Admin-only reads) is enforced in the application by `requireSuperAdmin`, because the database cannot tell a Super Admin request from an ordinary one on a pooled connection. [APPROVED A-12, A-19]

### 4.4 Append-only and integrity triggers [RECOMMENDED][ENG-VALIDATE]

```sql
CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();

-- Per-row content hash over a canonical text form. Overwrites anything the client supplied.
-- pgcrypto is not needed: sha256(bytea) is built in from PostgreSQL 11.
CREATE OR REPLACE FUNCTION audit_events_set_row_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_hash := sha256(convert_to(concat_ws(E'\x1f',
      NEW.id::text, NEW.seq::text, to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      NEW.schema_version::text, NEW.category, NEW.action, NEW.outcome, coalesce(NEW.reason_code, ''),
      NEW.actor_type, coalesce(NEW.actor_user_id, ''), coalesce(NEW.actor_role, ''), coalesce(NEW.organization_id, ''),
      NEW.resource_type, coalesce(NEW.resource_id, ''), coalesce(NEW.request_id::text, ''),
      coalesce(NEW.correlation_id::text, ''), coalesce(host(NEW.source_ip), ''), coalesce(NEW.user_agent_summary, ''),
      NEW.metadata::text, coalesce(NEW.before_state::text, ''), coalesce(NEW.after_state::text, ''), NEW.retention_class),
    'UTF8'));
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_row_hash BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_set_row_hash();
```

`jsonb::text` is deterministic for a given `jsonb` value, which makes the canonical form reproducible. [ENG-VALIDATE] Verify this, including across major-version upgrades, before relying on it.

**Sealing chain.** A strict hash chain written inside each business transaction would need one global lock held until commit, which would serialize every audited action on the platform. Instead, a separate **sealer** links committed events after the fact. [RECOMMENDED][ENG-VALIDATE]

```sql
CREATE TABLE IF NOT EXISTS audit_event_seals (
  seal_seq    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    uuid        NOT NULL UNIQUE,            -- audit_events.id (not a FK, same reasoning)
  event_seq   bigint      NOT NULL,
  row_hash    bytea       NOT NULL CHECK (octet_length(row_hash) = 32),
  chain_hash  bytea       NOT NULL CHECK (octet_length(chain_hash) = 32),  -- sha256(previous chain_hash || row_hash)
  sealed_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  checkpoint_id   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  last_seal_seq   bigint      NOT NULL,
  chain_hash      bytea       NOT NULL CHECK (octet_length(chain_hash) = 32),
  event_count     bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Both tables get the same append-only triggers. Only a dedicated sealer role may INSERT into them.
```

- The sealer is one process, holding a session advisory lock so only one instance runs. Every N seconds it seals unsealed events older than a settle window (for example 30 s), in `seq` order.
- An event committed late, after higher `seq` values were already sealed, is still sealed in a later batch. The chain is in **sealing order**, so nothing is skipped.
- Deleting, changing or reordering a sealed event, or deleting a seal row, breaks the recomputed chain. Gaps are detectable because `seal_seq` advances only on committed inserts.
- **Window of exposure:** an event deleted by a database operator *before* it is sealed (inside the settle window) is not detected by the chain. Detection there relies on the business-table cross-checks in §8.4.
- **Checkpoints** (for example hourly) record the latest `chain_hash` and count. Each checkpoint is also **exported off the database host** to a medium controlled by someone other than the database operator. Without that export, an operator could rewrite the whole chain. The export target needs client approval (OD-6); no SaaS is assumed (S-07, S-12).

### 4.5 Indexes [RECOMMENDED][ENG-VALIDATE]

```sql
CREATE INDEX IF NOT EXISTS audit_events_occurred_brin   ON audit_events USING brin (occurred_at);
CREATE INDEX IF NOT EXISTS audit_events_recent          ON audit_events (occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS audit_events_actor           ON audit_events (actor_user_id, occurred_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_organization    ON audit_events (organization_id, occurred_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_resource        ON audit_events (resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action          ON audit_events (category, action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_refusals        ON audit_events (occurred_at DESC) WHERE outcome <> 'succeeded';
CREATE INDEX IF NOT EXISTS audit_events_request         ON audit_events (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_event_seals_event_seq  ON audit_event_seals (event_seq);
```

No GIN index on `metadata` in release 1. The viewer filters on the typed columns; JSON search is added only if real queries need it. Each index costs write throughput, so the set should be trimmed after measuring actual viewer queries.

### 4.6 Partitioning [RECOMMENDED]

**Not in release 1.** Monthly range partitioning on `occurred_at` mainly pays off for dropping or archiving old partitions, and A-13 forbids automatic deletion this release. Partitioning also forces the primary key to include `occurred_at` and complicates the uniqueness of `id` and `seq`.

Revisit when any of these is true:
- the table exceeds about 50 million rows or 50 GB;
- the retention decision (OD-1) requires per-period archiving;
- index maintenance or vacuum time on the table becomes operationally significant.

Converting later is a planned maintenance operation: create the partitioned table, copy in `seq` order, re-verify the chain, then swap. [ENG-VALIDATE]

### 4.7 Query examples

```sql
-- Recent activity (keyset pagination, newest first)
SELECT id, occurred_at, category, action, outcome, reason_code, actor_user_id, actor_role, resource_type, resource_id
FROM audit_events
WHERE (occurred_at, id) < ($1, $2)
ORDER BY occurred_at DESC, id DESC
LIMIT 100;

-- Full history of one withdrawal
SELECT occurred_at, action, outcome, reason_code, actor_user_id, actor_role, metadata
FROM audit_events
WHERE resource_type = 'withdrawal' AND resource_id = $1
ORDER BY occurred_at;

-- Refused financial actions in a period
SELECT occurred_at, action, reason_code, actor_user_id, resource_id
FROM audit_events
WHERE category = 'finance' AND outcome <> 'succeeded' AND occurred_at >= $1 AND occurred_at < $2
ORDER BY occurred_at DESC;

-- Everything a given Super Admin did in a period
SELECT occurred_at, category, action, outcome, resource_type, resource_id
FROM audit_events
WHERE actor_user_id = $1 AND occurred_at >= $2 AND occurred_at < $3
ORDER BY occurred_at DESC;

-- Every document content view by anyone, newest first
SELECT occurred_at, actor_user_id, actor_role, resource_id, metadata->>'mode' AS mode
FROM audit_events
WHERE category = 'document' AND action = 'document.content_viewed'
ORDER BY occurred_at DESC LIMIT 200;
```

### 4.8 Data growth [ENG-VALIDATE]

Estimate: a typical row is 0.6–1.5 KB including TOAST-free JSON. Indexes add about 1–1.5 times the heap, giving **about 1.5–3.5 KB per event on disk**.

| Events per day | Rows per year | Approx. storage per year |
|---|---|---|
| 10,000 | 3.7 M | 5–13 GB |
| 100,000 | 37 M | 55–130 GB |
| 1,000,000 | 365 M | 0.5–1.3 TB (partitioning and archiving required) |

Drivers are logins, application submissions and document views. Aggregating `authorization.denied` (§9.4) and rate-limiting `session.login_failed` keep abuse from inflating the table. Measure real per-event size on the disposable environment before capacity planning.

---

## 5. Authorization matrix

| Capability | Who | Mechanism | Status |
|---|---|---|---|
| Create events | **Server code only**, through one writer module; the CLI (`operator`) and the sealer (`system`) for their own events | `eltnoy_app` has column-limited `INSERT`; no HTTP endpoint accepts client-supplied audit events | [RECOMMENDED] |
| Read events (viewer) | **Super Admin only** | `requireAuth, requireRoles('official'), requireSuperAdmin` on every audit route | [APPROVED A-12] |
| Search and filter | Super Admin only | Same guard; allow-listed filters only (date range, category, action, outcome, actor, organization, resource) | [APPROVED A-12][RECOMMENDED] |
| Export | Super Admin only, bounded (for example ≤ 50,000 rows per export, date range required) | Same guard, plus an `audit.exported` event **written before** the file is streamed | [APPROVED A-12][CLIENT OD-7 for format and limits] |
| Review security incidents | Super Admin only | Same guard; incident workflow is a future extension | [APPROVED A-12][CLIENT OD-9] |
| Organization activity view | **Nobody in release 1.** A filtered view of the organization's own staff actions would need explicit approval | C-03: drop `audit.view` from the permission catalogue | [CLIENT C-03] |
| Ordinary Officials, staff, centers, candidates | No access | 403 before any query (the P0-3 pattern) | [APPROVED A-12, A-19] |
| Database operators | Direct database access is out of band and **not** controlled by the application | Mitigated by role separation, operational procedure and off-host checkpoints (§4.4) | [CLIENT OD-6] |

**No recursion.** [RECOMMENDED] Reading the audit log writes **one** `audit.searched` (or `audit.exported`) event per request, recording the allow-listed filters and the result count, not the rows returned. PostgreSQL has no `SELECT` triggers and the writer is never invoked by a read of `audit_events` itself, so a search can't trigger further searches. The viewer shows its own access events like any others.

---

## 6. Document access integration (P3-D5 / P3-D10)

| Item | Status |
|---|---|
| Generic document preview and download stay **Super Admin-only** (route `GET /api/admin/institution-documents/versions/:versionId/content`, `requireSuperAdmin`) | [APPROVED A-09, P3-D10; implemented in `df9b93e`] |
| Each Super Admin content view writes `document.content_viewed` (`mode: preview \| download`) | [RECOMMENDED], release 1 phase 5 |
| Institution-approval Officials may **eventually** use a controlled, read-only in-app review panel | [APPROVED P3-D5 as a direction] |
| No download and no direct file URL for these Officials | [APPROVED P3-D5] |
| Access limited to **assigned** institution-approval work | [APPROVED P3-D5]. **No assignment model exists today** for institution approval (A-01 lets every Official approve), so a new assignment concept is needed first [CLIENT OD-10] |
| Every panel open and page view is audited | [APPROVED P3-D5] |
| The feature stays **blocked** until this audit mechanism is implemented, tested and separately approved | [APPROVED] |

Recommended panel design, for later approval only:
- A separate route, `GET /api/admin/institution-review/:assignmentId/documents/:versionId/render`. It checks: Official role, an active assignment for that institution, and a document version belonging to that institution.
- It returns rendered page images (server-side rasterized PDF pages or re-encoded images) with `Content-Disposition: inline`, `Cache-Control: no-store` and a watermark showing the viewer and the time. It never returns the original bytes.
- **Audit-before-serve:** the `document.page_viewed` event is inserted and committed **before** the content is sent. If the insert fails, nothing is served (fail closed).
- Honest limitation: an Official can still photograph the screen. The controls make copying harder and **attributable**, not impossible. [CLIENT OD-10]
- Server-side rasterization is a new dependency (for example a PDF renderer) and needs separate approval (S-07 does not apply to local libraries, but M-13-style dependency review does). [CLIENT][ENG-VALIDATE]

---

## 7. Financial event contracts

**The financial ledger stays authoritative.** [APPROVED A-11 principle][RECOMMENDED] Balances come only from `institute_wallet_entries` and `institute_withdrawals`. `audit_events` records who did what and why; it is never summed, and a mismatch between them is an integrity alarm, not a reason to change the ledger.

All successful financial events are written **in the same transaction** as the ledger change (A-11). Refusals and failures use the separate writer (§9.3). Amounts are integers in paise (E-07 rule: no unnecessary personal data).

| Action | When | `resource_type` / `resource_id` | Metadata contract (all keys required unless marked `?`) | Outcome / reason codes |
|---|---|---|---|---|
| `wallet.credited` | Super Admin records a verified credit | `wallet_entry` / entry ID | `institute_id`, `amount_paise`, `payment_reference`, `ledger_entry_id` | `succeeded`; `denied: not_super_admin`; `failed: duplicate_payment_reference` |
| `withdrawal.requested` | Institution requests a withdrawal | `withdrawal` / ID | `institute_id`, `amount_paise`, `available_paise_at_request` | `succeeded`; `failed: insufficient_balance` |
| `withdrawal.approved` | Super Admin approves (maker) | `withdrawal` / ID | `institute_id`, `amount_paise`, `previous_status: pending`, `approver_user_id` | `succeeded`; `failed: invalid_transition` |
| `withdrawal.rejected` | Super Admin rejects before payment | `withdrawal` / ID | `institute_id`, `amount_paise`, `previous_status`, `rejected_by_user_id`, `was_approver?` (boolean), `reason_text?` | `succeeded`; `failed: invalid_transition` |
| `withdrawal.paid` | A different Super Admin marks paid (checker) | `withdrawal` / ID | `institute_id`, `amount_paise`, `approver_user_id`, `payer_user_id`, `transfer_reference`, `debit_entry_id`, `active_super_admins` | `succeeded` |
| `withdrawal.payment_refused` | Payment refused by policy | `withdrawal` / ID | `institute_id`, `amount_paise`, `approver_user_id?` | `denied`: `maker_checker`, `approver_unknown`, `insufficient_super_admins`, `invalid_transition` |
| `withdrawal.payment_failed` | Payment rolled back by the database | `withdrawal` / ID | `institute_id`, `amount_paise`, `sqlstate` | `failed`: `duplicate_transfer_reference`, `concurrent_update`, `database_error` |
| `wallet.adjusted` / `wallet.reversed` (future) | Corrections or reversals, if ever approved | `wallet_entry` / new entry ID | `reverses_entry_id`, `amount_paise`, `reason_text`, maker and checker IDs | Needs a reversal policy first [CLIENT OD-8] |
| `payment.*`, `refund.*`, `settlement.*` (future) | Gateway or offline payments | `payment` / ID | `provider`, `provider_reference`, `amount_paise`, `status`; **never** card numbers, CVV, UPI PINs or full account numbers | Blocked by provider approval (P-15, D-21, S-07) and refund policy (M-07) |

**Maker-checker identity.** [APPROVED A-03] `approver_user_id` and `payer_user_id` are both recorded on `withdrawal.paid`, and the writer asserts they differ before inserting. The ledger already holds the payer (`created_by`) and the approver (`reviewed_by`, preserved since `df9b93e`). The audit row makes that pairing visible in one place.

**Failed and reversed operations.** A rolled-back business transaction cannot keep a same-transaction audit row; that is inherent to A-11's design. The handler therefore records `*_refused` and `*_failed` events through the separate writer **after** the rollback (§9.3). Reversal of a completed payment is a new ledger entry plus its own event; nothing is ever edited in place.

---

## 8. Retention, backup and recovery

### 8.1 Retention [APPROVED A-13][CLIENT OD-1]

- **Approved:** append-only; no automatic deletion this release; retention is a future client decision (A-13, M-09).
- **Not approved:** a seven-year retention period. It is an earlier proposal; **no repository document records it**. It must not be implemented without approval.
- The schema carries `retention_class` (`security`, `financial`, `governance`, `access`, `operational`) so different periods can be applied later without reclassifying history.
- **Legal and client confirmation needed** (this proposal does not give legal advice). The client's counsel should confirm which obligations apply. Likely candidates for an Indian platform include:
  - the Digital Personal Data Protection Act, 2023 (purpose limitation and erasure versus retention of personal data in audit rows);
  - the CERT-In Directions of 28 April 2022 (ICT system log retention, commonly read as 180 days within India);
  - statutory retention of financial books and records for the financial categories.
- Any future deletion or archival of expired events must itself be an audited, Super Admin-initiated, checkpointed operation, never a silent job.

### 8.2 Backup inclusion [RECOMMENDED][CLIENT M-10]

- `audit_events`, `audit_event_seals` and `audit_checkpoints` are in every database backup, in the same consistent snapshot as the business tables.
- Exported checkpoints (§4.4) are kept **separately** from database backups, so a restore can be verified against them.
- Backup location, encryption at rest and off-site copies remain M-10 decisions. No cloud storage is assumed (S-12).

### 8.3 Recovery verification [RECOMMENDED][ENG-VALIDATE]

After any restore, before the application is reopened:
1. Recompute every `row_hash` from the row contents.
2. Recompute the seal chain from `audit_event_seals`.
3. Compare the latest restored checkpoint with the off-host checkpoint copies.
4. Record `restore.completed` with the verification result (`operations` category, actor `operator`).
5. Expect missing events after a point-in-time restore: everything after the restore point is legitimately lost. The off-host checkpoints show how much.

### 8.4 Integrity checks [RECOMMENDED]

| Check | Frequency | Alarm on |
|---|---|---|
| Row-hash recomputation over newly sealed events | Every sealing run | Any mismatch |
| Full chain verification | Daily (verifier role, read-only) | Break, gap in `seal_seq`, mismatch with the latest exported checkpoint |
| Unsealed backlog | Every minute | Events older than the settle window plus a margin still unsealed |
| Ledger cross-check | Daily | A `withdrawal.paid` without a matching debit entry, or a paid withdrawal without a `withdrawal.paid` event (from the S-1 go-live date) |
| Trigger presence | Daily | Any of the append-only triggers missing or disabled (`pg_trigger.tgenabled`) |
| Privilege drift | Daily | `eltnoy_app` gaining `UPDATE`, `DELETE`, `TRUNCATE` or ownership on audit tables |

Verification failures are written as `audit.verification_failed` events **and** sent through the monitoring channel approved under M-10, because an attacker who can tamper with the table could also suppress events inside it.

### 8.5 Storage growth monitoring [RECOMMENDED]

Track daily row counts and on-disk size per table and index (`pg_total_relation_size`), events per category, and the partitioning thresholds from §4.6. Alert when growth exceeds the planned envelope by a set margin.

---

## 9. Performance and operations

### 9.1 Write path [RECOMMENDED]

- One writer module, `server/audit.ts` (future), exposing `recordAuditEvent(client, event)`. It **requires** a transaction client: it refuses to run on the pool for `succeeded` events, so a same-transaction write can't be skipped by accident.
- The writer validates the event against its action's payload contract, then performs a single `INSERT … RETURNING id`. The insert is small and indexed; expected cost is about a millisecond. [ENG-VALIDATE]
- Handlers that use single `pool.query` calls today (F-10) are converted to explicit `BEGIN … COMMIT` transactions as they are integrated.

### 9.2 Atomicity for critical actions [APPROVED A-11][RECOMMENDED]

For financial, approval, publishing, permission and document-access actions, **the audit insert happens inside the business transaction and its failure aborts the action.** This is how no record is silently lost: if the event can't be written, the money doesn't move and the content isn't published. The user receives a 500 with the existing generic message, and the failure is logged. This trades availability for auditability, deliberately.

### 9.3 Refused and failed actions (separate writer) [RECOMMENDED][ENG-VALIDATE]

- After a business rollback, the handler calls `recordAuditEventStandalone(event)`. That runs a short transaction of its own on a pooled connection, with a statement timeout (for example 2 s).
- If that write fails, the event is written as a structured log line marked `audit.write_failed`, containing the same allow-listed fields, and a metric is incremented. The log line follows the S-05 and E-07 rules.
- These are refusals of actions that did **not** happen, so losing one is a monitoring problem, not a missing record of a state change. The alert threshold on `audit.write_failed` should be zero.
- **No asynchronous queue in release 1.** A queue adds delivery, retry and ordering problems without benefit at the expected volume. Revisit only if write latency becomes measurable.

### 9.4 Volume control [RECOMMENDED][CLIENT OD-5]

- `authorization.denied`: recorded for Super Admin-only routes. Repeated denials for the same actor, route and outcome within 60 s are aggregated into one event with a `count`.
- `session.login_failed`: recorded per attempt up to the existing rate limit. Beyond it, one aggregated event per window.
- Read events (`document.content_viewed`, `audit.searched`): one per request, never per row.

### 9.5 Monitoring and alerting [RECOMMENDED][CLIENT M-10, S-07]

Metrics:
- audit insert latency (p50 and p99);
- `audit.write_failed` count;
- unsealed backlog;
- seal and verification status;
- events per category per hour;
- table and index size.

Alert channels must use locally hosted tooling; no SaaS without approval (S-07).

### 9.6 Query performance [RECOMMENDED]

- Keyset pagination only (no `OFFSET`).
- A mandatory date range for searches, defaulting to 7 days and capped at, for example, 93 days per query.
- Indexes per §4.5, and a statement timeout on viewer queries.
- Exports stream with a cursor and are bounded (OD-7).

### 9.7 Archival and partition management [CLIENT OD-1]

None in release 1 (A-13). When retention is decided, archive whole periods to read-only, checksummed files. Re-verify the chain across each archive boundary, and keep the archive checkpoints off-host.

---

## 10. Implementation and migration plan

Each phase has its own approval gate and is validated on a disposable PostgreSQL 17 environment first, following the P0-3 pattern: isolated network, loopback-only API, synthetic data.

| Phase | Scope | Depends on | Rollback |
|---|---|---|---|
| **1a. Role separation** | Create `eltnoy_owner`, `eltnoy_migrator`, `eltnoy_app`, `eltnoy_audit_verifier`. Transfer object ownership, grant business privileges to `eltnoy_app`, switch the API's `DATABASE_URL` to `eltnoy_app` and migrations to `eltnoy_migrator`. | Client approval of OD-2; a deployment window; secret handling for the new credentials (never printed, S-05) | Point the API back at the previous role. Ownership changes are reversible with `ALTER … OWNER TO`. **Highest-risk phase:** rehearse on a restored copy first. |
| **1b. Schema** | `audit_events`, `audit_event_seals`, `audit_checkpoints`, triggers, indexes and grants, as a fourth idempotent migration file appended to `MIGRATION_FILES` | 1a | Additive. Leave the tables in place; old code ignores them. Never drop audit tables in production. |
| **2. Writer and request IDs** | `server/audit.ts` (contracts, validation, transactional and standalone writers); request-ID middleware (SEC-03); unit tests and a real-database test proving append-only behaviour and rollback atomicity | 1b | Revert the code. No data depends on it yet. |
| **3. Authentication and administrative events** | Login, logout, registration, CLI account creation, institution decisions (A-01 routes), applications, helpdesk, data export, `authorization.denied` | 2; OD-3 and OD-5 decisions | Revert per route |
| **4. Financial and publishing events** | Credits, withdrawals (§7), results, answer keys, online exams, admit cards, exam forms, notices. **P0-4 finalization only if C-10 is approved.** | 2; C-10 for P0-4 | Revert per route. Ledger untouched. |
| **5. Document events** | `document.uploaded`, `document.review_recorded`, `document.content_viewed` (audit-before-serve). **The P3-D5 review panel remains a separate, later approval.** | 4; OD-10 for the panel | Revert per route |
| **6. Audit viewer and export** | Super Admin-only routes and UI (search, filters, keyset pagination, bounded export, self-audit events); route-matrix entries in `server/adminAuthorization.test.ts` | 2; OD-7 | Remove routes. Data unaffected. |
| **7. Integrity and operations** | Sealer, verifier, checkpoint export, monitoring, restore verification runbook | 1b; OD-6 for the checkpoint destination; M-10 | Stop the sealer. Unsealed events stay valid, and sealing resumes from the last seal. |

**Migration risks**

| Risk | Mitigation |
|---|---|
| Role separation breaks the running API (missing grants) | Generate grants from a privilege inventory; rehearse on a restored copy; run the full route matrix against the new role before cutover |
| The first `ALTER TABLE … OWNER TO` takes locks on busy tables | Run in a maintenance window; it's brief per table but needs care with long-running transactions |
| Converting handlers to transactions changes behaviour | Per-route tests, including the P0-3 race and maker-checker suites, and the P0-4 suite unchanged and green |
| An audit write failure blocks critical actions | Intended (§9.2). Monitor insert latency and failures; capacity-test before go-live. |
| A hash-canonicalization difference across PostgreSQL versions | Validate `jsonb::text` stability; store `schema_version` and keep the canonicalization version-tagged |
| Personal data creeps into metadata | Per-action allow-lists in code, the `no_secret_keys` CHECK as backstop, and contract tests that reject unknown keys |
| The documentation drifts | On approval, update the data-model proposal's `audit_events` row and the register (A-11, A-12, A-13, C-03, C-10, SEC-02) in a separate, approved docs change |

---

## 11. Security threat model

| Threat | Prevented by | Detected by | Residual risk |
|---|---|---|---|
| An ordinary user (candidate, center, ordinary Official) modifies or reads events | No write API; `requireSuperAdmin` on read routes (A-12); the app role has no `UPDATE`/`DELETE` | Route-matrix tests; `authorization.denied` events | None known, once implemented |
| A Super Admin silently deletes or edits records through the application | No delete or edit endpoint exists; triggers reject `UPDATE`, `DELETE` and `TRUNCATE` | Seal chain; viewer access is itself audited | None known, through the application |
| Application code (bug or compromise) issues `UPDATE` or `DELETE` | `eltnoy_app` lacks the privileges (**only after phase 1a**); triggers as a second layer | Trigger and privilege drift checks | **Today (F-2) the API is superuser: no protection until 1a** |
| Application compromise inserts forged events | Column-limited `INSERT`; server-assigned `id`, `seq`, `occurred_at` and `row_hash` | Cross-checks against business tables; anomalous actor or role combinations | A compromised app *can* insert plausible false events. Integrity proves events weren't changed after writing, not that they were true. |
| Database operator or superuser edits, deletes or rewrites events | Owner role is `NOLOGIN`; operator access is procedural | Seal chain plus **off-host checkpoints**; restore verification | A superuser can disable triggers and rewrite rows. The change is **detectable** against off-host checkpoints, **not preventable**. Events inside the unsealed window can be removed undetected by the chain. |
| Backup tampering | Checksummed backups (M-10) | Restore verification against off-host checkpoints | Depends on the checkpoint export staying independent of the operator |
| Sensitive data leakage through audit rows | Allow-lists; the CHECK backstop; no document content, secrets or answers | Contract tests; periodic sampling | Free-text `reason_text` may contain personal data typed by users: length limits and viewer-only access |
| Denial of service by audit flooding | Aggregation and rate limits (§9.4) | Events-per-category metrics | Storage growth under sustained abuse |

**Tamper-evident, not immutable.** This design makes tampering by the application impossible once roles are separated, and tampering by anyone with database superuser access *detectable*, provided the exported checkpoints stay outside that person's control. It does not, and on a self-hosted PostgreSQL cannot, make records genuinely immutable. Genuine immutability would need write-once (WORM) storage or an independent external ledger, which would be a new infrastructure decision (S-07, S-12). [CLIENT OD-6]

---

## 12. Open decisions requiring client approval

| ID | Decision | Recommendation |
|---|---|---|
| OD-1 | Retention period per `retention_class`, and whether archival is allowed (A-13, M-09). The seven-year figure is unapproved. | Decide with counsel; keep "no automatic deletion" until then |
| OD-2 | Approve database role separation (phase 1a) and a maintenance window | Approve; it is a precondition for any meaningful database-side protection |
| OD-3 | Collect `source_ip` and `user_agent_summary`: for which categories, and is it disclosed in the privacy notice? | Auth, security and financial categories only; summary form, never the raw user agent |
| OD-4 | Show actor names by lookup at read time (recommended) or snapshot them into events | Lookup; avoids copying personal data into an append-only store |
| OD-5 | Scope of denial logging and failed-login logging, including whether to store a submitted login ID for unknown accounts | Super Admin routes only; aggregate; never store unknown login IDs |
| OD-6 | Off-host destination for checkpoint exports (who controls it, which medium); whether WORM storage is wanted | A medium controlled by someone other than the database operator; no SaaS assumed |
| OD-7 | Export format, size limits and frequency | CSV, ≤ 50,000 rows, date range required, Super Admin only, each export audited |
| OD-8 | A reversal and adjustment policy for wallet entries | Needed before any reversal feature; maker-checker by analogy with A-03 |
| OD-9 | A security incident process (who opens, updates and closes incidents) | Super Admin only for release 1 |
| OD-10 | The P3-D5 panel: what "assigned institution-approval work" means (an assignment model doesn't exist under A-01), rendering approach, watermarking | A separate approval after phases 1–5 pass |
| C-03 | Organization activity view versus A-12 | Keep `audit.view` out of the catalogue; design a separate, filtered view later if wanted |
| C-10 | P0-4 finalization events | Approve a small, separately reviewed change to P0-4 after phase 2 |
| — | Super Admin `reason_text` required for which actions | Required for rejections, reversals and overrides; optional elsewhere |

---

## 13. Acceptance checklist (for the future implementation)

**Schema and privileges**
- [ ] The API connects as `eltnoy_app`, which is neither superuser nor owner. Verified with `rolsuper = false` and an ownership query.
- [ ] `eltnoy_app` cannot `UPDATE`, `DELETE` or `TRUNCATE` `audit_events`, `audit_event_seals` or `audit_checkpoints` (permission error).
- [ ] The owner role is also refused by the triggers on `UPDATE`, `DELETE` and `TRUNCATE`.
- [ ] Client-supplied `id`, `seq`, `occurred_at` and `row_hash` cannot be set by `eltnoy_app`.
- [ ] The migration is idempotent: rerunning it changes nothing.

**Writer**
- [ ] Each release-1 action has a payload contract; unknown keys are rejected; secret-like keys are rejected by both code and CHECK.
- [ ] A `succeeded` event cannot be written outside a transaction.
- [ ] A failed audit insert rolls back the business action (tested for credits, withdrawals, publishing).
- [ ] Refused and failed actions produce `denied` or `failed` events through the standalone writer, or `audit.write_failed` log lines if that fails.

**Coverage**
- [ ] Every release-1 action in §3.2 is emitted by its route, with the expected actor, resource and outcome (route-level tests).
- [ ] Withdrawal events show `approver_user_id ≠ payer_user_id` on every `withdrawal.paid`.
- [ ] No event contains passwords, OTPs, tokens, cookies, answers, score contents or document bytes (contract tests plus a sampling scan).

**Access**
- [ ] Audit routes: unauthenticated 401; candidate, center and ordinary Official 403 with no protected query; Super Admin 200.
- [ ] Every search and export writes exactly one self-audit event; no recursion.

**Integrity**
- [ ] Sealer: a single instance; chain recomputation matches; deliberate tampering on a disposable database (edit, delete, reorder) is detected.
- [ ] Checkpoints are exported off-host and verified after a test restore.
- [ ] Trigger and privilege drift checks raise alarms when deliberately broken on a disposable database.

**Performance and operations**
- [ ] Insert latency p99 measured under concurrent load (target set during validation).
- [ ] Viewer queries use the indexes (`EXPLAIN`) and respect the date-range limit.
- [ ] Growth metrics and alerts are in place.

**Regression**
- [ ] The P0-3 authorization and race suites, the P0-4 suite, lint, typecheck and build all pass. P0-4 behaviour is unchanged unless C-10 is approved.

**Documentation**
- [ ] On approval, the data-model proposal and policy registers are updated in a separate approved change (A-11, A-12, A-13, C-03, C-10, SEC-02, SEC-03).
