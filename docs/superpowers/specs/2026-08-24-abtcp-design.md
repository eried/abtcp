# ABTCP — A Better Tesla Contest Planner — Design

Date: 2026-08-24 · Status: built autonomously from the owner's written brief; assumptions listed in §13.

## 1. Purpose

A static web app (GitHub Pages, no server, no build step) to plan road trips that visit as
many **unique Tesla Supercharger sites** as possible in one continuous streak for Tesla's
**2026 Free Supercharging Competition** ("Longest Trip" category), while keeping the car's
battery realistic and the 24-hour streak timer satisfied.

It is deliberately a "de-optimizer": instead of the fewest stops, it helps you chain the
*most* stops, each with a short hop and a small charge, without ever stranding the car.

Primary use case: the owner's Model Y 2025 Long Range AWD (Giga Berlin), trip from
Tromsø (Norway) south through Scandinavia and central Europe into a dense area of
southern Europe (e.g. Barcelona / Madrid), and possibly back.

## 2. Contest rules encoded

Source: https://www.tesla.com/support/tesla-app/charging-badges/contest (the page blocks
automated fetches; rules below are as quoted by secondary write-ups — the owner should
verify against the official page; every parameter is configurable in Settings).

- **Longest Trip** = longest continuous streak of *unique* Supercharger sites where each
  new site's charging session happens **within 24 hours of the previous session's start
  time**.
- Repeat visits to an already-counted site are allowed; they neither reset the 24 h timer
  nor add to the trip length.
- A "site" is a distinct location as shown in the app / in-car navigation → only
  **Tesla Supercharger sites** count (no destination chargers, no third-party chargers).
- Other categories tracked as counters: **Most Unique Sites** (per calendar year) and
  **Most Energy Supercharged** (kWh — also the tie-breaker).
- No published minimum kWh/minutes per session → planner uses a safety default of
  ≥ 5 min and ≥ 1 kWh per counted session (configurable).

Configurable rule parameters: window hours (24), timer anchor (`start` of previous counted
session [official] or `end`), safety margin minutes before the deadline (60), minimum
session minutes / kWh.

## 3. Non-goals

- No accounts, no backend, no Tesla account/API integration, no live vehicle data.
- Not a general-purpose fastest-route planner (ABRP does that).
- No turn-by-turn navigation; the output is a plan (stops, charge targets, times) the
  driver follows with the car's own navigation.

## 4. Architecture

Static site served from the repo root:

```
index.html                 entry (single page)
app/main.js                bootstrap + wiring
app/state.js               trip state, autosave (localStorage), import/export JSON (schema v1)
app/chargers.js            loads data/chargers.json, grid spatial index, filters, nearest()
app/planner.js             orchestrates leg building, candidate search, auto-chain
app/model/energy.js        pure physics consumption model (chunks → kWh)
app/model/charging.js      charging curve, time-to-charge, kWh billed
app/model/timeline.js      pure: stops + cached legs → times, SoC, streak status, counters
app/model/cars.js          car presets (Model Y 2025 LR AWD first)
app/model/profiles.js      driving-style presets
app/model/geo.js           haversine, bearing, polyline sampling, chunking
app/services/osrm.js       route + table (throttled queue, configurable base URL)
app/services/weather.js    Open-Meteo forecast / archive, manual override
app/services/elevation.js  Open-Meteo elevation, batched (100 pts) + cache
app/services/geocode.js    Photon (komoot) with Nominatim fallback
app/ui/map.js              Leaflet map, canvas charger layer, route lines, popups
app/ui/sidebar.js          start block, stop cards, candidates panel, settings, toasts
app/ui/format.js           formatting helpers
vendor/leaflet/            vendored Leaflet 1.9.4 (no CDN dependency)
data/chargers.json         generated charger DB (worldwide, ~10.9k sites)
tools/fetch_chargers.py    regenerates data/chargers.json
tools/capture_fixtures.py  records real API responses into tests/fixtures/
tests/unit/*.test.mjs      node --test unit tests (models, serialization)
tests/e2e/test_app.py      Python Playwright end-to-end tests (offline via fixtures)
```

Data flow: user action → `state` mutation → `timeline.compute(trip)` (pure, sync) →
render. Leg results (route geometry, distance, energy, weather, elevation stats) are
computed asynchronously by `planner.buildLeg()` and stored in `trip.legs[cacheKey]`, so an
imported trip renders immediately without network access; "Recompute" refreshes legs.

## 5. Charger database (`tools/fetch_chargers.py`)

- Source: supercharge.info `service/supercharge/allSites` (community-maintained DB of all
  Tesla Supercharger sites; carries Tesla's own `locationId`, so each site links to
  `tesla.com/findus/location/supercharger/<locationId>`). Tesla's own `findus` API is
  behind Akamai bot protection and is not scriptable, so it is not used.
- Output `data/chargers.json`:
  `{ generated, source, count, sites: [ { id, tid, name, status, lat, lng, country, region,
  stalls, kw, opened, elev, plugs } ] }` — compact keys, worldwide, all statuses kept.
- The app shows OPEN and EXPANDING sites by default; CLOSED_TEMP greyed; planned /
  construction hidden (toggle in Settings).

## 6. Energy model (`app/model/energy.js`)

Input: a leg profile = array of chunks `{ d (m), tOsrm (s), vOsrm (m/s), mode:
'driving'|'ferry', bearing, elev0, elev1 }` plus weather `{ tempC, windKmh, windFromDeg,
precipMm }`, car, profile.

Chunking: consecutive OSRM annotation segments are merged until ≥ 400 m (OSRM durations
are rounded to 0.1 s, so per-segment speeds are noise on short segments). Elevation is
sampled at chunk boundaries (Open-Meteo, 100 points per call, cached). Grade is clamped to
±12 %.

Per driving chunk:
- Speed `v = min(vOsrm·speedFactor + offset [only if vOsrm ≥ 60 km/h], vMax)`; time `= d / v`.
- Air density `ρ = 101325 / (287.05 · (T + 273.15))`.
- Headwind `w = windMs · cos(windFrom − bearing)`; `vRel = v + w`.
- Forces: `Faero = ½ ρ Cd A vRel|vRel|`, `Froll = Crr · m · g · (1 + 0.1·wet)`,
  `Fgrade = m · g · grade`.
- Mechanical `Em = (Faero + Froll + Fgrade) · d`; battery energy `Em / ηdrive` if
  positive, `Em · ηregen` if negative (regen).
- Auxiliary `Paux = 0.35 kW + 0.09·max(0, 20−T) + 0.08·max(0, T−24)` kW · time (heat pump).
- Cold-battery factor on drive energy: ×1.08 below 0 °C, ×1.04 below 8 °C.
- Global margin `×(1 + margin%)` (default +5 %: the in-car estimate is optimistic).

Ferry chunk: 0 drive energy; time = OSRM ferry duration + configurable wait (30 min per
ferry); sentry-off parked drain applies for the crossing.

Car preset — Model Y 2025 Long Range AWD (Juniper, EU): usable 75 kWh, mass 1997 kg
(+ 120 kg payload), Cd 0.22, A 2.5 m², Crr 0.010, ηdrive 0.90, ηregen 0.62, max DC 250 kW.
Wh/km sanity targets at 20 °C flat: ~145 at 90 km/h, ~190 at 120 km/h; ~230 at 120 km/h
and 0 °C. Unit tests assert these ranges.

Leg output: `{ km, driveH, ferryH, ferries, gainM, lossM, kwh, whKm, temp, wind,
weatherSrc, geometry (simplified [lat,lng] list), computedAt }`.

## 7. Charging model (`app/model/charging.js`)

- Curve (kW vs SoC %) for the Model Y LR (Panasonic 2170) as piecewise-linear points
  `[(0,120),(5,250),(20,250),(30,205),(40,170),(50,140),(60,115),(70,90),(80,65),(90,45),(100,15)]`,
  capped by `min(siteKw, carMaxKw)`; V2 sites are 150 kW.
- Integrate in 1 % steps: `dt = 0.01·usableKwh / min(curve(soc), cap)`.
- Cold arrival (< 5 °C) without preconditioning: ×0.6 power for the first 10 min
  (Settings: "assume preconditioning", default on).
- Overhead 3 min per stop (park, plug, unplug).
- kWh billed = kWh stored / 0.94 (energy counter, tie-breaker).
- Helper: minimum useful target = next leg kWh + reserve; shown on each stop card.

## 8. Timeline, streak and counters (`app/model/timeline.js`)

State schema (v1):

```
Trip { version:1, meta:{name, createdAt, updatedAt},
       settings:{ rules:{windowH, anchor, marginMin, minSessionMin, minSessionKwh},
                  reserveSoc, marginPct, sentry:{onPctH, offPctH, coldFactor},
                  ferryWaitMin, plugOverheadMin, precondition,
                  weatherOverride:{enabled, tempC, windKmh, windFromDeg},
                  osrmUrl, tiles, showStatuses[] },
       car:{...}, profile:{...},
       start:{ lat, lng, name, time (ISO local), soc },
       destination:{ lat, lng, name } | null,
       stops:[ Stop ], legs:{ [cacheKey]: LegResult }, visitedBefore:[siteId] }
Stop { id, kind:'charger'|'point', siteId?, lat, lng, name,
       charge:{ targetSoc } | null, rest:{ hours, sentry } | null, note }
```

`compute(trip)` walks the stops: arrival time = previous departure + leg time + break
time (profile: minutes per hour of driving); arrival SoC = departure SoC − leg kWh /
usable; if `charge` and the stop is a charger: session start = arrival + overhead;
**counted** iff the site is not yet counted in this trip; deadline = last counted
session `anchor` + windowH; `streakBroken` if session start > deadline; charge time from
the curve; departure = session start + charge time. `rest`: departure += hours, SoC −=
drain(sentry, temp) · hours. Warnings: SoC below reserve, SoC below 0 (leg impossible),
deadline missed, deadline within margin, session below minimum, site not open, leg
pending / failed, unroutable site.

Summary: `{ uniqueCounted, tripLength (sites counted before the first break),
firstBreakIndex, newForYear (not in visitedBefore), totalKm, totalDriveH, totalTimeH,
chargeH, kwhBilled, eta, minSoc, warnings[] }`.

Per stop: `sinceLastSessionH` and `deadlineIn` (h:mm, negative = missed) for the "how long
since the last session" display.

## 9. Planner (`app/planner.js`)

- `buildLeg(from, to)`: OSRM route (`overview=full, geometries=geojson, steps=true,
  annotations=true`) → ferry intervals from steps with `mode:'ferry'` → chunk →
  elevation samples → weather at the leg midpoint for the ETA hour (forecast if within
  16 days, else archive for the same date one year earlier, else override) → energy
  model → LegResult stored in `trip.legs`.
- `candidates(fromLatLng, opts)`: haversine pre-filter of unvisited open sites (nearest
  60, optional "toward destination" filter: candidate must reduce distance-to-destination)
  → one OSRM `table` call (null = unroutable, dropped) → road km + h → quick SoC estimate
  (average Wh/km of the trip so far, else the car's profile value at the chosen
  temperature) → sorted by road km.
- `autoChain(n)`: repeatedly add the nearest candidate that is toward the destination and
  reachable above reserve with the default charge target; stops when `n` reached, the
  destination is within one hop, or nothing is reachable.
- Request throttling: max 4 concurrent OSRM calls, ≥ 120 ms spacing; one retry.

## 10. UI (`index.html`, `app/ui/*`)

- Header: title; counters — unique sites counted, streak state (OK / broken at stop #n),
  total km, total time, kWh charged, ETA; Import / Export / New / Recompute buttons.
- Left panel, tabs **Trip** and **Settings**.
  - Trip: start block (place search via Photon, or "set start" from map/charger; date-time;
    start SoC slider); destination (optional, for "toward" ranking); stop cards in order:
    number, name (link to tesla.com), country / stalls / kW, arrival time + SoC, streak
    timer ("+13h20 since last session · deadline in 10h40"), charge target slider with
    "min useful" marker and resulting session minutes / kWh, rest controls (hours, sentry
    toggle), leg stats under the card (km, h, ferries, ↑gain, Wh/km, temp), move up/down,
    delete. "Next stop" finder: list of candidates with road km, h, arrival SoC,
    toward-destination badge; click adds. "Auto-chain N stops" control.
  - Settings: car preset + editable numbers; driving profile preset (Limit, +5 km/h, +10,
    Eco) + numbers; contest rule parameters; reserve / margin; sentry rates; ferry wait;
    plug overhead; weather override; shown statuses; OSRM URL; tiles.
- Map (Leaflet, canvas renderer): chargers colored by state (open / temporarily closed /
  planned, planned-in-trip, visited-before); numbered stop markers; route polylines colored
  by arrival SoC (green → red); popup: name, stalls, kW, status, "Add as next stop",
  "Set as start", "Set as destination", "Mark visited earlier this year".
- Persistence: autosave to localStorage on every change; Export downloads
  `abtcp-trip-<name>.json`; Import via file picker; New trip resets to defaults.
- Toasts for service errors; failed legs show a retry button.

## 11. External services and fair use

OSRM demo server (routing, table) — light personal use; base URL configurable for
self-hosting. Open-Meteo (weather, elevation) — free, no key, CORS. Photon / Nominatim
(geocoding, ≤ 1 req/s). OSM tiles with attribution (CARTO alternative). All calls are
made from the browser; nothing is proxied.

## 12. Testing

- Unit: `node --test tests/unit` — energy ranges, chunking, charging times, timeline &
  streak edge cases (repeat site, missed deadline, rest drain), JSON round-trip.
- E2E: `python tests/e2e/test_app.py` — serves the repo with `http.server`, intercepts
  OSRM / Open-Meteo / Photon requests with recorded fixtures, then: loads the DB, sets a
  start (Tromsø), adds two chargers and a rest, checks SoC / timer values, exports a file,
  reloads, imports it and checks identical state; also checks localStorage autosave and
  settings persistence. `ABTCP_LIVE=1` runs a smoke test against the real services.

## 13. Assumptions (to confirm)

1. Rules quoted from secondary sources; the official page could not be fetched by script.
2. Sites in countries excluded from EMEA *eligibility* (Italy, Portugal, Greece, Poland,
   Romania, Iceland, Estonia, …) are assumed to still count as visited sites for a German
   participant — the exclusion list reads as participant residency, not site location.
3. Sentry drain defaults: 150 W (firmware ≥ 2024.38) ≈ 0.2 %/h (~5 %/day); parked with
   sentry off ≈ 0.04 %/h; ×1.3 below 0 °C.
4. Car physics constants are tuned to public range tests; margin +5 % covers the in-car
   estimate optimism the owner observed.
5. Charging sessions are assumed to require ≥ 5 min / ≥ 1 kWh to be recorded (safety).
