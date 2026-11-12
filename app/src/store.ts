import { useSyncExternalStore } from 'react';
import { load, save } from '../../js/store.js';

// Device-local state (shared store.js over localStorage), made observable for React.
// Writes are batched: one update often follows another within a gesture, and each write serialises everything.
const SAVE_MS = 400;
let state = load();
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export const flush = () => {
  clearTimeout(timer);
  timer = undefined;
  save(state);
};
export const getState = () => state;
export const update = (patch: Record<string, unknown>) => {
  state = { ...state, ...patch };
  timer ??= setTimeout(flush, SAVE_MS);
  listeners.forEach((l) => l());
};
export const useAppState = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, getState);
