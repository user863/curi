// Feed metrics: pure functions over simulator runs (tools/sim.mjs), and two commands.
//   node tools/metrics.mjs a.json [b.json]          print one saved result, or two side by side
//   node tools/metrics.mjs --log log.json [pack]    summarise a log copied from the app's Activity log
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { emptyProfile, learn, scoreAll } from '../js/rank.js';
import { summary } from '../js/log.js';
import { loadWorld, mulberry, MODERN } from './pack.mjs';

const SET = 7; // cards per pacing set: variety is measured inside one
const SOURCE_CAP = [10, 2]; // window, most cards from one source
const CREATOR_CAP = [20, 1];
const OVERLAP_FIRST = 50;
const DWELL_MIN_S = 3; // as in js/app.js
const PAIRS = 20000; // sampled pairs for catalogue-wide and reader-to-reader means

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const windows = (xs, size) => Array.from({ length: Math.max(0, xs.length - size + 1) }, (_, i) => xs.slice(i, i + size));
const chunks = (xs, size) => Array.from({ length: Math.floor(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

// Most cards sharing one value; negative values (no creator) never count as shared.
const mostCommon = (xs) => {
  const counts = new Map();
  xs.forEach((x) => { if (x >= 0) counts.set(x, (counts.get(x) ?? 0) + 1); });
  return Math.max(0, ...counts.values());
};

export const gini = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const total = sum(sorted);
  const n = sorted.length;
  return total ? (2 * sum(sorted.map((x, i) => (i + 1) * x))) / (n * total) - (n + 1) / n : 0;
};

export const jaccard = (a, b) => {
  const inA = new Set(a);
  const both = b.filter((x) => inA.has(x)).length;
  return both / (a.length + b.length - both || 1);
};

// Share of (positive, negative) pairs the scores put in the right order.
export const auc = (pos, neg) => (pos.length && neg.length
  ? sum(pos.map((p) => sum(neg.map((q) => (p > q ? 1 : p === q ? 0.5 : 0))))) / (pos.length * neg.length)
  : null);

const distance = ({ index, dim }, a, b) => {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let d = 0; d < dim; d++) {
    const x = index.emb[a * dim + d];
    const y = index.emb[b * dim + d];
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return 1 - ab / (Math.sqrt(aa * bb) || 1);
};

const pairwise = (world, rows) => mean(rows.flatMap((a, i) => rows.slice(i + 1).map((b) => distance(world, a, b))));

// runs: one per reader, { pos (index rows in feed order), u, save, skip, oracle, random, target, bytes }.
export const summarise = (world, runs) => {
  const { index } = world;
  const rng = mulberry(7);
  const all = runs.flatMap((r) => r.pos);
  const firsts = runs.map((r) => r.save.indexOf(true)).map((i) => (i < 0 ? Infinity : i + 1));
  const first = median(firsts);
  const sourceWindows = runs.flatMap((r) => windows(r.pos.map((p) => world.source[p]), SOURCE_CAP[0]).map(mostCommon));
  const creatorWindows = runs.flatMap((r) => windows(r.pos.map((p) => world.creator[p]), CREATOR_CAP[0]).map(mostCommon));
  const exposure = new Float64Array(world.k);
  all.forEach((p) => { exposure[world.cluster[p]] += 1; });
  const sizes = index.info.counts.map(sum);
  const share = (rows, test) => (rows.length ? rows.filter(test).length / rows.length : null);
  const cats = index.categories.map((c) => c.id);
  const mixOf = (rows) => cats.map((_, c) => share(rows, (p) => index.cat[p] === c));
  const everyRow = Array.from({ length: world.n }, (_, p) => p);
  return {
    firstSave: Number.isFinite(first) ? first : null,
    noSave: share(firsts, (i) => !Number.isFinite(i)),
    regret: mean(runs.map((r) => r.oracle - mean(r.u))),
    utilityOracle: mean(runs.map((r) => r.oracle)),
    utilityRandom: mean(runs.map((r) => r.random)),
    variety: mean(runs.flatMap((r) => chunks(r.pos, SET).map((rows) => pairwise(world, rows)))),
    varietyCatalogue: mean(Array.from({ length: PAIRS }, () => distance(world, Math.floor(rng() * world.n), Math.floor(rng() * world.n)))),
    sourcePer10: mean(sourceWindows),
    sourceOver: share(sourceWindows, (m) => m > SOURCE_CAP[1]),
    creatorPer20: mean(creatorWindows),
    creatorOver: share(creatorWindows, (m) => m > CREATOR_CAP[1]),
    coverage: share([...exposure], (x) => x > 0),
    exposureGini: gini([...exposure].map((x, j) => x / sizes[j])),
    overlap50: mean(Array.from({ length: Math.min(PAIRS, runs.length * (runs.length - 1) / 2) }, () => {
      const a = Math.floor(rng() * runs.length);
      const b = (a + 1 + Math.floor(rng() * (runs.length - 1))) % runs.length;
      return jaccard(runs[a].pos.slice(0, OVERLAP_FIRST), runs[b].pos.slice(0, OVERLAP_FIRST));
    })),
    categoryGap: mean(runs.map((r) => 100 * mean(mixOf(r.pos).map((s, c) => Math.abs(s - r.target[cats[c]]))))),
    categories: Object.fromEntries(mixOf(all).map((s, c) => [cats[c], s])),
    modern: share(all, (p) => world.era[p] >= MODERN),
    undated: share(all, (p) => world.era[p] === 0),
    modernCatalogue: share(everyRow, (p) => world.era[p] >= MODERN),
    undatedCatalogue: share(everyRow, (p) => world.era[p] === 0),
    starterQuality: null, // no starter edition in the pack yet
    saveRate: mean(runs.map((r) => share(r.save, Boolean))),
    skipRate: mean(runs.map((r) => share(r.skip, Boolean))),
    utility: mean(runs.map((r) => mean(r.u))),
    indexKB: mean(runs.map((r) => r.bytes / 1024)),
  };
};

const num = (digits) => (x) => x.toFixed(digits);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ROWS = [
  ['firstSave', 'Cards to first save, median', 'below 8', num(0)],
  ['noSave', 'Readers with no save in the run', '', pct],
  ['regret', 'Regret against the oracle, in utility', 'falling', num(3)],
  ['utility', 'Utility of the cards shown, mean', '', num(3)],
  ['utilityRandom', 'Same, a random feed', '', num(3)],
  ['utilityOracle', 'Same, the oracle', '', num(3)],
  ['variety', 'Distance within a set of 7, mean', 'above catalogue', num(3)],
  ['varietyCatalogue', 'Distance between two random works', '', num(3)],
  ['sourcePer10', 'Most cards from one source in 10', 'at most 2', num(2)],
  ['sourceOver', 'Windows of 10 over that cap', '0%', pct],
  ['creatorPer20', 'Most cards from one creator in 20', 'at most 1', num(2)],
  ['creatorOver', 'Windows of 20 over that cap', '0%', pct],
  ['coverage', 'Clusters shown to at least one reader', 'above 80%', pct],
  ['exposureGini', 'Gini of exposure across clusters', 'falling', num(3)],
  ['overlap50', 'Overlap of the first 50 cards, two readers', 'below 0.15', num(3)],
  ['categoryGap', 'Category mix, gap to target in points', 'within 5', num(1)],
  ['modern', 'Cards dated after 1900', 'at least 30%', pct],
  ['modernCatalogue', 'Same, whole catalogue', '', pct],
  ['undated', 'Cards with no date', '', pct],
  ['starterQuality', 'Starter edition, quality percentile', 'above 90', num(0)],
  ['saveRate', 'Cards saved', '', pct],
  ['skipRate', 'Cards skipped', '', pct],
  ['indexKB', 'Index downloaded per reader, KB', '', num(0)],
];

// One result, or two side by side.
export const table = (a, b = null) => {
  const cell = (m, key, fmt) => (m[key] === null || m[key] === undefined ? 'unknown' : fmt(m[key])).padStart(10);
  const head = `${'metric'.padEnd(44)}${(b ? 'before' : 'value').padStart(10)}${b ? 'after'.padStart(10) : ''}  target`;
  const mixLine = (m) => Object.entries(m.categories).map(([id, s]) => `${id} ${pct(s)}`).join(', ');
  return [
    head,
    ...ROWS.map(([key, label, target, fmt]) => `${label.padEnd(44)}${cell(a, key, fmt)}${b ? cell(b, key, fmt) : ''}  ${target}`),
    `${b ? 'category mix before' : 'category mix'}: ${mixLine(a)}`,
    ...(b ? [`category mix after: ${mixLine(b)}`] : []),
  ].join('\n');
};

// Replays a device log through the ranker: did it score the cards that were then saved above the skipped ones?
const replay = (world, events) => {
  const scores = new Map();
  const liked = new Set();
  const refused = new Set();
  const one = (profile, p) => scoreAll({ n: 1, dim: world.dim, emb: world.index.emb.subarray(p * world.dim, (p + 1) * world.dim), quality: [world.index.quality[p]] }, profile)[0];
  events.reduce((profile, [, kind, n, , value]) => {
    const p = world.index.posOf(n);
    if (p < 0) return profile; // not a card event, or a work no longer in the pack
    const vec = world.index.vecOf(n);
    if (kind === 'show') scores.set(n, one(profile, p));
    if (kind === 'save' || kind === 'more') liked.add(n);
    if (kind === 'skip' || kind === 'less') refused.add(n);
    if (['save', 'more', 'less', 'note', 'skip', 'finish'].includes(kind)) return learn(profile, world.cards[p], kind, vec);
    return kind === 'dwell' && value >= DWELL_MIN_S ? learn(profile, world.cards[p], 'dwell', null, value) : profile;
  }, emptyProfile());
  const of = (set) => [...set].filter((n) => scores.has(n) && !(set === refused && liked.has(n))).map((n) => scores.get(n));
  return { liked: of(liked).length, refused: of(refused).length, auc: auc(of(liked), of(refused)) };
};

const main = async ([first, second, third]) => {
  if (first === '--log') {
    const events = JSON.parse(await readFile(second, 'utf8'));
    console.log(summary(events));
    const r = replay(await loadWorld(third ?? 'data/pack'), events);
    console.log(`replay from an empty profile: ${r.liked} liked, ${r.refused} refused, AUC ${r.auc === null ? 'unknown' : r.auc.toFixed(3)}`);
    return;
  }
  const [a, b] = await Promise.all([first, second].filter(Boolean).map(async (f) => JSON.parse(await readFile(f, 'utf8'))));
  [a, b].filter(Boolean).forEach((r) => console.log(`${r.label}: pack rev ${r.rev}, ${r.works} works, ${r.readers} readers x ${r.cards} cards, seed ${r.seed}`));
  console.log(table(a.metrics, b?.metrics));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
