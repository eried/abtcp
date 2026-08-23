#!/usr/bin/env python3
"""Record real OSRM route responses for the offline e2e tests.

Usage: python tools/capture_fixtures.py

Fixtures are keyed by the route's coordinates rounded to 3 decimals, which is how
tests/e2e/test_app.py matches intercepted requests: osrm_route_<lat1>_<lng1>_<lat2>_<lng2>.json
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
BASE = "https://router.project-osrm.org"

# Tromsø (default start) → Skibotn → Setermoen → Narvik, coordinates from data/chargers.json
DB = json.loads((ROOT / "data" / "chargers.json").read_text(encoding="utf-8"))
SITES = {s["name"]: s for s in DB["sites"]}
START = {"lat": 69.6496, "lng": 18.9553}
CHAIN = ["Skibotn, Norway", "Setermoen, Norway", "Narvik, Norway"]


def route_url(a, b):
    return f"{BASE}/route/v1/driving/{a['lng']:.6f},{a['lat']:.6f};{b['lng']:.6f},{b['lat']:.6f}?overview=full&geometries=geojson&steps=true&annotations=true"


def key(a, b):
    return f"{a['lat']:.3f}_{a['lng']:.3f}_{b['lat']:.3f}_{b['lng']:.3f}"


def main():
    FIX.mkdir(parents=True, exist_ok=True)
    prev = START
    for name in CHAIN:
        site = SITES[name]
        url = route_url(prev, site)
        req = urllib.request.Request(url, headers={"User-Agent": "abtcp-fixtures"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
        out = FIX / f"osrm_route_{key(prev, site)}.json"
        out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        rt = data["routes"][0]
        print(f"{name}: {rt['distance']/1000:.1f} km, {rt['duration']/3600:.2f} h -> {out.name} ({out.stat().st_size//1024} KB)")
        prev = site
    (FIX / "chain.json").write_text(json.dumps({"start": START, "chain": [{"name": n, "id": SITES[n]["id"], "lat": SITES[n]["lat"], "lng": SITES[n]["lng"]} for n in CHAIN]}, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
