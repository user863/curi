"""Colour for the pack, from the stored palette features (work_colour): search buckets and the detail block.
Pure functions; export.py calls them."""
import math

HUES = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown"]  # names for chips; ranges below are OKLab hue angles
HUE_WEIGHT = 0.18   # a palette colour counts for its hue when it covers at least this share
HUE_CHROMA = 0.04   # and is at least this saturated
DARK, LIGHT, VIVID, MUTED, WARM, COOL = 0.4, 0.8, 0.09, 0.05, 0.35, -0.2
BROWN_L, BROWN_C = 0.62, 0.12  # orange to yellow hues that are dark or dull read as brown

def hue_of(lightness, a, b):
    """Colour name for an OKLab colour."""
    angle = math.degrees(math.atan2(b, a)) % 360
    if 30 <= angle < 110 and (lightness < BROWN_L or math.hypot(a, b) < BROWN_C):
        return "brown"
    for end, name in ((10, "pink"), (45, "red"), (80, "orange"), (115, "yellow"), (170, "green"), (225, "teal"), (285, "blue"), (330, "purple")):
        if angle < end:
            return name
    return "pink"

def buckets(f):
    """Names of the search buckets a picture belongs to."""
    if f["monochrome"]:
        return ["monochrome"] + (["dark"] if f["lightness"] < DARK else ["light"] if f["lightness"] > LIGHT else [])
    out = {hue_of(*p["lab"]) for p in f["palette"] if p["weight"] >= HUE_WEIGHT and math.hypot(p["lab"][1], p["lab"][2]) >= HUE_CHROMA}
    if f["lightness"] < DARK: out.add("dark")
    if f["lightness"] > LIGHT: out.add("light")
    if f["chroma"] >= VIVID: out.add("vivid")
    if f["chroma"] < MUTED: out.add("muted")
    if f["warmth"] >= WARM: out.add("warm")
    if f["warmth"] <= COOL: out.add("cool")
    return sorted(out)

def detail(f):
    """For the info sheet: swatches as [hex without #, share %], and the scalars as words."""
    return {"pal": [[p["hex"][1:], round(p["weight"] * 100)] for p in f["palette"]],
            "tone": [w for w in buckets(f) if w not in HUES]}
