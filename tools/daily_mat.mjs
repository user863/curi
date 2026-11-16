// Adds the matched background and text colour to each pick of the widget's daily.json (pipeline/daily.py), with the app's colour matcher.
//   node tools/daily_mat.mjs data/pack/daily.json
import { readFileSync, writeFileSync } from 'node:fs';
import { complement, luminance } from '../js/colour.js';

const file = process.argv[2];
const daily = JSON.parse(readFileSync(file, 'utf8'));
daily.picks = daily.picks.map((p) => {
  const bg = complement(p.sw, String(p.id));
  return { ...p, bg, fg: luminance(bg) < 0.35 ? '#ffffff' : '#000000' };
});
writeFileSync(file, JSON.stringify(daily));
