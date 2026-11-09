"""Project Gutenberg via Gutendex: popular English books, author-death gate, automatic passage extraction."""
import datetime, math, re
from .. import quality, rights, state, taxonomy
from ..http import get_json, get_text
from .common import reject, stable_pick, TONES

NAME = "gutenberg"
JUNK_BOOK = re.compile(r"(?i)bible|dictionary|encyclop|cook|manual|letters|complete works|collected|index|catalog")

def strip_boilerplate(text):
    start = re.search(r"\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n", text)
    end = re.search(r"\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG", text)
    return text[start.end(): end.start() if end else None] if start else text

def paragraphs(body):
    for block in re.split(r"\n\s*\n", body.replace("\r", "")):
        lines = [l for l in block.split("\n") if l.strip()]
        if lines:
            yield lines

def sentence_lengths(text):
    return [len(s.split()) for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]

def passage_score(lines, text):
    """0..1 'quotability': prose, mid-length sentences, varied vocabulary, little dialogue."""
    words = text.split()
    n = len(words)
    if not 45 <= n <= 140 or sum(len(l) for l in lines) / len(lines) < 45:
        return 0.0
    if re.search(r"\[|\]|Illustration|CHAPTER|Chapter|\d{3}", text) or not text[0].isupper() or text[-1] not in '.!?"”’':
        return 0.0
    if sum(w.isupper() and len(w) > 2 for w in words) > 2 or len(re.findall(r"[“”\"]", text)) / n > 0.03:
        return 0.0
    lens = sentence_lengths(text)
    if len(lens) < 2:
        return 0.0
    avg = sum(lens) / len(lens)
    sentence_fit = max(0.0, 1 - abs(avg - 20) / 15)
    diversity = len({w.lower().strip(".,;:!?") for w in words}) / n
    return 0.5 * sentence_fit + 0.5 * min(1.0, diversity / 0.8)

def best_passages(text, count):
    body = strip_boilerplate(text)
    paras = list(paragraphs(body))
    lo, hi = int(len(paras) * 0.05), int(len(paras) * 0.95)
    scored = []
    for i, lines in enumerate(paras[lo:hi], lo):
        joined = re.sub(r"\s+", " ", " ".join(l.strip() for l in lines)).replace("--", "—")
        s = passage_score(lines, joined)
        if s > 0:
            scored.append((s, i, joined))
    picked = []
    for s, i, t in sorted(scored, reverse=True):
        if all(abs(i - j) > 20 for _, j, _ in picked):  # spread across the book
            picked.append((s, i, t))
        if len(picked) == count:
            break
    return picked

def display_name(name):
    last, _, first = name.partition(", ")
    return f"{first} {last}".strip()

def book_list(cfg):
    url, books = "https://gutendex.com/books/?languages=en&sort=popular&copyright=false", []
    while url and len(books) < cfg["pool"]:
        page = get_json(url, delay=0.5)
        books += page["results"]
        url = page.get("next")
    return books[: cfg["pool"]]

def run(cfg, stats):
    today = datetime.date.today().isoformat()
    out = []
    for book in book_list(cfg):
        if JUNK_BOOK.search(book["title"]):
            reject(stats, NAME, "junk-title")
            continue
        gate = rights.gutenberg_gate(book["authors"])
        if gate != "yes":
            reject(stats, NAME, f"author-death-{gate}")
            continue
        fmt = book["formats"]
        url = fmt.get("text/plain; charset=utf-8") or fmt.get("text/plain; charset=us-ascii")
        if not url:
            reject(stats, NAME, "no-text")
            continue
        try:
            text = get_text(url)
        except Exception:
            reject(stats, NAME, "fetch-failed")
            continue
        creator = display_name(book["authors"][0]["name"])
        pop = quality.popularity(book["download_count"], ceiling=6)
        subjects = [s.split(" -- ")[0] for s in book["subjects"]] + [s.replace("Category: ", "") for s in book["bookshelves"]]
        tags = taxonomy.subject_tags(subjects, 4) + ["prose"]
        death = book["authors"][0]["death_year"]
        era = taxonomy.era_tag(death)
        for score, idx, passage in best_passages(text, cfg["passages_per_book"]):
            cid = f"pg-{book['id']}-{idx}"
            if state.is_known(cid):
                reject(stats, NAME, "known")
                continue
            out.append({
                "id": cid, "type": "passage", "title": book["title"], "creator": creator, "date": str(death or ""),
                "source": {"institution": "Project Gutenberg", "url": f"https://www.gutenberg.org/ebooks/{book['id']}",
                           "sourceId": str(book["id"]), "fetchedAt": today, "work": book["title"]},
                "rights": rights.rights("PDM", "worldwide",
                                        f"{creator}, {book['title']} (public domain, via Project Gutenberg)", "passage"),
                "text": {"body": passage, "verse": False},
                "editorial": {"note": "", "noteSource": "source", "room": "words",
                              "tags": tags + ([era] if era else []), "tone": stable_pick(cid, TONES)},
                "_score": quality.combine([(0.5, pop), (0.5, score)]), "_group": creator, "_source": NAME,
            })
    return out
