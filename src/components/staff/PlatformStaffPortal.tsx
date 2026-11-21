// SM-1: Platform Staff sign-in and dashboard (/login/platform-staff, /dashboard/platform-staff).
// Uses only the Platform Staff API (its own path-scoped session cookie); never the portal session.
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, BadgeCheck } from 'lucide-react';
import { ApiError, apiRequest } from '../../api';
import { BrandLogo } from '../BrandLogo';
import { Button, Card, EmptyState, ErrorState, LoadingState, StatusBadge, TextField } from '../ui';
import { PLATFORM_STAFF_DASHBOARD_PATH, PLATFORM_STAFF_LOGIN_PATH } from '../../utils/staffAccess';

interface StaffView {
  staffId: string;
  displayName: string;
  mustChangePassword: boolean;
  department: { id: string; name: string } | null;
  roles: Array<{ id: string; name: string }>;
  permissions: string[];
}
interface Unavailable { available: false; reason: string }
interface Dashboard { staff: StaffView; workQueue: Unavailable & { items: unknown[] }; activity: Unavailable & { events: unknown[] } }

interface PlatformStaffPortalProps {
  pathname: string;
  navigate: (path: string) => void;
  onHome: () => void;
}

type Phase = 'checking' | 'signed-out' | 'change-password' | 'dashboard' | 'not-installed';

export const PlatformStaffPortal: React.FC<PlatformStaffPortalProps> = ({ pathname, navigate, onHome }) => {
  const [phase, setPhase] = useState<Phase>('checking');
  const [staff, setStaff] = useState<StaffView | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState({ staffId: '', password: '' });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });

  const enter = useCallback(async (view: StaffView) => {
    setStaff(view);
    if (view.mustChangePassword) {
      setPhase('change-password');
      return;
    }
    const data = await apiRequest<Dashboard>('/api/platform-staff/dashboard');
    setDashboard(data);
    setPhase('dashboard');
    if (pathname !== PLATFORM_STAFF_DASHBOARD_PATH) navigate(PLATFORM_STAFF_DASHBOARD_PATH);
  }, [navigate, pathname]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ staff: StaffView }>('/api/platform-staff/auth/me')
      .then((data) => { if (!cancelled) return enter(data.staff); })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 503) setPhase('not-installed');
        else {
          setPhase('signed-out');
          if (pathname !== PLATFORM_STAFF_LOGIN_PATH) navigate(PLATFORM_STAFF_LOGIN_PATH);
        }
      });
    return () => { cancelled = true; };
    // Runs once per mount: the session check decides the phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await apiRequest<{ staff: StaffView }>('/api/platform-staff/auth/login', { method: 'POST', body: JSON.stringify(credentials) });
      setCredentials({ staffId: '', password: '' });
      await enter(data.staff);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 503 ? 'Staff sign-in is not available yet.' : caught instanceof Error ? caught.message : 'Sign-in failed.');
      setCredentials((current) => ({ ...current, password: '' }));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/api/platform-staff/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: passwords.currentPassword, newPassword: passwords.newPassword }) });
      setPasswords({ currentPassword: '', newPassword: '', confirm: '' });
      const me = await apiRequest<{ staff: StaffView }>('/api/platform-staff/auth/me');
      await enter(me.staff);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The password could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await apiRequest('/api/platform-staff/auth/logout', { method: 'POST' });
    } finally {
      setStaff(null);
      setDashboard(null);
      setPhase('signed-out');
      navigate(PLATFORM_STAFF_LOGIN_PATH);
    }
  };

  return (
    <main className="min-h-screen bg-[#EEF6F1] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-2">
          <BrandLogo />
          <div className="flex items-center gap-2">
            {staff && phase !== 'signed-out' && <Button variant="secondary" size="sm" onClick={() => void signOut()}>Sign out</Button>}
            <button onClick={onHome} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-[#0B2E59] hover:bg-emerald-50">
              <ArrowLeft className="h-4 w-4" /> Home
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        {phase === 'checking' && <LoadingState label="Checking staff session…" />}

        {phase === 'not-installed' && (
          <EmptyState title="Platform Staff sign-in is not available yet" description="Staff accounts have not been set up on this portal." />
        )}

        {phase === 'signed-out' && (
          <div className="mx-auto max-w-md">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-teal-700">ELTNOY staff</p>
            <h1 className="mt-2 text-3xl font-black text-[#0B2E59]">Platform Staff Login</h1>
            <p className="mt-2 text-sm text-slate-600">Sign in with the Staff ID and password issued by your Super Admin. This is separate from student, institute and Super Admin sign-in.</p>
            <form className="mt-6 space-y-4 rounded-2xl bg-white p-6 shadow-sm" onSubmit={(event) => void signIn(event)}>
              <TextField label="Staff ID" required value={credentials.staffId} onChange={(e) => setCredentials({ ...credentials, staffId: e.target.value })} autoComplete="username" maxLength={50} />
              <TextField label="Password" required type="password" value={credentials.password} onChange={(e) => setCredentials({ ...credentials, password: e.target.value })} autoComplete="current-password" maxLength={128} />
              {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">{error}</p>}
              <Button type="submit" fullWidth loading={busy}>Secure sign in</Button>
            </form>
          </div>
        )}

        {phase === 'change-password' && staff && (
          <div className="mx-auto max-w-md">
            <h1 className="text-2xl font-black text-[#0B2E59]">Replace your initial password</h1>
            <p className="mt-2 text-sm text-slate-600">Welcome, {staff.displayName}. Choose your own password before continuing. Other sessions of this account will be signed out.</p>
            <form className="mt-6 space-y-4 rounded-2xl bg-white p-6 shadow-sm" onSubmit={(event) => void changePassword(event)}>
              <TextField label="Current (initial) password" required type="password" value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} autoComplete="current-password" />
              <TextField label="New password" required type="password" value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} hint="At least 12 characters." autoComplete="new-password" />
              <TextField label="Confirm new password" required type="password" value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} autoComplete="new-password" />
              {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">{error}</p>}
              <Button type="submit" fullWidth loading={busy}>Save new password</Button>
            </form>
          </div>
        )}

        {phase === 'dashboard' && dashboard && (
          <div className="space-y-6">
            <section className="rounded-2xl bg-gradient-to-r from-teal-900 via-[#0B2E59] to-slate-950 p-7 text-white">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-white/70">Platform Staff workspace</p>
              <h1 className="mt-2 text-3xl font-black">{dashboard.staff.displayName}</h1>
              <p className="mt-1 font-mono text-sm text-white/80">{dashboard.staff.staffId}</p>
            </section>
            <div className="grid gap-6 md:grid-cols-3">
              <Card title="Department" headingLevel={2}>
                <p className="text-sm">{dashboard.staff.department?.name ?? 'Not assigned'}</p>
              </Card>
              <Card title="Roles" headingLevel={2}>
                {dashboard.staff.roles.length
                  ? <ul className="space-y-1 text-sm">{dashboard.staff.roles.map((role) => <li key={role.id} className="flex items-center gap-2"><BadgeCheck className="h-4 w-4 text-teal-700" aria-hidden="true" />{role.name}</li>)}</ul>
                  : <p className="text-sm text-slate-600">No roles assigned.</p>}
              </Card>
              <Card title="Permissions" headingLevel={2}>
                {dashboard.staff.permissions.length
                  ? <ul className="space-y-1 font-mono text-xs">{dashboard.staff.permissions.map((code) => <li key={code}>{code}</li>)}</ul>
                  : <p className="text-sm text-slate-600">None. Permissions can be granted only after the permission catalogue (D-08) is approved.</p>}
              </Card>
            </div>
            <Card title="Work queue" headingLevel={2} actions={<StatusBadge status="pending" label="Not available" />}>
              <EmptyState title="No assigned work" description={dashboard.workQueue.reason} />
            </Card>
            <Card title="Activity history" headingLevel={2} actions={<StatusBadge status="pending" label="Not available" />}>
              <p className="text-sm text-slate-600">{dashboard.activity.reason}</p>
            </Card>
          </div>
        )}

        {phase === 'dashboard' && !dashboard && <ErrorState description="The dashboard could not be loaded." onRetry={() => window.location.reload()} />}
      </div>
    </main>
  );
};
