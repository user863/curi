"""Europeana in bulk: one theme or text query, every provider scanned in completeness order by cursor, so no single
archive fills the stream. API calls are sequential and spaced; media probes run in parallel but are spaced per host (http.py).
Reuses the candidate and probe code of europeana.py. Known works are skipped, so a repeat pass with a larger
per_provider goes deeper."""
import collections, datetime
from .. import secrets
from ..http import get_json
from . import europeana
from .common import reject

SORT = "COMPLETENESS desc,europeana_id asc"   # cursor paging needs europeana_id last
PAGE = 100

def scan(key, src, provider, today, stats):
    cursor, scanned, out = "*", 0, []
    while scanned < src["per_provider"]:
        data = europeana.search(key, src, {"qf": f'DATA_PROVIDER:"{provider}"', "sort": SORT, "cursor": cursor}, PAGE)
        items = data.get("items", [])
        for it in items:
            card, why = europeana.candidate(it, src, today)
            if card:
                out.append(card)
            else:
                reject(stats, src["name"], why)
        scanned += len(items)
        cursor = data.get("nextCursor")
        if not cursor or len(items) < PAGE:
            break
    return out

def shortlist(pool, take, per_provider_most):
    """Best score first, at most per_provider_most from one provider, up to take."""
    counts, out = collections.Counter(), []
    for c in sorted(pool, key=lambda c: c["_score"], reverse=True):
        if counts[c["_group"]] < per_provider_most:
            counts[c["_group"]] += 1
            out.append(c)
        if len(out) == take:
            break
    return out

def run(src, stats):
    name, key = src["name"], secrets.get("EUROPEANA_API_KEY")
    if not key:
        reject(stats, name, "no-api-key")
        return []
    today = datetime.date.today().isoformat()
    pool = []
    for n, provider in enumerate(europeana.providers(key, src), 1):
        pool += scan(key, src, provider, today, stats)
        print(f"{name}: provider {n} {provider[:40]!r}, pool {len(pool)}", flush=True)
    picks = shortlist(pool, src["take"], src["max_per_group"])
    print(f"{name}: probing {len(picks)} of {len(pool)}", flush=True)
    return europeana.probe_all(picks, src, stats)
