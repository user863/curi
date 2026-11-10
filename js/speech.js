// Read a passage aloud with the system voice (speechSynthesis). `chunks` is pure; `speaker` is the thin layer over the browser.
// Nothing is shown but the speaker button's state. A tap on the card pauses and resumes.

const RATE = { prose: 0.98, verse: 0.9 };
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
  return out;
};

// The passages are English, so the voice is too, whatever the device's language: the best English voice installed.
const LANG = 'en-US';
const pickVoice = (synth) => {
  const english = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
  const rank = (v) => (/premium|enhanced/i.test(v.name) ? 4 : 0) + (/siri/i.test(v.name) ? 2 : 0) + (/^en[-_](GB|US)/i.test(v.lang) ? 1 : 0);
  return english.sort((a, b) => rank(b) - rank(a))[0] || null;
};

// One reader at a time. States: 'playing' | 'paused'. A tap pauses by stopping at the sentence; resuming repeats that sentence.
export const speaker = (synth = globalThis.speechSynthesis) => {
  let s = null;
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
    synth.cancel();
  };
  const speakFrom = (i) => {
    if (!s) return;
    const cur = s;
    if (i >= cur.chunks.length) return stop();
    const c = cur.chunks[i];
    cur.i = i;
    const gen = (cur.gen += 1);
    const u = new SpeechSynthesisUtterance(c.text);
    const voice = pickVoice(synth);
    u.lang = voice ? voice.lang : LANG; // with no English voice installed, the system still reads it as English
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
  return {
    active: () => (s ? s.el : null),
    state: () => (s ? s.el.dataset.speech : null),
    start(el, body, verse) {
      stop();
      if (!synth) return false;
      s = { el, chunks: chunks(body, verse), verse, i: 0, gen: 0, timer: 0 };
      mark('playing');
      speakFrom(0);
      return true;
    },
    // A tap on the card: pause or resume. Returns true when it is now playing.
    toggle() {
      if (!s) return false;
      if (s.el.dataset.speech === 'playing') {
        s.gen += 1;
        clearTimeout(s.timer);
        synth.cancel();
        mark('paused');
        return false;
      }
      mark('playing');
      speakFrom(s.i);
      return true;
    },
    stop,
  };
};
