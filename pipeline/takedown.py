"""Take a work down: python3 -m pipeline.takedown <uid> [<uid> ...]
Marks it taken_down and re-exports. Clients block tombstoned ids on next manifest load."""
import sys
from pathlib import Path
from . import db, export

ROOT = Path(__file__).resolve().parent.parent

def main():
    conn = db.connect(Path(__file__).parent / "works.sqlite")
    rev = db.next_rev(conn)
    for uid in sys.argv[1:]:
        print(uid, "taken down" if db.take_down(conn, uid, rev) else "not found")
    conn.commit()
    print(export.write(conn, ROOT / "data" / "pack"))

if __name__ == "__main__":
    main()
