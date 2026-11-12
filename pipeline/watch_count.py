"""Live count of published works, by source and type, from the database.
    python3 -m pipeline.watch_count [seconds]"""
import sqlite3, sys, time
from pathlib import Path

DB = Path(__file__).parent / "works.sqlite"
TARGET = 150_000

def snapshot():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    total = conn.execute("SELECT COUNT(*) FROM work WHERE state='published'").fetchone()[0]
    by = conn.execute("SELECT source, type, COUNT(*) FROM work WHERE state='published' GROUP BY 1,2 ORDER BY 3 DESC").fetchall()
    conn.close()
    return total, by

def main(every):
    start, t0 = None, time.time()
    while True:
        total, by = snapshot()
        start = total if start is None else start
        rate = (total - start) / max(1, time.time() - t0) * 60
        parts = "  ".join(f"{s}/{t} {n}" for s, t, n in by[:8])
        print(f"{time.strftime('%H:%M:%S')}  {total:>7} / {TARGET}  ({total / TARGET:5.1%})  +{total - start}  {rate:5.0f}/min   {parts}", flush=True)
        time.sleep(every)

if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 5)
