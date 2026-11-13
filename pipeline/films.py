"""Film pipeline: Internet Archive item -> verified copy -> key scenes -> per-clip features, staged under experiments/films/.
    experiments/.venv/bin/python -m pipeline.films ITEM [ITEM ...] [--per 240] [--keep]
Stages, each resumable and cached per item in <CACHE>/<item>/:
  discover  public-domain items by the item's own usage field (licenseurl: Public Domain Mark or the old PD dedication)
  fetch     the lightest playable file (the one the app will play), resumed on failure, size and md5 checked against the item's metadata
  analyse   cuts, motion, frame embeddings (analysis.npz; clips.py)
  pick      clips.json: start, end, score, key frame, with the file's provenance
  stills    key frame JPEGs (the poster of each clip)
  features  one row per clip in <CACHE>/catalog/ in the layout the image tools read (chunk_*.npy, .json, .colour.json):
            raw SigLIP 2 vector of the key frame, colour features; then tags (features/tag_rest.py), mood, valence and energy
            (features/affect_norm.py), and the 96-d vector (blocks.py) in <CACHE>/features.json
The video file is deleted after the stills unless --keep. Nothing here touches works.sqlite."""
import argparse
import collections
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from . import blocks, clips, http, quality, rights, state, taxonomy
from .features import palette
from .sources import archive
from .sources.common import parse_seconds

CACHE = Path("experiments/films")
LENGTH_TOLERANCE = 0.02  # the file may differ this much from the length the item states
RETRIES = 4
HOST_PAUSE = 3  # seconds between two films of one host (an existing-work run)


def first(v):
    return (v[0] if isinstance(v, list) else v) or ""


def search(collection, max_year, rows, min_downloads):
    """Public-domain films of an Internet Archive collection, most downloaded first."""
    q = (f"collection:{collection} AND mediatype:movies AND licenseurl:(*publicdomain*)" + (f" AND year:[1880 TO {max_year}]" if max_year else "")
         + f" AND downloads:[{min_downloads} TO 1000000000]")
    params = [("q", q), ("rows", rows), ("page", 1), ("output", "json"), ("sort[]", "downloads desc")] + [("fl[]", f) for f in archive.FIELDS]
    return http.get_json("https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(params))["response"]["docs"]


def source(doc):
    """The item's licence and the file to use, or a reason it is rejected. doc: its advancedsearch row."""
    ident = doc["identifier"]
    license = rights.license_from_url(doc.get("licenseurl"))
    if not license:
        return {"error": "no-open-license", "licenseurl": doc.get("licenseurl")}
    meta = http.get_json(f"https://archive.org/metadata/{ident}", delay=0.2)
    cands = archive.candidate_files(meta.get("files", []), {"kind": "video", "min_seconds": 60})
    if not cands:
        return {"error": "no-video-file"}
    f, length = cands[0]
    return {"ident": ident, "title": first(doc.get("title")), "year": taxonomy.year_of(doc.get("year") or doc.get("date")),
            "creator": first(doc.get("creator")) or "Unknown", "license": license, "licenseurl": doc.get("licenseurl"),
            "description": taxonomy.clean_description(first(doc.get("description"))), "subjects": taxonomy.as_list(doc.get("subject")),
            "downloads": doc.get("downloads") or 0, "collection": first(doc.get("collection")),
            "url": archive.download_url(ident, f["name"]),
            "file": {"name": f["name"], "format": f["format"], "size": int(f["size"]), "md5": f.get("md5"), "length": length}}


def safe(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120]


def existing(db, min_seconds):
    """Videos already in the pack, one fixed excerpt each: the base of their clips, best first. Their rights, tags and source
    carry over to the clips; media url, title and licence are what the work already says."""
    import sqlite3
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""SELECT w.uid, w.quality, c.title, c.creator, c.date_label, c.note, c.note_source, c.institution, c.work_title, c.source_url,
          m.url, m.fallback, m.duration_s, r.license, r.license_url, r.jurisdictions, r.attribution, r.credit_line, s.source_id, s.collection,
          (SELECT group_concat(t.slug, ',') FROM work_tag wt JOIN tag t ON t.id = wt.tag_id WHERE wt.work_id = w.id) AS tags
        FROM work w JOIN work_card c ON c.work_id = w.id JOIN work_media m ON m.work_id = w.id JOIN work_rights r ON r.work_id = w.id
        JOIN work_source s ON s.work_id = w.id
        WHERE w.type = 'video' AND w.state = 'published' AND w.uid NOT LIKE '%@%' AND m.duration_s >= ? ORDER BY w.quality DESC""", (min_seconds,)).fetchall()
    return [{"ident": safe(r["uid"]), "uid": r["uid"], "base": dict(r), "title": r["title"], "year": taxonomy.year_of(r["date_label"]),
             "creator": r["creator"], "license": r["license"], "description": r["note"] or "", "subjects": [], "downloads": 0,
             "collection": r["collection"], "url": r["url"], "file": {"name": safe(r["uid"]) + ".mp4", "size": None, "md5": None, "length": r["duration_s"]}}
            for r in rows]


def host_of(item):
    return urllib.parse.urlparse(item["url"]).netloc


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(item, dest):
    """Download item['url'] to dest, resuming a partial file; checks size and md5. Raises when it cannot get a good copy."""
    want, md5 = item["file"].get("size"), item["file"].get("md5")
    part = Path(str(dest) + ".part")
    if dest.exists() and (want is None or dest.stat().st_size == want) and (not md5 or md5_of(dest) == md5):
        return dest
    for attempt in range(RETRIES):
        have = part.stat().st_size if part.exists() else 0
        req = urllib.request.Request(item["url"], headers={"User-Agent": http.UA, **({"Range": f"bytes={have}-"} if have else {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r, open(part, "ab" if have and r.status == 206 else "wb") as out:
                for block in iter(lambda: r.read(1 << 20), b""):
                    out.write(block)
        except Exception as e:
            print(f"  fetch attempt {attempt + 1} failed: {e!r}", flush=True)
            time.sleep(2 ** attempt)
            continue
        if (want is None or part.stat().st_size == want) and (not md5 or md5_of(part) == md5):
            part.rename(dest)
            return dest
        part.unlink()  # wrong size or hash: start over
    raise RuntimeError("could not fetch a verified copy")


def duration_of(path):
    """Seconds, from ffmpeg's header line."""
    out = subprocess.run([clips.ffmpeg(), "-i", str(path)], capture_output=True, text=True).stderr
    h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out).groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


def process(doc, per, keep=False, min_seconds=0):
    """Stages fetch to stills for one item; returns its clips.json content, or {'error': ...}.
    doc: an advancedsearch row, or an item from existing() (it carries its file)."""
    item = doc if "file" in doc else source(doc)
    if "error" in item:
        return item
    ident = item["ident"]
    d = CACHE / ident
    d.mkdir(parents=True, exist_ok=True)
    out = d / "clips.json"
    if (item["file"]["length"] or 0) < min_seconds:
        return {"error": "too-short", "minutes": round((item["file"]["length"] or 0) / 60)}
    video = d / item["file"]["name"]
    if not (d / "analysis.npz").exists() or not (d / "stills").exists():
        fetch(item, video)
        got, stated = duration_of(video), item["file"]["length"]
        if stated and not item.get("base") and abs(got - stated) / stated > LENGTH_TOLERANCE:  # existing works carry a stated length from other sources
            return {"error": "length-mismatch", "stated": stated, "got": got}
    a = clips.analyse(video, d / "analysis.npz")
    picked = clips.pick(a, per)
    (d / "stills").mkdir(exist_ok=True)
    for n, c in enumerate(picked):
        c["still"] = f"stills/{n:02d}.jpg"
        if not (d / c["still"]).exists():
            clips.frame_at(video, c["key"], d / c["still"])
        c["vec"] = (a["vec"][int(c["key"] / clips.SAMPLE)]).astype(np.float32).tolist()
    result = {**item, "duration": float(a["duration"]), "cuts": len(a["cuts"]), "clips": picked}
    out.write_text(json.dumps(result))
    if not keep and video.exists():
        video.unlink()
    return result


def stage(idents):
    """One catalog chunk of every clip's key frame, in the layout the image tools read."""
    cat = CACHE / "catalog"
    cat.mkdir(parents=True, exist_ok=True)
    uids, vecs, colour, meta = [], [], {}, {}
    for ident in idents:
        r = json.loads((CACHE / ident / "clips.json").read_text())
        for c in r["clips"]:
            uid = f"{r.get('uid', 'ia-' + ident)}@{int(c['start'])}"
            uids.append(uid)
            vecs.append(c["vec"])
            colour[uid] = palette.features((CACHE / ident / c["still"]).read_bytes())
            meta[uid] = {"film": ident, "title": r["title"], "year": r["year"], "start": c["start"], "end": c["end"], "still": str(CACHE / ident / c["still"])}
    for f in cat.glob("chunk_*"):
        f.unlink()
    np.save(cat / "chunk_0000.npy", np.array(vecs, dtype=np.float16))
    (cat / "chunk_0000.json").write_text(json.dumps(uids))
    (cat / "chunk_0000.colour.json").write_text(json.dumps(colour))
    (CACHE / "meta.json").write_text(json.dumps(meta))
    return uids, np.array(vecs, dtype=np.float32), colour, meta


def tag(cat, uids):
    """Tags from the saved ensemble, through features/tag_rest.py on the staged chunk."""
    subprocess.run([sys.executable, "-m", "pipeline.features.tag_rest", "--catalog", str(cat)], check=True, capture_output=True)
    pred = json.loads((cat / "pred.json").read_text())
    allowed = {t for t, m in json.loads(Path("experiments/train/ens/terms.json").read_text()).items() if m["precision"] >= 0.4}
    return {u: [t for t, _p in pred.get(u, []) if t in allowed] for u in uids}


def features(idents):
    from .features import affect_norm
    uids, emb, colour, meta = stage(idents)
    tags = tag(CACHE / "catalog", uids)
    affect = affect_norm.score(emb)
    pca = np.load(Path(__file__).parent / "siglip_pca64.npz")
    p = (emb - pca["mean"]) @ pca["components"].T
    sem = p / np.linalg.norm(p, axis=1, keepdims=True)
    rows = []
    for i, u in enumerate(uids):
        mood = affect[i]["mood"]
        tags[u] = tags[u] + [m for m in mood if m not in tags[u]]
        rows.append(blocks.colour_raw(colour[u], meta[u]["year"]))
    v96 = blocks.to_int8(blocks.extend(sem, [tags[u] for u in uids], rows, blocks.load_basis()))
    out = {u: {**meta[u], "tags": tags[u], "valence": affect[i]["valence"], "energy": affect[i]["energy"],
               "colour": {k: colour[u][k] for k in ("hue", "monochrome", "lightness", "warmth", "chroma")},
               "palette": [p["hex"] for p in colour[u]["palette"][:4]],
               "vec64": np.round(sem[i] * 127).astype(int).tolist(), "vec96": v96[i].astype(int).tolist()}
           for i, u in enumerate(uids)}
    (CACHE / "features.json").write_text(json.dumps(out))
    return out


def docs_for(idents):
    return [d for i in idents for d in http.get_json("https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(
        [("q", f"identifier:{i}"), ("rows", 1), ("output", "json")] + [("fl[]", f) for f in archive.FIELDS]))["response"]["docs"]]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("items", nargs="*", help="item ids; or use --collection")
    ap.add_argument("--collection", help="take the most downloaded public-domain films of this collection")
    ap.add_argument("--existing", action="store_true", help="the videos already in the pack (one fixed excerpt each) instead: key scenes for each")
    ap.add_argument("--take", type=int, default=20)
    ap.add_argument("--max-year", type=int, default=0, help="only films from this year or earlier; 0 (default) leaves it to the item's usage field")
    ap.add_argument("--min-downloads", type=int, default=500)
    ap.add_argument("--min-minutes", type=int, default=20)
    ap.add_argument("--per-creator", type=int, default=2)
    ap.add_argument("--per", type=float, default=clips.PER)
    ap.add_argument("--keep", action="store_true", help="keep the downloaded video")
    ap.add_argument("--workers", type=int, default=1, help="processes, each with its own model; films are shared out between them")
    ap.add_argument("--shard", help="i/n: this process takes every n-th film (set by --workers)")
    args = ap.parse_args()
    if args.existing:
        docs = [d for d in existing(Path(__file__).parent / "works.sqlite", args.min_minutes * 60)]
        args.take = len(docs)
    elif args.collection:
        found = [d for d in search(args.collection, args.max_year, args.take * 6, args.min_downloads) if not quality.is_junk_title(first(d.get("title")))]
        seen, by_creator, docs = set(), collections.Counter(), []
        for d in found:  # one film once, and at most --per-creator of one maker (Chaplin alone has dozens)
            key, maker = state.dupe_key(first(d.get("title")), first(d.get("creator"))), first(d.get("creator")) or d["identifier"]
            if key in seen or by_creator[maker] >= args.per_creator:
                continue
            seen.add(key); by_creator[maker] += 1; docs.append(d)
    else:
        docs = docs_for(args.items)
    docs = [d for d in docs if not (CACHE / (d.get("ident") or d["identifier"]) / "clips.json").exists()][:args.take * 2]  # done items are kept  # spare candidates for the ones that fail the checks
    if args.workers > 1:
        procs = [subprocess.Popen([sys.executable, "-W", "ignore", "-m", "pipeline.films", *sys.argv[1:], "--workers", "1", "--shard", f"{i}/{args.workers}"])
                 for i in range(args.workers)]
        for p in procs:
            p.wait()
        args.shard = None
        docs = []
    elif args.shard:
        i, n = map(int, args.shard.split("/"))
        hosts = sorted({host_of(d) for d in docs if "file" in d})
        by_host = len(hosts) > 1 or not hosts  # a host stays with one worker (one download at a time); the last host is shared
        docs = [d for d in docs if (hosts.index(host_of(d)) % n if "file" in d else 0) == i] if by_host and hosts else docs[i::n]
        args.take = len(docs) if args.existing else -(-args.take // n)
    done = []
    for doc in docs:
        if len(done) >= args.take:
            break
        ident = doc.get("ident") or doc["identifier"]
        try:
            r = process(doc, args.per, args.keep, args.min_minutes * 60)
            if "file" in doc:
                time.sleep(HOST_PAUSE)
        except Exception as e:  # one bad item must not stop the batch
            r = {"error": repr(e)[:200]}
        print(ident, r.get("error") or f"{len(r['clips'])} clips of {r['duration'] / 60:.0f} min", flush=True)
        if "error" not in r:
            done.append(ident)
        else:
            (CACHE / ident).mkdir(parents=True, exist_ok=True)
            (CACHE / ident / "rejected.json").write_text(json.dumps(r))
    if args.shard:  # a worker leaves the features to the parent
        return
    allf = sorted(p.parent.name for p in CACHE.glob("*/clips.json"))
    if allf:
        print(len(features(allf)), "clips with features ->", CACHE / "features.json")


if __name__ == "__main__":
    main()
