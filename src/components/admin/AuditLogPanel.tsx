// A-12: Super Admin tab — the platform audit log (read-only). The server decides who may read
// (Super Admin only), validates every filter and records each search; this panel never filters or
// hides records on its own.
import React, { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../api';
import { Button, Card, DataTable, ErrorState, SelectField, StatusBadge, TextField } from '../ui';
import { auditSearchParams, initialAuditFilters as initialFilters, type AuditFilters as Filters } from '../../utils/auditLogSearch';

interface AuditEventView {
  id: string;
  occurredAt: string;
  category: string;
  action: string;
  outcome: 'succeeded' | 'denied' | 'failed';
  reasonCode: string | null;
  actor: { type: string; userId: string | null; role: string | null; name: string | null; loginId: string | null };
  organization: { id: string; name: string | null } | null;
  resource: { type: string; id: string | null };
  metadata: Record<string, unknown>;
}
interface AuditPage {
  events: AuditEventView[];
  range: { from: string; to: string };
  nextCursor: string | null;
  filters: { categories: string[]; actions: string[] };
}
const humanize = (value: string) => value.replace(/[._]/g, ' ');
const formatTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });
const formatValue = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value));

export const AuditLogPanel: React.FC = () => {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [applied, setApplied] = useState<Filters>(filters);
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [options, setOptions] = useState<AuditPage['filters']>({ categories: [], actions: [] });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (search: Filters, cursor: string | null) => {
    if (cursor) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const page = await apiRequest<AuditPage>(`/api/admin/audit-events?${auditSearchParams(search, cursor).toString()}`);
      setEvents((current) => (cursor ? [...current, ...page.events] : page.events));
      setNextCursor(page.nextCursor);
      setOptions(page.filters);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audit log could not be loaded.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { void load(applied, null); }, [applied, load]);

  const set = (key: keyof Filters) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters({ ...filters, [key]: event.target.value });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setApplied({ ...filters });
  };

  return (
    <div className="space-y-5">
      <Card
        title="Audit log"
        headingLevel={3}
        description="Append-only record of administrative, institute, publishing and payment actions. Visible to Super Admins only; every search is itself recorded. Passwords, codes, tokens and contact details are never stored."
      >
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Audit log filters">
          <TextField label="From" type="date" value={filters.from} onChange={set('from')} required max={filters.to || undefined} />
          <TextField label="To" type="date" value={filters.to} onChange={set('to')} required min={filters.from || undefined} hint="At most 93 days." />
          <SelectField label="Category" value={filters.category} onChange={set('category')} placeholder="All categories" options={options.categories.map((value) => ({ value, label: humanize(value) }))} />
          <SelectField label="Action" value={filters.action} onChange={set('action')} placeholder="All actions" options={options.actions.map((value) => ({ value, label: value }))} />
          <SelectField label="Outcome" value={filters.outcome} onChange={set('outcome')} placeholder="All outcomes" options={[{ value: 'succeeded', label: 'Succeeded' }, { value: 'denied', label: 'Denied' }, { value: 'failed', label: 'Failed' }]} />
          <TextField label="Institution ID" value={filters.organizationId} onChange={set('organizationId')} maxLength={200} />
          <TextField label="Actor account ID" value={filters.actorUserId} onChange={set('actorUserId')} maxLength={200} />
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm" loading={loading}>Search</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { const reset = initialFilters(); setFilters(reset); setApplied(reset); }}>Reset</Button>
          </div>
        </form>
      </Card>

      {error ? <ErrorState description={error} onRetry={() => void load(applied, null)} /> : (
        <Card padded={false}>
          <DataTable
            caption="Audit events, newest first"
            captionHidden
            rows={events}
            rowKey={(row) => row.id}
            loading={loading}
            loadingLabel="Loading audit events…"
            emptyTitle="No audit events"
            emptyDescription="Nothing was recorded for these filters and dates."
            columns={[
              { key: 'time', header: 'Time', render: (row) => <time dateTime={row.occurredAt} className="whitespace-nowrap">{formatTime(row.occurredAt)}</time> },
              { key: 'action', header: 'Action', isRowHeader: true, render: (row) => (
                <div>
                  <div className="font-semibold text-slate-900">{row.action}</div>
                  <div className="text-xs text-slate-500">{humanize(row.category)}</div>
                </div>
              ) },
              { key: 'outcome', header: 'Outcome', render: (row) => (
                <StatusBadge status={row.outcome === 'succeeded' ? 'approved' : 'rejected'} label={row.reasonCode ? `${row.outcome}: ${humanize(row.reasonCode)}` : row.outcome} />
              ) },
              { key: 'actor', header: 'Actor', render: (row) => (
                <div>
                  <div>{row.actor.userId ? (row.actor.name ?? 'Unknown account') : humanize(row.actor.type)}</div>
                  <div className="text-xs text-slate-500">{[row.actor.role ? humanize(row.actor.role) : null, row.actor.loginId].filter(Boolean).join(' · ')}</div>
                </div>
              ) },
              { key: 'institution', header: 'Institution', render: (row) => (row.organization ? (row.organization.name ?? row.organization.id) : '—') },
              { key: 'resource', header: 'Record', render: (row) => (
                <div className="max-w-[14rem] break-all text-xs">{humanize(row.resource.type)}{row.resource.id ? `: ${row.resource.id}` : ''}</div>
              ) },
              { key: 'details', header: 'Details', render: (row) => {
                const entries = Object.entries(row.metadata);
                return entries.length ? (
                  <dl className="max-w-xs space-y-0.5 text-xs">
                    {entries.map(([key, value]) => (
                      <div key={key} className="flex gap-1"><dt className="text-slate-500">{humanize(key)}:</dt><dd className="break-words text-slate-800">{formatValue(value)}</dd></div>
                    ))}
                  </dl>
                ) : '—';
              } },
            ]}
          />
          {nextCursor && !loading && (
            <div className="border-t border-slate-200 p-3 text-center">
              <Button type="button" size="sm" variant="secondary" loading={loadingMore} onClick={() => void load(applied, nextCursor)}>Load older events</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};
