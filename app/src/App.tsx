import { ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, AppState, FlatList, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from './ui';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { age, withRoom } from '../../js/rank.js';
import * as Log from '../../js/log.js';
import { AudioCard, Ctx, EndCard, ImageCard, PassageCard, VideoCard } from './cards';
import { createFeed, FeedController, Item } from './feed';
import { openCatalog } from './pack';
import { Loader } from './Loader';
import { useSwitzer } from './ui';
import { Onboarding } from './Onboarding';
import { createReader } from './speech';
import { InfoSheet, SettingsSheet, VoiceSheet } from './sheets';
import { SavedView, SearchView, SimilarView, SimplePage } from './views';
import { VOICES } from '../../js/speech.js';
import { flush, getState, update, useAppState } from './store';
import { migration, withBit } from '../../js/store.js';
import { paletteFor, tonePalette } from './theme';

const UI_HIDE_MS = 4000;
const INTRO_MS = 2600; // controls show at launch, then slide away
const NO_ITEMS: Item[] = [];
const NO_SUBSCRIBE = () => () => {};
const viewability = { itemVisiblePercentThreshold: 60 };

// Local event log (js/log.js): what was shown and what the reader did, kept on this device only.
let events: any[] = Log.read(globalThis.localStorage);
let logTimer: ReturnType<typeof setTimeout>;
const emit = (kind: string, n = 0, cl = 0, value = 0) => {
  events = Log.push(events, [Math.round(Date.now() / 1000), kind, n, cl, value]);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => Log.write(globalThis.localStorage, events), 2000);
};

const Screen = () => {
  const insets = useSafeAreaInsets();
  const { width: w, height: h } = useWindowDimensions();
  const state = useAppState();
  const [feed, setFeed] = useState<FeedController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | { catalog: any; done: (picked: string[]) => void }>(null); // first-run room choice
  const list = useRef<FlatList<Item>>(null);
  const items = useSyncExternalStore(feed?.subscribe ?? NO_SUBSCRIBE, () => feed?.items() ?? NO_ITEMS);
  const [active, setActive] = useState<string | null>(null);
  const [foreground, setForeground] = useState(true);
  const [ui, setUiState] = useState(true);
  const [sound, setSound] = useState(true);
  const [toast, setToast] = useState('');
  const [sheet, setSheet] = useState<null | 'settings' | 'voice' | { info: any }>(null);
  const [view, setViewState] = useState<null | 'discover' | 'saved' | 'similar' | 'chat' | 'profile'>(null); // a view over the feed; the feed stays where it was
  const [goto, setGoto] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<{ key: string | null; state: string | null }>({ key: null, state: null });
  const uiTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const hiddenAt = useRef(0);

  const reader = useMemo(() => createReader((key, s) => setSpeaking(s ? { key, state: s } : (cur) => (cur.key === key ? { key: null, state: null } : cur))), []);

  const setUi = useCallback((on: boolean, ms = UI_HIDE_MS) => {
    clearTimeout(uiTimer.current);
    setUiState(on);
    if (on) uiTimer.current = setTimeout(() => setUiState(false), ms);
  }, []);

  const say = useCallback((msg: string, ms = 1600) => {
    setToast(msg);
    toastOpacity.setValue(1);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => Animated.timing(toastOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(), ms);
  }, [toastOpacity]);

  // start
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const catalog: any = await openCatalog();
        const moved = await migration(getState(), catalog);
        if (moved) update(moved);
        update({ profile: age(getState().profile, Math.round(Date.now() / 1000)) }); // time passed since the last session
        if (getState().onboarded === 'unknown') {
          const picked = await new Promise<string[]>((done) => setAsk({ catalog, done }));
          setAsk(null);
          const profile = picked.reduce((p: any, r) => withRoom(p, r, true, catalog.roomVec(r), catalog.manifest.roomCategories[r]), getState().profile);
          update({ profile, onboarded: picked.length ? 'yes' : 'no' });
        }
        const f = createFeed(catalog, emit);
        if (!alive) return;
        setFeed(f);
        await f.begin();
        setUi(true, INTRO_MS);
      } catch (e) {
        console.error(e);
        setError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [setUi]);

  // leaving the app: finish the card, pause what plays
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const on = next === 'active';
      setForeground(on);
      if (!feed) return;
      if (!on) {
        hiddenAt.current = Date.now();
        feed.visibility(true);
        flush();
        Log.write(globalThis.localStorage, events);
        if (reader.activeKey() && reader.state() !== 'paused') reader.toggle();
      } else feed.visibility(false, Date.now() - hiddenAt.current);
    });
    return () => sub.remove();
  }, [feed, reader]);

  const showView = useCallback((next: typeof view) => {
    if (next === view) return;
    if (next && !view) feed?.away(true);
    if (!next && view) feed?.away(false);
    if (next) reader.stop();
    setViewState(next);
    if (!next) setUi(true);
  }, [view, feed, reader, setUi]);

  // A found work goes in below the card on screen, and the feed moves to it.
  const showWork = useCallback(async (n: number, cl: number) => {
    if (!feed) return;
    const key = await feed.showWork(n, cl);
    showView(null);
    if (key) setGoto(key);
  }, [feed, showView]);

  const [like, setLike] = useState<number | null>(null); // the work whose neighbours are shown

  const indexOf = useCallback((key: string) => items.findIndex((i) => i.key === key), [items]);

  const onViewable = useRef(({ viewableItems }: { viewableItems: { item: Item; isViewable: boolean }[] }) => {
    const top = viewableItems.find((v) => v.isViewable);
    if (!top) return;
    const key = (top.item as Item).key;
    setActive(key);
    setUi(false);
  }).current;

  useEffect(() => {
    if (!feed || !active) return;
    if (reader.activeKey() && reader.activeKey() !== active) reader.stop();
    feed.activate(active);
  }, [active, feed, reader]);

  const scrollTo = useCallback((index: number, animated = true) => {
    if (index >= 0 && index < items.length) list.current?.scrollToIndex({ index, animated });
  }, [items.length]);

  useEffect(() => {
    if (!goto || view !== null) return;
    const i = items.findIndex((it) => it.key === goto);
    if (i < 0) return;
    setGoto(null);
    setTimeout(() => list.current?.scrollToIndex({ index: i, animated: true }), 50);
  }, [goto, view, items]);

  const ctx: Ctx = useMemo(() => ({
    w, h, top: insets.top, bottom: insets.bottom, colour: state.colour, sound, ui,
    save: (key, addOnly) => {
      const nowSaved = feed?.toggleSave(key, addOnly);
      if (nowSaved === null || nowSaved === undefined) return;
      say(nowSaved ? 'Saved' : 'Removed');
    },
    info: async (key) => {
      const entry = feed?.entryOf(key);
      if (!entry || !feed) return;
      feed.feedback(key, 'note');
      const detail = await feed.catalog.getDetail(entry.card.n ?? entry.n, entry.card.cl).catch(() => null);
      setUi(false);
      const vocab = await feed.catalog.vocab().catch(() => ({}));
      setSheet({ info: { card: entry.card, detail, vocab, reason: entry.reason, rooms: feed.catalog.rooms, categories: feed.catalog.categories } });
    },
    similar: (key) => {
      const entry = feed?.entryOf(key);
      if (!entry) return;
      setLike(entry.card.n ?? entry.n);
      showView('similar');
    },
    toggleUi: () => setUi(!ui),
    setUi: (on) => setUi(on),
    swipe: (key, dir) => {
      const i = indexOf(key);
      if (!feed || i < 0) return;
      feed.markJudged();
      say(dir > 0 ? 'More like this' : 'Fewer like this');
      const next = items[i + 1];
      if (!next) { feed.feedback(key, dir > 0 ? 'more' : 'less'); return; }
      scrollTo(i + 1, false); // the card beneath was ranked already: it is the one that appears
      setActive(next.key);
      setTimeout(() => { // learning and re-ranking wait until the reveal has been drawn
        feed.feedback(key, dir > 0 ? 'more' : 'less', false);
        feed.activate(next.key);
        feed.refillAhead();
      }, 120);
    },
    next: (key) => scrollTo(indexOf(key) + 1),
    unplayable: (key) => { feed?.unplayable(key); },
    speak: (key, body, verse) => {
      if (reader.activeKey() === key) return reader.stop();
      const chosen = getState().voice;
      reader.start(key, body, verse, chosen && chosen !== 'random' ? chosen : undefined);
    },
    voices: () => { if (Platform.OS !== 'web') setSheet('voice'); }, // the web reads with the browser voice
    speakToggle: () => { reader.toggle(); },
    speaking,
  }), [w, h, insets, state.colour, sound, ui, feed, say, setUi, indexOf, scrollTo, items.length, reader, speaking, showView]);

  const cardFor = useCallback((item: Item & { kind: 'card' }, on: boolean, near: boolean, under?: ReactNode) => {
    const props = { entry: item.entry, active: on, near, ctx, under };
    switch (item.entry.card.type) {
      case 'image': return <ImageCard {...props} />;
      case 'passage': return <PassageCard {...props} />;
      case 'audio': return <AudioCard {...props} />;
      case 'video': return <VideoCard {...props} />;
      default: return null;
    }
  }, [ctx]);

  const renderItem = useCallback(({ item, index }: { item: Item; index: number }) => {
    // a film has its player (and starts buffering) two cards ahead; anything else one card either way
    const gap = active !== null ? indexOf(item.key) - indexOf(active) : NaN;
    const reach = item.kind === 'card' && item.entry.card.type === 'video' ? 2 : 1;
    const near = foreground && view === null && gap >= -1 && gap <= reach;
    const on = foreground && view === null && item.key === active;
    const following = items[index + 1];
    // the next card is drawn beneath the active one at full size (without playing), so a swipe reveals it at once
    const under = item.key === active && following ? (
      following.kind === 'card' ? cardFor(following, false, false)
          : <EndCard count={items.length - 1} saved={state.saved.length} onRestart={() => {}} />
    ) : undefined;
    return (
      <View style={{ width: w, height: h }}>
        {item.kind === 'card' ? cardFor(item, on, near, under) : (
          <EndCard count={items.length - 1} saved={state.saved.length} onRestart={() => feed!.startOver()} />
        )}
      </View>
    );
  }, [w, h, active, foreground, view, ctx, feed, items, indexOf, scrollTo, state.saved.length, cardFor]);

  // chrome colours follow the card on screen
  const entry = feed && active ? feed.entryOf(active) : null;
  const bar = entry ? paletteFor(entry.card, state.colour) : tonePalette('paper');
  const media = entry && (entry.card.type === 'video' || entry.card.type === 'audio');

  if (ask) return <Onboarding rooms={ask.catalog.rooms} samples={ask.catalog.manifest.roomSamples} onDone={ask.done} />;
  if (error) return <View style={styles.center}><Text style={{ padding: 24 }}>{error}</Text></View>;
  if (!feed || items.length === 0) return <View style={[styles.center, { backgroundColor: '#000' }]}><Loader /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: bar.bg }}>
      <StatusBar hidden />
      <FlatList
        ref={list}
        data={items}
        keyExtractor={(i) => i.key}
        renderItem={renderItem}
        extraData={`${view}${active}${foreground}${sound}${ui}${state.colour}${speaking.key}${speaking.state}${state.saved.length}`}
        getItemLayout={(_, index) => ({ length: h, offset: h * index, index })}
        pagingEnabled
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        viewabilityConfig={viewability}
        onViewableItemsChanged={onViewable}
        windowSize={5}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        removeClippedSubviews
      />
      <View pointerEvents={ui && !view ? 'auto' : 'none'} style={[styles.bar, { paddingTop: insets.top, backgroundColor: bar.barBg, opacity: ui && !view ? 1 : 0 }]}>
        <View style={styles.row}>
          <Text style={[styles.mark, { color: bar.barFg }]}>Curi</Text>
          <View style={styles.nav}>
            <Pressable hitSlop={10} onPress={() => showView(view === 'saved' ? null : 'saved')}><Text style={[styles.navText, { color: bar.barFg }]}>Saved{state.saved.length ? ` (${state.saved.length})` : ''}</Text></Pressable>
            <Pressable hitSlop={10} onPress={() => setSheet('settings')}><Text style={[styles.navText, { color: bar.barFg }]}>Settings</Text></Pressable>
          </View>
        </View>
      </View>
      {media ? (
        <View pointerEvents={ui ? 'auto' : 'none'} style={[styles.tools, { bottom: insets.bottom + 88, opacity: ui ? 1 : 0 }]}>
          <Pressable style={styles.tool} onPress={() => { setSound(!sound); setUi(true); }}><Text style={styles.toolText}>{sound ? 'Mute' : 'Sound'}</Text></Pressable>
        </View>
      ) : null}
      <Animated.View pointerEvents="none" style={[styles.toast, { opacity: toastOpacity, bottom: insets.bottom + 110 }]}><Text style={styles.toastText}>{toast}</Text></Animated.View>
      <SettingsSheet visible={sheet === 'settings'} onClose={() => setSheet(null)} feed={feed} state={state} events={events} />
      {view === 'discover' ? (
        <SearchView catalog={feed.catalog} profile={state.profile} top={insets.top + 8} width={w} height={h} onPick={showWork} onBroken={(n) => update({ bad: withBit(getState().bad, n) })} />
      ) : null}
      {view === 'saved' ? (
        <SavedView
          catalog={feed.catalog} top={insets.top + 8} width={w} onPick={showWork}
          saved={[...state.saved].reverse().map((n: number) => [n, state.savedCl[n]] as [number, number])}
          onUnsave={(n) => { feed.emit('unsave', n, state.savedCl[n]); update({ saved: getState().saved.filter((x: number) => x !== n) }); }}
        />
      ) : null}
      {view === 'similar' && like !== null ? (
        <SimilarView catalog={feed.catalog} id={like} top={insets.top + 8} width={w} onPick={showWork} onBroken={(n) => update({ bad: withBit(getState().bad, n) })} />
      ) : null}
      {view === 'chat' ? <SimplePage top={insets.top + 8} title="Chat" text="Talk with Curi about what you are looking at. Coming soon." /> : null}
      {view === 'profile' ? <SimplePage top={insets.top + 8} title="Profile" text="Your taste, your saves and your account. Coming soon." /> : null}
      <View pointerEvents={ui || view ? 'auto' : 'none'} style={[styles.dock, { paddingBottom: insets.bottom + 6, opacity: ui || view ? 1 : 0, zIndex: 9 }]}>
        {([['feed', 'Feed'], ['discover', 'Discover'], ['chat', 'Chat'], ['profile', 'Profile']] as const).map(([id, label]) => {
          const on = id === 'feed' ? view === null : view === id;
          return (
            <Pressable key={id} style={styles.dockItem} onPress={() => { showView(id === 'feed' ? null : id); if (id === 'feed') setUi(true); }}>
              <Text style={[styles.dockText, { opacity: on ? 1 : 0.5 }, on && { textDecorationLine: 'underline' }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      <VoiceSheet
        visible={sheet === 'voice'} onClose={() => setSheet(null)} voices={VOICES} chosen={state.voice ?? 'random'}
        onPick={(voice) => {
          update({ voice });
          setSheet(null);
          const card = entry?.card; // read the passage on screen with the chosen voice
          if (card?.type === 'passage' && active) { reader.stop(); reader.start(active, card.text.body, card.text.verse, voice === 'random' ? undefined : voice); }
        }}
      />
      <InfoSheet data={typeof sheet === 'object' && sheet ? sheet.info : null} onClose={() => setSheet(null)} />
    </View>
  );
};

export default function App() {
  const fonts = useSwitzer();
  if (!fonts) return <View style={[styles.center, { backgroundColor: '#000' }]}><Loader /></View>;
  return <SafeAreaProvider><Screen /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 20, paddingBottom: 8 },
  row: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mark: { fontSize: 14, fontWeight: '500', letterSpacing: 0.14 },
  nav: { flexDirection: 'row', gap: 18 },
  navText: { fontSize: 14, fontWeight: '500' },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 4, paddingHorizontal: 12, flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.86)', borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  dockItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  dockText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  tools: { position: 'absolute', right: 14, gap: 8, alignItems: 'flex-end' },
  tool: { height: 40, paddingHorizontal: 16, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'center' },
  toolText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  toast: { position: 'absolute', alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.82)' },
  toastText: { color: '#fff', fontSize: 14 },
});
