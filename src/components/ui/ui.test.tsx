import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { colorTokens, contrastRatio } from '../../utils/designTokens.ts';
import {
  Button, buttonVariants, Card, Checkbox, DataTable, EmptyState, ErrorState, LoadingState,
  SelectField, StatusBadge, TextArea, TextField, humanizeStatus, statusTone, toneStyles,
} from './index.ts';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const attr = (markup: string, tag: string, name: string): string[] =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const ids = (markup: string) => new Set([...markup.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));

// ---------- Contrast ----------

test('every badge tone and button variant meets WCAG AA (4.5:1) for its label text', () => {
  for (const [name, { fg, bg }] of Object.entries(toneStyles)) {
    const ratio = contrastRatio(colorTokens[fg], colorTokens[bg]);
    assert.ok(ratio >= 4.5, `tone ${name}: ${ratio.toFixed(2)}:1`);
  }
  for (const [name, { fg, bg }] of Object.entries(buttonVariants)) {
    const ratio = contrastRatio(colorTokens[fg], colorTokens[bg]);
    assert.ok(ratio >= 4.5, `button ${name}: ${ratio.toFixed(2)}:1`);
  }
});

test('tone and variant classes use the tokens they declare (contrast test checks what renders)', () => {
  for (const { fg, bg, className } of [...Object.values(toneStyles), ...Object.values(buttonVariants)]) {
    assert.match(className, new RegExp(`(^|\\s)text-eltnoy-${fg}(\\s|$)`));
    if (bg !== 'surface' || className.includes('bg-eltnoy-surface ')) {
      assert.match(className, new RegExp(`(^|\\s)bg-(eltnoy-${bg}|transparent)(\\s|$)`));
    }
  }
});

test('every eltnoy colour class in the UI source names a real token (typos render no style)', () => {
  const dir = new URL('./', import.meta.url);
  const known = new Set(Object.keys(colorTokens));
  for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.tsx'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/-eltnoy-([a-z0-9-]+?)(?:\/\d+)?(?=[\s'"`])/g)) {
      assert.ok(known.has(match[1]), `${file}: unknown token "${match[1]}"`);
    }
  }
});

// ---------- Button ----------

test('Button defaults to type="button" so it never submits a form by accident', () => {
  assert.deepEqual(attr(html(<Button>Save</Button>), 'button', 'type'), ['button']);
  assert.deepEqual(attr(html(<Button type="submit">Send</Button>), 'button', 'type'), ['submit']);
});

test('Button loading state: busy, disabled, label kept, spinner hidden from assistive technology', () => {
  const markup = html(<Button loading>Submitting</Button>);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /<button[^>]*disabled=""/);
  assert.match(markup, />Submitting</);
  assert.match(markup, /<svg aria-hidden="true" focusable="false"/);
  assert.doesNotMatch(html(<Button>Idle</Button>), /aria-busy|disabled=""/);
});

test('Button: visible keyboard focus ring, 44px default target, decorative icon hidden', () => {
  const markup = html(<Button icon={<b>i</b>}>Go</Button>);
  assert.match(markup, /focus-visible:outline-eltnoy-teal-600/);
  assert.match(markup, /min-h-11/);
  assert.match(markup, /<span aria-hidden="true"[^>]*><b>i<\/b><\/span>/);
});

// ---------- Form controls ----------

test('TextField links label, hint and error; marks invalid and required', () => {
  const markup = html(<TextField label="Full name" hint="As on your ID" error="Enter your name" required />);
  const [inputId] = attr(markup, 'input', 'id');
  assert.ok(inputId);
  assert.deepEqual(attr(markup, 'label', 'for'), [inputId]);
  const describedBy = attr(markup, 'input', 'aria-describedby')[0].split(' ');
  assert.equal(describedBy.length, 2);
  for (const id of describedBy) assert.ok(ids(markup).has(id), `described-by target ${id} exists`);
  assert.match(markup, /<input[^>]*aria-invalid="true"/);
  assert.match(markup, /<input[^>]*required=""/);
  assert.match(markup, /<span aria-hidden="true"[^>]*>\*<\/span>/); // asterisk is visual only; `required` carries meaning
});

test('TextField without error or hint has no aria-invalid or dangling aria-describedby', () => {
  const markup = html(<TextField label="Email" type="email" />);
  assert.doesNotMatch(markup, /aria-invalid|aria-describedby/);
  assert.deepEqual(attr(markup, 'input', 'type'), ['email']);
});

test('fields rendered together get distinct ids; an explicit id is respected', () => {
  const markup = html(<form><TextField label="A" /><TextArea label="B" /><SelectField label="C" options={[]} /><Checkbox label="D" /></form>);
  const labelled = attr(markup, 'label', 'for');
  assert.equal(new Set(labelled).size, 4);
  for (const id of labelled) assert.ok(ids(markup).has(id));
  assert.deepEqual(attr(html(<TextField id="dob" label="Date of birth" />), 'input', 'id'), ['dob']);
});

test('SelectField renders a disabled empty placeholder and every option', () => {
  const markup = html(<SelectField label="Category" placeholder="Choose…" error="Required" options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', disabled: true }]} />);
  assert.match(markup, /<option value="" disabled="">Choose…<\/option>/);
  assert.match(markup, /<option value="a">Alpha<\/option>/);
  assert.match(markup, /<option value="b" disabled="">Beta<\/option>/);
  assert.match(markup, /<select[^>]*aria-invalid="true"/);
});

test('Checkbox is a real checkbox with an associated label', () => {
  const markup = html(<Checkbox label="I confirm the details are correct" required />);
  const [id] = attr(markup, 'input', 'id');
  assert.deepEqual(attr(markup, 'input', 'type'), ['checkbox']);
  assert.deepEqual(attr(markup, 'label', 'for'), [id]);
});

// ---------- Status badge ----------

test('StatusBadge always shows text, so colour is never the only signal', () => {
  assert.match(html(<StatusBadge status="under_review" />), />Under review<\/span>$/);
  assert.match(html(<StatusBadge status="approved" label="स्वीकृत" />), /स्वीकृत/);
  assert.match(html(<StatusBadge status="rejected" />), /text-eltnoy-danger/);
});

test('statusTone covers existing database statuses and falls back to neutral', () => {
  assert.equal(statusTone('approved'), 'success');
  assert.equal(statusTone('rejected'), 'danger');
  assert.equal(statusTone('under_review'), 'warning');
  assert.equal(statusTone('submitted'), 'info');
  assert.equal(statusTone('something_new'), 'neutral');
  assert.equal(humanizeStatus('expired_pending_scoring'), 'Expired pending scoring');
  assert.equal(humanizeStatus(''), '');
});

// ---------- States ----------

test('LoadingState is a polite live region with readable text', () => {
  const markup = html(<LoadingState label="Loading applications…" />);
  assert.match(markup, /^<div role="status" aria-live="polite"/);
  assert.match(markup, /Loading applications…/);
  assert.match(markup, /motion-safe:animate-spin/); // no spinning when reduced motion is requested
});

test('ErrorState is an alert; retry button appears only with a handler', () => {
  assert.match(html(<ErrorState />), /^<div role="alert"/);
  assert.doesNotMatch(html(<ErrorState />), /<button/);
  const markup = html(<ErrorState onRetry={() => undefined} retryLabel="Reload" />);
  assert.match(markup, /<button type="button"[^>]*>.*Reload/);
});

test('EmptyState shows title, description and action; icon is decorative', () => {
  const markup = html(<EmptyState title="No applications" description="Applications appear here." icon={<i />} action={<Button>Browse</Button>} />);
  assert.match(markup, /No applications/);
  assert.match(markup, /Applications appear here\./);
  assert.match(markup, /<div aria-hidden="true"[^>]*><i><\/i><\/div>/);
  assert.match(markup, /Browse/);
});

// ---------- Card ----------

test('titled Card is a section labelled by its heading at the requested level', () => {
  const markup = html(<Card title="Recent applications" headingLevel={3}>Body</Card>);
  const [labelledBy] = attr(markup, 'section', 'aria-labelledby');
  assert.ok(labelledBy);
  assert.match(markup, new RegExp(`<h3 id="${labelledBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html(<Card>Plain</Card>), /^<div/);
});

// ---------- Table ----------

type Row = { id: string; name: string; status: string };
const columns = [
  { key: 'name', header: 'Name', render: (r: Row) => r.name, isRowHeader: true },
  { key: 'status', header: 'Status', render: (r: Row) => <StatusBadge status={r.status} /> },
];

test('DataTable: caption, labelled focusable scroll region, column and row headers', () => {
  const markup = html(<DataTable caption="Applications" columns={columns} rows={[{ id: '1', name: 'Synthetic A', status: 'approved' }]} rowKey={(r) => r.id} />);
  assert.match(markup, /^<div role="region" aria-label="Applications" tabindex="0"/);
  assert.match(markup, /<caption[^>]*>Applications<\/caption>/);
  assert.equal(attr(markup, 'th', 'scope').filter((s) => s === 'col').length, 2);
  assert.match(markup, /<th scope="row"[^>]*>Synthetic A<\/th>/);
  assert.match(markup, />Approved<\/span>/);
});

test('DataTable empty and loading states span all columns; loading marks the table busy', () => {
  const empty = html(<DataTable caption="Applications" columns={columns} rows={[]} rowKey={(r) => r.id} emptyTitle="No applications yet" />);
  assert.match(empty, /<td colSpan="2">|<td colspan="2">/i);
  assert.match(empty, /No applications yet/);
  const loading = html(<DataTable caption="Applications" captionHidden columns={columns} rows={[{ id: '1', name: 'x', status: 'approved' }]} rowKey={(r) => r.id} loading />);
  assert.match(loading, /<table aria-busy="true"/);
  assert.match(loading, /role="status"/);
  assert.doesNotMatch(loading, />x</); // stale rows are not shown while loading
  assert.match(loading, /<caption class="sr-only">/);
});

// ---------- Font ----------

test('Plus Jakarta Sans is bundled locally with its licence; no remote font request', () => {
  const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
  const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2);
  for (const url of urls) {
    assert.match(url, /^\/fonts\/plus-jakarta-sans\/[a-z-]+\.woff2$/);
    const bytes = readFileSync(new URL(`../../../public${url}`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${url} is a WOFF2 file`);
  }
  assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|@import\s+url\(['"]?https?:/);
  assert.match(css, /--font-sans: 'Plus Jakarta Sans', system-ui/);
  const stack = /--font-sans:([^;]+);/.exec(css)?.[1] ?? '';
  for (const fallback of ['Nirmala UI', 'Noto Sans Devanagari', 'Kohinoor Devanagari', 'Noto Sans Bengali', 'Bangla Sangam MN', 'Noto Sans Kannada', 'Kannada Sangam MN']) {
    assert.ok(stack.includes(`'${fallback}'`), `Indic fallback ${fallback} is in the stack`);
  }
  assert.match(stack.trim(), /sans-serif$/);
  const licence = readFileSync(new URL('../../../public/fonts/plus-jakarta-sans/OFL.txt', import.meta.url), 'utf8');
  assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
  const index = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /fonts\.googleapis|fonts\.gstatic/);
});
