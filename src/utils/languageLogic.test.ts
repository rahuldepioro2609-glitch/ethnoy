import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES,
  LANGUAGE_OPTIONS,
  TOP_BAR_TRANSLATIONS,
  getNextLanguage,
  getSavedLanguage,
  getTopBarTranslation,
  LANGUAGE_LOCALES,
  Language,
} from './languageLogic.js';

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

test('getTopBarTranslation returns localized text for each supported language', () => {
  const en = getTopBarTranslation('English');
  assert.equal(en.welcome, 'Welcome to ELTNOY Examination Portal');
  assert.equal(en.helpdesk, 'Helpdesk');

  const hi = getTopBarTranslation('Hindi');
  assert.ok(hi.welcome.includes('स्वागत'));
  assert.equal(hi.helpdesk, 'सहायता केंद्र');

  assert.ok(getTopBarTranslation('Kannada').welcome.includes('ಸುಸ್ವಾಗತ'));
  assert.ok(getTopBarTranslation('Bengali').welcome.includes('স্বাগতম'));
  assert.ok(getTopBarTranslation('Marathi').welcome.includes('स्वागत'));
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
