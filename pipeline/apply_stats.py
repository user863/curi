"""Stores the technical image statistics (pipeline/imagestats.py) in the work database, table work_stats.
    python3 -m pipeline.apply_stats [--dirs experiments/stats experiments/catalog]
Reads chunk_*.stats.json (keyed by uid) from each directory. Rows are replaced on rerun."""
import argparse, json, sqlite3
from pathlib import Path

DB = Path(__file__).parent / "works.sqlite"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dirs", nargs="*", default=["experiments/stats", "experiments/catalog"])
    args = ap.parse_args()
    by_uid = {}
    for d in args.dirs:
        for f in sorted(Path(d).glob("chunk_*.stats.json")):
            by_uid.update(json.loads(f.read_text()))
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS work_stats(work_id INTEGER PRIMARY KEY, features TEXT NOT NULL)")
    ids = dict(conn.execute("SELECT uid, id FROM work WHERE state='published' AND type='image'"))
    rows = [(ids[u], json.dumps(v, separators=(",", ":"))) for u, v in by_uid.items() if u in ids]
    conn.executemany("INSERT OR REPLACE INTO work_stats VALUES(?,?)", rows)
    conn.commit()
    print(f"{len(rows)} of {len(ids)} images have statistics")

if __name__ == "__main__":
    main()
