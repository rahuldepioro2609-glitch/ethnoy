# Internal Testing Deployment Readiness

**Status: NOT READY.** This document prepares an isolated internal-testing deployment; it does not
authorize starting containers, applying migrations, or using any production data. The current
Compose topology and Nginx configurations are statically tested, not runtime-validated.

## Readiness blockers

An internal deployment must not start until all of these are resolved:

1. **The testing stack is statically defined but has no operator configuration or runtime evidence.**
   `internal-testing.compose.yml` and `scripts/eltnoy-internal-testing.sh` use the fixed project
   `eltnoy-internal-testing`, distinct services/networks/volumes, and an isolated PostgreSQL 17
   service. The wrapper and Compose graph have not been runtime-tested. Do not use the production
   project, data, environment file, secret paths, or certificates.
2. **Testing hostnames and ingress are not approved or provisioned.** Separate Nginx templates now
   accept only four validated operator-supplied non-production hostnames. Internal DNS, certificates
   covering those exact names, and approved host/WireGuard addresses remain outstanding. Do not route
   public DNS or expose the Admin surface to create a test path.
3. **Network and runtime checks are outstanding.** Compose, Nginx, proxy trust, TLS, listener
   isolation, the host firewall's WireGuard-only Admin rule (L-5), and the P1-F checks have only
   static evidence. No container or service has been runtime-validated in the intended environment.
4. **Image and host inputs are not ready.** The operator must select and verify digest-pinned
   PostgreSQL 17 and unprivileged Nginx images, a locally built API image tag, non-overlapping
   private subnets/static addresses, and private interface/WireGuard addresses. These values must
   pass the deployment preflight; none should be guessed.
5. **Database bootstrap/migration is not authorized.** The dedicated service uses its own project-
   scoped persistent volume, database name, secret names and network. The database must be a new,
   empty, disposable testing
   database with its own volume and credentials. Do not use the production database, an existing
   user database, `eltnoy`, or `eltnoy_dev`. Do not run any migration until separately approved.
   Phase 2B additionally requires independent source review and successful PostgreSQL 17 runtime
   integration evidence; neither may be bypassed.
6. **Authentication and product workflows are limited.** The owner selected Resend for email and
   Twilio for SMS, and source adapters are registered, but deployment secret files, sender/domain
   verification, and approved abuse-limit settings are not configured or runtime-verified. Student
   and Institute verification therefore remain disabled. Staff Management is gated on privileged
   MFA, and document, payment, and outbound notification workflows remain incomplete or
   policy-blocked. Test only explicitly available flows; do not substitute fixed OTPs, real student
   data, or provider calls.
7. **Operations are not validated.** P1-F runtime checks, encrypted backup/restore rehearsal,
   rollback, monitoring, and an approved document-volume backup procedure remain outstanding.
8. **No host is selected (recorded 2026-11-21).** The owner previously required a free-only setup,
   then asked about paid hosting and requested `eltnoy.com`; no paid plan or server has been confirmed
   or provisioned. `render.yaml` (one Render web service) and `netlify.toml` (static files only, every
   `/api` call answered with HTML) cannot run the two listeners, the two Nginx surfaces, PostgreSQL 17
   with TLS, or a WireGuard-only Admin path, so neither is a substitute. Making a public platform
   hostname an Admin host is not acceptable: Admin must stay private. The stack needs an always-on Linux
   host that the owner controls (Docker, inbound WireGuard UDP, a host firewall), provisioned by the
   owner; any provider signup, card verification or billing step is the owner's to perform.
9. **The Admin domain needs DNS that the owner controls.** Admin is pinned to `admin.eltnoy.in`, the
   private domain, while the public site `eltnoy.com` serves Students and Institutes only. It must
   resolve only for WireGuard clients (split-horizon), with no public A or AAAA record. Its certificate
   must come from a private CA or a DNS-01 challenge. No DNS was changed.

## Separate testing database configuration

The testing environment needs its own operator-owned environment file and secret directory, stored
outside the repository and never copied from `.env.production`. It must have:

- A unique Compose project and a unique, empty PostgreSQL 17 data volume.
- A distinct database name such as `eltnoy_internal_test`; the exact name is an operator-controlled
  testing identifier, not a production setting.
- A testing-only database user/role bootstrap and separately generated password files for the
  PostgreSQL bootstrap, application, and migration identities. Passwords must not be stored in the
  environment file or printed.
- Separate testing CA/server TLS material and separate public/Admin Nginx certificate directories.
- Testing-only hostnames, private interface bindings, proxy addresses, subnets, static addresses, and
  image references.
- `DATABASE_SSL=true` and certificate verification enabled. Do not disable TLS to make startup pass.
- The SMS/email abuse-limit groups left empty unless and until the corresponding owner values and
  provider are approved. Empty provider configuration must continue to fail closed.

**The checked-in example is not a usable environment file.** Copy it outside the repository to the
exact basename `.env.internal-testing`, then fill every required value only after the testing host,
network, DNS, certificate and image inputs have been approved. The wrapper rejects the production
environment filenames, non-testing keys, production domains, production paths, shell interpolation,
ambient Compose/Docker variables, and values that fail its validation.

### Required environment variables

| Variable(s) | Purpose / constraint |
|---|---|
| `INTERNAL_TEST_DATABASE_NAME`, `INTERNAL_TEST_POSTGRES_USER` | Fixed to `eltnoy_internal_test` and `eltnoy_internal_test_bootstrap`; prevents accidental production DB/user selection. |
| `INTERNAL_TEST_ROOT_DIR` | Existing external directory with an `internal-testing` path component; all testing secrets, certificates and rendered Nginx configs must be below it. |
| `INTERNAL_TEST_SECRETS_DIR` | Dedicated subdirectory containing only the three role-specific password files. |
| `INTERNAL_TEST_POSTGRES_TLS_DIR`, `INTERNAL_TEST_POSTGRES_CA_FILE` | PostgreSQL server certificate/key and the CA mounted read-only into both API roles and migrator. TLS verification stays enabled. |
| `INTERNAL_TEST_PUBLIC_TLS_CERT_DIR`, `INTERNAL_TEST_ADMIN_TLS_CERT_DIR` | Separate Nginx certificate/key directories; each certificate must cover the selected testing hostname(s). |
| `INTERNAL_TEST_NGINX_RENDERED_DIR` | External directory where the wrapper writes non-secret Nginx configs, mode 0644. |
| `INTERNAL_TEST_API_IMAGE` | Unique local `localhost/eltnoy-api:internal-testing-*` tag built from this checkout; never use a production tag. |
| `INTERNAL_TEST_NGINX_IMAGE`, `INTERNAL_TEST_POSTGRES_IMAGE` | Digest-pinned Nginx unprivileged 1.19.4+ and PostgreSQL 17 references, selected/reviewed by the operator. |
| `INTERNAL_TEST_MARKETING_HOSTNAME`, `INTERNAL_TEST_EXAM_HOSTNAME`, `INTERNAL_TEST_INSTITUTION_HOSTNAME`, `INTERNAL_TEST_ADMIN_HOSTNAME` | Four distinct, approved lower-case internal names, never the `eltnoy.com` or `eltnoy.in` production domains (or any subdomain of them). |
| `INTERNAL_TEST_PUBLIC_BIND_ADDRESS` | Approved private RFC1918 host interface for internal public-surface ingress. |
| `INTERNAL_TEST_ADMIN_BIND_ADDRESS`, `INTERNAL_TEST_WIREGUARD_INTERFACE_ADDRESS` | Must match the actual WireGuard interface; Admin HTTPS is bound only there. Host firewall remains required. |
| `INTERNAL_TEST_PUBLIC_APP_SUBNET`, `INTERNAL_TEST_ADMIN_APP_SUBNET` | Distinct, non-overlapping RFC1918 Docker subnets. |
| `INTERNAL_TEST_NGINX_PUBLIC_APP_ADDRESS`, `INTERNAL_TEST_API_PUBLIC_APP_ADDRESS` | Distinct usable static addresses in the public app subnet. |
| `INTERNAL_TEST_NGINX_ADMIN_APP_ADDRESS`, `INTERNAL_TEST_API_ADMIN_APP_ADDRESS` | Distinct usable static addresses in the Admin app subnet. |
| `INTERNAL_TEST_ROLE_BOOTSTRAP_APPROVAL` | Keep `PENDING`; `bootstrap-roles` and `set-role-passwords` require explicit `APPROVED`. |
| `INTERNAL_TEST_ROLE_PASSWORDS_CONFIGURED` | Keep `NO` until role passwords are set from the test-only secrets; `migrate` and app `start` require `YES`. |
| `INTERNAL_TEST_MIGRATION_APPROVAL` | Keep `PENDING`; migration requires a separately approved `APPROVED` value. |
| `INTERNAL_TEST_PHASE2B_SOURCE_REVIEW` | Keep `PENDING`; migration requires independent source review recorded as `APPROVED`. |
| `INTERNAL_TEST_PHASE2B_POSTGRES17_RUNTIME` | Keep `PENDING`; migration requires real PostgreSQL 17 integration evidence recorded as `PASSED`. |
| `INTERNAL_TEST_SCHEMA_MIGRATIONS` | Keep `PENDING`; app `start` requires the separately approved migrations to have completed (`APPLIED`). |

These gate values are operator assertions, not cryptographic proof or substitutes for review records.
The wrapper always pins the project/file and fails closed on missing values; it never auto-runs
migrations. `DATABASE_SSL=true`, certificate verification, app `eltnoy_app`, migrator
`eltnoy_migrator`, fixed service names, and API listener/hostname mappings are set by Compose and are
not operator-overridable settings. SMS/email abuse protection remains empty and no providers are
configured.

## Safe preparation sequence

No command below starts containers or changes a database. The deployment sequence is intentionally
blocked until the testing-specific target and outstanding approvals exist.

1. Assign an internal test owner and host. Confirm that the host has no production database volume,
   production secret, or public route attached.
2. Obtain approval for four testing hostnames, private address ranges, WireGuard access, certificate
   provisioning, exact image digests, and the isolated deployment implementation.
3. Review the testing-only Compose project, wrapper, and Nginx templates. Confirm static tests prove
   they cannot reuse the production project name, volumes, environment file, secret paths, or DB host.
4. Prepare the testing-only environment and secret files outside the repository. Run the new
   testing-target preflight and a non-starting configuration render; inspect the resolved project,
   image references, published addresses, networks, mounts, and database name before any start.
5. Obtain explicit approval for each database/bootstrap/migration operation. Until then, the
   database remains empty and no application deployment command is authorized.
6. Once separately approved, rehearse only on the newly created disposable PostgreSQL 17 database.
   Complete Phase 2B's guarded integration suite and required source review before proceeding with
   any further authentication phase.
7. After a successful rehearsal and separate approval, start the internal stack with synthetic
   data only. Keep the public bind on an approved private interface and Admin reachable only via
   WireGuard and the host firewall.

### Commands currently safe to run

Static repository checks do not start services or access a database:

```sh
npm run lint
node --import tsx --test server/composeTopology.test.ts server/nginxHealthcheck.test.ts server/nginxSurfaceConfig.test.ts server/deploymentConfig.test.ts server/deploymentWrapper.test.ts server/deploymentRunner.test.ts server/deploymentDocsConsistency.test.ts server/deploymentDocs.test.ts
npm run build
```

The production deployment wrapper is never used for internal testing. Do not run these future
internal-testing commands until the corresponding approvals are recorded:

```sh
sh scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing preflight
sh scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing render-nginx
sh scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing config
sh scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing build
sh scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing start-postgres
```

Only after explicit approval for role bootstrap, initialize dedicated-cluster roles and set passwords
interactively (do not enter passwords on a command line):

```sh
sh scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing bootstrap-roles
sh scripts/eltnoy-internal-testing.sh --env-file /absolute/path/.env.internal-testing set-role-passwords
```

Only after independent Phase 2B source review, passing disposable PostgreSQL 17 integration, and
separate migration approval: set the corresponding gate values in the protected testing env file,
then run `migrate`. After separately confirming the schema migration state as `APPLIED`, run `start`.
The wrapper gates these operations but the gate values do not replace approval/evidence. `status` and
`stop` are pinned to this test project; never use `down -v`.

No commands in this document were run against Docker or a database.

## Internal smoke-test checklist

Run only after the blockers above are resolved and a test deployment is separately approved. Use
synthetic accounts and records exclusively.

### Before first start

- [ ] Confirm the environment file, secret files, certificates, database, Docker project, volumes,
      networks, and image tags/digests are all testing-only.
- [ ] Confirm private address bindings, firewall rules, WireGuard-only Admin access, and absence of
      public DNS/ingress to the test host.
- [ ] Confirm configuration render names the testing project and unique test volume/database; check
      there are no production mounts, secrets, addresses, hostnames, or image references.
- [ ] Confirm the approval record explicitly covers the database/bootstrap/migration steps planned.

### Network and service boundaries

- [ ] Verify the API and PostgreSQL ports are not published on the host.
- [ ] Verify public Nginx reaches only `api_public`, Admin Nginx reaches only `api_admin`, and neither
      Nginx has database-network access.
- [ ] Verify the two API services do not share an application network.
- [ ] Verify only the Nginx health endpoint is exposed for local container liveness; `/api/health`
      remains internal-only.
- [ ] Verify unknown host/SNI requests are refused and wrong Host/origin or forwarded identity
      headers cannot select another surface.
- [ ] Verify Admin requests fail outside the approved WireGuard path and host firewall.

### Authentication and authorization

- [ ] Verify unauthenticated and wrong-role requests are rejected before protected data access.
- [ ] Verify ordinary Officials and Super Admins match the approved route authorization matrix,
      including A-17 notice draft versus publish behavior.
- [ ] Verify Candidate, Center, and Official sessions do not substitute for each other.
- [ ] Verify absent OTP providers fail closed with the expected unavailable response; do not send
      real SMS/email or use a fixed code.
- [ ] Verify privileged MFA and staff workflows are not treated as production-ready or enabled before
      their explicit release gates.
- [ ] Verify secrets, password hashes, OTP material, and personal data do not appear in logs.

### Database and workflow checks

- [ ] Use only synthetic accounts and records in the disposable testing database.
- [ ] Verify the application connects as its least-privilege app role, with TLS verification enabled.
- [ ] Verify database role grants and role-isolation checks after the separately approved setup.
- [ ] Run Phase 2B PostgreSQL 17 integration tests only against the guarded disposable test database;
      report them as blocked/skipped until actually executed and passing.
- [ ] Verify unsupported provider-dependent payment, notification, document, and authentication
      workflows remain unavailable rather than returning success-shaped fallbacks.

### Shutdown and recovery

- [ ] Verify the approved stop procedure affects only the testing project.
- [ ] Verify the testing database and document volume backup/restore procedure on synthetic data.
- [ ] Record image identifiers, test results, logs with secrets redacted, and rollback steps.
- [ ] Confirm no test data, volume, secret, or certificate was copied to production.
