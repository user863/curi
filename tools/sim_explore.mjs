// Discover wall: the explore score (js/explore.js) against plain taste order, for simulated readers.
//   node tools/sim_explore.mjs [--pack data/pack] [--readers 200] [--pages 3] [--seed 1]
// A reader saves a few works they like, then sees `pages` pages of the wall.
import { fileURLToPath } from 'node:url';
import { emptyProfile, learn, scoreAll } from '../js/rank.js';
import { compose, exploreScores } from '../js/explore.js';
import { loadWorld, mulberry, mixSeed } from './pack.mjs';
import { makeReader, judge, tasteRamp } from './sim.mjs';

const PAGE = 24;
const SAVED = 6;
const SAMPLE = 3000;
const args = Object.fromEntries(process.argv.slice(2).reduce((o, a, i, all) => (a.startsWith('--') ? [...o, [a.slice(2), all[i + 1]]] : o), []));
const opt = { pack: 'data/pack', readers: '200', pages: '3', seed: '1', ...args };

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const MONO = 1;

const strategies = {
  taste: ({ index, profile, skip }) => {
    const scores = scoreAll(index, profile);
    return (taken) => Array.from(scores.keys()).filter((i) => !skip(i) && !taken.has(i)).sort((a, b) => scores[b] - scores[a]).slice(0, PAGE);
  },
  explore: ({ index, profile, skip, rng }) => (taken) => {
    const scores = exploreScores({ index, profile, rng, session: null, crowd: null, skip: (i) => skip(i) || taken.has(i) });
    return compose({ index, scores, count: PAGE, rng, profile });
  },
};

const main = async () => {
  const loaded = await loadWorld(opt.pack);
  const world = { ...loaded, maxQuality: loaded.index.quality.reduce((a, b) => Math.max(a, b), 1) };
  const { index } = world;
  const ramp = tasteRamp(world);
  const view = Object.assign(Object.create(index), { rooms: index.manifest.roomOrder });
  const imageCat = index.categories.findIndex((c) => c.id === 'visual');
  const skip = (i) => index.cat[i] !== imageCat;
  const pool = Array.from({ length: index.n }, (_, i) => i).filter((i) => !skip(i));
  const out = Object.fromEntries(Object.keys(strategies).map((k) => [k, []]));
  for (let r = 0; r < Number(opt.readers); r++) {
    const seed = mixSeed(Number(opt.seed), r + 2);
    const reader = makeReader(world, seed);
    const rng = mulberry(mixSeed(seed, 1));
    const sample = Array.from({ length: SAMPLE }, () => pool[Math.floor(rng() * pool.length)]);
    const liked = sample.map((p) => [p, judge(world, ramp, reader, p).u]).sort((a, b) => b[1] - a[1]).slice(0, SAVED).map(([p]) => p);
    const profile = liked.reduce((pr, p) => learn(pr, world.cards[p], 'save', index.vecOf(index.ids[p])), emptyProfile());
    for (const [name, make] of Object.entries(strategies)) {
      const next = make({ index: view, profile, skip, rng: mulberry(mixSeed(seed, 7)) });
      const taken = new Set(liked);
      const shown = [];
      for (let pg = 0; pg < Number(opt.pages); pg++) {
        const page = next(taken);
        page.forEach((i) => taken.add(i));
        shown.push(...page);
      }
      const u = shown.map((p) => judge(world, ramp, reader, p).u);
      const sources = new Map();
      shown.forEach((p) => sources.set(world.source[p], (sources.get(world.source[p]) ?? 0) + 1));
      out[name].push({
        u: mean(u), hit: mean(u.map((x) => (x >= 0.5 ? 1 : 0))), sources: sources.size, topSource: Math.max(...sources.values()) / shown.length,
        creators: new Set(shown.map((p) => world.creator[p]).filter((c) => c >= 0)).size,
        mono: mean(shown.map((p) => (index.flags[p] & MONO ? 1 : 0))), rooms: new Set(shown.map((p) => index.room[p])).size,
        quality: mean(shown.map((p) => index.quality[p])) / 250,
      });
    }
  }
  const keys = ['u', 'hit', 'sources', 'topSource', 'creators', 'mono', 'rooms', 'quality'];
  console.log(`pack rev ${index.manifest.rev}, ${opt.readers} readers, ${opt.pages} pages of ${PAGE}`);
  console.log(['strategy', ...keys].map((s) => s.padEnd(10)).join(''));
  for (const [name, rows] of Object.entries(out)) console.log([name, ...keys.map((k) => mean(rows.map((x) => x[k])).toFixed(3))].map((s) => s.padEnd(10)).join(''));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
