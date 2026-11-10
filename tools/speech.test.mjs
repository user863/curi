import test from 'node:test';
import assert from 'node:assert/strict';
import { chunks } from '../js/speech.js';

const prose = 'Begin the morning by saying to thyself, I shall meet the busybody. All these things happen to them by reason of ignorance! Is it not so?';
const verse = 'Success is counted sweetest\nBy those who ne\'er succeed.\nTo comprehend a nectar\nRequires sorest need.\n\nNot one of all the purple host\nWho took the flag to-day';

test('chunks map back to the body and keep their order', () => {
  for (const [body, isVerse] of [[prose, false], [verse, true]]) {
    const cs = chunks(body, isVerse);
    assert.ok(cs.length >= 3);
    cs.forEach((c, k) => {
      assert.equal(body.slice(c.start, c.end), c.text);
      if (k) assert.ok(c.start >= cs[k - 1].end);
    });
  }
  assert.equal(chunks(prose, false).length, 3);
});

test('verse reads line by line, with a longer pause between stanzas', () => {
  const cs = chunks(verse, true);
  assert.equal(cs.length, 6);
  assert.ok(cs[3].gap > cs[2].gap);
});
