import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Text } from './ui';
import { hueColour, luminance, toOklch } from '../../js/colour.js';
import { TONES } from '../../js/colours.js';
import { Slider } from './Slider';

// A few starting points: the colour names the pack knows, plus black, grey and white.
const DEFAULTS = ['#c8403a', '#e08a2c', '#e3c13a', '#5f9a54', '#3a8f94', '#3f6fb0', '#7d56a6', '#e3829f', '#7a5a3c', '#1a1a1a', '#8a8a8a', '#f2f2f2'];
const HEX = /^#[0-9a-f]{6}$/i;
const lch = (hex: string) => toOklch(hex) as [number, number, number];
const toneText = (t: string) => (t === 'monochrome' ? 'black & white' : t);

const track = (f: (v: number) => string, steps = 24) => Array.from({ length: steps }, (_, i) => f(i / (steps - 1)));

export const ColourPicker = ({ visible, hex, tones, onApply, onClose }: {
  visible: boolean; hex: string | null; tones: string[]; onApply: (hex: string | null, tones: string[]) => void; onClose: () => void;
}) => {
  const [[L, C, h], setLch] = useState<[number, number, number]>([0.7, 0.14, 350]);
  const [text, setText] = useState('');
  const [on, setOn] = useState(false); // a colour is chosen; otherwise only the tones apply
  const [picked, setPicked] = useState<string[]>(tones);
  useEffect(() => { // start from the colour in force when the sheet opens
    if (!visible) return;
    setPicked(tones);
    setOn(!!hex);
    if (hex) { setLch(lch(hex)); setText(hex); } else setText('');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = hueColour(h, L, C);
  const choose = (v: string) => { setLch(lch(v)); setText(v); setOn(true); };
  const move = (next: [number, number, number]) => { setLch(next); setText(hueColour(next[2], next[0], next[1])); setOn(true); };
  const typed = (v: string) => {
    const t = (v.startsWith('#') ? v : `#${v}`).toLowerCase();
    setText(v);
    if (HEX.test(t)) { setLch(lch(t)); setOn(true); }
  };
  const current = on ? shown : null;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Pressable onPress={onClose} style={styles.close}><Text style={styles.closeText}>Close</Text></Pressable>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.h}>Colour</Text>
          <View style={[styles.preview, { backgroundColor: current ?? '#0001' }]}>
            <Text style={{ color: current && luminance(current) < 0.35 ? '#fff' : '#000', fontSize: 22 }}>{current ?? 'No colour'}</Text>
          </View>
          <Text style={styles.k}>Starting points</Text>
          <View style={styles.row}>
            {DEFAULTS.map((d) => <Pressable key={d} onPress={() => choose(d)} style={[styles.dot, { backgroundColor: d }]} />)}
          </View>
          <Text style={styles.k}>Hue</Text>
          <Slider value={h} min={0} max={359} onChange={(v) => move([L, C, v])} track={track((f) => hueColour(f * 359, L, Math.max(C, 0.1)))} />
          <Text style={styles.k}>Colourfulness</Text>
          <Slider value={C} min={0} max={0.3} onChange={(v) => move([L, v, h])} track={track((f) => hueColour(h, L, f * 0.3))} />
          <Text style={styles.k}>Lightness</Text>
          <Slider value={L} min={0.1} max={0.97} onChange={(v) => move([v, C, h])} track={track((f) => hueColour(h, 0.1 + f * 0.87, C))} />
          <Text style={styles.k}>Hex</Text>
          <TextInput style={styles.field} value={text} onChangeText={typed} placeholder="#e85d9a" placeholderTextColor="rgba(0,0,0,0.4)" autoCapitalize="none" autoCorrect={false} maxLength={7} />
          <Text style={styles.k}>Tone</Text>
          <View style={styles.row}>
            {TONES.concat('monochrome').map((t) => {
              const sel = picked.includes(t);
              return (
                <Pressable key={t} onPress={() => setPicked(sel ? picked.filter((x) => x !== t) : [...picked, t])} style={[styles.chip, sel && styles.chipOn]}>
                  <Text style={[styles.chipText, sel && { color: '#fff' }]}>{toneText(t)}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={() => { onApply(current, picked); onClose(); }}><Text style={styles.primaryText}>Show works</Text></Pressable>
            <Pressable style={styles.secondary} onPress={() => { onApply(null, []); onClose(); }}><Text style={styles.secondaryText}>Clear colour</Text></Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: '#fff' },
  close: { alignSelf: 'flex-end', padding: 16 },
  closeText: { fontSize: 15, fontWeight: '500' },
  body: { padding: 22, paddingTop: 0, gap: 8 },
  h: { fontSize: 24, fontWeight: '500', letterSpacing: -0.5 },
  k: { fontSize: 13, color: '#0009', marginTop: 8 },
  preview: { height: 96, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dot: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: '#0003' },
  field: { height: 40, borderRadius: 10, paddingHorizontal: 14, backgroundColor: 'rgba(0,0,0,0.07)', fontSize: 16 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#0006' },
  chipOn: { backgroundColor: '#000', borderColor: '#000' },
  chipText: { fontSize: 14 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  primary: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 999, backgroundColor: '#000' },
  primaryText: { color: '#fff', fontWeight: '500' },
  secondary: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 999, borderWidth: 1, borderColor: '#0006' },
  secondaryText: { fontWeight: '500' },
});
