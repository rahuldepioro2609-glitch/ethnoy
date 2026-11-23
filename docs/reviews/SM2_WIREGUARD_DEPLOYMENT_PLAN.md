# SM-2 WireGuard Deployment Plan (Admin surface)

**Status:** Plan only. **No host, network, firewall, Docker, Compose, Nginx or DNS change was made, and nothing was validated live.** Every check in §5 is still to be performed (P1-F).
**Date:** 2026-11-14. **Updated 2026-11-21:** the Admin hostname moved from `admin.eltnoy.com` to the private domain `admin.eltnoy.in` (owner requirement: the public `eltnoy.com` serves Students and Institutes only). References below use the new name; the legacy name is served by neither Nginx.
**Policy:** SM2-P02 is APPROVED. Platform Staff work **only** on the Admin surface, and the Admin surface is reachable **only over WireGuard**. This is a go-live condition for Staff Management.

## 1. What the repository already enforces (evidence)

| Layer | Control | Evidence |
|---|---|---|
| Application surface | Platform Staff routes and pages exist only on `admin`; Organization Staff only on `institution`; Super Admin staff management only on `admin` | `server/surface.ts:604-633`, `:644`; tests `surface.test.ts:431`, `:703`, `:777` |
| Listener and host binding | The Admin API listener (4001) accepts only its configured proxy peers and the exact `admin.eltnoy.in` original host | `server/surfaceEnforcement.ts:560-588`; `deploy/nginx/admin.conf:19-28` |
| Separate ingress | A separate `nginx_admin` container with a separate certificate directory, proxying only to `api_admin` | `docker-compose.yml:220-243`; `admin.conf:15-21`, `:76-86` |
| Bind to the tunnel address | `nginx_admin` publishes only `${ADMIN_BIND_ADDRESS}:443`. If the address is absent, Docker cannot bind and the container does not start | `docker-compose.yml:228-230` |
| Preflight | `ADMIN_BIND_ADDRESS` must equal `WIREGUARD_INTERFACE_ADDRESS` in a private/shared tunnel range; the public bind is separately validated (private ENI by default, or explicit direct-VPS public IP with firewall controls) | `server/deploymentConfig.ts`; `production-operator-runbook.md` §14.8 |

## 2. What is missing or unverified

| Gap | Why it matters | Evidence |
|---|---|---|
| **Host firewall restricting 443 on the `wg0` address to tunnel peers (audit L-5)** | The preflight cannot prove the address is really on `wg0`. Anyone with Docker access can bypass the wrapper | Runbook `:562`, `:626` |
| **No Nginx allow-list for the tunnel subnet** | `admin.conf` states that nothing there is network isolation | `deploy/nginx/admin.conf:8-10` |
| **P1-F runtime checks not performed** | Socket bindings, peer addresses, 421/444 handling and split-horizon DNS are unverified | Runbook `:543` |
| **WireGuard itself is not in the repository** | Peer keys, the address plan and the listening port are operator artefacts | — |
| **The Admin TLS certificate cannot use public HTTP validation** | Admin is not publicly reachable; the issuance method is undecided (OI-7) | — |

## 3. Target design

```
Super Admin / Platform Staff device ──(WireGuard UDP, one key pair per person)──► host wg0 (e.g. 10.x.y.1/24)
                                                                         │
                                       nginx_admin bound to wg0 address:443 (TLS, admin.eltnoy.in)
                                                                         │ admin_app network
                                                                  api_admin :4001 (admin listener only)
```

- **One peer per person.** No shared keys. The private key is generated on the person's device and never leaves it; only the public key is registered. `AllowedIPs` on the server is a single `/32` per peer.
- **Peer register (offline, access-controlled):** person, role (Super Admin or Platform Staff), public key, tunnel address, issue date, expiry or review date. It is the source for revocation.
- **Tunnel addressing:** a dedicated private `/24` that does not overlap the VPC, Docker subnets (`PUBLIC_APP_SUBNET`, `ADMIN_APP_SUBNET`) or the host (runbook `:539`).
- **Client configuration:** route only the tunnel subnet (split tunnel), with `AllowedIPs = <server tunnel address>/32` or the tunnel `/24`. Use `PersistentKeepalive` only where NAT requires it.
- **DNS:** `admin.eltnoy.in` resolves to the `wg0` address **only for tunnel clients** (split-horizon, as the runbook anticipates). No public A or AAAA record points at the Admin service.
- **Cloud security group:** inbound UDP on the WireGuard port. TCP 443 on the `wg0` address is never exposed through the security group, and SSH follows the existing host policy.
- **Host firewall (L-5), nftables or equivalent:**
  - allow `tcp dport 443` with destination the `wg0` address only when `iifname "wg0"` and the source is in the tunnel subnet;
  - drop TCP 443 to the `wg0` address arriving on any other interface;
  - make sure Docker's own rules (the `DOCKER-USER` chain) do not bypass this, because Docker inserts its published-port rules ahead of host rules.
- **Defence in depth (recommended code/config change, needs approval):** in `admin.conf`'s 8443 server block, add `allow <tunnel subnet>; deny all;`. This only works if `$remote_addr` is the real WireGuard peer, which P1-F must confirm.

## 4. Operating procedures

| Procedure | Steps |
|---|---|
| **Onboard a person** | Approval recorded. The person generates a key pair on their device and sends the **public** key. The operator adds a peer (`/32`) and reloads with `wg syncconf` (no restart). Register entry made. Test from the device. The application account (Super Admin MFA enrolment, or Platform Staff account creation) is a separate step. |
| **Offboard or revoke** | Remove the peer and `wg syncconf`. Deactivate the Platform Staff account (ends sessions, `platformStaff.ts:239-243`), or remove the Super Admin flag through the approved process. Disable the MFA factor. Register entry closed. |
| **Lost device** | Revoke the peer immediately; then follow the MFA lost-factor procedure. |
| **Key rotation** | Period is decision OI-7. Rotate the server key with overlap by adding the new peer configuration before removing the old one. |
| **Monitoring** | `wg show` latest-handshake per peer; alert on a handshake from an unregistered or long-idle peer; Nginx admin access log at the `$remote_addr` level (no secrets). |
| **Host prerequisites** | NTP time sync (also needed by TOTP MFA); unattended security updates according to host policy. |

## 5. Validation checklist (P1-F; none performed yet)

From outside the tunnel:
- [ ] `admin.eltnoy.in` does not resolve publicly, or does not connect.
- [ ] TCP 443 on the host's public address does not serve Admin. `public.conf` has no `admin.eltnoy.in` server, so the Admin SNI should hit the default server: TLS handshake rejected (`deploy/nginx/public.conf:95-97`), and 444 on HTTP (`:51`).
- [ ] A port scan of the public interface shows no 4000, 4001 or 5432.

From inside the tunnel:
- [ ] The Admin UI and `/api/platform-staff/auth/login` work.
- [ ] `/api/org-staff/*` and `/api/center/staff*` answer 404 on Admin (surface deny).

On the host and in containers:
- [ ] `ss -ltnp` shows `nginx_admin` only on the `wg0` address:443.
- [ ] Stopping `wg0` stops the Admin Nginx from binding (fail closed).
- [ ] The observed proxy peer equals `NGINX_ADMIN_APP_ADDRESS`.
- [ ] `$remote_addr` is the WireGuard peer.

Firewall:
- [ ] Traffic to the `wg0` address:443 from a non-`wg0` interface is dropped, including through Docker-published rules.

Application:
- [ ] A Super Admin session from Exam or Institution is refused.
- [ ] Platform Staff cookies are not sent to other paths (path scope).
- [ ] MFA is required (after SM2-P03 is implemented).

Revocation:
- [ ] A removed peer can no longer complete a handshake.

Record each result with date, operator and evidence in the runbook audit record. Do not claim validation without it.

## 6. Out of scope for this review

- Choosing the WireGuard host OS packaging, cloud account settings or a certificate authority.
- Any change to `docker-compose.yml`, `deploy/nginx/*`, the preflight or the host.
- Each of those needs separate approval.
