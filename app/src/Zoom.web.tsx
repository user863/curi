import { ReactNode, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { grip } from './Shell';

type Props = { width: number; height: number; active: boolean; children: ReactNode };
type View2 = { s: number; x: number; y: number };

const MAX = 5;
const IDENTITY: View2 = { s: 1, x: 0, y: 0 };
const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const mid = (t: TouchList) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];

// Zoom by `k` about the point (px, py) of the box; the picture always covers the box.
const zoomAt = (v: View2, k: number, px: number, py: number, w: number, h: number): View2 => {
  const s = Math.min(MAX, Math.max(1, v.s * k));
  return pan({ s, x: px - ((px - v.x) * s) / v.s, y: py - ((py - v.y) * s) / v.s }, 0, 0, w, h);
};
const pan = (v: View2, dx: number, dy: number, w: number, h: number): View2 => ({
  s: v.s,
  x: Math.min(0, Math.max(w * (1 - v.s), v.x + dx)),
  y: Math.min(0, Math.max(h * (1 - v.s), v.y + dy)),
});

// Pinch zoom of the picture: ctrl+wheel (a trackpad pinch arrives as ctrl+wheel), two fingers, and drag to pan once zoomed in.
export const Zoom = ({ width, height, active, children }: Props) => {
  const box = useRef<any>(null);
  const [view, setView] = useState<View2>(IDENTITY);
  const cur = useRef(view);
  const set = (v: View2) => { cur.current = v; grip.held = v.s > 1.02; setView(v); };

  useEffect(() => { // leaving the card puts the picture back
    if (active) return;
    grip.held = false;
    cur.current = IDENTITY;
    setView(IDENTITY);
  }, [active]);

  useEffect(() => {
    const el: HTMLElement | undefined = box.current;
    if (!el) return undefined;
    const local = (cx: number, cy: number) => { const r = el.getBoundingClientRect(); return [cx - r.left, cy - r.top]; };
    let pinch: { d: number; at: number[] } | null = null;
    let drag: number[] | null = null;

    const wheel = (e: WheelEvent) => {
      if (!active || !e.ctrlKey) return; // a plain wheel scrolls the feed
      e.preventDefault();
      const [px, py] = local(e.clientX, e.clientY);
      set(zoomAt(cur.current, Math.exp(-e.deltaY * 0.01), px, py, width, height));
    };
    const start = (e: TouchEvent) => {
      if (!active) return;
      if (e.touches.length === 2) { e.preventDefault(); pinch = { d: dist(e.touches), at: mid(e.touches) }; drag = null; }
      else if (e.touches.length === 1 && cur.current.s > 1.02) drag = [e.touches[0].clientX, e.touches[0].clientY];
    };
    const move = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches);
        const at = mid(e.touches);
        const [px, py] = local(at[0], at[1]);
        set(pan(zoomAt(cur.current, d / pinch.d, px, py, width, height), at[0] - pinch.at[0], at[1] - pinch.at[1], width, height));
        pinch = { d, at };
      } else if (drag && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        set(pan(cur.current, t.clientX - drag[0], t.clientY - drag[1], width, height));
        drag = [t.clientX, t.clientY];
      }
    };
    const end = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; if (!e.touches.length) drag = null; };
    const down = (e: MouseEvent) => { if (active && cur.current.s > 1.02) drag = [e.clientX, e.clientY]; };
    const drag2 = (e: MouseEvent) => {
      if (!drag) return;
      set(pan(cur.current, e.clientX - drag[0], e.clientY - drag[1], width, height));
      drag = [e.clientX, e.clientY];
    };
    const up = () => { drag = null; };

    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', drag2);
    window.addEventListener('mouseup', up);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
      el.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', drag2);
      window.removeEventListener('mouseup', up);
    };
  }, [active, width, height]);

  return (
    <View ref={box} style={{ width, height, overflow: 'hidden' }}>
      <View style={{ width, height, transform: [{ translateX: view.x }, { translateY: view.y }, { scale: view.s }], transformOrigin: '0 0' } as any}>
        {children}
      </View>
    </View>
  );
};
