// Client catalog. Holds the cluster directory, loads index shards on demand, and fetches card and
// detail shards per cluster. Shard files are content-addressed, so the HTTP cache keeps them.
import { planClusters } from './plan.js';

const concat = (Type, parts, total) => {
  const out = new Type(total);
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
};

// Index shard, version 2: see pipeline/export.py index_shard.
const parseShard = (buf, dim) => {
  const n = new DataView(buf).getUint32(0, true);
  let o = 4;
  const ids = new Uint32Array(buf, o, n);
  o += 4 * n;
  const cat = new Uint8Array(buf, o, n);
  o += n;
  const room = new Uint8Array(buf, o, n);
  o += n;
  const quality = new Uint8Array(buf, o, n);
  o += n;
  const source = new Uint8Array(buf, o, n);
  o += n + (o + n) % 2;
  const creator = new Uint16Array(buf, o, n);
  o += 2 * n;
  o += (4 - (o % 4)) % 4;
  return { n, ids, cat, room, quality, source, creator, emb: new Int8Array(buf, o, n * dim) };
};

export const loadCatalog = async (base = 'data/pack') => {
  const stats = { bytes: 0, requests: 0 };
  const get = async (url, as) => {
    const res = await fetch(url);
    stats.requests += 1;
    if (as === 'json') {
      const text = await res.text();
      stats.bytes += text.length;
      return JSON.parse(text);
    }
    const buf = await res.arrayBuffer();
    stats.bytes += buf.byteLength;
    return buf;
  };

  const manifest = await get(`${base}/manifest.json?rev=${Date.now() >> 14}`, 'json'); // revalidate every few minutes
  const { clusters: cl, dim } = manifest;
  const centBytes = new Int8Array(await get(`${base}/${cl.centroids}`));
  const cent = new Float32Array(centBytes.length);
  for (let j = 0; j < cl.ids.length; j++) {
    let n = 0;
    for (let d = 0; d < dim; d++) n += centBytes[j * dim + d] ** 2;
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < dim; d++) cent[j * dim + d] = centBytes[j * dim + d] / n;
  }
  const info = { ids: cl.ids, dim, cent, counts: cl.counts, quality: cl.quality };
  const slot = new Map(cl.ids.map((id, j) => [id, j]));
  const blocked = new Set(manifest.tombstones);

  // The index: all loaded shards concatenated. Same object, rebuilt in place when shards arrive.
  const view = {
    manifest, dim, categories: manifest.categories, rooms: manifest.rooms, blocked, stats, info,
    n: 0, version: 0, ids: new Uint32Array(0), cat: new Uint8Array(0), room: new Uint8Array(0),
    quality: new Uint8Array(0), source: new Uint8Array(0), creator: new Uint16Array(0), emb: new Int8Array(0),
  };
  const loaded = new Map(); // cluster id -> shard
  const inflight = new Map();
  let pos = new Map();
  let owner = new Map(); // work id -> cluster id

  const rebuild = () => {
    const parts = [...loaded.entries()];
    const total = parts.reduce((s, [, p]) => s + p.n, 0);
    view.n = total;
    view.ids = concat(Uint32Array, parts.map(([, p]) => p.ids), total);
    view.cat = concat(Uint8Array, parts.map(([, p]) => p.cat), total);
    view.room = concat(Uint8Array, parts.map(([, p]) => p.room), total);
    view.quality = concat(Uint8Array, parts.map(([, p]) => p.quality), total);
    view.source = concat(Uint8Array, parts.map(([, p]) => p.source), total);
    view.creator = concat(Uint16Array, parts.map(([, p]) => p.creator), total);
    view.emb = concat(Int8Array, parts.map(([, p]) => p.emb), total * dim);
    pos = new Map();
    owner = new Map();
    parts.forEach(([c, p]) => p.ids.forEach((id) => owner.set(id, c)));
    view.ids.forEach((id, i) => pos.set(id, i));
    view.version += 1;
  };

  const loadIndex = (c) => {
    if (loaded.has(c)) return null;
    if (!inflight.has(c)) {
      inflight.set(c, get(`${base}/idx/${c}.${cl.idx[slot.get(c)]}.bin`).then((buf) => {
        loaded.set(c, parseShard(buf, dim));
        inflight.delete(c);
      }));
    }
    return inflight.get(c);
  };

  let tagsOnce = null;
  const searchShards = new Map();
  const shards = new Map();
  const shard = (dir, c) => {
    const key = `${dir}/${c}`;
    if (!shards.has(key)) shards.set(key, get(`${base}/${dir}/${c}.${cl[dir][slot.get(c)]}.json`, 'json'));
    return shards.get(key);
  };

  Object.assign(view, {
    posOf: (id) => pos.get(id) ?? -1,
    clusterOf: (id) => owner.get(id),
    isBlocked: (id) => blocked.has(id),
    loadedWorks: () => view.n,
    loadedClusters: () => loaded.size,

    // Fetch the clusters the plan asks for. Returns how many were loaded.
    ensureClusters: async ({ profile, shares, want, explore = 0, maxNew = 12, rng = Math.random, must = [] }) => {
      const wanted = planClusters({ info, profile, shares, categories: manifest.categories, loaded: new Set(loaded.keys()), want, explore, maxNew, rng, must });
      if (!wanted.length) return 0;
      await Promise.all(wanted.map(loadIndex));
      rebuild();
      return wanted.length;
    },

    // One file of the word index, named by its two first letters; {} when no word starts with them.
    searchShard: (key) => {
      const hash = manifest.search?.[key];
      if (!hash) return Promise.resolve({});
      if (!searchShards.has(key)) searchShards.set(key, get(`${base}/search/${key}.${hash}.json`, 'json'));
      return searchShards.get(key);
    },

    // Tag vocabulary and postings (tag -> { cluster: [ids] }), fetched once when the filter is first used.
    loadTags: () => {
      tagsOnce ??= manifest.tags ? get(`${base}/${manifest.tags}`, 'json') : Promise.resolve({});
      return tagsOnce;
    },

    // Cards and detail: (id, cluster) pairs. Cluster is on every card as `cl`, and known for loaded works.
    getCard: async (id, c = owner.get(id)) => (await shard('cards', c))[id],
    getCards: async (pairs) => new Map(await Promise.all(pairs.map(async ([id, c]) => [id, (await shard('cards', c ?? owner.get(id)))[id]]))),
    getDetail: async (id, c = owner.get(id)) => (await shard('detail', c))[id],

    vecOf: (id) => {
      const v = Array.from(view.emb.subarray(pos.get(id) * dim, (pos.get(id) + 1) * dim));
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    },
    roomVec: (r) => {
      const v = manifest.roomCentroids[r];
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    },
  });
  return view;
};
