"""Mood terms, valence and energy for pictures embedded after calibrate.py ran (film key frames).
    experiments/.venv/bin/python -m pipeline.features.affect_norm      # once: writes affect_norm.npz from the corpus
calibrate.py z-scores each term over the corpus and rank-normalises the two axes there. This keeps what is needed to do the
same for one new embedding: per-term mean and std of the cosine, and 1001 quantiles of each raw axis."""
import json
from pathlib import Path
import numpy as np
from .calibrate import AXES
from .embeddings import load_all
from .zeroshot import text_vectors

HERE = Path(__file__).parent
NORM = HERE / "affect_norm.npz"
Q = 1001


def terms():
    return list(json.loads((HERE / "prompts_tuned.json").read_text())["mood"])


def raw_axes(z, names):
    col = {t: i for i, t in enumerate(names)}
    return {k: z[:, [col[t] for t in a["high"]]].mean(1) - z[:, [col[t] for t in a["low"]]].mean(1) for k, a in AXES.items()}


def build():
    names = terms()
    mood = json.loads((HERE / "prompts_tuned.json").read_text())["mood"]
    text = text_vectors([mood[t] for t in names])
    _, emb = load_all()
    cos = emb @ text.T
    mean, std = cos.mean(0), cos.std(0) + 1e-9
    axes = raw_axes((cos - mean) / std, names)
    np.savez(NORM, mean=mean, std=std, **{f"q_{k}": np.quantile(v, np.linspace(0, 1, Q)) for k, v in axes.items()})
    print(f"{len(emb)} pictures, {len(names)} terms -> {NORM}")


def score(emb, text=None):
    """[{mood, valence, energy}] for unit SigLIP 2 vectors (n, 768), as calibrate.py gives the corpus."""
    names = terms()
    spec = json.loads((HERE / "affect.json").read_text())["terms"]
    mood = json.loads((HERE / "prompts_tuned.json").read_text())["mood"]
    n = np.load(NORM)
    text = text_vectors([mood[t] for t in names]) if text is None else text
    z = (emb @ text.T - n["mean"]) / n["std"]
    axes = raw_axes(z, names)
    level = {k: 1 + np.round(254 * np.searchsorted(n[f"q_{k}"], v) / (Q - 1)).clip(0, 254).astype(int) for k, v in axes.items()}
    return [{"mood": [t for j, t in enumerate(names) if spec[t]["publish"] and z[i, j] >= spec[t]["threshold"]],
             "valence": int(level["valence"][i]), "energy": int(level["energy"][i])} for i in range(len(emb))]


if __name__ == "__main__":
    build()
