"""Records the Europeana gallery titles (from the cached sets API) next to their tag slugs, for the Discover hero cards.
    python3 -m pipeline.galleries
A work's gallery membership already sits in its tags (`gallery-<title>`, see sources/europeana_galleries.py)."""
from pathlib import Path
import sqlite3
from . import secrets
from .sources import europeana_galleries as eg

DB = Path(__file__).parent / "works.sqlite"

def main():
    key = secrets.get("EUROPEANA_API_KEY")
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS gallery(slug TEXT PRIMARY KEY, title TEXT NOT NULL, set_id TEXT)")
    rows = {eg.tag_of(title): (title, set_id) for set_id, title in eg.galleries(key)}
    conn.executemany("INSERT OR REPLACE INTO gallery VALUES(?,?,?)", [(s, t, i) for s, (t, i) in rows.items()])
    conn.commit()
    used = {r[0] for r in conn.execute("SELECT slug FROM tag WHERE slug LIKE 'gallery-%'")}
    print(f"{len(rows)} galleries, {len(used & set(rows))} of {len(used)} gallery tags matched")

if __name__ == "__main__":
    main()
