"""SigLIP 2 features: an image embedding per picture, and zero-shot scores against pipeline/features/prompts.json.
Optional stage with its own dependencies (torch, transformers); run it from the venv:
    experiments/.venv/bin/python -m pipeline.features.siglip [--dir experiments] [--model google/siglip2-base-patch16-224]
Writes <dir>/siglip_emb.npy (float16, one row per image in images.json order) and <dir>/siglip_tags.json."""
import argparse, json
from pathlib import Path
import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

HERE = Path(__file__).parent
PROMPTS = HERE / "prompts_tuned.json"   # run tune_prompts first; falls back to prompts.json
TOP = 8
TOP_FACET = 4
MIN_Z = 2.5  # a term counts for an image when its logit is this many standard deviations above the term's mean over all images
# Scores are sigmoids, independent per term and small in absolute terms, so terms are ranked inside their facet and
# also given a z-score against the other images (a stand-in for the per-term thresholds calibrated on tagged works).

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments")
    ap.add_argument("--model", default="google/siglip2-base-patch16-224")
    args = ap.parse_args()
    d = Path(args.dir)
    meta = json.loads((d / "images.json").read_text())["images"]
    vocab = json.loads((PROMPTS if PROMPTS.exists() else HERE / "prompts.json").read_text())
    terms = [(facet, term, prompt) for facet, group in vocab.items() for term, prompt in group.items()]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = AutoModel.from_pretrained(args.model).to(device).eval()
    proc = AutoProcessor.from_pretrained(args.model)
    with torch.no_grad():
        def encode(prompts):
            x = proc(text=prompts, padding="max_length", max_length=64, return_tensors="pt").to(device)
            return torch.nn.functional.normalize(model.get_text_features(**x), dim=-1)
        # "a | b": several wordings of one term, embeddings averaged
        t = torch.nn.functional.normalize(torch.stack([encode([w.strip() for w in p.split("|")]).mean(0) for _, _, p in terms]), dim=-1)
        embs, scores = [], []
        for i in range(0, len(meta), 16):
            batch = [Image.open(d / r["file"]).convert("RGB") for r in meta[i:i + 16]]
            x = proc(images=batch, return_tensors="pt").to(device)
            v = torch.nn.functional.normalize(model.get_image_features(**x), dim=-1)
            logits = v @ t.T * model.logit_scale.exp() + model.logit_bias
            embs.append(v.cpu().numpy()); scores.append(logits.cpu().numpy())
    emb, logit = np.concatenate(embs), np.concatenate(scores)
    prob = 1 / (1 + np.exp(-logit))
    np.save(d / "siglip_emb.npy", emb.astype(np.float16))
    z = (logit - logit.mean(0)) / (logit.std(0) + 1e-9)
    out = {}
    for r, row, zr in zip(meta, prob, z):
        by = {}
        for (facet, term, _), p, zz in zip(terms, row, zr):
            by.setdefault(facet, []).append((term, float(p), float(zz)))
        out[r["file"]] = {facet: [{"term": t_, "p": round(p, 3), "z": round(zz, 1)} for t_, p, zz in sorted(v, key=lambda x: -x[2])[:TOP_FACET] if zz >= MIN_Z] for facet, v in by.items()}
    (d / "siglip_tags.json").write_text(json.dumps({"model": args.model, "terms": len(terms), "images": out}, indent=1, ensure_ascii=False))
    print(f"{len(meta)} images, {len(terms)} terms, embedding dim {emb.shape[1]}, device {device}")

if __name__ == "__main__":
    main()
