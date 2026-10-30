/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Phone,
  Mail,
  Headphones,
  Globe,
  Eye,
  ChevronDown,
  Check,
  RefreshCw,
} from 'lucide-react';
import {
  Language,
  LANGUAGE_OPTIONS,
  getNextLanguage,
  getTopBarTranslation,
} from '../utils/languageLogic';

interface TopUtilityBarProps {
  fontSizeLevel: number;
  onFontSizeChange: (level: number) => void;
  highContrast: boolean;
  onToggleHighContrast: () => void;
  onOpenGrievance: () => void;
  onLanguageChange?: (lang: Language) => void;
}

export const TopUtilityBar: React.FC<TopUtilityBarProps> = ({
  fontSizeLevel,
  onFontSizeChange,
  highContrast,
  onToggleHighContrast,
  onOpenGrievance,
  onLanguageChange,
}) => {
  // Component-level state to store selected language and update UI text
  const [selectedLanguage, setSelectedLanguage] = useState<Language>('English');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Active translations for UI text based on component state
  const t = getTopBarTranslation(selectedLanguage);

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
    setSelectedLanguage(lang);
    setIsDropdownOpen(false);
    onLanguageChange?.(lang);
  };

  const handleCycleLanguage = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextLang = getNextLanguage(selectedLanguage);
    setSelectedLanguage(nextLang);
    onLanguageChange?.(nextLang);
  };

  return (
    <aside
      aria-label="ELTNOY Examination Portal Utility Bar"
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
            {t.welcome}
          </span>
          <span className="hidden lg:inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            {t.badge}
          </span>
        </div>

        {/* Right: Helpdesk, Phone, Email, Language Selector */}
        <div className="flex items-center flex-wrap gap-x-3 sm:gap-x-4 gap-y-1 text-xs text-slate-200 ml-auto">
          {/* Helpdesk */}
          <button
            type="button"
            onClick={onOpenGrievance}
            className="flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer"
            title="Open Helpdesk"
          >
            <Headphones className="w-3.5 h-3.5 text-sky-300" />
            <span className="font-medium">{t.helpdesk}</span>
          </button>

          <span className="hidden sm:inline text-slate-400/50">|</span>

          {/* Helpline Phone */}
          <a
            href="tel:+919876543210"
            className="flex items-center gap-1.5 hover:text-white transition-colors"
          >
            <Phone className="w-3.5 h-3.5 text-sky-300" />
            <span className="font-sans">{t.phoneLabel}</span>
          </a>

          <span className="hidden sm:inline text-slate-400/50">|</span>

          {/* Email Support */}
          <a
            href="mailto:support@eltnoy.com"
            className="flex items-center gap-1.5 hover:text-white transition-colors"
          >
            <Mail className="w-3.5 h-3.5 text-sky-300" />
            <span className="hidden md:inline">{t.emailLabel}</span>
            <span className="md:hidden">Email</span>
          </a>

          <span className="hidden sm:inline text-slate-400/50">|</span>

          {/* Language Selector Dropdown (English, Hindi, Regional) */}
          <div className="relative" ref={dropdownRef}>
            <div className="inline-flex items-center rounded bg-slate-900/60 border border-slate-700 hover:border-slate-500 transition-colors">
              {/* Dropdown open trigger */}
              <button
                type="button"
                onClick={() => setIsDropdownOpen((prev) => !prev)}
                className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-slate-100 hover:text-white cursor-pointer"
                aria-expanded={isDropdownOpen}
                aria-haspopup="true"
                aria-label={`Select language. Current: ${selectedLanguage}`}
              >
                <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="font-semibold">{selectedLanguage}</span>
                <ChevronDown
                  className={`w-3 h-3 text-slate-300 transition-transform duration-200 ${
                    isDropdownOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {/* Quick Cycle button to cycle through 'English' -> 'Hindi' -> 'Regional' */}
              <button
                type="button"
                onClick={handleCycleLanguage}
                title="Cycle next language (English → Hindi → Regional)"
                className="px-1.5 py-0.5 border-l border-slate-700/80 hover:bg-slate-800 text-sky-300 hover:text-sky-200 cursor-pointer transition-colors"
                aria-label="Cycle to next language"
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
                  <span>Portal Language</span>
                  <span className="text-emerald-400 font-mono">3 Options</span>
                </div>

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
                  <span>Quick toggle:</span>
                  <button
                    type="button"
                    onClick={handleCycleLanguage}
                    className="text-emerald-400 hover:text-emerald-300 underline font-medium cursor-pointer"
                  >
                    Cycle Next
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
              title="Toggle Font Size"
            >
              A{fontSizeLevel > 0 ? '+' : ''}
            </button>
            <button
              type="button"
              onClick={onToggleHighContrast}
              className="p-1 rounded bg-blue-950/60 hover:bg-blue-900 text-slate-300 cursor-pointer"
              title="Toggle Contrast"
            >
              <Eye className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
