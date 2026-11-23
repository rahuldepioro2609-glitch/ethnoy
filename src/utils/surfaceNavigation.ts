import type { PortalRole } from '../components/RolePortal';

export type PortalSurface = 'marketing' | 'exam' | 'institution' | 'admin';
export type SurfaceHostnames = Record<PortalSurface, string>;
/**
 * What GET /api/surface-hostnames returns. Public surfaces omit `admin`: the public site never learns
 * or links the private Admin hostname. Only the Admin surface returns all four.
 */
export type DisclosedSurfaceHostnames = Partial<Record<PortalSurface, string>>;

/** Keep the Institute link on this machine when using the read-only live Institute preview. */
export function surfaceHostnamesForLocalInstitutePreview(
  hostnames: DisclosedSurfaceHostnames,
  currentHostname: string,
  previewEnabled: boolean,
): DisclosedSurfaceHostnames {
  const hostname = currentHostname.toLowerCase();
  if (!previewEnabled || !['localhost', '127.0.0.1'].includes(hostname)) return hostnames;
  return { ...hostnames, marketing: hostname, institution: hostname };
}

export type InstituteSignOutViewState = 'checking' | 'wrong_surface' | 'signed_out' | 'confirm';

/** A display hint is never enough to sign out; verify both the owning host and its live Institute session. */
export function instituteSignOutViewState(input: {
  authLoading: boolean;
  hostnames: DisclosedSurfaceHostnames | null;
  currentHostname: string;
  accountRole?: PortalRole | null;
}): InstituteSignOutViewState {
  if (input.authLoading || !input.hostnames) return 'checking';
  if (input.hostnames.institution?.toLowerCase() !== input.currentHostname.toLowerCase()) return 'wrong_surface';
  if (input.accountRole !== 'center') return 'signed_out';
  return 'confirm';
}

const ROLE_SURFACE: Readonly<Record<PortalRole, PortalSurface>> = Object.freeze({
  candidate: 'exam',
  center: 'institution',
  official: 'admin',
});

/** Admin sign-in page; the landing page of the Admin host. */
export const ADMIN_HOME_PATH = '/login/official';

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function surfaceForRole(role: PortalRole): PortalSurface {
  return ROLE_SURFACE[role];
}

export function requiredSurfaceForPath(pathname: string): PortalSurface | null {
  if (pathname === '/' || pathname === '/index.html') return 'marketing';
  // SM-1 Platform Staff sign-in and dashboard (src/utils/staffAccess.ts) belong to the Admin surface.
  if (/^\/(?:login|dashboard)\/platform-staff\/*$/.test(pathname)) return 'admin';
  const role = pathname.match(/^\/(?:login|dashboard)\/(candidate|center|official)(?:\/|$)/)?.[1] as PortalRole | undefined;
  return role ? surfaceForRole(role) : null;
}

/** Return the same URL on the target surface, preserving protocol, port, path, query and fragment. */
export function urlForSurface(href: string, surface: PortalSurface, hostnames: DisclosedSurfaceHostnames): string | null {
  const hostname = hostnames[surface];
  if (typeof hostname !== 'string' || !HOSTNAME.test(hostname)) return null;
  const target = new URL(href);
  if (target.hostname.toLowerCase() === hostname.toLowerCase()) return null;
  target.hostname = hostname;
  return target.toString();
}

export type SurfaceNavigationPlan =
  /** Render the page here. For an Admin page this means the server confirmed this is the Admin host. */
  | { action: 'stay' }
  /** Move the same URL to the surface that owns the role's session cookie. */
  | { action: 'redirect'; url: string }
  /** On the Admin host, a page that is not an Admin page: show Admin sign-in instead of public content. */
  | { action: 'admin_home' }
  /** An Admin-only page requested anywhere but the Admin host. Public hosts never route to Admin. */
  | { action: 'not_found' }
  /** The configured hostname for the required surface is missing or malformed. */
  | { action: 'invalid' };

/**
 * Decide where the current page belongs. `required` is the surface the path needs (null: any surface,
 * or not yet known). Fails closed: an Admin page stays only when this host IS the disclosed Admin host.
 */
export function planSurfaceNavigation(href: string, required: PortalSurface | null, hostnames: DisclosedSurfaceHostnames): SurfaceNavigationPlan {
  const current = new URL(href).hostname.toLowerCase();
  const onAdminHost = typeof hostnames.admin === 'string' && hostnames.admin.toLowerCase() === current;
  if (required === 'admin') return onAdminHost ? { action: 'stay' } : { action: 'not_found' };
  if (onAdminHost && (required === null || required === 'marketing')) return { action: 'admin_home' };
  if (required === null) return { action: 'stay' };
  if (hostnames[required]?.toLowerCase() === current) return { action: 'stay' };
  const url = urlForSurface(href, required, hostnames);
  return url ? { action: 'redirect', url } : { action: 'invalid' };
}
