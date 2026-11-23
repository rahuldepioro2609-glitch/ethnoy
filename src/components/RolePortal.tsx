/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Award,
  BookOpen,
  Building2,
  CalendarDays,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  GraduationCap,
  Home,
  LifeBuoy,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  PlusCircle,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { ApiError, apiRequest, apiRequestWithMeta } from '../api';
import { VerificationStep } from './VerificationStep';
import { AdminMfaChallenge } from './AdminMfaChallenge';
import { AdminMfaEnrollment } from './AdminMfaEnrollment';
import { adminMfaStartStatus } from '../utils/adminMfa';
import { StudentAuthPanel } from './StudentAuthPanel';
import { StudentGoogleLinkCard } from './StudentGoogleLinkCard';
import { emailOnlyVerification, googleNotice, isChallenge, signInAvailable, unavailableMessage, verificationMessage, type ProviderStatus, type VerificationChallengeView } from '../utils/authVerification';
import { OnlineExamRunner } from './OnlineExamRunner';
import { ExamApplyModal } from './ExamApplyModal';
import type { ExamItem } from '../data/portalData';
import { BrandLogo } from './BrandLogo';
import { useLanguage } from '../utils/languageContext';
import { NO_LINKED_APPLICATIONS_MESSAGE } from '../utils/candidateDashboard';
import type { DisclosedSurfaceHostnames } from '../utils/surfaceNavigation';
import { describeOnlineExamAttempt } from '../utils/onlineExamDashboard';
import { adminPermissions, canLoadAdminSection, canSeeAdminTab, SUPER_ADMIN_ONLY_TEXT, withdrawalPaymentState } from '../utils/adminPermissions';
import { DashboardSectionLoader, getDashboardSectionContentState, type DashboardSectionStatusMap } from '../utils/dashboardData';
import { InstitutionDocumentManagement } from './InstitutionDocumentManagement';
import { PendingInstitutionSubmission } from './PendingInstitutionSubmission';
import { PlatformStaffAdminPanel } from './staff/PlatformStaffAdminPanel';
import { OrganizationStaffOwnerPanel } from './staff/OrganizationStaffOwnerPanel';
import { InstituteVerificationPanel } from './admin/InstituteVerificationPanel';
import { InstituteDashboardOverview } from './InstituteDashboardOverview';
import { InstituteAdvancedSection, type InstituteAdvancedSectionId } from './InstituteAdvancedSection';
import { savePortalHintInBrowser } from '../utils/portalHint';
import { ErrorState, LoadingState } from './ui';
import { currentDateInTimeZone, DEFAULT_EXAM_TIME_ZONE, getDateOnlyParts, isRegistrationOpen } from '../utils/examSchedule';

export type PortalRole = 'candidate' | 'center' | 'official';

export interface PortalUser {
  name: string;
  id: string;
  role: PortalRole;
  isSuperAdmin: boolean;
}

const roleDetails: Record<PortalRole, { title: string; subtitle: string; label: string; icon: typeof UserRound; accent: string }> = {
  candidate: {
    title: 'Student Login',
    subtitle: 'Access your applications, admit card and examination results.',
    label: 'Candidate',
    icon: GraduationCap,
    accent: 'emerald',
  },
  center: {
    title: 'Institute Login',
    subtitle: 'Manage candidate check-ins, institute forms, profile requests, and wallet withdrawals.',
    label: 'Institute',
    icon: Building2,
    accent: 'sky',
  },
  official: {
    title: 'Super Admin Login',
    subtitle: 'Manage applications, helpdesk tickets and published results.',
    label: 'Portal Official',
    icon: ShieldCheck,
    accent: 'blue',
  },
};

const dashboardTheme: Record<PortalRole, { shell: string; header: string; eyebrow: string; description: string }> = {
  candidate: {
    shell: 'bg-[#F5F7FB]',
    header: 'from-[#173B70] via-[#173B70] to-[#2563EB]',
    eyebrow: 'Student workspace',
    description: 'Track your exam applications, admit card, results, and practice history.',
  },
  center: {
    shell: 'bg-[#EEF3FA]',
    header: 'from-sky-950 via-sky-900 to-[#0B2E59]',
    eyebrow: 'Institute workspace',
    description: 'Manage candidate check-ins, submit public form listings, request profile changes, and track wallet activity.',
  },
  official: {
    shell: 'bg-slate-100',
    header: 'from-blue-950 via-[#0B2E59] to-slate-950',
    eyebrow: 'Super Admin control panel',
    description: 'Manage exam publication, institute approvals, applications, support, and results.',
  },
};

const accentClasses: Record<string, { panel: string; button: string }> = {
  emerald: { panel: 'bg-emerald-700', button: 'bg-emerald-700' },
  sky: { panel: 'bg-sky-700', button: 'bg-sky-700' },
  blue: { panel: 'bg-blue-800', button: 'bg-blue-800' },
};

const rolePath: Record<PortalRole, string> = {
  candidate: '/login/candidate',
  center: '/login/center',
  official: '/login/official',
};

const StudentEmailContactPanel: React.FC = () => {
  const [email, setEmail] = useState('');
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<VerificationChallengeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const result = await apiRequest<{ email: string | null }>('/api/auth/student/email');
      setVerifiedEmail(result.email);
      if (result.email) setEmail(result.email);
    } catch {
      setError('Could not load your verified email address. Please refresh and try again.');
    }
  };

  useEffect(() => { void load(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = (await apiRequestWithMeta<Record<string, unknown>>('/api/auth/student/email', {
        method: 'POST', body: JSON.stringify({ email: email.trim() }),
      })).data;
      if (isChallenge(result)) setChallenge(result);
      else if (result.status === 'already_verified') setVerifiedEmail(String(result.email));
      else setError('The server did not start email verification. Please try again.');
    } catch (caught) {
      setError(caught instanceof ApiError ? verificationMessage(caught.code, caught.message) : 'Could not start email verification. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {challenge ? (
        <VerificationStep
          challenge={challenge}
          onSignedIn={() => setChallenge(null)}
          onContactsVerified={() => { setChallenge(null); void load(); }}
          onRestart={(message) => { setChallenge(null); setError(message); }}
        />
      ) : (
        <>
          <h2 className="text-lg font-extrabold text-[#0B2E59]">Student email</h2>
          <p className="mt-1 text-sm text-slate-600">{verifiedEmail ? `Verified: ${verifiedEmail}` : 'Add an email address and verify the code we send to it.'}</p>
          <form onSubmit={(event) => void submit(event)} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <label className="sr-only" htmlFor="student-contact-email">Email address</label>
            <input id="student-contact-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
            <button type="submit" disabled={busy || !email.trim()} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60">{busy ? 'Please wait…' : verifiedEmail ? 'Change email' : 'Send verification code'}</button>
          </form>
          {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
        </>
      )}
    </section>
  );
};

interface RoleLoginPageProps {
  role?: PortalRole;
  surfaceHostnames?: DisclosedSurfaceHostnames | null;
  onBack: () => void;
  onLogin: (user: PortalUser) => void;
}

export const RoleLoginPage: React.FC<RoleLoginPageProps> = ({ role, surfaceHostnames, onBack, onLogin }) => {
  const { t } = useLanguage();
  const [loginId, setLoginId] = useState('');
  const [fullName, setFullName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [registeredAddress, setRegisteredAddress] = useState('');
  const [website, setWebsite] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isResubmitting, setIsResubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [showSubmissionAccess, setShowSubmissionAccess] = useState(false);
  const [submissionAccessMessage, setSubmissionAccessMessage] = useState('');
  // AUTH-1: server-reported provider availability and an in-progress verification (server-started only).
  const [mobile, setMobile] = useState('');
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [verification, setVerification] = useState<VerificationChallengeView | null>(null);
  // AUTH C1.9.2: Official / Super Admin authenticator step (shown only after the server's 202 mfa_required).
  const [adminMfaPending, setAdminMfaPending] = useState(false);
  const [adminMfaEnrolmentPending, setAdminMfaEnrolmentPending] = useState(false);

  useEffect(() => {
    if (role !== 'candidate' && role !== 'center') return;
    let cancelled = false;
    const closed = { available: false, reason: null };
    apiRequestWithMeta<ProviderStatus>('/api/auth/providers')
      .then(({ data }) => { if (!cancelled) setProviders(data); })
      .catch(() => { if (!cancelled) setProviders({ sms: closed, email: closed, google: closed }); });
    const notice = googleNotice(window.location.search);
    if (notice) setError(notice);
    if (role === 'candidate' && new URLSearchParams(window.location.search).get('verification') === 'pending') {
      apiRequestWithMeta<VerificationChallengeView>('/api/auth/verification')
        .then(({ data }) => { if (!cancelled && isChallenge(data)) setVerification(data); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [role]);

  const describeError = (caught: unknown, fallback: string) => (caught instanceof ApiError
    ? verificationMessage(caught.code, caught.message)
    : caught instanceof Error ? caught.message : fallback);

  /** After the SERVER reports a verified session, confirm it through /api/auth/me as before. */
  const finishVerifiedSignIn = async () => {
    try {
      const { user } = await apiRequest<{
        user: { id: string; loginId: string; name: string; role: PortalRole; isSuperAdmin: boolean };
      }>('/api/auth/me');
      setVerification(null);
      setAdminMfaPending(false);
      setAdminMfaEnrolmentPending(false);
      onLogin({ id: user.loginId, name: user.name, role: user.role, isSuperAdmin: user.isSuperAdmin });
    } catch (caught) {
      setVerification(null);
      setAdminMfaPending(false);
      setError(describeError(caught, 'Sign in failed. Please try again.'));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!role) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await apiRequestWithMeta<Record<string, unknown>>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginId: loginId.trim(), password, role }),
      });
      // AUTH-1: Students (and Institutes still verifying contacts) get a verification step, not a session.
      if (result.status === 202 && isChallenge(result.data)) {
        setPassword('');
        setVerification(result.data);
        return;
      }
      // AUTH C1.9.2: an Official's password never yields a session. The server answers 202 and either
      // started an authenticator challenge (its cookie is HttpOnly; nothing is read here) or reports that
      // no authenticator is set up (enrolment is not available in the portal yet).
      if (role === 'official' && result.status === 202) {
        setPassword('');
        const start = adminMfaStartStatus(result.data);
        if (start === 'mfa_required') setAdminMfaPending(true);
        else if (start === 'mfa_enrolment_required') setAdminMfaEnrolmentPending(true);
        else setError('Sign in failed. Please try again.');
        return;
      }
      // Verify the session was durably persisted before updating UI state.
      const { user } = await apiRequest<{
        user: { id: string; loginId: string; name: string; role: PortalRole; isSuperAdmin: boolean };
      }>('/api/auth/me');
      onLogin({ id: user.loginId, name: user.name, role: user.role, isSuperAdmin: user.isSuperAdmin });
    } catch (loginError) {
      setError(describeError(loginError, 'Sign in failed. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    // Students register in StudentAuthPanel; this form serves Institutes only.
    if (role !== 'center') return;
    setError(null);
    setMessage(null);
    setIsSubmitting(true);
    try {
      const { message: registrationMessage, verification: started } = await apiRequest<{ message: string; verification?: unknown }>('/api/center/register', {
        method: 'POST',
        body: JSON.stringify({
          loginId: loginId.trim(),
          name: fullName.trim(),
          contactEmail: contactEmail.trim(),
          contactMobile: mobile.trim(),
          registrationNumber: registrationNumber.trim(),
          registeredAddress: registeredAddress.trim(),
          website: website.trim(),
          password,
        }),
      });
      setSubmissionAccessMessage(registrationMessage);
      setShowSubmissionAccess(true);
      setPassword('');
      if (isChallenge(started)) setVerification(started);
    } catch (registrationError) {
      setError(describeError(registrationError, 'Could not submit registration.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const resubmitInstitute = async (event: React.FormEvent) => {
    event.preventDefault();
    if (role !== 'center') return;
    setError(null);
    setMessage(null);
    setIsSubmitting(true);
    try {
      const { message: resubmissionMessage, submissionReference } = await apiRequest<{
        message: string;
        submissionReference: string;
      }>('/api/center/resubmit', {
        method: 'POST',
        body: JSON.stringify({
          loginId: loginId.trim(),
          password,
          name: fullName.trim(),
          contactEmail: contactEmail.trim(),
          registrationNumber: registrationNumber.trim(),
          registeredAddress: registeredAddress.trim(),
          website: website.trim(),
        }),
      });
      setSubmissionAccessMessage(`${resubmissionMessage} Reference: ${submissionReference}`);
      setPassword('');
      setIsResubmitting(false);
      setIsRegistering(false);
      setShowSubmissionAccess(true);
    } catch (resubmissionError) {
      setError(resubmissionError instanceof Error ? resubmissionError.message : 'Could not resubmit institute details.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const startInstituteResubmission = () => {
    setIsRegistering(true);
    setIsResubmitting(true);
    setIsPasswordVisible(false);
    setError(null);
    setMessage(null);
  };

  const changeRegistrationMode = (enabled: boolean) => {
    setShowSubmissionAccess(false);
    setIsRegistering(enabled);
    setIsResubmitting(false);
    setIsPasswordVisible(false);
    setError(null);
    setMessage(null);
  };

  const detail = role ? roleDetails[role] : null;
  const Icon = detail?.icon ?? GraduationCap;
  const accent = accentClasses[detail?.accent ?? 'emerald'];

  return (
    <main className="min-h-screen bg-[#EEF6F1] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-2">
          <div className="flex items-center gap-3">
            <BrandLogo />
          </div>
          <button onClick={onBack} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-[#0B2E59] hover:bg-emerald-50">
            <ArrowLeft className="h-4 w-4" /> {t('Home')}
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
        {!role ? (
          <>
            <div className="mx-auto mb-9 max-w-2xl text-center">
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-emerald-700">{t('Secure access')}</p>
              <h1 className="mt-2 text-3xl font-black text-[#0B2E59] sm:text-4xl">{t('Choose your portal')}</h1>
              <p className="mt-3 text-slate-600">{t('Select the account type shown on your ELTNOY credentials.')}</p>
            </div>
            {surfaceHostnames?.exam && surfaceHostnames.institution ? (
              <div className="grid gap-5 md:grid-cols-2">
                {(['candidate', 'center'] as const).map((item) => {
                  const itemDetail = roleDetails[item];
                  const RoleIcon = itemDetail.icon;
                  const colorClass = item === 'candidate' ? 'bg-emerald-600' : 'bg-sky-600';
                  const targetSurface = item === 'candidate' ? 'exam' : 'institution';
                  const href = `${window.location.protocol}//${surfaceHostnames[targetSurface]}${rolePath[item]}`;
                  return (
                    <a key={item} href={href} className="group rounded-2xl border border-slate-200 bg-white p-7 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
                      <div className={`mb-5 inline-flex rounded-xl p-3 text-white ${colorClass}`}><RoleIcon className="h-7 w-7" /></div>
                      <h2 className="text-xl font-extrabold text-[#0B2E59]">{t(itemDetail.title)}</h2>
                      <p className="mt-2 min-h-12 text-sm leading-6 text-slate-600">{t(itemDetail.subtitle)}</p>
                      <span className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-emerald-700">{t('Continue to login')} <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" /></span>
                    </a>
                  );
                })}
              </div>
            ) : (
              <p role="status" className="mx-auto max-w-xl rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                {t('Secure portal links are loading. If this continues, refresh the page.')}
              </p>
            )}
          </>
        ) : (
          <div className="mx-auto grid max-w-4xl overflow-hidden rounded-3xl bg-white shadow-xl md:grid-cols-[0.9fr_1.1fr]">
            <section className={`flex min-h-64 flex-col justify-between ${accent.panel} p-8 text-white sm:p-10`}>
              <div>
                <div className="inline-flex rounded-2xl bg-white/15 p-3"><Icon className="h-8 w-8" /></div>
                <p className="mt-8 text-sm font-bold uppercase tracking-[0.18em] text-white/75">{detail?.label}</p>
                <h1 className="mt-2 text-3xl font-black">{detail?.title}</h1>
                <p className="mt-3 max-w-sm text-sm leading-6 text-white/85">{detail?.subtitle}</p>
              </div>
              <p className="mt-8 text-xs text-white/70">{t('Your Future, Our Mission')}</p>
            </section>
            <section className="p-7 sm:p-10">
              {verification ? (
                <VerificationStep
                  challenge={verification}
                  onSignedIn={() => void finishVerifiedSignIn()}
                  onContactsVerified={(verifiedMessage) => {
                    setVerification(null);
                    setShowSubmissionAccess(false);
                    setIsRegistering(false);
                    setMessage(verifiedMessage);
                  }}
                  onRestart={(restartMessage) => {
                    setVerification(null);
                    setError(restartMessage);
                  }}
                />
              ) : role === 'official' && adminMfaPending ? (
                <AdminMfaChallenge
                  buttonClass={accent.button}
                  onSignedIn={() => void finishVerifiedSignIn()}
                  onRestart={(restartMessage) => {
                    setAdminMfaPending(false);
                    setError(restartMessage);
                  }}
                />
              ) : role === 'official' && adminMfaEnrolmentPending ? (
                <AdminMfaEnrollment
                  buttonClass={accent.button}
                  onSignedIn={() => void finishVerifiedSignIn()}
                  onRestart={(restartMessage) => {
                    setAdminMfaEnrolmentPending(false);
                    setError(restartMessage);
                  }}
                />
              ) : role === 'candidate' ? (
                // AUTH-1: Student sign-in (mobile + password, then OTP; Google; legacy Student ID link).
                // Every option stays visible; unavailable providers are shown explicitly.
                <StudentAuthPanel providers={providers} initialError={error} buttonClass={accent.button} onChallenge={setVerification} onSignedIn={() => void finishVerifiedSignIn()} />
              ) : role === 'center' && !isResubmitting && !showSubmissionAccess && signInAvailable(role, providers) === false ? (
                <div className="space-y-5">
                  <a href="/login" className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-[#0B2E59]"><ArrowLeft className="h-3.5 w-3.5" /> {t('All login options')}</a>
                  <h2 className="text-2xl font-extrabold text-[#0B2E59]">{t('Institute sign-in is unavailable')}</h2>
                  <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">{t(unavailableMessage(role, providers))}</div>
                  {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
                  {role === 'center' && (
                    <button type="button" onClick={startInstituteResubmission} className="w-full text-center text-sm font-bold text-sky-800 hover:underline">
                      {t('Rejected application? Correct details and resubmit')}
                    </button>
                  )}
                </div>
              ) : role === 'center' && showSubmissionAccess ? (
                <PendingInstitutionSubmission
                  message={submissionAccessMessage}
                  onReturnToLogin={() => {
                    setShowSubmissionAccess(false);
                    setIsRegistering(false);
                    setIsResubmitting(false);
                    setMessage(null);
                    setError(null);
                  }}
                />
              ) : (
                <>
              <a href={role === 'official' ? '/' : '/login'} className="mb-7 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-[#0B2E59]"><ArrowLeft className="h-3.5 w-3.5" /> {t('All login options')}</a>
              <h2 className="text-2xl font-extrabold text-[#0B2E59]">
                {t(isResubmitting ? 'Correct and resubmit institute details' : isRegistering ? 'Request institute access' : 'Sign in to your account')}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {t(isResubmitting
                  ? 'Use the existing rejected institute login ID and password. Corrected details will be submitted under the same account for review; this does not restore portal access.'
                  : isRegistering
                  ? 'Submit your institute details. Portal access starts only after Super Admin approval.'
                  : 'Enter the credentials provided by your portal administrator.')}
              </p>
              <form className="mt-7 space-y-5" onSubmit={(event) => void (isResubmitting ? resubmitInstitute(event) : isRegistering ? register(event) : submit(event))}>
                {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
                {message && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</div>}
                {isRegistering && (
                  <div>
                    <label htmlFor="role-register-name" className="mb-1.5 block text-sm font-semibold text-slate-700">
                      {t(isResubmitting ? 'Corrected institute name' : 'Institute name')}
                    </label>
                    <input id="role-register-name" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} required maxLength={120} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                  </div>
                )}
                <div>
                  <label htmlFor="role-login-id" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {t(isRegistering ? 'Choose institute / center ID' : role === 'center' ? 'Institute email or Staff / Center ID' : 'Staff / Center ID')}
                  </label>
                  <input id="role-login-id" autoComplete="username" value={loginId} onChange={(event) => setLoginId(event.target.value)} required minLength={isRegistering ? 4 : 1} maxLength={isRegistering ? 50 : role === 'center' ? 254 : 50} pattern={isRegistering || role === 'official' ? '[A-Za-z0-9._-]+' : undefined} title={isRegistering || role === 'official' ? 'Use 4-50 letters, numbers, dots, underscores or hyphens.' : undefined} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm uppercase outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                </div>
                {isRegistering && !isResubmitting && (
                  <div>
                    <label htmlFor="role-register-mobile" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Institute contact mobile number')}</label>
                    <input id="role-register-mobile" type="tel" inputMode="numeric" autoComplete="tel-national" value={mobile} onChange={(event) => setMobile(event.target.value)} required maxLength={16} placeholder="10-digit mobile number" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:bg-white focus:ring-2 focus:ring-emerald-600/15" />
                    <p className="mt-1 text-xs text-slate-500">{t(emailOnlyVerification(providers)
                      ? 'Contact number for institute records. It is not verified while mobile verification is off; the one-time code is sent to your email.'
                      : 'A one-time code will be sent to this number. You can sign in only after it is verified.')}</p>
                  </div>
                )}
                {isRegistering && role === 'center' && (
                  <div>
                    <label htmlFor="institute-contact-email" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Contact email')}</label>
                    <input id="institute-contact-email" type="email" autoComplete="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} required maxLength={254} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                  </div>
                )}
                <div>
                  <label htmlFor="role-login-password" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Password')}</label>
                  <div className="relative">
                    <input id="role-login-password" type={isPasswordVisible ? 'text' : 'password'} autoComplete={isRegistering ? 'new-password' : 'current-password'} minLength={isRegistering ? 12 : undefined} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 pr-12 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                    <button
                      type="button"
                      onClick={() => setIsPasswordVisible((visible) => !visible)}
                      aria-label={t(isPasswordVisible ? 'Hide password' : 'Show password')}
                      aria-pressed={isPasswordVisible}
                      className="absolute inset-y-0 right-0 inline-flex items-center justify-center px-3 text-slate-500 hover:text-[#0B2E59] focus-visible:outline-2 focus-visible:outline-emerald-600"
                    >
                      {isPasswordVisible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                  {isRegistering && <p className="mt-1 text-xs text-slate-500">{t('Use at least 12 characters. Keep your login ID and password safe.')}</p>}
                </div>
                {role === 'center' && isRegistering && (
                  <>
                    <div>
                      <label htmlFor="institute-registration-number" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Institute registration / recognition number')}</label>
                      <input id="institute-registration-number" value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} required minLength={3} maxLength={100} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                    </div>
                    <div>
                      <label htmlFor="institute-registered-address" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Registered address')}</label>
                      <textarea id="institute-registered-address" value={registeredAddress} onChange={(event) => setRegisteredAddress(event.target.value)} required minLength={10} maxLength={500} rows={3} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                    </div>
                    <div>
                      <label htmlFor="institute-website" className="mb-1.5 block text-sm font-semibold text-slate-700">{t('Official website (optional)')}</label>
                      <input id="institute-website" type="url" value={website} onChange={(event) => setWebsite(event.target.value)} maxLength={200} placeholder="https://example.org" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                    </div>
                    <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                      {t('Registration does not grant immediate access. Super Admin must independently verify these details before approval. Approved institutes may submit exam and teacher-recruitment listings for Super Admin review; no documents are uploaded here.')}
                    </p>
                  </>
                )}
                <button type="submit" disabled={isSubmitting} className={`flex w-full items-center justify-center gap-2 rounded-lg ${accent.button} px-4 py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60`}>
                  <LockKeyhole className="h-4 w-4" /> {t(isSubmitting ? 'Please wait…' : isResubmitting ? 'Resubmit corrected details' : isRegistering ? 'Submit for approval' : 'Secure sign in')}
                </button>
              </form>
              {role !== 'official' && (
                <div className="mt-5 space-y-3">
                  <button type="button" onClick={() => changeRegistrationMode(!isRegistering)} className="w-full text-center text-sm font-bold text-emerald-800 hover:underline">
                    {t(isRegistering ? 'Already registered? Sign in' : 'Institute needs access? Register for approval')}
                  </button>
                  {role === 'center' && !isResubmitting && (
                    <button
                      type="button"
                      onClick={startInstituteResubmission}
                      className="w-full text-center text-sm font-bold text-sky-800 hover:underline"
                    >
                      {t('Rejected application? Correct details and resubmit')}
                    </button>
                  )}
                  {role === 'center' && isResubmitting && (
                    <button type="button" onClick={() => changeRegistrationMode(false)} className="w-full text-center text-sm font-bold text-slate-600 hover:underline">
                      {t('Return to institute sign in')}
                    </button>
                  )}
                </div>
              )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
};

type DashboardTab = 'overview' | 'exams' | 'institutes' | 'institution-documents' | 'applications' | 'feedback' | 'attempts' | 'results' | 'admit-cards' | 'online-exams' | 'answer-keys' | 'notices' | 'data-export' | 'platform-staff' | 'institute-verification';

interface RoleDashboardProps {
  user: PortalUser;
  onLogout: () => void;
  onHome: () => void;
  onOpenAdmitCard: () => void;
  onOpenResults: () => void;
}

type PortalData = Record<string, unknown>;

interface ExamDraft {
  code: string;
  name: string;
  category: 'Undergraduate' | 'Scholarship' | 'Teacher' | 'Professional';
  targetAudience: string;
  regStart: string;
  regEnd: string;
  examDate: string;
  timeZone: string;
  fee: string;
  duration: string;
  mode: string;
  shifts: string;
}

const emptyExamDraft: ExamDraft = {
  code: '',
  name: '',
  category: 'Undergraduate',
  targetAudience: '',
  regStart: '',
  regEnd: '',
  examDate: '',
  timeZone: 'Asia/Kolkata',
  fee: 'Free',
  duration: '',
  mode: 'Online Computer Based Test (CBT)',
  shifts: '',
};

interface NoticeDraft {
  title: string;
  category: 'Registration' | 'Admit Card' | 'Answer Key' | 'Result' | 'Circular';
  summary: string;
  fullContent: string;
  referenceNumber: string;
}

interface InstituteFormDraft {
  formType: 'exam_application' | 'teacher_recruitment';
  title: string;
  description: string;
  eligibility: string;
  applicationDeadline: string;
  externalUrl: string;
}

const emptyInstituteFormDraft: InstituteFormDraft = {
  formType: 'exam_application',
  title: '',
  description: '',
  eligibility: '',
  applicationDeadline: '',
  externalUrl: '',
};

function rupeesToPaise(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [rupees, fraction = ''] = value.trim().split('.');
  const paise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, '0'));
  return paise > 0n && paise <= 1_000_000_000_000n ? Number(paise) : null;
}

function formatPaise(value: unknown): string {
  const paise = Number(value);
  return Number.isSafeInteger(paise)
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100)
    : 'Amount unavailable';
}

const emptyNoticeDraft: NoticeDraft = {
  title: '',
  category: 'Circular',
  summary: '',
  fullContent: '',
  referenceNumber: '',
};

export const RoleDashboard: React.FC<RoleDashboardProps> = ({ user, onLogout, onHome, onOpenAdmitCard, onOpenResults }) => {
  const { t } = useLanguage();
  const [data, setData] = useState<PortalData>({});
  const [tab, setTab] = useState<DashboardTab>('overview');
  const [activeCandidateSection, setActiveCandidateSection] = useState('dashboard');
  const [isCandidateMenuOpen, setIsCandidateMenuOpen] = useState(false);
  const [candidateExamSearch, setCandidateExamSearch] = useState('');
  const [candidateExamCategory, setCandidateExamCategory] = useState('all');
  const [candidateApplyExam, setCandidateApplyExam] = useState<ExamItem | null>(null);
  const [candidateTicketType, setCandidateTicketType] = useState('other');
  const [candidateTicketTitle, setCandidateTicketTitle] = useState('');
  const [candidateTicketDescription, setCandidateTicketDescription] = useState('');
  const [candidateTicketEmail, setCandidateTicketEmail] = useState('');
  const [candidateTicketApplication, setCandidateTicketApplication] = useState('');
  const [candidateTicketId, setCandidateTicketId] = useState<string | null>(null);
  const [isSubmittingCandidateTicket, setIsSubmittingCandidateTicket] = useState(false);
  const [activeInstituteSection, setActiveInstituteSection] = useState('institute-overview');
  const [isInstituteMenuOpen, setIsInstituteMenuOpen] = useState(false);
  const instituteMenuRef = useRef<HTMLElement>(null);
  const instituteMenuButtonRef = useRef<HTMLButtonElement>(null);
  const candidateMenuRef = useRef<HTMLElement>(null);
  const candidateMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [sectionStatuses, setSectionStatuses] = useState<DashboardSectionStatusMap>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applicationNumber, setApplicationNumber] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [checkinStatus, setCheckinStatus] = useState('verified');
  const [checkinNote, setCheckinNote] = useState('');
  const [examDraft, setExamDraft] = useState<ExamDraft>(emptyExamDraft);
  const [noticeDraft, setNoticeDraft] = useState<NoticeDraft>(emptyNoticeDraft);
  const [instituteFormDraft, setInstituteFormDraft] = useState<InstituteFormDraft>(emptyInstituteFormDraft);
  const [instituteProfileDraft, setInstituteProfileDraft] = useState({
    displayName: '',
    contactEmail: '',
    registrationNumber: '',
    registeredAddress: '',
    website: '',
  });
  const [institutionDecisionReasons, setInstitutionDecisionReasons] = useState<Record<string, string>>({});
  const [savingInstitutionDecisionId, setSavingInstitutionDecisionId] = useState<string | null>(null);
  const [withdrawalAmount, setWithdrawalAmount] = useState('');
  const [transferReferences, setTransferReferences] = useState<Record<string, string>>({});
  const [isSavingExam, setIsSavingExam] = useState(false);
  const [isSavingNotice, setIsSavingNotice] = useState(false);
  const [isSavingInstituteForm, setIsSavingInstituteForm] = useState(false);
  const [isSavingInstituteProfile, setIsSavingInstituteProfile] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [activeOnlineExam, setActiveOnlineExam] = useState<{ code: string; name: string } | null>(null);
  const activeRoleRef = useRef(user.role);
  const retryLoadRef = useRef<Record<string, () => Promise<void>>>({});
  const dashboardLoader = useMemo(() => new DashboardSectionLoader(
    (update) => setData((current) => ({ ...current, ...update })),
    (update) => setSectionStatuses(update),
  ), []);

  const refresh = async () => {
    if (activeRoleRef.current !== user.role) {
      dashboardLoader.reset();
      activeRoleRef.current = user.role;
      retryLoadRef.current = {};
      setData({});
      setSectionStatuses({});
    }
    setError(null);
    const requests: Promise<void>[] = [];
    const loadSection = (
      name: string,
      path: string,
      select: (response: PortalData) => PortalData,
    ) => {
      const key = `${user.role}:${name}`;
      const retry = () => dashboardLoader.load(key, async () => (
        select(await apiRequest<PortalData>(path))
      ));
      retryLoadRef.current[key] = retry;
      requests.push(retry());
    };

    if (user.role === 'candidate') {
      loadSection('portal', '/api/candidate/portal', (portal) => ({
        applications: portal.applications,
        results: portal.results,
      }));
      loadSection('attempts', '/api/mock-exams/mine', (attempts) => ({
        attempts: attempts.attempts,
      }));
      loadSection('online-exams', '/api/online-exams', (onlineExams) => ({
        onlineExams: onlineExams.exams,
      }));
      loadSection('exams', '/api/exams', (exams) => ({
        candidateExams: exams.exams,
      }));
    } else if (user.role === 'center') {
      loadSection('checkins', '/api/center/checkins', (checkins) => ({
        checkins: checkins.checkins,
      }));
      loadSection('workspace', '/api/center/workspace', (workspace) => workspace);
    } else {
      loadSection('applications', '/api/admin/applications', (applications) => ({
        applications: applications.applications,
      }));
      // P0-3 (A-14, P3-D4): ordinary Officials never request helpdesk data.
      if (canLoadAdminSection(user, 'feedback')) {
        loadSection('feedback', '/api/admin/feedback', (feedback) => ({
          feedback: feedback.entries,
        }));
      }
      loadSection('attempts', '/api/admin/mock-exams/attempts', (attempts) => ({
        attempts: attempts.attempts,
      }));
      loadSection('results', '/api/admin/results', (results) => ({
        results: results.results,
      }));
      loadSection('stats', '/api/admin/dashboard-stats', (stats) => ({
        stats: stats.stats,
      }));
      loadSection('exams', '/api/admin/exams', (exams) => ({
        exams: exams.exams,
      }));
      loadSection('institutes', '/api/admin/institutes', (institutes) => ({
        institutes: institutes.institutes,
      }));
      loadSection('institution-cycles', '/api/institution-document-submission/admin/cycles', (cycles) => ({
        institutionSubmissionCycles: cycles.submissions,
      }));
      loadSection('institute-management', '/api/admin/institute-management', (management) => ({
        instituteForms: management.forms,
        profileChanges: management.profileChanges,
        withdrawals: management.withdrawals,
        walletBalances: management.walletBalances,
      }));
      loadSection('online-exams', '/api/admin/online-exams', (onlineExams) => ({
        onlineExams: onlineExams.exams,
      }));
      loadSection('answer-keys', '/api/admin/answer-keys', (answerKeys) => ({
        answerKeys: answerKeys.exams,
      }));
      loadSection('notices', '/api/admin/notices', (notices) => ({
        notices: notices.notices,
      }));
    }

    await Promise.all(requests);
  };

  useEffect(() => { void refresh(); }, [user.role]);

  const updateApplication = async (id: string, status: string) => {
    try {
      await apiRequest(`/api/admin/applications/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setNotice('Application status updated.');
      await refresh();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update application.');
    }
  };

  const updateFeedback = async (id: string, status: string) => {
    try {
      await apiRequest(`/api/admin/feedback/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setNotice('Helpdesk ticket updated.');
      await refresh();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update ticket.');
    }
  };

  const createExam = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSavingExam(true);
    try {
      await apiRequest('/api/admin/exams', {
        method: 'POST',
        body: JSON.stringify(examDraft),
      });
      setExamDraft(emptyExamDraft);
      setNotice('Exam form created as a draft. Publish it when the details are verified.');
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create exam form.');
    } finally {
      setIsSavingExam(false);
    }
  };

  const createPortalNotice = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSavingNotice(true);
    try {
      await apiRequest('/api/admin/notices', {
        method: 'POST',
        body: JSON.stringify(noticeDraft),
      });
      setNoticeDraft(emptyNoticeDraft);
      setNotice('Notice saved as a draft. A Super Admin can publish it after review.');
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not save notice draft.');
    } finally {
      setIsSavingNotice(false);
    }
  };

  const setExamField = <K extends keyof ExamDraft,>(field: K, value: ExamDraft[K]) => {
    setExamDraft((draft) => ({ ...draft, [field]: value }));
  };

  const setExamPublished = async (id: string, isPublished: boolean) => {
    setError(null);
    try {
      await apiRequest(`/api/admin/exams/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isPublished }),
      });
      setNotice(isPublished ? 'Exam is now visible on the public website.' : 'Exam has been unpublished.');
      await refresh();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Could not update exam publication.');
    }
  };

  const setInstituteApproval = async (id: string, status: 'approved' | 'rejected', reason: string) => {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 1000) {
      setError('Enter an institution decision reason between 10 and 1,000 characters.');
      return;
    }
    setError(null);
    setSavingInstitutionDecisionId(id);
    try {
      await apiRequest(`/api/admin/institutes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reason: normalizedReason }),
      });
      setInstitutionDecisionReasons((reasons) => {
        const next = { ...reasons };
        delete next[id];
        return next;
      });
      setNotice(status === 'approved' ? 'Institute access approved.' : 'Institute registration rejected.');
      await refresh();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Could not update institute registration.');
    } finally {
      setSavingInstitutionDecisionId(null);
    }
  };

  const submitInstituteForm = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSavingInstituteForm(true);
    try {
      await apiRequest('/api/center/forms', {
        method: 'POST',
        body: JSON.stringify(instituteFormDraft),
      });
      setInstituteFormDraft(emptyInstituteFormDraft);
      setNotice('Form submitted for Super Admin review. It will appear publicly only after approval.');
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit institute form.');
    } finally {
      setIsSavingInstituteForm(false);
    }
  };

  const submitInstituteProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSavingInstituteProfile(true);
    try {
      await apiRequest('/api/center/profile-changes', {
        method: 'POST',
        body: JSON.stringify(instituteProfileDraft),
      });
      setNotice('Profile change submitted for Super Admin approval.');
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit profile change.');
    } finally {
      setIsSavingInstituteProfile(false);
    }
  };

  const requestWithdrawal = async (event: React.FormEvent) => {
    event.preventDefault();
    const amountPaise = rupeesToPaise(withdrawalAmount);
    if (amountPaise === null) {
      setError('Enter a withdrawal amount greater than zero with up to two decimal places.');
      return;
    }
    setError(null);
    try {
      await apiRequest('/api/center/withdrawals', {
        method: 'POST',
        body: JSON.stringify({ amountPaise }),
      });
      setWithdrawalAmount('');
      setNotice('Withdrawal request submitted. The amount is reserved while Super Admin reviews it.');
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not request withdrawal.');
    }
  };

  const reviewInstituteRecord = async (
    endpoint: string,
    status: 'approved' | 'rejected',
    successMessage: string,
  ) => {
    setError(null);
    try {
      await apiRequest(endpoint, { method: 'PATCH', body: JSON.stringify({ status }) });
      setNotice(successMessage);
      await refresh();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not review institute request.');
    }
  };

  const updateInstituteWithdrawal = async (
    id: string,
    status: 'approved' | 'rejected' | 'paid',
  ) => {
    const transferReference = transferReferences[id]?.trim();
    setError(null);
    try {
      await apiRequest(`/api/admin/institute-withdrawals/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...(status === 'paid' ? { transferReference } : {}) }),
      });
      setNotice(status === 'paid' ? 'Withdrawal marked paid with transfer reference.' : `Withdrawal ${status}.`);
      await refresh();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not update withdrawal.');
    }
  };

  const recordInstituteCredit = async (event: React.FormEvent<HTMLFormElement>, instituteId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const amountPaise = rupeesToPaise(String(formData.get('amount') || ''));
    if (amountPaise === null) {
      setError('Enter a credit amount greater than zero with up to two decimal places.');
      return;
    }
    setError(null);
    try {
      await apiRequest(`/api/admin/institutes/${encodeURIComponent(instituteId)}/credits`, {
        method: 'POST',
        body: JSON.stringify({
          amountPaise,
          description: String(formData.get('description') || ''),
          paymentReference: String(formData.get('paymentReference') || ''),
        }),
      });
      form.reset();
      setNotice('Verified payment credit recorded in the institute wallet.');
      await refresh();
    } catch (creditError) {
      setError(creditError instanceof Error ? creditError.message : 'Could not record wallet credit.');
    }
  };

  const submitCheckin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await apiRequest('/api/center/checkins', {
        method: 'POST',
        body: JSON.stringify({ applicationNumber, dateOfBirth, status: checkinStatus, note: checkinNote }),
      });
      setNotice('Candidate check-in saved for this center.');
      setApplicationNumber('');
      setDateOfBirth('');
      setCheckinNote('');
      await refresh();
    } catch (checkinError) {
      setError(checkinError instanceof Error ? checkinError.message : 'Could not verify this candidate.');
    }
  };

  const uploadWorkbook = async (kind: 'admit-cards' | 'answer-keys' | 'online-exams' | 'results', file?: File) => {
    if (!file) return;
    setError(null);
    setUploading(kind);
    try {
      const response = await apiRequest<{ imported: number; published?: boolean }>(`/api/admin/${kind}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: await file.arrayBuffer(),
      });
      setNotice(`${response.imported} row(s) imported. Review them and publish when ready.`);
      await refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : `Could not import ${kind}.`);
    } finally {
      setUploading(null);
    }
  };

  const publishAdminRecord = async (
    endpoint: string,
    isPublished: boolean,
    recordName: string,
  ) => {
    setError(null);
    try {
      await apiRequest(endpoint, { method: 'PATCH', body: JSON.stringify({ isPublished }) });
      setNotice(`${recordName} ${isPublished ? 'published' : 'unpublished'}.`);
      await refresh();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : `Could not update ${recordName}.`);
    }
  };

  const downloadAdminWorkbook = async () => {
    setError(null);
    try {
      const response = await fetch('/api/admin/data-export', { credentials: 'same-origin' });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error || `Export failed (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'eltnoy-admin-data.xlsx';
      link.click();
      URL.revokeObjectURL(url);
      setNotice('Complete admin data workbook downloaded.');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Could not download admin workbook.');
    }
  };

  const downloadUploadTemplates = () => {
    const link = document.createElement('a');
    link.href = '/api/admin/workbook-template';
    link.download = 'eltnoy-admin-upload-templates.xlsx';
    link.click();
  };

  const detail = roleDetails[user.role];
  const theme = dashboardTheme[user.role];
  const instituteNavItems = [
    { id: 'institute-overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'institute-profile', label: 'My Institute', icon: Building2 },
    { id: 'institute-forms', label: 'Create Examination', icon: PlusCircle },
    { id: 'institute-exam-management', label: 'Exam Management', icon: ClipboardCheck },
    { id: 'institute-applications', label: 'Online Applications', icon: FolderOpen },
    { id: 'institute-checkins', label: 'Applicants & verification', icon: ClipboardCheck },
    { id: 'institute-wallet', label: 'Payments & fees', icon: Wallet },
    { id: 'institute-admit-cards', label: 'Admit Cards', icon: Award },
    { id: 'institute-question-bank', label: 'Question Bank', icon: FileText },
    { id: 'institute-cbt-center', label: 'CBT Exam Center', icon: LayoutDashboard },
    { id: 'institute-results', label: 'Results & Merit List', icon: Award },
    { id: 'institute-reports', label: 'Reports & Analytics', icon: Download },
    { id: 'institute-staff', label: 'Staff & roles', icon: UserRound },
    { id: 'institute-attendance', label: 'Exam Attendance Management', icon: CalendarDays },
    { id: 'institute-interviews', label: 'Online Interview', icon: UserRound },
    { id: 'institute-training', label: 'Online Training', icon: Award },
    { id: 'institute-settings', label: 'Settings & Support', icon: LockKeyhole },
  ];
  const selectedInstituteSection = instituteNavItems.find((item) => item.id === activeInstituteSection) ?? instituteNavItems[0];
  const candidateNavItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'profile', label: 'My Profile', icon: UserRound },
    { id: 'browse-exams', label: 'Browse Examinations', icon: Search },
    { id: 'apply-exam', label: 'Apply for Examination', icon: PlusCircle },
    { id: 'applications', label: 'My Applications', icon: FileText },
    { id: 'payments', label: 'Payments & Fees', icon: CreditCard },
    { id: 'admit-cards', label: 'Admit Cards', icon: Award },
    { id: 'my-exams', label: 'My Examinations', icon: ClipboardList },
    { id: 'instructions', label: 'Exam Instructions', icon: BookOpen },
    { id: 'results', label: 'Results & Merit List', icon: CheckCircle2 },
    { id: 'attendance', label: 'Exam Attendance', icon: CalendarCheck },
    { id: 'interview', label: 'Online Interview', icon: UserRound },
    { id: 'training', label: 'Online Training', icon: GraduationCap },
    { id: 'helpdesk', label: 'Helpdesk & Support', icon: LifeBuoy },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];
  const candidateSectionDescriptions: Record<string, string> = {
    dashboard: 'Your applications, upcoming exam dates, admit cards and published results at a glance.',
    profile: 'Your student account details and verified sign-in options.',
    'browse-exams': 'Search published examinations and check eligibility, dates, mode and fee details.',
    'apply-exam': 'Start an application for an examination whose registration window is open.',
    applications: 'Track the status of applications linked to your student account.',
    payments: 'Review fee information shown for your applications.',
    'admit-cards': 'Check your application status and open the secure admit-card lookup.',
    'my-exams': 'Open eligible online exams and review your completed practice tests.',
    instructions: 'Review published exam details and the instructions available for your exams.',
    results: 'View which results are published and open your secure scorecard lookup.',
    attendance: 'See attendance information when it is published for your account.',
    interview: 'Interview schedules will appear here when they are provided by the exam team.',
    training: 'Training courses will appear here when they are provided by the exam team.',
    helpdesk: 'Send a support request to the ELTNOY team and save its ticket reference.',
    settings: 'Manage linked sign-in options or securely sign out.',
  };
  const selectedCandidateSection = candidateNavItems.find((item) => item.id === activeCandidateSection) ?? candidateNavItems[0];
  const instituteSectionDescriptions: Record<string, string> = {
    'institute-overview': 'Manage examinations, applicants and institute activity in one place.',
    'institute-profile': 'Manage your institute profile and view institutional verification details.',
    'institute-forms': 'Prepare exam and recruitment listings for ELTNOY review.',
    'institute-exam-management': 'Track the approval status of institute examination listings.',
    'institute-applications': 'Review the public application links attached to approved institute listings.',
    'institute-checkins': 'Verify candidates assigned to your examination center and review recent check-ins.',
    'institute-wallet': 'View institute funds, wallet activity and withdrawal requests.',
    'institute-admit-cards': 'View guidance for admit-card access and exam-center coordination.',
    'institute-question-bank': 'Question authoring and answer keys are restricted to the ELTNOY examination team.',
    'institute-cbt-center': 'Use your assigned center code to verify and check in candidates.',
    'institute-results': 'ELTNOY publishes results for candidates through the public portal.',
    'institute-reports': 'Review live institute listing and assigned-center check-in counts.',
    'institute-staff': 'Manage staff invitations and institute roles.',
    'institute-attendance': 'Review candidate check-ins recorded at your assigned center.',
    'institute-interviews': 'Interview scheduling is not connected to institute accounts in this release.',
    'institute-training': 'Training courses and learner progress are not connected to institute accounts in this release.',
    'institute-settings': 'Manage institution documents and find support details.',
  };
  const renderInstituteNavItems = (variant: 'desktop' | 'mobile') => instituteNavItems.map((item) => {
    const Icon = item.icon;
    const active = activeInstituteSection === item.id;
    return (
      <button
        key={item.id}
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => jumpToInstituteSection(item.id)}
        className={`flex w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition ${variant === 'desktop' ? 'py-2.5' : 'py-3'} ${active ? 'bg-emerald-600 font-bold text-white shadow-sm' : variant === 'desktop' ? 'font-semibold text-slate-200 hover:bg-white/10' : 'font-semibold text-slate-200 hover:bg-white/10'}`}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1">{t(item.label)}</span>
        {!active && variant === 'mobile' && <ArrowRight className="h-4 w-4 shrink-0" />}
      </button>
    );
  });
  const openCandidateSection = (sectionId: string) => {
    setActiveCandidateSection(sectionId);
    setIsCandidateMenuOpen(false);
    setError(null);
    setNotice(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const renderCandidateNavItems = (variant: 'desktop' | 'mobile') => candidateNavItems.map((item) => {
    const Icon = item.icon;
    const active = activeCandidateSection === item.id;
    return (
      <button
        key={item.id}
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => openCandidateSection(item.id)}
        className={`flex w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition ${variant === 'desktop' ? 'py-2.5' : 'py-3'} ${active ? 'bg-blue-600 font-bold text-white shadow-sm' : 'font-semibold text-slate-200 hover:bg-white/10'}`}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1">{t(item.label)}</span>
        {!active && variant === 'mobile' && <ArrowRight className="h-4 w-4 shrink-0" />}
      </button>
    );
  });
  const navTabs: { id: DashboardTab; label: string }[] = user.role === 'official'
    ? [{ id: 'overview', label: 'Overview' }, { id: 'institutes', label: 'Institute approvals & wallet' }, { id: 'institution-documents', label: 'Institution documents' }, { id: 'exams', label: 'Exam forms' }, { id: 'notices', label: 'Latest updates' }, { id: 'admit-cards', label: 'Admit cards' }, { id: 'online-exams', label: 'Online exams' }, { id: 'answer-keys', label: 'Answer keys' }, { id: 'applications', label: 'Applications' }, { id: 'feedback', label: 'Helpdesk' }, { id: 'attempts', label: 'Mock tests' }, { id: 'results', label: 'Results' }, { id: 'data-export', label: 'Excel data' }, { id: 'platform-staff', label: 'Staff management' }, { id: 'institute-verification', label: 'Institutional verification' }]
    : [{ id: 'overview', label: 'Overview' }];
  const permissions = adminPermissions(user);
  const visibleNavTabs = navTabs.filter((item) => canSeeAdminTab(user, item.id));

  const list = (key: string) => Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : [];
  const record = (key: string) => typeof data[key] === 'object' && data[key] !== null
    ? data[key] as Record<string, unknown>
    : {};
  const instituteProfile = record('profile');
  const instituteDisplayName = typeof instituteProfile.display_name === 'string' && instituteProfile.display_name.trim()
    ? instituteProfile.display_name
    : user.name;
  const openWallet = () => {
    if (user.role === 'official') {
      setTab('institutes');
      window.setTimeout(() => document.getElementById('admin-institute-wallet')?.scrollIntoView({ behavior: 'smooth' }), 100);
      return;
    }
    setActiveInstituteSection('institute-wallet');
    setIsInstituteMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const jumpToInstituteSection = (sectionId: string) => {
    setActiveInstituteSection(sectionId);
    setIsInstituteMenuOpen(false);
    setError(null);
    setNotice(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const isLoading = Object.entries(sectionStatuses).some(
    ([key, status]) => key.startsWith(`${user.role}:`) && status.state === 'loading',
  );
  const currentSectionStatuses = Object.entries(sectionStatuses).filter(
    ([key]) => key.startsWith(`${user.role}:`),
  );
  const dashboardStats = record('stats');
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? value
    : '—';
  const candidateSectionState = (section: string) => getDashboardSectionContentState(
    sectionStatuses[`candidate:${section}`],
  );
  const candidateSectionStatus = (section: string, label: string) => {
    const state = candidateSectionState(section);
    if (state === 'loading') {
      return <LoadingState label={`Loading ${label.toLowerCase()}…`} className="justify-start px-0 py-5" />;
    }
    if (state === 'error') {
      return (
        <ErrorState
          title={`${label} unavailable`}
          description="We couldn't load this section. Please try again."
          onRetry={() => { void retryLoadRef.current[`candidate:${section}`]?.(); }}
          className="mt-4"
        />
      );
    }
    return null;
  };
  const candidateExamItems: ExamItem[] = list('candidateExams').flatMap((row) => {
    const examDate = String(row.examDate || '').slice(0, 10);
    const regStart = String(row.regStart || '').slice(0, 10);
    const regEnd = String(row.regEnd || '').slice(0, 10);
    if (!examDate || !regStart || !regEnd) return [];
    let parts: { day: string; month: string };
    let isOpen = false;
    try {
      parts = getDateOnlyParts(examDate);
      isOpen = isRegistrationOpen(regStart, regEnd, String(row.timeZone || DEFAULT_EXAM_TIME_ZONE));
    } catch {
      parts = { day: '—', month: '' };
    }
    return [{
      id: String(row.id || row.code || ''),
      code: String(row.code || ''),
      name: String(row.name || 'Examination'),
      category: String(row.category || 'Professional') as ExamItem['category'],
      targetAudience: String(row.targetAudience || ''),
      day: parts.day,
      month: parts.month,
      regStart,
      regEnd,
      examDate,
      timeZone: String(row.timeZone || DEFAULT_EXAM_TIME_ZONE),
      fee: String(row.fee || 'See exam details'),
      status: isOpen ? 'Apply Now' : 'Apply Soon',
      isButtonActive: isOpen,
      duration: String(row.duration || 'See exam instructions'),
      mode: String(row.mode || 'To be announced'),
      shifts: String(row.shifts || 'To be announced'),
      syllabusHighlights: [],
    }];
  });
  const candidateAppliedExamCodes = new Set(list('applications').map((item) => String(item.exam_code)));
  const candidateToday = currentDateInTimeZone(new Date(), DEFAULT_EXAM_TIME_ZONE);
  const filteredCandidateExams = candidateExamItems.filter((exam) => {
    const query = candidateExamSearch.trim().toLowerCase();
    const matchesSearch = !query || `${exam.name} ${exam.code} ${exam.category} ${exam.targetAudience}`.toLowerCase().includes(query);
    const matchesCategory = candidateExamCategory === 'all' || exam.category === candidateExamCategory;
    const matchesOpen = activeCandidateSection !== 'apply-exam' || exam.isButtonActive;
    return matchesSearch && matchesCategory && matchesOpen;
  });
  const submitCandidateTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmittingCandidateTicket(true);
    setError(null);
    setCandidateTicketId(null);
    try {
      const { entry } = await apiRequest<{ entry: { id: string } }>('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({
          type: candidateTicketType,
          title: candidateTicketTitle.trim(),
          description: candidateTicketDescription.trim(),
          module: 'Student portal',
          candidateName: user.name,
          email: candidateTicketEmail.trim() || undefined,
          applicationNumber: candidateTicketApplication.trim() || undefined,
          priority: 'medium',
        }),
      });
      setCandidateTicketId(entry.id);
      setCandidateTicketTitle('');
      setCandidateTicketDescription('');
    } catch (ticketError) {
      setError(ticketError instanceof Error ? ticketError.message : 'Could not submit your support request. Please try again.');
    } finally {
      setIsSubmittingCandidateTicket(false);
    }
  };
  const openCandidateExamApply = (exam: ExamItem) => {
    if (candidateAppliedExamCodes.has(exam.code)) {
      setNotice('Your account already has an application for this examination. Open My Applications to see its status.');
      return;
    }
    setCandidateApplyExam(exam);
  };
  const renderCandidateExams = (openOnly = false) => (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <span className="sr-only">Search examinations</span>
          <input value={candidateExamSearch} onChange={(event) => setCandidateExamSearch(event.target.value)} placeholder="Search by exam, code or eligibility" className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm" />
        </label>
        <label className="text-sm font-semibold text-slate-700">
          <span className="sr-only">Filter by category</span>
          <select value={candidateExamCategory} onChange={(event) => setCandidateExamCategory(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5">
            <option value="all">All categories</option>
            <option value="Undergraduate">Undergraduate</option>
            <option value="Scholarship">Scholarship</option>
            <option value="Teacher">Teacher</option>
            <option value="Professional">Professional</option>
          </select>
        </label>
      </div>
      {candidateSectionStatus('exams', 'Published examinations') ?? (filteredCandidateExams.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {filteredCandidateExams.map((exam) => {
            const applied = candidateAppliedExamCodes.has(exam.code);
            return (
              <article key={exam.code} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <span className="text-xs font-bold uppercase tracking-wide text-blue-700">{exam.category} · {exam.code}</span>
                    <h3 className="mt-1 text-lg font-extrabold text-[#0B2E59]">{exam.name}</h3>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${exam.isButtonActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{exam.isButtonActive ? 'Applications open' : 'Applications closed'}</span>
                </div>
                <p className="mt-2 text-sm text-slate-600">{exam.targetAudience}</p>
                <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-xs text-slate-500">Exam date</dt><dd className="font-semibold text-slate-800">{exam.examDate}</dd></div>
                  <div><dt className="text-xs text-slate-500">Registration</dt><dd className="font-semibold text-slate-800">{exam.regStart} – {exam.regEnd}</dd></div>
                  <div><dt className="text-xs text-slate-500">Mode & duration</dt><dd className="font-semibold text-slate-800">{exam.mode} · {exam.duration}</dd></div>
                  <div><dt className="text-xs text-slate-500">Published fee information</dt><dd className="font-semibold text-slate-800">{exam.fee}</dd></div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {openOnly || activeCandidateSection === 'apply-exam'
                    ? <button type="button" disabled={!exam.isButtonActive || applied} onClick={() => openCandidateExamApply(exam)} className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400">{applied ? 'Already applied' : exam.isButtonActive ? 'Start application' : 'Registration closed'}</button>
                    : <button type="button" onClick={() => openCandidateSection('apply-exam')} className="rounded-lg border border-blue-700 px-4 py-2.5 text-sm font-bold text-blue-800 hover:bg-blue-50">View application options</button>}
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">{openOnly ? 'There are no published examinations currently accepting applications.' : 'No published examinations match your search.'}</p>)}
    </>
  );

  useEffect(() => {
    const profile = record('profile');
    if (!instituteProfileDraft.displayName && typeof profile.display_name === 'string') {
      setInstituteProfileDraft({
        displayName: profile.display_name,
        contactEmail: String(profile.contact_email || ''),
        registrationNumber: String(profile.registration_number || ''),
        registeredAddress: String(profile.registered_address || ''),
        website: String(profile.website || ''),
      });
    }
  }, [data.profile]);

  // Display-only hint for the public site ("signed in as <Institute>, back to the dashboard"). It holds
  // only the display name; the real session stays host-only on the Institute site (utils/portalHint.ts).
  useEffect(() => {
    if (user.role !== 'center') return;
    savePortalHintInBrowser({ role: 'center', name: instituteDisplayName });
  }, [user.role, instituteDisplayName]);

  // The institute menu closes on Escape (from anywhere) and on a click or tap outside it.
  useEffect(() => {
    if (!isInstituteMenuOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsInstituteMenuOpen(false);
      instituteMenuButtonRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (instituteMenuRef.current?.contains(target) || instituteMenuButtonRef.current?.contains(target)) return;
      setIsInstituteMenuOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isInstituteMenuOpen]);

  useEffect(() => {
    if (!isCandidateMenuOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsCandidateMenuOpen(false);
      candidateMenuButtonRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (candidateMenuRef.current?.contains(target) || candidateMenuButtonRef.current?.contains(target)) return;
      setIsCandidateMenuOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isCandidateMenuOpen]);

  const instituteSectionErrors: Record<string, string> = {
    'center:checkins': 'Candidate check-ins could not be loaded',
    'center:workspace': 'Institute forms, profile and wallet could not be loaded',
  };
  const instituteSectionsByData: Record<string, string[]> = {
    'institute-overview': ['center:workspace', 'center:checkins'],
    'institute-profile': ['center:workspace'],
    'institute-forms': ['center:workspace'],
    'institute-exam-management': ['center:workspace'],
    'institute-applications': ['center:workspace'],
    'institute-checkins': ['center:checkins'],
    'institute-wallet': ['center:workspace'],
    'institute-cbt-center': ['center:checkins'],
    'institute-reports': ['center:workspace', 'center:checkins'],
    'institute-attendance': ['center:checkins'],
    'institute-settings': ['center:workspace'],
  };
  const relevantInstituteData = new Set(instituteSectionsByData[activeInstituteSection] ?? []);
  const failedInstituteSections = user.role === 'center'
    ? currentSectionStatuses.filter(([key, status]) => relevantInstituteData.has(key) && status.state === 'error' && instituteSectionErrors[key])
    : [];

  return (
    <main className={`min-h-screen text-slate-900 ${theme.shell}`}>
      {user.role === 'center' && import.meta.env.DEV && import.meta.env.VITE_ELTNOY_LIVE_PREVIEW === 'true' && (
        <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm font-semibold text-amber-950">
          {t('Live institute data is connected. Changes are disabled in this local preview.')}
        </div>
      )}
      {(user.role === 'center' || user.role === 'candidate') && (
        <div className="bg-[#0B2E59] text-white">
          <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-2 text-[11px] font-bold tracking-[0.12em] sm:px-6">
            <span className="uppercase">ELTNOY {t('Examination portal')}</span>
            <span className="hidden text-blue-100 sm:inline"><span className="uppercase">{t(user.role === 'center' ? 'Institute workspace' : 'Student workspace')}</span> · {user.role === 'center' ? instituteDisplayName : user.name}</span>
          </div>
        </div>
      )}
      <header className={`${user.role !== 'official' ? 'sticky top-0 z-40 bg-white text-slate-900 border-b border-slate-200 shadow-sm' : 'bg-gradient-to-r ' + theme.header + ' text-white shadow-md'}`}>
        {/* Student and institute headers keep navigation reachable on small screens. */}
        <div className={user.role !== 'official'
          ? 'relative mx-auto flex max-w-[1600px] items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6'
          : 'mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6'}
        >
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            {user.role === 'center' && (
              <button
                ref={instituteMenuButtonRef}
                type="button"
                aria-label={t(isInstituteMenuOpen ? 'Close institute workspace menu' : 'Open institute workspace menu')}
                aria-controls="institute-section-menu"
                aria-expanded={isInstituteMenuOpen}
                onClick={() => setIsInstituteMenuOpen((isOpen) => !isOpen)}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 lg:hidden"
              >
                {isInstituteMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
              </button>
            )}
            {user.role === 'candidate' && (
              <button
                ref={candidateMenuButtonRef}
                type="button"
                aria-label={t(isCandidateMenuOpen ? 'Close student workspace menu' : 'Open student workspace menu')}
                aria-controls="candidate-section-menu"
                aria-expanded={isCandidateMenuOpen}
                onClick={() => setIsCandidateMenuOpen((isOpen) => !isOpen)}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 lg:hidden"
              >
                {isCandidateMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
              </button>
            )}
            {user.role !== 'official' ? <BrandLogo compact /> : <BrandLogo compact light />}
            <div className={`min-w-0 ${user.role !== 'official' ? 'hidden lg:block' : ''}`}><p className="truncate font-black tracking-wide">{user.role === 'center' ? t('Institute Dashboard') : user.role === 'candidate' ? t('Student Dashboard') : `${t(detail.label)} ${t('Portal')}`}</p><p className={`truncate text-xs ${user.role !== 'official' ? 'text-slate-500' : 'text-slate-300'}`}>{user.role === 'center' ? instituteDisplayName : user.name} · {user.id}</p></div>
          </div>
          {user.role === 'center' ? (
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={onHome} className="hidden whitespace-nowrap rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 md:inline-flex">{t('Public website')}</button>
              <button type="button" aria-label={t('Open institute profile')} onClick={() => jumpToInstituteSection('institute-profile')} className="hidden h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 sm:grid"><UserRound className="h-5 w-5" /></button>
              {/* Below 320px the logo and these two buttons do not fit on one row: they move into the
                  menu ("Payments & fees" and the Sign out item at the bottom of the menu). */}
              <button type="button" onClick={openWallet} className="inline-flex h-10 min-w-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 max-[319px]:hidden sm:px-3">
                <Wallet className="h-4 w-4 shrink-0" /><span className="sr-only sm:not-sr-only">{t('Wallet')}</span>
              </button>
              <button type="button" onClick={() => void onLogout()} className="inline-flex h-10 min-w-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-emerald-600 px-2.5 text-sm font-bold text-white hover:bg-emerald-500 max-[319px]:hidden sm:px-3">
                <LogOut className="h-4 w-4 shrink-0" /><span className="sr-only sm:not-sr-only">{t('Sign out')}</span>
              </button>
            </div>
          ) : user.role === 'candidate' ? (
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <button type="button" onClick={onHome} className="hidden whitespace-nowrap rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 sm:inline-flex">{t('Public website')}</button>
              <button type="button" onClick={() => openCandidateSection('profile')} aria-label="Open student profile" className="grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"><UserRound className="h-5 w-5" /></button>
              <button type="button" onClick={() => void onLogout()} aria-label={t('Sign out')} className="grid h-10 w-10 place-items-center rounded-lg bg-blue-700 text-white hover:bg-blue-800"><LogOut className="h-4 w-4" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={onHome} className="rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/10">{t('Public website')}</button>
              {user.role === 'official' && (
                <button onClick={openWallet} className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm font-bold text-white hover:bg-white/20">
                  <Wallet className="h-4 w-4" /> {t('Wallet')}
                </button>
              )}
              <button onClick={() => void onLogout()} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold hover:bg-emerald-500"><LogOut className="h-4 w-4" /> {t('Sign out')}</button>
            </div>
          )}
          {user.role === 'center' && (
            <nav
              ref={instituteMenuRef}
              id="institute-section-menu"
              aria-label={t('Institute sections')}
              className={`${isInstituteMenuOpen ? 'block' : 'hidden'} absolute left-0 top-full z-50 mt-2 max-h-[calc(100vh-8rem)] w-[min(90vw,360px)] overflow-y-auto rounded-2xl border border-slate-200 bg-[#071E49] p-3 text-white shadow-2xl`}
            >
              <p className="px-3 pb-2 pt-1 text-xs font-black uppercase tracking-[0.16em] text-blue-200">{t('Institute workspace')}</p>
              <div className="space-y-1">
                {renderInstituteNavItems('mobile')}
              </div>
              {/* The header hides this link below the md breakpoint, so phones reach it here. */}
              <div className="mt-2 border-t border-white/15 pt-2 md:hidden">
                <button type="button" onClick={() => { setIsInstituteMenuOpen(false); onHome(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-semibold text-slate-200 hover:bg-white/10">
                  <Home className="h-5 w-5 shrink-0" />
                  <span>{t('Public website')}</span>
                </button>
                {/* Below 320px the header hides Sign out (see the header buttons above). */}
                <button type="button" onClick={() => { setIsInstituteMenuOpen(false); void onLogout(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-semibold text-slate-200 hover:bg-white/10 min-[320px]:hidden">
                  <LogOut className="h-5 w-5 shrink-0" />
                  <span>{t('Sign out')}</span>
                </button>
              </div>
            </nav>
          )}
          {user.role === 'candidate' && (
            <nav
              ref={candidateMenuRef}
              id="candidate-section-menu"
              aria-label={t('Student sections')}
              className={`${isCandidateMenuOpen ? 'block' : 'hidden'} absolute left-0 top-full z-50 mt-2 max-h-[calc(100vh-8rem)] w-[min(92vw,380px)] overflow-y-auto rounded-2xl border border-slate-200 bg-[#071E49] p-3 text-white shadow-2xl lg:hidden`}
            >
              <p className="px-3 pb-2 pt-1 text-xs font-black uppercase tracking-[0.16em] text-blue-200">Student workspace · 15 sections</p>
              <div className="space-y-1">{renderCandidateNavItems('mobile')}</div>
              <div className="mt-2 border-t border-white/15 pt-2 sm:hidden">
                <button type="button" onClick={() => { setIsCandidateMenuOpen(false); onHome(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-semibold text-slate-200 hover:bg-white/10"><Home className="h-5 w-5 shrink-0" /><span>{t('Public website')}</span></button>
              </div>
            </nav>
          )}
        </div>
      </header>
      <div className={`mx-auto flex w-full gap-5 px-4 py-7 sm:px-6 ${user.role !== 'official' ? 'max-w-[1600px]' : 'max-w-7xl'}`}>
        {user.role === 'center' && (
          <aside aria-label={t('Institute sections')} className="sticky top-[112px] hidden h-[calc(100vh-128px)] w-[252px] shrink-0 self-start flex-col overflow-hidden rounded-2xl bg-[#071E49] text-white shadow-lg lg:flex">
            <div className="border-b border-white/10 px-4 py-4">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-blue-200">{t('Institute workspace')}</p>
              <p className="mt-1 text-[11px] text-blue-100/70">17 operational sections</p>
            </div>
            <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label={t('Institute navigation')}>
              {renderInstituteNavItems('desktop')}
            </nav>
            <div className="border-t border-white/10 px-4 py-3">
              <p className="truncate text-xs font-bold">{instituteDisplayName}</p>
              <p className="mt-0.5 text-[10px] text-blue-100/70">{t('Center code')}: {user.id}</p>
            </div>
          </aside>
        )}
        {user.role === 'candidate' && (
          <aside aria-label={t('Student sections')} className="sticky top-[112px] hidden h-[calc(100vh-128px)] w-[260px] shrink-0 self-start flex-col overflow-hidden rounded-2xl bg-[#071E49] text-white shadow-lg lg:flex">
            <div className="border-b border-white/10 px-4 py-4">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-blue-200">Student workspace</p>
              <p className="mt-1 text-[11px] text-blue-100/70">Applications, exams and results</p>
            </div>
            <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label={t('Student navigation')}>
              {renderCandidateNavItems('desktop')}
            </nav>
            <div className="border-t border-white/10 px-4 py-3">
              <p className="truncate text-xs font-bold">{user.name}</p>
              <p className="mt-0.5 truncate text-[10px] text-blue-100/70">Student ID: {user.id}</p>
            </div>
          </aside>
        )}
        <div className="min-w-0 flex-1">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className={`text-xs font-bold uppercase tracking-[0.16em] ${
              user.role === 'official' || user.role === 'candidate' ? 'text-blue-800' : 'text-sky-800'
            }`}>{t(theme.eyebrow)}</p>
            <h1 className="mt-1 text-2xl font-black text-[#0B2E59] sm:text-3xl">{user.role === 'center' ? activeInstituteSection === 'institute-overview' ? t('Welcome back, {name}').replace('{name}', instituteDisplayName) : t(selectedInstituteSection.label) : user.role === 'candidate' ? activeCandidateSection === 'dashboard' ? `Welcome back, ${user.name}` : t(selectedCandidateSection.label) : `${t(detail.title.replace('Login', '').trim())} ${t('Dashboard')}`}</h1>
            <p className="mt-1 text-sm text-slate-600">{user.role === 'center' ? t(instituteSectionDescriptions[activeInstituteSection]) : user.role === 'candidate' ? t(candidateSectionDescriptions[activeCandidateSection]) : t(theme.description)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {user.role === 'center' && activeInstituteSection === 'institute-overview' && (
              <>
                <button type="button" onClick={() => jumpToInstituteSection('institute-forms')} className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-emerald-700 bg-white px-4 py-2.5 text-sm font-bold text-emerald-800 shadow-sm hover:bg-emerald-50"><PlusCircle className="h-4 w-4" />{t('Create institute form')}</button>
                <button type="button" onClick={() => jumpToInstituteSection('institute-checkins')} className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-emerald-600"><ClipboardCheck className="h-4 w-4" />{t('Verify candidate')}</button>
              </>
            )}
            {user.role === 'candidate' && activeCandidateSection === 'dashboard' && (
              <>
                <button type="button" onClick={() => openCandidateSection('browse-exams')} className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-blue-700 bg-white px-4 py-2.5 text-sm font-bold text-blue-800 shadow-sm hover:bg-blue-50"><Search className="h-4 w-4" />Browse exams</button>
                <button type="button" onClick={() => openCandidateSection('apply-exam')} className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-800"><PlusCircle className="h-4 w-4" />Apply now</button>
              </>
            )}
            <button onClick={() => void refresh()} disabled={isLoading} className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> {t('Refresh')}</button>
          </div>
        </div>
        {notice && <div role="status" className="mb-4 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></div>}
        {error && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><p>{error}</p></div>}
        {failedInstituteSections.length > 0 && (
          <div className="mb-5 space-y-3">
            {failedInstituteSections.map(([key]) => (
              <ErrorState
                key={key}
                title={t(instituteSectionErrors[key])}
                description={t('Figures that depend on this data show “—” until it loads. Please try again.')}
                retryLabel={t('Try again')}
                onRetry={() => { void retryLoadRef.current[key]?.(); }}
              />
            ))}
          </div>
        )}
        {user.role === 'official' && currentSectionStatuses.length > 0 && (
          <section aria-label="Dashboard data loading status" className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-bold text-slate-800">{t('Dashboard data status')}</h2>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {currentSectionStatuses.map(([key, status]) => {
                const name = key.slice(user.role.length + 1).replaceAll('-', ' ');
                return (
                  <li key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                    <span className="capitalize font-medium text-slate-700">{t(name)}</span>
                    {status.state === 'loading'
                      ? <span role="status" className="text-slate-500">{t('Loading…')}</span>
                      : status.state === 'success'
                        ? <span className="text-emerald-700">{t('Loaded')}</span>
                        : <span className="flex flex-wrap items-center gap-2 text-rose-700">
                            <span role="alert">{status.error}</span>
                            <button
                              type="button"
                              onClick={() => void retryLoadRef.current[key]?.()}
                              className="rounded border border-rose-300 bg-white px-2 py-1 font-semibold"
                            >
                              {t('Retry')}
                            </button>
                          </span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {user.role === 'official' && (
          <nav aria-label="Dashboard sections" className="mb-5 flex flex-wrap gap-2">
            {visibleNavTabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm font-bold ${tab === item.id ? 'bg-blue-900 text-white shadow-sm' : 'bg-white text-slate-600 hover:bg-blue-50'}`}>{t(item.label)}</button>)}
          </nav>
        )}
        {user.role === 'official' && tab === 'institution-documents' && (
          <InstitutionDocumentManagement role="official" canOpenDocuments={permissions.canOpenInstitutionDocuments} canReviewDocuments={permissions.canReviewInstitutionDocuments} />
        )}
            {user.role === 'official' && tab === 'notices' && (
              <section className="space-y-5">
                <form onSubmit={(event) => void createPortalNotice(event)} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div>
                    <h2 className="text-lg font-extrabold text-[#0B2E59]">Create a portal notice draft</h2>
                    <p className="mt-1 text-sm text-slate-600">Published notices appear automatically in the scrolling Latest Updates bar, Public Notices, and site search.</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-semibold text-slate-700">Notice title
                      <input required minLength={8} maxLength={180} value={noticeDraft.title} onChange={(event) => setNoticeDraft((draft) => ({ ...draft, title: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" placeholder="Enter a clear announcement title" />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">Category
                      <select value={noticeDraft.category} onChange={(event) => setNoticeDraft((draft) => ({ ...draft, category: event.target.value as NoticeDraft['category'] }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal">
                        {(['Registration', 'Admit Card', 'Answer Key', 'Result', 'Circular'] as const).map((category) => <option key={category} value={category}>{category}</option>)}
                      </select>
                    </label>
                    <label className="text-sm font-semibold text-slate-700 sm:col-span-2">Short summary
                      <textarea required minLength={10} maxLength={500} rows={2} value={noticeDraft.summary} onChange={(event) => setNoticeDraft((draft) => ({ ...draft, summary: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" placeholder="Short description shown in notices and search" />
                    </label>
                    <label className="text-sm font-semibold text-slate-700 sm:col-span-2">Full notice details
                      <textarea required minLength={10} maxLength={10000} rows={6} value={noticeDraft.fullContent} onChange={(event) => setNoticeDraft((draft) => ({ ...draft, fullContent: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" placeholder="Write the full notice. Line breaks are preserved." />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">Reference number
                      <input required minLength={3} maxLength={80} pattern="[A-Za-z0-9._/-]+" value={noticeDraft.referenceNumber} onChange={(event) => setNoticeDraft((draft) => ({ ...draft, referenceNumber: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono font-normal" placeholder="ELTNOY/NOTICE/2026/001" />
                    </label>
                  </div>
                  <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{SUPER_ADMIN_ONLY_TEXT.noticePublishing}</p>
                  <button disabled={isSavingNotice} type="submit" className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-60">{isSavingNotice ? 'Saving…' : 'Save notice draft'}</button>
                </form>

                <section className="space-y-3">
                  <div>
                    <h2 className="text-lg font-extrabold text-[#0B2E59]">Published and unpublished updates</h2>
                    <p className="text-sm text-slate-600">Unpublished notices are hidden from the public site.</p>
                  </div>
                  {list('notices').length ? list('notices').map((item) => (
                    <article key={String(item.id)} className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-bold text-slate-900">{String(item.title)}</h3>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${item.is_published ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{item.is_published ? 'Published' : 'Draft'}</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{String(item.category)} · {String(item.reference_number)} · {new Date(String(item.created_at)).toLocaleString()}</p>
                        <p className="mt-2 text-sm text-slate-600">{String(item.summary)}</p>
                      </div>
                      {permissions.canPublishNotices
                        ? <button type="button" onClick={() => void publishAdminRecord(`/api/admin/notices/${encodeURIComponent(String(item.id))}`, !Boolean(item.is_published), 'Notice')} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">{item.is_published ? 'Unpublish' : 'Publish'}</button>
                        : <span className="text-xs text-slate-500">{SUPER_ADMIN_ONLY_TEXT.noticePublishing}</span>}
                    </article>
                  )) : <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">No portal updates yet. Publish the first notice above.</p>}
                </section>
              </section>
            )}

            {user.role === 'official' && tab === 'admit-cards' && (
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-start gap-3">
                  <Upload className="mt-1 h-5 w-5 text-blue-800" />
                  <div>
                    <h2 className="text-lg font-extrabold text-[#0B2E59]">Bulk admit-card upload</h2>
                    <p className="mt-1 text-sm text-slate-600">Upload an Excel workbook with an AdmitCards worksheet. Rows are matched to existing applications and published immediately; the whole upload rolls back if any row is invalid.</p>
                    {!permissions.canWriteAdmitCards && <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{SUPER_ADMIN_ONLY_TEXT.admitCards}</p>}
                    {permissions.canWriteAdmitCards && <>
                    <button type="button" onClick={downloadUploadTemplates} className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline"><Download className="h-4 w-4" /> Download Excel templates</button>
                    <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm font-semibold text-slate-700 hover:bg-blue-50">
                      <Upload className="h-5 w-5" />
                      {uploading === 'admit-cards' ? 'Uploading…' : 'Choose admit-card workbook (.xlsx)'}
                      <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={uploading !== null} onChange={(event) => { void uploadWorkbook('admit-cards', event.target.files?.[0]); event.target.value = ''; }} />
                    </label>
                    <p className="mt-2 text-xs text-slate-500">Required columns are provided in the template. A successful upload publishes cards so candidates can look them up.</p>
                    </>}
                  </div>
                </div>
              </section>
            )}

            {user.role === 'official' && tab === 'online-exams' && (
              <section className="space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Create online exam from Excel</h2>
                  <p className="mt-1 text-sm text-slate-600">Upload one exam per workbook. Questions and correct answers are stored server-side; candidates never receive the answer key. New or replaced rows stay unpublished until reviewed.</p>
                  {!permissions.canCorrectPublishedContent && <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{SUPER_ADMIN_ONLY_TEXT.draftImports} {SUPER_ADMIN_ONLY_TEXT.publishing}</p>}
                  <button type="button" onClick={downloadUploadTemplates} className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline"><Download className="h-4 w-4" /> Download Excel templates</button>
                  <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm font-semibold text-slate-700 hover:bg-blue-50">
                    <Upload className="h-5 w-5" />
                    {uploading === 'online-exams' ? 'Uploading…' : 'Choose online-exam question workbook (.xlsx)'}
                    <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={uploading !== null} onChange={(event) => { void uploadWorkbook('online-exams', event.target.files?.[0]); event.target.value = ''; }} />
                  </label>
                </div>
                <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Exam</th><th className="p-4">Questions</th><th className="p-4">Duration</th><th className="p-4">Status</th><th className="p-4">Action</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">{list('onlineExams').map((exam) => <tr key={String(exam.exam_code)}><td className="p-4 font-bold">{String(exam.exam_name)}<span className="block text-xs text-slate-500">{String(exam.exam_code)}</span></td><td className="p-4">{String(exam.question_count)}</td><td className="p-4">{String(exam.duration_minutes)} min</td><td className="p-4">{exam.is_published ? 'Published' : 'Draft'}</td><td className="p-4">{permissions.canPublishOnlineExams ? <button type="button" onClick={() => void publishAdminRecord(`/api/admin/online-exams/${encodeURIComponent(String(exam.exam_code))}`, !Boolean(exam.is_published), 'Online exam')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">{exam.is_published ? 'Unpublish' : 'Publish exam'}</button> : <span className="text-xs text-slate-500">Super Admin only</span>}</td></tr>)}</tbody>
                  </table>
                </section>
              </section>
            )}

            {user.role === 'official' && tab === 'answer-keys' && (
              <section className="space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Upload official answer keys</h2>
                  <p className="mt-1 text-sm text-slate-600">Import exam-specific questions and correct options from the AnswerKeys worksheet. Imports remain drafts; publish only after verification.</p>
                  {!permissions.canCorrectPublishedContent && <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{SUPER_ADMIN_ONLY_TEXT.draftImports} {SUPER_ADMIN_ONLY_TEXT.publishing}</p>}
                  <button type="button" onClick={downloadUploadTemplates} className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline"><Download className="h-4 w-4" /> Download Excel templates</button>
                  <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm font-semibold text-slate-700 hover:bg-blue-50">
                    <Upload className="h-5 w-5" />
                    {uploading === 'answer-keys' ? 'Uploading…' : 'Choose answer-key workbook (.xlsx)'}
                    <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={uploading !== null} onChange={(event) => { void uploadWorkbook('answer-keys', event.target.files?.[0]); event.target.value = ''; }} />
                  </label>
                </div>
                <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                  <table className="w-full min-w-[600px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Exam</th><th className="p-4">Questions</th><th className="p-4">Status</th><th className="p-4">Action</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">{list('answerKeys').map((exam) => <tr key={String(exam.exam_code)}><td className="p-4 font-bold">{String(exam.exam_code)}</td><td className="p-4">{String(exam.question_count)}</td><td className="p-4">{exam.is_published ? 'Published' : 'Draft'}</td><td className="p-4">{permissions.canPublishAnswerKeys ? <button type="button" onClick={() => void publishAdminRecord(`/api/admin/answer-keys/${encodeURIComponent(String(exam.exam_code))}`, !Boolean(exam.is_published), 'Answer key')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">{exam.is_published ? 'Unpublish' : 'Publish key'}</button> : <span className="text-xs text-slate-500">Super Admin only</span>}</td></tr>)}</tbody>
                  </table>
                </section>
              </section>
            )}

            {user.role === 'official' && user.isSuperAdmin && tab === 'platform-staff' && <PlatformStaffAdminPanel />}
            {user.role === 'official' && user.isSuperAdmin && tab === 'institute-verification' && <InstituteVerificationPanel />}

            {user.role === 'official' && user.isSuperAdmin && tab === 'data-export' && (
              <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-start gap-4">
                  <Download className="mt-1 h-6 w-6 text-blue-800" />
                  <div>
                    <h2 className="text-lg font-extrabold text-[#0B2E59]">Download complete admin data</h2>
                    <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Export operational records into one Excel workbook with separate worksheets for accounts, applications, exams, notices, admit cards, check-ins, helpdesk, practice attempts, results, answer keys, and online exams.</p>
                    <p className="mt-2 text-xs text-slate-500">Passwords, password hashes, session tokens, and session records are never included. Applicant personal details in the workbook must be handled securely.</p>
                    <button type="button" onClick={() => void downloadAdminWorkbook()} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-800"><Download className="h-4 w-4" /> Download Excel workbook</button>
                  </div>
                </div>
              </section>
            )}

            {user.role === 'official' && tab === 'exams' && (
              <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                <form onSubmit={(event) => void createExam(event)} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center gap-2">
                    <PlusCircle className="h-5 w-5 text-emerald-700" />
                    <div>
                      <h2 className="text-lg font-extrabold text-[#0B2E59]">Create exam application form</h2>
                      <p className="text-xs text-slate-500">New forms stay hidden until you publish them.</p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-semibold text-slate-700">Exam code
                      <input required maxLength={30} pattern="[A-Za-z0-9-]+" value={examDraft.code} onChange={(event) => setExamField('code', event.target.value.toUpperCase())} placeholder="e.g. ENT-2027" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm uppercase" />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">Exam category
                      <select value={examDraft.category} onChange={(event) => setExamField('category', event.target.value as ExamDraft['category'])} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm">
                        <option value="Undergraduate">Undergraduate</option><option value="Scholarship">Scholarship</option><option value="Teacher">Teacher</option><option value="Professional">Professional</option>
                      </select>
                    </label>
                  </div>
                  <label className="block text-sm font-semibold text-slate-700">Public exam title
                    <input required maxLength={160} value={examDraft.name} onChange={(event) => setExamField('name', event.target.value)} placeholder="Exam name shown to candidates" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">Who can apply?
                    <input required maxLength={200} value={examDraft.targetAudience} onChange={(event) => setExamField('targetAudience', event.target.value)} placeholder="Eligibility summary / target candidates" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <label className="text-sm font-semibold text-slate-700">Applications open
                      <input required type="date" value={examDraft.regStart} onChange={(event) => setExamField('regStart', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2.5 text-sm" />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">Applications close
                      <input required type="date" min={examDraft.regStart || undefined} value={examDraft.regEnd} onChange={(event) => setExamField('regEnd', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2.5 text-sm" />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">Exam date
                      <input required type="date" value={examDraft.examDate} onChange={(event) => setExamField('examDate', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2.5 text-sm" />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">Exam time zone
                      <input required maxLength={64} value={examDraft.timeZone} onChange={(event) => setExamField('timeZone', event.target.value)} placeholder="Asia/Kolkata" aria-describedby="exam-time-zone-help" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                      <span id="exam-time-zone-help" className="mt-1 block text-xs font-normal text-slate-500">IANA name, e.g. Europe/London</span>
                    </label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-semibold text-slate-700">Application fee (display only)
                      <input required maxLength={80} value={examDraft.fee} onChange={(event) => setExamField('fee', event.target.value)} placeholder="Free / ₹ amount" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">Duration
                      <input required maxLength={80} value={examDraft.duration} onChange={(event) => setExamField('duration', event.target.value)} placeholder="e.g. 120 minutes" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                    </label>
                  </div>
                  <label className="block text-sm font-semibold text-slate-700">Exam mode
                    <input required maxLength={100} value={examDraft.mode} onChange={(event) => setExamField('mode', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">Shift / timing information
                    <input required maxLength={200} value={examDraft.shifts} onChange={(event) => setExamField('shifts', event.target.value)} placeholder="Exam schedule details" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                  </label>
                  <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Publishing makes this form public. The fee is informational only; online payment and file uploads are not configured.</p>
                  <button disabled={isSavingExam} type="submit" className="inline-flex items-center gap-2 rounded-lg bg-[#0B2E59] px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-900 disabled:opacity-60">
                    <PlusCircle className="h-4 w-4" /> {isSavingExam ? 'Saving draft…' : 'Save as draft'}
                  </button>
                </form>

                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div><h2 className="text-lg font-extrabold text-[#0B2E59]">Exam forms</h2><p className="text-xs text-slate-500">Only published forms appear on the public website.</p></div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{list('exams').length} total</span>
                  </div>
                  {list('exams').length ? (
                    <div className="space-y-3">
                      {list('exams').map((exam) => (
                        <article key={String(exam.id)} className="rounded-lg border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2"><h3 className="font-bold text-slate-900">{String(exam.name)}</h3><span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs">{String(exam.code)}</span></div>
                              <p className="mt-1 text-xs text-slate-500">Apply: {String(exam.regStart)} — {String(exam.regEnd)} · Exam: {String(exam.examDate)} · {String(exam.timeZone)}</p>
                            </div>
                            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${exam.isPublished ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{exam.isPublished ? 'Published' : 'Draft'}</span>
                          </div>
                          <p className="mt-2 text-sm text-slate-600">{String(exam.targetAudience)} · Fee shown: {String(exam.fee)}</p>
                          <button type="button" onClick={() => void setExamPublished(String(exam.id), !Boolean(exam.isPublished))} className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold ${exam.isPublished ? 'border border-slate-300 text-slate-700 hover:bg-slate-50' : 'bg-emerald-700 text-white hover:bg-emerald-600'}`}>
                            {exam.isPublished ? <><EyeOff className="h-4 w-4" /> Unpublish</> : <><Eye className="h-4 w-4" /> Publish on website</>}
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">No exam forms yet. Create one and publish it when verified.</p>}
                </section>
              </div>
            )}

            {user.role === 'official' && tab === 'institutes' && (
              <div className="space-y-5">
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-lg font-extrabold text-[#0B2E59]">Pending document-submission cycles</h2>
                <p className="mt-1 text-sm text-slate-500">Review visibility only. Category counts do not satisfy or enforce an approval gate; document uploads and completeness policy remain disabled.</p>
                {list('institutionSubmissionCycles').length ? (
                  <div className="mt-3 space-y-3">
                    {list('institutionSubmissionCycles').map((submission) => {
                      const counts = submission.category_counts && typeof submission.category_counts === 'object'
                        ? submission.category_counts as Record<string, unknown>
                        : {};
                      const missing = Array.isArray(submission.missing_categories)
                        ? submission.missing_categories.map(String)
                        : [];
                      const hasCycle = Boolean(submission.cycle_id);
                      return (
                        <article key={String(submission.institution_id)} className="rounded-lg border border-slate-200 p-4">
                          <div className="flex flex-wrap justify-between gap-2">
                            <div>
                              <h3 className="font-bold text-slate-900">{String(submission.display_name)}</h3>
                              <p className="text-xs text-slate-500">{String(submission.login_id)} · Account {String(submission.account_status)}</p>
                            </div>
                            <span className="text-xs font-semibold text-slate-600">
                              {hasCycle
                                ? `Cycle ${String(submission.submission_version)} · ${String(submission.source_type)}`
                                : 'No submission cycle recorded'}
                            </span>
                          </div>
                          <p className="mt-2 text-sm text-slate-700">
                            {hasCycle
                              ? `Documents by confirmed category: ${Object.entries(counts).map(([category, count]) => `${category}: ${String(count)}`).join(' · ')}`
                              : 'This existing pending account predates submission-cycle tracking.'}
                          </p>
                          {hasCycle && missing.length > 0 && (
                            <p className="mt-1 text-xs text-slate-500">No document record yet for: {missing.join(', ')}</p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : <p className="mt-3 text-sm text-slate-500">No pending submission cycles are available.</p>}
              </section>
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Institute registration requests</h2>
                  <p className="mt-1 text-sm text-slate-500">Approve access only after independently verifying the institute. Institute forms, profile changes, credits, and withdrawals are managed separately below.</p>
                </div>
                {list('institutes').length ? (
                  <div className="space-y-3">
                    {list('institutes').map((institute) => (
                      <article key={String(institute.id)} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 p-4">
                        <div>
                          <h3 className="font-bold text-slate-900">{String(institute.display_name)}</h3>
                          <p className="mt-1 text-sm text-slate-600">Institute ID: <span className="font-mono">{String(institute.login_id)}</span></p>
                          <p className="text-sm text-slate-600">Contact: {String(institute.contact_email || 'Not provided')}</p>
                          <p className="mt-1 text-sm text-slate-600">Registration no.: <span className="font-mono">{String(institute.registration_number || 'Not provided')}</span></p>
                          <p className="text-sm text-slate-600">Registered address: {String(institute.registered_address || 'Not provided')}</p>
                          {typeof institute.website === 'string' && institute.website.length > 0 && <p className="text-sm text-slate-600">Website: {institute.website}</p>}
                          <p className="mt-1 text-xs text-slate-500">Submitted {new Date(String(institute.created_at)).toLocaleString()}</p>
                        </div>
                        <div className="flex flex-col items-start gap-2">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${
                            institute.account_status === 'approved' ? 'bg-emerald-100 text-emerald-800'
                              : institute.account_status === 'rejected' ? 'bg-rose-100 text-rose-800'
                                : 'bg-amber-100 text-amber-800'
                          }`}>{String(institute.account_status)}</span>
                          {institute.account_status === 'pending' && (
                            <div className="space-y-2">
                              <label className="block text-xs font-semibold text-slate-700">
                                Decision reason (10–1,000 characters)
                                <textarea
                                  required
                                  minLength={10}
                                  maxLength={1000}
                                  rows={2}
                                  value={institutionDecisionReasons[String(institute.id)] || ''}
                                  onChange={(event) => setInstitutionDecisionReasons((reasons) => ({
                                    ...reasons,
                                    [String(institute.id)]: event.target.value,
                                  }))}
                                  className="mt-1 block w-full min-w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal"
                                />
                              </label>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  disabled={savingInstitutionDecisionId === institute.id || (institutionDecisionReasons[String(institute.id)] || '').trim().length < 10}
                                  onClick={() => void setInstituteApproval(String(institute.id), 'approved', institutionDecisionReasons[String(institute.id)] || '')}
                                  className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-50"
                                >Approve access</button>
                                <button
                                  type="button"
                                  disabled={savingInstitutionDecisionId === institute.id || (institutionDecisionReasons[String(institute.id)] || '').trim().length < 10}
                                  onClick={() => void setInstituteApproval(String(institute.id), 'rejected', institutionDecisionReasons[String(institute.id)] || '')}
                                  className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                                >Reject</button>
                              </div>
                            </div>
                          )}

                        </div>
                      </article>
                    ))}
                  </div>
                ) : <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">No institute registrations yet.</p>}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-lg font-extrabold text-[#0B2E59]">Institute form review</h2>
                {list('instituteForms').length ? <div className="mt-3 space-y-3">{list('instituteForms').map((form) => <article key={String(form.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-slate-900">{String(form.title)}</h3><p className="text-xs text-slate-500">{String(form.institute_name)} · {String(form.login_id)} · {form.form_type === 'teacher_recruitment' ? 'Teacher recruitment' : 'Exam application'}</p></div><span className="text-xs font-bold capitalize text-slate-600">{String(form.status)}</span></div><p className="mt-2 text-sm text-slate-700">{String(form.description)}</p><p className="mt-1 text-xs text-slate-500">Eligibility: {String(form.eligibility)}{form.application_deadline ? ` · Deadline: ${String(form.application_deadline).slice(0, 10)}` : ''}</p>{typeof form.external_url === 'string' && <a href={form.external_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-semibold text-blue-800 underline">Application link</a>}{form.status === 'pending' && <div className="mt-3 flex gap-2"><button type="button" onClick={() => void reviewInstituteRecord(`/api/admin/institute-forms/${encodeURIComponent(String(form.id))}`, 'approved', 'Institute form approved and published.')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white">Approve and publish</button><button type="button" onClick={() => void reviewInstituteRecord(`/api/admin/institute-forms/${encodeURIComponent(String(form.id))}`, 'rejected', 'Institute form rejected.')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700">Reject</button></div>}</article>)}</div> : <p className="mt-3 text-sm text-slate-500">No institute forms submitted.</p>}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-lg font-extrabold text-[#0B2E59]">Profile change approvals</h2>
                {list('profileChanges').length ? <div className="mt-3 space-y-3">{list('profileChanges').map((change) => <article key={String(change.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-bold">{String(change.display_name)}</h3><p className="text-xs text-slate-500">{String(change.login_id)} · Current name: {String(change.current_name)}</p></div><span className="text-xs font-bold capitalize">{String(change.status)}</span></div><p className="mt-2 text-sm text-slate-600">{String(change.contact_email)} · Registration: {String(change.registration_number)}</p><p className="text-sm text-slate-600">{String(change.registered_address)}</p>{typeof change.website === 'string' && change.website && <p className="text-sm text-slate-600">{change.website}</p>}{change.status === 'pending' && <div className="mt-3 flex gap-2"><button type="button" onClick={() => void reviewInstituteRecord(`/api/admin/institute-profile-changes/${encodeURIComponent(String(change.id))}`, 'approved', 'Institute profile updated after approval.')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white">Approve changes</button><button type="button" onClick={() => void reviewInstituteRecord(`/api/admin/institute-profile-changes/${encodeURIComponent(String(change.id))}`, 'rejected', 'Institute profile change rejected.')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700">Reject</button></div>}</article>)}</div> : <p className="mt-3 text-sm text-slate-500">No profile change requests.</p>}
              </section>

              <section id="admin-institute-wallet" className="scroll-mt-24 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="flex items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><Wallet className="h-5 w-5" /> Institute wallet management</h2>
                <p className="mt-1 text-sm text-slate-500">Before recording a credit, independently verify the application-fee payment. This does not connect to a payment gateway.</p>
                {!permissions.canCreditWallets && <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{SUPER_ADMIN_ONLY_TEXT.wallet}</p>}
                <div className="mt-3 space-y-3">{list('institutes').filter((institute) => institute.account_status === 'approved').map((institute) => {
                  const balance = list('walletBalances').find((item) => item.institute_id === institute.id);
                  return <article key={String(institute.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-bold">{String(institute.display_name)}</h3><p className="text-xs text-slate-500">{String(institute.login_id)}</p></div><strong>{formatPaise(balance?.balance_paise ?? 0)}</strong></div>{permissions.canCreditWallets && <form onSubmit={(event) => void recordInstituteCredit(event, String(institute.id))} className="mt-3 grid gap-2 sm:grid-cols-[140px_1fr_1fr_auto]"><input name="amount" required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" placeholder="Amount ₹" aria-label="Credit amount in rupees" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input name="paymentReference" required minLength={3} maxLength={120} pattern="[A-Za-z0-9._/-]+" placeholder="Verified payment reference" aria-label="Verified payment reference" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input name="description" required minLength={3} maxLength={300} placeholder="Reason / fee details" aria-label="Credit description" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><button type="submit" className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">Record credit</button></form>}</article>;
                })}</div>
                <h3 className="mt-6 font-bold text-slate-800">Withdrawal requests</h3>
                {list('withdrawals').length ? <div className="mt-3 space-y-3">{list('withdrawals').map((withdrawal) => <article key={String(withdrawal.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-2"><div><strong>{String(withdrawal.institute_name)} · {String(withdrawal.login_id)}</strong><p className="text-sm">{formatPaise(withdrawal.amount_paise)} · <span className="capitalize">{String(withdrawal.status)}</span></p></div><span className="text-xs text-slate-500">{new Date(String(withdrawal.created_at)).toLocaleDateString()}</span></div>{permissions.canManageWithdrawals && withdrawal.status === 'pending' && <div className="mt-3 flex gap-2"><button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'approved')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white">Approve</button><button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'rejected')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700">Reject</button></div>}{permissions.canManageWithdrawals && withdrawal.status === 'approved' && (() => { const paymentState = withdrawalPaymentState(user, withdrawal); return <div className="mt-3 flex flex-wrap gap-2">{paymentState === 'allowed' ? <><input value={transferReferences[String(withdrawal.id)] || ''} onChange={(event) => setTransferReferences((refs) => ({ ...refs, [String(withdrawal.id)]: event.target.value }))} required minLength={3} maxLength={120} pattern="[A-Za-z0-9._/-]+" placeholder="Manual transfer reference" aria-label={`Manual transfer reference for ${String(withdrawal.login_id)}`} className="min-w-60 rounded-lg border border-slate-300 px-3 py-2 text-sm" /><button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'paid')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">Mark paid</button></> : <p role="note" className="basis-full text-xs text-amber-800">{paymentState === 'maker_checker' ? SUPER_ADMIN_ONLY_TEXT.makerChecker : SUPER_ADMIN_ONLY_TEXT.approverUnknown}</p>}<button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'rejected')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700">Cancel approval</button></div>; })()}</article>)}</div> : <p className="mt-2 text-sm text-slate-500">No withdrawal requests.</p>}
              </section>
              </div>
            )}

            {user.role === 'center' && activeInstituteSection === 'institute-overview' && (
              <InstituteDashboardOverview
                centerCode={user.id}
                forms={list('forms')}
                checkins={list('checkins')}
                summary={data.dashboardSummary}
                workspaceState={getDashboardSectionContentState(sectionStatuses['center:workspace'])}
                checkinsState={getDashboardSectionContentState(sectionStatuses['center:checkins'])}
                availableBalance={data.availablePaise === undefined ? '—' : formatPaise(data.availablePaise)}
                onOpenForms={() => jumpToInstituteSection('institute-forms')}
                onVerifyCandidate={() => jumpToInstituteSection('institute-checkins')}
                onOpenProfile={() => jumpToInstituteSection('institute-profile')}
                onOpenWallet={openWallet}
              />
            )}
            {user.role === 'official' && tab === 'overview' && (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: 'Applications', value: count(dashboardStats.applications), icon: FileText },
                  ...(permissions.canSeeHelpdeskCount ? [{ label: 'Open helpdesk tickets', value: count(dashboardStats.openHelpdesk), icon: ClipboardCheck }] : []),
                  { label: 'Mock test attempts', value: count(dashboardStats.mockExamAttempts), icon: Award },
                  { label: 'Published results', value: count(dashboardStats.publishedResults), icon: CheckCircle2 },
                ].map((item) => {
                  const CardIcon = item.icon;
                  return <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-500">{item.label}</p><CardIcon className="h-5 w-5 text-emerald-700" /></div><p className="mt-3 text-2xl font-black text-[#0B2E59]">{item.value}</p></article>;
                })}
              </div>
            )}
            {user.role === 'candidate' && activeCandidateSection === 'dashboard' && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    { label: 'My applications', value: candidateSectionState('portal') === 'success' ? list('applications').length : '—', icon: FileText, section: 'applications' },
                    { label: 'Upcoming exams', value: candidateSectionState('portal') === 'success' && candidateSectionState('exams') === 'success' ? list('applications').filter((application) => {
                      const exam = candidateExamItems.find((item) => item.code === String(application.exam_code));
                      return Boolean(exam && exam.examDate >= candidateToday);
                    }).length : '—', icon: CalendarDays, section: 'my-exams' },
                    { label: 'Admit cards', value: candidateSectionState('portal') === 'success' ? list('applications').filter((application) => Boolean(application.roll_number)).length : '—', icon: Award, section: 'admit-cards' },
                    { label: 'Published results', value: candidateSectionState('portal') === 'success' ? list('results').length : '—', icon: CheckCircle2, section: 'results' },
                  ].map((item) => {
                    const CardIcon = item.icon;
                    return <button type="button" key={item.label} onClick={() => openCandidateSection(item.section)} className="rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-500">{item.label}</p><CardIcon className="h-5 w-5 text-blue-700" /></div><p className="mt-3 text-2xl font-black text-[#0B2E59]">{item.value}</p></button>;
                  })}
                </div>
                <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
                  <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-extrabold text-[#0B2E59]">Application progress</h2><p className="mt-1 text-xs text-slate-500">Status comes from your linked applications.</p></div><button type="button" onClick={() => openCandidateSection('applications')} className="text-sm font-bold text-blue-700 hover:underline">View all</button></div>
                    {candidateSectionStatus('portal', 'Applications') ?? (list('applications').length ? <div className="mt-4 space-y-3">{list('applications').slice(0, 5).map((item) => <article key={String(item.application_number)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 p-4"><div><p className="font-bold text-slate-900">{String(item.exam_code)}</p><p className="mt-1 text-xs text-slate-500">{String(item.application_number)} · {item.created_at ? new Date(String(item.created_at)).toLocaleDateString() : 'Date unavailable'}</p></div><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold capitalize text-blue-800">{String(item.status).replaceAll('_', ' ')}</span></article>)}</div> : <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{t(NO_LINKED_APPLICATIONS_MESSAGE)}</p>)}
                  </section>
                  <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-extrabold text-[#0B2E59]">Upcoming schedule</h2><p className="mt-1 text-xs text-slate-500">Published exams linked to your applications.</p></div><CalendarDays className="h-5 w-5 text-blue-700" /></div>
                    {candidateSectionStatus('portal', 'Schedule') ?? (() => {
                      const applicationCodes = new Set(list('applications').map((application) => String(application.exam_code)));
                      const upcoming = candidateExamItems.filter((exam) => applicationCodes.has(exam.code) && exam.examDate >= candidateToday).slice(0, 4);
                      return upcoming.length ? <ul className="mt-4 space-y-3">{upcoming.map((exam) => <li key={exam.code} className="flex items-center gap-3 rounded-lg bg-slate-50 p-3"><span className="min-w-14 rounded-md bg-blue-100 px-2 py-2 text-center text-xs font-black text-blue-800">{exam.day} {exam.month}</span><span className="min-w-0"><strong className="block truncate text-sm text-slate-900">{exam.name}</strong><span className="text-xs text-slate-500">{exam.code} · {exam.mode}</span></span></li>)}</ul> : <p className="mt-4 text-sm text-slate-500">No upcoming exam dates are published for your linked applications.</p>;
                    })()}
                  </section>
                </div>
                <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
                  <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h2 className="text-lg font-extrabold text-[#0B2E59]">Recent activity</h2>
                    {candidateSectionStatus('portal', 'Recent activity') ?? (list('applications').length ? <ul className="mt-3 space-y-3">{list('applications').slice(0, 4).map((item) => <li key={String(item.application_number)} className="flex gap-3 text-sm text-slate-700"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span>Application <strong>{String(item.application_number)}</strong> is <span className="capitalize">{String(item.status).replaceAll('_', ' ')}</span>.</span></li>)}{list('results').slice(0, 2).map((item) => <li key={`${String(item.exam_code)}-${String(item.published_at)}`} className="flex gap-3 text-sm text-slate-700"><Award className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /><span>A result was published for <strong>{String(item.exam_code)}</strong>.</span></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">Activity will appear after you submit an examination application.</p>)}
                  </section>
                  <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h2 className="text-lg font-extrabold text-[#0B2E59]">Quick actions</h2>
                    <div className="mt-3 grid gap-2"><button type="button" onClick={() => openCandidateSection('browse-exams')} className="flex items-center justify-between rounded-lg bg-blue-50 px-3 py-3 text-sm font-bold text-blue-900 hover:bg-blue-100"><span className="flex items-center gap-2"><Search className="h-4 w-4" />Browse exams</span><ArrowRight className="h-4 w-4" /></button><button type="button" onClick={() => openCandidateSection('admit-cards')} className="flex items-center justify-between rounded-lg bg-violet-50 px-3 py-3 text-sm font-bold text-violet-900 hover:bg-violet-100"><span className="flex items-center gap-2"><Award className="h-4 w-4" />Admit cards</span><ArrowRight className="h-4 w-4" /></button><button type="button" onClick={() => openCandidateSection('results')} className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-3 text-sm font-bold text-emerald-900 hover:bg-emerald-100"><span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />Results</span><ArrowRight className="h-4 w-4" /></button></div>
                  </section>
                </div>
              </div>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'profile' && (
              <section className="space-y-5">
                <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
                  <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-xl bg-blue-100 text-blue-800"><UserRound className="h-6 w-6" /></div><div><h2 className="text-lg font-extrabold text-[#0B2E59]">Student account</h2><p className="text-sm text-slate-500">Authenticated account details</p></div></div>
                    <dl className="mt-5 divide-y divide-slate-100 text-sm"><div className="py-3"><dt className="text-slate-500">Name</dt><dd className="mt-1 font-bold text-slate-900">{user.name}</dd></div><div className="py-3"><dt className="text-slate-500">Student login ID</dt><dd className="mt-1 font-mono font-bold text-slate-900">{user.id}</dd></div><div className="py-3"><dt className="text-slate-500">Applications linked</dt><dd className="mt-1 font-bold text-slate-900">{candidateSectionState('portal') === 'success' ? list('applications').length : 'Loading…'}</dd></div></dl>
                    <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-900">Personal details for each application are stored with that application. Editing identity details or uploading profile documents is not available in this account yet.</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-[#0B2E59]">Application identity details</h2>{candidateSectionStatus('portal', 'Application details') ?? (list('applications').length ? <div className="mt-4 space-y-3">{list('applications').slice(0, 4).map((application) => <div key={String(application.application_number)} className="rounded-lg bg-slate-50 p-4"><p className="font-bold text-slate-900">{String(application.candidate_name)}</p><p className="mt-1 text-xs text-slate-500">{String(application.exam_code)} · {String(application.application_number)}</p></div>)}</div> : <p className="mt-4 text-sm text-slate-500">Your application identity details will appear after you apply.</p>)}</article>
                </div>
              </section>
            )}

            {user.role === 'candidate' && ['browse-exams', 'apply-exam'].includes(activeCandidateSection) && (
              <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5">
                {renderCandidateExams(activeCandidateSection === 'apply-exam')}
              </section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'applications' && (
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-extrabold text-[#0B2E59]">Application tracker</h2><p className="mt-1 text-sm text-slate-500">Application status and exam details for your signed-in account.</p></div><button type="button" onClick={() => openCandidateSection('browse-exams')} className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-800">Browse examinations</button></div>
                {candidateSectionStatus('portal', 'Applications') ?? (list('applications').length ? <div className="mt-5 space-y-3">{list('applications').map((item) => <article key={String(item.application_number)} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">{String(item.exam_code)}</p><h3 className="mt-1 font-extrabold text-slate-900">{String(item.application_number)}</h3></div><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold capitalize text-blue-800">{String(item.status).replaceAll('_', ' ')}</span></div><div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-2"><p>Submitted: {item.created_at ? new Date(String(item.created_at)).toLocaleDateString() : '—'}</p><p>{item.roll_number ? `Roll number: ${String(item.roll_number)}` : 'Roll number: not assigned yet'}</p><p>{item.exam_date ? `Exam date: ${String(item.exam_date).slice(0, 10)}` : 'Exam date: not published here'}</p><p>{item.center_name ? `Center: ${String(item.center_name)}` : 'Center: not allocated yet'}</p></div></article>)}</div> : <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{t(NO_LINKED_APPLICATIONS_MESSAGE)}</p>)}
              </section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'payments' && (
              <section className="space-y-4">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><strong>Payment status is not connected to student accounts.</strong> Fees shown below come from published exam details; this portal does not collect, confirm, or mark payments as paid.</div>
                {candidateSectionStatus('portal', 'Applications') ?? (list('applications').length ? list('applications').map((application) => {
                  const exam = candidateExamItems.find((item) => item.code === String(application.exam_code));
                  return <article key={String(application.application_number)} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div><h2 className="font-extrabold text-[#0B2E59]">{String(application.exam_code)}</h2><p className="mt-1 text-xs text-slate-500">Application {String(application.application_number)}</p></div><div className="text-right"><p className="text-xs text-slate-500">Published fee information</p><p className="font-bold text-slate-900">{exam?.fee ?? 'Not listed for this exam'}</p></div></article>;
                }) : <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">Fee details will appear here when you have an application for a published examination.</p>)}
              </section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'admit-cards' && (
              <section className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4"><div><h2 className="font-extrabold text-[#0B2E59]">Admit card access</h2><p className="mt-1 text-sm text-blue-900">A card is available only after the examination team publishes your center allocation.</p></div><button type="button" onClick={onOpenAdmitCard} className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-800">Open secure lookup</button></div>
                {candidateSectionStatus('portal', 'Applications') ?? (list('applications').length ? list('applications').map((application) => <article key={String(application.application_number)} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-extrabold text-[#0B2E59]">{String(application.exam_code)}</h3><p className="mt-1 text-xs text-slate-500">{String(application.application_number)}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${application.roll_number ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{application.roll_number ? 'Admit card details published' : 'Awaiting publication'}</span></div>{Boolean(application.roll_number) && <dl className="mt-4 grid gap-2 text-sm text-slate-700 sm:grid-cols-2"><div><dt className="text-xs text-slate-500">Roll number</dt><dd className="font-bold">{String(application.roll_number)}</dd></div><div><dt className="text-xs text-slate-500">Exam date</dt><dd className="font-bold">{String(application.exam_date || '—')}</dd></div><div><dt className="text-xs text-slate-500">Center</dt><dd className="font-bold">{String(application.center_name || '—')}</dd></div><div><dt className="text-xs text-slate-500">Center address</dt><dd className="font-bold">{String(application.center_address || '—')}</dd></div></dl>}</article>) : <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">No applications are linked to this account yet.</p>)}
              </section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'my-exams' && (
              <div className="space-y-5">
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-[#0B2E59]">Online examinations</h2>{candidateSectionStatus('online-exams', 'Online examinations') ?? (list('onlineExams').length ? <div className="mt-4 grid gap-3 md:grid-cols-2">{list('onlineExams').map((exam) => { const card = describeOnlineExamAttempt(exam.attempt as Record<string, unknown> | null, Date.now()); const toneClass = { success: 'text-emerald-800', warning: 'text-amber-800', danger: 'text-rose-800', active: 'text-blue-800', neutral: 'text-slate-600' }[card.tone]; return <article key={String(exam.exam_code)} className="rounded-lg border border-slate-200 bg-slate-50 p-4"><h3 className="font-bold text-slate-900">{String(exam.exam_name)}</h3><p className="mt-1 text-xs text-slate-500">{String(exam.exam_code)} · {String(exam.question_count)} questions · {String(exam.duration_minutes)} minutes</p>{card.statusText && <p className={`mt-2 text-sm ${toneClass}`}>{card.statusText}</p>}<button type="button" disabled={!card.canOpen} onClick={() => setActiveOnlineExam({ code: String(exam.exam_code), name: String(exam.exam_name) })} className="mt-3 rounded-lg bg-blue-700 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-400">{card.buttonLabel}</button></article>; })}</div> : <p className="mt-3 text-sm text-slate-500">No published online exams are currently available for your approved applications.</p>)}</section>
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-[#0B2E59]">Practice test history</h2>{candidateSectionStatus('attempts', 'Practice history') ?? (list('attempts').length ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Submitted</th><th className="p-3">Questions</th><th className="p-3">Correct</th><th className="p-3">Score</th><th className="p-3">Percent</th></tr></thead><tbody className="divide-y divide-slate-100">{list('attempts').map((attempt) => <tr key={String(attempt.id)}><td className="p-3">{attempt.submitted_at ? new Date(String(attempt.submitted_at)).toLocaleString() : '—'}</td><td className="p-3">{String(attempt.total_questions)}</td><td className="p-3">{String(attempt.correct)}</td><td className="p-3">{String(attempt.total_score)} / {String(attempt.max_score)}</td><td className="p-3 font-bold">{String(attempt.percentage)}%</td></tr>)}</tbody></table></div> : <p className="mt-3 text-sm text-slate-500">No submitted practice tests yet.</p>)}</section>
              </div>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'instructions' && (
              <section className="space-y-4">
                <div className="rounded-xl border border-blue-100 bg-blue-50 p-5"><h2 className="text-lg font-extrabold text-[#0B2E59]">Before you start</h2><ul className="mt-3 space-y-2 text-sm leading-6 text-blue-950"><li>• Confirm exam date, mode, duration and shift from the official exam details or your admit card.</li><li>• Keep your application number and roll number available when contacting support.</li><li>• Online exam timers and submission status are controlled by the examination server.</li><li>• Follow the latest instructions published by ELTNOY for your specific examination.</li></ul></div>
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-[#0B2E59]">Your examination details</h2>{candidateSectionStatus('portal', 'Applications') ?? (list('applications').length ? <div className="mt-4 space-y-3">{list('applications').map((application) => { const exam = candidateExamItems.find((item) => item.code === String(application.exam_code)); return <article key={String(application.application_number)} className="rounded-lg border border-slate-100 bg-slate-50 p-4"><h3 className="font-bold">{exam?.name ?? String(application.exam_code)}</h3><p className="mt-1 text-xs text-slate-500">Application {String(application.application_number)} · {String(application.status).replaceAll('_', ' ')}</p>{exam && <p className="mt-2 text-sm text-slate-700">{exam.examDate} · {exam.mode} · {exam.duration} · {exam.shifts}</p>}</article>; })}</div> : <p className="mt-3 text-sm text-slate-500">Apply for a published exam to see its details here.</p>)}</section>
              </section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'results' && (
              <section className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-100 bg-emerald-50 p-4"><div><h2 className="font-extrabold text-emerald-950">Published scorecards</h2><p className="mt-1 text-sm text-emerald-900">Scores are shown only after official publication and identity verification.</p></div><button type="button" onClick={onOpenResults} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-800">Open secure result lookup</button></div>
                {candidateSectionStatus('portal', 'Results') ?? (list('results').length ? <div className="grid gap-3 md:grid-cols-2">{list('results').map((result) => <article key={`${String(result.exam_code)}-${String(result.application_number)}`} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800">Published</span><h3 className="mt-3 text-lg font-extrabold text-[#0B2E59]">{String(result.exam_code)}</h3><p className="mt-1 text-sm text-slate-600">Application {String(result.application_number)}{result.roll_number ? ` · Roll ${String(result.roll_number)}` : ''}</p><p className="mt-2 text-xs text-slate-500">Published {result.published_at ? new Date(String(result.published_at)).toLocaleDateString() : 'date unavailable'}</p><button type="button" onClick={onOpenResults} className="mt-4 rounded-lg border border-blue-700 px-3 py-2 text-sm font-bold text-blue-800 hover:bg-blue-50">View verified scorecard</button></article>)}</div> : <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">No official results have been published for your linked applications.</p>)}
              </section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'attendance' && (
              <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-start gap-3"><CalendarCheck className="mt-1 h-6 w-6 text-blue-700" /><div><h2 className="text-lg font-extrabold text-[#0B2E59]">Exam attendance</h2><p className="mt-2 text-sm leading-6 text-slate-600">Candidate attendance records are not currently exposed in the student account API. Your exam check-in is recorded by the assigned center; ask the examination team if you need an attendance confirmation.</p><button type="button" onClick={() => openCandidateSection('helpdesk')} className="mt-4 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-800">Contact support</button></div></div></section>
            )}

            {user.role === 'candidate' && ['interview', 'training'].includes(activeCandidateSection) && (
              <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-start gap-3">{activeCandidateSection === 'interview' ? <UserRound className="mt-1 h-6 w-6 text-blue-700" /> : <GraduationCap className="mt-1 h-6 w-6 text-blue-700" />}<div><h2 className="text-lg font-extrabold text-[#0B2E59]">{activeCandidateSection === 'interview' ? 'Online interview' : 'Online training'}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{activeCandidateSection === 'interview' ? 'Interview schedules, panel details and join links are not yet provided by the current student services API. Any official schedule will be shown when the exam team publishes it.' : 'There are no course enrollment or learning progress services connected to student accounts yet. Published training options will appear here when available.'}</p><button type="button" onClick={() => openCandidateSection('helpdesk')} className="mt-4 rounded-lg border border-blue-700 px-4 py-2.5 text-sm font-bold text-blue-800 hover:bg-blue-50">Ask the helpdesk</button></div></div></section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'helpdesk' && (
              <section className="grid gap-5 lg:grid-cols-[1fr_320px]">
                <form onSubmit={(event) => void submitCandidateTicket(event)} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div><h2 className="text-lg font-extrabold text-[#0B2E59]">Create a support ticket</h2><p className="mt-1 text-sm text-slate-500">The ELTNOY team receives this request with your student account attached.</p></div>
                  {candidateTicketId && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">Ticket submitted. Save this reference: <strong className="font-mono">{candidateTicketId}</strong></p>}
                  <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold text-slate-700">Request type<select value={candidateTicketType} onChange={(event) => setCandidateTicketType(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5"><option value="other">General support</option><option value="admit_card">Admit card</option><option value="cbt_issue">Online exam issue</option><option value="bug">Technical problem</option><option value="suggestion">Suggestion</option></select></label><label className="text-sm font-semibold text-slate-700">Application number (optional)<select value={candidateTicketApplication} onChange={(event) => setCandidateTicketApplication(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5"><option value="">Not related to an application</option>{list('applications').map((application) => <option key={String(application.application_number)} value={String(application.application_number)}>{String(application.application_number)} · {String(application.exam_code)}</option>)}</select></label></div>
                  <label className="block text-sm font-semibold text-slate-700">Contact email (optional)<input type="email" value={candidateTicketEmail} onChange={(event) => setCandidateTicketEmail(event.target.value)} maxLength={254} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5" placeholder="Email for a reply" /></label>
                  <label className="block text-sm font-semibold text-slate-700">Subject<input required minLength={4} maxLength={100} value={candidateTicketTitle} onChange={(event) => setCandidateTicketTitle(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5" /></label>
                  <label className="block text-sm font-semibold text-slate-700">Describe the issue<textarea required minLength={10} maxLength={1000} rows={5} value={candidateTicketDescription} onChange={(event) => setCandidateTicketDescription(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5" /></label>
                  <button type="submit" disabled={isSubmittingCandidateTicket} className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-60">{isSubmittingCandidateTicket ? 'Submitting…' : 'Submit support request'}</button>
                </form>
                <aside className="h-fit rounded-xl border border-blue-100 bg-blue-50 p-5"><LifeBuoy className="h-6 w-6 text-blue-700" /><h3 className="mt-3 font-extrabold text-[#0B2E59]">Ticket follow-up</h3><p className="mt-2 text-sm leading-6 text-blue-950">Keep the ticket reference shown after submission. This release lets you submit a ticket, but does not yet provide student ticket history or replies inside the portal.</p></aside>
              </section>
            )}

            {user.role === 'candidate' && activeCandidateSection === 'settings' && (
              <section className="space-y-5"><StudentEmailContactPanel /><StudentGoogleLinkCard /><section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-extrabold text-[#0B2E59]">Session</h2><p className="mt-1 text-sm text-slate-600">Sign out of this student account on this device.</p><button type="button" onClick={() => void onLogout()} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-rose-300 px-4 py-2.5 text-sm font-bold text-rose-700 hover:bg-rose-50"><LogOut className="h-4 w-4" />Sign out</button></section></section>
            )}

            {user.role === 'center' && activeInstituteSection === 'institute-checkins' && (
              <div id="institute-checkins" className="scroll-mt-28 mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
                <form onSubmit={(event) => void submitCheckin(event)} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Verify a candidate</h2>
                  <p className="mt-1 text-sm text-slate-500">Only candidates assigned to center <strong>{user.id}</strong> can be checked in.</p>
                  <label className="mt-4 block text-sm font-semibold text-slate-700">Application number<input required value={applicationNumber} onChange={(event) => setApplicationNumber(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm uppercase" /></label>
                  <label className="mt-3 block text-sm font-semibold text-slate-700">Date of birth<input required type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" /></label>
                  <label className="mt-3 block text-sm font-semibold text-slate-700">Check-in status<select value={checkinStatus} onChange={(event) => setCheckinStatus(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"><option value="verified">Identity verified</option><option value="admitted">Admitted to exam</option><option value="flagged">Flag for review</option><option value="rejected">Entry denied</option></select></label>
                  <label className="mt-3 block text-sm font-semibold text-slate-700">Note (optional)<textarea value={checkinNote} onChange={(event) => setCheckinNote(event.target.value)} maxLength={500} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" /></label>
                  <button type="submit" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-sky-600"><ClipboardCheck className="h-4 w-4" /> Verify and save</button>
                </form>
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-[#0B2E59]">Recent check-ins</h2>{list('checkins').length ? <div className="mt-4 space-y-2">{list('checkins').map((item) => <article key={String(item.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3"><div><strong className="text-sm">{String(item.candidate_name)}</strong><p className="text-xs text-slate-500">{String(item.application_number)} · {String(item.roll_number)} · {String(item.exam_code)}</p></div><span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-bold capitalize text-sky-800">{String(item.status)}</span></article>)}</div> : <p className="mt-4 text-sm text-slate-500">No check-ins recorded for this center.</p>}</section>
              </div>
            )}

            {user.role === 'center' && ['institute-forms', 'institute-profile', 'institute-wallet'].includes(activeInstituteSection) && (
              <div className="mt-5 space-y-5">
                {['institute-forms', 'institute-profile'].includes(activeInstituteSection) && <div className="grid gap-5 lg:grid-cols-2">
                  {activeInstituteSection === 'institute-forms' && (
                  <form onSubmit={(event) => void submitInstituteForm(event)} id="institute-forms" className="scroll-mt-28 space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.14em] text-emerald-800">{t('Examination forms')}</p>
                      <h2 className="text-lg font-extrabold text-[#0B2E59]">Submit an institute form</h2>
                      <p className="mt-1 text-sm text-slate-500">Super Admin must approve it before it appears on the public website.</p>
                    </div>
                    <label className="block text-sm font-semibold text-slate-700">Form type
                      <select value={instituteFormDraft.formType} onChange={(event) => setInstituteFormDraft((draft) => ({ ...draft, formType: event.target.value as InstituteFormDraft['formType'] }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm">
                        <option value="exam_application">Exam application</option><option value="teacher_recruitment">Teacher recruitment</option>
                      </select>
                    </label>
                    <label className="block text-sm font-semibold text-slate-700">Public title
                      <input required minLength={5} maxLength={160} value={instituteFormDraft.title} onChange={(event) => setInstituteFormDraft((draft) => ({ ...draft, title: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                    </label>
                    <label className="block text-sm font-semibold text-slate-700">Details
                      <textarea required minLength={10} maxLength={3000} rows={4} value={instituteFormDraft.description} onChange={(event) => setInstituteFormDraft((draft) => ({ ...draft, description: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                    </label>
                    <label className="block text-sm font-semibold text-slate-700">Eligibility
                      <textarea required minLength={3} maxLength={1000} rows={2} value={instituteFormDraft.eligibility} onChange={(event) => setInstituteFormDraft((draft) => ({ ...draft, eligibility: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm font-semibold text-slate-700">Application deadline (optional)
                        <input type="date" value={instituteFormDraft.applicationDeadline} onChange={(event) => setInstituteFormDraft((draft) => ({ ...draft, applicationDeadline: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                      </label>
                      <label className="text-sm font-semibold text-slate-700">External application link (optional)
                        <input type="url" maxLength={500} value={instituteFormDraft.externalUrl} onChange={(event) => setInstituteFormDraft((draft) => ({ ...draft, externalUrl: event.target.value }))} placeholder="https://…" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
                      </label>
                    </div>
                    <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Candidates apply through your external link or contact details. ELTNOY does not collect applications or payments for these forms.</p>
                    <button disabled={isSavingInstituteForm} type="submit" className="rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60">{isSavingInstituteForm ? 'Submitting…' : 'Submit for approval'}</button>
                  </form>
                  )}

                  {activeInstituteSection === 'institute-profile' && <div className="space-y-5">
                    <form onSubmit={(event) => void submitInstituteProfile(event)} id="institute-profile" className="scroll-mt-28 space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div>
                        <h2 className="text-lg font-extrabold text-[#0B2E59]">Request profile update</h2>
                        <p className="mt-1 text-sm text-slate-500">Your currently approved profile stays unchanged until Super Admin approves the request.</p>
                      </div>
                      <label className="block text-sm font-semibold text-slate-700">Institute name<input required minLength={2} maxLength={150} value={instituteProfileDraft.displayName} onChange={(event) => setInstituteProfileDraft((draft) => ({ ...draft, displayName: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                      <label className="block text-sm font-semibold text-slate-700">Contact email<input required type="email" maxLength={254} value={instituteProfileDraft.contactEmail} onChange={(event) => setInstituteProfileDraft((draft) => ({ ...draft, contactEmail: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                      <label className="block text-sm font-semibold text-slate-700">Registration / recognition no.<input required minLength={3} maxLength={100} value={instituteProfileDraft.registrationNumber} onChange={(event) => setInstituteProfileDraft((draft) => ({ ...draft, registrationNumber: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                      <label className="block text-sm font-semibold text-slate-700">Registered address<textarea required minLength={10} maxLength={500} rows={2} value={instituteProfileDraft.registeredAddress} onChange={(event) => setInstituteProfileDraft((draft) => ({ ...draft, registeredAddress: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                      <label className="block text-sm font-semibold text-slate-700">Website (optional)<input type="url" maxLength={200} value={instituteProfileDraft.website} onChange={(event) => setInstituteProfileDraft((draft) => ({ ...draft, website: event.target.value }))} placeholder="https://…" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
                      <button disabled={isSavingInstituteProfile || list('profileChanges').some((change) => change.status === 'pending')} type="submit" className="rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60">{isSavingInstituteProfile ? 'Submitting…' : 'Request profile review'}</button>
                    </form>
                    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                      <h2 className="text-lg font-extrabold text-[#0B2E59]">Profile requests</h2>
                      {list('profileChanges').length ? <div className="mt-3 space-y-2">{list('profileChanges').map((change) => <article key={String(change.id)} className="rounded-lg bg-slate-50 p-3"><div className="flex justify-between gap-2"><strong className="text-sm">{String(change.display_name)}</strong><span className="text-xs font-bold capitalize text-slate-600">{String(change.status)}</span></div><p className="mt-1 text-xs text-slate-500">Submitted {new Date(String(change.created_at)).toLocaleDateString()}</p></article>)}</div> : <p className="mt-3 text-sm text-slate-500">No profile change requests.</p>}
                    </section>
                  </div>}
                </div>}

                {activeInstituteSection === 'institute-wallet' && <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div><h2 id="institute-wallet" className="flex scroll-mt-24 items-center gap-2 text-lg font-extrabold text-[#0B2E59]"><Wallet className="h-5 w-5" /> Institute wallet</h2><p className="mt-1 text-sm text-slate-500">View your wallet balance, verified credits, and withdrawal requests.</p></div>
                    <div className="grid grid-cols-2 gap-3 text-right"><div><p className="text-xs text-slate-500">Balance</p><p className="font-bold text-slate-900">{formatPaise(data.balancePaise)}</p></div><div><p className="text-xs text-slate-500">Available</p><p className="font-bold text-emerald-800">{formatPaise(data.availablePaise)}</p></div></div>
                  </div>
                  <form onSubmit={(event) => void requestWithdrawal(event)} className="mt-4 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3">
                    <label className="text-sm font-semibold text-slate-700">Request withdrawal (₹)
                      <input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={withdrawalAmount} onChange={(event) => setWithdrawalAmount(event.target.value)} placeholder="0.00" className="mt-1 block w-44 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <button type="submit" className="rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white">Request withdrawal</button>
                    <p className="max-w-xl text-xs text-slate-500">Do not enter bank details here. Super Admin approves requests, transfers funds manually, then records the transfer reference.</p>
                  </form>
                  <div className="mt-5 grid gap-5 lg:grid-cols-2">
                    <div><h3 className="font-bold text-slate-800">Wallet activity</h3>{list('entries').length ? <div className="mt-2 space-y-2">{list('entries').map((entry) => <article key={String(entry.id)} className="flex justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm"><div><strong>{String(entry.description)}</strong><p className="text-xs text-slate-500">{String(entry.payment_reference || entry.transfer_reference || '')} · {new Date(String(entry.created_at)).toLocaleDateString()}</p></div><span className={`font-bold ${entry.entry_type === 'credit' ? 'text-emerald-700' : 'text-rose-700'}`}>{entry.entry_type === 'credit' ? '+' : '−'}{formatPaise(entry.amount_paise)}</span></article>)}</div> : <p className="mt-2 text-sm text-slate-500">No wallet transactions recorded.</p>}</div>
                    <div><h3 className="font-bold text-slate-800">Withdrawal requests</h3>{list('withdrawals').length ? <div className="mt-2 space-y-2">{list('withdrawals').map((withdrawal) => <article key={String(withdrawal.id)} className="flex justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm"><div><strong>{formatPaise(withdrawal.amount_paise)}</strong><p className="text-xs capitalize text-slate-500">{String(withdrawal.status)}{withdrawal.transfer_reference ? ` · ${String(withdrawal.transfer_reference)}` : ''}</p></div><span className="text-xs text-slate-500">{new Date(String(withdrawal.created_at)).toLocaleDateString()}</span></article>)}</div> : <p className="mt-2 text-sm text-slate-500">No withdrawal requests.</p>}</div>
                  </div>
                </section>}

                {activeInstituteSection === 'institute-forms' && <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">My submitted forms</h2>
                  {list('forms').length ? <div className="mt-3 grid gap-3 md:grid-cols-2">{list('forms').map((form) => <article key={String(form.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex justify-between gap-2"><h3 className="font-bold text-slate-900">{String(form.title)}</h3><span className="text-xs font-bold capitalize text-slate-600">{String(form.status)}</span></div><p className="mt-1 text-xs text-slate-500">{form.form_type === 'teacher_recruitment' ? 'Teacher recruitment' : 'Exam application'} · Submitted {new Date(String(form.created_at)).toLocaleDateString()}</p><p className="mt-2 text-sm text-slate-600">{String(form.description)}</p></article>)}</div> : <p className="mt-3 text-sm text-slate-500">No institute forms submitted yet.</p>}
                </section>}
              </div>
            )}

            {user.role === 'center' && activeInstituteSection === 'institute-documents' && (
              <div id="institute-documents" className="scroll-mt-28"><InstitutionDocumentManagement role="center" /></div>
            )}

            {user.role === 'center' && activeInstituteSection === 'institute-staff' && <div id="institute-staff" className="scroll-mt-28"><OrganizationStaffOwnerPanel /></div>}

            {user.role === 'center' && activeInstituteSection === 'institute-settings' && (
              <div className="space-y-5">
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Settings &amp; Support</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Manage your institute verification documents and contact ELTNOY support if your access or center assignment needs review.</p>
                </section>
                {/* The component renders the visible "Institution documents" heading itself. */}
                <section aria-labelledby="institution-documents-center">
                  <InstitutionDocumentManagement role="center" />
                </section>
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="font-extrabold text-[#0B2E59]">ELTNOY Support</h2>
                  <p className="mt-1 text-sm text-slate-600">For sign-in, institute verification, or assigned-center questions, contact the portal support team.</p>
                  <a href="mailto:support@eltnoy.com" className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline">support@eltnoy.com <ArrowRight className="h-4 w-4" /></a>
                </section>
              </div>
            )}

            {user.role === 'center' && [
              'institute-exam-management', 'institute-applications', 'institute-admit-cards',
              'institute-question-bank', 'institute-cbt-center', 'institute-results',
              'institute-reports', 'institute-attendance', 'institute-interviews', 'institute-training',
            ].includes(activeInstituteSection) && (
              <InstituteAdvancedSection
                sectionId={activeInstituteSection as InstituteAdvancedSectionId}
                centerCode={user.id}
                forms={list('forms')}
                checkins={list('checkins')}
                summary={data.dashboardSummary}
                workspaceState={getDashboardSectionContentState(sectionStatuses['center:workspace'])}
                checkinsState={getDashboardSectionContentState(sectionStatuses['center:checkins'])}
                onCreateForm={() => jumpToInstituteSection('institute-forms')}
                onOpenCheckins={() => jumpToInstituteSection('institute-checkins')}
              />
            )}

            {user.role === 'official' && tab === 'applications' && <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Application</th><th className="p-4">Candidate / exam</th><th className="p-4">Submitted</th><th className="p-4">Status</th><th className="p-4">Admit card</th></tr></thead><tbody className="divide-y divide-slate-100">{list('applications').map((item) => <tr key={String(item.id)}><td className="p-4 font-mono font-bold">{String(item.application_number)}</td><td className="p-4">{String(item.candidate_name)}<span className="block text-xs text-slate-500">{String(item.exam_code)}</span></td><td className="p-4 text-slate-500">{new Date(String(item.created_at)).toLocaleDateString()}</td><td className="p-4"><select aria-label={`Status for ${String(item.application_number)}`} value={String(item.status)} onChange={(event) => void updateApplication(String(item.id), event.target.value)} className="rounded-md border border-slate-300 px-2 py-1"><option value="submitted">Submitted</option><option value="under_review">Under review</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></td><td className="p-4 text-xs">{item.admit_card_published ? 'Published' : 'Not published'}</td></tr>)}</tbody></table></section>}

            {user.role === 'official' && tab === 'feedback' && permissions.canAccessHelpdesk && <section className="space-y-3">{list('feedback').length ? list('feedback').map((item) => <article key={String(item.id)} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-bold text-[#0B2E59]">{String(item.title)}</p><p className="mt-1 text-xs text-slate-500">{String(item.id)} · {String(item.type)} · {String(item.priority)}</p></div><select aria-label={`Status for ${String(item.id)}`} value={String(item.status)} onChange={(event) => void updateFeedback(String(item.id), event.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm"><option value="under_review">Under review</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select></div><p className="mt-3 text-sm text-slate-700">{String(item.description)}</p></article>) : <p className="rounded-xl bg-white p-6 text-sm text-slate-500">No helpdesk tickets have been submitted.</p>}</section>}

            {user.role === 'official' && tab === 'attempts' && <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Account</th><th className="p-4">Submitted</th><th className="p-4">Questions</th><th className="p-4">Score</th></tr></thead><tbody className="divide-y divide-slate-100">{list('attempts').map((item) => <tr key={String(item.id)}><td className="p-4">{String(item.display_name ?? item.login_id ?? 'Guest')}<span className="block text-xs text-slate-500">{String(item.login_id ?? '')}</span></td><td className="p-4">{new Date(String(item.submitted_at)).toLocaleString()}</td><td className="p-4">{String(item.correct)} / {String(item.total_questions)}</td><td className="p-4 font-bold">{String(item.percentage)}%</td></tr>)}</tbody></table></section>}

            {user.role === 'official' && tab === 'results' && (
              <section className="space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Bulk result upload</h2>
                  <p className="mt-1 text-sm text-slate-600">Import verified scorecards from the Results worksheet. They remain unpublished until a Super Admin explicitly publishes them below.</p>
                  {!permissions.canCorrectPublishedContent && <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{SUPER_ADMIN_ONLY_TEXT.draftImports} {SUPER_ADMIN_ONLY_TEXT.publishing}</p>}
                  <button type="button" onClick={downloadUploadTemplates} className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline"><Download className="h-4 w-4" /> Download Excel templates</button>
                  <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm font-semibold text-slate-700 hover:bg-blue-50">
                    <Upload className="h-5 w-5" />
                    {uploading === 'results' ? 'Uploading…' : 'Choose result workbook (.xlsx)'}
                    <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={uploading !== null} onChange={(event) => { void uploadWorkbook('results', event.target.files?.[0]); event.target.value = ''; }} />
                  </label>
                  <p className="mt-2 text-xs text-slate-500">The template uses a scorecardJson column containing the complete scorecard JSON for each row.</p>
                </div>
                <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Application</th><th className="p-4">Roll number</th><th className="p-4">Exam</th><th className="p-4">Status</th><th className="p-4">Published</th><th className="p-4">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{list('results').map((item) => <tr key={String(item.id)}><td className="p-4 font-mono">{String(item.application_number)}</td><td className="p-4">{String(item.roll_number)}</td><td className="p-4">{String(item.exam_code)}</td><td className="p-4">{item.is_published ? 'Published' : 'Draft'}</td><td className="p-4">{new Date(String(item.published_at)).toLocaleString()}</td><td className="p-4">{permissions.canPublishResults ? <button type="button" onClick={() => void publishAdminRecord(`/api/admin/results/${encodeURIComponent(String(item.id))}`, !Boolean(item.is_published), 'Result')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">{item.is_published ? 'Unpublish' : 'Publish result'}</button> : <span className="text-xs text-slate-500">Super Admin only</span>}</td></tr>)}</tbody></table></section>
              </section>
            )}
        </div>
      </div>
      {activeOnlineExam && (
        <OnlineExamRunner
          examCode={activeOnlineExam.code}
          examName={activeOnlineExam.name}
          onClose={() => {
            setActiveOnlineExam(null);
            void refresh();
          }}
          onSubmitted={() => void refresh()}
        />
      )}
      <ExamApplyModal
        exam={candidateApplyExam}
        onClose={() => setCandidateApplyExam(null)}
        onApplicationComplete={(applicationNumberValue) => {
          setNotice(`Application ${applicationNumberValue} submitted successfully.`);
          setActiveCandidateSection('applications');
          void refresh();
        }}
      />
    </main>
  );
};
