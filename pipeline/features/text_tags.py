"""Tags for the textual works (quotes, poems, speeches, passages), in the style of the image tags, so texts and pictures can be grouped
in one vocabulary. The same local model as the image teacher (JoyCaption's Llama 3.1 base, MLX 4-bit) is used text-only.
    experiments/.venv-mlx/bin/python -m pipeline.features.text_tags [--out experiments/text/tags_raw.jsonl] [--max-tokens 64]
Reads published passages from pipeline/works.sqlite; appends {uid, title, creator, kind, tags, text, seconds} per work. Resumable.
The next step (snap_text_tags.py) maps these free tags onto the image vocabulary."""
import argparse, json, sqlite3, time
from pathlib import Path
from mlx_vlm import load, generate

MODEL = "experiments/models/joycaption-mlx4"
DB = Path(__file__).resolve().parents[1] / "works.sqlite"
SYSTEM = "You are a careful reader who tags literary texts for a visual archive."
ASK = ("Write 14 to 18 short lowercase tags for this {kind}, as a comma-separated list. Cover its imagery and subjects (things, places, "
       "people, nature, weather, time of day), its mood, and its themes. Use plain common words of one to three words, the way pictures are "
       "tagged, for example: tree, night sky, sea, solitary figure, war, soldier, grief, spring, hope. Output only the tags.\n\n"
       "Title: {title}\nAuthor: {creator}\n\n{body}")
KINDS = {"quote": "quotation", "poem": "poem", "speech": "speech excerpt", "prose": "prose passage"}

def works():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""SELECT w.uid, c.title, c.creator, t.body, t.verse,
        (SELECT group_concat(g.slug) FROM work_tag wt JOIN tag g ON g.id = wt.tag_id WHERE wt.work_id = w.id) AS tags
        FROM work w JOIN work_card c ON c.work_id = w.id JOIN work_text t ON t.work_id = w.id
        WHERE w.state = 'published' AND w.type = 'passage' ORDER BY w.id""").fetchall()
    for r in rows:
        tags = (r["tags"] or "").split(",")
        kind = next((k for k in ("quote", "poem", "speech") if k in tags), "poem" if r["verse"] else "prose")
        yield {"uid": r["uid"], "title": r["title"], "creator": r["creator"], "body": r["body"], "kind": kind}

def tags_of(text):
    raw = [t.strip().lower().strip(".") for t in text.replace("\\n", ",").replace("\n", ",").split(",") if t.strip()]
    return list(dict.fromkeys(raw[:-1] if len(raw) > 18 else raw))[:18]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="experiments/text/tags_raw.jsonl")
    ap.add_argument("--max-tokens", type=int, default=64)
    args = ap.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = {json.loads(l)["uid"] for l in out.read_text().splitlines() if l.strip()} if out.exists() else set()
    todo = [w for w in works() if w["uid"] not in done]
    print(f"{len(todo)} to tag, {len(done)} done", flush=True)
    model, processor = load(MODEL)
    for n, w in enumerate(todo, 1):
        t = time.time()
        prompt = processor.tokenizer.apply_chat_template(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": ASK.format(kind=KINDS[w["kind"]], title=w["title"], creator=w["creator"], body=w["body"])}],
            tokenize=False, add_generation_prompt=True)
        res = generate(model, processor, prompt, max_tokens=args.max_tokens, temperature=0.4, verbose=False)
        rec = {"uid": w["uid"], "title": w["title"], "creator": w["creator"], "kind": w["kind"], "tags": tags_of(res.text), "text": res.text, "seconds": round(time.time() - t, 2)}
        with out.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        if n % 10 == 0 or n <= 3:
            print(f"{len(done) + n} done, {rec['seconds']}s last: {', '.join(rec['tags'][:8])}", flush=True)
    print("finished")

if __name__ == "__main__":
    main()
