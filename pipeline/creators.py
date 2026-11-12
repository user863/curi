"""Normalises creator names so one person is one key. Pure.
normalise("Smith, Joe (1928-) (Interviewer)") -> "Joe Smith"; names that say nobody -> None."""
import re

NOBODY = re.compile(r"(?i)^(|unknown.*|anonymous.*|anonym.*|unidentified.*|unbekannt.*|desconegut|okänd|various.*|n\.?\s?n\.?|ok[aä]nd.*|anoniem.*|nieznany.*)$")
URL = re.compile(r"(?i)https?://\S+|www\.\S+|#agent_\S+")
BRACKETS = re.compile(r"\s*[\(\[][^)\]]*[\)\]]")   # roles, life dates, attributions

def normalise(name):
    t = URL.sub("", str(name or ""))
    t = BRACKETS.sub("", t)
    t = re.sub(r"\s+,", ",", re.sub(r"\s+", " ", t)).strip(" ,;")
    if NOBODY.match(t):
        return None
    parts = [p.strip() for p in t.split(",")]
    if len(parts) == 2 and parts[0] and parts[1] and len(parts[0].split()) <= 2 and not any(ch.isdigit() for ch in t):
        t = f"{parts[1]} {parts[0]}"                 # "Last, First" -> "First Last"
    elif len(parts) > 2:
        t = parts[0]                                 # a trailing site or address: keep the name
    return t or None

def key(name):
    n = normalise(name)
    return n.lower() if n else None
