"""Colour features from the picture itself (PIL + numpy): palette in OKLab and a few scalars.
    python3 -m pipeline.features.palette [--dir experiments]   -> <dir>/colour.json
Pure functions below; main() runs them over <dir>/images.json."""
import argparse, io, json, math
from pathlib import Path
import numpy as np
from PIL import Image

SIZE = 64          # long side after downscale
TRIM_STD = 5.0     # an edge line with less spread than this (0-255) is border, mount or scan background
TRIM_MAX = 0.2     # trim at most this share from each side
K = 5
ORANGE = math.radians(55)  # warm direction in the a-b plane
HUES = ["red", "orange", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "magenta", "pink"]

def load(data):
    img = Image.open(io.BytesIO(data) if isinstance(data, bytes) else data)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    img = img.convert("RGB")
    img.thumbnail((SIZE, SIZE), Image.LANCZOS)
    return np.asarray(img, dtype=np.float64)  # h x w x 3, 0-255

def trim(px):
    """Cut uniform borders (frames, mounts, scan backgrounds) so they do not become the dominant colour."""
    h, w, _ = px.shape
    top, bottom, left, right = 0, h, 0, w
    lim_h, lim_w = int(h * TRIM_MAX), int(w * TRIM_MAX)
    flat = lambda line: line.reshape(-1, 3).std(axis=0).max() < TRIM_STD
    while top < lim_h and flat(px[top, left:right]): top += 1
    while h - bottom < lim_h and flat(px[bottom - 1, left:right]): bottom -= 1
    while left < lim_w and flat(px[top:bottom, left]): left += 1
    while w - right < lim_w and flat(px[top:bottom, right - 1]): right -= 1
    return px[top:bottom, left:right]

def to_oklab(px):
    c = px.reshape(-1, 3) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]])
    m2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]])
    lms = np.cbrt(lin @ m1.T)
    return lms @ m2.T  # L in 0-1, a and b about -0.4..0.4

def from_oklab(lab):
    m1i = np.linalg.inv(np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]]))
    m2i = np.linalg.inv(np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]]))
    lin = np.clip(((lab @ m2i.T) ** 3) @ m1i.T, 0, 1)
    c = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(np.round(c * 255), 0, 255).astype(int)

def kmeans(x, k, iters=15, seed=0):
    rng = np.random.default_rng(seed)
    centres = [x[rng.integers(len(x))]]
    for _ in range(1, k):  # k-means++ start
        d = np.min([((x - c) ** 2).sum(1) for c in centres], axis=0)
        centres.append(x[rng.choice(len(x), p=d / d.sum())] if d.sum() > 0 else x[rng.integers(len(x))])
    centres = np.array(centres)
    for _ in range(iters):
        label = np.argmin(((x[:, None, :] - centres[None]) ** 2).sum(2), axis=1)
        for j in range(k):
            if (label == j).any():
                centres[j] = x[label == j].mean(0)
    label = np.argmin(((x[:, None, :] - centres[None]) ** 2).sum(2), axis=1)
    return centres, np.bincount(label, minlength=k) / len(x)

def features(data):
    px = trim(load(data))
    lab = to_oklab(px)
    centres, weight = kmeans(lab, min(K, len(np.unique(lab.round(3), axis=0))))
    order = np.argsort(-weight)
    rgb = from_oklab(centres[order])
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    hue = np.arctan2(lab[:, 2], lab[:, 1])
    mean_c = float(chroma.mean())
    hist = np.bincount(((np.degrees(hue) % 360) // 30).astype(int), weights=chroma, minlength=12)
    lightness = lab[:, 0]
    warm = float(np.clip((lab[:, 1] * math.cos(ORANGE) + lab[:, 2] * math.sin(ORANGE)).mean() / 0.1, -1, 1))
    return {
        "palette": [{"hex": "#%02x%02x%02x" % tuple(c), "weight": round(float(w), 3), "lab": [round(float(v), 3) for v in centres[i]]}
                    for c, w, i in zip(rgb, weight[order], order)],
        "lightness": round(float(lightness.mean()), 3),
        "contrast": round(float(np.percentile(lightness, 95) - np.percentile(lightness, 5)), 3),
        "warmth": round(warm, 3),
        "chroma": round(mean_c, 3),
        "hue": "neutral" if mean_c < 0.02 else HUES[int(np.argmax(hist))],
        "monochrome": bool(np.percentile(chroma, 95) < 0.03),
        "trimmed": [int(px.shape[1]), int(px.shape[0])],
    }

def one(path):
    return path, features(Path(path).read_bytes())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments")
    ap.add_argument("--workers", type=int, default=1)
    d = Path(ap.parse_args().dir)
    args = ap.parse_args()
    d = Path(args.dir)
    if (d / "images.json").exists():
        files = [r["file"] for r in json.loads((d / "images.json").read_text())["images"]]
    else:  # a training set: one manifest line per image
        files = [json.loads(l)["file"] for l in (d / "manifest.jsonl").read_text().splitlines() if l.strip()]
    paths = [str(d / f) for f in files]
    if args.workers > 1:
        from multiprocessing import Pool
        with Pool(args.workers) as pool:
            done = dict(pool.imap(one, paths, chunksize=64))
    else:
        done = dict(one(p) for p in paths)
    out = {f: done[str(d / f)] for f in files}
    (d / "colour.json").write_text(json.dumps(out, indent=1))
    hues = {}
    for f in out.values():
        hues[f["hue"]] = hues.get(f["hue"], 0) + 1
    print(f"{len(out)} images; hues {dict(sorted(hues.items(), key=lambda x: -x[1]))}; monochrome {sum(f['monochrome'] for f in out.values())}")

if __name__ == "__main__":
    main()
