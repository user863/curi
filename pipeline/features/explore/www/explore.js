// Canvas explorer. Every picture has a fixed size in map units (D), so it grows with the zoom. Zoomed out the pictures are
// colour squares; once a picture is big enough on screen its thumbnail loads. The layout is spread once so none overlap.
// Click a picture to open it. ?set=pack shows the published pack (92k pictures, loaded from their sources, politely).
(() => {
  const PACK = new URLSearchParams(location.search).get('set') === 'pack';
  const $ = (s) => document.querySelector(s);
  const cv = $('#cv'), ctx = cv.getContext('2d');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let pts = [], vis = [], tiles = [];
  let W = 0, H = 0, dpr = 1;
  const view = { x: 0, y: 0, s: 1, k: 1 }; // screen = view + world * s; k is the zoom factor
  let filter = {}, hover = null, drag = null, raf = 0;
  const cache = new Map();
  let D = 0.0055;
  const CACHE_MAX = 5000, FILL = 0.92, IMG_MIN = 14; // D: spacing in map units; IMG_MIN: screen px at which thumbnails load

  const size = () => {
    dpr = window.devicePixelRatio || 1;
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const fit = () => {
    view.s = Math.min(W, H - 50) * 0.92 * view.k;
  };
  const home = () => {
    view.k = 1; fit();
    view.x = (W - view.s) / 2; view.y = 50 + (H - 50 - view.s) / 2;
  };
  const tileSize = () => D * FILL * view.s;

  const matches = (p) => {
    const f = filter;
    if (f.src && p.src !== f.src) return false;
    if (f.hue && p.hue !== f.hue) return false;
    if (f.mono !== '' && f.mono != null && String(+!!p.mono) !== f.mono) return false;
    if (f.labelled && !p.jc) return false;
    if (f.quality && !qualityOk(p, f.quality)) return false;
    if (f.q && !p.text.includes(f.q.toLowerCase())) return false;
    return true;
  };
  // Quality filter over the pictures in the map: thresholds on the raw score r (source score minus penalties).
  let rawSorted = [];
  const qualityOk = (p, mode) => {
    if (!p.qm) return false;
    if (mode === 'pen') return Object.keys(p.qm.why).length > 0;
    const cut = mode === 'n100' ? rawSorted[Math.min(99, rawSorted.length - 1)] : rawSorted[Math.floor(rawSorted.length * (mode === 'p5' ? 0.05 : 0.2))];
    return p.qm.r <= cut;
  };
  const refilter = () => {
    vis = pts.filter(matches);
    $('#count').textContent = `${vis.length} of ${pts.length}`;
    schedule();
  };

  const thumb = (p) => {
    let e = cache.get(p.u);
    if (e) { cache.delete(p.u); cache.set(p.u, e); return e; }
    e = { img: new Image(), ok: false };
    e.img.onload = () => { e.ok = true; schedule(); };
    if (PACK) polite(p, e); else e.img.src = `train/report/thumbs/${p.u}.jpg`;
    cache.set(p.u, e);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return e;
  };

  // Polite loading: the pack's pictures come straight from the institutions, so requests wait in a queue. At most PAR_HOST in flight
  // per host with HOST_GAP ms between starts, PAR_ALL overall; only pictures still on screen when their turn comes (newest first);
  // a host that fails FAILS times in a row rests for REST ms; a failed picture is not asked for again. Pictures use their smaller
  // variant where the source sizes on request, and no referrer is sent.
  const PAR_HOST = 2, HOST_GAP = 400, PAR_ALL = 8, REST = 60000, FAILS = 3;
  const hosts = new Map(), queue = [];
  let inflight = 0, wanted = new Set(), timer = 0, loaded = 0, failed = 0;
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const hostState = (h) => hosts.get(h) ?? hosts.set(h, { active: 0, last: 0, fails: 0, until: 0 }).get(h);
  const status = () => {
    const note = $('#note');
    if (!note) return;
    const resting = [...hosts.values()].filter((h) => h.until > performance.now()).length;
    note.textContent = `images load from their sources, slowly: ${loaded} shown, ${queue.length} waiting${failed ? `, ${failed} failed` : ''}${resting ? `, ${resting} source(s) resting` : ''}`;
  };
  const pump = () => {
    timer = 0;
    const now = performance.now();
    let wait = 500;
    for (let i = queue.length - 1; i >= 0 && inflight < PAR_ALL; i--) {
      const job = queue[i];
      if (!wanted.has(job.p.u)) { queue.splice(i, 1); cache.delete(job.p.u); continue; }
      const h = hostState(job.host), ready = Math.max(h.last + HOST_GAP, h.until);
      if (h.active >= PAR_HOST || ready > now) { wait = Math.min(wait, h.active >= PAR_HOST ? 200 : Math.max(50, ready - now)); continue; }
      queue.splice(i, 1);
      h.active++; h.last = now; inflight++;
      const end = (ok) => {
        h.active--; inflight--;
        if (ok) { loaded++; h.fails = 0; } else { failed++; if (++h.fails >= FAILS) { h.until = performance.now() + REST; h.fails = 0; } }
        status(); if (!timer) timer = setTimeout(pump, 0);
      };
      job.e.img.onload = () => { job.e.ok = true; schedule(); end(true); };
      job.e.img.onerror = () => end(false);
      job.e.img.referrerPolicy = 'no-referrer';
      job.e.img.src = job.url;
    }
    status();
    if (queue.length && !timer) timer = setTimeout(pump, wait);
  };
  const polite = (p, e) => { queue.push({ p, e, url: p.th || p.img, host: hostOf(p.th || p.img) }); if (!timer) timer = setTimeout(pump, 0); };

  // Pushes overlapping pictures apart (neighbours within D) until none are, so absolute sizes never overlap.
  const spread = (list) => {
    for (let it = 0; it < 60; it++) {
      const grid = new Map();
      list.forEach((p, i) => { const k = Math.floor(p.x / D) * 100003 + Math.floor(p.y / D); (grid.get(k) ?? grid.set(k, []).get(k)).push(i); });
      let moved = 0;
      list.forEach((p, i) => {
        const cx = Math.floor(p.x / D), cy = Math.floor(p.y / D);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          for (const j of grid.get((cx + dx) * 100003 + cy + dy) ?? []) {
            if (j <= i) continue;
            const q = list[j];
            let vx = q.x - p.x, vy = q.y - p.y, d = Math.hypot(vx, vy);
            if (d >= D) continue;
            if (d < 1e-9) { const a = (i * 2.399) % 6.283; vx = Math.cos(a); vy = Math.sin(a); d = 1; }
            const push = (D - Math.hypot(q.x - p.x, q.y - p.y)) / 2 + 1e-4;
            p.x -= (vx / d) * push; p.y -= (vy / d) * push; q.x += (vx / d) * push; q.y += (vy / d) * push;
            moved++;
          }
        }
      });
      if (!moved) break;
    }
  };

  const layout = () => {
    const T = tileSize(), x0 = -T, x1 = W + T, y0 = 40 - T, y1 = H + T;
    tiles = [];
    for (const p of vis) {
      const sx = view.x + p.x * view.s, sy = view.y + p.y * view.s;
      if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
      tiles.push({ p, x: sx - T / 2, y: sy - T / 2, w: T });
    }
  };

  const draw = () => {
    raf = 0;
    ctx.clearRect(0, 0, W, H);
    layout();
    const big = tileSize() >= IMG_MIN;
    if (PACK) wanted = big ? new Set(tiles.map((t) => t.p.u)) : new Set();
    for (const t of tiles) {
      const e = big ? thumb(t.p) : null;
      if (e?.ok) {
        const iw = e.img.naturalWidth, ih = e.img.naturalHeight, m = Math.min(iw, ih);
        ctx.drawImage(e.img, (iw - m) / 2, (ih - m) / 2, m, m, t.x, t.y, t.w, t.w);
      } else {
        ctx.fillStyle = t.p.hex; ctx.fillRect(t.x, t.y, t.w, t.w);
      }
    }
    if (hover) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(hover.x, hover.y, hover.w, hover.w);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(hover.x - 1, hover.y - 1, hover.w + 2, hover.w + 2);
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };

  const at = (x, y) => tiles.find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.w) ?? null;

  // zoom keeping the point under (cx, cy) fixed
  const zoom = (factor, cx, cy) => {
    const k = Math.min(120, Math.max(0.6, view.k * factor)), f = k / view.k;
    view.x = cx - (cx - view.x) * f; view.y = cy - (cy - view.y) * f;
    view.k = k; view.s *= f;
    schedule();
  };
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });

  const pointers = new Map();
  let pinch = 0;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    if (pointers.size === 2) pinch = 0;
  });
  cv.addEventListener('pointermove', (e) => {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) { // two fingers: pinch
      const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) zoom(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch = d;
      if (drag) drag.moved = true;
      return;
    }
    if (drag && e.buttons) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) { drag.moved = true; cv.classList.add('drag'); }
      if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; schedule(); }
      $('#tip').style.display = 'none';
      return;
    }
    const t = at(e.clientX, e.clientY);
    if (t !== hover) { hover = t; schedule(); }
    const tip = $('#tip');
    if (t) {
      tip.textContent = `${t.p.t || 'untitled'} · ${t.p.src}${t.p.qm ? ` · quality ${t.p.qm.q} (raw ${t.p.qm.r})` : ''}`;
      tip.style.display = 'block'; tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 14}px`;
    } else tip.style.display = 'none';
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    cv.classList.remove('drag');
    if (drag && !drag.moved && pointers.size === 0) { const t = at(e.clientX, e.clientY); if (t) expand(t); }
    if (pointers.size === 0) drag = null;
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); drag = null; });

  // Opening: the tile grows into the large picture; the side panel carries its metadata.
  const box = $('#open');
  const close = () => { box.hidden = true; box.classList.remove('on'); box.innerHTML = ''; };
  const expand = (t) => {
    const p = t.p;
    box.hidden = false; box.classList.remove('on');
    const stage = { w: innerWidth - Math.min(360, innerWidth * 0.4), h: innerHeight };
    const side = `<div class="side"><h2>${esc(p.t) || 'untitled'}</h2><div class="m">${esc(p.c)} ${esc(p.dt)}</div>
      <div class="m">${esc(p.inst)}</div><div class="pal">${p.pal.map((c) => `<i style="background:${c[0]};flex:${c[1]}"></i>`).join('')}</div>
      <div class="m">${esc(p.hue ?? '')}${p.mono ? ' · monochrome' : ''} · L ${p.L} · chroma ${p.ch}</div>
      ${p.qm ? `<p class="m">quality ${p.qm.q} · raw score ${p.qm.r}${p.qm.ls ? ` · ${p.qm.ls}px long side · ${p.qm.bpp} bits/px · sharpness ${p.qm.sh}` : ' · no file statistics yet'}</p>
        <p class="tags why">${Object.entries(p.qm.why).map(([k, v]) => `<span>${esc(k)} -${v}</span>`).join('') || '<span>no penalties</span>'}</p>` : ''}
      ${p.jc ? `<p class="m">teacher</p><p class="tags">${p.jc.map((x) => `<span>${esc(x)}</span>`).join('')}</p>` : '<p class="m">not labelled yet</p>'}
      ${p.st && p.st.length ? `<p class="m">student${p.split ? ` (${p.split === 'held' ? 'held-out' : 'trained on'})` : ''}</p><p class="tags">${p.st.map((x) => `<span>${esc(x[0])}</span>`).join('')}</p>` : ''}
      <p class="m">${esc((p.tags || []).join(', '))}</p>${p.url ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener">Source</a></p>` : ''}</div>`;
    box.innerHTML = `<img class="pic" alt="" referrerpolicy="no-referrer" src="${PACK ? esc(p.img) : `train/images/${esc(p.u)}.jpg`}">${side}`;
    const pic = box.querySelector('.pic');
    const set = (x, y, w, h) => Object.assign(pic.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    set(t.x, t.y, t.w, t.w);
    pic.style.objectFit = 'cover';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const m = Math.min(stage.w - 40, stage.h - 40);
      pic.style.objectFit = 'contain';
      set((stage.w - m) / 2, (stage.h - m) / 2, m, m);
      box.classList.add('on');
    }));
  };
  box.addEventListener('click', (e) => { if (!e.target.closest('.side') || e.target.closest('.pic')) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  addEventListener('resize', () => { size(); fit(); schedule(); });
  size(); home();

  // Two layouts of the same pictures: by colour vector and by the student's tags. Switching moves every picture there.
  let layoutName = 'colour', tween = 0;
  const tweenTo = (name) => {
    layoutName = name;
    const from = pts.map((p) => [p.x, p.y]), t0 = performance.now(), DUR = 700;
    cancelAnimationFrame(tween);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / DUR), e = t * t * (3 - 2 * t);
      pts.forEach((p, i) => { p.x = from[i][0] + (p.to[name][0] - from[i][0]) * e; p.y = from[i][1] + (p.to[name][1] - from[i][1]) * e; });
      schedule();
      if (t < 1) tween = requestAnimationFrame(step);
    };
    tween = requestAnimationFrame(step);
  };

  const finish = () => {
    D = 0.736 / Math.sqrt(pts.length); // 0.0055 for the 17.9k training pictures; the pack's pictures are smaller in proportion
    ['colour', 'tags'].forEach((name) => {
      const set = pts.map((p) => ({ x: p.to[name][0], y: p.to[name][1] }));
      spread(set);
      pts.forEach((p, i) => { p.to[name] = [set[i].x, set[i].y]; });
    });
    pts.forEach((p) => { [p.x, p.y] = p.to.colour; });
    rawSorted = pts.filter((p) => p.qm).map((p) => p.qm.r).sort((a, b) => a - b);
    refilter();
  };
  if (PACK) {
    $('#qbtn').hidden = true;
    const note = document.createElement('span'); note.id = 'note'; note.style.cssText = 'color:var(--mut);font-size:12px';
    $('#bar').append(note);
    Promise.all([fetch('pack/data.json').then((r) => r.json()), fetch('pack/explore/layout.json').then((r) => r.json()),
      fetch('pack/explore/layout_tags.json').then((r) => r.json())]).then(([items, rows, tagRows]) => {
      const by = new Map(items.map((i) => [i.u, i]));
      const tags = new Map(tagRows.map((r) => [r.u, r]));
      pts = rows.flatMap((l, i) => {
        const it = by.get(l.u), t = tags.get(l.u) ?? l; // a picture without student tags stays where its colour puts it
        return it ? [{ ...it, x: l.x, y: l.y, to: { colour: [l.x, l.y], tags: [t.x, t.y] }, rank: i, hex: it.pal[0]?.[0] ?? '#888',
          text: `${it.t} ${it.c} ${(it.tags || []).join(' ')}`.toLowerCase() }] : [];
      });
      pts.sort(() => Math.random() - 0.5).forEach((p, i) => { p.rank = i; });
      finish();
    });
  } else Promise.all([fetch('train/report/data.json').then((r) => r.json()), fetch('train/explore/layout.json').then((r) => r.json()),
    fetch('train/explore/layout_tags.json').then((r) => r.json()), fetch('train/report/quality.json').then((r) => r.json())]).then(([items, colourRows, tagRows, quality]) => {
    const by = new Map(items.map((i) => [i.u, i]));
    const tags = new Map(tagRows.map((r) => [r.u, r]));
    const order = colourRows.map((_, i) => i).sort(() => Math.random() - 0.5);
    pts = colourRows.flatMap((l, i) => {
      const it = by.get(l.u), t = tags.get(l.u);
      return it && t ? [{ ...it, qm: quality[l.u], x: l.x, y: l.y, to: { colour: [l.x, l.y], tags: [t.x, t.y] }, rank: order[i], hex: it.pal[0]?.[0] ?? '#888',
        text: `${it.t} ${it.c} ${(it.tags || []).join(' ')} ${(it.jc || []).join(' ')} ${(it.st || []).map((x) => x[0]).join(' ')}`.toLowerCase() }] : [];
    });
    finish();
  });

  // Quality metrics: reasons, distribution, weakest sources and the lowest-scored works of the whole catalogue.
  const qpanel = $('#qpanel');
  const thumbOf = (x) => (x.local ? `train/report/thumbs/${esc(x.uid)}.jpg` : esc(x.url ?? ''));
  const renderQuality = (m) => {
    const max = Math.max(...m.histogram, 1);
    const hist = (h) => `<div class="hist">${h.map((n, i) => `<i style="height:${Math.max(1, (80 * n) / Math.max(...h, 1))}px" title="${(m.bins.from + (i * (m.bins.to - m.bins.from)) / m.bins.n).toFixed(2)}: ${n}"></i>`).join('')}</div>`;
    const rows = (o) => Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('');
    qpanel.innerHTML = `<div class="m">${m.works} works · file statistics for ${m.withStats} · colour for ${m.withColour}</div>
      <div class="cols">
        <div><h2>Penalties (works affected)</h2><table>${rows(m.reasons)}</table></div>
        <div><h2>Raw score, all works (${m.bins.from} to ${m.bins.to})</h2>${hist(m.histogram)}</div>
        ${Object.entries(m.histogramByType).map(([t, h]) => `<div><h2>${esc(t)}</h2>${hist(h)}</div>`).join('')}
        <div><h2>Lowest sources, mean raw score</h2><table>${m.sources.map((s) => `<tr><td>${esc(s.source)}</td><td class="num">${s.works}</td><td class="num">${s.meanRaw}</td><td class="num">${Math.round(s.penalised * 100)}% penalised</td></tr>`).join('')}</table></div>
      </div>
      <h2>Lowest ${m.lowest.length} works</h2>
      <div class="grid">${m.lowest.map((x) => `<div class="card"><img loading="lazy" alt="" src="${thumbOf(x)}">
        <div><b>${esc((x.t || 'untitled').slice(0, 60))}</b><br>${esc(x.inst)} · ${esc(x.type)}<br>raw ${x.r} · rank ${x.q}${x.ls ? `<br>${x.ls}px · ${x.bpp} bpp · sharp ${x.sh}` : ''}
        <div class="why">${Object.keys(x.why).map((k) => `<span>${esc(k)}</span>`).join('')}</div></div></div>`).join('')}</div>`;
  };
  let summary = null;
  $('#qbtn').addEventListener('click', async () => {
    qpanel.hidden = !qpanel.hidden;
    qpanel.style.top = `${$('#bar').offsetHeight}px`;
    if (!qpanel.hidden && !summary) { summary = await fetch('train/report/quality_summary.json').then((r) => r.json()); renderQuality(summary); }
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') qpanel.hidden = true; });

  const register = () => {
    if (!window.Shiny?.addCustomMessageHandler) return setTimeout(register, 50);
    Shiny.addCustomMessageHandler('filter', (f) => {
      filter = f;
      if (f.layout && f.layout !== layoutName && pts.length) tweenTo(f.layout);
      refilter();
    });
  };
  register();
})();
