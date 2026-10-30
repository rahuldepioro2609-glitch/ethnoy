/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  CheckCircle2,
  ArrowRight,
  User,
  FileText,
  IdCard,
  Monitor,
  BarChart3,
  Building2,
  Sparkles,
} from 'lucide-react';
import { HERO_ACTION_RAIL } from '../data/portalData';

interface HeroSectionProps {
  onOpenApply: () => void;
  onOpenMockExam: () => void;
  onOpenAdmitCard: () => void;
  onOpenResults: () => void;
  onOpenAnswerKey?: () => void;
  onOpenInstituteDashboard?: () => void;
  onOpenLogin: () => void;
}

export const HeroSection: React.FC<HeroSectionProps> = ({
  onOpenApply,
  onOpenMockExam,
  onOpenAdmitCard,
  onOpenResults,
  onOpenAnswerKey,
  onOpenInstituteDashboard,
  onOpenLogin,
}) => {
  const handleActionRailClick = (actionId: string) => {
    switch (actionId) {
      case 'apply':
        onOpenApply();
        break;
      case 'admit-card':
        onOpenAdmitCard();
        break;
      case 'cbt-exam':
      case 'cbt-mock':
        onOpenMockExam();
        break;
      case 'results':
        onOpenResults();
        break;
      case 'answer-key':
        if (onOpenAnswerKey) onOpenAnswerKey();
        else onOpenResults();
        break;
      case 'institute-dashboard':
      case 'institute-login':
      case 'login-institute':
        if (onOpenInstituteDashboard) onOpenInstituteDashboard();
        else onOpenLogin();
        break;
      default:
        break;
    }
  };

  const renderRailIcon = (type: string) => {
    switch (type) {
      case 'application':
        return <FileText className="w-5 h-5 text-emerald-500" />;
      case 'admit-card':
        return <IdCard className="w-5 h-5 text-blue-500" />;
      case 'cbt-exam':
        return <Monitor className="w-5 h-5 text-amber-500" />;
      case 'answer-key':
        return <BarChart3 className="w-5 h-5 text-purple-500" />;
      case 'institute-dashboard':
        return <Building2 className="w-5 h-5 text-teal-600" />;
      default:
        return <FileText className="w-5 h-5 text-slate-500" />;
    }
  };

  return (
    <section className="relative overflow-hidden bg-gradient-to-r from-[#edf7ff] via-[#e5f4fd] to-[#ebfbf3] border-b border-slate-200/80">
      {/* Soft teal/cyan decorative diagonal shapes matching reference mockup */}
      <div className="absolute inset-0 pointer-events-none opacity-40">
        <div className="absolute -right-20 -top-20 w-96 h-96 rounded-full bg-teal-200/40 blur-3xl" />
        <div className="absolute right-1/4 top-0 w-80 h-full bg-gradient-to-b from-teal-100/30 via-transparent to-blue-100/30 transform -skew-x-12" />
      </div>

      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12 relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
          {/* Left Column: Heading, Subtitle, 4 Checkmarks, CTAs */}
          <div className="lg:col-span-5 space-y-5">
            {/* Tagline */}
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/80 border border-sky-200 shadow-2xs text-[#0284c7] text-xs font-semibold">
              <Sparkles className="w-3.5 h-3.5 text-sky-500" />
              <span>AI Powered Examination Ecosystem</span>
            </div>

            {/* Giant Heading matching ELTNOY layout */}
            <div className="space-y-0.5">
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-[#16A34A] tracking-tight leading-none">
                ELTNOY
              </h1>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#0B254E] tracking-tight leading-tight">
                Examination Portal
              </h2>
            </div>

            {/* Subtitle description */}
            <p className="text-sm sm:text-base text-slate-600 leading-relaxed max-w-lg font-normal">
              A secure, transparent and technology-driven platform for conducting online examinations.
            </p>

            {/* 4 Key Checkmarks: 2x2 inline grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-1 text-xs sm:text-sm font-semibold text-slate-700">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-[#0284C7] text-white flex items-center justify-center shrink-0 shadow-2xs">
                  <CheckCircle2 className="w-3.5 h-3.5 stroke-[2.5]" />
                </div>
                <span>Easy Registration</span>
              </div>

              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-[#0284C7] text-white flex items-center justify-center shrink-0 shadow-2xs">
                  <CheckCircle2 className="w-3.5 h-3.5 stroke-[2.5]" />
                </div>
                <span>Secure &amp; Fair Examination</span>
              </div>

              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-[#0284C7] text-white flex items-center justify-center shrink-0 shadow-2xs">
                  <CheckCircle2 className="w-3.5 h-3.5 stroke-[2.5]" />
                </div>
                <span>Real-time Monitoring</span>
              </div>

              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-[#0284C7] text-white flex items-center justify-center shrink-0 shadow-2xs">
                  <CheckCircle2 className="w-3.5 h-3.5 stroke-[2.5]" />
                </div>
                <span>Instant Results</span>
              </div>
            </div>

            {/* Action Buttons: Apply for Examination & Student Login */}
            <div className="flex flex-wrap items-center gap-3 pt-3">
              <button
                onClick={onOpenApply}
                className="px-5 py-2.5 sm:px-6 sm:py-3 bg-[#16A34A] hover:bg-[#15803D] active:bg-[#166534] text-white font-bold text-xs sm:text-sm rounded-lg shadow-sm flex items-center gap-2 transition-all transform hover:-translate-y-0.5"
              >
                <span>Apply for Examination</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                onClick={onOpenLogin}
                className="px-5 py-2.5 sm:px-6 sm:py-3 bg-white hover:bg-slate-50 text-slate-800 font-semibold text-xs sm:text-sm rounded-lg border border-slate-300 flex items-center gap-2 transition-all shadow-2xs"
              >
                <User className="w-4 h-4 text-blue-600" />
                <span>Student Login</span>
              </button>
            </div>
          </div>

          {/* Center Column: Student Photo with "Your Future Our Mission" */}
          <div className="lg:col-span-4 relative flex items-center justify-center">
            <div className="relative w-full max-w-md mx-auto rounded-2xl overflow-hidden shadow-md border border-white/80 bg-white/50 backdrop-blur-xs group">
              <img
                src="/assets/student-hero.png"
                alt="Students taking examination at ELTNOY Portal - Your Future Our Mission"
                className="w-full h-auto object-cover transform group-hover:scale-[1.02] transition-transform duration-300"
              />
            </div>
          </div>

          {/* Right Column: Floating Sidebar 5 Quick Link Cards */}
          <div className="lg:col-span-3 flex flex-col gap-2.5">
            {HERO_ACTION_RAIL.map((card) => (
              <button
                key={card.id}
                onClick={() => handleActionRailClick(card.actionId)}
                className="w-full bg-white hover:bg-slate-50/90 rounded-xl p-2.5 px-3.5 border border-slate-200/90 shadow-2xs hover:shadow-md transition-all flex items-center gap-3.5 text-left group hover:-translate-x-0.5"
              >
                <div className={`p-2 rounded-lg border ${card.iconBg} shrink-0 group-hover:scale-105 transition-transform`}>
                  {renderRailIcon(card.iconType)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs sm:text-sm font-bold text-slate-900 group-hover:text-[#16A34A] transition-colors truncate">
                    {card.title}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {card.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
