// On-device captions. The iOS app transcribes the excerpt with Apple's on-device speech recogniser and
// hands back timed words; nothing leaves the phone. In a plain browser there is no recogniser: `available` is false.

const handler = window.webkit?.messageHandlers?.captions;
export const available = Boolean(handler);

const GAP_S = 0.7; // a longer pause starts a new line
const SENTENCE_END = /[.!?…]["')\]]*$/;
const CLAUSE_END = /[,;:—–]["')\]]*$/;

export const SUBTITLE = { maxChars: 44, maxWords: 9 }; // under a video
export const READER = { maxChars: 90, maxWords: 18 }; // scrolling transcript

// words [{ t, d, w }] -> lines [{ t, end, text }]
export const phrases = (words, { maxChars, maxWords }) => {
  const line = (ws) => ({ t: ws[0].t, end: ws[ws.length - 1].t + ws[ws.length - 1].d, text: ws.map((x) => x.w).join(' ') });
  const { lines, cur } = words.reduce(({ lines: out, cur: ws }, word) => {
    const prev = ws[ws.length - 1];
    const [done, open] = prev && word.t - (prev.t + prev.d) > GAP_S ? [[...out, line(ws)], []] : [out, ws];
    const next = [...open, word];
    const chars = next.reduce((n, x) => n + x.w.length + 1, 0);
    const close = SENTENCE_END.test(word.w) || next.length >= maxWords || chars >= maxChars
      || (CLAUSE_END.test(word.w) && chars >= maxChars * 0.6);
    return close ? { lines: [...done, line(next)], cur: [] } : { lines: done, cur: next };
  }, { lines: [], cur: [] });
  return cur.length ? [...lines, line(cur)] : lines;
};

// Index of the line being spoken at time t, or -1 before the first.
export const lineAt = (lines, t) => lines.reduce((found, l, i) => (l.t <= t + 0.05 ? i : found), -1);

/* ---------- bridge to the app ---------- */

const jobs = new Map(); // card id -> { status: 'working' | 'done' | 'none' | 'unavailable', words }
let notify = () => {};

export const stateOf = (id) => jobs.get(id);

// Native replies, possibly several times per job while it listens: { id, status, words: [[t, d, word], ...] }
window.commonplaceCaptions = ({ id, status, words }) => {
  jobs.set(id, { status, words: words.map(([t, d, w]) => ({ t, d, w })) });
  notify(id);
};

// Ask for these cards (the active one first). Replaces the app's queue, so cards scrolled past stop costing work.
export const want = (list, onChange) => {
  if (!available) return;
  notify = onChange;
  const open = list.filter((j) => !['done', 'none'].includes(jobs.get(j.id)?.status));
  if (open.length) handler.postMessage({ want: open });
};
