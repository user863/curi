import test from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../js/suggest.js';

const list = [['portrait', 90], ['port-city', 40], ['harbour', 30], ['art-nouveau', 20], ['landscape', 10]];
const vocab = { harbour: { de: 'Hafen' } };

test('label starts come before word starts, in use order', () => {
  assert.deepEqual(complete(list, vocab, 'en', 'por').map((s) => s.slug), ['portrait', 'port-city']);
  assert.deepEqual(complete(list, vocab, 'en', 'nou').map((s) => s.slug), ['art-nouveau']);
});

test('completes the last word and keeps the rest', () => {
  assert.equal(complete(list, vocab, 'en', 'oil land')[0].text, 'oil landscape');
});

test('uses the language label', () => {
  assert.equal(complete(list, vocab, 'de', 'haf')[0].label, 'Hafen');
});

test('needs two letters and skips a tag typed in full', () => {
  assert.deepEqual(complete(list, vocab, 'en', 'p'), []);
  assert.deepEqual(complete(list, vocab, 'en', 'portrait'), []);
});
