// On-device ranking over typed arrays. Pure: no DOM, no storage; randomness and caches are injected.
//
// Interest = a few centroids in embedding space (positive and negative), learned from feedback.
// Mix = share per category (images, text, film, audio): equal at the start, shifting with interest.

const DELTA = { save: 1, more: 1.5, less: -1.5, note: 0.3, skip: -0.5, finish: 0.4 };
const SOFT_CONFIRM = 4; // similar skips before a soft dislike counts in full
const DWELL_PER_S = 0.02;
const DWELL_CAP = 0.15; // dwell stays a weak signal
const DECAY = 0.98;
const CLAMP = 6;
const K_POS = 8;
const K_NEG = 4;
const MERGE_COS = 0.55; // feedback within this cosine of a centroid moves it instead of adding one
const ETA = 0.3;
const MAX_LABELS = 12;
const THETA = 0.25; // how far the attribute draw can tilt a score

const FACET_HALF_LIFE_DAYS = 30; // an interest not touched for a month counts half
const COUNTER_HALF_LIFE_DAYS = 60; // category lean
const MIN_WEIGHT = 0.2; // a faded interest below this is dropped (unless picked by room)

const SOURCE_CAP = { window: 10, most: 2 }; // cards from one source in the last 10
const CREATOR_CAP = { window: 20, most: 1 }; // and from one creator in the last 20
const NO_CREATOR = 0xffff;

const CAT_SENSITIVITY = 0.35; // how fast the mix follows interest
const CAT_FLOOR = 0.1; // no category drops below this share
const WINDOW = 12; // recent cards the mix is measured over

const EXPLORE_RATE = 0.2;
const EXPLORE_MIN_QUALITY = 50; // quality byte: 1 + 50/250 = 1.2
const EXPLORE_SAMPLE = 300;
const MMR_LAMBDA = 0.45;
const RECENT = 3;
const TOP_M = 40;
const JITTER = 0.03;

// Beta(a, b) by two gammas (Marsaglia-Tsang); normals by Box-Muller from the injected rng.
const normal = (rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
const gamma = (shape, rng) => {
  if (shape < 1) return gamma(shape + 1, rng) * rng() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v = (1 + c * x) ** 3;
    if (v > 0 && Math.log(1 - rng()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
};
export const beta = (a, b, rng) => {
  const x = gamma(a, rng);
  return x / (x + gamma(b, rng));
};

const norm = (v) => Math.hypot(...v) || 1;
const unit = (v) => {
  const n = norm(v);
  return v.map((x) => x / n);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x) => Math.max(-CLAMP, Math.min(CLAMP, x));
const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));

// Features used for labels ("Because you saved ... tagged X").
export const featuresOf = (card) => [`r:${card.editorial.room}`, ...card.editorial.tags.map((t) => `t:${t}`)];

// Beta counters per attribute, [wins, losses]: "r:<room>" and "k:<category>". Weak signals add little, firm ones more.
export const emptyProfile = () => ({ cents: [], negs: [], cat: {}, attrs: {}, ver: 0 });

// Profiles saved before the counters: wins from the labels of the interests, losses from those of the dislikes.
export const withAttrs = (profile) => {
  if (profile.attrs) return profile;
  const attrs = {};
  const count = (list, slot) => list.forEach((c) => Object.entries(c.labels ?? {}).forEach(([l, n]) => {
    if (!l.startsWith('r:')) return;
    attrs[l] ??= [0, 0];
    attrs[l][slot] += n * (c.w ?? c.n ?? 1);
  }));
  count(profile.cents, 0);
  count(profile.negs, 1);
  return { ...profile, attrs };
};

const attributesOf = (card) => [`r:${card.editorial.room}`, `k:${card.cat}`];

const bump = (attrs, card, delta) => attributesOf(card).reduce((o, k) => {
  const [a, b] = o[k] ?? [0, 0];
  return { ...o, [k]: delta > 0 ? [a + delta, b] : [a, b - delta] };
}, attrs);

// Time passes: interests and category lean fade (now in seconds). Called once at the start of a session.
export const age = (profile, now) => {
  const days = (now - (profile.at ?? now)) / 86400;
  if (!(days > 0)) return { ...profile, at: now };
  const keep = (halfLife) => 0.5 ** (days / halfLife);
  const fade = (list) => list.map((c) => ({ ...c, w: weightOf(c) * keep(FACET_HALF_LIFE_DAYS) })).filter((c) => c.room || c.w >= MIN_WEIGHT);
  const cat = Object.fromEntries(Object.entries(profile.cat).map(([k, v]) => [k, v * keep(COUNTER_HALF_LIFE_DAYS)]));
  const attrs = Object.fromEntries(Object.entries(profile.attrs ?? {}).map(([k, [a, b]]) => [k, [a * keep(COUNTER_HALF_LIFE_DAYS), b * keep(COUNTER_HALF_LIFE_DAYS)]]));
  return { ...profile, cents: fade(profile.cents), negs: fade(profile.negs), cat, attrs, at: now, ver: profile.ver + 1 };
};

const weightOf = (c) => c.w ?? c.n; // profiles saved before weights count their number of touches

const merge = (list, vec, delta, labels, cap, extra, create = Math.abs(delta) >= 1) => {
  const hard = Math.abs(delta) >= 1;
  const sims = list.map((c) => dot(c.v, vec));
  const best = sims.length ? sims.indexOf(Math.max(...sims)) : -1;
  const counted = Object.fromEntries(labels.map((l) => [l, 1]));
  if (best >= 0 && sims[best] >= MERGE_COS) {
    const c = list[best];
    const v = unit(c.v.map((x, i) => x + ETA * Math.abs(delta) * vec[i]));
    const bump = (obj) => labels.reduce((o, l) => ({ ...o, [l]: (o[l] || 0) + 1 }), obj);
    return list.map((x, i) => (i === best
      ? { ...x, v, n: x.n + 1, w: weightOf(x) + Math.abs(delta), labels: top(bump(x.labels), MAX_LABELS), saves: (x.saves || 0) + (extra.saves || 0), mores: (x.mores || 0) + (extra.mores || 0),
          hard: x.hard || hard, soft: !(x.hard || hard || x.n + 1 >= SOFT_CONFIRM) }
      : x));
  }
  if (!create) return list; // weak positive signals only refine existing interests
  const fresh = { v: vec, n: 1, w: Math.abs(delta), labels: counted, saves: extra.saves || 0, mores: extra.mores || 0, hard, soft: !hard };
  if (list.length >= cap) { // the lightest goes; a soft dislike never pushes out an interest or a firm dislike
    const lightest = (rows) => rows.reduce((a, b) => (weightOf(b[0]) < weightOf(a[0]) ? b : a));
    const indexed = list.map((c, j) => [c, j]);
    const soft = indexed.filter(([c]) => c.soft);
    if (!soft.length && fresh.soft) return list;
    const [, out] = lightest(soft.length ? soft : indexed);
    return [...list.filter((_, j) => j !== out), fresh];
  }
  return [...list, fresh];
};

// event: save | more | less | note | dwell (seconds). vec: unit embedding of the card.
export const learn = (profile, card, event, vec, seconds = 0) => {
  const delta = event === 'dwell' ? Math.min(DWELL_CAP, DWELL_PER_S * seconds) : DELTA[event];
  if (!delta) return profile;
  const cat = Object.fromEntries(Object.entries(profile.cat).map(([k, v]) => [k, v * DECAY]));
  cat[card.cat] = clamp((cat[card.cat] || 0) + delta);
  const attrs = bump(profile.attrs ?? {}, card, delta);
  if (event === 'dwell') return { ...profile, cat, attrs };
  const labels = featuresOf(card);
  const extra = { saves: event === 'save' ? 1 : 0, mores: event === 'more' ? 1 : 0 };
  return delta > 0
    ? { ...profile, cat, attrs, cents: merge(profile.cents, vec, delta, labels, K_POS, extra, delta >= 1), ver: profile.ver + 1 }
    : { ...profile, cat, attrs, negs: merge(profile.negs, vec, delta, labels, K_NEG, {}, true), ver: profile.ver + 1 };
};

// Picking a room in onboarding or Interests seeds a centroid and nudges the mix toward its categories.
export const withRoom = (profile, room, on, centroid, categories) => {
  const rest = profile.cents.filter((c) => c.room !== room);
  if (!on) return { ...profile, cents: rest, ver: profile.ver + 1 };
  if (rest.length < profile.cents.length) return profile;
  const cat = { ...profile.cat };
  Object.entries(categories).forEach(([c, share]) => { cat[c] = clamp((cat[c] || 0) + share); });
  const seeded = { v: unit(centroid), n: 1, w: 3, labels: { [`r:${room}`]: 3 }, room, saves: 0, mores: 0 };
  return { ...profile, cat, cents: [...rest, seeded].slice(-K_POS), ver: profile.ver + 1 };
};

export const forgetInterest = (profile, kind, i) =>
  ({ ...profile, [kind]: profile[kind].filter((_, j) => j !== i), ver: profile.ver + 1 });

// Share of the feed per category: equal at the start; follows interest with a floor.
export const shares = (profile, categoryIds) => {
  const raw = categoryIds.map((id) => Math.exp(CAT_SENSITIVITY * (profile.cat[id] || 0)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const floored = raw.map((r) => Math.max(CAT_FLOOR, r / sum));
  const total = floored.reduce((a, b) => a + b, 0);
  return Object.fromEntries(categoryIds.map((id, k) => [id, floored[k] / total]));
};

// Cosine of every work to its closest positive interest (0 with no interests). Flat typed arrays keep this fast at 100k+ works.
export const matchAll = (index, profile) => {
  const { n, dim, emb } = index;
  const out = new Float32Array(n);
  const k = profile.cents.length;
  if (!k) return out;
  const pos = Float32Array.from(profile.cents.flatMap((c) => c.v));
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let m = -1;
    for (let c = 0; c < k; c++) {
      let s = 0;
      const o = c * dim;
      for (let d = 0; d < dim; d++) s += pos[o + d] * emb[base + d];
      if (s > m) m = s;
    }
    out[i] = m / 127;
  }
  return out;
};

// Beta(1 + wins, 1 + losses) draw per attribute, from the injected rng; 0.5 on average when nothing is known.
export const draw = (profile, key, rng) => {
  const [a, b] = profile.attrs?.[key] ?? [0, 0];
  return beta(1 + a, 1 + b, rng);
};

// Interest x quality for every work. With rng, the room and category counters tilt it (Thompson draw, at most +-THETA).
export const scoreAll = (index, profile, rng) => {
  const { n, dim, emb, quality } = index;
  const out = new Float32Array(n);
  const neg = Float32Array.from(profile.negs.flatMap((c) => c.v));
  const kn = profile.negs.length;
  const match = matchAll(index, profile);
  const weights = profile.negs.map((c) => (c.soft ? (c.n / SOFT_CONFIRM) ** 2 : 1)); // a few skips are a hint, not a verdict
  const dislike = (base) => {
    let worst = 0;
    for (let c = 0; c < kn; c++) {
      let s = 0;
      const o = c * dim;
      for (let d = 0; d < dim; d++) s += neg[o + d] * emb[base + d];
      worst = Math.max(worst, weights[c] * Math.max(0, s / 127 - 0.3));
    }
    return worst;
  };
  const tilt = rng && Object.keys(profile.attrs ?? {}).length > 0;
  const roomIds = Array.isArray(index.rooms) ? index.rooms : index.manifest?.roomOrder; // catalogs carry `rooms` as a label map
  const rooms = tilt ? roomIds?.map((r) => draw(profile, `r:${r}`, rng)) : null;
  const cats = tilt ? index.categories?.map((c) => draw(profile, `k:${c.id ?? c}`, rng)) : null;
  for (let i = 0; i < n; i++) {
    const interest = sigmoid(5 * (match[i] - 0.25 - 0.6 * (kn ? dislike(i * dim) : 0)));
    const theta = tilt ? ((rooms?.[index.room[i]] ?? 0.5) + (cats?.[index.cat[i]] ?? 0.5)) / 2 : 0.5;
    out[i] = interest * (1 + quality[i] / 250) * (1 + THETA * 2 * (theta - 0.5));
  }
  return out;
};

const rowCos = (emb, dim, a, b) => {
  let s = 0;
  for (let d = 0; d < dim; d++) s += emb[a * dim + d] * emb[b * dim + d];
  return s / (127 * 127);
};

// Best m untaken works of one category, by score.
const topInCategory = (index, scores, catCode, taken, m, skip) => {
  const best = [];
  for (let i = 0; i < index.n; i++) {
    if (index.cat[i] !== catCode || taken(index.ids[i]) || skip(i)) continue;
    const s = scores[i];
    if (best.length === m && s <= best[m - 1][1]) continue;
    let j = best.length;
    while (j > 0 && best[j - 1][1] < s) j--;
    best.splice(j, 0, [i, s]);
    if (best.length > m) best.pop();
  }
  return best;
};

// Random-but-excellent: a high-quality work from a random sample, outside the top list.
const explore = (index, catCode, taken, rng, exclude, skip, minQuality) => {
  let pick = null;
  for (let t = 0; t < EXPLORE_SAMPLE; t++) {
    const i = Math.floor(rng() * index.n);
    if (index.cat[i] !== catCode || exclude.has(i) || skip(i) || taken(index.ids[i]) || index.quality[i] < minQuality) continue;
    if (!pick || index.quality[i] > index.quality[pick]) pick = i;
  }
  return pick;
};

// Rows that would repeat a source or a creator too soon: at most 2 per source in 10, 1 per creator in 20.
// Returns the two checks apart, so the creator check can be relaxed first (a category may hold few authors).
const repeats = (index, shown) => {
  if (!index.source) return { source: () => false, creator: () => false };
  const rows = shown.map((id) => index.posOf(id)).filter((p) => p >= 0);
  const sources = rows.slice(-SOURCE_CAP.window).reduce((m, p) => m.set(index.source[p], (m.get(index.source[p]) ?? 0) + 1), new Map());
  const creators = new Set(rows.slice(-CREATOR_CAP.window).map((p) => index.creator[p]).filter((c) => c !== NO_CREATOR));
  return { source: (i) => (sources.get(index.source[i]) ?? 0) >= SOURCE_CAP.most, creator: (i) => creators.has(index.creator[i]) };
};

// Next work: choose the category furthest below its share in the recent window, then the best work in it.
// In a category with nothing left under both caps, the creator cap goes first, then the source cap, before another category is tried.
// only: category ids to draw from, or null. A pacing slot (js/session.js) can set explore ('never' | 'maybe' | 'always'),
// a minimum quality for explore picks, and an extra rule for rows to leave out; relax: false returns null
// instead of breaking the repeat caps.
export const pickNext = ({ index, profile, scores, taken, shown, rng, only = null, explore: mode = 'maybe', exploreMin = EXPLORE_MIN_QUALITY, extra = () => false, relax = true }) => {
  const ids = index.categories.map((c) => c.id);
  const share = shares(profile, ids);
  const recent = shown.slice(-WINDOW).map((id) => index.cat[index.posOf(id)]);
  const deficit = ids.map((id, k) => [k, share[id] - (recent.length ? recent.filter((c) => c === k).length / recent.length : 0) + rng() * JITTER]);
  deficit.sort((a, b) => b[1] - a[1]);
  const last = shown.slice(-RECENT).map((id) => index.posOf(id));
  const cap = repeats(index, shown);
  const attempt = (levels) => {
    for (const [k] of only ? deficit.filter(([k]) => only.includes(ids[k])) : deficit) {
      for (const skip of levels) {
        const list = topInCategory(index, scores, k, taken, TOP_M, (i) => skip(i) || extra(i));
        if (!list.length) continue;
        if (mode === 'always' || (mode === 'maybe' && shown.length >= 2 && rng() < EXPLORE_RATE)) {
          const i = explore(index, k, taken, rng, new Set(list.map(([p]) => p)), (r) => skip(r) || extra(r), exploreMin);
          if (i !== null) return { pos: i, id: index.ids[i], category: ids[k], share: share[ids[k]], exploring: true };
        }
        const value = ([i, s]) => s + rng() * JITTER - MMR_LAMBDA * (last.length ? Math.max(...last.map((j) => rowCos(index.emb, index.dim, i, j))) : 0);
        const [pos] = list.map((e) => [e[0], value(e)]).reduce((a, b) => (b[1] > a[1] ? b : a));
        return { pos, id: index.ids[pos], category: ids[k], share: share[ids[k]], exploring: false };
      }
    }
    return null;
  };
  return attempt([(i) => cap.source(i) || cap.creator(i), cap.source]) ?? (relax ? attempt([() => false]) : null);
};

// Why this card: the closest interest, named by the label it shares with the card.
export const explain = (profile, card, vec, exploring) => {
  if (exploring) return { kind: 'exploring' };
  const sims = profile.cents.map((c) => dot(c.v, vec));
  const best = sims.length ? sims.indexOf(Math.max(...sims)) : -1;
  if (best < 0 || sims[best] < 0.3) return { kind: 'editor' };
  const c = profile.cents[best];
  const mine = featuresOf(card);
  const shared = Object.entries(c.labels).filter(([l]) => mine.includes(l)).sort((a, b) => b[1] - a[1])[0];
  const feature = (shared || Object.entries(c.labels).sort((a, b) => b[1] - a[1])[0])[0];
  if (c.saves) return { kind: 'saved', feature, count: c.saves };
  if (c.mores) return { kind: 'more', feature, count: c.mores };
  return c.room ? { kind: 'picked', feature } : { kind: 'learned', feature };
};

// Names for the Interests screen.
export const labelOf = (c, n = 3) => Object.entries(c.labels).sort((a, b) => b[1] - a[1]).slice(0, n).map(([l]) => l);
