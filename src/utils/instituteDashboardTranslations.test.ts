import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instituteDashboardTranslations } from './instituteDashboardTranslations.ts';
import { translateUiText } from './uiTranslations.ts';
import { LANGUAGES } from './languageLogic.ts';

const otherLanguages = LANGUAGES.filter((language) => language !== 'English');
const placeholders = (text: string) => [...text.matchAll(/\{[a-zA-Z]+\}/g)].map((match) => match[0]).sort();

test('every institute dashboard string is translated into every language with its placeholders', () => {
  for (const [english, translations] of Object.entries(instituteDashboardTranslations)) {
    for (const language of otherLanguages) {
      const translated = translations[language];
      assert.ok(translated && translated.trim(), `${language} missing for "${english}"`);
      assert.deepEqual(placeholders(translated), placeholders(english), `${language} placeholders for "${english}"`);
      // Also proves no older entry with the same English key overrides this one.
      assert.equal(translateUiText(language, english), translated, `${language} lookup for "${english}"`);
    }
  }
});

test('the institute overview has no untranslated UI text', () => {
  const source = readFileSync(new URL('../components/InstituteDashboardOverview.tsx', import.meta.url), 'utf8');
  // UI text in this component is single-quoted and starts with a capital letter or a placeholder;
  // class names use double quotes or template literals.
  const uiText = [...source.matchAll(/'([A-Z{][^'\n]*[a-z][^'\n]*)'/g)]
    .map((match) => match[1])
    .filter((text) => !/^\{[a-zA-Z]+\}$/.test(text)); // the `{code}` in .replace('{code}', …)
  assert.ok(uiText.length > 40, `expected to find the component's UI text, found ${uiText.length}`);
  const missing = uiText.filter((text) => !(text in instituteDashboardTranslations) && translateUiText('Hindi', text) === text);
  assert.deepEqual(missing, []);
});

test('the institute header, menu and section titles in RolePortal are translated', () => {
  const source = readFileSync(new URL('../components/RolePortal.tsx', import.meta.url), 'utf8');
  const menuStart = source.indexOf('const instituteNavItems = [');
  const menuEnd = source.indexOf('];', menuStart);
  const descriptionsStart = source.indexOf('const instituteSectionDescriptions:', menuEnd);
  const descriptionsEnd = source.indexOf('};', descriptionsStart);
  assert.ok(menuStart > 0 && menuEnd > menuStart && descriptionsStart > menuEnd && descriptionsEnd > descriptionsStart,
    'institute menu and section definitions not found');
  const definitions = `${source.slice(menuStart, menuEnd)}\n${source.slice(descriptionsStart, descriptionsEnd)}`;
  // Menu labels (`label: '…'`) and section descriptions (`'institute-x': '…'`), not the ids.
  const strings = [...definitions.matchAll(/(?:label: |'institute-[a-z]+': )'([^']+)'/g)].map((match) => match[1]);
  assert.ok(strings.length >= 14, `expected menu labels and descriptions, found ${strings.length}`);
  for (const text of [...strings, 'Examination portal', 'Institute workspace', 'Institute Dashboard', 'Welcome back, {name}',
    'Verify candidate', 'Open institute profile', 'Institute sections', 'Open institute workspace menu',
    'Close institute workspace menu', 'Candidate check-ins could not be loaded',
    'Institute forms, profile and wallet could not be loaded',
    'Figures that depend on this data show “—” until it loads. Please try again.', 'Try again']) {
    assert.notEqual(translateUiText('Hindi', text), text, `no translation for "${text}"`);
    assert.ok(source.includes(`'${text}'`), `"${text}" is no longer used in RolePortal.tsx`);
  }
});
