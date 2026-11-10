// Decides which clusters to download. Pure: no network, no storage; randomness is injected.
//
// A cluster is a group of similar works (about 128). The client holds the cluster directory (centroids,
// per-category counts, mean quality) and fetches only the clusters it needs: the ones nearest its
// interests, enough works per category to honour the category mix, and a few random ones (decoys and
// serendipity). The server sees file requests only, never a profile.

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

const WANT_PER_CATEGORY = 300; // works to have in memory per category when it has an equal share
const MIN_WANT = 100;

// Interest of a cluster: same curve as work scoring, times mean quality.
const priority = (info, j, profile, rng) => {
  const { dim, cent } = info;
  const best = (list) => list.reduce((m, c) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += c.v[d] * cent[j * dim + d];
    return Math.max(m, s);
  }, -1);
  const pos = profile.cents.length ? best(profile.cents) : 0;
  const neg = profile.negs.length ? best(profile.negs) : -1;
  const interest = sigmoid(5 * (pos - 0.25 - 0.6 * Math.max(0, neg - 0.3)));
  return interest * (1 + info.quality[j] / 250) + rng() * 0.02;
};

// Returns cluster ids (not indices) to fetch, best first.
export const planClusters = ({ info, profile, shares, categories, loaded, want, explore, maxNew, rng, must = [] }) => {
  const k = info.ids.length;
  const have = categories.map(() => 0);
  info.ids.forEach((id, j) => { if (loaded.has(id)) info.counts[j].forEach((n, c) => { have[c] += n; }); });
  const chosen = [];
  const taken = new Set();
  must.forEach((id) => { // clusters a tag filter needs, whatever the interests say
    const j = info.ids.indexOf(id);
    if (j >= 0 && !loaded.has(id) && !taken.has(j) && chosen.length < maxNew) { taken.add(j); chosen.push(j); }
  });
  const order = Array.from({ length: k }, (_, j) => [j, priority(info, j, profile, rng)]).sort((a, b) => b[1] - a[1]);
  categories.forEach((cat, c) => {
    const goal = Math.max(MIN_WANT, Math.round(want * categories.length * (shares[cat.id] ?? 1 / categories.length)));
    for (const [j] of order) {
      if (have[c] >= goal || chosen.length >= maxNew) break;
      if (loaded.has(info.ids[j]) || taken.has(j) || !info.counts[j][c]) continue;
      taken.add(j);
      chosen.push(j);
      info.counts[j].forEach((n, cc) => { have[cc] += n; });
    }
  });
  const pool = order.filter(([j]) => !loaded.has(info.ids[j]) && !taken.has(j));
  for (let e = 0; e < explore && pool.length && chosen.length < maxNew + explore; e++) {
    const i = Math.floor(rng() * pool.length);
    chosen.push(pool[i][0]);
    pool.splice(i, 1);
  }
  return chosen.map((j) => info.ids[j]);
};
