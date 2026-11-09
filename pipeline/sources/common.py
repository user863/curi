import hashlib, threading

TONES = ("paper", "mauve", "sun", "sky", "ink")

def stable_pick(key, options):
    """Deterministic choice from a stable hash, so reruns give the same card."""
    return options[int(hashlib.sha1(key.encode()).hexdigest(), 16) % len(options)]

_lock = threading.Lock()

def reject(stats, source, reason):
    with _lock:
        counts = stats.setdefault(source, {})
        counts[reason] = counts.get(reason, 0) + 1

def parse_seconds(v):
    """IA mixes seconds ('507.1') and clock strings ('08:26', '1:12:14')."""
    if v is None:
        return None
    s = str(v)
    if ":" in s:
        parts = [float(p) for p in s.split(":")]
        return sum(p * 60 ** i for i, p in enumerate(reversed(parts)))
    try:
        return float(s)
    except ValueError:
        return None
