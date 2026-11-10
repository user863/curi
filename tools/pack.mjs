// Pack access for the tools. Lets js/catalog.js read from disk, and builds one table of every work.
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../js/catalog.js';
import { emptyProfile } from '../js/rank.js';

// fetch stand-in: paths instead of URLs, each file read once. Reads are synchronous, so shards land in the
// order they were asked for and a run repeats exactly.
export const useFiles = () => {
  const cache = new Map();
  const read = (url) => {
    const path = url.split('?')[0];
    if (!cache.has(path)) {
      const b = readFileSync(path);
      cache.set(path, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }
    return cache.get(path);
  };
  globalThis.fetch = async (url) => ({
    arrayBuffer: async () => read(url),
    text: async () => new TextDecoder().decode(read(url)),
  });
};

export const ERAS = ['undated', 'before 1500', '1500 to 1799', '1800 to 1899', '1900 to 1949', '1950 on'];
export const MODERN = 4; // era buckets from here on are post-1900

// Rough year from a display date. Stands in until the pack carries a parsed year.
export const yearOf = (date) => {
  const text = date ?? '';
  const century = /(\d+)(?:st|nd|rd|th) century/.exec(text);
  const plain = /\d{1,4}/.exec(text);
  if (!century && !plain) return null;
  const year = century ? (Number(century[1]) - 1) * 100 + 50 : Number(plain[0]);
  return /\bBCE?\b/.test(text) ? -year : year;
};
export const eraOf = (year) => (year === null ? 0 : year < 1500 ? 1 : year < 1800 ? 2 : year < 1900 ? 3 : year < 1950 ? 4 : 5);

const NOBODY = /^(|unknown.*|anonymous.*|anonym.*|unidentified.*|unbekannt.*|desconegut|okänd|various.*)$/;
export const creatorKey = (name) => {
  const key = (name ?? '').trim().toLowerCase();
  return NOBODY.test(key) ? null : key;
};

// Every work in one index (row order of `index`), with the fields the metrics need from the card shards.
export const loadWorld = async (dir) => {
  useFiles();
  const index = await loadCatalog(dir);
  await index.ensureClusters({ profile: emptyProfile(), shares: {}, want: Infinity, maxNew: Infinity, rng: mulberry(0) }); // seeded: a fixed row order
  const { n, dim, manifest, info } = index;
  const k = info.ids.length;
  const slotOf = new Map(info.ids.map((id, j) => [id, j]));
  const source = new Uint16Array(n);
  const creator = new Int32Array(n).fill(-1);
  const era = new Uint8Array(n);
  const cluster = new Uint16Array(n);
  const length = new Float32Array(n); // seconds of a film or audio excerpt, else 0
  const cards = new Array(n); // what rank.learn reads from a card
  const sources = new Map();
  const creators = new Map();
  const idOf = (map, key) => map.get(key) ?? map.set(key, map.size).get(key);
  info.ids.forEach((cl, j) => {
    const shard = JSON.parse(readFileSync(`${dir}/cards/${cl}.${manifest.clusters.cards[j]}.json`, 'utf8'));
    Object.values(shard).forEach((c) => {
      const p = index.posOf(c.n);
      const who = creatorKey(c.creator);
      source[p] = idOf(sources, c.source.institution);
      creator[p] = who === null ? -1 : idOf(creators, who);
      era[p] = eraOf(yearOf(c.date));
      cluster[p] = j;
      length[p] = c.media?.end != null ? c.media.end - c.media.start : 0;
      cards[p] = { cat: c.cat, editorial: { room: c.editorial.room, tags: c.editorial.tags } };
    });
  });

  // Cosine of every work to every cluster centroid: the hidden tastes of simulated readers live in this space.
  const cos = new Float32Array(n * k);
  for (let p = 0; p < n; p++) {
    const base = p * dim;
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += index.emb[base + d] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += index.emb[base + d] * info.cent[j * dim + d];
      cos[p * k + j] = s / norm;
    }
  }
  return { dir, index, n, k, dim, slotOf, source, creator, era, cluster, length, cards, cos, sources: sources.size, creators: creators.size };
};

// Seeded randomness for the tools: the same seed gives the same run.
export const mulberry = (seed) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const mixSeed = (a, b) => (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) | 0;
