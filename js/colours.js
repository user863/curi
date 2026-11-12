// Colour search: names the pack's colour buckets (pipeline/colour_pack.py) and combines them.
// Pure apart from the bucket file it is given.

// Chip swatches for the colour names; the tone words have no swatch.
export const HUES = {
  red: '#c8403a', orange: '#e08a2c', yellow: '#e3c13a', green: '#5f9a54', teal: '#3a8f94',
  blue: '#3f6fb0', purple: '#7d56a6', pink: '#e3829f', brown: '#7a5a3c', monochrome: '#8a8a8a',
};
export const TONES = ['dark', 'light', 'vivid', 'muted', 'warm', 'cool'];

// buckets: { name: { cluster: [ids] } }. Works in every named bucket: Map id -> cluster.
export const hits = (buckets, names) => {
  const sets = names.map((n) => {
    const m = new Map();
    Object.entries(buckets[n] ?? {}).forEach(([cl, ids]) => ids.forEach((id) => m.set(id, Number(cl))));
    return m;
  });
  if (!sets.length) return new Map();
  const [first, ...others] = sets.sort((a, b) => a.size - b.size);
  return new Map([...first].filter(([id]) => others.every((m) => m.has(id))));
};
