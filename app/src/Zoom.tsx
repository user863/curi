import { ReactNode, useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { grip } from './Shell';
import { scrollLock } from './scrollLock';

type Props = { width: number; height: number; active: boolean; children: ReactNode };

const MAX = 5;
const ZOOMED = 1.02;

// Pinch zoom and pan of the picture with react-native-gesture-handler. Zoom and pan run together; the pan is on only while zoomed in.
// Two fingers down, or zoomed in, hold the feed's vertical scroll (scrollLock) and turn the card's sideways swipe off (grip); both
// are released when the picture is back at full size. The picture is clipped to its stage.
export const Zoom = ({ width, height, active, children }: Props) => {
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const zoomed = useSharedValue(false);
  const locked = useRef(false);

  const hold = (on: boolean) => {
    grip.held = on;
    if (on !== locked.current) { locked.current = on; scrollLock.set(on); }
  };

  useEffect(() => {
    // A card always starts, and is left, fully zoomed out: the whole picture in view.
    scale.value = 1; tx.value = 0; ty.value = 0; zoomed.value = false;
    hold(false);
  }, [active, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  const pinch = usePinchGesture({
    onTouchesDown: (e) => { 'worklet'; if (e.numberOfTouches > 1) scheduleOnRN(hold, true); },
    onActivate: (e) => {
      'worklet';
      startScale.value = scale.value; startX.value = tx.value; startY.value = ty.value;
      focalX.value = e.focalX - width / 2; focalY.value = e.focalY - height / 2;
      scheduleOnRN(hold, true);
    },
    onUpdate: (e) => {
      'worklet';
      const s = Math.min(MAX * 1.15, Math.max(0.85, startScale.value * e.scale));
      const k = s / startScale.value;
      const x = e.focalX - width / 2 - (focalX.value - startX.value) * k; // the picture point under the fingers stays under them
      const y = e.focalY - height / 2 - (focalY.value - startY.value) * k;
      const mx = Math.max(0, (width * (s - 1)) / 2);
      const my = Math.max(0, (height * (s - 1)) / 2);
      scale.value = s;
      tx.value = Math.min(mx, Math.max(-mx, x));
      ty.value = Math.min(my, Math.max(-my, y));
    },
    onDeactivate: () => {
      'worklet';
      const s = Math.min(MAX, Math.max(1, scale.value));
      if (s < 1.05) { // nearly full size: back to full size
        scale.value = withSpring(1); tx.value = withSpring(0); ty.value = withSpring(0);
        zoomed.value = false;
      } else {
        const mx = (width * (s - 1)) / 2;
        const my = (height * (s - 1)) / 2;
        scale.value = withSpring(s);
        tx.value = withSpring(Math.min(mx, Math.max(-mx, tx.value)));
        ty.value = withSpring(Math.min(my, Math.max(-my, ty.value)));
        zoomed.value = true;
      }
    },
    onFinalize: () => { 'worklet'; scheduleOnRN(hold, zoomed.value); },
  });

  const pan = usePanGesture({
    enabled: zoomed,
    minPointers: 1,
    maxPointers: 1,
    onActivate: () => { 'worklet'; startX.value = tx.value; startY.value = ty.value; },
    onUpdate: (e) => {
      'worklet';
      const mx = (width * (scale.value - 1)) / 2;
      const my = (height * (scale.value - 1)) / 2;
      tx.value = Math.min(mx, Math.max(-mx, startX.value + e.translationX));
      ty.value = Math.min(my, Math.max(-my, startY.value + e.translationY));
    },
  });

  const gesture = useSimultaneousGestures(pinch, pan);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }] }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.clip]} collapsable={false}>
        <Animated.View style={[{ width, height }, style]}>{children}</Animated.View>
      </Animated.View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });
