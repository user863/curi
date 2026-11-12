"""Writes the image tagger's tags into the work database, replacing the tags a previous run added.
    python3 -m pipeline.apply_tags [--train experiments/train] [--catalog experiments/catalog]
Reads <train>/ens/pred.json (keyed by file, mapped to uids by <train>/manifest.jsonl) and <catalog>/pred.json (keyed by uid).
Tags a work already had from its source are left alone; the ones added here are listed in work_tag_model so a rerun can replace them.
Terms below --min-precision on the held-out set are not applied. Then run apply_affect.py, then re-export the pack: python3 -m pipeline.run --only none"""
import argparse, json, re, sqlite3
from pathlib import Path

DB = Path(__file__).parent / "works.sqlite"

def slug(tag):
    return re.sub(r"[^a-z0-9]+", "-", tag.lower()).strip("-")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="experiments/train")
    ap.add_argument("--catalog", default="experiments/catalog")
    ap.add_argument("--min-precision", type=float, default=0.4, help="held-out precision a term needs (train/ens/terms.json from term_report.py); 0 keeps all")
    args = ap.parse_args()
    train, catalog = Path(args.train), Path(args.catalog)
    by_uid = {}
    files = {json.loads(l)["file"]: json.loads(l)["uid"] for l in (train / "manifest.jsonl").read_text().splitlines() if l.strip()}
    for f, tags in json.loads((train / "ens" / "pred.json").read_text()).items():
        if f in files:
            by_uid[files[f]] = tags
    if (catalog / "pred.json").exists():
        by_uid.update(json.loads((catalog / "pred.json").read_text()))
    terms = json.loads((train / "ens" / "terms.json").read_text()) if args.min_precision else {}
    allowed = {t for t, m in terms.items() if m["precision"] >= args.min_precision}
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS work_tag_model(work_id INTEGER, tag_id INTEGER, PRIMARY KEY(work_id, tag_id))")
    conn.execute("DELETE FROM work_tag WHERE (work_id, tag_id) IN (SELECT work_id, tag_id FROM work_tag_model)")
    conn.execute("DELETE FROM work_tag_model")
    ids = {r["uid"]: r["id"] for r in conn.execute("SELECT uid, id FROM work WHERE state='published' AND type='image'")}
    added = dropped = 0
    for uid, tags in by_uid.items():
        if uid not in ids:
            continue
        for tag, _p in tags:
            if args.min_precision and tag not in allowed:
                dropped += 1
                continue
            conn.execute("INSERT OR IGNORE INTO tag(slug) VALUES(?)", (slug(tag),))
            tid = conn.execute("SELECT id FROM tag WHERE slug=?", (slug(tag),)).fetchone()["id"]
            if conn.execute("INSERT OR IGNORE INTO work_tag VALUES(?,?)", (ids[uid], tid)).rowcount:
                conn.execute("INSERT INTO work_tag_model VALUES(?,?)", (ids[uid], tid))
                added += 1
    conn.commit()
    print(f"{len(by_uid)} works tagged, {added} tags added, {dropped} dropped below precision {args.min_precision} ({len(allowed)} terms kept)" if args.min_precision else f"{len(by_uid)} works tagged, {added} tags added")

if __name__ == "__main__":
    main()
