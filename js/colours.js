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

// Search by a colour typed as hex: "#e85d9a", "#e5a" or a bare six digits that contain a digit (so "decade" stays a word).
// Returns { hex, rest } with the hex taken out of the query, or null.
export const parseHex = (query) => {
  const m = /(?:^|\s)(#[0-9a-f]{6}|#[0-9a-f]{3}|(?=[0-9a-f]*\d)[0-9a-f]{6})(?=\s|$)/i.exec(String(query ?? ''));
  if (!m) return null;
  let h = m[1].replace('#', '').toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return { hex: `#${h}`, rest: String(query).replace(m[1], ' ').replace(/\s+/g, ' ').trim() };
};

// The pack's colour column (pipeline/export.py): per work id six bytes, OKLab of its dominant colour and of its most colourful
// one (L u8, a and b i8 over +-0.4). L of 0 means no colour. Returns the works nearest to a colour, closest first.
const AB = 0.4 / 127;
export const nearest = (column, lab, limit = 1500, within = 0.16) => {
  const u = new Uint8Array(column);
  const s = new Int8Array(column);
  const out = [];
  for (let id = 0; id * 6 + 5 < u.length; id++) {
    const o = id * 6;
    if (!u[o]) continue;
    const d1 = Math.hypot(u[o] / 255 - lab[0], s[o + 1] * AB - lab[1], s[o + 2] * AB - lab[2]);
    const d2 = u[o + 3] ? Math.hypot(u[o + 3] / 255 - lab[0], s[o + 4] * AB - lab[1], s[o + 5] * AB - lab[2]) * 1.25 : Infinity; // the accent counts a little less
    const d = Math.min(d1, d2);
    if (d <= within) out.push({ id, d });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, limit);
};
