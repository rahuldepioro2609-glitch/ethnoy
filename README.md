# ELTNOY portal

## Local development

The UI runs on Vite (`3000`) and the API runs on Express (`4000`). The Vite server proxies `/api` requests to the API.
If a restricted agent terminal reports `EPERM` while binding a port, run these commands from your regular system terminal instead.

1. Install Node.js 22.12+ and PostgreSQL, then run `npm install`.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL` to a PostgreSQL database you control. Set `DATABASE_SSL=true` when your database provider requires TLS, and keep `APP_ORIGIN=http://localhost:3000` for local development.
3. Create the tables with `npm run db:migrate`.
4. Create an initial official account. The command securely prompts for and confirms a password (input is hidden):

   ```sh
   npm run user:create -- ADMIN-001 "Portal Administrator" official
   ```

   Enter a password of 12-128 characters at both hidden prompts. Repeat with `candidate` or `center` to provision other accounts.
5. In one terminal run `npm run dev:api`; in a second run `npm run dev`. Open `http://localhost:3000`.

The API health check is `GET /api/health`. `npm start` serves the production build and API from one origin; build the frontend first with `npm run build`.

## Role portals

Select **Login** on the home page, or open `/login/candidate`, `/login/center`, or `/login/official` directly. Successful sign-in opens the matching protected dashboard at `/dashboard/<role>`. Student services such as applications, admit cards, mock exams, results, answer keys, helpdesk, and center lookup prompt for candidate sign-in first; search, notices, and general navigation remain public. After sign-in, the selected service opens automatically.

- Students create an account with a login ID and password, sign in, and then apply for an open exam. Applications and signed-in mock-practice attempts are tied to the account and appear in that student's dashboard. Guest mock practice remains available but is not saved to an account. Older administrator-created candidate accounts can continue to sign in with their existing IDs.
- Institutes can submit a center login ID, institute name, contact email, registration/recognition number, registered address, optional website, and password from the institute login page. New requests remain pending and cannot sign in until a Super Admin verifies the details and approves them in **Institute approvals & wallet**. Approved institutes can submit exam-application and teacher-recruitment listings, and request profile changes; both remain pending until Super Admin approval. Only approved listings appear in the public **Institute exam & teacher forms** section. Candidates follow the institute's external application link or contact it directly; ELTNOY does not collect these applications.
- The institute dashboard includes a read-only wallet ledger and withdrawal requests. The institute portal does not offer a wallet top-up or payment option. Super Admins can record credits only after separately verifying payment. Withdrawals reserve available funds while pending or approved; Super Admin must approve, transfer funds manually, then enter the transfer reference to mark the request paid. Do not collect bank details in the portal. Candidate fee collection, automatic institute revenue sharing, and automatic payouts are not part of this flow.
- An approved center account uses its center code as its login ID. An official must assign that exact center code on the candidate's admit card. The center dashboard can then verify the candidate using the application number and date of birth and save a check-in status.
- Official accounts can review applications, update helpdesk tickets, and view practice attempts and published results.
- Officials can create exam forms under **Exam forms**. New forms are saved as drafts; selecting **Publish on website** makes the form visible in the public exam list. Unpublishing hides it and blocks new applications. Each exam uses an IANA time zone (for example, `Asia/Kolkata` or `Europe/London`) for registration-window checks on both the public site and API. Existing exams default to `Asia/Kolkata`.
- Super Admins can publish and unpublish notices from **Latest updates** in the dashboard. Published notices appear in the scrolling homepage ticker, Public Notices list, and site search; the homepage refreshes published notices every 30 seconds and when the browser regains focus.
- Super Admins can download the Excel upload template from **Admit cards**, **Online exams**, **Answer keys**, or **Results**. Uploads require the matching worksheet name and headers, accept up to 5,000 rows per worksheet and 5 MB per file, and are validated transactionally. The server validates the XLSX ZIP structure and bounds archive entries (2,000 maximum), each expanded entry (20 MB maximum), and total expanded content (50 MB maximum) before parsing. No antivirus service is configured. Admit cards publish when imported; online exams, answer keys, and results remain drafts until explicitly reviewed and published.
- Workbook sheets and required fields:
  - `AdmitCards`: `applicationNumber`, `examCode`, `rollNumber`, `examDate` (YYYY-MM-DD), `reportingTime`, `gateClosingTime`, `examTiming`, `centerCode`, `centerName`, `centerAddress`. Each row must match an existing application; this sheet publishes cards immediately.
  - `AnswerKeys`: `examCode`, `questionNumber`, `subject` (`Mathematics`, `Physics`, `Chemistry`, or `Logical Reasoning`), `questionText`, `optionA`–`optionD`, `officialKey` (`A`–`D`), and optional `explanation`. A new import returns that exam’s key to draft status.
  - `OnlineExam`: `examCode`, `examName`, `durationMinutes`, `questionNumber`, `section`, `questionText`, `optionA`–`optionD`, `correctOption` (`A`–`D`), and optional `points` (default 1). Upload one exam code per sheet. Once an exam has an attempt, its questions cannot be replaced; create a new exam code for a revised paper.
  - `Results`: `applicationNumber`, `rollNumber`, `examCode`, `dateOfBirth` (YYYY-MM-DD), and `scorecardJson`. The JSON must match the result API schema: candidate/parent identity, DOB, gender/category/PwD status, exam and center details, `sectionScores` (section name, maximum/earned marks, percentile), total marks, aggregate percentile, ranks, qualification, cutoff marks, verification code, counseling stream, and issue date. Its roll number, application number, exam code, and DOB must match the row and a matching application. If an admit card has assigned a roll number, it must match. A valid example shape is available in the `scorecardSchema` in `server/index.ts`.
- Candidate online exams are listed only for approved applications. The server hides correct answers, scores submissions, saves answer progress for resume, enforces one attempt per exam, and expires attempts at the published duration. This workflow is not a substitute for production-grade proctoring or high-stakes exam security.
- **Excel data** downloads one workbook with separate worksheets for accounts, applications, exam forms, notices, admit cards, center check-ins, helpdesk, mock attempts, results, answer keys, online exam questions, and online exam attempts. Passwords, password hashes, and session records are excluded. The export contains sensitive applicant information and is restricted to Super Admins.
- The language preference offers English, Hindi, Kannada, Bengali, and Marathi and is saved in the browser. Shared navigation, common login and application labels, admit-card lookup, and FAQ controls have translations; localization is still incomplete in dashboard sections, other dialogs, and detailed FAQ content. Admin-entered and database-published content stays in the language it was entered.
- Institute registration approval is a manual review of the submitted details. No certificate files are uploaded or stored; verify the registration number and address independently before approving. The site does not currently verify email ownership.

If the database was migrated before institute workflow, center check-in, exam-form, institute registration-details, portal notice, exam time-zone, or legacy application ownership-verification features were added, rerun `npm run db:migrate` to apply the new columns and tables. Back up first and use the explicitly selected database; migrations are never automatic.

## API capabilities

- Database-backed role accounts and revocable, expiring HttpOnly sessions (`/api/auth/*`).
- Public feedback submission (linked to the account when signed in); official-only feedback listing and status updates (`/api/feedback`, `/api/admin/feedback`).
- Exam application submissions; official review and admit-card assignment (`/api/applications`, `/api/admin/applications`).
- Candidate portal applications and results are scoped to the authenticated account's `user_id`; only published results are returned. Legacy unlinked applications require an official to verify ownership independently (identity-document review, registered-contact confirmation, or institution confirmation) and link the application through `POST /api/admin/applications/:id/verify-ownership`. The verifier, method, and time are stored; document numbers or copies are not collected.
- Admit-card lookup using application number, date of birth, and exam code (`/api/admit-cards/lookup`).
- Role-protected candidate dashboard data and center check-in verification for candidates assigned to that center (`/api/candidate/portal`, `/api/center/checkins`).
- Student account registration and institute registration requests with Super Admin-only approval (`/api/auth/register`, `/api/center/register`, `/api/admin/institutes`).
- Institute form submissions, profile-change review, manually verified wallet credits, and reserved/manual withdrawal processing (`/api/center/forms`, `/api/center/profile-changes`, `/api/center/withdrawals`, `/api/admin/institute-management`). Approved public institute forms are served by `/api/institute-forms`.
- Official-only exam form creation and publication with a public list containing published exams only (`/api/admin/exams`, `/api/exams`).
- Server-side scoring and persistence for the included mock practice test (`/api/mock-exams/*`).
- Official result publication and candidate lookup (`/api/admin/results`, `/api/results/lookup`).
- Super Admin Excel templates/imports/complete data export, published answer-key lookup, and candidate online-exam start, autosave, and scoring (`/api/admin/workbook-template`, `/api/admin/data-export`, `/api/admin/*/import`, `/api/answer-keys/exams`, `/api/answer-keys`, `/api/online-exams/*`).
- Super Admin notice authoring/publication and public published-notice feed (`/api/admin/notices`, `/api/notices`).
- Official-only application, feedback, result, and mock-attempt administration endpoints (`/api/admin/*`).

## Self-hosted deployment (Ubuntu Server)

The proposed deployment runs the existing Node.js + Express application, the official PostgreSQL 17 image, and Nginx with Docker Compose on a client-owned Ubuntu Server. PostgreSQL data is stored in a persistent named Docker volume. The app connects to the `postgres` service over a private Docker network with verified TLS. Compose does not automatically run migrations or import data from another database; existing records are not modified by adding this service. Express continues to serve both `dist/` and `/api` from the same origin.

### Local development TLS certificates

The following self-signed development CA and service certificates are for local testing only. They are not production certificates, must not be used on a public or client deployment, and should not be shared. The generated private keys are ignored by Git.

From the repository root, generate the CA and separate PostgreSQL and Nginx certificates:

```sh
bash scripts/generate-local-dev-certs.sh
```

The checked-out, Git-ignored `.env.development` file is a local-only Compose configuration with dummy database credentials. It is not a production template. Its settings use `APP_HOSTNAME=localhost`, `APP_ORIGIN=https://localhost`, `DEPLOYMENT_MODE=development`, and verified PostgreSQL TLS. Confirm the local cert files exist, then validate the Compose configuration without starting containers:

```sh
docker compose --env-file .env.development config
```

The file sets `POSTGRES_DB=eltnoy_dev`, `POSTGRES_USER=eltnoy_dev`, and the dummy password `local-only-not-for-production`. Compose builds the app database URL internally as `postgresql://eltnoy_dev:local-only-not-for-production@postgres:5432/eltnoy_dev`. Do not reuse these credentials outside local development.

To run a non-destructive database connectivity check after the local development app and PostgreSQL containers are already running:

```sh
bash scripts/test-local-dev-db.sh
```

The script refuses to start containers, verifies the effective Compose configuration and app connection target, confirms PostgreSQL TLS, and tests `INSERT`, `SELECT`, and `UPDATE` against a temporary table inside a transaction that it rolls back. It never writes to ELTNOY application tables and fails closed if the target is not the Docker development database.

The script writes files under `.local-dev/certs/` with private keys set to mode `600`. It refuses to replace existing certificate files unless run interactively and you confirm. The local Compose paths are already set in `.env.development`:

```dotenv
POSTGRES_TLS_DIR=./.local-dev/certs/postgres
POSTGRES_CA_FILE=./.local-dev/certs/ca/ca.crt
TLS_CERT_DIR=./.local-dev/certs/nginx
```

These match Compose's mounted paths: PostgreSQL reads `server.crt` and `server.key` from `/run/postgresql-tls`; the app trusts `/run/postgresql-ca/ca.crt`; and Nginx reads `fullchain.pem` and `privkey.pem` from `/etc/nginx/tls`. The PostgreSQL certificate has `DNS:postgres`; the Nginx certificate has `DNS:localhost` and loopback IP SANs. For local browser HTTPS, access the site at `https://localhost` and trust the generated local CA only on a development machine. Never copy the local CA private key or service keys into production.

For local Compose runs, explicitly set `DEPLOYMENT_MODE=development`, `DATABASE_SSL=true`, and the three certificate paths shown above. The app preflight rejects missing or disabled TLS and rejects any `.local-dev` certificate path unless development mode is explicitly selected. For production, set `DEPLOYMENT_MODE=production` and supply separate production PostgreSQL TLS, CA, and Nginx certificate paths outside `.local-dev`; startup is rejected if any configured certificate path points inside `.local-dev`. PostgreSQL certificate verification remains enabled in both modes.

On Linux hosts, the PostgreSQL server key must be owned by the PostgreSQL container user (currently UID 999), and the Nginx private key by the Nginx container user (UID 101); both must remain mode `600`. For example, after generation run `sudo chown 999:999 .local-dev/certs/postgres/server.key` and `sudo chown 101:101 .local-dev/certs/nginx/privkey.pem`. Do not loosen permissions to make private keys world-readable. Certificate generation does not start containers or run database migrations.

Before installation, provision an Ubuntu host, DNS name, an approved source for Docker Engine/Compose, Node/Nginx images, and npm packages, plus HTTPS certificates. Use a client-controlled registry/mirror or an approved offline package/image transfer for isolated environments. Pin and review image versions/digests before production. Certificate provisioning and renewal must use a client-approved process; certificate files are mounted read-only and are not stored in Git.

1. Install Docker Engine and the Compose plugin from the client-approved Ubuntu package source. Configure the host firewall to allow public inbound traffic only on ports 80 and 443; PostgreSQL and the application port are not published to the host.
2. Prepare PostgreSQL TLS files in a client-controlled directory: `server.crt` (server certificate and any required intermediate certificates), `server.key` (private key), and `ca.crt` (the CA that issued the server certificate). The server certificate must include `DNS:postgres` in its subject alternative names. Make the private key readable only by the PostgreSQL container user (UID 999; typically mode `0600`) and the CA certificate readable by the app's `node` user. Set `POSTGRES_TLS_DIR` and `POSTGRES_CA_FILE` to those host paths. Do not mount the private key into the app container.
3. Create `.env.production` from `.env.example` and restrict its file permissions. Set `NODE_ENV=production`, `APP_HOSTNAME` to the client-approved DNS hostname, `APP_ORIGIN` to its exact HTTPS origin without a trailing slash, and `TLS_CERT_DIR` to a host directory containing `fullchain.pem` and `privkey.pem` for that hostname. No production website hostname is preconfigured. Set `POSTGRES_DB` and `POSTGRES_USER`, and set `POSTGRES_PASSWORD` to a strong URL-safe password (for example, generate 32 random bytes encoded as hex); do not use reserved URL characters. Set `DATABASE_SSL=true`; Compose fixes certificate verification on and mounts the CA certificate for Node.js. Compose constructs `DATABASE_URL` using the internal `postgres` service hostname. Set `DATABASE_SSL` to `false` only for an explicitly approved non-TLS exception; it disables encryption and is not recommended. Compose rejects a missing/invalid value before app startup. Compose validates `APP_HOSTNAME`; Nginx substitutes it from the mounted `deploy/nginx/default.conf.template`. Nginx runs as UID/GID 101 and listens internally on unprivileged ports 8080/8443; Compose maps host ports 80/443 to those ports. Make the web certificate and key readable by GID 101 without making the private key world-readable.
4. Build the application image with `docker compose --env-file .env.production build`. The PostgreSQL service uses the official `postgres:17` image, stores data in the named `postgres_data` volume, and is reachable only over the private database network. The PostgreSQL service has a readiness health check; the app waits for it before starting.
5. Before any schema change, take an encrypted database backup and verify a restore against a separate test database. Then, only when explicitly approved, run `docker compose --env-file .env.production run --rm app npm run db:migrate`. This uses the existing idempotent schema script; it is not an ordered migration ledger.
6. Start the services with `docker compose --env-file .env.production up -d`. Verify `https://your-host/api/health`, the homepage, public APIs, login, and role-protected workflows. Review service logs without recording credentials or applicant data.
7. Create the initial official account with `docker compose --env-file .env.production run --rm -it app npm run user:create -- ADMIN-001 "Portal Administrator" official`; enter the password at the hidden prompts.

Sensitive Excel data export is limited to an explicitly designated Super Admin. The schema adds `users.is_super_admin` with a false default, so existing official accounts retain their current administrative access but do not gain export permission. After taking and verifying a backup, apply the schema update before deploying the application version that reads this column. Then, in a separate operator-controlled database session, assign the permission only to the explicitly selected, approved official account:

```sql
BEGIN;
UPDATE users
SET is_super_admin = true
WHERE login_id = upper('<EXPLICIT_APPROVED_OFFICIAL_LOGIN_ID>')
  AND role = 'official'
  AND account_status = 'approved';
-- Verify exactly one row was updated before committing; otherwise roll back.
COMMIT;
```

Do not promote all officials or expose a self-service promotion endpoint. Verify the selected account can export and an ordinary official receives HTTP 403. To revoke access, set `is_super_admin = false` for that explicitly selected login ID. This is a migration/assignment plan only; no database update was executed during this code change.

The Compose PostgreSQL service initializes a database only when its named volume is empty. Existing data in another database is not copied, overwritten, or deleted. Take and verify an encrypted backup before any migration or data import. `docker compose down` preserves the named volume; never use `docker compose down -v` or volume-pruning commands unless intentionally deleting the database after a verified backup.

Keep `.env.production`, private keys, and backups outside version control. Use encrypted, access-controlled off-host backup media under client control, a documented retention policy, and regular restore drills. To stop the application without removing the database, run `docker compose --env-file .env.production down`; this removes the app/Nginx containers and Compose network only. Do not use volume-pruning commands as part of routine rollback.

The tracked `render.yaml` and `netlify.toml` are legacy hosted-platform configurations. They are intentionally retained until the Compose build and smoke tests pass on the target Ubuntu environment; retire them only in a separately reviewed change. Do not deploy this project to Render, Netlify, or another unapproved managed platform.

## Demo limits

The current CBT question bank contains only four sample questions and its content is also bundled in the client. Treat it as practice-only, not a secure or high-stakes examination. Candidate and center accounts must be provisioned by an administrator; applications do not automatically create accounts or send confirmation email. Center check-in is limited to candidates assigned to that center by an official. Candidate exam-fee collection, automatic wallet credits or fee sharing, automatic payouts, email/SMS delivery, real file uploads, self-service registration/password recovery, production question authoring, answer-key objection workflows, biometric verification, and live AI proctoring are not configured. Institute wallet top-ups are not available in the portal; withdrawals remain manual. Do not present these capabilities as operational until their providers, workflows, and requirements are supplied and implemented.

The bundled examination calendar, notices, and center directory are sample data. The example examination dates are from 2025 and are closed; replace them with verified current schedules before launch. Published answer keys are administrator-supplied records; do not rely on any key until the Super Admin verifies and publishes it. The center directory is not an authoritative list of accredited venues.

## Production readiness and scale

This repository has not been load-tested and must not be advertised as proven for 10,000 concurrent users. Registered-user count is not the same as simultaneous traffic. Capacity depends on peak concurrent sessions, requests per second, database capacity, instance sizing, and the behavior of expensive workflows such as exam submission.

Before a public launch, use the client-owned Ubuntu deployment with HTTPS, a self-managed PostgreSQL server restricted to private access, encrypted backups, monitoring operated on approved client infrastructure, and a tested rollback plan. Size the application and database connection pools together and run a representative load test against a private staging environment. If scaling to multiple API instances, move rate-limit state to an approved shared store and configure health checks and alerts. Establish the expected peak concurrency and load-test target first; do not increase the database pool size without checking the database's connection limit.

## Institution document foundation

The document foundation supports only these confirmed categories: Registration Certificate, PAN Card, Address Proof, Affiliation / Recognition Certificate, and Authorized Person’s ID Proof. It creates no document records for existing institutions.

The standalone Milestone 1 SQL for review is `server/institutionDocumentsMigration.sql`; the additive Milestone 2 SQL is `server/institutionDocumentSubmissionMigration.sql` and depends on Milestone 1. Neither is included in `server/schema.sql` or the current `db:migrate` path; no migration has been applied. Apply only after separate review and explicit approval.

Pending institutions receive a short-lived, HTTP-only, institution- and cycle-bound capability cookie; only its SHA-256 hash is stored. The default capability lifetime is 30 minutes and `INSTITUTION_SUBMISSION_CAPABILITY_TTL_SECONDS` may set a value from 60 to 3,600 seconds. Recovery rechecks existing credentials, and capabilities can be revoked explicitly. Pending and rejected institutions do not receive normal portal sessions.

Uploads and replacements remain hard-disabled in this milestone even if file-policy variables are populated. The pending portal lists the five categories, but document counts are informational only; completeness enforcement and any change to Official approval behavior are disabled. The private storage implementation and file-content validators remain available for a later explicitly approved activation.

Milestone 2 keeps existing document rows' `submission_cycle_id` null and installs a database trigger requiring a cycle on every new document insert; the composite foreign key verifies that the cycle belongs to the same institution. Official approval or rejection revokes active submission capabilities and closes an open cycle in the same transaction as the existing status and audit-history updates.

`INSTITUTION_DOCUMENT_REVIEW_DECISION_CODES` must remain blank until the client confirms decision vocabulary and rules. Officials can then record append-only remarks without assigning an outcome. The foundation does not define approval/rejection statuses, required-document gating, per-category replacement eligibility, or malware scanning.

The self-hosted deployment must mount the configured storage directory as a persistent private volume accessible only to the non-root application process. Do not mount it into Nginx or the static client. Database backups alone do not back up document bytes; configure encrypted client-controlled backups for both the database and document volume and verify restores together.
