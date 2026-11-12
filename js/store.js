// Device-local state. Nothing leaves the browser.
// `seen` and `bad` are bitsets over dense work ids (100k works = 12.5 KB each). `bad`: pictures their source refuses to serve.
import { emptyProfile, withAttrs } from './rank.js';

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

// A pack built on another embedding model leaves the stored taste profile and cluster ids meaningless:
// the profile starts over, saved works are found again by id. Rooms that no longer exist are dropped
// from the profile, and the room choice is asked again. Returns the patch to apply, or null.
// A model id that extends the one a profile was learned in (the 64-d vector gained blocks): interests keep their first
// coordinates and gain zeros, so nothing the reader taught the feed is lost.
const widened = (state, model, dim) => {
  if (!state.embedModel || state.embedModel === model || !model.startsWith(`${state.embedModel}+`)) return null;
  const pad = (list) => list.map((c) => ({ ...c, v: [...c.v, ...Array(Math.max(0, dim - c.v.length)).fill(0)] }));
  return { embedModel: model, profile: withAttrs({ ...state.profile, cents: pad(state.profile.cents), negs: pad(state.profile.negs) }), session: null };
};

export const migration = async (state, catalog) => {
  const model = catalog.manifest.model;
  const wider = widened(state, model, catalog.manifest.dim);
  if (wider) return wider;
  if (state.embedModel !== model) {
    const owners = state.saved.length ? await catalog.owners() : [];
    return {
      embedModel: model, profile: emptyProfile(), session: null, onboarded: 'unknown',
      savedCl: Object.fromEntries(state.saved.map((n) => [n, owners[n]]).filter(([, c]) => c !== undefined && c !== 0xFFFF)),
    };
  }
  const gone = (c) => c.room && !(c.room in catalog.rooms);
  if (!state.profile.cents.some(gone)) return state.profile.attrs ? null : { profile: withAttrs(state.profile) };
  return { profile: withAttrs({ ...state.profile, cents: state.profile.cents.filter((c) => !gone(c)) }), onboarded: 'unknown' };
};

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
