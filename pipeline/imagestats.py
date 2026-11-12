"""Technical quality of a picture: size, compression and sharpness. Pure apart from PIL and numpy.
    features(data, size)  size = (w, h) of the file as fetched, before any draft-mode downscale
Used by quality_v2 (weak scans, thumbnails, over-compressed or blurred files)."""
import io
import numpy as np
from PIL import Image

SHARP_SIDE = 256  # long side the sharpness is measured at, so it does not depend on resolution

def sharpness(img):
    """Variance of the Laplacian of the grey picture at SHARP_SIDE, 0 for a flat or blurred one."""
    g = img.convert("L")
    g.thumbnail((SHARP_SIDE, SHARP_SIDE), Image.BILINEAR)
    a = np.asarray(g, dtype=np.float64)
    if min(a.shape) < 3:
        return 0.0
    lap = 4 * a[1:-1, 1:-1] - a[:-2, 1:-1] - a[2:, 1:-1] - a[1:-1, :-2] - a[1:-1, 2:]
    return float(lap.var())

def features(data, size, img=None):
    """{longSide, bytesPerPixel, sharp}; img: the already opened picture, if the caller has it."""
    w, h = size
    img = img or Image.open(io.BytesIO(data))
    return {"longSide": max(w, h), "bytesPerPixel": round(len(data) * 8 / max(1, w * h), 3), "sharp": round(sharpness(img), 1)}
