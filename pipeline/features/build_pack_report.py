"""Data for the explorer's pack view: every published picture with colour features, placed by the colour layout (make_layout.R).
    python3 -m pipeline.features.build_pack_report [--out experiments/pack]
Writes <out>/colour.json ({uid.jpg: features}, the input of make_layout.R) and <out>/data.json (one row per picture).
Then: Rscript pipeline/features/explore/make_layout.R experiments/pack
Pictures are not stored here: each row carries the source address, and a smaller variant where the source sizes on request."""
import argparse, json, re, sqlite3
from pathlib import Path

DB = Path(__file__).parents[1] / "works.sqlite"
SIZES = [(re.compile(r"(/full/!)\d+,\d+(/0/default\.jpg)$"), r"\g<1>256,256\2"),  # IIIF
         (re.compile(r"dimension=\d+x\d+"), "dimension=300x300"),  # DigitaltMuseum
         (re.compile(r"(/commons/thumb/.+/)\d+px-"), r"\g<1>330px-"),  # Commons standard width
         (re.compile(r"=w\d+(-h\d+)?(-[a-z]+)*$"), "=w300")]  # Google image proxies

def thumb(url):
    for rx, to in SIZES:
        if rx.search(url or ""):
            return rx.sub(to, url)
    return url

def colours(train, catalog):
    out = {}
    out.update({Path(f).stem: v for f, v in json.loads((train / "colour.json").read_text()).items()})
    for f in sorted(catalog.glob("chunk_*.colour.json")):
        out.update(json.loads(f.read_text()))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="experiments/pack")
    ap.add_argument("--train", default="experiments/train")
    ap.add_argument("--catalog", default="experiments/catalog")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "explore").mkdir(parents=True, exist_ok=True)
    col = colours(Path(args.train), Path(args.catalog))
    conn = sqlite3.connect(DB)
    rows = conn.execute("""SELECT w.uid, c.title, c.creator, c.date_label, c.institution, c.source_url, m.url, w.source,
        (SELECT group_concat(t.slug, ',') FROM work_tag wt JOIN tag t ON t.id = wt.tag_id WHERE wt.work_id = w.id)
        FROM work w JOIN work_card c ON c.work_id = w.id JOIN work_media m ON m.work_id = w.id
        WHERE w.state = 'published' AND w.type = 'image' AND m.url IS NOT NULL AND m.url NOT LIKE 'https://www.artic.edu/%'  -- native-app-only host""").fetchall()
    data, keep = [], {}
    for uid, title, creator, date, inst, link, url, src, tags in rows:
        f = col.get(uid)
        if not f:
            continue
        keep[uid + ".jpg"] = f
        data.append({"u": uid, "t": title, "c": creator, "dt": date, "inst": inst, "url": link, "src": src, "img": url, "th": thumb(url),
                     "tags": (tags or "").split(","), "pal": [[p["hex"], p["weight"]] for p in f["palette"]], "hue": f["hue"],
                     "mono": f["monochrome"], "L": f["lightness"], "ch": f["chroma"], "w": f["warmth"]})
    (out / "colour.json").write_text(json.dumps(keep))
    (out / "data.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(data)} of {len(rows)} published pictures have colour features -> {out}")

if __name__ == "__main__":
    main()
