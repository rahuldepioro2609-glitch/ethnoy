// SM-1: which staff sign-in options the portal chooser offers, and why an option is unavailable.
// Pure data, unit-tested. An option is active only when its backend sign-in, session isolation and
// authorization are implemented and tested AND an account can actually become usable.

export interface StaffLoginOption {
  id: 'platform-staff' | 'organization-staff';
  title: string;
  subtitle: string;
  /** Route of the sign-in page; null while unavailable. */
  path: string | null;
  available: boolean;
  /** Shown instead of the link when unavailable. */
  unavailableReason: string | null;
}

export const STAFF_LOGIN_OPTIONS: readonly StaffLoginOption[] = Object.freeze([
  Object.freeze({
    id: 'platform-staff',
    title: 'Platform Staff Login',
    subtitle: 'ELTNOY staff accounts created by the Super Admin. Sign in with your Staff ID.',
    path: '/login/platform-staff',
    available: true,
    unavailableReason: null,
  }),
  Object.freeze({
    id: 'organization-staff',
    title: 'Organization Staff Login',
    subtitle: 'Staff invited by an institute owner.',
    path: null,
    available: false,
    unavailableReason: 'Not available yet: staff accounts need mobile verification, which waits for an approved SMS provider (C-18).',
  }),
]);

export const PLATFORM_STAFF_LOGIN_PATH = '/login/platform-staff';
export const PLATFORM_STAFF_DASHBOARD_PATH = '/dashboard/platform-staff';

export function isPlatformStaffPath(pathname: string): boolean {
  const normalised = pathname.replace(/\/+$/, '');
  return normalised === PLATFORM_STAFF_LOGIN_PATH || normalised === PLATFORM_STAFF_DASHBOARD_PATH;
}

/** Q117 role templates, as labelled in the reviewed migration (display only; the server validates). */
export const ORGANIZATION_STAFF_ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  reviewer: 'Reviewer',
  verifier: 'Verifier',
  application_manager: 'Application Manager',
  finance_viewer: 'Finance Viewer',
  invigilator: 'Invigilator',
  viewer: 'Viewer',
});
