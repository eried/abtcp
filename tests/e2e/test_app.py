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


def file_menu(page, item_id):
    """Open the File menu and click one of its items."""
    page.click("#btn-file")
    page.wait_for_selector(f"#{item_id}:visible", timeout=5000)
    page.click(f"#{item_id}")


def trip_menu(page, item_id):
    """Open the Trip menu and click one of its items."""
    page.click("#btn-trip")
    page.wait_for_selector(f"#{item_id}:visible", timeout=5000)
    page.click(f"#{item_id}")


def open_settings(page):
    page.click("#btn-settings")
    page.wait_for_selector("#panel-settings [data-setting]", timeout=5000)


def close_dialog(page):
    page.click("#dialog-close")
    page.wait_for_function("!document.getElementById('dialog').open", timeout=5000)


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
    open_settings(page)
    set_value(page, '[data-setting="rules.windowH"]', "48")
    close_dialog(page)
    assert "in a row" in page.text_content("#counter-streak")
    streak_text = page.text_content("#counter-streak")
    arrival2 = page.locator('.stop[data-index="1"] .arrival-soc').text_content()

    # --- export
    with page.expect_download() as dl_info:
        file_menu(page, "btn-export")
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
    open_settings(page)
    assert page.input_value('[data-setting="rules.windowH"]') == "48"
    close_dialog(page)

    # --- new trip asks with a browser confirm; import restores everything
    page.once("dialog", lambda d: d.dismiss())
    file_menu(page, "btn-new")
    assert page.locator(".stop").count() == 2, "cancelled confirm keeps the trip"
    page.once("dialog", lambda d: d.accept())
    file_menu(page, "btn-new")
    page.wait_for_function("document.querySelectorAll('.stop').length === 0")
    page.set_input_files("#file-import", str(exported))
    page.wait_for_function("document.querySelectorAll('.stop').length === 2", timeout=15000)
    wait_legs(page)
    assert page.locator('.stop[data-index="1"] .arrival-soc').text_content() == arrival2
    assert page.text_content("#counter-streak") == streak_text
    open_settings(page)
    assert page.input_value('[data-setting="rules.windowH"]') == "48"
    # exactly one scrollbar in the dialog (the <dialog> element itself must not scroll too)
    scroll_probe = "(() => [document.documentElement, document.body, document.getElementById('dialog'), ...document.querySelectorAll('#dialog *')].filter(e => e && e.scrollHeight > e.clientHeight + 2 && ['auto','scroll'].includes(getComputedStyle(e).overflowY)).map(e => e.id || e.className || e.tagName))()"
    assert page.evaluate(scroll_probe) == ["dialog-body"], page.evaluate(scroll_probe)
    page.click("#dtab-help")
    page.wait_for_selector("#panel-help:visible", timeout=5000)
    assert page.evaluate(scroll_probe) == ["dialog-body"], page.evaluate(scroll_probe)
    page.click("#dtab-settings")
    close_dialog(page)

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

    # --- destination routed as a final leg + roundtrip
    page.evaluate("window.__abtcp.sidebar.setDestination({ lat: 68.4385, lng: 17.4272, name: 'Narvik town' })")
    page.wait_for_selector("#dest-card", timeout=15000)
    wait_legs(page)
    dest_txt = page.text_content("#dest-card")
    assert "Arrive" in dest_txt and "Narvik town" in dest_txt, dest_txt
    assert page.text_content("#counter-eta") != "–"
    page.click("#btn-roundtrip")
    page.wait_for_function("document.querySelector('#dest-card') && document.querySelector('#dest-card').textContent.includes('Back to')", timeout=15000)
    wait_legs(page)

    # --- a real mouse click on a canvas dot opens the popup and adds the site
    t2 = page.evaluate("""() => { const a = window.__abtcp; const s = a.db.search('Mo i Rana', 3).find(x => a.db.isUsable(x));
      a.map.map.setView([s.lat, s.lng], 9, { animate: false });
      const r = document.getElementById('map').getBoundingClientRect();
      const p = a.map.map.latLngToContainerPoint([s.lat, s.lng]);
      return { x: r.left + p.x, y: r.top + p.y, name: s.name }; }""")
    page.mouse.click(t2["x"], t2["y"])
    page.wait_for_selector(".leaflet-popup [data-act=\'add\']", timeout=5000)
    assert t2["name"] in page.text_content(".leaflet-popup .popup")
    page.click(".leaflet-popup [data-act=\'add\']")
    page.wait_for_function("document.querySelectorAll(\'.stop[data-id]\').length === 3", timeout=20000)
    wait_legs(page)

    # --- repeat visit: pass chips on fanned badges
    first_site = page.evaluate("window.__abtcp.store.trip.stops[0].siteId")
    page.evaluate(f"window.__abtcp.map.openSite({first_site})")
    page.wait_for_selector(".leaflet-popup [data-act='add']", timeout=5000)
    page.click(".leaflet-popup [data-act='add']")
    page.wait_for_function("document.querySelectorAll('.stop[data-id]').length === 4", timeout=20000)
    wait_legs(page)
    assert page.locator(".stop-icon .pass").count() == 2, "pass chips on both visits of the same site"
    page.evaluate("window.__abtcp.sidebar.removeStop(window.__abtcp.store.trip.stops[3].id)")
    page.wait_for_function("document.querySelectorAll('.stop[data-id]').length === 3", timeout=15000)
    wait_legs(page)
    assert page.locator(".stop-icon .pass").count() == 0

    # --- floating map actions: hover a planned stop, then remove it from there
    n_before = page.locator(".stop[data-id]").count()
    box = page.evaluate("(() => { const el = [...document.querySelectorAll('.leaflet-marker-pane .stop-icon')].find(e => e.querySelector('.n') && e.querySelector('.n').textContent === '1' && !e.className.includes('start')); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 8 }; })()")
    page.mouse.move(box["x"], box["y"])
    page.wait_for_selector("#map-actions button[data-act='remove']", timeout=5000)
    assert page.locator("#map-actions button[data-act='replace']").count() == 1
    assert page.locator("#map-actions button[data-act='fill']").count() == 1
    page.click("#map-actions button[data-act='remove']")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n_before - 1}", timeout=20000)
    wait_legs(page)
    page.click("#btn-undo")  # restore it, so the rest of the flow keeps its plan
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n_before}", timeout=20000)
    wait_legs(page)

    # --- hovering a free charger offers Add
    pt = page.evaluate("""() => { const a = window.__abtcp; const s = a.db.search('Alta', 3).find(x => a.db.isUsable(x) && x.country === 'Norway');
      a.map.map.setView([s.lat, s.lng], 9, { animate: false });
      const r = document.getElementById('map').getBoundingClientRect();
      const p = a.map.map.latLngToContainerPoint([s.lat, s.lng]);
      return { x: r.left + p.x, y: r.top + p.y, id: s.id }; }""")
    page.mouse.move(pt["x"], pt["y"])
    page.wait_for_selector("#map-actions button[data-act='add']", timeout=5000)
    page.click("#map-actions button[data-act='add']")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n_before + 1}", timeout=20000)
    wait_legs(page)
    page.evaluate("window.__abtcp.sidebar.removeStop(window.__abtcp.store.trip.stops.at(-1).id)")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n_before}", timeout=15000)
    wait_legs(page)

    # --- hovering the route trace offers Fill this leg
    page.click("#btn-fit")
    page.wait_for_timeout(800)
    # a point on the trace at least 4 km from any charger, so no dot's Add action takes precedence
    mid = page.evaluate("""() => { const a = window.__abtcp; const t = a.store.trip;
      const k = p => `${(+p.lat).toFixed(5)},${(+p.lng).toFixed(5)}`;
      const leg = t.legs[`${k(t.start)}>${k(t.stops[0])}`];
      if (!leg || leg.status !== 'ok') return null;
      const r = document.getElementById('map').getBoundingClientRect();
      const chunks = leg.route.chunks;
      for (let n = 0; n < chunks.length; n++) {
        const c = chunks[Math.floor(chunks.length / 2) + (n % 2 ? -1 : 1) * Math.ceil(n / 2)];
        if (!c) continue;
        const near = a.db.nearest(c[5], c[6], { n: 1, filter: s => a.db.isUsable(s) });
        if (near.length && near[0].distM < 4000) continue;
        const p = a.map.map.latLngToContainerPoint([c[5], c[6]]);
        if (p.x < 30 || p.y < 30 || p.x > r.width - 30 || p.y > r.height - 30) continue;
        return { x: r.left + p.x, y: r.top + p.y };
      }
      return null; }""")
    assert mid, "no clear point found on the first leg"
    page.mouse.move(mid["x"] + 60, mid["y"] + 60)
    page.wait_for_timeout(350)
    page.mouse.move(mid["x"], mid["y"])
    page.wait_for_timeout(120)
    page.mouse.move(mid["x"] + 1, mid["y"])
    try:
        page.wait_for_selector("#map-actions button[data-act='fill']", timeout=5000)
    except Exception:
        state = page.evaluate("(() => { const el = document.getElementById('map-actions'); return { hidden: el.hidden, kind: el.dataset.kind, html: el.innerHTML.slice(0, 90) }; })()")
        raise AssertionError(f"leg hover did not offer Fill: {state}")
    page.mouse.move(mid["x"], mid["y"] - 200)

    # --- hovering a suggestion highlights that charger on the map
    page.hover(".candidate[data-site]")
    page.wait_for_function("window.__abtcp.map.highlightCount() > 0", timeout=5000)
    page.hover("#start-name")
    page.wait_for_function("window.__abtcp.map.highlightCount() === 0", timeout=5000)

    # --- adding a stop keeps the sidebar scroll position
    page.eval_on_selector("#panel-trip", "e => { e.scrollTop = 260; }")
    before = page.evaluate("document.querySelector('#panel-trip').scrollTop")
    n_before = page.locator(".stop[data-id]").count()
    page.evaluate("window.__abtcp.sidebar.addStop(window.__abtcp.db.search('Alta', 3).find(s => window.__abtcp.db.isUsable(s)))")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n_before + 1}", timeout=20000)
    wait_legs(page)
    after = page.evaluate("document.querySelector('#panel-trip').scrollTop")
    assert abs(after - before) < 40, f"scroll jumped from {before} to {after}"
    page.evaluate("window.__abtcp.sidebar.removeStop(window.__abtcp.store.trip.stops.at(-1).id)")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n_before}", timeout=15000)
    wait_legs(page)

    # --- densify inserts extra sites within the detour budget and the charge cap
    stops_before = page.evaluate("window.__abtcp.store.trip.stops.length")
    low_before = page.evaluate("window.__abtcp.timeline.stops.filter(r => r.arrivalSoc < window.__abtcp.store.trip.settings.reserveSoc).length")
    added = page.evaluate("window.__abtcp.planner.densify({ maxDetourKm: 60, maxAdds: 3 })")
    assert added >= 1, "densify inserted nothing"
    assert page.evaluate("window.__abtcp.store.trip.stops.length") == stops_before + added
    wait_legs(page)
    assert page.evaluate("window.__abtcp.timeline.stops.every(r => r.leg.status === 'ok')"), "all legs routed after densify"
    cap = page.evaluate("window.__abtcp.store.trip.settings.maxChargeSoc")
    assert page.evaluate(f"window.__abtcp.store.trip.stops.every(s => !s.charge || s.charge.targetSoc <= {cap})"), "a stop was pushed above the charge cap"
    low_after = page.evaluate("window.__abtcp.timeline.stops.filter(r => r.arrivalSoc < window.__abtcp.store.trip.settings.reserveSoc).length")
    assert low_after <= low_before, f"densify made reachability worse ({low_before} -> {low_after} legs below reserve)"
    # a 0 km detour budget must insert nothing
    assert page.evaluate("window.__abtcp.planner.densify({ maxDetourKm: 0, maxAdds: 2 })") == 0
    for _ in range(added):
        page.evaluate("window.__abtcp.sidebar.removeStop(window.__abtcp.store.trip.stops.at(-1).id)")
    wait_legs(page)

    # --- per-gap fill: the ⊕ button on a card only touches that leg
    n0 = page.locator(".stop[data-id]").count()
    set_value(page, "#densify-km", "120")
    page.click('.stop[data-index="1"] [data-act="fillgap"]')
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length > {n0}", timeout=60000)
    wait_legs(page)
    n1 = page.locator(".stop[data-id]").count()
    assert page.evaluate("window.__abtcp.timeline.stops.every(r => r.leg.status === 'ok')")

    # --- undo / redo restores the previous plan
    page.click("#btn-undo")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n0}", timeout=15000)
    page.click("#btn-redo")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n1}", timeout=15000)
    page.click("#btn-undo")
    page.wait_for_function(f"document.querySelectorAll('.stop[data-id]').length === {n0}", timeout=15000)
    wait_legs(page)
    assert page.evaluate("document.querySelector('#btn-undo').disabled") is False

    # --- day separators appear where the plan crosses midnight (30 h rest)
    seps = page.eval_on_selector_all(".day-sep span", "els => els.map(e => e.textContent)")
    assert len(seps) >= 1, "a Day divider after the 30 h rest"
    assert seps[0].startswith("Day 2"), seps

    # --- the departure field keeps focus while typing (a re-render must not steal it)
    page.click("#start-time")
    page.evaluate("window.__abtcp.store.update(t => { t.meta.name = t.meta.name; })")
    page.wait_for_timeout(150)
    assert page.evaluate("document.activeElement && document.activeElement.id") == "start-time", "datetime field lost focus on re-render"
    page.click("#stops")
    page.wait_for_timeout(150)

    # --- itinerary calendar view
    trip_menu(page, "btn-itinerary")
    page.wait_for_selector(".itin-ev", timeout=5000)
    assert page.locator(".itin-ev.drive").count() >= 3, "drive blocks"
    assert page.locator(".itin-ev.charge").count() >= 2, "charge blocks"
    assert page.locator(".itin-day").count() >= 2, "day columns (30 h rest spans days)"
    assert page.locator(".itin-ev.rest").count() >= 1, "rest block"
    overlaps = page.evaluate("""() => { let bad = 0; for (const day of document.querySelectorAll('.itin-day')) {
      for (const lane of [['drive', 'rest'], ['charge']]) {
        const rs = [...day.querySelectorAll('.itin-ev')].filter(e => lane.some(k => e.classList.contains(k)))
          .map(e => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
        for (let i = 1; i < rs.length; i++) if (rs[i].top < rs[i - 1].bottom - 1) bad++;
      } } return bad; }""")
    assert overlaps == 0, f"{overlaps} overlapping itinerary blocks"
    assert page.evaluate("[...document.querySelectorAll('.itin-ev')].every(e => e.getBoundingClientRect().height >= 20)"), "unreadably small itinerary blocks"
    assert page.locator("#itin-print").count() == 1, "print button"
    page.evaluate("window.__printed = 0; window.__clicks = 0; window.print = () => { window.__printed++; }; document.getElementById('itin-print').addEventListener('click', () => { window.__clicks++; });")
    page.click("#itin-print")
    printed = page.evaluate("window.__printed")
    assert printed == 1, f"print count: {printed}, click events: {page.evaluate('window.__clicks')}"
    page.click("#itin-close")
    page.wait_for_function("document.getElementById('itinerary').hidden === true", timeout=5000)
    trip_menu(page, "btn-itinerary")
    page.wait_for_selector(".itin-ev", timeout=5000)
    page.locator(".itin-ev").first.click()
    page.wait_for_function("document.getElementById('itinerary').hidden === true", timeout=5000)
    # renaming lives in the Trip menu now
    page.once("dialog", lambda d: d.accept("Renamed trip"))
    trip_menu(page, "btn-rename")
    page.wait_for_function("window.__abtcp.store.trip.meta.name === 'Renamed trip'", timeout=5000)

    # --- popup of a planned charger offers Remove stop
    sid = page.evaluate("window.__abtcp.store.trip.stops[2].siteId")
    page.evaluate(f"window.__abtcp.map.openSite({sid})")
    page.wait_for_selector(".leaflet-popup [data-act=\'removeStop\']", timeout=5000)
    page.click(".leaflet-popup [data-act=\'removeStop\']")
    page.wait_for_function("document.querySelectorAll(\'.stop[data-id]\').length === 2", timeout=15000)
    wait_legs(page)

    # --- battery bars on every card (incl. destination) and under the map badges
    assert page.locator(".stop[data-id] .batt").count() == 2
    assert page.locator("#dest-card .batt").count() == 1
    assert page.locator(".stop-icon .mini-batt").count() >= 2, "mini battery under stop numbers"
    assert page.locator(".stop-icon.start .mini-batt").count() == 1, "battery on the start marker"
    assert page.locator(".stop-icon.dest .mini-batt").count() == 1, "battery on the destination marker"

    # --- badge alignment: the number bubble stays centered on the site at any zoom
    for z in (6, 10):
        misalign = page.evaluate("""(z) => { const a = window.__abtcp; const s = a.store.trip.stops[0];
          a.map.map.setView([s.lat, s.lng], z, { animate: false });
          const pt = a.map.map.latLngToContainerPoint([s.lat, s.lng]);
          const rect = document.getElementById('map').getBoundingClientRect();
          const icons = [...document.querySelectorAll('.leaflet-marker-pane .stop-icon')];
          const el = icons.find(e => { const n = e.querySelector('.n'); return n && n.textContent === '1' && !e.className.includes('start'); });
          if (!el) return 'no badge';
          const b = el.querySelector('.n').getBoundingClientRect();
          return Math.hypot(b.left + b.width / 2 - (rect.left + pt.x), b.top + b.height / 2 - (rect.top + pt.y)); }""", z)
        assert isinstance(misalign, (int, float)) and misalign < 6, f"badge misaligned by {misalign}px at zoom {z}" 

    # --- map filter: All | Reachable | Iconic (trip sites always visible)
    trip_visible = "window.__abtcp.store.trip.stops.filter(s => s.siteId != null).every(s => window.__abtcp.map.isVisible(s.siteId))"
    total_visible = page.evaluate("window.__abtcp.map.visibleCount()")
    page.click("#chip-iconic")
    page.wait_for_function(f"window.__abtcp.map.visibleCount() < {total_visible}", timeout=5000)
    assert page.evaluate("window.__abtcp.map.visibleCount()") > 0, "iconic sites remain"
    assert page.evaluate(trip_visible), "trip sites stay visible in Iconic mode"
    page.click("#chip-reach")
    page.wait_for_timeout(400)
    assert page.evaluate(trip_visible), "trip sites stay visible in Reachable mode"
    assert page.evaluate("window.__abtcp.map.visibleCount()") < total_visible
    assert page.evaluate("window.__abtcp.map.pinsVisible() < window.__abtcp.map.pinsTotal()"), "far iconic pins hidden in Reachable mode" 
    page.click("#chip-all")
    page.wait_for_function(f"window.__abtcp.map.visibleCount() === {total_visible}", timeout=5000)

    # --- iconic badge table in Help (now a dialog tab)
    page.click("#btn-settings")
    page.click("#dtab-help")
    page.wait_for_selector("#panel-help:visible", timeout=5000)
    assert page.locator(".iconic-table").count() >= 3, "badge tables per region"
    help_text = page.text_content("#iconic-table")
    for name in ("Dombås", "Honningsvåg", "Stonehenge", "Great Barrier Reef"):
        assert name in help_text, name
    close_dialog(page)

    # --- replace a stop from the candidates, keeping its rest
    set_rest(page, 0, 2, True)
    old_first = page.evaluate("window.__abtcp.store.trip.stops[0].siteId")
    page.click('.stop[data-index="0"] [data-act="swap"]')
    page.wait_for_selector(".candidate[data-site]", timeout=15000)
    page.click(".candidate[data-site]")
    page.wait_for_function(f"window.__abtcp.store.trip.stops[0].siteId !== {old_first}", timeout=15000)
    wait_legs(page)
    assert page.evaluate("window.__abtcp.store.trip.stops[0].rest.hours") == 2
    assert page.evaluate("window.__abtcp.store.trip.stops[0].rest.sentry") is True
    assert page.locator(".stop[data-id]").count() == 2

    # --- replace by clicking a charger dot directly on the map
    page.click('.stop[data-index="0"] [data-act="swap"]')
    t3 = page.evaluate("""() => { const a = window.__abtcp; const s = a.db.search('Alta', 3).find(x => a.db.isUsable(x) && x.country === 'Norway');
      a.map.map.setView([s.lat, s.lng], 9, { animate: false });
      const r = document.getElementById('map').getBoundingClientRect();
      const p = a.map.map.latLngToContainerPoint([s.lat, s.lng]);
      return { x: r.left + p.x, y: r.top + p.y, id: s.id }; }""")
    page.mouse.click(t3["x"], t3["y"])
    page.wait_for_function(f"window.__abtcp.store.trip.stops[0].siteId === {t3['id']}", timeout=15000)
    wait_legs(page)
    assert page.evaluate("window.__abtcp.store.trip.stops[0].rest.hours") == 2, "rest preserved on map-click replace"

    # --- the top bar keeps a stable geometry while the plan changes
    probe = """(() => ({ top: Math.round(document.querySelector('.actions').getBoundingClientRect().top), height: Math.round(document.querySelector('.topbar').getBoundingClientRect().height), counters: document.querySelectorAll('.counter').length }))()"""
    geom = page.evaluate(probe)
    page.evaluate("window.__abtcp.store.update(t => { t.meta.name = 'a very long trip name that would stretch the bar'; })")
    page.wait_for_timeout(200)
    assert page.evaluate(probe) == geom, "top bar moved when the plan changed"

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
        file_menu(page, "btn-export")
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
