"""Points small pictures at larger copies the source serves: IIIF links sized small (Europeana) and the Met's originals.
    python3 -m pipeline.upgrade_images [--apply] [--below 800]
Looks at images whose measured long side (work_stats) is below --below; a new address replaces the old only when it passes
probe.image_ok. Without --apply it only reports. Writes the changed uids to experiments/stats/remeasure.json for
`stats_rest --uids`. Cleveland's larger file is 8 MB, over the phone budget, so it stays."""
import argparse, json, sqlite3
from pathlib import Path
from . import probe
from .http import get_json
from .sources import met

DB = Path(__file__).parent / "works.sqlite"
MET = "https://collectionapi.metmuseum.org/public/collection/v1/objects"

def candidate(uid, url):
    """The address to try instead of url, or None."""
    if uid.startswith("met-"):
        obj = get_json(f"{MET}/{uid[4:]}", delay=0.35)
        return met.best_image(obj)
    return probe.larger(url)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--below", type=int, default=800)
    ap.add_argument("--out", default="experiments/stats/remeasure.json")
    args = ap.parse_args()
    conn = sqlite3.connect(DB)
    rows = conn.execute("""SELECT w.id, w.uid, m.url, s.features FROM work w JOIN work_media m ON m.work_id=w.id
                           JOIN work_stats s ON s.work_id=w.id WHERE w.state='published' AND w.type='image'""").fetchall()
    small = [(i, u, url) for i, u, url, f in rows if json.loads(f)["longSide"] < args.below]
    changed, kept = [], 0
    for wid, uid, url in small:
        try:
            new = candidate(uid, url)
        except Exception:
            new = None
        if new and new != url and probe.image_ok(new) == "yes":
            changed.append((wid, uid, new))
        else:
            kept += 1
    print(f"{len(small)} small images: {len(changed)} have a larger copy, {kept} stay")
    if args.apply:
        conn.executemany("UPDATE work_media SET url=? WHERE work_id=?", [(new, wid) for wid, _, new in changed])
        conn.commit()
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps([u for _, u, _ in changed]))
        print(f"updated; uids in {args.out}")

if __name__ == "__main__":
    main()
