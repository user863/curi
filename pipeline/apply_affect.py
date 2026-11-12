"""Stores mood tags, valence and energy (pipeline/features/calibrate.py) in the work database.
    python3 -m pipeline.apply_affect [--file experiments/affect/affect.json]
Table work_affect(work_id, valence, energy), both 1..255. Mood terms become work_tag rows, also listed in work_tag_model
so apply_tags.py replaces them; run this after apply_tags.py. Rows are replaced on rerun."""
import argparse, json, sqlite3
from pathlib import Path

DB = Path(__file__).parent / "works.sqlite"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="experiments/affect/affect.json")
    by_uid = json.loads(Path(ap.parse_args().file).read_text())
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS work_affect(work_id INTEGER PRIMARY KEY, valence INTEGER NOT NULL, energy INTEGER NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS work_tag_model(work_id INTEGER, tag_id INTEGER, PRIMARY KEY(work_id, tag_id))")
    ids = dict(conn.execute("SELECT uid, id FROM work WHERE state='published'"))
    rows = [(ids[u], a["valence"], a["energy"]) for u, a in by_uid.items() if u in ids]
    conn.executemany("INSERT OR REPLACE INTO work_affect VALUES(?,?,?)", rows)
    moods = sorted({t for a in by_uid.values() for t in a["mood"]})
    conn.executemany("INSERT OR IGNORE INTO tag(slug) VALUES(?)", [(t,) for t in moods])
    tag = dict(conn.execute("SELECT slug, id FROM tag WHERE slug IN (%s)" % ",".join("?" * len(moods)), moods)) if moods else {}
    pairs = [(ids[u], tag[t]) for u, a in by_uid.items() if u in ids for t in a["mood"]]
    conn.executemany("INSERT OR IGNORE INTO work_tag VALUES(?,?)", pairs)
    conn.executemany("INSERT OR IGNORE INTO work_tag_model VALUES(?,?)", pairs)
    conn.commit()
    print(f"{len(rows)} works with valence and energy; {len(pairs)} mood tags ({', '.join(moods)})")

if __name__ == "__main__":
    main()
