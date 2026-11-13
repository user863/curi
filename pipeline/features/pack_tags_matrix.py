"""Tag probabilities of the saved ensemble (tag_images.py) for every embedded picture, reduced to 50 dimensions (PCA): the input of
the pack explorer's tag layout.
    experiments/.venv/bin/python -m pipeline.features.pack_tags_matrix [--train experiments/train] [--out experiments/pack]
Writes <out>/explore/tags_pca.f32 and tags_order.json, then: Rscript pipeline/features/explore/make_layout_tags.R experiments/pack"""
import argparse, json
from pathlib import Path
import numpy as np
import torch
from .embeddings import load_all
from .strategies import build, predict

DIMS = 50

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="experiments/train")
    ap.add_argument("--out", default="experiments/pack")
    args = ap.parse_args()
    e = Path(args.train) / "ens"
    saved = torch.load(e / "nets.pt", weights_only=False)
    vocab = json.loads((e / "vocab.json").read_text())
    nets = []
    for sd in saved["nets"]:
        net = build(1024, saved["dim"], len(vocab))
        net.load_state_dict(sd)
        nets.append(net.eval())
    uids, emb = load_all()
    keep = {Path(f).stem for f in json.loads((Path(args.out) / "colour.json").read_text())}  # the pictures the explorer shows
    rows = [i for i, u in enumerate(uids) if u in keep]
    x = (emb[rows] - saved["mu"]) / saved["sd"]
    p = np.concatenate([np.mean([predict(n, x[i:i + 4096]) for n in nets], 0) for i in range(0, len(x), 4096)])
    p = p - p.mean(0)
    u, s, _ = np.linalg.svd(p, full_matrices=False)
    z = (u[:, :DIMS] * s[:DIMS]).astype(np.float32)
    out = Path(args.out) / "explore"
    out.mkdir(parents=True, exist_ok=True)
    z.tofile(out / "tags_pca.f32")
    (out / "tags_order.json").write_text(json.dumps([uids[i] for i in rows]))
    print(z.shape, "variance kept", round(float((s[:DIMS] ** 2).sum() / (s ** 2).sum()), 3))

if __name__ == "__main__":
    main()
