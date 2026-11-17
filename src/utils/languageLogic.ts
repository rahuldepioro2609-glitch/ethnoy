/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Language = 'English' | 'Hindi' | 'Kannada' | 'Bengali' | 'Marathi';

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
