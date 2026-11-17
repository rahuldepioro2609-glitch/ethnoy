import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fitWithin, formatBytes } from './fileUpload.ts';

describe('image upload helpers', () => {
  test('scales large images down to fit, keeping aspect ratio', () => {
    assert.deepEqual(fitWithin(3000, 4000, 360, 480), { width: 360, height: 480 });
    assert.deepEqual(fitWithin(4000, 1000, 600, 200), { width: 600, height: 150 });
  });

  test('never scales small images up', () => {
    assert.deepEqual(fitWithin(200, 250, 360, 480), { width: 200, height: 250 });
  });

  test('handles invalid sizes', () => {
    assert.deepEqual(fitWithin(0, 100, 360, 480), { width: 0, height: 0 });
  });

  test('formats byte counts', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(150 * 1024), '150 KB');
    assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB');
  });
});
