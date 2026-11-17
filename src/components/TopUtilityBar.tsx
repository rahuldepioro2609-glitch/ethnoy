/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Headphones,
  Globe,
  Eye,
  ChevronDown,
  Check,
  RefreshCw,
  Clock3,
} from 'lucide-react';
import {
  Language,
  LANGUAGE_LOCALES,
  LANGUAGE_OPTIONS,
  getNextLanguage,
} from '../utils/languageLogic';
import { useTranslation } from '../i18n';

interface TopUtilityBarProps {
  fontSizeLevel: number;
  onFontSizeChange: (level: number) => void;
  highContrast: boolean;
  onToggleHighContrast: () => void;
  onOpenGrievance: () => void;
}

export const TopUtilityBar: React.FC<TopUtilityBarProps> = ({
  fontSizeLevel,
  onFontSizeChange,
  highContrast,
  onToggleHighContrast,
  onOpenGrievance,
}) => {
  const { t, language: selectedLanguage, setLanguage } = useTranslation();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [indiaTime, setIndiaTime] = useState(() => new Date());
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setIndiaTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isDropdownOpen]);

  const handleSelectLanguage = (lang: Language) => {
    setLanguage(lang);
    setIsDropdownOpen(false);
  };

  const handleCycleLanguage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLanguage(getNextLanguage(selectedLanguage));
  };
  const currentOption = LANGUAGE_OPTIONS.find((option) => option.id === selectedLanguage) ?? LANGUAGE_OPTIONS[0];
  const locale = LANGUAGE_LOCALES[selectedLanguage];

  return (
    <aside
      aria-label={t('topbar.aria')}
      className={`border-b text-xs transition-colors py-1.5 px-4 md:px-8 relative z-50 ${
        highContrast
          ? 'bg-black text-amber-300 border-amber-500'
          : 'bg-[#0B2E59] text-slate-200 border-[#082347]'
      }`}
    >
      <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-y-1.5 gap-x-4">
        {/* Left: Dynamic localized welcome text updated via component state */}
        <div className="flex items-center gap-2 text-xs font-normal text-slate-200 tracking-wide">
          <span className="font-medium text-slate-100 transition-all duration-200">
            {t('topbar.welcome')}
          </span>
          <span className="hidden lg:inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            {t('topbar.badge')}
          </span>
          <span
            className="inline-flex whitespace-nowrap items-center gap-1.5 rounded bg-blue-950/60 px-2 py-1 font-mono text-[11px] font-semibold tabular-nums text-emerald-200"
            aria-label={`${t('topbar.indiaTimeAria')} ${new Intl.DateTimeFormat(locale, {
              timeZone: 'Asia/Kolkata',
              dateStyle: 'full',
              timeStyle: 'long',
            }).format(indiaTime)}`}
          >
            <Clock3 className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">{t('topbar.india')}</span>
            <time dateTime={indiaTime.toISOString()}>
              {new Intl.DateTimeFormat(locale, {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true,
              }).format(indiaTime)} {t('topbar.ist')}
            </time>
          </span>
        </div>

        {/* Right: Helpdesk and language selector */}
        <div className="flex items-center flex-wrap gap-x-3 sm:gap-x-4 gap-y-1 text-xs text-slate-200 ml-auto">
          {/* Helpdesk */}
          <button
            type="button"
            onClick={onOpenGrievance}
            className="flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer"
            title={t('topbar.openHelpdesk')}
          >
            <Headphones className="w-3.5 h-3.5 text-sky-300" />
            <span className="font-medium">{t('topbar.helpdesk')}</span>
          </button>

          <span className="hidden sm:inline text-slate-400/50">|</span>

          {/* Language Selector Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <div className="inline-flex items-center rounded bg-slate-900/60 border border-slate-700 hover:border-slate-500 transition-colors">
              {/* Dropdown open trigger */}
              <button
                type="button"
                onClick={() => setIsDropdownOpen((prev) => !prev)}
                className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-slate-100 hover:text-white cursor-pointer"
                aria-expanded={isDropdownOpen}
                aria-haspopup="true"
                aria-label={t('topbar.selectLanguage', { language: currentOption.nativeName })}
              >
                <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="font-semibold">{currentOption.label === 'English' ? 'English' : currentOption.nativeName.split(' (')[0]}</span>
                <ChevronDown
                  className={`w-3 h-3 text-slate-300 transition-transform duration-200 ${
                    isDropdownOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {/* Quick Cycle button to cycle through supported languages */}
              <button
                type="button"
                onClick={handleCycleLanguage}
                title={t('topbar.cycleLanguage')}
                className="px-1.5 py-0.5 border-l border-slate-700/80 hover:bg-slate-800 text-sky-300 hover:text-sky-200 cursor-pointer transition-colors"
                aria-label={t('topbar.cycleLanguage')}
              >
                <RefreshCw className="w-2.5 h-2.5" />
              </button>
            </div>

            {/* Dropdown Menu */}
            {isDropdownOpen && (
              <div
                role="menu"
                aria-orientation="vertical"
                className="absolute right-0 mt-1.5 w-52 bg-[#0B254E] border border-sky-900/80 rounded-lg shadow-xl py-1 text-xs z-50 animate-in fade-in-50 zoom-in-95 duration-150"
              >
                <div className="px-3 py-1 text-[10px] uppercase font-bold tracking-wider text-slate-400 border-b border-sky-900/60 mb-1 flex items-center justify-between">
                  <span>{t('topbar.portalLanguage')}</span>
                  <span className="text-emerald-400 font-mono">{t('topbar.optionCount', { count: LANGUAGE_OPTIONS.length })}</span>
                </div>
                <p className="px-3 py-1.5 text-[10px] leading-relaxed text-slate-400">
                  {t('topbar.translationNote')}
                </p>

                {LANGUAGE_OPTIONS.map((option) => {
                  const isSelected = selectedLanguage === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitem"
                      onClick={() => handleSelectLanguage(option.id)}
                      className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-emerald-600/30 text-white font-semibold'
                          : 'text-slate-200 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-5 text-[10px] font-mono text-sky-300 font-bold">
                          {option.shortCode}
                        </span>
                        <span>{option.nativeName}</span>
                      </div>
                      {isSelected && (
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      )}
                    </button>
                  );
                })}

                <div className="mt-1 pt-1 border-t border-sky-900/60 px-3 py-1 text-[10px] text-slate-400 flex items-center justify-between">
                  <span>{t('topbar.quickToggle')}</span>
                  <button
                    type="button"
                    onClick={handleCycleLanguage}
                    className="text-emerald-400 hover:text-emerald-300 underline font-medium cursor-pointer"
                  >
                    {t('topbar.cycleNext')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Accessibility toggle pill */}
          <div className="hidden lg:flex items-center gap-1 ml-1 pl-2 border-l border-slate-600/50">
            <button
              type="button"
              onClick={() => onFontSizeChange(fontSizeLevel === 0 ? 1 : 0)}
              className="text-[10px] px-1 py-0.5 rounded bg-blue-950/60 hover:bg-blue-900 text-slate-300 font-bold cursor-pointer"
              title={t('topbar.fontSize')} aria-label={t('topbar.fontSize')}
            >
              A{fontSizeLevel > 0 ? '+' : ''}
            </button>
            <button
              type="button"
              onClick={onToggleHighContrast}
              className="p-1 rounded bg-blue-950/60 hover:bg-blue-900 text-slate-300 cursor-pointer"
              title={t('topbar.contrast')} aria-label={t('topbar.contrast')}
            >
              <Eye className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
