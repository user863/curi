"""Search keywords for the app's idle search: tags that mark the best-rated works.
A tag qualifies with enough works to be worth a search and not so many that it is a bucket (painting, photograph); the list is
ordered by the mean quality of the works carrying it. Only terms of the curated vocabulary (pipeline/vocab.json) count, so no internal or technical tag is offered.
The app shows a random few each time the search opens."""
import collections
import re

from . import vocab

SKIP = re.compile(r"^(\d|new$|film$|silent-film$|europeana|calm$|dramatic$|ornate$)|-century$|^\d{4}s$|^(wall|table|daytime|canvas|beak|feather|perched|dock|arch|cross|graphic|car|instrumental|small-bird|boy|girl|child)$")  # eras, sources, mood words, plain parts of a picture

def pick(rows, tags, floor=40, ceiling=0.05, limit=300, known=vocab.german):
    """Tag slugs of the curated vocabulary (those with a label), best first. rows carry id and quality; tags maps work id -> slugs."""
    by = collections.defaultdict(list)
    for r in rows:
        for slug in set(tags.get(r["id"], [])):
            by[slug].append(r["quality"])
    top = ceiling * len(rows)
    scored = [(sum(q) / len(q), len(q), s) for s, q in by.items()
              if floor <= len(q) <= top and not SKIP.search(s) and known(s)]
    return [s for _, _, s in sorted(scored, key=lambda t: (-t[0], -t[1], t[2]))[:limit]]
