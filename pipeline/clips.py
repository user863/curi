"""Key scenes of a film as timestamps: {start, end, score, key}. The video is only read, never kept.

analyse() makes one pass over the file and caches the result: 4 fps at 32x32 gray (cuts, motion, luma) and 0.5 fps at
224x224 colour (SigLIP 2 embeddings, text-card flags). pick() works on that cache only, so changing how many clips to take
or how they score costs nothing. A window scores on coherence (one scene), salience (unlike the film as a whole) and motion;
dark, blank and text-card windows lose. Each clip also names its key frame: the sampled frame closest to the window's mean.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

FF = None
SAMPLE = 2.0  # seconds between embedded frames
WINDOW = 30.0  # target clip length
SNAP = 6.0  # an end moves to a cut at most this far
EDGE = 0.05  # skip titles and credits at both ends
GAP = 20.0  # minimum space between clips
PER = 240.0  # one clip per this many seconds of film, between 3 and 24
DARK, BRIGHT = 25, 235  # mean luma outside this is black or blank
MIN_CLIP = 15.0
PROMPTS = ("a title card with text on a plain background", "a film still of people in a place")


def ffmpeg():
    global FF
    if FF is None:
        import imageio_ffmpeg
        FF = imageio_ffmpeg.get_ffmpeg_exe()
    return FF


def decode(src, tmp):
    """One decode of the file into both passes: 4 fps gray 32x32 (n, 32, 32) and 0.5 fps colour 224x224 (m, 224, 224, 3)."""
    tmp = Path(tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    g, c = tmp / "gray.raw", tmp / "rgb.raw"
    graph = f"[0:v]split=2[a][b];[a]fps=4,scale=32:32,format=gray[g];[b]fps={1 / SAMPLE},scale=224:224,format=rgb24[c]"
    subprocess.run([ffmpeg(), "-v", "error", "-y", "-i", str(src), "-an", "-filter_complex", graph,
                    "-map", "[g]", "-f", "rawvideo", str(g), "-map", "[c]", "-f", "rawvideo", str(c)], check=True)
    gray = np.fromfile(g, np.uint8).reshape(-1, 32, 32)
    rgb = np.fromfile(c, np.uint8).reshape(-1, 224, 224, 3)
    g.unlink(); c.unlink()
    return gray, rgb


def frame_at(src, t, out, width=640):
    """One JPEG still at t seconds."""
    subprocess.run([ffmpeg(), "-v", "error", "-y", "-ss", str(t), "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-2",
                    "-q:v", "3", str(out)], check=True)


def motion_and_cuts(gray, fps):
    """Per-step mean difference, and the times (s) of cuts: steps far above the film's typical change."""
    d = np.abs(np.diff(gray.astype(np.int16), axis=0)).mean(axis=(1, 2))
    mid = np.median(d)
    spread = np.median(np.abs(d - mid)) * 1.4826 + 1e-6
    cut = d > mid + 8 * spread + 6
    return d, [float((i + 1) / fps) for i in np.flatnonzero(cut)]


def embed(rgb, batch=32):
    """Unit SigLIP 2 image vectors (n, 768), and per frame whether it is a text card."""
    import torch
    from transformers import AutoModel, AutoProcessor
    name = "google/siglip2-base-patch16-224"
    model, proc = AutoModel.from_pretrained(name).eval(), AutoProcessor.from_pretrained(name)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model.to(device)
    out = []
    with torch.no_grad():
        for i in range(0, len(rgb), batch):
            x = proc(images=list(rgb[i:i + batch]), return_tensors="pt")["pixel_values"].to(device)
            out.append(model.get_image_features(pixel_values=x).cpu().numpy())
        t = proc(text=list(PROMPTS), padding="max_length", max_length=64, return_tensors="pt")["input_ids"].to(device)
        text = model.get_text_features(input_ids=t).cpu().numpy()
    unit = lambda a: a / np.linalg.norm(a, axis=1, keepdims=True)
    v, text = unit(np.concatenate(out)), unit(text)
    return v, (v @ text.T)[:, 0] > (v @ text.T)[:, 1]


def analyse(src, cache=None):
    """Everything pick() needs from the file. Cached in <cache> (an .npz) when given."""
    if cache and Path(cache).exists():
        z = np.load(cache)
        return {k: z[k] for k in z.files}
    gray, rgb = decode(src, Path(cache).parent if cache else "/tmp/clips")
    motion, cuts = motion_and_cuts(gray, 4)
    vec, cards = embed(rgb)
    a = {"duration": np.array(len(gray) / 4), "motion": np.append(motion, motion[-1:]), "cuts": np.array(cuts),
         "luma": gray.mean(axis=(1, 2)), "vec": vec.astype(np.float16), "cards": cards}
    if cache:
        Path(cache).parent.mkdir(parents=True, exist_ok=True)
        np.savez(cache, **a)
    return a


def z(x):
    x = np.asarray(x, float)
    return (x - x.mean()) / (x.std() + 1e-9)


def windows(duration, cuts):
    """Candidate [start, end]: start at each cut or every 10 s, end WINDOW later, moved to a nearby cut."""
    starts = sorted(set([round(float(c), 1) for c in cuts] + list(np.arange(0, duration, 10.0))))
    out = []
    for s in starts:
        e = s + WINDOW
        if e > duration:
            continue
        near = [c for c in cuts if abs(c - e) <= SNAP and c - s >= MIN_CLIP]
        out.append((s, float(min(near, key=lambda c: abs(c - e))) if near else e))
    return out


def span(s, e):
    """Sample indices [a, b) of the embedded frames inside [s, e]."""
    a = int(s / SAMPLE)
    return a, max(int(e / SAMPLE), a + 2)


def score(wins, a):
    """One score per window, from the sampled embeddings (every SAMPLE s) and luma and motion (4 fps)."""
    vec = a["vec"].astype(np.float32)
    film = vec.mean(axis=0)
    film /= np.linalg.norm(film)
    coh, sal, mot, dark, text = [], [], [], [], []
    for s, e in wins:
        i, j = span(s, e)
        m = vec[i:j].mean(axis=0)
        m /= np.linalg.norm(m)
        coh.append(float((vec[i:j] @ m).mean()))
        sal.append(float(1 - m @ film))
        mot.append(float(a["motion"][int(s * 4):int(e * 4)].mean()))
        dark.append(float(a["luma"][int(s * 4):int(e * 4) + 1].mean()))
        text.append(float(a["cards"][i:j].mean()))
    bad = np.array([d < DARK or d > BRIGHT for d in dark], float)
    return z(coh) + z(sal) + z(mot) - 3 * bad - 6 * np.array(text)  # text cards and black are not scenes


def unusable(a, i):
    """The sampled frame i is a text card or near black or blank."""
    luma = a["luma"][min(i * int(SAMPLE * 4), len(a["luma"]) - 1)]
    return bool(a["cards"][i]) or luma < DARK or luma > BRIGHT


def trim(a, s, e):
    """Move the ends inward past text cards and black frames, keeping at least MIN_CLIP."""
    i, j = span(s, e)
    while i < j - 1 and e - s > MIN_CLIP and unusable(a, i):
        i, s = i + 1, s + SAMPLE
    while j - 1 > i and e - s > MIN_CLIP and unusable(a, j - 1):
        j, e = j - 1, e - SAMPLE
    return s, e


def keyframe(a, s, e):
    """Index of the sampled frame inside [s, e] closest to the window's mean, never a text card or black frame."""
    vec = a["vec"].astype(np.float32)
    i, j = span(s, e)
    m = vec[i:j].mean(axis=0)
    sim = vec[i:j] @ m
    ok = [k for k in range(j - i) if not unusable(a, i + k)] or list(range(j - i))
    return i + max(ok, key=lambda k: sim[k])


def pick(a, per=PER, k=None):
    """Best windows first, no two closer than GAP, none in the first or last EDGE of the film. Each: start, end, score, key (s)."""
    duration = float(a["duration"])
    wins = windows(duration, a["cuts"].tolist())
    scores = score(wins, a)
    k = k or int(np.clip(duration / per, 3, 24))
    chosen = []
    for n in np.argsort(-scores):
        s, e = wins[n]
        if s < duration * EDGE or e > duration * (1 - EDGE):
            continue
        if all(e + GAP <= s2 or s >= e2 + GAP for s2, e2, _ in chosen):
            chosen.append((s, e, float(scores[n])))
        if len(chosen) == k:
            break
    out = []
    for s, e, c in sorted(chosen):
        s, e = trim(a, s, e)
        out.append({"start": round(s, 1), "end": round(e, 1), "score": round(c, 2), "key": keyframe(a, s, e) * SAMPLE})
    return out


def scenes(src, cache=None, per=PER):
    a = analyse(src, cache)
    return {"duration": float(a["duration"]), "cuts": len(a["cuts"]), "clips": pick(a, per)}


if __name__ == "__main__":
    src, out = sys.argv[1], Path(sys.argv[2])
    out.write_text(json.dumps(scenes(src, cache=out.with_suffix(".npz")), indent=1))
    print(out.read_text())
