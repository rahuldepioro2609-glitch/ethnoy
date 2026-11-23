import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPortalHint,
  encodePortalHint,
  PORTAL_HINT_COOKIE,
  PORTAL_HINT_MAX_AGE_SECONDS,
  portalHintCookieDomain,
  readPortalHint,
  writePortalHint,
} from './portalHint.ts';

const live = { hostname: 'institution.eltnoy.com', protocol: 'https:' };

test('the hint is shared with the parent domain only, never with IPs, localhost or bare domains', () => {
  assert.equal(portalHintCookieDomain('institution.eltnoy.com'), 'eltnoy.com');
  assert.equal(portalHintCookieDomain('Institution.ELTNOY.com.'), 'eltnoy.com');
  assert.equal(portalHintCookieDomain('institution.127.0.0.1.nip.io'), '127.0.0.1.nip.io');
  for (const host of ['eltnoy.com', 'localhost', '127.0.0.1', '::1', '']) assert.equal(portalHintCookieDomain(host), null, host);
});

test('write sets a 12-hour, Secure, Lax, parent-domain cookie holding only the role and display name', () => {
  const target = { cookie: '' };
  writePortalHint(target, live, { role: 'center', name: 'Demo Public School' });
  assert.equal(target.cookie, `${PORTAL_HINT_COOKIE}=v1.center.Demo%20Public%20School; Path=/; Max-Age=${PORTAL_HINT_MAX_AGE_SECONDS}; SameSite=Lax; Domain=eltnoy.com; Secure`);
  assert.equal(PORTAL_HINT_MAX_AGE_SECONDS, 12 * 60 * 60, 'same lifetime as a session');
  const local = { cookie: '' };
  writePortalHint(local, { hostname: '127.0.0.1', protocol: 'http:' }, { role: 'center', name: 'X' });
  assert.doesNotMatch(local.cookie, /Domain=|Secure/, 'host-only and not Secure on plain-http local hosts');
});

test('read round-trips the name, cleans it, and ignores anything malformed or for another role', () => {
  const value = encodePortalHint({ role: 'center', name: '  Shri Ram Vidyalaya; Gwalior & Sons  ' })!;
  assert.deepEqual(readPortalHint(`a=1; ${PORTAL_HINT_COOKIE}=${value}; b=2`), { role: 'center', name: 'Shri Ram Vidyalaya; Gwalior & Sons' });
  assert.equal(readPortalHint(`${PORTAL_HINT_COOKIE}=v1.center.${encodeURIComponent('A\u0000B\nC')}`)?.name, 'ABC', 'control characters removed');
  assert.equal(readPortalHint(`${PORTAL_HINT_COOKIE}=v1.center.${encodeURIComponent('x'.repeat(200))}`)?.name.length, 80, 'length capped');
  for (const bad of ['', 'other=1', `${PORTAL_HINT_COOKIE}=`, `${PORTAL_HINT_COOKIE}=v1.official.Admin`, `${PORTAL_HINT_COOKIE}=v1.candidate.Student`,
    `${PORTAL_HINT_COOKIE}=center.Name`, `${PORTAL_HINT_COOKIE}=v1.center.%E0%A4`, `${PORTAL_HINT_COOKIE}=v1.center.%20%20`]) {
    assert.equal(readPortalHint(bad), null, bad);
  }
  assert.equal(encodePortalHint({ role: 'center', name: '   ' }), null, 'an empty name is never stored');
  const target = { cookie: '' };
  writePortalHint(target, live, { role: 'center', name: '\u0000' });
  assert.equal(target.cookie, '', 'nothing written for an unusable name');
});

test('clear expires both the parent-domain and the host-only copy', () => {
  const writes: string[] = [];
  const target = { set cookie(value: string) { writes.push(value); }, get cookie() { return ''; } };
  clearPortalHint(target, live);
  assert.deepEqual(writes, [
    `${PORTAL_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Domain=eltnoy.com; Secure`,
    `${PORTAL_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`,
  ]);
});
