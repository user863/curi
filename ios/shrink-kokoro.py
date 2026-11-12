"""Halves the Kokoro model: float32 weights to bfloat16 (327 MB to about 164 MB). The phone needs the space.
    experiments/.venv-mlx/bin/python ios/shrink-kokoro.py      (reads ios/Kokoro/original/, writes ios/Kokoro/)"""
import mlx.core as mx
from pathlib import Path

d = Path(__file__).parent / "Kokoro"
weights, meta = mx.load(str(d / "original" / "kokoro-v1_0.safetensors"), return_metadata=True)
small = {k: v.astype(mx.bfloat16) if v.dtype == mx.float32 else v for k, v in weights.items()}
mx.save_safetensors(str(d / "kokoro-v1_0.safetensors"), small, metadata=meta)
print(len(small), "tensors", round((d / "kokoro-v1_0.safetensors").stat().st_size / 1e6), "MB")
