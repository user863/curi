import { loadCatalog } from './catalog.js';
import { load, save as persist, hasBit, withBit } from './store.js';
import { pickNext, scoreAll, shares, learn, withRoom, forgetInterest, emptyProfile, explain } from './rank.js';
import * as V from './views.js';
import * as Captions from './captions.js';
import * as Subtitles from './subtitles.js';
import * as Filter from './filter.js';
import { createSearchView, createSavedView } from './search-view.js';

const AHEAD = 2; // cards rendered ahead of the active one
const RETAIN = 4; // cards kept rendered behind it; older ones are released so a long scroll stays light
const ONBOARDING = false; // true: ask which rooms to start from. Off: the feed starts from an even mix
const TAP_MS = 260;
const DWELL_MIN_S = 3;
const SKIP_S = 1.2; // scrolled past before this: a weak no
const SWIPE_PX = 70; // sideways drag that counts: left is fewer like this, right is more
const SKIP_SECONDS = 10; // double tap on the left or right third of a film or recording
const HOLD_MS = 350; // hold the left third for double speed
const FAST_RATE = 2;
const FINISH_SHARE = 0.8; // stayed for this much of an excerpt: a weak yes
const UI_HIDE_MS = 4000;
const INTRO_MS = 2600; // controls show at launch, then slide away
const FIRST_WANT = 120; // works per category to have before the first card
const WANT = 300; // works per category to keep loaded (at an equal share)
const PRELOAD_TIMEOUT_MS = 7000; // a picture slower than this is skipped for now
const EXPLORE_CLUSTERS = 2; // random clusters per fetch: serendipity, and decoys for privacy

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const feed = $('#feed');
const dock = $('#dock');
const tools = $('#tools');
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
const slow = new Set(); // works that timed out or failed to play this session: skipped, but not remembered
let dragging = false; // a card is being swiped: what shows through underneath must not become active
let judged = false; // the card just left was judged by a swipe
let epoch = 0; // bumped when feedback invalidates cards that were ranked but not yet shown

const update = (patch) => {
  state = { ...state, ...patch };
  persist(state);
};

const filtering = () => state.filter.types.length > 0 || state.filter.tags.length > 0;
const categoryIds = () => catalog.categories.map((c) => c.id);

// Scores depend only on the interests, so they are recomputed only when those change.
let scoreCache = { key: '', scores: null };
const scoresNow = () => {
  const key = `${state.profile.ver}:${catalog.version}`; // interests changed, or more works loaded
  if (scoreCache.key !== key) scoreCache = { key, scores: scoreAll(catalog, state.profile) };
  return scoreCache.scores;
};

// Tag filter: the works that carry a chosen tag, and the clusters holding them (null / [] when no tag is chosen).
let postings = null; // tag -> { cluster: [ids] }, loaded the first time the filter or a saved tag filter needs it
let allowedIds = null;
let tagClusters = [];
const refreshTags = () => {
  allowedIds = postings ? Filter.idsFor(state.filter.tags, postings) : null;
  tagClusters = postings ? Filter.clustersFor(state.filter.tags, postings) : [];
};

const mix = () => Filter.restrict(shares(state.profile, categoryIds()), state.filter.types);
const grow = (opts = {}) => catalog.ensureClusters({ profile: state.profile, shares: mix(), want: WANT, explore: tagClusters.length ? 0 : EXPLORE_CLUSTERS, must: tagClusters, ...opts })
  .catch((e) => console.error(e));

// Categories to draw from: the chosen types, or none (all). temp: the very first card is always an artwork if images are allowed.
const onlyTypes = () => {
  const types = state.filter.types;
  if (shown.length === 0 && (!types.length || types.includes('visual'))) return ['visual'];
  return types.length ? types : null;
};

const rank = () => pickNext({
  index: catalog,
  profile: state.profile,
  scores: scoresNow(),
  taken: (id) => hasBit(state.seen, id) || catalog.isBlocked(id) || shownIds.has(id) || hasBit(state.bad, id) || slow.has(id) || (allowedIds !== null && !allowedIds.has(id)),
  shown: shown.map((s) => s.n),
  rng: Math.random,
  only: onlyTypes(),
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

let sound = true; // video and audio play with sound; the tools toggle it
const mutedByBrowser = new WeakSet(); // autoplay with sound was refused: playing muted until the next tap
const mediaOf = (el) => el.querySelector('video, audio');
const bounds = (el) => [Number(el.dataset.start), Number(el.dataset.end)];

const syncPlayButton = (el, on) => el.querySelector('.play')?.setAttribute('aria-pressed', String(on));

// Plays the excerpt window [start, end] of the source file. Video loops it; audio stops at the end.
const wireMedia = (el, media) => {
  const [start, end] = bounds(el);
  const fill = el.querySelector('.scrub i');
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
    const entry = shown.find((s) => s.el === el);
    console.warn('media error', el.dataset.id, media.error?.code, media.error?.message ?? '', String(media.currentSrc).slice(-60));
    if (entry) slow.add(entry.n);
    if (entry && shown.indexOf(entry) > activeIndex()) return dropAhead(entry); // not seen yet: it never appears
    const note = el.querySelector('.failed');
    note.hidden = false;
    if (media.error) note.dataset.code = media.error.code;
    if (el === active) setTimeout(() => { if (el === active) scrollToNext(el); }, 1800); // on screen: move on
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
    if (fill && !scrubbing) fill.style.transform = `scaleX(${Math.min(1, Math.max(0, (media.currentTime - start) / (end - start)))})`;
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
  syncTools();
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
  (entries) => { if (!dragging) entries.forEach((e) => e.isIntersecting && e.intersectionRatio >= 0.6 && activate(e.target)); },
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
  paint(el, entry.card);
  io.unobserve(stub);
  stub.replaceWith(el);
  io.observe(el);
  shown = shown.map((s) => (s === entry ? { ...s, el } : s));
};

const releaseBehind = () => {
  const keep = activeIndex() - RETAIN;
  shown = shown.map((s, i) => (i < keep && !s.el.dataset.gone ? release(s) : s));
};

/* ---------- card colour: the palette tone, or the colour of the picture ---------- */

const BAR_VARS = [['--bar-bg', 'barBg'], ['--bar-fg', 'barFg'], ['--bar-inv', 'barInv']];

const paintBar = (el) => {
  app.dataset.tone = el.dataset.tone;
  BAR_VARS.forEach(([v, key]) => (el.dataset[key] ? app.style.setProperty(v, el.dataset[key]) : app.style.removeProperty(v)));
};

const paint = (el, card) => {
  const free = state.colour === 'image' && card.sw;
  el.dataset.tone = free ? 'swatch' : card.editorial.tone;
  if (free) {
    const c = V.swatchColours(card.sw);
    el.style.cssText = c.card;
    Object.assign(el.dataset, { barBg: c.barBg, barFg: c.barFg, barInv: c.barInv });
  } else {
    el.removeAttribute('style');
    BAR_VARS.forEach(([, key]) => delete el.dataset[key]);
  }
  if (el === active) paintBar(el);
};

// A card below the current one that turned out unplayable is removed before anyone sees it.
const dropAhead = (entry) => {
  shownIds.add(entry.n);
  shown = shown.filter((s) => s !== entry);
  unmount(entry.el);
  fillAhead();
};

const unmount = (el) => {
  io.unobserve(el);
  el.remove();
};

const appendEnd = () => {
  endEl = mount(V.endCardHtml(shown.length, state.saved.length));
};

// Ranks and mounts the next card. Returns 'yes' | 'no' (an end card was added) | 'stale' (feedback arrived meanwhile).
// Loads a picture before its card exists, so a card that cannot show its picture never reaches the feed.
// -> 'yes' | 'broken' (the source refuses it) | 'slow'
const preloadImage = (url) => new Promise((resolve) => {
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  const timer = setTimeout(() => { img.src = ''; resolve('slow'); }, PRELOAD_TIMEOUT_MS);
  img.onload = () => { clearTimeout(timer); resolve('yes'); };
  img.onerror = () => { clearTimeout(timer); resolve('broken'); };
  img.src = url;
});

let firstCard;
const firstShown = new Promise((resolve) => { firstCard = resolve; });

// Local event log (js/log.js): what was shown and what the reader did, kept on this device only.
// The module loads after the first card; until then `events` holds this launch's events.
let Log = null;
let events = [];
let logTimer;
const emit = (kind, n = 0, cl = 0, value = 0) => {
  const e = [Math.round(Date.now() / 1000), kind, n, cl, value];
  events = Log ? Log.push(events, e) : [...events, e];
  if (!Log) return;
  clearTimeout(logTimer);
  logTimer = setTimeout(() => Log.write(localStorage, events), 2000);
};
firstShown.then(() => import('./log.js')).then((m) => {
  events = events.reduce((all, e) => m.push(all, e), m.read(localStorage));
  Log = m;
}).catch((e) => console.error(e));

const appendNext = async () => {
  const stamp = epoch;
  let pick = rank();
  if (!pick && (await catalog.ensureClusters({ profile: state.profile, shares: mix(), want: Infinity, maxNew: 4, must: tagClusters }))) pick = rank();
  if (!pick && state.seen.length && !filtering()) {
    update({ seen: new Uint8Array(0) }); // every work seen once: start a new pass
    pick = rank();
  }
  if (!pick) {
    appendEnd();
    return 'no';
  }
  const card = await catalog.getCard(pick.id);
  if (stamp !== epoch) return 'stale';
  if (card.type === 'image') {
    const verdict = await preloadImage(card.media.url);
    if (stamp !== epoch) return 'stale';
    if (verdict === 'broken') update({ bad: withBit(state.bad, pick.id) });
    if (verdict !== 'yes') {
      slow.add(pick.id);
      return 'skipped';
    }
  }
  const reason = { ...explain(state.profile, card, catalog.vecOf(pick.id), pick.exploring), category: pick.category, share: pick.share };
  const el = mount(V.cardHtml(card));
  paint(el, card);
  shown = [...shown, { card, n: pick.id, reason, el }];
  shownIds.add(pick.id);
  warmNext();
  firstCard();
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

// Sound and full screen are for film and recordings only.
const syncTools = () => {
  const type = cardOf(active)?.card.type;
  const media = type === 'video' || type === 'audio';
  tools.hidden = !media;
  tools.querySelector('[data-act="full"]').hidden = type !== 'video';
  tools.querySelector('[data-act="sound"]').textContent = sound ? 'Mute' : 'Sound';
};

const syncSaved = () => {
  $('#saved-count').textContent = state.saved.length ? String(state.saved.length) : '';
};

const finishDwell = () => {
  const entry = cardOf(active);
  if (!entry) return;
  const seconds = (performance.now() - activeSince) / 1000;
  const m = entry.card.media;
  const length = m ? m.end - m.start : 0;
  const kind = judged ? 'left' : seconds < SKIP_S ? 'skip' : length > 0 && seconds >= FINISH_SHARE * length ? 'finish' : 'dwell';
  judged = false;
  emit(kind, entry.n, entry.card.cl, Math.round(seconds * 10) / 10);
  if (kind === 'skip' || kind === 'finish') update({ profile: learn(state.profile, entry.card, kind, catalog.vecOf(entry.n)) });
  else if (kind === 'dwell' && seconds >= DWELL_MIN_S) update({ profile: learn(state.profile, entry.card, 'dwell', null, seconds) });
};

const activate = (el) => {
  if (el === active) return;
  if (fullEl && el !== fullEl) exitFull();
  if (el.dataset.gone) return revive(el);
  finishDwell();
  active = el;
  activeSince = performance.now();
  paintBar(el);
  setUi(intro, INTRO_MS);
  intro = false;
  const entry = cardOf(el);
  if (entry) emit('show', entry.n, entry.card.cl, entry.reason.kind === 'exploring' ? 1 : 0);
  if (entry && !hasBit(state.seen, entry.n)) update({ seen: withBit(state.seen, entry.n) });
  syncTools();
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
  emit(event, entry.n, entry.card.cl);
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
  if (has) emit('unsave', entry.n, entry.card.cl);
  else learnFrom(entry, 'save');
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

// One sheet for the note, why the card was picked, and its source. Opened by tapping the text under a card.
const openInfo = (el = active) => {
  const entry = cardOf(el);
  if (!entry) return;
  learnFrom(entry, 'note');
  openSheet(async () => V.infoSheetHtml(withDetail(entry.card, await catalog.getDetail(entry.card.n, entry.card.cl)), {
    reason: entry.reason, rooms: catalog.rooms, categories: catalog.categories, gallery: state.sets && isSetCard(entry.el),
  }));
};

const act = (name) => {
  switch (name) {
    case 'save': return toggleSave();
    case 'more': return feedback('more', 'More like this');
    case 'less': return feedback('less', 'Fewer like this');
    case 'info': return openInfo();
    case 'sound': return toggleSound();
    case 'full': return toggleFull();
    case 'play': return togglePlay(active);
  }
};

// Full screen for film: the card fills the screen, turned on its side on a portrait phone. A spacer keeps its place in the feed.
const rotated = () => matchMedia('(orientation: portrait)').matches;
let fullEl = null;
const exitFull = () => {
  if (!fullEl) return;
  fullEl.parentElement.querySelector('[data-full-spacer]')?.remove();
  delete fullEl.dataset.full;
  delete app.dataset.full;
  fullEl = null;
};
const enterFull = (el) => {
  const spacer = document.createElement('section');
  spacer.className = 'card';
  Object.assign(spacer.dataset, { fullSpacer: 'yes', tone: el.dataset.tone });
  el.before(spacer);
  el.dataset.full = 'yes';
  app.dataset.full = 'yes';
  fullEl = el;
  setUi(false);
};
const toggleFull = () => (fullEl ? exitFull() : active?.dataset.type === 'video' && enterFull(active));

// Film and audio: the left third, the middle and the right third of the card.

const zoneOf = (el, e) => {
  const box = el.getBoundingClientRect();
  const x = el.dataset.full && rotated() ? (e.clientY - box.top) / box.height : (e.clientX - box.left) / box.width; // full screen on a portrait phone is turned on its side
  return x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'middle';
};

const flash = (el, cls, text) => {
  const tag = document.createElement('span');
  tag.className = `flash ${cls}`;
  tag.textContent = text;
  el.append(tag);
  tag.addEventListener('animationend', () => tag.remove(), { once: true });
};

// Jump within the excerpt; never past its ends.
const skip = (el, seconds, side) => {
  const m = mediaOf(el);
  if (!m) return;
  const [start, end] = bounds(el);
  m.currentTime = Math.min(end - 0.3, Math.max(start, m.currentTime + seconds));
  flash(el, side, `${seconds < 0 ? '−' : '+'}${Math.abs(seconds)}`);
};

// Hold the right third of a playing film or recording: double speed until let go.
let hold = null;
let suppressClick = false;
const setFast = (el, on) => {
  const m = mediaOf(el);
  if (m) m.playbackRate = on ? FAST_RATE : 1;
  if (on) el.dataset.fast = 'yes';
  else delete el.dataset.fast;
};
const endHold = () => {
  if (!hold) return;
  clearTimeout(hold.timer);
  if (hold.fast) {
    setFast(hold.el, false);
    suppressClick = true; // the release would otherwise count as a tap and pause
    setTimeout(() => { suppressClick = false; }, 400);
  }
  hold = null;
};
feed.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.card');
  if (!el || !isMedia(el) || e.target.closest('button, a, .scrub, .reader p') || zoneOf(el, e) !== 'right') return;
  const m = mediaOf(el);
  if (!m || m.paused) return;
  hold = { el, x: e.clientX, y: e.clientY, fast: false, timer: setTimeout(() => { hold.fast = true; setFast(el, true); }, HOLD_MS) };
});
feed.addEventListener('pointermove', (e) => {
  if (hold && !hold.fast && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 12) endHold(); // a swipe, not a hold
});
['pointerup', 'pointercancel'].forEach((type) => feed.addEventListener(type, endHold));

// Scrub: drag along the timeline to seek within the excerpt.
let scrubbing = false;
const scrubTo = (el, e) => {
  const rail = el.querySelector('.scrub .rail');
  const box = rail.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, el.dataset.full && rotated() ? (e.clientY - box.top) / box.height : (e.clientX - box.left) / box.width));
  const m = mediaOf(el);
  const [start, end] = bounds(el);
  m.currentTime = Math.min(end - 0.3, start + f * (end - start));
  el.querySelector('.scrub i').style.transform = `scaleX(${f})`;
  el.querySelector('.scrub .when').textContent = `${V.fmtTime(f * (end - start))} / ${V.fmtTime(end - start)}`;
  el.querySelector('.scrub').setAttribute('aria-valuenow', String(Math.round(f * 100)));
};
feed.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.scrub');
  if (!bar) return;
  const el = bar.closest('.card');
  scrubbing = true;
  bar.dataset.active = 'yes';
  try { bar.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer: the drag still works while over the bar */ }
  scrubTo(el, e);
});
feed.addEventListener('pointermove', (e) => {
  const bar = e.target.closest('.scrub');
  if (scrubbing && bar) scrubTo(bar.closest('.card'), e);
});
['pointerup', 'pointercancel'].forEach((type) => feed.addEventListener(type, (e) => {
  const bar = e.target.closest('.scrub');
  if (!scrubbing || !bar) return;
  scrubbing = false;
  delete bar.dataset.active;
  setUi(true);
}));

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
      const side = zoneOf(el, e);
      if (side === 'middle') {
        toggleSave(true);
        ring(el, e);
      } else {
        skip(el, side === 'left' ? -SKIP_SECONDS : SKIP_SECONDS, side);
      }
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
  if (!el || e.target.closest('a, .scrub')) return;
  if (suppressClick) { suppressClick = false; return; }
  if (e.target.closest('.cap')) return openInfo(el);
  const btn = e.target.closest('button[data-act]');
  if (btn?.dataset.act === 'more-session') return startOver();
  if (btn?.dataset.act === 'play') return setUi(!togglePlay(el));
  if (btn?.dataset.act === 'exit-full') return exitFull();
  const line = e.target.closest('.reader p[data-t]');
  if (line) return seekTo(el, line);
  if (!btn) onTap(el, e);
});

tools.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  act(btn.dataset.act);
  if (app.classList.contains('ui')) setUi(true); // keep it up while in use
});

// Swipe like cards: drag a card sideways and it follows the finger, the next one shows underneath. Far enough and it
// flies off (left: fewer like this, right: more) and the next card is there; not far enough and it springs back.
let swipe = null;
const clearSwipe = (el, next) => {
  el.style.transition = '';
  el.style.transform = '';
  el.style.zIndex = '';
  delete el.dataset.swiping;
  if (next) { next.style.transform = ''; next.style.zIndex = ''; }
};
const springBack = ({ el, next, tag }) => {
  tag?.remove();
  el.style.transition = 'transform 0.2s ease';
  el.style.transform = '';
  setTimeout(() => { clearSwipe(el, next); dragging = false; }, 220);
};
const flyAway = ({ el, next, tag }, dir) => {
  const entry = cardOf(el);
  learnFrom(entry, dir > 0 ? 'more' : 'less');
  toast(dir > 0 ? 'More like this' : 'Fewer like this');
  el.style.transition = 'transform 0.24s ease-in';
  el.style.transform = `translateX(${dir * 120}%) rotate(${dir * 14}deg)`;
  setTimeout(() => {
    tag?.remove();
    judged = true; // the swipe was the verdict: leaving the card is not a skip
    clearSwipe(el, next);
    next.scrollIntoView({ behavior: 'auto', block: 'start' });
    dragging = false;
    activate(next);
    refillAhead();
  }, 250);
};
feed.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.card');
  swipe = el && el === active && !dragging && !fullEl && el.dataset.type !== 'end' && !el.dataset.set && !e.target.closest('button, a, .scrub, .strip')
    ? { el, x: e.clientX, y: e.clientY, live: false, tag: null, next: null }
    : null;
});
feed.addEventListener('pointermove', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.live) {
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) swipe = null; // the feed is scrolling
    else if (Math.abs(dx) > 14 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      swipe.live = true;
      dragging = true;
      swipe.tag = document.createElement('span');
      swipe.el.append(swipe.tag);
      swipe.next = swipe.el.nextElementSibling;
      swipe.el.dataset.swiping = 'live';
      swipe.el.style.zIndex = '2';
      if (swipe.next) { // the next card waits underneath, in the place of this one
        swipe.next.style.transform = 'translateY(-100%)';
        swipe.next.style.zIndex = '1';
      }
      if (hold) endHold(); // a swipe, not a hold
    }
    if (!swipe?.live) return;
  }
  const more = dx > 0;
  swipe.el.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
  swipe.tag.className = `swipe-tag ${more ? 'more' : 'less'}`;
  swipe.tag.textContent = more ? 'More like this' : 'Fewer like this';
  swipe.tag.style.setProperty('--so', String(Math.min(1, Math.abs(dx) / SWIPE_PX)));
});
feed.addEventListener('pointerup', (e) => {
  const s = swipe;
  swipe = null;
  if (!s?.live) return;
  suppressClick = true; // the end of a swipe is not a tap
  setTimeout(() => { suppressClick = false; }, 400);
  const dx = e.clientX - s.x;
  const far = Math.abs(dx) >= Math.max(SWIPE_PX, s.el.clientWidth * 0.22) && s.el === active;
  if (far && s.next) return flyAway(s, dx > 0 ? 1 : -1);
  springBack(s);
  if (far) feedback(dx > 0 ? 'more' : 'less', dx > 0 ? 'More like this' : 'Fewer like this'); // nothing below to reveal yet
});
feed.addEventListener('pointercancel', () => {
  const s = swipe;
  swipe = null;
  if (s?.live) springBack(s);
});

feed.addEventListener('scroll', () => setUi(false), { passive: true });

/* ---------- sheets ---------- */

const inertFeed = (on) => [feed, bar, tools].forEach((n) => { n.inert = on; }); // behind a full-screen view; the tab bar stays live
const setInert = (on) => [feed, bar, dock, tools].forEach((n) => { n.inert = on; }); // behind a sheet

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

const interestsSheet = () => V.interestsSheetHtml(state.profile, catalog.rooms, mix(), catalog.categories, state.colour, state.sets, state.nav);
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
  const sets = e.target.closest('[data-sets]');
  if (sets) {
    update({ sets: sets.dataset.sets === 'true' });
    return rerenderSheet();
  }
  const nav = e.target.closest('button[data-nav]'); // the app root carries data-nav too
  if (nav) {
    update({ nav: nav.dataset.nav });
    app.dataset.nav = state.nav;
    return rerenderSheet();
  }
  const colour = e.target.closest('[data-colour]');
  if (colour) {
    update({ colour: colour.dataset.colour });
    shown.forEach((s) => { if (!s.el.dataset.gone) paint(s.el, s.card); });
    return rerenderSheet();
  }
  const btn = e.target.closest('[data-act]');
  if (btn?.dataset.act === 'open-interests') return swapSheet(interestsSheet);
  if (btn?.dataset.act === 'open-log' && Log) return swapSheet(() => Log.sheetHtml(events));
  const log = e.target.closest('[data-log]')?.dataset.log;
  if (log === 'copy') {
    $('#sheet .log-dump').select();
    document.execCommand('copy');
    return toast('Copied');
  }
  if (log === 'clear') {
    events = [];
    Log.write(localStorage, events);
    return rerenderSheet();
  }
  if (btn?.dataset.act === 'open-set') {
    const el = active;
    closeSheet();
    return el && openSet(el);
  }
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

$('#btn-saved').addEventListener('click', () => showView(view === 'saved' ? null : 'saved'));
$('#btn-settings').addEventListener('click', () => openSheet(interestsSheet));
dock.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  showView(tab.dataset.tab === 'feed' ? null : tab.dataset.tab);
  if (!view) setUi(true);
});

const KEYS = { s: 'save', m: 'more', l: 'less', n: 'info', w: 'info', i: 'info', p: 'play' };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view) return showView(null);
  if (e.target.matches('input')) return; // typing a tag is not a shortcut
  if (e.key === 'Escape' && fullEl) return exitFull();
  if (e.key === 'Escape' && !wrap.hidden) return closeSheet();
  if (!wrap.hidden || view || !onboarding.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('button, a') && (e.key === 'Enter' || e.key === ' ')) return;
  const page = feed.clientHeight;
  if (['ArrowDown', 'PageDown', 'j'].includes(e.key)) { e.preventDefault(); feed.scrollBy({ top: page, behavior: 'smooth' }); }
  else if (['ArrowUp', 'PageUp', 'k'].includes(e.key)) { e.preventDefault(); feed.scrollBy({ top: -page, behavior: 'smooth' }); }
  else if (e.key === 'u') toggleUi();
  else if (e.key === 'ArrowLeft' && active && isMedia(active)) skip(active, -SKIP_SECONDS, 'left');
  else if (e.key === 'ArrowRight' && active && isMedia(active)) skip(active, SKIP_SECONDS, 'right');
  else if (e.key === 'ArrowLeft') act('less');
  else if (e.key === 'ArrowRight') act('more');
  else if (KEYS[e.key]) act(KEYS[e.key]);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    finishDwell();
    emit('hide');
    Log?.write(localStorage, events);
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
  await Promise.race([fillAhead(), firstShown]); // the first card is ready (its picture loaded); the rest keeps filling
  grow(); // then fill out the rest in the background
};

/* ---------- sets (experimental): more pictures from the same gallery, from a card's info ---------- */

const SET_MAX = 11; // other pictures shown beside the one you were on
const SET_SHARDS = 3; // card files fetched at most, to find them
const galleryOf = (card) => card.editorial.tags.find((t) => t.startsWith('gallery-'));
const isSetCard = (el) => el.dataset.type === 'image' && !el.dataset.gone && Boolean(cardOf(el) && galleryOf(cardOf(el).card));

// Other works of the card's gallery: [id, cluster] pairs, own cluster first so few files are needed.
const setPairs = (entry, found) => {
  const pairs = Object.entries(found[galleryOf(entry.card)] ?? {}).map(([c, ids]) => [Number(c), ids.filter((id) => id !== entry.n)]).filter(([, ids]) => ids.length);
  return pairs.sort((a, b) => (b[0] === entry.card.cl) - (a[0] === entry.card.cl) || b[1].length - a[1].length);
};

const openSet = async (el) => {
  if (!state.sets || !isSetCard(el) || el.dataset.set) return;
  const entry = cardOf(el);
  el.dataset.set = 'loading';
  const pairs = setPairs(entry, await withPostings()).slice(0, SET_SHARDS).flatMap(([c, ids]) => ids.map((id) => [id, c]));
  const found = [...(await catalog.getCards(pairs)).values()].filter((c) => c?.type === 'image');
  const others = found.sort((a, b) => b.editorial.quality - a.editorial.quality).slice(0, SET_MAX);
  if (!others.length) {
    delete el.dataset.set;
    return toast('Nothing more from this gallery');
  }
  const slides = [entry.card, ...others];
  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.innerHTML = slides.map(V.setSlideHtml).join('');
  const count = document.createElement('p');
  count.className = 'set-count';
  const label = () => { count.textContent = `${Math.round(strip.scrollLeft / strip.clientWidth) + 1} / ${strip.children.length}`; };
  strip.addEventListener('scroll', label, { passive: true });
  strip.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.closest('.slide').remove(); label(); }, { once: true }));
  el.append(strip, count);
  el.dataset.set = 'open';
  label();
  requestAnimationFrame(() => strip.scrollTo({ left: strip.clientWidth, behavior: 'smooth' })); // the swipe carries on to the next picture
};

/* ---------- views: discover, saved, chat, profile (the tab bar stays; one at a time) ---------- */

const search = createSearchView({
  root: $('#search'), catalog: () => catalog, setInert: inertFeed, onClose: () => showView(null),
  onPick: (n, cl) => showWork(n, cl),
  onBroken: (n) => update({ bad: withBit(state.bad, n) }),
  hints: async () => {
    const found = await withPostings();
    return Object.keys(found).filter((t) => !t.startsWith('gallery-')).map((t) => [Filter.label(t), Filter.count(t, found)])
      .sort((a, b) => b[1] - a[1]).slice(0, 40).map(([label]) => label);
  },
});

const savedView = createSavedView({
  root: $('#saved'), catalog: () => catalog, setInert: inertFeed, onClose: () => showView(null),
  saved: () => [...state.saved].reverse().map((n) => [n, state.savedCl[n]]),
  onPick: (n, cl) => showWork(n, cl),
  onUnsave: (n) => {
    emit('unsave', n, state.savedCl[n]);
    update({ saved: state.saved.filter((x) => x !== n) });
    syncSaved();
  },
});

const simplePage = (sel) => {
  const root = $(sel);
  return { open: () => { root.hidden = false; inertFeed(true); }, close: () => { root.hidden = true; inertFeed(false); } };
};
const views = { discover: search, saved: savedView, chat: simplePage('#page-chat'), profile: simplePage('#page-profile') };
let view = null;
let leftAt = 0;

const showView = (name) => {
  if (name === view) return;
  const leaving = view === null; // from the feed
  if (view) views[view].close();
  view = name;
  if (name) {
    app.dataset.view = name;
    feed.querySelectorAll('video, audio').forEach((m) => m.pause());
    if (leaving) leftAt = performance.now();
    views[name].open();
  } else {
    delete app.dataset.view;
    activeSince += performance.now() - leftAt; // time away is not time spent on the card
    if (active) syncMedia(active);
  }
  dock.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === (view ?? 'feed');
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
};

// Shows a found work next, right below the one you are on.
const showWork = async (n, cl) => {
  showView(null);
  const there = shown.find((s) => s.n === n && !s.el.dataset.gone);
  if (there) return there.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await catalog.ensureClusters({ profile: state.profile, shares: mix(), want: 0, maxNew: 1, must: [cl] }); // its vector, for learning
  const card = await catalog.getCard(n, cl);
  if (!card) return;
  const el = build(V.cardHtml(card));
  paint(el, card);
  const at = activeIndex();
  (active ?? feed.lastElementChild)?.after(el);
  io.observe(el);
  shown = [...shown.slice(0, at + 1), { card, n, reason: { kind: 'search' }, el }, ...shown.slice(at + 1)];
  shownIds.add(n);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* ---------- filter: type and tag ---------- */

const typesEl = $('#filter-types');
const tagsEl = $('#filter-tags');
const tagInput = $('#tag-input');
const suggestEl = $('#tag-suggest');

const renderFilter = () => {
  const { types, tags } = state.filter;
  typesEl.innerHTML = catalog.categories.map((c) =>
    `<button type="button" data-type="${V.esc(c.id)}" aria-pressed="${types.includes(c.id)}">${V.esc(c.label)}</button>`).join('');
  tagsEl.querySelectorAll('.chip').forEach((c) => c.remove());
  tagInput.before(...tags.map((t) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${V.esc(Filter.label(t))}<button type="button" data-untag="${V.esc(t)}" aria-label="Remove ${V.esc(Filter.label(t))}">×</button>`;
    return chip;
  }));
};

const withPostings = async () => {
  postings ??= await catalog.loadTags();
  return postings;
};

// The filter changed: reload what it needs, re-rank the cards below the current one.
const applyFilter = async (filter) => {
  update({ filter });
  await withPostings();
  refreshTags();
  renderFilter();
  setUi(true);
  epoch += 1;
  await grow({ want: FIRST_WANT });
  await refillAhead();
  toast(filtering() ? 'Filter applied' : 'Showing everything');
};

// A saved filter is checked against the live tags: anything no longer in the data is dropped.
const restoreFilter = async () => {
  if (state.filter.tags.length) {
    await withPostings();
    const tags = Filter.validTags(state.filter.tags, postings);
    if (tags.length !== state.filter.tags.length) update({ filter: { ...state.filter, tags } });
    refreshTags();
  }
  renderFilter();
};

const toggleType = (id) => {
  const has = state.filter.types.includes(id);
  const types = has ? state.filter.types.filter((t) => t !== id) : [...state.filter.types, id];
  return applyFilter({ ...state.filter, types: types.length === catalog.categories.length ? [] : types });
};

const addTag = (tag) => {
  tagInput.value = '';
  suggestEl.hidden = true;
  if (!postings || !(tag in postings) || state.filter.tags.includes(tag)) return; // only tags that exist in the data
  return applyFilter({ ...state.filter, tags: [...state.filter.tags, tag] });
};

const showSuggestions = async () => {
  const found = Filter.suggest(tagInput.value, await withPostings(), state.filter.tags);
  suggestEl.innerHTML = found.map((t) =>
    `<li><button type="button" data-tag="${V.esc(t)}"><span>${V.esc(Filter.label(t))}</span><span class="n">${Filter.count(t, postings)}</span></button></li>`).join('');
  suggestEl.hidden = !found.length;
};

typesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-type]');
  if (btn) toggleType(btn.dataset.type);
});
tagsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-untag]');
  if (btn) applyFilter({ ...state.filter, tags: state.filter.tags.filter((t) => t !== btn.dataset.untag) });
});
suggestEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tag]');
  if (btn) addTag(btn.dataset.tag);
});
tagInput.addEventListener('focus', () => { withPostings().catch(() => {}); });
tagInput.addEventListener('input', showSuggestions);
tagInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const [first] = Filter.suggest(tagInput.value, await withPostings(), state.filter.tags, 1);
  if (first) addTag(first);
});
$('.bar').addEventListener('pointerup', () => { if (app.classList.contains('ui')) setUi(true); }); // in use: keep it up

/* ---------- init ---------- */

const init = async () => {
  emit('start');
  catalog = await loadCatalog();
  app.dataset.nav = state.nav;
  app.classList.toggle('cc', Captions.available);
  await restoreFilter();
  requestAnimationFrame(follow);
  syncSaved();
  if (ONBOARDING && state.onboarded === 'unknown') await showOnboarding();
  else await begin();
};

// For debugging bandwidth: commonplaceStats() in the console.
window.commonplaceStats = () => ({ ...catalog.stats, works: catalog.n, clusters: catalog.loadedClusters(), total: catalog.manifest.count });

init();
