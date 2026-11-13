"""Art Institute of Chicago open access: public-domain works with an image (CC0). The image server answers only clients that send
the AIC-User-Agent header (http.HOST_HEADERS), so these works show in the native app only. The API returns at most 1000 hits per
query, so the pool is read in date buckets, curated highlights first."""
import datetime
import urllib.parse
from .. import quality, rights, state, taxonomy
from ..http import get_json
from . import visual
from .common import reject

NAME = "artic"
API = "https://api.artic.edu/api/v1/artworks/search"
FIELDS = "id,title,artist_display,date_display,date_start,image_id,is_boosted,is_on_view,department_title,classification_title,style_title,term_titles,short_description,credit_line,place_of_origin,medium_display"
BUCKETS = [(-3000, 1000), (1000, 1400), (1400, 1600), (1600, 1700), (1700, 1800), (1800, 1850), (1850, 1880), (1880, 1900), (1900, 1920), (1920, 1950), (1950, 2030)]
PAGE = 100

def query(lo, hi, page):
    must = [("term][is_public_domain", "true"), ("exists][field", "image_id"), ("range][date_start][gte", lo), ("range][date_start][lt", hi)]
    params = [(f"query[bool][must][{i}][{k}]", v) for i, (k, v) in enumerate(must)]
    params += [("limit", PAGE), ("page", page), ("fields", FIELDS)]
    return f"{API}?{urllib.parse.urlencode(params)}"

def card(a, today):
    tags = taxonomy.subject_tags([t for t in (a.get("classification_title"), a.get("style_title"), *(a.get("term_titles") or [])) if t], 6)
    era = taxonomy.era_tag(a.get("date_start"))
    text = f"{a['title']} {' '.join(tags)} {a.get('classification_title') or ''}"
    note = taxonomy.clean_description(a.get("short_description") or "")
    return {
        "id": f"aic-{a['id']}", "type": "image", "title": a["title"], "creator": visual.person((a.get("artist_display") or "").split("\n")[0]) or "Unknown maker",
        "date": a.get("date_display") or "",
        "source": {"institution": "Art Institute of Chicago, Open Access", "url": f"https://www.artic.edu/artworks/{a['id']}", "sourceId": str(a["id"]), "fetchedAt": today},
        "rights": rights.rights("CC0", "worldwide", "Art Institute of Chicago (CC0)", "image",
                                creditLine=(a.get("credit_line") or "") + ("; description CC BY 4.0, Art Institute of Chicago" if note else "")),
        "media": {"kind": "image", "url": f"https://www.artic.edu/iiif/2/{a['image_id']}/full/843,/0/default.jpg", "medium": a.get("medium_display"),
                  "dimensions": None, "culture": a.get("place_of_origin")},
        "editorial": {"note": note, "noteSource": "source", "room": visual.room_of(text, a.get("department_title")),
                      "tags": tags + ([era] if era else []), "tone": visual.tone_of(a.get("classification_title"), str(a["id"]))},
    }

def score(a, note):
    curation = 1.0 if a.get("is_boosted") else 0.5 if a.get("is_on_view") else 0.0
    return quality.combine([(0.55, curation), (0.25, 1.0 if len(note) >= 80 else 0.3), (0.1, 1.0 if a.get("artist_display") else 0.0), (0.1, 1.0 if a.get("date_display") else 0.0)])

def run(cfg, stats):
    today, out = datetime.date.today().isoformat(), []
    for lo, hi in BUCKETS:
        for page in range(1, cfg["pages_per_bucket"] + 1):
            data = get_json(query(lo, hi, page), delay=0.4).get("data") or []
            for a in data:
                if state.is_known(f"aic-{a['id']}"):
                    reject(stats, NAME, "known")
                    continue
                c = card(a, today)
                c["_score"] = score(a, c["editorial"]["note"])
                c["_group"], c["_source"] = a.get("department_title") or "n/a", NAME
                out.append(c)
            if len(data) < PAGE:
                break
    return out
