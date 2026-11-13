"""Image vectors and mood for works added after the last corpus pass: every catalog picture whose work has no affect row yet.
    experiments/.venv/bin/python -m pipeline.features.apply_new [--catalog experiments/catalog] [--affect experiments/affect/affect_new.json]
Vector: the saved PCA (siglip_pca64.npz) of the SigLIP 2 image vector, unit length, int8, into work_embedding. Mood, valence and energy:
affect_norm.score, written as <affect> for pipeline.apply_affect. Run after embed_rest.py and tag_rest.py."""
import argparse, json, sqlite3
from pathlib import Path
import numpy as np
from .. import embed
from . import affect_norm

DB = Path(__file__).resolve().parents[1] / "works.sqlite"


def catalog(cat):
    uids, vecs = [], []
    for f in sorted(Path(cat).glob("chunk_[0-9][0-9][0-9][0-9].json")):
        uids += json.loads(f.read_text())
        vecs.append(np.load(f.with_suffix(".npy")).astype(np.float32))
    return uids, np.concatenate(vecs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="experiments/catalog")
    ap.add_argument("--affect", default="experiments/affect/affect_new.json")
    args = ap.parse_args()
    conn = sqlite3.connect(DB)
    todo = dict(conn.execute("SELECT w.uid, w.id FROM work w WHERE w.state='published' AND w.id NOT IN (SELECT work_id FROM work_affect)"))
    uids, emb = catalog(args.catalog)
    keep = [i for i, u in enumerate(uids) if u in todo]
    uids, emb = [uids[i] for i in keep], emb[keep]
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    pca = np.load(embed.PCA)
    p = (emb - pca["mean"]) @ pca["components"].T
    vec = np.round(p / np.linalg.norm(p, axis=1, keepdims=True) * 127).astype(np.int8)
    conn.executemany("INSERT OR REPLACE INTO work_embedding VALUES(?,?,?,?)", [(todo[u], embed.MODEL, embed.DIM, vec[i].tobytes()) for i, u in enumerate(uids)])
    conn.commit()
    scored = affect_norm.score(emb)
    Path(args.affect).parent.mkdir(parents=True, exist_ok=True)
    Path(args.affect).write_text(json.dumps({u: scored[i] for i, u in enumerate(uids)}))
    print(f"{len(uids)} works: image vectors stored, mood and affect -> {args.affect}")


if __name__ == "__main__":
    main()
