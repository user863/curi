import { loadCatalog } from '../../js/catalog.js';

// The pack is served next to the app. Shard file names carry a content hash, so a cached response never goes stale
// and is kept in the Cache API. Only the manifest is re-fetched; offline, the last copy is used.
const BASE = `${process.env.EXPO_BASE_URL ?? ''}/data/pack`;
const NAME = 'curi-pack';

const bare = (url: string) => url.split('?')[0];

// Hashed files that no manifest names any more (older packs) are removed, so the cache stays the size of one pack.
const prune = async (cache: Cache, manifestText: string) => {
  const live = new Set(manifestText.match(/[0-9a-f]{10}/g));
  const stale = (await cache.keys()).filter((req) => {
    const hash = req.url.split('.').slice(-2, -1)[0];
    return /^[0-9a-f]{10}$/.test(hash) && !live.has(hash);
  });
  await Promise.all(stale.map((req) => cache.delete(req)));
};

const read = async (url: string) => {
  const key = bare(url);
  const mutable = key.endsWith('/manifest.json');
  const cache = await caches.open(NAME).catch(() => null); // unavailable in some private modes: plain network then
  const stored = await cache?.match(key);
  if (stored && !mutable) return stored;
  try {
    const res = await fetch(key, mutable ? { cache: 'no-cache' } : undefined);
    if (!res.ok) throw new Error(String(res.status));
    if (cache) {
      await cache.put(key, res.clone());
      if (mutable) await prune(cache, await res.clone().text());
    }
    return res;
  } catch (e) {
    if (stored) return stored;
    throw e;
  }
};

export const openCatalog = () => loadCatalog(BASE, read as typeof fetch);
