"""Per-term precision and recall of the saved tagger on its held-out 15%, at the saved threshold.
    experiments/.venv/bin/python -m pipeline.features.term_report [--dir experiments/train] [--min-support 10]
Writes <dir>/ens/terms.json ({term: {support, precision, recall, auc}}) and prints the summary."""
import argparse, json
from pathlib import Path
import numpy as np
import torch
from .calibrate import auc
from .strategies import build, predict, prepare

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--min-support", type=int, default=10)
    args = ap.parse_args()
    d = Path(args.dir)
    saved = torch.load(d / "ens" / "nets.pt", weights_only=False)
    vocab = json.loads((d / "ens" / "vocab.json").read_text())
    P = prepare(d, 25)
    assert P["vocab"] == vocab, "the vocabulary differs from the one the nets were trained with"
    nets = [build(1024, saved["dim"], len(vocab)).eval() for _ in saved["nets"]]
    for n, sd in zip(nets, saved["nets"]):
        n.load_state_dict(sd)
    x, y = P["z"](P["xi"][P["te"]]), P["yi"][P["te"]]
    p = np.mean([predict(n, x) for n in nets], 0)
    hit = p >= saved["th"]
    out = {}
    for j, t in enumerate(vocab):
        s = int(y[:, j].sum())
        if s < args.min_support:
            continue
        tp = int((hit[:, j] & (y[:, j] == 1)).sum())
        out[t] = {"support": s, "precision": round(tp / max(1, int(hit[:, j].sum())), 3), "recall": round(tp / s, 3), "auc": round(auc(p[:, j], y[:, j] == 1), 3)}
    (d / "ens" / "terms.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    prec = np.array([v["precision"] for v in out.values()])
    print(f"{len(out)} terms with >= {args.min_support} held-out positives (of {len(vocab)}); held-out {len(P['te'])} images, threshold {saved['th']:.2f}")
    print(f"macro precision {prec.mean():.3f}, median {np.median(prec):.3f}; terms at precision >= 0.5: {(prec >= 0.5).sum()}, >= 0.7: {(prec >= 0.7).sum()}")
    print(f"macro recall {np.mean([v['recall'] for v in out.values()]):.3f}, macro AUC {np.nanmean([v['auc'] for v in out.values()]):.3f}")
    top = sorted(out.items(), key=lambda kv: -kv[1]["support"])[:12]
    print("most common:", "; ".join(f"{t} p{v['precision']} r{v['recall']}" for t, v in top))

if __name__ == "__main__":
    main()
