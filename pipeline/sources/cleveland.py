"""Cleveland Museum of Art Open Access: CC0, with image. Highlights and on-view works rank highest."""
import datetime
from .. import quality, rights, state, taxonomy
from ..http import get_json
from . import visual
from .common import reject

NAME = "cleveland"
API = "https://openaccess-api.clevelandart.org/api/artworks/"

def pages(params, limit, pool):
    for skip in range(0, pool, limit):
        qs = "&".join(f"{k}={v}" for k, v in {**params, "limit": limit, "skip": skip}.items())
        data = get_json(f"{API}?{qs}", delay=0.3)["data"]
        if not data:
            return
        yield from data

def card(a, today):
    web = (a.get("images") or {}).get("web") or {}
    creators = a.get("creators") or []
    creator = visual.person(creators[0]["description"]) if creators else "Unknown maker"
    tags = taxonomy.subject_tags([a.get("type"), a.get("technique"), a.get("collection"), *(a.get("culture") or [])], 5)
    era = taxonomy.era_tag(a.get("creation_date_earliest"))
    text = f"{a['title']} {' '.join(tags)} {a.get('type') or ''}"
    note = taxonomy.clean_description(a.get("did_you_know") or a.get("description") or "")
    return {
        "id": f"cma-{a['id']}", "type": "image", "title": a["title"], "creator": creator, "date": a.get("creation_date") or "",
        "source": {"institution": "Cleveland Museum of Art, Open Access", "url": a["url"], "sourceId": str(a["id"]), "fetchedAt": today},
        "rights": rights.rights("CC0", "worldwide", f"Cleveland Museum of Art (CC0)", "image", creditLine=a.get("creditline")),
        "media": {"kind": "image", "url": web["url"], "medium": a.get("technique"), "dimensions": None,
                  "culture": ", ".join(a.get("culture") or [])},
        "editorial": {"note": note, "noteSource": "source", "room": visual.room_of(text, a.get("department")),
                      "tags": tags + ([era] if era else []), "tone": visual.tone_of(a.get("type"), str(a["id"]))},
    }

def score(a, desc):
    on_view = bool(a.get("current_location"))
    curation = 1.0 if a.get("is_highlight") else 0.5 if on_view else 0.0
    return quality.combine([(0.55, curation), (0.25, 1.0 if len(desc) >= 80 else 0.3),
                            (0.1, 1.0 if a.get("creators") else 0.0), (0.1, 1.0 if a.get("creation_date") else 0.0)])

def run(cfg, stats):
    today, seen, out = datetime.date.today().isoformat(), set(), []
    base = {"cc0": 1, "has_image": 1}
    sources = [({**base, "highlight": 1}, 300), (base, cfg["on_view_pool"])]
    for params, pool in sources:
        for a in pages(params, 100, pool):
            if a["id"] in seen:
                continue
            seen.add(a["id"])
            if state.is_known(f"cma-{a['id']}"):
                reject(stats, NAME, "known")
                continue
            if a.get("share_license_status") != "CC0":
                reject(stats, NAME, "not-cc0")
                continue
            if not ((a.get("images") or {}).get("web") or {}).get("url"):
                reject(stats, NAME, "no-image")
                continue
            if "highlight" not in params and not a.get("current_location"):
                reject(stats, NAME, "not-on-view")  # the non-highlight pool keeps on-view works only
                continue
            c = card(a, today)
            c["_score"] = score(a, c["editorial"]["note"])
            c["_group"], c["_source"] = a.get("department") or "n/a", NAME
            out.append(c)
    return out
