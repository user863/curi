"""Colour swatch per visual work, read from a small version of its image and stored in the database.
The pack carries it on the card (`sw`), so the app can paint a card in the colour of its picture.
Only the picture's border colour is kept; the image itself is not stored. Europeana serves thumbnails; other
sources use the poster or the image URL.
Usage: python3 -m pipeline.swatch [--limit N] [--redo]"""
import argparse, colorsys, io, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image
from . import db
from .http import UA, _wait

MAX_BYTES = 4_000_000
RING = 0.12  # share of the picture's edge that counts as its border
LIGHTNESS = (0.14, 0.86)  # never pure black or white: text must stay readable on it
MAX_SATURATION = 0.6

def source_url(source, kind, url, poster):
    if kind == "video":
        return poster
    if source == "eu":
        return "https://api.europeana.eu/thumbnail/v2/url.json?uri=" + urllib.parse.quote(url, safe="") + "&type=IMAGE"
    return url

def fetch(url):
    _wait(url, 0.05)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=40) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("too large")
    return data

def border_colour(data):
    """The colour around the edge of a picture, softened so it works as a card background."""
    img = Image.open(io.BytesIO(data))
    img.draft("RGB", (160, 160))
    px = np.asarray(img.convert("RGB").resize((48, 48)), dtype=float) / 255
    k = max(1, round(48 * RING))
    ring = np.concatenate([px[:k].reshape(-1, 3), px[-k:].reshape(-1, 3), px[k:-k, :k].reshape(-1, 3), px[k:-k, -k:].reshape(-1, 3)])
    r, g, b = np.median(ring, axis=0)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    r, g, b = colorsys.hls_to_rgb(h, min(max(l, LIGHTNESS[0]), LIGHTNESS[1]), min(s, MAX_SATURATION))
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))

def one(row):
    try:
        return row["id"], border_colour(fetch(source_url(row["source"], row["kind"], row["url"], row["poster"])))
    except Exception:
        return row["id"], None

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--redo", action="store_true", help="recompute works that already have a swatch")
    args = ap.parse_args()
    conn = db.connect(Path(__file__).parent / "works.sqlite")
    rows = conn.execute(f"""SELECT w.id, w.source, m.kind, m.url, m.poster FROM work w JOIN work_media m ON m.work_id=w.id
                            WHERE w.state='published' AND w.type IN ('image', 'video') {'' if args.redo else 'AND w.swatch IS NULL'}
                            AND (w.type='image' OR m.poster IS NOT NULL) ORDER BY w.id""").fetchall()
    rows = rows[: args.limit] if args.limit else rows
    done = failed = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        for i, (wid, colour) in enumerate(pool.map(one, rows), 1):
            if colour:
                conn.execute("UPDATE work SET swatch=? WHERE id=?", (colour, wid))
                done += 1
            else:
                failed += 1
            if i % 200 == 0:
                conn.commit()
                print(f"{i}/{len(rows)} ({done} ok, {failed} failed)", flush=True)
    conn.commit()
    print(f"swatches: {done} added, {failed} failed")

if __name__ == "__main__":
    main()
