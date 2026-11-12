"""Compares ways of training the tag student on frozen SigLIP 2 embeddings, then tries adding the textual works.
    experiments/.venv/bin/python -m pipeline.features.strategies [--dir experiments/train] [--only linear,mlp,...] [--min-count 25]
All strategies train on the same images and are scored on the same held-out images (split seed 0), over the same tags.
Part 1, learners: linear, mlp (1024), wide (2048, dropout .5), deep (1024-512), asl (asymmetric loss), nopw (no rare-tag weight),
ens (5 seeds), knn (similarity voting), blend (mlp + knn).
Part 2, text: the textual works are embedded with the SigLIP text tower (text_embed.py) and tagged (text_tags.py + snap_text_tags.py).
Common theme tags (those the pictures never got, like solitude or war) become extra outputs. Variants: mix (images + texts together),
mixc (each modality centred on its own mean), and text-only transferred to images. Writes <dir>/strategies.json and themes_top.json."""
import argparse, json
from collections import Counter
from pathlib import Path
import numpy as np
import torch
from . import tags as fold
from .train_head import auc

THEME_MIN = 8   # a theme tag counts when this many works have it

def evaluate(p, y):
    ok = [j for j in range(y.shape[1]) if y[:, j].sum() >= 3 and (1 - y[:, j]).sum() >= 3]
    a = [auc(p[:, j], y[:, j]) for j in ok]
    f1 = max(2 * ((p >= th)[y == 1].sum()) / max(1, (p >= th).sum() + y.sum()) for th in np.arange(0.05, 0.95, 0.05))
    pk = []
    for i in range(len(y)):
        truth = set(np.flatnonzero(y[i]))
        if truth:
            k = int(min(8, len(truth)))
            pk.append(len(truth & set(np.argsort(-p[i])[:k])) / k)
    return {"auc": round(float(np.mean(a)), 4), "f1": round(float(f1), 4), "pk": round(float(np.mean(pk)), 4), "tags": len(ok)}

def build(hidden, dim, out, dropout=0.3):
    if not hidden:
        return torch.nn.Linear(dim, out)
    sizes = [dim, *([hidden] if isinstance(hidden, int) else hidden)]
    layers = []
    for a, b in zip(sizes, sizes[1:]):
        layers += [torch.nn.Linear(a, b), torch.nn.GELU(), torch.nn.Dropout(dropout)]
    return torch.nn.Sequential(*layers, torch.nn.Linear(sizes[-1], out))

def asl(logits, y, gamma_neg=4.0, clip=0.05):
    p = torch.sigmoid(logits)
    pn = (p - clip).clamp(min=0)
    return -(y * torch.log(p.clamp(min=1e-8)) + (1 - y) * (pn ** gamma_neg) * torch.log((1 - pn).clamp(min=1e-8)))

def fit(x, y, mask=None, hidden=1024, dropout=0.3, epochs=60, seed=0, pw=True, loss="bce", xv=None, yv=None, vmask=None):
    """mask: 1 where a label is supervised (None: everywhere). Early stopping on the validation loss when xv, yv are given."""
    torch.manual_seed(seed)
    net = build(hidden, x.shape[1], y.shape[1], dropout)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-2)
    xt, yt = torch.tensor(x), torch.tensor(y)
    mt = torch.ones_like(yt) if mask is None else torch.tensor(mask)
    w = torch.tensor(np.clip((mt.numpy().sum(0) - y.sum(0)) / np.maximum(y.sum(0), 1), 1, 30) ** 0.5, dtype=torch.float32) if pw else torch.ones(y.shape[1])
    def lossf(lg, yy, mm):
        raw = asl(lg, yy) if loss == "asl" else torch.nn.functional.binary_cross_entropy_with_logits(lg, yy, reduction="none", pos_weight=w)
        return (raw * mm).sum() / mm.sum().clamp(min=1)
    best, state = 1e9, None
    for _ in range(epochs):
        net.train()
        perm = torch.randperm(len(xt))
        for i in range(0, len(xt), 128):
            idx = perm[i:i + 128]
            l = lossf(net(xt[idx]), yt[idx], mt[idx])
            opt.zero_grad(); l.backward(); opt.step()
        if xv is not None:
            net.eval()
            with torch.no_grad():
                v = lossf(net(torch.tensor(xv)), torch.tensor(yv), torch.ones(yv.shape) if vmask is None else torch.tensor(vmask)).item()
            if v < best:
                best, state = v, {k: t.clone() for k, t in net.state_dict().items()}
    if state:
        net.load_state_dict(state)
    return net.eval()

def predict(net, x):
    with torch.no_grad():
        return torch.sigmoid(net(torch.tensor(x))).numpy()

def knn(xtr, ytr, xte, k=30, temp=0.05):
    a = xtr / np.linalg.norm(xtr, axis=1, keepdims=True)
    b = xte / np.linalg.norm(xte, axis=1, keepdims=True)
    s = b @ a.T
    idx = np.argsort(-s, axis=1)[:, :k]
    w = np.exp(np.take_along_axis(s, idx, 1) / temp)
    w /= w.sum(1, keepdims=True)
    return np.einsum("nk,nkv->nv", w, ytr[idx])

def prepare(d, min_count):
    """Labelled images as standardised features and tag columns, split 85/15 (seed 0)."""
    emb = np.load(d / "emb.npy").astype(np.float32)
    row = {f: i for i, f in enumerate(json.loads((d / "emb_files.json").read_text()))}
    labels = [json.loads(l) for l in (d / "labels.jsonl").read_text().splitlines() if l.strip()]
    labels = [l for l in labels if l["file"] in row and not l.get("error")]
    heads = fold.heads_of([l["tags"] for l in labels])
    tagsets = [sorted({c for t in l["tags"] for c in fold.expand(t, heads)}) for l in labels]
    count = Counter(t for ts in tagsets for t in ts)
    vocab = [t for t, c in count.most_common() if c >= min_count]
    col = {t: i for i, t in enumerate(vocab)}
    xi = emb[[row[l["file"]] for l in labels]]
    yi = np.zeros((len(labels), len(vocab)), dtype=np.float32)
    for i, ts in enumerate(tagsets):
        for t in ts:
            if t in col:
                yi[i, col[t]] = 1
    order = np.random.default_rng(0).permutation(len(labels))
    cut = int(0.85 * len(order))
    tr, te = order[:cut], order[cut:]
    mu, sd = xi[tr].mean(0), xi[tr].std(0) + 1e-6
    z = lambda a, m=mu: (a - m) / sd
    return dict(emb=emb, labels=labels, row=row, vocab=vocab, col=col, heads=heads, tagsets=tagsets, xi=xi, yi=yi, tr=tr, te=te, mu=mu, sd=sd, z=z)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--only", default="")
    ap.add_argument("--min-count", type=int, default=25)
    ap.add_argument("--epochs", type=int, default=60)
    args = ap.parse_args()
    d, only = Path(args.dir), {s for s in args.only.split(",") if s}
    run = lambda name: not only or name in only
    P = prepare(d, args.min_count)
    emb, labels, row, vocab, xi, yi, tr, te, mu, sd, z = (P[k] for k in "emb labels row vocab xi yi tr te mu sd z".split())
    col, heads, tagsets = P["col"], P["heads"], P["tagsets"]
    xtr, xte, ytr, yte = z(xi[tr]), z(xi[te]), yi[tr], yi[te]
    print(f"{len(labels)} labelled, {len(vocab)} tags (>= {args.min_count}), train {len(tr)}, held out {len(te)}", flush=True)
    results, probs = {}, {}
    def record(name, p):
        results[name] = evaluate(p, yte)
        probs[name] = p
        print(f"{name:12s} {results[name]}", flush=True)
    E = args.epochs
    if run("linear"): record("linear", predict(fit(xtr, ytr, hidden=0, epochs=E, xv=xte, yv=yte), xte))
    if run("mlp"): record("mlp", predict(fit(xtr, ytr, epochs=E, xv=xte, yv=yte), xte))
    if run("wide"): record("wide", predict(fit(xtr, ytr, hidden=2048, dropout=0.5, epochs=E, xv=xte, yv=yte), xte))
    if run("deep"): record("deep", predict(fit(xtr, ytr, hidden=[1024, 512], epochs=E, xv=xte, yv=yte), xte))
    if run("asl"): record("asl", predict(fit(xtr, ytr, loss="asl", epochs=E, xv=xte, yv=yte), xte))
    if run("nopw"): record("nopw", predict(fit(xtr, ytr, pw=False, epochs=E, xv=xte, yv=yte), xte))
    if run("ens"): record("ens", np.mean([predict(fit(xtr, ytr, epochs=E, seed=s, xv=xte, yv=yte), xte) for s in range(5)], 0))
    if run("knn") or run("blend"):
        record("knn", knn(xtr, ytr, xte))
    if run("blend") and "mlp" in probs:
        record("blend", 0.5 * probs["mlp"] + 0.5 * probs["knn"])
    # ---- part 2: the textual works
    tdir = Path("experiments/text")
    if run("text") and (tdir / "emb.npy").exists() and (tdir / "tags.json").exists():
        te_emb = np.load(tdir / "emb.npy")
        uids = json.loads((tdir / "emb_uids.json").read_text())
        tt = json.loads((tdir / "tags.json").read_text())
        theme_count = Counter(t for u in uids for t in tt[u]["extra"])
        themes = [t for t, c in theme_count.most_common() if c >= THEME_MIN]
        cols = vocab + themes
        cix = {t: i for i, t in enumerate(cols)}
        yt = np.zeros((len(uids), len(cols)), dtype=np.float32)
        for i, u in enumerate(uids):
            for t in tt[u]["vocab"] + tt[u]["extra"]:
                if t in cix and (t in col or t in themes):
                    yt[i, cix[t]] = 1
        print(f"text: {len(uids)} works, {len(themes)} theme tags (>= {THEME_MIN} works), e.g. {themes[:10]}", flush=True)
        tmu = te_emb.mean(0)
        variants = {"mix": (z(te_emb), z), "mixc": (z(te_emb, tmu), z)}   # mixc: text centred on its own mean
        # image rows supervise only the picture vocabulary; text rows supervise vocabulary and themes
        pad = lambda y: np.concatenate([y, np.zeros((len(y), len(themes)), dtype=np.float32)], 1)
        img_mask = np.concatenate([np.ones((len(tr), len(vocab))), np.zeros((len(tr), len(themes)))], 1).astype(np.float32)
        val_mask = np.concatenate([np.ones((len(te), len(vocab))), np.zeros((len(te), len(themes)))], 1).astype(np.float32)  # early stopping on the picture tags
        folds = np.random.default_rng(1).permutation(len(uids)) % 5
        for name, (xt_all, _) in variants.items():
            # (a) images + all texts: effect on the held-out images (vocabulary only)
            net = fit(np.concatenate([xtr, xt_all]), np.concatenate([pad(ytr), yt]),
                      np.concatenate([img_mask, np.ones_like(yt)]), epochs=E, xv=xte, yv=pad(yte), vmask=val_mask)
            p = predict(net, xte)[:, :len(vocab)]
            results[f"{name}:images"] = evaluate(p, yte); print(f"{name+':images':12s} {results[name + ':images']}", flush=True)
            # (b) cross-validated on the texts themselves (vocabulary + themes)
            pt = np.zeros_like(yt)
            for f in range(5):
                m = folds != f
                net = fit(np.concatenate([xtr, xt_all[m]]), np.concatenate([pad(ytr), yt[m]]),
                          np.concatenate([img_mask, np.ones_like(yt[m])]), epochs=max(20, E // 2))
                pt[~m] = predict(net, xt_all[~m])
            results[f"{name}:texts"] = evaluate(pt, yt); print(f"{name+':texts':12s} {results[name + ':texts']}", flush=True)
        # (c) text only -> pictures: does a head learned from texts transfer? scored on the shared vocabulary
        net = fit(z(te_emb, tmu), yt[:, :len(vocab)], epochs=E)
        results["text->images"] = evaluate(predict(net, xte), yte); print(f"{'text->images':12s} {results['text->images']}", flush=True)
        # (d) look at the themes: the pictures each theme tag scores highest on, from the mixc model trained on everything
        net = fit(np.concatenate([xtr, z(te_emb, tmu)]), np.concatenate([pad(ytr), yt]), np.concatenate([img_mask, np.ones_like(yt)]), epochs=E)
        allp = predict(net, z(emb))[:, len(vocab):]
        files = list(row)
        (d / "themes_top.json").write_text(json.dumps({t: [files[i] for i in np.argsort(-allp[:, j])[:16]] for j, t in enumerate(themes)}, indent=1))
    (d / "strategies.json").write_text(json.dumps(results, indent=1))
    print("\nbest by mean AUC / F1 / P@k:", sorted(results.items(), key=lambda kv: -kv[1]["auc"])[:3])

if __name__ == "__main__":
    main()
