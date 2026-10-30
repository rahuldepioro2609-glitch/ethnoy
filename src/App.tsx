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
import { LoginModal } from './components/LoginModal';
import { NoticeDetailModal } from './components/NoticeDetailModal';
import { ExamApplyModal } from './components/ExamApplyModal';
import { CandidateResultModal } from './components/CandidateResultModal';
import { InstituteDashboardModal } from './components/InstituteDashboardModal';
import { AiProctoringModal } from './components/AiProctoringModal';
import { AnswerKeyObjectionModal } from './components/AnswerKeyObjectionModal';
import { FeedbackSlideOut } from './components/FeedbackSlideOut';
import { EXAMINATIONS, NOTICES, ExamItem, NoticeItem } from './data/portalData';
import { UserCheck, LogOut, CheckCircle2 } from 'lucide-react';

export default function App() {
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(0);
  const [highContrast, setHighContrast] = useState<boolean>(false);
  const [activeNavTab, setActiveNavTab] = useState<string>('Home');

  // Active Modals
  const [isAdmitCardOpen, setIsAdmitCardOpen] = useState(false);
  const [isMockExamOpen, setIsMockExamOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCenterLocatorOpen, setIsCenterLocatorOpen] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [isResultOpen, setIsResultOpen] = useState(false);
  const [isInstituteDashboardOpen, setIsInstituteDashboardOpen] = useState(false);
  const [isAiProctoringOpen, setIsAiProctoringOpen] = useState(false);
  const [isAnswerKeyOpen, setIsAnswerKeyOpen] = useState(false);
  const [activeNotice, setActiveNotice] = useState<NoticeItem | null>(null);
  const [activeApplyExam, setActiveApplyExam] = useState<ExamItem | null>(null);
  const [selectedExamFilter, setSelectedExamFilter] = useState<string | undefined>(undefined);

  // User state
  const [loggedInUser, setLoggedInUser] = useState<{ name: string; role: string; id: string } | null>(null);
  const [systemAlert, setSystemAlert] = useState<string | null>(null);

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
        setIsLoginOpen(false);
        setIsFeedbackOpen(false);
        setIsResultOpen(false);
        setIsInstituteDashboardOpen(false);
        setIsAiProctoringOpen(false);
        setIsAnswerKeyOpen(false);
        setActiveNotice(null);
        setActiveApplyExam(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleQuickLinkAction = (actionId: string) => {
    switch (actionId) {
      case 'apply':
        setActiveApplyExam(EXAMINATIONS[0]);
        break;
      case 'login-student':
        setIsLoginOpen(true);
        break;
      case 'login-institute':
      case 'institute-dashboard':
        setIsInstituteDashboardOpen(true);
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
        setIsAiProctoringOpen(true);
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

  const handleOpenGrievance = () => {
    setIsFeedbackOpen(true);
    setSystemAlert('Official ELTNOY Candidate Helpdesk & Bug Reporting active. Submit your ticket below or call +91-XXXXXXXXXX.');
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

  return (
    <div
      className={`min-h-screen flex flex-col transition-all ${getFontSizeClass()} ${
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

      {/* Sticky Navbar: ELTNOY Logo, Links with Green underline on Home, Search, Green Login CTA */}
      <StickyNavbar
        onOpenSearch={() => setIsSearchOpen(true)}
        onOpenLogin={() => setIsLoginOpen(true)}
        onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
        onOpenMockExam={() => setIsMockExamOpen(true)}
        onOpenCenterLocator={() => setIsCenterLocatorOpen(true)}
        onOpenNoticeCategory={handleNoticeCategoryFilter}
        onSelectExamFilter={(examId) => setSelectedExamFilter(examId)}
        onOpenResultsPortal={() => setIsResultOpen(true)}
        onOpenAnswerKeyPortal={() => setIsAnswerKeyOpen(true)}
        onOpenInstituteDashboard={() => setIsInstituteDashboardOpen(true)}
        onOpenAiProctoring={() => setIsAiProctoringOpen(true)}
        activeNavTab={activeNavTab}
        setActiveNavTab={setActiveNavTab}
      />

      {/* Authenticated User Session Notification Ribbon (if logged in) */}
      {loggedInUser && (
        <div className="bg-emerald-800 text-white px-4 py-2 text-xs flex items-center justify-between shadow-xs">
          <div className="max-w-[1440px] mx-auto w-full flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-emerald-300" />
              <span>
                Authenticated as <strong>{loggedInUser.name}</strong> ({loggedInUser.role}) · ID: {loggedInUser.id}
              </span>
            </div>
            <button
              onClick={() => setLoggedInUser(null)}
              className="flex items-center gap-1 text-[11px] bg-emerald-900/80 hover:bg-emerald-950 px-2.5 py-0.5 rounded transition-colors"
            >
              <LogOut className="w-3 h-3" />
              <span>Sign Out</span>
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
          onOpenApply={() => setActiveApplyExam(EXAMINATIONS[0])}
          onOpenMockExam={() => setIsMockExamOpen(true)}
          onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
          onOpenResults={() => setIsResultOpen(true)}
          onOpenAnswerKey={() => setIsAnswerKeyOpen(true)}
          onOpenInstituteDashboard={() => setIsInstituteDashboardOpen(true)}
          onOpenLogin={() => setIsLoginOpen(true)}
        />

        {/* METRICS BANNER: 5 Data Points (50+, 10 Million+, 1,000+, 99.9%, 100%) */}
        <MetricsBanner />

        {/* THREE-COLUMN DATA GRID: Column 1 Notifications, Column 2 Upcoming Examinations, Column 3 Quick Links (6 tiles) */}
        <ThreeColumnDataGrid
          onOpenNotice={(notice) => setActiveNotice(notice)}
          onOpenExamApply={(exam) => setActiveApplyExam(exam)}
          onQuickLinkAction={handleQuickLinkAction}
          filterExamId={selectedExamFilter}
        />

        {/* FREQUENTLY ASKED QUESTIONS (FAQ) ACCORDION */}
        <FAQAccordion
          onOpenAdmitCard={() => setIsAdmitCardOpen(true)}
          onOpenMockExam={() => setIsMockExamOpen(true)}
          onOpenExamApply={() => setActiveApplyExam(EXAMINATIONS[0])}
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
      />

      <CenterLocatorModal
        isOpen={isCenterLocatorOpen}
        onClose={() => setIsCenterLocatorOpen(false)}
      />

      <LoginModal
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onLoginSuccess={(user) => setLoggedInUser(user)}
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

      {/* Institute Administration Dashboard */}
      <InstituteDashboardModal
        isOpen={isInstituteDashboardOpen}
        onClose={() => setIsInstituteDashboardOpen(false)}
        onOpenAiProctoring={() => setIsAiProctoringOpen(true)}
      />

      {/* AI Proctoring & Incident Monitoring Room */}
      <AiProctoringModal
        isOpen={isAiProctoringOpen}
        onClose={() => setIsAiProctoringOpen(false)}
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
