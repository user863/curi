import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Text } from './ui';
import { Image } from 'expo-image';
import * as Search from '../../js/search.js';
import * as Colours from '../../js/colours.js';
import { complete } from '../../js/suggest.js';
import { deviceLang } from '../../js/vocab.js';
import { compose, exploreScores, pickGalleries } from '../../js/explore.js';
import { Grid, GRID_PAGE } from './Grid';
import { tonePalette } from './theme';

const P = tonePalette('paper');

const unitOf = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

const Page = ({ top, children }: { top: number; children: ReactNode }) => (
  <View style={[styles.page, { paddingTop: top }]}>{children}</View>
);


type Gallery = { t: string; s: string; c: string; q: number; v: number[]; ids: number[] };
const HERO_COUNT = 6;
const sized = (url: string, px: number) => url.replace(/=s0$/, `=w${px}`); // Google-hosted originals come at full size

// Europeana galleries as large cards in a row; a tap opens the gallery.
const HeroRow = ({ galleries, width, onOpen }: { galleries: Gallery[]; width: number; onOpen: (g: Gallery) => void }) => {
  const w = Math.round(width * 0.78);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={w + 8} decelerationRate="fast" contentContainerStyle={{ paddingHorizontal: 6, gap: 8, paddingBottom: 8 }}>
      {galleries.map((g) => (
        <Pressable key={g.s} onPress={() => onOpen(g)} style={{ width: w, height: Math.round(w * 1.1), backgroundColor: '#222', overflow: 'hidden' }}>
          <Image source={{ uri: sized(g.c, 900) }} contentFit="cover" transition={200} style={{ width: w, height: Math.round(w * 1.1) }} />
          <View style={styles.heroLabel}>
            <Text numberOfLines={2} style={styles.heroTitle}>{g.t}</Text>
            <Text style={styles.heroMeta}>Europeana gallery · {g.ids.length} works</Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
};

const GALLERY_BATCH = 8;

// One gallery, one work per screen, swiped sideways; works are fetched a few at a time.
const GalleryView = ({ catalog, gallery, top, width, height, onPick, onClose }: {
  catalog: any; gallery: Gallery; top: number; width: number; height: number; onPick: (n: number, cl: number) => void; onClose: () => void;
}) => {
  const [cards, setCards] = useState<any[]>([]);
  const [at, setAt] = useState(0);
  const fetched = useRef(0);
  const busy = useRef(false);
  const owners = useRef<Uint16Array | null>(null);

  const more = useCallback(async () => {
    if (busy.current || fetched.current >= gallery.ids.length) return;
    busy.current = true;
    try {
      owners.current ??= await catalog.owners();
      const ids = gallery.ids.slice(fetched.current, fetched.current + GALLERY_BATCH);
      fetched.current += ids.length;
      const got = await catalog.getCards(ids.map((id: number) => [id, owners.current![id]]));
      setCards((cur) => [...cur, ...ids.map((id: number) => got.get(id)).filter((c: any) => c?.type === 'image' && !catalog.isBlocked(c.n))]);
    } finally {
      busy.current = false;
    }
  }, [catalog, gallery]);

  useEffect(() => { more(); }, [more]);

  return (
    <View style={[styles.gallery, { paddingTop: top }]}>
      <View style={styles.galleryBar}>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={styles.galleryTitle}>{gallery.t}</Text>
          <Text style={styles.galleryMeta}>{cards.length ? `${at + 1} / ${gallery.ids.length}` : ' '}</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close gallery"><Text style={styles.galleryClose}>×</Text></Pressable>
      </View>
      <FlatList
        horizontal pagingEnabled data={cards} keyExtractor={(c) => String(c.n)} showsHorizontalScrollIndicator={false}
        onEndReachedThreshold={2} onEndReached={more}
        onMomentumScrollEnd={(e) => setAt(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => (
          <Pressable onPress={() => onPick(item.n, item.cl)} style={{ width, height: height - top - 120, justifyContent: 'center' }}>
            <Image source={{ uri: item.media.url }} contentFit="contain" transition={150} style={{ width, height: height - top - 160 }} />
            <Text numberOfLines={2} style={styles.galleryCaption}>{item.title}{item.creator && item.creator !== 'Unknown' ? ` · ${item.creator}` : ''}</Text>
          </Pressable>
        )}
      />
    </View>
  );
};

// Discover: search over the word index. With nothing typed, popular tags to start from.
export const SearchView = ({ catalog, profile, top, width, height, onPick, onBroken }: { catalog: any; profile: any; top: number; width: number; height: number; onPick: (n: number, cl: number) => void; onBroken: (n: number) => void }) => {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<number | null>(null);
  const [heroes, setHeroes] = useState<Gallery[]>([]);
  const [open, setOpen] = useState<Gallery | null>(null);
  const [picked, setPicked] = useState<string[]>([]); // colour chips on
  const [tags, setTags] = useState<[string, number][]>([]);
  const [vocab, setVocab] = useState<any>({});
  const [chosen, setChosen] = useState(''); // text a suggestion filled in, so it is not suggested again
  useEffect(() => {
    let alive = true;
    Promise.all([catalog.suggest(), catalog.vocab()]).then(([t, v]) => { if (alive) { setTags(t); setVocab(v); } }).catch(() => {});
    return () => { alive = false; };
  }, [catalog]);
  const suggestions = useMemo(() => (text === chosen ? [] : complete(tags, vocab, deviceLang(), text)), [tags, vocab, text, chosen]);
  useEffect(() => { // the galleries to feature, chosen once per visit from the reader's interests
    let alive = true;
    catalog.galleries().then((all: Gallery[]) => { if (alive) setHeroes(pickGalleries({ galleries: all, profile, count: HERO_COUNT, rng: Math.random })); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);
  const queue = useRef<any[]>([]); // cards fetched but not yet shown
  const clusters = useRef<[number, number[]][]>([]); // [cluster, ids] still to fetch, most hits first
  const loaded = useRef(''); // the query whose hits are in `clusters`

  useEffect(() => { // typing settles for a moment before searching
    const t = setTimeout(() => setQuery(text), 220);
    return () => clearTimeout(t);
  }, [text]);

  const seen = useRef(new Set<number>());
  const asked = useRef(new Set<number>()); // clusters already requested for the wall
  const session = useRef<number[] | null>(null); // running mean of the works opened from this wall
  const opened = (n: number, cl: number) => {
    const v: number[] | undefined = catalog.vecOf(n);
    if (v) session.current = session.current ? session.current.map((x, d) => 0.7 * x + 0.3 * v[d]) : v.slice();
    onPick(n, cl);
  };
  // Nothing typed: images chosen by the explore score (js/explore.js) from the clusters near the reader's interests,
  // best-rated first when there are none; more clusters are loaded when the wall runs short.
  const wall = async (alive: () => boolean) => {
    const imageCat = catalog.categories.findIndex((c: any) => c.id === 'visual');
    const index = Object.assign(Object.create(catalog), { rooms: catalog.manifest.roomOrder });
    const pick = () => {
      const skip = (i: number) => catalog.cat[i] !== imageCat || seen.current.has(catalog.ids[i]) || catalog.isBlocked(catalog.ids[i]);
      const scores = exploreScores({ index, profile, rng: Math.random, session: session.current ? unitOf(session.current) : null, crowd: null, skip });
      return compose({ index, scores, count: GRID_PAGE, rng: Math.random, profile });
    };
    const shares = Object.fromEntries(catalog.categories.map((c: any) => [c.id, c.id === 'visual' ? 1 : 0]));
    if (!asked.current.size) await catalog.ensureClusters({ profile, shares, want: 75, maxNew: 6, explore: 2 });
    asked.current.add(-1);
    let best = pick();
    while (best.length < GRID_PAGE) {
      const next = catalog.info.ids
        .map((id: number, j: number) => [id, j] as [number, number])
        .filter(([id, j]: [number, number]) => !asked.current.has(id) && catalog.info.counts[j][imageCat] > 0)
        .sort((a: any, b: any) => catalog.info.quality[b[1]] - catalog.info.quality[a[1]]).slice(0, 4);
      if (!next.length) break;
      next.forEach(([id]: [number]) => asked.current.add(id));
      await catalog.ensureClusters({ profile: { cents: [], negs: [] }, shares: {}, want: 0, maxNew: 4, must: next.map(([id]: [number]) => id) });
      if (!alive()) return [];
      best = pick();
    }
    const ids = best.map((i: number) => catalog.ids[i]);
    ids.forEach((id: number) => seen.current.add(id));
    const cards = await catalog.getCards(ids.map((id: number) => [id, catalog.clusterOf(id)]));
    return alive() ? ids.map((id: number) => cards.get(id)).filter(Boolean) : [];
  };

  const wanted = picked;
  const rest = query.trim();
  const key = `${rest}|${wanted.join(',')}`;
  const idle = !rest && !wanted.length;

  const supply = useCallback(async (alive: () => boolean) => {
    if (idle) return wall(alive);
    if (loaded.current !== key) { // the first step of a query runs the search itself
      setFound(null);
      let hits: { id: number; cl: number }[] | null = rest ? await Search.find(rest, catalog.searchShard) : null;
      if (wanted.length) {
        const byColour: Map<number, number> = Colours.hits(await catalog.colours(), wanted);
        hits = hits ? hits.filter((h) => byColour.has(h.id)) : [...byColour].map(([id, cl]) => ({ id, cl }));
      }
      if (!alive()) return [];
      setFound(hits!.length);
      const byCluster = hits!.reduce((m: Map<number, number[]>, h: any) => m.set(h.cl, [...(m.get(h.cl) ?? []), h.id]), new Map());
      clusters.current = [...byCluster.entries()].sort((a, b) => b[1].length - a[1].length);
      queue.current = [];
      loaded.current = key;
    }
    while (queue.current.length < GRID_PAGE && clusters.current.length) {
      const [cl, ids] = clusters.current.shift()!;
      const cards = [...(await catalog.getCards(ids.map((id: number) => [id, cl]))).values()].filter(Boolean) as any[];
      if (!alive()) return [];
      queue.current.push(...cards.sort((a, b) => b.editorial.quality - a.editorial.quality));
    }
    return alive() ? queue.current.splice(0, GRID_PAGE) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, catalog]);

  return (
    <Page top={top}>
      <View style={styles.searchTop}>
        <TextInput
          style={styles.field} value={text} onChangeText={setText} placeholder="Title, artist, place, tag, word"
          placeholderTextColor="rgba(0,0,0,0.45)" autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing"
        />
      </View>
      {suggestions.length ? (
        <View style={styles.suggest}>
          {suggestions.map((s) => (
            <Pressable key={s.slug} onPress={() => { setChosen(s.text); setText(s.text); }} style={styles.suggestRow}>
              <Text style={styles.suggestText}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.colourRow}>
        {[...Object.keys(Colours.HUES), ...Colours.TONES].map((c) => {
          const on = wanted.includes(c);
          const hex = (Colours.HUES as Record<string, string>)[c];
          return (
            <Pressable key={c} onPress={() => setPicked(on ? picked.filter((x) => x !== c) : [...picked, c])} style={[styles.colourChip, on && styles.colourOn]}>
              {hex ? <View style={[styles.colourDot, { backgroundColor: hex }]} /> : null}
              <Text style={[styles.colourText, on && { color: '#fff' }]}>{c === 'monochrome' ? 'black & white' : c}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {!idle && found === 0 ? <Text style={styles.note}>Nothing found.</Text> : null}
      <Grid supply={supply} resetKey={key} width={width} onPick={opened} onBroken={onBroken} header={idle && heroes.length ? <HeroRow galleries={heroes} width={width} onOpen={setOpen} /> : undefined} />
      {open ? <GalleryView catalog={catalog} gallery={open} top={top} width={width} height={height} onPick={opened} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
};

// Saved: the saved works, newest first; a cross takes one out.
export const SavedView = ({ catalog, top, width, saved, onPick, onUnsave }: {
  catalog: any; top: number; width: number; saved: [number, number][]; onPick: (n: number, cl: number) => void; onUnsave: (n: number) => void;
}) => {
  const waiting = useRef<[number, number][]>([...saved]); // read before the grid's first step
  const [total, setTotal] = useState(saved.length);
  const key = useRef(String(Math.random())).current;

  const supply = useCallback(async (alive: () => boolean) => {
    const pairs = waiting.current.splice(0, GRID_PAGE);
    if (!pairs.length) return [];
    const cards = await catalog.getCards(pairs);
    return alive() ? pairs.map(([n]) => cards.get(n)).filter(Boolean) : [];
  }, [catalog]);

  return (
    <Page top={top}>
      {total ? null : <Text style={[styles.note, { paddingTop: 12 }]}>Nothing saved yet. Double tap a card to save it.</Text>}
      <Grid supply={supply} resetKey={key} width={width} removable onPick={onPick} onUnsave={(n) => { setTotal((t) => t - 1); onUnsave(n); }} />
    </Page>
  );
};

const NEAR_CLUSTERS = 3; // clusters nearest the work are loaded so its neighbours are there to compare
const NEIGHBOURS = 150;

// Experiment: the works whose embedding is closest to this one, by cosine over every loaded work.
const neighboursOf = async (catalog: any, id: number): Promise<[number, number][]> => {
  if (catalog.posOf(id) < 0) return [];
  const { cent, ids } = catalog.info;
  const dim = catalog.dim;
  const v: number[] = catalog.vecOf(id);
  const ranked = ids.map((cid: number, j: number) => [cid, v.reduce((s, x, d) => s + x * cent[j * dim + d], 0)] as [number, number])
    .sort((a: [number, number], b: [number, number]) => b[1] - a[1]).slice(0, NEAR_CLUSTERS).map(([cid]: [number, number]) => cid);
  await catalog.ensureClusters({ profile: { cents: [], negs: [] }, shares: {}, want: 0, maxNew: NEAR_CLUSTERS, must: ranked });
  const target: number[] = catalog.vecOf(id);
  const scored: [number, number][] = [];
  for (let i = 0; i < catalog.n; i++) {
    const wid = catalog.ids[i];
    if (wid === id || catalog.isBlocked(wid)) continue;
    let dot = 0, norm = 0;
    for (let d = 0; d < dim; d++) { const e = catalog.emb[i * dim + d]; dot += e * target[d]; norm += e * e; }
    scored.push([i, dot / (Math.sqrt(norm) || 1)]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, NEIGHBOURS).map(([i]) => [catalog.ids[i], catalog.clusterOf(catalog.ids[i])]);
};

// Similar to this: a wall of the nearest works.
export const SimilarView = ({ catalog, id, top, width, onPick, onBroken }: {
  catalog: any; id: number; top: number; width: number; onPick: (n: number, cl: number) => void; onBroken: (n: number) => void;
}) => {
  const waiting = useRef<Promise<[number, number][]> | null>(null);
  const supply = useCallback(async (alive: () => boolean) => {
    waiting.current ??= neighboursOf(catalog, id);
    const all = await waiting.current;
    const pairs = all.splice(0, GRID_PAGE);
    if (!pairs.length || !alive()) return [];
    const cards = await catalog.getCards(pairs);
    return alive() ? pairs.map(([n]) => cards.get(n)).filter(Boolean) : [];
  }, [catalog, id]);
  return (
    <Page top={top}>
      <Grid supply={supply} resetKey={String(id)} width={width} onPick={onPick} onBroken={onBroken} empty={<Text style={[styles.note, { paddingTop: 12 }]}>No neighbours found.</Text>} />
    </Page>
  );
};

export const SimplePage = ({ top, title, text }: { top: number; title: string; text: string }) => (
  <Page top={top}>
    <View style={{ padding: 22, gap: 8 }}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{text}</Text>
    </View>
  </Page>
);

const styles = StyleSheet.create({
  suggest: { paddingHorizontal: 12, paddingBottom: 6 },
  suggestRow: { paddingVertical: 8, paddingHorizontal: 14 },
  suggestText: { fontSize: 15 },
  colourRow: { paddingHorizontal: 12, paddingBottom: 8, gap: 6, alignItems: 'center' },
  colourChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#0004' },
  colourOn: { backgroundColor: '#000', borderColor: '#000' },
  colourDot: { width: 12, height: 12, borderRadius: 6 },
  colourText: { fontSize: 14 },
  heroLabel: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: 'rgba(0,0,0,0.45)' },
  heroTitle: { color: '#fff', fontSize: 20, fontWeight: '600', letterSpacing: -0.4 },
  heroMeta: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 3 },
  gallery: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: P.bg, zIndex: 2 },
  galleryBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6, minHeight: 48 },
  galleryTitle: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  galleryMeta: { fontSize: 12, color: P.dim },
  galleryClose: { fontSize: 30, lineHeight: 32, color: P.dim, paddingHorizontal: 6 },
  galleryCaption: { fontSize: 12, color: P.dim, paddingHorizontal: 16, paddingTop: 8 },
  page: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: P.bg, zIndex: 8 },
  searchTop: { paddingHorizontal: 12, paddingVertical: 6, minHeight: 44, justifyContent: 'center' },
  field: { height: 34, borderRadius: 999, paddingHorizontal: 14, backgroundColor: 'rgba(0,0,0,0.07)', fontSize: 15, fontFamily: 'Switzer-Regular' },
  title: { fontSize: 24, fontWeight: '500', letterSpacing: -0.5 },
  note: { fontSize: 13, color: P.dim, paddingHorizontal: 20, paddingBottom: 8, minHeight: 22 },
  body: { fontSize: 15, color: P.dim },
});
