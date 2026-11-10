// The grid views (Discover and Saved): every work as a small card, laid out in columns by the picture's shape,
// scrolling on without end. Cards are fetched a cluster at a time and pictures a screenful at a time, so a query
// that matches thousands of works still costs only what has been scrolled to.
import * as Search from './search.js';
import { esc } from './views.js';

const PAGE = 24; // tiles added per step
const PRELOAD_TIMEOUT_MS = 7000;
const GLYPH = { video: '▶', audio: '♪', passage: '“' };

const preload = (url) => new Promise((resolve) => {
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  const timer = setTimeout(() => { img.src = ''; resolve(null); }, PRELOAD_TIMEOUT_MS);
  img.onload = () => { clearTimeout(timer); resolve(img); };
  img.onerror = () => { clearTimeout(timer); resolve(null); };
  img.src = url;
});

const pictureOf = (c) => (c.type === 'image' ? c.media.url : c.type === 'video' || c.type === 'audio' ? c.media?.poster : null);
const line = (c) => [c.type === 'passage' ? c.title : c.creator === 'Unknown' ? '' : c.creator, c.date].filter(Boolean).join(', ');

const tileHtml = (c, img, removable) => {
  const tile = `
  <button type="button" class="hit" data-show="${c.n}" data-cl="${c.cl}" data-tone="${esc(c.editorial.tone)}" data-type="${c.type}">
    ${img ? `<img src="${esc(img.src)}" alt="" referrerpolicy="no-referrer" decoding="async" draggable="false">`
      : c.type === 'passage' ? `<span class="quote">${esc(c.text.body.slice(0, 160))}…</span>`
        : `<span class="glyph" aria-hidden="true">${GLYPH[c.type] ?? ''}</span>`}
    ${c.type === 'video' && img ? '<span class="badge" aria-hidden="true">▶</span>' : ''}
    <span class="cap"><strong>${esc(c.type === 'passage' ? c.creator : c.title)}</strong><span>${esc(line(c))}</span></span>
  </button>`;
  return removable
    ? `<div class="hitbox">${tile}<button type="button" class="unsave" data-unsave="${c.n}" aria-label="Remove ${esc(c.title)} from saved">×</button></div>`
    : tile;
};

// Columns that fill with tiles. `start(supply)` begins a run: supply(alive) resolves with the next cards to show
// (empty when there are no more); a newer run, or clear(), supersedes one still loading.
const createGrid = ({ scroller, columnsEl, sentinel, onBroken, removable = false }) => {
  let run = 0;
  let busyRun = null;
  let supply = null;

  const columns = () => [...columnsEl.children];
  const shortest = () => columns().reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));

  const layout = () => {
    const n = Math.max(2, Math.floor(columnsEl.clientWidth / 170));
    if (columns().length !== n) columnsEl.innerHTML = '<div class="col"></div>'.repeat(n);
  };

  const more = async () => {
    if (!supply || busyRun === run) return;
    const stamp = run;
    busyRun = stamp;
    try {
      do {
        const batch = await supply(() => stamp === run);
        if (stamp !== run || !batch.length) break;
        const loaded = await Promise.all(batch.map(async (c) => [c, pictureOf(c) ? await preload(pictureOf(c)) : null]));
        if (stamp !== run) break;
        loaded.forEach(([c, img]) => {
          if (c.type === 'image' && !img) return onBroken?.(c.n); // an image its source will not serve is left out
          const holder = document.createElement('div');
          holder.innerHTML = tileHtml(c, img, removable).trim();
          shortest().append(holder.firstElementChild);
        });
        // keep going while the end is on screen (a short first page)
      } while (sentinel.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom + 400);
    } finally {
      if (busyRun === stamp) busyRun = null;
    }
  };

  const clear = () => {
    run += 1;
    supply = null;
    layout();
    columns().forEach((c) => { c.innerHTML = ''; });
    scroller.scrollTop = 0;
  };

  const start = (next) => {
    supply = next;
    return more();
  };

  const stop = () => { run += 1; };

  new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { root: scroller, rootMargin: '600px' }).observe(sentinel);
  return { clear, start, stop, layout };
};

// Discover: search over the word index. With nothing typed, popular tags to start from.
export const createSearchView = ({ root, catalog, onPick, onBroken, setInert, onClose, hints }) => {
  const input = root.querySelector('#search-input');
  const note = root.querySelector('#search-note');
  const scroller = root.querySelector('#search-scroll');
  const columnsEl = root.querySelector('#search-columns');
  const hintsEl = root.querySelector('#search-hints');
  const grid = createGrid({ scroller, columnsEl, sentinel: root.querySelector('#search-sentinel'), onBroken });
  let latest = 0; // a newer query supersedes one still loading
  let queue = []; // cards fetched but not yet shown
  let clusters = []; // [cluster, ids] still to fetch, most hits first
  let timer;

  const fetchMore = async (alive) => {
    while (queue.length < PAGE && clusters.length) {
      const [cl, ids] = clusters.shift();
      const cards = [...(await catalog().getCards(ids.map((id) => [id, cl]))).values()].filter(Boolean);
      if (!alive()) return;
      queue.push(...cards.sort((a, b) => b.editorial.quality - a.editorial.quality));
    }
  };
  const supply = async (alive) => {
    await fetchMore(alive);
    return alive() ? queue.splice(0, PAGE) : [];
  };

  const query = async (text) => {
    const stamp = (latest += 1);
    queue = [];
    clusters = [];
    grid.clear();
    hintsEl.hidden = Boolean(text.trim());
    if (!text.trim()) {
      note.textContent = '';
      return;
    }
    const hits = await Search.find(text, catalog().searchShard);
    if (stamp !== latest) return;
    note.textContent = hits.length ? `${hits.length.toLocaleString()} found` : 'Nothing found.';
    const byCluster = hits.reduce((m, h) => m.set(h.cl, [...(m.get(h.cl) ?? []), h.id]), new Map());
    clusters = [...byCluster.entries()].sort((a, b) => b[1].length - a[1].length);
    await grid.start(supply);
  };

  let hinted = false;
  const showHints = async () => {
    if (hinted) return;
    hinted = true;
    const words = await hints().catch(() => []);
    hintsEl.innerHTML = words.map((w) => `<button type="button" data-q="${esc(w)}">${esc(w)}</button>`).join('');
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => query(input.value), 220);
  });
  hintsEl.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (!q) return;
    input.value = q;
    query(q);
  });
  root.querySelector('#search-close').addEventListener('click', () => onClose());
  columnsEl.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-show]');
    if (hit) onPick(Number(hit.dataset.show), Number(hit.dataset.cl));
  });

  const open = () => {
    root.hidden = false;
    setInert(true);
    grid.layout();
    showHints();
    input.focus();
  };
  const close = () => {
    root.hidden = true;
    setInert(false);
    grid.stop(); // stop anything still loading; the results stay for when it is opened again
  };
  return { open, close, isOpen: () => !root.hidden };
};

// Saved: the saved works, newest first, in the same layout; a cross takes one out.
export const createSavedView = ({ root, catalog, saved, onPick, onUnsave, setInert, onClose }) => {
  const note = root.querySelector('#saved-note');
  const columnsEl = root.querySelector('#saved-columns');
  const grid = createGrid({ scroller: root.querySelector('#saved-scroll'), columnsEl, sentinel: root.querySelector('#saved-sentinel'), removable: true });
  let waiting = []; // [n, cluster] not yet fetched
  let total = 0;

  const label = () => { note.textContent = total ? `${total.toLocaleString()} saved` : 'Nothing saved yet. Double-tap a card to save it.'; };

  const supply = async (alive) => {
    const pairs = waiting.splice(0, PAGE);
    if (!pairs.length) return [];
    const cards = await catalog().getCards(pairs);
    return alive() ? pairs.map(([n]) => cards.get(n)).filter(Boolean) : [];
  };

  root.querySelector('#saved-close').addEventListener('click', () => onClose());
  columnsEl.addEventListener('click', (e) => {
    const gone = e.target.closest('[data-unsave]');
    if (gone) {
      onUnsave(Number(gone.dataset.unsave));
      gone.closest('.hitbox').remove();
      total -= 1;
      label();
      return;
    }
    const hit = e.target.closest('[data-show]');
    if (hit) onPick(Number(hit.dataset.show), Number(hit.dataset.cl));
  });

  const open = () => {
    root.hidden = false;
    setInert(true);
    waiting = saved();
    total = waiting.length;
    label();
    grid.clear();
    grid.start(supply);
  };
  const close = () => {
    root.hidden = true;
    setInert(false);
    grid.clear();
  };
  return { open, close, isOpen: () => !root.hidden };
};
