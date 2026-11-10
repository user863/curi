// Card colour from the colour around a picture's edge. Pure.
// Not the picture's own colour: its complement, pulled toward the palette's hues (sun, sky, mauve), muted, and set
// apart from the picture in lightness, so the picture reads against it like a mat. Computed per card, not picked from a list.

const ANCHORS = [43, 207, 307]; // hues of sun, sky and mauve, in degrees
const PULL = 0.7; // how far the complement moves toward the nearest palette hue

const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

const toHsl = ([r, g, b]) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
};

const toHex = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
};

const turn = (from, to, t) => (from + (((to - from + 540) % 360) - 180) * t + 360) % 360; // along the shorter arc
const gap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const nearest = (h) => ANCHORS.reduce((best, a) => (gap(a, h) < gap(best, h) ? a : best));

export const complement = (hex) => {
  const [h, s, l] = toHsl(parse(hex));
  // Away from the picture's lightness, never into the muddy middle: text must read on it.
  const light = l < 0.5 ? 0.62 + (0.5 - l) * 0.4 : 0.38 - (l - 0.5) * 0.4;
  if (s < 0.1) return toHex(l < 0.5 ? 43 : 207, 0.07, light); // grey pictures: warm paper over dark, cool ink over light
  const hue = turn((h + 180) % 360, nearest((h + 180) % 360), PULL);
  const sat = Math.min(0.5, 0.18 + 0.4 * Math.min(s, 0.8)) * (gap(hue, 43) < 25 ? 1.4 : 1); // the sun hue may be brighter
  return toHex(hue, Math.min(sat, 0.75), light);
};

// Relative luminance, for choosing black or white text.
export const luminance = (hex) => {
  const [r, g, b] = parse(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
