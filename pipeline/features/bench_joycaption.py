"""Times the JoyCaption teacher under different llama-server settings.
    python3 -m pipeline.features.bench_joycaption --name np8 --concurrency 8 --max-tokens 48 --n 16 [--url http://127.0.0.1:8089]
Sends --n images (first ones of experiments/images.json beyond the cached ones) with --concurrency requests in flight and
reports wall time per image, and prefill / decode time from the server's own timings. Appends to experiments/bench.json."""
import argparse, base64, io, json, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image
from .joycaption import PROMPTS, SIDE

def request(url, jpeg, max_tokens):
    body = {"messages": [{"role": "system", "content": "You are a helpful image captioner."},
                         {"role": "user", "content": [{"type": "text", "text": PROMPTS["booru"]},
                                                      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}}]}],
            "max_tokens": max_tokens, "temperature": 0.6, "top_p": 0.9, "repeat_penalty": 1.15}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.load(r)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--url", default="http://127.0.0.1:8089")
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--max-tokens", type=int, default=48)
    ap.add_argument("--n", type=int, default=16)
    ap.add_argument("--dir", default="experiments")
    ap.add_argument("--note", default="")
    args = ap.parse_args()
    d = Path(args.dir)
    files = [r["file"] for r in json.loads((d / "images.json").read_text())["images"]][200:200 + args.n]
    jpegs = []
    for f in files:
        im = Image.open(d / f).convert("RGB")
        im.thumbnail((SIDE, SIDE))
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=88); jpegs.append(buf.getvalue())
    request(args.url, jpegs[0], 4)  # warm-up: graphs and caches
    t0 = time.time()
    with ThreadPoolExecutor(args.concurrency) as pool:
        results = list(pool.map(lambda j: request(args.url, j, args.max_tokens), jpegs))
    wall = time.time() - t0
    timings = [r.get("timings", {}) for r in results]
    avg = lambda k: sum(t.get(k, 0) for t in timings) / len(timings)
    row = {"name": args.name, "note": args.note, "concurrency": args.concurrency, "max_tokens": args.max_tokens, "images": len(jpegs),
           "s_per_image": round(wall / len(jpegs), 2), "prompt_tokens": round(avg("prompt_n")), "prefill_ms": round(avg("prompt_ms")),
           "decode_tokens": round(avg("predicted_n")), "decode_ms": round(avg("predicted_ms")),
           "prefill_tok_s": round(avg("prompt_per_second"), 1), "decode_tok_s": round(avg("predicted_per_second"), 1),
           "sample": results[0]["choices"][0]["message"]["content"][:160]}
    path = d / "bench.json"
    rows = json.loads(path.read_text()) if path.exists() else []
    path.write_text(json.dumps(rows + [row], indent=1, ensure_ascii=False))
    print(json.dumps(row, ensure_ascii=False))

if __name__ == "__main__":
    main()
