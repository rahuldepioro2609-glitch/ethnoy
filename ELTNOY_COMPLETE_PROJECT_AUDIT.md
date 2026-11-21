# ELTNOY Complete Project Audit

**Audit date:** 2026-11-16  
**Mode:** Read-only source, test, documentation, and configuration review  
**Verdict:** **NOT READY FOR DEPLOYMENT**

> Historical baseline: this audit records the repository state reviewed on 2026-11-16. The working tree and verification evidence changed afterward; the percentages and inventory below have not been recalculated for the current snapshot.

## Current follow-up (2026-11-17)

The historical findings below are not all current. This follow-up records work completed in the present session; the verdict remains **NOT READY FOR PUBLIC LAUNCH** because provider configuration, production deployment, PostgreSQL runtime rehearsal, policy approvals, and launch-content validation remain open.

- **Resolved in source:** Platform Staff and Organization Staff migrations are now included in the standard ten-file migration sequence before grants; the grants manifest covers all 14 Staff tables. Static migration/grant tests pass. This has not been applied to any database.
- **Resolved in source:** the SPA reads public surface-hostname metadata and routes role login/dashboard paths to their cookie-owning portal host. Candidate root routing waits for session resolution, and the Exam surface can load public notices/forms. The surface policy and browser navigation helpers have tests; browser-level/live-host validation remains outstanding.
- **Verification:** full suite **1,133 total / 1,093 passed / 0 failed / 40 skipped**; `npm run test:verifier` **27/27**; `npm run test:official-auth-foundation` **12/12**; TypeScript check and Vite build pass. PostgreSQL-gated tests, staging, and production were not run. Vite reports an existing `__dirname` compatibility warning and a JavaScript bundle above 500 kB.
- **Still open for launch:** SMS/email choices are now Resend/Twilio, but deploy-time configuration and live delivery remain unverified; Google OAuth is not configured. Official auth still uses application-side password/MFA/session handling rather than the proposed isolated verifier/gateway; production runtime/database/host configuration, reviewed policy decisions, public content, and operational rehearsals remain unverified.
- **Baseline rows superseded:** the Staff migration findings in sections A, D and E are historical and resolved in source. The current migration list is in [server/migrate.ts](./server/migrate.ts#L29). The current README and release plan supersede older statements below about AUTH-1 migration sequencing and CI checks.

## Current launch status (2026-11-21)

- **Provider choice updated:** the owner selected Resend for email and Twilio for SMS. Source adapters are registered in `server/verificationProviderAdapters.ts` and the production Compose file maps their settings and secret files. This is source-level wiring only: no deployment secret values, sender/domain verification, SMS abuse-limit values, or live delivery evidence have been supplied or inspected. Student and Institute verification therefore remains disabled until the operator configures and verifies these values.
- **VPS provisioned, application deployment blocked:** the BigRock Ubuntu 22 VPS is `64.247.186.46`. Docker/Compose, UFW rules for SSH/HTTP/HTTPS/WireGuard, WireGuard `10.77.0.1/24`, and the Admin-only firewall guard are configured. DNS remains on the existing Render target; the application, TLS, and DNS cutover are not live on this VPS.
- **Database backup and migration rehearsal completed (2026-11-21):** a 64,154-byte mode-0600 Render PostgreSQL 16 custom-format backup is stored at `/var/backups/eltnoy/render-before-cutover.dump` on the VPS. The 8.7 MB source restored to an isolated PostgreSQL 17 volume; the role bootstrap and all eleven migrations then committed on that restored copy. Verification showed 56 public tables, 7 ELTNOY roles, 2 users, 0 applications, and the app role can read `users` but has no table-wide `UPDATE` or access to the four preserved legacy tables. A grant-manifest compatibility change preserves `answer_key_objection_windows`, `answer_key_objections`, `auth_tokens`, and `uploaded_files` without granting the app role access. The isolated database container is stopped and its volume remains on the VPS. The temporary Render inbound rule and migration credentials were removed. This does not constitute production database cutover or application smoke testing.
- **Current code verification:** `npm run lint`, `npm run build`, and `git diff --check` passed on 2026-11-21. The build still warns about Vite's `__dirname` config compatibility and a minified JavaScript chunk above 500 kB. These checks do not establish database, provider, browser, or deployment readiness.
- **Temporary preview:** the previously approved Cloudflare demo tunnel was stopped. The local Vite and API processes were left running; their availability is local-only and is not a client-facing deployment.
- **Remaining release blockers:** PostgreSQL 17 runtime validation for the isolated Official-auth foundation, the separate verifier/session gateway and its policy decisions, production Compose/API setup, provider secrets and owner-approved delivery limits, public TLS and DNS cutover, external firewall/WireGuard acceptance, launch-content approval, API role smoke tests, and an encrypted off-host backup/retention plan. The local production preflight still refuses to run because required network, image, TLS, database, and bind settings are absent. Optional payment collection, automated payouts, file upload, and high-stakes proctoring remain outside the current working flows.

## Audit scope and evidence rules

This report reviews the application source, migration source, tests, documentation, and deployment templates found in the repository workspace. It does not claim that source code is deployed or operational. No Git commands, tests, builds, database connections, migrations, Docker commands, credential reads, DNS changes, infrastructure operations, or dependency changes were performed for this audit.

Secret and data-bearing paths were not opened. The workspace inventory included `.env` files, local TLS material, database dump files, and backup files; their contents and version-control status were not inspected. `.gitignore` and `.dockerignore` contain exclusion rules for these classes, but without Git inspection this report cannot confirm tracking status. Do not treat their presence or exclusion rules as proof that secrets or personal data are safe.

Generated `dist/`, `node_modules/`, user-provided media, certificates, and database/backup contents are not assessed. Visual responsiveness and actual browser interaction are **UNVERIFIED** because no browser test was performed. All file references in this report are relative to the repository root.

### Status definitions

- **COMPLETE:** The source contains a connected frontend/backend/database implementation and corresponding test source; it is not a claim of production deployment.
- **PARTIALLY COMPLETE:** Some layers or sub-workflows exist, but a known gap, unavailable provider, security boundary, or manual dependency remains.
- **NOT IMPLEMENTED:** No operational workflow was found in the source.
- **BROKEN:** The supported source configuration has a known integration defect or routes to schema that the supported migration sequence does not install.
- **UNVERIFIED:** Evidence requires runtime, deployment, actual database, or browser validation.

## A. Executive summary

ELTNOY is a substantial React/Vite/TypeScript and Express/PostgreSQL application. It contains public portal content, candidate and institute workflows, exam and application management, online and mock exams, results, notices, check-ins, institute wallet accounting, MFA code, migrations, and extensive source-level tests.

That breadth is not production readiness:

1. **Phase 4.6.5 Official authentication is architectural direction only.** The independent verifier, `auth.eltnoy.com`, `api.eltnoy.com`, separate session gateway, gateway receipt store, verifier-only credential store, signed assertions, pgsodium integration, and separate production verifier host do not exist in the reviewed source.
2. **Official MFA enrollment is not end-to-end available in the UI.** The Official login screen reports that enrollment is not available and instructs the user to contact a Super Admin. Express currently handles Official passwords, OTPs, TOTP secrets, and session cookies.
3. **Student/Institute registration and login are gated off** because SMS, email, and Google providers are not configured, as documented in [README.md](./README.md).
4. **Staff migrations are included in the supported migration list.** This source-level integration was fixed after the historical baseline, but no deployment database migration or runtime check has been performed.
5. **Current deployment configuration is not the approved architecture.** Compose has separated public/Admin listeners and networks, but not the new verifier/gateway/API/auth domains. The repository explicitly marks Render and Netlify configs unsupported.
6. **No current test/build run was performed.** CI configuration runs TypeScript checking and a frontend build, not the repository test suite. PostgreSQL integration tests are gated and were not run.
7. **Production content, provider setup, capacity, backup/restore, and the Phase 4.6.5 blockers are not fully accepted or verified.**

### Major source findings

| Finding | Status | Evidence |
|---|---|---|
| Express still verifies Official passwords in the shared `users.password_hash` path | **CONFIRMED — BLOCKER** | [server/index.ts](./server/index.ts#L2078), [server/index.ts](./server/index.ts#L2102) |
| Express provisions/decrypts TOTP and verifies Official codes | **CONFIRMED — BLOCKER** | [server/adminMfa.ts](./server/adminMfa.ts#L243), [server/adminMfa.ts](./server/adminMfa.ts#L443), [server/adminMfa.ts](./server/adminMfa.ts#L526) |
| Express creates and sets the Official bearer session cookie | **CONFIRMED — BLOCKER** | [server/adminMfa.ts](./server/adminMfa.ts#L478), [server/adminMfa.ts](./server/adminMfa.ts#L511), [server/auth.ts](./server/auth.ts#L103) |
| Application DB role has session/evidence inserts and factor-secret SELECT through manifest grants | **CONFIRMED in grant source; actual deployed ACL UNVERIFIED** | [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L113), [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L152), [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L155) |
| MFA confirmation function trusts caller-provided accepted TOTP step | **CONFIRMED — HIGH RISK** | [server/adminMfaMigration.sql](./server/adminMfaMigration.sql#L454), [server/adminMfaMigration.sql](./server/adminMfaMigration.sql#L463) |
| First-time enrollment UI/ticket issue path is absent | **CONFIRMED — BLOCKER** | [src/components/RolePortal.tsx](./src/components/RolePortal.tsx#L202), [src/utils/adminMfa.ts](./src/utils/adminMfa.ts#L16), [server/adminMfa.ts](./server/adminMfa.ts#L243) |
| Staff routers and schemas are present in the supported migration sequence | **RESOLVED IN SOURCE; DATABASE UNVERIFIED** | [server/index.ts](./server/index.ts#L2847), [server/index.ts](./server/index.ts#L2854), [server/migrate.ts](./server/migrate.ts#L40) |
| SMS, email, and Google provider services unavailable | **CONFIRMED per README; deployed config UNVERIFIED** | [README.md](./README.md#L35) |
| Candidate, institute, exam sample data includes stale schedules and limited practice-only content | **CONFIRMED per README** | [README.md](./README.md#L159) |
| No PostgreSQL/pgsodium runtime verification for the target image | **UNVERIFIED — deployment blocker** | [docker-compose.yml](./docker-compose.yml#L316), no extension setup found in migration list |

### Repository inventory

- **Frontend:** React, Vite, TypeScript SPA. [src/main.tsx](./src/main.tsx) starts the application; [src/App.tsx](./src/App.tsx#L423) owns top-level custom navigation and public modal flows; [src/components/RolePortal.tsx](./src/components/RolePortal.tsx) contains Candidate, Institute, Center, and Official portal/login surfaces. The component inventory includes `AdminMfaChallenge`, `StudentAuthPanel`, `InstituteRegistrationForm`, `CenterLocator`, `ExamList`, `ApplicationForm`, `AdmitCard`, `MockExam`, `ResultsPanel`, `AnswerKeyPanel`, `FeedbackForm`, `InstituteDashboard`, and Official administration/import/export screens. This is a component-driven SPA, not separate server-rendered pages. No browser or responsive visual test was run.
- **Backend:** Express application and API route registration are in [server/index.ts](./server/index.ts). Main route groups cover public exams/forms/notices; Candidate authentication, applications, online/mock exams, admit cards and results; Institute registration, verification, forms, profile, wallet and withdrawals; Center check-ins; Official exam/result/answer-key administration; MFA; and Staff routers. Shared policy is in [server/surface.ts](./server/surface.ts), request authentication/authorization in [server/auth.ts](./server/auth.ts), and narrower domain logic in server modules such as `adminMfaStore.ts`, `authVerificationStore.ts`, and `onlineExamScoring.ts`.
- **Database:** PostgreSQL schema and SQL migration sources live under `server/`. The standard runner [server/migrate.ts](./server/migrate.ts#L29) wires core schema, institution-document, auth-verification, registration-claim, MFA, and grant migrations. Role bootstrap, grants, monitoring setup, and the two Staff migration drafts are separate sources; Staff migrations are not in the standard sequence. A migration having source code does not establish that it has been run on any environment.
- **External integrations:** provider abstractions exist for SMS/email/Google verification and spreadsheet import/export, but README states the identity/notification providers are not configured. Payment processing, automated payouts, and live proctoring are documented limitations rather than operational integrations.
- **Deployment/configuration:** [Dockerfile](./Dockerfile), [docker-compose.yml](./docker-compose.yml), `deploy/nginx/`, [server/validateDeploymentConfig.ts](./server/validateDeploymentConfig.ts), [.env.example](./.env.example), and the operator runbook provide deployment-oriented source. `render.yaml` and `netlify.toml` expressly disclaim compatibility with the production design. No actual environment values or certificates were read.
- **Repository scale from the source inventory:** 94 frontend source paths, 101 server TypeScript/SQL paths, 22 documentation files, and 72 test files with test declarations were found. These counts describe the inventory and are not an execution or coverage metric.

## B. Project completion percentage

### Method

Percentages below are a reproducible **source-inventory completion index**, not a production-readiness score:

- The denominator is 24 workflows explicitly identified from the repository’s pages, API routes, persistence modules, README limitations, and approved Official-auth requirements.
- Each workflow contributes equally within each layer (frontend, backend, database, testing); feature weights were not available, so this is not a business-value weighting.
- Per layer: `COMPLETE = 1`, `PARTIALLY COMPLETE = 0.5`, and `NOT IMPLEMENTED`, `BROKEN`, or `UNVERIFIED = 0`.
- For the testing layer, `PARTIALLY COMPLETE` means test source exists but was not run in this audit; it does not mean tests passed.
- The overall index is the arithmetic mean of the four layer scores. This method deliberately does not convert an unverified deployment into a pass.

| Layer | Scored points | Maximum | Index |
|---|---:|---:|---:|
| Frontend | 16.5 | 24 | 68.8% |
| Backend | 16 | 24 | 66.7% |
| Database | 16 | 24 | 66.7% |
| Testing | 10.5 | 24 | 43.8% |
| **Overall source-inventory index** | **59** | **96** | **61.5%** |

The index is limited by the selected workflow inventory and equal weighting. It must not be read as “61.5% safe for production.” Production acceptance is gated by critical security and operational controls, several of which are absent.

### 24-workflow feature matrix

| Feature/workflow | Frontend | Backend | Database | Testing | Overall status |
|---|---|---|---|---|---|
| Public home, navigation, notices, and discovery | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Exam catalogue and Official exam publishing | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Candidate registration, login, and verification | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Candidate applications and dashboard | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | COMPLETE |
| Admit-card publication and lookup | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Answer-key publication/read and objections | PARTIALLY COMPLETE | PARTIALLY COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Results publication and lookup | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Mock exams/practice attempts | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Candidate online exams | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Institute registration, approval, and verification | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Institute forms, profile changes, wallet, and withdrawals | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Institution document submission and review | PARTIALLY COMPLETE | PARTIALLY COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Official console, imports/exports, notices, and administration | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Official MFA login and enrollment | PARTIALLY COMPLETE | PARTIALLY COMPLETE | COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Authentication/session/authorization target boundary | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Center check-ins | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | COMPLETE |
| Feedback/helpdesk | COMPLETE | COMPLETE | COMPLETE | PARTIALLY COMPLETE | COMPLETE |
| Platform Staff | PARTIALLY COMPLETE | PARTIALLY COMPLETE | NOT IMPLEMENTED in supported migrations | PARTIALLY COMPLETE | BROKEN |
| Organization Staff | PARTIALLY COMPLETE | PARTIALLY COMPLETE | NOT IMPLEMENTED in supported migrations | PARTIALLY COMPLETE | BROKEN |
| SMS/email/Google integrations | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE | PARTIALLY COMPLETE |
| Password recovery/reset | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED |
| Outbound notification delivery | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED |
| Automated payment, exam fees, and payouts | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED |
| Live AI/biometric proctoring | PARTIALLY COMPLETE (demo/UI logic only) | NOT IMPLEMENTED | NOT IMPLEMENTED | PARTIALLY COMPLETE | NOT IMPLEMENTED |

**Interpretation:** “Complete” in a layer means the layer is present in source. The overall status remains partial where documented limitations, unconfigured dependencies, absent production content, or unverified deployment block the end-to-end user workflow.

## C. Completed features

These are source-implemented workflows, not independently accepted production operations:

- React/Vite portal with public navigation, exam and institute-form discovery, notices, FAQ, search, center locator, and feedback interface. [src/App.tsx](./src/App.tsx#L423)
- Candidate application submission, candidate-scoped portal data, Official review, ownership verification, and admit-card assignment routes. [server/index.ts](./server/index.ts#L2318) [server/index.ts](./server/index.ts#L2431) [server/index.ts](./server/index.ts#L2510)
- Exam administration, admit cards, answer keys, result imports/publication, workbook template/import/export, mock exams, and online exam scoring/persistence. [server/index.ts](./server/index.ts#L429) [server/index.ts](./server/index.ts#L851) [server/index.ts](./server/index.ts#L2690) [server/index.ts](./server/index.ts#L2795)
- Institute approval, institutional verification/suspension, public form listing, profile change, wallet-credit and manual withdrawal flows. [server/index.ts](./server/index.ts#L1204) [server/index.ts](./server/index.ts#L1442) [server/index.ts](./server/index.ts#L1548)
- Candidate and Institute role boundaries are represented in server middleware and route policies. [server/auth.ts](./server/auth.ts#L198) [server/surface.ts](./server/surface.ts#L500)
- Core schema includes users, sessions, exams, applications, online exams, center check-ins, mock attempts, results, institute forms, wallet entries, and withdrawals. [server/schema.sql](./server/schema.sql#L1) [server/schema.sql](./server/schema.sql#L88) [server/schema.sql](./server/schema.sql#L132) [server/schema.sql](./server/schema.sql#L169) [server/schema.sql](./server/schema.sql#L239) [server/schema.sql](./server/schema.sql#L297)
- Additive institution-document, registration-claim, auth-verification, and MFA migration source is present and wired through the standard migration list, except the explicitly excluded Staff migrations. [server/migrate.ts](./server/migrate.ts#L29)
- TLS/network/deployment hardening source includes separate public/Admin Nginx surfaces, internal Compose networks, service identities, TLS validation, and deployment preflight logic. It has not been runtime-validated in this audit. [docker-compose.yml](./docker-compose.yml#L1) [deploy/nginx/public.conf](./deploy/nginx/public.conf#L1) [deploy/nginx/admin.conf](./deploy/nginx/admin.conf#L1) [server/validateDeploymentConfig.ts](./server/validateDeploymentConfig.ts#L1)

## D. Partially completed features

- **Candidate authentication:** mobile/password, Student ID compatibility, SMS verification, and Google linking code exist, but provider gating reports unavailable services. README states no SMS, email, or Google provider is configured. [src/components/StudentAuthPanel.tsx](./src/components/StudentAuthPanel.tsx#L1) [server/verificationProviders.ts](./server/verificationProviders.ts#L1) [README.md](./README.md#L35)
- **Institute authentication/onboarding:** registration and approval code exists; email/mobile provider verification is closed when providers are missing. Manual review is not certificate verification. [server/index.ts](./server/index.ts#L1792) [README.md](./README.md#L43)
- **Institution documents:** tables, review history, capability model, and UI foundations exist, but README explicitly says upload/replacement remains hard-disabled. [server/institutionDocumentsMigration.sql](./server/institutionDocumentsMigration.sql#L7) [README.md](./README.md#L191)
- **Official MFA:** MFA schema, TOTP crypto, challenge, login verification, enrollment backend, triggers, and source tests exist. However, the current frontend has only the MFA challenge screen; first-time enrollment displays a “not available” message. [src/components/AdminMfaChallenge.tsx](./src/components/AdminMfaChallenge.tsx#L1) [src/utils/adminMfa.ts](./src/utils/adminMfa.ts#L16) [server/adminMfa.ts](./server/adminMfa.ts#L365)
- **Institute wallet:** ledger, manual credit, and manual withdrawal code exist; automated payments, top-ups, and payouts do not. [server/index.ts](./server/index.ts#L1548) [README.md](./README.md#L159)
- **Localization:** language selection and shared text support English, Hindi, Kannada, Bengali, and Marathi; README acknowledges dashboard/dialog/content localization gaps. [src/utils/languageLogic.ts](./src/utils/languageLogic.ts#L1) [README.md](./README.md#L58)
- **Online exams:** saved progress, timing, server scoring, and recovery code exist, but the README cautions the question bank is sample/practice-only and not production-grade proctoring. [server/onlineExamScoring.ts](./server/onlineExamScoring.ts#L1) [server/onlineExamRecovery.ts](./server/onlineExamRecovery.ts#L1) [README.md](./README.md#L159)
- **Staff portals:** UI, route modules, and migration drafts exist, but migrations are not wired and require separate approval/review. See §F and §G.

## E. Missing features and unavailable workflows

Per repository documentation and route/source inventory:

- Official password changes/resets and end-user password recovery.
- Operational SMS/email/Google provider integrations and delivery.
- Candidate exam-fee collection, automatic institute wallet credits, revenue sharing, and payouts.
- Answer-key objection workflow.
- Operational file uploads/replacements and associated end-to-end document-verification workflow.
- Live AI proctoring and biometric verification.
- Outbound notification delivery/outbox workflow.
- Phase 4.6.5 verifier, gateway, signed proof assertions, assertion replay table, encrypted receipt store, and verifier-only credential/factor-key stores.
- Phase 4.6.5 first-time enrollment-ticket issuance and browser-bound capability flow.
- Approved institutional/platform MFA reset and recovery authority policy.

These are not approvals to build new features; each remains subject to existing policy and operator approval.

### Frontend and UI review limits

- The portal is component-driven and the source includes login, MFA challenge, exam, application, institute, Center, results, notices, and Official administration surfaces as listed above and in the feature matrix.
- The Official first-enrollment screen is an identified missing workflow; the login UI directs the user to contact a Super Admin rather than completing enrollment.
- README identifies incomplete localization in dashboard/dialog content and sample public data. [README.md](./README.md#L58) [README.md](./README.md#L159)
- No attempt was made to click every button, submit every form, or compare layouts at viewport sizes. Consequently, broken-button claims, exact loading/success/error-state coverage, keyboard/accessibility behavior, and responsive-design defects are **UNVERIFIED**, not presumed absent.
- Local Vite-to-API behavior has a documented concrete gap: the proxy does not send the original-host header expected by the server’s surface policy. This is a local development integration defect, not evidence that production routing is broken. [README.md](./README.md#L17)

## F. Critical bugs and security risks

### Critical production blockers

1. **Official authentication trust boundary not implemented.** Express currently reads Official password hashes, performs bcrypt verification, receives TOTP code input, decrypts MFA factors, and creates the session. This violates approved decisions 7–9, 14, and 18. [server/index.ts](./server/index.ts#L2078) [server/adminMfa.ts](./server/adminMfa.ts#L526) [server/auth.ts](./server/auth.ts#L103)
2. **Database app-role bypasses remain.** The grants manifest grants `eltnoy_app` SELECT on the application tables including MFA factor ciphertext, INSERT on sessions and MFA evidence, and UPDATE of factor disable state. The evidence trigger checks a live session and an active factor, not a verifier-signed TOTP proof. [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L113) [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L152) [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L155) [server/adminMfaMigration.sql](./server/adminMfaMigration.sql#L286)
3. **Confirmation function does not verify TOTP.** The `SECURITY DEFINER` routine accepts `p_accepted_step` from the caller. It enforces ordered mutation and identity relationships but does not independently establish a valid TOTP assertion. [server/adminMfaMigration.sql](./server/adminMfaMigration.sql#L454)
4. **First-time enrollment flow incomplete.** UI says enrollment is unavailable; the backend expects a ticket; there is no approved 30-minute browser-bound ticket issuance and trusted auth UI. [src/utils/adminMfa.ts](./src/utils/adminMfa.ts#L16) [server/adminMfa.ts](./server/adminMfa.ts#L243)
5. **Staff migration sequence is wired in source.** `MIGRATION_FILES` includes both Staff schemas before the grants migration. This has not been applied to or verified against the VPS database. [server/migrate.ts](./server/migrate.ts#L40)

### High and medium risks

- **Provider-dependent authentication unavailable:** documented SMS, email, Google unconfigured; do not treat code presence as working login. [README.md](./README.md#L35)
- **Sample/dated production content:** README says exam schedules include 2025 dates, and the center directory/notices are sample data. As of the audit date (2026-11-16), replace and verify launch content before public use. [README.md](./README.md#L159)
- **No pgsodium/assertion proof implementation:** no pgsodium extension setup, key table, assertion verification routine, signed proof protocol, or replay consumption table appears in the wired migrations. Exact PostgreSQL 17 image is an operator-supplied digest. [server/migrate.ts](./server/migrate.ts#L29) [docker-compose.yml](./docker-compose.yml#L316)
- **No gateway or receipt recovery:** Express creates the raw session token and sets the cookie. No gateway-only durable receipt store exists in source. [server/auth.ts](./server/auth.ts#L95) [server/adminMfa.ts](./server/adminMfa.ts#L478)
- **MFA recovery authorization unspecified:** reset schema contains `two_person` and `single_super_admin` modes, but the operator has not approved the real institutional/platform approver hierarchy. [server/adminMfaMigration.sql](./server/adminMfaMigration.sql#L135)
- **Migration no-op before roles provisioned:** grants migration returns early if its six existing roles are missing; it therefore does not independently revoke PUBLIC function execution in that path. Runtime ACL state remains unverified. [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L57)
- **Development API proxy documented as incomplete:** README says the current Vite proxy does not send `X-ELTNOY-Original-Host`, so local API requests are rejected until tooling changes. [README.md](./README.md#L17)
- **Historical policy documentation drift (resolved in source docs):** the 2026-11-16 README described AUTH-1 tables as not yet applied even though the migration runner included them. README now says they are in the supported sequence, while explicitly leaving actual database application unverified. [README.md](./README.md#L35) [server/migrate.ts](./server/migrate.ts#L29)
- **Artifact confidentiality unknown:** workspace path inventory found local env/certificate paths and database dump/backup filenames; contents were not accessed. Ignore rules exist, but Git tracking and backup confidentiality were not verified.

## G. Phase 4.6.5 blocker status

The following are the nine blockers identified in the Phase 4.6.5 report. “Already implemented” means source-level presence only.

| # | Blocker | Current status | Already implemented | Remaining work / approval |
|---|---|---|---|---|
| 1 | Institutional/platform MFA recovery approvers and target policy | **BLOCKER** | Schema includes reset request records and two approval-mode enum values. | Approve who may initiate/approve each recovery class, exceptions, and audit policy. Do not infer hierarchy from schema. [server/adminMfaMigration.sql](./server/adminMfaMigration.sql#L135) |
| 2 | Official password change/reset policy | **BLOCKER** | No verifier-owned Official password store or reset flow found. Existing bcrypt hash is in `users`. | Approve password change/reset conditions, recovery, rate limits, lockout, and audit requirements. [server/schema.sql](./server/schema.sql#L1) |
| 3 | Receipt-store durability and gateway key recovery | **BLOCKER** | No receipt store in source. | Approve durable storage, replication/backups, five-minute expiry cleanup, key recovery/rotation, and host-loss behavior. |
| 4 | Browser-to-gateway completion and cookie/CSRF/origin protocol | **BLOCKER** | Existing surface middleware performs exact origin checks for current surfaces. | Define cross-origin handoff, transaction/cookie binding, CSRF, CORS, host-only cookie, replay, and redirect handling for new domains. [server/surfaceEnforcement.ts](./server/surfaceEnforcement.ts#L1) |
| 5 | Exact PostgreSQL 17 image and pgsodium API | **UNVERIFIED / deployment BLOCKER** | Compose requires a digest-pinned PostgreSQL 17 image. No pgsodium extension declaration is present in the wired migrations. | Select only after approval; validate extension build, function schema/signature, vectors, grants, failures, and operations on the exact image. [docker-compose.yml](./docker-compose.yml#L316) |
| 6 | Verifier-owned reset/recovery implementation | **BLOCKER** | Reset/recovery tables and hashed recovery-code schema exist; no end-to-end independent verifier workflow is established. | Implement only after blocker 1 policy approval; remove Express direct factor disable/reset access. [server/adminMfaMigration.sql](./server/adminMfaMigration.sql#L103) [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L152) |
| 7 | Session lifetime, assertion time boundaries, audit retention, NTP thresholds | **BLOCKER / UNVERIFIED** | Current sessions have a 12-hour Express cookie TTL; MFA challenge policy code exists. No approved target assertion/receipt policy is wired. | Approve session/assertion TTL boundary semantics, NTP fail-closed thresholds, audit retention and alerting. [server/auth.ts](./server/auth.ts#L29) |
| 8 | Least-privilege function owner and migration convention | **BLOCKER** | Existing `eltnoy_owner` owns all public objects; migrator begins as owner. | Design dedicated NOLOGIN owner and exact privileges; update bootstrap/runner migration sequence; ensure no early-return ACL gap. [server/databaseRoleBootstrap.sql](./server/databaseRoleBootstrap.sql#L33) [server/databaseRoleBootstrap.sql](./server/databaseRoleBootstrap.sql#L62) |
| 9 | Candidate/Center issuance compatible with gateway-generated tokens | **BLOCKER** | Candidate and Center OTP flows create sessions via `authVerificationStore`; current policy is separate from Official MFA. | Move token generation/cookie delivery behind gateway without changing Candidate/Center authentication; preserve session/evidence semantics. [server/authVerificationStore.ts](./server/authVerificationStore.ts#L423) [server/authVerificationStore.ts](./server/authVerificationStore.ts#L632) |

### Testing and quality

- The source inventory found test files across server logic, frontend utility logic, component/UI logic, and data logic; examples include [server/adminMfa.test.ts](./server/adminMfa.test.ts), [server/adminMfaMigration.test.ts](./server/adminMfaMigration.test.ts), [server/databaseGrants.postgres.integration.test.ts](./server/databaseGrants.postgres.integration.test.ts), and MFA/proctor utility tests under `src/`.
- The PostgreSQL grant integration harness is disposable-database gated. It was not invoked; no database was accessed.
- CI configuration at [.github/workflows/ci.yml](./.github/workflows/ci.yml) runs type checking and a frontend build; it does not run the discovered test suite. CI execution status was not queried.
- **Tests/build/typecheck executed in this audit: none.** Current test pass/fail, TypeScript diagnostics, build output, and coverage are therefore **UNVERIFIED**. Prior conversational summaries of earlier checks are not treated as current evidence.
- No line/function coverage report was generated. No static security scanner, dependency audit, browser automation, load test, or runtime integration test was run.

## H. Deployment readiness assessment

### Docker and service topology

- `Dockerfile` uses Node 22 multi-stage build, runs the API as UID/GID 10001, uses a non-login migration identity, copies built assets, and runs Node directly. **Source present; image build and runtime UNVERIFIED.** [Dockerfile](./Dockerfile#L1)
- `docker-compose.yml` describes separate public/Admin Nginx and API services, internal networks, isolated DB networks, TLS mounts, a PostgreSQL 17 image variable and a one-off migration runner. It explicitly says statically tested only/not runtime-validated. [docker-compose.yml](./docker-compose.yml#L1)
- This topology does not include the Phase 4.6.5 verifier, separate verifier host, gateway, receipt store, or the approved `auth.eltnoy.com` / `api.eltnoy.com` services.
- `render.yaml` is explicitly marked incompatible with P1-B; `netlify.toml` is static-only and redirects API paths to the SPA. Neither is production-safe for the current API. [render.yaml](./render.yaml#L1) [netlify.toml](./netlify.toml#L1)

### Domains, TLS, and network

- Current hostnames are `eltnoy.com`, `exam.eltnoy.com`, `institution.eltnoy.com`, `admin.eltnoy.com`; requested auth/API domains are not wired. [server/surface.ts](./server/surface.ts#L20)
- Nginx TLS configuration uses TLS 1.2/1.3 and HSTS; the Admin Nginx configuration is separate from public Nginx and published on the WireGuard interface per the Compose comments. Actual DNS, certificates, firewall, WireGuard reachability, and TLS handshakes were not inspected or tested. [deploy/nginx/includes/eltnoy-tls.conf](./deploy/nginx/includes/eltnoy-tls.conf#L1) [deploy/nginx/admin.conf](./deploy/nginx/admin.conf#L65)
- Express uses Helmet CSP defaults with selected style exceptions; exact production browser behavior and deployment headers are **UNVERIFIED**. [server/index.ts](./server/index.ts#L98)
- Current API rate limiting uses in-process express-rate-limit configuration. Multi-instance shared limiting is not configured in the inspected source; README says shared state is needed when scaling. [server/index.ts](./server/index.ts#L110) [README.md](./README.md#L167)

### Database, backup, monitoring, and rollback

- Migration runner applies a fixed list in one transaction and uses an advisory lock, but there is no migration ledger and no down-migration/automated rollback suite. [server/migrate.ts](./server/migrate.ts#L29) [server/migrate.ts](./server/migrate.ts#L50)
- PostgreSQL 17 is specified as an externally supplied digest-pinned image; no exact digest is approved here. No pgsodium setup is present.
- Role bootstrap and grant manifests exist; actual deployed roles/ACLs were not inspected. Database monitoring SQL is a separate operator-run setup and is not in `MIGRATION_FILES`. [server/databaseRoleBootstrap.sql](./server/databaseRoleBootstrap.sql#L1) [server/databaseGrantsMigration.sql](./server/databaseGrantsMigration.sql#L1) [server/databaseMonitoringSetup.sql](./server/databaseMonitoringSetup.sql#L1) [server/migrate.ts](./server/migrate.ts#L29)
- Runbook documents encrypted off-host backups and restore steps, but no backup/restore operation or restore rehearsal was performed. Workspace backup artifacts were not opened. [docs/operations/production-operator-runbook.md](./docs/operations/production-operator-runbook.md#L1)
- Production host count, provider, firewall, budgets, monitoring, backup destination, TLS issuance, DNS, production data migration, capacity, and restore readiness require operator validation. Do not purchase or deploy based on this report.

### Production readiness

The repository is **not ready for production deployment**. Existing Compose hardening is useful but does not meet the approved authentication architecture and has no runtime acceptance evidence. The sample examination calendar and directory require verified launch data; provider integrations are unavailable; staff schema routing is inconsistent; and restore/load/security acceptance remains outstanding.

## I. Remaining work checklist

- [ ] Resolve all nine Phase 4.6.5 blockers in §G.
- [ ] Approve recovery authority matrix and password change/reset policy.
- [ ] Approve gateway receipt-store durability, key backup, expiry deletion, and restart/recovery behavior.
- [ ] Select separate production host boundaries and revise budget before procurement.
- [ ] Approve exact PostgreSQL 17 image digest and pgsodium compatibility test target.
- [ ] Move Official credential hashes into a verifier-only store without changing existing passwords.
- [ ] Implement trusted auth origin and independent verifier; Express must not receive Official password, OTP, secret, or private key.
- [ ] Implement separate login/enrollment/reset proof protocols and database-verifiable signatures.
- [ ] Remove direct `eltnoy_app` access to Official factor secrets, factor confirmation/disable, Official evidence/session creation.
- [ ] Implement session gateway and gateway-generated token for all roles; Express receives no raw bearer token or browser cookie.
- [ ] Add gateway-only encrypted five-minute delivery receipts and tested idempotent retry.
- [ ] Implement first-time 30-minute browser-bound enrollment ticket without existing app session.
- [ ] Wire and review Platform Staff / Organization Staff migrations and grants only with separate approval; resolve current route/schema mismatch.
- [ ] Reconcile `README.md` migration/deployment statements with current source.
- [ ] Configure and validate approved SMS/email/Google providers if those flows are within launch scope.
- [ ] Replace stale/sample exam, notice, and center data with verified launch content.
- [ ] Decide document upload, payment, answer objection, notification, proctoring, and password recovery scope; do not imply availability.
- [ ] Run unit/static tests, typecheck, and build in approved environment; execute gated PostgreSQL integration tests only after separate disposable-DB approval.
- [ ] Run exact-image PostgreSQL/pgsodium proof, ACL, rollback, replay, and concurrency testing.
- [ ] Perform end-to-end browser, accessibility, responsive, security, and synthetic-account testing.
- [ ] Perform separate-host network acceptance, NTP monitoring, backup/restore, key rotation/revocation, and load testing.
- [ ] Complete pre-deployment operator checklist and obtain explicit release approval.

## J. Recommended execution order

1. **Policy/operations decisions first:** recovery authority, password reset/change, session/receipt retention, clock thresholds, host topology, database image and budget.
2. **Security architecture acceptance:** specify credential ownership, browser-to-verifier/gateway flow, assertion encoding and proof purposes, role/ACL ownership, session recovery/idempotency.
3. **Verifier-only credential transition:** preserve existing Official bcrypt hashes, reconcile identities, eliminate Express read access, retain Candidate/Center flow.
4. **Database proof boundary:** install/validate the approved extension, create least-privilege roles/function owner, implement signed assertion consume/session/evidence/audit transaction, eliminate direct grants.
5. **Trusted UI, enrollment, login, and recovery:** implement 30-minute one-time enrollment ticket, browser binding, login protocol, approved reset/recovery.
6. **Gateway and receipt recovery:** token generation and cookie termination at gateway, encrypted durable five-minute receipt, retry/restart safety.
7. **Existing feature consistency:** fix Staff migration wiring before enabling those routes; resolve docs/config conflicts; verify provider/content state.
8. **Separate-host and production acceptance:** tests, restore and rotation drills, load/accessibility/security checks, DNS/TLS/network configuration and release approval.

Each phase needs separate authorization. This report does not authorize implementation, database access, infrastructure setup, DNS, provider calls, or purchases.

## K. Estimated remaining engineering days

**Indicative engineering estimate: 40–75 person-days**, excluding policy decision latency, infrastructure procurement, provider onboarding lead time, production-data access approvals, and any newly approved product scope.

| Work package | Estimate |
|---|---:|
| Resolve policy/security design blockers and acceptance criteria | 3–6 days |
| Verifier service, trusted auth UI, Official credential migration | 8–15 days |
| PostgreSQL proof routines, roles/ACLs, pgsodium validation | 6–12 days |
| Session gateway, all-role token delivery, encrypted receipt recovery | 6–12 days |
| MFA enrollment/login/reset/recovery integration and migration rehearsal | 5–10 days |
| Staff migration/grant consistency and documentation/config reconciliation | 2–5 days |
| Separate-host integration, security/replay/concurrency/restore/load testing | 8–15 days |
| **Total** | **38–75 days** |

The headline 40–75 range rounds the 38-day lower bound for planning. It assumes decisions are prompt and the current application scope remains fixed. Provider integrations, payment systems, live proctoring, and newly approved workflows are excluded and require separate estimates.

## L. Final verdict

# NOT READY FOR DEPLOYMENT

This verdict is based on missing approved authentication boundaries, incomplete first-time MFA enrollment, app-role session/evidence/factor access, unresolved recovery authority, unavailable live provider evidence, and absent runtime production evidence. The BigRock VPS is provisioned but SSH root authentication failed, so the application is not deployed and DNS has not been switched. Existing source and tests demonstrate meaningful implementation, but do not prove a safe production deployment.

No implementation changes were made during this 2026-11-16 audit. Later code changes, runtime checks, and approvals must be assessed from their own current evidence; this document is not a current completion score.
