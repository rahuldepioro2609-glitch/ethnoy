// SM-1: Super Admin tab — Platform Staff management and Organization Staff activation (Q115).
// Every action is authorized by the server (Super Admin only); this panel never decides access.
import React, { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../../api';
import { Button, Card, Checkbox, DataTable, EmptyState, ErrorState, LoadingState, SelectField, StatusBadge, TextField } from '../ui';

interface Account {
  id: string; staffId: string; displayName: string; status: 'active' | 'deactivated'; mustChangePassword: boolean;
  department: { id: string; name: string } | null; roles: Array<{ id: string; name: string }>; permissions: string[]; createdAt: string;
}
interface Department { id: string; name: string }
interface Role { id: string; name: string; description: string; permissions: string[] }
interface AuditEvent { id: string; occurredAt: string; actorKind: string; action: string; targetAccountId: string | null }
interface OrgMember { id: string; organizationName: string; organizationLoginId: string; staffId: string; displayName: string; accepted: boolean; verified: boolean }

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'The request could not be completed.');

export const PlatformStaffAdminPanel: React.FC = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalogueSize, setCatalogueSize] = useState(0);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [orgVerificationReason, setOrgVerificationReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [notInstalled, setNotInstalled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ staffId: '', displayName: '', initialPassword: '', departmentId: '' });
  const [departmentName, setDepartmentName] = useState('');
  const [roleForm, setRoleForm] = useState({ name: '', description: '' });
  const [editing, setEditing] = useState<{ id: string; departmentId: string; roleIds: string[] } | null>(null);
  const [deactivating, setDeactivating] = useState<{ id: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [accountData, departmentData, roleData, auditData, orgData] = await Promise.all([
        apiRequest<{ accounts: Account[] }>('/api/admin/platform-staff'),
        apiRequest<{ departments: Department[] }>('/api/admin/platform-staff/departments'),
        apiRequest<{ roles: Role[]; permissionCatalogue: unknown[] }>('/api/admin/platform-staff/roles'),
        apiRequest<{ events: AuditEvent[] }>('/api/admin/platform-staff/audit'),
        apiRequest<{ members: OrgMember[]; verification: { reason: string } }>('/api/admin/organization-staff'),
      ]);
      setAccounts(accountData.accounts);
      setDepartments(departmentData.departments);
      setRoles(roleData.roles);
      setCatalogueSize(roleData.permissionCatalogue.length);
      setAudit(auditData.events.slice(0, 50));
      setOrgMembers(orgData.members);
      setOrgVerificationReason(orgData.verification.reason);
      setNotInstalled(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) setNotInstalled(true);
      else setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setNotice(success);
      await load();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingState label="Loading staff management…" />;
  if (notInstalled) {
    return (
      <EmptyState
        title="Staff management is not installed yet"
        description="The reviewed staff migrations have not been applied to this database. Nothing can be created until they are approved and applied."
      />
    );
  }
  if (loadError) return <ErrorState description={loadError} onRetry={() => void load()} />;

  return (
    <div className="space-y-6">
      <Card title="Platform Staff" description="Staff accounts are created and managed only by Super Admins. Staff sign in separately at /login/platform-staff with their Staff ID.">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>Permissions: {catalogueSize === 0 ? 'none can be granted yet. The permission catalogue (D-08) is awaiting approval, so roles are named groups only.' : `${catalogueSize} catalogue permissions available.`}</li>
          <li>Work modules for staff are not delegated yet (A-01, A-08, A-17).</li>
          <li>Deactivation is immediate and ends every session. Reactivation is not available (not yet decided).</li>
        </ul>
        {notice && <p role="status" className="mt-4 rounded-lg bg-slate-100 p-3 text-sm text-slate-800">{notice}</p>}
      </Card>

      <Card title="Create a staff account" headingLevel={3} description="Give the initial password to the staff member securely. They must replace it at first sign-in.">
        <form
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await apiRequest('/api/admin/platform-staff', {
                method: 'POST',
                body: JSON.stringify({ staffId: form.staffId, displayName: form.displayName, initialPassword: form.initialPassword, departmentId: form.departmentId || null }),
              });
              setForm({ staffId: '', displayName: '', initialPassword: '', departmentId: '' });
            }, 'Staff account created.');
          }}
        >
          <TextField label="Staff ID" required value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })} hint="4–50 letters, digits, dots, underscores or hyphens." autoComplete="off" />
          <TextField label="Full name" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoComplete="off" />
          <TextField label="Initial password" required type="password" value={form.initialPassword} onChange={(e) => setForm({ ...form, initialPassword: e.target.value })} hint="At least 12 characters." autoComplete="new-password" />
          <SelectField label="Department" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} placeholder="No department" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
          <div className="md:col-span-2"><Button type="submit" loading={busy}>Create staff account</Button></div>
        </form>
      </Card>

      <Card title="Staff accounts" headingLevel={3}>
        <DataTable
          caption="Platform staff accounts"
          captionHidden
          rows={accounts}
          rowKey={(row) => row.id}
          emptyTitle="No staff accounts yet"
          columns={[
            { key: 'staffId', header: 'Staff ID', isRowHeader: true, render: (row) => <span className="font-mono">{row.staffId}</span> },
            { key: 'name', header: 'Name', render: (row) => row.displayName },
            { key: 'department', header: 'Department', render: (row) => row.department?.name ?? '—' },
            { key: 'roles', header: 'Roles', render: (row) => (row.roles.length ? row.roles.map((r) => r.name).join(', ') : '—') },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status === 'active' ? 'approved' : 'rejected'} label={row.status === 'active' ? (row.mustChangePassword ? 'Active (initial password)' : 'Active') : 'Deactivated'} /> },
            {
              key: 'actions', header: 'Actions', render: (row) => row.status === 'active' ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ id: row.id, departmentId: row.department?.id ?? '', roleIds: row.roles.map((r) => r.id) })}>Assignment</Button>
                  <Button size="sm" variant="danger" onClick={() => setDeactivating({ id: row.id, reason: '' })}>Deactivate</Button>
                </div>
              ) : <span className="text-xs text-slate-500">No actions</span>,
            },
          ]}
        />
        {editing && (
          <form
            className="mt-4 space-y-3 rounded-lg border border-slate-200 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await apiRequest(`/api/admin/platform-staff/${encodeURIComponent(editing.id)}/assignment`, { method: 'PUT', body: JSON.stringify({ departmentId: editing.departmentId || null, roleIds: editing.roleIds }) });
                setEditing(null);
              }, 'Assignment saved.');
            }}
          >
            <SelectField label="Department" value={editing.departmentId} onChange={(e) => setEditing({ ...editing, departmentId: e.target.value })} placeholder="No department" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Roles</legend>
              {roles.length === 0 && <p className="text-sm text-slate-500">No roles yet. Create one below.</p>}
              {roles.map((role) => (
                <Checkbox key={role.id} label={role.name} checked={editing.roleIds.includes(role.id)} onChange={(e) => setEditing({ ...editing, roleIds: e.target.checked ? [...editing.roleIds, role.id] : editing.roleIds.filter((id) => id !== role.id) })} />
              ))}
            </fieldset>
            <div className="flex gap-2"><Button type="submit" size="sm" loading={busy}>Save assignment</Button><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
          </form>
        )}
        {deactivating && (
          <form
            className="mt-4 space-y-3 rounded-lg border border-red-200 bg-red-50 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await apiRequest(`/api/admin/platform-staff/${encodeURIComponent(deactivating.id)}/deactivate`, { method: 'POST', body: JSON.stringify({ reason: deactivating.reason }) });
                setDeactivating(null);
              }, 'Account deactivated. All of its sessions have ended.');
            }}
          >
            <TextField label="Reason for deactivation" required value={deactivating.reason} onChange={(e) => setDeactivating({ ...deactivating, reason: e.target.value })} hint="At least 10 characters. Recorded in the audit log." />
            <p className="text-xs text-red-900">Deactivation cannot be undone from the portal: reactivation is not available.</p>
            <div className="flex gap-2"><Button type="submit" size="sm" variant="danger" loading={busy}>Deactivate account</Button><Button type="button" size="sm" variant="ghost" onClick={() => setDeactivating(null)}>Cancel</Button></div>
          </form>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Departments" headingLevel={3}>
          <ul className="mb-4 space-y-1 text-sm">{departments.length ? departments.map((d) => <li key={d.id}>{d.name}</li>) : <li className="text-slate-500">No departments yet.</li>}</ul>
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void act(async () => { await apiRequest('/api/admin/platform-staff/departments', { method: 'POST', body: JSON.stringify({ name: departmentName }) }); setDepartmentName(''); }, 'Department created.'); }}>
            <TextField label="New department" required value={departmentName} onChange={(e) => setDepartmentName(e.target.value)} />
            <Button type="submit" size="sm" loading={busy}>Add</Button>
          </form>
        </Card>
        <Card title="Roles" headingLevel={3} description="Named groups only until the permission catalogue (D-08) is approved.">
          <ul className="mb-4 space-y-1 text-sm">{roles.length ? roles.map((r) => <li key={r.id}><span className="font-semibold">{r.name}</span>{r.description ? ` — ${r.description}` : ''} <span className="text-slate-500">({r.permissions.length} permissions)</span></li>) : <li className="text-slate-500">No roles yet.</li>}</ul>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void act(async () => { await apiRequest('/api/admin/platform-staff/roles', { method: 'POST', body: JSON.stringify({ name: roleForm.name, description: roleForm.description || undefined }) }); setRoleForm({ name: '', description: '' }); }, 'Role created.'); }}>
            <TextField label="Role name" required value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })} />
            <TextField label="Description" value={roleForm.description} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })} />
            <Button type="submit" size="sm" loading={busy}>Add role</Button>
          </form>
        </Card>
      </div>

      <Card title="Organization Staff awaiting activation" headingLevel={3} description={`Q115: Super Admin activates each verified staff member. ${orgVerificationReason}`}>
        <DataTable
          caption="Organization staff awaiting activation"
          captionHidden
          rows={orgMembers}
          rowKey={(row) => row.id}
          emptyTitle="No invited organization staff"
          columns={[
            { key: 'org', header: 'Organization', isRowHeader: true, render: (row) => `${row.organizationName} (${row.organizationLoginId})` },
            { key: 'staff', header: 'Staff', render: (row) => `${row.displayName} · ${row.staffId}` },
            { key: 'accepted', header: 'Invitation', render: (row) => (row.accepted ? 'Accepted' : 'Not accepted') },
            { key: 'verified', header: 'Verification', render: (row) => <StatusBadge status={row.verified ? 'approved' : 'pending'} label={row.verified ? 'Verified' : 'Not verified'} /> },
            { key: 'action', header: 'Action', render: (row) => <Button size="sm" disabled={!row.verified || busy} title={row.verified ? undefined : 'Activation needs a completed verification'} onClick={() => void act(() => apiRequest(`/api/admin/organization-staff/${encodeURIComponent(row.id)}/activate`, { method: 'POST' }), 'Member activated.')}>Activate</Button> },
          ]}
        />
      </Card>

      <Card title="Recent staff audit events" headingLevel={3} description="Append-only. Visible to Super Admins only (A-12).">
        <DataTable
          caption="Recent platform staff audit events"
          captionHidden
          rows={audit}
          rowKey={(row) => row.id}
          emptyTitle="No events yet"
          columns={[
            { key: 'time', header: 'Time', isRowHeader: true, render: (row) => new Date(row.occurredAt).toLocaleString() },
            { key: 'actor', header: 'Actor', render: (row) => row.actorKind.replace('_', ' ') },
            { key: 'action', header: 'Action', render: (row) => <span className="font-mono text-xs">{row.action}</span> },
            { key: 'target', header: 'Account', render: (row) => accounts.find((a) => a.id === row.targetAccountId)?.staffId ?? '—' },
          ]}
        />
      </Card>
    </div>
  );
};
