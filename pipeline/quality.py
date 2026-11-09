"""Quality heuristics. Each returns a 0..1 score from source signals; no manual picking.
card quality weight = 1 + 0.4 * score, so the ranker sees 1.0..1.4."""
import math, re

JUNK_TITLE = re.compile(r"(?i)\b(batch|template|untitled|test|capcut|geometry dash|mod apk|part \d+ of \d+)\b|\.(mp3|mp4|avi|mov)$")

def popularity(downloads, ceiling=7):
    return min(1.0, math.log10((downloads or 0) + 1) / ceiling)

def rating(avg, reviews):
    return max(0.0, min(1.0, ((avg or 0) - 3) / 2)) if (reviews or 0) >= 3 else 0.0

def completeness(description, subjects, creator, year):
    return min(1.0, 0.45 * (len(description or "") >= 100) + 0.2 * (len(subjects) >= 2) + 0.2 * bool(creator) + 0.15 * bool(year))

def combine(parts):
    """parts: [(weight, score)]; a score of None is unknown and left out, so weights renormalise over what is known."""
    known = [(w, s) for w, s in parts if s is not None]
    total = sum(w for w, _ in known)
    return sum(w * s for w, s in known) / total if total else 0.0

def weight(score):
    return round(1 + 0.4 * max(0.0, min(1.0, score)), 3)

def is_junk_title(title):
    return bool(JUNK_TITLE.search(title or ""))
