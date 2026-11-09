"""Content categories. The feed balances across these, not across sources."""
CATEGORIES = [
    {"id": "visual", "label": "Images", "types": ["image"]},
    {"id": "text", "label": "Text", "types": ["passage"]},
    {"id": "video", "label": "Film", "types": ["video"]},
    {"id": "audio", "label": "Audio", "types": ["audio"]},
]
CATEGORY_OF_TYPE = {t: c["id"] for c in CATEGORIES for t in c["types"]}
