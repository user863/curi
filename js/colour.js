// Card colour from the colour around a picture's edge. Pure.
// A bold mat for the picture: a hue that sits against the picture's own (its complement, or a neighbour of it on the wheel),
// snapped to a short list of striking hues (pink, coral, amber, green, teal, blue, violet), at high chroma and set far apart
// from the picture in lightness so the picture reads on it. Computed in OKLCH; the chroma is cut back only to stay inside sRGB.

// Hues the default mat lands on, OKLCH degrees: pink, coral, amber, green, teal, blue, violet.
const STRIKING = [352, 28, 75, 145, 195, 255, 305];

// What the matcher can be asked. The defaults are the museum mat; the app's colour lab and the Explorer change any of them.
// map: for a picture hue at 0, 30 ... 330 degrees (OKLCH), the hue of its mat; between those it is blended along the shorter arc.
export const MAT = {
  map: /** @type {number[]} */ ([]), // filled below with the complements, snapped to STRIKING
  spread: 0, // degrees a work's seed may move its mat either way, for variety among pictures of one hue
  chroma: 0.13, // colourfulness of the mat at least (OKLCH chroma, cut back only to stay inside sRGB)
  gain: 0.09, // more of it when the picture is colourful
  lightOnDark: 0.8, // mat lightness behind a dark picture
  darkOnLight: 0.44, // and behind a light one
  pivot: 0.55, // picture lightness that counts as dark
  contrast: 'opposite', // opposite | light | dark | same
  grey: 'varied', // hue behind a grey picture: varied (by seed) | warm | cool | pink | sun
  bar: 'same', // top bar: same | deeper | lighter than the mat
  accent: 'sun', // sun | contrast (a hue across the wheel from the mat)
};

const GREY_HUES = { warm: 55, cool: 235, pink: 352, sun: 85 };

const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export const oklab = (hex) => {
  const [r, g, b] = parse(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, a, bb];
};

export const toOklch = (hex) => {
  const [L, a, b] = oklab(hex);
  return [L, Math.hypot(a, b), (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
};

const rgbOf = (L, C, h) => {
  const a = C * Math.cos(h * Math.PI / 180);
  const b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
};

const toHex = (L, C, h) => {
  let c = C;
  while (c > 0 && rgbOf(L, c, h).some((v) => v < -0.0005 || v > 1.0005)) c -= 0.004; // back to the sRGB edge, keeping hue and lightness
  return `#${rgbOf(L, c, h).map((v) => Math.round(Math.min(1, Math.max(0, encode(Math.max(0, v)))) * 255).toString(16).padStart(2, '0')).join('')}`;
};

const gap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const nearest = (h, list) => list.reduce((best, a) => (gap(a, h) < gap(best, h) ? a : best));
const hash = (s) => [...String(s ?? '')].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);

const turn = (from, to, t) => (from + (((to - from + 540) % 360) - 180) * t + 360) % 360; // along the shorter arc

const wrap = (h) => ((h % 360) + 360) % 360;
const STEP = 30;

// The mat hue for a picture hue: the map's two neighbouring sectors, blended.
const matHue = (map, h) => {
  const i = Math.floor(h / STEP) % 12;
  return turn(map[i], map[(i + 1) % 12], (h - i * STEP) / STEP);
};

MAT.map = Array.from({ length: 12 }, (_, k) => {
  const target = wrap(k * STEP + 180);
  const near = STRIKING.filter((h) => gap(h, target) <= 50);
  return nearest(target, near.length ? near : STRIKING);
});

export const hueColour = (h, L = 0.75, C = 0.15) => toHex(L, C, wrap(h));

// seed: any stable string (the work's id); it moves the hue within `spread`, and picks the hue behind grey pictures.
export const complement = (hex, seed, mat = MAT) => {
  const p = { ...MAT, ...mat };
  const [Lp, Cp, hp] = toOklch(hex);
  const dark = Lp < p.pivot;
  const L = p.contrast === 'light' ? p.lightOnDark : p.contrast === 'dark' ? p.darkOnLight : p.contrast === 'same' ? Math.min(0.9, Math.max(0.3, Lp)) : dark ? p.lightOnDark : p.darkOnLight;
  const wobble = ((hash(seed) % 2001) / 1000 - 1) * p.spread;
  if (Cp < 0.03) return toHex(L, p.chroma + p.gain, wrap((GREY_HUES[p.grey] ?? STRIKING[hash(seed) % STRIKING.length]) + wobble));
  return toHex(L, p.chroma + p.gain * Math.min(1, Cp / 0.12), wrap(matHue(p.map, hp) + wobble));
};

// The mat a little lighter or deeper, for the bar over it.
export const shade = (hex, dL) => {
  const [L, C, h] = toOklch(hex);
  return toHex(Math.min(0.97, Math.max(0.05, L + dL)), C, h);
};

// A hue across the wheel from the mat, bright enough to read on it.
export const accentOf = (hex) => {
  const [L, C, h] = toOklch(hex);
  return toHex(L < 0.6 ? 0.88 : 0.28, Math.max(0.12, C), (h + 150) % 360);
};

// Relative luminance, for choosing black or white text.
export const luminance = (hex) => {
  const [r, g, b] = parse(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
