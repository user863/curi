"""Exports the client pack, sharded by cluster and addressed by content hash.
The client downloads the manifest and the cluster directory (centroids), then only the clusters it needs:
per cluster an index shard (typed arrays), a card shard (display fields) and a detail shard (rights, spec rows).
Shard names contain a content hash, so they are immutable and cacheable, and an update changes only the
shards whose works changed."""
import collections, hashlib, json, math, re, shutil, struct, unicodedata
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from . import cluster
from .categories import CATEGORIES
from .embed import DIM, MODEL, to_int8

def digest(data):
    return hashlib.sha1(data).hexdigest()[:10]

def put(out, folder, stem, ext, data):
    """Write a content-addressed file; returns the hash used in its name."""
    h = digest(data)
    (out / folder / f"{stem}.{h}.{ext}").write_bytes(data)
    return h

# Word index for the app's search: word -> {cluster: [ids]}, in files named by the word's first two letters, so a query
# fetches only the few files its words start with. js/search.js must tokenise exactly like this.
STOP = {"the", "and", "of", "de", "la", "le", "les", "el", "del", "der", "die", "das", "den", "het", "een", "van", "von", "und",
        "des", "du", "et", "en", "in", "on", "at", "to", "for", "with", "by", "from", "an", "is", "are", "was", "his", "her", "its"}
MAX_DF = 3000  # a word on more works than this narrows nothing
NOTE_WORDS = 25

def words(text):
    folded = "".join(c for c in unicodedata.normalize("NFKD", (text or "").lower()) if not unicodedata.combining(c))
    return [w for w in re.findall(r"[a-z0-9]+", folded) if len(w) >= 2 and w not in STOP]

def write_search(out, rows, tags, labels):
    postings = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        found = set(words(f"{r['title']} {r['creator']} {r['institution']} {labels.get(r['room'], '')} {r['date_label']} {' '.join(tags[r['id']])}"))
        found.update(words(r["note"])[:NOTE_WORDS])
        for w in found:
            postings[w][r["cluster"]].append(r["id"])
    shards = collections.defaultdict(dict)
    for w, by in postings.items():
        if sum(map(len, by.values())) <= MAX_DF:
            shards[w[:2]][w] = {str(c): ids for c, ids in by.items()}
    return {k: put(out, "search", k, "json", json.dumps(v, separators=(",", ":")).encode()) for k, v in sorted(shards.items())}

def card_of(r, tags, media, text):
    card = {
        "n": r["id"], "cl": r["cluster"], "id": r["uid"], "type": r["type"], "cat": r["category"], "title": r["title"],
        "creator": r["creator"], "date": r["date_label"],
        "source": {"institution": r["institution"], "work": r["work_title"], "url": r["source_url"]},
        "rights": {"license": r["license"]},
        "editorial": {"note": r["note"], "noteSource": r["note_source"], "room": r["room"], "tags": tags,
                      "tone": r["tone"], "quality": r["quality"]},
    }
    if r["swatch"]:
        card["sw"] = r["swatch"]
    if media:
        card["media"] = {"kind": media["kind"], "url": media["url"], "fallback": media["fallback"],
                         "poster": media["poster"], "start": media["start_s"], "end": media["end_s"],
                         "duration": media["duration_s"]}
    if text:
        card["text"] = {"body": text["body"], "verse": bool(text["verse"])}
    return card

def detail_of(r, media):
    d = {"source": {"collection": r["collection"], "sourceId": r["source_id"], "fetchedAt": r["fetched_at"]},
         "rights": {"jurisdictions": r["jurisdictions"], "derivativesOk": r["derivatives_ok"],
                    "verifiedBy": r["verified_by"], "attribution": r["attribution"], "creditLine": r["credit_line"],
                    "licenseUrl": r["license_url"],
                    "gate": r["gate"]}}
    if media and media["kind"] == "image":
        d["media"] = {"medium": media["medium"], "dimensions": media["dimensions"], "culture": media["culture"]}
    return d

NOBODY = re.compile(r"^(|unknown.*|anonymous.*|anonym.*|unidentified.*|unbekannt.*|desconegut|okänd|various.*)$")
NO_CREATOR = 0xFFFF

def creator_key(name):
    key = (name or "").strip().lower()
    return None if NOBODY.match(key) else key

def index_shard(rows, cat_ids, room_order, source_ids, creator_ids):
    """[count u32][ids u32*n][cat u8*n][room u8*n][quality u8*n][source u8*n][pad to 2][creator u16*n][pad to 4][emb i8*n*DIM]
    source: institution id (manifest order); creator: id of the normalised name, 0xFFFF when unknown."""
    n = len(rows)
    body = struct.pack(f"<{n}I", *(r["id"] for r in rows))
    body += bytes(cat_ids.index(r["category"]) for r in rows)
    body += bytes(room_order.index(r["room"]) for r in rows)
    body += bytes(max(0, min(255, round((r["quality"] - 1) * 250))) for r in rows)  # decode: 1 + v/250
    body += bytes(source_ids[r["institution"]] for r in rows)
    body += b"\0" * (-len(body) % 2)
    body += struct.pack(f"<{n}H", *(creator_ids.get(creator_key(r["creator"]), NO_CREATOR) for r in rows))
    body += b"\0" * (-len(body) % 4)
    return struct.pack("<I", n) + body + b"".join(r["vec"] for r in rows)

def write(conn, out_dir):
    clustering = cluster.ensure(conn)
    conn.commit()
    out = Path(out_dir)
    if out.exists():
        shutil.rmtree(out)
    for d in ("idx", "cards", "detail", "search"):
        (out / d).mkdir(parents=True)
    rows = conn.execute("""
        SELECT w.*, c.title, c.creator, c.date_label, c.note, c.note_source, c.institution, c.work_title, c.source_url,
               r.license, r.jurisdictions, r.derivatives_ok, r.verified_by, r.gate, r.attribution, r.credit_line, r.license_url,
               s.source_id, s.collection, s.fetched_at, e.vec
        FROM work w JOIN work_card c ON c.work_id=w.id JOIN work_rights r ON r.work_id=w.id
             JOIN work_source s ON s.work_id=w.id JOIN work_embedding e ON e.work_id=w.id
        WHERE w.state='published' ORDER BY w.id""").fetchall()
    media = {m["work_id"]: m for m in conn.execute("SELECT * FROM work_media")}
    text = {t["work_id"]: t for t in conn.execute("SELECT * FROM work_text")}
    tags = collections.defaultdict(list)
    for t in conn.execute("SELECT wt.work_id, t.slug FROM work_tag wt JOIN tag t ON t.id=wt.tag_id ORDER BY t.id"):
        tags[t["work_id"]].append(t["slug"])
    labels = json.loads((Path(__file__).parent / "rooms.json").read_text())
    present = {r["room"] for r in rows}
    room_order = [r for r in labels if r in present]  # display order from rooms.json
    cat_ids = [c["id"] for c in CATEGORIES]
    sources = sorted({r["institution"] for r in rows})
    assert len(sources) <= 256, "source id no longer fits a byte"
    source_ids = {name: i for i, name in enumerate(sources)}
    creators = sorted({k for k in (creator_key(r["creator"]) for r in rows) if k})
    assert len(creators) < NO_CREATOR, "creator id no longer fits two bytes"
    creator_ids = {name: i for i, name in enumerate(creators)}

    by_cluster = collections.defaultdict(list)
    for r in rows:
        by_cluster[r["cluster"]].append(r)
    cent_rows = {c["id"]: c["centroid"] for c in conn.execute("SELECT id, centroid FROM cluster")}
    cl_ids = sorted(by_cluster)
    shards = {"idx": [], "cards": [], "detail": []}
    counts, mean_quality, sizes = [], [], []
    for cl in cl_ids:
        members = by_cluster[cl]
        shards["idx"].append(put(out, "idx", cl, "bin", index_shard(members, cat_ids, room_order, source_ids, creator_ids)))
        card_json = {r["id"]: card_of(r, tags[r["id"]], media.get(r["id"]), text.get(r["id"])) for r in members}
        detail_json = {r["id"]: detail_of(r, media.get(r["id"])) for r in members}
        dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":")).encode()
        shards["cards"].append(put(out, "cards", cl, "json", dump(card_json)))
        shards["detail"].append(put(out, "detail", cl, "json", dump(detail_json)))
        tally = collections.Counter(r["category"] for r in members)
        counts.append([tally.get(c, 0) for c in cat_ids])
        mean_quality.append(round(sum(max(0, min(255, round((r["quality"] - 1) * 250))) for r in members) / len(members)))
        sizes.append(len(members))
    # Tag vocabulary and postings for the client's filter: tag -> {cluster: [ids]}. Tags on a single work are no use as a filter.
    postings = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        for slug in tags[r["id"]]:
            postings[slug][r["cluster"]].append(r["id"])
    postings = {s: {str(c): ids for c, ids in by.items()} for s, by in postings.items() if sum(map(len, by.values())) >= 2}
    tags_hash = put(out, ".", "tags", "json", json.dumps(postings, ensure_ascii=False, separators=(",", ":")).encode())
    search_hashes = write_search(out, rows, tags, labels)
    cent_bytes = b"".join(cent_rows[cl] for cl in cl_ids)
    cent_hash = put(out, ".", "centroids", "i8", cent_bytes)

    # Room metadata for onboarding and for seeding interests.
    centroids, cats_by_room, samples = {}, {}, {}
    for room_id in room_order:
        members = [r for r in rows if r["room"] == room_id]
        acc = np.sum([np.array(to_int8(r["vec"]), dtype=np.float64) for r in members], axis=0)
        acc = acc / (np.linalg.norm(acc) or 1)
        centroids[room_id] = [int(round(x * 127)) for x in acc]
        tally = collections.Counter(r["category"] for r in members)
        cats_by_room[room_id] = {c: round(v / len(members), 3) for c, v in tally.items()}
        best = max(members, key=lambda r: r["quality"])
        m = media.get(best["id"])
        body = text.get(best["id"])
        samples[room_id] = {  # enough to draw the onboarding tile without fetching a shard
            "type": best["type"], "tone": best["tone"],
            "image": (m["url"] if best["type"] == "image" else m["poster"]) if m else None,
            "text": body["body"].split("\n")[0][:90] if body else None}
    tombstones = [r["id"] for r in conn.execute("SELECT id FROM work WHERE state='taken_down'")]
    rev = int(conn.execute("SELECT value FROM meta WHERE key='rev'").fetchone()["value"])
    manifest = {
        "rev": rev, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(rows), "dim": DIM, "model": MODEL, "idxVersion": 2,
        "clusters": {"ids": cl_ids, "centroids": f"centroids.{cent_hash}.i8", "idx": shards["idx"],
                     "cards": shards["cards"], "detail": shards["detail"], "counts": counts,
                     "quality": mean_quality, "sizes": sizes},
        "tags": f"tags.{tags_hash}.json", "search": search_hashes, "categories": CATEGORIES, "roomOrder": room_order,
        "rooms": {r: labels[r] for r in room_order}, "roomCategories": cats_by_room,
        "roomCentroids": centroids, "roomSamples": samples, "tombstones": tombstones,
    }
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode()
    (out / "manifest.json").write_bytes(manifest_bytes)
    files = [p for p in out.rglob("*") if p.is_file()]
    idx_total = sum(p.stat().st_size for p in (out / "idx").iterdir())
    return {"works": len(rows), "rev": rev, "clusters": len(cl_ids), "clustering": clustering,
            "bytes": sum(p.stat().st_size for p in files), "indexBytes": idx_total,
            "firstLoadBytes": len(manifest_bytes) + len(cent_bytes)}
