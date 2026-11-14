"""Rijksmuseum open data (Linked Art, no key): objects with an image under a Public Domain Mark or CC0.
Search pages list ids per object type; each object is one request, fetched by a small pool of threads. Works already in the
database (the Europeana copy of the same object, matched by object number, or the same title and maker) are skipped before any
object request. Images come from the museum's IIIF server at 1280 px."""
import datetime
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from .. import quality, rights, state, taxonomy
from ..http import get_json
from . import visual
from .common import reject

NAME = "rijksmuseum"
SEARCH = "https://data.rijksmuseum.nl/search/collection"
EN, NL = "http://vocab.getty.edu/aat/300388277", "http://vocab.getty.edu/aat/300388256"
PREFERRED, DESCRIPTION, MEDIUM = "300404670", "300048722", "300435429"
OBJECT_NUMBER = "https://id.rijksmuseum.nl/22015218"
WIDTH = 1280

def number_key(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())

def ids(kind, limit):
    """Object ids of one type that have an image, in the search's own order."""
    url, out = f"{SEARCH}?{urllib.parse.urlencode({'imageAvailable': 'true', 'type': kind})}", []
    while url and len(out) < limit:
        page = get_json(url, delay=0.2)
        out += [i["id"] for i in page.get("orderedItems", [])]
        url = (page.get("next") or {}).get("id")
    return out[:limit]

def langs(node):
    return [l.get("id") for l in node.get("language", [])]

def english(nodes, kind=None):
    """Content of the first node in English, else none."""
    for n in nodes:
        if EN in langs(n) and (kind is None or any(kind in (c.get("id") or "") for c in n.get("classified_as", []))):
            return n.get("content")
    return None

def notation(types):
    return [n["@value"] for t in types for n in t.get("notation", []) if n.get("@language") == "en"]

def parse(o):
    """The fields the card needs from one Linked Art object, or None without a usable open image."""
    number = next((n["content"] for n in o.get("identified_by", []) if any(c.get("id") == OBJECT_NUMBER for c in n.get("classified_as", []))), None)
    names = [n for n in o.get("identified_by", []) if n.get("type") == "Name" and any(PREFERRED in (c.get("id") or "") for c in n.get("classified_as", []))]
    title = english(names) or (names[0].get("content") if names else None)
    image = licence = page = None
    for s in o.get("subject_of", []):
        for d in s.get("digitally_carried_by", []):
            for a in d.get("access_point", []):
                u = a.get("id") or ""
                if "iiif.micr.io" in u:
                    image = re.sub(r"/full/[^/]+/", f"/full/{WIDTH},/", u)
                    licence = next((r.get("content") for r in d.get("referred_to_by", [])), None)
                elif "rijksmuseum.nl" in u:
                    page = u
    prod = o.get("produced_by") or {}
    span = (prod.get("timespan") or {})
    note = next((p.get("content") for s in o.get("subject_of", []) if EN in langs(s) for p in s.get("part", [])
                 if any(DESCRIPTION in (c.get("id") or "") for c in p.get("classified_as", []))), None)
    return {"number": number, "title": title, "image": image, "licence": licence, "page": page,
            "creator": english(prod.get("referred_to_by", []), "300435416") or "Unknown maker",
            "date": english(span.get("identified_by", [])) or "", "begin": (span.get("begin_of_the_begin") or "")[:4],
            "medium": english(o.get("referred_to_by", []), MEDIUM), "note": taxonomy.clean_description(note or ""),
            "kinds": notation(o.get("classified_as", [])), "techniques": notation(prod.get("technique", []))}

def card(i, p, today):
    uid = f"rm-{i.rsplit('/', 1)[-1]}"
    code = rights.license_from_url(p["licence"])
    tags = taxonomy.subject_tags([*p["kinds"], *p["techniques"], p["medium"] or ""], 5)
    era = taxonomy.era_tag(int(p["begin"])) if p["begin"].isdigit() else None
    return {
        "id": uid, "type": "image", "title": p["title"], "creator": visual.person(p["creator"]), "date": p["date"],
        "source": {"institution": "Rijksmuseum, Open Data", "url": p["page"] or i, "sourceId": i.rsplit("/", 1)[-1], "fetchedAt": today},
        "rights": rights.rights(code, "worldwide", f"Rijksmuseum ({rights.LICENSES[code][0]})", "image"),
        "media": {"kind": "image", "url": p["image"], "medium": p["medium"], "dimensions": None, "culture": None},
        "editorial": {"note": p["note"], "noteSource": "source", "room": visual.room_of(f"{p['title']} {' '.join(tags)}", ""),
                      "tags": tags + ([era] if era else []), "tone": visual.tone_of(" ".join(p["kinds"]), uid)},
    }

def score(p):
    core = 1.0 if (p["number"] or "").startswith(("SK-A", "SK-C")) else 0.5  # the museum's main paintings
    return quality.combine([(0.45, core), (0.3, 1.0 if len(p["note"]) >= 80 else 0.3), (0.15, 0.0 if p["creator"] == "Unknown maker" else 1.0), (0.1, 1.0 if p["date"] else 0.0)])

def run(cfg, stats):
    today, out = datetime.date.today().isoformat(), []
    have, seen = set(state.NUMBERS), set()  # object numbers and (title, maker) keys already held or taken in this run
    todo = []
    for kind, limit in cfg["types"].items():
        for i in ids(kind, limit):
            if state.is_known(f"rm-{i.rsplit('/', 1)[-1]}"):
                reject(stats, NAME, "known")
            else:
                todo.append((i, kind))
    def fetch(item):
        try:
            return item, parse(get_json(item[0], delay=0.12, headers={"Accept": "application/ld+json"}))
        except Exception:
            return item, None
    with ThreadPoolExecutor(cfg.get("workers", 8)) as pool:
        for (i, kind), p in pool.map(fetch, todo):
            if not p or not p["title"] or not p["image"] or rights.license_from_url(p["licence"]) is None:
                reject(stats, NAME, "no-open-image")
            elif number_key(p["number"]) in have:
                reject(stats, NAME, "duplicate-number")
            elif state.dupe_key(p["title"], p["creator"]) in seen:
                reject(stats, NAME, "duplicate-title")
            else:
                c = card(i, p, today)
                c["_score"], c["_group"], c["_source"] = score(p), kind, NAME
                seen.add(state.dupe_key(p["title"], p["creator"]))
                have.add(number_key(p["number"]))
                out.append(c)
    return out
