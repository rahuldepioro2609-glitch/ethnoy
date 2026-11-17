import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applicationConfirmationEmail, escapeHtml, passwordResetEmail, portalLink } from './emailTemplates.ts';
import { getMailMode } from './mailer.ts';

describe('email', () => {
  test('chooses SMTP when configured, console in development, nothing in production', () => {
    assert.equal(getMailMode({ SMTP_HOST: 'smtp.example.test', NODE_ENV: 'production' }), 'smtp');
    assert.equal(getMailMode({ NODE_ENV: 'development' }), 'console');
    assert.equal(getMailMode({}), 'console');
    assert.equal(getMailMode({ NODE_ENV: 'production' }), 'disabled');
  });

  test('builds absolute links with encoded parameters', () => {
    assert.equal(portalLink('https://portal.example.test', '/reset-password', { token: 'a b+c' }), 'https://portal.example.test/reset-password?token=a+b%2Bc');
    assert.equal(portalLink('https://portal.example.test/', '/verify-email'), 'https://portal.example.test/verify-email');
  });

  test('escapes user-controlled text in HTML emails', () => {
    assert.equal(escapeHtml(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
    const message = passwordResetEmail('<b>Mallory</b>', 'STU1', 'https://portal.example.test/reset-password?token=abc', 30);
    assert.ok(!message.html.includes('<b>Mallory</b>'));
    assert.ok(message.html.includes('&lt;b&gt;Mallory&lt;/b&gt;'));
    assert.ok(message.text.includes('https://portal.example.test/reset-password?token=abc'));
    assert.ok(message.text.includes('30 minutes'));
  });

  test('application confirmation includes the application number', () => {
    const message = applicationConfirmationEmail({
      candidateName: 'Asha', applicationNumber: 'APP-2026-123456', examCode: 'ENT-2026', examName: 'National Test', dashboardUrl: 'https://portal.example.test/dashboard/candidate',
    });
    assert.ok(message.subject.includes('APP-2026-123456'));
    assert.ok(message.text.includes('National Test (ENT-2026)'));
  });
});
