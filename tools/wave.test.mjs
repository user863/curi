import test from 'node:test';
import assert from 'node:assert/strict';
import { shape, barsHtml } from '../js/wave.js';

test('a recording always gets the same waveform', () => {
  assert.deepEqual(shape('ia-123'), shape('ia-123'));
  assert.notDeepEqual(shape('ia-123'), shape('ia-124'));
});

test('heights stay in range and the shape has quiet and loud parts', () => {
  const h = shape('wc-9', 96);
  assert.equal(h.length, 96);
  assert.ok(h.every((x) => x >= 0.1 && x <= 1));
  assert.ok(Math.max(...h) - Math.min(...h) > 0.4);
});

test('both layers carry one bar per height, plus the playhead', () => {
  const html = barsHtml([0.2, 0.9, 0.4]);
  assert.equal((html.match(/<i /g) || []).length, 6);
  assert.ok(html.includes('class="head"'));
});
