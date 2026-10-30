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

Select **Login** on the home page, or open `/login/candidate`, `/login/center`, or `/login/official` directly. Successful sign-in opens the matching protected dashboard at `/dashboard/<role>`.

- Students create an account with a login ID and password, sign in, and then apply for an open exam. Applications are tied to the signed-in account and appear in that student's dashboard. Older administrator-created candidate accounts can continue to sign in with their existing IDs.
- Institutes can submit a center login ID, institute name, contact email, registration/recognition number, registered address, optional website, and password from the institute login page. New requests remain pending and cannot sign in until a Super Admin verifies the details and approves them in **Institute approvals**. Approval only grants the center portal; institutes cannot create or publish exam forms. Exam forms are created and published by Super Admin accounts only.
- An approved center account uses its center code as its login ID. An official must assign that exact center code on the candidate's admit card. The center dashboard can then verify the candidate using the application number and date of birth and save a check-in status.
- Official accounts can review applications, update helpdesk tickets, and view practice attempts and published results.
- Officials can create exam forms under **Exam forms**. New forms are saved as drafts; selecting **Publish on website** makes the form visible in the public exam list. Unpublishing hides it and blocks new applications. The API also checks the published status and registration dates when accepting an application.
- Institute registration approval is a manual review of the submitted details. No certificate files are uploaded or stored; verify the registration number and address independently before approving. The site does not currently verify email ownership.

If the database was migrated before the center check-in, exam-form, or institute registration-details features were added, rerun `npm run db:migrate` to apply the new columns and tables.

## API capabilities

- Database-backed role accounts and revocable, expiring HttpOnly sessions (`/api/auth/*`).
- Public feedback submission; official-only feedback listing and status updates (`/api/feedback`, `/api/admin/feedback`).
- Exam application submissions; official review and admit-card assignment (`/api/applications`, `/api/admin/applications`).
- Admit-card lookup using application number, date of birth, and exam code (`/api/admit-cards/lookup`).
- Role-protected candidate dashboard data and center check-in verification for candidates assigned to that center (`/api/candidate/portal`, `/api/center/checkins`).
- Student account registration and institute registration requests with Super Admin-only approval (`/api/auth/register`, `/api/center/register`, `/api/admin/institutes`).
- Official-only exam form creation and publication with a public list containing published exams only (`/api/admin/exams`, `/api/exams`).
- Server-side scoring and persistence for the included mock practice test (`/api/mock-exams/*`).
- Official result publication and candidate lookup (`/api/admin/results`, `/api/results/lookup`).
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

The current CBT question bank contains only four sample questions and its content is also bundled in the client. Treat it as practice-only, not a secure or high-stakes examination. Candidate and center accounts must be provisioned by an administrator; applications do not automatically create accounts or send confirmation email. Center check-in is limited to candidates assigned to that center by an official. Payment processing, email/SMS delivery, real file uploads, self-service registration/password recovery, production question authoring, answer-key objection workflows, biometric verification, and live AI proctoring are not configured. Do not present these capabilities as operational until their providers, workflows, and requirements are supplied and implemented.

The bundled examination calendar, notices, center directory, and answer-key preview are sample data. The example examination dates are from 2025 and are closed; replace them with verified current schedules before launch. The center directory is not an authoritative list of accredited venues.

## Production readiness and scale

This repository has not been load-tested and must not be advertised as proven for 10,000 concurrent users. Registered-user count is not the same as simultaneous traffic. Capacity depends on peak concurrent sessions, requests per second, database capacity, instance sizing, and the behavior of expensive workflows such as exam submission.

Before a public launch, deploy behind HTTPS on a production hosting plan, use a managed PostgreSQL service with backups and monitoring, size the application and database connection pools together, and run a representative load test against a staging environment. If scaling to multiple API instances, move rate-limit state to a shared store and configure health checks, alerts, and a tested rollback plan. Establish the expected peak concurrency and load-test target first; do not increase the database pool size without checking the database's connection limit.
