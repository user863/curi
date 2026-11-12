// Web counterpart of the Swift module's audio half: loudness peaks and tape scrub on Web Audio.
// Read-aloud needs no bridge here (js/speech.js uses speechSynthesis).
type Excerpt = { fwd: AudioBuffer; back: AudioBuffer; length: number };

let ctx: AudioContext | undefined;
const context = () => (ctx ??= new AudioContext());
const GRAIN = 0.09; // seconds of tape sounded per move
const MAX_RATE = 8;

const decode = async (url: string, start: number, end: number) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  const whole = await context().decodeAudioData(await res.arrayBuffer());
  const rate = whole.sampleRate;
  const from = Math.max(0, Math.floor(start * rate));
  const to = Math.min(whole.length, Math.ceil(end * rate));
  return { whole, from, to };
};

const slice = (b: AudioBuffer, from: number, to: number, reverse: boolean) => {
  const out = context().createBuffer(b.numberOfChannels, to - from, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const part = b.getChannelData(c).slice(from, to);
    out.copyToChannel(reverse ? part.reverse() : part, c);
  }
  return out;
};

const peaksOf = (b: AudioBuffer, from: number, to: number, n: number) => {
  const per = Math.max(1, Math.floor((to - from) / n));
  const raw = Array.from({ length: n }, (_, i) => {
    let top = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const data = b.getChannelData(c);
      for (let k = from + i * per; k < Math.min(to, from + (i + 1) * per); k++) top = Math.max(top, Math.abs(data[k]));
    }
    return top;
  });
  const max = Math.max(...raw, 1e-6);
  return raw.map((v) => Math.min(1, Math.max(0.08, Math.sqrt(v / max)))); // sqrt lifts quiet passages
};

let excerpt: Excerpt | undefined;
let head = 0; // fraction of the excerpt under the tape head
let at = 0; // time of the last move
let voice: AudioBufferSourceNode | undefined;

const grain = (f: number) => {
  const e = excerpt;
  if (!e) return;
  const now = context().currentTime;
  const dt = Math.max(0.016, now - at);
  const speed = Math.min(MAX_RATE, Math.abs(f - head) * e.length / dt);
  const forward = f >= head;
  head = f;
  at = now;
  if (speed < 0.05) return;
  const src = context().createBufferSource();
  const gain = context().createGain();
  src.buffer = forward ? e.fwd : e.back;
  src.playbackRate.value = speed;
  const offset = forward ? f * e.length : (1 - f) * e.length;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(1, now + 0.01);
  gain.gain.linearRampToValueAtTime(0, now + GRAIN);
  src.connect(gain).connect(context().destination);
  src.start(now, Math.min(offset, e.length - 0.01), GRAIN * speed);
  voice?.stop();
  voice = src;
};

export default {
  async audioPeaks(url: string, start: number, end: number, n: number) {
    const { whole, from, to } = await decode(url, start, end);
    return peaksOf(whole, from, to, n);
  },
  async tapeLoad(url: string, start: number, end: number) {
    const { whole, from, to } = await decode(url, start, end);
    excerpt = { fwd: slice(whole, from, to, false), back: slice(whole, from, to, true), length: (to - from) / whole.sampleRate };
    return true;
  },
  tapeHold(f: number) { void context().resume(); head = f; at = context().currentTime; },
  tapeMove: grain,
  tapeRelease() { voice?.stop(); voice = undefined; },
  tapePeaks(n: number) { return excerpt ? peaksOf(excerpt.fwd, 0, excerpt.fwd.length, n) : []; },
  tapeUnload() { excerpt = undefined; },
};
