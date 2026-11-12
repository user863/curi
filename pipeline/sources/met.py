"""The Met Open Access: highlights per department, public domain with an image."""
import datetime, urllib.parse
from .. import quality, rights, state, taxonomy
from ..http import get_json
from .common import reject, stable_pick

B = "https://collectionapi.metmuseum.org/public/collection"
NAME = "met"

ROOM_TAGS = (
    ("faces", {"portraits", "men", "women", "self-portraits", "faces", "heads", "children", "boys", "girls"}),
    ("open-air", {"landscapes", "seascapes", "skies", "clouds", "trees", "mountains", "rivers", "animals",
                  "birds", "horses", "ships", "gardens", "winter", "summer", "storms", "fields", "hunting"}),
    ("interiors", {"interiors", "still life", "flowers", "fruit", "domestic", "furniture", "tables", "food"}),
)
ROOM_DEPARTMENTS = {
    "Drawings and Prints": "line", "Photographs": "line",
    "Egyptian Art": "deep-time", "Ancient West Asian Art": "deep-time", "Greek and Roman Art": "deep-time",
}

def room_of(obj, tags):
    for room, wanted in ROOM_TAGS:
        if wanted & {t.lower() for t in tags}:
            return room
    return ROOM_DEPARTMENTS.get(obj["department"], "interiors")

def tone_of(obj):
    c = (obj.get("classification") or "") + " " + (obj.get("objectName") or "")
    if "Paintings" in c:
        return "ink"
    if any(w in c for w in ("Drawings", "Prints", "Photographs")):
        return "paper"
    return stable_pick(str(obj["objectID"]), ("mauve", "paper", "sky"))

def score(obj, tags):
    return quality.combine([
        (0.35, 1.0 if obj.get("GalleryNumber") else 0.0),  # on view now
        (0.2, 1.0 if obj.get("artistDisplayName") else 0.0),
        (0.25, min(1.0, len(tags) / 3)),
        (0.1, 1.0 if obj.get("objectDate") else 0.0),
        (0.1, 1.0 if obj.get("primaryImageSmall") else 0.0),
    ])

def card(obj, tags, today):
    begin = obj.get("objectBeginDate") or 0
    tag_list = [taxonomy.slug(t) for t in tags][:5]
    extra = [t for t in (taxonomy.era_tag(begin), taxonomy.slug(obj.get("culture") or "")) if t][:2]
    return {
        "id": f"met-{obj['objectID']}", "type": "image", "title": obj["title"],
        "creator": obj["artistDisplayName"] or "Unknown maker", "date": obj["objectDate"],
        "source": {"institution": "The Metropolitan Museum of Art, Open Access", "url": obj["objectURL"],
                   "sourceId": str(obj["objectID"]), "fetchedAt": today},
        "rights": rights.rights("CC0", "worldwide", "The Metropolitan Museum of Art (CC0)", "image",
                                creditLine=obj["creditLine"]),
        "media": {"kind": "image", "url": obj["primaryImageSmall"], "medium": obj["medium"],
                  "dimensions": obj["dimensions"], "culture": obj["culture"]},
        "editorial": {"note": f"{obj['medium']}. {obj['department']}.".replace("..", "."), "noteSource": "source",
                      "room": room_of(obj, tags), "tags": tag_list + extra,
                      "tone": tone_of(obj)},
    }

PAGE = 500  # largest page the search returns

def candidate_ids(dep, highlight):
    """Object ids of one department with an image, paginated: highlights first, then the other public-domain works."""
    for flag in ("isHighlight", "isPublicDomain") if highlight else ("isPublicDomain",):
        offset = 0
        while True:
            q = urllib.parse.urlencode({"q": "*", flag: "true", "hasImages": "true", "departmentId": dep["departmentId"],
                                        "limit": PAGE, "offset": offset})
            ids = get_json(f"{B}/v1.1/search?{q}").get("objectIDs") or []
            yield from ids
            if len(ids) < PAGE:
                break
            offset += PAGE

def run(cfg, stats):
    today = datetime.date.today().isoformat()
    departments = [d for d in get_json(f"{B}/v1/departments")["departments"]
                   if d["departmentId"] not in cfg.get("exclude_departments", [])]
    out = []
    for dep in departments:
        fresh = 0  # new works taken from this department; known ones are skipped without a fetch
        for oid in candidate_ids(dep, highlight=True):
            if fresh >= cfg["pool_per_department"]:
                break
            if state.is_known(f"met-{oid}"):
                reject(stats, NAME, "known")
                continue
            try:
                obj = get_json(f"{B}/v1/objects/{oid}", delay=cfg.get("delay", 0.1))
            except Exception:
                reject(stats, NAME, "fetch-failed")
                continue
            if not obj.get("isPublicDomain"):
                reject(stats, NAME, "not-public-domain")
                continue
            if not obj.get("primaryImageSmall"):
                reject(stats, NAME, "no-image")
                continue
            tags = [t["term"] for t in (obj.get("tags") or [])]
            c = card(obj, tags, today)
            c["_score"], c["_group"], c["_source"] = score(obj, tags), obj["department"], NAME
            out.append(c)
            fresh += 1
    return out
