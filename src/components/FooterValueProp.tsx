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
  Compass,
  Target,
  ListChecks,
  Scale,
} from 'lucide-react';

import { useTranslation } from '../i18n';
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
  const { t } = useTranslation();
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <footer className="bg-white border-t border-slate-200">
      <section id="about-eltnoy" className="scroll-mt-56 border-b border-slate-200 bg-[#F4F8FC] px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1440px]">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-bold uppercase tracking-wider text-emerald-800">
              <Compass className="h-4 w-4" /> {t('footer.aboutBadge')}
            </span>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-[#0B254E]">{t('footer.aboutHeading')}</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
              {t('footer.aboutIntro')}
            </p>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="inline-flex rounded-xl bg-emerald-50 p-2.5 text-emerald-700"><Compass className="h-5 w-5" /></div>
              <h3 className="mt-4 font-extrabold text-[#0B254E]">{t('footer.vision')}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{t('footer.visionText')}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="inline-flex rounded-xl bg-blue-50 p-2.5 text-blue-700"><Target className="h-5 w-5" /></div>
              <h3 className="mt-4 font-extrabold text-[#0B254E]">{t('footer.mission')}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{t('footer.missionText')}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="inline-flex rounded-xl bg-sky-50 p-2.5 text-sky-700"><ListChecks className="h-5 w-5" /></div>
              <h3 className="mt-4 font-extrabold text-[#0B254E]">{t('footer.objectives')}</h3>
              <ul className="mt-2 space-y-1.5 text-sm leading-5 text-slate-600">
                <li>{t('footer.objective1')}</li>
                <li>{t('footer.objective2')}</li>
                <li>{t('footer.objective3')}</li>
              </ul>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="inline-flex rounded-xl bg-amber-50 p-2.5 text-amber-700"><Scale className="h-5 w-5" /></div>
              <h3 className="mt-4 font-extrabold text-[#0B254E]">{t('footer.principles')}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{t('footer.principlesText')}</p>
            </article>
          </div>

          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950 sm:text-sm">
            {t('footer.disclaimer')}
          </div>
        </div>
      </section>

      {/* "Why Choose ELTNOY?" Horizontal Strip - Exactly as in Reference Image */}
      <div id="why-choose-section" className="border-b border-slate-200/80 bg-white py-5 px-4 sm:px-6 lg:px-8">
        <div className="max-w-[1440px] mx-auto flex flex-col xl:flex-row items-center justify-between gap-6">
          {/* Left Title: Trophy + Why Choose ELTNOY? */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded-full bg-emerald-100 text-[#16A34A] flex items-center justify-center">
              <Trophy className="w-4 h-4 text-[#16A34A]" />
            </div>
            <h3 className="text-base sm:text-lg font-extrabold text-[#0B254E] tracking-tight">
              {t('footer.whyChoose')}
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
                  {t('footer.why.access')}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {t('footer.why.accessText')}
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
                  {t('footer.why.friendly')}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {t('footer.why.friendlyText')}
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
                  {t('footer.why.info')}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {t('footer.why.infoText')}
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
                  {t('footer.why.helpdesk')}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {t('footer.why.helpdeskText')}
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
              {t('footer.brandText')}
            </p>
          </div>

          {/* Col 2: Quick Links */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              {t('footer.studentNav')}
            </h4>
            <ul className="space-y-1.5 text-slate-400">
              <li>
                <button onClick={onOpenAdmitCard} className="hover:text-white transition-colors">
                  {t('footer.link.admitCard')}
                </button>
              </li>
              <li>
                <button onClick={onOpenMockExam} className="hover:text-white transition-colors">
                  {t('footer.link.mock')}
                </button>
              </li>
              <li>
                <button onClick={onOpenCenterLocator} className="hover:text-white transition-colors">
                  {t('footer.link.centers')}
                </button>
              </li>
              <li>
                <button onClick={onOpenResults} className="hover:text-white transition-colors">
                  {t('footer.link.results')}
                </button>
              </li>
              <li>
                <button onClick={onOpenGrievance} className="hover:text-white transition-colors">
                  {t('footer.link.helpdesk')}
                </button>
              </li>
            </ul>
          </div>

          {/* Col 3: Examination Programs */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              {t('footer.why.info')}
            </h4>
            <ul className="space-y-1.5 text-slate-400">
              <li>{t('footer.info1')}</li>
              <li>{t('footer.info2')}</li>
              <li>{t('footer.info3')}</li>
            </ul>
          </div>

          {/* Col 4: Contact Info */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              {t('footer.contact')}
            </h4>
            <div className="space-y-1.5 text-slate-400 text-xs">
              <p>{t('footer.contactText')}</p>
              <button onClick={onOpenGrievance} className="text-emerald-300 hover:text-white transition-colors">
                {t('footer.openHelpdesk')}
              </button>
            </div>
            <button
              onClick={scrollToTop}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs transition-colors"
            >
              <ArrowUp className="w-3.5 h-3.5" />
              <span>{t('footer.backToTop')}</span>
            </button>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="mt-8 pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>© {new Date().getFullYear()} {t('footer.copyright')}</span>
          <nav aria-label={t('footer.legalNav')} className="flex items-center gap-4">
            <a href="/privacy" className="hover:text-white">{t('footer.privacy')}</a>
            <a href="/terms" className="hover:text-white">{t('footer.terms')}</a>
          </nav>
        </div>
      </div>
    </footer>
  );
};
