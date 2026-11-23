import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstituteSignOutPage } from '../InstituteSignOutPage.tsx';
import { StickyNavbar } from '../StickyNavbar.tsx';
import { LanguageProvider } from '../../utils/languageContext.tsx';

const noop = () => undefined;
const navbarProps: React.ComponentProps<typeof StickyNavbar> = {
  onOpenSearch: noop,
  onOpenLogin: noop,
  account: null,
  authLoading: false,
  onSignOut: noop,
  onOpenAdmitCard: noop,
  onOpenMockExam: noop,
  onOpenCenterLocator: noop,
  onOpenNoticeCategory: noop,
  onSelectExamFilter: noop,
  onOpenResultsPortal: noop,
  onOpenAnswerKeyPortal: noop,
  onOpenInstituteDashboard: noop,
  instituteReturn: null,
  examinations: [],
  activeNavTab: 'Home',
  setActiveNavTab: noop,
};

const renderNavbar = (overrides: Partial<typeof navbarProps> = {}) => renderToStaticMarkup(
  <LanguageProvider><StickyNavbar {...navbarProps} {...overrides} /></LanguageProvider>,
);

test('signed-in Student and Institute identities appear below the logo with Sign out in the header', () => {
  for (const account of [
    { name: 'Asha Student', role: 'candidate' as const },
    { name: 'ABC Public School', role: 'center' as const },
  ]) {
    const markup = renderNavbar({ account });
    assert.match(markup, new RegExp(account.name));
    assert.match(markup, new RegExp(account.role === 'center' ? 'Institute' : 'Student'));
    assert.match(markup, /aria-label="Sign out"/);
    assert.doesNotMatch(markup, /aria-label="Login"/);
  }
});

test('a public Institute hint links to the Institute dashboard and verified sign-out bridge instead of Login', () => {
  const markup = renderNavbar({
    instituteReturn: {
      name: 'ABC Public School',
      href: 'https://institution.example.test/dashboard/center',
      signOutHref: 'https://institution.example.test/sign-out/institute',
    },
  });
  assert.match(markup, /ABC Public School/);
  assert.match(markup, /href="https:\/\/institution\.example\.test\/dashboard\/center"/);
  assert.match(markup, /href="https:\/\/institution\.example\.test\/sign-out\/institute"/);
  assert.match(markup, /aria-label="Sign out of institute account"/);
  assert.doesNotMatch(markup, /aria-label="Login"/);
});

test('a signed-out visitor sees Login; auth checking temporarily hides account actions', () => {
  const signedOut = renderNavbar();
  assert.match(signedOut, /aria-label="Login"/);
  assert.doesNotMatch(signedOut, /aria-label="Sign out"/);

  const checking = renderNavbar({ authLoading: true });
  assert.match(checking, /aria-label="Checking sign-in"/);
  assert.doesNotMatch(checking, /aria-label="Login"/);
  assert.doesNotMatch(checking, /aria-label="Sign out"/);
});

const renderSignOutPage = (props: Partial<React.ComponentProps<typeof InstituteSignOutPage>> = {}) => renderToStaticMarkup(
  <InstituteSignOutPage
    state="confirm"
    accountName="ABC Public School"
    marketingHome="https://eltnoy.example.test/"
    onSignOut={noop}
    onCancel={noop}
    {...props}
  />,
);

test('Institute sign-out confirmation displays the authenticated account and requires a deliberate sign-out action', () => {
  const markup = renderSignOutPage();
  assert.match(markup, /Sign out of the Institute portal\?/);
  assert.match(markup, /ABC Public School/);
  assert.match(markup, /<button type="button"[^>]*>Sign out<\/button>/);
  assert.match(markup, /<button type="button"[^>]*>Cancel<\/button>/);
});

test('Institute sign-out bridge handles checking, wrong surface, and missing sessions without signing anyone out', () => {
  assert.match(renderSignOutPage({ state: 'checking' }), /Checking Institute session/);
  const wrongSurface = renderSignOutPage({ state: 'wrong_surface' });
  assert.match(wrongSurface, /Open this sign-out link on the Institute website/);
  assert.doesNotMatch(wrongSurface, /<button[^>]*>Sign out<\/button>/);
  const signedOut = renderSignOutPage({ state: 'signed_out' });
  assert.match(signedOut, /No active Institute session/);
  assert.match(signedOut, /Institute sign in/);
  assert.match(signedOut, /href="https:\/\/eltnoy\.example\.test\/"/);
  assert.doesNotMatch(signedOut, /<button[^>]*>Sign out<\/button>/);
});
