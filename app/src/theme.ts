import { complement, luminance } from '../../js/colour.js';

export type Tone = 'paper' | 'mauve' | 'sun' | 'ink' | 'sky';
export type Palette = { bg: string; fg: string; dim: string; accent: string; barBg: string; barFg: string; barInv: string };

const GREY = '#ececec';
const SKY = '#3f6e96';
const SUN = '#e3ac1c';
const alpha = (rgb: string, a: number) => `rgba(${rgb},${a})`;

const TONES: Record<Tone, Palette> = {
  paper: { bg: GREY, fg: '#000000', dim: alpha('0,0,0', 0.62), accent: SKY, barBg: 'rgba(236,236,236,0.86)', barFg: '#000000', barInv: GREY },
  mauve: { bg: '#c9bec7', fg: '#000000', dim: alpha('0,0,0', 0.62), accent: SKY, barBg: 'rgba(201,190,199,0.86)', barFg: '#000000', barInv: GREY },
  sun: { bg: SUN, fg: '#000000', dim: alpha('0,0,0', 0.66), accent: '#000000', barBg: 'rgba(227,172,28,0.9)', barFg: '#000000', barInv: GREY },
  ink: { bg: '#000000', fg: '#ffffff', dim: alpha('255,255,255', 0.62), accent: SUN, barBg: 'rgba(0,0,0,0.82)', barFg: '#ffffff', barInv: '#000000' },
  sky: { bg: SKY, fg: '#ffffff', dim: alpha('255,255,255', 0.8), accent: SUN, barBg: 'rgba(63,110,150,0.9)', barFg: '#ffffff', barInv: SKY },
};

// The palette tone of a card, or the colour matched to its picture (card.sw) when Settings ask for it.
export const paletteFor = (card: any, colour: string): Palette => {
  if (colour === 'image' && card.sw) {
    const bg = complement(card.sw);
    const dark = luminance(bg) < 0.35;
    const [fg, inv, dim] = dark ? ['#ffffff', bg, alpha('255,255,255', 0.66)] : ['#000000', '#ececec', alpha('0,0,0', 0.62)];
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
    return { bg, fg, dim, accent: dark ? SUN : '#000000', barBg: `rgba(${r},${g},${b},0.88)`, barFg: fg, barInv: inv };
  }
  return TONES[(card.editorial.tone as Tone) in TONES ? (card.editorial.tone as Tone) : 'paper'];
};

export const tonePalette = (tone: string): Palette => TONES[(tone as Tone) in TONES ? (tone as Tone) : 'paper'];
