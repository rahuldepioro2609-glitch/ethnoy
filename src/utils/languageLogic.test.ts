import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES,
  LANGUAGE_OPTIONS,
  getNextLanguage,
  getSavedLanguage,
  LANGUAGE_LOCALES,
  Language,
} from './languageLogic.js';
import { registerDictionary, translate } from '../i18n/translate.ts';
import hi from '../i18n/locales/hi.ts';
import kn from '../i18n/locales/kn.ts';
import bn from '../i18n/locales/bn.ts';
import mr from '../i18n/locales/mr.ts';

registerDictionary('Hindi', hi);
registerDictionary('Kannada', kn);
registerDictionary('Bengali', bn);
registerDictionary('Marathi', mr);

test('LANGUAGES contains the supported launch languages', () => {
  assert.deepEqual(LANGUAGES, ['English', 'Hindi', 'Kannada', 'Bengali', 'Marathi']);
  assert.equal(LANGUAGE_OPTIONS.length, 5);
});

test('getNextLanguage cycles through all launch languages', () => {
  let lang: Language = 'English';
  const sequence: Language[] = [];
  for (let index = 0; index < LANGUAGES.length; index += 1) {
    lang = getNextLanguage(lang);
    sequence.push(lang);
  }
  assert.deepEqual(sequence, ['Hindi', 'Kannada', 'Bengali', 'Marathi', 'English']);
});

test('getNextLanguage falls back gracefully if invalid language provided', () => {
  // @ts-expect-error testing fallback
  assert.equal(getNextLanguage('InvalidLang'), 'English');
});

test('top bar text is localized for each supported language', () => {
  assert.equal(translate('English', 'topbar.welcome'), 'Welcome to ELTNOY Examination Portal');
  assert.equal(translate('English', 'topbar.helpdesk'), 'Helpdesk');
  assert.ok(translate('Hindi', 'topbar.welcome').includes('स्वागत'));
  assert.equal(translate('Hindi', 'topbar.helpdesk'), 'सहायता केंद्र');
  assert.ok(translate('Kannada', 'topbar.welcome').includes('ಸುಸ್ವಾಗತ'));
  assert.ok(translate('Bengali', 'topbar.welcome').includes('স্বাগতম'));
  assert.ok(translate('Marathi', 'topbar.welcome').includes('स्वागत'));
  assert.deepEqual(LANGUAGE_LOCALES, {
    English: 'en-IN',
    Hindi: 'hi-IN',
    Kannada: 'kn-IN',
    Bengali: 'bn-IN',
    Marathi: 'mr-IN',
  });
});

test('getSavedLanguage returns a supported preference or English fallback', () => {
  assert.equal(getSavedLanguage('Marathi'), 'Marathi');
  assert.equal(getSavedLanguage('Regional'), 'English');
  assert.equal(getSavedLanguage(null), 'English');
});
