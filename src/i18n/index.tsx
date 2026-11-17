import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LANGUAGE_LOCALES, getSavedLanguage, type Language } from '../utils/languageLogic';
import { isDictionaryLoaded, loadDictionary, translate, type TranslationKey, type TranslationParams } from './translate';

export type { TranslationKey } from './translate';

const STORAGE_KEY = 'portal-language';
const HTML_LANG: Record<Language, string> = { English: 'en', Hindi: 'hi', Kannada: 'kn', Bengali: 'bn', Marathi: 'mr' };

interface I18nValue {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  /** Accepts known keys, or a computed key string (e.g. `answerKey.status.${status}`). */
  t: (key: TranslationKey | (string & {}), params?: TranslationParams) => string;
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: (value: string | number | Date) => string;
  formatNumber: (value: number) => string;
}

function readSavedLanguage(): Language {
  try {
    return getSavedLanguage(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'English';
  }
}

function createValue(language: Language, setLanguage: (language: Language) => void): I18nValue {
  const locale = LANGUAGE_LOCALES[language];
  const safeDate = (value: string | number | Date) => {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  return {
    language,
    locale,
    setLanguage,
    t: (key, params) => translate(language, key, params),
    formatDate: (value, options = { day: 'numeric', month: 'short', year: 'numeric' }) => {
      const date = safeDate(value);
      return date ? new Intl.DateTimeFormat(locale, options).format(date) : String(value);
    },
    formatDateTime: (value) => {
      const date = safeDate(value);
      return date ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : String(value);
    },
    formatNumber: (value) => new Intl.NumberFormat(locale).format(value),
  };
}

const I18nContext = createContext<I18nValue>(createValue('English', () => undefined));

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(readSavedLanguage);
  // Bumped when a language file finishes loading, so text re-renders in that language.
  const [loadedVersion, setLoadedVersion] = useState(0);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this visit when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = HTML_LANG[language];
    if (isDictionaryLoaded(language)) return;
    let cancelled = false;
    loadDictionary(language)
      .then(() => { if (!cancelled) setLoadedVersion((version) => version + 1); })
      .catch(() => { /* English text stays visible if the language file cannot load. */ });
    return () => { cancelled = true; };
  }, [language]);

  const value = useMemo(() => createValue(language, setLanguage), [language, setLanguage, loadedVersion]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useTranslation(): I18nValue {
  return useContext(I18nContext);
}
