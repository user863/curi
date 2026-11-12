"""Builds experiments/report/index.html: every sampled image with its colour features and tags, filters, sorting,
and "more like this" by SigLIP similarity. Static: open it through any web server rooted at <dir>.
    python3 -m pipeline.features.build_report [--dir experiments]"""
import argparse, base64, json
from pathlib import Path
import numpy as np
from PIL import Image

THUMB = 360

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments")
    d = Path(ap.parse_args().dir)
    meta = json.loads((d / "images.json").read_text())["images"]
    colour = json.loads((d / "colour.json").read_text())
    vision = json.loads((d / "vision.json").read_text()) if (d / "vision.json").exists() else {}
    sig = json.loads((d / "siglip_tags.json").read_text())
    joy = json.loads((d / "joycaption.json").read_text()) if (d / "joycaption.json").exists() else {}
    tune = json.loads((d / "tune.json").read_text()) if (d / "tune.json").exists() else None
    emb = np.load(d / "siglip_emb.npy").astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    (d / "report" / "thumbs").mkdir(parents=True, exist_ok=True)
    items = []
    for i, r in enumerate(meta):
        thumb = d / "report" / "thumbs" / f"{i}.jpg"
        if not thumb.exists():
            im = Image.open(d / r["file"]).convert("RGB")
            im.thumbnail((THUMB, THUMB))
            im.save(thumb, quality=80)
        c = colour[r["file"]]
        items.append({"i": i, "t": r["title"], "c": r["creator"], "dt": r["date"], "src": r["source"], "inst": r["institution"], "tags": r["tags"],
                      "pal": [[p["hex"], p["weight"]] for p in c["palette"]], "L": c["lightness"], "con": c["contrast"], "w": c["warmth"], "ch": c["chroma"],
                      "hue": c["hue"], "mono": c["monochrome"], "sig": sig["images"][r["file"]],
                      "jc": joy.get(r["file"], {}).get("booru", [])[:16], "av": [[x["label"], x["confidence"]] for x in vision.get(r["file"], [])[:5]], "url": r["sourceUrl"], "wh": [r["width"], r["height"]]})
    q = np.round(emb * 127).astype(np.int8)
    data = {"items": items, "emb": base64.b64encode(q.tobytes()).decode(), "dim": int(emb.shape[1]), "tune": tune, "model": sig["model"], "terms": sig["terms"], "joy": len(joy)}
    html = (Path(__file__).parent / "report_template.html").read_text().replace("/*DATA*/null", json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (d / "report" / "index.html").write_text(html)
    print(f"{len(items)} items, report at {d / 'report' / 'index.html'} ({len(html) // 1024} KB)")

if __name__ == "__main__":
    main()
