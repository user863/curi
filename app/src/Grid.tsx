import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from './ui';
import { Image } from 'expo-image';
import { tonePalette } from './theme';

const PAGE = 24; // tiles added per step
const GAP = 2;
const GLYPH: Record<string, string> = { video: '▶', audio: '♪', passage: '“' };

export const GRID_PAGE = PAGE;
const pictureOf = (c: any) => (c.type === 'image' ? c.media.url : c.type === 'video' || c.type === 'audio' ? c.media?.poster : null);

type Tile = { card: any; col: number };

// Works as small cards in columns by the picture's shape, scrolling on without end. `supply(alive)` resolves with the
// next cards (empty when there are no more); a new `resetKey`, or leaving, supersedes a run still loading.
export const Grid = ({ supply, resetKey, width, removable = false, onPick, onUnsave, onBroken, header, empty }: {
  supply: (alive: () => boolean) => Promise<any[]>; resetKey: string; width: number; removable?: boolean;
  onPick: (n: number, cl: number) => void; onUnsave?: (n: number) => void; onBroken?: (n: number) => void;
  header?: React.ReactNode; empty?: React.ReactNode;
}) => {
  const columns = Math.max(3, Math.floor(width / 120));
  const colW = (width - GAP * (columns + 1)) / columns;
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [done, setDone] = useState(false);
  const ratios = useRef(new Map<number, number>());
  const run = useRef(0);
  const busy = useRef<number | null>(null);
  const view = useRef({ height: 0, content: 0, y: 0 });
  const [, bump] = useState(0);

  const place = useCallback((existing: Tile[], cards: any[]) => {
    const heights = Array.from({ length: columns }, () => 0);
    existing.forEach((t) => { heights[t.col] += colW * (ratios.current.get(t.card.n) ?? 1.25) + GAP; });
    return [...existing, ...cards.map((card) => {
      const col = heights.indexOf(Math.min(...heights));
      heights[col] += colW * 1.25 + GAP;
      return { card, col };
    })];
  }, [columns, colW]);

  const more = useCallback(async () => {
    const stamp = run.current;
    if (busy.current === stamp) return;
    busy.current = stamp;
    try {
      const batch = await supply(() => stamp === run.current);
      if (stamp !== run.current) return;
      if (!batch.length) { setDone(true); return; }
      setTiles((cur) => place(cur, batch));
    } finally {
      if (busy.current === stamp) busy.current = null;
    }
  }, [supply, place]);

  useEffect(() => {
    run.current += 1;
    busy.current = null;
    ratios.current = new Map();
    setTiles([]);
    setDone(false);
    more();
    return () => { run.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // a short first page: keep going while the end is on screen
  const fill = () => {
    const v = view.current;
    if (!done && v.height > 0 && v.content < v.y + v.height + 400) more();
  };

  const cols = Array.from({ length: columns }, (_, c) => tiles.filter((t) => t.col === c));
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 120 }}
      scrollEventThrottle={64}
      onLayout={(e) => { view.current.height = e.nativeEvent.layout.height; fill(); }}
      onContentSizeChange={(_, h) => { view.current.content = h; fill(); }}
      onScroll={(e) => { view.current.y = e.nativeEvent.contentOffset.y; fill(); }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {header}
      {tiles.length === 0 && done ? empty : null}
      <View style={[styles.row, { paddingHorizontal: GAP / 2 }]}>
        {cols.map((col, c) => (
          <View key={c} style={{ width: colW + GAP, paddingHorizontal: GAP / 2 }}>
            {col.map(({ card }) => (
              <TileView
                key={card.n} card={card} width={colW} removable={removable}
                onRatio={(r) => { if (ratios.current.get(card.n) !== r) { ratios.current.set(card.n, r); bump((x) => x + 1); } }}
                onPick={() => onPick(card.n, card.cl)}
                onUnsave={() => { setTiles((cur) => cur.filter((t) => t.card.n !== card.n)); onUnsave?.(card.n); }}
                onBroken={() => { setTiles((cur) => cur.filter((t) => t.card.n !== card.n)); onBroken?.(card.n); }}
              />
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
};

const TileView = ({ card, width, removable, onRatio, onPick, onUnsave, onBroken }: {
  card: any; width: number; removable: boolean; onRatio: (r: number) => void; onPick: () => void; onUnsave: () => void; onBroken: () => void;
}) => {
  const pal = tonePalette(card.editorial.tone);
  const uri = pictureOf(card);
  const [ratio, setRatio] = useState(1.25);
  return (
    <View style={{ marginBottom: GAP }}>
      <Pressable onPress={onPick} style={[styles.tile, { backgroundColor: pal.bg }]}>
        {uri ? (
          <Image
            source={{ uri }} contentFit="cover" transition={150}
            style={{ width, height: width * ratio }}
            onLoad={(e) => { const r = Math.min(2, Math.max(0.6, e.source.height / e.source.width)); setRatio(r); onRatio(r); }}
            onError={() => { if (card.type === 'image') onBroken(); }}
          />
        ) : card.type === 'passage' ? (
          <Text numberOfLines={8} style={{ padding: 10, fontSize: 10, color: pal.fg, minHeight: width * 0.8 }}>{card.text.body.slice(0, 160)}…</Text>
        ) : (
          <View style={{ height: width * 0.8, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 28, color: pal.fg }}>{GLYPH[card.type] ?? ''}</Text></View>
        )}
        {card.type === 'video' && uri ? <Text style={styles.badge}>▶</Text> : null}
      </Pressable>
      {removable ? <Pressable onPress={onUnsave} hitSlop={8} style={styles.unsave} accessibilityLabel="Remove from saved"><Text style={{ color: '#fff', fontSize: 16, lineHeight: 18 }}>×</Text></Pressable> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  tile: { overflow: 'hidden' },
  badge: { position: 'absolute', right: 6, top: 6, color: '#fff', fontSize: 12, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  unsave: { position: 'absolute', right: 6, top: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center' },
});
