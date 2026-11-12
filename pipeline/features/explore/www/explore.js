// Canvas explorer. Every picture has a fixed size in map units (D), so it grows with the zoom. Zoomed out the pictures are
// colour squares; once a picture is big enough on screen its thumbnail loads. The layout is spread once so none overlap.
// Click a picture to open it.
(() => {
  const $ = (s) => document.querySelector(s);
  const cv = $('#cv'), ctx = cv.getContext('2d');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let pts = [], vis = [], tiles = [];
  let W = 0, H = 0, dpr = 1;
  const view = { x: 0, y: 0, s: 1, k: 1 }; // screen = view + world * s; k is the zoom factor
  let filter = {}, hover = null, drag = null, raf = 0;
  const cache = new Map();
  const CACHE_MAX = 5000, D = 0.0055, FILL = 0.92, IMG_MIN = 14; // D: spacing in map units; IMG_MIN: screen px at which thumbnails load

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
    if (f.q && !p.text.includes(f.q.toLowerCase())) return false;
    return true;
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
    e.img.src = `train/report/thumbs/${p.u}.jpg`;
    cache.set(p.u, e);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return e;
  };

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
      tip.textContent = `${t.p.t || 'untitled'} · ${t.p.src}`;
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
      ${p.jc ? `<p class="m">teacher</p><p class="tags">${p.jc.map((x) => `<span>${esc(x)}</span>`).join('')}</p>` : '<p class="m">not labelled yet</p>'}
      ${p.st && p.st.length ? `<p class="m">student${p.split ? ` (${p.split === 'held' ? 'held-out' : 'trained on'})` : ''}</p><p class="tags">${p.st.map((x) => `<span>${esc(x[0])}</span>`).join('')}</p>` : ''}
      <p class="m">${esc((p.tags || []).join(', '))}</p>${p.url ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener">Source</a></p>` : ''}</div>`;
    box.innerHTML = `<img class="pic" alt="" src="train/images/${esc(p.u)}.jpg">${side}`;
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

  Promise.all([fetch('train/report/data.json').then((r) => r.json()), fetch('train/explore/layout.json').then((r) => r.json()),
    fetch('train/explore/layout_tags.json').then((r) => r.json())]).then(([items, colourRows, tagRows]) => {
    const by = new Map(items.map((i) => [i.u, i]));
    const tags = new Map(tagRows.map((r) => [r.u, r]));
    const order = colourRows.map((_, i) => i).sort(() => Math.random() - 0.5);
    pts = colourRows.flatMap((l, i) => {
      const it = by.get(l.u), t = tags.get(l.u);
      return it && t ? [{ ...it, x: l.x, y: l.y, to: { colour: [l.x, l.y], tags: [t.x, t.y] }, rank: order[i], hex: it.pal[0]?.[0] ?? '#888',
        text: `${it.t} ${it.c} ${(it.tags || []).join(' ')} ${(it.jc || []).join(' ')} ${(it.st || []).map((x) => x[0]).join(' ')}`.toLowerCase() }] : [];
    });
    ['colour', 'tags'].forEach((name) => { // spread each layout on its own so neither overlaps
      const set = pts.map((p) => ({ x: p.to[name][0], y: p.to[name][1] }));
      spread(set);
      pts.forEach((p, i) => { p.to[name] = [set[i].x, set[i].y]; });
    });
    pts.forEach((p) => { [p.x, p.y] = p.to.colour; });
    refilter();
  });

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
