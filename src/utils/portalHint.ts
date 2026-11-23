// Display-only "signed in elsewhere" hint (owner decision, 2026-11-23).
//
// Each site keeps its own sign-in: the session cookie is host-only on institution.eltnoy.com, so the
// public site (eltnoy.com) cannot see it (surface isolation, P1-B). To still show "you are signed in as
// <Institute> — back to the dashboard" on the public site, the Institute dashboard stores ONLY the
// Institute's display name in a small, non-secret cookie for the parent domain. It is never a
// credential: the link it produces goes to the Institute site, which checks the real session again.
// Anyone can set this cookie in their own browser; it only changes what that browser displays.

export const PORTAL_HINT_COOKIE = 'elt_portal_hint';
/** Same lifetime as a portal session (server/auth.ts SESSION_TTL_MS, 12 hours). */
export const PORTAL_HINT_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_NAME_LENGTH = 80;
const PREFIX = 'v1.center.';

export interface PortalHint {
  role: 'center';
  name: string;
}

/** Removes control characters, trims and limits the length; empty means "no usable name". */
function cleanName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH).trim();
}

/**
 * The cookie Domain that lets sibling sites read the hint: the hostname without its first label
 * (institution.eltnoy.com -> eltnoy.com). Null (host-only cookie) for IP addresses, localhost and
 * two-label hosts, where no shared parent exists.
 */
export function portalHintCookieDomain(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || /^[0-9.]+$/.test(host) || host.includes(':')) return null;
  const labels = host.split('.');
  return labels.length >= 3 ? labels.slice(1).join('.') : null;
}

export function encodePortalHint(hint: PortalHint): string | null {
  const name = cleanName(hint.name);
  return hint.role === 'center' && name ? `${PREFIX}${encodeURIComponent(name)}` : null;
}

/** Reads the hint from a `document.cookie` string. Anything malformed is ignored (null). */
export function readPortalHint(cookieString: string): PortalHint | null {
  const entry = cookieString.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${PORTAL_HINT_COOKIE}=`));
  const value = entry?.slice(PORTAL_HINT_COOKIE.length + 1) ?? '';
  if (!value.startsWith(PREFIX)) return null;
  let name: string;
  try {
    name = cleanName(decodeURIComponent(value.slice(PREFIX.length)));
  } catch {
    return null;
  }
  return name ? { role: 'center', name } : null;
}

interface CookieTarget { cookie: string }
interface LocationLike { hostname: string; protocol: string }

function cookieAttributes(location: LocationLike, maxAgeSeconds: number): string {
  const domain = portalHintCookieDomain(location.hostname);
  return [
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax',
    ...(domain ? [`Domain=${domain}`] : []),
    ...(location.protocol === 'https:' ? ['Secure'] : []),
  ].join('; ');
}

/** Stores the hint for the parent domain. Does nothing if the name is unusable. */
export function writePortalHint(target: CookieTarget, location: LocationLike, hint: PortalHint): void {
  const value = encodePortalHint(hint);
  if (!value) return;
  target.cookie = `${PORTAL_HINT_COOKIE}=${value}; ${cookieAttributes(location, PORTAL_HINT_MAX_AGE_SECONDS)}`;
}

/** Removes the hint (parent-domain and host-only copies). Safe to call when none exists. */
export function clearPortalHint(target: CookieTarget, location: LocationLike): void {
  target.cookie = `${PORTAL_HINT_COOKIE}=; ${cookieAttributes(location, 0)}`;
  // A host-only copy could exist from a run on a host without a shared parent; clear it too.
  target.cookie = `${PORTAL_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}

// Browser wrappers. All cookie access for the hint lives in this file, so App.tsx and RolePortal.tsx
// never touch document.cookie (adminMfa.test.ts keeps them away from the HttpOnly challenge cookie).
// Every wrapper is a no-op when cookies are unavailable.

export function readPortalHintFromBrowser(): PortalHint | null {
  try { return readPortalHint(document.cookie); } catch { return null; }
}

export function savePortalHintInBrowser(hint: PortalHint): void {
  try { writePortalHint(document, window.location, hint); } catch { /* cookies unavailable */ }
}

export function clearPortalHintInBrowser(): void {
  try { clearPortalHint(document, window.location); } catch { /* cookies unavailable */ }
}
