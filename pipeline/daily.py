"""Picks for the home-screen widget: one picture a day, 366 of them, the best-rated works with a picture a phone widget can load.
Written to the pack as daily.json; tools/daily_mat.mjs adds the matched background (the app's colour matcher) to each pick.
The widget shows pick number (day of the era) mod the list length, so every install shows the same picture on the same day."""
import collections
import random
from urllib.parse import urlparse

BLOCKED_HOSTS = {"www.artic.edu", "upload.wikimedia.org"}  # a header is needed; originals answer 429

def pick(rows, media, count=366, per_source=0.35, per_creator=2, seed=7):
    """rows carry id, type, source, title, creator, swatch and quality; media maps id -> {url}. Returns the picks, shuffled."""
    taken, by_source, by_creator, titles = [], collections.Counter(), collections.Counter(), set()
    for r in sorted(rows, key=lambda r: (-r["quality"], r["id"])):
        m = media.get(r["id"])
        url = (m["url"] if m else "") or ""
        if r["type"] != "image" or not r["swatch"] or not url.startswith("https://") or urlparse(url).netloc in BLOCKED_HOSTS:
            continue
        who, title = (r["creator"] or "").strip().lower(), (r["title"] or "").strip().lower()
        if title in titles or (who and who != "unknown" and by_creator[who] >= per_creator) or by_source[r["source"]] >= per_source * count:
            continue
        url = url.replace("/CRDImages/es/original/", "/CRDImages/es/web-large/")  # the Met's originals run to tens of MB; a widget needs a few hundred KB
        taken.append({"id": r["id"], "title": r["title"], "creator": r["creator"], "image": url, "sw": r["swatch"]})
        titles.add(title)
        by_source[r["source"]] += 1
        by_creator[who] += 1
        if len(taken) == count:
            break
    random.Random(seed).shuffle(taken)
    return taken
