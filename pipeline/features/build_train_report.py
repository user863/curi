"""Builds experiments/train/report/: every downloaded training image with colour features and JoyCaption tags (where
labelled yet), filters and search. Static; open through a server rooted at experiments/ (the `lab` server).
    python3 -m pipeline.features.build_train_report [--dir experiments/train]    -> <dir>/report/index.html, data.json, thumbs/
Re-run to pick up new labels; thumbnails are made once."""
import argparse, json
from multiprocessing import Pool
from pathlib import Path
from PIL import Image
from . import tags as fold

THUMB = 240

def thumb(job):
    src, dst = job
    if not Path(dst).exists():
        try:
            im = Image.open(src).convert("RGB")
            im.thumbnail((THUMB, THUMB))
            im.save(dst, quality=75)
        except Exception:
            return False
    return True

def lines(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    d = Path(ap.parse_args().dir)
    (d / "report" / "thumbs").mkdir(parents=True, exist_ok=True)
    rows = lines(d / "manifest.jsonl")
    colour = json.loads((d / "colour.json").read_text()) if (d / "colour.json").exists() else {}
    labels = {r["file"]: r for r in lines(d / "labels.jsonl")}
    student = d / "student1024"
    pred = json.loads((student / "pred.json").read_text()) if (student / "pred.json").exists() else {}
    held = set(json.loads((student / "metrics.json").read_text()).get("heldout_files", [])) if (student / "metrics.json").exists() else set()
    heads = fold.heads_of([l["tags"] for l in labels.values()])
    with Pool(2) as pool:
        ok = pool.map(thumb, [(str(d / r["file"]), str(d / "report" / "thumbs" / f"{r['uid']}.jpg")) for r in rows], chunksize=64)
    items = []
    for r, good in zip(rows, ok):
        if not good:
            continue
        c = colour.get(r["file"])
        l = labels.get(r["file"])
        st = pred.get(r["file"])
        teacher = {c for t in l["tags"] for c in fold.expand(t, heads)} if l else set()
        student_set = {t for t, _ in st} if st else set()
        items.append({"u": r["uid"], "t": r.get("title", ""), "c": r.get("creator", ""), "dt": r.get("date", ""), "src": r["source"],
                      "inst": r.get("institution", ""), "tags": r.get("tags", []), "url": r.get("sourceUrl", ""),
                      "pal": [[p["hex"], p["weight"]] for p in c["palette"]] if c else [], "hue": c["hue"] if c else None,
                      "mono": c["monochrome"] if c else None, "L": c["lightness"] if c else None, "ch": c["chroma"] if c else None,
                      "w": c["warmth"] if c else None, "jc": l["tags"][:20] if l else None,
                      "jm": [bool(fold.expand(t, heads) & student_set) for t in l["tags"][:20]] if l and st else None,
                      "st": st, "sm": [t in teacher for t, _ in st] if l and st else None,
                      "split": None if not l else ("held" if r["file"] in held else "train")})
    (d / "report" / "data.json").write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")))
    (d / "report" / "index.html").write_text((Path(__file__).parent / "train_report_template.html").read_text())
    print(f"{len(items)} items, {sum(1 for i in items if i['jc'])} labelled, {sum(1 for i in items if i['hue'])} with colour")

if __name__ == "__main__":
    main()
