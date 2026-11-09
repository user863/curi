"""API keys, looked up in this order: environment variable, macOS Keychain, pipeline/.env.local.
Keys are sent as HTTP headers, never in URLs, so they do not end up in the cache, logs or the pack.

Keychain (recommended): security add-generic-password -a "$USER" -s commonplace-europeana-api-key -w
File fallback: pipeline/.env.local with KEY=value lines (gitignored, chmod 600)."""
import os
import subprocess
from pathlib import Path

ENV_FILE = Path(__file__).parent / ".env.local"
SERVICES = {"EUROPEANA_API_KEY": "commonplace-europeana-api-key"}
_memo = {}

def _keychain(service):
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() or None if r.returncode == 0 else None

def _file(name):
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == name and value.strip():
                return value.strip().strip("\"'")
    return None

def get(name):
    if name not in _memo:
        _memo[name] = os.environ.get(name) or (_keychain(SERVICES[name]) if name in SERVICES else None) or _file(name)
    return _memo[name]

def redact(text):
    """Replace any known key in a message before it is printed or stored."""
    for name in SERVICES:
        value = _memo.get(name)
        if value:
            text = text.replace(value, "***")
    return text
