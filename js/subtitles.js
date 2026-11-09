// DOM for captions: one line under a video, a scrolling transcript on an audio card.
import { phrases, lineAt, SUBTITLE, READER } from './captions.js';

const linesOf = new WeakMap(); // card element -> lines

const kindOf = (el) => el.dataset.type;
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// state: { status, words } from captions.js
export const render = (el, state) => {
  const audio = kindOf(el) === 'audio';
  const lines = phrases(state.words, audio ? READER : SUBTITLE);
  const same = linesOf.get(el)?.map((l) => l.text).join('|') === lines.map((l) => l.text).join('|');
  linesOf.set(el, lines);
  if (!audio) return;
  const showing = lines.length ? 'yes' : state.status === 'working' ? 'pending' : 'no';
  el.dataset.cc = showing;
  if (same) return;
  const reader = el.querySelector('.reader');
  reader.innerHTML = `<div>${
    lines.length
      ? lines.map((l) => `<p data-t="${l.t}">${escapeHtml(l.text)}</p>`).join('')
      : '<p class="note">Transcribing on this device…</p>'
  }</div>`;
  delete el.dataset.line;
};

// Called while the card plays, with the media's current time.
export const tick = (el, t) => {
  const lines = linesOf.get(el);
  if (!lines?.length) return;
  const i = lineAt(lines, t);
  if (kindOf(el) === 'audio') return tickReader(el, i);
  const sub = el.querySelector('.subs');
  const text = i >= 0 && t <= lines[i].end + 0.5 ? lines[i].text : '';
  if (sub.textContent !== text) sub.textContent = text;
};

const tickReader = (el, i) => {
  if (el.dataset.line === String(i)) return;
  el.dataset.line = String(i);
  const reader = el.querySelector('.reader');
  const rows = reader.querySelectorAll('p');
  rows.forEach((p, k) => p.classList.toggle('on', k === i));
  const row = rows[Math.max(0, i)];
  if (row) reader.scrollTo({ top: row.offsetTop - (reader.clientHeight - row.offsetHeight) / 2, behavior: 'smooth' });
};
