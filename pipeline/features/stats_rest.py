"""Technical image statistics (pipeline/imagestats.py) for every published image that has none yet, fetched on the fly.
    experiments/.venv/bin/python -m pipeline.features.stats_rest [--out experiments/stats] [--catalog experiments/catalog]
Writes <out>/chunk_XXXX.stats.json {uid: stats}; uids already in a chunk there or in <catalog> are skipped.
Fetches are spaced per host as in embed_rest.py. Then: python3 -m pipeline.apply_stats"""
import argparse, collections, io, itertools, json, random, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
from PIL import Image
from .. import http, imagestats
from .embed_rest import DB, HOST_GAP, MAX_BYTES, SLOW_HOSTS, THREADS, WINDOW, pending

CHUNK = 5000
SLOW_STREAM = {"thumb.wikimedia.org", "upload.wikimedia.org"}  # one request per HOST_GAP, so they get a stream of their own

def known(*dirs):
    done = set()
    for d in dirs:
        for f in Path(d).glob("chunk_*.stats.json"):
            done.update(json.loads(f.read_text()))
    return done

def load(item):
    uid, url = item
    try:
        data = http._fetch(url, SLOW_HOSTS.get(urlparse(url).netloc, HOST_GAP))
        if len(data) > MAX_BYTES:
            raise ValueError(f"{len(data)} bytes")
        img = Image.open(io.BytesIO(data))
        size = img.size
        img.draft("RGB", (448, 448))
        return uid, imagestats.features(data, size, img)
    except Exception:
        return uid, None

def crawl(items, threads, name, out):
    """Measures items with `threads` fetches in flight; writes a chunk of CHUNK results at a time."""
    n, got, seen = 0, {}, 0
    def save():
        nonlocal n, got
        if got:
            (out / f"chunk_{name}{n:04d}.stats.json").write_text(json.dumps(got))
            n, got = n + 1, {}
    with ThreadPoolExecutor(threads) as pool:
        it = iter(items)
        waiting = collections.deque(pool.submit(load, x) for x in itertools.islice(it, threads * 4))
        while waiting:
            uid, st = waiting.popleft().result()
            nxt = next(it, None)
            if nxt is not None:
                waiting.append(pool.submit(load, nxt))
            seen += 1
            if st:
                got[uid] = st
            if len(got) >= CHUNK:
                save()
            if seen % 1000 == 0:
                print(f"{name} {seen}/{len(items)}", flush=True)
    save()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="experiments/stats")
    ap.add_argument("--catalog", default="experiments/catalog")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    todo = pending(known(out, args.catalog))
    random.Random(0).shuffle(todo)
    # a host that is fetched slowly must not hold up the others: its own stream
    slow = [x for x in todo if urlparse(x[1]).netloc in SLOW_STREAM]
    fast = [x for x in todo if urlparse(x[1]).netloc not in SLOW_STREAM]
    print(f"{len(fast)} + {len(slow)} to measure", flush=True)
    with ThreadPoolExecutor(2) as streams:
        jobs = [streams.submit(crawl, fast, THREADS, "a", out), streams.submit(crawl, slow, 8, "w", out)]
        for j in jobs:
            j.result()
    print("done", flush=True)

if __name__ == "__main__":
    main()
