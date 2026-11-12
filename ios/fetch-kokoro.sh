#!/bin/sh
# Downloads the Kokoro-82M model (327 MB) and the voice styles (15 MB) that the app bundles. They are not in git.
# The model is float32; ios/shrink-kokoro.py makes the bfloat16 copy the app bundles (half the size; the phone needs the space).
# Both come from the KokoroTestApp repository, in the format the KokoroSwift package loads.
set -e
cd "$(dirname "$0")"
mkdir -p Kokoro/original
curl -L -o Kokoro/original/kokoro-v1_0.safetensors "https://media.githubusercontent.com/media/mlalma/KokoroTestApp/main/Resources/kokoro-v1_0.safetensors"
curl -L -o Kokoro/voices.npz "https://raw.githubusercontent.com/mlalma/KokoroTestApp/main/Resources/voices.npz"
cd ..
experiments/.venv-mlx/bin/python ios/shrink-kokoro.py
