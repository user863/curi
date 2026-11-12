"""Controlled tag vocabulary (pipeline/vocab.json): drops noise tags, folds aliases into one term,
and carries German labels. One slug per term, stable across sources.
    python3 -m pipeline.vocab     -> the most common tags that have no German label yet"""
import collections, json, re, sqlite3
from pathlib import Path

HERE = Path(__file__).parent
VOCAB = json.loads((HERE / "vocab.json").read_text())
DROP, ALIAS, DE = set(VOCAB["drop"]), VOCAB["alias"], VOCAB["de"]
CENTURY = re.compile(r"^(\d+)(?:st|nd|rd|th)-century$")
DECADE = re.compile(r"^(\d{3})0s$")

def canonical(slug):
    return ALIAS.get(slug, slug)

def normalise(slugs):
    """Tags of one work: noise removed, aliases folded, order kept, no repeats."""
    seen, out = set(), []
    for s in slugs:
        s = canonical(s)
        if s in DROP or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out

def german(slug):
    """German label for a term, or None. Eras follow a rule."""
    if slug in DE:
        return DE[slug]
    m = CENTURY.match(slug)
    if m:
        return f"{m.group(1)}. Jahrhundert"
    m = DECADE.match(slug)
    return f"{m.group(1)}0er" if m else None

def labels(slugs):
    """{slug: {"de": label}} for the terms in use that have one."""
    return {s: {"de": g} for s in sorted(set(slugs)) if (g := german(s))}

if __name__ == "__main__":
    conn = sqlite3.connect(HERE / "works.sqlite")
    count = collections.Counter()
    for (slug, n) in conn.execute("SELECT t.slug, COUNT(*) FROM work_tag wt JOIN tag t ON t.id=wt.tag_id GROUP BY 1"):
        count[canonical(slug)] += n
    todo = [(s, n) for s, n in count.most_common(400) if s not in DROP and not german(s) and not s.startswith("gallery-")]
    print(f"{len(todo)} of the top 400 terms without a German label")
    print(" ".join(f"{s}({n})" for s, n in todo[:80]))
