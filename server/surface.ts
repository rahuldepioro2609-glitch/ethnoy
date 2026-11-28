// P1-A: pure surface-isolation policy (specification P1 Surface Isolation v1.4).
//
// This module only DESCRIBES policy. It has no side effects, reads no environment, mounts no
// middleware and is not imported by the application. P1-B will wire it into Express after the
// trusted proxy peer and the original-host header have been verified.
//
// Surfaces and hostnames are pinned and matched exactly (no suffix or wildcard matching). Nothing
// here trusts Host, X-Forwarded-Host or any other client header: callers pass the already-trusted
// original-host value (P1-B) and the surface derived from the local listener port.
//
// Route matching mirrors Express 4 defaults (case-insensitive, one optional trailing slash, raw
// percent-encoded path, HEAD handled by GET routes). Where Express would route an unusual spelling,
// this matcher either selects the same route or rejects the path as malformed; it never selects a
// different route. Every unmatched request fails closed.

export const SURFACES = ['marketing', 'exam', 'institution', 'admin'] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * Pinned production hostnames (P1 v1.4 §2). The public site (eltnoy.com) serves Students and
 * Institutes only. Admin and Staff access is private and lives on the separate eltnoy.in domain
 * (owner decision 2026-11-21): a different registrable domain from the public site, reachable only over
 * WireGuard with split-horizon DNS, never published in public DNS or linked from the public surfaces.
 */
export const PINNED_SURFACE_HOSTNAMES: Readonly<Record<Surface, string>> = Object.freeze({
  marketing: 'eltnoy.com',
  exam: 'exam.eltnoy.com',
  institution: 'institution.eltnoy.com',
  admin: 'admin.eltnoy.in',
});

/** Registrable production domains. Staging, development and internal testing must use neither. */
export const PRODUCTION_DOMAINS = Object.freeze(['eltnoy.com', 'eltnoy.in'] as const);

/** True for a production domain or any subdomain of one (case-insensitive). */
export function isProductionDomainHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return PRODUCTION_DOMAINS.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

export type SurfaceHostnames = Readonly<Record<Surface, string>>;

export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && (SURFACES as readonly string[]).includes(value);
}

/** Surfaces served to the public internet. The Admin surface is private (WireGuard-only ingress). */
export const PUBLIC_SURFACES = Object.freeze(['marketing', 'exam', 'institution'] as const satisfies readonly Surface[]);

/**
 * Hostnames a surface may tell the browser (GET /api/surface-hostnames). Public surfaces disclose only
 * the public hostnames, so the public site never learns or links the private Admin hostname; the Admin
 * surface may disclose all four (public hostnames are public).
 */
export function disclosedSurfaceHostnames(surface: Surface, hostnames: SurfaceHostnames): Readonly<Partial<Record<Surface, string>>> {
  const visible: readonly Surface[] = surface === 'admin' ? SURFACES : PUBLIC_SURFACES;
  return Object.freeze(Object.fromEntries(visible.map((name) => [name, hostnames[name]])) as Partial<Record<Surface, string>>);
}

// ---------------------------------------------------------------------------
// Original host: parsing and exact validation
// ---------------------------------------------------------------------------

export type HostParseResult =
  | { ok: true; hostname: string }
  | { ok: false; reason: 'missing' | 'empty' | 'multiple_values' | 'port_not_allowed' | 'malformed' };

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Parses the original-host value that the trusted proxy copies from the client request
 * (X-ELTNOY-Original-Host, set from $http_host). Rejects missing, empty, comma-separated,
 * port-qualified, bracketed/IPv6, userinfo, path, whitespace and otherwise malformed values.
 * Case is normalised; nothing else is.
 */
export function parseOriginalHost(raw: unknown): HostParseResult {
  if (raw === undefined || raw === null) return { ok: false, reason: 'missing' };
  if (Array.isArray(raw)) return { ok: false, reason: 'multiple_values' };
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  if (raw.includes(',')) return { ok: false, reason: 'multiple_values' };
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'malformed' };
  if (raw.includes('[') || raw.includes(']') || raw.includes('@') || raw.includes('/') || raw.includes('\\')) {
    return { ok: false, reason: 'malformed' };
  }
  if (raw.includes(':')) return { ok: false, reason: 'port_not_allowed' };
  const hostname = raw.toLowerCase();
  if (hostname.length > 253 || hostname.startsWith('.') || hostname.endsWith('.')) return { ok: false, reason: 'malformed' };
  const labels = hostname.split('.');
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL.test(label))) return { ok: false, reason: 'malformed' };
  return { ok: true, hostname };
}

/** Exact (case-normalised) hostname → surface. Unknown hostnames return null (fail closed). */
export function surfaceForHostname(hostname: string, hostnames: SurfaceHostnames = PINNED_SURFACE_HOSTNAMES): Surface | null {
  const parsed = parseOriginalHost(hostname);
  if (!parsed.ok) return null;
  for (const surface of SURFACES) {
    if (hostnames[surface] === parsed.hostname) return surface;
  }
  return null;
}

/**
 * True only when the trusted original-host value names exactly the hostname configured for the
 * surface of the receiving listener (P1-B derives that surface from the local port).
 */
export function isOriginalHostValidForSurface(raw: unknown, surface: Surface, hostnames: SurfaceHostnames = PINNED_SURFACE_HOSTNAMES): boolean {
  if (!isSurface(surface)) return false;
  const parsed = parseOriginalHost(raw);
  return parsed.ok && hostnames[surface] === parsed.hostname;
}

/** Configuration check for P1-B: every surface has a distinct, valid, exact hostname. */
export function validateSurfaceHostnames(candidate: unknown): string[] {
  const errors: string[] = [];
  if (typeof candidate !== 'object' || candidate === null) return ['surface hostname configuration must be an object'];
  const record = candidate as Record<string, unknown>;
  const seen = new Map<string, Surface>();
  for (const surface of SURFACES) {
    const value = record[surface];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${surface}: hostname is required`);
      continue;
    }
    if (value.includes('*')) {
      errors.push(`${surface}: wildcard hostnames are not allowed`);
      continue;
    }
    const parsed = parseOriginalHost(value);
    if (!parsed.ok) {
      errors.push(`${surface}: hostname is invalid (${parsed.reason})`);
      continue;
    }
    if (parsed.hostname !== value) errors.push(`${surface}: hostname must be lower-case`);
    const previous = seen.get(parsed.hostname);
    if (previous) errors.push(`${surface}: hostname duplicates ${previous}`);
    seen.set(parsed.hostname, surface);
  }
  for (const key of Object.keys(record)) {
    if (!isSurface(key)) errors.push(`unknown surface: ${key}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Roles: sessions and login
// ---------------------------------------------------------------------------

export type PortalRole = 'candidate' | 'center' | 'official';

/** Session roles accepted on each surface. Super Admin is an Official with is_super_admin. */
export const SURFACE_SESSION_ROLES: Readonly<Record<Surface, readonly PortalRole[]>> = Object.freeze({
  marketing: Object.freeze([]),
  exam: Object.freeze(['candidate'] as const),
  institution: Object.freeze(['center'] as const),
  admin: Object.freeze(['official'] as const),
});

export interface SessionPrincipal {
  role: unknown;
  isSuperAdmin?: unknown;
}

function isPortalRole(value: unknown): value is PortalRole {
  return value === 'candidate' || value === 'center' || value === 'official';
}

/** A session is usable only on the surface its role belongs to. Unknown roles are denied. */
export function isSessionAllowedOnSurface(surface: Surface, principal: SessionPrincipal | null | undefined): boolean {
  if (!isSurface(surface) || !principal || !isPortalRole(principal.role)) return false;
  if (principal.isSuperAdmin === true && principal.role !== 'official') return false;
  return SURFACE_SESSION_ROLES[surface].includes(principal.role);
}

/**
 * Login role allowed on a surface, checked BEFORE any user lookup (P1-B). Super Admin logs in with
 * role 'official', so it is covered by the Admin row. Marketing accepts no login.
 */
export function isLoginRoleAllowedOnSurface(surface: Surface, role: unknown): boolean {
  return isSurface(surface) && isPortalRole(role) && SURFACE_SESSION_ROLES[surface].includes(role);
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

export const STATE_CHANGING_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE'] as const);

/**
 * Explicit missing-Origin policy: every state-changing request on every surface must carry an
 * Origin header. Browsers send Origin on same-origin fetch/XHR POST, PUT, PATCH and DELETE, so only
 * non-browser clients are affected. (Stricter than the pre-P1 rule, which allowed a missing Origin
 * when no session cookie was present; recorded for P1-B review.)
 */
export const MISSING_ORIGIN_POLICY = 'reject_state_changing_on_every_surface' as const;

export function expectedOrigin(surface: Surface, hostnames: SurfaceHostnames = PINNED_SURFACE_HOSTNAMES): string {
  return `https://${hostnames[surface]}`;
}

export type OriginDecision =
  | { allowed: true; reason: 'not_state_changing' | 'exact_match' }
  | { allowed: false; reason: 'missing' | 'null' | 'multiple_values' | 'malformed' | 'cross_surface' | 'marketing_is_not_a_portal' | 'unknown_surface' };

/** Exact https origins for the given hostnames (production and staging). */
export function expectedOrigins(hostnames: SurfaceHostnames = PINNED_SURFACE_HOSTNAMES): Readonly<Record<Surface, string>> {
  return Object.freeze(Object.fromEntries(SURFACES.map((surface) => [surface, expectedOrigin(surface, hostnames)])) as Record<Surface, string>);
}

export function evaluateOrigin(
  input: { surface: Surface; method: string; origin: unknown },
  hostnames: SurfaceHostnames = PINNED_SURFACE_HOSTNAMES,
): OriginDecision {
  return evaluateOriginAgainst(input, expectedOrigins(hostnames));
}

/**
 * Origin check against an explicit expected-origin map. Production and staging use https origins
 * built from the validated hostnames; only development may configure another scheme or port.
 */
export function evaluateOriginAgainst(
  input: { surface: Surface; method: string; origin: unknown },
  origins: Readonly<Record<Surface, string>>,
): OriginDecision {
  if (!isSurface(input.surface)) return { allowed: false, reason: 'unknown_surface' };
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
  if (!(STATE_CHANGING_METHODS as readonly string[]).includes(method)) return { allowed: true, reason: 'not_state_changing' };
  const origin = input.origin;
  if (origin === undefined) return { allowed: false, reason: 'missing' };
  if (Array.isArray(origin)) return { allowed: false, reason: 'multiple_values' };
  if (typeof origin !== 'string' || origin.length === 0) return { allowed: false, reason: 'missing' };
  if (origin === 'null') return { allowed: false, reason: 'null' };
  if (origin.includes(',') || /\s/.test(origin)) return { allowed: false, reason: 'multiple_values' };
  if (input.surface === 'marketing') return { allowed: false, reason: 'marketing_is_not_a_portal' };
  if (!/^https?:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin)) return { allowed: false, reason: 'malformed' };
  if (typeof origins[input.surface] === 'string' && origin === origins[input.surface]) return { allowed: true, reason: 'exact_match' };
  return { allowed: false, reason: 'cross_surface' };
}

// ---------------------------------------------------------------------------
// Listeners (D3) and trusted proxy peers
// ---------------------------------------------------------------------------

export const LISTENERS = ['public', 'admin'] as const;
export type ListenerName = (typeof LISTENERS)[number];

/** Which surfaces each Express listener may serve. The Admin surface has its own listener. */
export const LISTENER_SURFACES: Readonly<Record<ListenerName, readonly Surface[]>> = Object.freeze({
  public: Object.freeze(['marketing', 'exam', 'institution'] as const),
  admin: Object.freeze(['admin'] as const),
});

export function isListenerName(value: unknown): value is ListenerName {
  return typeof value === 'string' && (LISTENERS as readonly string[]).includes(value);
}

/**
 * The surface for a request: the trusted original host must name a surface that the receiving
 * listener serves. Returns null (fail closed) for an unknown listener, an invalid host or a host
 * that belongs to the other listener.
 */
export function surfaceForListenerAndHost(listener: unknown, rawOriginalHost: unknown, hostnames: SurfaceHostnames = PINNED_SURFACE_HOSTNAMES): Surface | null {
  if (!isListenerName(listener)) return null;
  const parsed = parseOriginalHost(rawOriginalHost);
  if (!parsed.ok) return null;
  const surface = surfaceForHostname(parsed.hostname, hostnames);
  return surface && LISTENER_SURFACES[listener].includes(surface) ? surface : null;
}

export interface PeerAddress {
  family: 4 | 6;
  address: string;
  value: bigint;
}

function ipv4ToBigInt(address: string): bigint | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function ipv6ToBigInt(address: string): bigint | null {
  if (!/^[0-9a-f:.]+$/.test(address)) return null;
  let text = address;
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

/**
 * Normalises a socket peer address. IPv4-mapped IPv6 in dotted form ("::ffff:a.b.c.d") becomes the
 * IPv4 address; zone indexes and anything that is not a plain IP literal are rejected.
 */
export function normalizePeerAddress(raw: unknown): PeerAddress | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 || raw.includes('%')) return null;
  const lower = raw.toLowerCase();
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  const v4Text = mapped ? mapped[1] : lower;
  const v4 = ipv4ToBigInt(v4Text);
  if (v4 !== null && (mapped || !lower.includes(':'))) return { family: 4, address: v4Text, value: v4 };
  if (!lower.includes(':')) return null;
  const v6 = ipv6ToBigInt(lower);
  if (v6 === null) return null;
  // Any IPv4-mapped form (including hex "::ffff:ac1e:a") is the IPv4 address, as in proxy-addr.
  if ((v6 >> 32n) === 0xffffn) {
    const v4 = v6 & 0xffffffffn;
    const address = [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 0xffn)).join('.');
    return { family: 4, address, value: v4 };
  }
  return { family: 6, address: lower, value: v6 };
}

/** True when an IPv6 value lies in the IPv4-mapped space ::ffff:0:0/96. */
function isIpv4MappedValue(value: bigint): boolean {
  return (value >> 32n) === 0xffffn;
}

/** True for the in-container loopback peer used by the health probe. */
export function isLoopbackPeer(peer: PeerAddress | null): boolean {
  return peer !== null && ((peer.family === 4 && peer.value === 0x7f000001n) || (peer.family === 6 && peer.value === 1n));
}

export interface ProxyRange {
  family: 4 | 6;
  network: bigint;
  prefix: number;
  /** Canonical "address/prefix" text, as given (lower-case). */
  text: string;
}

/**
 * Parses one trusted proxy range ("a.b.c.d/n", "a.b.c.d", "v6/n" or a v6 address). Rejects
 * prefix 0 (any address), host bits set below the prefix, zone indexes and malformed input.
 */
export function parseProxyRange(raw: unknown): ProxyRange | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (text.length === 0 || text.length > 64 || text.includes('%')) return null;
  const [address, prefixText, extra] = text.split('/');
  if (extra !== undefined) return null;
  const isV4 = !address.includes(':');
  const value = isV4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  if (value === null) return null;
  const bits = isV4 ? 32 : 128;
  if (prefixText !== undefined && !/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (prefix < 1 || prefix > bits) return null;
  // L-2: IPv4-mapped IPv6 ranges (::ffff:0:0/96) are rejected. Peers are normalised to IPv4, so such
  // a range could never match in the gate while Express proxy-addr would treat it as IPv4.
  if (!isV4 && prefix >= 96 && isIpv4MappedValue(value)) return null;
  if (!isV4 && prefix < 96) {
    // A shorter IPv6 prefix that still covers the mapped space (e.g. ::/80) is equally ambiguous.
    const shift = BigInt(128 - prefix);
    if ((0xffffn << 32n) >> shift === value >> shift) return null;
  }
  const hostBits = BigInt(bits - prefix);
  if (hostBits > 0n && (value & ((1n << hostBits) - 1n)) !== 0n) return null;
  return Object.freeze({ family: isV4 ? 4 : 6, network: value, prefix, text: `${address}/${prefix}` });
}

/** True when two ranges share at least one address (same family and common prefix). */
export function rangesOverlap(a: ProxyRange, b: ProxyRange): boolean {
  if (a.family !== b.family) return false;
  const shift = BigInt((a.family === 4 ? 32 : 128) - Math.min(a.prefix, b.prefix));
  return (a.network >> shift) === (b.network >> shift);
}

export function isPeerInRanges(peer: PeerAddress | null, ranges: readonly ProxyRange[]): boolean {
  if (!peer) return false;
  return ranges.some((range) => {
    if (range.family !== peer.family) return false;
    const shift = BigInt((range.family === 4 ? 32 : 128) - range.prefix);
    return (peer.value >> shift) === (range.network >> shift);
  });
}

// ---------------------------------------------------------------------------
// Route policy
// ---------------------------------------------------------------------------

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What a request needs once it is allowed on the surface. The existing route guards still enforce
 * it (requireAuth, requireRoles, requireSuperAdmin, the institution capability check); P1-B adds the
 * surface/session binding.
 * - anonymous: no session
 * - login: credential login; the login role is restricted by isLoginRoleAllowedOnSurface
 * - session: any session whose role belongs to the surface (isSessionAllowedOnSurface)
 * - candidate / center / official: that session role
 * - super_admin: an Official with is_super_admin
 * - capability: the institution submission capability flow (no portal session)
 * - platform_staff / org_staff (SM-1): the independent staff session of that module, checked by the
 *   module's own route guard (requirePlatformStaff… / requireOrgStaff); never a portal session
 */
export type AuthRequirement = 'anonymous' | 'login' | 'session' | 'candidate' | 'center' | 'official' | 'super_admin' | 'capability' | 'platform_staff' | 'org_staff';

export type SurfaceAccess =
  | { decision: 'allow'; auth: AuthRequirement }
  | { decision: 'deny' }
  /** Answer 401 without any session lookup (Marketing /api/auth/me and /api/auth/logout). */
  | { decision: 'unauthenticated' }
  /** No owner decision yet. Fails closed (404) until resolved. */
  | { decision: 'unresolved'; question: string };

export type RouteClass =
  | 'public_content'
  | 'auth'
  | 'candidate'
  | 'institution'
  | 'institution_capability'
  | 'admin'
  | 'super_admin'
  | 'platform_staff'
  | 'organization_staff'
  | 'health';

export interface RoutePolicyEntry {
  method: RouteMethod;
  /** Express route pattern exactly as registered (literal segments and :params only). */
  path: string;
  routeClass: RouteClass;
  access: Readonly<Record<Surface, SurfaceAccess>>;
  /**
   * The allowed surfaces require different authentication (for example anonymous on Marketing and
   * a Candidate session on Exam). Must equal "more than one distinct allowed AuthRequirement"; the
   * test suite derives and checks it.
   */
  authenticationVariesBySurface?: true;
  /**
   * One surface allows anonymous access and another requires a session, so no route-level guard can
   * express the policy. The central surface enforcement (server/surfaceEnforcement.ts) is the only
   * control, and the route must carry no authentication middleware of its own.
   */
  centralAuthenticationOnly?: true;
  /**
   * The policy requires a session on some surface, but the route does not enforce it yet. Records
   * the guard registered on the route TODAY (verified against the live route stack) and how P1-B
   * must enforce it. Remove the record once enforcement exists and the guard test is updated.
   */
  pendingAuthentication?: PendingAuthentication;
  /** Health endpoint: denied on every hostname surface; reachable only by the in-container probe. */
  internalProbe?: true;
}

export interface PendingAuthentication {
  /** Authentication middleware registered on the route today: none at all, or optionalAuth. */
  currentRouteGuard: 'none' | 'optionalAuth';
  /**
   * central_only: one surface allows anonymous access and another requires a session, so a route
   * guard cannot express the policy; only P1-B's central surface enforcement can (from this table).
   * route_guard_or_central: a route guard (requireAuth + requireRoles) can express it; P1-B may add
   * one in addition to central enforcement.
   */
  enforcement: 'central_only' | 'route_guard_or_central';
  phase: 'P1-B';
}

const DENY: SurfaceAccess = Object.freeze({ decision: 'deny' });
const allow = (auth: AuthRequirement): SurfaceAccess => Object.freeze({ decision: 'allow', auth });
/** For a future route that has no approved policy yet: fails closed (404) and is reported. */
export const unresolvedAccess = (question: string): SurfaceAccess => Object.freeze({ decision: 'unresolved', question });
/** For a future row whose required authentication is not yet enforced by its route. */
export const pendingAuthenticationRecord = (currentRouteGuard: PendingAuthentication['currentRouteGuard'], enforcement: PendingAuthentication['enforcement']): PendingAuthentication =>
  Object.freeze({ currentRouteGuard, enforcement, phase: 'P1-B' as const });

function only(surface: Surface, access: SurfaceAccess): Readonly<Record<Surface, SurfaceAccess>> {
  return Object.freeze({ marketing: DENY, exam: DENY, institution: DENY, admin: DENY, [surface]: access } as Record<Surface, SurfaceAccess>);
}

function entry(method: RouteMethod, path: string, routeClass: RouteClass, access: Readonly<Record<Surface, SurfaceAccess>>, extra: Partial<RoutePolicyEntry> = {}): RoutePolicyEntry {
  return Object.freeze({ method, path, routeClass, access, ...extra });
}

const marketingContent = (path: string, extra?: Partial<RoutePolicyEntry>) => entry('GET', path, 'public_content', only('marketing', allow('anonymous')), extra);
const exam =(method: RouteMethod, path: string, auth: AuthRequirement = 'candidate', extra?: Partial<RoutePolicyEntry>) => entry(method, path, 'candidate', only('exam', allow(auth)), extra);
const institution = (method: RouteMethod, path: string, auth: AuthRequirement = 'center') => entry(method, path, 'institution', only('institution', allow(auth)));
const capability = (method: RouteMethod, path: string) => entry(method, path, 'institution_capability', only('institution', allow('capability')));
const official = (method: RouteMethod, path: string) => entry(method, path, 'admin', only('admin', allow('official')));
const superAdmin = (method: RouteMethod, path: string) => entry(method, path, 'super_admin', only('admin', allow('super_admin')));

/**
 * Every registered Express route (v1.4 §8). The completeness test compares this table with the live
 * route stack, and checks each role level against the route's real guard middleware.
 */
export const ROUTE_POLICY: readonly RoutePolicyEntry[] = Object.freeze([
  // Public content (Amendment A-1, owner decisions U1-U6).
  // Routing metadata the SPA needs to move a role flow to its surface. Public surfaces answer with the
  // public hostnames only; the private Admin hostname is disclosed only on Admin (disclosedSurfaceHostnames).
  entry('GET', '/api/surface-hostnames', 'public_content', Object.freeze({
    marketing: allow('anonymous'), exam: allow('anonymous'), institution: allow('anonymous'), admin: allow('anonymous'),
  })),
  entry('GET', '/api/notices', 'public_content', Object.freeze({
    marketing: allow('anonymous'), exam: allow('anonymous'), institution: DENY, admin: DENY,
  })),
  entry('GET', '/api/institute-forms', 'public_content', Object.freeze({
    marketing: allow('anonymous'), exam: allow('anonymous'), institution: DENY, admin: DENY,
  })),
  // Marketing anonymous listing; Exam needs a Candidate session (application flow). The route has
  // no guard and cannot have one (Marketing is anonymous): enforced centrally (P1-B).
  entry('GET', '/api/exams', 'public_content', Object.freeze({
    marketing: allow('anonymous'), exam: allow('candidate'), institution: DENY, admin: DENY,
  }), { authenticationVariesBySurface: true, centralAuthenticationOnly: true }),
  // Answer keys: Candidate on Exam only; enforced centrally and by route guards (P1-B).
  exam('GET', '/api/answer-keys/exams'),
  exam('GET', '/api/answer-keys'),

  // Health: in-container probe only; never through a hostname surface.
  entry('GET', '/api/health', 'health', only('admin', DENY), { internalProbe: true }),

  // Authentication (locked rows, v1.4 §4).
  entry('POST', '/api/auth/login', 'auth', Object.freeze({ marketing: DENY, exam: allow('login'), institution: allow('login'), admin: allow('login') })),
  // AUTH C1.9.1 (MFA P3a-1): the second step of Official sign-in. Admin only; no portal session yet (the
  // challenge cookie, Path=/api/auth/mfa, is the only credential).
  entry('POST', '/api/auth/mfa/verify', 'auth', only('admin', allow('login'))),
  // AUTH C1.9.1 (MFA P4): first-time enrollment is also pre-session; its enrollment-purpose challenge
  // cookie is validated by the handlers, and normal portal routes remain session-gated.
  entry('POST', '/api/auth/mfa/enrol/start', 'auth', only('admin', allow('login'))),
  entry('POST', '/api/auth/mfa/enrol/confirm', 'auth', only('admin', allow('login'))),
  entry('GET', '/api/auth/me', 'auth', Object.freeze({ marketing: Object.freeze({ decision: 'unauthenticated' }) as SurfaceAccess, exam: allow('session'), institution: allow('session'), admin: allow('session') })),
  entry('POST', '/api/auth/logout', 'auth', Object.freeze({ marketing: Object.freeze({ decision: 'unauthenticated' }) as SurfaceAccess, exam: allow('session'), institution: allow('session'), admin: allow('session') })),
  entry('POST', '/api/auth/register', 'auth', only('exam', allow('anonymous'))),
  entry('POST', '/api/center/register', 'auth', only('institution', allow('anonymous'))),
  entry('POST', '/api/center/resubmit', 'auth', only('institution', allow('anonymous'))),

  // Locked special rows (v1.4 §4): authenticated portal users only (requireAuth + role guards, P1-B).
  entry('POST', '/api/feedback', 'auth', Object.freeze({ marketing: DENY, exam: allow('candidate'), institution: allow('center'), admin: DENY }), {
    authenticationVariesBySurface: true,
  }),
  exam('POST', '/api/mock-exams/submit'),

  // Candidate (Exam surface).
  exam('GET', '/api/candidate/portal'),
  exam('POST', '/api/applications'),
  exam('POST', '/api/candidate/admit-cards/lookup'),
  exam('POST', '/api/admit-cards/lookup'),
  exam('POST', '/api/candidate/results/lookup'),
  exam('POST', '/api/results/lookup'),
  exam('GET', '/api/online-exams'),
  exam('POST', '/api/online-exams/:examCode/start'),
  exam('PATCH', '/api/online-exams/:examCode/attempt'),
  exam('POST', '/api/online-exams/:examCode/submit'),
  exam('GET', '/api/mock-exams/mine'),

  // Institution (Institution surface).
  institution('GET', '/api/center/workspace'),
  institution('POST', '/api/center/forms'),
  institution('POST', '/api/center/profile-changes'),
  institution('POST', '/api/center/withdrawals'),
  institution('GET', '/api/center/checkins'),
  institution('POST', '/api/center/checkins'),
  institution('GET', '/api/center/documents/policy'),
  institution('GET', '/api/center/documents'),
  institution('POST', '/api/center/documents'),
  institution('PUT', '/api/center/documents/:documentId/versions'),
  institution('GET', '/api/center/documents/versions/:versionId/content'),
  institution('GET', '/api/center/overview'),
  institution('GET', '/api/center/branches'),
  institution('POST', '/api/center/branches'),
  institution('PATCH', '/api/center/branches/:id'),
  institution('GET', '/api/center/exams'),
  institution('POST', '/api/center/exams'),
  institution('POST', '/api/center/exams/:id/transition'),
  institution('GET', '/api/center/exams/:id/broadcasts'),
  institution('POST', '/api/center/exams/:id/broadcasts'),
  institution('GET', '/api/center/app-forms'),
  institution('POST', '/api/center/app-forms'),
  institution('PATCH', '/api/center/app-forms/:id'),
  institution('GET', '/api/center/applications'),
  institution('POST', '/api/center/applications'),
  institution('POST', '/api/center/applications/:id/review'),
  institution('GET', '/api/center/applications/:id/logs'),
  institution('GET', '/api/center/payments'),
  institution('POST', '/api/center/payments/refunds'),
  institution('PATCH', '/api/center/payments/refunds/:id'),
  institution('GET', '/api/center/admit-cards'),
  institution('POST', '/api/center/admit-cards/templates'),
  institution('POST', '/api/center/admit-cards/generate'),
  institution('PATCH', '/api/center/admit-cards/:id/release'),
  institution('GET', '/api/center/questions'),
  institution('POST', '/api/center/questions'),
  institution('PATCH', '/api/center/questions/:id/moderate'),
  institution('POST', '/api/center/paper-blueprints'),
  institution('POST', '/api/center/paper-blueprints/:id/lock'),
  institution('GET', '/api/center/cbt-sessions'),
  institution('POST', '/api/center/cbt-incidents/:id/review'),
  institution('GET', '/api/center/results'),
  institution('POST', '/api/center/results'),
  institution('PATCH', '/api/center/results/:id/status'),
  institution('GET', '/api/center/reports/saved'),
  institution('POST', '/api/center/reports/preview'),
  institution('POST', '/api/center/reports/saved'),
  institution('GET', '/api/center/staff/audit'),
  institution('GET', '/api/center/attendance'),
  institution('POST', '/api/center/attendance/mark'),
  institution('GET', '/api/center/interviews'),
  institution('POST', '/api/center/interviews'),
  institution('POST', '/api/center/interviews/:id/scorecards'),
  institution('POST', '/api/center/interviews/:id/cancel'),
  institution('POST', '/api/center/interviews/:id/reschedule'),
  institution('GET', '/api/center/training'),
  institution('POST', '/api/center/training/courses'),
  institution('POST', '/api/center/training/sessions'),
  institution('POST', '/api/center/training/enrollments'),
  institution('POST', '/api/center/training/enrollments/:id/certificate'),
  institution('GET', '/api/center/settings'),
  institution('POST', '/api/center/tickets'),
  institution('PATCH', '/api/center/tickets/:id'),

  // Institution submission capability flow (Institution surface; no portal session).
  capability('POST', '/api/institution-document-submission/reissue'),
  capability('GET', '/api/institution-document-submission/status'),
  capability('GET', '/api/institution-document-submission/documents'),
  capability('POST', '/api/institution-document-submission/documents'),
  capability('PUT', '/api/institution-document-submission/documents/:documentId/versions'),
  capability('POST', '/api/institution-document-submission/revoke'),

  // Official (Admin surface), including the route outside /api/admin.
  official('GET', '/api/institution-document-submission/admin/cycles'),
  official('GET', '/api/admin/notices'),
  official('POST', '/api/admin/notices'),
  superAdmin('PATCH', '/api/admin/notices/:id'),
  official('GET', '/api/admin/workbook-template'),
  official('GET', '/api/admin/dashboard-stats'),
  official('POST', '/api/admin/answer-keys/import'),
  official('POST', '/api/admin/online-exams/import'),
  official('POST', '/api/admin/results/import'),
  official('GET', '/api/admin/answer-keys'),
  official('GET', '/api/admin/online-exams'),
  official('GET', '/api/admin/exams'),
  official('POST', '/api/admin/exams'),
  official('PATCH', '/api/admin/exams/:id'),
  official('GET', '/api/admin/institutes'),
  official('PATCH', '/api/admin/institutes/:id'),
  official('GET', '/api/admin/institute-management'),
  official('PATCH', '/api/admin/institute-forms/:id'),
  official('PATCH', '/api/admin/institute-profile-changes/:id'),
  official('GET', '/api/admin/applications'),
  official('PATCH', '/api/admin/applications/:id'),
  official('POST', '/api/admin/results'),
  official('GET', '/api/admin/results'),
  official('GET', '/api/admin/mock-exams/attempts'),
  official('GET', '/api/admin/institution-documents/policy'),
  official('GET', '/api/admin/institution-documents'),

  // Super Admin (Admin surface; existing requireSuperAdmin).
  superAdmin('GET', '/api/admin/data-export'),
  // D-02 (2026-11-27): Super Admin review and publication of Institute Workspace drafts.
  superAdmin('GET', '/api/admin/institute-workspace/review-queue'),
  superAdmin('POST', '/api/admin/institute-workspace/exams/:id/decision'),
  superAdmin('GET', '/api/admin/institute-workspace/exams/:id/results'),
  superAdmin('POST', '/api/admin/institute-workspace/exams/:id/results/decision'),
  superAdmin('POST', '/api/admin/institute-workspace/exams/:id/admit-cards/decision'),
  superAdmin('POST', '/api/admin/admit-cards/import'),
  superAdmin('PATCH', '/api/admin/answer-keys/:examCode'),
  superAdmin('PATCH', '/api/admin/online-exams/:examCode'),
  superAdmin('POST', '/api/admin/institutes/:id/credits'),
  superAdmin('PATCH', '/api/admin/institute-withdrawals/:id'),
  superAdmin('GET', '/api/admin/feedback'),
  superAdmin('PATCH', '/api/admin/feedback/:id'),
  superAdmin('POST', '/api/admin/applications/:id/verify-ownership'),
  superAdmin('PUT', '/api/admin/applications/:id/admit-card'),
  superAdmin('PATCH', '/api/admin/results/:id'),
  superAdmin('GET', '/api/admin/institution-documents/versions/:versionId/content'),
  superAdmin('POST', '/api/admin/institution-documents/versions/:versionId/reviews'),

  // AUTH-1 verification (Exam and Institution). Anonymous at the gate: the pending verification is
  // identified by its own path-scoped cookie, and no portal session exists until a code is verified.
  entry('GET', '/api/auth/providers', 'auth', Object.freeze({ marketing: DENY, exam: allow('anonymous'), institution: allow('anonymous'), admin: DENY })),
  entry('GET', '/api/auth/verification', 'auth', Object.freeze({ marketing: DENY, exam: allow('anonymous'), institution: allow('anonymous'), admin: DENY })),
  entry('POST', '/api/auth/verification/destination', 'auth', Object.freeze({ marketing: DENY, exam: allow('anonymous'), institution: allow('anonymous'), admin: DENY })),
  entry('POST', '/api/auth/verification/resend', 'auth', Object.freeze({ marketing: DENY, exam: allow('anonymous'), institution: allow('anonymous'), admin: DENY })),
  entry('POST', '/api/auth/verification/verify', 'auth', Object.freeze({ marketing: DENY, exam: allow('anonymous'), institution: allow('anonymous'), admin: DENY })),
  // AUTH-1 Google sign-in (Exam only). Linking needs a verified Student session.
  entry('GET', '/api/auth/google/start', 'auth', only('exam', allow('anonymous'))),
  entry('GET', '/api/auth/google/callback', 'auth', only('exam', allow('anonymous'))),
  exam('GET', '/api/auth/google/link'),
  // AUTH-1 follow-up: a signed-in Student reads or starts verification of their own email address.
  exam('GET', '/api/auth/student/email'),
  exam('POST', '/api/auth/student/email'),
  // AUTH-1 / SM-2: institutional verification and suspension of Institutes, Super Admin only.
  superAdmin('GET', '/api/admin/institute-verifications'),
  superAdmin('GET', '/api/admin/institute-verifications/decisions'),
  superAdmin('POST', '/api/admin/institute-verifications/:institutionId/verify'),
  superAdmin('POST', '/api/admin/institute-verifications/:institutionId/reject'),
  superAdmin('POST', '/api/admin/institute-verifications/:institutionId/suspend'),
  superAdmin('POST', '/api/admin/institute-verifications/:institutionId/restore'),

  // SM-1 Platform Staff (Admin surface). Sign-in is anonymous at the gate; every other staff route
  // requires the Platform Staff session, enforced by the module's own guard (no portal session).
  entry('POST', '/api/platform-staff/auth/login', 'platform_staff', only('admin', allow('anonymous'))),
  entry('GET', '/api/platform-staff/auth/me', 'platform_staff', only('admin', allow('platform_staff'))),
  entry('POST', '/api/platform-staff/auth/logout', 'platform_staff', only('admin', allow('platform_staff'))),
  entry('POST', '/api/platform-staff/auth/password', 'platform_staff', only('admin', allow('platform_staff'))),
  entry('GET', '/api/platform-staff/dashboard', 'platform_staff', only('admin', allow('platform_staff'))),
  // SM-1 Platform Staff management: Super Admin only.
  superAdmin('GET', '/api/admin/platform-staff'),
  superAdmin('POST', '/api/admin/platform-staff'),
  superAdmin('POST', '/api/admin/platform-staff/:id/deactivate'),
  superAdmin('PUT', '/api/admin/platform-staff/:id/assignment'),
  superAdmin('GET', '/api/admin/platform-staff/departments'),
  superAdmin('POST', '/api/admin/platform-staff/departments'),
  superAdmin('GET', '/api/admin/platform-staff/roles'),
  superAdmin('POST', '/api/admin/platform-staff/roles'),
  superAdmin('GET', '/api/admin/platform-staff/audit'),

  // SM-1 Organization Staff. Owner management: the Organization Owner's own (center) session.
  institution('GET', '/api/center/staff'),
  institution('POST', '/api/center/staff/invitations'),
  institution('PUT', '/api/center/staff/:id/roles'),
  // Invitation acceptance and the (unavailable, C-18) OTP step: anonymous on Institution only.
  entry('POST', '/api/org-staff/invitations/accept', 'organization_staff', only('institution', allow('anonymous'))),
  entry('POST', '/api/org-staff/verification/otp', 'organization_staff', only('institution', allow('anonymous'))),
  entry('POST', '/api/org-staff/auth/login', 'organization_staff', only('institution', allow('anonymous'))),
  entry('GET', '/api/org-staff/auth/me', 'organization_staff', only('institution', allow('org_staff'))),
  entry('POST', '/api/org-staff/auth/logout', 'organization_staff', only('institution', allow('org_staff'))),
  entry('GET', '/api/org-staff/dashboard', 'organization_staff', only('institution', allow('org_staff'))),
  // Q115: Super Admin reviews and activates Organization Staff.
  superAdmin('GET', '/api/admin/organization-staff'),
  superAdmin('POST', '/api/admin/organization-staff/:id/activate'),
]);

/** The SPA catch-all route (registered only when dist/ exists) is governed by SPA_SHELL_PATHS. */
export const SPA_FALLBACK_ROUTE = Object.freeze({ method: 'GET' as const, path: '*' });

/** Client routes that may receive the SPA shell on each surface (exact, after normalisation). */
export const SPA_SHELL_PATHS: Readonly<Record<Surface, readonly string[]>> = Object.freeze({
  marketing: Object.freeze(['/', '/login']),
  exam: Object.freeze(['/', '/login', '/login/candidate', '/dashboard/candidate']),
  // /sign-out/institute: the Institute sign-out confirmation linked from the public site's Institute pill.
  institution: Object.freeze(['/', '/login', '/login/center', '/dashboard/center', '/sign-out/institute']),
  admin: Object.freeze(['/', '/login/official', '/dashboard/official', '/login/platform-staff', '/dashboard/platform-staff']),
});

/** Built static assets (dist/assets, dist/fonts) and the shell file itself; GET/HEAD only. */
export const STATIC_ASSET_PREFIXES = Object.freeze(['/assets/', '/fonts/']);
export const STATIC_SHELL_FILE = '/index.html';

// --- Express-compatible matching -------------------------------------------

const ROUTE_PATTERN = /^(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z][A-Za-z0-9_]*))+$/;

/**
 * Compiles a registered route pattern the way Express 4 (path-to-regexp 0.1.x) does with
 * sensitive=false, strict=false, end=true: case-insensitive, one optional trailing slash, ":param"
 * matches one non-empty segment. Throws for any pattern outside that subset (no silent approximation).
 */
export function compileRoutePattern(pattern: string): RegExp {
  if (!ROUTE_PATTERN.test(pattern)) throw new Error(`unsupported route pattern: ${pattern}`);
  const body = pattern
    .split('/')
    .slice(1)
    .map((segment) => (segment.startsWith(':') ? '(?:\\/([^/]+?))' : `\\/${segment}`))
    .join('');
  return new RegExp(`^${body}\\/?$`, 'i');
}

const COMPILED_POLICY: ReadonlyArray<{ entry: RoutePolicyEntry; regexp: RegExp }> = Object.freeze(
  ROUTE_POLICY.map((policyEntry) => ({ entry: policyEntry, regexp: compileRoutePattern(policyEntry.path) })),
);

export type PathParseResult = { ok: true; path: string } | { ok: false; reason: 'empty' | 'not_absolute' | 'duplicate_separator' | 'encoded_separator' | 'dot_segment' | 'invalid_character' };

/**
 * Extracts the raw path (no decoding) from a request target and rejects spellings that could be
 * used to confuse matching: duplicate separators, encoded "/" or "\", backslashes, NUL/control
 * characters and "." / ".." segments. Query string and fragment are ignored.
 */
export function parseRequestPath(target: unknown): PathParseResult {
  if (typeof target !== 'string' || target.length === 0) return { ok: false, reason: 'empty' };
  const end = target.search(/[?#]/);
  const path = end === -1 ? target : target.slice(0, end);
  if (path.length === 0) return { ok: false, reason: 'empty' };
  if (!path.startsWith('/')) return { ok: false, reason: 'not_absolute' };
  if (/[\u0000-\u001f\u007f\s\\]/.test(path)) return { ok: false, reason: 'invalid_character' };
  if (/%(?:2f|5c|00)/i.test(path)) return { ok: false, reason: 'encoded_separator' };
  if (path.includes('//')) return { ok: false, reason: 'duplicate_separator' };
  if (path.split('/').some((segment) => segment === '.' || segment === '..' || /^%2e(?:%2e)?$/i.test(segment) || /^\.%2e$|^%2e\.$/i.test(segment))) {
    return { ok: false, reason: 'dot_segment' };
  }
  return { ok: true, path };
}

/** First policy entry whose method and Express-compatible pattern match (HEAD uses GET). */
export function matchRoutePolicy(method: string, path: string): RoutePolicyEntry | null {
  const normalized = typeof method === 'string' ? method.toUpperCase() : '';
  const effective = normalized === 'HEAD' ? 'GET' : normalized;
  for (const { entry: policyEntry, regexp } of COMPILED_POLICY) {
    if (policyEntry.method === effective && regexp.test(path)) return policyEntry;
  }
  return null;
}

// --- Request decision -------------------------------------------------------

export type RequestCategory = 'api_route' | 'static_asset' | 'spa_shell' | 'options' | 'unknown_api' | 'unknown_path' | 'malformed' | 'unknown_surface' | 'method_not_allowed';

export type RequestDecision =
  | { outcome: 'allow'; status: 200; category: 'api_route' | 'static_asset' | 'spa_shell'; auth: AuthRequirement; entry?: RoutePolicyEntry }
  | { outcome: 'deny'; status: 404 | 421; category: RequestCategory; entry?: RoutePolicyEntry; reason: string }
  | { outcome: 'unauthenticated'; status: 401; category: 'api_route'; entry: RoutePolicyEntry }
  | { outcome: 'unresolved'; status: 404; category: 'api_route'; entry: RoutePolicyEntry; question: string };

const SAFE_METHODS = ['GET', 'HEAD'];
const KNOWN_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** The decision for an already-matched policy entry on a known surface (unknown access → deny). */
export function decideForEntry(surface: Surface, policyEntry: RoutePolicyEntry): RequestDecision {
  const access = isSurface(surface) ? policyEntry.access[surface] : undefined;
  switch (access?.decision) {
    case 'allow':
      return { outcome: 'allow', status: 200, category: 'api_route', auth: access.auth, entry: policyEntry };
    case 'unauthenticated':
      return { outcome: 'unauthenticated', status: 401, category: 'api_route', entry: policyEntry };
    case 'unresolved':
      return { outcome: 'unresolved', status: 404, category: 'api_route', entry: policyEntry, question: access.question };
    default:
      return { outcome: 'deny', status: 404, category: 'api_route', entry: policyEntry, reason: `not available on the ${String(surface)} surface` };
  }
}

/**
 * The surface route policy (v1.4 §8): a request target either matches an explicit classification
 * for the receiving surface or fails closed. Unknown surface → 421; everything else unmatched → 404.
 * Authentication and roles are still enforced by the existing guards; this is the surface layer.
 */
export function decideRequest(surface: unknown, method: unknown, target: unknown): RequestDecision {
  if (!isSurface(surface)) return { outcome: 'deny', status: 421, category: 'unknown_surface', reason: 'unknown surface' };
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  if (!KNOWN_METHODS.includes(verb)) return { outcome: 'deny', status: 404, category: 'method_not_allowed', reason: 'method not allowed' };
  const parsed = parseRequestPath(target);
  if (!parsed.ok) return { outcome: 'deny', status: 404, category: 'malformed', reason: parsed.reason };
  if (verb === 'OPTIONS') return { outcome: 'deny', status: 404, category: 'options', reason: 'no CORS or preflight is served; same-origin only' };
  const { path } = parsed;

  if (/^\/api(?:\/|$)/i.test(path)) {
    const policyEntry = matchRoutePolicy(verb, path);
    if (!policyEntry) return { outcome: 'deny', status: 404, category: 'unknown_api', reason: 'unclassified API route' };
    return decideForEntry(surface, policyEntry);
  }

  if (!SAFE_METHODS.includes(verb)) return { outcome: 'deny', status: 404, category: 'unknown_path', reason: 'non-API paths are read-only' };
  if (STATIC_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length && !path.endsWith('/')) || path === STATIC_SHELL_FILE) {
    return { outcome: 'allow', status: 200, category: 'static_asset', auth: 'anonymous' };
  }
  const shellPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (SPA_SHELL_PATHS[surface].some((allowed) => allowed.toLowerCase() === shellPath.toLowerCase())) {
    return { outcome: 'allow', status: 200, category: 'spa_shell', auth: 'anonymous' };
  }
  return { outcome: 'deny', status: 404, category: 'unknown_path', reason: 'unclassified path' };
}

/** P1-B narrow exception: the in-container health probe (loopback peer) may call GET/HEAD /api/health. */
export function isInternalHealthProbe(method: unknown, target: unknown): boolean {
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  if (!SAFE_METHODS.includes(verb)) return false;
  const parsed = parseRequestPath(target);
  if (!parsed.ok) return false;
  return matchRoutePolicy(verb, parsed.path)?.internalProbe === true;
}

/** Routes with an open owner decision (fail closed until resolved). */
export function unresolvedPolicyRows(): Array<{ method: RouteMethod; path: string; surfaces: Surface[]; question: string }> {
  return ROUTE_POLICY.flatMap((policyEntry) => {
    const surfaces = SURFACES.filter((surface) => policyEntry.access[surface].decision === 'unresolved');
    if (surfaces.length === 0) return [];
    const access = policyEntry.access[surfaces[0]] as { question: string };
    return [{ method: policyEntry.method, path: policyEntry.path, surfaces, question: access.question }];
  });
}
