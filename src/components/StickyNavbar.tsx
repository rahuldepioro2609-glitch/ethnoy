/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  ChevronDown,
  User,
  GraduationCap,
  FileCheck,
  Building2,
  Phone,
  Award,
  CalendarDays,
  LayoutDashboard,
  LogOut,
} from 'lucide-react';
import { ExamItem } from '../data/portalData';
import { BrandLogo } from './BrandLogo';
import { useLanguage } from '../utils/languageContext';

interface StickyNavbarProps {
  onOpenSearch: () => void;
  onOpenLogin: () => void;
  account: { name: string; role: 'candidate' | 'center' | 'official' } | null;
  authLoading: boolean;
  onSignOut: () => void;
  onOpenAdmitCard: () => void;
  onOpenMockExam: () => void;
  onOpenCenterLocator: () => void;
  onOpenNoticeCategory: (cat: string) => void;
  onSelectExamFilter: (examId?: string) => void;
  onOpenResultsPortal: () => void;
  onOpenAnswerKeyPortal: () => void;
  onOpenInstituteDashboard: () => void;
  /**
   * Shown under the logo when this browser is signed in on the Institute site (display-only hint,
   * utils/portalHint.ts). `href` always points at the Institute site's dashboard.
   */
  instituteReturn?: { name: string; href: string; signOutHref: string } | null;
  examinations: ExamItem[];
  activeNavTab: string;
  setActiveNavTab: (tab: string) => void;
}

export const StickyNavbar: React.FC<StickyNavbarProps> = ({
  onOpenSearch,
  onOpenLogin,
  account,
  authLoading,
  onSignOut,
  onOpenAdmitCard,
  onOpenMockExam,
  onOpenCenterLocator,
  onOpenNoticeCategory,
  onSelectExamFilter,
  onOpenResultsPortal,
  onOpenAnswerKeyPortal,
  onOpenInstituteDashboard,
  instituteReturn,
  examinations,
  activeNavTab,
  setActiveNavTab,
}) => {
  const { t } = useLanguage();
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setActiveDropdown(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleDropdown = (name: string) => {
    setActiveDropdown((prev) => (prev === name ? null : name));
  };

  const mobileLinks: { label: string; activeTab?: string; onClick: () => void }[] = [
    { label: 'Home', activeTab: 'Home', onClick: () => {
      setActiveNavTab('Home');
      onSelectExamFilter(undefined);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } },
    { label: 'Examinations', activeTab: 'Examinations', onClick: () => {
      setActiveNavTab('Examinations');
      document.getElementById('exam-list')?.scrollIntoView({ behavior: 'smooth' });
    } },
    { label: 'Public Notices', activeTab: 'Public Notices', onClick: () => {
      setActiveNavTab('Public Notices');
      document.getElementById('public-notices')?.scrollIntoView({ behavior: 'smooth' });
    } },
    { label: 'Admit Card', onClick: onOpenAdmitCard },
    { label: 'Practice Exam', onClick: onOpenMockExam },
    { label: 'Answer Keys', onClick: onOpenAnswerKeyPortal },
    { label: 'Center Locator', onClick: onOpenCenterLocator },
    { label: 'Results', activeTab: 'Results', onClick: () => {
      setActiveNavTab('Results');
      onOpenResultsPortal();
    } },
    { label: 'Institute', activeTab: 'Institute Zone', onClick: onOpenInstituteDashboard },
    { label: 'Contact Us', activeTab: 'Contact Us', onClick: () => {
      setActiveNavTab('Contact Us');
      document.getElementById('footer-contact')?.scrollIntoView({ behavior: 'smooth' });
    } },
    { label: 'About Us', activeTab: 'About Us', onClick: () => {
      setActiveNavTab('About Us');
      document.getElementById('about-eltnoy')?.scrollIntoView({ behavior: 'smooth' });
    } },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/90 bg-white shadow-2xs">
      <div className="max-w-[1440px] mx-auto px-4 md:px-8">
        <div className="flex min-h-[72px] items-center justify-between gap-4 py-2 sm:min-h-[78px] sm:px-2">
          <div className="flex min-w-0 items-center gap-3 sm:gap-5">
            <div className="flex min-w-0 shrink-0 flex-col items-start gap-1">
              <button
                onClick={() => {
                  setActiveNavTab('Home');
                  onSelectExamFilter(undefined);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="flex shrink-0 items-center rounded-lg p-0.5 text-left focus-visible:outline-emerald-600"
                aria-label={`ELTNOY ${t('Examination Portal Home')}`}
              >
                <BrandLogo />
              </button>
              {account ? (
                <button
                  type="button"
                  onClick={onOpenLogin}
                  title={`${account.name} · ${account.role === 'center' ? 'Institute' : account.role === 'candidate' ? 'Student' : 'Admin'}`}
                  aria-label={`${account.name}, open dashboard`}
                  className="inline-flex max-w-[130px] items-center gap-1.5 overflow-hidden rounded-full border border-emerald-200 bg-emerald-50 py-1 pl-1.5 pr-2.5 text-[11px] font-bold text-emerald-950 transition hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 sm:max-w-[260px]"
                >
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-white ${account.role === 'center' ? 'bg-sky-700' : account.role === 'candidate' ? 'bg-emerald-700' : 'bg-blue-800'}`}>
                    {account.role === 'center' ? <Building2 className="h-3 w-3" /> : <User className="h-3 w-3" />}
                  </span>
                  <span className="truncate">{account.name}</span>
                  <span className="shrink-0 text-[9px] font-extrabold uppercase tracking-wide text-slate-500">
                    {account.role === 'center' ? 'Institute' : account.role === 'candidate' ? 'Student' : 'Admin'}
                  </span>
                  <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
                </button>
              ) : instituteReturn ? (
                <a
                  href={instituteReturn.href}
                  title={`${t('Return to the institute dashboard')}: ${instituteReturn.name}`}
                  aria-label={`${t('Return to the institute dashboard')}: ${instituteReturn.name}`}
                  className="inline-flex max-w-[130px] items-center gap-1.5 overflow-hidden rounded-full border border-sky-200 bg-sky-50 py-1 pl-1.5 pr-2.5 text-[11px] font-bold text-sky-900 transition hover:bg-sky-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 sm:max-w-[260px]"
                >
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-sky-700 text-white"><Building2 className="h-3 w-3" /></span>
                  <span className="truncate">{instituteReturn.name}</span>
                  <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-sky-700" />
                </a>
              ) : null}
            </div>
            <div className="hidden items-center gap-1 border-l border-slate-200 pl-3 lg:flex xl:gap-2 xl:pl-4">
              <button
                type="button"
                onClick={() => document.getElementById('exam-list')?.scrollIntoView({ behavior: 'smooth' })}
                className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold text-slate-600 transition hover:bg-emerald-50 hover:text-emerald-800 xl:px-2.5 xl:text-xs"
              >
                <CalendarDays className="h-4 w-4 text-emerald-700" />
                {t('Exam Calendar')}
              </button>
              <button
                type="button"
                onClick={() => document.querySelector('[aria-label="Latest portal updates"]')?.scrollIntoView({ behavior: 'smooth' })}
                className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold text-slate-600 transition hover:bg-amber-50 hover:text-amber-800 xl:px-2.5 xl:text-xs"
              >
                <FileCheck className="h-4 w-4 text-amber-600" />
                {t('Latest Notices')}
              </button>
              <button
                type="button"
                onClick={onOpenAdmitCard}
                className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold text-slate-600 transition hover:bg-sky-50 hover:text-sky-800 xl:px-2.5 xl:text-xs"
              >
                <GraduationCap className="h-4 w-4 text-sky-700" />
                {t('Candidate Services')}
              </button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={onOpenSearch}
              className="flex h-10 w-10 items-center justify-center rounded-full text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:h-auto sm:w-56 sm:justify-start sm:gap-2 sm:rounded-lg sm:border sm:border-slate-300 sm:bg-slate-50 sm:px-3 sm:py-2 sm:text-left"
              title={t('Search (Ctrl+K)')}
              aria-label={t('Search exams and portal services')}
            >
              <Search className="h-5 w-5 shrink-0 text-slate-500" />
              <span className="hidden truncate text-xs text-slate-500 sm:inline">{t('Search exams and services')}</span>
              <span className="ml-auto hidden rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-400 md:inline">Ctrl K</span>
            </button>
            {authLoading ? (
              <span role="status" aria-label={t('Checking sign-in')} className="h-10 w-10 animate-pulse rounded-lg bg-slate-100" />
            ) : account ? (
              <button
                type="button"
                onClick={onSignOut}
                className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-slate-700 sm:px-4 sm:text-sm"
                aria-label={t('Sign out')}
              >
                <LogOut className="h-4 w-4" />
                <span>{t('Sign out')}</span>
              </button>
            ) : instituteReturn ? (
              <a
                href={instituteReturn.signOutHref}
                className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-slate-700 sm:px-4 sm:text-sm"
                aria-label={t('Sign out of institute account')}
              >
                <LogOut className="h-4 w-4" />
                <span>{t('Sign out')}</span>
              </a>
            ) : (
              <button
                type="button"
                onClick={onOpenLogin}
                className="flex items-center gap-1.5 rounded-lg bg-[#16A34A] px-3 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-[#15803D] sm:px-4 sm:text-sm"
                aria-label={t('Login')}
              >
                <User className="h-4 w-4 stroke-[2.2]" />
                <span>{t('Login')}</span>
              </button>
            )}
          </div>
        </div>

        <div className="hidden border-t border-slate-200 bg-white lg:block">
          <div className="flex min-h-[48px] items-center gap-3">
          {/* Center Navigation Links: Home, Examinations, Student Zone, Institute Zone, Results, Contact Us, About Us */}
          <nav
            ref={dropdownRef}
            aria-label="Primary Navigation"
            className="flex items-center gap-4 xl:gap-6 text-[13px] font-semibold text-slate-700"
          >
            {/* 1. Home */}
            <div className="relative py-2">
              <button
                onClick={() => {
                  setActiveNavTab('Home');
                  onSelectExamFilter(undefined);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className={`transition-colors pb-1 ${
                  activeNavTab === 'Home'
                    ? 'text-slate-900 font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t('Home')}
              </button>
              {activeNavTab === 'Home' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#16A34A] rounded-full" />
              )}
            </div>

            {/* 2. Examinations Dropdown */}
            <div className="relative py-2">
              <button
                onClick={() => toggleDropdown('exams')}
                className={`flex items-center gap-1 transition-colors pb-1 ${
                  activeDropdown === 'exams' || activeNavTab === 'Examinations'
                    ? 'text-[#16A34A] font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                aria-expanded={activeDropdown === 'exams'}
              >
                <span>{t('Examinations')}</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-70" />
              </button>

              {activeDropdown === 'exams' && (
                <div className="absolute left-0 mt-2 w-72 bg-white rounded-xl shadow-xl border border-slate-200 py-2 animate-in fade-in zoom-in-95 duration-150 z-50">
                  <button
                    type="button"
                    onClick={() => {
                      document.getElementById('exam-list')?.scrollIntoView({ behavior: 'smooth' });
                      setActiveDropdown(null);
                    }}
                    className="w-full border-b border-slate-100 px-3 py-2 text-left text-xs font-bold text-emerald-800 hover:bg-emerald-50"
                  >
                    {t('View exam calendar and application windows →')}
                  </button>
                  <div className="px-3 py-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    {t('Published exam forms')}
                  </div>
                  {examinations.length ? examinations.map((exam) => (
                    <button
                      key={exam.id}
                      onClick={() => {
                        onSelectExamFilter(exam.id);
                        setActiveDropdown(null);
                      }}
                      className="w-full text-left px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 hover:text-[#16A34A] flex flex-col"
                    >
                      <span className="font-semibold text-slate-900">{exam.name}</span>
                      <span className="text-[11px] text-slate-500">{exam.code} · {t('Apply until')} {exam.regEnd}</span>
                    </button>
                  )) : <p className="px-3 py-2 text-xs text-slate-500">{t('No exams published yet.')}</p>}
                </div>
              )}
            </div>

            <div className="relative py-2">
              <button
                type="button"
                onClick={() => {
                  setActiveNavTab('Public Notices');
                  document.getElementById('public-notices')?.scrollIntoView({ behavior: 'smooth' });
                }}
                className={`transition-colors pb-1 ${
                  activeNavTab === 'Public Notices' ? 'font-bold text-slate-900' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t('Public Notices')}
              </button>
              {activeNavTab === 'Public Notices' && <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[#16A34A]" />}
            </div>

            {/* 3. Student Zone Dropdown */}
            <div className="relative py-2">
              <button
                onClick={() => toggleDropdown('student')}
                className={`flex items-center gap-1 transition-colors pb-1 ${
                  activeDropdown === 'student' || activeNavTab === 'Student Zone'
                    ? 'text-[#16A34A] font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                aria-expanded={activeDropdown === 'student'}
              >
                <span>{t('Student Zone')}</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-70" />
              </button>

              {activeDropdown === 'student' && (
                <div className="absolute left-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-slate-200 py-2 animate-in fade-in zoom-in-95 duration-150 z-50">
                  <button
                    onClick={() => {
                      onOpenAdmitCard();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-[#16A34A] flex items-center gap-2.5"
                  >
                    <FileCheck className="w-4 h-4 text-[#16A34A]" />
                    <span className="font-semibold">{t('Download Admit Card')}</span>
                  </button>
                  <button
                    onClick={() => {
                      onOpenMockExam();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-blue-700 flex items-center gap-2.5"
                  >
                    <GraduationCap className="w-4 h-4 text-blue-600" />
                    <span className="font-semibold">{t('Online CBT Practice Exam')}</span>
                  </button>
                  <button
                    onClick={() => {
                      onOpenAnswerKeyPortal();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-purple-700 flex items-center gap-2.5"
                  >
                    <Award className="w-4 h-4 text-purple-600" />
                    <span className="font-semibold">{t('Answer Keys & Objections')}</span>
                  </button>
                  <button
                    onClick={() => {
                      onOpenResultsPortal();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-emerald-700 flex items-center gap-2.5"
                  >
                    <Award className="w-4 h-4 text-emerald-600" />
                    <span className="font-semibold">{t('Candidate Result & Rank Card')}</span>
                  </button>
                </div>
              )}
            </div>

            {/* 4. Institute Zone Dropdown */}
            <div className="relative py-2">
              <button
                onClick={() => toggleDropdown('institute')}
                className={`flex items-center gap-1 transition-colors pb-1 ${
                  activeDropdown === 'institute' || activeNavTab === 'Institute Zone'
                    ? 'text-[#16A34A] font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                aria-expanded={activeDropdown === 'institute'}
              >
                <span>{t('Institute Zone')}</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-70" />
              </button>

              {activeDropdown === 'institute' && (
                <div className="absolute left-0 mt-2 w-72 bg-white rounded-xl shadow-xl border border-slate-200 py-2 animate-in fade-in zoom-in-95 duration-150 z-50">
                  <button
                    onClick={() => {
                      onOpenInstituteDashboard();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-[#16A34A]"
                  >
                    <div className="font-semibold flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-[#16A34A]" />
                      <span>{t('Institute Administration Dashboard')}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 pl-6">{t('Slots, Biometrics & Proctors')}</div>
                  </button>
                </div>
              )}
            </div>

            {/* 5. Results */}
            <div className="relative py-2">
              <button
                onClick={() => {
                  setActiveNavTab('Results');
                  onOpenResultsPortal();
                }}
                className={`transition-colors pb-1 ${
                  activeNavTab === 'Results'
                    ? 'text-slate-900 font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t('Results')}
              </button>
              {activeNavTab === 'Results' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#16A34A] rounded-full" />
              )}
            </div>

            {/* 6. Contact Us */}
            <div className="relative py-2">
              <button
                onClick={() => {
                  setActiveNavTab('Contact Us');
                  const footer = document.getElementById('footer-contact');
                  if (footer) footer.scrollIntoView({ behavior: 'smooth' });
                }}
                className={`transition-colors pb-1 ${
                  activeNavTab === 'Contact Us'
                    ? 'text-slate-900 font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t('Contact Us')}
              </button>
              {activeNavTab === 'Contact Us' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#16A34A] rounded-full" />
              )}
            </div>

            {/* About Us */}
            <div className="relative py-2">
              <button
                onClick={() => {
                  setActiveNavTab('About Us');
                  const el = document.getElementById('about-eltnoy');
                  if (el) el.scrollIntoView({ behavior: 'smooth' });
                }}
                className={`transition-colors pb-1 ${
                  activeNavTab === 'About Us'
                    ? 'text-slate-900 font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t('About Us')}
              </button>
              {activeNavTab === 'About Us' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#16A34A] rounded-full" />
              )}
            </div>
          </nav>

        </div>
        </div>
        <nav aria-label={t('Mobile quick navigation')} className="lg:hidden -mx-4 border-t border-slate-100 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {mobileLinks.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                aria-current={item.activeTab === activeNavTab ? 'page' : undefined}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 ${
                  item.activeTab === activeNavTab
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-200 hover:bg-emerald-50'
                }`}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
};
