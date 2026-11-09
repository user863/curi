// End-to-end client session against a pack served over HTTP: node tools/bench_pack.mjs http://127.0.0.1:4411/pack
import { loadCatalog } from '../js/catalog.js';
import { emptyProfile, withRoom, learn, scoreAll, pickNext, shares, explain } from '../js/rank.js';

const BASE = process.argv[2];
const cat = await loadCatalog(BASE);
const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const t0 = performance.now();
const log = (label) => console.log(`${label.padEnd(44)} ${kb(cat.stats.bytes).padStart(8)} in ${String(cat.stats.requests).padStart(3)} requests, ${String(cat.n).padStart(6)} works in ${String(cat.loadedClusters()).padStart(3)} clusters  [${(performance.now() - t0).toFixed(0)} ms]`);
console.log(`catalog: ${cat.manifest.count.toLocaleString()} works, ${cat.manifest.clusters.ids.length} clusters`);
log('directory (manifest + centroids)');

let profile = emptyProfile();
const ids = cat.categories.map((c) => c.id);
const mix = () => shares(profile, ids);
for (const r of ['film', 'open-air']) profile = withRoom(profile, r, true, cat.roomVec(r), cat.manifest.roomCategories[r]);
await cat.ensureClusters({ profile, shares: mix(), want: 120, explore: 0 });
log('first cards ready');
await cat.ensureClusters({ profile, shares: mix(), want: 300, explore: 2 });
log('background fill');

let seed = 5;
const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const seen = new Set();
const shown = [];
const counts = {};
let scoreKey = '';
let scores;
const pickTimes = [];
for (let k = 0; k < 60; k++) {
  const key = `${profile.ver}:${cat.version}`;
  if (key !== scoreKey) { scores = scoreAll(cat, profile); scoreKey = key; }
  const t = performance.now();
  const pick = pickNext({ index: cat, profile, scores, taken: (id) => seen.has(id) || cat.isBlocked(id), shown, rng });
  pickTimes.push(performance.now() - t);
  seen.add(pick.id);
  shown.push(pick.id);
  counts[pick.category] = (counts[pick.category] || 0) + 1;
  const card = await cat.getCard(pick.id);
  if (rng() < 0.25) {
    profile = learn(profile, card, 'save', cat.vecOf(pick.id));
    await cat.ensureClusters({ profile, shares: mix(), want: 300, explore: 2 });
  }
}
log('after a 60-card session with saves');
console.log('picks by category:', counts);
console.log(`pick time: median ${pickTimes.sort((a, b) => a - b)[30].toFixed(1)} ms, max ${pickTimes[59].toFixed(1)} ms`);
console.log(`full-index alternative: ${kb(cat.manifest.count * 71)} before the first card`);
