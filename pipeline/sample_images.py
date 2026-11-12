"""Pulls a seeded, source-balanced sample of published images into a local folder for extraction experiments.
    python3 -m pipeline.sample_images [--count 100] [--seed 1] [--out experiments]
Writes <out>/images/<uid>.<ext> and <out>/images.json (one record per file: work fields, license, source, size)."""
import argparse, collections, io, json, random, sqlite3, time
from pathlib import Path
from urllib.parse import urlparse
from PIL import Image
from . import http

DB = Path(__file__).parent / "works.sqlite"
SHARE = {"wc": 0.20, "cma": 0.10, "met": 0.10, "ov": 0.10}  # the rest goes to Europeana, one work per institution first
SLOW_HOSTS = {"upload.wikimedia.org": 1.2}  # seconds between requests
MAX_BYTES = 15_000_000

def candidates(conn):
    rows = conn.execute("""
        SELECT w.id, w.uid, w.source, w.room, w.quality, k.title, k.creator, k.date_label, k.institution, k.source_url,
               r.license, m.url, m.medium
        FROM work w JOIN work_card k ON k.work_id=w.id JOIN work_rights r ON r.work_id=w.id JOIN work_media m ON m.work_id=w.id
        WHERE w.state='published' AND w.type='image' AND m.url IS NOT NULL""").fetchall()
    tags = collections.defaultdict(list)
    for t in conn.execute("SELECT wt.work_id, t.slug FROM work_tag wt JOIN tag t ON t.id=wt.tag_id ORDER BY t.id"):
        tags[t[0]].append(t[1])
    return rows, tags

def choose(rows, count, rng):
    """Per source its share, spread over as many institutions as possible; Europeana takes what is left."""
    by_source = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        by_source[r["source"]][r["institution"]].append(r)
    picked = []
    for source, institutions in by_source.items():
        want = round(count * SHARE[source]) if source in SHARE else count - sum(round(count * v) for v in SHARE.values())
        pools = [rng.sample(v, len(v)) for v in institutions.values()]
        rng.shuffle(pools)
        while want > 0 and any(pools):  # one per institution per round
            for pool in pools:
                if want > 0 and pool:
                    picked.append(pool.pop())
                    want -= 1
    return picked

def fetch(url):
    delay = SLOW_HOSTS.get(urlparse(url).netloc, 0.4)
    return http.get_bytes(url, delay=delay)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="experiments")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows, tags = candidates(conn)
    rng = random.Random(args.seed)
    todo = choose(rows, args.count, rng)
    records, failed = [], []
    for i, r in enumerate(todo, 1):
        try:
            data = fetch(r["url"])
            if len(data) > MAX_BYTES:
                raise ValueError(f"{len(data)} bytes")
            img = Image.open(io.BytesIO(data))
            img.load()
        except Exception as e:  # a source that refuses or an unreadable file: leave it out, say why
            failed.append({"uid": r["uid"], "url": r["url"], "error": str(e)[:120]})
            print(f"[{i}/{len(todo)}] skip {r['uid']}: {str(e)[:80]}", flush=True)
            continue
        ext = {"JPEG": "jpg", "PNG": "png", "GIF": "gif", "WEBP": "webp", "TIFF": "tif"}.get(img.format, "img")
        name = f"{r['uid']}.{ext}"
        (out / "images" / name).write_bytes(data)
        records.append({"file": f"images/{name}", "uid": r["uid"], "id": r["id"], "source": r["source"], "institution": r["institution"],
                        "title": r["title"], "creator": r["creator"], "date": r["date_label"], "room": r["room"], "medium": r["medium"],
                        "tags": tags[r["id"]], "quality": r["quality"], "license": r["license"], "sourceUrl": r["source_url"],
                        "imageUrl": r["url"], "width": img.width, "height": img.height, "mode": img.mode, "bytes": len(data)})
        print(f"[{i}/{len(todo)}] {r['source']:3} {r['institution'][:40]:40} {img.width}x{img.height} {len(data) // 1024} KB", flush=True)
    (out / "images.json").write_text(json.dumps({"seed": args.seed, "count": len(records), "failed": failed, "images": records}, indent=1, ensure_ascii=False))
    per = collections.Counter(r["source"] for r in records)
    print(f"done: {len(records)} images, {len(failed)} failed, per source {dict(per)}, {sum(r['bytes'] for r in records) / 1e6:.0f} MB")

if __name__ == "__main__":
    main()
