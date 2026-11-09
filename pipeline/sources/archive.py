"""Internet Archive video and audio from collections that assert public-domain status.
Plays an excerpt of the original file by time range; nothing is re-encoded or stored."""
import datetime, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from .. import probe, quality, rights, state, taxonomy
from ..http import get_json
from .common import reject, parse_seconds, stable_pick

FIELDS = ["identifier", "title", "creator", "description", "subject", "collection", "licenseurl",
          "downloads", "avg_rating", "num_reviews", "year", "date"]
# Lightest first: a small file starts fast on a phone connection.
VIDEO_FORMATS = ("512Kb MPEG4", "h.264", "MPEG4")
AUDIO_FORMATS = ("64Kbps MP3", "VBR MP3", "128Kbps MP3", "MP3")

def search(src, pool):
    q = (f"collection:{src['collection']} AND mediatype:{src['mediatype']} AND licenseurl:(*publicdomain*)"
         f" AND downloads:[{src['min_downloads']} TO 1000000000] {src.get('query_extra', '')}")
    params = [("q", q), ("rows", pool), ("page", 1), ("output", "json"), ("sort[]", "downloads desc")]
    params += [("fl[]", f) for f in FIELDS]
    return get_json("https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(params))["response"]["docs"]

def candidate_files(files, src):
    """Files long enough for the excerpt, lightest format first."""
    wanted = VIDEO_FORMATS if src["kind"] == "video" else AUDIO_FORMATS
    cands = [(f, parse_seconds(f.get("length"))) for f in files if f.get("format") in wanted]
    cands = [(f, d) for f, d in cands if d and d >= src["min_seconds"]]
    prefer = [p.lower() for p in src.get("prefer_files", [])]
    cands.sort(key=lambda fd: (not any(p in fd[0]["name"].lower() for p in prefer), wanted.index(fd[0]["format"]), fd[0]["name"]))
    return cands

def download_url(ident, name):
    return f"https://archive.org/download/{ident}/{urllib.parse.quote(name)}"

def pick_playable(ident, files, src, stats):
    """First two playable files of different format: [(url, duration)], primary then fallback."""
    out, formats = [], set()
    for f, d in candidate_files(files, src):
        if f["format"] in formats:
            continue
        url = download_url(ident, f["name"])
        verdict = probe.playable(url, src["kind"])
        if verdict != "yes":
            reject(stats, src["name"], f"unplayable-{verdict}")
            continue
        formats.add(f["format"])
        out.append((url, d))
        if len(out) == 2:
            break
    return out

def excerpt(duration, src):
    ex = src["excerpt"]
    if duration <= ex.get("whole_if_under", 0) or duration <= ex["length_s"]:
        return 0.0, duration
    start = ex["start_s"] if "start_s" in ex else duration * ex["start_frac"]
    start = min(start, duration - ex["length_s"])
    return round(start, 1), round(start + ex["length_s"], 1)

def first(v):
    return (v[0] if isinstance(v, list) else v) or ""

def process(doc, src, stats, today):
    """One search hit -> a card, or None (with the reason counted)."""
    name = src["name"]
    if True:
        ident = doc["identifier"]
        if state.is_known(f"ia-{ident}"):
            reject(stats, name, "known")
            return None
        license = rights.license_from_url(doc.get("licenseurl"))
        if not license:
            reject(stats, name, "no-open-license")
            return None
        if quality.is_junk_title(doc.get("title")):
            reject(stats, name, "junk-title")
            return None
        try:
            meta = get_json(f"https://archive.org/metadata/{ident}", delay=0.2)
        except Exception:
            reject(stats, name, "fetch-failed")
            return None
        playable = pick_playable(ident, meta.get("files", []), src, stats)
        if not playable:
            reject(stats, name, "no-playable-file")
            return None
        (url, duration), fallback = playable[0], (playable[1][0] if len(playable) > 1 else None)
        start, end = excerpt(duration, src)
        year = taxonomy.year_of(doc.get("year") or doc.get("date"))
        subjects = taxonomy.as_list(doc.get("subject"))
        description = taxonomy.clean_description(first(doc.get("description")))
        creator = first(doc.get("creator")) or "Unknown"
        pop = quality.popularity(doc.get("downloads"))
        fit = 1.0 if src["min_seconds"] <= duration <= 3600 else 0.6
        score = quality.combine([(0.4, pop), (0.2, quality.rating(doc.get("avg_rating"), doc.get("num_reviews"))),
                                 (0.3, quality.completeness(first(doc.get("description")), subjects, creator, year)),
                                 (0.1, fit)])
        card = {
            "id": f"ia-{ident}", "type": src["kind"], "title": first(doc["title"]), "creator": creator,
            "date": str(year or "") if src.get("show_date", True) else "",
            "source": {"institution": "Internet Archive", "url": f"https://archive.org/details/{ident}",
                       "sourceId": ident, "fetchedAt": today, "collection": src["collection"]},
            "rights": rights.rights(license, "worldwide", rights.attribution(creator, first(doc["title"]), license, f"https://archive.org/details/{ident}"), src["kind"]),
            "media": {"kind": src["kind"], "url": url, "fallback": fallback, "poster": f"https://archive.org/services/img/{ident}",
                      "duration": round(duration), "start": start, "end": end},
            "editorial": {"note": description, "noteSource": "source", "room": src["room"],
                          "tags": (taxonomy.subject_tags(subjects, 4) + src.get("tags", [])
                                   + [t for t in (taxonomy.decade_tag(year),) if t and src.get("decade_tag", True)]),
                          "tone": stable_pick(ident, src["tones"])},
            "_score": score, "_group": {"creator": creator, "none": ident}.get(src.get("group"), taxonomy.decade_tag(year) or "n/a"),
            "_source": name,
        }
        return card

def run(src, stats):
    today = datetime.date.today().isoformat()
    with ThreadPoolExecutor(max_workers=src.get("workers", 8)) as pool:
        cards = pool.map(lambda d: process(d, src, stats, today), search(src, src["pool"]))
        return [c for c in cards if c]
