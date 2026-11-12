"""SigLIP 2 text-tower embeddings of the textual works, from the text itself (not from their tags), in the same space as the image embeddings.
    experiments/.venv/bin/python -m pipeline.features.text_embed
A work is split into sentences (prose) or lines (verse), each embedded (64 tokens at most) and averaged, then L2-normalised.
Writes experiments/text/emb.npy (float32, one row per work) and emb_uids.json."""
import json, re, sqlite3
from pathlib import Path
import numpy as np
import torch
from transformers import AutoModel, AutoProcessor

MODEL = "google/siglip2-base-patch16-224"
DB = Path(__file__).resolve().parents[1] / "works.sqlite"

def pieces(body, verse):
    parts = [l.strip() for l in body.split("\n")] if verse else re.findall(r"[^.!?]+[.!?]*", body)
    parts = [p.strip() for p in parts if len(p.strip()) > 3]
    # lines of a poem are short: pair them so a piece carries some meaning
    return [" ".join(parts[i:i + 2]) for i in range(0, len(parts), 2)] if verse else parts

def main():
    conn = sqlite3.connect(DB)
    rows = conn.execute("""SELECT w.uid, t.body, t.verse FROM work w JOIN work_text t ON t.work_id = w.id
                           WHERE w.state = 'published' AND w.type = 'passage' ORDER BY w.id""").fetchall()
    model = AutoModel.from_pretrained(MODEL).eval()
    proc = AutoProcessor.from_pretrained(MODEL)
    out = []
    with torch.no_grad():
        for uid, body, verse in rows:
            ps = pieces(body, bool(verse)) or [body[:200]]
            x = proc(text=ps, padding="max_length", max_length=64, truncation=True, return_tensors="pt")
            v = torch.nn.functional.normalize(model.get_text_features(**x), dim=-1).mean(0)
            out.append(torch.nn.functional.normalize(v, dim=0).numpy())
    Path("experiments/text").mkdir(parents=True, exist_ok=True)
    np.save("experiments/text/emb.npy", np.stack(out).astype(np.float32))
    Path("experiments/text/emb_uids.json").write_text(json.dumps([r[0] for r in rows]))
    print(len(out), "works embedded")

if __name__ == "__main__":
    main()
