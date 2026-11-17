import type { Language } from '../utils/languageLogic';
import en from './locales/en';

export type TranslationKey = keyof typeof en;
export type Dictionary = Record<TranslationKey, string>;
export type TranslationParams = Record<string, string | number>;

/**
 * English ships with the main bundle. Other languages are separate chunks, fetched only
 * when a visitor chooses them, so most visitors do not download every translation.
 */
const LOADERS: Record<Exclude<Language, 'English'>, () => Promise<{ default: Partial<Dictionary> }>> = {
  Hindi: () => import('./locales/hi'),
  Kannada: () => import('./locales/kn'),
  Bengali: () => import('./locales/bn'),
  Marathi: () => import('./locales/mr'),
};

const loaded: Partial<Record<Language, Partial<Dictionary>>> = { English: en };

export function isDictionaryLoaded(language: Language): boolean {
  return Boolean(loaded[language]);
}

export async function loadDictionary(language: Language): Promise<void> {
  if (loaded[language] || language === 'English') return;
  loaded[language] = (await LOADERS[language]()).default;
}

/** For tests: registers a dictionary without the dynamic import. */
export function registerDictionary(language: Language, dictionary: Partial<Dictionary>): void {
  loaded[language] = dictionary;
}

/** Returns the {placeholder} names used in a message, sorted. */
export function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

/**
 * Looks up a message in the chosen language, falling back to English, then to the key itself,
 * and fills {placeholders} from params.
 */
export function translate(language: Language, key: string, params?: TranslationParams): string {
  const message = (loaded[language] as Record<string, string | undefined> | undefined)?.[key]
    ?? (en as Record<string, string | undefined>)[key]
    ?? key;
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => (
    Object.hasOwn(params, name) ? String(params[name]) : placeholder
  ));
}
