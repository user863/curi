"""Student tagger: a multi-label head on frozen SigLIP 2 embeddings, trained on the JoyCaption teacher's tags.
    experiments/.venv/bin/python -m pipeline.features.train_head [--dir experiments/train] [--min-count 25]
Features: SigLIP 2 (emb.npy). Tags are folded by tags.py unless --raw. Reads labels.jsonl. Writes <dir>/student<hidden>/{head.npz, vocab.json, metrics.json}.
Reports on a held-out split of the labelled images: per-tag AUC, micro F1, and how well the top-k tags match the teacher's."""
import argparse, json, re
from collections import Counter
from pathlib import Path
import numpy as np
from . import tags as fold
import torch

def norm(tag):
    t = re.sub(r"[^a-z0-9 \-']", " ", tag.lower()).strip()
    return re.sub(r"\s+", " ", t)

def auc(score, y):
    pos, neg = score[y == 1], score[y == 0]
    if len(pos) < 3 or len(neg) < 3:
        return None
    r = np.argsort(np.argsort(np.concatenate([pos, neg]))) + 1
    return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))

def fit(x, y, hidden, epochs, seed, xv=None, yv=None):
    torch.manual_seed(seed)
    dim, v = x.shape[1], y.shape[1]
    net = torch.nn.Sequential(torch.nn.Linear(dim, hidden), torch.nn.GELU(), torch.nn.Dropout(0.3), torch.nn.Linear(hidden, v)) if hidden else torch.nn.Linear(dim, v)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-2)
    xt, yt = torch.tensor(x), torch.tensor(y)
    pw = torch.tensor(np.clip((len(y) - y.sum(0)) / np.maximum(y.sum(0), 1), 1, 30) ** 0.5, dtype=torch.float32)  # mild weight on rare tags
    best, best_state = 1e9, None
    for ep in range(epochs):
        net.train()
        perm = torch.randperm(len(xt))
        for i in range(0, len(xt), 128):
            idx = perm[i:i + 128]
            loss = torch.nn.functional.binary_cross_entropy_with_logits(net(xt[idx]), yt[idx], pos_weight=pw)
            opt.zero_grad(); loss.backward(); opt.step()
        if xv is not None:
            net.eval()
            with torch.no_grad():
                vl = torch.nn.functional.binary_cross_entropy_with_logits(net(torch.tensor(xv)), torch.tensor(yv), pos_weight=pw).item()
            if vl < best:
                best, best_state = vl, {k: t.clone() for k, t in net.state_dict().items()}
    if best_state:
        net.load_state_dict(best_state)
    return net.eval()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--min-count", type=int, default=25)
    ap.add_argument("--raw", action="store_true", help="skip tag folding (pipeline/features/tags.py)")
    ap.add_argument("--hidden", type=int, default=0, help="0 = linear head")
    ap.add_argument("--epochs", type=int, default=60)
    args = ap.parse_args()
    d = Path(args.dir)
    emb = np.load(d / "emb.npy").astype(np.float32)
    files = json.loads((d / "emb_files.json").read_text())
    row = {f: i for i, f in enumerate(files)}
    labels = [json.loads(l) for l in (d / "labels.jsonl").read_text().splitlines() if l.strip()]
    labels = [l for l in labels if l["file"] in row]
    heads = fold.heads_of([l["tags"] for l in labels])
    tagsets = [sorted({norm(t) for t in l["tags"] if norm(t)}) if args.raw else sorted({c for t in l["tags"] for c in fold.expand(t, heads)}) for l in labels]
    count = Counter(t for ts in tagsets for t in ts)
    vocab = [t for t, c in count.most_common() if c >= args.min_count]
    col = {t: i for i, t in enumerate(vocab)}
    x = emb[[row[l["file"]] for l in labels]]
    mu, sd_x = x.mean(0), x.std(0) + 1e-6
    x = (x - mu) / sd_x  # standardised features
    y = np.zeros((len(labels), len(vocab)), dtype=np.float32)
    for i, ts in enumerate(tagsets):
        for t in ts:
            if t in col:
                y[i, col[t]] = 1
    rng = np.random.default_rng(0)
    order = rng.permutation(len(labels))
    cut = int(len(order) * 0.85)
    tr, te = order[:cut], order[cut:]
    print(f"{len(labels)} labelled, {len(count)} distinct tags, {len(vocab)} kept (>= {args.min_count}); train {len(tr)}, held out {len(te)}", flush=True)
    net = fit(x[tr], y[tr], args.hidden, args.epochs, 0, x[te], y[te])
    with torch.no_grad():
        p = torch.sigmoid(net(torch.tensor(x[te]))).numpy()
    yt = y[te]
    aucs = {vocab[j]: auc(p[:, j], yt[:, j]) for j in range(len(vocab))}
    good = [a for a in aucs.values() if a is not None]
    # micro F1 at the best global threshold
    best = max(((2 * (p >= th)[yt == 1].sum() / max(1, (p >= th).sum() + yt.sum()), th) for th in np.arange(0.05, 0.9, 0.05)))
    # top-k agreement: of the k highest-scoring tags, the share the teacher also gave; and of the teacher's tags (up to k), the share recovered
    prec, rec = [], []
    for i in range(len(te)):
        k = int(min(8, max(1, yt[i].sum())))
        top = np.argsort(-p[i])[:k]
        truth = set(np.flatnonzero(yt[i]))
        if truth:
            prec.append(len(truth & set(top)) / k)
            rec.append(len(truth & set(np.argsort(-p[i])[:8])) / len(truth))
    per_tag = sorted(((vocab[j], round(aucs[vocab[j]], 3), int(yt[:, j].sum()), int(count[vocab[j]])) for j in range(len(vocab)) if aucs[vocab[j]] is not None), key=lambda r: -r[3])
    metrics = {"labelled": len(labels), "vocab": len(vocab), "min_count": args.min_count, "heldout": len(te), "hidden": args.hidden,
               "mean_auc": round(float(np.mean(good)), 4), "median_auc": round(float(np.median(good)), 4),
               "auc_ge_0.9": round(float(np.mean([a >= 0.9 for a in good])), 3), "auc_lt_0.75": round(float(np.mean([a < 0.75 for a in good])), 3),
               "heldout_files": [labels[i]["file"] for i in te], "micro_f1": round(float(best[0]), 4), "f1_threshold": round(float(best[1]), 2),
               "precision_at_k": round(float(np.mean(prec)), 4), "recall_at_8": round(float(np.mean(rec)), 4), "per_tag": per_tag}
    out = d / f"student{args.hidden or ''}{'_raw' if args.raw else ''}"; out.mkdir(exist_ok=True)
    sd = net.state_dict()
    np.savez(out / "head.npz", mu=mu, sd=sd_x, **{k.replace(".", "_"): v.numpy() for k, v in sd.items()})
    (out / "vocab.json").write_text(json.dumps(vocab))
    (out / "metrics.json").write_text(json.dumps(metrics, indent=1))
    print({k: v for k, v in metrics.items() if k not in ("per_tag", "heldout_files")})
    print("best tags:", [r[:2] for r in sorted(per_tag, key=lambda r: -r[1])[:8]])
    print("worst tags:", [r[:2] for r in sorted(per_tag, key=lambda r: r[1])[:8]])

if __name__ == "__main__":
    main()
