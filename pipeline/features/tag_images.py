"""Tags every embedded image with the ensemble: 5 seeds of the 1024-unit MLP head, probabilities averaged.
    experiments/.venv/bin/python -m pipeline.features.tag_images [--dir experiments/train] [--seeds 5] [--top 14]
Trains on the same 85% split as strategies.py, picks the F1-best threshold on the held-out 15%, then tags all images.
Writes <dir>/ens/{vocab.json, metrics.json, pred.json, nets.pt}; nets.pt (weights, standardisation, threshold) tags further embeddings via tag_rest.py; pred.json is {file: [[tag, probability], ...]}, best first."""
import argparse, json
from pathlib import Path
import numpy as np
import torch
from .strategies import prepare, fit, predict, evaluate

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--min-count", type=int, default=25)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--top", type=int, default=14)
    args = ap.parse_args()
    d = Path(args.dir)
    P = prepare(d, args.min_count)
    z, xi, yi, tr, te, vocab = P["z"], P["xi"], P["yi"], P["tr"], P["te"], P["vocab"]
    xtr, xte = z(xi[tr]), z(xi[te])
    nets = [fit(xtr, yi[tr], epochs=args.epochs, seed=s, xv=xte, yv=yi[te]) for s in range(args.seeds)]
    ens = lambda x: np.mean([predict(n, x) for n in nets], 0)
    held = ens(xte)
    f1 = lambda th: 2 * ((held >= th)[yi[te] == 1].sum()) / max(1, (held >= th).sum() + yi[te].sum())
    th = max(np.arange(0.05, 0.95, 0.05), key=f1)
    p = ens(z(P["emb"]))
    files = json.loads((d / "emb_files.json").read_text())
    out = {f: [[vocab[j], round(float(r[j]), 2)] for j in np.argsort(-r)[:args.top] if r[j] >= th] for f, r in zip(files, p)}
    o = d / "ens"
    o.mkdir(exist_ok=True)
    torch.save({"nets": [n.state_dict() for n in nets], "mu": P["mu"], "sd": P["sd"], "th": float(th), "dim": xtr.shape[1]}, o / "nets.pt")
    (o / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False))
    (o / "pred.json").write_text(json.dumps(out, ensure_ascii=False))
    (o / "metrics.json").write_text(json.dumps({**evaluate(held, yi[te]), "seeds": args.seeds, "f1_threshold": round(float(th), 2), "labelled": len(P["labels"]), "vocab": len(vocab), "heldout": len(te)}, indent=1))
    print(f"{len(out)} images, threshold {th:.2f}, mean {np.mean([len(v) for v in out.values()]):.1f} tags/image")

if __name__ == "__main__":
    main()
