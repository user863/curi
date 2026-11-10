"""Content pipeline: pull -> rights gate -> score -> diversify -> data/catalog.json.
Usage (from the project root): python3 -m pipeline.run [--only met,gutenberg,prelinger-film,...]"""
import argparse, collections, json
from pathlib import Path
from . import db, embed, export, quality, secrets, state
from .sources import archive, cleveland, europeana, europeana_galleries, gutenberg, met, openverse, texts

ROOT = Path(__file__).resolve().parent.parent

def select(cands, take, max_per_group):
    """Best first, with a cap per group (department, author, decade...) so no single bucket dominates."""
    counts, out, seen = collections.Counter(), [], set()
    for c in sorted(cands, key=lambda c: c["_score"], reverse=True):
        if c["id"] in seen:  # the same item can be reachable through several queries
            continue
        seen.add(c["id"])
        if counts[c["_group"]] < max_per_group:
            counts[c["_group"]] += 1
            out.append(c)
        if len(out) == take:
            break
    return out

def finish(card, overrides):
    ed = card["editorial"]
    ed["quality"] = quality.weight(card["_score"])
    for k, v in overrides.get(card["id"], {}).items():
        ed[k] = v
        if k == "note":
            ed["noteSource"] = "curator"
    return {k: v for k, v in card.items() if not k.startswith("_")}

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", default="", help="comma-separated source names")
    ap.add_argument("--refresh", action="store_true", help="re-evaluate works the database already holds")
    ap.add_argument("--retire", action="store_true", help="with --refresh: retire works that no longer qualify")
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}
    cfg = json.loads((Path(__file__).parent / "config.json").read_text())
    overrides = json.loads((Path(__file__).parent / "overrides.json").read_text())["cards"]
    jobs = [("met", lambda s: met.run(cfg["met"], s), cfg["met"]),
            ("cleveland", lambda s: cleveland.run(cfg["cleveland"], s), cfg["cleveland"]),
            ("gutenberg", lambda s: gutenberg.run(cfg["gutenberg"], s), cfg["gutenberg"]),
            ("texts", lambda s: texts.run(cfg["texts"], s), cfg["texts"])]
    jobs += [(a["name"], (lambda a: lambda s: archive.run(a, s))(a), a) for a in cfg["archive"]]
    jobs += [(e["name"], (lambda e: lambda s: europeana.run(e, s))(e), e) for e in cfg["europeana"]]
    jobs += [("europeana-galleries", lambda s: europeana_galleries.run(cfg["europeana_galleries"], s), cfg["europeana_galleries"])]
    jobs += [("openverse", lambda s: openverse.run(cfg["openverse"], s), cfg["openverse"])]

    conn = db.connect(Path(__file__).parent / "works.sqlite")
    rev = db.next_rev(conn)
    conn.commit()
    if args.refresh:
        state.KNOWN.clear()
    else:
        state.load(conn)
    stats, report, added = {}, {}, []
    for name, run, c in jobs:
        if only and name not in only:
            continue
        try:
            cands = run(stats)
        except Exception as e:  # one failing source must not sink the run
            report[name] = {"error": secrets.redact(repr(e))}
            print(f"{name}: FAILED {secrets.redact(repr(e))}", flush=True)
            continue
        gated = [x for x in cands if x["rights"]["gate"] == "yes"]  # safety net: no adapter may bypass the gate
        if len(gated) != len(cands):
            stats.setdefault(name, {})["rights-gate"] = len(cands) - len(gated)
        fresh = [x for x in gated if state.dupe_key(x["title"], x["creator"]) not in state.KEYS]  # same work from another source
        if len(fresh) != len(gated):
            stats.setdefault(name, {})["duplicate"] = len(gated) - len(fresh)
        cards = [finish(x, overrides) for x in select(fresh, c["take"], c["max_per_group"])]
        for card in cards:
            db.upsert(conn, card, embed.embed(card), embed.MODEL, embed.DIM, rev)
        db.add_tags(conn, state.RETAG)
        state.RETAG.clear()
        conn.commit()  # checkpoint per source: a long run can be stopped and resumed
        state.KNOWN.update(card["id"] for card in cards)
        state.KEYS.update(state.dupe_key(card["title"], card["creator"]) for card in cards)
        added += cards
        report[name] = {"candidates": len(fresh), "added": len(cards), "rejected": stats.get(name, {})}
        print(f"{name}: {len(fresh)} new candidates -> {len(cards)} added; skipped/rejected {stats.get(name, {})}", flush=True)
    if args.refresh and args.retire and not only:
        db.retire_missing(conn, [c["id"] for c in added], rev)
        conn.commit()
    pack = export.write(conn, ROOT / "data" / "pack")
    print("pack:", pack)
    rows = conn.execute("SELECT type, room FROM work WHERE state='published'").fetchall()
    report["totals"] = {"published": len(rows), "addedThisRun": len(added),
                        "types": dict(collections.Counter(r["type"] for r in rows)),
                        "rooms": dict(collections.Counter(r["room"] for r in rows))}
    (ROOT / "data" / "pipeline-report.json").write_text(json.dumps(report, indent=1))
    print("totals:", report["totals"])

if __name__ == "__main__":
    main()
