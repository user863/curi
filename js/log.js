// Local event log: the last 2,000 feed events, kept on this device and nowhere else. The reader can read, copy
// and clear it. An event is [time in s, kind, work id, cluster, value].
// Kinds: start, hide | show (value 1: an exploring pick) | skip, finish, dwell, left (value: seconds on the card;
// left = judged by a swipe) | save, unsave, more, less, note.
import { esc } from './views.js';

export const CAP = 2000;
const KEY = 'curi.log.v1';
const GAP_S = 300; // a longer pause starts a new sitting
const LEAVES = ['skip', 'finish', 'dwell', 'left'];

export const push = (events, e, cap = CAP) => [...events, e].slice(-cap);

// Runs of events with no long pause between them.
export const sittings = (events) => events.reduce((runs, e) => {
  const last = runs[runs.length - 1];
  return last && e[1] !== 'start' && e[0] - last[last.length - 1][0] <= GAP_S ? [...runs.slice(0, -1), [...last, e]] : [...runs, [e]];
}, []);

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

export const summary = (events) => {
  const count = (kind) => events.filter((e) => e[1] === kind).length;
  const runs = sittings(events).filter((run) => run.some((e) => e[1] === 'show'));
  const left = events.filter((e) => LEAVES.includes(e[1])).length;
  return {
    events: events.length,
    cards: count('show'),
    saves: count('save'),
    more: count('more'),
    less: count('less'),
    skipShare: left ? count('skip') / left : null,
    sittings: runs.length,
    medianMinutes: runs.length ? median(runs.map((run) => (run[run.length - 1][0] - run[0][0]) / 60)) : null,
    medianCards: runs.length ? median(runs.map((run) => run.filter((e) => e[1] === 'show').length)) : null,
  };
};

export const read = (storage) => {
  try {
    return JSON.parse(storage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
};

export const write = (storage, events) => {
  try {
    storage.setItem(KEY, JSON.stringify(events));
  } catch {
    // storage full or blocked: the log is best effort
  }
};

const shown = (x, unit = '') => (x === null ? 'Not yet known' : `${Math.round(x * 10) / 10}${unit}`);

export const sheetHtml = (events) => {
  const s = summary(events);
  const rows = [
    ['Events', `${s.events} of ${CAP} kept`],
    ['Cards', s.cards],
    ['Verdicts', `${s.saves} saved, ${s.more} more, ${s.less} less`],
    ['Skipped', s.skipShare === null ? shown(null) : `${Math.round(s.skipShare * 100)}%`],
    ['Sittings', s.sittings],
    ['Median', s.medianMinutes === null ? shown(null) : `${shown(s.medianMinutes, ' min')}, ${s.medianCards} cards`],
  ];
  return `<h2 id="sheet-title">Activity log</h2>
    <p class="line dim">What the feed showed and what you did, on this device only. Nothing here is sent unless you opt in to share usage data.</p>
    <dl class="spec">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl>
    <textarea class="log-dump" readonly rows="6" aria-label="Log as JSON">${esc(JSON.stringify(events))}</textarea>
    <div class="actions">
      <button type="button" class="btn" data-log="copy">Copy</button>
      <button type="button" class="btn ghost" data-log="clear">Clear</button>
    </div>`;
};
