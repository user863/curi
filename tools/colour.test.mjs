import test from 'node:test';
import assert from 'node:assert/strict';
import { complement, luminance, MAT } from '../js/colour.js';

const hex = /^#[0-9a-f]{6}$/;

test('a mat is a valid colour set apart from the picture in lightness', () => {
  for (const picture of ['#1a2b4c', '#e8d8c0', '#c0392b', '#4f7f3a', '#f2f2f2', '#101010']) {
    const mat = complement(picture, 'x');
    assert.match(mat, hex);
    assert.ok(Math.abs(luminance(mat) - luminance(picture)) > 0.1, `${picture} -> ${mat}`);
  }
});

test('a grey picture gets a striking hue chosen by the seed', () => {
  const mats = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => complement('#808080', s)));
  assert.ok(mats.size > 3);
  assert.equal(complement('#808080', 'a'), complement('#808080', 'a'));
});

test('a green picture is matched with a pink or violet mat', () => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(complement('#3f7a3a', 'x').slice(i, i + 2), 16));
  assert.ok(r > g, 'warm side of the wheel');
});

test('the hue map moves the mat of one hue and blends in between', () => {
  const picture = '#c0392b';
  const base = complement(picture, 'x');
  const map = [...MAT.map];
  map.fill(120);
  const moved = complement(picture, 'x', { map });
  assert.notEqual(base, moved);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(moved.slice(i, i + 2), 16));
  assert.ok(g > r && g > b, 'a green mat');
});
