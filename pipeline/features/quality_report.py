"""Quality metrics for the lab (explore app): every published work's quality v2 score, the reasons behind it, and the lowest ones.
    python3 -m pipeline.features.quality_report [--train experiments/train] [--lowest 150]
Writes <train>/report/quality.json ({uid: {q, r, why, ls, bpp, sh}} for the pictures in the explorer) and
<train>/report/quality_summary.json (counts per reason and source, histograms of the raw score, the lowest works over the whole catalogue).
q = quality in the pack (1.0..1.4, rank inside source and type); r = the score before ranking (source score minus penalties)."""
import argparse, collections, json, sqlite3
from pathlib import Path
from .. import quality_v2, vocab

DB = Path(__file__).parents[1] / "works.sqlite"
BINS = 20  # histogram of the raw score, -0.6 .. 1.2

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="experiments/train")
    ap.add_argument("--lowest", type=int, default=150)
    args = ap.parse_args()
    out = Path(args.train) / "report"
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("""SELECT w.id, w.uid, w.source, w.type, w.quality, w.room, c.title, c.creator, c.institution, m.url, m.poster
        FROM work w JOIN work_card c ON c.work_id=w.id LEFT JOIN work_media m ON m.work_id=w.id WHERE w.state='published'""")]
    tags = collections.defaultdict(list)
    for wid, slug in conn.execute("SELECT wt.work_id, t.slug FROM work_tag wt JOIN tag t ON t.id=wt.tag_id ORDER BY t.id"):
        tags[wid].append(slug)
    tags = {wid: vocab.normalise(s) for wid, s in tags.items()}
    has = lambda t: conn.execute("SELECT 1 FROM sqlite_master WHERE name=?", (t,)).fetchone()
    colour = {wid: json.loads(f) for wid, f in conn.execute("SELECT work_id, features FROM work_colour")} if has("work_colour") else {}
    stats = {wid: json.loads(f) for wid, f in conn.execute("SELECT work_id, features FROM work_stats")} if has("work_stats") else {}
    pack = quality_v2.rescore(rows, tags, colour, stats)

    train = {json.loads(l)["uid"] for l in (Path(args.train) / "manifest.jsonl").read_text().splitlines() if l.strip()}
    per = {}
    for r in rows:
        why = quality_v2.penalties(tags.get(r["id"], ()), colour.get(r["id"]), stats.get(r["id"]))
        raw = quality_v2.refined((r["quality"] - 1) / 0.4, tags.get(r["id"], ()), colour.get(r["id"]), stats.get(r["id"]))
        st = stats.get(r["id"]) or {}
        per[r["id"]] = {"q": pack[r["id"]], "r": round(raw, 3), "why": why, "ls": st.get("longSide"), "bpp": st.get("bytesPerPixel"), "sh": st.get("sharp")}

    (out / "quality.json").write_text(json.dumps({r["uid"]: per[r["id"]] for r in rows if r["uid"] in train}, separators=(",", ":")))
    reasons = collections.Counter(k for p in per.values() for k in p["why"])
    hist = lambda items: [sum(1 for p in items if min(BINS - 1, max(0, int((p["r"] + 0.6) / 1.8 * BINS))) == b) for b in range(BINS)]
    by_source = collections.defaultdict(list)
    for r in rows:
        by_source[r["institution"]].append(per[r["id"]])
    sources = sorted(({"source": k, "works": len(v), "meanRaw": round(sum(p["r"] for p in v) / len(v), 3),
                       "penalised": round(sum(1 for p in v if p["why"]) / len(v), 3)} for k, v in by_source.items() if len(v) >= 50), key=lambda x: x["meanRaw"])
    lowest = sorted(rows, key=lambda r: (per[r["id"]]["r"], per[r["id"]]["q"]))[:args.lowest]
    summary = {
        "works": len(rows), "withStats": len(stats), "withColour": len(colour), "bins": {"from": -0.6, "to": 1.2, "n": BINS},
        "reasons": dict(reasons.most_common()), "histogram": hist(per.values()),
        "histogramByType": {t: hist([per[r["id"]] for r in rows if r["type"] == t]) for t in sorted({r["type"] for r in rows})},
        "sources": sources[:15],
        "lowest": [{"uid": r["uid"], "t": r["title"], "c": r["creator"], "inst": r["institution"], "type": r["type"], "url": r["url"] or r["poster"],
                    "local": r["uid"] in train, **per[r["id"]]} for r in lowest],
    }
    (out / "quality_summary.json").write_text(json.dumps(summary, ensure_ascii=False))
    print(f"{len(rows)} works; statistics for {len(stats)}; reasons {dict(reasons)}")
    print("lowest:", "; ".join(f"{(x['t'] or '')[:30]} ({x['r']}, {','.join(x['why'])})" for x in summary["lowest"][:5]))

if __name__ == "__main__":
    main()
