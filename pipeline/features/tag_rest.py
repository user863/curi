"""Tags the embeddings from embed_rest.py with the saved ensemble (tag_images.py), best first.
    experiments/.venv/bin/python -m pipeline.features.tag_rest [--dir experiments/train] [--catalog experiments/catalog] [--top 14]
Writes <catalog>/pred.json: {uid: [[tag, probability], ...]}."""
import argparse, json
from pathlib import Path
import numpy as np
import torch
from .strategies import build, predict

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--catalog", default="experiments/catalog")
    ap.add_argument("--top", type=int, default=14)
    args = ap.parse_args()
    e = Path(args.dir) / "ens"
    saved = torch.load(e / "nets.pt", weights_only=False)
    vocab = json.loads((e / "vocab.json").read_text())
    nets = []
    for sd in saved["nets"]:
        net = build(1024, saved["dim"], len(vocab))
        net.load_state_dict(sd)
        nets.append(net.eval())
    c = Path(args.catalog)
    out = {}
    for f in sorted(c.glob("chunk_*.npy")):
        uids = json.loads(f.with_suffix(".json").read_text())
        x = (np.load(f).astype(np.float32) - saved["mu"]) / saved["sd"]
        p = np.mean([predict(n, x) for n in nets], 0)
        for u, r in zip(uids, p):
            out[u] = [[vocab[j], round(float(r[j]), 2)] for j in np.argsort(-r)[:args.top] if r[j] >= saved["th"]]
    (c / "pred.json").write_text(json.dumps(out, ensure_ascii=False))
    print(f"{len(out)} images, mean {np.mean([len(v) for v in out.values()]):.1f} tags/image")

if __name__ == "__main__":
    main()
