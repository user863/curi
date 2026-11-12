"""Quality v2 for the pack: the source score refined with curatorial and technical signals, then rank-normalised
inside each source and format so no source or format sits above the rest. Output keeps the 1.0..1.4 weight range.
Pure; export.py applies it."""
import collections

FEATURED = "featured-picture"           # Wikimedia Commons curators' pick
DOCUMENT_TAGS = {"text", "document", "handwritten-text", "floor-plan", "technical-drawing", "blueprint"}
BONUS_FEATURED, PENALTY_DOCUMENT, PENALTY_FLAT, PENALTY_BLANK = 0.25, 0.2, 0.2, 0.15
FLAT_CONTRAST = 0.25                    # spread of lightness below this: faded scan or haze
BLANK_LIGHTNESS = (0.07, 0.93)          # mean lightness outside this: nearly black or white page
# Technical signals (pipeline/imagestats.py), measured on the file the reader is shown.
SMALL_SIDE, TINY_SIDE = 800, 480        # long side in pixels: small, and thumbnail-sized
PENALTY_SMALL, PENALTY_TINY = 0.08, 0.2
SQUEEZED_BPP, PENALTY_SQUEEZED = 0.35, 0.1   # bits per pixel below this: over-compressed, blocky
BLURRED, PENALTY_BLURRED = 80.0, 0.15        # Laplacian variance below this (about the blurriest 2%): out of focus or smeared

def technical(stats):
    """Penalty for the weaknesses of the file itself; 0 without statistics."""
    if not stats:
        return 0.0
    p = PENALTY_TINY if stats["longSide"] < TINY_SIDE else PENALTY_SMALL if stats["longSide"] < SMALL_SIDE else 0.0
    if stats["bytesPerPixel"] < SQUEEZED_BPP:
        p += PENALTY_SQUEEZED
    if stats["sharp"] < BLURRED:
        p += PENALTY_BLURRED
    return p

def refined(base, tags, colour, stats=None):
    """base: source score 0..1; tags: slugs; colour: palette features or None; stats: imagestats features or None."""
    s = base - technical(stats)
    if FEATURED in tags:
        s += BONUS_FEATURED
    if DOCUMENT_TAGS & set(tags):
        s -= PENALTY_DOCUMENT
    if colour:
        if colour["contrast"] < FLAT_CONTRAST:
            s -= PENALTY_FLAT
        if not BLANK_LIGHTNESS[0] <= colour["lightness"] <= BLANK_LIGHTNESS[1]:
            s -= PENALTY_BLANK
    return s

def rescore(works, tags, colour, stats=None):
    """works: [{id, source, type, quality}]; returns {id: quality in 1.0..1.4}. Ties share their mean rank."""
    scored = [(w["id"], (w["source"], w["type"]), refined((w["quality"] - 1) / 0.4, tags.get(w["id"], ()), colour.get(w["id"]), (stats or {}).get(w["id"]))) for w in works]
    groups = collections.defaultdict(list)
    for wid, key, s in scored:
        groups[key].append((s, wid))
    out = {}
    for items in groups.values():
        items.sort()
        n, i = len(items), 0
        while i < n:
            j = i
            while j + 1 < n and items[j + 1][0] == items[i][0]:
                j += 1
            pct = ((i + j) / 2 + 0.5) / n
            for k in range(i, j + 1):
                out[items[k][1]] = round(1 + 0.4 * pct, 3)
            i = j + 1
    return out
