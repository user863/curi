"""Moves every published work to SigLIP 2 embeddings reduced to 64 numbers (PCA), then drops the clusters so the next export re-clusters.
    experiments/.venv/bin/python -m pipeline.features.switch_embedding
Images: SigLIP image vectors (experiments/train/emb.npy + experiments/catalog chunks). Passages: text vectors from text_embed.py.
Audio, video and images without a vector: the text tower on "title, creator, tags", the same joint space.
Writes pipeline/siglip_pca64.npz (mean, components) for works added later."""
import json, sqlite3
from pathlib import Path
import numpy as np
import torch
from transformers import AutoModel, AutoProcessor

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "pipeline" / "works.sqlite"
MODEL = "google/siglip2-base-patch16-224"
NAME, DIM = "siglip2-pca-64-v1", 64

def unit(x):
    return x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)

def image_vectors():
    uids, vecs = [], []
    train = ROOT / "experiments" / "train"
    uids += [json.loads(l)["uid"] for l in (train / "manifest.jsonl").read_text().splitlines() if l.strip()]
    vecs.append(np.load(train / "emb.npy").astype(np.float32))
    for f in sorted((ROOT / "experiments" / "catalog").glob("chunk_[0-9]*[0-9].json")):
        uids += json.loads(f.read_text())
        vecs.append(np.load(f.with_suffix(".npy")).astype(np.float32))
    return dict(zip(uids, unit(np.concatenate(vecs))))

def text_vectors(conn, wanted):
    """Text-tower vectors for uid -> text."""
    model = AutoModel.from_pretrained(MODEL).eval()
    proc = AutoProcessor.from_pretrained(MODEL)
    out, items = {}, list(wanted.items())
    with torch.no_grad():
        for i in range(0, len(items), 64):
            batch = items[i:i + 64]
            x = proc(text=[t for _, t in batch], padding="max_length", max_length=64, truncation=True, return_tensors="pt")
            v = torch.nn.functional.normalize(model.get_text_features(**x), dim=-1).numpy()
            out.update(zip([u for u, _ in batch], v))
    return out

def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    works = conn.execute("SELECT id, uid, type FROM work WHERE state='published' ORDER BY id").fetchall()
    img = image_vectors()
    passages = dict(zip(json.loads((ROOT / "experiments/text/emb_uids.json").read_text()), unit(np.load(ROOT / "experiments/text/emb.npy"))))
    needs = {w["uid"]: w for w in works if w["uid"] not in img and w["uid"] not in passages}
    tags = {}
    for r in conn.execute("SELECT w.uid, t.slug FROM work_tag wt JOIN work w ON w.id=wt.work_id JOIN tag t ON t.id=wt.tag_id WHERE w.state='published'"):
        tags.setdefault(r["uid"], []).append(r["slug"].replace("-", " "))
    meta = {r["uid"]: r for r in conn.execute("SELECT w.uid, c.title, c.creator FROM work w JOIN work_card c ON c.work_id=w.id")}
    said = {u: f"{meta[u]['title']}, {meta[u]['creator']}. " + ", ".join(tags.get(u, [])[:12]) if u in meta else ", ".join(tags.get(u, [])) for u in needs}
    txt = text_vectors(conn, said)
    print(f"{len(img)} image vectors, {len(passages)} passages, {len(txt)} from text", flush=True)

    train = np.stack(list(img.values()))
    mean = train.mean(0)
    _, _, vt = np.linalg.svd(train[np.random.default_rng(0).choice(len(train), min(len(train), 20000), replace=False)] - mean, full_matrices=False)
    comp = vt[:DIM].astype(np.float32)
    np.savez(ROOT / "pipeline" / "siglip_pca64.npz", mean=mean.astype(np.float32), components=comp)

    full = {**txt, **passages, **img}
    rows = []
    for w in works:
        v = unit(((full[w["uid"]] - mean) @ comp.T)[None])[0]
        rows.append((w["id"], NAME, DIM, bytes(np.round(v * 127).astype(np.int8).tobytes())))
    conn.executemany("INSERT OR REPLACE INTO work_embedding(work_id, model, dim, vec) VALUES(?,?,?,?)", rows)
    conn.execute("DELETE FROM cluster")
    conn.execute("UPDATE work SET cluster=NULL")
    conn.commit()
    print(f"{len(rows)} works on {NAME}", flush=True)

if __name__ == "__main__":
    main()
