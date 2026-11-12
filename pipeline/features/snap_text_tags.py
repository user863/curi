"""Maps the free tags of the textual works (text_tags.py) onto the image tag vocabulary, so texts and pictures share terms.
    experiments/.venv/bin/python -m pipeline.features.snap_text_tags [--student student1024] [--min-cos 0.8]
Tags that only repeat the title, the author or the kind of text ("epictetus", "poem"), and bare years, are dropped. Each text tag is folded (tags.py); an exact match with a vocabulary term wins, else the nearest term by SigLIP 2 text-tower cosine if
it is at least --min-cos. Tags with no match are kept as `extra` (themes and moods the pictures do not have). Writes
experiments/text/tags.json: {uid: {title, creator, kind, vocab: [...], extra: [...]}} and prints coverage."""
import argparse, json
from collections import Counter
from pathlib import Path
import numpy as np
import torch
from transformers import AutoModel, AutoProcessor
from . import tags as fold

MODEL = "google/siglip2-base-patch16-224"
KIND_WORDS = {"quote", "quotation", "poem", "speech", "excerpt", "passage", "verse", "saying", "sayings"}

def meta_words(r):
    return {w for w in fold.canon(f"{r['title']} {r['creator']}").split()} | KIND_WORDS

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--student", default="student1024")
    ap.add_argument("--min-cos", type=float, default=0.94, help="below ~0.94 SigLIP text similarity matches unrelated phrases")
    args = ap.parse_args()
    vocab = json.loads(Path(f"experiments/train/{args.student}/vocab.json").read_text())
    raw = [json.loads(l) for l in Path("experiments/text/tags_raw.jsonl").read_text().splitlines() if l.strip()]
    heads = fold.heads_of([r["tags"] for r in raw] + [vocab])
    folded = {t: fold.canon(t) for r in raw for t in r["tags"]}
    junk = lambda r, c: not c or c.replace(" ", "").isdigit() or set(c.split()) <= meta_words(r)
    known = set(vocab)
    unknown = sorted({folded[t] for r in raw for t in r["tags"] if not junk(r, folded[t]) and folded[t] not in known})
    model = AutoModel.from_pretrained(MODEL).eval()
    proc = AutoProcessor.from_pretrained(MODEL)
    def embed(texts):
        out = []
        with torch.no_grad():
            for i in range(0, len(texts), 64):
                x = proc(text=texts[i:i + 64], padding="max_length", max_length=64, return_tensors="pt")
                out.append(torch.nn.functional.normalize(model.get_text_features(**x), dim=-1).numpy())
        return np.concatenate(out)
    sim = embed(unknown) @ embed(vocab).T if unknown else np.zeros((0, len(vocab)))
    snap = {u: (vocab[int(sim[i].argmax())], float(sim[i].max())) for i, u in enumerate(unknown)}
    out, exact, near, extra = {}, 0, 0, 0
    for r in raw:
        v, e = [], []
        for t in r["tags"]:
            c = folded[t]
            if junk(r, c):
                continue
            if c in known:
                v.append(c); exact += 1
            elif snap[c][1] >= args.min_cos:
                v.append(snap[c][0]); near += 1
            else:
                e.append(c); extra += 1
        out[r["uid"]] = {"title": r["title"], "creator": r["creator"], "kind": r["kind"], "vocab": list(dict.fromkeys(v)), "extra": list(dict.fromkeys(e))}
    Path("experiments/text/tags.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    total = exact + near + extra
    print(f"{len(out)} works; {total} tags: {exact} exact vocabulary, {near} snapped (cos >= {args.min_cos}), {extra} extra; "
          f"{np.mean([len(v['vocab']) for v in out.values()]):.1f} vocabulary tags per work")
    print("most common vocabulary tags:", Counter(t for v in out.values() for t in v["vocab"]).most_common(15))
    print("most common extra:", Counter(t for v in out.values() for t in v["extra"]).most_common(15))
    print("sample snaps:", [(u, snap[u][0], round(snap[u][1], 2)) for u in unknown[:12]])

if __name__ == "__main__":
    main()
