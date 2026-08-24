#!/usr/bin/env python3
"""End-to-end tests for ABTCP with Playwright (Chromium, headless).

    python tests/e2e/test_app.py            # offline: OSRM/Open-Meteo/Photon are replayed from fixtures
    ABTCP_LIVE=1 python tests/e2e/test_app.py   # additionally runs a smoke test against the real services

Requires: pip install playwright && playwright install chromium
"""
import functools
import http.server
import json
import math
import os
import re
import socketserver
import sys
import threading
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures"
OUT = ROOT / "tests" / "e2e" / "output"
CHAIN = json.loads((FIX / "chain.json").read_text(encoding="utf-8"))
SITE_ID = {c["name"].split(",")[0]: c["id"] for c in CHAIN["chain"]}
PNG1x1 = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050001ff2a6a3e0000000049454e44ae426082")


# ---------------------------------------------------------------- helpers
def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def hav(lat1, lng1, lat2, lng2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(a))


def parse_coords(url):
    part = re.search(r"/driving/([^?]+)", url).group(1)
    return [tuple(map(float, c.split(","))) for c in part.split(";")]  # (lng, lat)


def install_fakes(page, log):
    def osrm(route):
        url = route.request.url
        log.append(url)
        pts = parse_coords(url)
        if "/route/v1/" in url:
            (lng1, lat1), (lng2, lat2) = pts[0], pts[-1]
            fx = FIX / f"osrm_route_{lat1:.3f}_{lng1:.3f}_{lat2:.3f}_{lng2:.3f}.json"
            if fx.exists():
                return route.fulfill(status=200, content_type="application/json", body=fx.read_text(encoding="utf-8"))
            d = hav(lat1, lng1, lat2, lng2) * 1.3
            t = d / (80 / 3.6)
            body = {"code": "Ok", "routes": [{"distance": d, "duration": t,
                    "geometry": {"coordinates": [[lng1, lat1], [(lng1 + lng2) / 2, (lat1 + lat2) / 2], [lng2, lat2]]},
                    "legs": [{"steps": [{"mode": "driving", "distance": d, "duration": t, "name": "synthetic"}],
                              "annotation": {"distance": [d / 2, d / 2], "duration": [t / 2, t / 2], "speed": [22.2, 22.2]}}]}]}
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
        if "/table/v1/" in url:
            src, dests = pts[0], pts[1:]
            dist = [hav(src[1], src[0], p[1], p[0]) * 1.3 for p in dests]
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"code": "Ok", "distances": [dist], "durations": [[d / (80 / 3.6) for d in dist]]}))
        return route.fulfill(status=400, content_type="application/json", body='{"code":"InvalidUrl"}')

    def meteo(route):
        url = route.request.url
        log.append(url)
        if "/v1/elevation" in url:
            n = len(re.search(r"latitude=([^&]+)", url).group(1).split(","))
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"elevation": [50.0] * n}))
        hours = [f"2026-09-01T{h:02d}:00" for h in range(24)]
        body = {"hourly": {"time": hours, "temperature_2m": [10.0] * 24, "wind_speed_10m": [10.0] * 24,
                           "wind_direction_10m": [180] * 24, "precipitation": [0.0] * 24}}
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    def photon(route):
        log.append(route.request.url)
        body = {"features": [{"geometry": {"coordinates": [18.9553, 69.6496]}, "properties": {"name": "Tromsø", "country": "Norway"}}]}
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    def valhalla(route):
        log.append(route.request.url)
        n = len(json.loads(route.request.post_data or '{"shape":[]}')["shape"])
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({"height": [50.0] * n}))

    page.route(re.compile(r"https://valhalla1\.openstreetmap\.de/.*"), valhalla)
    page.route(re.compile(r"https://router\.project-osrm\.org/.*"), osrm)
    page.route(re.compile(r"https://(api|archive-api)\.open-meteo\.com/.*"), meteo)
    page.route(re.compile(r"https://photon\.komoot\.io/.*"), photon)
    page.route(re.compile(r"https://nominatim\.openstreetmap\.org/.*"), lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
    page.route(re.compile(r"https://[^/]*(tile\.openstreetmap\.org|cartocdn\.com)/.*"), lambda r: r.fulfill(status=200, content_type="image/png", body=PNG1x1))


def wait_db(page):
    page.wait_for_function("window.__abtcp && window.__abtcp.db && window.__abtcp.timeline", timeout=30000)


def wait_legs(page):
    page.wait_for_function(
        "!document.querySelector('#status').textContent && ![...document.querySelectorAll('.stop .leg')].some(l => l.textContent.includes('Routing'))",
        timeout=30000)
    page.wait_for_function("!document.querySelector('.candidate.empty') || !document.querySelector('.candidate.empty').textContent.includes('Ranking')", timeout=30000)


def pct(text):
    return float(re.search(r"(-?\d+)\s*%", text).group(1))


def set_value(page, selector, value, event="change"):
    page.eval_on_selector(selector, f"e => {{ e.value = {json.dumps(value)}; e.dispatchEvent(new Event('input', {{bubbles: true}})); e.dispatchEvent(new Event({json.dumps(event)}, {{bubbles: true}})); }}")


def set_rest(page, idx, hours, sentry):
    page.eval_on_selector(f'.stop[data-index="{idx}"] input.rest-sentry', f"e => {{ e.checked = {str(sentry).lower()}; }}")
    set_value(page, f'.stop[data-index="{idx}"] input.rest-hours', str(hours))


# ---------------------------------------------------------------- tests
def test_plan_export_import(page, url, log):
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(url, wait_until="load")
    wait_db(page)
    assert page.evaluate("window.__abtcp.db.sites.length") > 8000
    assert page.evaluate("window.__abtcp.map.size()") > 8000, "charger dots drawn"
    assert page.locator(".stop").count() == 0

    # --- start via search (Photon fake), time and battery
    page.fill("#start-search", "Tromsø")
    page.wait_for_selector("#start-results div:not([data-site])")
    page.click("#start-results div:not([data-site])")
    assert "Tromsø" in page.text_content("#start-name")
    set_value(page, "#start-time", "2026-09-01T08:00")
    set_value(page, "#start-soc", "90")
    assert page.evaluate("window.__abtcp.store.trip.start.soc") == 90
    assert page.evaluate("window.__abtcp.store.trip.start.time") == "2026-09-01T08:00"

    # --- candidates ranked by (fake) road distance: Skibotn first
    page.wait_for_selector(".candidate[data-site]", timeout=30000)
    names = page.eval_on_selector_all(".candidate[data-site] b", "els => els.map(e => e.textContent)")
    assert names[0].startswith("Skibotn"), names
    page.click(f'.candidate[data-site="{SITE_ID["Skibotn"]}"]')
    wait_legs(page)
    card = page.locator(".stop").nth(0)
    assert "Skibotn" in card.text_content()
    leg = card.locator(".leg").text_content()
    assert "127 km" in leg, leg  # real recorded route
    arrival = pct(card.locator(".arrival-soc").text_content())
    assert 55 <= arrival <= 85, arrival
    assert "streak starts" in card.locator(".deadline").text_content()

    # --- charge target 70 → departure 70 %
    set_value(page, '.stop[data-index="0"] input.charge-target', "70")
    tl0 = page.evaluate("(() => { const s = window.__abtcp.timeline.stops[0]; return { arrival: s.arrivalSoc, depart: s.departSoc, kwh: s.session.kwhStored }; })()")
    expected = max(70, tl0["arrival"] + 8)  # rules.minSessionPct = 8: every site must register a real session
    assert abs(tl0["depart"] - expected) < 1e-6, tl0
    assert pct(page.locator('.stop[data-index="0"] .depart-soc').text_content()) == round(expected)
    assert tl0["kwh"] > 5
    assert "in a row" in page.text_content("#counter-streak")

    # --- second stop, Setermoen (recorded route)
    page.click(f'.candidate[data-site="{SITE_ID["Setermoen"]}"]')
    wait_legs(page)
    assert page.locator(".stop").count() == 2
    second = page.locator('.stop[data-index="1"]')
    assert "133 km" in second.locator(".leg").text_content()
    dl = second.locator(".deadline").text_content()
    assert "since last session" in dl and "left" in dl, dl
    assert page.text_content("#counter-unique").startswith("2")
    assert page.text_content("#counter-deadline") != "–"
    assert "in a row" in page.text_content("#counter-streak")

    # --- rest 10 h with Sentry keeps the streak, 30 h breaks it
    set_rest(page, 0, 10, True)
    assert "in a row" in page.text_content("#counter-streak")
    assert "Sentry" in page.locator('.stop[data-index="0"]').text_content()
    set_rest(page, 0, 30, True)
    assert "broken" in page.text_content("#counter-streak"), page.text_content("#counter-streak")
    assert "broken" in page.eval_on_selector('.stop[data-index="1"]', "e => e.className")
    assert "missed" in page.locator('.stop[data-index="1"] .deadline').text_content()

    # --- settings: 48 h window heals it; value persists
    page.click("#tab-settings")
    set_value(page, '[data-setting="rules.windowH"]', "48")
    page.click("#tab-trip")
    assert "in a row" in page.text_content("#counter-streak")
    streak_text = page.text_content("#counter-streak")
    arrival2 = page.locator('.stop[data-index="1"] .arrival-soc').text_content()

    # --- export
    with page.expect_download() as dl_info:
        page.click("#btn-export")
    OUT.mkdir(exist_ok=True)
    exported = OUT / "exported-trip.json"
    dl_info.value.save_as(exported)
    data = json.loads(exported.read_text(encoding="utf-8"))
    assert dl_info.value.suggested_filename.startswith("abtcp-")
    assert data["version"] == 1 and len(data["stops"]) == 2
    assert data["settings"]["rules"]["windowH"] == 48
    assert data["stops"][0]["rest"] == {"hours": 30, "sentry": True}
    assert data["stops"][0]["charge"]["targetSoc"] == 70
    assert len(data["legs"]) == 2 and all(l["status"] == "ok" for l in data["legs"].values())

    # --- reload: autosaved state comes back without any routing
    log.clear()
    page.reload(wait_until="load")
    wait_db(page)
    assert page.locator(".stop").count() == 2
    assert page.locator('.stop[data-index="1"] .arrival-soc').text_content() == arrival2
    assert page.text_content("#counter-streak") == streak_text
    assert not [u for u in log if "/route/v1/" in u], "no re-routing after reload"
    page.click("#tab-settings")
    assert page.input_value('[data-setting="rules.windowH"]') == "48"
    page.click("#tab-trip")

    # --- new trip needs two clicks, then import restores everything
    page.click("#btn-new")
    assert page.locator(".stop").count() == 2, "first click only arms"
    page.click("#btn-new")
    assert page.locator(".stop").count() == 0
    page.set_input_files("#file-import", str(exported))
    page.wait_for_function("document.querySelectorAll('.stop').length === 2", timeout=15000)
    wait_legs(page)
    assert page.locator('.stop[data-index="1"] .arrival-soc').text_content() == arrival2
    assert page.text_content("#counter-streak") == streak_text
    page.click("#tab-settings")
    assert page.input_value('[data-setting="rules.windowH"]') == "48"
    page.click("#tab-trip")

    # --- garbage import is rejected with a toast, state untouched
    bad = OUT / "bad.json"
    bad.write_text('{"hello":"world"}', encoding="utf-8")
    page.set_input_files("#file-import", str(bad))
    page.wait_for_function("document.querySelector('#toast').textContent.includes('Import failed')", timeout=5000)
    assert page.locator(".stop").count() == 2

    # --- remove a stop, map popup add, point via map pick
    page.click('.stop[data-index="1"] .btn-remove')
    page.wait_for_function("document.querySelectorAll('.stop').length === 1")
    wait_legs(page)
    page.evaluate(f"window.__abtcp.map.openSite({SITE_ID['Narvik']})")
    page.wait_for_selector(".leaflet-popup [data-act='add']")
    page.click(".leaflet-popup [data-act='add']")
    page.wait_for_function("document.querySelectorAll('.stop').length === 2")
    wait_legs(page)
    assert "Narvik" in page.locator('.stop[data-index="1"]').text_content()
    assert page.evaluate("window.__abtcp.timeline.summary.uniqueCounted") == 2

    assert not errors, errors
    page.screenshot(path=str(OUT / "final.png"))


def test_live_smoke(page, url, log):
    page.goto(url, wait_until="load")
    wait_db(page)
    page.click("#btn-new"); page.click("#btn-new")
    page.wait_for_selector(".candidate[data-site]", timeout=120000)
    page.click(".candidate[data-site]")
    page.wait_for_function("document.querySelectorAll('.stop').length === 1 && !document.querySelector('.stop .leg').textContent.includes('Routing')", timeout=180000)
    leg = page.locator(".stop .leg").text_content()
    assert "km" in leg and "Wh/km" in leg and "Route failed" not in leg, leg
    assert "forecast" in leg or "archive" in leg, leg
    with page.expect_download() as dl_info:
        page.click("#btn-export")
    OUT.mkdir(exist_ok=True)
    dl_info.value.save_as(OUT / "live-trip.json")


# ---------------------------------------------------------------- runner
def main():
    srv, port = serve()
    url = f"http://127.0.0.1:{port}/"
    tests = [("plan/export/import (offline)", test_plan_export_import, True)]
    if os.environ.get("ABTCP_LIVE"):
        tests.append(("live smoke", test_live_smoke, False))
    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for name, fn, fake in tests:
            ctx = browser.new_context(viewport={"width": 1400, "height": 900}, accept_downloads=True)
            page = ctx.new_page()
            log = []
            if fake:
                install_fakes(page, log)
            t0 = time.time()
            try:
                fn(page, url, log)
                print(f"PASS  {name}  ({time.time() - t0:.1f}s)")
            except Exception:
                failures += 1
                OUT.mkdir(exist_ok=True)
                shot = OUT / f"fail-{re.sub(r'[^a-z0-9]+', '-', name.lower())}.png"
                try:
                    page.screenshot(path=str(shot))
                except Exception:
                    pass
                print(f"FAIL  {name}\n{traceback.format_exc()}\nscreenshot: {shot}")
            finally:
                ctx.close()
        browser.close()
    srv.shutdown()
    print("all passed" if not failures else f"{failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
