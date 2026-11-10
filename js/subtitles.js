// DOM for captions: one line under a film.
import { phrases, lineAt, SUBTITLE } from './captions.js';

const linesOf = new WeakMap(); // card element -> lines

// state: { status, words } from captions.js
export const render = (el, state) => {
  linesOf.set(el, phrases(state.words, SUBTITLE));
};

// Called while the card plays, with the media's current time.
export const tick = (el, t) => {
  const lines = linesOf.get(el);
  if (!lines?.length) return;
  const i = lineAt(lines, t);
  const sub = el.querySelector('.subs');
  const text = i >= 0 && t <= lines[i].end + 0.5 ? lines[i].text : '';
  if (sub.textContent !== text) sub.textContent = text;
};
