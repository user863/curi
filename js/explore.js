// Explore wall: which works to show a reader who is browsing, not following the feed. Pure: randomness is injected.
//
// Follows the score of the ranking design, s(w) = q(w) [0.45 f(w) + 0.20 v(w) + 0.25 theta(w) + 0.10 c(w)] - fatigue(w):
//   q quality prior, f best interest match (dislikes included), v match to this session's picks,
//   theta Thompson draw over the work's attributes (category, room), c crowd prior, fatigue repeats within the wall.
// A term with no data (v without picks, c until crowd priors ship) drops out and the others share its weight.
// With no profile theta is a uniform draw, so a new reader gets quality with variety; the draw narrows as evidence grows.
import { beta, draw, scoreAll } from './rank.js';

export { beta };

const WEIGHT = { f: 0.45, v: 0.2, theta: 0.25, c: 0.1 };
const POOL_PER_SOURCE = 150;
const POOL = 400; // best by score that selection chooses from
const DIVERSITY = 0.15; // pull away from works already chosen
const COLD_DIVERSITY = 0.3; // with no interests yet, variety matters more: the reader is being sounded out
const NEAR = 0.8; // only close to a chosen work counts (cosine above this)
const WILDCARD_EVERY = 6; // one pick in six ignores interests: the best quality that is far from them
const SOURCE_MOST = 4; // per page
const CREATOR_MOST = 2;
const NO_CREATOR = 0xffff;
const MONO = 0.45; // quality factor of a monochrome picture: discouraged, not hidden

// Score of every work: terms known for this reader, combined as in the design. Works in `skip` score -Infinity.
// index: the catalog's typed arrays plus `categories` and `rooms` (id lists) to name the attribute values.
export const exploreScores = ({ index, profile, rng, session, crowd, skip }) => {
  const { n, dim, emb, quality, cat, room, flags } = index;
  const taste = scoreAll(index, profile); // interest x quality, dislikes inside
  const roomDraw = index.rooms?.map((r) => draw(profile, `r:${r}`, rng));
  const catDraw = index.categories?.map((c) => draw(profile, `k:${c.id ?? c}`, rng));
  const parts = { f: profile.cents.length > 0, v: Boolean(session), theta: true, c: Boolean(crowd) };
  const total = Object.entries(parts).reduce((s, [k, on]) => s + (on ? WEIGHT[k] : 0), 0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (skip?.(i)) { out[i] = -Infinity; continue; }
    const q = Math.max(0.1, Math.min(1, quality[i] / 250)) * (flags?.[i] & 1 ? MONO : 1); // the quality byte is a percentile among peers
    let s = 0;
    if (parts.f) s += WEIGHT.f * (taste[i] / (1 + quality[i] / 250)); // scoreAll multiplied quality in
    if (parts.v) {
      let d = 0;
      for (let k = 0; k < dim; k++) d += session[k] * emb[i * dim + k];
      s += WEIGHT.v * Math.max(0, d / 127);
    }
    s += WEIGHT.theta * ((roomDraw?.[room[i]] ?? 0.5) + (catDraw?.[cat[i]] ?? 0.5)) / 2;
    if (parts.c) s += WEIGHT.c * crowd[i];
    out[i] = (q * s) / total;
  }
  return out;
};

const cos = (emb, dim, a, b) => {
  let s = 0;
  for (let d = 0; d < dim; d++) s += emb[a * dim + d] * emb[b * dim + d];
  return s / (127 * 127);
};

// Chooses `count` rows: best score first, each later one penalised for being close to those chosen (fatigue),
// source and creator capped per page, and every few picks a wildcard. Returns row positions in display order.
export const compose = ({ index, scores, count, rng, profile }) => {
  const { dim, emb, source, creator, quality } = index;
  // Best-scored works, at most POOL_PER_SOURCE from each source, so the caps below have something to choose from.
  const ranked = Array.from({ length: index.n }, (_, i) => i).filter((i) => scores[i] !== -Infinity).sort((a, b) => scores[b] - scores[a]);
  const perSource = new Map();
  const pool = [];
  for (const i of ranked) {
    if (pool.length >= POOL) break;
    const k = perSource.get(source?.[i]) ?? 0;
    if (k >= POOL_PER_SOURCE) continue;
    perSource.set(source?.[i], k + 1);
    pool.push(i);
  }
  const chosen = [];
  const sources = new Map();
  const creators = new Map();
  const allowed = (i) => (sources.get(source?.[i]) ?? 0) < SOURCE_MOST && (!creator || creator[i] === NO_CREATOR || (creators.get(creator[i]) ?? 0) < CREATOR_MOST);
  const note = (i) => {
    chosen.push(i);
    sources.set(source?.[i], (sources.get(source?.[i]) ?? 0) + 1);
    if (creator && creator[i] !== NO_CREATOR) creators.set(creator[i], (creators.get(creator[i]) ?? 0) + 1);
  };
  const interest = profile.cents.length ? scoreAll(index, profile) : null;
  const median = interest ? [...pool].map((i) => interest[i]).sort((a, b) => a - b)[Math.floor(pool.length / 2)] : 0;
  const taken = new Set();
  while (chosen.length < count && chosen.length < pool.length) {
    const wild = (chosen.length + 1) % WILDCARD_EVERY === 0;
    const valueOf = (i) => (wild && interest ? quality[i] + rng() : scores[i] - (interest ? DIVERSITY : COLD_DIVERSITY) * Math.max(0, chosen.reduce((m, c) => Math.max(m, cos(emb, dim, i, c)), 0) - NEAR) / (1 - NEAR));
    // caps first; when nothing satisfies them (few sources or creators), the best remaining
    const fits = (i) => !taken.has(i) && !(wild && index.flags?.[i] & 1) && (!wild || !interest || interest[i] <= median);
    let candidates = pool.filter((i) => fits(i) && allowed(i));
    if (!candidates.length) candidates = pool.filter((i) => !taken.has(i));
    const best = candidates.reduce((b, i) => (valueOf(i) > valueOf(b) ? i : b));
    taken.add(best);
    note(best);
  }
  return chosen;
};

// Hero cards: which galleries to feature. A gallery is scored like a work: quality times the reader's interest in its
// mean vector, plus a Thompson-style jitter that shrinks as interests accumulate; picks are kept apart from each other.
export const pickGalleries = ({ galleries, profile, count, rng, exclude = new Set() }) => {
  const pool = galleries.filter((g) => !exclude.has(g.s));
  const jitter = 0.35 / (1 + profile.cents.length);
  const scored = pool.map((g) => {
    const match = profile.cents.length ? Math.max(...profile.cents.map((c) => c.v.reduce((s, x, d) => s + x * g.v[d], 0) / 127)) : 0;
    const taste = profile.cents.length ? 1 / (1 + Math.exp(-5 * (match - 0.25))) : 0.5;
    return { g, value: (0.25 + 0.75 * (g.q / 250)) * (0.4 + taste) + jitter * rng() };
  });
  const chosen = [];
  while (chosen.length < count && scored.length) {
    let best = 0;
    let bestValue = -Infinity;
    scored.forEach((x, k) => {
      const near = chosen.reduce((m, c) => Math.max(m, c.g.v.reduce((s, v, d) => s + v * x.g.v[d], 0) / (127 * 127)), 0);
      const value = x.value - 0.5 * Math.max(0, near - 0.5);
      if (value > bestValue) { bestValue = value; best = k; }
    });
    chosen.push(scored.splice(best, 1)[0]);
  }
  return chosen.map((x) => x.g);
};
