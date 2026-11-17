"""Flickr albums and group pools, read from the public pages (no API: it needs a paid account). Each page embeds its photo list as
JSON with every photo's licence, owner and sizes. Only CC BY, CC BY-SA, CC0, PDM and "no known copyright restrictions" are kept;
the uploader's licence tag is taken as given (decided 17 Nov). Albums are walked page by page and filtered here; a group pool goes
through Flickr's own search with the licence filter, so only licensed photos are paged. Pages are cached on disk and requested
slowly (src["delay"] seconds apart), so a run can be stopped and resumed."""
import datetime, json, re, urllib.parse
from .. import quality, rights, state, taxonomy
from ..http import BROWSER_UA, get_head, get_text
from .common import reject, stable_pick

NAME = "flickr-pages"
LICENSE = {4: "CC-BY", 5: "CC-BY-SA", 9: "CC0", 10: "PDM", 7: "PDM"}  # Flickr licence id -> ours (7: no known copyright restrictions)
SIZES = ("l", "c", "z")  # 1024, 800, 640 px on the long side: the largest that is still phone-sized

def model(html):
    m = re.search(r"modelExport:\s*(\{.*)", html, re.S)
    return json.JSONDecoder().raw_decode(m.group(1))[0] if m else {}

def walk(o, found, test):
    if isinstance(o, dict):
        if test(o):
            found.append(o)
        for v in o.values():
            walk(v, found, test)
    elif isinstance(o, list):
        for v in o:
            walk(v, found, test)
    return found

def page_photos(html):
    data = model(html)
    photos = walk(data, [], lambda o: "license" in o and "sizes" in o and "id" in o)
    page_owner = next(iter(walk(data, [], lambda o: "pathAlias" in o and "username" in o and "sizes" not in o)), {})
    for p in photos:  # each photo's owner is a reference ("~3") into the page's table
        ref = (p.get("owner") or {}).get("data")
        p["_owner"] = resolve(data, ref) if isinstance(ref, str) and ref.startswith("~") else (ref if isinstance(ref, dict) else page_owner) or page_owner
    return photos, page_owner

def resolve(data, ref):
    o = data.get("main", {})
    try:
        for k in data["legend"][int(ref[1:])]:
            o = o[int(k)] if isinstance(o, list) else o[k]
        return o if isinstance(o, dict) else None
    except (KeyError, IndexError, ValueError, TypeError):
        return None

def page_url(src, n, sort=None):
    if src["kind"] == "group":
        q = {"group_id": src["group_id"], "license": ",".join(map(str, LICENSE)), "sort": sort, "text": "", "page": n}
        return f"https://www.flickr.com/search/?{urllib.parse.urlencode(q)}"
    return src["url"] if n == 1 else f"{src['url'].rstrip('/')}/page{n}"

def image_of(p):
    sizes = {k: v["data"] for k, v in p["sizes"]["data"].items() if isinstance(v, dict) and "data" in v}
    pick = next((sizes[k] for k in SIZES if k in sizes), None)
    return pick and ("https:" + pick["url"], pick["width"], pick["height"])

def card_of(p, page_owner, src, today):
    owner = p.get("_owner") or page_owner
    lic = LICENSE.get(int(p["license"]))
    if not lic:
        return None, "license"
    pid, title = str(p["id"]), (p.get("title") or "").strip()
    img = image_of(p)
    if not img or not title:
        return None, "no-media"
    cid = f"flickr-{pid}"
    alias = p.get("pathAlias") or owner.get("pathAlias") or p.get("ownerNsid")
    creator = p.get("realname") or p.get("username") or owner.get("realname") or owner.get("username") or alias or "Unknown"
    if state.is_known(cid) or state.dupe_key(title, creator) in state.KEYS:
        return None, "known"
    url, w, h = img
    page = f"https://www.flickr.com/photos/{alias}/{pid}/"
    score = quality.combine([(0.4, min(1.0, max(w, h) / 1600)), (0.2, 1.0 if creator != "Unknown" else 0.0),
                             (0.2, 1.0 if len(title.split()) >= 2 else 0.2), (0.2, min(1.0, (p.get("faveCount") or 0) / 50))])
    extra = {"creditLine": "Flickr: no known copyright restrictions"} if int(p["license"]) == 7 else {}
    card = {
        "id": cid, "type": "image", "title": title, "creator": creator, "date": "",
        "source": {"institution": "Flickr", "url": page, "sourceId": pid, "fetchedAt": today, "collection": src["topic"]},
        "rights": rights.rights(lic, "worldwide", rights.attribution(creator, title, lic, page), "image", **extra),
        "media": {"kind": "image", "url": url},
        "editorial": {"note": "", "noteSource": "source", "room": src["room"],
                      "tags": [*src["tags"], *taxonomy.subject_tags(re.findall(r"[A-Za-z]{4,}", title), 3)],
                      "tone": stable_pick(cid, ("paper", "mauve", "ink", "sky"))},
        "_score": score, "_group": src["topic"], "_source": NAME,
    }
    return (card, None) if card["rights"]["gate"] == "yes" else (None, "rights-gate")

def run(cfg, stats):
    today, out, seen_all = datetime.date.today().isoformat(), [], set()
    # a search shows only its first ~1,200 hits, so a group pool is read under several sort orders; each shows a different slice
    walks = [(src, sort) for src in cfg["sources"] for sort in (src.get("sorts") or [None])]
    for src, sort in walks:
        seen = set()
        for n in range(1, cfg["max_pages"] + 1):
            try:
                photos, owner = page_photos(get_text(page_url(src, n, sort), delay=cfg["delay"]))
            except Exception as e:
                reject(stats, NAME, "page-failed")
                print(f"{src['name']}: page {n} failed ({e!r})", flush=True)
                break
            new = [p for p in photos if str(p["id"]) not in seen]
            if not new:
                break
            for p in new:
                seen.add(str(p["id"]))
                if str(p["id"]) in seen_all:
                    continue
                seen_all.add(str(p["id"]))
                card, why = card_of(p, owner, src, today)
                if card:
                    out.append(card)
                else:
                    reject(stats, NAME, why)
            print(f"{src['name']} {sort or ''}: page {n}, {len(seen)} seen, {sum(1 for c in out if c['source']['collection'] == src['topic'])} kept", flush=True)
    def check(card):
        try:
            info = get_head(card["media"]["url"], ua=BROWSER_UA)
        except Exception:
            return reject(stats, NAME, "image-fetch-failed")
        ok = info["status"] in (200, 206) and info["contentType"] in ("image/jpeg", "image/png")
        return card if ok else reject(stats, NAME, "image-unusable")
    return [c for c in map(check, out) if c]
