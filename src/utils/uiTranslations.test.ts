import test from 'node:test';
import assert from 'node:assert/strict';
import { translateUiText } from './uiTranslations.js';
import { LANGUAGES } from './languageLogic.js';

test('translateUiText preserves English and localizes core portal labels', () => {
  assert.equal(translateUiText('English', 'Student Login'), 'Student Login');
  assert.equal(translateUiText('Hindi', 'Student Login'), 'विद्यार्थी लॉग इन');
  assert.equal(translateUiText('Kannada', 'Student Login'), 'ವಿದ್ಯಾರ್ಥಿ ಲಾಗಿನ್');
  assert.equal(translateUiText('Bengali', 'Student Login'), 'শিক্ষার্থী লগইন');
  assert.equal(translateUiText('Marathi', 'Student Login'), 'विद्यार्थी लॉग इन');
});

test('translateUiText falls back to original content when a phrase is not translated', () => {
  for (const language of LANGUAGES) {
    assert.equal(translateUiText(language, 'Untranslated institution content'), 'Untranslated institution content');
  }
});
