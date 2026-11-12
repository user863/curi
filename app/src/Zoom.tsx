import { ReactNode, useEffect, useRef } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { grip } from './Shell';

type Props = { width: number; height: number; active: boolean; children: ReactNode };

// Pinch zoom of the picture (iOS scroll view zoom). Leaving the card puts the picture back.
export const Zoom = ({ width, height, active, children }: Props) => {
  const zoom = useRef<any>(null);
  useEffect(() => {
    if (active) return;
    grip.held = false;
    zoom.current?.scrollResponderZoomTo({ x: 0, y: 0, width, height, animated: false });
  }, [active, width, height]);
  return (
    <ScrollView
      ref={zoom}
      style={StyleSheet.absoluteFill}
      contentContainerStyle={{ width, height }}
      maximumZoomScale={5}
      minimumZoomScale={1}
      bouncesZoom
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={(e) => { if (active) grip.held = (e.nativeEvent.zoomScale ?? 1) > 1.02; }} // zoomed in: a drag pans the picture, not the card
    >
      {children}
    </ScrollView>
  );
};
