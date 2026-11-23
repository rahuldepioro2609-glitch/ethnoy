import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import {
  parsePasswordCredentialInput,
  verifyBcryptPassword,
} from './passwords.js';

test('bcrypt compatibility adapter verifies a synthetic existing-format hash', async () => {
  const password = 'Synthetic-Official-Password-42!';
  const hash = await bcrypt.hash(password, 10);
  assert.equal(await verifyBcryptPassword(password, hash), true);
});

test('invalid password and malformed stored hashes fail closed without throwing', async () => {
  const hash = await bcrypt.hash('Synthetic-Official-Password-42!', 10);
  assert.equal(await verifyBcryptPassword('wrong password', hash), false);
  assert.equal(await verifyBcryptPassword('password', 'not-a-bcrypt-hash'), false);
  assert.equal(await verifyBcryptPassword('password', undefined), false);
});

test('malformed credential input and oversized bcrypt input are rejected', async () => {
  assert.equal(parsePasswordCredentialInput({ loginId: 'OFFICIAL-1', password: 'a', extra: true }), undefined);
  assert.equal(parsePasswordCredentialInput({ loginId: '', password: 'password' }), undefined);
  assert.equal(parsePasswordCredentialInput({ loginId: 'OFFICIAL-1', password: 'a'.repeat(129) }), undefined);

  const legacyPasswordPrefix = 'a'.repeat(72);
  const legacyHash = await bcrypt.hash(legacyPasswordPrefix, 4);
  assert.equal(await verifyBcryptPassword(`${legacyPasswordPrefix}suffix`, legacyHash), true);
});
