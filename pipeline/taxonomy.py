"""Automatic tags, eras and clean source descriptions. No per-item judgement."""
import html, re

STOP = {"librivox", "audiobook", "audiobooks", "prelinger", "archives", "film", "films", "movies", "nasa",
        "publicdomain", "public domain", "ephemeral", "ephemeral films", "moving image", "audio", "video", "the", "and"}

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    return re.split(r"\s*[;]\s*", str(v))

def subject_tags(subjects, limit=5):
    seen, out = set(), []
    for raw in subjects:
        for part in re.split(r"\s*[:,;]\s*", raw):
            part = part.strip()
            s = slug(part)
            if not s or s in seen or part.lower() in STOP or s.startswith("fav-") or len(s) > 28 or len(part.split()) > 3 or "fictitious" in s:
                continue
            seen.add(s)
            out.append(s)
    return out[:limit]

def era_tag(year):
    if not year:
        return None
    if year < 1000:
        return "ancient" if year < 500 else "medieval"
    return f"{(year // 100) + 1}th-century" if year < 2000 else f"{(year // 10) * 10}s"

def decade_tag(year):
    return f"{(year // 10) * 10}s" if year else None

def year_of(text):
    m = re.search(r"(1[0-9]{3}|20[0-2][0-9])", str(text or ""))
    return int(m.group(1)) if m else None

def clean_description(raw, limit=240):
    """First sentences of the source description, tags and links stripped."""
    t = html.unescape(re.sub(r"<[^>]+>", " ", raw or ""))
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return ""
    out = ""
    for sentence in re.split(r"(?<=[.!?])\s+", t):
        if len(out) + len(sentence) > limit and out:
            break
        out = f"{out} {sentence}".strip()
    return out[:limit].rstrip(" ,;:") + ("…" if len(out) > limit else "")
