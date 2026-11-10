"""Public-domain quotes, poems and speeches from chosen Project Gutenberg books, extracted by rule.
The books and their authors' death years are in config.json ("texts"); the public-domain gate and every passage
come from the text itself: no per-passage picking. Three kinds:
  quote   numbered sayings and aphorisms, short paragraphs
  poem    whole poems (or their first stanzas) from single-author collections
  speech  paragraphs from orations and addresses"""
import datetime, re
from .. import quality, rights, state, taxonomy
from ..http import get_text
from .common import reject, stable_pick, TONES
from .gutenberg import strip_boilerplate, sentence_lengths

NAME = "texts"
TERMINAL = '.!?"”’)'
MARKER = re.compile(r"^\s*(?:[IVXLC]+|\d{1,3})\.?\s*$")        # a section number alone on its line
LEAD_MARKER = re.compile(r"^(?:[IVXLC]+|\d{1,3})\.\s+")         # "IV. Begin the morning..."
BAD = re.compile(r"\[|\]|Illustration|CHAPTER|Chapter |Footnote|\bET AL\b|_{2,}|https?:|www\.|\([ivxlc]+\.\s?\d+|Project Gutenberg")
POEM_MAX_LINES = 16

def text_url(book_id):
    return f"https://www.gutenberg.org/cache/epub/{book_id}/pg{book_id}.txt"

def blocks(body):
    """Blank-line separated blocks as (lines, gap_before) where gap_before counts the blank lines above."""
    out, cur, gap = [], [], 0
    for line in body.replace("\r", "").split("\n"):
        if line.strip():
            cur.append(line.rstrip())
        else:
            if cur:
                out.append((cur, gap))
                cur, gap = [], 0
            gap += 1
    if cur:
        out.append((cur, gap))
    return out

def words_of(text):
    return text.split()

def diversity(text):
    w = [x.lower().strip(".,;:!?\"“”’") for x in words_of(text)]
    return len(set(w)) / max(1, len(w))

def prose_paragraph(lines):
    """The paragraph as one string, or None for indented notes and anything that is not plain prose."""
    if any(l.startswith("    ") for l in lines):
        return None
    t = re.sub(r"\s+", " ", " ".join(l.strip() for l in lines)).replace("--", "—")
    return t

def strip_marker(t):
    return LEAD_MARKER.sub("", t)

def sayings(body, spec):
    lo, hi = spec.get("min_words", 14), spec.get("max_words", 75)
    out = []
    for i, (lines, _) in enumerate(blocks(body)):
        if len(lines) == 1 and MARKER.match(lines[0]):
            continue
        t = prose_paragraph(lines)
        if not t:
            continue
        t = strip_marker(t)
        n = len(words_of(t))
        if not lo <= n <= hi or BAD.search(t) or not t[0].isupper() or t[-1] not in TERMINAL or t.count('"') % 2:
            continue
        brevity = max(0.0, 1 - abs(n - 34) / 45)
        out.append((0.6 * brevity + 0.4 * min(1.0, diversity(t) / 0.8), i, t))
    return out

def speeches(body, spec):
    lo, hi = spec.get("min_words", 45), spec.get("max_words", 140)
    out = []
    for i, (lines, _) in enumerate(blocks(body)):
        t = prose_paragraph(lines)
        if not t:
            continue
        n = len(words_of(t))
        if not lo <= n <= hi or BAD.search(t) or not t[0].isupper() or t[-1] not in TERMINAL:
            continue
        lens = sentence_lengths(t)
        if len(lens) < 2 or sum(w.isupper() and len(w) > 2 for w in words_of(t)) > 2:
            continue
        fit = max(0.0, 1 - abs(sum(lens) / len(lens) - 20) / 16)
        out.append((0.5 * fit + 0.5 * min(1.0, diversity(t) / 0.8), i, t))
    return out

def verse_block(lines):
    """Short lines with sentence punctuation: a stanza, not a table of contents or a wrapped paragraph."""
    if len(lines) < 2 or any(len(l.strip()) > 78 for l in lines) or BAD.search(" ".join(lines)):
        return False
    avg = sum(len(l.strip()) for l in lines) / len(lines)
    punct = sum(any(c in l for c in ",;:.!?—-'’") for l in lines) / len(lines)
    upper = sum(l.strip()[:1].isupper() for l in lines) / len(lines)
    return avg < 56 and punct >= 0.4 and upper >= 0.4 and not all(l.strip().isupper() for l in lines)

def clean_title(lines):
    t = " ".join(l.strip() for l in lines).strip().rstrip(".")
    if not t or len(t.split()) > 8 or MARKER.match(t) or t.isdigit():
        return None
    return t.title() if t.isupper() else t

def poems(body, spec):
    """Runs of stanzas separated by single blank lines; two or more blank lines end a poem."""
    bl = blocks(body)
    runs, cur = [], []
    for k, (lines, gap) in enumerate(bl):
        if verse_block(lines):
            if cur and gap >= 2:
                runs.append(cur)
                cur = []
            cur.append(k)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    out = []
    for run in runs:
        indent = min(len(l) - len(l.lstrip()) for k in run for l in bl[k][0])
        stanzas = [[l[indent:].rstrip() for l in bl[k][0] if not MARKER.match(l)] for k in run]
        title = None
        for back in range(1, 4):  # the heading above: a short line, skipping a bare number
            if run[0] - back < 0:
                break
            lines, _ = bl[run[0] - back]
            if len(lines) <= 2 and not verse_block(lines) and not (len(lines) == 1 and MARKER.match(lines[0])):
                title = clean_title(lines)
                break
        picked, count = [], 0
        for st in stanzas:
            if count + len(st) > POEM_MAX_LINES:
                break
            picked.append(st)
            count += len(st)
        if count < spec.get("min_lines", 4):
            continue
        whole = len(picked) == len(stanzas)
        body_text = "\n\n".join("\n".join(st) for st in picked)
        n = len(words_of(body_text))
        if n > 140:
            continue
        score = 0.35 * whole + 0.35 * min(1.0, diversity(body_text) / 0.8) + 0.3 * max(0.0, 1 - abs(count - 12) / 10)
        out.append((score, run[0], body_text, title))
    return out

def candidates(text, spec):
    body = strip_boilerplate(text)
    if spec.get("after"):  # skip an editor's introduction: start at this phrase
        body = body[max(0, body.find(spec["after"])):]
    body = body[int(len(body) * spec.get("skip_frac", 0)):]
    kind = spec["kind"]
    if kind == "poem":
        return poems(body, spec)
    return [(s, i, t, None) for s, i, t in (sayings(body, spec) if kind == "quote" else speeches(body, spec))]

def spread(scored, count, gap):
    """Best first, but no two from neighbouring places in the book."""
    picked = []
    for s, i, t, title in sorted(scored, key=lambda x: x[0], reverse=True):
        if all(abs(i - j) > gap for _, j, _, _ in picked):
            picked.append((s, i, t, title))
        if len(picked) == count:
            break
    return picked

def run(cfg, stats):
    today = datetime.date.today().isoformat()
    out, seen = [], set()  # seen: the same passage can sit in two books (a speech in a collection and on its own)
    for spec in cfg["books"]:
        gate = rights.gutenberg_gate([{"death_year": spec["death"]}])
        if gate != "yes":
            reject(stats, NAME, f"author-death-{gate}")
            continue
        try:
            text = get_text(text_url(spec["id"]), delay=1.0)
        except Exception:
            reject(stats, NAME, "fetch-failed")
            continue
        kind, creator = spec["kind"], spec["creator"]
        era = taxonomy.era_tag(spec["death"])
        tags = [kind] + spec.get("tags", []) + ([era] if era else [])
        for score, idx, passage, title in spread(candidates(text, spec), spec["count"], spec.get("gap", 3)):
            key = re.sub(r"\W+", "", passage.lower())[:80]
            if key in seen:
                reject(stats, NAME, "duplicate-passage")
                continue
            seen.add(key)
            cid = f"pg-{spec['id']}-{idx}"
            if state.is_known(cid):
                reject(stats, NAME, "known")
                continue
            out.append({
                "id": cid, "type": "passage", "title": title or spec["title"], "creator": creator, "date": spec.get("date", ""),
                "source": {"institution": "Project Gutenberg", "url": f"https://www.gutenberg.org/ebooks/{spec['id']}",
                           "sourceId": str(spec["id"]), "fetchedAt": today, "work": spec["title"]},
                "rights": rights.rights("PDM", "worldwide", f"{creator}, {spec['title']} (public domain, via Project Gutenberg)", "passage"),
                "text": {"body": passage, "verse": kind == "poem"},
                "editorial": {"note": "", "noteSource": "source", "room": "words", "tags": tags, "tone": stable_pick(cid, TONES)},
                "_score": quality.combine([(1.0, score)]), "_group": creator, "_source": NAME,
            })
    return out
