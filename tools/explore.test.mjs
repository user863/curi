// node --test tools/
import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreScores, compose, beta, pickGalleries } from '../js/explore.js';
import { emptyProfile, learn } from '../js/rank.js';

const DIM = 8;
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const unit = (i) => Array.from({ length: DIM }, (_, d) => (d === i ? 1 : 0));

// 4 regions x 50 works, quality rising within each, 8 sources
const build = () => {
  const n = 200;
  const emb = new Int8Array(n * DIM);
  const quality = new Uint8Array(n);
  const room = new Uint8Array(n);
  const source = new Uint8Array(n);
  const rng = seeded(1);
  for (let i = 0; i < n; i++) {
    const r = i % 4;
    room[i] = r;
    source[i] = (i >> 2) % 8;
    quality[i] = 40 + (i >> 2) * 3;
    for (let d = 0; d < DIM; d++) emb[i * DIM + d] = Math.round((d === r ? 120 : 0) + (rng() - 0.5) * 20);
  }
  return { n, dim: DIM, emb, quality, room, source, cat: new Uint8Array(n), ids: Uint32Array.from({ length: n }, (_, i) => i), rooms: ['a', 'b', 'c', 'd'], categories: ['visual'] };
};
const card = (room) => ({ cat: 'visual', editorial: { room, tags: [] } });

test('beta draws stay in (0,1) and follow their mean', () => {
  const rng = seeded(3);
  const draws = Array.from({ length: 4000 }, () => beta(8, 2, rng));
  assert.ok(draws.every((x) => x > 0 && x < 1));
  assert.ok(Math.abs(draws.reduce((s, x) => s + x, 0) / draws.length - 0.8) < 0.02);
});

test('an interest pulls its region to the front', () => {
  const index = build();
  const p = learn(learn(emptyProfile(), card('b'), 'save', unit(1)), card('b'), 'save', unit(1));
  const scores = exploreScores({ index, profile: p, rng: seeded(5) });
  const picks = compose({ index, scores, count: 24, rng: seeded(6), profile: p });
  const inRegion = picks.filter((i) => index.room[i] === 1).length;
  assert.ok(inRegion >= 14, `${inRegion} of 24 in the liked region`);
  assert.ok(picks.some((i) => index.room[i] !== 1), 'the wildcard leaves the region');
});

test('no profile: quality with variety, every region shown', () => {
  const index = build();
  const p = emptyProfile();
  const picks = compose({ index, scores: exploreScores({ index, profile: p, rng: seeded(9) }), count: 24, rng: seeded(10), profile: p });
  assert.equal(new Set(picks).size, 24);
  assert.equal(new Set(picks.map((i) => index.room[i])).size, 4);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(mean(picks.map((i) => index.quality[i])) > mean([...index.quality]) + 15);
});

test('source cap holds per page', () => {
  const index = build();
  const p = emptyProfile();
  const picks = compose({ index, scores: exploreScores({ index, profile: p, rng: seeded(2) }), count: 12, rng: seeded(4), profile: p });
  const per = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => picks.filter((i) => index.source[i] === s).length);
  assert.ok(Math.max(...per) <= 4, String(per));
});

test('skipped works are never chosen; same seed gives the same wall', () => {
  const index = build();
  const p = emptyProfile();
  const run = () => compose({ index, scores: exploreScores({ index, profile: p, rng: seeded(7), skip: (i) => i < 100 }), count: 24, rng: seeded(8), profile: p });
  const a = run();
  assert.ok(a.every((i) => i >= 100));
  assert.deepEqual(a, run());
});

test('a disliked region is kept out', () => {
  const index = build();
  const p = learn(learn(learn(emptyProfile(), card('c'), 'less', unit(2)), card('c'), 'less', unit(2)), card('a'), 'save', unit(0));
  const picks = compose({ index, scores: exploreScores({ index, profile: p, rng: seeded(11) }), count: 18, rng: seeded(12), profile: p });
  assert.ok(picks.filter((i) => index.room[i] === 2).length <= 3);
});

test('monochrome pictures are discouraged, not hidden', () => {
  const index = build();
  index.flags = new Uint8Array(index.n);
  for (let i = 0; i < index.n; i++) if (index.room[i] === 0) index.flags[i] = 1; // one region is all monochrome
  const p = emptyProfile();
  const picks = compose({ index, scores: exploreScores({ index, profile: p, rng: seeded(21) }), count: 24, rng: seeded(22), profile: p });
  const mono = picks.filter((i) => index.flags[i]).length;
  assert.ok(mono <= 3, `${mono} of 24 monochrome`);
  const interested = learn(learn(emptyProfile(), card('a'), 'save', unit(0)), card('a'), 'save', unit(0));
  const wanted = compose({ index, scores: exploreScores({ index, profile: interested, rng: seeded(23) }), count: 24, rng: seeded(24), profile: interested });
  assert.ok(wanted.some((i) => index.flags[i]), 'a reader who saves monochrome still gets some');
});

test('galleries: interest and quality lead, picks differ from each other', () => {
  const v = (i) => unit(i).map((x) => x * 127);
  const galleries = [0, 1, 2, 3, 4, 5].map((i) => ({ s: `g${i}`, t: `G${i}`, q: 100 + i * 10, v: v(i % 4), ids: [i] }));
  const p = learn(learn(emptyProfile(), card('b'), 'save', unit(1)), card('b'), 'save', unit(1));
  const picks = pickGalleries({ galleries, profile: p, count: 3, rng: seeded(31) });
  assert.equal(new Set(picks.map((g) => g.s)).size, 3);
  assert.ok(picks.slice(0, 2).some((g) => g.v[1] > 100), 'a liked gallery is featured early');
  assert.deepEqual(pickGalleries({ galleries, profile: emptyProfile(), count: 2, rng: seeded(32), exclude: new Set(['g5', 'g4']) }).map((g) => g.s).every((s) => s !== 'g5' && s !== 'g4'), true);
});
