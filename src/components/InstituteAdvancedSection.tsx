import React, { useMemo } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileText,
  MonitorPlay,
  ShieldCheck,
} from 'lucide-react';
import {
  buildInstituteDashboardStats,
  rowTime,
  type DashboardRow,
  type SectionState,
} from '../utils/instituteDashboard';

export type InstituteAdvancedSectionId =
  | 'institute-exam-management'
  | 'institute-applications'
  | 'institute-admit-cards'
  | 'institute-question-bank'
  | 'institute-cbt-center'
  | 'institute-results'
  | 'institute-reports'
  | 'institute-attendance'
  | 'institute-interviews'
  | 'institute-training';

interface InstituteAdvancedSectionProps {
  sectionId: InstituteAdvancedSectionId;
  centerCode: string;
  forms: DashboardRow[];
  checkins: DashboardRow[];
  summary: unknown;
  workspaceState: SectionState;
  checkinsState: SectionState;
  onCreateForm: () => void;
  onOpenCheckins: () => void;
}

const text = (value: unknown, fallback = '—'): string =>
  typeof value === 'string' && value.trim() ? value : fallback;

const statusTone = (value: unknown): string => {
  const status = text(value, 'pending').toLowerCase();
  if (status === 'approved' || status === 'verified' || status === 'admitted') return 'bg-emerald-50 text-emerald-800';
  if (status === 'rejected' || status === 'flagged') return 'bg-rose-50 text-rose-800';
  return 'bg-amber-50 text-amber-800';
};

const dateLabel = (value: unknown): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return '—';
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toLocaleDateString('en-IN') : '—';
};

const Card: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ children, className = '' }) => (
  <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 ${className}`}>
    {children}
  </section>
);

const StatusPill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700">{children}</span>
);

const moduleMessages: Record<Exclude<InstituteAdvancedSectionId, 'institute-exam-management' | 'institute-applications' | 'institute-cbt-center' | 'institute-reports' | 'institute-attendance'>, { title: string; description: string; icon: typeof FileText }> = {
  'institute-admit-cards': {
    title: 'Admit cards are managed by ELTNOY',
    description: 'Institute accounts cannot generate or edit admit cards. Once ELTNOY publishes a candidate admit card, the candidate can retrieve it through the public portal.',
    icon: FileText,
  },
  'institute-question-bank': {
    title: 'Question Bank is not enabled for institute accounts',
    description: 'Question authoring and answer-key access are restricted to the ELTNOY examination team in the current portal.',
    icon: ShieldCheck,
  },
  'institute-results': {
    title: 'Results are published by ELTNOY',
    description: 'This institute account does not have access to candidate scorecards or merit-list data. Candidates retrieve their own published results from the public portal.',
    icon: CheckCircle2,
  },
  'institute-interviews': {
    title: 'Online Interview is not enabled for institutes yet',
    description: 'Interview scheduling, panel rooms, and evaluation records are not connected to an institute API in this release.',
    icon: CalendarDays,
  },
  'institute-training': {
    title: 'Online Training is not enabled for institutes yet',
    description: 'Course publishing, learner progress, and training sessions are not connected to an institute API in this release.',
    icon: MonitorPlay,
  },
};

const Metric: React.FC<{ label: string; value: string | number; detail: string; icon: typeof FileText }> = ({ label, value, detail, icon: Icon }) => (
  <article className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-2xl font-black tracking-tight text-[#0B2E59]">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-700"><Icon className="h-5 w-5" /></span>
    </div>
  </article>
);

export const InstituteAdvancedSection: React.FC<InstituteAdvancedSectionProps> = ({
  sectionId,
  centerCode,
  forms,
  checkins,
  summary,
  workspaceState,
  checkinsState,
  onCreateForm,
  onOpenCheckins,
}) => {
  const stats = useMemo(() => buildInstituteDashboardStats({
    summary,
    forms,
    checkins,
    workspaceState,
    checkinsState,
  }), [summary, forms, checkins, workspaceState, checkinsState]);
  const recentCheckins = useMemo(
    () => [...checkins].sort((a, b) => rowTime(b) - rowTime(a)).slice(0, 100),
    [checkins],
  );

  if (sectionId === 'institute-exam-management') {
    const approved = forms.filter((row) => text(row.status, '').toLowerCase() === 'approved').length;
    const pending = forms.filter((row) => text(row.status, '').toLowerCase() === 'pending').length;
    const rejected = forms.filter((row) => text(row.status, '').toLowerCase() === 'rejected').length;
    return (
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Approved listings" value={workspaceState === 'success' ? approved : '—'} detail="Visible after review" icon={CheckCircle2} />
          <Metric label="Under review" value={workspaceState === 'success' ? pending : '—'} detail="Awaiting ELTNOY review" icon={CalendarDays} />
          <Metric label="Returned listings" value={workspaceState === 'success' ? rejected : '—'} detail="Review the submitted details" icon={FileText} />
        </div>
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-extrabold text-[#0B2E59]">Institute examination listings</h2><p className="mt-1 text-sm text-slate-600">Track the exam and recruitment listings your institute submitted for public review.</p></div>
            <button type="button" onClick={onCreateForm} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-600"><FileText className="h-4 w-4" /> Create listing</button>
          </div>
          {workspaceState === 'loading' ? <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading institute listings…</p>
            : workspaceState === 'error' ? <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Institute listings could not be loaded. Use Refresh and try again.</p>
              : forms.length ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Listing</th><th className="p-3">Type</th><th className="p-3">Submitted</th><th className="p-3">Review status</th></tr></thead><tbody className="divide-y divide-slate-100">{forms.map((row) => <tr key={text(row.id, `${text(row.title)}-${text(row.created_at)}`)}><td className="p-3 font-bold text-slate-900">{text(row.title)}</td><td className="p-3 text-slate-600">{row.form_type === 'teacher_recruitment' ? 'Teacher recruitment' : 'Exam application'}</td><td className="p-3 text-slate-600">{dateLabel(row.created_at)}</td><td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${statusTone(row.status)}`}>{text(row.status, 'pending')}</span></td></tr>)}</tbody></table></div>
                : <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No institute listings have been submitted yet.</p>}
          <p className="mt-4 rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-900">These are institute public listings, not ELTNOY’s exam schedule or exam-paper controls. ELTNOY approves each listing before publishing it.</p>
        </Card>
      </div>
    );
  }

  if (sectionId === 'institute-applications') {
    const publishedForms = forms.filter((row) => text(row.status, '').toLowerCase() === 'approved');
    return (
      <div className="space-y-5">
        <Card>
          <div className="flex items-start gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700"><ExternalLink className="h-5 w-5" /></span><div><h2 className="text-lg font-extrabold text-[#0B2E59]">Published application links</h2><p className="mt-1 text-sm leading-6 text-slate-600">ELTNOY displays your approved listing. Candidates complete applications on the external link or through the contact process your institute provides; candidate submissions are not stored in this institute portal.</p></div></div>
        </Card>
        {workspaceState === 'loading' ? <p role="status" className="rounded-xl bg-white p-5 text-sm text-slate-600">Loading published listings…</p>
          : workspaceState === 'error' ? <p role="alert" className="rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Published listings could not be loaded. Use Refresh and try again.</p>
            : publishedForms.length ? <div className="grid gap-4 xl:grid-cols-2">{publishedForms.map((row) => <Card key={text(row.id, `${text(row.title)}-${text(row.created_at)}`)} className="p-5"><div className="flex items-start justify-between gap-3"><div><StatusPill>Public</StatusPill><h3 className="mt-3 text-base font-extrabold text-[#0B2E59]">{text(row.title)}</h3><p className="mt-1 text-xs text-slate-500">{row.form_type === 'teacher_recruitment' ? 'Teacher recruitment' : 'Exam application'} · Deadline {dateLabel(row.application_deadline)}</p></div><ExternalLink className="mt-1 h-4 w-4 shrink-0 text-blue-700" /></div><p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-600">{text(row.description, 'No listing description provided.')}</p>{typeof row.external_url === 'string' && row.external_url ? <a href={row.external_url} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline">Open application link <ArrowRight className="h-4 w-4" /></a> : <p className="mt-4 text-xs text-amber-800">No external application link was supplied for this listing.</p>}</Card>)}</div>
              : <Card><p className="text-sm text-slate-600">No approved application listings are currently available.</p></Card>}
      </div>
    );
  }

  if (sectionId === 'institute-cbt-center') {
    return (
      <div className="grid gap-5 xl:grid-cols-[1.4fr_0.8fr]">
        <Card>
          <div className="flex items-start gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700"><MonitorPlay className="h-5 w-5" /></span><div><h2 className="text-lg font-extrabold text-[#0B2E59]">Center operations</h2><p className="mt-1 text-sm text-slate-600">Your assigned center code is <strong className="font-mono text-slate-900">{centerCode || '—'}</strong>.</p></div></div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Available now</p><p className="mt-2 font-extrabold text-emerald-950">Candidate check-in</p><p className="mt-1 text-sm leading-5 text-emerald-900">Verify the application number and date of birth for candidates assigned to this center, then record the entry status.</p></div><div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-amber-800">Not connected</p><p className="mt-2 font-extrabold text-amber-950">Live CBT monitoring</p><p className="mt-1 text-sm leading-5 text-amber-900">The institute portal does not expose live exam sessions, rooms, or proctor incident controls.</p></div></div>
          <button type="button" onClick={onOpenCheckins} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-800"><ClipboardCheck className="h-4 w-4" /> Open candidate check-in <ArrowRight className="h-4 w-4" /></button>
        </Card>
        <Card><h2 className="text-lg font-extrabold text-[#0B2E59]">Access boundary</h2><p className="mt-2 text-sm leading-6 text-slate-600">Only candidates whose admit card has this center code can be checked in. Exam session control and candidate answer data remain outside this institute workspace.</p><div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">If your center assignment is incorrect, contact ELTNOY support before exam day.</div></Card>
      </div>
    );
  }

  if (sectionId === 'institute-reports') {
    const metrics = [
      { label: 'Approved listings', value: stats.forms?.approved ?? '—', icon: CheckCircle2 },
      { label: 'Listings under review', value: stats.forms?.pending ?? '—', icon: FileText },
      { label: 'Recorded check-ins', value: stats.checkins?.total ?? '—', icon: ClipboardCheck },
    ];
    const monthValues = stats.checkins?.months ?? [];
    const max = Math.max(1, ...monthValues.map((month) => month.value));
    return (
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">{metrics.map((metric) => <Metric key={metric.label} label={metric.label} value={metric.value} detail="From institute workspace records" icon={metric.icon} />)}</div>
        <Card>
          <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><BarChart3 className="h-5 w-5 text-blue-700" /> Check-in trend</h2><p className="mt-1 text-sm text-slate-500">Recorded candidate check-ins by month, based on the institute workspace summary.</p></div><StatusPill>Live records</StatusPill></div>
          {workspaceState === 'loading' || checkinsState === 'loading' ? <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading report data…</p>
            : workspaceState === 'error' || checkinsState === 'error' ? <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Report data could not be loaded. Use Refresh and try again.</p>
              : <div className="mt-6 grid h-56 grid-cols-6 items-end gap-3 border-b border-slate-200 px-2">{monthValues.map((month) => <div key={month.key} className="flex h-full flex-col items-center justify-end gap-2"><span className="text-xs font-bold text-slate-700">{month.value}</span><div className="w-full max-w-14 rounded-t-md bg-blue-600" style={{ height: `${Math.max(month.value > 0 ? 8 : 2, (month.value / max) * 70)}%` }} /><span className="pb-2 text-[11px] text-slate-500">{new Date(`${month.key}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}</span></div>)}</div>}
          <p className="mt-4 text-xs leading-5 text-slate-500">Only institute listings and assigned-center check-ins are available here. Candidate application funnels, fee collections, and exported report workbooks are not provided by the current institute API.</p>
        </Card>
      </div>
    );
  }

  if (sectionId === 'institute-attendance') {
    return (
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><CalendarDays className="h-5 w-5 text-blue-700" /> Attendance register</h2><p className="mt-1 text-sm text-slate-500">Attendance entries recorded through your assigned center’s candidate check-in workflow.</p></div><button type="button" onClick={onOpenCheckins} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">Record check-in <ArrowRight className="h-4 w-4" /></button></div>
        {checkinsState === 'loading' ? <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading attendance records…</p>
          : checkinsState === 'error' ? <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">Attendance records could not be loaded. Use Refresh and try again.</p>
            : recentCheckins.length ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Candidate</th><th className="p-3">Application</th><th className="p-3">Exam</th><th className="p-3">Check-in time</th><th className="p-3">Attendance</th></tr></thead><tbody className="divide-y divide-slate-100">{recentCheckins.map((row, index) => <tr key={text(row.id, `${text(row.application_number)}-${index}`)}><td className="p-3 font-semibold text-slate-900">{text(row.candidate_name)}</td><td className="p-3 font-mono text-slate-600">{text(row.application_number)}</td><td className="p-3 text-slate-600">{text(row.exam_code)}</td><td className="p-3 text-slate-600">{dateLabel(row.checked_in_at ?? row.created_at)}</td><td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${statusTone(row.status)}`}>{text(row.status, 'unknown')}</span></td></tr>)}</tbody></table></div>
              : <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No candidate attendance has been recorded for this center.</p>}
      </Card>
    );
  }

  const module = moduleMessages[sectionId as keyof typeof moduleMessages];
  if (!module) return null;
  const Icon = module.icon;
  return (
    <div className="grid gap-5 xl:grid-cols-[1.4fr_0.8fr]">
      <Card>
        <div className="flex items-start gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-700"><Icon className="h-6 w-6" /></span><div><StatusPill>Unavailable to institute accounts</StatusPill><h2 className="mt-3 text-lg font-extrabold text-[#0B2E59]">{module.title}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{module.description}</p></div></div>
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0" /><p>This screen uses no sample applicants, payments, exam sessions, scores, or other demo figures. Only data backed by the institute API is shown in active sections.</p></div>
      </Card>
      <Card>
        <h2 className="text-lg font-extrabold text-[#0B2E59]">Current institute access</h2>
        <ul className="mt-4 space-y-3 text-sm text-slate-700"><li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />Institute profile and document review</li><li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />Exam and recruitment listings</li><li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />Institute wallet and withdrawal requests</li><li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />Assigned-center candidate check-ins</li></ul>
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">New capabilities require institute-scoped API permissions and data workflows before they can be activated here.</p>
      </Card>
    </div>
  );
};
