"""Openverse: normalised licence data across many museum collections. Image sources only, from an allowlist.
Openverse has no quality signal, so quality comes from metadata: resolution, creator, title, tags.
Anonymous limits (20 requests/min, 200/day, 240 results per query) are respected; results are cached."""
import datetime, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from .. import probe, quality, rights, state, taxonomy
from ..http import get_json
from . import visual
from .common import reject, stable_pick

NAME = "openverse"
API = "https://api.openverse.org/v1/images/"

def hits(src, source, term, page):
    params = {"source": source, "license": ",".join(src["licenses"]), "q": term, "page": page, "page_size": 20,
              "extension": "jpg,png", "mature": "false"}
    try:
        return get_json(f"{API}?{urllib.parse.urlencode(params)}", delay=3.2).get("results", [])
    except Exception:  # depth/rate limits: stop this query, keep what we have
        return []

def candidate(r, src, today):
    license = rights.license_from_code(r.get("license"))
    if not license or r.get("mature"):
        return None, "license"
    if not r.get("url", "").startswith("http") or not r.get("title"):
        return None, "no-media"
    cid = f"ov-{r['id']}"
    title, creator = r["title"], r.get("creator") or ""
    if state.is_known(cid) or state.dupe_key(title, creator) in state.KEYS:
        return None, "known"
    side = min(r.get("width") or 0, r.get("height") or 0)
    if side < src["min_side"]:
        return None, "low-resolution"
    tags = [t["name"] for t in (r.get("tags") or []) if t.get("name")]
    score = quality.combine([
        (0.35, min(1.0, side / 2000)), (0.2, 1.0 if creator else 0.0),
        (0.2, 1.0 if len(title.split()) >= 2 else 0.2), (0.15, min(1.0, len(tags) / 4)),
        (0.1, src["source_prior"].get(r["source"], 0.5))])
    card = {
        "id": cid, "type": "image", "title": title, "creator": creator or "Unknown", "date": "",
        "source": {"institution": f"{r.get('provider') or r['source']} via Openverse", "url": r["foreign_landing_url"],
                   "sourceId": r["id"], "fetchedAt": today, "collection": r["source"]},
        "rights": rights.rights(license, "worldwide", r.get("attribution") or rights.attribution(creator, title, license), "image"),
        "media": {"kind": "image", "url": r["url"]},
        "editorial": {"note": "", "noteSource": "source",
                      "room": visual.room_of(f"{title} {' '.join(tags)}", r.get("category") or ""),
                      "tags": taxonomy.subject_tags(tags, 5) or [r["source"]], "tone": stable_pick(cid, ("paper", "mauve", "ink", "sky"))},
        "_score": score, "_group": r["source"], "_source": NAME,
    }
    return (card, None) if card["rights"]["gate"] == "yes" else (None, "rights-gate")

def run(src, stats):
    today, pool, seen, budget = datetime.date.today().isoformat(), [], set(), src["max_requests"]
    terms = src.get("terms") or state.TAGS[: src["max_terms"]]
    for source in src["sources"]:
        for term in terms:
            if budget <= 0:
                break
            budget -= 1
            for r in hits(src, source, term, 1):
                if r["id"] in seen:
                    continue
                seen.add(r["id"])
                card, why = candidate(r, src, today)
                if card:
                    pool.append(card)
                else:
                    reject(stats, NAME, why)
    def check(card):
        verdict, card["media"]["url"] = probe.secure_image(card["media"]["url"])
        return card if verdict == "yes" else reject(stats, NAME, f"image-{verdict}")
    with ThreadPoolExecutor(max_workers=12) as ex:
        return [c for c in ex.map(check, pool) if c]
