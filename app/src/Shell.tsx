import { ReactNode, useMemo, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './ui';
import { Palette } from './theme';

export const TAP_MS = 260;
const SWIPE_PX = 70; // sideways drag that counts: right is more, left is fewer like this

// A scrub bar is being dragged: the card must not take that drag for a swipe.
export const grip = { held: false };

export type Zone = 'left' | 'middle' | 'right';
export const zoneOf = (f: number): Zone => (f < 1 / 3 ? 'left' : f > 2 / 3 ? 'right' : 'middle');

// Gives a card its touch: taps (single, double, with the third of the card they land in) and the sideways swipe.
export const Shell = ({ palette, width, swipeable, under, onTap, onHold, onSwipe, children }: {
  palette: Palette; width: number; swipeable: boolean;
  under?: ReactNode; // the next card, at full size beneath this one
  onTap: (zone: Zone, double: boolean) => void;
  onHold?: (zone: Zone, on: boolean) => void;
  onSwipe: (dir: 1 | -1) => void;
  children: ReactNode;
}) => {
  const x = useRef(new Animated.Value(0)).current;
  const last = useRef(0);
  const live = useRef(false);
  const more = x.interpolate({ inputRange: [0, SWIPE_PX], outputRange: [0, 1], extrapolate: 'clamp' });
  const less = x.interpolate({ inputRange: [-SWIPE_PX, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const rotate = x.interpolate({ inputRange: [-width, width], outputRange: ['-14deg', '14deg'] });
  const far = Math.max(SWIPE_PX, width * 0.22);

  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => swipeable && !grip.held && Math.abs(g.dx) > 14 && Math.abs(g.dx) > 1.5 * Math.abs(g.dy),
    onPanResponderGrant: () => { live.current = true; },
    onPanResponderMove: (_, g) => {
      x.setValue(g.dx);
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_, g) => {
      live.current = false;
      if (Math.abs(g.dx) >= far) {
        const dir = g.dx > 0 ? 1 : -1;
        Animated.timing(x, { toValue: dir * width * 1.3, duration: 220, useNativeDriver: true }).start(() => {
          onSwipe(dir);
          // the list scrolls to the next card first; the flown-off card returns to centre only once it is out of sight
          setTimeout(() => x.setValue(0), 200);
        });
      } else Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
    },
    onPanResponderTerminate: () => {
      live.current = false;
      Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
    },
  }), [swipeable, width, far, onSwipe, x]);

  return (
    <View style={styles.fill}>
      {under ? <View style={StyleSheet.absoluteFill} pointerEvents="none">{under}</View> : null}
    <Animated.View style={[styles.fill, { backgroundColor: palette.bg, transform: [{ translateX: x }, { rotate }] }]} {...pan.panHandlers}>
      <Pressable
        style={styles.fill}
        onPress={(e) => {
          const now = Date.now();
          const double = now - last.current < TAP_MS;
          last.current = double ? 0 : now;
          onTap(zoneOf(e.nativeEvent.locationX / width), double);
        }}
        onLongPress={(e) => onHold?.(zoneOf(e.nativeEvent.locationX / width), true)}
        onPressOut={() => onHold?.('middle', false)}
        delayLongPress={350}
      >
        {children}
      </Pressable>
      <Animated.View pointerEvents="none" style={[styles.tag, { opacity: more, left: 16 }]}>
        <Text style={{ color: palette.fg, fontSize: 17, fontWeight: '500' }}>More like this</Text>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.tag, { opacity: less, right: 16 }]}>
        <Text style={{ color: palette.fg, fontSize: 17, fontWeight: '500' }}>Fewer like this</Text>
      </Animated.View>
    </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tag: { position: 'absolute', top: 90, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, backgroundColor: 'rgba(128,128,128,0.25)' },
});
