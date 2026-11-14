import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

// A bar you drag; the value follows the finger. track: optional colours painted along it.
export const Slider = ({ value, min, max, onChange, track }: { value: number; min: number; max: number; onChange: (v: number) => void; track?: string[] }) => {
  const [width, setWidth] = useState(1);
  const live = useRef({ width, min, max, onChange });
  live.current = { width, min, max, onChange };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => at(e.nativeEvent.locationX),
    onPanResponderMove: (e) => at(e.nativeEvent.locationX),
  })).current;
  const at = (x: number) => {
    const { width: w, min: lo, max: hi, onChange: set } = live.current;
    set(lo + Math.min(1, Math.max(0, x / w)) * (hi - lo));
  };
  const f = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return (
    <View style={styles.slider} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} {...pan.panHandlers}>
      <View style={styles.track} pointerEvents="none">
        {track ? track.map((c, i) => <View key={i} style={{ flex: 1, backgroundColor: c }} />) : <View style={{ flex: 1, backgroundColor: '#0002' }} />}
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: f * (width - 16) }]} />
    </View>
  );
};

const styles = StyleSheet.create({
  slider: { height: 34, justifyContent: 'center' },
  track: { height: 10, borderRadius: 5, overflow: 'hidden', flexDirection: 'row' },
  thumb: { position: 'absolute', width: 16, height: 26, borderRadius: 8, backgroundColor: '#fff', borderWidth: 2, borderColor: '#000' },
});
