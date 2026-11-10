// node --test tools/
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile, learn, age, pickNext } from '../js/rank.js';

const unit = (i, dim = 8) => Array.from({ length: dim }, (_, d) => (d === i ? 1 : 0));
const card = { cat: 'visual', editorial: { room: 'r', tags: [] } };
const DAY = 86400;

test('weights add up and fade with half-life 30 days', () => {
  let p = emptyProfile();
  p = learn(p, card, 'save', unit(0));
  p = learn(p, card, 'save', unit(0));
  assert.equal(p.cents.length, 1);
  assert.equal(p.cents[0].w, 2);
  p = age(p, 0);
  p = age(p, 30 * DAY);
  assert.ok(Math.abs(p.cents[0].w - 1) < 1e-9);
});

test('a faded interest is dropped, a picked room is kept', () => {
  let p = { ...emptyProfile(), cents: [{ v: unit(0), n: 1, w: 1, labels: {} }, { v: unit(1), n: 1, w: 1, labels: {}, room: 'x' }], at: 0 };
  p = age(p, 120 * DAY);
  assert.equal(p.cents.length, 1);
  assert.equal(p.cents[0].room, 'x');
});

test('aging does nothing without elapsed time, and sets the clock', () => {
  const p = age(emptyProfile(), 500);
  assert.equal(p.at, 500);
  assert.equal(age(p, 500).cents.length, 0);
});

test('eviction removes the lightest interest, not the oldest', () => {
  let p = emptyProfile();
  const heavy = unit(0);
  for (let i = 0; i < 3; i++) p = learn(p, card, 'save', heavy); // oldest, heaviest
  for (let i = 1; i < 8; i++) p = learn(p, card, 'save', unit(i)); // fills 8
  assert.equal(p.cents.length, 8);
  p = learn(p, card, 'more', unit(1).map((x, d) => (d === 1 ? 0 : d === 2 ? 0.4 : 0.9 * (d === 0 ? 0 : 0.1)))); // new interest far from the rest
  const first = p.cents.find((c) => c.v[0] > 0.99);
  assert.ok(first, 'the heaviest, oldest interest survives');
});

const world = (rows) => ({
  n: rows.length, dim: 2, categories: [{ id: 'visual' }], cat: new Uint8Array(rows.length),
  ids: Uint32Array.from(rows.map((_, i) => i)), posOf: (id) => id, source: Uint8Array.from(rows.map((r) => r[0])),
  creator: Uint16Array.from(rows.map((r) => r[1])), emb: new Int8Array(rows.length * 2).fill(10), quality: new Uint8Array(rows.length),
});

test('repeat caps: at most 2 per source in 10, 1 per creator in 20, relaxed only when nothing else is left', () => {
  // five sources of four works each, every work its own creator; scores prefer the first source
  const index = world(Array.from({ length: 20 }, (_, i) => [Math.floor(i / 4), i]));
  const scores = Float32Array.from({ length: 20 }, (_, i) => 1 - i / 100);
  const shown = [];
  const seen = new Set();
  for (let k = 0; k < 10; k++) {
    const pick = pickNext({ index, profile: emptyProfile(), scores, taken: (id) => seen.has(id), shown, rng: () => 0.5 });
    shown.push(pick.id);
    seen.add(pick.id);
  }
  const per = [0, 1, 2, 3, 4].map((s) => shown.filter((id) => index.source[id] === s).length);
  assert.deepEqual(per, [2, 2, 2, 2, 2]);
  const same = world([[0, 5], [0, 5]]);
  const last = pickNext({ index: same, profile: emptyProfile(), scores: new Float32Array(2), taken: (id) => id === 0, shown: [0], rng: () => 0.5 });
  assert.equal(last.id, 1, 'same creator is allowed when it is all that remains');
});
