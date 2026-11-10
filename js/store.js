// Device-local state. Nothing leaves the browser.
// `seen` and `bad` are bitsets over dense work ids (100k works = 12.5 KB each). `bad`: pictures their source refuses to serve.
import { emptyProfile } from './rank.js';

const KEY = 'commonplace.v2';

export const hasBit = (bits, id) => id >> 3 < bits.length && (bits[id >> 3] & (1 << (id & 7))) !== 0;

export const withBit = (bits, id) => {
  const out = new Uint8Array(Math.max(bits.length, (id >> 3) + 1));
  out.set(bits);
  out[id >> 3] |= 1 << (id & 7);
  return out;
};

const toBase64 = (bits) => {
  let s = '';
  bits.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
};
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// session: where pacing stopped, { setNo, pos, plan }, so a set resumes.
// onboarded: 'yes' | 'no' (skipped) | 'unknown' (not asked yet)
export const initial = () => ({ profile: emptyProfile(), saved: [], savedCl: {}, seen: new Uint8Array(0), bad: new Uint8Array(0), onboarded: 'unknown', filter: { types: [], tags: [] }, colour: 'palette', sets: false, nav: 'icons', session: null });

export const load = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    return raw ? { ...initial(), ...raw, seen: raw.seen ? fromBase64(raw.seen) : new Uint8Array(0), bad: raw.bad ? fromBase64(raw.bad) : new Uint8Array(0) } : initial();
  } catch {
    return initial();
  }
};

export const save = (state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, seen: toBase64(state.seen), bad: toBase64(state.bad) }));
  } catch {
    // storage blocked: the session still works, it just won't persist
  }
};
