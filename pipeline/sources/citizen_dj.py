"""Library of Congress Citizen DJ (citizen-dj.labs.loc.gov): audio excerpts of collections the Library
states are public domain or dedicated to it. Each item's phrase clips are standalone ~30 s mp3s on the
site itself; a card plays the clip nearest the middle of the item. Only collections with a licence
in the config are read."""
import datetime
from .. import quality, rights, state, taxonomy
from ..http import get_json
from .common import reject, stable_pick

SITE = "https://citizen-dj.labs.loc.gov"
UA = {"User-Agent": "commonplace-pipeline/0.1 (research prototype)"}
ROLE = ("Musical Group", "Leader", "Vocalist", "Instrumentalist", "Conductor", "Speaker", "Performer")

def name_of(entry):
    return entry.split(" -- ")[0].strip()

def creator_of(names):
    """The performer if one is listed, else the first contributor."""
    for n in names:
        if any(r in n for r in ROLE):
            return name_of(n)
    return name_of(names[0]) if names else "Unknown"

def pick_clip(clips, duration_ms):
    """Clip whose start is nearest the middle of the item."""
    return min(clips, key=lambda c: abs(c["start"] - duration_ms / 2)) if clips else None

def run(src, stats):
    today = datetime.date.today().isoformat()
    coll, name = src["collection"], src["name"]
    meta = get_json(f"{SITE}/data/metadata/{coll}.json", headers=UA)
    phr = get_json(f"{SITE}/data/phrasedata/{coll}.json", headers=UA)
    heads = meta["itemHeadings"]
    people, topics = meta["groups"].get("contributors", []), meta["groups"].get("subjects", [])
    files = phr["groups"]["itemFilename"]
    by_item = {}
    for row in phr["items"]:
        c = dict(zip(phr["itemHeadings"], row))
        by_item.setdefault(files[c["itemFilename"]], []).append(c)
    cards = []
    for row in meta["items"]:
        it = dict(zip(heads, row))
        uid = f"cdj-{it['filename'].rsplit('.', 1)[0]}"
        if state.is_known(uid):
            reject(stats, name, "known")
            continue
        clip = pick_clip(by_item.get(it["filename"], []), 180000)
        if not clip:
            reject(stats, name, "no-clip")
            continue
        title = it["title"]
        if quality.is_junk_title(title):
            reject(stats, name, "junk-title")
            continue
        creator = creator_of([people[i] for i in it.get("contributors", [])])
        year = it.get("year") if isinstance(it.get("year"), int) else taxonomy.year_of(it.get("year"))
        subjects = [topics[i] for i in it.get("subjects", [])]
        page = it["url"] if it["url"].startswith("http") else SITE + it["url"]
        license = src["license"]
        dur = clip["dur"] / 1000
        score = quality.combine([(0.6, quality.completeness("", subjects, creator, year)), (0.4, min(1.0, dur / 30))])
        cards.append({
            "id": uid, "type": "audio", "title": title, "creator": creator, "date": str(year or ""),
            "source": {"institution": "Library of Congress", "url": page, "sourceId": it["filename"], "fetchedAt": today, "collection": coll},
            "rights": rights.rights(license, "worldwide", rights.attribution(creator, title, license, page), "audio"),
            "media": {"kind": "audio", "url": f"{SITE}/audio/samplepacks/{coll}/{clip['clipFilename']}", "fallback": None, "poster": None,
                      "duration": round(dur), "start": 0.0, "end": round(dur, 1)},
            "editorial": {"note": "", "noteSource": "source", "room": src["room"],
                          "tags": taxonomy.subject_tags(subjects, 4) + src.get("tags", []) + [t for t in (taxonomy.decade_tag(year),) if t],
                          "tone": stable_pick(uid, src["tones"])},
            "_score": score, "_group": creator, "_source": name,
        })
    return cards
