"""Overnight harvest of open-licensed artworks from Europeana's art theme, spread over hours and kept polite.
Providers (museums and art archives) take turns, one page of 100 at a time, so no single archive dominates and
every one of them keeps moving. Best works first (Europeana's completeness order). Resumable: cursors are kept.

Politeness: one request per second at most per host, a global cap on requests per second, Europeana's API itself
barely touched (one search page per 100 works). Stops at the time budget or the target, whichever comes first.

Usage: python3 -m pipeline.overnight [--hours 8] [--take 50000] [--per-provider 1500] [--providers 40]
                                     [--rate 3] [--host-interval 1.0] [--workers 6]"""
import argparse, json, queue, threading, time
from datetime import datetime
from pathlib import Path
from . import db, embed, http, secrets, state
from .run import finish
from .sources import europeana

HERE = Path(__file__).parent
CHECKPOINT = HERE / ".cache" / "overnight.json"

def log(msg):
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hours", type=float, default=8)
    ap.add_argument("--take", type=int, default=50000)
    ap.add_argument("--per-provider", type=int, default=1500)
    ap.add_argument("--providers", type=int, default=40)
    ap.add_argument("--rate", type=float, default=3.0, help="requests per second, all hosts together")
    ap.add_argument("--host-interval", type=float, default=1.0, help="seconds between requests to one host")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--fresh", action="store_true", help="ignore the saved cursors")
    args = ap.parse_args()
    key = secrets.get("EUROPEANA_API_KEY")
    if not key:
        raise SystemExit("EUROPEANA_API_KEY is not set (see pipeline/README.md)")
    http.configure(per_host=args.host_interval, per_second=args.rate)
    overrides = json.loads((HERE / "overrides.json").read_text())["cards"]
    conn = db.connect(HERE / "works.sqlite", timeout=120, shared=True)
    state.load(conn)
    rev = db.next_rev(conn)
    conn.commit()

    src = {"name": "europeana-museums", "type": "IMAGE", "kind": "image", "theme": "art", "min_tier": 4,
           "providers": args.providers, "tones": ["ink", "paper", "mauve", "sky"], "tags": ["europeana"], "workers": 4}
    saved = {} if args.fresh or not CHECKPOINT.exists() else json.loads(CHECKPOINT.read_text())
    providers = europeana.providers(key, src)
    progress = {p: saved.get(p, {"cursor": "*", "added": 0, "done": False}) for p in providers}
    log(f"{len(providers)} providers; target {args.take} works in {args.hours} h; "
        f"at most {args.rate}/s overall and one request per {args.host_interval}s per host")

    deadline = time.time() + args.hours * 3600
    lock = threading.Lock()  # database writes and shared counters
    totals = {"added": 0, "pages": 0, "candidates": 0}
    stats = {}
    turns = queue.Queue()
    for p in providers:
        if not progress[p]["done"]:
            turns.put(p)

    def save():
        CHECKPOINT.parent.mkdir(exist_ok=True)
        CHECKPOINT.write_text(json.dumps(progress))

    def take_turn(provider):
        """One page of one provider: fetch, filter, probe, store. Returns False when the provider is finished."""
        p = progress[provider]
        data = europeana.search(key, src, {"qf": f'DATA_PROVIDER:"{provider}"', "sort": "COMPLETENESS desc,europeana_id asc", "cursor": p["cursor"]}, 100)
        items = data.get("items", [])
        today = datetime.now().date().isoformat()
        with lock:
            fresh = [c for c, _ in (europeana.candidate(it, src, today) for it in items) if c and state.dupe_key(c["title"], c["creator"]) not in state.KEYS]
        cards = [finish(c, overrides) for c in europeana.probe_all(fresh, src, stats)]
        with lock:
            for card in cards:
                if card["id"] in state.KNOWN:
                    continue
                db.upsert(conn, card, embed.embed(card), embed.MODEL, embed.DIM, rev)
                state.KNOWN.add(card["id"])
                state.KEYS.add(state.dupe_key(card["title"], card["creator"]))
            conn.commit()
            p["added"] += len(cards)
            p["cursor"] = data.get("nextCursor")
            p["done"] = not items or not p["cursor"] or p["added"] >= args.per_provider
            totals["added"] += len(cards)
            totals["pages"] += 1
            totals["candidates"] += len(fresh)
            save()
            if totals["pages"] % 10 == 0:
                left = (deadline - time.time()) / 3600
                log(f"{totals['added']} added from {totals['pages']} pages ({totals['candidates']} candidates); {left:.1f} h left")
        return not p["done"]

    def worker():
        while time.time() < deadline and totals["added"] < args.take:
            try:
                provider = turns.get(timeout=5)
            except queue.Empty:
                if all(p["done"] for p in progress.values()):
                    return
                continue
            try:
                if take_turn(provider):
                    turns.put(provider)  # back of the line: the others get their turn first
            except Exception as e:  # one bad page must not end a night's run
                log(f"{provider}: {secrets.redact(repr(e))[:120]}")
                time.sleep(30)
                turns.put(provider)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    save()
    log(f"finished: {totals['added']} works added in {totals['pages']} pages; rejected {stats.get(src['name'], {})}")
    log("not exported yet: run `python3 -m pipeline.run --only none` to write the pack")

if __name__ == "__main__":
    main()
