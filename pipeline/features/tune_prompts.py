"""Compares prompt wordings for the zero-shot terms, scored against the works' own source metadata.
    experiments/.venv/bin/python -m pipeline.features.tune_prompts [--dir experiments]
For each term with enough matches in the metadata (tags, title, medium), the AUC of the SigLIP score against that
match says how well the wording separates the works. Prompt variants:
  full      the sentence prompts in prompts.json
  stripped  the same with articles, prepositions and filler words removed
  label     the bare term
  mix       stripped + label, text embeddings averaged
Writes <dir>/tune.json and the winning wordings to pipeline/features/prompts_tuned.json."""
import argparse, json, re
from pathlib import Path
import numpy as np
import torch
from transformers import AutoModel, AutoProcessor

HERE = Path(__file__).parent
STOP = {"a", "an", "the", "of", "with", "and", "or", "in", "on", "at", "by", "for", "to", "is", "are", "image", "picture", "scene", "view"}
MIN_POS = 12
# Source-metadata patterns (regex on tags + title + medium, lower case) standing in for ground truth.
MATCH = {
    "portrait": r"portrait", "landscape": r"landscape", "seascape": r"seascape|marine|sea\b", "cityscape": r"cityscape|city view|townscape",
    "still life": r"still.life", "flowers": r"flower|floral|blossom", "animal": r"animal|beast", "bird": r"\bbird|owl|eagle|duck", "horse": r"horse",
    "dog": r"\bdog", "nude": r"\bnude|naked", "mythology": r"mytholog|venus|apollo|jupiter", "religion": r"saint|christ|madonna|religio|angel|virgin",
    "battle": r"battle|war\b|soldier", "interior": r"interior|room", "architecture": r"architect|building|facade|palace", "church": r"church|cathedral|chapel",
    "ship": r"\bship|boat|vessel", "trees": r"\btree|forest|wood\b", "mountains": r"mountain|alps", "map": r"\bmap\b|cartograph", "manuscript": r"manuscript|codex",
    "textile": r"textile|fabric|embroider|woven", "clothing": r"cloth|dress|costume|garment|suit|hat\b", "fashion": r"fashion|couture", "jewellery": r"jewel|ring\b|necklace|brooch",
    "eyewear": r"glasses|spectacle|pince", "tableware": r"vase|bowl|cup\b|plate|jug", "furniture": r"furniture|chair|table\b", "sculpture": r"sculpture|statue|bust\b",
    "coin": r"\bcoin|medal", "music": r"music|instrument|violin|piano", "street": r"street", "village": r"village|rural", "garden": r"garden", "winter": r"winter|snow",
    "fruit": r"fruit|apple|grape", "skeleton": r"skull|skeleton", "microscopy": r"microscop|cell\b|cells\b",
    "oil painting": r"oil.on|oil paint", "watercolour": r"water.?colou?r|gouache", "drawing": r"drawing|pencil|charcoal|chalk|sketch", "print": r"\bprint|engraving|woodcut|lithograph|etching",
    "etching": r"etching", "photograph": r"photograph|photo\b|gelatin|albumen", "ceramic": r"ceramic|porcelain|pottery|earthenware", "glass": r"\bglass", "metalwork": r"bronze|silver|gold|brass|iron|metal",
    "enamel": r"enamel|cloisonn", "poster": r"poster", "illustration": r"illustrat", "lithograph": r"lithograph", "icon": r"\bicon\b",
    "medieval": r"medieval|gothic|romanesque", "renaissance": r"renaissance", "baroque": r"baroque", "rococo": r"rococo", "neoclassical": r"neoclassic", "romantic": r"romantic",
    "impressionist": r"impressionis", "art nouveau": r"art nouveau|jugend", "art deco": r"art deco", "japanese": r"japan|edo|meiji|ukiyo", "chinese": r"chinese|china|ming\b|qing",
    "islamic": r"islamic|persian|ottoman", "egyptian": r"egypt", "greek roman": r"greek|roman|classical antiq", "documentary photo": r"documentary|reportage",
}

def strip(prompt):
    return " ".join(w for w in re.findall(r"[\w'-]+", prompt.lower()) if w not in STOP)

def auc(score, positive):
    order = np.argsort(score)
    ranks = np.empty(len(score)); ranks[order] = np.arange(1, len(score) + 1)
    n1, n0 = positive.sum(), (~positive).sum()
    return float((ranks[positive].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments")
    ap.add_argument("--model", default="google/siglip2-base-patch16-224")
    args = ap.parse_args()
    d = Path(args.dir)
    meta = json.loads((d / "images.json").read_text())["images"]
    emb = np.load(d / "siglip_emb.npy").astype(np.float32)
    vocab = json.loads((HERE / "prompts.json").read_text())
    terms = [(f, t, p) for f, g in vocab.items() for t, p in g.items()]
    text = [" ".join(r["tags"]).replace("-", " ").lower() + " " + (r["title"] or "").lower() + " " + (r["medium"] or "").lower() for r in meta]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = AutoModel.from_pretrained(args.model).to(device).eval()
    proc = AutoProcessor.from_pretrained(args.model)
    def encode(prompts):
        with torch.no_grad():
            x = proc(text=prompts, padding="max_length", max_length=64, return_tensors="pt").to(device)
            return torch.nn.functional.normalize(model.get_text_features(**x), dim=-1).cpu().numpy()
    full = encode([p for _, _, p in terms])
    stripped = encode([strip(p) for _, _, p in terms])
    label = encode([t for _, t, _ in terms])
    mix = full * 0
    mix = (stripped + label); mix /= np.linalg.norm(mix, axis=1, keepdims=True)
    variants = {"full": full, "stripped": stripped, "label": label, "mix": mix}
    rows = []
    for k, (facet, term, prompt) in enumerate(terms):
        pat = MATCH.get(term)
        if not pat:
            continue
        pos = np.array([bool(re.search(pat, s)) for s in text])
        if pos.sum() < MIN_POS or (~pos).sum() < MIN_POS:
            continue
        rows.append({"facet": facet, "term": term, "positives": int(pos.sum()),
                     **{name: round(auc(emb @ m[k], pos), 3) for name, m in variants.items()}})
    mean = {name: round(float(np.mean([r[name] for r in rows])), 3) for name in variants}
    best = {}
    for k, (facet, term, prompt) in enumerate(terms):
        r = next((r for r in rows if r["term"] == term), None)
        name = max(variants, key=lambda n: r[n]) if r else "mix"  # no evidence for the term: the averaged wording
        best.setdefault(facet, {})[term] = {"full": prompt, "stripped": strip(prompt), "label": term}[name] if name != "mix" else f"{strip(prompt)} | {term}"
    (d / "tune.json").write_text(json.dumps({"terms_evaluated": len(rows), "mean_auc": mean, "rows": rows}, indent=1))
    (HERE / "prompts_tuned.json").write_text(json.dumps(best, indent=1, ensure_ascii=False))
    print("terms evaluated:", len(rows), "mean AUC", mean)

if __name__ == "__main__":
    main()
