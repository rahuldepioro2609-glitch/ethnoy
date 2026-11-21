// AUTH-1 / SM-2: Super Admin tab — institutional verification and suspension of Institutes.
// Institutional verification is separate from Official approval (shown read-only here). Every
// decision is made and authorized by the server (Super Admin only); this panel never decides access.
import React, { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../../api';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingState, StatusBadge, TextField } from '../ui';
import { availableDecisions, type InstitutionalDecision } from '../../utils/instituteVerification';

type Decision = InstitutionalDecision;

interface InstituteRow {
  institutionId: string;
  loginId: string;
  name: string;
  officialApproval: string;
  institutionalVerification: 'pending' | 'verified' | 'rejected';
  institutionalDecidedAt: string | null;
  suspended: boolean;
  contacts: { mobile: { verified: boolean; destination: string | null }; email: { verified: boolean; destination: string | null } };
}
interface DecisionEvent { id: string; occurredAt: string; action: string; institutionId: string | null; actorId: string | null; reason: string | null }

const DECISION_LABELS: Readonly<Record<Decision, string>> = Object.freeze({ verify: 'Verify', reject: 'Reject', suspend: 'Suspend', restore: 'Lift suspension' });
const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'institute.institutional_verified': 'Institutionally verified',
  'institute.institutional_rejected': 'Institutionally rejected',
  'institute.suspended': 'Suspended',
  'institute.suspension_lifted': 'Suspension lifted',
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'The request could not be completed.');

export const InstituteVerificationPanel: React.FC = () => {
  const [institutes, setInstitutes] = useState<InstituteRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [notInstalled, setNotInstalled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ row: InstituteRow; decision: Decision; reason: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [list, history] = await Promise.all([
        apiRequest<{ institutes: InstituteRow[] }>('/api/admin/institute-verifications'),
        apiRequest<{ decisions: DecisionEvent[] }>('/api/admin/institute-verifications/decisions'),
      ]);
      setInstitutes(list.institutes);
      setDecisions(history.decisions.slice(0, 50));
      setNotInstalled(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) setNotInstalled(true);
      else setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    setNotice(null);
    try {
      await apiRequest(`/api/admin/institute-verifications/${encodeURIComponent(pending.row.institutionId)}/${pending.decision}`, {
        method: 'POST',
        body: JSON.stringify({ reason: pending.reason }),
      });
      setNotice(`${DECISION_LABELS[pending.decision]}: ${pending.row.name} — recorded in the audit log.`);
      setPending(null);
      await load();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingState label="Loading institutional verification…" />;
  if (notInstalled) {
    return (
      <EmptyState
        title="Institutional verification is not installed yet"
        description="The reviewed AUTH-1 verification migration has not been applied to this database. No decision can be recorded until it is approved and applied."
      />
    );
  }
  if (loadError) return <ErrorState description={loadError} onRetry={() => void load()} />;

  const nameOf = (id: string | null) => institutes.find((row) => row.institutionId === id)?.name ?? id ?? '—';

  return (
    <div className="space-y-6">
      <Card
        title="Institutional verification"
        description="Super Admin only. Institutional verification (registration details and documents) and suspension are separate from Official approval, which is shown here for reference and is not changed by these decisions."
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>An Institute can use the portal only when Official approval is granted, its mobile and email are verified, it is institutionally verified and it is not suspended.</li>
          <li>Suspension takes effect on the Institute's next request. Lifting it does not change the verification decision.</li>
          <li>Every decision needs a reason (10–500 characters) and is recorded with your account in the append-only audit log.</li>
        </ul>
        {notice && <p role="status" className="mt-4 rounded-lg bg-slate-100 p-3 text-sm text-slate-800">{notice}</p>}
      </Card>

      <Card title="Institutes" headingLevel={3}>
        <DataTable
          caption="Institutes and their verification state"
          captionHidden
          rows={institutes}
          rowKey={(row) => row.institutionId}
          emptyTitle="No institutes registered"
          columns={[
            { key: 'name', header: 'Institute', isRowHeader: true, render: (row) => <span>{row.name}<span className="block font-mono text-xs text-slate-500">{row.loginId}</span></span> },
            { key: 'approval', header: 'Official approval', render: (row) => <StatusBadge status={row.officialApproval} /> },
            {
              key: 'contacts', header: 'Mobile / email', render: (row) => (
                <span className="text-xs">
                  {row.contacts.mobile.verified ? 'Mobile verified' : 'Mobile not verified'}
                  <span className="block">{row.contacts.email.verified ? 'Email verified' : 'Email not verified'}</span>
                </span>
              ),
            },
            { key: 'institutional', header: 'Institutional verification', render: (row) => <StatusBadge status={row.institutionalVerification} /> },
            { key: 'suspension', header: 'Suspension', render: (row) => <StatusBadge status={row.suspended ? 'rejected' : 'approved'} label={row.suspended ? 'Suspended' : 'Not suspended'} /> },
            {
              key: 'actions', header: 'Actions', render: (row) => (
                <div className="flex flex-wrap gap-2">
                  {availableDecisions(row).map((decision) => (
                    <Button
                      key={decision}
                      size="sm"
                      variant={decision === 'reject' || decision === 'suspend' ? 'danger' : 'secondary'}
                      disabled={busy}
                      onClick={() => setPending({ row, decision, reason: '' })}
                    >
                      {DECISION_LABELS[decision]}
                    </Button>
                  ))}
                </div>
              ),
            },
          ]}
        />
        {pending && (
          <form
            className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}
          >
            <p className="text-sm font-semibold">{DECISION_LABELS[pending.decision]}: {pending.row.name} ({pending.row.loginId})</p>
            <TextField label="Reason" required value={pending.reason} onChange={(e) => setPending({ ...pending, reason: e.target.value })} hint="10–500 characters. Recorded in the audit log." />
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant={pending.decision === 'reject' || pending.decision === 'suspend' ? 'danger' : 'primary'} loading={busy}>Confirm</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            </div>
          </form>
        )}
      </Card>

      <Card title="Recent decisions" headingLevel={3} description="Append-only. Visible to Super Admins only (A-12).">
        <DataTable
          caption="Recent institutional verification decisions"
          captionHidden
          rows={decisions}
          rowKey={(row) => row.id}
          emptyTitle="No decisions yet"
          columns={[
            { key: 'time', header: 'Time', isRowHeader: true, render: (row) => new Date(row.occurredAt).toLocaleString() },
            { key: 'institute', header: 'Institute', render: (row) => nameOf(row.institutionId) },
            { key: 'action', header: 'Decision', render: (row) => ACTION_LABELS[row.action] ?? row.action },
            { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
            { key: 'actor', header: 'By', render: (row) => <span className="font-mono text-xs">{row.actorId ?? '—'}</span> },
          ]}
        />
      </Card>
    </div>
  );
};
