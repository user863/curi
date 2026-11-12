// Tag labels in the reader's language. vocab: { slug: { de } } from the pack; English is the slug itself.
export const tagLabel = (vocab, slug, lang = 'en') => vocab?.[slug]?.[lang] ?? slug.replace(/-/g, ' ');

// Two-letter language of the device ('en' when unknown).
export const deviceLang = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().locale.slice(0, 2); } catch { return 'en'; }
};
