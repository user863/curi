"""Flickr photos under an open licence (CC0, PDM, CC BY, CC BY-SA), read through the Openverse index: Flickr's own search API
needs a paid account, Openverse lists Flickr with the uploader's licence, creator, tags and the photo page URL, and needs no key.
The licence is the uploader's tag, taken as given (decided 17 Nov). Topics: rave flyers, gig posters, zines, matchbox labels.
Anonymous Openverse limits (20 requests/min, 200/day, 240 results per query) are respected; responses are cached."""
import datetime, re, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from .. import quality, rights, state, taxonomy
from ..http import BROWSER_UA, get_head, get_json
from . import visual
from .common import reject, stable_pick

NAME = "flickr"
API = "https://api.openverse.org/v1/images/"

def hits(src, query, page):
    params = {"source": "flickr", "license": ",".join(src["licenses"]), "q": query, "page": page, "page_size": 20,
              "extension": "jpg,png", "mature": "false"}
    try:
        return get_json(f"{API}?{urllib.parse.urlencode(params)}", delay=3.2).get("results", [])
    except Exception:  # server error or limit
        return None

def matches(topic, text):
    return any(re.search(rf"\b{re.escape(w)}", text) for w in topic["words"])

def candidate(r, topic, src, today):
    license = rights.license_from_code(r.get("license"))
    if not license or r.get("mature"):
        return None, "license"
    title, creator = (r.get("title") or "").strip(), r.get("creator") or ""
    if not r.get("url", "").startswith("http") or not title:
        return None, "no-media"
    tags = [t["name"] for t in (r.get("tags") or []) if t.get("name")]
    if not matches(topic, f"{title} {' '.join(tags)}".lower()):
        return None, "off-topic"
    cid = f"flickr-{r['id']}"
    if state.is_known(cid) or state.dupe_key(title, creator) in state.KEYS:
        return None, "known"
    side = max(r.get("width") or 0, r.get("height") or 0)  # size only weighs into the quality score
    score = quality.combine([
        (0.4, min(1.0, side / 1600)), (0.2, 1.0 if creator else 0.0),
        (0.2, 1.0 if len(title.split()) >= 2 else 0.2), (0.2, min(1.0, len(tags) / 6))])
    card = {
        "id": cid, "type": "image", "title": title, "creator": creator or "Unknown", "date": "",
        "source": {"institution": "Flickr", "url": r["foreign_landing_url"], "sourceId": r["id"], "fetchedAt": today,
                   "collection": topic["name"]},
        "rights": rights.rights(license, "worldwide", r.get("attribution") or rights.attribution(creator, title, license, r["foreign_landing_url"]), "image"),
        "media": {"kind": "image", "url": r["url"]},
        "editorial": {"note": "", "noteSource": "source", "room": topic["room"],
                      "tags": [topic["name"], *taxonomy.subject_tags(tags, 5)], "tone": stable_pick(cid, ("paper", "mauve", "ink", "sky"))},
        "_score": score, "_group": topic["name"], "_source": NAME,
    }
    return (card, None) if card["rights"]["gate"] == "yes" else (None, "rights-gate")

def run(src, stats):
    today, pool, seen, budget = datetime.date.today().isoformat(), [], set(), src["max_requests"]
    for topic in src["topics"]:
        for query in topic["queries"]:
            for page in range(1, src["pages"] + 1):
                if budget <= 0:
                    break
                budget -= 1
                batch = next((b for b in (hits(src, query, page) for _ in range(3)) if b is not None), None)
                if batch is None:  # still failing after retries: move on
                    reject(stats, NAME, "page-failed")
                    continue
                for r in batch:
                    if r["id"] in seen:
                        continue
                    seen.add(r["id"])
                    card, why = candidate(r, topic, src, today)
                    if card:
                        pool.append(card)
                    else:
                        reject(stats, NAME, why)
                if len(batch) < 20:
                    break
    def check(card):
        # Flickr sends no file size; the 1024 px size it serves is always small enough, so only reachability and type are checked
        try:
            info = get_head(card["media"]["url"], ua=BROWSER_UA)
        except Exception:
            return reject(stats, NAME, "image-fetch-failed")
        ok = card["media"]["url"].startswith("https://") and info["status"] in (200, 206) and info["contentType"] in ("image/jpeg", "image/png")
        return card if ok else reject(stats, NAME, "image-unusable")
    with ThreadPoolExecutor(max_workers=12) as ex:
        return [c for c in ex.map(check, pool) if c]
