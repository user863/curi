"""Downloads a source- and cluster-balanced training sample of published images, politely, into experiments/train.
    python3 -m pipeline.sample_training [--count 18000] [--seed 7] [--out experiments/train] [--threads 12]
Quotas per source group; inside a group one work per institution per round, so no institution dominates.
Per host at least 0.5 s between requests (Wikimedia 1.2 s), retries back off on 403/429/5xx, nothing is cached on disk
besides the result: images are stored resized (long side 768) as JPEG. Resumable: rerun to continue.
Writes <out>/images/<uid>.jpg and <out>/manifest.jsonl (one record per image), <out>/failed.jsonl."""
import argparse, collections, io, json, random, sqlite3, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
from PIL import Image
from . import http

DB = Path(__file__).parent / "works.sqlite"
QUOTA = {"wc": 4000, "cma": 1500, "met": 70, "ov": 119}  # the rest is Europeana
HOST_DELAY = {"upload.wikimedia.org": 1.2, "thumb.wikimedia.org": 1.2, "commons.wikimedia.org": 1.2}
DEFAULT_DELAY = 0.5
SIDE = 768
MAX_BYTES = 20_000_000

def candidates(conn):
    return conn.execute("""
        SELECT w.id, w.uid, w.source, w.room, w.cluster, w.quality, k.title, k.creator, k.date_label, k.institution, k.source_url,
               r.license, m.url, m.medium
        FROM work w JOIN work_card k ON k.work_id=w.id JOIN work_rights r ON r.work_id=w.id JOIN work_media m ON m.work_id=w.id
        WHERE w.state='published' AND w.type='image' AND m.url IS NOT NULL""").fetchall()

def choose(rows, count, rng):
    by = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        by[r["source"]][r["institution"]].append(r)
    picked = []
    for source, institutions in by.items():
        want = QUOTA.get(source, count - sum(QUOTA.values()))
        pools = []
        for v in institutions.values():
            rng.shuffle(v)
            pools.append(v)
        rng.shuffle(pools)
        while want > 0 and any(pools):
            for pool in pools:
                if want > 0 and pool:
                    picked.append(pool.pop())
                    want -= 1
    rng.shuffle(picked)  # spreads hosts across the worker threads
    return picked

def fetch(url):
    return http._fetch(url, HOST_DELAY.get(urlparse(url).netloc, DEFAULT_DELAY))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=18000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="experiments/train")
    ap.add_argument("--threads", type=int, default=12)
    args = ap.parse_args()
    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    tags = collections.defaultdict(list)
    for t in conn.execute("SELECT wt.work_id, t.slug FROM work_tag wt JOIN tag t ON t.id=wt.tag_id ORDER BY t.id"):
        tags[t[0]].append(t[1])
    todo = choose(candidates(conn), args.count, random.Random(args.seed))
    done = {json.loads(l)["uid"] for l in (out / "manifest.jsonl").read_text().splitlines()} if (out / "manifest.jsonl").exists() else set()
    todo = [r for r in todo if r["uid"] not in done]
    print(f"{len(done)} done, {len(todo)} to fetch", flush=True)
    lock = threading.Lock()
    stats = collections.Counter()
    t0 = time.time()

    def work(r):
        try:
            data = fetch(r["url"])
            if len(data) > MAX_BYTES:
                raise ValueError(f"{len(data)} bytes")
            im = Image.open(io.BytesIO(data))
            im.load()
            w, h = im.size
            im = im.convert("RGB")
            im.thumbnail((SIDE, SIDE), Image.LANCZOS)
            im.save(out / "images" / f"{r['uid']}.jpg", "JPEG", quality=88)
            rec = {"file": f"images/{r['uid']}.jpg", "uid": r["uid"], "id": r["id"], "source": r["source"], "institution": r["institution"], "cluster": r["cluster"],
                   "title": r["title"], "creator": r["creator"], "date": r["date_label"], "room": r["room"], "medium": r["medium"], "tags": tags[r["id"]],
                   "quality": r["quality"], "license": r["license"], "sourceUrl": r["source_url"], "imageUrl": r["url"], "width": w, "height": h}
            with lock:
                (out / "manifest.jsonl").open("a").write(json.dumps(rec, ensure_ascii=False) + "\n")
                stats["ok"] += 1
        except Exception as e:  # a source that refuses or an unreadable file: left out, with the reason
            with lock:
                (out / "failed.jsonl").open("a").write(json.dumps({"uid": r["uid"], "url": r["url"], "error": str(e)[:160]}) + "\n")
                stats["failed"] += 1
        with lock:
            n = stats["ok"] + stats["failed"]
            if n % 100 == 0:
                print(f"{n}/{len(todo)} ok {stats['ok']} failed {stats['failed']} {time.time() - t0:.0f}s", flush=True)

    with ThreadPoolExecutor(args.threads) as pool:
        list(pool.map(work, todo))
    print(f"finished: ok {stats['ok']}, failed {stats['failed']}, {time.time() - t0:.0f}s")

if __name__ == "__main__":
    main()
