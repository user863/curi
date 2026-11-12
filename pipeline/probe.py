"""Playability probe: can iOS WebKit stream this file? Checks range support and the container head.
Returns 'yes' or the reason it failed."""
import re, struct
from .http import BROWSER_UA, get_head, get_range, get_span

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

def mp4_info(url):
    """('yes', seconds, bytes) for an h264 MP4 that streams by range, wherever its index (moov) sits; else (reason, None, None).
    A file with the index at the end still starts: the player reads the end first. It starts a little slower."""
    try:
        info, head = get_range(url, 4096)
    except Exception:
        return "fetch-failed", None, None
    if info["status"] != 206 or not info["contentRange"]:
        return "no-range-support", None, None
    total = int(info["contentRange"].rsplit("/", 1)[-1])
    if head[4:8] != b"ftyp":
        return "not-mp4", None, None
    offset = 0
    try:
        while offset + 8 <= total:  # walk the top-level boxes by their headers: ftyp, mdat..., moov
            box = get_span(url, offset, 16) if offset else head[:16]
            size, kind = struct.unpack(">I4s", box[:8])
            if size == 1:
                size = struct.unpack(">Q", box[8:16])[0]
            if kind == b"moov":
                data = get_span(url, offset, min(size, 300_000))
                return _moov_summary(data, total)
            if size < 8:
                return "bad-box", None, None
            offset += size
    except Exception:
        return "fetch-failed", None, None
    return "no-moov", None, None

def _moov_summary(moov, total):
    i = moov.find(b"mvhd")
    if i < 0:
        return "no-mvhd", None, None
    v = moov[i + 4]
    scale, length = struct.unpack(">II", moov[i + 16:i + 24]) if v == 0 else (struct.unpack(">I", moov[i + 24:i + 28])[0], struct.unpack(">Q", moov[i + 28:i + 36])[0])
    if not scale or not length:
        return "no-duration", None, None
    return ("yes" if b"avc1" in moov else "not-h264"), length / scale, total

def secure_image(url):
    """(verdict, url). An http:// address is upgraded to https when the host serves it there."""
    url = "https://" + url[len("http://"):] if url.startswith("http://") else url
    return image_ok(url), url

IIIF_SIZE = re.compile(r"(/full/!)(\d+),(\d+)(/0/default\.jpg)$")
WANTED_SIDE = 1920  # long side asked of every source that sizes on request (IIIF, Commons thumbnails); also a Commons standard size

def larger(url):
    """An IIIF address that asks for a smaller bounding box than WANTED_SIDE asks for WANTED_SIDE; other addresses stay."""
    m = IIIF_SIZE.search(url)
    if not m or int(m.group(2)) >= WANTED_SIDE:
        return url
    return url[:m.start()] + f"{m.group(1)}{WANTED_SIDE},{WANTED_SIDE}{m.group(4)}"

IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")

def image_ok(url, max_bytes=3_500_000):
    """A phone-sized image: served over https (an https page cannot load http images), a browser format, small enough
    to load quickly. Fetched the way a phone does: browser user agent, no referrer."""
    if not url.startswith("https://"):
        return "not-https"
    try:
        info = get_head(url, ua=BROWSER_UA)
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
