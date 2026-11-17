import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import en from './locales/en.ts';
import hi from './locales/hi.ts';
import kn from './locales/kn.ts';
import bn from './locales/bn.ts';
import mr from './locales/mr.ts';
import { placeholdersOf, registerDictionary, translate } from './translate.ts';

const DICTIONARIES = { Hindi: hi, Kannada: kn, Bengali: bn, Marathi: mr };
for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
  registerDictionary(language as keyof typeof DICTIONARIES, dictionary);
}

describe('translate', () => {
  test('fills placeholders and leaves unknown ones visible', () => {
    assert.equal(translate('English', 'nav.applyUntil', { date: '2026-12-31' }), 'Apply until 2026-12-31');
    assert.equal(translate('English', 'nav.applyUntil'), 'Apply until {date}');
  });

  test('falls back to English, then to the key itself', () => {
    assert.equal(translate('Hindi', 'definitely.missing.key'), 'definitely.missing.key');
    // Server messages passed through t() are shown unchanged.
    assert.equal(translate('Hindi', 'Your session has expired.'), 'Your session has expired.');
  });
});

describe('locale files', () => {
  const englishKeys = Object.keys(en).sort();
  for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
    test(`${language} has every English key, and no extras`, () => {
      const keys = Object.keys(dictionary).sort();
      const missing = englishKeys.filter((key) => !(key in dictionary));
      const extra = keys.filter((key) => !(key in en));
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
    });

    test(`${language} keeps the same {placeholders} as English`, () => {
      const mismatched = englishKeys.filter((key) => {
        const message = (dictionary as Record<string, string | undefined>)[key];
        return message !== undefined && placeholdersOf(message).join() !== placeholdersOf(en[key as keyof typeof en]).join();
      });
      assert.deepEqual(mismatched, []);
    });

    test(`${language} messages are non-empty`, () => {
      const empty = Object.entries(dictionary).filter(([, message]) => !message?.trim()).map(([key]) => key);
      assert.deepEqual(empty, []);
    });
  }
});
