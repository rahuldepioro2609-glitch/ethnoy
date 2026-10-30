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
import { NOTICES, ExamItem, NoticeItem } from './data/portalData';
import { UserCheck, LogOut, CheckCircle2 } from 'lucide-react';
import { ApiError, apiRequest } from './api';
import { PortalRole, RoleDashboard, RoleLoginPage } from './components/RolePortal';

function dateOnlyValue(value: string): number {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
  ) return Number.NaN;
  return date.getTime();
}

function mapPublishedExam(exam: Record<string, unknown>): ExamItem {
  const examDate = String(exam.examDate).slice(0, 10);
  const regStart = String(exam.regStart).slice(0, 10);
  const regEnd = String(exam.regEnd).slice(0, 10);
  const examDateValue = new Date(dateOnlyValue(examDate));
  const today = new Date();
  const todayValue = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startValue = dateOnlyValue(regStart);
  const endValue = dateOnlyValue(regEnd);
  const isButtonActive = Number.isFinite(startValue) && Number.isFinite(endValue) &&
    todayValue.getTime() >= startValue && todayValue.getTime() <= endValue;
  return {
    id: String(exam.id),
    code: String(exam.code),
    name: String(exam.name),
    category: exam.category as ExamItem['category'],
    targetAudience: String(exam.targetAudience),
    day: String(examDateValue.getDate()).padStart(2, '0'),
    month: examDateValue.toLocaleString('en', { month: 'short' }).toUpperCase(),
    regStart,
    regEnd,
    examDate,
    fee: String(exam.fee),
    status: isButtonActive ? 'Apply Now' : 'Apply Soon',
    isButtonActive,
    duration: String(exam.duration),
    mode: String(exam.mode),
    shifts: String(exam.shifts),
    syllabusHighlights: [],
  };
}

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(0);
  const [highContrast, setHighContrast] = useState<boolean>(false);
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
  const [pendingApplyExam, setPendingApplyExam] = useState<ExamItem | null>(null);
  const [selectedExamFilter, setSelectedExamFilter] = useState<string | undefined>(undefined);
  const [publishedExams, setPublishedExams] = useState<ExamItem[]>([]);

  // User state
  const [loggedInUser, setLoggedInUser] = useState<{ name: string; role: string; id: string; accountRole: PortalRole } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [systemAlert, setSystemAlert] = useState<string | null>(null);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setPathname(path);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

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

  useEffect(() => {
    apiRequest<{ exams: Record<string, unknown>[] }>('/api/exams')
      .then(({ exams }) => setPublishedExams(exams.map(mapPublishedExam)))
      .catch((error: unknown) => {
        setSystemAlert(error instanceof Error ? error.message : 'Could not load published exam forms.');
      });
  }, []);

  useEffect(() => {
    apiRequest<{
      user: { loginId: string; name: string; role: 'candidate' | 'center' | 'official' };
    }>('/api/auth/me')
      .then(({ user }) => {
        const roleLabels = {
          candidate: 'Registered Candidate',
          center: 'Test Center Admin',
          official: 'Assessment Official',
        };
        setLoggedInUser({ name: user.name, role: roleLabels[user.role], id: user.loginId, accountRole: user.role });
      })
      .catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 401)) {
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
        setIsAdmitCardOpen(true);
        break;
      case 'cbt-mock':
      case 'cbt-exam':
        setIsMockExamOpen(true);
        break;
      case 'answer-key':
        setIsAnswerKeyOpen(true);
        break;
      case 'results':
      case 'result':
        setIsResultOpen(true);
        break;
      case 'ai-proctoring':
        navigate('/login/official');
        break;
      case 'grievance':
        handleOpenGrievance();
        break;
      case 'centers':
        setIsCenterLocatorOpen(true);
        break;
      default:
        break;
    }
  };

  const handleOpenExamApply = (exam: ExamItem) => {
    const today = new Date();
    const todayValue = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const registrationStart = dateOnlyValue(exam.regStart);
    const registrationEnd = dateOnlyValue(exam.regEnd);
    if (!exam.isButtonActive || Number.isNaN(registrationEnd) || Number.isNaN(registrationStart) || todayValue < registrationStart || todayValue > registrationEnd) {
      setSystemAlert(`Applications for ${exam.name} are not open. Please check the exam schedule.`);
      window.setTimeout(() => setSystemAlert(null), 6000);
      return;
    }
    if (!loggedInUser || loggedInUser.accountRole !== 'candidate') {
      setPendingApplyExam(exam);
      navigate('/login/candidate');
      return;
    }
    setActiveApplyExam(exam);
  };

  const handleOpenGrievance = () => {
    setIsFeedbackOpen(true);
    setSystemAlert('Candidate helpdesk is open. Submit your issue using the feedback panel.');
    setTimeout(() => setSystemAlert(null), 6000);
  };

  const handleNoticeCategoryFilter = (category: string) => {
    const matched = NOTICES.find((n) => n.category === category);
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

  useEffect(() => {
    if (authLoading || !pathname.startsWith('/dashboard/')) return;
    if (!dashboardRole || !loggedInUser || loggedInUser.accountRole !== dashboardRole) {
      navigate(loggedInUser ? `/dashboard/${loggedInUser.accountRole}` : `/login/${dashboardRole ?? 'candidate'}`);
    }
  }, [authLoading, dashboardRole, loggedInUser, pathname]);

  useEffect(() => {
    if (!authLoading && loggedInUser && pathname.startsWith('/login')) {
      navigate(`/dashboard/${loggedInUser.accountRole}`);
    }
  }, [authLoading, loggedInUser, pathname]);

  const handlePortalLogin = (user: { name: string; id: string; role: PortalRole }) => {
    const roleLabels: Record<PortalRole, string> = {
      candidate: 'Registered Candidate',
      center: 'Test Center Admin',
      official: 'Assessment Official',
    };
    setLoggedInUser({ ...user, accountRole: user.role, role: roleLabels[user.role] });
    if (user.role === 'candidate' && pendingApplyExam) {
      navigate('/');
      setActiveApplyExam(pendingApplyExam);
      setPendingApplyExam(null);
    } else {
      navigate(`/dashboard/${user.role}`);
    }
  };

  if (pathname.startsWith('/login')) {
    if (authLoading) return <main className="min-h-screen bg-[#eef5fa] p-10 text-center text-slate-600">Checking secure session…</main>;
    if (loggedInUser) return <main className="min-h-screen bg-[#eef5fa] p-10 text-center text-slate-600">Opening your dashboard…</main>;
    return <RoleLoginPage role={loginRole} onBack={() => navigate('/')} onLogin={handlePortalLogin} />;
  }

  if (pathname.startsWith('/dashboard/')) {
    if (authLoading) return <main className="min-h-screen bg-[#eef5fa] p-10 text-center text-slate-600">Checking secure session…</main>;
    if (!loggedInUser || !dashboardRole || loggedInUser.accountRole !== dashboardRole) {
      return <main className="min-h-screen bg-[#eef5fa] p-10 text-center text-slate-600">Redirecting to sign in…</main>;
    }
    return (
      <RoleDashboard
        user={{ name: loggedInUser.name, id: loggedInUser.id, role: loggedInUser.accountRole }}
        onLogout={handleLogout}
        onHome={() => navigate('/')}
        onOpenAdmitCard={() => {
          navigate('/');
          setIsAdmitCardOpen(true);
        }}
        onOpenResults={() => {
          navigate('/');
          setIsResultOpen(true);
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
        onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
        onOpenMockExam={() => setIsMockExamOpen(true)}
        onOpenCenterLocator={() => setIsCenterLocatorOpen(true)}
        onOpenNoticeCategory={handleNoticeCategoryFilter}
        onSelectExamFilter={(examId) => setSelectedExamFilter(examId)}
        onOpenResultsPortal={() => setIsResultOpen(true)}
        onOpenAnswerKeyPortal={() => setIsAnswerKeyOpen(true)}
        onOpenInstituteDashboard={() => navigate('/login/center')}
        onOpenAiProctoring={() => navigate('/login/official')}
        examinations={publishedExams}
        activeNavTab={activeNavTab}
        setActiveNavTab={setActiveNavTab}
      />

      <div role="note" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-950">
        Preview environment: exam schedules, notices, center details, and answer keys contain sample content. Verify and replace it before accepting public applications.
      </div>

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
              <span className="hidden sm:inline">Sign out</span>
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
          onOpenMockExam={() => setIsMockExamOpen(true)}
          onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
          onOpenResults={() => setIsResultOpen(true)}
          onOpenAnswerKey={() => setIsAnswerKeyOpen(true)}
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
          filterExamId={selectedExamFilter}
          isAuthenticated={Boolean(loggedInUser)}
        />

        {/* FREQUENTLY ASKED QUESTIONS (FAQ) ACCORDION */}
        <FAQAccordion
          onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
          onOpenMockExam={() => setIsMockExamOpen(true)}
          onOpenExamApply={() => {
            const openExam = publishedExams.find((exam) => exam.isButtonActive);
            if (openExam) handleOpenExamApply(openExam);
            else setSystemAlert('No exam applications are currently open.');
          }}
          onOpenCenterLocator={() => setIsCenterLocatorOpen(true)}
          onOpenFeedback={handleOpenGrievance}
        />
      </main>

      {/* FOOTER VALUE PROP: "Why Choose ELTNOY?" 4-Item Horizontal Strip + Full Directory */}
      <FooterValueProp
        onOpenGrievance={handleOpenGrievance}
        onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
        onOpenMockExam={() => setIsMockExamOpen(true)}
        onOpenCenterLocator={() => setIsCenterLocatorOpen(true)}
        onOpenResults={() => setIsResultOpen(true)}
      />

      {/* Interactive Modals */}
      <AdmitCardModal
        isOpen={isAdmitCardOpen}
        onClose={() => setIsAdmitCardOpen(false)}
        defaultExamCode="ENT-2025"
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
        onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
        onOpenMockExam={() => setIsMockExamOpen(true)}
        examinations={publishedExams}
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
      />

      {/* Answer Key & Objection Tracker */}
      <AnswerKeyObjectionModal
        isOpen={isAnswerKeyOpen}
        onClose={() => setIsAnswerKeyOpen(false)}
      />

      {/* Persistent Feedback & Bug Report Slide-out Panel */}
      <FeedbackSlideOut
        isOpen={isFeedbackOpen}
        onOpen={() => setIsFeedbackOpen(true)}
        onClose={() => setIsFeedbackOpen(false)}
        loggedInUser={loggedInUser}
      />
    </div>
  );
}
