"""Which embedding finds the best neighbours? Scores nearest-neighbour lists against the JoyCaption teacher's tags
(independent of every embedding tried): mean tag overlap (Jaccard) of the top 10, over random query images.
    experiments/.venv/bin/python -m pipeline.features.compare_embeddings [--dir experiments/train] [--queries 1000]
Candidates: the shipped 64-dim hash, SigLIP 2 at 768, and PCA to 256 / 128 / 64, each as int8."""
import argparse, json, sqlite3
from pathlib import Path
import numpy as np
from . import tags as fold

DB = Path(__file__).parents[1] / "works.sqlite"

def unit(x):
    return x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)

def int8(x):
    return np.clip(np.round(unit(x) * 127), -127, 127) / 127

def pca(x, k):
    mu = x.mean(0)
    _, _, vt = np.linalg.svd(x[::4] - mu, full_matrices=False)
    return (x - mu) @ vt[:k].T

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--queries", type=int, default=1000)
    args = ap.parse_args()
    d = Path(args.dir)
    man = {json.loads(l)["file"]: json.loads(l)["uid"] for l in (d / "manifest.jsonl").read_text().splitlines() if l.strip()}
    files = json.loads((d / "emb_files.json").read_text())
    sig = np.load(d / "emb.npy").astype(np.float32)
    labels = {json.loads(l)["file"]: json.loads(l) for l in (d / "labels.jsonl").read_text().splitlines() if l.strip()}
    keep = [i for i, f in enumerate(files) if f in labels and not labels[f].get("error")]
    heads = fold.heads_of([labels[files[i]]["tags"] for i in keep])
    tagset = [frozenset(c for t in labels[files[i]]["tags"] for c in fold.expand(t, heads)) for i in keep]
    conn = sqlite3.connect(DB)
    uids = [man[files[i]] for i in keep]
    vec = {u: v for u, v in conn.execute("SELECT w.uid, e.vec FROM work w JOIN work_embedding e ON e.work_id=w.id")}
    old = np.array([np.frombuffer(vec[u], dtype=np.int8).astype(np.float32) for u in uids])
    x = sig[keep]
    sets = {"hash-64 (shipped)": old, "siglip-768": int8(x), "pca-256": int8(pca(x, 256)), "pca-128": int8(pca(x, 128)), "pca-64": int8(pca(x, 64))}
    rng = np.random.default_rng(0)
    q = rng.choice(len(keep), args.queries, replace=False)
    def jac(a, b):
        return len(a & b) / max(1, len(a | b))
    for name, e in sets.items():
        e = unit(e)
        s = e[q] @ e.T
        s[np.arange(len(q)), q] = -9
        top = np.argsort(-s, axis=1)[:, :10]
        j = [np.mean([jac(tagset[qi], tagset[n]) for n in row]) for qi, row in zip(q, top)]
        print(f"{name:20s} Jaccard@10 {np.mean(j):.3f}")
    rand = np.mean([jac(tagset[a], tagset[b]) for a, b in rng.integers(0, len(keep), (5000, 2))])
    print(f"{'random pairs':20s} Jaccard    {rand:.3f}")

if __name__ == "__main__":
    main()
