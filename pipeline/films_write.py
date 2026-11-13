"""Writes the clips staged by pipeline/films.py into the work database and the poster folder.
    python3 -m pipeline.films_write [--apply] [--max-year N]
One work per clip: uid ia-<item>@<start> (<old uid>@<start> for a video already in the pack, which it replaces), type video, room film, the film file played from start to end, the key frame as poster
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
    uid = uid_of(film, c)
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


def uid_of(film, c):
    return f"{film.get('uid') or 'ia-' + film['ident']}@{int(c['start'])}"


def stored(conn, uid):
    """Everything a clip inherits from the single-excerpt work it replaces."""
    w = conn.execute("SELECT w.id, w.quality, w.room, w.tone FROM work w WHERE w.uid=?", (uid,)).fetchone()
    r = conn.execute("SELECT * FROM work_rights WHERE work_id=?", (w["id"],)).fetchone()
    tags = [t["slug"] for t in conn.execute("SELECT t.slug FROM work_tag wt JOIN tag t ON t.id=wt.tag_id WHERE wt.work_id=?", (w["id"],))]
    return {"quality": w["quality"], "room": w["room"], "tone": w["tone"], "tags": tags, "rights": {
        "license": r["license"], "licenseUrl": r["license_url"], "jurisdictions": r["jurisdictions"], "derivativesOk": r["derivatives_ok"],
        "verifiedBy": r["verified_by"], "attribution": r["attribution"], "gate": r["gate"], "creditLine": r["credit_line"]}}


def card_existing(old, film, c, feat, today):
    """A clip of a video already in the pack: the work's own rights, source, room and tags, plus the tags found on the key frame."""
    b = film["base"]
    rank = clip_scores(film)[c["start"]]
    quality_ = quality.weight(quality.combine([(0.7, (old["quality"] - 1) / 0.4), (0.3, rank)]))
    tags = [t for t in dict.fromkeys([*old["tags"], *feat["tags"]]) if t != "new"]
    return {"id": uid_of(film, c), "type": "video", "title": b["title"], "creator": b["creator"], "date": b["date_label"] or "",
            "source": {"institution": b["institution"], "url": b["source_url"], "sourceId": b["source_id"], "fetchedAt": today,
                       "collection": b["collection"], "work": b["work_title"]},
            "rights": old["rights"],
            "media": {"kind": "video", "url": b["url"], "fallback": b["fallback"], "poster": POSTER_BASE + f"{film['ident']}-{int(c['start'])}.jpg",
                      "duration": round(film["duration"]), "start": c["start"], "end": c["end"]},
            "editorial": {"note": b["note"], "noteSource": b["note_source"], "room": old["room"], "tags": tags, "tone": old["tone"], "quality": quality_}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-year", type=int, default=0, help="optional: only films up to this year")
    args = ap.parse_args()
    feats = json.loads((CACHE / "features.json").read_text())
    colour = json.loads((CACHE / "catalog" / "chunk_0000.colour.json").read_text())
    films = {p.parent.name: {**json.loads(p.read_text()), "ident": p.parent.name} for p in CACHE.glob("*/clips.json")}
    for i, f in films.items():  # films staged before the pipeline kept the item's metadata
        if "downloads" not in f and "base" not in f:
            f.update({k: v for k, v in film_stage.source(film_stage.docs_for([i])[0]).items() if k not in ("file", "url")})
    conn = db.connect(ROOT / "pipeline" / "works.sqlite")
    today = datetime.date.today().isoformat()
    olds = {f["uid"]: stored(conn, f["uid"]) for f in films.values() if "base" in f}
    take = {i: f for i, f in films.items() if (not args.max_year or (f["year"] and f["year"] <= args.max_year)) and rights.admitted(
        olds[f["uid"]]["rights"] if "base" in f else rights.rights(f["license"], "worldwide", rights.attribution(f["creator"], f["title"], f["license"]), "video"))}
    skipped = sorted(set(films) - set(take))
    cards = [(card_existing(olds[f["uid"]], f, c, feats[uid_of(f, c)], today) if "base" in f else card(f, c, feats[uid_of(f, c)], today), f, c)
             for f in take.values() for c in f["clips"] if uid_of(f, c) in feats]
    print(f"{len(take)} films ({sum('base' in f for f in take.values())} replacing an excerpt), {len(cards)} clips; skipped {len(skipped)} films (year or licence): {skipped}")
    if not args.apply:
        return
    POSTERS.mkdir(parents=True, exist_ok=True)
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
    for f in take.values():  # the single excerpt leaves the pack once its clips are in
        if "base" in f and any(uid_of(f, c) in feats for c in f["clips"]):
            conn.execute("UPDATE work SET state='retired', rev=? WHERE uid=? AND state='published'", (rev, f["uid"]))
    conn.commit()
    print(f"wrote {len(cards)} clips and posters to {POSTERS}")


if __name__ == "__main__":
    main()
