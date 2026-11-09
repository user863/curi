import { loadCatalog } from './catalog.js';
import { load, save as persist, hasBit, withBit } from './store.js';
import { pickNext, scoreAll, shares, learn, withRoom, forgetInterest, emptyProfile, explain } from './rank.js';
import * as V from './views.js';
import * as Captions from './captions.js';
import * as Subtitles from './subtitles.js';

const AHEAD = 2; // cards rendered ahead of the active one
const RETAIN = 4; // cards kept rendered behind it; older ones are released so a long scroll stays light
const ONBOARDING = false; // true: ask which rooms to start from. Off: the feed starts from an even mix
const TAP_MS = 260;
const DWELL_MIN_S = 3;
const UI_HIDE_MS = 4000;
const INTRO_MS = 2600; // controls show at launch, then slide away
const FIRST_WANT = 120; // works per category to have before the first card
const WANT = 300; // works per category to keep loaded (at an equal share)
const EXPLORE_CLUSTERS = 2; // random clusters per fetch: serendipity, and decoys for privacy

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const feed = $('#feed');
const dock = $('#dock');
const bar = $('.bar');
const toastEl = $('#toast');
const wrap = $('#sheet-wrap');
const sheetBody = $('#sheet-body');
const onboarding = $('#onboarding');

let catalog = null;
let state = load();
let shown = []; // { card, n, reason, el } in feed order
const shownIds = new Set();
let endEl = null;
let active = null;
let activeSince = 0;
let lastFocus = null;
let currentSheet = null; // () => html (or Promise), re-rendered after edits
let epoch = 0; // bumped when feedback invalidates cards that were ranked but not yet shown

const update = (patch) => {
  state = { ...state, ...patch };
  persist(state);
};

const categoryIds = () => catalog.categories.map((c) => c.id);

// Scores depend only on the interests, so they are recomputed only when those change.
let scoreCache = { key: '', scores: null };
const scoresNow = () => {
  const key = `${state.profile.ver}:${catalog.version}`; // interests changed, or more works loaded
  if (scoreCache.key !== key) scoreCache = { key, scores: scoreAll(catalog, state.profile) };
  return scoreCache.scores;
};

const mix = () => shares(state.profile, categoryIds());
const grow = (opts = {}) => catalog.ensureClusters({ profile: state.profile, shares: mix(), want: WANT, explore: EXPLORE_CLUSTERS, ...opts })
  .catch((e) => console.error(e));

const rank = () => pickNext({
  index: catalog,
  profile: state.profile,
  scores: scoresNow(),
  taken: (id) => hasBit(state.seen, id) || catalog.isBlocked(id) || shownIds.has(id),
  shown: shown.map((s) => s.n),
  rng: Math.random,
});

/* ---------- chrome (hidden by default) ---------- */

let uiTimer;
let intro = true; // the first card opens with the controls showing
const setUi = (on, ms = UI_HIDE_MS) => {
  clearTimeout(uiTimer);
  app.classList.toggle('ui', on);
  if (on) uiTimer = setTimeout(() => setUi(false), ms);
};
const toggleUi = () => setUi(!app.classList.contains('ui'));

/* ---------- media ---------- */

let sound = true; // video and audio play with sound; the dock toggles it
const mutedByBrowser = new WeakSet(); // autoplay with sound was refused: playing muted until the next tap
const mediaOf = (el) => el.querySelector('video, audio');
const bounds = (el) => [Number(el.dataset.start), Number(el.dataset.end)];

const syncPlayButton = (el, on) => el.querySelector('.play')?.setAttribute('aria-pressed', String(on));

// Plays the excerpt window [start, end] of the source file. Video loops it; audio stops at the end.
const wireMedia = (el, media) => {
  const [start, end] = bounds(el);
  const bar2 = el.querySelector('.track i');
  const wait = (on) => { el.dataset.wait = on ? 'yes' : 'no'; };
  let retried = false;
  media.addEventListener('error', () => {
    const fallback = media.dataset.fallback;
    if (fallback && !retried) { // lighter or alternative file from the pipeline
      retried = true;
      media.src = fallback;
      media.load();
      if (el === active) syncMedia(el);
      return;
    }
    wait(false);
    const note = el.querySelector('.failed');
    note.hidden = false;
    if (media.error) note.dataset.code = media.error.code;
  });
  media.addEventListener('loadedmetadata', () => {
    if (media.currentTime < start || media.currentTime >= end) media.currentTime = start;
  });
  media.addEventListener('waiting', () => wait(true));
  media.addEventListener('playing', () => wait(false));
  media.addEventListener('pause', () => wait(false));
  media.addEventListener('timeupdate', () => {
    if (media.currentTime >= end - 0.05) {
      media.currentTime = start;
      if (media.tagName === 'AUDIO') media.pause();
    }
    if (bar2) bar2.style.transform = `scaleX(${Math.min(1, Math.max(0, (media.currentTime - start) / (end - start)))})`;
  });
  media.addEventListener('ended', () => { media.currentTime = start; });
  media.addEventListener('play', () => syncPlayButton(el, true));
  media.addEventListener('pause', () => syncPlayButton(el, false));
};

const inWindow = (el, media) => {
  const [start, end] = bounds(el);
  return media.currentTime >= start && media.currentTime < end - 0.05;
};

const playFrom = (el, media) => {
  if (!inWindow(el, media)) media.currentTime = bounds(el)[0];
  el.dataset.wait = 'yes';
  return media.play();
};

// Only the active card plays, with sound. If the browser refuses sound before any tap, video plays muted and a tap unmutes it.
const syncMedia = (el) => {
  feed.querySelectorAll('video, audio').forEach((m) => { if (m !== mediaOf(el)) m.pause(); });
  const m = el && mediaOf(el);
  if (!m) return;
  m.preload = 'auto';
  m.muted = !sound;
  playFrom(el, m).catch(() => {
    el.dataset.wait = 'no';
    if (m.tagName !== 'VIDEO') return; // audio waits for a tap
    mutedByBrowser.add(m);
    m.muted = true;
    m.play().catch(() => {});
  });
};

// Film and audio on the next cards start buffering at their excerpt, so they begin as soon as the card arrives.
const PRELOAD_AHEAD = 2;
const warmNext = () => {
  shown.slice(activeIndex() + 1, activeIndex() + 1 + PRELOAD_AHEAD).forEach((s) => {
    const m = mediaOf(s.el);
    if (!m || m.preload === 'auto') return;
    m.preload = 'auto';
    if (m.networkState === HTMLMediaElement.NETWORK_EMPTY) m.load(); // starts the fetch; loadedmetadata seeks to the excerpt
  });
};

// One tap: pause or play. Returns true when it is now playing.
const togglePlay = (el) => {
  const m = el && mediaOf(el);
  if (!m) return false;
  if (mutedByBrowser.has(m)) { // first tap after a refused autoplay: bring the sound in
    mutedByBrowser.delete(m);
    m.muted = !sound;
    return true;
  }
  if (!m.paused) { m.pause(); return false; }
  m.muted = !sound;
  playFrom(el, m).catch(() => { el.dataset.wait = 'no'; });
  return true;
};

const toggleSound = () => {
  sound = !sound;
  const m = active && mediaOf(active);
  if (m) { m.muted = !sound; mutedByBrowser.delete(m); }
  syncDock();
};

/* ---------- captions (iOS app: on-device speech recognition) ---------- */

const wantsCaptions = (card) =>
  (card.type === 'video' || card.type === 'audio') && !card.editorial.tags.includes('music');

const wantCaptions = () => {
  if (!Captions.available) return;
  const from = activeIndex();
  const list = shown.slice(from, from + 1 + AHEAD).filter((s) => wantsCaptions(s.card)).slice(0, 2);
  list.forEach((s) => { if (s.el.dataset.type === 'audio' && !Captions.stateOf(s.card.id)) s.el.dataset.cc = 'pending'; });
  Captions.want(list.map((s) => ({
    id: s.card.id, url: s.card.media.url, fallback: s.card.media.fallback || '', start: s.card.media.start, end: s.card.media.end,
  })), (id) => {
    const entry = shown.find((s) => s.card.id === id);
    if (entry && !entry.el.dataset.gone) Subtitles.render(entry.el, Captions.stateOf(id));
  });
};

// Follows the playing media so captions and the reader stay on the spoken line.
const follow = () => {
  const m = active && mediaOf(active);
  if (m && !m.paused) Subtitles.tick(active, m.currentTime);
  requestAnimationFrame(follow);
};

/* ---------- feed ---------- */

const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.intersectionRatio >= 0.6 && activate(e.target)),
  { root: feed, threshold: [0.6] },
);

const build = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const el = tpl.content.firstElementChild;
  const img = el.querySelector('img.art');
  if (img) {
    const ready = () => img.classList.add('ready');
    if (img.complete && img.naturalWidth) ready();
    else img.addEventListener('load', ready, { once: true });
    img.addEventListener('error', () => { el.querySelector('.failed').hidden = false; }, { once: true });
  }
  const media = mediaOf(el);
  if (media) wireMedia(el, media);
  return el;
};

const mount = (html) => {
  const el = build(html);
  feed.append(el);
  io.observe(el);
  return el;
};

// A released card keeps its place (same height) but frees its image or media.
const release = (entry) => {
  const stub = document.createElement('section');
  stub.className = 'card';
  Object.assign(stub.dataset, { gone: 'yes', id: entry.card.id, type: entry.card.type, tone: entry.card.editorial.tone });
  entry.el.querySelectorAll('video, audio').forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });
  io.unobserve(entry.el);
  entry.el.replaceWith(stub);
  io.observe(stub);
  return { ...entry, el: stub };
};

// Scrolled back to a released card: draw it again; the observer then activates the new element.
const revive = (stub) => {
  const entry = shown.find((s) => s.el === stub);
  if (!entry) return;
  const el = build(V.cardHtml(entry.card));
  io.unobserve(stub);
  stub.replaceWith(el);
  io.observe(el);
  shown = shown.map((s) => (s === entry ? { ...s, el } : s));
};

const releaseBehind = () => {
  const keep = activeIndex() - RETAIN;
  shown = shown.map((s, i) => (i < keep && !s.el.dataset.gone ? release(s) : s));
};

const unmount = (el) => {
  io.unobserve(el);
  el.remove();
};

const appendEnd = () => {
  endEl = mount(V.endCardHtml(shown.length, state.saved.length));
};

// Ranks and mounts the next card. Returns 'yes' | 'no' (an end card was added) | 'stale' (feedback arrived meanwhile).
const appendNext = async () => {
  const stamp = epoch;
  let pick = rank();
  if (!pick && (await catalog.ensureClusters({ profile: state.profile, shares: mix(), want: Infinity, maxNew: 4 }))) pick = rank();
  if (!pick && state.seen.length) {
    update({ seen: new Uint8Array(0) }); // every work seen once: start a new pass
    pick = rank();
  }
  if (!pick) {
    appendEnd();
    return 'no';
  }
  const card = await catalog.getCard(pick.id);
  if (stamp !== epoch) return 'stale';
  const reason = { ...explain(state.profile, card, catalog.vecOf(pick.id), pick.exploring), category: pick.category, share: pick.share };
  const el = mount(V.cardHtml(card));
  shown = [...shown, { card, n: pick.id, reason, el }];
  shownIds.add(pick.id);
  warmNext();
  return 'yes';
};

const activeIndex = () => {
  const i = shown.findIndex((s) => s.el === active);
  return i >= 0 ? i : active ? shown.length - 1 : 0; // on the end card: after the last
};

let chain = Promise.resolve();
const fillAhead = () => {
  chain = chain.then(async () => {
    while (!endEl && shown.length - 1 - activeIndex() < AHEAD) {
      if ((await appendNext()) === 'no') break;
    }
  }).catch((e) => console.error(e));
  return chain;
};

// After feedback: drop the pre-ranked cards below the active one and rank them again.
const refillAhead = () => {
  if (endEl && active === endEl) return chain;
  epoch += 1;
  const idx = activeIndex();
  shown.slice(idx + 1).forEach((s) => { unmount(s.el); shownIds.delete(s.n); });
  shown = shown.slice(0, idx + 1);
  if (endEl) { unmount(endEl); endEl = null; }
  return fillAhead();
};

const cardOf = (el) => shown.find((s) => s.el === el);

const syncDock = () => {
  const entry = cardOf(active);
  dock.hidden = !entry;
  if (!entry) return;
  const on = state.saved.includes(entry.n);
  const btn = dock.querySelector('[data-act="save"]');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? 'Saved' : 'Save';
  const soundBtn = dock.querySelector('[data-act="sound"]');
  soundBtn.hidden = entry.card.type !== 'video' && entry.card.type !== 'audio';
  soundBtn.textContent = sound ? 'Mute' : 'Sound';
};

const syncSaved = () => {
  $('#saved-count').textContent = state.saved.length ? `(${state.saved.length})` : '';
  syncDock();
};

const finishDwell = () => {
  const entry = cardOf(active);
  if (!entry) return;
  const seconds = (performance.now() - activeSince) / 1000;
  if (seconds >= DWELL_MIN_S) update({ profile: learn(state.profile, entry.card, 'dwell', null, seconds) });
};

const activate = (el) => {
  if (el === active) return;
  if (el.dataset.gone) return revive(el);
  finishDwell();
  active = el;
  activeSince = performance.now();
  app.dataset.tone = el.dataset.tone;
  setUi(intro, INTRO_MS);
  intro = false;
  const entry = cardOf(el);
  if (entry && !hasBit(state.seen, entry.n)) update({ seen: withBit(state.seen, entry.n) });
  syncDock();
  fillAhead();
  releaseBehind();
  syncMedia(el);
  warmNext();
  wantCaptions();
};

const scrollToNext = (el) => el.nextElementSibling?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/* ---------- actions ---------- */

let toastTimer;
const toast = (msg, ms = 1600) => {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
};

const learnFrom = (entry, event) => {
  update({ profile: learn(state.profile, entry.card, event, catalog.vecOf(entry.n)) });
  grow(); // interests moved: fetch the clusters now nearest to them
};

const toggleSave = (addOnly = false) => {
  const entry = cardOf(active);
  if (!entry) return;
  const has = state.saved.includes(entry.n);
  if (has && addOnly) return;
  update({
    saved: has ? state.saved.filter((n) => n !== entry.n) : [...state.saved, entry.n],
    savedCl: { ...state.savedCl, [entry.n]: entry.card.cl }, // remembers which shard holds the card
  });
  if (!has) learnFrom(entry, 'save');
  syncSaved();
  toast(has ? 'Removed' : 'Saved');
  if (!has) refillAhead();
};

const feedback = (event, message) => {
  const entry = cardOf(active);
  if (!entry) return;
  learnFrom(entry, event);
  toast(message);
  const refilled = refillAhead();
  if (event === 'less') {
    setUi(false);
    refilled.then(() => setTimeout(() => scrollToNext(entry.el), 150));
  }
};

const ring = (el, e) => {
  const box = el.getBoundingClientRect();
  const dot = document.createElement('span');
  dot.className = 'ring';
  dot.style.left = `${e.clientX - box.left}px`;
  dot.style.top = `${e.clientY - box.top}px`;
  el.append(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
};

const startOver = async () => {
  epoch += 1;
  shown.forEach((s) => unmount(s.el));
  shown = [];
  shownIds.clear();
  active = null;
  update({ seen: new Uint8Array(0) });
  if (endEl) unmount(endEl);
  endEl = null;
  await fillAhead();
  shown[0]?.el.scrollIntoView({ block: 'start' });
};

const withDetail = (card, d = {}) => ({
  ...card,
  source: { ...card.source, ...d.source },
  rights: { ...card.rights, ...d.rights },
  media: card.media || d.media ? { ...card.media, ...d.media } : undefined,
});

const noteSheet = (card) => async () => V.noteSheetHtml(withDetail(card, await catalog.getDetail(card.n, card.cl)));

const openNote = () => {
  const entry = cardOf(active);
  if (!entry) return;
  learnFrom(entry, 'note');
  openSheet(noteSheet(entry.card));
};

const openWhy = () => {
  const entry = cardOf(active);
  if (entry) openSheet(() => V.whySheetHtml(entry.card, entry.reason, catalog.rooms, catalog.categories));
};

const act = (name) => {
  switch (name) {
    case 'save': return toggleSave();
    case 'more': return feedback('more', 'More like this');
    case 'less': return feedback('less', 'Fewer like this');
    case 'note': return openNote();
    case 'why': return openWhy();
    case 'sound': return toggleSound();
    case 'play': return togglePlay(active);
  }
};

// Taps. On film and audio: one plays or pauses (and a pause brings up the controls), two save.
// On everything else: one reveals the controls, two save.
const isMedia = (el) => el.dataset.type === 'video' || el.dataset.type === 'audio';
let lastTap = { t: 0, el: null };
let tapTimer;
const onTap = (el, e) => {
  if (el.dataset.type === 'end') return;
  const now = performance.now();
  const double = lastTap.el === el && now - lastTap.t < TAP_MS;
  if (isMedia(el)) {
    const playing = togglePlay(el); // immediate; a double tap toggles twice, so it ends where it began
    if (double) {
      lastTap = { t: 0, el: null };
      toggleSave(true);
      ring(el, e);
    } else {
      lastTap = { t: now, el };
      setUi(!playing);
    }
    return;
  }
  if (double) {
    clearTimeout(tapTimer);
    lastTap = { t: 0, el: null };
    toggleSave(true);
    ring(el, e);
    return;
  }
  lastTap = { t: now, el };
  tapTimer = setTimeout(toggleUi, TAP_MS);
};

// A tap on a transcript line jumps there.
const seekTo = (el, line) => {
  const m = mediaOf(el);
  if (!m) return;
  m.currentTime = Number(line.dataset.t);
  m.muted = !sound;
  if (m.paused) playFrom(el, m).catch(() => {});
};

feed.addEventListener('click', (e) => {
  const el = e.target.closest('.card');
  if (!el || e.target.closest('a')) return;
  const btn = e.target.closest('button[data-act]');
  if (btn?.dataset.act === 'more-session') return startOver();
  if (btn?.dataset.act === 'play') return setUi(!togglePlay(el));
  const line = e.target.closest('.reader p[data-t]');
  if (line) return seekTo(el, line);
  if (!btn) onTap(el, e);
});

dock.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  act(btn.dataset.act);
  if (app.classList.contains('ui')) setUi(true); // keep it up while in use
});

feed.addEventListener('scroll', () => setUi(false), { passive: true });

/* ---------- sheets ---------- */

const setInert = (on) => [feed, bar, dock].forEach((n) => { n.inert = on; });

const openSheet = async (render) => {
  setUi(false);
  lastFocus = document.activeElement;
  currentSheet = render;
  sheetBody.innerHTML = '';
  wrap.hidden = false;
  setInert(true);
  $('#sheet .close').focus();
  sheetBody.innerHTML = await render();
};

const rerenderSheet = async (focusSel) => {
  sheetBody.innerHTML = await currentSheet();
  if (focusSel) $('#sheet').querySelector(focusSel)?.focus();
};

const closeSheet = () => {
  wrap.hidden = true;
  currentSheet = null;
  setInert(false);
  lastFocus?.focus?.();
};

const savedSheet = async () => {
  const cards = await catalog.getCards(state.saved.map((n) => [n, state.savedCl[n]]));
  return V.savedSheetHtml(state.saved.map((n) => cards.get(n)).filter(Boolean));
};
const interestsSheet = () => V.interestsSheetHtml(state.profile, catalog.rooms, mix(), catalog.categories);
const swapSheet = (render) => {
  currentSheet = render;
  return rerenderSheet('.close');
};

const changeProfile = (profile, focusSel) => {
  update({ profile });
  grow();
  refillAhead();
  return rerenderSheet(focusSel);
};

wrap.addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]')) return closeSheet();
  const room = e.target.closest('[data-room]');
  if (room) {
    const r = room.dataset.room;
    const on = room.getAttribute('aria-pressed') !== 'true';
    return changeProfile(withRoom(state.profile, r, on, catalog.roomVec(r), catalog.manifest.roomCategories[r]), `[data-room="${r}"]`);
  }
  const gone = e.target.closest('[data-forget]');
  if (gone) {
    const [kind, i] = gone.dataset.forget.split(':');
    return changeProfile(forgetInterest(state.profile, kind, Number(i)));
  }
  const open = e.target.closest('[data-open]');
  if (open) return swapSheet(async () => {
    const n = Number(open.dataset.open);
    return noteSheet(await catalog.getCard(n, state.savedCl[n]))();
  });
  const unsave = e.target.closest('[data-unsave]');
  if (unsave) {
    update({ saved: state.saved.filter((n) => n !== Number(unsave.dataset.unsave)) });
    syncSaved();
    return rerenderSheet();
  }
  const btn = e.target.closest('[data-act]');
  if (btn?.dataset.act === 'open-interests') return swapSheet(interestsSheet);
  if (btn?.dataset.act === 'reset') {
    if (btn.dataset.armed !== 'yes') {
      btn.dataset.armed = 'yes';
      btn.textContent = 'Tap again to confirm';
      return;
    }
    update({ seen: new Uint8Array(0) });
    return changeProfile(emptyProfile());
  }
});

$('#btn-saved').addEventListener('click', () => openSheet(savedSheet));
$('#btn-interests').addEventListener('click', () => openSheet(interestsSheet));

const KEYS = { s: 'save', m: 'more', l: 'less', n: 'note', w: 'why', p: 'play' };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !wrap.hidden) return closeSheet();
  if (!wrap.hidden || !onboarding.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('button, a') && (e.key === 'Enter' || e.key === ' ')) return;
  const page = feed.clientHeight;
  if (['ArrowDown', 'PageDown', 'j'].includes(e.key)) { e.preventDefault(); feed.scrollBy({ top: page, behavior: 'smooth' }); }
  else if (['ArrowUp', 'PageUp', 'k'].includes(e.key)) { e.preventDefault(); feed.scrollBy({ top: -page, behavior: 'smooth' }); }
  else if (e.key === 'u') toggleUi();
  else if (KEYS[e.key]) act(KEYS[e.key]);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    finishDwell();
    feed.querySelectorAll('video, audio').forEach((m) => m.pause());
  } else if (active) syncMedia(active);
  activeSince = performance.now();
});

/* ---------- onboarding ---------- */

const showOnboarding = async () => {
  onboarding.innerHTML = V.onboardingHtml(catalog.rooms, catalog.manifest.roomSamples);
  onboarding.hidden = false;
  const start = $('#start');
  const picked = () => [...onboarding.querySelectorAll('.tile[aria-pressed="true"]')].map((t) => t.dataset.room);
  onboarding.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (tile) {
      tile.setAttribute('aria-pressed', String(tile.getAttribute('aria-pressed') !== 'true'));
      start.disabled = picked().length < 2;
    } else if (e.target === start) {
      const profile = picked().reduce((p, r) => withRoom(p, r, true, catalog.roomVec(r), catalog.manifest.roomCategories[r]), state.profile);
      update({ profile, onboarded: 'yes' });
      start.disabled = true;
      begin();
    } else if (e.target.id === 'skip') {
      update({ onboarded: 'no' });
      begin();
    }
  });
};

const begin = async () => {
  await grow({ want: FIRST_WANT, explore: 0 }); // just enough for the first cards
  onboarding.hidden = true;
  onboarding.innerHTML = '';
  await fillAhead();
  grow(); // then fill out the rest in the background
};

/* ---------- init ---------- */

const init = async () => {
  catalog = await loadCatalog();
  app.classList.toggle('cc', Captions.available);
  requestAnimationFrame(follow);
  syncSaved();
  if (ONBOARDING && state.onboarded === 'unknown') await showOnboarding();
  else await begin();
};

// For debugging bandwidth: commonplaceStats() in the console.
window.commonplaceStats = () => ({ ...catalog.stats, works: catalog.n, clusters: catalog.loadedClusters(), total: catalog.manifest.count });

init();
