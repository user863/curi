"""Calibrates the zero-shot mood terms (zeroshot.py) against the teacher's tags and derives valence and energy.
    experiments/.venv/bin/python -m pipeline.features.calibrate [--dir experiments/affect] [--train experiments/train]
Terms with enough teacher positives get the z threshold that maximises F1 on half of the labelled pictures; precision, recall
and AUC are then measured on the other half. The rest use Z_DEFAULT and are not published. Valence and energy are signed combinations of the term
z-scores, rank-normalised over the corpus to 1..255.
Writes pipeline/features/affect.json (spec and holdout metrics) and <dir>/affect.json ({uid: {mood, valence, energy}})."""
import argparse, hashlib, json, re
from pathlib import Path
import numpy as np

HERE = Path(__file__).parent
Z_DEFAULT = 2.5
MIN_POS = 25
MIN_AUC = 0.85  # a term is published as a tag only when its holdout AUC reaches this
# Teacher words that count as the same mood.
TEACHER = {
    "calm": ["calm", "peaceful", "tranquil", "quiet"], "serene": ["serene"], "dramatic": ["dramatic"],
    "melancholy": ["melancholy", "melancholic", "sad"], "joyful": ["joyful", "happy", "cheerful"], "mysterious": ["mysterious", "eerie"],
    "tender": ["intimate", "tender", "romantic"], "ornate": ["ornate"], "minimal": ["minimal", "minimalist"], "chaotic": ["chaotic"],
    "sombre": ["somber", "sombre", "gloomy", "moody"], "playful": ["playful"], "solemn": ["solemn", "serious"], "dreamlike": ["dreamlike"],
}
# Signed combinations; teacher words that stand for the high and low end check them.
AXES = {
    "valence": {"high": ["joyful", "tender", "serene", "playful"], "low": ["melancholy", "sombre", "mysterious"],
                "teacher_high": ["happy", "joyful", "cheerful", "bright", "festive"], "teacher_low": ["gloomy", "somber", "sad", "dark", "moody"]},
    "energy": {"high": ["dramatic", "chaotic", "playful"], "low": ["calm", "serene", "solemn", "minimal", "dreamlike"],
               "teacher_high": ["dynamic", "energetic", "chaotic", "motion", "dramatic"], "teacher_low": ["calm", "serene", "peaceful", "tranquil", "quiet"]},
}

def auc(score, positive):
    """Probability that a random positive outscores a random negative (rank formula)."""
    order = np.argsort(score)
    ranks = np.empty(len(score))
    ranks[order] = np.arange(1, len(score) + 1)
    p = positive.sum()
    q = len(score) - p
    return float((ranks[positive].sum() - p * (p + 1) / 2) / (p * q)) if p and q else float("nan")

def best_threshold(z, y):
    best = (0.0, Z_DEFAULT)
    for t in np.arange(0.5, 4.01, 0.1):
        hit = z >= t
        tp = (hit & y).sum()
        f1 = 2 * tp / max(1, hit.sum() + y.sum())
        if f1 > best[0]:
            best = (float(f1), float(round(t, 1)))
    return best[1]

def prf(z, y, t):
    hit = z >= t
    tp = int((hit & y).sum())
    return {"precision": round(tp / max(1, hit.sum()), 3), "recall": round(tp / max(1, y.sum()), 3), "auc": round(auc(z, y), 3)}

def percentile(x):
    order = np.argsort(np.argsort(x))
    return (1 + np.round(254 * order / max(1, len(x) - 1))).astype(int)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/affect")
    ap.add_argument("--train", default="experiments/train")
    args = ap.parse_args()
    d = Path(args.dir)
    s = np.load(d / "scores.npz")
    uids, terms, z = list(s["uids"]), list(s["terms"]), s["z"]
    col = {t: i for i, t in enumerate(terms)}
    row = {u: i for i, u in enumerate(uids)}
    teacher = {}
    for l in (Path(args.train) / "labels.jsonl").read_text().splitlines():
        if l.strip():
            r = json.loads(l)
            teacher[r["uid"]] = " ".join(t.lower() for t in r.get("tags", []))
    labelled = [u for u in teacher if u in row]
    held = np.array([int(hashlib.md5(u.encode()).hexdigest(), 16) % 2 == 1 for u in labelled])  # odd hash: holdout
    idx = np.array([row[u] for u in labelled])
    has = lambda words: np.array([any(re.search(rf"\b{w}\b", teacher[u]) for w in words) for u in labelled])

    spec = {"terms": {}, "axes": {}}
    for t in terms:
        y = has(TEACHER[t])
        zt = z[idx, col[t]]
        if y[~held].sum() >= MIN_POS:
            thr = best_threshold(zt[~held], y[~held])
            m = prf(zt[held], y[held], thr)
            spec["terms"][t] = {"threshold": thr, "calibrated": True, "publish": m["auc"] >= MIN_AUC, "support": int(y.sum()), **{k: float(v) for k, v in m.items()}}
        else:
            spec["terms"][t] = {"threshold": Z_DEFAULT, "calibrated": False, "publish": False, "support": int(y.sum())}
    axis = {}
    for name, a in AXES.items():
        val = z[:, [col[t] for t in a["high"]]].mean(1) - z[:, [col[t] for t in a["low"]]].mean(1)
        axis[name] = percentile(val)
        hi, lo = has(a["teacher_high"]) & ~has(a["teacher_low"]), has(a["teacher_low"]) & ~has(a["teacher_high"])
        both = (hi | lo) & held
        spec["axes"][name] = {"high": a["high"], "low": a["low"], "holdoutAuc": round(auc(val[idx][both], hi[both]), 3), "holdoutN": int(both.sum())}
    (HERE / "affect.json").write_text(json.dumps(spec, indent=1))
    out = {}
    for u, i in row.items():
        out[u] = {"mood": [t for t in terms if spec["terms"][t]["publish"] and z[i, col[t]] >= spec["terms"][t]["threshold"]], "valence": int(axis["valence"][i]), "energy": int(axis["energy"][i])}
    (d / "affect.json").write_text(json.dumps(out, separators=(",", ":")))
    for t, m in spec["terms"].items():
        print(f"{t:11s}", m)
    print(spec["axes"])

if __name__ == "__main__":
    main()
