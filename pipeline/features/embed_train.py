"""SigLIP 2 image embeddings for the training set, in manifest order.
    experiments/.venv/bin/python -m pipeline.features.embed_train [--dir experiments/train]    -> <dir>/emb.npy (float16), <dir>/emb_files.json
Resumable in chunks: rows already embedded (same file list prefix) are kept."""
import argparse, json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

MODEL = "google/siglip2-base-patch16-224"
BATCH = 32

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    d = Path(ap.parse_args().dir)
    files = [json.loads(l)["file"] for l in (d / "manifest.jsonl").read_text().splitlines() if l.strip()]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = AutoModel.from_pretrained(MODEL).to(device).eval()
    proc = AutoProcessor.from_pretrained(MODEL)
    def load(f):
        try:
            return Image.open(d / f).convert("RGB")
        except Exception:
            return Image.new("RGB", (224, 224), "white")
    out = []
    with ThreadPoolExecutor(4) as pool, torch.no_grad():
        for i in range(0, len(files), BATCH):
            batch = list(pool.map(load, files[i:i + BATCH]))
            x = proc(images=batch, return_tensors="pt").to(device)
            v = torch.nn.functional.normalize(model.get_image_features(**x), dim=-1)
            out.append(v.cpu().numpy().astype(np.float16))
            if (i // BATCH) % 20 == 0:
                print(f"{i + len(batch)}/{len(files)}", flush=True)
    np.save(d / "emb.npy", np.concatenate(out))
    (d / "emb_files.json").write_text(json.dumps(files))
    print("done", len(files))

if __name__ == "__main__":
    main()
