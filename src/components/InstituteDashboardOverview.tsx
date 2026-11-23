import React, { useMemo } from 'react';
import {
  ArrowRight,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FileText,
  Plus,
  UserCheck,
  Wallet,
} from 'lucide-react';
import { useLanguage } from '../utils/languageContext';
import { LANGUAGE_LOCALES } from '../utils/languageLogic';
import {
  buildInstituteDashboardStats,
  CHECKIN_STATUSES,
  rowTime,
  type CheckinStatus,
  type DashboardRow,
  type SectionState,
} from '../utils/instituteDashboard';

interface InstituteDashboardOverviewProps {
  centerCode: string;
  forms: DashboardRow[];
  checkins: DashboardRow[];
  /** `dashboardSummary` from /api/center/workspace: exact counts over every record. */
  summary: unknown;
  workspaceState: SectionState;
  checkinsState: SectionState;
  availableBalance: string;
  onOpenForms: () => void;
  onVerifyCandidate: () => void;
  onOpenProfile: () => void;
  onOpenWallet: () => void;
}

const UNKNOWN = '—';

const readText = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const statusStyle = (status: string): string => {
  if (status === 'approved' || status === 'verified' || status === 'admitted') return 'bg-emerald-50 text-emerald-800';
  if (status === 'rejected' || status === 'flagged') return 'bg-rose-50 text-rose-800';
  return 'bg-amber-50 text-amber-800';
};

const CHECKIN_STATUS_DISPLAY: Record<CheckinStatus, { label: string; color: string }> = {
  verified: { label: 'Identity verified', color: '#16A34A' },
  admitted: { label: 'Admitted', color: '#2563EB' },
  flagged: { label: 'Flagged for review', color: '#F59E0B' },
  rejected: { label: 'Entry denied', color: '#EF4444' },
};

const FORM_STATUS_LABELS: Record<string, string> = {
  approved: 'Approved',
  pending: 'Pending',
  rejected: 'Rejected',
};

export const InstituteDashboardOverview: React.FC<InstituteDashboardOverviewProps> = ({
  centerCode,
  forms,
  checkins,
  summary,
  workspaceState,
  checkinsState,
  availableBalance,
  onOpenForms,
  onVerifyCandidate,
  onOpenProfile,
  onOpenWallet,
}) => {
  const { t, language } = useLanguage();
  const locale = LANGUAGE_LOCALES[language];
  const formatDate = (time: number) => new Date(time).toLocaleDateString(locale);
  const formatDateTime = (time: number) => new Date(time).toLocaleString(locale);

  const stats = useMemo(
    () => buildInstituteDashboardStats({ summary, forms, checkins, workspaceState, checkinsState }),
    [summary, forms, checkins, workspaceState, checkinsState],
  );
  const formsKnown = workspaceState === 'success';
  const checkinsListKnown = checkinsState === 'success';
  const sectionMessage = (state: SectionState, failedText: string) =>
    (state === 'error' ? t(failedText) : t('Loading…'));

  const checkinStatusLabel = (status: string) =>
    (status in CHECKIN_STATUS_DISPLAY ? t(CHECKIN_STATUS_DISPLAY[status as CheckinStatus].label) : status);
  const formStatusLabel = (status: string) => (FORM_STATUS_LABELS[status] ? t(FORM_STATUS_LABELS[status]) : status);

  const recentForms = useMemo(
    () => (formsKnown ? [...forms].sort((left, right) => rowTime(right) - rowTime(left)).slice(0, 5) : []),
    [forms, formsKnown],
  );
  const activity = useMemo(() => [
    ...(formsKnown ? forms.map((row) => ({ kind: 'form' as const, row, time: rowTime(row) })) : []),
    ...(checkinsListKnown ? checkins.map((row) => ({ kind: 'checkin' as const, row, time: rowTime(row) })) : []),
  ].sort((left, right) => right.time - left.time).slice(0, 4), [forms, checkins, formsKnown, checkinsListKnown]);
  const activityLoading = activity.length === 0 && (workspaceState === 'loading' || checkinsState === 'loading');

  const statusRows = CHECKIN_STATUSES.map((key) => ({
    key,
    ...CHECKIN_STATUS_DISPLAY[key],
    count: stats.checkins?.statuses[key] ?? null,
  }));
  const statusTotal = stats.checkins
    ? CHECKIN_STATUSES.reduce((sum, key) => sum + stats.checkins!.statuses[key], 0)
    : null;
  let statusProgress = 0;
  const statusStops = statusRows.map((row) => {
    const from = statusProgress;
    statusProgress += statusTotal ? ((row.count ?? 0) / statusTotal) * 100 : 0;
    return `${row.color} ${from}% ${statusProgress}%`;
  }).join(', ');
  const donutStyle = {
    background: statusTotal ? `conic-gradient(${statusStops})` : 'conic-gradient(#E2E8F0 0% 100%)',
  };

  const monthLabel = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short' });
  const monthSeries = (stats.checkins?.months ?? []).map((month) => {
    const [year, monthNumber] = month.key.split('-').map(Number);
    return { ...month, label: monthLabel.format(new Date(Date.UTC(year, monthNumber - 1, 1))) };
  });
  const maxMonth = Math.max(1, ...monthSeries.map((month) => month.value));
  const points = monthSeries.map((month, index) => ({
    ...month,
    x: 34 + index * 104,
    y: 170 - (month.value / maxMonth) * 125,
  }));
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1]?.x ?? 554} 180 L ${points[0]?.x ?? 34} 180 Z`;

  const metrics = [
    { label: 'Published forms', value: stats.forms ? String(stats.forms.approved) : UNKNOWN, icon: FileText, iconStyle: 'bg-blue-100 text-blue-700', note: t('Approved by Super Admin') },
    { label: 'Forms under review', value: stats.forms ? String(stats.forms.pending) : UNKNOWN, icon: CalendarDays, iconStyle: 'bg-amber-100 text-amber-700', note: t('Awaiting Super Admin review') },
    { label: 'Candidate check-ins', value: stats.checkins ? String(stats.checkins.total) : UNKNOWN, icon: UserCheck, iconStyle: 'bg-emerald-100 text-emerald-700', note: t('Center {code}').replace('{code}', centerCode) },
    { label: 'Wallet available', value: availableBalance, icon: Wallet, iconStyle: 'bg-violet-100 text-violet-700', note: t('Available for withdrawal request') },
  ];

  return (
    <section id="institute-overview" className="scroll-mt-28 space-y-5" aria-labelledby="institute-dashboard-title">
      {/* The page title above already greets the institute and holds the main actions. */}
      <h2 id="institute-dashboard-title" className="sr-only">{t('Institute overview')}</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <article key={metric.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-600">{t(metric.label)}</p>
                  <p className="mt-2 truncate text-2xl font-black tracking-tight text-[#0B2E59]">{metric.value}</p>
                  <p className="mt-2 text-xs text-slate-500">{metric.note}</p>
                </div>
                <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${metric.iconStyle}`}><Icon className="h-6 w-6" /></span>
              </div>
            </article>
          );
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><BarChart3 className="h-5 w-5 text-blue-700" /> {t('Check-in activity')}</h2>
              <p className="mt-1 text-sm text-slate-500">{t('Check-in records last updated by month over the last six months')}</p>
            </div>
            <span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">{t('Recent 6 months')}</span>
          </div>
          <div className="mt-5 overflow-hidden">
            {stats.checkins ? (
              <>
                <svg viewBox="0 0 600 220" role="img" aria-label={t('Monthly candidate check-in counts')} className="h-56 w-full">
                  {[35, 80, 125, 170].map((y) => <line key={y} x1="34" y1={y} x2="554" y2={y} stroke="#E2E8F0" strokeDasharray="4 5" />)}
                  <path d={areaPath} fill="url(#institute-chart-fill)" />
                  <path d={linePath} fill="none" stroke="#2563EB" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                  <defs><linearGradient id="institute-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#2563EB" stopOpacity="0.18" /><stop offset="100%" stopColor="#2563EB" stopOpacity="0.01" /></linearGradient></defs>
                  {points.map((point) => <g key={point.key}><circle cx={point.x} cy={point.y} r="5" fill="white" stroke="#2563EB" strokeWidth="3" /><text x={point.x} y="205" textAnchor="middle" fill="#64748B" fontSize="12">{point.label}</text><text x={point.x} y={point.y - 12} textAnchor="middle" fill="#334155" fontSize="11" fontWeight="700">{point.value}</text></g>)}
                </svg>
                {stats.checkins.total === 0 && <p className="-mt-2 text-center text-xs text-slate-500">{t('No check-ins have been recorded yet.')}</p>}
              </>
            ) : (
              <p role={checkinsState === 'error' ? 'alert' : 'status'} className="grid h-56 place-items-center rounded-xl bg-slate-50 text-sm text-slate-600">{sectionMessage(checkinsState, 'Check-ins could not be loaded.')}</p>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-600"><span className="h-2.5 w-2.5 rounded-full bg-blue-600" />{t('Recorded check-ins')}</div>
        </section>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><CheckCircle2 className="h-5 w-5 text-emerald-700" /> {t('Check-in status')}</h2>
            <p className="mt-1 text-sm text-slate-500">{t('Status of all check-ins recorded at your center')}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-5 sm:justify-start xl:justify-center">
              <div className="relative h-36 w-36 shrink-0 rounded-full" style={donutStyle} role="img" aria-label={statusTotal === null ? t('Check-in status is not available') : t('{count} check-in records by status').replace('{count}', String(statusTotal))}>
                <div className="absolute inset-4 grid place-content-center rounded-full bg-white text-center"><strong className="text-2xl font-black text-[#0B2E59]">{statusTotal ?? UNKNOWN}</strong><span className="text-xs text-slate-500">{t('records')}</span></div>
              </div>
              <ul className="space-y-2.5">
                {statusRows.map((row) => <li key={row.key} className="flex items-center gap-2 text-xs text-slate-700"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: row.color }} /><span>{t(row.label)}</span><strong className="ml-auto pl-2">{row.count ?? UNKNOWN}</strong></li>)}
              </ul>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><Plus className="h-5 w-5 text-blue-700" /> {t('Quick actions')}</h2>
            <div className="mt-4 grid gap-2">
              <button type="button" onClick={onOpenForms} className="flex items-center justify-between rounded-xl bg-emerald-50 px-3 py-3 text-left text-sm font-bold text-emerald-950 hover:bg-emerald-100"><span className="flex items-center gap-3"><Plus className="h-5 w-5 text-emerald-700" />{t('Create institute form')}</span><ArrowRight className="h-4 w-4" /></button>
              <button type="button" onClick={onVerifyCandidate} className="flex items-center justify-between rounded-xl bg-blue-50 px-3 py-3 text-left text-sm font-bold text-blue-950 hover:bg-blue-100"><span className="flex items-center gap-3"><UserCheck className="h-5 w-5 text-blue-700" />{t('Verify candidate')}</span><ArrowRight className="h-4 w-4" /></button>
              <button type="button" onClick={onOpenProfile} className="flex items-center justify-between rounded-xl bg-violet-50 px-3 py-3 text-left text-sm font-bold text-violet-950 hover:bg-violet-100"><span className="flex items-center gap-3"><Building2 className="h-5 w-5 text-violet-700" />{t('Update institute profile')}</span><ArrowRight className="h-4 w-4" /></button>
              <button type="button" onClick={onOpenWallet} className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-3 text-left text-sm font-bold text-amber-950 hover:bg-amber-100"><span className="flex items-center gap-3"><Wallet className="h-5 w-5 text-amber-700" />{t('Open wallet')}</span><ArrowRight className="h-4 w-4" /></button>
            </div>
          </section>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)]">
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
            <div><h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><CalendarDays className="h-5 w-5 text-blue-700" /> {t('Recent institute forms')}</h2><p className="mt-1 text-sm text-slate-500">{t('Review publication status and submitted listings')}</p></div>
            <button type="button" onClick={onOpenForms} className="inline-flex items-center gap-1 text-sm font-bold text-blue-800 hover:underline">{t('View all')} <ArrowRight className="h-4 w-4" /></button>
          </div>
          {!formsKnown ? (
            <p role={workspaceState === 'error' ? 'alert' : 'status'} className="p-6 text-sm text-slate-600">{sectionMessage(workspaceState, 'Institute forms could not be loaded.')}</p>
          ) : recentForms.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">{t('Form')}</th><th className="px-4 py-3">{t('Submitted')}</th><th className="px-4 py-3">{t('Status')}</th><th className="px-5 py-3">{t('Action')}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{recentForms.map((form) => {
                  const status = readText(form.status, 'pending').toLowerCase();
                  const time = rowTime(form);
                  const submitted = time ? formatDate(time) : UNKNOWN;
                  return <tr key={readText(form.id, `${readText(form.title)}-${submitted}`)}><td className="px-5 py-4"><strong className="block text-slate-900">{readText(form.title, t('Institute form'))}</strong><span className="mt-1 block text-xs text-slate-500">{t(readText(form.form_type) === 'teacher_recruitment' ? 'Teacher recruitment' : 'Exam application')}</span></td><td className="px-4 py-4 text-slate-600">{submitted}</td><td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${statusStyle(status)}`}>{formStatusLabel(status)}</span></td><td className="px-5 py-4"><button type="button" onClick={onOpenForms} className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-bold text-blue-800 hover:bg-blue-50">{t('Manage')}</button></td></tr>;
                })}</tbody>
              </table>
            </div>
          ) : <p className="p-6 text-sm text-slate-600">{t('No institute forms have been submitted yet.')}</p>}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><Clock3 className="h-5 w-5 text-blue-700" /> {t('Latest updates')}</h2><p className="mt-1 text-sm text-slate-500">{t('Recent activity in your institute portal')}</p></div><span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-800">{activity.length}</span></div>
          {activity.length ? <ul className="mt-4 divide-y divide-slate-100">{activity.map((entry, index) => {
            const detail = entry.kind === 'form'
              ? `${readText(entry.row.title, t('Institute form'))} · ${formStatusLabel(readText(entry.row.status, 'pending').toLowerCase())}`
              : `${readText(entry.row.exam_code, t('Candidate check-in'))} · ${checkinStatusLabel(readText(entry.row.status).toLowerCase())}`;
            return <li key={`${entry.kind}-${readText(entry.row.id, String(index))}`} className="flex gap-3 py-3"><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${entry.kind === 'form' ? 'bg-violet-600' : 'bg-emerald-600'}`} /><div className="min-w-0"><p className="text-sm font-semibold text-slate-800">{t(entry.kind === 'form' ? 'Institute form updated' : 'Candidate check-in saved')}</p><p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p><p className="mt-1 text-[11px] text-slate-400">{entry.time ? formatDateTime(entry.time) : t('Date unavailable')}</p></div></li>;
          })}</ul> : <p role={activityLoading ? 'status' : undefined} className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{activityLoading ? t('Loading…') : t('New form submissions and saved check-ins will appear here.')}</p>}
          <div className="mt-3 rounded-xl bg-[#F3F6FB] p-3 text-xs leading-5 text-slate-600">{t('Candidate applications are completed through the institute’s external application process.')}</div>
        </section>
      </div>
    </section>
  );
};
