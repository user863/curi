"""Folds the teacher's free-text tags into a smaller, denser set. Pure functions; no model.
  canon(tag)  lowercase, hyphens to spaces, drop filler words, singularise: "Black-and-White" -> "black and white", "red beetles" -> "red beetle"
  expand(tag, heads)  adds the head noun when it is itself a common tag: "red beetle" -> {"red beetle", "beetle"}
heads = the canonical tags that occur on their own at least HEAD_MIN times in the corpus."""
import re
from collections import Counter

FILLER = {"a", "an", "the", "of", "with", "in", "on"}
IRREGULAR = {"men": "man", "women": "woman", "children": "child", "feet": "foot", "teeth": "tooth", "leaves": "leaf", "people": "people", "geese": "goose", "mice": "mouse"}
KEEP = {"glass", "grass", "dress", "moss", "cross", "class", "mass", "brass", "canvas", "bus", "gas", "lens", "series", "species", "news", "chiaroscuro", "pants", "scissors", "jeans", "glasses"}
HEAD_MIN = 10

def singular(w):
    if w in IRREGULAR:
        return IRREGULAR[w]
    if w in KEEP or len(w) < 4 or w.endswith(("ss", "us", "is", "ous")):
        return w
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith(("ches", "shes", "xes", "sses", "zes")):
        return w[:-2]
    if w.endswith("s"):
        return w[:-1]
    return w

def canon(tag):
    words = re.sub(r"[^a-z0-9' ]", " ", tag.lower().replace("-", " ")).split()
    words = [singular(w) for w in words if w not in FILLER]
    return " ".join(words)

def heads_of(tags_by_image, min_count=HEAD_MIN):
    count = Counter(c for tags in tags_by_image for c in {canon(t) for t in tags} if c and " " not in c)
    return {t for t, n in count.items() if n >= min_count}

def expand(tag, heads):
    c = canon(tag)
    if not c:
        return set()
    last = c.split()[-1]
    return {c} | ({last} if " " in c and last in heads else set())
