import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from './ui';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tonePalette } from './theme';

const P = tonePalette('paper');
const MIN_PICKS = 2;

type Sample = { image: string | null; text: string | null; tone: string };

// First launch: pick at least two rooms; they seed the profile.
export const Onboarding = ({ rooms, samples, onDone }: {
  rooms: Record<string, string>; samples: Record<string, Sample>; onDone: (picked: string[]) => void;
}) => {
  const insets = useSafeAreaInsets();
  const tileW = Math.floor((useWindowDimensions().width - 48) / 2); // explicit size: pictures need a box
  const tileH = Math.round(tileW * 0.82);
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (r: string) => setPicked((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  return (
    <View style={[styles.root, { backgroundColor: P.bg, paddingTop: insets.top + 24 }]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={[styles.title, { color: P.fg }]}>What are you interested in?</Text>
        <Text style={{ color: P.dim, marginTop: 8, fontSize: 15 }}>Choose at least {MIN_PICKS}.</Text>
        <View style={styles.tiles}>
          {Object.entries(rooms).map(([r, label]) => {
            const s = samples[r];
            const on = picked.includes(r);
            return (
              <Pressable key={r} onPress={() => toggle(r)} style={[styles.tile, { width: tileW, height: tileH }, on && styles.tileOn]} accessibilityState={{ selected: on }}>
                {s?.image ? <Image source={{ uri: s.image }} contentFit="cover" style={{ width: tileW, height: tileH }} />
                  : <Text numberOfLines={5} style={styles.sample}>{s?.text}</Text>}
                <View style={styles.label}><Text style={styles.labelText}>{label}</Text></View>
                {on ? <View style={styles.dot} /> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <View style={[styles.foot, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable hitSlop={10} onPress={() => onDone([])}><Text style={{ color: P.dim, fontSize: 16 }}>Skip</Text></Pressable>
        <Pressable disabled={picked.length < MIN_PICKS} onPress={() => onDone(picked)} style={[styles.start, picked.length < MIN_PICKS && { opacity: 0.35 }]}>
          <Text style={styles.startText}>Start</Text>
        </Pressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 16 },
  title: { fontSize: 30, fontWeight: '500', letterSpacing: -0.7, lineHeight: 32, maxWidth: 280 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 22 },
  tile: { overflow: 'hidden', backgroundColor: '#b9a9c9' },
  tileOn: { borderWidth: 3, borderColor: '#000' },
  sample: { padding: 12, fontSize: 17, lineHeight: 20, backgroundColor: '#e3ac1c', flex: 1 },
  label: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 10, paddingTop: 24, backgroundColor: 'rgba(0,0,0,0.45)' },
  labelText: { color: '#fff', fontWeight: '500', fontSize: 15 },
  dot: { position: 'absolute', top: 10, right: 10, width: 12, height: 12, borderRadius: 6, backgroundColor: '#fff', borderWidth: 2, borderColor: '#000' },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12 },
  start: { backgroundColor: '#000', borderRadius: 4, minHeight: 44, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center' },
  startText: { color: '#fff', fontWeight: '500', fontSize: 16 },
});
