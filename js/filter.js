// What to show: by type (category) and by tag. Pure; the tag data comes from the pack's tags file.
// postings: tag -> { cluster: [ids] }

// Category shares restricted to the chosen types (none chosen = all), renormalised.
export const restrict = (shares, types) => {
  if (!types.length) return shares;
  const kept = Object.fromEntries(Object.entries(shares).map(([id, s]) => [id, types.includes(id) ? s : 0]));
  const sum = Object.values(kept).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(kept).map(([id, s]) => [id, s / sum]));
};

// Works that carry at least one of the tags; null when no tag is chosen.
export const idsFor = (tags, postings) => (tags.length
  ? new Set(tags.flatMap((t) => Object.values(postings[t] ?? {}).flat()))
  : null);

// Clusters holding those works.
export const clustersFor = (tags, postings) => [...new Set(tags.flatMap((t) => Object.keys(postings[t] ?? {}).map(Number)))];

export const count = (tag, postings) => Object.values(postings[tag] ?? {}).reduce((n, ids) => n + ids.length, 0);

// Only tags that exist in the live data.
export const validTags = (tags, postings) => tags.filter((t) => t in postings);

export const label = (slug) => (slug.startsWith('gallery-') ? `${slug.slice(8).replace(/-/g, ' ')} (gallery)` : slug.replace(/-/g, ' '));

// Tags matching what was typed, best first: word starts before substrings, then by how many works carry them.
export const suggest = (query, postings, chosen, limit = 6) => {
  const q = query.trim().toLowerCase().replace(/-/g, ' ');
  if (!q) return [];
  return Object.keys(postings)
    .filter((t) => !chosen.includes(t))
    .map((t) => {
      const text = label(t).toLowerCase();
      const at = text.indexOf(q);
      return at < 0 ? null : { tag: t, rank: at === 0 || text[at - 1] === ' ' ? 0 : 1, n: count(t, postings) };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || b.n - a.n)
    .slice(0, limit)
    .map((x) => x.tag);
};
