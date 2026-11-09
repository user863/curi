"""Run state shared with the adapters: what the database already holds.
Adapters skip known works before probing them, so every run only pays for new content and,
because candidates are ranked best first, each run reaches deeper into the sources."""
import re

KNOWN = set()  # uids
KEYS = set()   # normalised (title, creator), to catch the same work arriving from two sources
TAGS = []      # most common subject tags in the catalogue, used as search terms

def dupe_key(title, creator):
    return (re.sub(r"\W+", "", (title or "").lower())[:60], re.sub(r"\W+", "", (creator or "").lower())[:30])

def load(conn):
    KNOWN.clear(); KEYS.clear(); TAGS.clear()
    KNOWN.update(r["uid"] for r in conn.execute("SELECT uid FROM work"))
    KEYS.update(dupe_key(r["title"], r["creator"]) for r in conn.execute("SELECT title, creator FROM work_card"))
    rows = conn.execute("""SELECT t.slug, COUNT(*) n FROM work_tag wt JOIN tag t ON t.id=wt.tag_id
                           GROUP BY t.slug ORDER BY n DESC LIMIT 200""").fetchall()
    TAGS.extend(r["slug"].replace("-", " ") for r in rows if len(r["slug"]) > 3 and not re.search(r"\d", r["slug"]))

def is_known(uid):
    return uid in KNOWN
