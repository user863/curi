// Pacing: the feed comes in sets of seven cards, each a small arc, with a quiet interlude between sets.
// Pure: no DOM, no storage; randomness is injected. There is no fixed end and no card limit: the interlude is a
// pause, and the next set is composed only when the reader goes past it.
//
// A work entry carries { n, setNo, pos (1..7), plan, outcome }. The next slot follows from the last entry.
import { pickNext } from './rank.js';

export const SET = 7;

// Slot kinds
//   anchor    top taste score: familiar ground
//   familiar  top scores, a different facet from the card before (the ranker's diversity term)
//   stretch   close to a facet but not on it
//   wildcard  a top-decile work from a cluster not shown yet
//   rest      a text, a breath before the peak
//   peak      the best card of the set by taste and quality
export const PLAN = ['anchor', 'familiar', 'stretch', 'familiar', 'wildcard', 'rest', 'peak'];
const CALM = ['anchor', 'familiar', 'stretch', 'rest', 'familiar', 'rest', 'peak']; // long sittings lean toward rest
const CALM_FROM = 3; // fourth set of a sitting

const STRETCH_AT = 0.45; // cosine to the nearest interest that counts as adjacent
const STRETCH_WIDTH = 0.15;
const WILD_QUALITY_RANK = 0.9;
const WILD_SAMPLE = 1500;
const LONG = ['video', 'audio'];

// previous: outcomes of the set just finished ('skip' or anything else), or null.
// More than half skipped: the stretch becomes familiar. Nothing skipped: a second stretch.
export const planFor = ({ sittingSet, previous }) => {
  const base = sittingSet >= CALM_FROM ? CALM : PLAN;
  if (!previous || previous.length < SET) return base;
  const skipped = previous.filter((o) => o === 'skip').length;
  if (skipped * 2 > SET) return base.map((k) => (k === 'stretch' ? 'familiar' : k));
  if (skipped === 0 && base === PLAN) return base.map((k, i) => (i === 3 ? 'stretch' : k));
  return base;
};

// Where the next card goes: after `last` (an entry, or the resumed { setNo, pos, plan }), or the start of a set.
export const nextSlot = (last) => (last && last.pos < SET ? { setNo: last.setNo, pos: last.pos + 1, start: false } : { setNo: (last?.setNo ?? -1) + 1, pos: 1, start: true });

const qualityAt = (index, rng, rank) => {
  const sample = Array.from({ length: Math.min(WILD_SAMPLE, index.n) }, () => index.quality[Math.floor(rng() * index.n)]).sort((a, b) => a - b);
  return sample[Math.floor(sample.length * rank)] ?? 0;
};

// Picks the card for a slot kind. Falls back to the plain ranker when the slot finds nothing, so a set never stalls.
// match: () => Float32Array, cosine to the closest interest per row (js/rank.js matchAll).
export const pickFor = ({ kind, index, profile, scores, match, taken, shown, rng, only = null }) => {
  const codes = index.categories.map((c) => c.id);
  const last = shown.length ? index.posOf(shown[shown.length - 1]) : -1;
  const lastLong = last >= 0 && LONG.includes(codes[index.cat[last]]);
  const longCodes = new Set(codes.map((id, k) => (LONG.includes(id) ? k : -1)).filter((k) => k >= 0));
  const rhythm = lastLong ? (i) => longCodes.has(index.cat[i]) : () => false; // never two film or audio in a row
  const run = (opts) => pickNext({ index, profile, scores, taken, shown, rng, only, extra: rhythm, ...opts });
  const slot = (opts) => run({ relax: false, ...opts });
  const withScores = (f) => slot({ scores: f, explore: 'never' });

  const attempt = (() => {
    switch (kind) {
      case 'stretch': {
        const m = match();
        const bump = Float32Array.from(scores, (s, i) => (profileHas(profile) ? Math.exp(-(((m[i] - STRETCH_AT) / STRETCH_WIDTH) ** 2)) * (1 + index.quality[i] / 250) : s));
        return () => withScores(bump);
      }
      case 'wildcard': {
        const seen = new Set(shown.map((id) => index.clusterOf?.(id)));
        const fresh = index.clusterOf ? (i) => seen.has(index.clusterOf(index.ids[i])) : () => false;
        return () => slot({ explore: 'always', exploreMin: qualityAt(index, rng, WILD_QUALITY_RANK), extra: (i) => rhythm(i) || fresh(i) });
      }
      case 'rest':
        return () => slot({ explore: 'never', only: only === null ? ['text'] : only.includes('text') ? ['text'] : only });
      case 'peak':
        return () => withScores(Float32Array.from(scores, (s, i) => s * (1 + index.quality[i] / 250)));
      default:
        return () => slot({ explore: 'never' });
    }
  })();
  return attempt() ?? run({}) ?? run({ extra: () => false }); // the rhythm rule gives way last: a film-only filter has nothing else to show
};

const profileHas = (profile) => profile.cents.length > 0;
