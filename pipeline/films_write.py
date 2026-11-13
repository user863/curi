"""Writes the clips staged by pipeline/films.py into the work database and the poster folder.
    python3 -m pipeline.films_write [--apply] [--max-year N]
One work per clip: uid ia-<item>@<start>, type video, room film, the film file played from start to end, the key frame as poster
(data/posters/, 480 px JPEG), vector, tags, mood, valence, energy and colour from features.json. Without --apply it only counts.
Then export the pack: python3 -m pipeline.run --only none
Rights: the item's usage field (licenseurl) must be a public-domain mark or another admitted licence (rights.admitted); like every
Internet Archive adapter it is taken as worldwide. --max-year is an optional extra limit."""
import argparse
import datetime
import io
import json
from pathlib import Path

from PIL import Image

from . import db, embed, films as film_stage, quality, rights
from .sources.common import stable_pick

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "experiments" / "films"
POSTERS = ROOT / "data" / "posters"
POSTER_BASE = "https://user863.github.io/curi/data/posters/"
POSTER_WIDTH = 480


def poster(src, dest):
    img = Image.open(src).convert("RGB")
    img = img.resize((POSTER_WIDTH, round(img.height * POSTER_WIDTH / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=72, optimize=True)
    dest.write_bytes(buf.getvalue())


def clip_scores(film):
    """0..1 per clip: where its score ranks within the film."""
    s = sorted(c["score"] for c in film["clips"])
    return {c["start"]: (s.index(c["score"]) / max(1, len(s) - 1)) for c in film["clips"]}


def card(film, c, feat, today):
    ident, url = film["ident"], f"https://archive.org/details/{film['ident']}"
    uid = f"ia-{ident}@{int(c['start'])}"
    rank = clip_scores(film)[c["start"]]
    pop = quality.popularity(film["downloads"])
    score = quality.combine([(0.4, pop), (0.4, rank), (0.2, quality.completeness(film["description"], film["subjects"], film["creator"], film["year"]))])
    decade = f"{(film['year'] // 10) * 10}s" if film["year"] else None
    tags = list(dict.fromkeys(["film", "silent-film", *([decade] if decade else []), *feat["tags"]]))
    attribution = rights.attribution(film["creator"], film["title"], film["license"], url)
    r = rights.rights(film["license"], "worldwide", attribution, "video")
    return {"id": uid, "type": "video", "title": film["title"], "creator": film["creator"], "date": str(film["year"] or ""),
            "source": {"institution": "Internet Archive", "url": url, "sourceId": film["ident"], "fetchedAt": today, "collection": film["collection"]},
            "rights": r,
            "media": {"kind": "video", "url": film["url"], "fallback": None, "poster": POSTER_BASE + f"{ident}-{int(c['start'])}.jpg",
                      "duration": round(film["duration"]), "start": c["start"], "end": c["end"]},
            "editorial": {"note": film["description"], "noteSource": "source", "room": "film", "tags": tags,
                          "tone": stable_pick(ident, ["ink"]), "quality": quality.weight(score)}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-year", type=int, default=0, help="optional: only films up to this year")
    args = ap.parse_args()
    feats = json.loads((CACHE / "features.json").read_text())
    colour = json.loads((CACHE / "catalog" / "chunk_0000.colour.json").read_text())
    films = {p.parent.name: {**json.loads(p.read_text()), "ident": p.parent.name} for p in CACHE.glob("*/clips.json")}
    for i, f in films.items():  # films staged before the pipeline kept the item's metadata
        if "downloads" not in f:
            f.update({k: v for k, v in film_stage.source(film_stage.docs_for([i])[0]).items() if k not in ("file", "url")})
    take = {i: f for i, f in films.items() if (not args.max_year or (f["year"] and f["year"] <= args.max_year)) and rights.admitted(
        rights.rights(f["license"], "worldwide", rights.attribution(f["creator"], f["title"], f["license"]), "video"))}
    skipped = sorted(set(films) - set(take))
    cards = [(card(f, c, feats[f"ia-{i}@{int(c['start'])}"], datetime.date.today().isoformat()), f, c)
             for i, f in take.items() for c in f["clips"] if f"ia-{i}@{int(c['start'])}" in feats]
    print(f"{len(take)} films, {len(cards)} clips; skipped {len(skipped)} films (year or licence): {skipped}")
    if not args.apply:
        return
    POSTERS.mkdir(parents=True, exist_ok=True)
    conn = db.connect(ROOT / "pipeline" / "works.sqlite")
    rev = db.next_rev(conn)
    conn.execute("CREATE TABLE IF NOT EXISTS work_colour(work_id INTEGER PRIMARY KEY, features TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS work_affect(work_id INTEGER PRIMARY KEY, valence INTEGER NOT NULL, energy INTEGER NOT NULL)")
    for card_, film, c in cards:
        uid = card_["id"]
        f = feats[uid]
        vec = bytes((v + 256) % 256 for v in f["vec64"])
        wid = db.upsert(conn, card_, vec, embed.MODEL, embed.DIM, rev)
        conn.execute("INSERT OR REPLACE INTO work_colour VALUES(?,?)", (wid, json.dumps(colour[uid])))
        conn.execute("INSERT OR REPLACE INTO work_affect VALUES(?,?,?)", (wid, f["valence"], f["energy"]))
        poster(CACHE / film["ident"] / c["still"], POSTERS / f"{film['ident']}-{int(c['start'])}.jpg")
    conn.commit()
    print(f"wrote {len(cards)} clips and posters to {POSTERS}")


if __name__ == "__main__":
    main()
