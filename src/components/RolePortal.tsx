/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Award,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Eye,
  EyeOff,
  FileText,
  GraduationCap,
  LockKeyhole,
  LogOut,
  PlusCircle,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserRound,
  Wallet,
} from 'lucide-react';
import { apiRequest } from '../api';
import { OnlineExamRunner } from './OnlineExamRunner';
import { BrandLogo } from './BrandLogo';

export type PortalRole = 'candidate' | 'center' | 'official';

export interface PortalUser {
  name: string;
  id: string;
  role: PortalRole;
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
    shell: 'bg-emerald-50/60',
    header: 'from-emerald-950 via-emerald-900 to-[#0B2E59]',
    eyebrow: 'Student workspace',
    description: 'Track your exam applications, admit card, results, and practice history.',
  },
  center: {
    shell: 'bg-sky-50/60',
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

interface RoleLoginPageProps {
  role?: PortalRole;
  onBack: () => void;
  onLogin: (user: PortalUser) => void;
}

export const RoleLoginPage: React.FC<RoleLoginPageProps> = ({ role, onBack, onLogin }) => {
  const [loginId, setLoginId] = useState('');
  const [fullName, setFullName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [registeredAddress, setRegisteredAddress] = useState('');
  const [website, setWebsite] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!role) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const { user } = await apiRequest<{
        user: { id: string; loginId: string; name: string; role: PortalRole };
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginId: loginId.trim(), password, role }),
      });
      onLogin({ id: user.loginId, name: user.name, role: user.role });
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Sign in failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!role || role === 'official') return;
    setError(null);
    setMessage(null);
    setIsSubmitting(true);
    try {
      if (role === 'candidate') {
        const { user } = await apiRequest<{
          user: { id: string; loginId: string; name: string; role: PortalRole };
        }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ loginId: loginId.trim(), name: fullName.trim(), password }),
        });
        onLogin({ id: user.loginId, name: user.name, role: user.role });
      } else {
        const { message: registrationMessage } = await apiRequest<{ message: string }>('/api/center/register', {
          method: 'POST',
          body: JSON.stringify({
            loginId: loginId.trim(),
            name: fullName.trim(),
            contactEmail: contactEmail.trim(),
            registrationNumber: registrationNumber.trim(),
            registeredAddress: registeredAddress.trim(),
            website: website.trim(),
            password,
          }),
        });
        setMessage(registrationMessage);
        setPassword('');
        setIsRegistering(false);
      }
    } catch (registrationError) {
      setError(registrationError instanceof Error ? registrationError.message : 'Could not submit registration.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const changeRegistrationMode = (enabled: boolean) => {
    setIsRegistering(enabled);
    setIsPasswordVisible(false);
    setError(null);
    setMessage(null);
  };

  const detail = role ? roleDetails[role] : null;
  const Icon = detail?.icon ?? GraduationCap;
  const accent = accentClasses[detail?.accent ?? 'emerald'];

  return (
    <main className="min-h-screen bg-[#eef5fa] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-2">
          <div className="flex items-center gap-3">
            <BrandLogo />
          </div>
          <button onClick={onBack} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-[#0B2E59] hover:bg-emerald-50">
            <ArrowLeft className="h-4 w-4" /> Home
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
        {!role ? (
          <>
            <div className="mx-auto mb-9 max-w-2xl text-center">
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-emerald-700">Secure access</p>
              <h1 className="mt-2 text-3xl font-black text-[#0B2E59] sm:text-4xl">Choose your portal</h1>
              <p className="mt-3 text-slate-600">Select the account type shown on your ELTNOY credentials.</p>
            </div>
            <div className="grid gap-5 md:grid-cols-3">
              {(['candidate', 'center', 'official'] as const).map((item) => {
                const itemDetail = roleDetails[item];
                const RoleIcon = itemDetail.icon;
                const colorClass = item === 'candidate' ? 'bg-emerald-600' : item === 'center' ? 'bg-sky-600' : 'bg-blue-800';
                return (
                  <a key={item} href={rolePath[item]} className="group rounded-2xl border border-slate-200 bg-white p-7 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
                    <div className={`mb-5 inline-flex rounded-xl p-3 text-white ${colorClass}`}><RoleIcon className="h-7 w-7" /></div>
                    <h2 className="text-xl font-extrabold text-[#0B2E59]">{itemDetail.title}</h2>
                    <p className="mt-2 min-h-12 text-sm leading-6 text-slate-600">{itemDetail.subtitle}</p>
                    <span className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-emerald-700">Continue to login <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" /></span>
                  </a>
                );
              })}
            </div>
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
              <p className="mt-8 text-xs text-white/70">Your Future, Our Mission</p>
            </section>
            <section className="p-7 sm:p-10">
              <a href="/login" className="mb-7 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-[#0B2E59]"><ArrowLeft className="h-3.5 w-3.5" /> All login options</a>
              <h2 className="text-2xl font-extrabold text-[#0B2E59]">
                {isRegistering ? (role === 'candidate' ? 'Create student account' : 'Request institute access') : 'Sign in to your account'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {isRegistering
                  ? role === 'candidate'
                    ? 'Create an account first. You can then sign in and submit exam applications.'
                    : 'Submit your institute details. Portal access starts only after Super Admin approval.'
                  : role === 'candidate'
                    ? 'Sign in before starting or continuing an exam application.'
                    : 'Enter the credentials provided by your portal administrator.'}
              </p>
              <form className="mt-7 space-y-5" onSubmit={(event) => void (isRegistering ? register(event) : submit(event))}>
                {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
                {message && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</div>}
                {isRegistering && (
                  <div>
                    <label htmlFor="role-register-name" className="mb-1.5 block text-sm font-semibold text-slate-700">
                      {role === 'candidate' ? 'Student full name' : 'Institute name'}
                    </label>
                    <input id="role-register-name" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} required maxLength={120} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                  </div>
                )}
                <div>
                  <label htmlFor="role-login-id" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {role === 'candidate' ? (isRegistering ? 'Choose student login ID' : 'Student login ID') : (isRegistering ? 'Choose institute / center ID' : 'Staff / Center ID')}
                  </label>
                  <input id="role-login-id" autoComplete="username" value={loginId} onChange={(event) => setLoginId(event.target.value)} required minLength={4} maxLength={50} pattern="[A-Za-z0-9._-]+" title="Use 4-50 letters, numbers, dots, underscores or hyphens." className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm uppercase outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                </div>
                {isRegistering && role === 'center' && (
                  <div>
                    <label htmlFor="institute-contact-email" className="mb-1.5 block text-sm font-semibold text-slate-700">Contact email</label>
                    <input id="institute-contact-email" type="email" autoComplete="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} required maxLength={254} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                  </div>
                )}
                <div>
                  <label htmlFor="role-login-password" className="mb-1.5 block text-sm font-semibold text-slate-700">Password</label>
                  <div className="relative">
                    <input id="role-login-password" type={isPasswordVisible ? 'text' : 'password'} autoComplete={isRegistering ? 'new-password' : 'current-password'} minLength={isRegistering ? 12 : undefined} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 pr-12 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                    <button
                      type="button"
                      onClick={() => setIsPasswordVisible((visible) => !visible)}
                      aria-label={isPasswordVisible ? 'Hide password' : 'Show password'}
                      aria-pressed={isPasswordVisible}
                      className="absolute inset-y-0 right-0 inline-flex items-center justify-center px-3 text-slate-500 hover:text-[#0B2E59] focus-visible:outline-2 focus-visible:outline-emerald-600"
                    >
                      {isPasswordVisible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                  {isRegistering && <p className="mt-1 text-xs text-slate-500">Use at least 12 characters. Keep your login ID and password safe.</p>}
                </div>
                <button type="submit" disabled={isSubmitting} className={`flex w-full items-center justify-center gap-2 rounded-lg ${accent.button} px-4 py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60`}>
                  <LockKeyhole className="h-4 w-4" /> {isSubmitting ? 'Please wait…' : isRegistering ? (role === 'candidate' ? 'Create account' : 'Submit for approval') : 'Secure sign in'}
                </button>
              </form>
              {role !== 'official' && (
                <button type="button" onClick={() => changeRegistrationMode(!isRegistering)} className="mt-5 w-full text-center text-sm font-bold text-emerald-800 hover:underline">
                  {isRegistering ? 'Already registered? Sign in' : role === 'candidate' ? 'New student? Create an account' : 'Institute needs access? Register for approval'}
                </button>
              )}
              {role === 'center' && isRegistering && (
                <>
                  <div>
                    <label htmlFor="institute-registration-number" className="mb-1.5 block text-sm font-semibold text-slate-700">Institute registration / recognition number</label>
                    <input id="institute-registration-number" value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} required minLength={3} maxLength={100} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                  </div>
                  <div>
                    <label htmlFor="institute-registered-address" className="mb-1.5 block text-sm font-semibold text-slate-700">Registered address</label>
                    <textarea id="institute-registered-address" value={registeredAddress} onChange={(event) => setRegisteredAddress(event.target.value)} required minLength={10} maxLength={500} rows={3} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                  </div>
                  <div>
                    <label htmlFor="institute-website" className="mb-1.5 block text-sm font-semibold text-slate-700">Official website (optional)</label>
                    <input id="institute-website" type="url" value={website} onChange={(event) => setWebsite(event.target.value)} maxLength={200} placeholder="https://example.org" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
                  </div>
                </>
              )}
              {role === 'center' && isRegistering && (
                <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  Registration does not grant immediate access. Super Admin must independently verify these details before approval. Approved institutes may submit exam and teacher-recruitment listings for Super Admin review; no documents are uploaded here.
                </p>
              )}
              {role === 'candidate' && isRegistering && (
                <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                  Email/SMS verification and password recovery are not configured. Do not use a password you use elsewhere.
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
};

type DashboardTab = 'overview' | 'exams' | 'institutes' | 'applications' | 'feedback' | 'attempts' | 'results' | 'admit-cards' | 'online-exams' | 'answer-keys' | 'notices' | 'data-export';

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
  const [data, setData] = useState<PortalData>({});
  const [tab, setTab] = useState<DashboardTab>('overview');
  const [loading, setLoading] = useState(true);
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
  const [withdrawalAmount, setWithdrawalAmount] = useState('');
  const [transferReferences, setTransferReferences] = useState<Record<string, string>>({});
  const [isSavingExam, setIsSavingExam] = useState(false);
  const [isSavingNotice, setIsSavingNotice] = useState(false);
  const [isSavingInstituteForm, setIsSavingInstituteForm] = useState(false);
  const [isSavingInstituteProfile, setIsSavingInstituteProfile] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [activeOnlineExam, setActiveOnlineExam] = useState<{ code: string; name: string } | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      if (user.role === 'candidate') {
        const [portal, attempts, onlineExams] = await Promise.all([
          apiRequest<PortalData>('/api/candidate/portal'),
          apiRequest<PortalData>('/api/mock-exams/mine'),
          apiRequest<PortalData>('/api/online-exams'),
        ]);
        setData({ ...portal, attempts: attempts.attempts, onlineExams: onlineExams.exams });
      } else if (user.role === 'center') {
        const [checkins, workspace] = await Promise.all([
          apiRequest<PortalData>('/api/center/checkins'),
          apiRequest<PortalData>('/api/center/workspace'),
        ]);
        setData({ ...workspace, checkins: checkins.checkins });
      } else {
        const [applications, feedback, attempts, results, exams, institutes, instituteManagement, onlineExams, answerKeys, notices] = await Promise.all([
          apiRequest<PortalData>('/api/admin/applications'),
          apiRequest<PortalData>('/api/admin/feedback'),
          apiRequest<PortalData>('/api/admin/mock-exams/attempts'),
          apiRequest<PortalData>('/api/admin/results'),
          apiRequest<PortalData>('/api/admin/exams'),
          apiRequest<PortalData>('/api/admin/institutes'),
          apiRequest<PortalData>('/api/admin/institute-management'),
          apiRequest<PortalData>('/api/admin/online-exams'),
          apiRequest<PortalData>('/api/admin/answer-keys'),
          apiRequest<PortalData>('/api/admin/notices'),
        ]);
        setData({
          applications: applications.applications,
          feedback: feedback.entries,
          attempts: attempts.attempts,
          results: results.results,
          exams: exams.exams,
          institutes: institutes.institutes,
          instituteForms: instituteManagement.forms,
          profileChanges: instituteManagement.profileChanges,
          withdrawals: instituteManagement.withdrawals,
          walletBalances: instituteManagement.walletBalances,
          onlineExams: onlineExams.exams,
          answerKeys: answerKeys.exams,
          notices: notices.notices,
        });
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load portal data.');
    } finally {
      setLoading(false);
    }
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
      setNotice('Notice published. It is now available in Latest Updates and Public Notices.');
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not publish notice.');
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

  const setInstituteApproval = async (id: string, status: 'approved' | 'rejected') => {
    setError(null);
    try {
      await apiRequest(`/api/admin/institutes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setNotice(status === 'approved' ? 'Institute access approved.' : 'Institute registration rejected.');
      await refresh();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Could not update institute registration.');
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
  const navTabs: { id: DashboardTab; label: string }[] = user.role === 'official'
    ? [{ id: 'overview', label: 'Overview' }, { id: 'institutes', label: 'Institute approvals & wallet' }, { id: 'exams', label: 'Exam forms' }, { id: 'notices', label: 'Latest updates' }, { id: 'admit-cards', label: 'Admit cards' }, { id: 'online-exams', label: 'Online exams' }, { id: 'answer-keys', label: 'Answer keys' }, { id: 'applications', label: 'Applications' }, { id: 'feedback', label: 'Helpdesk' }, { id: 'attempts', label: 'Mock tests' }, { id: 'results', label: 'Results' }, { id: 'data-export', label: 'Excel data' }]
    : [{ id: 'overview', label: 'Overview' }];

  const list = (key: string) => Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : [];
  const record = (key: string) => typeof data[key] === 'object' && data[key] !== null
    ? data[key] as Record<string, unknown>
    : {};
  const openWallet = () => {
    if (user.role === 'official') {
      setTab('institutes');
      window.setTimeout(() => document.getElementById('admin-institute-wallet')?.scrollIntoView({ behavior: 'smooth' }), 100);
      return;
    }
    document.getElementById('institute-wallet')?.scrollIntoView({ behavior: 'smooth' });
  };

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

  return (
    <main className={`min-h-screen text-slate-900 ${theme.shell}`}>
      <header className={`bg-gradient-to-r ${theme.header} text-white shadow-md`}>
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandLogo compact light />
            <div className="min-w-0"><p className="font-black tracking-wide">{detail.label} Portal</p><p className="truncate text-xs text-slate-300">{user.name} · {user.id}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onHome} className="rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/10">Public website</button>
            {(user.role === 'center' || user.role === 'official') && (
              <button onClick={openWallet} className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm font-bold text-white hover:bg-white/20">
                <Wallet className="h-4 w-4" /> Wallet
              </button>
            )}
            <button onClick={() => void onLogout()} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold hover:bg-emerald-500"><LogOut className="h-4 w-4" /> Sign out</button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-7 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className={`text-xs font-bold uppercase tracking-[0.16em] ${
              user.role === 'official' ? 'text-blue-800' : user.role === 'center' ? 'text-sky-800' : 'text-emerald-800'
            }`}>{theme.eyebrow}</p>
            <h1 className="mt-1 text-2xl font-black text-[#0B2E59] sm:text-3xl">{detail.title.replace('Login', '')} Dashboard</h1>
            <p className="mt-1 text-sm text-slate-600">{theme.description}</p>
          </div>
          <button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
        </div>
        {error && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
        {notice && <div role="status" className="mb-4 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></div>}
        {user.role === 'official' && (
          <nav aria-label="Dashboard sections" className="mb-5 flex flex-wrap gap-2">
            {navTabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm font-bold ${tab === item.id ? 'bg-blue-900 text-white shadow-sm' : 'bg-white text-slate-600 hover:bg-blue-50'}`}>{item.label}</button>)}
          </nav>
        )}
        {loading ? <div className="rounded-xl bg-white p-10 text-center text-sm text-slate-500">Loading secure portal data…</div> : (
          <>
            {user.role === 'official' && tab === 'notices' && (
              <section className="space-y-5">
                <form onSubmit={(event) => void createPortalNotice(event)} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div>
                    <h2 className="text-lg font-extrabold text-[#0B2E59]">Publish a portal update</h2>
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
                  <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Publishing is immediate. Check dates, application links, and notice text before publishing. You can unpublish an item below.</p>
                  <button disabled={isSavingNotice} type="submit" className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-60">{isSavingNotice ? 'Publishing…' : 'Publish update'}</button>
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
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${item.is_published ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{item.is_published ? 'Published' : 'Unpublished'}</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{String(item.category)} · {String(item.reference_number)} · {new Date(String(item.created_at)).toLocaleString()}</p>
                        <p className="mt-2 text-sm text-slate-600">{String(item.summary)}</p>
                      </div>
                      <button type="button" onClick={() => void publishAdminRecord(`/api/admin/notices/${encodeURIComponent(String(item.id))}`, !Boolean(item.is_published), 'Notice')} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">{item.is_published ? 'Unpublish' : 'Publish'}</button>
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
                    <button type="button" onClick={downloadUploadTemplates} className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline"><Download className="h-4 w-4" /> Download Excel templates</button>
                    <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm font-semibold text-slate-700 hover:bg-blue-50">
                      <Upload className="h-5 w-5" />
                      {uploading === 'admit-cards' ? 'Uploading…' : 'Choose admit-card workbook (.xlsx)'}
                      <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={uploading !== null} onChange={(event) => { void uploadWorkbook('admit-cards', event.target.files?.[0]); event.target.value = ''; }} />
                    </label>
                    <p className="mt-2 text-xs text-slate-500">Required columns are provided in the template. A successful upload publishes cards so candidates can look them up.</p>
                  </div>
                </div>
              </section>
            )}

            {user.role === 'official' && tab === 'online-exams' && (
              <section className="space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Create online exam from Excel</h2>
                  <p className="mt-1 text-sm text-slate-600">Upload one exam per workbook. Questions and correct answers are stored server-side; candidates never receive the answer key. New or replaced rows stay unpublished until reviewed.</p>
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
                    <tbody className="divide-y divide-slate-100">{list('onlineExams').map((exam) => <tr key={String(exam.exam_code)}><td className="p-4 font-bold">{String(exam.exam_name)}<span className="block text-xs text-slate-500">{String(exam.exam_code)}</span></td><td className="p-4">{String(exam.question_count)}</td><td className="p-4">{String(exam.duration_minutes)} min</td><td className="p-4">{exam.is_published ? 'Published' : 'Draft'}</td><td className="p-4"><button type="button" onClick={() => void publishAdminRecord(`/api/admin/online-exams/${encodeURIComponent(String(exam.exam_code))}`, !Boolean(exam.is_published), 'Online exam')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">{exam.is_published ? 'Unpublish' : 'Publish exam'}</button></td></tr>)}</tbody>
                  </table>
                </section>
              </section>
            )}

            {user.role === 'official' && tab === 'answer-keys' && (
              <section className="space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Upload official answer keys</h2>
                  <p className="mt-1 text-sm text-slate-600">Import exam-specific questions and correct options from the AnswerKeys worksheet. Imports remain drafts; publish only after verification.</p>
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
                    <tbody className="divide-y divide-slate-100">{list('answerKeys').map((exam) => <tr key={String(exam.exam_code)}><td className="p-4 font-bold">{String(exam.exam_code)}</td><td className="p-4">{String(exam.question_count)}</td><td className="p-4">{exam.is_published ? 'Published' : 'Draft'}</td><td className="p-4"><button type="button" onClick={() => void publishAdminRecord(`/api/admin/answer-keys/${encodeURIComponent(String(exam.exam_code))}`, !Boolean(exam.is_published), 'Answer key')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">{exam.is_published ? 'Unpublish' : 'Publish key'}</button></td></tr>)}</tbody>
                  </table>
                </section>
              </section>
            )}

            {user.role === 'official' && tab === 'data-export' && (
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
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${
                            institute.account_status === 'approved' ? 'bg-emerald-100 text-emerald-800'
                              : institute.account_status === 'rejected' ? 'bg-rose-100 text-rose-800'
                                : 'bg-amber-100 text-amber-800'
                          }`}>{String(institute.account_status)}</span>
                          {institute.account_status === 'pending' && (
                            <>
                              <button type="button" onClick={() => void setInstituteApproval(String(institute.id), 'approved')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-600">Approve access</button>
                              <button type="button" onClick={() => void setInstituteApproval(String(institute.id), 'rejected')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50">Reject</button>
                            </>
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
                <div className="mt-3 space-y-3">{list('institutes').filter((institute) => institute.account_status === 'approved').map((institute) => {
                  const balance = list('walletBalances').find((item) => item.institute_id === institute.id);
                  return <article key={String(institute.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-bold">{String(institute.display_name)}</h3><p className="text-xs text-slate-500">{String(institute.login_id)}</p></div><strong>{formatPaise(balance?.balance_paise ?? 0)}</strong></div><form onSubmit={(event) => void recordInstituteCredit(event, String(institute.id))} className="mt-3 grid gap-2 sm:grid-cols-[140px_1fr_1fr_auto]"><input name="amount" required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" placeholder="Amount ₹" aria-label="Credit amount in rupees" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input name="paymentReference" required minLength={3} maxLength={120} pattern="[A-Za-z0-9._/-]+" placeholder="Verified payment reference" aria-label="Verified payment reference" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input name="description" required minLength={3} maxLength={300} placeholder="Reason / fee details" aria-label="Credit description" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><button type="submit" className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">Record credit</button></form></article>;
                })}</div>
                <h3 className="mt-6 font-bold text-slate-800">Withdrawal requests</h3>
                {list('withdrawals').length ? <div className="mt-3 space-y-3">{list('withdrawals').map((withdrawal) => <article key={String(withdrawal.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-2"><div><strong>{String(withdrawal.institute_name)} · {String(withdrawal.login_id)}</strong><p className="text-sm">{formatPaise(withdrawal.amount_paise)} · <span className="capitalize">{String(withdrawal.status)}</span></p></div><span className="text-xs text-slate-500">{new Date(String(withdrawal.created_at)).toLocaleDateString()}</span></div>{withdrawal.status === 'pending' && <div className="mt-3 flex gap-2"><button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'approved')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white">Approve</button><button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'rejected')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700">Reject</button></div>}{withdrawal.status === 'approved' && <div className="mt-3 flex flex-wrap gap-2"><input value={transferReferences[String(withdrawal.id)] || ''} onChange={(event) => setTransferReferences((refs) => ({ ...refs, [String(withdrawal.id)]: event.target.value }))} required minLength={3} maxLength={120} pattern="[A-Za-z0-9._/-]+" placeholder="Manual transfer reference" aria-label={`Manual transfer reference for ${String(withdrawal.login_id)}`} className="min-w-60 rounded-lg border border-slate-300 px-3 py-2 text-sm" /><button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'paid')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">Mark paid</button><button type="button" onClick={() => void updateInstituteWithdrawal(String(withdrawal.id), 'rejected')} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700">Cancel approval</button></div>}</article>)}</div> : <p className="mt-2 text-sm text-slate-500">No withdrawal requests.</p>}
              </section>
              </div>
            )}

            {(user.role === 'candidate' || user.role === 'center' || tab === 'overview') && (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {(user.role === 'candidate' ? [
                  { label: 'Applications', value: list('applications').length, icon: FileText },
                  { label: 'Mock tests', value: list('attempts').length, icon: ClipboardCheck },
                  { label: 'Published results', value: list('results').length, icon: Award },
                ] : user.role === 'center' ? [
                  { label: 'Recorded check-ins', value: list('checkins').length, icon: ClipboardCheck },
                  { label: 'Center code', value: user.id, icon: Building2 },
                ] : [
                  { label: 'Applications', value: list('applications').length, icon: FileText },
                  { label: 'Open helpdesk tickets', value: list('feedback').filter((item) => item.status !== 'resolved').length, icon: ClipboardCheck },
                  { label: 'Mock test attempts', value: list('attempts').length, icon: Award },
                  { label: 'Published results', value: list('results').length, icon: CheckCircle2 },
                ]).map((item) => {
                  const CardIcon = item.icon;
                  return <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-500">{item.label}</p><CardIcon className="h-5 w-5 text-emerald-700" /></div><p className="mt-3 text-2xl font-black text-[#0B2E59]">{item.value}</p></article>;
                })}
              </div>
            )}

            {user.role === 'candidate' && (
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">My applications</h2>
                  {list('applications').length ? <div className="mt-4 space-y-3">{list('applications').map((item) => <article key={String(item.application_number)} className="rounded-lg border border-slate-100 bg-slate-50 p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{String(item.exam_code)}</strong><span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold capitalize text-amber-800">{String(item.status)}</span></div><p className="mt-2 text-sm text-slate-600">Application {String(item.application_number)}</p>{item.roll_number !== null && item.roll_number !== undefined && <p className="mt-1 text-sm text-slate-600">Roll no. {String(item.roll_number)} · {String(item.center_name)}</p>}</article>)}</div> : <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">No application is linked to this login ID yet. Use your application number as your candidate login ID.</p>}
                  <button onClick={onOpenAdmitCard} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-600">Open admit card lookup</button>
                </section>
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">My results and practice</h2>
                  {list('results').length ? <p className="mt-3 text-sm text-emerald-800">{list('results').length} result(s) published for your account.</p> : <p className="mt-3 text-sm text-slate-600">No official result has been published for this account.</p>}
                  <button onClick={onOpenResults} className="mt-4 rounded-lg border border-emerald-700 px-4 py-2.5 text-sm font-bold text-emerald-800 hover:bg-emerald-50">Check official result</button>
                  <h3 className="mt-6 font-bold text-slate-800">Practice test history</h3>
                  {list('attempts').length ? <ul className="mt-3 space-y-2 text-sm text-slate-600">{list('attempts').slice(0, 5).map((attempt) => <li key={String(attempt.id)} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2"><span>{String(attempt.correct)} correct of {String(attempt.total_questions)}</span><strong>{String(attempt.percentage)}%</strong></li>)}</ul> : <p className="mt-2 text-sm text-slate-500">No practice attempts yet.</p>}
                </section>
                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Online examinations</h2>
                  {list('onlineExams').length ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      {list('onlineExams').map((exam) => {
                        const attempt = exam.attempt as Record<string, unknown> | null;
                        const hasAttempt = Boolean(attempt);
                        const submitted = Boolean(attempt?.submitted_at);
                        const isActive = hasAttempt && !submitted && new Date(String(attempt?.expires_at)).getTime() > Date.now();
                        return (
                          <article key={String(exam.exam_code)} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                            <h3 className="font-bold text-slate-900">{String(exam.exam_name)}</h3>
                            <p className="mt-1 text-xs text-slate-500">{String(exam.exam_code)} · {String(exam.question_count)} questions · {String(exam.duration_minutes)} minutes</p>
                            {submitted && <p className="mt-2 text-sm text-emerald-800">Attempt completed. Score: {String((attempt?.score as Record<string, unknown> | undefined)?.totalScore ?? 'Submitted')}</p>}
                            {!submitted && hasAttempt && !isActive && <p className="mt-2 text-sm text-amber-800">Attempt expired.</p>}
                            <button type="button" disabled={hasAttempt && !isActive} onClick={() => setActiveOnlineExam({ code: String(exam.exam_code), name: String(exam.exam_name) })} className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-400">{isActive ? 'Resume exam' : hasAttempt ? 'Attempt used' : 'Start exam'}</button>
                          </article>
                        );
                      })}
                    </div>
                  ) : <p className="mt-3 text-sm text-slate-500">No published online exams are available for your approved applications.</p>}
                </section>
              </div>
            )}

            {user.role === 'center' && (
              <div className="mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
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

            {user.role === 'center' && (
              <div className="mt-5 space-y-5">
                <div className="grid gap-5 lg:grid-cols-2">
                  <form onSubmit={(event) => void submitInstituteForm(event)} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div>
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

                  <div className="space-y-5">
                    <form onSubmit={(event) => void submitInstituteProfile(event)} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
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
                  </div>
                </div>

                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
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
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">My submitted forms</h2>
                  {list('forms').length ? <div className="mt-3 grid gap-3 md:grid-cols-2">{list('forms').map((form) => <article key={String(form.id)} className="rounded-lg border border-slate-200 p-4"><div className="flex justify-between gap-2"><h3 className="font-bold text-slate-900">{String(form.title)}</h3><span className="text-xs font-bold capitalize text-slate-600">{String(form.status)}</span></div><p className="mt-1 text-xs text-slate-500">{form.form_type === 'teacher_recruitment' ? 'Teacher recruitment' : 'Exam application'} · Submitted {new Date(String(form.created_at)).toLocaleDateString()}</p><p className="mt-2 text-sm text-slate-600">{String(form.description)}</p></article>)}</div> : <p className="mt-3 text-sm text-slate-500">No institute forms submitted yet.</p>}
                </section>
              </div>
            )}

            {user.role === 'official' && tab === 'applications' && <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Application</th><th className="p-4">Candidate / exam</th><th className="p-4">Submitted</th><th className="p-4">Status</th><th className="p-4">Admit card</th></tr></thead><tbody className="divide-y divide-slate-100">{list('applications').map((item) => <tr key={String(item.id)}><td className="p-4 font-mono font-bold">{String(item.application_number)}</td><td className="p-4">{String(item.candidate_name)}<span className="block text-xs text-slate-500">{String(item.exam_code)}</span></td><td className="p-4 text-slate-500">{new Date(String(item.created_at)).toLocaleDateString()}</td><td className="p-4"><select aria-label={`Status for ${String(item.application_number)}`} value={String(item.status)} onChange={(event) => void updateApplication(String(item.id), event.target.value)} className="rounded-md border border-slate-300 px-2 py-1"><option value="submitted">Submitted</option><option value="under_review">Under review</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></td><td className="p-4 text-xs">{item.admit_card_published ? 'Published' : 'Not published'}</td></tr>)}</tbody></table></section>}

            {user.role === 'official' && tab === 'feedback' && <section className="space-y-3">{list('feedback').length ? list('feedback').map((item) => <article key={String(item.id)} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-bold text-[#0B2E59]">{String(item.title)}</p><p className="mt-1 text-xs text-slate-500">{String(item.id)} · {String(item.type)} · {String(item.priority)}</p></div><select aria-label={`Status for ${String(item.id)}`} value={String(item.status)} onChange={(event) => void updateFeedback(String(item.id), event.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm"><option value="under_review">Under review</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select></div><p className="mt-3 text-sm text-slate-700">{String(item.description)}</p></article>) : <p className="rounded-xl bg-white p-6 text-sm text-slate-500">No helpdesk tickets have been submitted.</p>}</section>}

            {user.role === 'official' && tab === 'attempts' && <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Account</th><th className="p-4">Submitted</th><th className="p-4">Questions</th><th className="p-4">Score</th></tr></thead><tbody className="divide-y divide-slate-100">{list('attempts').map((item) => <tr key={String(item.id)}><td className="p-4">{String(item.display_name ?? item.login_id ?? 'Guest')}<span className="block text-xs text-slate-500">{String(item.login_id ?? '')}</span></td><td className="p-4">{new Date(String(item.submitted_at)).toLocaleString()}</td><td className="p-4">{String(item.correct)} / {String(item.total_questions)}</td><td className="p-4 font-bold">{String(item.percentage)}%</td></tr>)}</tbody></table></section>}

            {user.role === 'official' && tab === 'results' && (
              <section className="space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-extrabold text-[#0B2E59]">Bulk result upload</h2>
                  <p className="mt-1 text-sm text-slate-600">Import verified scorecards from the Results worksheet. They remain unpublished until you explicitly publish them below.</p>
                  <button type="button" onClick={downloadUploadTemplates} className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-800 hover:underline"><Download className="h-4 w-4" /> Download Excel templates</button>
                  <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm font-semibold text-slate-700 hover:bg-blue-50">
                    <Upload className="h-5 w-5" />
                    {uploading === 'results' ? 'Uploading…' : 'Choose result workbook (.xlsx)'}
                    <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={uploading !== null} onChange={(event) => { void uploadWorkbook('results', event.target.files?.[0]); event.target.value = ''; }} />
                  </label>
                  <p className="mt-2 text-xs text-slate-500">The template uses a scorecardJson column containing the complete scorecard JSON for each row.</p>
                </div>
                <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Application</th><th className="p-4">Roll number</th><th className="p-4">Exam</th><th className="p-4">Status</th><th className="p-4">Published</th><th className="p-4">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{list('results').map((item) => <tr key={String(item.id)}><td className="p-4 font-mono">{String(item.application_number)}</td><td className="p-4">{String(item.roll_number)}</td><td className="p-4">{String(item.exam_code)}</td><td className="p-4">{item.is_published ? 'Published' : 'Draft'}</td><td className="p-4">{new Date(String(item.published_at)).toLocaleString()}</td><td className="p-4"><button type="button" onClick={() => void publishAdminRecord(`/api/admin/results/${encodeURIComponent(String(item.id))}`, !Boolean(item.is_published), 'Result')} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-bold text-white">{item.is_published ? 'Unpublish' : 'Publish result'}</button></td></tr>)}</tbody></table></section>
              </section>
            )}
          </>
        )}
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
    </main>
  );
};
