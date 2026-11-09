// Synthetic scale test: node tools/bench.mjs [works]. Measures ranking at N works.
import { emptyProfile, learn, withRoom, scoreAll, pickNext, shares } from '../js/rank.js';

const N = Number(process.argv[2] || 100000);
const DIM = 64;
let seed = 42;
const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const categories = ['visual', 'text', 'video', 'audio'].map((id) => ({ id }));
const ids = Uint32Array.from({ length: N }, (_, i) => i);
const cat = Uint8Array.from({ length: N }, () => Math.floor(rng() * 4));
const quality = Uint8Array.from({ length: N }, () => Math.floor(rng() * 100));
const centers = Array.from({ length: 200 }, () => Array.from({ length: DIM }, () => rng() - 0.5));
const emb = new Int8Array(N * DIM);
for (let i = 0; i < N; i++) {
  const c = centers[Math.floor(rng() * 200)];
  const v = c.map((x) => x + (rng() - 0.5) * 0.3);
  const n = Math.hypot(...v);
  v.forEach((x, d) => { emb[i * DIM + d] = Math.round((x / n) * 127); });
}
const index = { n: N, dim: DIM, ids, cat, quality, emb, categories, posOf: (id) => id };
const vecOf = (i) => { const v = Array.from(emb.subarray(i * DIM, (i + 1) * DIM)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const card = (i) => ({ cat: categories[cat[i]].id, editorial: { room: 'r', tags: ['a', 'b'] } });

const time = (label, fn, reps = 1) => {
  const t0 = performance.now();
  let out;
  for (let r = 0; r < reps; r++) out = fn();
  console.log(`${label.padEnd(34)} ${((performance.now() - t0) / reps).toFixed(1)} ms`);
  return out;
};

console.log(`works: ${N.toLocaleString()}  index: ${((N * (DIM + 7)) / 1e6).toFixed(1)} MB`);
let profile = emptyProfile();
time('scoreAll, cold start (no interests)', () => scoreAll(index, profile));
profile = withRoom(profile, 'x', true, vecOf(3), { visual: 1 });
for (const i of [10, 500, 9000, 70000 % N, 123]) profile = learn(profile, card(i), 'save', vecOf(i));
profile = learn(profile, card(77), 'less', vecOf(77));
console.log(`interests: ${profile.cents.length} positive, ${profile.negs.length} negative`);
let scores = time('scoreAll, 6+3 interests', () => scoreAll(index, profile), 5);

const seen = new Set();
const shown = [];
const taken = (id) => seen.has(id);
const counts = {};
time('pickNext x100 (scores cached)', () => {
  for (let k = 0; k < 100; k++) {
    const pick = pickNext({ index, profile, scores, taken, shown, rng });
    seen.add(pick.id);
    shown.push(pick.id);
    counts[pick.category] = (counts[pick.category] || 0) + 1;
  }
}, 1);
console.log('first 100 picks by category:', counts);
console.log('target shares:', Object.fromEntries(Object.entries(shares(profile, categories.map((c) => c.id))).map(([k, v]) => [k, +v.toFixed(2)])));
const flat = emptyProfile();
const seen2 = new Set(); const shown2 = []; const c2 = {};
const s2 = scoreAll(index, flat);
for (let k = 0; k < 200; k++) { const p = pickNext({ index, profile: flat, scores: s2, taken: (id) => seen2.has(id), shown: shown2, rng }); seen2.add(p.id); shown2.push(p.id); c2[p.category] = (c2[p.category] || 0) + 1; }
console.log('cold start, 200 picks by category:', c2);
console.log(`heap used: ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
