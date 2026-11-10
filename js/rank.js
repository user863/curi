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
const K_POS = 6;
const K_NEG = 3;
const MERGE_COS = 0.55; // feedback within this cosine of a centroid moves it instead of adding one
const ETA = 0.3;
const MAX_LABELS = 12;

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

export const emptyProfile = () => ({ cents: [], negs: [], cat: {}, ver: 0 });

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
      ? { ...x, v, n: x.n + 1, labels: top(bump(x.labels), MAX_LABELS), saves: (x.saves || 0) + (extra.saves || 0), mores: (x.mores || 0) + (extra.mores || 0),
          hard: x.hard || hard, soft: !(x.hard || hard || x.n + 1 >= SOFT_CONFIRM) }
      : x));
  }
  if (!create) return list; // weak positive signals only refine existing interests
  const fresh = { v: vec, n: 1, labels: counted, saves: extra.saves || 0, mores: extra.mores || 0, hard, soft: !hard };
  if (list.length >= cap) { // a soft dislike never pushes out an interest or a firm dislike
    const soft = list.findIndex((c) => c.soft);
    if (soft < 0 && fresh.soft) return list;
    return [...list.filter((_, j) => j !== (soft < 0 ? 0 : soft)), fresh];
  }
  return [...list, fresh];
};

// event: save | more | less | note | dwell (seconds). vec: unit embedding of the card.
export const learn = (profile, card, event, vec, seconds = 0) => {
  const delta = event === 'dwell' ? Math.min(DWELL_CAP, DWELL_PER_S * seconds) : DELTA[event];
  if (!delta) return profile;
  const cat = Object.fromEntries(Object.entries(profile.cat).map(([k, v]) => [k, v * DECAY]));
  cat[card.cat] = clamp((cat[card.cat] || 0) + delta);
  if (event === 'dwell') return { ...profile, cat };
  const labels = featuresOf(card);
  const extra = { saves: event === 'save' ? 1 : 0, mores: event === 'more' ? 1 : 0 };
  return delta > 0
    ? { ...profile, cat, cents: merge(profile.cents, vec, delta, labels, K_POS, extra, delta >= 1), ver: profile.ver + 1 }
    : { ...profile, cat, negs: merge(profile.negs, vec, delta, labels, K_NEG, {}, true), ver: profile.ver + 1 };
};

// Picking a room in onboarding or Interests seeds a centroid and nudges the mix toward its categories.
export const withRoom = (profile, room, on, centroid, categories) => {
  const rest = profile.cents.filter((c) => c.room !== room);
  if (!on) return { ...profile, cents: rest, ver: profile.ver + 1 };
  if (rest.length < profile.cents.length) return profile;
  const cat = { ...profile.cat };
  Object.entries(categories).forEach(([c, share]) => { cat[c] = clamp((cat[c] || 0) + share); });
  const seeded = { v: unit(centroid), n: 1, labels: { [`r:${room}`]: 3 }, room, saves: 0, mores: 0 };
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

// Interest x quality for every work. Flat typed arrays keep this fast at 100k+ works.
export const scoreAll = (index, profile) => {
  const { n, dim, emb, quality } = index;
  const out = new Float32Array(n);
  const flat = (list) => Float32Array.from(list.flatMap((c) => c.v));
  const pos = flat(profile.cents);
  const neg = flat(profile.negs);
  const kp = profile.cents.length;
  const kn = profile.negs.length;
  const best = (cs, k, base) => {
    let m = -1;
    for (let c = 0; c < k; c++) {
      let s = 0;
      const o = c * dim;
      for (let d = 0; d < dim; d++) s += cs[o + d] * emb[base + d];
      if (s > m) m = s;
    }
    return m / 127;
  };
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
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    const p = kp ? best(pos, kp, base) : 0;
    const interest = sigmoid(5 * (p - 0.25 - 0.6 * (kn ? dislike(base) : 0)));
    out[i] = interest * (1 + quality[i] / 250);
  }
  return out;
};

const rowCos = (emb, dim, a, b) => {
  let s = 0;
  for (let d = 0; d < dim; d++) s += emb[a * dim + d] * emb[b * dim + d];
  return s / (127 * 127);
};

// Best m untaken works of one category, by score.
const topInCategory = (index, scores, catCode, taken, m) => {
  const best = [];
  for (let i = 0; i < index.n; i++) {
    if (index.cat[i] !== catCode || taken(index.ids[i])) continue;
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
const explore = (index, catCode, taken, rng, exclude) => {
  let pick = null;
  for (let t = 0; t < EXPLORE_SAMPLE; t++) {
    const i = Math.floor(rng() * index.n);
    if (index.cat[i] !== catCode || exclude.has(i) || taken(index.ids[i]) || index.quality[i] < EXPLORE_MIN_QUALITY) continue;
    if (!pick || index.quality[i] > index.quality[pick]) pick = i;
  }
  return pick;
};

// Next work: choose the category furthest below its share in the recent window, then the best work in it.
export const pickNext = ({ index, profile, scores, taken, shown, rng, only = null }) => { // only: category ids to draw from, or null
  const ids = index.categories.map((c) => c.id);
  const share = shares(profile, ids);
  const recent = shown.slice(-WINDOW).map((id) => index.cat[index.posOf(id)]);
  const deficit = ids.map((id, k) => [k, share[id] - (recent.length ? recent.filter((c) => c === k).length / recent.length : 0) + rng() * JITTER]);
  deficit.sort((a, b) => b[1] - a[1]);
  const last = shown.slice(-RECENT).map((id) => index.posOf(id));
  for (const [k] of only ? deficit.filter(([k]) => only.includes(ids[k])) : deficit) {
    const list = topInCategory(index, scores, k, taken, TOP_M);
    if (!list.length) continue;
    if (shown.length >= 2 && rng() < EXPLORE_RATE) {
      const i = explore(index, k, taken, rng, new Set(list.map(([p]) => p)));
      if (i !== null) return { pos: i, id: index.ids[i], category: ids[k], share: share[ids[k]], exploring: true };
    }
    const value = ([i, s]) => s + rng() * JITTER - MMR_LAMBDA * (last.length ? Math.max(...last.map((j) => rowCos(index.emb, index.dim, i, j))) : 0);
    const [pos] = list.map((e) => [e[0], value(e)]).reduce((a, b) => (b[1] > a[1] ? b : a));
    return { pos, id: index.ids[pos], category: ids[k], share: share[ids[k]], exploring: false };
  }
  return null;
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
