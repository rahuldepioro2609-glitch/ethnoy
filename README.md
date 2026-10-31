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
- Super Admins can download the Excel upload template from **Admit cards**, **Online exams**, **Answer keys**, or **Results**. Uploads require the matching worksheet name and headers, accept up to 5,000 rows per worksheet and 5 MB per file, and are validated transactionally. Admit cards publish when imported; online exams, answer keys, and results remain drafts until explicitly reviewed and published.
- Workbook sheets and required fields:
  - `AdmitCards`: `applicationNumber`, `examCode`, `rollNumber`, `examDate` (YYYY-MM-DD), `reportingTime`, `gateClosingTime`, `examTiming`, `centerCode`, `centerName`, `centerAddress`. Each row must match an existing application; this sheet publishes cards immediately.
  - `AnswerKeys`: `examCode`, `questionNumber`, `subject` (`Mathematics`, `Physics`, `Chemistry`, or `Logical Reasoning`), `questionText`, `optionA`–`optionD`, `officialKey` (`A`–`D`), and optional `explanation`. A new import returns that exam’s key to draft status.
  - `OnlineExam`: `examCode`, `examName`, `durationMinutes`, `questionNumber`, `section`, `questionText`, `optionA`–`optionD`, `correctOption` (`A`–`D`), and optional `points` (default 1). Upload one exam code per sheet. Once an exam has an attempt, its questions cannot be replaced; create a new exam code for a revised paper.
  - `Results`: `applicationNumber`, `rollNumber`, `examCode`, `dateOfBirth` (YYYY-MM-DD), and `scorecardJson`. The JSON must match the result API schema: candidate/parent identity, DOB, gender/category/PwD status, exam and center details, `sectionScores` (section name, maximum/earned marks, percentile), total marks, aggregate percentile, ranks, qualification, cutoff marks, verification code, counseling stream, and issue date. Its roll number, application number, exam code, and DOB must match the row and a matching application. If an admit card has assigned a roll number, it must match. A valid example shape is available in the `scorecardSchema` in `server/index.ts`.
- Candidate online exams are listed only for approved applications. The server hides correct answers, scores submissions, saves answer progress for resume, enforces one attempt per exam, and expires attempts at the published duration. This workflow is not a substitute for production-grade proctoring or high-stakes exam security.
- **Excel data** downloads one workbook with separate worksheets for accounts, applications, exam forms, notices, admit cards, center check-ins, helpdesk, mock attempts, results, answer keys, online exam questions, and online exam attempts. Passwords, password hashes, and session records are excluded. The export contains sensitive applicant information and is restricted to Super Admins.
- The language preference offers English, Hindi, Kannada, Bengali, and Marathi and is saved in the browser. At present, only the utility bar and dynamic date labels are localized; the rest of the portal content remains English.
- Institute registration approval is a manual review of the submitted details. No certificate files are uploaded or stored; verify the registration number and address independently before approving. The site does not currently verify email ownership.

If the database was migrated before institute workflow, center check-in, exam-form, institute registration-details, portal notice, or exam time-zone features were added, rerun `npm run db:migrate` to apply the new columns and tables.

## API capabilities

- Database-backed role accounts and revocable, expiring HttpOnly sessions (`/api/auth/*`).
- Public feedback submission (linked to the account when signed in); official-only feedback listing and status updates (`/api/feedback`, `/api/admin/feedback`).
- Exam application submissions; official review and admit-card assignment (`/api/applications`, `/api/admin/applications`).
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

## Render deployment

The root `render.yaml` defines a single Node.js web service. Connect this repository to Render and deploy the Blueprint. It builds the frontend, applies the idempotent database schema on startup, serves the UI and API from one origin, and uses `/api/health` for health checks. It does not create a database or incur a database charge automatically.

Before deploying, provision a PostgreSQL database (Render Postgres or another provider) and set these Render environment variables:

- `DATABASE_URL`: the database connection string. Keep it secret.
- `DATABASE_SSL`: set to `true` if the provider requires TLS.
- `APP_ORIGIN`: the exact public origin, for example `https://your-service.onrender.com` (no trailing slash).
- `NODE_ENV`: set to `production` (the Blueprint sets this).

After the first deploy, create the initial official account in the Render Shell. Run the command and enter a password of 12-128 characters at both hidden prompts:

```sh
npm run user:create -- ADMIN-001 "Portal Administrator" official
```

Use the Render Shell's production environment so the account is written to the deployed database. Create candidate and center accounts as needed. Choose a database plan with backups and retention appropriate for real applicant data; do not use an expiring/free database for production.

Use HTTPS, managed database backups, restricted database access, and a secret manager. Do not commit `.env` or use the example database credentials. The app stores personal application data and dates of birth; production launch requires an appropriate privacy notice, consent/retention rules, and a data-protection review.

## Demo limits

The current CBT question bank contains only four sample questions and its content is also bundled in the client. Treat it as practice-only, not a secure or high-stakes examination. Candidate and center accounts must be provisioned by an administrator; applications do not automatically create accounts or send confirmation email. Center check-in is limited to candidates assigned to that center by an official. Candidate exam-fee collection, automatic wallet credits or fee sharing, automatic payouts, email/SMS delivery, real file uploads, self-service registration/password recovery, production question authoring, answer-key objection workflows, biometric verification, and live AI proctoring are not configured. Institute wallet top-ups are not available in the portal; withdrawals remain manual. Do not present these capabilities as operational until their providers, workflows, and requirements are supplied and implemented.

The bundled examination calendar, notices, and center directory are sample data. The example examination dates are from 2025 and are closed; replace them with verified current schedules before launch. Published answer keys are administrator-supplied records; do not rely on any key until the Super Admin verifies and publishes it. The center directory is not an authoritative list of accredited venues.

## Production readiness and scale

This repository has not been load-tested and must not be advertised as proven for 10,000 concurrent users. Registered-user count is not the same as simultaneous traffic. Capacity depends on peak concurrent sessions, requests per second, database capacity, instance sizing, and the behavior of expensive workflows such as exam submission.

Before a public launch, deploy behind HTTPS on a production hosting plan, use a managed PostgreSQL service with backups and monitoring, size the application and database connection pools together, and run a representative load test against a staging environment. If scaling to multiple API instances, move rate-limit state to a shared store and configure health checks, alerts, and a tested rollback plan. Establish the expected peak concurrency and load-test target first; do not increase the database pool size without checking the database's connection limit.
