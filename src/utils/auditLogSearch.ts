// A-12: query building for the Super Admin audit-log viewer (src/components/admin/AuditLogPanel.tsx).
// The server validates every parameter again; this only shapes the request.

export interface AuditFilters { from: string; to: string; category: string; action: string; outcome: string; organizationId: string; actorUserId: string }

const DAY_MS = 24 * 60 * 60 * 1000;
const dateInput = (date: Date) => date.toISOString().slice(0, 10);

/** The last seven days (today included), no other filter. */
export const initialAuditFilters = (now = new Date()): AuditFilters => ({
  from: dateInput(new Date(now.getTime() - 6 * DAY_MS)), to: dateInput(now), category: '', action: '', outcome: '', organizationId: '', actorUserId: '',
});

/** Builds the query string. Dates are whole days in UTC; the end date is inclusive. */
export function auditSearchParams(filters: AuditFilters, cursor: string | null): URLSearchParams {
  const params = new URLSearchParams({ limit: '50' });
  if (filters.from) params.set('from', `${filters.from}T00:00:00Z`);
  if (filters.to) params.set('to', new Date(Date.parse(`${filters.to}T00:00:00Z`) + DAY_MS).toISOString());
  for (const key of ['category', 'action', 'outcome', 'organizationId', 'actorUserId'] as const) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  if (cursor) params.set('cursor', cursor);
  return params;
}
