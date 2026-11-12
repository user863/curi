"""Assigns image rooms from the picture: SigLIP zero-shot over medium and subject prompts.
    experiments/.venv/bin/python -m pipeline.features.classify_rooms [--apply]
Without --apply it prints counts and samples only. Works already in deep-time (by museum department) keep it."""
import sys, sqlite3, collections
import numpy as np
import torch
from transformers import AutoModel, AutoProcessor
from pipeline.features.switch_embedding import DB, MODEL, image_vectors, unit

ROOMS = {
    "paintings": ["a painting", "an oil painting on canvas", "a watercolor painting", "a painted altarpiece", "an impressionist painting"],
    "drawings": ["a pencil drawing", "an ink sketch on paper", "an engraving", "a woodcut print", "an etching", "a lithograph"],
    "people": ["a portrait photograph of a person", "a photograph of a group of people", "a black and white portrait photo", "a photo of a face"],
    "landscapes": ["a landscape photograph", "a photograph of mountains and a lake", "a photo of the sea and sky", "a photograph of countryside and fields"],
    "cities": ["a photograph of a building", "a photograph of a city street", "a photo of a church facade", "an architectural photograph"],
    "wildlife": ["a photograph of an animal", "a macro photograph of an insect", "a photo of a bird", "a close-up photograph of a flower"],
    "objects": ["a sculpture", "a statue", "a museum object photographed on a plain background", "a ceramic vase", "a piece of jewellery", "a piece of furniture"],
    "manuscripts": ["a map", "a page of a manuscript", "a page of printed text", "an illuminated manuscript", "a handwritten letter"],
    "interiors": ["a photograph of a room interior", "a still life of fruit and flowers on a table", "a view of an interior with a window"],
}

# Model and source tags that vouch for a room; each adds to the zero-shot score.
TAG_ROOM = {
    "paintings": ["painting", "oil-painting", "watercolor"],
    "drawings": ["drawing", "sketch", "print", "engraving", "etching", "ink", "pencil", "illustration", "hand-drawn", "woodcut", "lithograph"],
    "people": ["portrait", "people", "group-people", "side-profile"],
    "landscapes": ["landscape", "mountain", "lake", "river", "ocean", "forest", "horizon"],
    "cities": ["architecture", "cityscape", "building", "urban", "street", "gothic-architecture"],
    "wildlife": ["wildlife", "bird", "animal", "insect", "flower", "macro-photography"],
    "objects": ["sculpture", "statue", "ceramic", "artifact", "carving", "object"],
    "manuscripts": ["map", "manuscript", "text", "images-with-annotations", "architectural-drawing"],
    "interiors": ["interior", "ceiling", "still-life"],
}
TAG_BONUS = 0.6

def text_features(prompts):
    model = AutoModel.from_pretrained(MODEL).eval()
    proc = AutoProcessor.from_pretrained(MODEL)
    out = []
    with torch.no_grad():
        for r, ps in ROOMS.items():
            x = proc(text=ps, padding="max_length", max_length=64, truncation=True, return_tensors="pt")
            out.append(unit(torch.nn.functional.normalize(model.get_text_features(**x), dim=-1).numpy()).mean(0))
    return unit(np.stack(out))

def main(apply):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT w.id, w.uid, w.room, c.title FROM work w JOIN work_card c ON c.work_id=w.id WHERE w.state='published' AND w.type='image'").fetchall()
    img = image_vectors()
    rows = [r for r in rows if r["uid"] in img]
    scores = np.stack([img[r["uid"]] for r in rows]) @ text_features(ROOMS).T
    tags = collections.defaultdict(set)
    for t in conn.execute("SELECT wt.work_id, t.slug FROM work_tag wt JOIN tag t ON t.id=wt.tag_id"):
        tags[t[0]].add(t[1])
    bonus = np.array([[TAG_BONUS * len(tags[r["id"]] & set(TAG_ROOM[n])) ** 0.5 for n in ROOMS] for r in rows])
    z = (scores - scores.mean(0)) / scores.std(0)  # per-class standardise: removes each prompt's baseline
    names = list(ROOMS)
    pick = [names[i] if r["room"] != "deep-time" else "deep-time" for r, i in zip(rows, (z + bonus).argmax(1))]
    print(collections.Counter(pick).most_common())
    rng = np.random.default_rng(1)
    for n in names:
        idx = [i for i, p in enumerate(pick) if p == n]
        print(f"\n{n} ({len(idx)})")
        for i in rng.choice(idx, min(8, len(idx)), replace=False):
            print("  ", rows[i]["uid"], rows[i]["title"][:70])
    if apply:
        conn.executemany("UPDATE work SET room=? WHERE id=?", [(p, r["id"]) for r, p in zip(rows, pick)])
        conn.commit()
        print("applied")

if __name__ == "__main__":
    main("--apply" in sys.argv)
