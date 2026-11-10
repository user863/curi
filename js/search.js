// Search over the pack's word index. Pure apart from the shard loader it is given.
// Tokenising must match words() in pipeline/export.py.

const STOP = new Set(['the', 'and', 'of', 'de', 'la', 'le', 'les', 'el', 'del', 'der', 'die', 'das', 'den', 'het', 'een', 'van', 'von', 'und',
  'des', 'du', 'et', 'en', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'an', 'is', 'are', 'was', 'his', 'her', 'its']);

export const tokens = (text) => [...new Set(
  (String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length >= 2 && !STOP.has(w)),
)];

// Works that match the most of the query's words (all of them when any work has them all).
// A word matches a work when one of the work's words starts with it, so results narrow as you type.
// shardOf(key) -> { word: { cluster: [ids] } }. Returns [{ id, cl, n }] with n = matched words.
export const find = async (query, shardOf) => {
  const words = tokens(query);
  if (!words.length) return [];
  const perWord = await Promise.all(words.map(async (w) => {
    const hits = new Map();
    Object.entries((await shardOf(w.slice(0, 2))) ?? {}).forEach(([word, byCluster]) => {
      if (word.startsWith(w)) Object.entries(byCluster).forEach(([cl, ids]) => ids.forEach((id) => hits.set(id, Number(cl))));
    });
    return hits;
  }));
  const score = new Map();
  perWord.forEach((hits) => hits.forEach((cl, id) => score.set(id, { id, cl, n: (score.get(id)?.n ?? 0) + 1 })));
  const all = [...score.values()];
  const best = all.reduce((m, e) => Math.max(m, e.n), 0);
  return all.filter((e) => e.n === best);
};

// The few clusters that hold most hits: their card files are the only ones fetched to show results.
export const topClusters = (hits, limit = 4) => {
  const count = hits.reduce((m, h) => m.set(h.cl, (m.get(h.cl) ?? 0) + 1), new Map());
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([cl]) => cl);
};
