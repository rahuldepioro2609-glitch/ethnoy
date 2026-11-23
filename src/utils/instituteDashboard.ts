export type DashboardRow = Record<string, unknown>;

export const CHECKIN_STATUSES = ['verified', 'admitted', 'flagged', 'rejected'] as const;
export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];

export interface InstituteDashboardSummary {
  totalCheckins: number;
  checkinStatuses: Record<CheckinStatus, number>;
  approvedForms: number;
  pendingForms: number;
  /** Check-in counts keyed by IST month, `YYYY-MM`. */
  monthlyCheckins: Map<string, number>;
}

export interface InstituteDashboardMonth {
  key: string;
  value: number;
}

/** Which data the overview can show; null means the number is not known (loading or failed). */
export interface InstituteDashboardStats {
  checkins: {
    total: number;
    statuses: Record<CheckinStatus, number>;
    months: InstituteDashboardMonth[];
  } | null;
  forms: { approved: number; pending: number } | null;
}

export type SectionState = 'loading' | 'success' | 'error';

const DASHBOARD_TIME_ZONE = 'Asia/Kolkata';
const MONTHS_SHOWN = 6;

/** Postgres sends count(*)::text; accept only whole, non-negative, safe numbers. */
function readCount(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the server's `dashboardSummary` (exact counts over every record, not the capped lists).
 * Returns null when it is missing or malformed so the caller can fall back to the lists.
 */
export function parseInstituteDashboardSummary(value: unknown): InstituteDashboardSummary | null {
  if (!isRecord(value) || !isRecord(value.checkinStatuses) || !Array.isArray(value.monthlyCheckins)) return null;
  const totalCheckins = readCount(value.totalCheckins);
  const approvedForms = readCount(value.approvedForms);
  const pendingForms = readCount(value.pendingForms);
  if (totalCheckins === null || approvedForms === null || pendingForms === null) return null;

  const rawStatuses = value.checkinStatuses;
  const checkinStatuses = {} as Record<CheckinStatus, number>;
  for (const status of CHECKIN_STATUSES) {
    const count = readCount(rawStatuses[status]);
    if (count === null) return null;
    checkinStatuses[status] = count;
  }

  const monthlyCheckins = new Map<string, number>();
  for (const entry of value.monthlyCheckins) {
    if (!isRecord(entry) || typeof entry.month !== 'string' || !/^\d{4}-\d{2}$/.test(entry.month)) return null;
    const count = readCount(entry.count);
    if (count === null) return null;
    monthlyCheckins.set(entry.month, count);
  }

  return { totalCheckins, checkinStatuses, approvedForms, pendingForms, monthlyCheckins };
}

export function rowTime(row: DashboardRow): number {
  const value = row.created_at ?? row.updated_at ?? row.checked_in_at;
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function istMonthKey(time: number): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TIME_ZONE, year: 'numeric', month: '2-digit',
  }).formatToParts(new Date(time));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return year && month ? `${year}-${month}` : null;
}

/** The last six IST months, oldest first, as `YYYY-MM` keys. */
export function recentMonthKeys(now: Date): string[] {
  const [year, month] = (istMonthKey(now.getTime()) ?? '1970-01').split('-').map(Number);
  return Array.from({ length: MONTHS_SHOWN }, (_, index) => {
    const date = new Date(Date.UTC(year, month - MONTHS_SHOWN + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function countByMonth(checkins: DashboardRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of checkins) {
    const time = rowTime(row);
    const key = time ? istMonthKey(time) : null;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/**
 * Overview numbers. The server summary is preferred because the check-in and form lists are
 * capped (500 and 200 rows). The lists are only a fallback for an older server without the summary.
 * A figure is null while its source is loading or after it failed, so the page never shows a
 * misleading zero.
 */
export function buildInstituteDashboardStats(input: {
  summary: unknown;
  forms: DashboardRow[];
  checkins: DashboardRow[];
  workspaceState: SectionState;
  checkinsState: SectionState;
  now?: Date;
}): InstituteDashboardStats {
  const monthKeys = recentMonthKeys(input.now ?? new Date());
  const summary = input.workspaceState === 'success' ? parseInstituteDashboardSummary(input.summary) : null;

  if (summary) {
    return {
      checkins: {
        total: summary.totalCheckins,
        statuses: summary.checkinStatuses,
        months: monthKeys.map((key) => ({ key, value: summary.monthlyCheckins.get(key) ?? 0 })),
      },
      forms: { approved: summary.approvedForms, pending: summary.pendingForms },
    };
  }

  let checkins: InstituteDashboardStats['checkins'] = null;
  if (input.checkinsState === 'success') {
    const statuses = Object.fromEntries(CHECKIN_STATUSES.map((status) => [status, 0])) as Record<CheckinStatus, number>;
    for (const row of input.checkins) {
      const status = textOf(row.status);
      if ((CHECKIN_STATUSES as readonly string[]).includes(status)) statuses[status as CheckinStatus] += 1;
    }
    const byMonth = countByMonth(input.checkins);
    checkins = {
      total: input.checkins.length,
      statuses,
      months: monthKeys.map((key) => ({ key, value: byMonth.get(key) ?? 0 })),
    };
  }

  const forms = input.workspaceState === 'success'
    ? {
        approved: input.forms.filter((form) => textOf(form.status) === 'approved').length,
        pending: input.forms.filter((form) => textOf(form.status) === 'pending').length,
      }
    : null;

  return { checkins, forms };
}
