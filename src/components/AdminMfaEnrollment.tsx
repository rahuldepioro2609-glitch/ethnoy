import React, { useState } from 'react';
import { apiRequestWithMeta } from '../api';
import { adminMfaErrorView, isCompleteAdminMfaCode, normaliseAdminMfaCode } from '../utils/adminMfa';

interface EnrollmentDetails {
  readonly otpauthUri: string;
  readonly secretBase32: string;
}

interface AdminMfaEnrollmentProps {
  readonly onSignedIn: () => void;
  readonly onRestart: (message: string) => void;
  readonly buttonClass?: string;
}

export const AdminMfaEnrollment: React.FC<AdminMfaEnrollmentProps> = ({ onSignedIn, onRestart, buttonClass = 'bg-[#0B2E59]' }) => {
  const [ticket, setTicket] = useState('');
  const [details, setDetails] = useState<EnrollmentDetails | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !ticket.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await apiRequestWithMeta<EnrollmentDetails>('/api/auth/mfa/enrol/start', {
        method: 'POST', body: JSON.stringify({ ticket: ticket.trim() }),
      });
      setTicket('');
      setDetails(data);
    } catch (caught) {
      const failure = caught as { status?: number; code?: string };
      const view = adminMfaErrorView(failure.status, failure.code);
      if (view.restart) onRestart(view.message);
      else setError(view.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !isCompleteAdminMfaCode(code)) return;
    setBusy(true);
    setError(null);
    try {
      const { data: result } = await apiRequestWithMeta<{ status: string }>('/api/auth/mfa/enrol/confirm', {
        method: 'POST', body: JSON.stringify({ code }),
      });
      setCode('');
      if (result.status === 'signed_in') onSignedIn();
      else setError('Enrollment could not be confirmed. Please restart sign-in.');
    } catch (caught) {
      const failure = caught as { status?: number; code?: string };
      const view = adminMfaErrorView(failure.status, failure.code);
      if (view.restart) onRestart(view.message);
      else setError(view.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" aria-live="polite">
      <div>
        <h2 className="text-2xl font-extrabold text-[#0B2E59]">Set up your authenticator</h2>
        <p className="mt-1 text-sm text-slate-600">Administrative sign-in requires an authenticator app. Use your one-time enrollment ticket to begin.</p>
      </div>
      {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {!details ? (
        <form className="space-y-4" onSubmit={(event) => void start(event)}>
          <label htmlFor="admin-mfa-ticket" className="block text-sm font-semibold text-slate-700">One-time enrollment ticket</label>
          <input id="admin-mfa-ticket" autoComplete="off" required value={ticket} disabled={busy} onChange={(event) => setTicket(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 font-mono text-sm outline-none focus:border-emerald-600 focus:bg-white" />
          <button type="submit" disabled={busy || !ticket.trim()} className={`w-full rounded-lg ${buttonClass} px-4 py-3 text-sm font-bold text-white disabled:opacity-60`}>{busy ? 'Starting…' : 'Start authenticator setup'}</button>
          <button type="button" disabled={busy} onClick={() => onRestart('Sign in again when you have an enrollment ticket.')} className="w-full text-center text-sm font-bold text-slate-600 hover:underline">Back to sign in</button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void confirm(event)}>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-800">Add this account in your authenticator app</p>
            <p className="mt-2 break-all font-mono text-xs text-slate-600">{details.otpauthUri}</p>
            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Manual setup key</p>
            <p className="mt-1 select-all break-all font-mono text-lg font-bold tracking-wider text-[#0B2E59]">{details.secretBase32}</p>
            <p className="mt-2 text-xs text-amber-800">This key is shown once. Store it only in your authenticator app.</p>
          </div>
          <label htmlFor="admin-mfa-enrol-code" className="block text-sm font-semibold text-slate-700">Current 6-digit authenticator code</label>
          <input id="admin-mfa-enrol-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} autoFocus value={code} disabled={busy} onChange={(event) => setCode(normaliseAdminMfaCode(event.target.value))} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-center font-mono text-lg tracking-[0.4em] outline-none focus:border-emerald-600 focus:bg-white" />
          <button type="submit" disabled={busy || !isCompleteAdminMfaCode(code)} className={`w-full rounded-lg ${buttonClass} px-4 py-3 text-sm font-bold text-white disabled:opacity-60`}>{busy ? 'Confirming…' : 'Confirm and sign in'}</button>
          <button type="button" disabled={busy} onClick={() => onRestart('Enrollment was not completed. Sign in again to restart.')} className="w-full text-center text-sm font-bold text-slate-600 hover:underline">Cancel setup</button>
        </form>
      )}
    </div>
  );
};
