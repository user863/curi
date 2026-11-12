import { Directory, File, Paths } from 'expo-file-system';
import { loadCatalog } from '../../js/catalog.js';

// The pack is served from GitHub Pages. Shard file names carry a content hash, so a cached file never goes stale
// and is kept on disk. Only the manifest is re-fetched; the bundled manifest and centroids are the offline start.
const REMOTE = 'https://user863.github.io/curi/data/pack';
const BUNDLED = `${Paths.bundle.uri.replace(/\/$/, '')}/pack`;
const cache = new Directory(Paths.document, 'pack-cache');

const relative = (url: string) => url.split('?')[0].slice(REMOTE.length + 1);
const wrap = (file: File) => ({ text: () => file.text(), arrayBuffer: () => file.arrayBuffer() });

// Hashed files that no manifest names any more (older packs) are removed, so the cache stays the size of one pack.
const prune = (manifestText: string) => {
  const live = new Set(manifestText.match(/[0-9a-f]{10}/g));
  const walk = (dir: Directory) => dir.list().forEach((entry) => {
    if (entry instanceof Directory) return walk(entry);
    const hash = entry.name.split('.').slice(-2, -1)[0];
    if (/^[0-9a-f]{10}$/.test(hash) && !live.has(hash)) entry.delete();
  });
  try { if (cache.exists) walk(cache); } catch { /* the cache is only a convenience */ }
};

const read = async (url: string) => {
  const rel = relative(url);
  const stored = new File(cache, rel);
  const mutable = rel === 'manifest.json';
  if (!mutable && stored.exists) return wrap(stored);
  try {
    const res = await fetch(`${REMOTE}/${rel}`);
    if (!res.ok) throw new Error(String(res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    stored.parentDirectory.create({ intermediates: true, idempotent: true });
    stored.create({ overwrite: true });
    stored.write(bytes);
    if (mutable) prune(new TextDecoder().decode(bytes));
    return wrap(stored);
  } catch (e) {
    if (stored.exists) return wrap(stored); // offline: the last copy
    const bundled = new File(`${BUNDLED}/${rel}`);
    if (bundled.exists) return wrap(bundled);
    throw e;
  }
};

export const openCatalog = () => loadCatalog(REMOTE, read as unknown as typeof fetch);
