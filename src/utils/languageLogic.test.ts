import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES,
  LANGUAGE_OPTIONS,
  TOP_BAR_TRANSLATIONS,
  getNextLanguage,
  getTopBarTranslation,
  Language,
} from './languageLogic.js';

test('LANGUAGES contains English, Hindi, and Regional', () => {
  assert.deepEqual(LANGUAGES, ['English', 'Hindi', 'Regional']);
  assert.equal(LANGUAGE_OPTIONS.length, 3);
});

test('getNextLanguage cycles through English -> Hindi -> Regional -> English', () => {
  let lang: Language = 'English';
  lang = getNextLanguage(lang);
  assert.equal(lang, 'Hindi');

  lang = getNextLanguage(lang);
  assert.equal(lang, 'Regional');

  lang = getNextLanguage(lang);
  assert.equal(lang, 'English');
});

test('getNextLanguage falls back gracefully if invalid language provided', () => {
  // @ts-expect-error testing fallback
  assert.equal(getNextLanguage('InvalidLang'), 'English');
});

test('getTopBarTranslation returns appropriate localized text for each language', () => {
  const en = getTopBarTranslation('English');
  assert.equal(en.welcome, 'Welcome to ELTNOY Examination Portal');
  assert.equal(en.helpdesk, 'Helpdesk');

  const hi = getTopBarTranslation('Hindi');
  assert.ok(hi.welcome.includes('स्वागत'));
  assert.equal(hi.helpdesk, 'सहायता केंद्र');

  const reg = getTopBarTranslation('Regional');
  assert.ok(reg.welcome.includes('ಸುಸ್ವಾಗತ') || reg.welcome.includes('Regional'));
  assert.ok(reg.helpdesk.includes('Helpdesk') || reg.helpdesk.includes('ಸಹಾಯವಾಣಿ'));
});
