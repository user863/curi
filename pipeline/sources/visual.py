"""Shared rules for visual works: room and tone from words in the title, tags and department."""
import re
from .common import stable_pick

ROOM_WORDS = (
    ("faces", ("portrait", "self-portrait", "head of", "bust", "man", "woman", "girl", "boy", "lady", "mother", "child", "face")),
    ("open-air", ("landscape", "river", "sea", "sky", "mountain", "forest", "field", "harvest", "garden", "tree", "storm",
                  "ship", "boat", "coast", "beach", "winter", "summer", "valley", "lake", "horse", "bird", "animal", "flowers")),
    ("interiors", ("interior", "still life", "room", "kitchen", "table", "fruit", "vase", "window", "domestic")),
)
LINE_DEPARTMENTS = ("drawing", "print", "photograph", "works on paper", "etching", "engraving", "woodcut", "lithograph", "watercolo", "map")
DEEP_TIME_DEPARTMENTS = ("egypt", "ancient", "greek", "roman", "near east", "antiquit", "archaeolog")

def room_of(text, department=""):
    """text: title plus tags, lower-cased by this function."""
    t, d = text.lower(), (department or "").lower()
    if any(w in d for w in LINE_DEPARTMENTS):
        return "line"
    if any(w in d for w in DEEP_TIME_DEPARTMENTS):
        return "deep-time"
    for room, words in ROOM_WORDS:
        if any(re.search(rf"\b{re.escape(w)}", t) for w in words):
            return room
    return "interiors"

def tone_of(kind, key):
    k = (kind or "").lower()
    if "painting" in k:
        return "ink"
    if any(w in k for w in ("drawing", "print", "photograph", "watercolor")):
        return "paper"
    return stable_pick(key, ("mauve", "paper", "sky"))

def person(description):
    """'George Bellows (American, 1882–1925)' -> 'George Bellows'"""
    return re.sub(r"\s*\(.*$", "", description or "").strip() or "Unknown maker"
