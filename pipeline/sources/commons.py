"""Wikimedia Commons featured pictures and featured media (video, sound). Newest first, open licences only.
Reads the category through the MediaWiki API in batches of 50, one request at a time, as Wikimedia asks of
bots: an identifying user agent, maxlag, and a wait when told to. Pictures are shown from Commons' own
1280 px renditions. Vector graphics, small images and anything that looks like an icon or logo are left out."""
import datetime, html, json, re, time, urllib.error, urllib.parse, urllib.request
from .. import http, probe, quality, rights, state, taxonomy
from . import visual
from .common import reject, stable_pick

API = "https://commons.wikimedia.org/w/api.php"
UA = "Curi/0.1 (https://github.com/user863/curi; research prototype)"
PICTURES = "Category:Featured pictures on Wikimedia Commons"
MEDIA = ["Category:Featured media", "Category:Featured videos", "Category:Featured sounds"]  # and their subcategories
WIDTH = probe.WANTED_SIDE  # a standard Commons thumbnail size
MIN_LONG_SIDE = 1000
MIN_SHORT_SIDE = 600
FORMATS = ("image/jpeg", "image/png", "image/webp")  # no svg, gif, tiff
ICON_WORDS = re.compile(r"\bicons?\b|\blogos?\b|emblem|pictogram|clip ?art|coat of arms|\bflags? of\b|symbol", re.I)
SKIP_CATEGORY = re.compile(r"featured|valued|quality|uploaded|wikimedia|commons|photograph(s|y)? by|pictures? by|images? by|taken|"
                           r"self-published|licen[cs]e|^cc-|^pd-|\d{4}|template|media|files|wikipedia|camera|nikon|canon|lens", re.I)
FIELDS = "ObjectName|ImageDescription|Artist|DateTimeOriginal|LicenseShortName|LicenseUrl|Categories|Restrictions"

def api(params, pause=1.2):
    """One polite call: spaced, identified, and patient when Wikimedia says to wait."""
    query = urllib.parse.urlencode({"format": "json", "formatversion": "2", "maxlag": "5", **params})
    for attempt in range(6):
        http._wait(API, pause)
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{API}?{query}", headers={"User-Agent": UA}), timeout=60) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(int(e.headers.get("Retry-After") or 30) + 2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, OSError):  # timeouts and dropped connections: wait and try again
            time.sleep(15 * (attempt + 1))
            continue
        if data.get("error", {}).get("code") == "maxlag":  # the servers are busy: back off
            time.sleep(10 * (attempt + 1))
            continue
        return data
    raise RuntimeError("Commons API kept refusing")

def batch(category, resume, pause=1.2, media=False):
    """(pages, continuation). Pages carry file info and licence data; newest additions to the category first."""
    params = {"action": "query", "generator": "categorymembers", "gcmtitle": category, "gcmtype": "file", "gcmlimit": "50",
              "gcmsort": "timestamp", "gcmdir": "descending", **(resume or {})}
    if media:
        params.update({"prop": "videoinfo", "viprop": "url|size|mime|duration|derivatives|extmetadata", "viurlwidth": "640",
                       "viextmetadatafilter": FIELDS})
    else:
        params.update({"prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": str(WIDTH), "iiextmetadatafilter": FIELDS})
    data = api(params, pause)
    return data.get("query", {}).get("pages", []), data.get("continue")

def subcategories(category, pause=1.2):
    out, resume = [], {}
    while True:
        data = api({"action": "query", "list": "categorymembers", "cmtitle": category, "cmtype": "subcat", "cmlimit": "500", **resume}, pause)
        out += [m["title"] for m in data["query"]["categorymembers"]]
        if "continue" not in data:
            return out
        resume = data["continue"]

def category_tree(roots, pause=1.2):
    """The roots and every category beneath them."""
    seen, stack = [], list(roots)
    while stack:
        cat = stack.pop()
        if cat not in seen:
            seen.append(cat)
            stack += subcategories(cat, pause)
    return seen

def meta(ii, key):
    return html.unescape(re.sub(r"<[^>]+>", " ", (ii.get("extmetadata", {}).get(key) or {}).get("value") or "")).strip()

def license_of(ii):
    url = (ii.get("extmetadata", {}).get("LicenseUrl") or {}).get("value")
    found = rights.license_from_url(url)
    if found:
        return found
    name = meta(ii, "LicenseShortName").lower()  # public domain everywhere, not just in the US
    if name.startswith("cc0"):
        return "CC0"
    return "PDM" if name == "public domain" or name.startswith("pd-old") or name.startswith("pd-art") else None

def candidate(page, today, experimental=False):
    """(card, None) or (None, reason). experimental: also accept a PDF, shown as its first page, tagged for checking."""
    ii = (page.get("imageinfo") or [{}])[0]
    if state.is_known(f"wc-{page['pageid']}"):
        return None, "known"
    pdf = experimental and ii.get("mime") == "application/pdf"
    if ii.get("mime") not in FORMATS and not pdf:
        return None, "not-a-photo-format"
    w, h = ii.get("width", 0), ii.get("height", 0)
    if not pdf and (max(w, h) < MIN_LONG_SIDE or min(w, h) < MIN_SHORT_SIDE):
        return None, "too-small"
    title = meta(ii, "ObjectName") or re.sub(r"^File:|\.\w+$", "", page["title"]).replace("_", " ")
    categories = [c for c in meta(ii, "Categories").split("|") if c]
    if ICON_WORDS.search(title) or any(ICON_WORDS.search(c) for c in categories):
        return None, "icon-or-logo"
    license = license_of(ii)
    if not license:
        return None, "licence"
    url = ii.get("thumburl") or ii.get("url") or ""
    if not url.startswith("https://") or meta(ii, "Restrictions"):
        return None, "unusable"
    creator = meta(ii, "Artist")
    creator = "" if re.match(r"unknown|anonymous|\?", creator, re.I) else creator[:80]
    year = taxonomy.year_of(meta(ii, "DateTimeOriginal"))
    desc = taxonomy.clean_description(meta(ii, "ImageDescription"))
    subjects = [c for c in categories if not SKIP_CATEGORY.search(c)]
    tags = taxonomy.subject_tags(subjects, 4) + [t for t in (taxonomy.era_tag(year),) if t] + ["wikimedia-commons", "featured-picture"]
    tags += ["experimental", "pdf-first-page"] if pdf else (["experimental"] if experimental else [])
    page_url = ii.get("descriptionurl") or f"https://commons.wikimedia.org/?curid={page['pageid']}"
    score = quality.combine([(0.4, 1.0), (0.2, 1.0 if len(desc) >= 60 else 0.3), (0.15, 1.0 if creator else 0.0),
                             (0.1, 1.0 if year else 0.0), (0.15, None if pdf else min(1.0, max(w, h) / 3500))])
    cid = f"wc-{page['pageid']}"
    return {
        "id": cid, "type": "image", "title": title[:140], "creator": creator or "Unknown", "date": str(year or ""),
        "source": {"institution": "Wikimedia Commons", "url": page_url, "sourceId": str(page["pageid"]), "fetchedAt": today,
                   "collection": "featured-pictures"},
        "rights": rights.rights(license, "worldwide", rights.attribution(creator, title, license, page_url), "image"),
        "media": {"kind": "image", "url": url},
        "editorial": {"note": desc, "noteSource": "source", "room": visual.room_of(f"{title} {' '.join(subjects)}"),
                      "tags": tags[:6], "tone": stable_pick(cid, ("ink", "paper", "mauve", "sky"))},
        "_score": score, "_group": str(year or "n/a"), "_source": "commons",
    }, None

# Video and sound: Commons keeps the original (often WebM, FLAC, WAV) and makes web renditions. We play a rendition.
WEBM_PREFERENCE = ("480p.vp9.webm", "360p.vp9.webm", "240p.vp9.webm")
QUICKTIME = "360p.mpeg4.mov"  # MPEG-4 in QuickTime: every iPhone plays it; WebM VP9 is not guaranteed on all of them
EXCERPT = {"video": {"start_frac": 0.25, "length_s": 45, "whole_if_under": 70}, "audio": {"start_s": 20, "length_s": 90, "whole_if_under": 240}}

def renditions(ii, kind):
    """(url, fallback). Video: QuickTime first when Commons made one, WebM as the fallback."""
    by_key = {d.get("transcodekey"): d.get("src") for d in ii.get("derivatives") or []}
    if kind == "audio":
        return by_key.get("mp3"), None
    webm = next((by_key[k] for k in WEBM_PREFERENCE if k in by_key), None)
    mov = by_key.get(QUICKTIME)
    return (mov, webm) if mov else (webm, None)

def window(duration, kind):
    ex = EXCERPT[kind]
    if duration <= ex.get("whole_if_under", 0) or duration <= ex["length_s"]:
        return 0.0, round(duration, 1)
    start = ex["start_s"] if "start_s" in ex else duration * ex["start_frac"]
    start = min(start, duration - ex["length_s"])
    return round(start, 1), round(start + ex["length_s"], 1)

def media_candidate(page, today):
    """(card, None) or (None, reason) for a featured video or sound."""
    ii = (page.get("videoinfo") or [{}])[0]
    cid = f"wc-{page['pageid']}"
    if state.is_known(cid):
        return None, "known"
    mime = ii.get("mime") or ""
    if not mime:
        return None, "not-a-file"  # housekeeping pages in the category tree: criteria, templates, talk pages
    if mime in FORMATS or mime == "application/pdf":  # a still or a document among the media: shown as a picture, marked experimental
        return candidate({**page, "imageinfo": page.get("videoinfo")}, today, experimental=True)
    kind = "audio" if mime.startswith("audio/") or mime == "application/ogg" and not ii.get("height") else "video" if mime.startswith("video/") or mime == "application/ogg" else None
    if not kind:
        return None, "not-media"
    url, fallback = renditions(ii, kind)
    duration = ii.get("duration") or 0
    if not url or not url.startswith("https://") or duration < 8:
        return None, "no-rendition"
    title = meta(ii, "ObjectName") or re.sub(r"^File:|\.\w+$", "", page["title"]).replace("_", " ")
    categories = [c for c in meta(ii, "Categories").split("|") if c]
    license = license_of(ii)
    if not license:
        return None, "licence"
    creator = meta(ii, "Artist")
    creator = "" if re.match(r"unknown|anonymous|\?", creator, re.I) else creator[:80]
    year = taxonomy.year_of(meta(ii, "DateTimeOriginal"))
    desc = taxonomy.clean_description(meta(ii, "ImageDescription"))
    subjects = [c for c in categories if not SKIP_CATEGORY.search(c)]
    tags = taxonomy.subject_tags(subjects, 4) + [t for t in (taxonomy.era_tag(year),) if t] + ["wikimedia-commons", f"featured-{'sound' if kind == 'audio' else 'video'}"]
    page_url = ii.get("descriptionurl") or f"https://commons.wikimedia.org/?curid={page['pageid']}"
    start, end = window(duration, kind)
    score = quality.combine([(0.5, 1.0), (0.2, 1.0 if len(desc) >= 60 else 0.3), (0.15, 1.0 if creator else 0.0), (0.15, 1.0 if year else 0.0)])
    media = {"kind": kind, "url": url, "fallback": fallback, "duration": round(duration), "start": start, "end": end}
    if kind == "video":
        media["poster"] = ii.get("thumburl")
    return {
        "id": cid, "type": kind, "title": title[:140], "creator": creator or "Unknown", "date": str(year or ""),
        "source": {"institution": "Wikimedia Commons", "url": page_url, "sourceId": str(page["pageid"]), "fetchedAt": today,
                   "collection": "featured-media"},
        "rights": rights.rights(license, "worldwide", rights.attribution(creator, title, license, page_url), kind),
        "media": media,
        "editorial": {"note": desc, "noteSource": "source", "room": "film" if kind == "video" else "sound", "tags": tags[:6],
                      "tone": stable_pick(cid, ("ink", "sky", "mauve") if kind == "video" else ("ink", "sun", "sky", "mauve"))},
        "_score": score, "_group": str(year or "n/a"), "_source": "commons",
    }, None
