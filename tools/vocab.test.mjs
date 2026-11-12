import test from 'node:test';
import assert from 'node:assert/strict';
import { tagLabel } from '../js/vocab.js';

test('tagLabel uses the language when known, else the slug', () => {
  const vocab = { 'black-and-white': { de: 'Schwarzweiß' } };
  assert.equal(tagLabel(vocab, 'black-and-white', 'de'), 'Schwarzweiß');
  assert.equal(tagLabel(vocab, 'black-and-white', 'en'), 'black and white');
  assert.equal(tagLabel(vocab, 'sea-gull', 'de'), 'sea gull');
  assert.equal(tagLabel(undefined, 'x-y'), 'x y');
});
