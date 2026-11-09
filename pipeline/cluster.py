"""Stable clustering of embeddings for sharded delivery (needs numpy).
Clusters are created once and then kept: new works join the nearest existing cluster, so a rerun
only changes the shards that received new works. A full re-cluster happens only when the catalogue
has grown to twice what the clusters were sized for."""
import math
import numpy as np

TARGET = 128  # works per cluster
MIN_K = 4
CHUNK = 8192

def decode(blobs):
    """bytes (unsigned int8 storage) -> unit float32 rows"""
    m = np.frombuffer(b"".join(blobs), dtype=np.int8).reshape(len(blobs), -1).astype(np.float32)
    return m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)

def nearest(x, cent):
    out = np.empty(len(x), dtype=np.int64)
    for i in range(0, len(x), CHUNK):
        out[i:i + CHUNK] = np.argmax(x[i:i + CHUNK] @ cent.T, axis=1)
    return out

def kmeans(x, k, iters=12, seed=7):
    rng = np.random.default_rng(seed)
    cent = x[rng.choice(len(x), k, replace=False)].copy()
    for _ in range(iters):
        a = nearest(x, cent)
        sums = np.zeros_like(cent)
        np.add.at(sums, a, x)
        counts = np.bincount(a, minlength=k)
        empty = counts == 0
        sums[empty] = x[rng.choice(len(x), int(empty.sum()))] if empty.any() else sums[empty]
        cent = sums / (np.linalg.norm(sums, axis=1, keepdims=True) + 1e-9)
    return cent

def to_int8(cent):
    return np.round(cent * 127).astype(np.int8)

def ensure(conn, target=TARGET):
    """Make sure every published work has a cluster. Returns {k, reclustered, assigned}."""
    rows = conn.execute("""SELECT w.id, w.cluster, e.vec FROM work w JOIN work_embedding e ON e.work_id=w.id
                           WHERE w.state='published' ORDER BY w.id""").fetchall()
    if not rows:
        return {"k": 0, "reclustered": False, "assigned": 0}
    x = decode([r["vec"] for r in rows])
    existing = conn.execute("SELECT id, centroid FROM cluster ORDER BY id").fetchall()
    k_needed = max(MIN_K, math.ceil(len(rows) / target))
    if not existing or k_needed > 2 * len(existing):
        k = min(k_needed, len(rows))
        cent = to_int8(kmeans(x, k))
        conn.execute("DELETE FROM cluster")
        conn.executemany("INSERT INTO cluster(id, centroid) VALUES(?, ?)", [(i, cent[i].tobytes()) for i in range(k)])
        conn.executemany("UPDATE work SET cluster=? WHERE id=?",
                         [(int(c), r["id"]) for c, r in zip(nearest(x, decode([cent[i].tobytes() for i in range(k)])), rows)])
        return {"k": k, "reclustered": True, "assigned": len(rows)}
    ids = [e["id"] for e in existing]
    cent = decode([e["centroid"] for e in existing])
    todo = [i for i, r in enumerate(rows) if r["cluster"] is None or r["cluster"] not in ids]
    if todo:
        a = nearest(x[todo], cent)
        conn.executemany("UPDATE work SET cluster=? WHERE id=?", [(ids[int(c)], rows[i]["id"]) for c, i in zip(a, todo)])
    return {"k": len(existing), "reclustered": False, "assigned": len(todo)}
