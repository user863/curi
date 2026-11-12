import { Platform } from 'react-native';
import Tape from '../modules/commonplace-speech';
import { shape } from '../../js/wave.js';

export const BARS = 96;
export const FLAT = Array.from({ length: BARS }, () => 0.08);

// Loudness bars of an audio card's excerpt. Computed once per card, two at a time (each downloads the whole file),
// and started as soon as the feed admits the card, so the bars are ready by the time it is reached.
const cache = new Map<string, Promise<number[]>>();
const lanes: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
let turn = 0;

export const peaksFor = (card: any): Promise<number[]> => {
  const hit = cache.get(card.id);
  if (hit) return hit;
  const m = card.media;
  // A host without CORS headers gives the page no samples; the web then draws the bars from the card id, as the old web app did.
  const run = () => Tape.audioPeaks(m.url, m.start, m.end, BARS).catch(() => {
    if (Platform.OS === 'web') return shape(card.id, BARS) as number[];
    cache.delete(card.id);
    return [] as number[];
  });
  const lane = turn++ % lanes.length;
  const job = lanes[lane].then(run);
  lanes[lane] = job;
  cache.set(card.id, job);
  return job;
};
