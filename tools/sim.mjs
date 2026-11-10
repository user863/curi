// Simulated readers over the real pack and the real ranking code (js/rank.js, js/plan.js, js/catalog.js).
//   node tools/sim.mjs [--pack data/pack] [--readers 1000] [--cards 100] [--seed 1] [--label name] [--out file.json]
// A reader has hidden tastes and reacts to each card by a fixed rule, so two rankers face the same readers.
// The feed loop below mirrors js/app.js (two cards ranked ahead, re-ranked after a verdict); keep them in step.
import { writeFile } from 'node:fs/promises';
import { loadCatalog } from '../js/catalog.js';
import { emptyProfile, learn, scoreAll, matchAll, shares } from '../js/rank.js';
import { SET, planFor, nextSlot, pickFor } from '../js/session.js';
import { loadWorld, mulberry, mixSeed, ERAS } from './pack.mjs';
import { summarise, table } from './metrics.mjs';

// As in js/app.js.
const AHEAD = 2;
const FIRST_WANT = 120;
const WANT = 300;
const EXPLORE_CLUSTERS = 2;
const SKIP_S = 1.2;
const DWELL_MIN_S = 3;
const FINISH_SHARE = 0.8;

// The reader model. Utility is in [0, 1]: taste for a few regions of the catalogue, an era, a format, and quality.
// Liked regions: one cluster in each format the reader takes to (a coin flip per format), and a few anywhere.
// Without the per-format regions nearly every taste would sit among the images, which are 98% of the works.
const LIKED_ANYWHERE = 2;
const TAKES_TO_FORMAT = 0.5;
const WEIGHT = { taste: 0.6, era: 0.15, format: 0.1, quality: 0.15 };
const SKIP = (u) => 0.75 * (1 - u) ** 2;
const SAVE = (u) => 0.6 * u ** 3;
const MORE = (u) => 0.15 * u ** 4;
const LESS = (u, dislike) => 0.5 * dislike * (1 - u);
const NOTE = (u) => 0.1 * u;
const ORACLE_SAMPLE = 20000; // cosines sampled to place the taste ramp

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const args = (argv) => Object.fromEntries(argv.reduce((out, a, i) => (a.startsWith('--') ? [...out, [a.slice(2), argv[i + 1]]] : out), []));

// Cosine to a liked centroid counts from the catalogue's median up to its 99th percentile.
const tasteRamp = ({ cos }) => {
  const step = Math.max(1, Math.floor(cos.length / ORACLE_SAMPLE));
  const sample = Float32Array.from({ length: Math.floor(cos.length / step) }, (_, i) => cos[i * step]).sort();
  const lo = sample[Math.floor(sample.length * 0.5)];
  const hi = sample[Math.floor(sample.length * 0.99)];
  return (c) => clamp01((c - lo) / (hi - lo));
};

const makeReader = (world, seed) => {
  const rng = mulberry(seed);
  const { counts } = world.index.info;
  const draw = (sizes) => { // a cluster, by its number of works
    let x = rng() * sizes.reduce((a, b) => a + b, 0);
    return sizes.findIndex((s) => (x -= s) < 0);
  };
  const all = counts.map((c) => c.reduce((a, b) => a + b, 0));
  const distinct = (n, taken) => (taken.length >= n ? taken : distinct(n, [...new Set([...taken, draw(all)])]));
  const takes = world.index.categories.map(() => rng() < TAKES_TO_FORMAT);
  const perFormat = [...new Set(takes.flatMap((yes, c) => (yes ? [draw(counts.map((row) => row[c]))] : [])))];
  const liked = distinct(perFormat.length + LIKED_ANYWHERE, perFormat);
  const disliked = distinct(liked.length + 1, liked)[liked.length];
  const loved = 1 + Math.floor(rng() * (ERAS.length - 1));
  const avoided = 1 + ((loved + Math.floor(rng() * (ERAS.length - 2))) % (ERAS.length - 1));
  return {
    seed,
    liked,
    disliked,
    era: ERAS.map((_, e) => (e === loved ? 1 : e === avoided ? 0 : 0.5)),
    format: takes.map((yes) => (yes ? 1 : 0.2)),
  };
};

const judge = (world, ramp, reader, p) => {
  const row = p * world.k;
  const taste = Math.max(...reader.liked.map((j) => ramp(world.cos[row + j])));
  const dislike = ramp(world.cos[row + reader.disliked]);
  const u = WEIGHT.taste * taste * (1 - dislike) + WEIGHT.era * reader.era[world.era[p]]
    + WEIGHT.format * reader.format[world.index.cat[p]] + WEIGHT.quality * world.index.quality[p] / world.maxQuality;
  return { u, dislike };
};

// What the reader does with one card. Seeded by reader and work: the same card always gets the same reaction.
const react = (world, ramp, reader, p) => {
  const { u, dislike } = judge(world, ramp, reader, p);
  const r = mulberry(mixSeed(reader.seed, world.index.ids[p]));
  const length = world.length[p];
  if (r() < SKIP(u)) return { u, seconds: 0.4 + 0.7 * r(), save: false, more: false, less: false, note: false };
  const stays = 2 + 14 * u * (0.5 + r());
  const seconds = length > 0 ? (r() < u ? length : Math.min(stays, 0.7 * length)) : stays;
  const save = r() < SAVE(u);
  const more = r() < MORE(u);
  return { u, seconds, save, more, less: !save && !more && r() < LESS(u, dislike), note: r() < NOTE(u) };
};

// Mean utility of the best `cards` works for this reader, and of all works (a random feed).
const bounds = (world, ramp, reader, cards) => {
  const all = Float32Array.from({ length: world.n }, (_, p) => judge(world, ramp, reader, p).u).sort();
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return { oracle: mean(all.subarray(world.n - cards)), random: mean(all) };
};

const runReader = async (world, ramp, seed, cards) => {
  const reader = makeReader(world, seed);
  const catalog = await loadCatalog(world.dir);
  const rng = mulberry(mixSeed(seed, 1)); // the ranker's own randomness
  const ids = catalog.categories.map((c) => c.id);
  const seen = new Set();
  const queued = new Set();
  let profile = emptyProfile();
  let entries = []; // { n, setNo, pos, plan, outcome } in feed order: shown so far, then the cards ranked ahead
  let at = 0;
  const released = new Set(); // sets whose interlude has been passed
  let scored = { key: '', scores: null, match: null };

  const mix = () => shares(profile, ids);
  const keyNow = () => `${profile.ver}:${catalog.version}`;
  const scoresNow = () => {
    if (scored.key !== keyNow()) scored = { key: keyNow(), scores: scoreAll(catalog, profile), match: null };
    return scored.scores;
  };
  const matchNow = () => {
    scoresNow();
    scored.match ??= matchAll(catalog, profile);
    return scored.match;
  };
  const grow = (opts = {}) => catalog.ensureClusters({ profile, shares: mix(), want: WANT, explore: EXPLORE_CLUSTERS, rng, ...opts });
  const rank = (kind) => pickFor({
    kind, index: catalog, profile, scores: scoresNow(), match: matchNow, shown: entries.map((e) => e.n), rng,
    taken: (id) => seen.has(id) || queued.has(id) || catalog.isBlocked(id),
    only: entries.length === 0 ? ['visual'] : null,
  });
  const waiting = () => entries.length > 0 && entries[entries.length - 1].pos === SET && !released.has(entries[entries.length - 1].setNo);
  const appendNext = async () => {
    const slot = nextSlot(entries[entries.length - 1]);
    const plan = slot.start
      ? planFor({ sittingSet: slot.setNo, previous: entries.filter((e) => e.setNo === slot.setNo - 1).map((e) => e.outcome) })
      : entries[entries.length - 1].plan;
    const kind = plan[slot.pos - 1];
    let pick = rank(kind);
    if (!pick && (await catalog.ensureClusters({ profile, shares: mix(), want: Infinity, maxNew: 4, rng }))) pick = rank(kind);
    if (!pick && seen.size) {
      seen.clear();
      pick = rank(kind);
    }
    if (!pick) return false;
    entries = [...entries, { n: pick.id, setNo: slot.setNo, pos: slot.pos, plan, outcome: null }];
    queued.add(pick.id);
    return true;
  };
  const fillAhead = async () => {
    while (!waiting() && entries.length - 1 - at < AHEAD && (await appendNext()));
  };
  const refillAhead = async () => {
    entries.slice(at + 1).forEach((e) => queued.delete(e.n));
    entries = entries.slice(0, at + 1);
    await fillAhead();
  };

  await grow({ want: FIRST_WANT, explore: 0 });
  await appendNext();
  await grow();
  await fillAhead();

  const run = { pos: [], u: [], save: [], skip: [] };
  let swiped = false; // the last card was judged by a swipe: the queue is re-ranked once the next card is up
  for (at = 0; at < cards && at < entries.length; at++) {
    const id = entries[at].n;
    seen.add(id);
    await (swiped ? refillAhead() : fillAhead());
    const p = world.index.posOf(id);
    const card = world.cards[p];
    const vec = catalog.vecOf(id);
    const did = react(world, ramp, reader, p);
    const verdict = async (event) => {
      profile = learn(profile, card, event, vec);
      await grow();
    };
    if (did.note) await verdict('note');
    if (did.save) {
      await verdict('save');
      await refillAhead();
    }
    swiped = did.more || did.less;
    if (swiped) await verdict(did.more ? 'more' : 'less');
    else if (did.seconds < SKIP_S) profile = learn(profile, card, 'skip', vec);
    else if (world.length[p] > 0 && did.seconds >= FINISH_SHARE * world.length[p]) profile = learn(profile, card, 'finish', vec);
    else if (did.seconds >= DWELL_MIN_S) profile = learn(profile, card, 'dwell', null, did.seconds);
    run.pos.push(p);
    run.u.push(did.u);
    run.save.push(did.save);
    run.skip.push(did.seconds < SKIP_S);
    entries[at].outcome = did.seconds < SKIP_S ? 'skip' : 'engaged';
    if (entries[at].pos === SET) { // past the interlude: the next set is composed
      released.add(entries[at].setNo);
      await fillAhead();
    }
  }
  return { ...run, ...bounds(world, ramp, reader, cards), target: mix(), bytes: catalog.stats.bytes };
};

const main = async () => {
  const opt = { pack: 'data/pack', readers: '1000', cards: '100', seed: '1', label: 'run', ...args(process.argv.slice(2)) };
  const [readers, cards, seed] = [opt.readers, opt.cards, opt.seed].map(Number);
  const t0 = performance.now();
  const loaded = await loadWorld(opt.pack);
  const world = { ...loaded, maxQuality: loaded.index.quality.reduce((a, b) => Math.max(a, b), 1) };
  const ramp = tasteRamp(world);
  const runs = [];
  for (let r = 0; r < readers; r++) runs.push(await runReader(world, ramp, mixSeed(seed, r + 2), cards));
  const { manifest } = world.index;
  const result = { label: opt.label, rev: manifest.rev, works: manifest.count, readers, cards, seed, metrics: summarise(world, runs) };
  console.log(`${result.label}: pack rev ${result.rev}, ${result.works} works in ${world.k} clusters, ${readers} readers x ${cards} cards, seed ${seed}  [${((performance.now() - t0) / 1000).toFixed(0)} s]`);
  console.log(table(result.metrics));
  if (opt.out) await writeFile(opt.out, `${JSON.stringify(result, null, 1)}\n`);
};

await main();
