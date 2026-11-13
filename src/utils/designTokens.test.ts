import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { approvedPairings, colorTokens, contrastRatio, minimumContrast, relativeLuminance } from './designTokens.ts';

test('contrast ratio matches WCAG reference values', () => {
  assert.equal(relativeLuminance('#FFFFFF'), 1);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(contrastRatio('#000000', '#FFFFFF'), 21);
  assert.equal(contrastRatio('#FFFFFF', '#000000'), 21); // order-independent
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrastRatio('#767676', '#FFFFFF') - 4.54) < 0.01);
  assert.throws(() => relativeLuminance('#FFF'), /Expected #RRGGBB/);
});

test('every approved pairing meets WCAG AA for its use', () => {
  for (const { fg, bg, use } of approvedPairings) {
    const ratio = contrastRatio(colorTokens[fg], colorTokens[bg]);
    assert.ok(ratio >= minimumContrast(use), `${fg} on ${bg} (${use}) is ${ratio.toFixed(2)}:1`);
  }
});

test('large-only colours are not approved for body text on white', () => {
  for (const token of ['teal-600', 'brand-green'] as const) {
    assert.ok(contrastRatio(colorTokens[token], colorTokens.surface) < 4.5, `${token} would pass as body text`);
    assert.ok(!approvedPairings.some((p) => p.fg === token && p.use === 'text'), `${token} listed as body text`);
  }
});

test('index.css @theme declares exactly the TypeScript tokens', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const theme = /@theme\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(theme, 'index.css has an @theme block');
  const declared = Object.fromEntries(
    [...theme.matchAll(/--color-eltnoy-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2].toUpperCase()]),
  );
  assert.deepEqual(declared, Object.fromEntries(Object.entries(colorTokens).map(([k, v]) => [k, v.toUpperCase()])));
});

test('existing brand navy is preserved as the primary token', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, new RegExp(`name="theme-color" content="${colorTokens['navy-800']}"`));
});
