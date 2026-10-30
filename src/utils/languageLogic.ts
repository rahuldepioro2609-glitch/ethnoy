/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Language = 'English' | 'Hindi' | 'Regional';

export interface TopUtilityBarTranslations {
  welcome: string;
  helpdesk: string;
  langLabel: string;
  badge: string;
}

export const LANGUAGES: Language[] = ['English', 'Hindi', 'Regional'];

export const LANGUAGE_OPTIONS: { id: Language; label: string; nativeName: string; shortCode: string }[] = [
  { id: 'English', label: 'English', nativeName: 'English (Default)', shortCode: 'EN' },
  { id: 'Hindi', label: 'Hindi', nativeName: 'हिन्दी (Hindi)', shortCode: 'HI' },
  { id: 'Regional', label: 'Regional', nativeName: 'Regional (ಕನ್ನಡ/বাংলা/मराठी)', shortCode: 'REG' },
];

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
  Regional: {
    welcome: 'ELTNOY ಪರೀಕ್ಷಾ ಪೋರ್ಟಲ್‌ಗೆ ಸುಸ್ವಾಗತ (Regional)',
    helpdesk: 'ಸಹಾಯವಾಣಿ (Helpdesk)',
    langLabel: 'Regional (ಕನ್ನಡ/বাংলা)',
    badge: 'ಅಧಿಕೃತ ಪೋರ್ಟಲ್',
  },
};

/**
 * Returns the next language in the cycle: English -> Hindi -> Regional -> English
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
