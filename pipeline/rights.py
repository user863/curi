"""Rights gate. A card is admitted only when license, jurisdictions and, for excerpts, derivatives are all 'yes'.
Answers are 'yes' | 'no' | 'unknown'. Licence data comes from the source; nothing here is a legal opinion.

Policy: CC0, Public Domain Mark and CC BY are admitted. CC BY-SA is admitted for whole images shown
unmodified; passages, clips and audio excerpts are adaptations, which share-alike would extend to
(derivatives 'unknown'), so they are rejected. NonCommercial and NoDerivatives are always rejected."""

# code -> (label, canonical URL, derivatives allowed)
LICENSES = {
    "CC0": ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "yes"),
    "PDM": ("Public Domain Mark", "https://creativecommons.org/publicdomain/mark/1.0/", "yes"),
    "CC-BY": ("CC BY", "https://creativecommons.org/licenses/by/4.0/", "yes"),
    "CC-BY-SA": ("CC BY-SA", "https://creativecommons.org/licenses/by-sa/4.0/", "unknown"),
}
ATTRIBUTION_REQUIRED = {"CC-BY", "CC-BY-SA"}
# Last-death year for a work to be public domain in life+70 countries as of 2026.
PD_DEATH_YEAR = 1955

def license_from_url(url):
    u = (url or "").lower()
    if "-nc" in u or "-nd" in u or "/nc" in u or "/nd" in u:
        return None  # NonCommercial / NoDerivatives
    if "publicdomain/zero" in u:
        return "CC0"
    if "publicdomain/mark" in u or "licenses/publicdomain" in u:
        return "PDM"
    if "/licenses/by-sa/" in u:
        return "CC-BY-SA"
    if "/licenses/by/" in u:
        return "CC-BY"
    return None

def license_from_code(code):
    """Openverse-style short codes: cc0, pdm, by, by-sa (others, including nc/nd, are rejected)."""
    return {"cc0": "CC0", "pdm": "PDM", "by": "CC-BY", "by-sa": "CC-BY-SA"}.get((code or "").lower())

def attribution(creator, title, license, url=None):
    label = LICENSES[license][0]
    return f"{title} by {creator or 'unknown'}, {label}" + (f" ({url})" if url else "")

def rights(license, jurisdictions, attribution_text, kind, **extra):
    """kind: image | passage | video | audio. Excerpts (everything but a whole image) need derivatives 'yes'."""
    derivatives = LICENSES[license][2] if license in LICENSES else "unknown"
    needs = kind != "image"
    if license is None:
        gate = "no"
    elif jurisdictions == "worldwide" and (derivatives == "yes" or not needs):
        gate = "yes"
    else:
        gate = "unknown"
    return {"license": license, "licenseUrl": LICENSES[license][1] if license in LICENSES else None,
            "jurisdictions": jurisdictions, "derivativesOk": derivatives, "verifiedBy": "unknown",
            "attribution": attribution_text, "gate": gate, **extra}

def gutenberg_gate(authors):
    """Public domain worldwide only when every author died in or before PD_DEATH_YEAR."""
    deaths = [a.get("death_year") for a in authors]
    if not deaths or any(d is None for d in deaths):
        return "unknown"
    return "yes" if all(d <= PD_DEATH_YEAR for d in deaths) else "no"
