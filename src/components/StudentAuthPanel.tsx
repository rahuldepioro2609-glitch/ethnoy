// AUTH-1: Student sign-in and account creation. Mobile number + password, then a code sent to that
// mobile (or to the Student's email while the server runs with AUTH_MOBILE_VERIFICATION=off);
// "Continue with Google" for accounts that linked Google (also ends with the mobile code).
// Every option stays visible. When the server reports a provider as unavailable the option is
// disabled with the reason;
// nothing here signs anyone in: only a server-started verification can lead to a session.
import React, { useEffect, useState } from 'react';
import { ArrowLeft, IdCard, Smartphone } from 'lucide-react';
import { ApiError, apiRequestWithMeta } from '../api';
import { useLanguage } from '../utils/languageContext';
import {
  emailOnlyVerification,
  isChallenge,
  studentGoogleSignInOption,
  studentGoogleSignUpOption,
  studentMobileOption,
  verificationMessage,
  type OptionState,
  type ProviderStatus,
  type VerificationChallengeView,
} from '../utils/authVerification';

type Mode = 'sign-in' | 'register' | 'existing-account';

interface StudentAuthPanelProps {
  providers: ProviderStatus | null;
  /** An error passed in by the page (for example a Google redirect notice). */
  initialError: string | null;
  buttonClass: string;
  onChallenge: (challenge: VerificationChallengeView) => void;
}

const inputClass = 'w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-60';

const Unavailable: React.FC<{ option: OptionState }> = ({ option }) => {
  const { t } = useLanguage();
  if (option.state !== 'unavailable') return null;
  return <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{t(option.reason)}</p>;
};

const GoogleOption: React.FC<{ option: OptionState; label: string; hint?: string }> = ({ option, label, hint }) => {
  const { t } = useLanguage();
  const content = <><span aria-hidden="true" className="font-black text-[#4285F4]">G</span> {t(label)}</>;
  return (
    <div className="space-y-2">
      {option.state === 'available' ? (
        <a href="/api/auth/google/start" className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-3 text-sm font-bold text-slate-800 hover:bg-slate-50">{content}</a>
      ) : (
        <button type="button" disabled aria-disabled="true" className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm font-bold text-slate-500">{content}</button>
      )}
      {option.state === 'available' && hint && <p className="text-xs text-slate-500">{t(hint)}</p>}
      <Unavailable option={option} />
    </div>
  );
};

export const StudentAuthPanel: React.FC<StudentAuthPanelProps> = ({ providers, initialError, buttonClass, onChallenge }) => {
  const { t } = useLanguage();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [mobile, setMobile] = useState('');
  const [studentId, setStudentId] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  // Page-level messages (Google redirect notices, a restarted verification) arrive after mount.
  useEffect(() => { if (initialError) setError(initialError); }, [initialError]);

  const mobileOption = studentMobileOption(providers);
  const canSubmit = mobileOption.state === 'available' && !busy;
  // AUTH_MOBILE_VERIFICATION=off: the code goes to the Student's email; the mobile stays the identifier.
  const emailOnly = emailOnlyVerification(providers);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setPassword('');
  };

  const send = async (path: string, body: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequestWithMeta<Record<string, unknown>>(path, { method: 'POST', body: JSON.stringify(body) });
      if (isChallenge(result.data)) {
        setPassword('');
        onChallenge(result.data);
        return;
      }
      setError(t('The server did not start a verification. Please try again.'));
    } catch (caught) {
      setError(caught instanceof ApiError ? verificationMessage(caught.code, caught.message) : t('The request could not be completed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (mode === 'register') {
      void send('/api/auth/register', emailOnly
        ? { name: fullName.trim(), mobile: mobile.trim(), email: email.trim(), password }
        : { name: fullName.trim(), mobile: mobile.trim(), password });
    } else if (mode === 'existing-account') {
      void send('/api/auth/login', { loginId: studentId.trim(), password, role: 'candidate' });
    } else void send('/api/auth/login', { mobile: mobile.trim(), password, role: 'candidate' });
  };

  const title = mode === 'register' ? 'Create student account' : mode === 'existing-account' ? 'Existing student sign-in' : 'Student sign-in';
  const subtitle = mode === 'register'
    ? emailOnly
      ? 'Use your mobile number to sign in. We send a one-time code to your email; your account works only after the code is confirmed.'
      : 'Use your mobile number. We send a one-time code to it; your account works only after the code is confirmed.'
    : mode === 'existing-account'
      ? emailOnly
        ? 'Enter your existing Student ID and password. Then complete the one-time email verification to finish signing in.'
        : 'Enter your existing Student ID and password. Then verify your mobile number with a one-time code to finish signing in.'
      : emailOnly
        ? 'Enter your mobile number and password. We then send a one-time code to your email to finish signing in.'
        : 'Enter your mobile number and password. We then send a one-time code to your mobile to finish signing in.';

  return (
    <>
      <a href="/login" className="mb-7 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-[#0B2E59]"><ArrowLeft className="h-3.5 w-3.5" /> {t('All login options')}</a>
      <h2 className="text-2xl font-extrabold text-[#0B2E59]">{t(title)}</h2>
      <p className="mt-1 text-sm text-slate-500">{t(subtitle)}</p>

      <form className="mt-6 space-y-4" onSubmit={submit}>
        {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
        <Unavailable option={mobileOption} />
        {mode === 'register' && (
          <div>
            <label htmlFor="student-name" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Student full name')}</label>
            <input id="student-name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} maxLength={120} disabled={mobileOption.state !== 'available'} className={inputClass} />
          </div>
        )}
        {mode === 'existing-account' ? (
          <div>
            <label htmlFor="student-id" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Student ID')}</label>
            <input id="student-id" type="text" autoComplete="username" value={studentId} onChange={(e) => setStudentId(e.target.value)} required maxLength={254} placeholder={t('Enter your existing Student ID')} disabled={mobileOption.state !== 'available'} className={inputClass} />
          </div>
        ) : (
          <div>
            <label htmlFor="student-mobile" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Mobile number')}</label>
            <input id="student-mobile" type="tel" inputMode="numeric" autoComplete="tel-national" value={mobile} onChange={(e) => setMobile(e.target.value)} required maxLength={16} placeholder="10-digit mobile number" disabled={mobileOption.state !== 'available'} className={inputClass} />
          </div>
        )}
        {mode === 'register' && emailOnly && (
          <div>
            <label htmlFor="student-email" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Email address')}</label>
            <input id="student-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} disabled={mobileOption.state !== 'available'} className={inputClass} />
            <p className="mt-1 text-xs text-slate-500">{t('Your one-time codes are sent to this email.')}</p>
          </div>
        )}
        <div>
          <label htmlFor="student-password" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Password')}</label>
          <input id="student-password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={mode === 'register' ? 12 : undefined} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} required disabled={mobileOption.state !== 'available'} className={inputClass} />
          {mode === 'register' && <p className="mt-1 text-xs text-slate-500">{t('Use at least 12 characters. Password recovery is not configured, so do not use a password you use elsewhere.')}</p>}
        </div>
        <button type="submit" disabled={!canSubmit} className={`flex w-full items-center justify-center gap-2 rounded-lg ${buttonClass} px-4 py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60`}>
          {mode === 'existing-account' ? <IdCard className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
          {t(busy ? 'Please wait…' : mode === 'register' ? 'Create account and send code' : 'Continue and send code')}
        </button>
      </form>

      {mode !== 'existing-account' && (
        <>
          <div className="my-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-slate-400"><span className="h-px flex-1 bg-slate-200" />{t('or')}<span className="h-px flex-1 bg-slate-200" /></div>
          {mode === 'register'
            ? <GoogleOption option={studentGoogleSignUpOption()} label="Sign up with Google" />
            : <GoogleOption option={studentGoogleSignInOption(providers)} label="Continue with Google" hint="For accounts that have linked Google. You will still confirm a code sent to your mobile." />}
        </>
      )}

      <div className="mt-6 space-y-3 text-center text-sm font-bold">
        {mode !== 'register' && <button type="button" onClick={() => switchMode('register')} className="w-full text-emerald-800 hover:underline">{t('New student? Create an account')}</button>}
        {mode === 'sign-in' && <button type="button" onClick={() => switchMode('existing-account')} className="w-full text-emerald-800 hover:underline">{t('Existing account? Sign in with Student ID')}</button>}
        {mode === 'register' && <button type="button" onClick={() => switchMode('sign-in')} className="w-full text-emerald-800 hover:underline">{t('Sign in with your mobile number')}</button>}
        {mode === 'existing-account' && <button type="button" onClick={() => switchMode('sign-in')} className="w-full text-emerald-800 hover:underline">{t('Use mobile number instead')}</button>}
      </div>
    </>
  );
};
