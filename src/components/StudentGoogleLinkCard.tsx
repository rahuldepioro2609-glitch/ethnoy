// AUTH-1: lets a signed-in Student link Google through the existing GET /api/auth/google/link, which
// the server allows only for a verified Student session (password + mobile code). Linking is what
// makes "Continue with Google" usable; the server never creates or links accounts by email. When
// Google sign-in is not configured the option stays visible, disabled, with the server's reason.
import React, { useEffect, useState } from 'react';
import { apiRequestWithMeta } from '../api';
import { useLanguage } from '../utils/languageContext';
import { googleLinkNotice, studentGoogleSignInOption, type ProviderStatus } from '../utils/authVerification';

export const StudentGoogleLinkCard: React.FC = () => {
  const { t } = useLanguage();
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [notice] = useState(() => (typeof window === 'undefined' ? null : googleLinkNotice(window.location.search)));

  useEffect(() => {
    let cancelled = false;
    const closed = { available: false, reason: null };
    apiRequestWithMeta<ProviderStatus>('/api/auth/providers')
      .then(({ data }) => { if (!cancelled) setProviders(data); })
      .catch(() => { if (!cancelled) setProviders({ sms: closed, email: closed, google: closed }); });
    return () => { cancelled = true; };
  }, []);

  const option = studentGoogleSignInOption(providers);
  return (
    <section aria-labelledby="student-google-link-heading" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 id="student-google-link-heading" className="font-bold text-[#0B2E59]">{t('Sign in with Google')}</h3>
      <p className="mt-1 text-sm text-slate-600">{t('Link your Google account to use "Continue with Google" next time. You will still confirm a code sent to your mobile.')}</p>
      {notice && <p role="status" className={`mt-3 rounded-lg p-3 text-sm ${notice.tone === 'success' ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-800'}`}>{t(notice.text)}</p>}
      <div className="mt-3">
        {option.state === 'available'
          ? <a href="/api/auth/google/link" className="inline-flex rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-800 hover:bg-slate-50">{t('Link Google account')}</a>
          : <button type="button" disabled aria-disabled="true" className="inline-flex cursor-not-allowed rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm font-bold text-slate-500">{t('Link Google account')}</button>}
        {option.state === 'unavailable' && <p role="status" className="mt-2 text-xs text-amber-900">{t(option.reason)}</p>}
      </div>
    </section>
  );
};
