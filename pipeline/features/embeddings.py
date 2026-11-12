"""All raw SigLIP 2 image embeddings (768-d, unit) on disk: the training set and the catalog chunks of embed_rest.py."""
import json
from pathlib import Path
import numpy as np

def load_all(train="experiments/train", catalog="experiments/catalog"):
    """(uids, float32 array) in one order; a uid in both comes from the catalog."""
    train, catalog = Path(train), Path(catalog)
    uid_of = {json.loads(l)["file"]: json.loads(l)["uid"] for l in (train / "manifest.jsonl").read_text().splitlines() if l.strip()}
    files = json.loads((train / "emb_files.json").read_text())
    parts = {u: i for i, u in ((i, uid_of[f]) for i, f in enumerate(files) if f in uid_of)}
    first = np.load(train / "emb.npy", mmap_mode="r")
    uids, rows = list(parts), [first[i] for i in parts.values()]
    out = dict(zip(uids, rows))
    for f in sorted(catalog.glob("chunk_[0-9]*[0-9].npy")):
        for u, v in zip(json.loads(f.with_suffix(".json").read_text()), np.load(f, mmap_mode="r")):
            out[u] = v
    keys = list(out)
    return keys, np.stack([np.asarray(out[k], dtype=np.float32) for k in keys])
