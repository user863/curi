"""Europeana: open-licensed images and sound from cultural-heritage providers.
Steered by Europeana's own thematic collections (art, photography, music...), spread across providers so no
single archive dominates, and probed so only files a phone can load are admitted. Needs EUROPEANA_API_KEY."""
import collections, datetime, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from .. import probe, quality, rights, secrets, state, taxonomy
from ..http import get_json, get_range
from . import visual
from .archive import excerpt
from .common import reject, stable_pick

API = "https://api.europeana.eu/record/v2/search.json"
API_DELAY = 0.125  # seconds between API calls (0.25 before)

def search(key, src, extra, rows):
    params = [("query", src.get("query", "*")), ("qf", f"TYPE:{src['type']}"), ("reusability", "open"), ("media", "true"),
              ("rows", rows), ("profile", extra.pop("profile", "rich"))]
    if src.get("theme"):
        params.append(("theme", src["theme"]))
    if src.get("concept"):
        params.append(("qf", f'skos_concept:"http://data.europeana.eu/concept/{src["concept"]}"'))
    if src.get("min_tier"):
        params.append(("qf", f"contentTier:{src['min_tier']}"))
    params += list(extra.items())
    return get_json(f"{API}?{urllib.parse.urlencode(params)}", delay=API_DELAY, headers={"X-Api-Key": key})

def providers(key, src):
    data = search(key, src, {"profile": "facets", "facet": "DATA_PROVIDER", "f.DATA_PROVIDER.facet.limit": src["providers"]}, 0)
    fields = next((f["fields"] for f in data.get("facets", []) if f["name"] == "DATA_PROVIDER"), [])
    return [f["label"] for f in fields]

def first(v):
    return (v[0] if isinstance(v, list) and v else v) or ""

def english(it, key):
    return (it.get(key) or {}).get("en") or []

PLAYER_HOSTS = ("vimeo.com", "youtu.be", "youtube.com", "euscreen.eu", "av.tib.eu", "polimedia.upv.es", "dailymotion.com")

def is_file(url):
    """A video URL that is a file, not a page with a player."""
    parts = urllib.parse.urlparse(url)
    return not any(h in parts.netloc for h in PLAYER_HOSTS) and not parts.path.endswith((".html", ".htm")) and "/player" not in parts.path

def candidate(it, src, today):
    license = rights.license_from_url(first(it.get("rights")))
    if not license:
        return None, "license"
    if it.get("previewNoDistribute"):
        return None, "no-distribute"
    url = first(it.get("edmIsShownBy"))
    if not url.startswith("http"):
        return None, "no-media"
    if src["kind"] == "video" and not is_file(url):
        return None, "player-page"
    title, creator = first(it.get("title")), first(it.get("dcCreator"))
    if not title or len(title) < 3:
        return None, "no-title"
    year = taxonomy.year_of(first(it.get("year")))
    desc = taxonomy.clean_description(first(it.get("dcDescription")))
    provider = first(it.get("dataProvider"))
    cid = "eu-" + it["id"].strip("/").replace("/", "_")
    if state.is_known(cid):
        return None, "known"
    guid = f"https://www.europeana.eu/item{it['id']}"
    kind = src["kind"]
    types = english(it, "dcTypeLangAware")
    labels = [*types, *english(it, "edmConceptPrefLabelLangAware"), *english(it, "dcSubjectLangAware")]
    tags = taxonomy.subject_tags(labels, 4) or taxonomy.subject_tags([first(it.get("country"))], 1)
    tags += [t for t in (taxonomy.era_tag(year) if kind == "image" else taxonomy.decade_tag(year),) if t]
    tags += src.get("tags", [])
    completeness = it.get("completeness") or 0
    score = quality.combine([
        (0.3, completeness / 10 if completeness else None),  # 0 means not reported (sound)
        (0.25, 1.0 if len(desc) >= 80 else 0.3), (0.15, 1.0 if creator else 0.0), (0.1, 1.0 if year else 0.0),
        (0.2, 1.0 if first(it.get("edmPreview")) else 0.0)])
    card = {
        "id": cid, "type": kind, "title": title, "creator": creator or "Unknown", "date": str(year or ""),
        "source": {"institution": f"{provider} via Europeana", "url": guid, "sourceId": it["id"], "fetchedAt": today,
                   "collection": src.get("theme")},
        "rights": rights.rights(license, "worldwide", rights.attribution(creator, title, license, guid) + f"; {provider} via Europeana", kind),
        "media": {"kind": kind, "url": url, **({"poster": first(it.get("edmPreview"))} if kind == "video" else {})},
        "editorial": {"note": desc, "noteSource": "source", "room": src.get("room") or visual.room_of(f"{title} {desc} {' '.join(labels)}", f"{src.get('theme', '')} {' '.join(types)}"),
                      "tags": tags[:6], "tone": visual.tone_of(first(types), cid) if kind == "image" and types else stable_pick(cid, tuple(src["tones"]))},
        "_score": score, "_group": provider, "_source": src["name"],
    }
    if card["rights"]["gate"] != "yes":  # e.g. share-alike audio: an excerpt is an adaptation
        return None, f"rights-gate-{card['rights']['gate']}"
    return card, None

def admit(card, src, stats):
    """Probe the media. Images must be web formats under the size budget; audio must stream from an excerpt start."""
    url = card["media"]["url"]
    if card["type"] == "image":
        verdict, secure = probe.secure_image(url)
        card["media"]["url"] = secure
        if verdict == "too-large":  # admitted and marked, to see how they load on a phone
            card["editorial"]["tags"].append("large-image")
            return True, "yes"
        return verdict == "yes", verdict
    if card["type"] == "video":
        verdict, seconds, size = probe.mp4_info(url)
        if verdict != "yes":
            return False, verdict
        if seconds < src["min_seconds"]:
            return False, "too-short"
        if size * 8 / seconds > src["max_bps"]:
            return False, "too-heavy"  # an excerpt would cost a phone too much data
        start, end = excerpt(seconds, src)
        card["media"].update({"duration": round(seconds), "start": start, "end": end})
        return True, "yes"
    verdict = probe.playable(url, "audio")
    if verdict != "yes":
        return False, verdict
    info, data = get_range(url)
    total = int(info["contentRange"].rsplit("/", 1)[-1])
    duration = probe.mp3_duration(data, total)
    if not duration or duration < src["min_seconds"]:
        return False, "too-short-or-unreadable"
    ex = src["excerpt"]
    whole = duration <= ex.get("whole_if_under", 0) or duration <= ex["length_s"]
    start = 0.0 if whole else min(ex["start_s"], duration - ex["length_s"])
    card["media"].update({"duration": round(duration), "start": round(start, 1), "end": round(duration if whole else start + ex["length_s"], 1)})
    return True, "yes"

def safe_admit(card, src, stats):
    try:
        return admit(card, src, stats)
    except Exception:
        return False, "fetch-failed"

REASON_PREFIX = {"audio": "unplayable", "video": "video"}

def probe_all(cards, src, stats):
    """Keeps the cards whose media loads on a phone; probes in parallel."""
    out = []
    with ThreadPoolExecutor(max_workers=src.get("workers", 16)) as ex:
        for i, (card, (ok, verdict)) in enumerate(zip(cards, ex.map(lambda c: safe_admit(c, src, stats), cards)), 1):
            if i % 2000 == 0:
                print(f"{src['name']}: probed {i} of {len(cards)}, {len(out)} usable, failed so far {stats.get(src['name'], {})}", flush=True)
            if ok:
                out.append(card)
            else:
                reject(stats, src["name"], f"{REASON_PREFIX.get(card['type'], 'image')}-{verdict}")
    return out

def run(src, stats):
    name, key = src["name"], secrets.get("EUROPEANA_API_KEY")
    if not key:
        reject(stats, name, "no-api-key")
        print(f"{name}: skipped, EUROPEANA_API_KEY is not set (see pipeline/README.md)", flush=True)
        return []
    today = datetime.date.today().isoformat()
    pool = []
    for provider in providers(key, src):
        for start in range(1, src["per_provider"] + 1, 100):  # deeper pages: known works are skipped, so each run goes further
            rows = min(100, src["per_provider"] - start + 1)
            data = search(key, src, {"qf": f'DATA_PROVIDER:"{provider}"', "sort": "COMPLETENESS desc", "start": start}, rows)
            items = data.get("items", [])
            for it in items:
                card, why = candidate(it, src, today)
                if card:
                    pool.append(card)
                else:
                    reject(stats, name, why)
            if len(items) < rows:
                break
    # Best first within each provider; probe only what could be selected, in parallel.
    by_provider = collections.defaultdict(list)
    for card in sorted(pool, key=lambda c: c["_score"], reverse=True):
        by_provider[card["_group"]].append(card)
    shortlist = [c for cards in by_provider.values() for c in cards[: src["max_per_group"] * 2]]
    return probe_all(shortlist, src, stats)
