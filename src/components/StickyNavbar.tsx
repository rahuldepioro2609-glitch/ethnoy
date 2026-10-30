/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  ChevronDown,
  User,
  Menu,
  X,
  GraduationCap,
  FileCheck,
  Building2,
  Phone,
  Award,
} from 'lucide-react';
import { ExamItem } from '../data/portalData';

interface StickyNavbarProps {
  onOpenSearch: () => void;
  onOpenLogin: () => void;
  isAuthenticated: boolean;
  onOpenAdmitCard: () => void;
  onOpenMockExam: () => void;
  onOpenCenterLocator: () => void;
  onOpenNoticeCategory: (cat: string) => void;
  onSelectExamFilter: (examId?: string) => void;
  onOpenResultsPortal: () => void;
  onOpenAnswerKeyPortal: () => void;
  onOpenInstituteDashboard: () => void;
  onOpenAiProctoring: () => void;
  examinations: ExamItem[];
  activeNavTab: string;
  setActiveNavTab: (tab: string) => void;
}

export const StickyNavbar: React.FC<StickyNavbarProps> = ({
  onOpenSearch,
  onOpenLogin,
  isAuthenticated,
  onOpenAdmitCard,
  onOpenMockExam,
  onOpenCenterLocator,
  onOpenNoticeCategory,
  onSelectExamFilter,
  onOpenResultsPortal,
  onOpenAnswerKeyPortal,
  onOpenInstituteDashboard,
  onOpenAiProctoring,
  examinations,
  activeNavTab,
  setActiveNavTab,
}) => {
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200/90 shadow-2xs">
      <div className="max-w-[1440px] mx-auto px-4 md:px-8">
        <div className="flex items-center justify-between h-20 gap-4">
          {/* Left: ELTNOY Brand Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => {
                setActiveNavTab('Home');
                onSelectExamFilter(undefined);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="flex items-center gap-3 text-left group focus-visible:outline-emerald-600 rounded-lg p-0.5"
              aria-label="ELTNOY Examination Portal Home"
            >
              {/* Graduation Cap Icon */}
              <div className="relative">
                <div className="w-11 h-11 rounded-lg bg-emerald-600/10 flex items-center justify-center group-hover:scale-105 transition-transform">
                  <GraduationCap className="w-7 h-7 text-[#15803D] stroke-[2.2]" />
                </div>
              </div>
              <div className="flex flex-col">
                <div className="flex items-center text-2xl font-black tracking-tight leading-none">
                  <span className="text-[#16A34A]">ELT</span>
                  <span className="text-[#0B254E]">NOY</span>
                </div>
                <span className="text-[11px] font-semibold text-slate-600 tracking-wide mt-1">
                  Examination Portal
                </span>
              </div>
            </button>
          </div>

          {/* Center Navigation Links: Home, Examinations, Student Zone, Institute Zone, Results, Contact Us, About Us */}
          <nav
            ref={dropdownRef}
            aria-label="Primary Navigation"
            className="hidden lg:flex items-center gap-4 xl:gap-6 text-[13px] font-semibold text-slate-700"
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
                Home
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
                <span>Examinations</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-70" />
              </button>

              {activeDropdown === 'exams' && (
                <div className="absolute left-0 mt-2 w-72 bg-white rounded-xl shadow-xl border border-slate-200 py-2 animate-in fade-in zoom-in-95 duration-150 z-50">
                  <div className="px-3 py-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    Published exam forms
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
                      <span className="text-[11px] text-slate-500">{exam.code} · Apply until {exam.regEnd}</span>
                    </button>
                  )) : <p className="px-3 py-2 text-xs text-slate-500">No exams published yet.</p>}
                </div>
              )}
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
                <span>Student Zone</span>
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
                    <span className="font-semibold">Download Admit Card</span>
                  </button>
                  <button
                    onClick={() => {
                      onOpenMockExam();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-blue-700 flex items-center gap-2.5"
                  >
                    <GraduationCap className="w-4 h-4 text-blue-600" />
                    <span className="font-semibold">Online CBT Practice Exam</span>
                  </button>
                  <button
                    onClick={() => {
                      onOpenAnswerKeyPortal();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-purple-700 flex items-center gap-2.5"
                  >
                    <Award className="w-4 h-4 text-purple-600" />
                    <span className="font-semibold">Answer Keys &amp; Objections</span>
                  </button>
                  <button
                    onClick={() => {
                      onOpenResultsPortal();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-emerald-700 flex items-center gap-2.5"
                  >
                    <Award className="w-4 h-4 text-emerald-600" />
                    <span className="font-semibold">Candidate Result &amp; Rank Card</span>
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
                <span>Institute Zone</span>
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
                      <span>Institute Administration Dashboard</span>
                    </div>
                    <div className="text-[11px] text-slate-500 pl-6">Slots, Biometrics &amp; Proctors</div>
                  </button>
                  <button
                    onClick={() => {
                      onOpenAiProctoring();
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-700 hover:bg-slate-50 hover:text-rose-700 border-t border-slate-100"
                  >
                    <div className="font-semibold flex items-center gap-2">
                      <Award className="w-4 h-4 text-rose-600" />
                      <span>Official Administration Dashboard</span>
                    </div>
                    <div className="text-[11px] text-slate-500 pl-6">Applications, support tickets and results</div>
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
                Results
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
                Contact Us
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
                  const el = document.getElementById('why-choose-section');
                  if (el) el.scrollIntoView({ behavior: 'smooth' });
                }}
                className={`transition-colors pb-1 ${
                  activeNavTab === 'About Us'
                    ? 'text-slate-900 font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                About Us
              </button>
              {activeNavTab === 'About Us' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#16A34A] rounded-full" />
              )}
            </div>
          </nav>

          {/* Right Section: Search Trigger & Account Button */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Search Icon Button */}
            <button
              onClick={onOpenSearch}
              className="p-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-full transition-colors focus-visible:outline-[#16A34A]"
              title="Search (Ctrl+K)"
              aria-label="Open search dialog"
            >
              <Search className="w-5 h-5 text-slate-600" />
            </button>

            <button
              onClick={onOpenLogin}
              className="flex items-center gap-1.5 px-4 sm:px-5 py-2 text-xs sm:text-sm font-bold text-white bg-[#16A34A] hover:bg-[#15803D] active:bg-[#166534] rounded-lg transition-all shadow-xs"
              aria-label={isAuthenticated ? 'Open dashboard' : 'Login'}
            >
              <User className="w-4 h-4 stroke-[2.2]" />
              <span>{isAuthenticated ? 'My Dashboard' : 'Login'}</span>
            </button>

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              className="lg:hidden p-2 text-slate-700 hover:bg-slate-100 rounded-lg focus-visible:outline-emerald-600"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-slate-200 bg-white px-4 py-4 space-y-3 shadow-lg">
          <div className="space-y-1 text-sm font-medium text-slate-800">
            <button
              onClick={() => {
                setActiveNavTab('Home');
                setMobileMenuOpen(false);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 font-semibold"
            >
              Home
            </button>
            <p className="px-3 pt-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Published exam forms</p>
            {examinations.length ? examinations.map((exam) => (
              <button
                key={exam.id}
                onClick={() => {
                  onSelectExamFilter(exam.id);
                  setMobileMenuOpen(false);
                  document.getElementById('exam-list')?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100"
              >
                {exam.name} <span className="text-xs text-slate-500">({exam.code})</span>
              </button>
            )) : <p className="px-3 py-2 text-sm text-slate-500">No exams published yet.</p>}
            <button
              onClick={() => {
                onOpenAdmitCard();
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100"
            >
              Download Admit Card
            </button>
            <button
              onClick={() => {
                onOpenMockExam();
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100"
            >
              Online CBT Exam Simulator
            </button>
            <button
              onClick={() => {
                onOpenResultsPortal();
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 font-semibold text-emerald-700"
            >
              Candidate Result &amp; Rank Card
            </button>
            <button
              onClick={() => {
                onOpenAnswerKeyPortal();
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 font-semibold text-purple-700"
            >
              Answer Keys &amp; Objections
            </button>
            <button
              onClick={() => {
                onOpenInstituteDashboard();
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 font-semibold text-[#0B254E]"
            >
              Institute Administration Dashboard
            </button>
            <button
              onClick={() => {
                onOpenAiProctoring();
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100 font-semibold text-rose-600"
            >
              Official Administration Dashboard
            </button>
            <button
              onClick={() => {
                setActiveNavTab('About Us');
                setMobileMenuOpen(false);
                document.getElementById('why-choose-section')?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-100"
            >
              About Us
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
