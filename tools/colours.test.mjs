import test from 'node:test';
import assert from 'node:assert/strict';
import { hits, nearest, parseHex } from '../js/colours.js';
import { oklab } from '../js/colour.js';

test('hits keeps works in every bucket', () => {
  const b = { blue: { 1: [1, 2, 3], 2: [9] }, dark: { 1: [2, 3, 4], 2: [9] } };
  assert.deepEqual([...hits(b, ['blue', 'dark'])], [[2, 1], [3, 1], [9, 2]].sort());
  assert.equal(hits(b, ['red']).size, 0);
});

test('a hex colour is told from a word and taken out of the query', () => {
  assert.deepEqual(parseHex('#E85D9A portrait'), { hex: '#e85d9a', rest: 'portrait' });
  assert.deepEqual(parseHex('rose #f0a'), { hex: '#ff00aa', rest: 'rose' });
  assert.deepEqual(parseHex('e85d9a'), { hex: '#e85d9a', rest: '' });
  assert.equal(parseHex('decade'), null);
  assert.equal(parseHex('facade of a church'), null);
  assert.equal(parseHex('#12345'), null);
});

test('nearest returns the works closest to a colour first', () => {
  const lab = (hex) => oklab(hex);
  const pack = (hexes) => {
    const buf = new ArrayBuffer(6 * hexes.length);
    const u = new Uint8Array(buf), s = new Int8Array(buf);
    hexes.forEach((hex, id) => {
      if (!hex) return;
      const [L, a, b] = lab(hex);
      u[id * 6] = Math.round(L * 255); s[id * 6 + 1] = Math.round(a / 0.4 * 127); s[id * 6 + 2] = Math.round(b / 0.4 * 127);
    });
    return buf;
  };
  const column = pack([null, '#e85d9a', '#3f7a3a', '#f06aa0', '#2a4d8f']);
  const found = nearest(column, lab('#ee6aa5'));
  assert.deepEqual(found.map((f) => f.id), [3, 1]);
  assert.ok(found[0].d < found[1].d);
});
