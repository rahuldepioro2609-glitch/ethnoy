# Phase 1 — Official verifier foundation

## Status and scope

This phase adds an independently runnable Node service foundation under `server/verifier/`. It does not connect to PostgreSQL, read real Official credentials, migrate MFA rows, issue sessions, implement a public login endpoint, or alter the existing Express authentication flow. Express remains the active implementation until a separately approved cutover.

The verifier process has no import path to `server/index.ts`, `server/auth.ts`, `server/adminMfa.ts`, `server/adminMfaStore.ts`, or the application database pool. It reuses only the transport-independent TOTP primitives in `server/adminMfaCore.ts`; that module contains cryptographic functions but no Express, database, or session access.

The private-address bind check does not prove host isolation. A separate process on the application VPS is suitable only for development or controlled testing. Production must use a separate verifier host, dedicated service identity, private network controls, and authenticated service-to-service transport; these infrastructure properties cannot be established by this repository-only foundation.

```text
Browser ── HTTPS ──> auth.eltnoy.com (trusted UI; not implemented here)
                           │
                           │ private network; future authenticated protocol
                           ▼
              Independent verifier process
              ├── Ed25519 assertion key interface
              ├── versioned AES-256-GCM MFA key interface
              ├── bcrypt compatibility adapter
              ├── transaction / browser / challenge binding
              └── health/readiness only over HTTP in Phase 1

api.eltnoy.com gateway ── future private verifier protocol
          │
          └── PostgreSQL proof/session transaction: NOT IMPLEMENTED

Existing Express Official login ── unchanged until approved cutover
Candidate and Center authentication ── unchanged
```

The HTTP listener accepts only a private or loopback IP address. Health endpoints return fixed status strings and do not include environment, key IDs, user identity, or dependency detail. `/healthz` reports process liveness; `/readyz` intentionally remains 503 because no credential repository, auth route, or atomic assertion consumer is wired. No request-body authentication endpoint is exposed; this prevents a partially wired service from being mistaken for the approved authentication boundary.

## Existing Official authentication dependencies (source review)

- `server/index.ts` handles `POST /api/auth/login`, selects `password_hash` from `users`, compares bcrypt credentials, and calls `beginAdminMfaSignIn` for approved Official accounts. Candidate and Center branches remain in the same route and were not modified.
- `server/adminMfa.ts` loads the Express process's `ADMIN_MFA_ENCRYPTION_KEY_FILE`, provisions/encrypts TOTP factors, decrypts factors for code verification, and sets the `elt_session` cookie after successful verification.
- `server/adminMfaStore.ts` owns challenge/factor lookup and transactional replay/session/evidence logic, but the code check callback is supplied by the Express MFA module.
- `server/auth.ts` extracts the shared `elt_session` cookie and looks up session hashes/Official MFA evidence for authorization.
- `server/schema.sql` stores `users.password_hash` for all roles and `auth_sessions.token_hash`; Official credential separation has not happened.
- `server/adminMfaMigration.sql` stores encrypted TOTP records and existing challenge/evidence/reset tables. No Phase 1 change was made to it.
- `server/databaseGrantsMigration.sql` and `server/databaseRoleBootstrap.sql` retain existing grants/ownership. These are not a verifier role design and were not changed.

## Verifier configuration and key custody

Run using `npm run start:verifier`; it does not load the application `.env` file. Configuration is injected through the process environment:

| Variable | Requirement |
|---|---|
| `VERIFIER_BIND_HOST` | Required loopback, RFC1918, IPv4 link-local, or IPv6 local/private IP literal. Public/wildcard addresses are rejected. |
| `VERIFIER_PORT` | Required integer 1–65535. |
| `VERIFIER_AUTH_ORIGIN` | Required origin only; production is exactly `https://auth.eltnoy.com`. Local HTTP is allowed only for localhost/loopback. |
| `VERIFIER_SIGNING_KEY_FILE` | Absolute path to a PEM Ed25519 private key; file must not grant group/other permissions. In production, the file must be owned by the verifier process effective UID. |
| `VERIFIER_SIGNING_KEY_ID` | Required non-secret signing key identifier. |
| `VERIFIER_MFA_KEY_FILE` | Separate absolute path to exactly 32 raw key bytes; file must not grant group/other permissions. In production, the file must be owned by the verifier process effective UID. |
| `VERIFIER_MFA_KEY_VERSION` | Positive integer stored with encrypted factor material. |

No key is generated at startup. Signing and encryption use different files and interfaces. Files are opened read-only with no-follow semantics, then checked through the opened descriptor as regular files with no group/other permissions. Symlink paths fail closed. Production requires the key files to be owned by the verifier process's effective UID. Non-production environments do not enforce ownership, but still require regular files with restrictive permissions. For local development, key files should be owned by the developer wherever practical.

The key-file parent directories must also be provisioned and writable only by trusted operators; the no-follow open protects the final path component, not a hostile or replaceable parent directory. Production mounts should be read-only and controlled outside the application account.

The signing interface is Ed25519 and binds a `keyId`; the MFA interface uses AES-256-GCM, binds a key version, and authenticates a length-prefixed tuple of domain identifier, key version, user ID, and factor ID as associated data. Each tuple field is prefixed by its four-byte big-endian UTF-8 byte length, avoiding delimiter ambiguity. Identifier inputs must be strings of 1–128 UTF-8 bytes and reject NUL or invalid UTF-8 round trips. Unknown key/AAD versions, malformed envelopes, identity substitution, or authentication-tag failures are rejected.

The AAD format change is **not backward-compatible** with ciphertext produced using the prior delimiter-only AAD. Envelopes explicitly require `aadVersion: 2`; older rows do not contain this discriminator and must not be interpreted as version 2. Existing production ciphertext has not been read or changed. Before any future migration, the storage schema must carry an AAD-format version independently of the encryption-key version, and a controlled migration/rollback plan must be approved. No legacy fallback is implemented.

`destroy()` overwrites the verifier-owned MFA key buffer and drops the signing closure's reference to its private `KeyObject`, disabling further signing through that interface. Node.js does not expose a supported guarantee that an Ed25519 `KeyObject`'s native private-key memory is zeroized when references are dropped or garbage-collected. The source does **not** claim signing-key zeroization. Production therefore requires separate-host/process isolation, a dedicated least-privilege service identity, protected key-file or external key custody, audited key access, and an operator-approved rotation/revocation procedure with key IDs and verifier/gateway overlap management. Rotation and remote custody are not implemented.

Phase 1 loads one active MFA key version only. Multi-version decryption, controlled rotation, KMS/HSM integration, key backup, and the migration of existing ciphertext remain unimplemented.

## Bcrypt compatibility

`server/verifier/passwords.ts` compares synthetic or future repository-provided bcrypt hashes using the existing `bcryptjs` dependency. It neither rewrites hashes nor logs credentials. Malformed stored hashes, oversized values, and wrong passwords return a generic false result. The adapter matches the current login API's 128-character input limit and preserves `bcryptjs`'s existing 72-byte truncation behavior for legacy hashes; new registration already has a stricter 72-UTF-8-byte limit in `server/auth.ts`.

No credential repository, production dummy-hash policy, Official hash migration, or user-facing password endpoint exists. Unknown-user timing behavior and account status policy must be integrated and tested when the isolated credential store is approved. No existing hash is read or copied.

## Authentication protocol foundation

### Transaction

The strict transaction schema contains:

- immutable transaction UUID;
- exact Official user ID;
- purpose: `official_login` or `official_enrolment`;
- SHA-256 hashes of high-entropy challenge and browser-binding values;
- creation and expiry time in Unix seconds;
- `pending`, `completed`, or `consumed` state.

Validation checks the transaction state and IDs, purpose, expiry, future creation time, explicit maximum lifetime, challenge hash, and browser-binding hash. Comparisons of the fixed-size hashes use constant-time equality. Challenge and browser-binding raw values are not included in assertions or logs.

The verifier API requires an explicit `maxLifetimeSeconds` policy argument. It has no default and is not sourced from an environment variable. The approved 30-second assertion TTL does not determine the authentication-transaction lifetime. The owner must approve that lifetime before wiring transaction issuance or assertion signing into a service route.

### Assertion

Assertions use a strict, versioned JSON claim shape and detached Ed25519 signature over a deterministic serialization:

```text
version, issuer, audience, keyId, assertionId, transactionId, userId,
purpose, challengeHash, browserBindingHash, issuedAt, expiresAt
```

Issuer and audience are fixed to the verifier and API/session-gateway protocol identifiers. `assertionId` is a UUID. The lifetime is exactly 30 seconds; a 5-second skew is allowed at the `issuedAt` and expiry boundaries. A proof for one purpose cannot satisfy the other purpose. Validation binds the assertion to the expected transaction, user, challenge, browser and purpose.

### Browser binding and transaction issuance (design, not live protocol)

In the eventual flow, the verifier—not Express—must create the transaction after the verifier has authenticated the Official. The trusted authentication origin will hold a random browser-binding token in a Secure, HttpOnly, SameSite cookie scoped to `auth.eltnoy.com`; only its hash is stored with the transaction. Mutations must enforce exact Origin/CSRF checks and must not accept browser-binding values from Express. Transaction issue/consume persistence and origin behavior are not implemented here.

### Replay and atomic database consumption

Phase 1 has no production replay store. A unit test uses a test-local in-memory fake only to demonstrate duplicate-ID detection; this is **not database-backed or cross-process replay protection**. The future verifier/gateway database operation must consume `assertionId` atomically with the purpose-specific proof, session, evidence, and audit mutations, using database time and an approved NOLOGIN function owner. PostgreSQL 17/pgsodium API and role ownership remain unvalidated blockers.

### Separate proof purposes

- `official_login`: proves a confirmed, active factor was verified for an existing login transaction. It must not enroll or replace a factor.
- `official_enrolment`: proves successful first-time enrollment confirmation bound to its own challenge/ticket transaction. It must not authorize login before confirmation or authorize reset/recovery.

No database write, reset/recovery flow, ticket store, first-time UI, assertion consumer, or session issuance is included.

## Rate limiting and security logs

The HTTP foundation uses a bounded in-process 60-requests/minute per direct peer-address transport limiter; it ignores forwarded headers and returns generic 429 responses. It covers unknown routes as well as health/readiness. It is not a password/account lockout policy and does not provide distributed limits. Before any authentication route or multi-instance deployment, add an approved shared rate-limit strategy, account/identifier controls, proxy identity configuration, and monitoring.

Security events are JSON records with a closed event vocabulary and optional safe code/route fields only. Request bodies, passwords, hashes, OTPs, cookies, headers, keys, and raw IP addresses are not logged. HTTP errors return generic JSON status bodies.

## Validation and tests

`npm run test:verifier` runs synthetic bcrypt, config validation, temporary disposable key-file, assertion-boundary, test-only replay, rate limiter, and health/readiness tests. Temporary Ed25519/MFA test keys are generated only in the test process and removed from the OS temporary directory. These tests do not use database access, real credentials, production keys, sessions, or provider calls.

## Remaining integration blockers

1. Approved separate-host network identities and the trusted `auth.eltnoy.com` UI/API protocol.
2. Verifier-only Official credential persistence, identity/account-status resolution, safe password migration, and unknown-user timing policy.
3. Persistent browser-bound transactions/tickets and idempotent failure/recovery behavior.
4. Gateway-owned session tokens/cookies and encrypted five-minute delivery receipts.
5. PostgreSQL 17 exact image and pgsodium/function compatibility validation; dedicated verifier/gateway/database roles and NOLOGIN proof-function ownership.
6. Atomic one-time assertion consumption with enrollment/login proof, session, evidence and audit writes.
7. Multi-version MFA keyring and controlled migration of existing TOTP ciphertext without losing factor IDs/state/replay counters.
8. Approved MFA recovery authority, reset, password-change and lockout policies.
9. Shared/distributed authentication rate limiting, monitored NTP, key rotation/revocation, backup and restore acceptance.
10. Explicitly approved cutover plan; until then, Express Official login remains active and its current shared credential/key boundary remains a known risk.
11. Operator approval of the authentication-transaction maximum lifetime; assertion lifetime/skew do not answer this policy.
