import { Image } from 'expo-image';
import { peaksFor } from './peaks';
import { scoreAll, matchAll, shares, learn, explain } from '../../js/rank.js';
import { SET, planFor, nextSlot, pickFor } from '../../js/session.js';
import { hasBit, withBit } from '../../js/store.js';
import * as Filter from '../../js/filter.js';
import { getState, update } from './store';

// The feed controller: what is shown, in what order, what the reader did. The same pacing and ranking as the web app
// (js/app.js), without the page: React reads `items()` and tells the controller which card is active.

const AHEAD = 2; // cards ready ahead of the active one
const DWELL_MIN_S = 3;
const SKIP_S = 1.2; // left before this: a weak no
const FINISH_SHARE = 0.8; // stayed for this much of an excerpt: a weak yes
const FIRST_WANT = 120; // works per category to have before the first card
const WANT = 300; // works per category to keep loaded (at an equal share)
const PRELOAD_TIMEOUT_MS = 7000; // a picture slower than this is skipped for now
const EXPLORE_CLUSTERS = 2; // random clusters per fetch: serendipity, and decoys for privacy
const NEW_SITTING_MS = 300000;

export type Entry = { card: any; n: number; reason: any; setNo?: number; pos?: number; plan: string[]; sittingSet: number; outcome: string | null }; // a found work has no place in a set
export type Item =
  | { key: string; kind: 'card'; entry: Entry }
  | { key: 'end'; kind: 'end' };
type Emit = (kind: string, n?: number, cl?: number, value?: number) => void;

const preload = async (url: string): Promise<'yes' | 'slow' | 'broken'> => {
  const timeout = new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), PRELOAD_TIMEOUT_MS));
  const load = Image.prefetch(url).then((ok) => (ok ? 'yes' : 'broken') as 'yes' | 'broken').catch(() => 'broken' as const);
  return Promise.race([load, timeout]);
};

export const createFeed = (catalog: any, emit: Emit) => {
  let shown: Entry[] = [];
  const shownIds = new Set<number>();
  let ended = false;
  let activeKey: string | null = null;
  let activeSince = 0;
  let awayAt = 0;
  let judged = false; // the card just left was judged by a swipe
  const slow = new Set<number>(); // timed out or failed to play this session: skipped, but not remembered
  let resumed: any = getState().session ? { ...getState().session, pos: SET } : null; // a launch starts a new set, never the tail of an old one
  const sitting = { start: Date.now(), firstSet: null as number | null };
  let epoch = 0; // bumped when feedback invalidates cards that were ranked but not yet shown
  let version = 0;
  let cached: Item[] = [];
  const listeners = new Set<() => void>();
  let postings: any = null;
  let allowedIds: Set<number> | null = null;
  let tagClusters: number[] = [];
  let scoreCache: { key: string; scores: Float32Array | null; match: Float32Array | null } = { key: '', scores: null, match: null };
  let chain: Promise<unknown> = Promise.resolve();

  const state = () => getState();
  const changed = () => {
    version += 1;
    cached = shown.map((entry): Item => ({ key: entry.card.id, kind: 'card', entry }));
    if (ended) cached = [...cached, { key: 'end', kind: 'end' }];
    listeners.forEach((l) => l());
  };

  const lastEntry = () => [...shown].reverse().find((s) => s.setNo !== undefined) ?? resumed;
  const filtering = () => state().filter.types.length > 0 || state().filter.tags.length > 0;
  const categoryIds = () => catalog.categories.map((c: any) => c.id);

  // Scores depend only on the interests, so they are recomputed only when those change.
  const scoresNow = () => {
    const key = `${state().profile.ver}:${catalog.version}`;
    if (scoreCache.key !== key) scoreCache = { key, scores: scoreAll(catalog, state().profile, Math.random), match: null };
    return scoreCache.scores;
  };
  const matchNow = () => {
    scoresNow();
    scoreCache.match ??= matchAll(catalog, state().profile);
    return scoreCache.match;
  };

  const refreshTags = () => {
    allowedIds = postings ? Filter.idsFor(state().filter.tags, postings) : null;
    tagClusters = postings ? Filter.clustersFor(state().filter.tags, postings) : [];
  };
  const mix = () => Filter.restrict(shares(state().profile, categoryIds()), state().filter.types);
  const grow = (opts: Record<string, unknown> = {}) => catalog
    .ensureClusters({ profile: state().profile, shares: mix(), want: WANT, explore: tagClusters.length ? 0 : EXPLORE_CLUSTERS, must: tagClusters, ...opts })
    .catch((e: unknown) => console.error(e));

  // Categories to draw from: the chosen types, or none (all). The very first card is an artwork if images are allowed.
  const onlyTypes = () => {
    const types = state().filter.types;
    if (shown.length === 0 && (!types.length || types.includes('visual'))) return ['visual'];
    return types.length ? types : null;
  };
  // A reader with no interests yet gets the pack's starter edition first, in its order.
  const starter: [number, number][] = catalog.manifest.starter ?? [];
  const starterPick = (taken: (id: number) => boolean) => {
    if (state().profile.cents.length > 0 || filtering()) return null;
    const hit = starter.find(([id]) => !taken(id) && catalog.posOf(id) >= 0);
    return hit ? { id: hit[0], exploring: false, category: catalog.categories[catalog.cat[catalog.posOf(hit[0])]].id, share: 0 } : null;
  };
  const isTaken = (id: number) => hasBit(state().seen, id) || catalog.isBlocked(id) || shownIds.has(id) || hasBit(state().bad, id) || slow.has(id);
  const rank = (kind: string) => starterPick(isTaken) ?? pickFor({
    kind, index: catalog, profile: state().profile, scores: scoresNow(), match: matchNow,
    taken: (id: number) => hasBit(state().seen, id) || catalog.isBlocked(id) || shownIds.has(id) || hasBit(state().bad, id) || slow.has(id) || (allowedIds !== null && !allowedIds.has(id)),
    shown: shown.map((s) => s.n), rng: Math.random, only: onlyTypes(),
  });

  const activeIndex = () => {
    const i = shown.findIndex((s) => s.card.id === activeKey);
    if (i >= 0) return i;
    return activeKey ? shown.length - 1 : 0; // on the end card: after the last
  };
  const entryOf = (key: string | null) => shown.find((s) => s.card.id === key);

  const appendNext = async (): Promise<'yes' | 'no' | 'stale' | 'skipped'> => {
    const stamp = epoch;
    const slot = nextSlot(lastEntry());
    if (slot.start) sitting.firstSet ??= slot.setNo;
    const sittingSet = slot.setNo - (sitting.firstSet ?? slot.setNo);
    const plan = slot.start
      ? planFor({ sittingSet, previous: shown.filter((s) => s.setNo === slot.setNo - 1).map((s) => s.outcome) })
      : lastEntry().plan;
    const kind = plan[slot.pos - 1];
    let pick = rank(kind);
    if (!pick && (await catalog.ensureClusters({ profile: state().profile, shares: mix(), want: Infinity, maxNew: 4, must: tagClusters }))) pick = rank(kind);
    if (!pick && state().seen.length && !filtering()) {
      update({ seen: new Uint8Array(0) }); // every work seen once: start a new pass
      pick = rank(kind);
    }
    if (!pick) {
      ended = true;
      changed();
      return 'no';
    }
    const card = await catalog.getCard(pick.id);
    if (stamp !== epoch) return 'stale';
    if (card.type === 'audio') void peaksFor(card); // download and measure the recording now, not when it is reached
    if (card.type === 'image') {
      const verdict = await preload(card.media.url);
      if (stamp !== epoch) return 'stale';
      if (verdict === 'broken') update({ bad: withBit(state().bad, pick.id) });
      if (verdict !== 'yes') {
        slow.add(pick.id);
        return 'skipped';
      }
    }
    const reason = { ...explain(state().profile, card, catalog.vecOf(pick.id), pick.exploring), category: pick.category, share: pick.share };
    shown = [...shown, { card, n: pick.id, reason, setNo: slot.setNo, pos: slot.pos, plan, sittingSet, outcome: null }];
    shownIds.add(pick.id);
    changed();
    return 'yes';
  };

  const fillAhead = () => {
    chain = chain.then(async () => {
      while (!ended && shown.length - 1 - activeIndex() < AHEAD) {
        const got = await appendNext();
        if (got === 'no') break;
      }
    }).catch((e) => console.error(e));
    return chain;
  };

  // After feedback: drop the pre-ranked cards below the active one and rank them again.
  const refillAhead = () => {
    if (ended && activeKey === 'end') return chain;
    epoch += 1;
    const idx = activeIndex();
    shown.slice(idx + 1).forEach((s) => shownIds.delete(s.n));
    shown = shown.slice(0, idx + 1);
    ended = false;
    changed();
    return fillAhead();
  };

  const finishDwell = () => {
    const entry = entryOf(activeKey);
    if (!entry) return;
    const seconds = (performance.now() - activeSince) / 1000;
    const m = entry.card.media;
    const length = m ? m.end - m.start : 0;
    const kind = judged ? 'left' : seconds < SKIP_S ? 'skip' : length > 0 && seconds >= FINISH_SHARE * length ? 'finish' : 'dwell';
    judged = false;
    entry.outcome = kind;
    emit(kind, entry.n, entry.card.cl, Math.round(seconds * 10) / 10);
    if (kind === 'skip' || kind === 'finish') update({ profile: learn(state().profile, entry.card, kind, catalog.vecOf(entry.n)) });
    else if (kind === 'dwell' && seconds >= DWELL_MIN_S) update({ profile: learn(state().profile, entry.card, 'dwell', null, seconds) });
  };

  const learnFrom = (entry: Entry, event: string) => {
    emit(event, entry.n, entry.card.cl);
    update({ profile: learn(state().profile, entry.card, event, catalog.vecOf(entry.n)) });
    grow(); // interests moved: fetch the clusters now nearest to them
  };

  return {
    subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    items: () => cached,
    version: () => version,
    activeKey: () => activeKey,
    entryOf,
    mix,
    catalog,

    async begin() {
      emit('start');
      await grow({ want: FIRST_WANT, explore: 0, must: [...tagClusters, ...(state().profile.cents.length ? [] : starter.map(([, cl]) => cl))] }); // just enough for the first cards
      await fillAhead();
      grow(); // then fill out the rest in the background
    },

    activate(key: string) {
      if (key === activeKey) return;
      finishDwell();
      activeKey = key;
      activeSince = performance.now();
      const entry = entryOf(key);
      if (entry) {
        emit('show', entry.n, entry.card.cl, entry.reason.kind === 'exploring' ? 1 : 0);
        if (entry.setNo !== undefined) update({ session: { setNo: entry.setNo, pos: entry.pos, plan: entry.plan } });
        if (!hasBit(state().seen, entry.n)) update({ seen: withBit(state().seen, entry.n) });
      }
      fillAhead();
    },

    markJudged: () => { judged = true; },
    fillAhead,

    toggleSave(key: string, addOnly = false) {
      const entry = entryOf(key);
      if (!entry) return null;
      const has = state().saved.includes(entry.n);
      if (has && addOnly) return null;
      update({
        saved: has ? state().saved.filter((n: number) => n !== entry.n) : [...state().saved, entry.n],
        savedCl: { ...state().savedCl, [entry.n]: entry.card.cl }, // remembers which shard holds the card
      });
      if (has) emit('unsave', entry.n, entry.card.cl);
      else learnFrom(entry, 'save');
      if (!has) refillAhead();
      return !has;
    },

    // refill: false keeps the cards below (a swipe reveals the next one, already ranked); refillAhead() follows once it is active.
    feedback(key: string, event: 'more' | 'less' | 'note', refill = true) {
      const entry = entryOf(key);
      if (!entry) return;
      learnFrom(entry, event);
      return refill ? refillAhead() : undefined;
    },

    refillAhead,
    emit,

    // A found work (search, saved) goes in right below the card on screen. Returns its key, or null.
    async showWork(n: number, cl: number): Promise<string | null> {
      const there = shown.find((s) => s.n === n);
      if (there) return there.card.id;
      await catalog.ensureClusters({ profile: state().profile, shares: mix(), want: 0, maxNew: 1, must: [cl] }); // its vector, for learning
      const card = await catalog.getCard(n, cl);
      if (!card) return null;
      const at = activeIndex();
      shown = [...shown.slice(0, at + 1), { card, n, reason: { kind: 'search' }, plan: [], sittingSet: 0, outcome: null }, ...shown.slice(at + 1)];
      shownIds.add(n);
      changed();
      return card.id;
    },

    // Time spent in another view is not time spent on the card.
    away(on: boolean) {
      if (on) awayAt = performance.now();
      else activeSince += performance.now() - awayAt;
    },

    async startOver() {
      epoch += 1;
      shown = [];
      shownIds.clear();
      activeKey = null;
      ended = false;
      resumed = null;
      update({ seen: new Uint8Array(0), session: null });
      changed();
      await fillAhead();
    },

    // The app left the foreground (true) or came back (false).
    visibility(hidden: boolean, hiddenFor = 0) {
      if (hidden) {
        finishDwell();
        emit('hide');
      } else if (hiddenFor > NEW_SITTING_MS) Object.assign(sitting, { start: Date.now(), firstSet: null });
      activeSince = performance.now();
    },

    // A work that cannot be played is dropped before anyone sees it, or skipped past if it is on screen.
    unplayable(key: string) {
      const entry = entryOf(key);
      if (!entry) return false;
      slow.add(entry.n);
      if (shown.indexOf(entry) <= activeIndex()) return false;
      shown = shown.filter((s) => s !== entry);
      changed();
      fillAhead();
      return true;
    },

    async applyFilter(filter: { types: string[]; tags: string[] }) {
      update({ filter });
      postings ??= await catalog.loadTags();
      refreshTags();
      epoch += 1;
      await grow({ want: FIRST_WANT });
      await refillAhead();
    },
    reprofile: () => { grow(); return refillAhead(); },
  };
};

export type FeedController = ReturnType<typeof createFeed>;
