"""Embeddings: SigLIP 2 vectors reduced to 64 numbers (PCA, int8), one space for pictures and text.
Stored vectors come from features/switch_embedding.py. A work added later is embedded here from its text
(title, creator, tags) through the SigLIP text tower; run the pipeline with experiments/.venv/bin/python for that.
Re-run embed_rest and switch_embedding to give new pictures their image vectors."""
from functools import lru_cache
from pathlib import Path

DIM = 64
MODEL = "siglip2-pca-64-v1"
SIGLIP = "google/siglip2-base-patch16-224"
PCA = Path(__file__).parent / "siglip_pca64.npz"

@lru_cache(maxsize=1)
def _tower():
    import numpy as np
    from transformers import AutoModel, AutoProcessor
    pca = np.load(PCA)
    return AutoModel.from_pretrained(SIGLIP).eval(), AutoProcessor.from_pretrained(SIGLIP), pca["mean"], pca["components"]

def text_of(card):
    ed = card["editorial"]
    return f"{card['title']}, {card['creator']}. " + ", ".join(t.replace("-", " ") for t in ed["tags"][:12])

def embed(card):
    import numpy as np
    import torch
    model, proc, mean, comp = _tower()
    with torch.no_grad():
        x = proc(text=[text_of(card)], padding="max_length", max_length=64, truncation=True, return_tensors="pt")
        v = torch.nn.functional.normalize(model.get_text_features(**x), dim=-1).numpy()[0]
    p = (v - mean) @ comp.T
    return bytes(np.round(p / (np.linalg.norm(p) + 1e-9) * 127).astype(np.int8).tobytes())

def to_int8(blob):
    return [b - 256 if b > 127 else b for b in blob]
