import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
const { createGoogleVerifier, generatedStudentLoginId, googleClientId } = await import('./google.ts');

const CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
const google = await generateKeyPair('RS256');
const attacker = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(google.publicKey)), kid: 'google-1', alg: 'RS256', use: 'sig' }] });
const verify = createGoogleVerifier(CLIENT_ID, keys);

function token(claims: Record<string, unknown>, options: { key?: CryptoKey; audience?: string; issuer?: string; expiresIn?: string } = {}) {
  return new SignJWT({ email: 'Student@Example.com', email_verified: true, name: 'Asha Rao', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'google-1' })
    .setSubject('109876543210')
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '10m')
    .sign(options.key ?? google.privateKey);
}

describe('Google ID token verification', () => {
  test('accepts a token signed by Google for this client', async () => {
    assert.deepEqual(await verify(await token({})), {
      sub: '109876543210',
      email: 'student@example.com',
      emailVerified: true,
      name: 'Asha Rao',
    });
    assert.equal((await verify(await token({}, { issuer: 'accounts.google.com' }))).sub, '109876543210');
  });

  test('reports an unverified Google email', async () => {
    assert.equal((await verify(await token({ email_verified: false }))).emailVerified, false);
  });

  test('rejects tokens for another app, from another issuer, expired, or not signed by Google', async () => {
    await assert.rejects(verify(await token({}, { audience: 'other.apps.googleusercontent.com' })));
    await assert.rejects(verify(await token({}, { issuer: 'https://evil.example' })));
    await assert.rejects(verify(await token({}, { expiresIn: '-5m' })));
    await assert.rejects(verify(await token({}, { key: attacker.privateKey })));
    await assert.rejects(verify('not.a.token'));
  });

  test('rejects a token without an email', async () => {
    await assert.rejects(verify(await token({ email: undefined })));
  });
});

describe('Google sign-in settings', () => {
  test('uses GOOGLE_CLIENT_ID only when it looks like a Google OAuth client ID', () => {
    assert.equal(googleClientId({ GOOGLE_CLIENT_ID: ` ${CLIENT_ID} ` }), CLIENT_ID);
    assert.equal(googleClientId({ GOOGLE_CLIENT_ID: 'something-else' }), null);
    assert.equal(googleClientId({}), null);
  });

  test('generated student login IDs are STU plus eight digits', () => {
    for (let i = 0; i < 50; i += 1) assert.match(generatedStudentLoginId(), /^STU\d{8}$/);
  });
});
