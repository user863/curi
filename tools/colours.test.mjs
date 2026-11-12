import test from 'node:test';
import assert from 'node:assert/strict';
import { hits } from '../js/colours.js';

test('hits keeps works in every bucket', () => {
  const b = { blue: { 1: [1, 2, 3], 2: [9] }, dark: { 1: [2, 3, 4], 2: [9] } };
  assert.deepEqual([...hits(b, ['blue', 'dark'])], [[2, 1], [3, 1], [9, 2]].sort());
  assert.equal(hits(b, ['red']).size, 0);
});
