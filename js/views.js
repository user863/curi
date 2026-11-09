// HTML builders. Pure: data in, string out.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const words = (s) => s.trim().split(/\s+/).length;
const sizeClass = (n) => (n <= 55 ? 'lg' : n <= 110 ? 'md' : 'sm');
const tagName = (t) => t.replace(/-/g, ' ');
const join = (parts, sep = ' · ') => parts.filter(Boolean).join(sep);

export const fmtTime = (s) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const LICENSE_LABEL = { CC0: 'CC0', PDM: 'Public domain', 'CC-BY': 'CC BY', 'CC-BY-SA': 'CC BY-SA' };
const licenseLabel = (r) => LICENSE_LABEL[r.license] || r.license;
const posterOf = (c) => (c.type === 'image' ? c.media.url : c.type === 'passage' ? '' : c.media.poster);

export const featureLabel = (feature, rooms) => {
  const [kind, name] = [feature.slice(0, 1), feature.slice(2)];
  return kind === 'r' ? rooms[name] : tagName(name);
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

const playIcon = `<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
  <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>`;

export const cardHtml = (card) => {
  const m = card.media;
  const attrs = `class="card" data-id="${esc(card.id)}" data-type="${card.type}" data-tone="${card.editorial.tone}"`;
  if (card.type === 'passage') {
    const work = card.source.work === card.title ? '' : card.source.work;
    return `<section ${attrs} aria-label="${esc(card.creator)}, ${esc(card.title)}">
      <div class="text ${sizeClass(words(card.text.body))}${card.text.verse ? ' verse' : ''}">${passageBody(card.text)}</div>
      ${cap(card.creator, join([card.title, work, card.date]) + ' · Public domain')}
    </section>`;
  }
  const line = join([join([who(card), card.date], ', '), card.source.institution.replace(/, Open Access/, ''), licenseLabel(card.rights)]);
  if (card.type === 'video') {
    return `<section ${attrs} data-start="${m.start}" data-end="${m.end}" aria-label="${esc(card.title)}, film excerpt">
      <div class="stage"><video class="art ready" src="${esc(m.url)}" poster="${esc(m.poster)}" playsinline preload="none" data-fallback="${esc(m.fallback || '')}"
        aria-label="${esc(card.title)}"></video><p class="subs" aria-live="off"></p></div>
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
        <p class="by">${esc(join([who(card), card.date], ', '))}</p>
        <div class="reader" aria-label="Transcript"></div>
        <button type="button" class="play" data-act="play" aria-label="Play excerpt" aria-pressed="false">${playIcon}</button>
        <div class="track" aria-hidden="true"><i></i></div>
      </div>
      <audio src="${esc(m.url)}" preload="none" data-fallback="${esc(m.fallback || '')}"></audio>
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

export const endCardHtml = (count, savedCount, exhausted) => `
  <section class="card end" data-id="end" data-type="end" data-tone="paper" aria-label="End of this session">
    <div class="text md">
      <p>${exhausted ? "That's everything for now." : "That's enough for now."}</p>
      <p class="dim">${count} cards${savedCount ? `, ${savedCount} saved` : ''}.</p>
    </div>
    <div class="meta"><button type="button" class="btn" data-act="more-session">${exhausted ? 'Start over' : 'Keep going'}</button></div>
  </section>`;

const row = (k, v) => (v ? `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>` : '');

const linkLabel = { image: 'View at the source', video: 'Watch the full film', audio: 'Open the full recording', passage: 'Read the full text' };

export const noteSheetHtml = (card) => {
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
    <dl class="spec">${rows}</dl>
    <p class="link"><a href="${esc(card.source.url)}" target="_blank" rel="noopener noreferrer">${linkLabel[card.type]} ↗</a></p>`;
};

export const whySheetHtml = (card, reason, rooms, categories) => `
  <h2 id="sheet-title">Why this?</h2>
  <p class="note">${esc(reasonText(reason, rooms, categories))}</p>
  <p class="line dim">Room</p><p class="chips"><span>${esc(rooms[card.editorial.room])}</span></p>
  <p class="line dim">Tags</p><p class="chips">${card.editorial.tags.map((t) => `<span>${esc(tagName(t))}</span>`).join('')}</p>
  <p class="line dim">Ranking runs on this device. Nothing about what you look at is sent anywhere.</p>
  <p><button type="button" class="btn ghost" data-act="open-interests">Your interests</button></p>`;

const labelsOf = (c, rooms) => Object.entries(c.labels).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([l]) => featureLabel(l, rooms)).join(', ');

export const interestsSheetHtml = (profile, rooms, mix, categories) => {
  const follows = (r) => profile.cents.some((c) => c.room === r);
  const list = (kind, title) => (profile[kind].length ? `<p class="line dim">${title}</p>
    <ul class="learned">${profile[kind].map((c, i) => `<li><span>${esc(labelsOf(c, rooms))}</span>
      <button type="button" data-forget="${kind}:${i}" aria-label="Forget ${esc(labelsOf(c, rooms))}">Forget</button></li>`).join('')}</ul>` : '');
  return `<h2 id="sheet-title">Your interests</h2>
    <p class="line dim">Stored on this device. Edit or clear them any time.</p>
    <p class="chips toggles">${Object.entries(rooms).map(([r, label]) =>
      `<button type="button" data-room="${esc(r)}" aria-pressed="${follows(r)}">${esc(label)}</button>`).join('')}</p>
    <p class="line dim">Your mix</p>
    <p class="chips">${categories.map((c) => `<span>${esc(c.label)} ${Math.round(mix[c.id] * 100)}%</span>`).join('')}</p>
    ${list('cents', 'More of')}${list('negs', 'Less of')}
    <p><button type="button" class="btn ghost" data-act="reset">Reset interests</button></p>`;
};

export const savedSheetHtml = (cards) => `
  <h2 id="sheet-title">Saved</h2>
  ${cards.length ? `<ul class="saved">${cards.map((c) => `<li>
      <button type="button" data-open="${c.n}">
        ${c.type === 'passage' ? `<span class="glyph" aria-hidden="true">“</span>` : `<img src="${esc(posterOf(c))}" alt="" referrerpolicy="no-referrer" loading="lazy">`}
        <span><strong>${esc(c.type === 'passage' ? c.creator : c.title)}</strong><br><span class="dim">${esc(c.type === 'passage' ? c.title : c.creator)}</span></span>
      </button>
      <button type="button" class="remove" data-unsave="${c.n}" aria-label="Remove ${esc(c.title)}">Remove</button></li>`).join('')}</ul>`
    : '<p class="note">Nothing saved yet. Double-tap a card, or press Save.</p>'}`;

export const onboardingHtml = (rooms, samples) => {
  const tile = (room, label) => {
    const c = samples[room];
    const inner = c.image
      ? `<img src="${esc(c.image)}" alt="" referrerpolicy="no-referrer" decoding="async">`
      : `<span class="sample" data-tone="${esc(c.tone)}">${esc(c.text)}</span>`;
    return `<button type="button" class="tile" data-room="${esc(room)}" aria-pressed="false">${inner}<span class="label">${esc(label)}</span></button>`;
  };
  return `<div class="inner">
    <h1>What are you curious about?</h1>
    <p class="dim">Choose at least two. It stays on this device.</p>
    <div class="tiles">${Object.entries(rooms).map(([r, l]) => tile(r, l)).join('')}</div>
    <div class="foot"><button type="button" class="btn" id="start" disabled>Start</button>
    <button type="button" class="linkish" id="skip">Skip</button></div></div>`;
};
