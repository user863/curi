"""Labels the training set with the JoyCaption teacher (MLX 4-bit, image tokens pooled 2x2) as the download delivers it.
    experiments/.venv-mlx/bin/python -m pipeline.features.label_train [--dir experiments/train] [--pool 2] [--max-tokens 48]
Follows <dir>/manifest.jsonl, never gets ahead of the downloader, and appends one line per image to <dir>/labels.jsonl:
{file, uid, tags, text, seconds}. Resumable: images already in labels.jsonl are skipped. Exits when the downloader is
gone and everything is labelled."""
import argparse, json, subprocess, time
from pathlib import Path
from mlx_vlm import load, generate
from mlx_vlm.models.llava import llava
from .joycaption import PROMPTS
from .joycaption_mlx import pooled, tags_of

MODEL = "experiments/models/joycaption-mlx4"
IDLE_S = 20

def downloading():
    return subprocess.run(["pgrep", "-f", "pipeline.sample_training"], capture_output=True).returncode == 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/train")
    ap.add_argument("--pool", type=int, default=2)
    ap.add_argument("--max-tokens", type=int, default=48)
    args = ap.parse_args()
    d = Path(args.dir)
    out = d / "labels.jsonl"
    model, processor = load(MODEL)
    llava.Model.get_input_embeddings = pooled(args.pool)
    processor.patch_size = 14 * args.pool
    processor.image_token = processor.tokenizer.convert_ids_to_tokens(model.config.image_token_index)
    processor.image_token_id = model.config.image_token_index
    processor.vision_feature_select_strategy = "full"
    processor.num_additional_image_tokens = 0
    prompt = processor.tokenizer.apply_chat_template(
        [{"role": "system", "content": "You are a helpful image captioner."}, {"role": "user", "content": PROMPTS["booru"]}],
        tokenize=False, add_generation_prompt=True)
    done = {json.loads(l)["file"] for l in out.read_text().splitlines()} if out.exists() else set()
    n = 0
    while True:
        rows = [json.loads(l) for l in (d / "manifest.jsonl").read_text().splitlines() if l.strip()]
        todo = [r for r in rows if r["file"] not in done]
        if not todo:
            if not downloading():
                break
            time.sleep(IDLE_S)
            continue
        for r in todo:
            t = time.time()
            try:
                res = generate(model, processor, prompt, image=[str(d / r["file"])], max_tokens=args.max_tokens, temperature=0.6, verbose=False)
                rec = {"file": r["file"], "uid": r["uid"], "tags": tags_of(res.text), "text": res.text, "seconds": round(time.time() - t, 2)}
            except Exception as e:  # an unreadable file: recorded, not retried
                rec = {"file": r["file"], "uid": r["uid"], "tags": [], "text": "", "error": str(e)[:160], "seconds": round(time.time() - t, 2)}
            with out.open("a") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            done.add(r["file"])
            n += 1
            if n % 25 == 0:
                print(f"{len(done)} labelled of {len(rows)} downloaded, {rec['seconds']}s last", flush=True)
    print(f"finished: {len(done)} labelled")

if __name__ == "__main__":
    main()
