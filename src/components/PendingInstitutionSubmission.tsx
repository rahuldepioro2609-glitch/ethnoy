import React, { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api';
import { INSTITUTION_DOCUMENT_CATEGORIES } from '../utils/institutionDocuments';

interface SubmissionStatus {
  cycle: {
    version: number;
    source: string;
    expiresAt: string;
  };
  categories: Array<{ name: string; documentCount: number }>;
  uploadEnabled: false;
  completenessPolicyEnabled: false;
}

interface PendingInstitutionSubmissionProps {
  message: string;
  onReturnToLogin: () => void;
}

export const PendingInstitutionSubmission: React.FC<PendingInstitutionSubmissionProps> = ({
  message,
  onReturnToLogin,
}) => {
  const [status, setStatus] = useState<SubmissionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [recoveryLoginId, setRecoveryLoginId] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const current = await apiRequest<SubmissionStatus>('/api/institution-document-submission/status');
      setStatus(current);
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : 'Secure submission access is unavailable.');
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const reissue = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setRecoveryMessage(null);
    try {
      const result = await apiRequest<{ message: string }>('/api/institution-document-submission/reissue', {
        method: 'POST',
        body: JSON.stringify({ loginId: recoveryLoginId.trim(), password: recoveryPassword }),
      });
      setRecoveryMessage(result.message);
      setRecoveryPassword('');
      await loadStatus();
    } catch (error) {
      setRecoveryMessage(error instanceof Error ? error.message : 'Access recovery could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await apiRequest<void>('/api/institution-document-submission/revoke', { method: 'POST' });
      setStatus(null);
      setStatusError('Secure submission access was revoked. Reissue it with your existing institute credentials.');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Secure access could not be revoked.');
    } finally {
      setBusy(false);
    }
  };

  const categoryCounts = new Map((status?.categories ?? []).map(({ name, documentCount }) => [name, documentCount]));

  return (
    <div>
      <button type="button" onClick={onReturnToLogin} className="mb-6 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-[#0B2E59]">
        Return to institute sign in
      </button>
      <h2 className="text-2xl font-extrabold text-[#0B2E59]">Pending institute document submission</h2>
      <p role="status" className="mt-2 text-sm leading-6 text-slate-600">{message}</p>
      {status && (
        <>
          <div className="mt-5 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
            Submission cycle {status.cycle.version} · Access expires {new Date(status.cycle.expiresAt).toLocaleString()}.
            No normal institute portal session has been created.
          </div>
          <ul className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200">
            {INSTITUTION_DOCUMENT_CATEGORIES.map((category) => (
              <li key={category} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span className="font-semibold text-slate-800">{category}</span>
                <span className="text-slate-600">{categoryCounts.get(category) ?? 0} documents on record</span>
                <button type="button" disabled className="cursor-not-allowed rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-400" aria-describedby="document-upload-disabled">
                  Upload disabled
                </button>
              </li>
            ))}
          </ul>
          <p id="document-upload-disabled" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
            Document upload, replacement, file policies, and category-cardinality rules are not enabled yet. Category counts are informational only; document completeness does not control Official approval.
          </p>
          <button type="button" disabled={busy} onClick={() => void revoke()} className="mt-4 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">
            Revoke this submission access
          </button>
        </>
      )}
      {!status && statusError && (
        <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {statusError}
        </div>
      )}
      <form onSubmit={(event) => void reissue(event)} className="mt-6 space-y-3 rounded-xl border border-slate-200 p-4">
        <h3 className="font-bold text-slate-900">Recover secure submission access</h3>
        <label className="block text-sm font-semibold text-slate-700">
          Existing institute login ID
          <input required minLength={4} maxLength={50} pattern="[A-Za-z0-9._-]+" autoComplete="username" value={recoveryLoginId} onChange={(event) => setRecoveryLoginId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
        </label>
        <label className="block text-sm font-semibold text-slate-700">
          Password
          <input required maxLength={128} type="password" autoComplete="current-password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
        </label>
        <button type="submit" disabled={busy} className="rounded-lg bg-[#0B2E59] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
          {busy ? 'Please wait…' : 'Reissue secure access'}
        </button>
        {recoveryMessage && <p role="status" className="text-sm text-slate-600">{recoveryMessage}</p>}
      </form>
    </div>
  );
};
