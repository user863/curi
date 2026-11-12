import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { useVideoPlayer } from 'expo-video';

const clamp = (f: number) => Math.min(1, Math.max(0, f));
export const SKIP_SECONDS = 10;
export const FAST_RATE = 2;

// Plays the excerpt window [start, end] of a source file. Film loops it; a recording stops at the end.
// The player exists only near the active card, so far-off cards hold no connection.
export const useExcerpt = ({ media, loops, near, active, sound, onFail }: {
  media: { url: string; fallback?: string; start: number; end: number }; loops: boolean; near: boolean; active: boolean; sound: boolean; onFail: () => void;
}) => {
  const { url, fallback, start, end } = media;
  const player = useVideoPlayer(near ? url : null, (p) => {
    p.timeUpdateEventInterval = 0.1;
    if (loops) p.bufferOptions = { preferredForwardBufferDuration: 20 }; // a paused film still reads ahead
    p.currentTime = start;
  });
  const progress = useRef(new Animated.Value(0)).current;
  const dragging = useRef(false);
  const retried = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [wait, setWait] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const subs = [
      player.addListener('timeUpdate', ({ currentTime }) => {
        if (currentTime >= end - 0.05) {
          player.currentTime = start;
          if (!loops) player.pause();
        }
        if (!dragging.current) progress.setValue(clamp((currentTime - start) / (end - start)));
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        setPlaying(isPlaying);
        if (isPlaying) setWait(false);
      }),
      player.addListener('statusChange', ({ status }) => {
        if (status !== 'error') return;
        if (fallback && !retried.current) {
          retried.current = true;
          player.replaceAsync(fallback).catch(() => {});
          return;
        }
        setWait(false);
        setFailed(true);
        onFail();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [player, start, end, loops, fallback, onFail, progress]);

  const inWindow = useCallback(() => player.currentTime >= start && player.currentTime < end - 0.05, [player, start, end]);
  const play = useCallback(() => {
    if (!inWindow()) player.currentTime = start;
    setWait(true);
    player.play();
  }, [player, inWindow, start]);

  // Only the active card plays, with sound.
  useEffect(() => {
    if (!near) return;
    player.muted = !sound;
    if (active) play();
    else player.pause();
  }, [active, near, sound, player, play]);

  return {
    player, progress, playing, wait, failed,
    toggle: () => { if (player.playing) player.pause(); else play(); },
    skip: (seconds: number) => { player.currentTime = Math.min(end - 0.3, Math.max(start, player.currentTime + seconds)); },
    fast: (on: boolean) => { player.playbackRate = on ? FAST_RATE : 1; },
    look: (f: number) => { dragging.current = true; progress.setValue(clamp(f)); },
    seek: (f: number, exact: boolean) => {
      dragging.current = !exact;
      player.currentTime = Math.min(end - 0.3, start + clamp(f) * (end - start));
      progress.setValue(clamp(f));
    },
  };
};
