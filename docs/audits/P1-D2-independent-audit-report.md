# ELTNOY — P1-D.2 Independent Security & Configuration Audit

| | |
|---|---|
| **Scope** | P1-D.2 Option B implementation (isolated public and Admin API instances) |
| **Repository** | `/Users/rahuldhakad/ethonoy/ethnoy` |
| **Branch** | `rc/day1-baseline` |
| **HEAD** | `df9b93ef3621a2edf212fa6eae329bc40a39dd95` |
| **Audit date** | 2026-11-11 |
| **Mode** | Strict read-only (static inspection, read-only Git, hashing, `tsc`, existing non-integration unit tests) |
| **Verdict** | **Conditional acceptance — changes required** |

## A. Executive verdict

**Conditional acceptance — changes required.** No critical or high findings. The declared topology, credential separation, listener selection and recovery ownership are correct in the source. Two medium configuration-hardening gaps should be fixed before any P1-F runtime work:

- **M-1:** how the shared API image is pulled and tagged;
- **M-2:** no guard on the Admin bind address.

### Integrity at audit start

- **Git:** HEAD `df9b93ef3621a2edf212fa6eae329bc40a39dd95`; 97 working-tree entries, 31 tracked modifications, 66 untracked, 0 staged, exactly as reported by the implementation.
- **Hashes:** all 20 P1-D.2 file hashes match the implementation report, as do `Dockerfile` (`1bc52f9b…5df02`) and the P0-4 recovery file `server/onlineExamRecovery.ts` (`c17c8b30…cfa6`).
- **P0-4 code:** `server/onlineExamFinalization.ts`, `server/onlineExamScoring.ts` and `server/mockScoring.ts` have no diff against HEAD.
- **Tests:** 569/569 non-integration server tests pass (34 files); `npx tsc --noEmit` is clean. The four integration test files were **not run** because they need a database or real HTTP:
  - `server/databaseCredentials.postgres.integration.test.ts`
  - `server/databaseGrants.postgres.integration.test.ts`
  - `server/institutionSubmission.http.integration.test.ts`
  - `server/roleLookupPostgres.integration.test.ts`

## B. Findings

| ID | Severity | File / line | Finding | Impact | Required action |
|---|---|---|---|---|---|
| M-1 | Medium | `docker-compose.yml:14-18`, `96-97` | `api_public` now has both `build` and `image: ${ELTNOY_API_IMAGE}` but no `pull_policy`. `api_admin` runs that tag with `pull_policy: never`. Before P1-D.2 the built service had no image name, so nothing could be pulled for it. | A `docker compose pull` (without `--ignore-buildable`) or `up --pull always` may fetch a same-named image from a registry. It then overwrites the local tag, and both API instances run it. That's an image-substitution (supply-chain) risk. Compose's exact behaviour here needs runtime confirmation. | Set `pull_policy: build` on `api_public`. Require a local-only name for `ELTNOY_API_IMAGE` (for example `localhost/eltnoy-api:<tag>`) in the docs and a preflight check. Confirm in P1-F. |
| M-2 | Medium | `docker-compose.yml:212`; no validation anywhere in `server/` | `ADMIN_BIND_ADDRESS` (and `PUBLIC_BIND_ADDRESS`) must only be non-empty. Nothing rejects `0.0.0.0`, `::` or a public address. | A single misconfiguration would publish the Admin Nginx beyond WireGuard. Login and roles would still apply, but the network boundary the spec requires would be gone. | Add a deployment preflight that rejects wildcard or non-WireGuard addresses (for example in `validateDeploymentConfig`, given the WireGuard range) and a test. In P1-F, verify the listening sockets. |
| L-1 | Low | `server/apiListeners.ts:64` vs `server/onlineExamFinalization.ts:108`; `server/startApi.test.ts:255-257` | `resolveActiveListeners` treats a whitespace-only `ONLINE_EXAM_RECOVERY_SINCE` as unset; the P0-4 parser treats it as set and invalid. The test asserts an Admin instance accepts it, and its comment claims P0-4 parity. That's false: it passes only because the test fakes the online-exam config loader. | Production fails closed (startup rejected), so there's no security impact, but the test proves behaviour that doesn't exist. | Align the two checks (no trimming), and test with the real config loader. |
| L-2 | Low | `docker-compose.yml:235-236` | `migrate` still builds its own image, separate from `ELTNOY_API_IMAGE`. | Migrations can run from different code than the APIs (code/schema skew). | Run `migrate` from the same image with an explicit build/pull policy, and add a test. |
| L-3 | Low | `scripts/test-local-dev-db.sh`; `.env.development` | The env files contain none of the new required variables (checked by name only). The dev script's `config` step and local `compose up` will fail on missing variables. `npm run dev:api` also needs the Vite proxy follow-up. | Local development via Compose is broken (it fails closed). | Update the development env template and script in a separate approved step. |
| L-4 | Low | `server/deploymentConfig.ts:21-23`, `44-47` | The check that the public and Admin certificate directories differ compares strings only (trailing slash and `.` segments). Symlinks or `..` aliases aren't caught, and host paths can't be resolved from inside the container. | Two paths could still point at the same directory, and so the same private key. | Add a host-side preflight using `realpath`. |
| L-5 | Low | `docker-compose.yml:212` (design) | Binding the Admin Nginx to the `wg0` address restricts the destination address, not the receiving interface (Linux "weak host" model). | Traffic addressed to the `wg0` IP but arriving on another interface relies on routing and AWS source/destination checks being correct. | Add a host firewall or `DOCKER-USER` rule allowing Admin port 443 only from `wg0`; verify in P1-F. |
| L-6 | Low (open item) | `server/institutionDocuments.ts:199-235`, `469`, `684`; `docker-compose.yml:149` | Confirmed from code: the Admin read path (`/admin/institution-documents/versions/:versionId/content` → `sendDocumentContent`) calls `ensurePrivateDirectories()`, which runs a recursive `mkdir` on the root, `quarantine` and `objects` directories. So the `api_admin` document mount remains read-write. | The Admin API keeps write access to document storage. | Possible fix: a read-only resolver for reads (`realpath` + `stat` mode/containment checks, no `mkdir`), used by `sendDocumentContent`, then mount `:ro` on `api_admin`. Prove it with a read-only filesystem test. |
| I-1 | Info | `docker-compose.yml` networks | The ingress networks aren't internal, so both Nginx containers have outbound internet access. | — | Decision D-11; optionally restrict with a host firewall. |
| I-2 | Info | `Dockerfile` | `EXPOSE 4000` only (metadata), and the `node:22-bookworm-slim` base isn't digest-pinned. | — | Address in the image-pinning step. |
| I-3 | Info | `docker-compose.yml` `restart: unless-stopped` | An invalid configuration produces a restart loop. | Intended fail-closed behaviour, but noisy. | Monitor for it. |
| I-4 | Info | `server/index.ts:2719` | Listener-selection errors are reported only after the surface configuration is valid. | Errors are surfaced over two attempts instead of one. | Optionally report both together. |
| I-5 | Info | `server/institutionSubmission.http.integration.worker.ts` | Still calls `app.listen(0)` with no gate configuration. Incompatible since P1-B; not run. | — | Rebuild it in P1-F. |
| I-6 | Info | `docker-compose.yml` IPAM | Static addresses being inside their subnets, and the two subnets not overlapping, are only checked by Docker at runtime. | Fails closed. | Add a preflight check. |

## C. Security boundary assessment

### What static inspection proves

- **Membership:** each service's networks match the required matrix exactly (`docker-compose.yml:74-79`, `150-155`, `188-191`, `218-221`, `266-267`, `295-298`):

  | Service | Networks |
  |---|---|
  | `nginx_public` | `public_ingress`, `public_app` |
  | `api_public` | `public_app`, `db_public` |
  | `nginx_admin` | `admin_ingress`, `admin_app` |
  | `api_admin` | `admin_app`, `db_admin` |
  | `postgres` | `db_public`, `db_admin`, `db_ops` |
  | `migrate` | `db_ops` |

- **No cross-reachability by declaration:**
  - the two APIs share no network;
  - the two Nginx containers share no network;
  - no Nginx is on a database network;
  - the `app` alias exists only on `public_app` (→ `api_public`) and `admin_app` (→ `api_admin`).
- **No exposure:** no `ports:` on the APIs, PostgreSQL or `migrate`; no host networking, shared namespaces, `privileged`, `cap_add` or socket mounts.
- **Secrets:** each API has only the `eltnoy_app` secret; only `migrate` has the migrator secret; only `postgres` has the superuser secret; neither Nginx has any.
- **Database TLS:** `DATABASE_SSL` required and `DATABASE_SSL_REJECT_UNAUTHORIZED: "true"` on the APIs and `migrate`.
- **Connection limits:** two pools of 10 against the `eltnoy_app` limit of 40.
- **`migrate`:** only starts under the `ops` profile.
- **TLS mounts:** each Nginx mounts only its own TLS directory, read-only; the configuration goes to `/etc/nginx/conf.d/default.conf:ro` and the includes to `/etc/nginx/includes:ro`. There's no template, `APP_HOSTNAME` or env-substitution setting; the health probes send no Host header; `server_tokens off` is set.
- **Listener selection (code):**
  - rejects unset, empty, unknown, duplicate and malformed values (`server/apiListeners.ts:41-69`);
  - allows both listeners only in development;
  - runs before the gate is configured, before the database check and before any bind (`server/index.ts:2716-2729`);
  - builds only the selected listeners (`server/index.ts:2735`).
- **Lifecycle:** readiness only after every configured listener binds; failure cleanup and persistent error handlers unchanged from the reviewed P1-B.1 code; tags, the `localPort` check, per-listener direct-peer trust, Origin and session rules unchanged (`surfaceEnforcement.ts`, `auth.ts` and `surface.ts` hashes unchanged).

### What only runtime can prove (not proven)

- Docker's isolation between networks (TCP refusals);
- that internal networks have no outbound access;
- published-port binding behaviour and the weak-host-model exposure (L-5);
- source-address preservation and the proxy addresses the APIs actually observe;
- alias resolution;
- Compose build/pull ordering with `pull_policy: never` (M-1);
- Nginx accepting the configuration and `ssl_reject_handshake` support;
- health-check timing;
- whether an Admin read works with a read-only volume.

## D. P0-3 and P0-4 regression assessment

### P0-3

- The only route-guard differences from HEAD in `server/index.ts` are the approved, stricter P1-B ones (answer keys, feedback, mock submit, internal health, forms query). P1-D.2 changed no route.
- `server/auth.ts` is unchanged, and the Super Admin wallet, withdrawal maker-checker, results, answer-key, admit-card, document, helpdesk and ownership routes are absent from the diff.
- The P0-3 suites pass.

### P0-4

- The recovery, finalization and scoring files are unchanged; the 30-second grace and the other defaults remain (`server/onlineExamFinalization.ts:102-105`).
- `FOR UPDATE SKIP LOCKED` and the conditional finalize are untouched.
- Recovery is started once per process through `startApiWithOnlineExamRecovery` with a combined "all listeners ready" object, so development's two-listener mode still starts it once.
- An Admin-only instance gets `NO_RECOVERY_HANDLE` even if validation were bypassed (`server/index.ts:2737`; the `startRecovery` selection).
- Compose gives the recovery cutoff only to `api_public` (`docker-compose.yml:64`).
- Startup and shutdown order are preserved.
- A second scoring path is impossible: the Admin instance has no recovery, and no candidate routes are reachable on the Admin listener.

## E. Test-quality assessment

### Strong

- `server/startApi.test.ts`: drives the real `startApi` with fake servers, covering single and dual listener modes, rejection of both listeners in production and staging, invalid values, recovery ownership, partial failure and shutdown order.
- `server/composeTopology.test.ts`: a strict parser that throws on unknown syntax, the exact membership matrix, credential holders, TLS mounts and health probes.
- Mutation checks during implementation were each caught.

### Weak points

1. **L-1:** `server/startApi.test.ts:255-257` asserts behaviour that production doesn't have, because it fakes the loader. Use the real `readOnlineExamConfig` for recovery tests.
2. **Bind addresses:** no test can catch a dangerous bind-address value, because no validation exists (M-2).
3. **Image pulling:** no test covers the pull policy or the shared-tag risk (M-1), or `migrate`'s image (L-2).
4. **Text-based tests:** `server/containerHardening.test.ts` and `server/nginxHealthcheck.test.ts` are regex-on-text. They pass today, but they're less robust than the structural parser and could be moved onto it.
5. **Image-tag check:** in `server/composeTopology.test.ts:204`, the lookahead `postgres:17\b(?![^\n]*#)` is convoluted; a plain check that the image fields are only `${…:?…}` would be clearer and is already partly done.
6. **Integration:** no real-HTTP or Docker test exists yet (expected for P1-F).

## F. Deployment blockers

| Blocker | Status |
|---|---|
| Image digests | Unresolved: `NGINX_IMAGE`, `POSTGRES_IMAGE` and the Node base image. None was invented: `docker-compose.yml:173`/`203`/`275` are required variables, and the test confirms no `@sha256`. |
| Image build and pull ordering | Unresolved (M-1, L-2) |
| IPAM subnets and static addresses | Unresolved (placeholders only; I-6) |
| Public and WireGuard bind addresses | Unresolved, and unvalidated (M-2, L-5) |
| Public and Admin certificates | Unresolved (only path separation is enforced; L-4) |
| Split-horizon DNS | Unresolved |
| Staging hostname variants of the Nginx files | Unresolved |
| Admin document-volume hardening | Open (L-6) |
| Paired database and document backup/restore | **Missing:** the runbook covers `pg_dump` only |
| Runtime TCP isolation and source-address preservation | Unverified (P1-F) |
| Nginx runtime configuration validation (`nginx -t`) | Not done |

## G. P1-D.2 acceptance decision

P1-D.2 is **safe to advance to P1-F planning**, with M-1 and M-2 fixed before any P1-F runtime execution. It is **not** deployment-ready.

## H. Exact remediation sequence

1. **M-1:** `pull_policy: build` on `api_public`, a local-only `ELTNOY_API_IMAGE` convention with a preflight check, and a test.
2. **M-2:** bind-address preflight validation (no wildcard, Admin within the WireGuard range) and tests.
3. **L-2:** run `migrate` from the same API image, with a test.
4. **L-1:** align the whitespace handling of the recovery cutoff, and test with the real loader.
5. **L-4 and I-6:** host-side preflight for real certificate-directory paths and subnet/address consistency.
6. **L-6:** a read-only document resolver, then a read-only mount on `api_admin`, with a read-only filesystem test.
7. **L-3:** development env template and script update.
8. **Deployment work (separately approved):** image digests including the Node base, addresses and bind addresses, certificates and DNS, staging Nginx variants, the paired backup/restore procedure, and the L-5 firewall rule.
9. **P1-F:** `nginx -t`, TCP isolation, source addresses, health checks, build/pull behaviour, end-to-end isolation tests, and rebuilding the integration worker (I-5).

## I. Integrity confirmation

During the audit:

- No file was created, modified, deleted or renamed; nothing changed after the audit started.
- No Docker or Compose command (including `config`) ran, and no Nginx, real HTTP or socket, database, migration, certificate, DNS, AWS, staging or production operation took place.
- No secrets or env values were read; env files were checked for variable names only.
- No Git staging, commit, push, fetch or branch change.
- The only commands run were read-only Git commands, hashing, `tsc` and the existing non-integration unit tests.

*This report file was saved afterwards, on request, as the only change: `docs/audits/P1-D2-independent-audit-report.md`.*

### Verified P1-D.2 file hashes (SHA-256)

| File | SHA-256 |
|---|---|
| `docker-compose.yml` | `950feb85d5fd3a762178ae1c70cb4b477819f7a7a65669cf1bafb5de6b4bf19f` |
| `server/apiListeners.ts` | `720b0a716ab05d66952bc37f05024c5eccd4e4fcf78eb8b7d21ab8bddcba6ae3` |
| `server/index.ts` | `7754931c868bb8c17baa88ad6b1d0ab8ff0271936724f198bb97fd9d8496165f` |
| `server/deploymentConfig.ts` | `9a900f13de349575bacb5af47f2d07e9a85fe0bde56945ec70094e140c126632` |
| `server/validateDeploymentConfig.ts` | `1f484c29860d2ddcf65ec348d1318cfcab959201418f7142496917b786b2ecef` |
| `deploy/nginx/public.conf` | `107a2a9bad4f9638d8777ef6196b3106bd15c8eaa0dac6f0e5bfff8245c50358` |
| `deploy/nginx/admin.conf` | `76ef3f22ca34e7a3c7223f6f016977cca451f897434176444312f9f62d8d8830` |
| `.env.example` | `f185e9ff3e4ad706d52e8fb0582b207c20cd6664bc28be54ba96ba93e7144ef8` |
| `README.md` | `c29840ef1b1ad6f4e786f2c2f585c192e7c86443c641d72d0dcb7e6e2bdad502` |
| `docs/operations/production-operator-runbook.md` | `b272e82d25be94e2a58b6c8241ad587c65bf3fc6369b80da710f4bb905f9869d` |
| `docs/architecture/secure-database-credentials.md` | `e59f275aa54c7d6b0386645804dff63135a3395a156f515ce278c8e36098f67c` |
| `scripts/test-local-dev-db.sh` | `e33d5ddd0e2463a252fbd7356739c8dbe4dfcf4d1d5817d3ee16f77728f40861` |
| `server/composeTopology.test.ts` | `a7a056d765d3a4a61a7cc628cd4d351ea19091785c2f2ab55396d8beea7f58fb` |
| `server/startApi.test.ts` | `d5b9e83d9ea7c1e49d5c7613aca4685f1914bd802bb4ecfc79eae1a0cc7d3670` |
| `server/apiListeners.test.ts` | `acdae511faa0d7aecd486f73939d731c9a42e5a1d37061ebdb32313c2554ad2f` |
| `server/containerHardening.test.ts` | `3c3c4fae02df1f1e056bdb9c2a27645a6f70e25357c7d64f4effb4ac7c85365d` |
| `server/deploymentConfig.test.ts` | `a3508cfb4124a90c22879717caaa1b0643fbcd32b9f25ade2cb4c7933cfb99c1` |
| `server/nginxHealthcheck.test.ts` | `989fe778913a21f972e6c254dc0736e98dbfb446e3696e379e102cf44532e558` |
| `server/nginxSurfaceConfig.test.ts` | `a7b12b05bd5abba837f694ebc69cea591b0bf786b78487a418bdab29d8d15c99` |
| `server/onlineExamStartupConfig.test.ts` | `f112d1fb2d9f8e5a779f13fb9fbff045844497faf7ae886ad8c6f42fcd5f808a` |
| `server/onlineExamRecovery.ts` (P0-4, unchanged) | `c17c8b3057ba9ee015bb063379ffeace191be6f9231507397653d0c6af40cfa6` |
| `Dockerfile` (unchanged) | `1bc52f9b849e66bb42eabaf155452b52c189d626e85b1b136e94192a2925df02` |
