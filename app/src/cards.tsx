import { memo, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AnimatedText, Text, familyFor } from './ui';
import Svg, { Path } from 'react-native-svg';
import { Image } from 'expo-image';
import { VideoView } from 'expo-video';
import { fmtTime } from '../../js/views.js';
import type { Entry } from './feed';
import Tape from '../modules/commonplace-speech';
import { useExcerpt, SKIP_SECONDS } from './media';
import { Loader } from './Loader';
import { FLAT, peaksFor } from './peaks';
import { Shell, grip, Zone } from './Shell';
import { Zoom } from './Zoom';
import { Palette, paletteFor, tonePalette } from './theme';

export type Ctx = {
  w: number; h: number; top: number; bottom: number;
  colour: string; sound: boolean; ui: boolean;
  save: (key: string, addOnly?: boolean) => void;
  info: (key: string) => void;
  toggleUi: () => void;
  setUi: (on: boolean) => void;
  swipe: (key: string, dir: 1 | -1) => void;
  next: (key: string) => void;
  unplayable: (key: string) => void;
  speak: (key: string, body: string, verse: boolean) => void;
  voices: () => void;
  similar: (key: string) => void;
  speakToggle: () => void;
  speaking: { key: string | null; state: string | null };
};

const join = (parts: (string | undefined)[], sep = ' · ') => parts.filter(Boolean).join(sep);
const who = (c: any) => (c.creator === 'Unknown' ? '' : c.creator);
const LICENSE = { CC0: 'CC0', PDM: 'Public domain', 'CC-BY': 'CC BY', 'CC-BY-SA': 'CC BY-SA', 'LOC-FREE': 'Free to use', 'LOC-ATTR': 'Free to use, credit' } as Record<string, string>;
const licenseLabel = (r: any) => LICENSE[r.license] || r.license;
const clampSize = (min: number, vw: number, max: number, w: number) => Math.min(max, Math.max(min, vw * w));
const STRIP = 28; // height of the row under a film: full screen button, 2× while fast-forwarding
const words = (s: string) => s.trim().split(/\s+/).length;

const Caption = ({ title, line, palette, ctx, onPress, right = 20 }: { title?: string; line: string; palette: Palette; ctx: Ctx; onPress: () => void; right?: number }) => (
  <Pressable onPress={onPress} style={[styles.cap, { paddingBottom: ctx.bottom + 16, paddingRight: right, opacity: ctx.ui ? 0 : 1 }]} pointerEvents={ctx.ui ? 'none' : 'auto'}>
    {title ? <Text numberOfLines={1} style={[styles.capText, { color: palette.fg, fontWeight: '500' }]}>{title}</Text> : null}
    <Text numberOfLines={1} style={[styles.capText, { color: palette.dim }]}>{line}</Text>
  </Pressable>
);

const creditLine = (card: any) => join([join([who(card), card.date], ', '), card.source.institution.replace(/, Open Access/, ''), licenseLabel(card.rights)]);

type Props = { entry: Entry; active: boolean; near: boolean; ctx: Ctx; under?: ReactNode };

const useCommon = (entry: Entry, ctx: Ctx) => {
  const palette = useMemo(() => paletteFor(entry.card, ctx.colour), [entry.card, ctx.colour]);
  const key = entry.card.id as string;
  const onSwipe = useCallback((dir: 1 | -1) => ctx.swipe(key, dir), [ctx, key]);
  return { palette, key, onSwipe };
};

/* ---------- image ---------- */

export const ImageCard = memo(({ entry, active, ctx, under }: Props) => {
  const { card } = entry;
  const { palette, key, onSwipe } = useCommon(entry, ctx);
  const [failed, setFailed] = useState(false);
  const stageH = ctx.h - (ctx.top + 14) - (ctx.bottom + 62);
  const tap = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onTap = (_: Zone, double: boolean) => {
    clearTimeout(tap.current);
    if (double) ctx.save(key, true);
    else tap.current = setTimeout(ctx.toggleUi, 260);
  };
  return (
    <Shell palette={palette} width={ctx.w} swipeable={active} under={under} onTap={onTap} onHold={(_, on) => on && ctx.similar(key)} onSwipe={onSwipe}>
      <View style={[styles.stage, { top: ctx.top + 14, bottom: ctx.bottom + 62 }]}>
        <Zoom width={ctx.w} height={stageH} active={active}>
          <Image
            source={{ uri: card.media.url }}
            contentFit="contain"
            transition={250}
            style={{ width: ctx.w, height: stageH }}
            accessibilityLabel={`${card.title}, ${card.creator}, ${card.date}`}
            onError={() => { setFailed(true); ctx.unplayable(key); }}
          />
        </Zoom>
      </View>
      {failed ? <Text style={[styles.failed, { color: palette.dim }]}>Image unavailable.</Text> : null}
      <Caption title={card.title} line={creditLine(card)} palette={palette} ctx={ctx} onPress={() => ctx.info(key)} />
    </Shell>
  );
});

/* ---------- passage ---------- */

const SpeakIcon = ({ color, size = 22 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z" fill={color} />
    <Path d="M15.4 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.8 7.8 0 0 1 0 10.8" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
  </Svg>
);

// Two arrows pointing apart along the diagonal: full screen.
const FullIcon = ({ color, size = 20 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
  </Svg>
);

export const PassageCard = memo(({ entry, active, ctx, under }: Props) => {
  const { card } = entry;
  const { palette, key, onSwipe } = useCommon(entry, ctx);
  const mine = ctx.speaking.key === key ? ctx.speaking.state : null;
  const pulse = useRef(new Animated.Value(1)).current;
  const tap = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (mine === 'playing' || mine === 'loading') {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]));
      loop.start();
      return () => { loop.stop(); pulse.setValue(1); };
    }
    return undefined;
  }, [mine, pulse]);

  const onTap = (_: Zone, double: boolean) => {
    clearTimeout(tap.current);
    if (mine) { // being read aloud: a tap pauses or resumes, a double tap also saves
      ctx.speakToggle();
      if (double) ctx.save(key, true);
    } else if (double) ctx.save(key, true);
    else tap.current = setTimeout(ctx.toggleUi, 260);
  };

  const body: string = card.text.body;
  const verse: boolean = card.text.verse;
  const n = words(body);
  const size = n <= 55 ? clampSize(26, 0.074, 32, ctx.w) : n <= 110 ? clampSize(21, 0.059, 25, ctx.w) : clampSize(15.5, 0.042, 17.5, ctx.w);
  const lineHeight = n <= 110 ? size * 1.27 : size * 1.36;
  const paragraphs = verse ? body.split(/\n\s*\n/).map((st) => st.split('\n').join('\n')) : [body];
  const work = card.source.work === card.title ? '' : card.source.work;

  return (
    <Shell palette={palette} width={ctx.w} swipeable={active} under={under} onTap={onTap} onSwipe={onSwipe}>
      <ScrollView
        style={[styles.text, { top: ctx.top + 18, bottom: ctx.bottom + 56 }]}
        contentContainerStyle={styles.textContent}
        showsVerticalScrollIndicator={false}
      >
        {paragraphs.map((p, i) => (
          <Text key={i} style={{ color: palette.fg, fontSize: size, lineHeight, letterSpacing: -0.012 * size, marginBottom: i < paragraphs.length - 1 ? size * 0.9 : 0 }}>
            {p}
            {i === paragraphs.length - 1 ? (
              // the speaker sits where the next character would go
              <>
                {' '}
                <View style={{ width: size * 0.85, height: size * 0.75, justifyContent: 'flex-end' }}>
                  <Pressable accessibilityLabel="Read aloud" hitSlop={12} onPress={() => ctx.speak(key, body, verse)} onLongPress={ctx.voices} delayLongPress={450}>
                    <Animated.View style={{ opacity: mine ? pulse : 1 }}>
                      <SpeakIcon color={mine ? palette.fg : palette.dim} size={Math.round(size * 0.8)} />
                    </Animated.View>
                  </Pressable>
                </View>
              </>
            ) : null}
          </Text>
        ))}
      </ScrollView>
      <Caption title={card.creator} line={join([card.title, work, card.date]) + ' · Public domain'} palette={palette} ctx={ctx} onPress={() => ctx.info(key)} />
    </Shell>
  );
});

/* ---------- timeline shared by film and recordings ---------- */

const TAPE_SPAN = 8; // seconds of tape under one screen width of finger travel

// Drag along the rail to seek within the excerpt. The release seeks exactly.
const useScrub = (seek: (f: number, exact: boolean) => void, onDrag: (on: boolean) => void) => {
  const width = useRef(1);
  const last = useRef(0);
  const [dragging, setDragging] = useState(false);
  const at = (x: number) => (last.current = Math.min(1, Math.max(0, x / width.current)));
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { grip.held = true; setDragging(true); onDrag(true); seek(at(e.nativeEvent.locationX), false); },
    onPanResponderMove: (e) => seek(at(e.nativeEvent.locationX), false),
    onPanResponderRelease: (e) => { grip.held = false; setDragging(false); onDrag(false); seek(at(e.nativeEvent.locationX), true); },
    onPanResponderTerminate: () => { grip.held = false; setDragging(false); onDrag(false); seek(last.current, true); },
  }), [seek, onDrag]);
  return { pan, dragging, onLayout: (w: number) => { width.current = w || 1; } };
};

const Rail = ({ progress, palette, seek, onDrag, bottom }: { progress: Animated.Value; palette: Palette; seek: (f: number, exact: boolean) => void; onDrag: (on: boolean) => void; bottom: number }) => {
  const s = useScrub(seek, onDrag);
  return (
    <View style={[styles.scrub, { bottom: bottom + 50 }]} {...s.pan.panHandlers} onLayout={(e) => s.onLayout(e.nativeEvent.layout.width)}>
      <View style={[styles.rail, { height: s.dragging ? 6 : 2, backgroundColor: palette.fg + '38' }]}>
        <Animated.View style={{ height: '100%', backgroundColor: palette.fg, width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
      </View>
    </View>
  );
};

/* ---------- film ---------- */

export const VideoCard = memo(({ entry, active, near, ctx, under }: Props) => {
  const { card } = entry;
  const m = card.media;
  const { palette, key, onSwipe } = useCommon(entry, ctx);
  const fail = useCallback(() => ctx.unplayable(key), [ctx, key]);
  const x = useExcerpt({ media: m, loops: true, near, active, sound: ctx.sound, onFail: fail });
  const flash = useRef(new Animated.Value(0)).current;
  const [flashText, setFlashText] = useState('');
  const [fast, setFast] = useState(false);
  const [full, setFull] = useState(false);
  const view = useRef<VideoView>(null);
  const shout = (text: string) => {
    setFlashText(text);
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 650, useNativeDriver: true }).start();
  };
  const onTap = (zone: Zone, double: boolean) => {
    x.toggle(); // immediate; a double tap toggles twice, so it ends where it began
    if (!double) { ctx.setUi(x.player.playing); return; }
    if (zone === 'middle') ctx.save(key, true);
    else {
      const s = zone === 'left' ? -SKIP_SECONDS : SKIP_SECONDS;
      x.skip(s);
      shout(`${s < 0 ? '−' : '+'}${SKIP_SECONDS}`);
    }
  };
  const onHold = (zone: Zone, on: boolean) => {
    if (on && zone !== 'right') { ctx.similar(key); return; }
    if (!on && !fast) return;
    x.fast(on);
    setFast(on);
  };
  return (
    <Shell palette={palette} width={ctx.w} swipeable={active} under={under} onTap={onTap} onHold={onHold} onSwipe={onSwipe}>
      <View style={[styles.stage, { top: ctx.top + 14, bottom: ctx.bottom + 62 + STRIP + 20 }]} pointerEvents="none">
        {near ? (
          <VideoView
            ref={view} player={x.player} nativeControls={full} contentFit="contain" style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]} // the web <video> needs a size, insets do not stretch it
            fullscreenOptions={{ enable: true }} onFullscreenEnter={() => setFull(true)} onFullscreenExit={() => setFull(false)}
          />
        ) : (
          <Image source={{ uri: m.poster }} contentFit="contain" style={StyleSheet.absoluteFill} />
        )}
      </View>
      <View style={[styles.strip, { bottom: ctx.bottom + 62 + 20 }]}>
        <Text style={[styles.speed, { color: palette.fg, opacity: fast && !full ? 1 : 0 }]}>2×</Text>
        <Pressable accessibilityLabel="Full screen" hitSlop={12} onPress={() => view.current?.enterFullscreen()}>
          <FullIcon color={palette.dim} />
        </Pressable>
      </View>
      <Rail progress={x.progress} palette={palette} seek={x.seek} onDrag={(on) => { if (!on) ctx.setUi(true); }} bottom={ctx.bottom} />
      {x.wait && !x.playing ? <View pointerEvents="none" style={styles.loader}><Loader size={72} /></View> : null}
      {x.failed ? <Text style={[styles.failed, { color: palette.dim }]}>Video unavailable.</Text> : null}
      <AnimatedText pointerEvents="none" style={[styles.flash, { opacity: flash, color: palette.fg }]}>{flashText}</AnimatedText>
      <Caption title={card.title} line={creditLine(card)} palette={palette} ctx={ctx} onPress={() => ctx.info(key)} />
    </Shell>
  );
});

/* ---------- recording ---------- */

export const AudioCard = memo(({ entry, active, near, ctx, under }: Props) => {
  const { card } = entry;
  const m = card.media;
  const { palette, key, onSwipe } = useCommon(entry, ctx);
  const fail = useCallback(() => ctx.unplayable(key), [ctx, key]);
  const x = useExcerpt({ media: m, loops: false, near, active, sound: ctx.sound, onFail: fail });
  const [heights, setHeights] = useState<number[]>(FLAT); // the real loudness once the excerpt is decoded; flat until then
  useEffect(() => { // normally ready already: the feed starts it when the card is admitted
    let live = true;
    peaksFor(card).then((p) => { if (live && p.length) setHeights(p); });
    return () => { live = false; };
  }, [card]);
  const [railW, setRailW] = useState(ctx.w - 40);
  const [dragging, setDragging] = useState(false);
  const onTap = (zone: Zone, double: boolean) => {
    x.toggle();
    if (!double) return;
    if (zone === 'middle') ctx.save(key, true);
    else x.skip(zone === 'left' ? -SKIP_SECONDS : SKIP_SECONDS);
  };
  // Tape scratch once the excerpt is decoded; until then (or if it cannot be) the plain seek.
  const [tape, setTape] = useState(false);
  useEffect(() => {
    if (!active || !near) return;
    let live = true;
    Tape.tapeLoad(m.url, m.start, m.end).then(() => {
      if (!live) return;
      setTape(true);
    }).catch(() => {});
    return () => { live = false; setTape(false); Tape.tapeUnload(); };
  }, [active, near, m.url, m.start, m.end]);
  // Like a hand on the tape: the head moves with the finger (sideways travel, not position), so it stops when the finger rests.
  const live = useRef({ x, tape, w: ctx.w });
  live.current = { x, tape, w: ctx.w };
  const tapePan = useMemo(() => {
    let from = 0, resume = false, span = 1;
    const at = (dx: number) => Math.min(1, Math.max(0, from + (dx / live.current.w) * (TAPE_SPAN / span)));
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const { x: ex } = live.current;
        grip.held = true; setDragging(true);
        span = m.end - m.start;
        from = (ex.player.currentTime - m.start) / span;
        resume = ex.player.playing;
        ex.player.pause();
        Tape.tapeHold(from);
      },
      onPanResponderMove: (_, g) => { Tape.tapeMove(at(g.dx)); live.current.x.look(at(g.dx)); },
      onPanResponderRelease: (_, g) => {
        grip.held = false; setDragging(false);
        Tape.tapeRelease();
        live.current.x.seek(at(g.dx), true);
        if (resume) live.current.x.toggle();
      },
      onPanResponderTerminate: () => {
        grip.held = false; setDragging(false);
        Tape.tapeRelease();
        if (resume) live.current.x.toggle();
      },
    });
  }, [m.start, m.end]);
  const s = useScrub(x.seek, setDragging);
  const length = m.end - m.start;
  const bars = (color: string) => (
    <View style={[styles.bars, { width: railW }]}>
      {heights.map((h, i) => <View key={i} style={{ flex: 1, maxWidth: 4, marginHorizontal: 0.75, height: `${Math.round(h * 100)}%`, backgroundColor: color, borderRadius: 1 }} />)}
    </View>
  );
  const head = x.progress.interpolate({ inputRange: [0, 1], outputRange: [0, railW] });
  const playing = x.playing;
  return (
    <Shell palette={palette} width={ctx.w} swipeable={active} under={under} onTap={onTap} onHold={(_, on) => on && ctx.similar(key)} onSwipe={onSwipe}>
      <View
        style={[styles.wave, { top: ctx.h * 0.38, opacity: playing || dragging ? 1 : 0.55 }]}
        {...(tape ? tapePan : s.pan).panHandlers}
        onLayout={(e) => { setRailW(e.nativeEvent.layout.width); s.onLayout(e.nativeEvent.layout.width); }}
      >
        {bars(palette.dim)}
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden', width: head }}>{bars(palette.fg)}</Animated.View>
        <Animated.View style={{ position: 'absolute', top: -4, bottom: -4, width: 2, marginLeft: -1, borderRadius: 1, backgroundColor: palette.accent, transform: [{ translateX: head }], opacity: x.wait && !playing ? 0.4 : 1 }} />
      </View>
      {!playing && !dragging ? <Text style={[styles.hint, { color: palette.dim, top: ctx.h * 0.38 + 106 }]}>Tap to play</Text> : null}
      <View style={[styles.listen, { top: ctx.h * 0.38 + 118, bottom: ctx.bottom + 62 }]} pointerEvents="none">
        <Text style={{ fontSize: 13, color: palette.dim }}>{card.editorial.room === 'words' ? 'Read aloud' : 'Recording'} · {fmtTime(length)}</Text>
        <Text numberOfLines={3} style={{ fontSize: clampSize(28, 0.08, 36, ctx.w), fontWeight: '500', letterSpacing: -0.9, lineHeight: clampSize(28, 0.08, 36, ctx.w) * 1.04, color: palette.fg }}>{card.title}</Text>
      </View>
      {Platform.OS === 'web' && near ? <VideoView player={x.player} style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} /> : null /* the web player plays only through a mounted element */}
      {x.failed ? <Text style={[styles.failed, { color: palette.dim }]}>Audio unavailable.</Text> : null}
      <Caption line={creditLine(card)} palette={palette} ctx={ctx} onPress={() => ctx.info(key)} />
    </Shell>
  );
});

/* ---------- the end ---------- */

export const EndCard = ({ count, saved, onRestart }: { count: number; saved: number; onRestart: () => void }) => {
  const palette = tonePalette('paper');
  return (
    <View style={[styles.fill, { backgroundColor: palette.bg, justifyContent: 'center', paddingHorizontal: 22, gap: 12 }]}>
      <Text style={{ fontSize: 24, color: palette.fg }}>That's everything for now.</Text>
      <Text style={{ color: palette.dim }}>{count} cards{saved ? `, ${saved} saved` : ''}.</Text>
      <Pressable onPress={onRestart} style={[styles.btn, { backgroundColor: palette.fg }]}><Text style={{ color: palette.bg, fontWeight: '500' }}>Start over</Text></Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  stage: { position: 'absolute', left: 14, right: 14 },
  failed: { position: 'absolute', top: '40%', left: 20, right: 20, textAlign: 'center' },
  cap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingLeft: 20 },
  capText: { fontSize: 12.5, lineHeight: 16 },
  text: { position: 'absolute', left: 0, right: 0 },
  textContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 8 },
  loader: { position: 'absolute', left: 0, right: 0, top: '38%', alignItems: 'center' },
  strip: { position: 'absolute', left: 20, right: 20, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  speed: { fontSize: 15, fontWeight: '500' },
  scrub: { position: 'absolute', left: 20, right: 20, height: 28, justifyContent: 'flex-end', zIndex: 3 },
  rail: { width: '100%', marginBottom: 8, overflow: 'hidden' },
  wave: { position: 'absolute', left: 20, right: 20, height: 96, justifyContent: 'center' },
  bars: { position: 'absolute', left: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' },
  hint: { position: 'absolute', left: 0, right: 0, textAlign: 'center', fontSize: 13 },
  listen: { position: 'absolute', left: 0, right: 0, paddingHorizontal: 22, justifyContent: 'flex-end', gap: 6, overflow: 'hidden' },
  flash: { position: 'absolute', top: '44%', right: '12%', fontSize: 20, fontWeight: '500', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, overflow: 'hidden', backgroundColor: 'rgba(128,128,128,0.25)' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile: { width: 44, height: 44, borderRadius: 6, borderWidth: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  btn: { alignSelf: 'flex-start', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 999 },
});
