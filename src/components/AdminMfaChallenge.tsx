// AUTH C1.9.2 (MFA P3a-2): the authenticator-code step of Official / Super Admin sign-in.
// Shown ONLY after the server answered 202 { status: 'mfa_required' } to the password step. It never
// decides success: only the server's `signed_in` answer does, and the existing /api/auth/me check then
// confirms the session. The challenge cookie is HttpOnly and is never read here.
import React, { useState } from 'react';
import { apiRequestWithMeta } from '../api';
import { isCompleteAdminMfaCode, normaliseAdminMfaCode, submitAdminMfaCode, type AdminMfaRequest } from '../utils/adminMfa';

interface AdminMfaChallengeProps {
  /** The server issued the MFA-verified session. */
  onSignedIn: () => void;
  /** The challenge can no longer be used (or the user went back): return to the password form with this message. */
  onRestart: (message: string | null) => void;
  /** Injected by tests; the app uses apiRequestWithMeta. */
  request?: AdminMfaRequest;
  buttonClass?: string;
}

const defaultRequest: AdminMfaRequest = (path, init) => apiRequestWithMeta<unknown>(path, init);

export const AdminMfaChallenge: React.FC<AdminMfaChallengeProps> = ({ onSignedIn, onRestart, request = defaultRequest, buttonClass = 'bg-[#0B2E59]' }) => {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !isCompleteAdminMfaCode(code)) return;
    setBusy(true);
    setError(null);
    const outcome = await submitAdminMfaCode(code, request);
    setBusy(false);
    setCode('');
    if (outcome.kind === 'signed_in') {
      onSignedIn();
      return;
    }
    if (outcome.view.restart) onRestart(outcome.view.message);
    else setError(outcome.view.message);
  };

  return (
    <div className="space-y-5" aria-live="polite">
      <div>
        <h2 className="text-2xl font-extrabold text-[#0B2E59]">Enter your authenticator code</h2>
        <p className="mt-1 text-sm text-slate-600">
          Open the authenticator app for your administrative account and enter the current 6-digit code. Your session starts only after the code is verified.
        </p>
      </div>
      {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <label htmlFor="admin-mfa-code" className="block text-sm font-semibold text-slate-700">Authenticator code</label>
        <input
          id="admin-mfa-code"
          name="admin-mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
          maxLength={6}
          autoFocus
          value={code}
          disabled={busy}
          onChange={(event) => setCode(normaliseAdminMfaCode(event.target.value))}
          className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-center font-mono text-lg tracking-[0.4em] outline-none focus:border-emerald-600 focus:bg-white focus:ring-2 focus:ring-emerald-600/15"
        />
        <button type="submit" disabled={busy || !isCompleteAdminMfaCode(code)} className={`w-full rounded-lg ${buttonClass} px-4 py-3 text-sm font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60`}>
          {busy ? 'Verifying…' : 'Verify and sign in'}
        </button>
        <button type="button" disabled={busy} onClick={() => onRestart(null)} className="w-full text-center text-sm font-bold text-slate-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          Back to sign in
        </button>
      </form>
    </div>
  );
};
