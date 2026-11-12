// HTML builders. Pure: data in, string out.
import { shape, barsHtml } from './wave.js';
import { complement, luminance } from './colour.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const words = (s) => s.trim().split(/\s+/).length;
const sizeClass = (n) => (n <= 55 ? 'lg' : n <= 110 ? 'md' : 'sm');
const tagName = (t) => t.replace(/-/g, ' ');
const join = (parts, sep = ' · ') => parts.filter(Boolean).join(sep);

// Card colours for a picture: background (the complement of its border colour), text, and the top bar over it.
export const swatchColours = (hex) => {
  const bg = complement(hex);
  const dark = luminance(bg) < 0.35;
  const [fg, inv] = dark ? ['#fff', bg] : ['#000', '#ececec'];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  return {
    card: `--bg:${bg};--fg:${fg};--dim:color-mix(in srgb, ${fg} 66%, transparent)`,
    barBg: `rgba(${r},${g},${b},0.88)`, barFg: fg, barInv: inv,
  };
};

export const fmtTime = (s) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const LICENSE_LABEL = { CC0: 'CC0', PDM: 'Public domain', 'CC-BY': 'CC BY', 'CC-BY-SA': 'CC BY-SA', 'LOC-FREE': 'Free to use', 'LOC-ATTR': 'Free to use, credit' };
const licenseLabel = (r) => LICENSE_LABEL[r.license] || r.license;

export const featureLabel = (feature, rooms) => {
  const [kind, name] = [feature.slice(0, 1), feature.slice(2)];
  return kind === 'r' ? rooms[name] ?? tagName(name) : tagName(name);
};

export const reasonText = (reason, rooms, categories = []) => {
  const f = reason.feature ? featureLabel(reason.feature, rooms) : '';
  const n = reason.count;
  const cat = categories.find((c) => c.id === reason.category);
  const mix = cat && reason.share ? ` ${cat.label} is about ${Math.round(reason.share * 100)}% of your feed right now.` : '';
  return `${base(reason, f, n)}${mix}`;
};

const base = (reason, f, n) => {
  switch (reason.kind) {
    case 'saved': return `Because you saved ${n === 1 ? 'a work' : `${n} works`} tagged "${f}".`;
    case 'more': return `Because you asked for more "${f}".`;
    case 'picked': return `Because you chose ${f}.`;
    case 'learned': return `Matches what you've looked at: "${f}".`;
    case 'search': return 'You found this by searching.';
    case 'exploring': return 'Exploring: something adjacent to your interests, picked by the pipeline for quality.';
    default: return 'Ranked high by the pipeline on source quality signals.';
  }
};

const passageBody = ({ body, verse }) =>
  verse
    ? body.split(/\n\s*\n/).map((st) => `<p>${st.split('\n').map(esc).join('<br>')}</p>`).join('')
    : `<p>${esc(body)}</p>`;

const cap = (title, line) => `<p class="cap">${title ? `<strong>${esc(title)}</strong>` : ''}<span>${esc(line)}</span></p>`;
const who = (c) => (c.creator === 'Unknown' ? '' : c.creator);

const speakIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z" fill="currentColor"/>
  <path d="M15.4 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.8 7.8 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

export const cardHtml = (card) => {
  const m = card.media;
  const attrs = `class="card" data-id="${esc(card.id)}" data-type="${card.type}" data-tone="${card.editorial.tone}"`;
  if (card.type === 'passage') {
    const work = card.source.work === card.title ? '' : card.source.work;
    return `<section ${attrs} aria-label="${esc(card.creator)}, ${esc(card.title)}">
      <div class="text ${sizeClass(words(card.text.body))}${card.text.verse ? ' verse' : ''}">${passageBody(card.text)}</div>
      ${cap(card.creator, join([card.title, work, card.date]) + ' · Public domain')}
      <button type="button" class="speak" data-act="speak" aria-label="Read aloud" aria-pressed="false">${speakIcon}</button>
    </section>`;
  }
  const line = join([join([who(card), card.date], ', '), card.source.institution.replace(/, Open Access/, ''), licenseLabel(card.rights)]);
  if (card.type === 'video') {
    return `<section ${attrs} data-start="${m.start}" data-end="${m.end}" aria-label="${esc(card.title)}, film excerpt">
      <button type="button" class="exit" data-act="exit-full" aria-label="Exit full screen">Exit</button>
      <div class="stage"><video class="art ready" src="${esc(m.url)}" poster="${esc(m.poster)}" playsinline preload="none" data-fallback="${esc(m.fallback || '')}"
        aria-label="${esc(card.title)}"></video><p class="subs" aria-live="off"></p></div>
      <div class="scrub" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="rail"><i></i></span><b class="when"></b></div>
      <p class="failed" hidden>Video unavailable. <a href="${esc(card.source.url)}" target="_blank" rel="noopener noreferrer">View at the source</a></p>
      ${cap(card.title, line)}
    </section>`;
  }
  if (card.type === 'audio') {
    const length = m.end - m.start;
    return `<section ${attrs} data-start="${m.start}" data-end="${m.end}" aria-label="${esc(card.title)}, audio excerpt">
      <div class="listen">
        <p class="kind">${esc(card.editorial.room === 'words' ? 'Read aloud' : 'Recording')} · ${fmtTime(length)}</p>
        <p class="big">${esc(card.title)}</p>
      </div>
      <audio src="${esc(m.url)}" preload="none" data-fallback="${esc(m.fallback || '')}"></audio>
      <div class="scrub" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="rail">${barsHtml(shape(card.id))}</span><b class="when"></b></div>
      <p class="hint">Tap to play</p>
      <p class="failed" hidden>Audio unavailable. <a href="${esc(card.source.url)}" target="_blank" rel="noopener noreferrer">View at the source</a></p>
      ${cap('', line)}
    </section>`;
  }
  return `<section ${attrs} aria-label="${esc(card.title)}, ${esc(card.creator)}">
    <div class="stage"><img class="art" src="${esc(m.url)}" alt="${esc(card.title)}, ${esc(card.creator)}, ${esc(card.date)}"
      referrerpolicy="no-referrer" decoding="async"></div>
    <p class="failed" hidden>Image unavailable. <a href="${esc(card.source.url)}" target="_blank" rel="noopener noreferrer">View at the source</a></p>
    ${cap(card.title, line)}
  </section>`;
};

// One picture of a set (gallery), for the horizontal strip. `n` of `total`, counted from 1.
export const setSlideHtml = (card) => `
  <figure class="slide" data-id="${esc(card.id)}">
    <img src="${esc(card.media.url)}" alt="${esc(card.title)}" referrerpolicy="no-referrer" decoding="async" draggable="false">
    <figcaption><strong>${esc(card.title)}</strong><span>${esc(join([who(card), card.date], ', '))}</span></figcaption>
  </figure>`;

export const endCardHtml = (count, savedCount) => `
  <section class="card end" data-id="end" data-type="end" data-tone="paper" aria-label="End of the feed">
    <div class="text md">
      <p>That's everything for now.</p>
      <p class="dim">${count} cards${savedCount ? `, ${savedCount} saved` : ''}.</p>
    </div>
    <div class="meta"><button type="button" class="btn" data-act="more-session">Start over</button></div>
  </section>`;

// The pause between two sets: a quiet card, filled in when it is reached (see app.js fillInterlude).
export const interludeHtml = () => `
  <section class="card break" data-id="break" data-type="break" data-tone="paper" aria-label="Pause between sets">
    <div class="text md"></div>
  </section>`;

// tiles: [{ pic, glyph, tone, saved }] for the set just seen. minutes: shown in small type in long sittings.
export const interludeBodyHtml = ({ tiles, saved, minutes }) => `
  <p>That was a set of ${tiles.length}.</p>
  <div class="tiles" aria-hidden="true">${tiles.map((t) => `<span class="tile" data-tone="${esc(t.tone)}" data-saved="${t.saved ? 'yes' : 'no'}">${
    t.pic ? `<img src="${esc(t.pic)}" alt="" referrerpolicy="no-referrer" decoding="async" draggable="false">` : esc(t.glyph)}</span>`).join('')}</div>
  <p class="dim">${saved ? `${saved} saved from it.` : 'Swipe on when you like.'}</p>
  ${minutes ? `<p class="dim small">${minutes} min so far</p>` : ''}
  <p><button type="button" class="btn" data-act="continue">Keep going</button></p>`;

const row = (k, v) => (v ? `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>` : '');

const linkLabel = { image: 'View at the source', video: 'Watch the full film', audio: 'Open the full recording', passage: 'Read the full text' };

// Why a card is in the feed: the reason, its room and tags, and a word on privacy.
const whyHtml = (card, reason, rooms, categories) => `
    <p class="line dim">Why you are seeing this</p>
    <p class="why">${esc(reasonText(reason, rooms, categories))}</p>
    <p class="chips"><span>${esc(rooms[card.editorial.room] ?? card.editorial.room)}</span>${card.editorial.tags.map((t) => `<span>${esc(tagName(t))}</span>`).join('')}</p>`;

// One sheet for a card: the note and where it comes from, why it was picked, rights and source.
export const infoSheetHtml = (card, { reason, rooms, categories, gallery = false }) => {
  const { rights, media: m, editorial: ed } = card;
  const rows = [
    row('Source', esc(card.source.institution)),
    row('Creator', esc(card.creator)),
    row('Date', esc(card.date)),
    card.source.collection && row('Collection', esc(card.source.collection)),
    card.type === 'image' && row('Medium', esc(m.medium)),
    card.type === 'image' && row('Culture', esc(m.culture)),
    card.type === 'image' && row('Credit', esc(rights.creditLine)),
    (card.type === 'video' || card.type === 'audio') && row('Excerpt', `${fmtTime(m.end - m.start)} of ${fmtTime(m.duration)}`),
    row('License', rights.licenseUrl ? `<a href="${esc(rights.licenseUrl)}" target="_blank" rel="noopener noreferrer">${esc(licenseLabel(rights))}</a> · ${esc(rights.jurisdictions)}` : `${esc(licenseLabel(rights))} · ${esc(rights.jurisdictions)}`),
    row('Attribution', esc(rights.attribution)),
    row('Rights check', rights.verifiedBy === 'unknown' ? 'Not yet verified by a person' : esc(rights.verifiedBy)),
    row('Retrieved', esc(card.source.fetchedAt)),
  ].filter(Boolean).join('');
  const label = ed.noteSource === 'curator' ? '' : '<p class="line dim">From the source description</p>';
  return `<h2 id="sheet-title">${esc(card.title)}</h2>
    <p class="line">${esc(join([who(card), card.date], ', '))}</p>
    ${ed.note ? `${label}<p class="note">${esc(ed.note)}</p>` : ''}
    <p class="link"><a href="${esc(card.source.url)}" target="_blank" rel="noopener noreferrer">${linkLabel[card.type]} ↗</a></p>
    ${whyHtml(card, reason, rooms, categories)}
    <p class="line dim">Ranking runs on this device. Nothing about what you look at is sent unless you opt in to share usage data.</p>
    <dl class="spec">${rows}</dl>
    <p class="actions">${gallery ? '<button type="button" class="btn ghost" data-act="open-set">More from this gallery</button>' : ''}<button type="button" class="btn ghost" data-act="open-interests">Settings</button></p>`;
};

const labelsOf = (c, rooms) => Object.entries(c.labels).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([l]) => featureLabel(l, rooms)).join(', ');

export const interestsSheetHtml = (profile, rooms, mix, categories, colour, sets = false, nav = 'icons') => {
  const follows = (r) => profile.cents.some((c) => c.room === r);
  const list = (kind, title) => (profile[kind].some((c) => !c.soft) ? `<p class="line dim">${title}</p>
    <ul class="learned">${profile[kind].map((c, i) => (c.soft ? '' : `<li><span>${esc(labelsOf(c, rooms))}</span>
      <button type="button" data-forget="${kind}:${i}" aria-label="Forget ${esc(labelsOf(c, rooms))}">Forget</button></li>`)).join('')}</ul>` : '');
  return `<h2 id="sheet-title">Settings</h2>
    <p class="line dim">Your interests are stored on this device. Edit or clear them any time.</p>
    <p class="chips toggles">${Object.entries(rooms).map(([r, label]) =>
      `<button type="button" data-room="${esc(r)}" aria-pressed="${follows(r)}">${esc(label)}</button>`).join('')}</p>
    <p class="line dim">Menus</p>
    <p class="chips toggles">${[['icons', 'Icons'], ['text', 'Text']].map(([id, label]) =>
      `<button type="button" data-nav="${id}" aria-pressed="${nav === id}">${label}</button>`).join('')}</p>
    <p class="line dim">Card colour</p>
    <p class="chips toggles">${[['palette', 'Palette'], ['image', 'Matched to the picture']].map(([id, label]) =>
      `<button type="button" data-colour="${id}" aria-pressed="${colour === id}">${label}</button>`).join('')}</p>
    <p class="line dim">Experimental</p>
    <p class="chips toggles">${[[false, 'Off'], [true, 'More from the gallery, in a card’s info']].map(([on, label]) =>
      `<button type="button" data-sets="${on}" aria-pressed="${sets === on}">${label}</button>`).join('')}</p>
    <p class="line dim">Your mix</p>
    <p class="chips">${categories.map((c) => `<span>${esc(c.label)} ${Math.round(mix[c.id] * 100)}%</span>`).join('')}</p>
    ${list('cents', 'More of')}${list('negs', 'Less of')}
    <div class="actions">
      <button type="button" class="btn ghost" data-act="reset">Reset interests</button>
      <button type="button" class="btn ghost" data-act="open-log">Activity log</button>
    </div>`;
};

export const onboardingHtml = (rooms, samples) => {
  const tile = (room, label) => {
    const c = samples[room];
    const inner = c.image
      ? `<img src="${esc(c.image)}" alt="" referrerpolicy="no-referrer" decoding="async">`
      : `<span class="sample" data-tone="${esc(c.tone)}">${esc(c.text)}</span>`;
    return `<button type="button" class="tile" data-room="${esc(room)}" aria-pressed="false">${inner}<span class="label">${esc(label)}</span></button>`;
  };
  return `<div class="inner">
    <h1>What are you interested in?</h1>
    <p class="dim">Choose at least two.</p>
    <div class="tiles">${Object.entries(rooms).map(([r, l]) => tile(r, l)).join('')}</div>
    <div class="foot"><button type="button" class="btn" id="start" disabled>Start</button>
    <button type="button" class="linkish" id="skip">Skip</button></div></div>`;
};
