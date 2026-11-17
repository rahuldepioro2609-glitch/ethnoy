import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectMimeType, sanitizeFileName, validateUpload } from './fileRules.ts';

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const pdf = new TextEncoder().encode('%PDF-1.7\n');

describe('upload file rules', () => {
  test('detects file types from content, not names', () => {
    assert.equal(detectMimeType(jpeg), 'image/jpeg');
    assert.equal(detectMimeType(png), 'image/png');
    assert.equal(detectMimeType(pdf), 'application/pdf');
    assert.equal(detectMimeType(new TextEncoder().encode('<svg onload=alert(1)>')), null);
    assert.equal(detectMimeType(new Uint8Array()), null);
  });

  test('accepts images for photos and signatures but not PDFs', () => {
    assert.deepEqual(validateUpload('photo', jpeg), { mimeType: 'image/jpeg' });
    assert.deepEqual(validateUpload('signature', png), { mimeType: 'image/png' });
    assert.ok('error' in validateUpload('photo', pdf));
    assert.deepEqual(validateUpload('objection_document', pdf), { mimeType: 'application/pdf' });
  });

  test('rejects empty and oversized files', () => {
    assert.ok('error' in validateUpload('photo', new Uint8Array()));
    const oversized = new Uint8Array(300 * 1024 + 1);
    oversized.set(jpeg);
    const result = validateUpload('photo', oversized);
    assert.ok('error' in result && result.error.includes('300 KB'));
  });

  test('sanitizes display file names', () => {
    assert.equal(sanitizeFileName('..%2F..%2Fetc%2Fpasswd'), 'passwd');
    assert.equal(sanitizeFileName('C:\\scans\\proof "1".pdf'), 'proof 1.pdf');
    assert.equal(sanitizeFileName('%E0%A4%AA%E0%A5%8D.pdf'), 'प्.pdf');
    assert.equal(sanitizeFileName(''), null);
    assert.equal(sanitizeFileName(undefined), null);
    assert.equal(sanitizeFileName('a'.repeat(300))?.length, 120);
  });
});
