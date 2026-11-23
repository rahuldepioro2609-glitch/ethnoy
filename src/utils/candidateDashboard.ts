export type DashboardContentState = 'loading' | 'error' | 'ready';

export function getDashboardContentState(loading: boolean, error: string | null): DashboardContentState {
  if (loading) return 'loading';
  return error ? 'error' : 'ready';
}

export const NO_LINKED_APPLICATIONS_MESSAGE =
  'No application is linked to this student account. New applications submitted while signed in are linked automatically. For an older application, contact an official to verify ownership and link it to your account.';
