"""Cached, polite HTTP. Responses are cached on disk so reruns are cheap and repeatable."""
import hashlib, json, threading, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path

CACHE = Path(__file__).parent / ".cache"
UA = "commonplace-pipeline/0.1 (research prototype)"
_lock = threading.Lock()
_next = {}  # host -> earliest time of the next request

def _wait(url, interval):
    """Space requests per host, safe across threads: different hosts proceed in parallel."""
    host = urllib.parse.urlparse(url).netloc
    with _lock:
        now = time.time()
        slot = max(_next.get(host, 0.0), now)
        _next[host] = slot + interval
    if slot > now:
        time.sleep(slot - now)

def _fetch(url, delay, headers=None):
    for attempt in range(4):
        _wait(url, delay)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 429, 500, 502, 503, 504) and attempt < 3:  # 403: the Met uses it for rate limits
                time.sleep(8 * 2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))

def get_bytes(url, delay=0.15, headers=None):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if path.exists():
        return path.read_bytes()
    data = _fetch(url, delay, headers)  # headers (API keys) stay out of the cache key
    path.write_bytes(data)
    return data

def get_json(url, delay=0.15, headers=None):
    return json.loads(get_bytes(url, delay, headers))

def get_text(url, delay=0.3):
    return get_bytes(url, delay).decode("utf-8", errors="replace")

def get_range(url, nbytes=262144):
    """First nbytes of a file via a Range request. Returns ({status, contentRange, contentType}, bytes)."""
    CACHE.mkdir(exist_ok=True)
    key = CACHE / hashlib.sha1(f"{url}#range{nbytes}".encode()).hexdigest()
    meta = key.with_suffix(".meta")
    if key.exists() and meta.exists():
        return json.loads(meta.read_text()), key.read_bytes()
    _wait(url, 0.1)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": f"bytes=0-{nbytes - 1}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        info = {"status": r.status, "contentRange": r.headers.get("Content-Range"),
                "contentType": r.headers.get("Content-Type")}
        data = r.read()
    key.write_bytes(data)
    meta.write_text(json.dumps(info))
    return info, data

def get_head(url, nbytes=2048):
    """Status, content type and total size of a resource, reading at most nbytes of it. Cached as metadata only."""
    CACHE.mkdir(exist_ok=True)
    meta = CACHE / (hashlib.sha1(f"{url}#head".encode()).hexdigest() + ".meta")
    if meta.exists():
        return json.loads(meta.read_text())
    _wait(url, 0.1)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": f"bytes=0-{nbytes - 1}"})
    with urllib.request.urlopen(req, timeout=40) as r:
        r.read(nbytes)
        total = None
        if r.headers.get("Content-Range"):
            total = int(r.headers["Content-Range"].rsplit("/", 1)[-1])
        elif r.headers.get("Content-Length"):
            total = int(r.headers["Content-Length"])
        info = {"status": r.status, "contentType": (r.headers.get("Content-Type") or "").split(";")[0], "total": total}
    meta.write_text(json.dumps(info))
    return info
