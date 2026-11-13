"""NASA Image and Video Library: images credited to NASA. NASA's media usage guidelines treat NASA-credited imagery as generally not
copyrighted; records with a third-party or partner credit (ESA, CSA, agencies, companies) are left out. The licence reads "NASA public domain"."""
import datetime
import re
import urllib.parse
from .. import quality, rights, state, taxonomy
from ..http import get_json
from . import visual
from .common import reject

NAME = "nasa"
API = "https://images-api.nasa.gov/search"
OWN = {"nasa", "jpl", "jpl-caltech", "caltech", "gsfc", "msfc", "jsc", "ksc", "arc", "grc", "larc", "afrc", "ssc", "hq", "goddard", "stsci", "usgs", "noaa", "msss"}

def own_credit(a):
    """True when every credited party is NASA or a NASA centre or instrument team, or no credit is given."""
    parts = [p.strip().lower() for p in re.split(r"[/;,&]| and ", a.get("secondary_creator") or "") if p.strip()]
    return all(p in OWN for p in parts)

def card(a, href, today):
    nid, year = a["nasa_id"], taxonomy.year_of(a.get("date_created"))
    tags = taxonomy.subject_tags(a.get("keywords") or [], 6)
    note = taxonomy.clean_description(a.get("description_508") or a.get("description") or "")
    credit = a.get("secondary_creator") or f"NASA {a.get('center') or ''}".strip()
    text = f"{a['title']} {' '.join(tags)} space astronomy"
    return {
        "id": f"nasa-{nid}", "type": "image", "title": a["title"], "creator": credit, "date": str(year or ""),
        "source": {"institution": "NASA Image and Video Library", "url": f"https://images.nasa.gov/details/{urllib.parse.quote(nid)}", "sourceId": nid, "fetchedAt": today},
        "rights": rights.rights("NASA-PD", "worldwide", f"{a['title']}, {credit}, NASA public domain", "image"),
        "media": {"kind": "image", "url": f"https://images-assets.nasa.gov/image/{urllib.parse.quote(nid)}/{urllib.parse.quote(nid)}~medium.jpg", "medium": None, "dimensions": None, "culture": None},
        "editorial": {"note": note, "noteSource": "source", "room": visual.room_of(text, ""), "tags": tags + (["space"] if "space" not in tags else []) + ([taxonomy.era_tag(year)] if taxonomy.era_tag(year) else []),
                      "tone": visual.tone_of("photograph", nid)},
    }

def score(a, note):
    return quality.combine([(0.5, 1.0 if len(note) >= 120 else 0.4), (0.3, 1.0 if a.get("secondary_creator") else 0.5), (0.2, 1.0 if len(a.get("keywords") or []) >= 3 else 0.3)])

def run(cfg, stats):
    today, out, seen = datetime.date.today().isoformat(), [], set()
    for q in cfg["queries"]:
        for page in range(1, cfg["pages_per_query"] + 1):
            params = urllib.parse.urlencode({"q": q, "media_type": "image", "page_size": 100, "page": page})
            try:
                items = get_json(f"{API}?{params}", delay=0.5)["collection"]["items"]
            except Exception:
                break
            for it in items:
                a = it["data"][0]
                if a["nasa_id"] in seen:
                    continue
                seen.add(a["nasa_id"])
                if state.is_known(f"nasa-{a['nasa_id']}"):
                    reject(stats, NAME, "known")
                elif not own_credit(a):
                    reject(stats, NAME, "third-party-credit")
                else:
                    c = card(a, "", today)
                    c["_score"], c["_group"], c["_source"] = score(a, c["editorial"]["note"]), a.get("center") or "n/a", NAME
                    out.append(c)
            if len(items) < 100:
                break
    return out
