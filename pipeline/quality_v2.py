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
LARGE_SIDE = 2000                       # from this size the 256 px sharpness and the bytes per pixel say little: sparse line art and pale sketches score low on both
SOFT_SHARP = 150.0                      # detail below this (about the softest 8%) or a small file: a flat or blank look is then a weak scan, not a style
BLURRED, PENALTY_BLURRED = 80.0, 0.15        # Laplacian variance below this (about the blurriest 2%): out of focus or smeared

def penalties(tags, colour, stats=None):
    """{reason: amount} for the weaknesses of one work. Document, flat and blank only count when the file is also weak
    (soft or small, and below LARGE_SIDE): a studio photo on white, or crisp line art, looks flat or blank and is not a poor picture.
    Without statistics they are not judged."""
    out = {}
    if stats:
        judged = stats["longSide"] < LARGE_SIDE  # detail is judged on files below LARGE_SIDE; larger ones are not blamed for it
        weak = judged and (stats["sharp"] < SOFT_SHARP or stats["longSide"] < SMALL_SIDE)
        if weak and DOCUMENT_TAGS & set(tags):
            out["document"] = PENALTY_DOCUMENT
        if weak and colour:
            if colour["contrast"] < FLAT_CONTRAST:
                out["flat"] = PENALTY_FLAT
            if not BLANK_LIGHTNESS[0] <= colour["lightness"] <= BLANK_LIGHTNESS[1]:
                out["blank"] = PENALTY_BLANK
        if stats["longSide"] < TINY_SIDE:
            out["tiny"] = PENALTY_TINY
        elif stats["longSide"] < SMALL_SIDE:
            out["small"] = PENALTY_SMALL
        if judged and stats["bytesPerPixel"] < SQUEEZED_BPP:
            out["squeezed"] = PENALTY_SQUEEZED
        if judged and stats["sharp"] < BLURRED:
            out["blurred"] = PENALTY_BLURRED
    return out

def technical(stats):
    """Penalty for the weaknesses of the file itself; 0 without statistics."""
    return sum(v for k, v in penalties((), None, stats).items())

def refined(base, tags, colour, stats=None):
    """base: source score 0..1; tags: slugs; colour: palette features or None; stats: imagestats features or None."""
    return base + (BONUS_FEATURED if FEATURED in tags else 0.0) - sum(penalties(tags, colour, stats).values())

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
