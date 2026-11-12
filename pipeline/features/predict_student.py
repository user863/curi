"""Runs the trained student over every embedded training image: tags above the F1 threshold, best first.
    experiments/.venv/bin/python -m pipeline.features.predict_student [--dir experiments/train] [--student student1024] [--top 14]
Writes <dir>/<student>/pred.json: {file: [[tag, probability], ...]}."""
import argparse, json
from pathlib import Path
import numpy as np
import torch

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--student", default="student1024")
    ap.add_argument("--top", type=int, default=14)
    args = ap.parse_args()
    d = Path(args.dir)
    s = d / args.student
    w = np.load(s / "head.npz")
    vocab = json.loads((s / "vocab.json").read_text())
    th = json.loads((s / "metrics.json").read_text())["f1_threshold"]
    x = (np.load(d / "emb.npy").astype(np.float32) - w["mu"]) / w["sd"]
    files = json.loads((d / "emb_files.json").read_text())
    h = torch.nn.functional.gelu(torch.tensor(x) @ torch.tensor(w["0_weight"]).T + torch.tensor(w["0_bias"]))
    p = torch.sigmoid(h @ torch.tensor(w["3_weight"]).T + torch.tensor(w["3_bias"])).numpy()
    out = {}
    for f, row in zip(files, p):
        idx = [j for j in np.argsort(-row)[:args.top] if row[j] >= th]
        out[f] = [[vocab[j], round(float(row[j]), 2)] for j in idx]
    (s / "pred.json").write_text(json.dumps(out, ensure_ascii=False))
    print(f"{len(out)} images, threshold {th}, mean {np.mean([len(v) for v in out.values()]):.1f} tags/image")

if __name__ == "__main__":
    main()
