"""Checks that the published pictures still load the way a phone fetches them, and fixes or retires the rest.
An http:// address is upgraded to https when the host serves it there; a picture that cannot be fetched (refused, not an
image, too large, no https) is retired, so it never reaches the feed. Retired works stay in the database and are not
re-ingested. Run it now and then: links rot.
Usage: python3 -m pipeline.verify [--dry-run]"""
import argparse, collections
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from . import db, probe

def check(row):
    verdict, url = probe.secure_image(row["url"])
    return row["id"], row["url"], url, verdict

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    conn = db.connect(Path(__file__).parent / "works.sqlite", timeout=120)
    rev = None
    if not args.dry_run:
        rev = db.next_rev(conn)
        conn.commit()  # no write lock held while the pictures are checked
    rows = conn.execute("""SELECT w.id, m.url FROM work w JOIN work_media m ON m.work_id=w.id
                           WHERE w.state='published' AND w.type='image' ORDER BY w.id""").fetchall()
    verdicts, upgraded = collections.Counter(), 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        first = list(pool.map(check, rows))
        retry = [r for r in rows if any(c[0] == r["id"] and c[3] == "fetch-failed" for c in first)]
        again = {c[0]: c for c in pool.map(check, retry)}  # a failed fetch may be a hiccup: one more try before retiring
        checked = [again.get(c[0], c) for c in first]
        for i, (wid, old, new, verdict) in enumerate(checked, 1):
            verdicts[verdict] += 1
            if not args.dry_run:
                if verdict == "yes" and new != old:
                    conn.execute("UPDATE work_media SET url=? WHERE work_id=?", (new, wid))
                    upgraded += 1
                elif verdict != "yes":
                    conn.execute("UPDATE work SET state='retired', rev=? WHERE id=?", (rev, wid))
            if i % 500 == 0:
                conn.commit()
                print(f"{i}/{len(rows)} {dict(verdicts)}", flush=True)
    conn.commit()
    print(f"checked {len(rows)}: {dict(verdicts)}; upgraded to https: {upgraded}")

if __name__ == "__main__":
    main()
