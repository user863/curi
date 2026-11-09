"""Playability probe: can iOS WebKit stream this file? Checks range support and the container head.
Returns 'yes' or the reason it failed."""
import struct
from .http import get_head, get_range

def mp4_boxes(data):
    i, out = 0, []
    while i + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[i:i + 8])
        header = 8
        if size == 1 and i + 16 <= len(data):
            size, header = struct.unpack(">Q", data[i + 8:i + 16])[0], 16
        out.append(kind.decode("latin1"))
        if size < header:
            break
        i += size
    return out

def playable(url, kind):
    try:
        info, data = get_range(url)
    except Exception:
        return "fetch-failed"
    if info["status"] != 206 or not info["contentRange"]:
        return "no-range-support"
    if kind == "video":
        boxes = mp4_boxes(data)
        if not boxes or boxes[0] != "ftyp":
            return "not-mp4"
        if "moov" not in boxes:
            return "moov-not-first"  # index at the end: slow or no start on mobile
        return "yes" if b"avc1" in data else "not-h264"
    ok = data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0)
    return "yes" if ok else "not-mp3"

IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")

def image_ok(url, max_bytes=3_500_000):
    """A phone-sized image: a browser format, and small enough to load quickly."""
    try:
        info = get_head(url)
    except Exception:
        return "fetch-failed"
    if info["contentType"] not in IMAGE_TYPES:
        return "not-web-image"
    if info["total"] is None or info["total"] > max_bytes:
        return "too-large"
    return "yes"

_BITRATES = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)  # MPEG-1 Layer III, kbit/s
_RATES = (44100, 48000, 32000, 0)

def mp3_duration(data, total):
    """Seconds, from a Xing/Info frame count if present, else a constant-bitrate estimate. None if unreadable."""
    i = 0
    if data[:3] == b"ID3" and len(data) > 10:
        i = 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
    while i + 4 < len(data) and not (data[i] == 0xFF and data[i + 1] & 0xE0 == 0xE0):
        i += 1
    if i + 4 >= len(data) or (data[i + 1] >> 3) & 3 != 3 or (data[i + 1] >> 1) & 3 != 1:  # MPEG-1 Layer III only
        return None
    bitrate, rate = _BITRATES[data[i + 2] >> 4] * 1000, _RATES[(data[i + 2] >> 2) & 3]
    if not bitrate or not rate:
        return None
    mono = (data[i + 3] >> 6) == 3
    tag = i + 4 + (17 if mono else 32)
    if data[tag:tag + 4] in (b"Xing", b"Info") and data[tag + 7] & 1:
        return int.from_bytes(data[tag + 8:tag + 12], "big") * 1152 / rate
    return (total - i) * 8 / bitrate if total else None
