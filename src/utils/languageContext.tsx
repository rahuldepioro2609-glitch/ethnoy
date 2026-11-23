import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getSavedLanguage, LANGUAGE_LOCALES, Language } from './languageLogic';
import { translateUiText } from './uiTranslations';

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (englishText: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export const LanguageProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [language, setLanguage] = useState<Language>(() => (
    typeof window === 'undefined' ? 'English' : getSavedLanguage(window.localStorage.getItem('portal-language'))
  ));

  useEffect(() => {
    window.localStorage.setItem('portal-language', language);
    document.documentElement.lang = LANGUAGE_LOCALES[language].split('-')[0];
  }, [language]);

  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t: (englishText) => translateUiText(language, englishText),
  }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider.');
  return context;
}
