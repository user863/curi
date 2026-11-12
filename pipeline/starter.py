"""Starter edition: the first three sets of seven for a reader with no interests yet (skipped the room choice).
One strong work per room, colour pictures only, no repeated creator or source beyond a cap, in a fixed rhythm.
Pure; export.py puts the result in the manifest as [[id, cluster], ...]."""
import collections, itertools

IMAGE_ROOMS = ["landscapes", "paintings", "people", "cities", "wildlife", "objects", "drawings", "interiors", "manuscripts", "deep-time", "paintings", "landscapes"]
SLOTS = ["img", "img", "film", "img", "img", "text", "img",
         "img", "img", "audio", "img", "img", "text", "img",
         "img", "img", "film", "img", "img", "audio", "img"]
KIND = {"img": ("image", None), "film": ("video", None), "audio": ("audio", None), "text": ("passage", None)}
SOURCE_MOST = 4

def starter(rows, mono_ids):
    """rows: dicts with id, cluster, type, room, quality, source, creator. mono_ids: ids of monochrome pictures."""
    by_type = collections.defaultdict(list)
    for r in sorted(rows, key=lambda r: (-r["quality"], r["id"])):
        if r["id"] not in mono_ids:
            by_type[r["type"]].append(r)
    taken, creators, sources = set(), set(), collections.Counter()

    def take(pool):
        for r in pool:
            c = (r["creator"] or "").strip().lower()
            if r["id"] in taken or (c and c in creators and not c.startswith("unknown")) or sources[r["source"]] >= SOURCE_MOST:
                continue
            taken.add(r["id"]); creators.add(c); sources[r["source"]] += 1
            return r
        return None

    rooms = itertools.cycle(IMAGE_ROOMS)
    out = []
    for slot in SLOTS:
        kind = KIND[slot][0]
        pool = by_type[kind]
        if slot == "img":
            room = next(rooms)
            pool = [r for r in pool if r["room"] == room]
        pick = take(pool)
        if pick:
            out.append([pick["id"], pick["cluster"]])
    return out
