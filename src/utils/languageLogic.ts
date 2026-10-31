/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Language = 'English' | 'Hindi' | 'Kannada' | 'Bengali' | 'Marathi';

export interface TopUtilityBarTranslations {
  welcome: string;
  helpdesk: string;
  langLabel: string;
  badge: string;
}

export const LANGUAGES: Language[] = ['English', 'Hindi', 'Kannada', 'Bengali', 'Marathi'];

export const LANGUAGE_OPTIONS: { id: Language; label: string; nativeName: string; shortCode: string }[] = [
  { id: 'English', label: 'English', nativeName: 'English (Default)', shortCode: 'EN' },
  { id: 'Hindi', label: 'Hindi', nativeName: 'हिन्दी (Hindi)', shortCode: 'HI' },
  { id: 'Kannada', label: 'Kannada', nativeName: 'ಕನ್ನಡ (Kannada)', shortCode: 'KN' },
  { id: 'Bengali', label: 'Bengali', nativeName: 'বাংলা (Bengali)', shortCode: 'BN' },
  { id: 'Marathi', label: 'Marathi', nativeName: 'मराठी (Marathi)', shortCode: 'MR' },
];

export const LANGUAGE_LOCALES: Record<Language, string> = {
  English: 'en-IN',
  Hindi: 'hi-IN',
  Kannada: 'kn-IN',
  Bengali: 'bn-IN',
  Marathi: 'mr-IN',
};

export const TOP_BAR_TRANSLATIONS: Record<Language, TopUtilityBarTranslations> = {
  English: {
    welcome: 'Welcome to ELTNOY Examination Portal',
    helpdesk: 'Helpdesk',
    langLabel: 'English',
    badge: 'Official Exam Portal',
  },
  Hindi: {
    welcome: 'ELTNOY परीक्षा पोर्टल में आपका स्वागत है',
    helpdesk: 'सहायता केंद्र',
    langLabel: 'हिन्दी (Hindi)',
    badge: 'आधिकारिक परीक्षा पोर्टल',
  },
  Kannada: {
    welcome: 'ELTNOY ಪರೀಕ್ಷಾ ಪೋರ್ಟಲ್‌ಗೆ ಸುಸ್ವಾಗತ',
    helpdesk: 'ಸಹಾಯ ಕೇಂದ್ರ',
    langLabel: 'ಕನ್ನಡ',
    badge: 'ಅಧಿಕೃತ ಪರೀಕ್ಷಾ ಪೋರ್ಟಲ್',
  },
  Bengali: {
    welcome: 'ELTNOY পরীক্ষা পোর্টালে আপনাকে স্বাগতম',
    helpdesk: 'সহায়তা কেন্দ্র',
    langLabel: 'বাংলা',
    badge: 'সরকারি পরীক্ষা পোর্টাল',
  },
  Marathi: {
    welcome: 'ELTNOY परीक्षा पोर्टलवर आपले स्वागत आहे',
    helpdesk: 'मदत केंद्र',
    langLabel: 'मराठी',
    badge: 'अधिकृत परीक्षा पोर्टल',
  },
};

export function getSavedLanguage(value: string | null): Language {
  return LANGUAGES.find((language) => language === value) ?? 'English';
}

/**
 * Returns the next language in the supported-language cycle.
 */
export function getNextLanguage(current: Language): Language {
  const currentIndex = LANGUAGES.indexOf(current);
  if (currentIndex === -1) return 'English';
  const nextIndex = (currentIndex + 1) % LANGUAGES.length;
  return LANGUAGES[nextIndex];
}

/**
 * Retrieves the translation object for the provided language with fallback to English.
 */
export function getTopBarTranslation(lang: Language): TopUtilityBarTranslations {
  return TOP_BAR_TRANSLATIONS[lang] || TOP_BAR_TRANSLATIONS.English;
}
