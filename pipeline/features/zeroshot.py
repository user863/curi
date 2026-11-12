"""Zero-shot mood scores of every embedded picture: the cosine of its SigLIP 2 embedding to each mood prompt, then a z-score per term.
    experiments/.venv/bin/python -m pipeline.features.zeroshot [--out experiments/affect]
Prompts: the "mood" facet of prompts_tuned.json. Writes <out>/scores.npz (uids, terms, z: n x terms) for calibrate.py."""
import argparse, json
from pathlib import Path
import numpy as np
import torch
from transformers import AutoModel, AutoProcessor
from .embed_train import MODEL
from .embeddings import load_all

HERE = Path(__file__).parent

def text_vectors(prompts):
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = AutoModel.from_pretrained(MODEL).to(device).eval()
    proc = AutoProcessor.from_pretrained(MODEL)
    with torch.no_grad():
        x = proc(text=prompts, padding="max_length", max_length=64, return_tensors="pt").to(device)
        return torch.nn.functional.normalize(model.get_text_features(**x), dim=-1).cpu().numpy()

def zscores(emb, text):
    cos = emb @ text.T
    return (cos - cos.mean(0)) / (cos.std(0) + 1e-9)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="experiments/affect")
    out = Path(ap.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    mood = json.loads((HERE / "prompts_tuned.json").read_text())["mood"]
    terms = list(mood)
    uids, emb = load_all()
    z = zscores(emb, text_vectors([mood[t] for t in terms]))
    np.savez(out / "scores.npz", uids=np.array(uids), terms=np.array(terms), z=z.astype(np.float32))
    print(f"{len(uids)} pictures x {len(terms)} terms")

if __name__ == "__main__":
    main()
