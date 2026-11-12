// Read a passage aloud. In the iOS app the voice is Kokoro-82M running on the device (ios/SpeechBridge.swift); in a plain browser it
// is the system voice (speechSynthesis). `chunks` is pure; `speaker` is the thin layer over whichever voice there is.
// Nothing is shown but the speaker button's state. A tap on the card pauses and resumes.

const RATE = { prose: 0.98, verse: 0.9 };
// Kokoro voice styles bundled in the app (ios/Kokoro/voices.npz), all English: American (af, am) and British (bf, bm). One is chosen at random for each reading, unless the reader picks one.
export const VOICES = ['af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'];
const MAX_CHARS = 200; // Kokoro takes up to about 500 phonemes at a time, and memory grows with the length
const GAP_MS = { sentence: 140, line: 260, stanza: 700 };

// What is spoken, in order: sentences for prose, lines for verse. { text, start, end, gap } with offsets into the body.
export const chunks = (body, verse) => {
  const out = [];
  if (verse) {
    [...body.matchAll(/[^\n]+/g)].forEach((m) => {
      const text = m[0].trim();
      if (!text) return;
      const start = m.index + m[0].indexOf(text);
      const next = body.slice(m.index + m[0].length).match(/^\n+/);
      out.push({ text, start, end: start + text.length, gap: next && next[0].length > 1 ? GAP_MS.stanza : GAP_MS.line });
    });
  } else {
    [...body.matchAll(/[^.!?]+(?:[.!?]+["”’)]*)?\s*/g)].forEach((m) => {
      const text = m[0].trim();
      if (text) out.push({ text, start: m.index + m[0].indexOf(text), end: m.index + m[0].indexOf(text) + text.length, gap: GAP_MS.sentence });
    });
  }
  return limit(out);
};

// A very long sentence or line is split at its last comma or space under the limit.
export const limit = (cs, max = MAX_CHARS) => cs.flatMap((c) => {
  if (c.text.length <= max) return [c];
  const cut = Math.max(c.text.lastIndexOf(', ', max), c.text.lastIndexOf('; ', max), c.text.lastIndexOf(' ', max), 1);
  const first = c.text.slice(0, cut + 1).trim();
  const rest = c.text.slice(cut + 1).trim();
  return [{ ...c, text: first, end: c.start + cut + 1, gap: 60 }, ...limit([{ ...c, text: rest, start: c.end - rest.length }], max)];
});

// The passages are English, so the system voice is too, whatever the device's language: the best English voice installed.
const LANG = 'en-US';
const pickVoice = (synth) => {
  const english = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
  const rank = (v) => (/premium|enhanced/i.test(v.name) ? 4 : 0) + (/siri/i.test(v.name) ? 2 : 0) + (/^en[-_](GB|US)/i.test(v.lang) ? 1 : 0);
  return english.sort((a, b) => rank(b) - rank(a))[0] || null;
};

// One reader at a time. States: 'loading' (the model is starting) | 'playing' | 'paused'.
// A tap pauses by stopping at the sentence; resuming repeats that sentence.
export const speaker = (synth = globalThis.speechSynthesis, bridge = globalThis.webkit?.messageHandlers?.speech) => {
  let s = null;
  let seq = 0;
  const mark = (state) => {
    if (!s) return;
    s.el.dataset.speech = state;
    s.el.querySelector('.speak')?.setAttribute('aria-pressed', 'true');
  };
  const stop = () => {
    if (!s) return;
    const cur = s;
    s = null;
    cur.gen += 1;
    clearTimeout(cur.timer);
    cur.el.querySelector('.speak')?.setAttribute('aria-pressed', 'false');
    delete cur.el.dataset.speech;
    if (cur.native) bridge.postMessage({ op: 'stop' });
    synth?.cancel();
  };

  // ---- the voice in the iOS app: Kokoro, asked for everything from chunk `from` on; it reports each chunk as it finishes playing
  const readNative = (from) => {
    s.native = true;
    s.base = from;
    s.i = from;
    s.id = seq += 1;
    mark('loading');
    bridge.postMessage({ op: 'read', id: s.id, voice: s.voice, chunks: s.chunks.slice(from).map((c) => ({ t: c.text, gap: c.gap })) });
  };
  globalThis.commonplaceSpeech = (e) => {
    if (!s || !s.native || e.id !== s.id) return;
    if (e.event === 'first') mark('playing');
    else if (e.event === 'chunk') s.i = s.base + e.i + 1;
    else if (e.event === 'done') stop();
    else if (e.event === 'error') { // Kokoro could not run: read with the system voice from here
      console.warn('speech: Kokoro failed:', e.message);
      s.native = false;
      mark('playing');
      speakFrom(s.i);
    }
  };

  // ---- the system voice (a plain browser, or when Kokoro failed)
  const speakFrom = (i) => {
    if (!s) return;
    const cur = s;
    if (i >= cur.chunks.length) return stop();
    const c = cur.chunks[i];
    cur.i = i;
    const gen = (cur.gen += 1);
    const u = new SpeechSynthesisUtterance(c.text);
    const voice = pickVoice(synth);
    u.lang = voice ? voice.lang : LANG;
    if (voice) u.voice = voice;
    u.rate = cur.verse ? RATE.verse : RATE.prose;
    u.onend = () => {
      if (cur.gen === gen && s === cur) cur.timer = setTimeout(() => speakFrom(i + 1), c.gap);
    };
    u.onerror = (e) => {
      if (cur.gen === gen && !/canceled|interrupted/.test(e.error)) stop();
    };
    synth.speak(u);
  };
  const resume = (from) => {
    if (bridge) readNative(from);
    else speakFrom(from);
  };

  return {
    active: () => (s ? s.el : null),
    state: () => (s ? s.el.dataset.speech : null),
    start(el, body, verse, voice) {
      stop();
      if (!bridge && !synth) return false;
      s = { el, chunks: chunks(body, verse), verse, i: 0, gen: 0, timer: 0, native: false, id: 0, base: 0, voice: voice || VOICES[Math.floor(Math.random() * VOICES.length)] }; // the same voice through pauses and resumes
      mark('playing');
      resume(0);
      return true;
    },
    // A tap on the card: pause or resume. Returns true when it is now playing.
    toggle() {
      if (!s) return false;
      if (s.el.dataset.speech !== 'paused') {
        s.gen += 1;
        clearTimeout(s.timer);
        if (s.native) bridge.postMessage({ op: 'stop' });
        synth?.cancel();
        mark('paused');
        return false;
      }
      mark('playing');
      resume(s.i);
      return true;
    },
    stop,
  };
};
