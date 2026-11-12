"""JoyCaption through MLX (4-bit), with optional pooling of the image tokens before the language model.
    experiments/.venv-mlx/bin/python -m pipeline.features.joycaption_mlx --model experiments/models/joycaption-mlx4 --pool 2 --n 24
--pool k averages k x k neighbouring patches before the projector: 729 image tokens (k=1) -> 169 (k=2) -> 81 (k=3).
The model was not trained on pooled input; the benchmark compares its tags with the unpooled teacher's.
Appends to experiments/bench_mlx.json."""
import argparse, json, time
from pathlib import Path
import mlx.core as mx
from mlx_vlm import load, generate
from mlx_vlm.models.llava import llava
from .joycaption import PROMPTS

GRID = 27   # 384 px / 14 px patches

def pooled(k):
    """Model.get_input_embeddings with k x k average pooling of the patch features."""
    def get_input_embeddings(self, input_ids=None, pixel_values=None, **kwargs):
        embeds = self.language_model.model.embed_tokens(input_ids)
        if pixel_values is None:
            return llava.InputEmbeddingsFeatures(inputs_embeds=embeds)
        *_, hidden = self.vision_tower(pixel_values.transpose(0, 2, 3, 1), output_hidden_states=True)
        feat = hidden[self.vision_feature_layer]                             # (1, 729, C): SigLIP has no CLS token
        if k > 1:
            n = GRID // k
            b, _, c = feat.shape
            feat = feat.reshape(b, GRID, GRID, c)[:, :n * k, :n * k]
            feat = feat.reshape(b, n, k, n, k, c).mean(axis=(2, 4)).reshape(b, n * n, c)
        image = self.multi_modal_projector(feat)
        return llava.InputEmbeddingsFeatures(inputs_embeds=self._merge_input_ids_with_image_features(image, embeds, input_ids))
    return get_input_embeddings

def tags_of(text):
    raw = [t.strip().lower() for t in text.replace("\n", " ").split(",") if t.strip()]
    return list(dict.fromkeys(raw[:-1] if len(raw) > 12 else raw))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--pool", type=int, default=1)
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--max-tokens", type=int, default=48)
    ap.add_argument("--dir", default="experiments")
    ap.add_argument("--name", default="")
    args = ap.parse_args()
    d = Path(args.dir)
    teacher = json.loads((d / "joycaption.json").read_text())   # llama.cpp Q6_K, unpooled, 100 tokens
    files = list(teacher)[:args.n]
    model, processor = load(args.model)
    llava.Model.get_input_embeddings = pooled(args.pool)
    processor.patch_size = 14 * args.pool                         # the processor expands <image> to (384 // patch)^2 tokens
    # the template puts one placeholder token (id = image_token_index) between start and end markers; the processor expands it
    processor.image_token = processor.tokenizer.convert_ids_to_tokens(model.config.image_token_index)
    processor.image_token_id = model.config.image_token_index
    processor.vision_feature_select_strategy = "full"
    processor.num_additional_image_tokens = 0
    prompt = processor.tokenizer.apply_chat_template(
        [{"role": "system", "content": "You are a helpful image captioner."}, {"role": "user", "content": PROMPTS["booru"]}],
        tokenize=False, add_generation_prompt=True)
    generate(model, processor, prompt, image=[str(d / files[0])], max_tokens=4, verbose=False)   # warm-up
    rows, t0 = [], time.time()
    for f in files:
        t = time.time()
        r = generate(model, processor, prompt, image=[str(d / f)], max_tokens=args.max_tokens, temperature=0.6, verbose=False)
        mine, ref = set(tags_of(r.text)), set(teacher[f]["booru"])
        words = lambda s: {w for x in s for w in x.replace("-", " ").split()}
        rows.append({"file": f, "s": time.time() - t, "prompt_tokens": r.prompt_tokens, "prefill_s": r.prompt_tokens / max(r.prompt_tps, 1e-9),
                     "decode_tokens": r.generation_tokens, "decode_tps": r.generation_tps, "text": r.text,
                     "tag_overlap": len(mine & ref) / max(1, len(mine)), "word_overlap": len(words(mine) & words(ref)) / max(1, len(words(mine)))})
    avg = lambda k: round(sum(r[k] for r in rows) / len(rows), 3)
    out = {"name": args.name or f"mlx_pool{args.pool}", "model": args.model, "pool": args.pool, "images": len(rows), "max_tokens": args.max_tokens,
           "s_per_image": avg("s"), "prompt_tokens": avg("prompt_tokens"), "prefill_s": avg("prefill_s"), "decode_tokens": avg("decode_tokens"),
           "decode_tps": avg("decode_tps"), "tag_overlap": avg("tag_overlap"), "word_overlap": avg("word_overlap"), "sample": rows[0]["text"][:200]}
    path = d / "bench_mlx.json"
    prev = json.loads(path.read_text()) if path.exists() else []
    path.write_text(json.dumps(prev + [{**out, "rows": rows}], indent=1, ensure_ascii=False))
    print(json.dumps(out, ensure_ascii=False))

if __name__ == "__main__":
    main()
