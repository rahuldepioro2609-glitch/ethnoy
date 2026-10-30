/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Trophy,
  ShieldCheck,
  Users,
  Cog,
  BarChart2,
  GraduationCap,
  ArrowUp,
} from 'lucide-react';

interface FooterValuePropProps {
  onOpenGrievance: () => void;
  onOpenAdmitCard: () => void;
  onOpenMockExam: () => void;
  onOpenCenterLocator: () => void;
  onOpenResults: () => void;
}

export const FooterValueProp: React.FC<FooterValuePropProps> = ({
  onOpenGrievance,
  onOpenAdmitCard,
  onOpenMockExam,
  onOpenCenterLocator,
  onOpenResults,
}) => {
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <footer className="bg-white border-t border-slate-200">
      {/* "Why Choose ELTNOY?" Horizontal Strip - Exactly as in Reference Image */}
      <div id="why-choose-section" className="border-b border-slate-200/80 bg-white py-5 px-4 sm:px-6 lg:px-8">
        <div className="max-w-[1440px] mx-auto flex flex-col xl:flex-row items-center justify-between gap-6">
          {/* Left Title: Trophy + Why Choose ELTNOY? */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded-full bg-emerald-100 text-[#16A34A] flex items-center justify-center">
              <Trophy className="w-4 h-4 text-[#16A34A]" />
            </div>
            <h3 className="text-base sm:text-lg font-extrabold text-[#0B254E] tracking-tight">
              Why Choose ELTNOY?
            </h3>
          </div>

          {/* 4 Feature Items Horizontally */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 flex-1 w-full xl:w-auto xl:pl-8 xl:border-l xl:border-slate-200">
            {/* 1. Secure & Fair */}
            <div className="flex items-start gap-2.5">
              <div className="p-1.5 rounded-lg bg-emerald-50 text-[#16A34A] mt-0.5">
                <ShieldCheck className="w-5 h-5 text-[#16A34A]" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-900 leading-tight">
                  Role-based Access
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Protected portal accounts
                </div>
              </div>
            </div>

            {/* 2. User Friendly */}
            <div className="flex items-start gap-2.5">
              <div className="p-1.5 rounded-lg bg-blue-50 text-[#0284C7] mt-0.5">
                <Users className="w-5 h-5 text-[#0284C7]" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-900 leading-tight">
                  User Friendly
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Easy to Use Platform
                </div>
              </div>
            </div>

            {/* 3. Multi-Exam Support */}
            <div className="flex items-start gap-2.5">
              <div className="p-1.5 rounded-lg bg-indigo-50 text-indigo-600 mt-0.5">
                <Cog className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-900 leading-tight">
                  Exam Information
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Notices and schedules
                </div>
              </div>
            </div>

            {/* 4. Real-time Analytics */}
            <div className="flex items-start gap-2.5">
              <div className="p-1.5 rounded-lg bg-sky-50 text-sky-600 mt-0.5">
                <BarChart2 className="w-5 h-5 text-sky-600" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-900 leading-tight">
                  Candidate Helpdesk
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Feedback and issue reports
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Footer Directory */}
      <div id="footer-contact" className="bg-[#0B254E] text-slate-300 py-10 px-4 sm:px-6 lg:px-8 text-xs">
        <div className="max-w-[1440px] mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {/* Col 1: ELTNOY Brand */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-lg bg-emerald-600/20 flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-[#16A34A]" />
              </div>
              <div className="text-xl font-black text-white">
                <span className="text-[#16A34A]">ELT</span>
                <span>NOY</span>
              </div>
            </div>
            <p className="text-slate-400 leading-relaxed text-xs">
              Examination portal for applications, admit-card lookup, result lookup, practice tests, and candidate support.
            </p>
          </div>

          {/* Col 2: Quick Links */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              Student Navigation
            </h4>
            <ul className="space-y-1.5 text-slate-400">
              <li>
                <button onClick={onOpenAdmitCard} className="hover:text-white transition-colors">
                  Download Admit Card
                </button>
              </li>
              <li>
                <button onClick={onOpenMockExam} className="hover:text-white transition-colors">
                  Online CBT Mock Simulator
                </button>
              </li>
              <li>
                <button onClick={onOpenCenterLocator} className="hover:text-white transition-colors">
                  Find a Test Center
                </button>
              </li>
              <li>
                <button onClick={onOpenResults} className="hover:text-white transition-colors">
                  Check Examination Results
                </button>
              </li>
              <li>
                <button onClick={onOpenGrievance} className="hover:text-white transition-colors">
                  Candidate Helpdesk &amp; Grievance
                </button>
              </li>
            </ul>
          </div>

          {/* Col 3: Examination Programs */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              Exam Information
            </h4>
            <ul className="space-y-1.5 text-slate-400">
              <li>Exam schedules are published in the latest portal notices.</li>
              <li>Registration status is shown with each examination listing.</li>
              <li>Use the admit card as the source of truth for your venue.</li>
            </ul>
          </div>

          {/* Col 4: Contact Info */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              Contact &amp; Support
            </h4>
            <div className="space-y-1.5 text-slate-400 text-xs">
              <p>For assistance, submit a message through the candidate helpdesk.</p>
              <button onClick={onOpenGrievance} className="text-emerald-300 hover:text-white transition-colors">
                Open candidate helpdesk
              </button>
            </div>
            <button
              onClick={scrollToTop}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs transition-colors"
            >
              <ArrowUp className="w-3.5 h-3.5" />
              <span>Back to Top</span>
            </button>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="mt-8 pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>© {new Date().getFullYear()} ELTNOY Examination Portal.</span>
          <span>Privacy notice, terms, and security disclosures must be added before public launch.</span>
        </div>
      </div>
    </footer>
  );
};
