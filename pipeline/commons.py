"""Pulls Wikimedia Commons featured pictures (or, with --media, featured video and sound) into the database, slowly,
alongside any other pipeline job. One API request about every 1.2 seconds (50 files each), newest featured first.
Resumable. Vector graphics, small images and icons or logos are left out.
Usage: python3 -m pipeline.commons [--media] [--take N] [--pause 1.2]"""
import argparse, json
from datetime import datetime
from pathlib import Path
from . import db, embed, state
from .run import finish
from .sources import commons

HERE = Path(__file__).parent

def log(msg):
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--media", action="store_true", help="featured video and sound instead of pictures")
    ap.add_argument("--take", type=int, default=0, help="stop after this many new works (0 = all)")
    ap.add_argument("--pause", type=float, default=1.2, help="seconds between API requests")
    ap.add_argument("--fresh", action="store_true", help="start again from the newest")
    ap.add_argument("--category", action="append", help="only this category (repeatable), instead of the whole tree")
    args = ap.parse_args()
    checkpoint = HERE / ".cache" / ("commons-media.json" if args.media and not args.category else "commons-targeted.json" if args.category else "commons.json")
    overrides = json.loads((HERE / "overrides.json").read_text())["cards"]
    conn = db.connect(HERE / "works.sqlite", timeout=120)
    state.load(conn)
    rev = db.next_rev(conn)
    conn.commit()
    saved = {} if args.fresh or not checkpoint.exists() else json.loads(checkpoint.read_text())
    done, resume, added = saved.get("done", []), saved.get("resume"), saved.get("added", 0)
    categories = args.category or (commons.category_tree(commons.MEDIA, args.pause) if args.media else [commons.PICTURES])
    build = commons.media_candidate if args.media else commons.candidate
    today = datetime.now().date().isoformat()
    log(f"Commons featured {'media' if args.media else 'pictures'}: {len(categories)} categories, {'resuming' if done or resume else 'from the newest'}")
    new, batches, rejected = 0, 0, {}
    for category in categories:
        if category in done:
            continue
        while True:
            pages, resume = commons.batch(category, resume, args.pause, args.media)
            cards = []
            for page in pages:
                card, why = build(page, today)
                if card and state.dupe_key(card["title"], card["creator"]) not in state.KEYS and card["rights"]["gate"] == "yes":
                    cards.append(finish(card, overrides))
                    state.KNOWN.add(card["id"])
                    state.KEYS.add(state.dupe_key(card["title"], card["creator"]))
                else:
                    reason = why or ("rights-gate" if card and card["rights"]["gate"] != "yes" else "duplicate")
                    rejected[reason] = rejected.get(reason, 0) + 1
            for card in cards:
                db.upsert(conn, card, embed.embed(card), embed.MODEL, embed.DIM, rev)
            conn.commit()
            added += len(cards)
            new += len(cards)
            batches += 1
            if not resume:
                done.append(category)
            checkpoint.parent.mkdir(exist_ok=True)
            checkpoint.write_text(json.dumps({"done": done, "resume": resume, "added": added}))
            if batches % 10 == 0:
                log(f"{added} added ({batches * 50} files read); rejected {rejected}")
            if not resume or (args.take and new >= args.take):
                break
        resume = None
        if args.take and new >= args.take:
            break
    log(f"finished: {added} added; rejected {rejected}")
    log("not exported yet: run `python3 -m pipeline.run --only none` to write the pack")

if __name__ == "__main__":
    main()
