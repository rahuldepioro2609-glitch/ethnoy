import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allowedOrigins, primaryOrigin, redirectTarget } from './hosting.ts';

describe('hosting', () => {
  const env = { CANONICAL_HOST: 'eltnoy.com', REDIRECT_HOSTS: 'eltnoy.in, www.eltnoy.in ,www.eltnoy.com' };

  test('redirects .in and www hosts to the .com domain, keeping path and query', () => {
    assert.equal(redirectTarget('eltnoy.in', '/login/candidate?x=1', env), 'https://eltnoy.com/login/candidate?x=1');
    assert.equal(redirectTarget('WWW.ELTNOY.IN:443', '/', env), 'https://eltnoy.com/');
    assert.equal(redirectTarget('www.eltnoy.com', '/terms', env), 'https://eltnoy.com/terms');
  });

  test('leaves the canonical host and unlisted hosts alone', () => {
    assert.equal(redirectTarget('eltnoy.com', '/', env), null);
    assert.equal(redirectTarget('eltnoy-portal.onrender.com', '/api/health', env), null);
    assert.equal(redirectTarget('eltnoy.in', '/', {}), null);
    assert.equal(redirectTarget(undefined, '/', env), null);
  });

  test('accepts several allowed origins; the first is primary', () => {
    const origins = { APP_ORIGIN: 'https://eltnoy.com/, https://eltnoy-portal.onrender.com' };
    assert.deepEqual(allowedOrigins(origins), ['https://eltnoy.com', 'https://eltnoy-portal.onrender.com']);
    assert.equal(primaryOrigin(origins), 'https://eltnoy.com');
    assert.equal(primaryOrigin({}), 'http://localhost:3000');
  });
});

describe('staff portal host rules', async () => {
  const { staffPortalAllowed } = await import('./hosting.ts');
  test('only STAFF_HOSTS may use the staff portal once it is set', () => {
    const env = { STAFF_HOSTS: 'eltnoy-portal.onrender.com' };
    assert.equal(staffPortalAllowed('eltnoy-portal.onrender.com', env), true);
    assert.equal(staffPortalAllowed('ELTNOY-PORTAL.onrender.com:443', env), true);
    assert.equal(staffPortalAllowed('eltnoy.com', env), false);
    assert.equal(staffPortalAllowed('eltnoy.in', env), false);
    assert.equal(staffPortalAllowed(undefined, env), false);
  });
  test('everything is allowed when STAFF_HOSTS is unset (local development)', () => {
    assert.equal(staffPortalAllowed('localhost', {}), true);
  });
});
