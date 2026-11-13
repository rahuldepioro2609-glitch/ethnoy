// P1-B: central surface enforcement (P1 Surface Isolation v1.4 §5, §7, §9).
//
// Per-request order (mounted first in server/index.ts):
//   identify            listener identity (server-side wiring + socket.localPort), the narrow
//                       in-container health exception, trusted proxy peer, validated original
//                       host → trusted surface (421 on any failure)
//   [helmet, body parsing]
//   enforceOrigin       exact Origin of the surface for state-changing methods (403)
//   enforceRoutePolicy  route policy for the surface (404 / 401), then — only when the matched
//                       policy needs a session — one session lookup with surface binding and role
//                       (401 / 403). Public rows never look up a session, even with a cookie.
//
// Nothing here reads the environment at import time: loadSurfaceRuntimeConfig() parses an env
// object at startup, and createSurfaceGate() is unusable (fails closed) until configure() is called.
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authenticateRequest, setTrustedRequestSurface, getTrustedRequestSurface, getTrustedRequestOrigin, type SessionRequirement } from './auth.js';
import {
  LISTENERS,
  PINNED_SURFACE_HOSTNAMES,
  SURFACES,
  decideRequest,
  evaluateOriginAgainst,
  expectedOrigins,
  isInternalHealthProbe,
  isListenerName,
  isLoopbackPeer,
  isPeerInRanges,
  normalizePeerAddress,
  parseOriginalHost,
  parseProxyRange,
  rangesOverlap,
  surfaceForListenerAndHost,
  validateSurfaceHostnames,
  type ListenerName,
  type ProxyRange,
  type Surface,
  type SurfaceHostnames,
} from './surface.js';

// ---------------------------------------------------------------------------
// Configuration (D4, D5, D7)
// ---------------------------------------------------------------------------

export const SURFACE_MODES = ['production', 'staging', 'development'] as const;
export type SurfaceMode = (typeof SURFACE_MODES)[number];

/** Environment variable names (documented in .env.example). */
export const SURFACE_ENV = Object.freeze({
  mode: 'ELTNOY_SURFACE_MODE',
  /** H-1: proxies trusted by the public listener only. */
  publicProxyCidrs: 'ELTNOY_PUBLIC_PROXY_CIDRS',
  /** H-1: proxies trusted by the Admin listener only. */
  adminProxyCidrs: 'ELTNOY_ADMIN_PROXY_CIDRS',
  /** Removed shared list; rejected if still set so it is never silently ignored. */
  legacyTrustedProxyCidrs: 'ELTNOY_TRUSTED_PROXY_CIDRS',
  hostnames: Object.freeze({
    marketing: 'ELTNOY_MARKETING_HOSTNAME',
    exam: 'ELTNOY_EXAM_HOSTNAME',
    institution: 'ELTNOY_INSTITUTION_HOSTNAME',
    admin: 'ELTNOY_ADMIN_HOSTNAME',
  } satisfies Record<Surface, string>),
  devOriginScheme: 'ELTNOY_DEV_ORIGIN_SCHEME',
  devOriginPort: 'ELTNOY_DEV_ORIGIN_PORT',
  publicPort: 'PORT',
  adminPort: 'ADMIN_PORT',
});

export const DEFAULT_LISTENER_PORTS: Readonly<Record<ListenerName, number>> = Object.freeze({ public: 4000, admin: 4001 });

export interface SurfaceRuntimeConfig {
  mode: SurfaceMode;
  hostnames: SurfaceHostnames;
  expectedOrigins: Readonly<Record<Surface, string>>;
  /**
   * Validated single proxy addresses ("address/32" or "address/128") per listener. The two lists
   * never overlap: a proxy trusted by the public listener is never trusted by the Admin listener.
   */
  trustedProxies: Readonly<Record<ListenerName, readonly string[]>>;
  listenerPorts: Readonly<Record<ListenerName, number>>;
}

export type SurfaceConfigResult = { ok: true; config: SurfaceRuntimeConfig } | { ok: false; errors: string[] };

type Env = Readonly<Record<string, string | undefined>>;

function parsePort(raw: string | undefined, fallback: number, name: string, errors: string[]): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 65535) {
    errors.push(`${name} must be a whole number from 1 to 65535.`);
    return fallback;
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Trusted proxy lists (H-1, M-1, L-2)
// ---------------------------------------------------------------------------

function inV4(value: bigint, network: number[], prefix: number): boolean {
  const base = network.reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
  const shift = BigInt(32 - prefix);
  return (value >> shift) === (base >> shift);
}

/**
 * Special-purpose addresses that can never be a legitimate reverse-proxy peer. Returns a rule text
 * (never the value) or null. L-A: no rule is inferred from an address suffix — whether a /32 is a
 * network, gateway or broadcast address depends on the actual subnet, so P1-F must verify every
 * configured address against the proxy container's own address and network configuration.
 */
function unsafeProxyAddressReason(range: ProxyRange, mode: SurfaceMode): string | null {
  const v = range.network;
  if (range.family === 4) {
    if (inV4(v, [127, 0, 0, 0], 8)) return mode === 'development' ? null : 'is a loopback address, which is allowed only in development.';
    if (inV4(v, [0, 0, 0, 0], 8)) return 'is an unspecified or reserved address.';
    if (inV4(v, [169, 254, 0, 0], 16)) return 'is a link-local address.';
    if (inV4(v, [224, 0, 0, 0], 3)) return 'is a multicast, reserved or broadcast address.';
    return null;
  }
  if (v === 0n) return 'is the unspecified address.';
  if (v === 1n) return mode === 'development' ? null : 'is a loopback address, which is allowed only in development.';
  if ((v >> 118n) === 0x3fan) return 'is a link-local address.';
  if ((v >> 120n) === 0xffn) return 'is a multicast address.';
  return null;
}

export interface TrustedProxyListResult {
  ranges: ProxyRange[];
  errors: string[];
}

/**
 * M-1: a trusted proxy list must name individual proxy addresses (/32 or /128) — never a subnet,
 * so a bridge gateway, other containers or client address space can never be trusted by accident.
 * Rejects empty, malformed, zoned, host-bit, IPv4-mapped IPv6 (L-2), duplicate and unsafe entries.
 * Error texts name the setting, entry number and rule only, never the value.
 */
/** A proxy list as configured (comma-separated environment value) or as validated (array). */
export type ProxyListInput = string | readonly string[] | undefined;

export function validateTrustedProxyList(name: string, raw: ProxyListInput, mode: SurfaceMode): TrustedProxyListResult {
  const ranges: ProxyRange[] = [];
  const errors: string[] = [];
  let entries: string[];
  if (typeof raw === 'string') {
    entries = raw.trim() === '' ? [] : raw.split(',').map((part) => part.trim());
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries = (raw as readonly string[]).map((entry) => entry.trim());
  } else if (raw === undefined || raw === null) {
    entries = [];
  } else {
    return { ranges, errors: [`${name} must be a list of proxy addresses.`] };
  }
  if (entries.length === 0) {
    return { ranges, errors: [`${name} must list at least one trusted proxy address.`] };
  }
  entries.forEach((entry, index) => {
    const label = `${name} entry ${index + 1}`;
    if (entry === '') {
      errors.push(`${label} is empty.`);
      return;
    }
    const range = parseProxyRange(entry);
    if (!range) {
      errors.push(`${label} is not a valid IPv4 or IPv6 address (IPv4-mapped IPv6, zone indexes, host bits and /0 are not allowed).`);
      return;
    }
    const full = range.family === 4 ? 32 : 128;
    if (range.prefix !== full) {
      errors.push(`${label} must be a single proxy address (/${full}); subnet ranges are not trusted.`);
      return;
    }
    const unsafe = unsafeProxyAddressReason(range, mode);
    if (unsafe) {
      errors.push(`${label} ${unsafe}`);
      return;
    }
    if (ranges.some((existing) => rangesOverlap(existing, range))) {
      errors.push(`${label} duplicates an earlier entry.`);
      return;
    }
    ranges.push(range);
  });
  return { ranges, errors };
}

export const PROXY_LIST_SETTINGS: Readonly<Record<ListenerName, string>> = Object.freeze({
  public: 'ELTNOY_PUBLIC_PROXY_CIDRS',
  admin: 'ELTNOY_ADMIN_PROXY_CIDRS',
});

export interface TrustedProxiesValidation {
  ok: boolean;
  /** Setting names, entry numbers and rules only — never configured values. */
  errors: string[];
  ranges: Readonly<Record<ListenerName, readonly ProxyRange[]>>;
  /** Canonical "address/32" or "address/128" texts per listener. */
  texts: Readonly<Record<ListenerName, readonly string[]>>;
}

function isSurfaceMode(value: unknown): value is SurfaceMode {
  return typeof value === 'string' && (SURFACE_MODES as readonly string[]).includes(value);
}

/**
 * I-6: the one canonical validator for both proxy lists, used by the environment loader,
 * SurfaceGate.configure() and createExpressProxyTrust(). Checks the mode, that both lists exist and
 * are non-empty, every entry (single /32 or /128 address, special-purpose rules, loopback only in
 * development, no IPv4-mapped IPv6, no duplicates) and that no address is shared between the public
 * and Admin lists. An unknown mode is an error and is checked with production rules.
 */
export function validateTrustedProxies(lists: unknown, mode: unknown): TrustedProxiesValidation {
  const errors: string[] = [];
  if (!isSurfaceMode(mode)) errors.push('The surface mode must be production, staging or development.');
  const effectiveMode: SurfaceMode = isSurfaceMode(mode) ? mode : 'production';
  const record = typeof lists === 'object' && lists !== null ? lists as Partial<Record<ListenerName, ProxyListInput>> : {};
  const ranges = {} as Record<ListenerName, ProxyRange[]>;
  for (const listener of LISTENERS) {
    const result = validateTrustedProxyList(PROXY_LIST_SETTINGS[listener], record[listener], effectiveMode);
    errors.push(...result.errors);
    ranges[listener] = result.ranges;
  }
  ranges.public.forEach((range, index) => {
    if (ranges.admin.some((other) => rangesOverlap(range, other))) {
      errors.push(`${PROXY_LIST_SETTINGS.public} entry ${index + 1} is also listed in ${PROXY_LIST_SETTINGS.admin}; a proxy may be trusted by one listener only.`);
    }
  });
  const ok = errors.length === 0;
  return {
    ok,
    errors,
    ranges: Object.freeze({ public: Object.freeze(ok ? ranges.public : []), admin: Object.freeze(ok ? ranges.admin : []) }),
    texts: Object.freeze({
      public: Object.freeze(ok ? ranges.public.map((range) => range.text) : []),
      admin: Object.freeze(ok ? ranges.admin.map((range) => range.text) : []),
    }),
  };
}

/**
 * Express `trust proxy` (L-2, M-1): trusts only the direct peer (hop 0), and only when it is a
 * configured proxy, using exactly the gate's address normalisation and matching. Client-supplied
 * X-Forwarded-For entries further left are never trusted, so req.ip is the address the proxy
 * appended. Express has no listener context here; the gate has already required hop 0 to be a
 * proxy of the receiving listener before any handler can read req.ip.
 * I-6: the configuration is re-validated with the canonical validator; an unsafe hand-built
 * configuration throws instead of producing a trust function.
 */
export function createExpressProxyTrust(config: Pick<SurfaceRuntimeConfig, 'trustedProxies' | 'mode'>): (address: string, hop: number) => boolean {
  const validation = validateTrustedProxies(config?.trustedProxies, config?.mode);
  if (!validation.ok) throw new Error('Invalid trusted proxy configuration.');
  const ranges = LISTENERS.flatMap((listener) => [...validation.ranges[listener]]);
  return (address: string, hop: number) => hop === 0 && isPeerInRanges(normalizePeerAddress(address), ranges);
}

/**
 * Validates the surface configuration. Error messages name the setting and the rule only, never
 * the configured value. There are no permissive defaults: every mode needs explicit proxy ranges;
 * production pins the hostnames; staging and development need explicit, validated hostnames.
 */
export function loadSurfaceRuntimeConfig(env: Env): SurfaceConfigResult {
  const errors: string[] = [];
  const mode = env[SURFACE_ENV.mode];
  if (!mode || !(SURFACE_MODES as readonly string[]).includes(mode)) {
    return { ok: false, errors: [`${SURFACE_ENV.mode} must be set to production, staging or development.`] };
  }
  const surfaceMode = mode as SurfaceMode;
  if (surfaceMode === 'development' && env.NODE_ENV === 'production') {
    errors.push(`${SURFACE_ENV.mode}=development is not allowed when NODE_ENV is production.`);
  }

  // Hostnames.
  let hostnames: SurfaceHostnames = PINNED_SURFACE_HOSTNAMES;
  const overrides = Object.fromEntries(SURFACES.map((surface) => [surface, env[SURFACE_ENV.hostnames[surface]]]));
  if (surfaceMode === 'production') {
    for (const surface of SURFACES) {
      const value = overrides[surface];
      if (value !== undefined && value !== '' && value !== PINNED_SURFACE_HOSTNAMES[surface]) {
        errors.push(`${SURFACE_ENV.hostnames[surface]} must be unset or the pinned production hostname in production.`);
      }
    }
  } else {
    const hostnameErrors = validateSurfaceHostnames(overrides);
    for (const message of hostnameErrors) {
      const surface = SURFACES.find((candidate) => message.startsWith(`${candidate}:`));
      errors.push(surface ? `${SURFACE_ENV.hostnames[surface]} is missing or invalid (${surfaceMode} requires explicit hostnames).` : 'Surface hostname configuration is invalid.');
    }
    const pinned = new Set(Object.values(PINNED_SURFACE_HOSTNAMES));
    for (const surface of SURFACES) {
      if (typeof overrides[surface] === 'string' && pinned.has(overrides[surface] as string)) {
        errors.push(`${SURFACE_ENV.hostnames[surface]} must not use a production hostname in ${surfaceMode}.`);
      }
    }
    if (hostnameErrors.length === 0) hostnames = Object.freeze({ ...(overrides as Record<Surface, string>) });
  }

  // Origins.
  let origins = expectedOrigins(hostnames);
  const scheme = env[SURFACE_ENV.devOriginScheme];
  const devPort = env[SURFACE_ENV.devOriginPort];
  if (surfaceMode === 'development') {
    if (scheme !== undefined && scheme !== '' && scheme !== 'http' && scheme !== 'https') {
      errors.push(`${SURFACE_ENV.devOriginScheme} must be http or https.`);
    }
    if (devPort !== undefined && devPort !== '' && (!/^[1-9][0-9]{0,4}$/.test(devPort) || Number(devPort) > 65535)) {
      errors.push(`${SURFACE_ENV.devOriginPort} must be a whole number from 1 to 65535.`);
    }
    const effectiveScheme = scheme === 'http' ? 'http' : 'https';
    const portSuffix = devPort ? `:${devPort}` : '';
    origins = Object.freeze(Object.fromEntries(SURFACES.map((surface) => [surface, `${effectiveScheme}://${hostnames[surface]}${portSuffix}`])) as Record<Surface, string>);
  } else {
    if (scheme) errors.push(`${SURFACE_ENV.devOriginScheme} is allowed only in development.`);
    if (devPort) errors.push(`${SURFACE_ENV.devOriginPort} is allowed only in development.`);
  }

  // Trusted proxies, separately per listener (H-1), as single addresses (M-1).
  if (env[SURFACE_ENV.legacyTrustedProxyCidrs] !== undefined && env[SURFACE_ENV.legacyTrustedProxyCidrs] !== '') {
    errors.push(`${SURFACE_ENV.legacyTrustedProxyCidrs} is no longer supported; set ${SURFACE_ENV.publicProxyCidrs} and ${SURFACE_ENV.adminProxyCidrs}.`);
  }
  const proxies = validateTrustedProxies({
    public: env[SURFACE_ENV.publicProxyCidrs],
    admin: env[SURFACE_ENV.adminProxyCidrs],
  }, surfaceMode);
  errors.push(...proxies.errors);

  // Listener ports.
  const publicPort = parsePort(env[SURFACE_ENV.publicPort], DEFAULT_LISTENER_PORTS.public, SURFACE_ENV.publicPort, errors);
  const adminPort = parsePort(env[SURFACE_ENV.adminPort], DEFAULT_LISTENER_PORTS.admin, SURFACE_ENV.adminPort, errors);
  if (publicPort === adminPort) errors.push(`${SURFACE_ENV.publicPort} and ${SURFACE_ENV.adminPort} must differ.`);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: Object.freeze({
      mode: surfaceMode,
      hostnames,
      expectedOrigins: origins,
      trustedProxies: proxies.texts,
      listenerPorts: Object.freeze({ public: publicPort, admin: adminPort }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export const ORIGINAL_HOST_HEADER = 'x-eltnoy-original-host';

const MISDIRECTED = { error: 'Misdirected request.' } as const;
const UNAVAILABLE = { error: 'Service unavailable.' } as const;
const NOT_FOUND = { error: 'Route not found.' } as const;
const ORIGIN_REJECTED = { error: 'Request origin is not allowed.' } as const;
const SIGN_IN_REQUIRED = { error: 'Sign in is required.' } as const;

/**
 * Fixed rejection reasons and their groups (L-3). Only these constant keys are ever logged or
 * counted: never header values, addresses, hostnames, paths, cookies, tokens or bodies.
 */
export const REJECTION_GROUPS = Object.freeze({
  not_configured: 'proxy_host',
  unknown_listener: 'proxy_host',
  listener_port_mismatch: 'proxy_host',
  invalid_peer: 'proxy_host',
  untrusted_peer: 'proxy_host',
  invalid_original_host: 'proxy_host',
  forwarded_host_mismatch: 'proxy_host',
  origin_rejected: 'origin',
  route_denied: 'route',
  authentication_failed: 'authentication',
} as const);
export type SurfaceRejection = keyof typeof REJECTION_GROUPS;
export const REJECTION_REASONS = Object.freeze(Object.keys(REJECTION_GROUPS) as SurfaceRejection[]);

export interface RejectionSummary {
  total: number;
  reasons: Partial<Record<SurfaceRejection, number>>;
  groups: Partial<Record<(typeof REJECTION_GROUPS)[SurfaceRejection], number>>;
}

export interface RejectionLogStats {
  /** All rejections counted since the process started. */
  lifetimeTotal: number;
  /** Reasons already announced with a first-seen line (at most one line per reason, ever). */
  announcedReasons: SurfaceRejection[];
  automaticSummaries: number;
  /** True once the automatic-summary cap is reached; counts then wait for flush(). */
  automaticSummariesCapped: boolean;
}

export interface RejectionLog {
  /** Counts one rejection. Never throws and never affects the HTTP response. */
  record(reason: SurfaceRejection): void;
  /** Writes one summary line for the counts since the last summary, then resets them. Idempotent when nothing is pending. */
  flush(): RejectionSummary | null;
  snapshot(): RejectionSummary;
  stats(): RejectionLogStats;
}

export interface RejectionLogOptions {
  /** Rejections before the first automatic summary (default 1000). Each later interval doubles. */
  summaryEvery?: number;
  /** Maximum automatic summaries per process (default 32); later counts wait for flush(). */
  maxAutomaticSummaries?: number;
}

/**
 * L-3/L-C: bounded, aggregated rejection logging without timers.
 * - Fixed reason keys only (unknown keys are ignored), so state is at most ten counters.
 * - At most one "first seen" line per reason for the whole process (never repeated).
 * - Automatic summaries at 1x, 2x, 4x… `summaryEvery` pending rejections, at most
 *   `maxAutomaticSummaries` per process; output therefore grows only logarithmically with volume
 *   and has a hard ceiling. flush() (used at shutdown) writes any pending counts once.
 * - A failing writer never throws into the request path, and a writer that records during a
 *   summary cannot trigger a recursive summary.
 */
export function createRejectionLog(write: (entry: Record<string, unknown>) => void, options: RejectionLogOptions = {}): RejectionLog {
  const positiveInteger = (value: unknown, fallback: number) => (Number.isInteger(value) && (value as number) > 0 ? value as number : fallback);
  const summaryEvery = positiveInteger(options.summaryEvery, 1000);
  const maxAutomaticSummaries = positiveInteger(options.maxAutomaticSummaries, 32);
  const counts = new Map<SurfaceRejection, number>();
  const announced = new Set<SurfaceRejection>();
  let pending = 0;
  let lifetimeTotal = 0;
  let automaticSummaries = 0;
  let nextAutomaticAt = summaryEvery;
  let writing = false;
  const safeWrite = (entry: Record<string, unknown>) => {
    if (writing) return;
    writing = true;
    try {
      write(entry);
    } catch {
      // Logging must never affect request handling.
    } finally {
      writing = false;
    }
  };
  const snapshot = (): RejectionSummary => {
    const reasons: Partial<Record<SurfaceRejection, number>> = {};
    const groups: Partial<Record<(typeof REJECTION_GROUPS)[SurfaceRejection], number>> = {};
    for (const reason of REJECTION_REASONS) {
      const count = counts.get(reason);
      if (!count) continue;
      reasons[reason] = count;
      const group = REJECTION_GROUPS[reason];
      groups[group] = (groups[group] ?? 0) + count;
    }
    return { total: pending, reasons, groups };
  };
  const emitSummary = (automatic: boolean): RejectionSummary | null => {
    if (pending === 0 || writing) return null;
    const summary = snapshot();
    counts.clear();
    pending = 0;
    safeWrite({ event: 'surface.rejection_summary', automatic, ...summary });
    return summary;
  };
  return {
    record(reason) {
      if (!Object.prototype.hasOwnProperty.call(REJECTION_GROUPS, reason)) return;
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
      pending += 1;
      lifetimeTotal += 1;
      // Announce only when the line can actually be written (not from inside another write).
      if (!announced.has(reason) && !writing) {
        announced.add(reason);
        safeWrite({ event: 'surface.rejection_first_seen', reason, group: REJECTION_GROUPS[reason] });
      }
      if (pending >= nextAutomaticAt && automaticSummaries < maxAutomaticSummaries && !writing) {
        automaticSummaries += 1;
        nextAutomaticAt *= 2;
        emitSummary(true);
      }
    },
    flush: () => emitSummary(false),
    snapshot,
    stats: () => ({
      lifetimeTotal,
      announcedReasons: REJECTION_REASONS.filter((reason) => announced.has(reason)),
      automaticSummaries,
      automaticSummariesCapped: automaticSummaries >= maxAutomaticSummaries,
    }),
  };
}

export interface SurfaceGateOptions {
  /** Shared session path (auth.ts); injectable for tests. */
  authenticate?: typeof authenticateRequest;
  onReject?: (reason: SurfaceRejection) => void;
}

const SESSION_REQUIREMENTS: Readonly<Record<string, SessionRequirement>> = Object.freeze({
  session: 'session',
  candidate: 'candidate',
  center: 'center',
  official: 'official',
  super_admin: 'super_admin',
});

export interface SurfaceGate {
  configure(config: SurfaceRuntimeConfig): void;
  isConfigured(): boolean;
  /** Called once both listeners are listening (D9). */
  markReady(): void;
  /** L-1: called on startup failure, fatal listener failure and shutdown. */
  markNotReady(): void;
  isReady(): boolean;
  /** Server-side listener wiring: tags each request with the listener that accepted it. */
  tagListener(request: IncomingMessage, listener: ListenerName): void;
  /** True only for a request accepted by `identify` as the in-container health probe. */
  isInternalProbe(request: object): boolean;
  identify: RequestHandler;
  enforceOrigin: RequestHandler;
  enforceRoutePolicy: RequestHandler;
}

export function createSurfaceGate(options: SurfaceGateOptions = {}): SurfaceGate {
  const authenticate = options.authenticate ?? authenticateRequest;
  const report = (reason: SurfaceRejection) => {
    try {
      options.onReject?.(reason);
    } catch {
      // Reporting must never change the decision.
    }
  };
  let runtime: { config: SurfaceRuntimeConfig; ranges: Record<ListenerName, ProxyRange[]> } | null = null;
  let ready = false;
  const listenerTags = new WeakMap<object, ListenerName>();
  const internalProbes = new WeakSet<object>();

  const reject = (response: Response, reason: SurfaceRejection) => {
    report(reason);
    if (reason === 'not_configured') response.status(503).json(UNAVAILABLE);
    else response.status(421).json(MISDIRECTED);
  };

  const identify: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
    if (!runtime) {
      reject(response, 'not_configured');
      return;
    }
    const { config, ranges } = runtime;
    const listener = listenerTags.get(request);
    if (!listener) {
      reject(response, 'unknown_listener');
      return;
    }
    if (request.socket?.localPort !== config.listenerPorts[listener]) {
      reject(response, 'listener_port_mismatch');
      return;
    }
    const peer = normalizePeerAddress(request.socket?.remoteAddress);
    if (!peer) {
      reject(response, 'invalid_peer');
      return;
    }
    const originalHost = request.headers[ORIGINAL_HOST_HEADER];
    const target = request.originalUrl ?? request.url;
    // Narrow health exception: a loopback peer (the in-container probe), no proxy header, exact
    // GET/HEAD /api/health. Listener identity has already been verified above.
    if (isLoopbackPeer(peer) && originalHost === undefined && isInternalHealthProbe(request.method, target)) {
      internalProbes.add(request);
      next();
      return;
    }
    // H-1: only the proxies configured for THIS listener (server-assigned identity) are trusted.
    if (!isPeerInRanges(peer, ranges[listener])) {
      reject(response, 'untrusted_peer');
      return;
    }
    const surface = surfaceForListenerAndHost(listener, originalHost, config.hostnames);
    if (!surface) {
      reject(response, 'invalid_original_host');
      return;
    }
    const forwardedHost = request.headers['x-forwarded-host'];
    if (forwardedHost !== undefined) {
      const parsed = parseOriginalHost(forwardedHost);
      if (!parsed.ok || parsed.hostname !== config.hostnames[surface]) {
        reject(response, 'forwarded_host_mismatch');
        return;
      }
    }
    setTrustedRequestSurface(request, surface, config.expectedOrigins[surface]);
    next();
  };

  const enforceOrigin: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
    if (internalProbes.has(request)) {
      next();
      return;
    }
    const surface = getTrustedRequestSurface(request);
    const origin = getTrustedRequestOrigin(request);
    if (!runtime || !surface || !origin) {
      reject(response, runtime ? 'invalid_original_host' : 'not_configured');
      return;
    }
    const decision = evaluateOriginAgainst({ surface, method: request.method, origin: request.headers.origin }, runtime.config.expectedOrigins);
    if (!decision.allowed) {
      report('origin_rejected');
      response.status(403).json(ORIGIN_REJECTED);
      return;
    }
    next();
  };

  const enforceRoutePolicy: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
    if (internalProbes.has(request)) {
      next();
      return;
    }
    const surface = getTrustedRequestSurface(request);
    if (!runtime || !surface) {
      reject(response, runtime ? 'invalid_original_host' : 'not_configured');
      return;
    }
    const decision = decideRequest(surface, request.method, request.originalUrl ?? request.url);
    if (decision.outcome === 'unauthenticated') {
      // Marketing never looks up sessions, so its GET/HEAD /api/auth/me always answers 401 — the
      // routine anonymous page-load check (exact policy entry, trusted surface). Everything else
      // that reaches this branch (e.g. Marketing logout) is still counted.
      const routineMarketingSessionCheck = surface === 'marketing'
        && decision.entry.method === 'GET' && decision.entry.path === '/api/auth/me';
      if (!routineMarketingSessionCheck) report('authentication_failed');
      response.status(401).json(SIGN_IN_REQUIRED);
      return;
    }
    if (decision.outcome !== 'allow') {
      report('route_denied');
      response.status(decision.status === 421 ? 421 : 404).json(decision.status === 421 ? MISDIRECTED : NOT_FOUND);
      return;
    }
    const requirement = SESSION_REQUIREMENTS[decision.auth];
    if (!requirement) {
      // anonymous, login, capability, static and SPA shell: no session lookup at all.
      next();
      return;
    }
    authenticate(request, response, requirement).then((ok) => {
      if (ok) next();
      else report('authentication_failed');
    }, next);
  };

  return {
    configure(config) {
      if (runtime) throw new Error('Surface enforcement is already configured.');
      for (const listener of LISTENERS) {
        if (!Number.isInteger(config?.listenerPorts?.[listener])) throw new Error('Invalid listener ports.');
      }
      // I-6: the same canonical validation as the environment loader (mode, special-purpose,
      // single addresses, duplicates, cross-listener overlap). Error text carries no values.
      const proxies = validateTrustedProxies(config.trustedProxies, config.mode);
      if (!proxies.ok) {
        throw new Error(proxies.errors.some((error) => /one listener only/.test(error))
          ? 'Invalid trusted proxy configuration: a proxy may be trusted by one listener only.'
          : 'Invalid trusted proxy configuration.');
      }
      runtime = { config, ranges: { public: [...proxies.ranges.public], admin: [...proxies.ranges.admin] } };
    },
    isConfigured: () => runtime !== null,
    markReady() {
      ready = true;
    },
    markNotReady() {
      ready = false;
    },
    isReady: () => ready,
    tagListener(request, listener) {
      if (!isListenerName(listener)) throw new Error('Unknown listener.');
      if (listenerTags.has(request)) throw new Error('The request listener is already set.');
      listenerTags.set(request, listener);
    },
    isInternalProbe: (request) => internalProbes.has(request),
    identify,
    enforceOrigin,
    enforceRoutePolicy,
  };
}
