"""Stores each image's colour features (pipeline/features/palette.py) in the work database, table work_colour.
    python3 -m pipeline.apply_colour [--train experiments/train] [--catalog experiments/catalog]
Reads <train>/colour.json (keyed by file, mapped to uids by manifest.jsonl) and <catalog>/chunk_*.colour.json (keyed by uid).
Rows are replaced on rerun. Shipping them in the pack is a separate step (M1 shard columns)."""
import argparse, json, sqlite3
from pathlib import Path

DB = Path(__file__).parent / "works.sqlite"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="experiments/train")
    ap.add_argument("--catalog", default="experiments/catalog")
    args = ap.parse_args()
    train, catalog = Path(args.train), Path(args.catalog)
    files = {json.loads(l)["file"]: json.loads(l)["uid"] for l in (train / "manifest.jsonl").read_text().splitlines() if l.strip()}
    by_uid = {files[f]: v for f, v in json.loads((train / "colour.json").read_text()).items() if f in files}
    for f in sorted(catalog.glob("chunk_*.colour.json")):
        by_uid.update(json.loads(f.read_text()))
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS work_colour(work_id INTEGER PRIMARY KEY, features TEXT NOT NULL)")
    ids = dict(conn.execute("SELECT uid, id FROM work WHERE state='published' AND type='image'"))
    rows = [(ids[u], json.dumps(v, separators=(",", ":"))) for u, v in by_uid.items() if u in ids]
    conn.executemany("INSERT OR REPLACE INTO work_colour VALUES(?,?)", rows)
    conn.commit()
    total = len(ids)
    print(f"{len(rows)} of {total} images have colour features")

if __name__ == "__main__":
    main()
