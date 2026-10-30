import test from 'node:test';
import assert from 'node:assert/strict';
import { FAQ_ITEMS, filterFaqsByCategory, searchFaqs } from './faqData.js';

test('FAQ Data contains comprehensive examination entries', () => {
  assert.ok(FAQ_ITEMS.length >= 6, 'FAQ items should contain at least 6 standard questions');
  const sample = FAQ_ITEMS[0];
  assert.ok(sample.id);
  assert.ok(sample.question);
  assert.ok(sample.answer);
  assert.ok(sample.category);
});

test('filterFaqsByCategory filters correctly', () => {
  const all = filterFaqsByCategory(FAQ_ITEMS, 'all');
  assert.equal(all.length, FAQ_ITEMS.length);

  const admitCardFaqs = filterFaqsByCategory(FAQ_ITEMS, 'admit-card');
  assert.ok(admitCardFaqs.length > 0);
  assert.ok(admitCardFaqs.every((f) => f.category === 'admit-card'));

  const cbtFaqs = filterFaqsByCategory(FAQ_ITEMS, 'cbt-exam');
  assert.ok(cbtFaqs.length >= 2);
  assert.ok(cbtFaqs.every((f) => f.category === 'cbt-exam'));

  const scoringFaqs = filterFaqsByCategory(FAQ_ITEMS, 'scoring');
  assert.ok(scoringFaqs.length >= 1);
});

test('searchFaqs searches by question text, answer, and key points', () => {
  const calcResults = searchFaqs(FAQ_ITEMS, 'calculator');
  assert.ok(calcResults.length >= 1, 'Should find FAQ mentioning calculator');
  assert.ok(calcResults.some((f) => f.id === 'faq-04'));

  const freezeResults = searchFaqs(FAQ_ITEMS, 'freeze');
  assert.ok(freezeResults.length >= 1, 'Should find terminal freeze FAQ');
  assert.ok(freezeResults.some((f) => f.id === 'faq-06'));

  const markingResults = searchFaqs(FAQ_ITEMS, '+4');
  assert.ok(markingResults.length >= 1, 'Should find marking scheme FAQ');
  assert.ok(markingResults.some((f) => f.id === 'faq-03'));

  const emptyResults = searchFaqs(FAQ_ITEMS, 'xyznonexistentword999');
  assert.equal(emptyResults.length, 0);

  const blankSearch = searchFaqs(FAQ_ITEMS, '');
  assert.equal(blankSearch.length, FAQ_ITEMS.length);
});
