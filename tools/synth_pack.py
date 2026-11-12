"""Synthetic catalogue for scale tests: python3 tools/synth_pack.py N OUT_DIR DB_PATH
Runs the real DB, embedding, clustering and export code on N fake works with topic structure."""
import random, sqlite3, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db, embed, export, quality

N, OUT, DBP = int(sys.argv[1]), sys.argv[2], sys.argv[3]
rng = random.Random(11)
TYPES = [("image", 0.4), ("passage", 0.25), ("video", 0.2), ("audio", 0.15)]
ROOMS = ["landscapes", "people", "interiors", "drawings", "deep-time", "words", "film", "sound"]
vocab = [f"tag{i}" for i in range(1500)]
topics = [rng.sample(vocab, 6) for _ in range(300)]
if Path(DBP).exists():
    Path(DBP).unlink()
conn = db.connect(DBP)
rev = db.next_rev(conn)
t0 = time.time()
for i in range(N):
    kind = rng.choices([t for t, _ in TYPES], [w for _, w in TYPES])[0]
    topic = rng.choice(topics)
    tags = rng.sample(topic, 3) + [rng.choice(vocab)]
    q = quality.weight(rng.random() ** 1.5)
    card = {"id": f"syn-{i}", "type": kind, "title": f"Work {i}", "creator": "Someone", "date": "1900",
            "source": {"institution": "Synthetic", "url": f"https://example.org/{i}", "sourceId": str(i), "fetchedAt": "2026-11-09", "work": f"Work {i}"},
            "rights": {"license": "CC0", "jurisdictions": "worldwide", "derivativesOk": "yes", "verifiedBy": "unknown", "attribution": "x", "gate": "yes"},
            "editorial": {"note": "A short description of the work in the source's own words.", "noteSource": "source",
                          "room": rng.choice(ROOMS), "tags": tags, "tone": "paper", "quality": q}}
    if kind == "passage":
        card["text"] = {"body": "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 12, "verse": False}
    elif kind == "image":
        card["media"] = {"kind": "image", "url": f"https://example.org/{i}.jpg", "medium": "Oil", "dimensions": "10 x 10", "culture": ""}
    else:
        card["media"] = {"kind": kind, "url": f"https://example.org/{i}.mp4", "fallback": None, "poster": f"https://example.org/{i}.jpg", "start": 30, "end": 75, "duration": 600}
    db.upsert(conn, card, embed.embed(card), embed.MODEL, embed.DIM, rev)
    if i % 10000 == 0:
        print(i, f"{time.time() - t0:.0f}s", flush=True)
conn.commit()
print("export:", export.write(conn, OUT))
