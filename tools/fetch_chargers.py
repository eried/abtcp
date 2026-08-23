#!/usr/bin/env python3
"""Build data/chargers.json from the supercharge.info community database.

Usage:
    python tools/fetch_chargers.py            # download and write data/chargers.json
    python tools/fetch_chargers.py --input x  # use a previously downloaded allSites JSON

supercharge.info tracks every Tesla Supercharger site worldwide (status, stalls, power,
Tesla's own location id). Tesla's findus API sits behind bot protection, so it is not used.
"""
import argparse
import datetime as dt
import json
import sys
import urllib.request
from collections import Counter
from pathlib import Path

SOURCE_URL = "https://supercharge.info/service/supercharge/allSites"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "chargers.json"


def download(url: str) -> list:
    req = urllib.request.Request(url, headers={"User-Agent": "abtcp/1.0 (+https://github.com/erwinried/abtcp)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def convert(raw: list) -> list:
    sites = []
    for s in raw:
        gps = s.get("gps") or {}
        addr = s.get("address") or {}
        plugs = sorted(k for k, v in (s.get("plugs") or {}).items() if v)
        stalls = s.get("stalls") or {}
        sites.append({
            "id": s["id"],
            "tid": s.get("locationId"),
            "name": s.get("name", "").strip(),
            "status": s.get("status", "UNKNOWN"),
            "lat": round(float(gps.get("latitude", 0.0)), 6),
            "lng": round(float(gps.get("longitude", 0.0)), 6),
            "country": addr.get("country", ""),
            "region": addr.get("region", ""),
            "city": addr.get("city", ""),
            "stalls": int(s.get("stallCount") or 0),
            "kw": int(s.get("powerKilowatt") or 0),
            "gen": "v4" if stalls.get("v4") else "v3" if stalls.get("v3") else "v2" if stalls.get("v2") else "",
            "opened": s.get("dateOpened"),
            "elev": s.get("elevationMeters"),
            "plugs": plugs,
            "otherEVs": bool(s.get("otherEVs")),
        })
    sites.sort(key=lambda x: x["id"])
    return sites


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="path to a downloaded allSites JSON instead of fetching")
    ap.add_argument("--output", default=str(OUT))
    args = ap.parse_args(argv)

    if args.input:
        raw = json.loads(Path(args.input).read_text(encoding="utf-8"))
    else:
        print(f"downloading {SOURCE_URL} ...", file=sys.stderr)
        raw = download(SOURCE_URL)

    sites = convert(raw)
    doc = {
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "source": SOURCE_URL,
        "count": len(sites),
        "sites": sites,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    by_region = Counter(s["region"] for s in sites)
    by_status = Counter(s["status"] for s in sites)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB), {len(sites)} sites")
    print("regions:", dict(by_region))
    print("status:", dict(by_status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
