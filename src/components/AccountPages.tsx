import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, MailCheck, MailWarning } from 'lucide-react';
import { apiRequest } from '../api';
import { useTranslation } from '../i18n';
import { BrandLogo } from './BrandLogo';
import { GoogleSignInButton, useGoogleClientId } from './GoogleSignInButton';

/** Reads ?token= once, then removes it from the address bar so it is not kept in history. */
function useUrlToken(): string {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  useEffect(() => {
    if (window.location.search) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  return token;
}

const Shell: React.FC<{ onHome: () => void; children: React.ReactNode }> = ({ onHome, children }) => {
  const { t } = useTranslation();
  return (
    <main className="min-h-screen bg-[#eef5fa] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-2">
          <BrandLogo />
          <button onClick={onHome} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-[#0B2E59] hover:bg-emerald-50">
            <ArrowLeft className="h-4 w-4" /> {t('account.home')}
          </button>
        </div>
      </header>
      <div className="mx-auto max-w-md px-4 py-12">
        <div className="rounded-2xl bg-white p-7 shadow-xl sm:p-9">{children}</div>
      </div>
    </main>
  );
};

export const ResetPasswordPage: React.FC<{ onHome: () => void; onSignIn: (role: string) => void }> = ({ onHome, onSignIn }) => {
  const { t } = useTranslation();
  const token = useUrlToken();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ role: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError(t('account.passwordsDiffer'));
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await apiRequest<{ role: string }>('/api/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setDone({ role: result.role });
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : t('account.resetFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Shell onHome={onHome}>
      <div className="mb-6 inline-flex rounded-xl bg-emerald-100 p-3 text-emerald-800"><KeyRound className="h-7 w-7" /></div>
      <h1 className="text-2xl font-extrabold text-[#0B2E59]">{t('account.resetTitle')}</h1>
      {done ? (
        <div className="mt-4 space-y-5">
          <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {t('account.resetDone')}
          </p>
          <button onClick={() => onSignIn(done.role)} className="w-full rounded-lg bg-emerald-700 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-600">{t('account.goToSignIn')}</button>
        </div>
      ) : !token ? (
        <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{t('account.linkMissing')}</p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4">
          <p className="text-sm text-slate-600">{t('account.resetIntro')}</p>
          {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
          <div>
            <label htmlFor="new-password" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('account.newPassword')}</label>
            <div className="relative">
              <input id="new-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 pr-12 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
              <button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? t('account.hidePassword') : t('account.showPassword')} aria-pressed={visible} className="absolute inset-y-0 right-0 inline-flex items-center px-3 text-slate-500 hover:text-[#0B2E59]">
                {visible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">{t('account.passwordRule')}</p>
          </div>
          <div>
            <label htmlFor="confirm-password" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('account.confirmPassword')}</label>
            <input id="confirm-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={12} maxLength={128} value={confirm} onChange={(event) => setConfirm(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
          </div>
          <button type="submit" disabled={isSubmitting} className="w-full rounded-lg bg-emerald-700 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-60">
            {isSubmitting ? t('common.pleaseWait') : t('account.saveNewPassword')}
          </button>
        </form>
      )}
    </Shell>
  );
};

export const VerifyEmailPage: React.FC<{ onHome: () => void }> = ({ onHome }) => {
  const { t } = useTranslation();
  const token = useUrlToken();
  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
  const [message, setMessage] = useState<string | null>(token ? null : t('account.linkMissing'));
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    apiRequest('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => setState('done'))
      .catch((verifyError: unknown) => {
        setState('failed');
        setMessage(verifyError instanceof Error ? verifyError.message : t('account.verifyFailed'));
      });
  }, [t, token]);

  return (
    <Shell onHome={onHome}>
      <div className={`mb-6 inline-flex rounded-xl p-3 ${state === 'failed' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'}`}>
        {state === 'working' ? <Loader2 className="h-7 w-7 animate-spin" /> : state === 'done' ? <MailCheck className="h-7 w-7" /> : <MailWarning className="h-7 w-7" />}
      </div>
      <h1 className="text-2xl font-extrabold text-[#0B2E59]">{t('account.verifyTitle')}</h1>
      <p role={state === 'failed' ? 'alert' : 'status'} className="mt-3 text-sm text-slate-700">
        {state === 'working' ? t('account.verifying') : state === 'done' ? t('account.verifyDone') : message}
      </p>
      <button onClick={onHome} className="mt-6 w-full rounded-lg bg-[#0B2E59] px-4 py-3 text-sm font-bold text-white">{t('account.backToPortal')}</button>
    </Shell>
  );
};

interface AccountInfo {
  account: { loginId: string; name: string; role: string; email: string | null; emailVerified: boolean; googleEmail?: string | null; hasPassword?: boolean };
  emailEnabled: boolean;
}

/** Shows the account email with its verification state, and lets the user change it or resend the link. */
export const AccountEmailCard: React.FC = () => {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => apiRequest<AccountInfo>('/api/account').then(setInfo).catch(() => setInfo(null));
  useEffect(() => { void load(); }, []);

  if (!info) return null;
  const { account } = info;

  const saveEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiRequest<{ emailVerified: boolean }>('/api/account/email', {
        method: 'PUT',
        body: JSON.stringify({ email: email.trim(), currentPassword }),
      });
      setMessage(result.emailVerified ? t('account.emailSaved') : t('account.emailSavedVerify'));
      setEditing(false);
      setCurrentPassword('');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('account.emailSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<{ message: string }>('/api/account/email/verification', { method: 'POST' });
      setMessage(result.message);
    } catch (resendError) {
      setError(resendError instanceof Error ? resendError.message : t('account.resendFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-extrabold text-[#0B2E59]">{t('account.cardTitle')}</h2>
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-800">{error}</p>}
      {message && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-900">{message}</p>}
      {!editing ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{account.email ?? t('account.noEmail')}</p>
            {account.email && (
              <p className={`mt-0.5 text-xs font-bold ${account.emailVerified ? 'text-emerald-700' : 'text-amber-700'}`}>
                {account.emailVerified ? t('account.verified') : t('account.notVerified')}
              </p>
            )}
            {!account.email && <p className="mt-0.5 text-xs text-amber-700">{t('account.addEmailHint')}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {account.email && !account.emailVerified && info.emailEnabled && (
              <button type="button" disabled={busy} onClick={() => void resend()} className="rounded-lg border border-emerald-300 px-3 py-2 text-xs font-bold text-emerald-800 disabled:opacity-60">{t('account.resend')}</button>
            )}
            <button type="button" onClick={() => { setEditing(true); setEmail(account.email ?? ''); setMessage(null); }} className="rounded-lg bg-[#0B2E59] px-3 py-2 text-xs font-bold text-white">
              {account.email ? t('account.changeEmail') : t('account.addEmail')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void saveEmail(event)} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="text-sm font-semibold text-slate-700">{t('account.email')}
            <input type="email" required maxLength={254} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-normal" />
          </label>
          <label className="text-sm font-semibold text-slate-700">{t('account.currentPassword')}
            <input type="password" required autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-normal" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-emerald-700 px-3 py-2.5 text-xs font-bold text-white disabled:opacity-60">{t('account.save')}</button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-slate-300 px-3 py-2.5 text-xs font-bold text-slate-700">{t('common.cancel')}</button>
          </div>
        </form>
      )}
    </section>
  );
};

/** Lets a signed-in user change their password; other devices are signed out. */
export const ChangePasswordCard: React.FC = () => {
  const { t } = useTranslation();
  const [hasPassword, setHasPassword] = useState(true);
  useEffect(() => {
    apiRequest<AccountInfo>('/api/account').then((info) => setHasPassword(info.account.hasPassword !== false)).catch(() => undefined);
  }, []);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (next !== confirm) {
      setError(t('account.passwordsDiffer'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiRequest('/api/account/password', { method: 'PUT', body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      setMessage(hasPassword ? t('account.passwordChanged') : t('account.passwordSet'));
      setHasPassword(true);
      setCurrent(''); setNext(''); setConfirm('');
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : t('account.passwordChangeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-normal';
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-extrabold text-[#0B2E59]">{hasPassword ? t('account.changePasswordTitle') : t('account.setPasswordTitle')}</h2>
      {!hasPassword && <p className="mt-1 text-sm text-slate-600">{t('account.setPasswordIntro')}</p>}
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-800">{error}</p>}
      {message && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-900">{message}</p>}
      <form onSubmit={(event) => void submit(event)} className={`mt-3 grid gap-3 ${hasPassword ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} sm:items-end`}>
        {hasPassword && (
          <label className="text-sm font-semibold text-slate-700">{t('account.currentPassword')}
            <input type="password" required autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} className={field} />
          </label>
        )}
        <label className="text-sm font-semibold text-slate-700">{t('account.newPassword')}
          <input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} className={field} />
        </label>
        <label className="text-sm font-semibold text-slate-700">{t('account.confirmPassword')}
          <input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} className={field} />
        </label>
        <div className={`${hasPassword ? 'sm:col-span-3' : 'sm:col-span-2'} flex flex-wrap items-center justify-between gap-2`}>
          <p className="text-xs text-slate-500">{t('account.passwordRule')}</p>
          <button type="submit" disabled={busy} className="rounded-lg bg-[#0B2E59] px-4 py-2.5 text-xs font-bold text-white disabled:opacity-60">
            {busy ? t('common.pleaseWait') : hasPassword ? t('account.changePassword') : t('account.setPassword')}
          </button>
        </div>
      </form>
    </section>
  );
};

/** Shows whether a Google account is connected, and connects one for one-click sign-in. */
export const GoogleAccountCard: React.FC = () => {
  const { t } = useTranslation();
  const clientId = useGoogleClientId();
  const [googleEmail, setGoogleEmail] = useState<string | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<AccountInfo>('/api/account').then((info) => setGoogleEmail(info.account.googleEmail ?? null)).catch(() => setGoogleEmail(undefined));
  }, []);

  if (!clientId || googleEmail === undefined) return null;

  const connect = async (credential: string) => {
    setError(null);
    setMessage(null);
    try {
      const result = await apiRequest<{ googleEmail: string }>('/api/account/google', { method: 'POST', body: JSON.stringify({ credential }) });
      setGoogleEmail(result.googleEmail);
      setMessage(t('account.googleConnectedNow'));
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : t('login.genericError'));
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-extrabold text-[#0B2E59]">{t('account.googleTitle')}</h2>
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-800">{error}</p>}
      {message && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-900">{message}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-slate-700">
          {googleEmail ? t('account.googleConnected', { email: googleEmail }) : t('account.googleNotConnected')}
        </p>
        <div className="w-full max-w-xs">
          <GoogleSignInButton clientId={clientId} text="continue_with" onCredential={(credential) => void connect(credential)} />
        </div>
      </div>
    </section>
  );
};

export const NotFoundPage: React.FC<{ onHome: () => void }> = ({ onHome }) => {
  const { t } = useTranslation();
  return (
    <Shell onHome={onHome}>
      <h1 className="text-2xl font-extrabold text-[#0B2E59]">{t('notFound.title')}</h1>
      <p className="mt-3 text-sm text-slate-700">{t('notFound.text')}</p>
      <button onClick={onHome} className="mt-6 w-full rounded-lg bg-[#0B2E59] px-4 py-3 text-sm font-bold text-white">{t('account.backToPortal')}</button>
    </Shell>
  );
};
