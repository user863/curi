// Tag completion for the search bar. Pure: the list is [[slug, works]], most used first.
import { tagLabel } from './vocab.js';

const fold = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Tags whose label, or one of its words, starts with the last word typed. Label starts come first, then use.
// Each: { slug, label, text } where text is the query with its last word replaced by the label.
export const complete = (list, vocab, lang, query, limit = 6) => {
  const words = String(query).split(/\s+/);
  const last = fold(words.pop() ?? '');
  if (last.length < 2) return [];
  const head = words.join(' ');
  const out = [];
  for (const [slug] of list) {
    const label = tagLabel(vocab, slug, lang);
    const folded = fold(label);
    if (folded === last && !words.length) continue; // already typed in full
    const rank = folded.startsWith(last) ? 0 : folded.split(' ').some((w) => w.startsWith(last)) ? 1 : -1;
    if (rank < 0) continue;
    out.push({ rank, slug, label, text: head ? `${head} ${label}` : label });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, limit).map(({ slug, label, text }) => ({ slug, label, text }));
};
