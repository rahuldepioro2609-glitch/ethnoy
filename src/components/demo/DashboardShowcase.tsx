// Client-facing dashboard showcase at /demo. VIEW-ONLY PREVIEW WITH SYNTHETIC DATA.
//
// - Standalone: rendered by src/main.tsx instead of <App />, so no App effect runs (no /api request,
//   no session check). It imports nothing from the API client, auth or the real dashboards.
// - It never signs anyone in and does not touch the real /dashboard routes or their guards.
// - Every action is disabled; nothing is written or sent anywhere.
// - Visuals mirror the existing Student and Institute dashboards (RolePortal.tsx).
// - Public preview: Students and Institutes only. No Admin, Staff or Super Admin view is shown here;
//   those dashboards exist only on the private Admin surface.
import React, { useEffect, useState } from 'react';
import { Award, Building2, ClipboardCheck, Eye, FileText, Info, LogOut, RefreshCw, Users, Wallet } from 'lucide-react';
import { BrandLogo } from '../BrandLogo';
import { StatusBadge } from '../ui';
import { DEMO_LABEL, demoInstitute, demoStudent } from '../../data/demoFixtures';

export type DemoRole = 'candidate' | 'center';
const ROLES: Array<{ id: DemoRole; label: string }> = [
  { id: 'candidate', label: 'Student' },
  { id: 'center', label: 'Institute' },
];

const THEME: Record<DemoRole, { shell: string; header: string; eyebrow: string; eyebrowClass: string; title: string; description: string; portal: string }> = {
  candidate: { shell: 'bg-emerald-50/60', header: 'from-emerald-950 via-emerald-900 to-[#0B2E59]', eyebrow: 'Student workspace', eyebrowClass: 'text-emerald-800', title: 'Student Dashboard', description: 'Track your exam applications, admit card, results, and practice history.', portal: 'Candidate Portal' },
  center: { shell: 'bg-sky-50/60', header: 'from-sky-950 via-sky-900 to-[#0B2E59]', eyebrow: 'Institute workspace', eyebrowClass: 'text-sky-800', title: 'Institute Dashboard', description: 'Manage candidate check-ins, submit public form listings, request profile changes, and track wallet activity.', portal: 'Institute Portal' },
};

/** ?role=candidate|center (anything else, including any Admin role, falls back to Student). */
export function demoRoleFromSearch(search: string): DemoRole {
  const value = new URLSearchParams(search).get('role');
  return value === 'center' ? value : 'candidate';
}

const DEMO_ACTION_TITLE = 'Demo preview: actions are disabled and nothing is saved.';

/**
 * Dashboard action that would normally write data or open a real workflow: always disabled, visibly
 * labelled "Demo only", never submits or navigates. (The role switcher is NOT a DemoButton and stays active.)
 */
const DemoButton: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <button type="button" disabled aria-disabled="true" title={DEMO_ACTION_TITLE} className={`${className} inline-flex cursor-not-allowed items-center gap-1.5 opacity-70`}>
    {children}
    <span className="rounded bg-black/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">Demo only</span>
  </button>
);

const Card: React.FC<{ title: string; className?: string; children: React.ReactNode }> = ({ title, className = '', children }) => (
  <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
    <h2 className="text-lg font-extrabold text-[#0B2E59]">{title}</h2>
    {children}
  </section>
);

const Stats: React.FC<{ items: Array<{ label: string; value: string | number; icon: typeof FileText }> }> = ({ items }) => (
  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
    {items.map((item) => {
      const Icon = item.icon;
      return (
        <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-500">{item.label}</p><Icon className="h-5 w-5 text-emerald-700" /></div>
          <p className="mt-3 text-3xl font-black text-[#0B2E59]">{item.value}</p>
        </article>
      );
    })}
  </div>
);

const StudentPreview: React.FC = () => (
  <>
    <Stats items={[
      { label: 'Applications', value: demoStudent.stats.applications, icon: FileText },
      { label: 'Mock tests', value: demoStudent.stats.mockTests, icon: ClipboardCheck },
      { label: 'Published results', value: demoStudent.stats.publishedResults, icon: Award },
    ]} />
    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <Card title="My applications">
        <div className="mt-4 space-y-3">
          {demoStudent.applications.map((item) => (
            <article key={item.number} className="rounded-lg border border-slate-100 bg-slate-50 p-4">
              <div className="flex flex-wrap justify-between gap-2"><strong>{item.number}</strong><StatusBadge status={item.status === 'Approved' ? 'approved' : 'under_review'} label={item.status} /></div>
              <p className="mt-1 text-sm text-slate-600">{item.exam} · {item.code}</p>
              <p className="mt-1 text-xs text-slate-500">Admit card: {item.admitCard}</p>
            </article>
          ))}
        </div>
        <DemoButton className="mt-4 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white">Open admit card lookup</DemoButton>
      </Card>
      <Card title="My results and practice">
        <p className="mt-3 text-sm text-emerald-800">{demoStudent.results.count} result(s) published for this sample account.</p>
        <DemoButton className="mt-4 rounded-lg border border-emerald-700 px-4 py-2.5 text-sm font-bold text-emerald-800">Check official result</DemoButton>
        <h3 className="mt-6 font-bold text-slate-800">Practice test history</h3>
        <ul className="mt-3 space-y-2 text-sm text-slate-600">
          {demoStudent.practice.map((attempt) => <li key={attempt.id} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2"><span>{attempt.correct} correct of {attempt.total}</span><strong>{attempt.percentage}%</strong></li>)}
        </ul>
      </Card>
      <Card title="Online examinations" className="lg:col-span-2">
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {demoStudent.onlineExams.map((exam) => (
            <article key={exam.code} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <h3 className="font-bold text-slate-900">{exam.name}</h3>
              <p className="mt-1 text-xs text-slate-500">{exam.code} · {exam.questions} questions · {exam.minutes} minutes</p>
              <p className={`mt-2 text-sm ${exam.tone}`}>{exam.status}</p>
              <DemoButton className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white">Open exam</DemoButton>
            </article>
          ))}
        </div>
      </Card>
    </div>
  </>
);

const disabledInput = 'mt-1 w-full cursor-not-allowed rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-500';

const InstitutePreview: React.FC = () => (
  <>
    <Stats items={[
      { label: 'Recorded check-ins', value: demoInstitute.stats.checkins, icon: ClipboardCheck },
      { label: 'Center code', value: demoInstitute.id, icon: Building2 },
    ]} />
    <div className="mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      <Card title="Verify a candidate">
        <p className="mt-1 text-sm text-slate-500">Only candidates assigned to center <strong>{demoInstitute.id}</strong> can be checked in.</p>
        <label className="mt-4 block text-sm font-semibold text-slate-700">Application number<input disabled value="DEMO-APP-0101" readOnly className={disabledInput} /></label>
        <label className="mt-3 block text-sm font-semibold text-slate-700">Date of birth<input disabled value="Sample date" readOnly className={disabledInput} /></label>
        <label className="mt-3 block text-sm font-semibold text-slate-700">Check-in status<input disabled value="Identity verified" readOnly className={disabledInput} /></label>
        <DemoButton className="mt-4 inline-flex items-center gap-2 rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white"><ClipboardCheck className="h-4 w-4" /> Verify and save</DemoButton>
      </Card>
      <Card title="Recent check-ins">
        <div className="mt-4 space-y-2">
          {demoInstitute.checkins.map((item) => (
            <article key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span><strong>{item.application}</strong> · {item.candidate}</span>
              <StatusBadge status={item.status === 'Absent' ? 'rejected' : 'approved'} label={item.status} />
            </article>
          ))}
        </div>
      </Card>
    </div>
    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <Card title="Institute exam & teacher forms">
        <ul className="mt-4 space-y-2 text-sm">
          {demoInstitute.forms.map((form) => <li key={form.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"><span><strong>{form.title}</strong><span className="block text-xs text-slate-500">{form.kind}</span></span><StatusBadge status={form.status} /></li>)}
        </ul>
        <DemoButton className="mt-4 rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white">Submit a listing for review</DemoButton>
      </Card>
      <Card title="Wallet">
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-slate-50 p-3"><dt className="text-slate-500">Available</dt><dd className="mt-1 font-bold text-[#0B2E59]">{demoInstitute.wallet.available}</dd></div>
          <div className="rounded-lg bg-slate-50 p-3"><dt className="text-slate-500">Reserved</dt><dd className="mt-1 font-bold text-[#0B2E59]">{demoInstitute.wallet.reserved}</dd></div>
        </dl>
        <DemoButton className="mt-4 inline-flex items-center gap-2 rounded-lg border border-sky-700 px-4 py-2.5 text-sm font-bold text-sky-800"><Wallet className="h-4 w-4" /> Request withdrawal</DemoButton>
      </Card>
      <Card title="Organization staff" className="lg:col-span-2">
        <ul className="mt-4 grid gap-2 text-sm md:grid-cols-2">
          {demoInstitute.staff.map((member) => <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"><span><strong>{member.name}</strong><span className="block text-xs text-slate-500">{member.staffId} · {member.role}</span></span><StatusBadge status="pending" label={member.status} /></li>)}
        </ul>
        <DemoButton className="mt-4 inline-flex items-center gap-2 rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white"><Users className="h-4 w-4" /> Create invitation</DemoButton>
      </Card>
    </div>
  </>
);

export const DashboardShowcase: React.FC = () => {
  const [role, setRole] = useState<DemoRole>(() => demoRoleFromSearch(window.location.search));
  const theme = THEME[role];
  const person = role === 'candidate' ? demoStudent : demoInstitute;

  useEffect(() => { document.title = 'ELTNOY dashboard preview (sample data)'; }, []);

  const switchRole = (next: DemoRole) => {
    setRole(next);
    // Keeps the deep link shareable (/demo?role=…). Only the query string changes; no navigation.
    window.history.replaceState(null, '', `/demo?role=${next}`);
  };

  return (
    <div className={`min-h-screen text-slate-900 ${theme.shell}`}>
      {/* Persistent banner: stays visible while scrolling on every role. */}
      <div role="note" aria-label="Demo preview notice" className="sticky top-0 z-50 border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-sm font-bold text-amber-950 shadow-sm">
        <span className="mr-2 inline-flex rounded bg-amber-900 px-2 py-0.5 text-xs uppercase tracking-wider text-white">Demo</span>
        Sample data only. This is a view-only preview, not a real account. Nothing is signed in, loaded or saved. Switch roles freely; dashboard actions are disabled and marked "Demo only".
      </div>

      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Eye className="h-4 w-4 text-emerald-700" /> Dashboard preview: choose a role</p>
          <div role="tablist" aria-label="Preview role" className="flex flex-wrap gap-2">
            {ROLES.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={role === item.id} onClick={() => switchRole(item.id)} className={`rounded-lg px-4 py-2 text-sm font-bold ${role === item.id ? 'bg-[#0B2E59] text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
                {item.label}
              </button>
            ))}
          </div>
          <a href="/" className="text-sm font-semibold text-emerald-800 hover:underline">Back to website</a>
        </div>
      </div>

      <main>
        <header className={`bg-gradient-to-r ${theme.header} text-white shadow-md`}>
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <BrandLogo compact light />
              <div className="min-w-0"><p className="font-black tracking-wide">{theme.portal} <span className="ml-1 rounded bg-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">{DEMO_LABEL}</span></p><p className="truncate text-xs text-slate-300">{person.name} · {person.id}</p></div>
            </div>
            <div className="flex items-center gap-2">
              <DemoButton className="rounded-lg px-3 py-2 text-sm text-slate-200">Public website</DemoButton>
              {role !== 'candidate' && <DemoButton className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm font-bold text-white"><Wallet className="h-4 w-4" /> Wallet</DemoButton>}
              <DemoButton className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold"><LogOut className="h-4 w-4" /> Sign out</DemoButton>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-4 py-7 sm:px-6">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className={`text-xs font-bold uppercase tracking-[0.16em] ${theme.eyebrowClass}`}>{theme.eyebrow}</p>
              <h1 className="mt-1 text-2xl font-black text-[#0B2E59] sm:text-3xl">{theme.title}</h1>
              <p className="mt-1 text-sm text-slate-600">{theme.description}</p>
            </div>
            <DemoButton className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"><RefreshCw className="h-4 w-4" /> Refresh</DemoButton>
          </div>
          <p className="mb-5 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
            Every name, ID, number and amount on this page is invented sample data. Actions marked "Demo only" and the sample form fields are disabled; the real dashboards require a verified sign-in.
          </p>
          {role === 'candidate' ? <StudentPreview /> : <InstitutePreview />}
        </div>
      </main>
    </div>
  );
};
