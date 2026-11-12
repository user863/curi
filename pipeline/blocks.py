"""The 96-d work vector: semantic block (SigLIP 2, PCA 64) + vocabulary block (24) + colour and era block (8).
Each block is unit length, then scaled so its share of the squared norm is its weight (semantic 0.60, vocabulary 0.25,
colour and era 0.15): the cosine of two vectors is the weighted sum of the blocks' cosines.
The vocabulary basis and the block means are fixed in pipeline/blocks_basis.npz, built once by `python3 -m pipeline.blocks`,
so interests a reader's device learned in this space stay valid when the pack is exported again.
Pure apart from numpy and that file."""
import math
from pathlib import Path
import numpy as np

SEM, VOCAB, COLOUR = 64, 24, 8
DIM = SEM + VOCAB + COLOUR
WEIGHT = (0.60, 0.25, 0.15)
BASIS = Path(__file__).parent / "blocks_basis.npz"
TAGS = 3000      # most used tags that carry a vocabulary vector
MIN_USES = 20
HUES = ["red", "orange", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "magenta", "pink"]
ERA_FROM, ERA_SPAN = 1400, 600  # year mapped to -1..1 around the middle of the range

def unit(x):
    return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-9)

def colour_raw(features, year):
    """8 numbers: lightness, contrast, warmth, chroma, monochrome, hue cos and sin (weighted by chroma), era. Zeros without colour."""
    era = 0.0 if year is None else max(-1.0, min(1.0, (year - ERA_FROM - ERA_SPAN / 2) / (ERA_SPAN / 2)))
    if not features:
        return np.array([0, 0, 0, 0, 0, 0, 0, era], dtype=np.float64)
    angle = HUES.index(features["hue"]) * 2 * math.pi / len(HUES) if features["hue"] in HUES else 0.0
    chroma = min(1.0, features["chroma"] * 4)
    return np.array([features["lightness"], features["contrast"], features["warmth"], chroma, float(features["monochrome"]),
                     chroma * math.cos(angle), chroma * math.sin(angle), era])

def tag_matrix(tag_lists, index):
    """works x tags, 1 where the work has the tag (rows normalised), for the tags in index {slug: column}."""
    m = np.zeros((len(tag_lists), len(index)), dtype=np.float32)
    for i, tags in enumerate(tag_lists):
        for t in tags:
            if t in index:
                m[i, index[t]] = 1
    return m

def build_basis(tag_lists, colour_rows):
    """Vocabulary basis from the tag co-occurrence of the catalogue, and the means of the colour and era numbers."""
    count = {}
    for tags in tag_lists:
        for t in set(tags):
            count[t] = count.get(t, 0) + 1
    slugs = [t for t, n in sorted(count.items(), key=lambda x: (-x[1], x[0])) if n >= MIN_USES][:TAGS]
    index = {t: i for i, t in enumerate(slugs)}
    m = tag_matrix(tag_lists, index)
    co = m.T @ m
    d = np.sqrt(np.maximum(np.diag(co), 1))
    values, vectors = np.linalg.eigh(co / np.outer(d, d))
    top = np.argsort(values)[::-1][:VOCAB]
    comp = (vectors[:, top] * np.sqrt(np.maximum(values[top], 0))).astype(np.float32)
    comp = np.pad(comp, ((0, 0), (0, VOCAB - comp.shape[1])))  # a small catalogue has fewer components
    raw = np.array(colour_rows)
    return {"slugs": np.array(slugs), "comp": comp, "tagMean": (unit_rows(m, comp)).mean(0), "colourMean": raw.mean(0), "colourScale": raw.std(0) + 1e-6}

def unit_rows(m, comp):
    return m @ comp / np.maximum(m.sum(1, keepdims=True), 1)

def save_basis(basis):
    np.savez(BASIS, **basis)

def load_basis():
    z = np.load(BASIS)
    return {k: z[k] for k in z.files}

def extend(sem, tag_lists, colour_rows, basis):
    """sem: n x 64 unit float rows; returns n x 96 float rows (blocks scaled by the weights), unit length overall."""
    index = {t: i for i, t in enumerate(basis["slugs"].tolist())}
    v = unit(unit_rows(tag_matrix(tag_lists, index), basis["comp"]) - basis["tagMean"])
    c = unit((np.array(colour_rows) - basis["colourMean"]) / basis["colourScale"])
    return np.hstack([unit(sem) * math.sqrt(WEIGHT[0]), v * math.sqrt(WEIGHT[1]), c * math.sqrt(WEIGHT[2])])

def to_int8(x):
    return np.round(unit(x) * 127).astype(np.int8)
