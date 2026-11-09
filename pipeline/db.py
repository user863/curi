"""Build-time database (SQLite; same schema ports to Postgres + pgvector).
Dense integer ids are assigned once and never reused, so client-side bitsets stay valid across runs."""
import sqlite3
from .categories import CATEGORY_OF_TYPE

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS work(
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, room TEXT NOT NULL,
  quality REAL NOT NULL, tone TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'published',  -- published | retired | taken_down
  rev INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS work_state ON work(state, category);
CREATE TABLE IF NOT EXISTS work_card(
  work_id INTEGER PRIMARY KEY REFERENCES work(id), title TEXT, creator TEXT, date_label TEXT,
  note TEXT, note_source TEXT, institution TEXT, work_title TEXT, source_url TEXT);
CREATE TABLE IF NOT EXISTS work_media(
  work_id INTEGER PRIMARY KEY REFERENCES work(id), kind TEXT, url TEXT, fallback TEXT, poster TEXT,
  start_s REAL, end_s REAL, duration_s REAL, medium TEXT, dimensions TEXT, culture TEXT);
CREATE TABLE IF NOT EXISTS work_text(work_id INTEGER PRIMARY KEY REFERENCES work(id), body TEXT, verse INTEGER);
CREATE TABLE IF NOT EXISTS work_rights(
  work_id INTEGER PRIMARY KEY REFERENCES work(id), license TEXT, jurisdictions TEXT,
  derivatives_ok TEXT CHECK (derivatives_ok IN ('yes','no','unknown')),
  verified_by TEXT, gate TEXT CHECK (gate IN ('yes','no','unknown')), attribution TEXT, credit_line TEXT);
CREATE TABLE IF NOT EXISTS work_source(
  work_id INTEGER PRIMARY KEY REFERENCES work(id), source_id TEXT, collection TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS cluster(id INTEGER PRIMARY KEY, centroid BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS tag(id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS work_tag(work_id INTEGER REFERENCES work(id), tag_id INTEGER REFERENCES tag(id), PRIMARY KEY(work_id, tag_id));
CREATE TABLE IF NOT EXISTS work_embedding(work_id INTEGER PRIMARY KEY REFERENCES work(id), model TEXT, dim INTEGER, vec BLOB);
"""

def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    if "cluster" not in [r["name"] for r in conn.execute("PRAGMA table_info(work)")]:
        conn.execute("ALTER TABLE work ADD COLUMN cluster INTEGER")
    if "license_url" not in [r["name"] for r in conn.execute("PRAGMA table_info(work_rights)")]:
        conn.execute("ALTER TABLE work_rights ADD COLUMN license_url TEXT")
    return conn

def next_rev(conn):
    row = conn.execute("SELECT value FROM meta WHERE key='rev'").fetchone()
    rev = int(row["value"]) + 1 if row else 1
    conn.execute("INSERT OR REPLACE INTO meta VALUES('rev', ?)", (str(rev),))
    return rev

def upsert(conn, card, vec, model, dim, rev):
    ed, src, rights = card["editorial"], card["source"], card["rights"]
    row = conn.execute("SELECT id FROM work WHERE uid=?", (card["id"],)).fetchone()
    values = (card["id"].split("-")[0], card["type"], CATEGORY_OF_TYPE[card["type"]], ed["room"], ed["quality"], ed["tone"], rev)
    if row:
        wid = row["id"]
        # A takedown is permanent: re-ingesting a work never republishes it.
        conn.execute("UPDATE work SET source=?, type=?, category=?, room=?, quality=?, tone=?, rev=?, "
                     "state=CASE WHEN state='taken_down' THEN 'taken_down' ELSE 'published' END WHERE id=?", values + (wid,))
    else:
        wid = conn.execute("INSERT INTO work(source,type,category,room,quality,tone,rev,uid) VALUES(?,?,?,?,?,?,?,?)", values + (card["id"],)).lastrowid
    m = card.get("media") or {}
    conn.execute("INSERT OR REPLACE INTO work_card VALUES(?,?,?,?,?,?,?,?,?)",
                 (wid, card["title"], card["creator"], card["date"], ed["note"], ed["noteSource"],
                  src["institution"], src.get("work"), src["url"]))
    if m:
        conn.execute("INSERT OR REPLACE INTO work_media VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (wid, m["kind"], m["url"], m.get("fallback"), m.get("poster"), m.get("start"), m.get("end"),
                      m.get("duration"), m.get("medium"), m.get("dimensions"), m.get("culture")))
    if "text" in card:
        conn.execute("INSERT OR REPLACE INTO work_text VALUES(?,?,?)", (wid, card["text"]["body"], int(card["text"]["verse"])))
    conn.execute("INSERT OR REPLACE INTO work_rights(work_id, license, jurisdictions, derivatives_ok, verified_by, gate, attribution, credit_line, license_url) VALUES(?,?,?,?,?,?,?,?,?)",
                 (wid, rights["license"], rights["jurisdictions"], rights["derivativesOk"], rights["verifiedBy"],
                  rights["gate"], rights["attribution"], rights.get("creditLine"), rights.get("licenseUrl")))
    conn.execute("INSERT OR REPLACE INTO work_source VALUES(?,?,?,?)",
                 (wid, src["sourceId"], src.get("collection"), src["fetchedAt"]))
    conn.execute("DELETE FROM work_tag WHERE work_id=?", (wid,))
    for slug in dict.fromkeys(ed["tags"]):
        conn.execute("INSERT OR IGNORE INTO tag(slug) VALUES(?)", (slug,))
        tid = conn.execute("SELECT id FROM tag WHERE slug=?", (slug,)).fetchone()["id"]
        conn.execute("INSERT OR IGNORE INTO work_tag VALUES(?,?)", (wid, tid))
    conn.execute("INSERT OR REPLACE INTO work_embedding VALUES(?,?,?,?)", (wid, model, dim, vec))
    return wid

def retire_missing(conn, live_uids, rev):
    """Works that dropped out of a full run stay in the database (ids are never reused) but leave the packs."""
    marks = ",".join("?" * len(live_uids))
    conn.execute(f"UPDATE work SET state='retired', rev=? WHERE state='published' AND uid NOT IN ({marks})", (rev, *live_uids))

def take_down(conn, uid, rev):
    cur = conn.execute("UPDATE work SET state='taken_down', rev=? WHERE uid=?", (rev, uid))
    return cur.rowcount
