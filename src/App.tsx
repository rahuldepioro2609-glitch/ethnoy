/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { TopUtilityBar } from './components/TopUtilityBar';
import { StickyNavbar } from './components/StickyNavbar';
import { HeroSection } from './components/HeroSection';
import { MetricsBanner } from './components/MetricsBanner';
import { ThreeColumnDataGrid } from './components/ThreeColumnDataGrid';
import { FAQAccordion } from './components/FAQAccordion';
import { FooterValueProp } from './components/FooterValueProp';
import { AdmitCardModal } from './components/AdmitCardModal';
import { CbtMockExamModal } from './components/CbtMockExamModal';
import { GlobalSearchModal } from './components/GlobalSearchModal';
import { CenterLocatorModal } from './components/CenterLocatorModal';
import { NoticeDetailModal } from './components/NoticeDetailModal';
import { ExamApplyModal } from './components/ExamApplyModal';
import { CandidateResultModal } from './components/CandidateResultModal';
import { AnswerKeyObjectionModal } from './components/AnswerKeyObjectionModal';
import { FeedbackSlideOut } from './components/FeedbackSlideOut';
import { ExamItem, NoticeItem } from './data/portalData';
import { UserCheck, LogOut, CheckCircle2, BellRing, CalendarDays } from 'lucide-react';
import { ApiError, apiRequest, apiRequestWithMeta } from './api';
import { PortalRole, RoleDashboard, RoleLoginPage } from './components/RolePortal';
import { PlatformStaffPortal } from './components/staff/PlatformStaffPortal';
import { isPlatformStaffPath } from './utils/staffAccess';
import { DEFAULT_EXAM_TIME_ZONE, getDateOnlyParts, isRegistrationOpen } from './utils/examSchedule';
import { LANGUAGE_LOCALES, Language } from './utils/languageLogic';
import { useLanguage } from './utils/languageContext';
import { ADMIN_HOME_PATH, planSurfaceNavigation, requiredSurfaceForPath, type DisclosedSurfaceHostnames } from './utils/surfaceNavigation';

function mapPublishedExam(exam: Record<string, unknown>, locale: string): ExamItem {
  const examDate = String(exam.examDate).slice(0, 10);
  const regStart = String(exam.regStart).slice(0, 10);
  const regEnd = String(exam.regEnd).slice(0, 10);
  const timeZone = String(exam.timeZone || DEFAULT_EXAM_TIME_ZONE);
  const dateParts = getDateOnlyParts(examDate, locale);
  const isButtonActive = isRegistrationOpen(regStart, regEnd, timeZone);
  return {
    id: String(exam.id),
    code: String(exam.code),
    name: String(exam.name),
    category: exam.category as ExamItem['category'],
    targetAudience: String(exam.targetAudience),
    day: dateParts.day,
    month: dateParts.month,
    regStart,
    regEnd,
    examDate,
    timeZone,
    fee: String(exam.fee),
    status: isButtonActive ? 'Apply Now' : 'Apply Soon',
    isButtonActive,
    duration: String(exam.duration),
    mode: String(exam.mode),
    shifts: String(exam.shifts),
    syllabusHighlights: [],
  };
}

function mapPublishedNotice(notice: Record<string, unknown>, locale: string): NoticeItem {
  const publishedAt = new Date(String(notice.published_at));
  const validDate = Number.isFinite(publishedAt.getTime()) ? publishedAt : new Date();
  return {
    id: String(notice.id),
    day: new Intl.DateTimeFormat(locale, { day: '2-digit' }).format(validDate),
    month: new Intl.DateTimeFormat(locale, { month: 'short' }).format(validDate),
    title: String(notice.title),
    date: validDate.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' }),
    category: notice.category as NoticeItem['category'],
    isNew: Date.now() - validDate.getTime() < 7 * 24 * 60 * 60 * 1000,
    summary: String(notice.summary),
    fullContent: String(notice.full_content),
    refNo: String(notice.reference_number),
  };
}

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(0);
  const [highContrast, setHighContrast] = useState<boolean>(false);
  const { language, t } = useLanguage();
  const [activeNavTab, setActiveNavTab] = useState<string>('Home');

  // Active Modals
  const [isAdmitCardOpen, setIsAdmitCardOpen] = useState(false);
  const [isMockExamOpen, setIsMockExamOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCenterLocatorOpen, setIsCenterLocatorOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [isResultOpen, setIsResultOpen] = useState(false);
  const [isAnswerKeyOpen, setIsAnswerKeyOpen] = useState(false);
  const [activeNotice, setActiveNotice] = useState<NoticeItem | null>(null);
  const [activeApplyExam, setActiveApplyExam] = useState<ExamItem | null>(null);
  const [pendingServiceAction, setPendingServiceAction] = useState<(() => void) | null>(null);
  const [selectedExamFilter, setSelectedExamFilter] = useState<string | undefined>(undefined);
  const [publishedExams, setPublishedExams] = useState<ExamItem[]>([]);
  const [publishedInstituteForms, setPublishedInstituteForms] = useState<Record<string, unknown>[]>([]);
  const [portalNotices, setPortalNotices] = useState<NoticeItem[]>([]);
  const [noticeLoadError, setNoticeLoadError] = useState<string | null>(null);

  // User state
  const [loggedInUser, setLoggedInUser] = useState<{ name: string; role: string; id: string; accountRole: PortalRole; isSuperAdmin: boolean } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [systemAlert, setSystemAlert] = useState<string | null>(null);
  // GET /api/surface-hostnames: public surfaces omit the private Admin hostname.
  const [surfaceHostnames, setSurfaceHostnames] = useState<DisclosedSurfaceHostnames | null>(null);
  const [surfaceRoutingFailed, setSurfaceRoutingFailed] = useState(false);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setPathname(path);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [language]);

  // Keyboard shortcut listener for Ctrl+K / Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
        setIsAdmitCardOpen(false);
        setIsMockExamOpen(false);
        setIsCenterLocatorOpen(false);
        setIsFeedbackOpen(false);
        setIsResultOpen(false);
        setIsAnswerKeyOpen(false);
        setActiveNotice(null);
        setActiveApplyExam(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // On the Exam surface GET /api/exams needs a Student session, so the list is reloaded whenever a
  // Student signs in or out (not for Institute/Official sign-ins). Only the latest request may update
  // state, and a failed load clears the list so lookups show their unavailable state.
  const candidateSessionKey = loggedInUser?.accountRole === 'candidate' ? loggedInUser.id : null;
  useEffect(() => {
    let active = true;
    apiRequest<{ exams: Record<string, unknown>[] }>('/api/exams')
      .then(({ exams }) => {
        if (active) setPublishedExams(exams.map((exam) => mapPublishedExam(exam, LANGUAGE_LOCALES[language])));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPublishedExams([]);
        setSystemAlert(error instanceof Error ? error.message : 'Could not load published exam forms.');
      });
    return () => { active = false; };
  }, [language, candidateSessionKey]);

  useEffect(() => {
    let active = true;
    const loadInstituteForms = () => {
      apiRequest<{ forms: Record<string, unknown>[] }>('/api/institute-forms')
        .then(({ forms }) => {
          if (active) setPublishedInstituteForms(forms);
        })
        .catch((error: unknown) => {
          if (active) {
            setSystemAlert(error instanceof Error ? error.message : 'Could not load approved institute forms.');
          }
        });
    };
    loadInstituteForms();
    const interval = window.setInterval(loadInstituteForms, 30_000);
    window.addEventListener('focus', loadInstituteForms);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', loadInstituteForms);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadNotices = () => {
      apiRequest<{ notices: Record<string, unknown>[] }>('/api/notices')
        .then(({ notices }) => {
          if (!active) return;
          setPortalNotices(notices.map((notice) => mapPublishedNotice(notice, LANGUAGE_LOCALES[language])));
          setNoticeLoadError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setNoticeLoadError(error instanceof Error ? error.message : 'Could not load published notices.');
        });
    };
    loadNotices();
    const interval = window.setInterval(loadNotices, 30_000);
    window.addEventListener('focus', loadNotices);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', loadNotices);
    };
  }, [language]);

  useEffect(() => {
    // apiRequestWithMeta (rather than apiRequest) so the error carries the server's `code`.
    apiRequestWithMeta<{
      user: { loginId: string; name: string; role: 'candidate' | 'center' | 'official'; isSuperAdmin: boolean };
    }>('/api/auth/me')
      .then(({ data: { user } }) => {
        const roleLabels = {
          candidate: 'Registered Candidate',
          center: 'Test Center Admin',
          official: 'Assessment Official',
        };
        setLoggedInUser({
          name: user.name,
          role: roleLabels[user.role],
          id: user.loginId,
          accountRole: user.role,
          isSuperAdmin: user.isSuperAdmin,
        });
      })
      .catch((error: unknown) => {
        // AUTH C1.9.2: an Official session without MFA (for example one issued before MFA) is refused by
        // the server, which also clears its cookie. That is a signed-out state, not a system fault.
        const signedOut = error instanceof ApiError && (error.status === 401 || (error.status === 403 && error.code === 'ADMIN_MFA_REQUIRED'));
        if (!signedOut) {
          setSystemAlert(error instanceof Error ? error.message : 'Could not connect to the account service.');
        }
      })
      .finally(() => setAuthLoading(false));
  }, []);

  const handleLogout = async () => {
    try {
      await apiRequest<void>('/api/auth/logout', { method: 'POST' });
      setLoggedInUser(null);
      navigate('/');
    } catch (error) {
      setSystemAlert(error instanceof Error ? error.message : 'Could not sign out. Please try again.');
    }
  };

  const requireCandidateLogin = (action: () => void) => {
    if (loggedInUser?.accountRole === 'candidate') {
      action();
      return;
    }
    if (loggedInUser) {
      setSystemAlert('Please sign in with a student account to use this service.');
      return;
    }
    setPendingServiceAction(() => action);
    navigate('/login/candidate');
  };

  const handleOpenAdmitCard = () => requireCandidateLogin(() => setIsAdmitCardOpen(true));
  const handleOpenMockExam = () => requireCandidateLogin(() => setIsMockExamOpen(true));
  const handleOpenAnswerKey = () => requireCandidateLogin(() => setIsAnswerKeyOpen(true));
  const handleOpenResults = () => requireCandidateLogin(() => setIsResultOpen(true));
  const handleOpenCenterLocator = () => requireCandidateLogin(() => setIsCenterLocatorOpen(true));

  const handleQuickLinkAction = (actionId: string) => {
    switch (actionId) {
      case 'apply':
        {
          const openExam = publishedExams.find((exam) => exam.isButtonActive);
          if (openExam) handleOpenExamApply(openExam);
          else setSystemAlert('No exam applications are currently open.');
        }
        break;
      case 'login-student':
        navigate('/login/candidate');
        break;
      case 'login-institute':
      case 'institute-dashboard':
        navigate('/login/center');
        break;
      case 'admit-card':
        handleOpenAdmitCard();
        break;
      case 'cbt-mock':
      case 'cbt-exam':
        handleOpenMockExam();
        break;
      case 'answer-key':
        handleOpenAnswerKey();
        break;
      case 'results':
      case 'result':
        handleOpenResults();
        break;
      case 'grievance':
        handleOpenGrievance();
        break;
      case 'centers':
        handleOpenCenterLocator();
        break;
      default:
        break;
    }
  };

  const handleOpenExamApply = (exam: ExamItem) => {
    if (!exam.isButtonActive || !isRegistrationOpen(exam.regStart, exam.regEnd, exam.timeZone || DEFAULT_EXAM_TIME_ZONE)) {
      setSystemAlert(`Applications for ${exam.name} are not open. Please check the exam schedule.`);
      window.setTimeout(() => setSystemAlert(null), 6000);
      return;
    }
    requireCandidateLogin(() => setActiveApplyExam(exam));
  };

  const handleOpenGrievance = () => {
    requireCandidateLogin(() => {
      setIsFeedbackOpen(true);
      setSystemAlert('Candidate helpdesk is open. Submit your issue using the feedback panel.');
      setTimeout(() => setSystemAlert(null), 6000);
    });
  };

  const handleNoticeCategoryFilter = (category: string) => {
    const matched = portalNotices.find((n) => n.category === category);
    if (matched) {
      setActiveNotice(matched);
    } else {
      setIsSearchOpen(true);
    }
  };

  const getFontSizeClass = () => {
    if (fontSizeLevel === -1) return 'text-[92%]';
    if (fontSizeLevel === 1) return 'text-[108%]';
    if (fontSizeLevel === 2) return 'text-[116%]';
    return 'text-[100%]';
  };

  const dashboardRole = pathname.match(/^\/dashboard\/(candidate|center|official)\/?$/)?.[1] as PortalRole | undefined;
  const loginRole = pathname.match(/^\/login\/(candidate|center|official)\/?$/)?.[1] as PortalRole | undefined;

  // SM-1: Platform Staff pages have their own session and are never redirected by portal sessions.
  const platformStaffPage = isPlatformStaffPath(pathname);
  const pathSurface = requiredSurfaceForPath(pathname);
  // The Exam root is the candidate home. Wait for its host-only session lookup before
  // deciding whether a root visit belongs on Exam or public Marketing.
  const requiredSurface = platformStaffPage ? 'admin' : pathname === '/'
    ? authLoading ? null : loggedInUser?.accountRole === 'candidate' ? 'exam' : 'marketing'
    : pathSurface;

  // Each role's session cookie belongs to its own hostname. Public surfaces disclose only the public
  // hostnames, so the public site can never route to (or learn) the private Admin hostname.
  useEffect(() => {
    let active = true;
    apiRequest<{ hostnames: DisclosedSurfaceHostnames }>('/api/surface-hostnames')
      .then(({ hostnames }) => {
        if (active) setSurfaceHostnames(hostnames);
      })
      .catch(() => {
        if (active) setSurfaceRoutingFailed(true);
      });
    return () => { active = false; };
  }, []);

  const navigationPlan = surfaceHostnames
    ? planSurfaceNavigation(window.location.href, requiredSurface, surfaceHostnames)
    : null;
  const navigationKey = navigationPlan
    ? `${navigationPlan.action}:${navigationPlan.action === 'redirect' ? navigationPlan.url : pathname}`
    : null;

  // Move role flows to their own host, return signed-out visitors to Marketing for public content, and
  // keep the Admin host on Admin sign-in instead of public pages.
  useEffect(() => {
    if (!navigationPlan) return;
    if (navigationPlan.action === 'redirect') window.location.assign(navigationPlan.url);
    else if (navigationPlan.action === 'admin_home') {
      window.history.replaceState({}, '', ADMIN_HOME_PATH);
      setPathname(ADMIN_HOME_PATH);
    } else if (navigationPlan.action === 'invalid') {
      setSystemAlert('The portal hostname configuration is invalid. Please contact support.');
    }
  }, [navigationKey]);

  useEffect(() => {
    if (surfaceRoutingFailed && requiredSurface && requiredSurface !== 'admin') {
      setSystemAlert('Could not load portal routing configuration. Please try again.');
    }
  }, [surfaceRoutingFailed, requiredSurface]);

  useEffect(() => {
    if (authLoading || platformStaffPage || !pathname.startsWith('/dashboard/')) return;
    if (!dashboardRole || !loggedInUser || loggedInUser.accountRole !== dashboardRole) {
      navigate(loggedInUser ? `/dashboard/${loggedInUser.accountRole}` : `/login/${dashboardRole ?? 'candidate'}`);
    }
  }, [authLoading, dashboardRole, loggedInUser, pathname, platformStaffPage]);

  useEffect(() => {
    if (!authLoading && loggedInUser && !platformStaffPage && pathname.startsWith('/login')) {
      navigate(`/dashboard/${loggedInUser.accountRole}`);
    }
  }, [authLoading, loggedInUser, pathname, platformStaffPage]);

  const handlePortalLogin = (user: { name: string; id: string; role: PortalRole; isSuperAdmin: boolean }) => {
    const roleLabels: Record<PortalRole, string> = {
      candidate: 'Registered Candidate',
      center: 'Test Center Admin',
      official: 'Assessment Official',
    };
    setLoggedInUser({ ...user, accountRole: user.role, role: roleLabels[user.role] });
    if (user.role === 'candidate' && pendingServiceAction) {
      navigate('/');
      pendingServiceAction();
      setPendingServiceAction(null);
    } else {
      navigate(`/dashboard/${user.role}`);
    }
  };

  // Admin and Platform Staff pages render only on the Admin host, confirmed by the server's surface
  // answer. Anywhere else (the public site, a static preview, a failed lookup) they are "not found".
  if (requiredSurface === 'admin' && navigationPlan?.action !== 'stay') {
    if (surfaceRoutingFailed || navigationPlan?.action === 'not_found') {
      return (
        <main className="min-h-screen bg-[#EEF6F1] p-10 text-center text-slate-700">
          <h1 className="text-2xl font-black text-[#0B2E59]">Page not found</h1>
          <p className="mt-2 text-sm text-slate-600">This page is not available on this website.</p>
          <button type="button" onClick={() => navigate('/')} className="mt-6 rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-600">Go to the home page</button>
        </main>
      );
    }
    return <main className="min-h-screen bg-[#EEF6F1] p-10 text-center text-slate-600">Checking secure connection…</main>;
  }

  if (platformStaffPage) {
    return <PlatformStaffPortal pathname={pathname} navigate={navigate} onHome={() => navigate('/')} />;
  }

  if (pathname.startsWith('/login')) {
    if (authLoading) return <main className="min-h-screen bg-[#EEF6F1] p-10 text-center text-slate-600">Checking secure session…</main>;
    if (loggedInUser) return <main className="min-h-screen bg-[#EEF6F1] p-10 text-center text-slate-600">Opening your dashboard…</main>;
    return <RoleLoginPage role={loginRole} surfaceHostnames={surfaceHostnames} onBack={() => navigate('/')} onLogin={handlePortalLogin} />;
  }

  if (pathname.startsWith('/dashboard/')) {
    if (authLoading) return <main className="min-h-screen bg-[#EEF6F1] p-10 text-center text-slate-600">Checking secure session…</main>;
    if (!loggedInUser || !dashboardRole || loggedInUser.accountRole !== dashboardRole) {
      return <main className="min-h-screen bg-[#EEF6F1] p-10 text-center text-slate-600">Redirecting to sign in…</main>;
    }
    return (
      <RoleDashboard
        user={{
          name: loggedInUser.name,
          id: loggedInUser.id,
          role: loggedInUser.accountRole,
          isSuperAdmin: loggedInUser.isSuperAdmin,
        }}
        onLogout={handleLogout}
        onHome={() => navigate('/')}
        onOpenAdmitCard={() => {
          navigate('/');
          handleOpenAdmitCard();
        }}
        onOpenResults={() => {
          navigate('/');
          handleOpenResults();
        }}
      />
    );
  }

  return (
    <div
      className={`min-h-screen flex flex-col transition-all ${loggedInUser ? 'pb-24' : ''} ${getFontSizeClass()} ${
        highContrast ? 'bg-black text-amber-300' : 'bg-white text-slate-900'
      }`}
    >
      {/* Top Utility Bar (Dark Navy #0B2E59): Welcome | Helpdesk | Phone | Email | Language */}
      <TopUtilityBar
        fontSizeLevel={fontSizeLevel}
        onFontSizeChange={setFontSizeLevel}
        highContrast={highContrast}
        onToggleHighContrast={() => setHighContrast((prev) => !prev)}
        onOpenGrievance={handleOpenGrievance}
      />

      {/* Sticky Navbar: ELTNOY Logo, navigation links, search, and account action */}
      <StickyNavbar
        onOpenSearch={() => setIsSearchOpen(true)}
        onOpenLogin={() => navigate(loggedInUser ? `/dashboard/${loggedInUser.accountRole}` : '/login')}
        isAuthenticated={Boolean(loggedInUser)}
        onOpenAdmitCard={handleOpenAdmitCard}
        onOpenMockExam={handleOpenMockExam}
        onOpenCenterLocator={handleOpenCenterLocator}
        onOpenNoticeCategory={handleNoticeCategoryFilter}
        onSelectExamFilter={(examId) => setSelectedExamFilter(examId)}
        onOpenResultsPortal={handleOpenResults}
        onOpenAnswerKeyPortal={handleOpenAnswerKey}
        onOpenInstituteDashboard={() => navigate('/login/center')}
        examinations={publishedExams}
        activeNavTab={activeNavTab}
        setActiveNavTab={setActiveNavTab}
      />

      <div role="note" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-950">
        {t('Preview environment: exam schedules, center details, and answer keys may contain sample content. Verify all information before accepting public applications.')}
      </div>

      <section aria-label="Latest portal updates" className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:px-6 lg:px-8">
          <div className="flex shrink-0 items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-[#0B2E59]">
            <BellRing className="h-4 w-4 text-amber-600" />
            <span>{t('Latest updates')}</span>
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            {portalNotices.length ? <div className="portal-news-track flex w-max items-center gap-6 py-1">
            {[...portalNotices, ...portalNotices].map((notice, index) => (
              <button
                key={`${notice.id}-${index}`}
                type="button"
                onClick={() => setActiveNotice(notice)}
                className="max-w-[280px] truncate text-left text-xs font-semibold text-slate-700 transition hover:text-emerald-700 sm:max-w-[360px]"
                aria-label={`Open ${notice.category} notice: ${notice.title}`}
              >
                <span className="mr-1.5 text-emerald-700">•</span>{notice.title}
              </button>
            ))}
            </div> : <p role={noticeLoadError ? 'alert' : 'status'} className="py-1 text-xs text-slate-500">{noticeLoadError ? `Notices could not be loaded: ${noticeLoadError}` : t('No updates have been published yet.')}</p>}
          </div>
          <button
            type="button"
            onClick={() => document.getElementById('exam-list')?.scrollIntoView({ behavior: 'smooth' })}
            className="hidden shrink-0 items-center gap-1 text-xs font-bold text-emerald-800 hover:text-emerald-600 sm:inline-flex"
          >
            <CalendarDays className="h-4 w-4" /> {t('Exam calendar')}
          </button>
        </div>
      </section>

      {/* Signed-in account bar */}
      {loggedInUser && (
        <div className="fixed inset-x-0 bottom-3 z-40 flex justify-center px-3 sm:bottom-5">
          <div className="flex w-full max-w-xl items-center gap-3 rounded-full border border-slate-200 bg-white/95 p-2 pl-2.5 shadow-[0_12px_36px_-14px_rgba(15,23,42,0.4)] backdrop-blur-md">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              loggedInUser.accountRole === 'official' ? 'bg-blue-100 text-blue-800'
                : loggedInUser.accountRole === 'center' ? 'bg-sky-100 text-sky-800'
                  : 'bg-emerald-100 text-emerald-800'
            }`}>
              <UserCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-bold text-slate-900">{loggedInUser.name}</p>
              <p className="truncate text-[11px] font-medium text-slate-500">
                {loggedInUser.role} <span className="px-1 text-slate-300">·</span> ID: {loggedInUser.id}
              </p>
            </div>
            <span className={`hidden rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide sm:inline-flex ${
              loggedInUser.accountRole === 'official' ? 'bg-blue-50 text-blue-800'
                : loggedInUser.accountRole === 'center' ? 'bg-sky-50 text-sky-800'
                  : 'bg-emerald-50 text-emerald-800'
            }`}>
              {loggedInUser.accountRole === 'official' ? 'Admin' : loggedInUser.accountRole === 'center' ? 'Institute' : 'Student'}
            </span>
            <button
              onClick={() => void handleLogout()}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-slate-900 px-4 text-xs font-bold text-white transition hover:bg-slate-700"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">{t('Sign out')}</span>
            </button>
          </div>
        </div>
      )}

      {/* System Toast Alert */}
      {systemAlert && (
        <div className="bg-[#0B254E] text-white px-4 py-2.5 text-xs text-center border-b border-sky-800 shadow-md flex items-center justify-center gap-2 animate-in slide-in-from-top-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{systemAlert}</span>
          <button
            onClick={() => setSystemAlert(null)}
            className="ml-3 text-slate-300 hover:text-white underline text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Page Layout */}
      <main className="flex-1">
        {/* HERO SECTION: Exact ELTNOY layout with script text "Your Future Our Mission" & 5 Action Cards */}
        <HeroSection
          onOpenApply={() => {
            const openExam = publishedExams.find((exam) => exam.isButtonActive);
            if (openExam) handleOpenExamApply(openExam);
            else setSystemAlert('No exam applications are currently open.');
          }}
          hasOpenExams={publishedExams.some((exam) => exam.isButtonActive)}
          onOpenMockExam={handleOpenMockExam}
          onOpenAdmitCard={handleOpenAdmitCard}
          onOpenResults={handleOpenResults}
          onOpenAnswerKey={handleOpenAnswerKey}
          onOpenInstituteDashboard={() => navigate('/login/center')}
          onOpenLogin={() => navigate(loggedInUser ? `/dashboard/${loggedInUser.accountRole}` : '/login')}
          isAuthenticated={Boolean(loggedInUser)}
        />

        {/* Portal capabilities */}
        <MetricsBanner />

        {/* THREE-COLUMN DATA GRID: Column 1 Notifications, Column 2 Upcoming Examinations, Column 3 Quick Links (6 tiles) */}
        <ThreeColumnDataGrid
          onOpenNotice={(notice) => setActiveNotice(notice)}
          onOpenExamApply={handleOpenExamApply}
          onQuickLinkAction={handleQuickLinkAction}
          examinations={publishedExams}
          notices={portalNotices}
          filterExamId={selectedExamFilter}
          isAuthenticated={Boolean(loggedInUser)}
        />

        <section aria-labelledby="institute-opportunities-heading" className="bg-white py-8">
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
            <div className="mb-4">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-800">Approved by ELTNOY Super Admin</p>
              <h2 id="institute-opportunities-heading" className="mt-1 text-2xl font-black text-[#0B2E59]">Institute exam & teacher forms</h2>
              <p className="mt-1 text-sm text-slate-600">These listings are published only after institute and form review. Applications are handled by the institute.</p>
            </div>
            {publishedInstituteForms.length ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {publishedInstituteForms.map((form) => (
                  <article key={String(form.id)} className="rounded-xl border border-slate-200 bg-slate-50 p-5 shadow-sm">
                    <span className="inline-flex rounded-full bg-sky-100 px-2.5 py-1 text-xs font-bold text-sky-800">{form.form_type === 'teacher_recruitment' ? 'Teacher recruitment' : 'Exam application'}</span>
                    <h3 className="mt-3 text-lg font-extrabold text-[#0B2E59]">{String(form.title)}</h3>
                    <p className="mt-1 text-sm font-semibold text-slate-600">{String(form.institute_name)}</p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{String(form.description)}</p>
                    <p className="mt-3 text-sm text-slate-600"><strong>Eligibility:</strong> {String(form.eligibility)}</p>
                    {typeof form.application_deadline === 'string' && form.application_deadline && <p className="mt-2 text-sm text-slate-600"><strong>Deadline:</strong> {form.application_deadline.slice(0, 10)}</p>}
                    {typeof form.external_url === 'string' && form.external_url ? (
                      <a href={form.external_url} target="_blank" rel="noreferrer" className="mt-4 inline-flex rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-sky-600">Apply on institute website</a>
                    ) : typeof form.contact_email === 'string' && form.contact_email ? (
                      <a href={`mailto:${form.contact_email}`} className="mt-4 inline-flex rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-sky-600">Contact institute</a>
                    ) : (
                      <p className="mt-4 text-xs text-slate-500">Contact the institute directly for application instructions.</p>
                    )}
                  </article>
                ))}
              </div>
            ) : <p className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">No approved institute forms are currently available.</p>}
          </div>
        </section>

        {/* FREQUENTLY ASKED QUESTIONS (FAQ) ACCORDION */}
        <FAQAccordion
          onOpenAdmitCard={handleOpenAdmitCard}
          onOpenMockExam={handleOpenMockExam}
          onOpenExamApply={() => {
            const openExam = publishedExams.find((exam) => exam.isButtonActive);
            if (openExam) handleOpenExamApply(openExam);
            else setSystemAlert('No exam applications are currently open.');
          }}
          onOpenCenterLocator={handleOpenCenterLocator}
          onOpenFeedback={handleOpenGrievance}
        />
      </main>

      {/* FOOTER VALUE PROP: "Why Choose ELTNOY?" 4-Item Horizontal Strip + Full Directory */}
      <FooterValueProp
        onOpenGrievance={handleOpenGrievance}
        onOpenAdmitCard={handleOpenAdmitCard}
        onOpenMockExam={handleOpenMockExam}
        onOpenCenterLocator={handleOpenCenterLocator}
        onOpenResults={handleOpenResults}
      />

      {/* Interactive Modals */}
      <AdmitCardModal
        isOpen={isAdmitCardOpen}
        onClose={() => setIsAdmitCardOpen(false)}
        publishedExams={publishedExams}
      />

      <CbtMockExamModal
        isOpen={isMockExamOpen}
        onClose={() => setIsMockExamOpen(false)}
      />

      <GlobalSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectExam={(exam) => {
          setSelectedExamFilter(exam.id);
          window.scrollTo({ top: 600, behavior: 'smooth' });
        }}
        onSelectNotice={(notice) => setActiveNotice(notice)}
        onOpenAdmitCard={handleOpenAdmitCard}
        onOpenMockExam={handleOpenMockExam}
        examinations={publishedExams}
        notices={portalNotices}
      />

      <CenterLocatorModal
        isOpen={isCenterLocatorOpen}
        onClose={() => setIsCenterLocatorOpen(false)}
      />

      <NoticeDetailModal
        notice={activeNotice}
        onClose={() => setActiveNotice(null)}
      />

      <ExamApplyModal
        exam={activeApplyExam}
        onClose={() => setActiveApplyExam(null)}
        onApplicationComplete={(appNo) => {
          setSystemAlert(`Application registration successful! Generated Application No: ${appNo}`);
        }}
      />

      {/* Candidate Result & Rank Card Portal */}
      <CandidateResultModal
        isOpen={isResultOpen}
        onClose={() => setIsResultOpen(false)}
        publishedExams={publishedExams}
      />

      {/* Answer Key & Objection Tracker */}
      <AnswerKeyObjectionModal
        isOpen={isAnswerKeyOpen}
        onClose={() => setIsAnswerKeyOpen(false)}
      />

      {/* Persistent Feedback & Bug Report Slide-out Panel */}
      <FeedbackSlideOut
        isOpen={isFeedbackOpen}
        onOpen={handleOpenGrievance}
        onClose={() => setIsFeedbackOpen(false)}
        loggedInUser={loggedInUser}
      />
    </div>
  );
}
