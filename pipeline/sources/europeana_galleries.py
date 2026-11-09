"""Europeana galleries: the editorial and user sets published at europeana.eu/galleries.
Every work carries its gallery titles as tags (`gallery-<title>`), so a collection filter can be added later.
Works the database already holds get the tags too. Needs EUROPEANA_API_KEY."""
import collections, datetime, math, re
from .. import secrets, state
from ..http import get_json
from . import europeana
from .common import reject

SETS = "https://api.europeana.eu/set"
PAGE = 100

def get(key, url):
    return get_json(url, delay=0.25, headers={"X-Api-Key": key})

def title_of(s):
    t = s.get("title")
    t = t.get("en") or next(iter(t.values()), "") if isinstance(t, dict) else t
    return (t[0] if isinstance(t, list) else t or "").strip()

def tag_of(title):
    return "gallery-" + re.sub(r"[^\w]+", "-", title.lower()).strip("-")[:48].rstrip("-")

def galleries(key):
    """[(set id, title)] for every published gallery."""
    out, page, total = [], 1, None
    while total is None or len(out) < total:
        data = get(key, f"{SETS}/search?query=*&profile=standard&qf=type:Collection&qf=visibility:published&pageSize={PAGE}&page={page}")
        total = data["partOf"]["total"]
        items = data.get("items", [])
        out += [(s["id"].rsplit("/", 1)[-1], title_of(s)) for s in items if title_of(s)]
        if len(items) < PAGE:
            break
        page += 1
    return out

def members(key, set_id):
    """Every item of one gallery, with Search-API-style metadata."""
    out, page = [], 1
    while True:
        data = get(key, f"{SETS}/{set_id}?profile=items.meta&pageSize={PAGE}&page={page}")
        items = data.get("items") or []
        out += items
        if len(items) < PAGE or len(out) >= data.get("partOf", {}).get("total", 0):
            return out
        page += 1

def run(src, stats):
    name, key = src["name"], secrets.get("EUROPEANA_API_KEY")
    if not key:
        reject(stats, name, "no-api-key")
        print(f"{name}: skipped, EUROPEANA_API_KEY is not set (see pipeline/README.md)", flush=True)
        return []
    today = datetime.date.today().isoformat()
    kinds = {"IMAGE": {**src, "kind": "image"},
             "SOUND": {**src, "kind": "audio", "room": "sound", "tones": src["sound_tones"], "tags": src["sound_tags"]}}
    tags_of, first_gallery, found = collections.defaultdict(list), {}, {}
    for set_id, title in galleries(key):
        tag = tag_of(title)
        for it in members(key, set_id):
            if it.get("type") not in kinds or not it.get("id"):
                continue
            cid = "eu-" + it["id"].strip("/").replace("/", "_")
            if tag not in tags_of[cid]:
                tags_of[cid].append(tag)
            first_gallery.setdefault(cid, title)
            found.setdefault(cid, it)
    print(f"{name}: {len(found)} items across galleries", flush=True)
    pool = []
    for cid, it in found.items():
        if state.is_known(cid):
            state.RETAG[cid] = tags_of[cid]  # already in the database: only the gallery tags are new
            reject(stats, name, "known")
            continue
        it = {**it, "completeness": it.get("europeanaCompleteness")}
        card, why = europeana.candidate(it, kinds[it["type"]], today)
        if not card:
            reject(stats, name, why)
            continue
        card["editorial"]["tags"] = card["editorial"]["tags"][:6] + tags_of[cid][:3]
        card["_group"] = first_gallery[cid]
        pool.append(card)
    by_gallery = collections.defaultdict(list)
    for card in sorted(pool, key=lambda c: c["_score"], reverse=True):
        by_gallery[card["_group"]].append(card)
    shortlist = [c for cards in by_gallery.values() for c in cards[: src["max_per_group"] * 2]]
    return europeana.probe_all(shortlist, src, stats)
