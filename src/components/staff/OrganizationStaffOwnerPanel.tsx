// SM-1: Organization Owner's staff section on the institute dashboard (Q115–Q117).
// The server scopes everything to the Owner's own organization; this panel never sends an
// organization identifier.
import React, { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../../api';
import { Button, Card, Checkbox, DataTable, EmptyState, ErrorState, LoadingState, StatusBadge, TextField } from '../ui';
import { ORGANIZATION_STAFF_ROLE_LABELS } from '../../utils/staffAccess';

interface Member {
  id: string; staffId: string; displayName: string; status: string; accepted: boolean; verified: boolean;
  roles: string[]; invitation: { state: 'live' | 'expired' | 'used' | 'none'; expiresAt: string | null };
}
interface Unavailable { available: boolean; reason: string }
interface StaffData {
  members: Member[];
  roleTemplates: Array<{ code: string; label: string; description: string }>;
  invitationsAvailable: boolean;
  invitationsUnavailableReason: string | null;
  /** Fixed, approved invitation-code lifetime (72 hours). */
  invitationExpiryHours?: number;
  verification: Unavailable;
  customRoles: Unavailable;
  suspensionAndRemoval: Unavailable;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'The request could not be completed.');

export const OrganizationStaffOwnerPanel: React.FC = () => {
  const [data, setData] = useState<StaffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notInstalled, setNotInstalled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [invite, setInvite] = useState({ staffId: '', displayName: '' });
  const [issuedCode, setIssuedCode] = useState<{ staffId: string; code: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; roles: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await apiRequest<StaffData>('/api/center/staff'));
      setNotInstalled(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) setNotInstalled(true);
      else setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sendInvitation = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setIssuedCode(null);
    try {
      const result = await apiRequest<{ member: Member; invitationCode: string }>('/api/center/staff/invitations', { method: 'POST', body: JSON.stringify(invite) });
      setIssuedCode({ staffId: result.member.staffId, code: result.invitationCode });
      setInvite({ staffId: '', displayName: '' });
      await load();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const saveRoles = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setNotice(null);
    try {
      await apiRequest(`/api/center/staff/${encodeURIComponent(editing.id)}/roles`, { method: 'PUT', body: JSON.stringify({ roleCodes: editing.roles }) });
      setEditing(null);
      setNotice('Roles saved.');
      await load();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingState label="Loading organization staff…" />;
  if (notInstalled) return <EmptyState title="Organization staff is not set up yet" description="Staff management has not been installed on this portal." />;
  if (loadError || !data) return <ErrorState description={loadError ?? 'Staff could not be loaded.'} onRetry={() => void load()} />;

  const label = (code: string) => ORGANIZATION_STAFF_ROLE_LABELS[code] ?? code;

  return (
    <Card title="Organization staff" description="Invite individual staff accounts for your institute and assign the approved staff roles. A Super Admin activates each account after identity verification.">
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
        {!data.verification.available && <li>{data.verification.reason}</li>}
        {!data.customRoles.available && <li>{data.customRoles.reason}</li>}
        {!data.suspensionAndRemoval.available && <li>{data.suspensionAndRemoval.reason}</li>}
      </ul>
      {notice && <p role="status" className="mb-4 rounded-lg bg-slate-100 p-3 text-sm">{notice}</p>}

      <form className="mb-6 grid gap-4 rounded-lg border border-slate-200 p-4 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={(event) => void sendInvitation(event)}>
        <TextField label="Staff ID" required disabled={!data.invitationsAvailable} value={invite.staffId} onChange={(e) => setInvite({ ...invite, staffId: e.target.value })} autoComplete="off" />
        <TextField label="Full name" required disabled={!data.invitationsAvailable} value={invite.displayName} onChange={(e) => setInvite({ ...invite, displayName: e.target.value })} autoComplete="off" />
        <Button type="submit" disabled={!data.invitationsAvailable} loading={busy}>Create invitation</Button>
        {!data.invitationsAvailable && <p className="text-sm text-amber-900 md:col-span-3">{data.invitationsUnavailableReason}</p>}
        {data.invitationsAvailable && data.invitationExpiryHours && <p className="text-xs text-slate-600 md:col-span-3">Invitation codes are shown once and expire {data.invitationExpiryHours} hours after they are created.</p>}
      </form>

      {issuedCode && (
        <div role="status" className="mb-6 rounded-lg border border-teal-300 bg-teal-50 p-4 text-sm">
          <p className="font-semibold">Invitation code for {issuedCode.staffId}. It is shown only once.</p>
          <p className="mt-2 break-all rounded bg-white p-2 font-mono">{issuedCode.code}</p>
          <p className="mt-2 text-teal-900">Give it to the staff member privately. They will also need your institute ID and their Staff ID.</p>
          <Button className="mt-3" size="sm" variant="secondary" onClick={() => setIssuedCode(null)}>I have recorded the code</Button>
        </div>
      )}

      <DataTable
        caption="Organization staff members"
        captionHidden
        rows={data.members}
        rowKey={(row) => row.id}
        emptyTitle="No staff invited yet"
        columns={[
          { key: 'staff', header: 'Staff', isRowHeader: true, render: (row) => <span>{row.displayName} <span className="font-mono text-xs text-slate-500">{row.staffId}</span></span> },
          { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status === 'active' ? 'approved' : 'pending'} label={row.status === 'active' ? 'Active' : row.accepted ? 'Accepted · awaiting verification' : `Invited (${row.invitation.state})`} /> },
          { key: 'roles', header: 'Roles', render: (row) => (row.roles.length ? row.roles.map(label).join(', ') : '—') },
          { key: 'action', header: 'Action', render: (row) => <Button size="sm" variant="secondary" onClick={() => setEditing({ id: row.id, roles: row.roles })}>Roles</Button> },
        ]}
      />

      {editing && (
        <form className="mt-4 space-y-2 rounded-lg border border-slate-200 p-4" onSubmit={(event) => void saveRoles(event)}>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Approved staff roles (Q117)</legend>
            {data.roleTemplates.map((template) => (
              <Checkbox
                key={template.code}
                label={`${template.label} — ${template.description}`}
                checked={editing.roles.includes(template.code)}
                onChange={(e) => setEditing({ ...editing, roles: e.target.checked ? [...editing.roles, template.code] : editing.roles.filter((code) => code !== template.code) })}
              />
            ))}
          </fieldset>
          <p className="text-xs text-slate-500">Roles describe responsibilities. They grant no module access until the permission catalogue (D-08) is approved.</p>
          <div className="flex gap-2"><Button type="submit" size="sm" loading={busy}>Save roles</Button><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
        </form>
      )}
    </Card>
  );
};
