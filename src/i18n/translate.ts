import type { Language } from '../utils/languageLogic';
import en from './locales/en';
import hi from './locales/hi';
import kn from './locales/kn';
import bn from './locales/bn';
import mr from './locales/mr';

export type TranslationKey = keyof typeof en;
export type Dictionary = Record<TranslationKey, string>;
export type TranslationParams = Record<string, string | number>;

export const DICTIONARIES: Record<Language, Partial<Dictionary>> = {
  English: en,
  Hindi: hi,
  Kannada: kn,
  Bengali: bn,
  Marathi: mr,
};

/** Returns the {placeholder} names used in a message, sorted. */
export function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

/**
 * Looks up a message in the chosen language, falling back to English, then to the key itself,
 * and fills {placeholders} from params.
 */
export function translate(language: Language, key: string, params?: TranslationParams): string {
  const message = (DICTIONARIES[language] as Record<string, string | undefined>)[key]
    ?? (en as Record<string, string | undefined>)[key]
    ?? key;
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => (
    Object.hasOwn(params, name) ? String(params[name]) : placeholder
  ));
}
