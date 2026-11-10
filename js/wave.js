// The waveform on a recording's card. The audio file gives no samples to the page (cross-origin), so the bars are drawn from the
// work's id: a few bursts that rise at once and decay, like speech or a struck note. The same recording always looks the same.

const BARS = 96;

const seeded = (id) => {
  let h = 2166136261;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
};

// Heights in 0.1..1, one per bar.
export const shape = (id, n = BARS) => {
  const rand = seeded(id);
  const bursts = Array.from({ length: 4 + Math.floor(rand() * 4) }, () => ({ at: rand() * n, peak: 0.55 + rand() * 0.45, tau: 5 + rand() * 9 }));
  return Array.from({ length: n }, (_, i) => {
    const level = bursts.reduce((top, b) => {
      const d = i - b.at;
      return Math.max(top, b.peak * (d >= 0 ? Math.exp(-d / b.tau) : Math.exp(d / 1.4)));
    }, 0);
    return Math.min(1, Math.max(0.1, level * (0.9 + 0.2 * rand()) + 0.06 * rand()));
  });
};

export const barsHtml = (heights) => `<span class="bars base">${heights.map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join('')}</span>` +
  `<span class="bars fill">${heights.map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join('')}</span><span class="head"></span>`;
