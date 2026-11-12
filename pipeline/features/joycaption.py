"""JoyCaption Alpha Two through a local llama.cpp server (GGUF, no cloud): booru tags and a short description per image.
    llama-server -m <Q6_K.gguf> --mmproj <mmproj.gguf> --port 8089 -c 4096 -ngl 99
    python3 -m pipeline.features.joycaption [--dir experiments] [--meta images.json] [--limit N]
Writes <dir>/joycaption.json: {file: {"booru": [...], "caption": "..."}}; resumes from an existing file."""
import argparse, base64, io, json, time, urllib.request
from pathlib import Path
from PIL import Image

PROMPTS = {"booru": "Write a list of Booru-like tags for this image.",
           "caption": "Write a straightforward caption for this image. Begin with the main subject and medium. Mention pivotal elements, colors, lighting, and mood."}
SIDE = 640

def ask(url, prompt, jpeg, max_tokens):
    body = {"messages": [{"role": "system", "content": "You are a helpful image captioner."},
                         {"role": "user", "content": [{"type": "text", "text": prompt},
                                                      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}}]}],
            "max_tokens": max_tokens, "temperature": 0.6, "top_p": 0.9, "repeat_penalty": 1.15}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()

def jpeg_of(path):
    im = Image.open(path).convert("RGB")
    im.thumbnail((SIDE, SIDE))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return buf.getvalue()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments")
    ap.add_argument("--meta", default="images.json")
    ap.add_argument("--url", default="http://127.0.0.1:8089")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--caption", action="store_true", help="also write a short description (slow)")
    args = ap.parse_args()
    d = Path(args.dir)
    files = [r["file"] for r in json.loads((d / args.meta).read_text())["images"]]
    if args.limit:
        files = files[:args.limit]
    out_path = d / "joycaption.json"
    out = json.loads(out_path.read_text()) if out_path.exists() else {}
    t0 = time.time()
    for n, f in enumerate(files, 1):
        if f in out:
            continue
        jpeg = jpeg_of(d / f)
        raw = [t.strip().lower() for t in ask(args.url, PROMPTS["booru"], jpeg, 100).replace("\n", " ").split(",") if t.strip()]
        tags = list(dict.fromkeys(raw[:-1] if len(raw) > 12 else raw))  # a cut-off last tag is dropped; repeats removed
        out[f] = {"booru": tags, "caption": ask(args.url, PROMPTS["caption"], jpeg, 120) if args.caption else ""}
        out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False))
        print(f"[{n}/{len(files)}] {time.time() - t0:.0f}s {f}: {', '.join(tags[:8])}", flush=True)

if __name__ == "__main__":
    main()
