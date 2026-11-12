"""Downloads the Citizen DJ mp3s hosted on the project's S3 bucket (FMA, MusicBox, Tony Schwartz) to experiments/citizen-dj."""
import json, urllib.request, urllib.error, time
from pathlib import Path

SITE = "https://citizen-dj.labs.loc.gov"
BUCKET = "https://s3.amazonaws.com/citizen-dj-assets.labs.loc.gov"
OUT = Path(__file__).resolve().parents[2] / "experiments" / "citizen-dj"
get = lambda url: urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8"}), timeout=120)

def main():
    for coll in ("loc-fma", "loc-musicbox", "loc-tony-schwartz"):
        meta = json.load(get(f"{SITE}/data/metadata/{coll}.json"))
        (OUT / coll).mkdir(parents=True, exist_ok=True)
        (OUT / coll / "metadata.json").write_text(json.dumps(meta))
        for item in meta["items"]:
            dest = OUT / coll / Path(item[-1]).name
            if dest.exists():
                continue
            try:
                data = get(BUCKET + item[-1]).read()
            except urllib.error.HTTPError as e:
                print(coll, item[1], "failed", e.code, flush=True)
                continue
            dest.write_bytes(data)
            print(coll, dest.name, len(data), flush=True)
            time.sleep(0.3)

if __name__ == "__main__":
    main()
