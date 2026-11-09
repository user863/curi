"""Stand-in embeddings: signed feature hashing into 64 dims, int8.
Cosine similarity tracks shared tags, room and type. Swap for CLIP/SigLIP/text embeddings later;
the pack format and the client do not change (dim and model are in the manifest)."""
import hashlib, math

DIM = 64
MODEL = "feature-hash-64-v1"

def feature_vec(feature):
    raw = hashlib.sha256(feature.encode()).digest() + hashlib.sha256(b"2" + feature.encode()).digest()
    return [(b - 127.5) / 73.6 for b in raw[:DIM]]  # roughly unit variance

def unit(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]

def features(card):
    ed = card["editorial"]
    out = {f"r:{ed['room']}": 1.5, f"k:{card['type']}": 0.5}
    out.update({f"t:{t}": 1.0 for t in ed["tags"]})
    return out

def embed(card):
    acc = [0.0] * DIM
    for f, w in features(card).items():
        for i, x in enumerate(feature_vec(f)):
            acc[i] += w * x
    return bytes((round(x * 127) & 0xFF) for x in unit(acc))  # int8 as unsigned bytes

def to_int8(blob):
    return [b - 256 if b > 127 else b for b in blob]
