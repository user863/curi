"""Parses display dates into a year span. Pure.
parse("c. 1300–1325") -> (1300, 1325); parse("17th century") -> (1600, 1699); parse("") -> None.
BCE years are negative. A bare year is a span of one."""
import re

NUM = r"\d{1,4}"
CENTURY = re.compile(rf"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?[\s-]*(?:century|cent\.?|c\.)(?:\s*(bce?|bc|ce|ad))?")
DECADE = re.compile(r"\b(1[0-9]|20)(\d)0s\b")
RANGE = re.compile(rf"(?<!\d)({NUM})\s*(?:[-–—/]|to|bis|till)\s*({NUM})(?!\d)")
YEAR = re.compile(r"(?<!\d)(\d{3,4})(?!\d)")
BCE = re.compile(r"(?i)\b(bce?|bc|v\.?\s*chr\.?|f\.?\s*kr\.?)\b")

def parse(text):
    t = str(text or "").strip()
    if not t:
        return None
    bce = bool(BCE.search(t))
    sign = -1 if bce else 1
    m = CENTURY.search(t)
    if m:
        c = int(m.group(1))
        bce = bce or (m.group(2) or "").lower() in ("bc", "bce")
        sign = -1 if bce else 1
        lo, hi = (c - 1) * 100, c * 100 - 1
        return (-hi, -lo) if bce else (lo, hi)
    m = DECADE.search(t)
    if m:
        start = int(m.group(1) + m.group(2) + "0")
        return (start, start + 9)
    m = RANGE.search(t)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        if b < 100 and a >= 100:                  # "1896–97"
            b = a // 100 * 100 + b
        elif b < a and len(m.group(2)) < len(m.group(1)):
            b = int(m.group(1)[:len(m.group(1)) - len(m.group(2))] + m.group(2))
        if b >= a:
            return (sign * a, sign * b) if not bce else (-b, -a)
    m = YEAR.search(t)
    if m:
        y = int(m.group(1))
        return (-y, -y) if bce else (y, y)
    return None

def era(span):
    """Era bucket: 0 undated, 1 before 1500, 2 1500-1799, 3 1800-1899, 4 1900-1949, 5 1950 on. By the span's middle."""
    if span is None:
        return 0
    year = (span[0] + span[1]) / 2
    return 1 if year < 1500 else 2 if year < 1800 else 3 if year < 1900 else 4 if year < 1950 else 5
