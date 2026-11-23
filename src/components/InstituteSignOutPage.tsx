import React from 'react';
import { Building2 } from 'lucide-react';

export type InstituteSignOutPageState = 'checking' | 'wrong_surface' | 'signed_out' | 'confirm';

interface InstituteSignOutPageProps {
  state: InstituteSignOutPageState;
  accountName?: string;
  marketingHome: string;
  onSignOut: () => void;
  onCancel: () => void;
}

export const InstituteSignOutPage: React.FC<InstituteSignOutPageProps> = ({
  state,
  accountName,
  marketingHome,
  onSignOut,
  onCancel,
}) => {
  if (state === 'checking') {
    return <main className="grid min-h-screen place-items-center bg-[#F5F7FB] p-6 text-sm text-slate-600">Checking Institute session…</main>;
  }

  if (state === 'wrong_surface') {
    return (
      <main className="grid min-h-screen place-items-center bg-[#F5F7FB] p-6">
        <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm">
          <h1 className="text-xl font-black text-[#0B2E59]">Institute sign-out unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">Open this sign-out link on the Institute website.</p>
          <a href={marketingHome} className="mt-5 inline-flex rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-bold text-white">Return to website</a>
        </section>
      </main>
    );
  }

  if (state === 'signed_out') {
    return (
      <main className="grid min-h-screen place-items-center bg-[#F5F7FB] p-6">
        <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-sky-100 text-sky-800"><Building2 className="h-6 w-6" /></span>
          <h1 className="mt-4 text-xl font-black text-[#0B2E59]">No active Institute session</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">This browser is not signed in to an Institute account. Sign in again if you need to open the dashboard.</p>
          <div className="mt-5 flex justify-center gap-3">
            <a href="/login/center" className="rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-bold text-white">Institute sign in</a>
            <a href={marketingHome} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700">Public website</a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#F5F7FB] p-6">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-sky-100 text-sky-800"><Building2 className="h-6 w-6" /></span>
        <h1 className="mt-4 text-xl font-black text-[#0B2E59]">Sign out of the Institute portal?</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">You are signed in as <strong>{accountName || 'Institute user'}</strong>. Confirm to end this Institute session and return to the public website.</p>
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" onClick={onSignOut} className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-700">Sign out</button>
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">Cancel</button>
        </div>
      </section>
    </main>
  );
};
