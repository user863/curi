"""The student's tag probabilities for every embedded image, reduced to 50 dimensions (PCA), for the explorer's second layout.
    experiments/.venv/bin/python -m pipeline.features.tags_matrix [--dir experiments/train] [--student student1024]
Writes <dir>/explore/tags_pca.f32 (raw float32, rows x 50) and tags_order.json (uids in row order)."""
import argparse, json
from pathlib import Path
import numpy as np
import torch

DIMS = 50

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--student", default="student1024")
    args = ap.parse_args()
    d = Path(args.dir)
    w = np.load(d / args.student / "head.npz")
    x = (np.load(d / "emb.npy").astype(np.float32) - w["mu"]) / w["sd"]
    h = torch.nn.functional.gelu(torch.tensor(x) @ torch.tensor(w["0_weight"]).T + torch.tensor(w["0_bias"]))
    p = torch.sigmoid(h @ torch.tensor(w["3_weight"]).T + torch.tensor(w["3_bias"])).numpy()
    p = p - p.mean(0)
    u, s, _ = np.linalg.svd(p, full_matrices=False)
    z = (u[:, :DIMS] * s[:DIMS]).astype(np.float32)
    (d / "explore").mkdir(exist_ok=True)
    z.tofile(d / "explore" / "tags_pca.f32")
    files = json.loads((d / "emb_files.json").read_text())
    (d / "explore" / "tags_order.json").write_text(json.dumps([Path(f).stem for f in files]))
    print(z.shape, "variance kept", round(float((s[:DIMS] ** 2).sum() / (s ** 2).sum()), 3))

if __name__ == "__main__":
    main()
