"""SigLIP 2 embeddings for every published image not yet in the training set, fetched and embedded on the fly (no images kept).
    experiments/.venv/bin/python -m pipeline.features.embed_rest [--out experiments/catalog] [--limit N]
Also the colour features of each picture (palette.py), in chunk_XXXX.colour.json: {uid: features}.
Resumable: writes <out>/chunk_XXXX.npy (float16) + chunk_XXXX.json (uids) every CHUNK images; uids already in a chunk or in
failed.jsonl are skipped. Hosts are spaced as in sample_images.py."""
import argparse, collections, io, itertools, json, random, sqlite3, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor
from .. import http
from . import palette
from .. import imagestats
from .embed_train import MODEL, BATCH

DB = Path(__file__).parents[1] / "works.sqlite"
SLOW_HOSTS = {"upload.wikimedia.org": 1.2}
THREADS, WINDOW = 64, 256  # fetches in flight
HOST_GAP = 0.25  # seconds between requests to one host (0.4 before)
MAX_BYTES = 15_000_000
CHUNK = 2000

def pending(done):
    conn = sqlite3.connect(DB)
    rows = conn.execute("""SELECT w.uid, m.url FROM work w JOIN work_media m ON m.work_id=w.id
                           WHERE w.state='published' AND w.type='image' AND m.url IS NOT NULL ORDER BY w.id""").fetchall()
    return [(u, url) for u, url in rows if u not in done]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="experiments/catalog")
    ap.add_argument("--train", default="experiments/train")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    done = {json.loads(l)["uid"] for l in (Path(args.train) / "manifest.jsonl").read_text().splitlines() if l.strip()}
    for f in out.glob("chunk_[0-9]*[0-9].json"):
        done.update(json.loads(f.read_text()))
    failed = out / "failed.jsonl"
    if failed.exists():
        done.update(json.loads(l)["uid"] for l in failed.read_text().splitlines() if l.strip())
    todo = pending(done)
    random.Random(0).shuffle(todo)  # providers interleave, so the per-host spacing does not serialise the run
    todo = todo[:args.limit or None]
    print(f"{len(todo)} to embed", flush=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = AutoModel.from_pretrained(MODEL).to(device).eval()
    proc = AutoProcessor.from_pretrained(MODEL)

    def load(item):
        uid, url = item
        try:
            data = http._fetch(url, SLOW_HOSTS.get(urlparse(url).netloc, HOST_GAP))
            if len(data) > MAX_BYTES:
                raise ValueError(f"{len(data)} bytes")
            img = Image.open(io.BytesIO(data))
            size = img.size  # before draft mode shrinks it
            img.draft("RGB", (448, 448))
            return uid, (img.convert("RGB"), palette.features(data), imagestats.features(data, size, img))
        except Exception as e:
            return uid, str(e)[:120]

    n = len(list(out.glob("chunk_[0-9]*[0-9].json")))
    vecs, uids, colours, stats = [], [], {}, {}
    def flush():
        nonlocal vecs, uids, colours, stats, n
        if not uids:
            return
        np.save(out / f"chunk_{n:04d}.npy", np.concatenate(vecs))
        (out / f"chunk_{n:04d}.colour.json").write_text(json.dumps(colours))
        (out / f"chunk_{n:04d}.stats.json").write_text(json.dumps(stats))
        (out / f"chunk_{n:04d}.json").write_text(json.dumps(uids))
        n += 1
        vecs, uids, colours, stats = [], [], {}, {}

    def stream(pool, items, window=WINDOW):
        """Loads in order with `window` fetches in flight, so one slow host does not stall a whole batch."""
        it = iter(items)
        waiting = collections.deque(pool.submit(load, x) for x in itertools.islice(it, window))
        while waiting:
            yield waiting.popleft().result()
            nxt = next(it, None)
            if nxt is not None:
                waiting.append(pool.submit(load, nxt))

    with ThreadPoolExecutor(THREADS) as pool, torch.no_grad():
        batch, seen = [], 0
        loads = stream(pool, todo)
        done_all = False
        while not done_all:
            batch = list(itertools.islice(loads, BATCH))
            done_all = len(batch) < BATCH
            ok = []
            for uid, got in batch:
                if isinstance(got, str):
                    with failed.open("a") as f:
                        f.write(json.dumps({"uid": uid, "error": got}) + "\n")
                else:
                    ok.append((uid, got[0]))
                    colours[uid] = got[1]
                    stats[uid] = got[2]
            seen += len(batch)
            if ok:
                x = proc(images=[im for _, im in ok], return_tensors="pt").to(device)
                v = torch.nn.functional.normalize(model.get_image_features(**x), dim=-1)
                vecs.append(v.cpu().numpy().astype(np.float16))
                uids += [u for u, _ in ok]
            if len(uids) >= CHUNK:
                flush()
            if (seen // BATCH) % 10 == 0:
                print(f"{min(seen, len(todo))}/{len(todo)}", flush=True)
        flush()
    print("done", flush=True)

if __name__ == "__main__":
    main()
