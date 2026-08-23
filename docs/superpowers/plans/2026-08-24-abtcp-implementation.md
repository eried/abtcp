# ABTCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the static "A Better Tesla Contest Planner" web app: charger DB, physics-based
battery model, 24 h-streak timeline, interactive map planner with import/export, unit + e2e tests.

**Architecture:** Plain ES-module JavaScript served from the repo root (GitHub Pages, no build).
Pure model modules (`app/model/*`) are unit-tested with `node --test`; browser-only code
(`app/ui/*`, `app/services/*`) is exercised by Python Playwright e2e tests that replay
recorded fixtures for OSRM and synthetic responses for Open-Meteo/Photon. Trip state is one
JSON document (schema v1) autosaved to localStorage and exported/imported as a file.

**Tech Stack:** ES2022 modules, Leaflet 1.9.4 (vendored), OSRM demo API, Open-Meteo, Photon;
Python 3.12 (`tools/`, Playwright e2e); Node 22 (`node --test`).

**Spec:** `docs/superpowers/specs/2026-08-24-abtcp-design.md`

## Global Constraints

- No build step, no bundler, no framework; `index.html` at repo root must work from `file://`-free static hosting (GitHub Pages).
- No CDN at runtime except map tiles and the public APIs listed in spec §11; Leaflet is vendored under `vendor/leaflet/`.
- All external calls happen in the browser with CORS; no secrets.
- Trip JSON schema version `1`; `deserialize` must accept any older/partial document by deep-merging defaults.
- Model modules must not touch `window`/`document`/`fetch` (they run in Node tests).
- Bash on this machine truncates commands > ~8 KB: write large files with the Write tool.
- Commit after each task (`git add -A && git commit`).

---

### Task 1: Scaffold repo, vendor Leaflet, test runners

**Files:**
- Create: `.gitignore`, `package.json`, `vendor/leaflet/{leaflet.js,leaflet.css,images/*}`, `README.md` (stub), `tests/unit/smoke.test.mjs`

**Interfaces:**
- Produces: `npm test` → `node --test tests/unit`; `python tests/e2e/test_app.py` (Task 11).

- [ ] **Step 1: package.json + .gitignore**

```json
{ "name": "abtcp", "private": true, "type": "module",
  "scripts": { "test": "node --test tests/unit/", "serve": "python -m http.server 8080" } }
```
`.gitignore`: `node_modules/`, `__pycache__/`, `*.pyc`, `tests/e2e/output/`, `.playwright/`

- [ ] **Step 2: Vendor Leaflet 1.9.4** from unpkg: `dist/leaflet.js`, `dist/leaflet.css`, `dist/images/{marker-icon.png,marker-icon-2x.png,marker-shadow.png,layers.png,layers-2x.png}`.

- [ ] **Step 3: smoke test** `tests/unit/smoke.test.mjs`:
```js
import test from 'node:test'; import assert from 'node:assert/strict';
test('runner works', () => assert.equal(1 + 1, 2));
```
Run `npm test` → PASS. Commit `chore: scaffold repo, vendor leaflet`.

---

### Task 2: Charger database tool + loader

**Files:**
- Create: `tools/fetch_chargers.py`, `data/chargers.json` (generated), `app/chargers.js`, `tests/unit/chargers.test.mjs`

**Interfaces:**
- Produces: `data/chargers.json` = `{ generated: ISO, source: string, count: n, sites: Site[] }`,
  `Site = { id:number, tid:string|null, name, status:'OPEN'|'EXPANDING'|'CLOSED_TEMP'|'CLOSED_PERM'|'CONSTRUCTION'|'PERMIT'|'PLAN'|'VOTING', lat, lng, country, region, stalls:number, kw:number, opened:string|null, elev:number|null, plugs:string[] }`
- Produces: `class ChargerDB { sites; byId(id); nearest(lat, lng, {n=60, filter=(s)=>true}) → [{site, distM}]; isUsable(site) }`, `export async function loadChargers(url)`.

- [ ] **Step 1:** `tools/fetch_chargers.py` downloads `https://supercharge.info/service/supercharge/allSites`, maps fields (`locationId→tid`, `gps.latitude→lat`, `powerKilowatt→kw`, `stallCount→stalls`, `address.country/region`, `elevationMeters→elev`, plug keys with count>0), sorts by id, writes compact JSON (`separators=(',',':')`, `ensure_ascii=False`) and prints per-region counts. `--input` flag lets it read a cached download.
- [ ] **Step 2:** run it → `data/chargers.json` (~1.5 MB, ~10.9k sites).
- [ ] **Step 3:** test `tests/unit/chargers.test.mjs`: loads the file with `fs`, asserts count > 8000, every site has numeric lat/lng and a status; `new ChargerDB(data).nearest(69.65, 18.95, {n:3, filter: s => s.status==='OPEN'})` returns Skibotn/Finnsnes within 140 km.
- [ ] **Step 4:** implement `app/chargers.js` (brute-force haversine via `geo.js` from Task 3 — order Task 3 first or inline the haversine). Run tests, commit `feat: charger database tool and loader`.

---

### Task 3: Geometry helpers and route chunking

**Files:**
- Create: `app/model/geo.js`, `tests/unit/geo.test.mjs`

**Interfaces:**
```js
export function haversineM(lat1, lng1, lat2, lng2) // meters
export function bearingDeg(lat1, lng1, lat2, lng2) // 0..360
export function ferryIntervals(steps) // OSRM legs[0].steps → [{start, end, seconds, name}] cumulative meters
export function chunkRoute(coords, annotation, ferries, minLen = 500)
// coords: GeoJSON [[lng,lat],...]; annotation: {distance[], duration[], speed[]}
// → [{ d, t, v, mode:0|1, brg, lat0, lng0, lat1, lng1 }]  (v = d/t, mode 1 = ferry)
export function packChunk(c)   // → [d, t, v, mode, brg, lat0, lng0, elev0]
export function unpackChunk(a, next) // inverse, elev1 from next chunk / last point
```

- [ ] **Step 1: tests**
```js
test('haversine Tromsø→Skibotn ≈ 59 km', () => { const m = haversineM(69.6496,18.9553,69.3924,20.2684); assert.ok(m > 57000 && m < 61000); });
test('bearing north is 0, east is 90', () => { assert.ok(Math.abs(bearingDeg(0,0,1,0)) < 0.01); assert.ok(Math.abs(bearingDeg(0,0,0,1) - 90) < 0.01); });
test('chunkRoute merges short segments to ≥ minLen and preserves total distance', () => {
  const coords = Array.from({length: 11}, (_, i) => [10 + i*0.001, 60]); // ~55 m apart
  const ann = { distance: Array(10).fill(55.6), duration: Array(10).fill(2), speed: Array(10).fill(27.8) };
  const chunks = chunkRoute(coords, ann, [], 200);
  const total = chunks.reduce((s,c) => s + c.d, 0);
  assert.ok(Math.abs(total - 556) < 0.01); assert.ok(chunks.every(c => c.d >= 200 || c === chunks.at(-1)));
});
test('ferry interval marks chunks as mode 1 and never merges across the boundary', ...)
```
- [ ] **Step 2:** implement; note the ferry rule: a chunk never mixes modes — close the current chunk when the cumulative distance enters/leaves a ferry interval. Run tests, commit `feat: geo helpers and route chunking`.

---

### Task 4: Car presets, driving profiles, energy model

**Files:**
- Create: `app/model/cars.js`, `app/model/profiles.js`, `app/model/energy.js`, `tests/unit/energy.test.mjs`

**Interfaces:**
```js
// cars.js
export const CARS = [{ id:'my-2025-lr-awd', name:'Model Y 2025 Long Range AWD (Berlin)', usableKwh:75, massKg:1997, payloadKg:120,
  cd:0.22, areaM2:2.5, crr:0.010, etaDrive:0.90, etaRegen:0.65, maxDcKw:250, refWhKm:175,
  curve:[[0,120],[5,250],[20,250],[30,205],[40,170],[50,140],[60,115],[70,90],[80,65],[90,45],[100,15]] }, ...]
// profiles.js
export const PROFILES = [{ id:'plus5', name:'+5 km/h over limit (default)', speedFactor:1.0, offsetKmh:5, maxKmh:135, breakMinPerH:5 }, {id:'limit',...offsetKmh:0}, {id:'plus10',...}, {id:'eco', speedFactor:0.95, offsetKmh:-5}]
// energy.js
export function airDensity(tempC)
export function auxPowerKw(tempC)
export function chunkEnergy(chunk /* {d,t,v,mode,brg,elev0,elev1} */, wx /* {tempC, windKmh, windFromDeg, precipMm} */, car, profile, settings /* {marginPct, ferryWaitMin, sentry} */)
// → { kwh, seconds, vKmh }
export function legEnergy(chunks, wx, car, profile, settings)
// → { kwh, driveH, ferryH, ferries, gainM, lossM, whKm, km }
export function quickWhKm(car, tempC) // refWhKm adjusted for temperature
```

- [ ] **Step 1: tests** (flat 10 km chunk at given speed and temperature):
```js
const flat = (vKmh) => [{ d:10000, t:10000/(vKmh/3.6), v:vKmh/3.6, mode:0, brg:0, elev0:0, elev1:0 }];
const wx = (t) => ({ tempC:t, windKmh:0, windFromDeg:0, precipMm:0 });
const S = { marginPct:5, ferryWaitMin:30, sentry:{ onPctH:0.2, offPctH:0.04, coldFactor:1.3 } };
test('120 km/h at 20°C ≈ 180–200 Wh/km', () => { const r = legEnergy(flat(120), wx(20), CAR, LIMIT, S); assert.ok(r.whKm > 180 && r.whKm < 200, r.whKm); });
test('90 km/h at 20°C ≈ 130–150 Wh/km', ...);
test('120 km/h at 0°C ≈ 215–245 Wh/km', ...);
test('headwind increases consumption, tailwind decreases', ...); // windFromDeg 0 with brg 0 vs windFromDeg 180
test('climb 500 m over 10 km costs more than descent recovers', ...);
test('ferry chunk consumes ~0 and adds wait time', ...);
test('profile offset applies only above 60 km/h', ...);
```
- [ ] **Step 2:** implement per spec §6. Speed rule: `vOsrmKmh >= 60 ? vOsrm*factor + offset : vOsrm*factor`, clamp to `[5, maxKmh]`. Ferry: `seconds = chunk.t` and (once per contiguous ferry run — handled in `legEnergy`) `+ ferryWaitMin*60`; energy = parked drain at `offPctH` × usableKwh × hours. Run tests, tune constants until ranges hold. Commit `feat: energy model, car and profile presets`.

---

### Task 5: Charging model

**Files:**
- Create: `app/model/charging.js`, `tests/unit/charging.test.mjs`

**Interfaces:**
```js
export function curveKw(car, soc)
export function chargeSession({ car, siteKw, fromSoc, toSoc, coldStart=false, overheadMin=3, lossFactor=0.94 })
// → { minutes /* incl. overhead */, kwhStored, kwhBilled, avgKw }
export function restDrainPctPerH(sentry, tempC, s /* settings.sentry */)
export function socAfterRest(soc, hours, sentry, tempC, s)
```
- [ ] **Step 1: tests:** 10→50 % at 250 kW site ≈ 9–13 min incl. 3 min overhead and 30 kWh stored, ~31.9 kWh billed; same at 150 kW site takes longer; `toSoc <= fromSoc` → 0 kWh, 0 min; coldStart adds ≥ 3 min; `restDrainPctPerH(true, 10)` = 0.2, `(true, -5)` = 0.26; `socAfterRest(50, 10, true, 10)` = 48.
- [ ] **Step 2:** implement (1 % steps, `dt = 0.01*usable / min(curve, siteKw, maxDcKw)`; coldStart multiplies power by 0.6 while elapsed < 10 min). Commit `feat: charging model`.

---

### Task 6: Trip state, defaults, serialization

**Files:**
- Create: `app/state.js`, `tests/unit/state.test.mjs`

**Interfaces:**
```js
export const SCHEMA_VERSION = 1;
export function defaultSettings()
export function defaultTrip() // start = Tromsø, time = next day 08:00 local, soc 90, car = CARS[0], profile = PROFILES[0]
export function newStop({ site } | { lat, lng, name }) // charger stop with charge {targetSoc: 60}, rest null
export function serialize(trip) → string
export function deserialize(text) → trip  // throws Error('Not an ABTCP trip file') on garbage; deep-merges defaults
export function createStore({ storage = globalThis.localStorage, key = 'abtcp.trip' } = {})
// → { get trip, update(fn), replace(trip), subscribe(fn) → unsubscribe, save(), load() → boolean }
```
- [ ] **Step 1: tests:** round-trip `deserialize(serialize(defaultTrip()))` deep-equals; partial doc `{version:1, stops:[]}` gets defaults; garbage throws; store with an in-memory storage object saves on `update` and `load()` restores; subscribers fire once per update.
- [ ] **Step 2:** implement. Commit `feat: trip state and serialization`.

---

### Task 7: Timeline, streak and counters

**Files:**
- Create: `app/model/timeline.js`, `tests/unit/timeline.test.mjs`

**Interfaces:**
```js
export function legKey(a, b) // `${lat.toFixed(5)},${lng.toFixed(5)}>${...}` — coordinates only
export function legTimeH(leg, profile, settings) // driveH + ferryH + ferries*wait + breaks
export function compute(trip) // → { stops: StopResult[], summary }
```
`StopResult = { i, stop, leg: { status:'ok'|'pending'|'failed', km, driveH, ferryH, ferries, gainM, lossM, kwh, whKm, temp, windKmh, weatherSrc } , arrival, arrivalSoc, session: null | { start, end, minutes, kwhStored, kwhBilled, counted, isNew, deadline, deadlineInH, sinceLastH, broken, belowMin }, rest: null | { start, end, drainPct }, depart, departSoc, minUsefulSoc, warnings: [{level, msg}] }`
`summary = { uniqueCounted, longestStreak, currentStreak, firstBreakIndex, newForYear, totalKm, totalDriveH, totalTimeH, chargeH, kwhBilled, eta, minSoc, pendingLegs, warnings }`

Energy for a leg is recomputed inside `compute` from `leg.route.chunks` + `leg.weather` via `legEnergy`, so profile/car/settings edits apply instantly. Stored leg shape (from Task 9):
`trip.legs[key] = { status:'ok', route:{ km, osrmH, chunks:number[][], last:[lat,lng,elev], ferries:[{km,h,name}] }, weather:{tempC, windKmh, windFromDeg, precipMm, source, at}, computedAt }` or `{ status:'failed', error }`.

- [ ] **Step 1: tests** (helpers build a trip with synthetic ok legs: `mkLeg(km, hours)` producing a single flat chunk):
  - two charger stops 100 km apart, start 90 %: arrivalSoc[0] ≈ 90 − 100·whKm/750; session counted; `uniqueCounted` 2; `longestStreak` 2.
  - second visit to the same siteId: not `isNew`, `uniqueCounted` stays 1, timer unchanged.
  - rest 30 h with sentry between two sites → second session `broken`, `firstBreakIndex` = 1, `longestStreak` 1, `currentStreak` 1.
  - anchor 'end' vs 'start' changes `deadline` by the session length.
  - leg missing → `leg.status 'pending'`, `summary.pendingLegs` 1, warning.
  - arrival below reserve → warning level 'warn'; below 0 → 'error'.
  - point stop with `charge:{targetSoc:80, kw:11}` adds energy but no session.
- [ ] **Step 2:** implement per spec §8. Commit `feat: timeline with streak rules`.

---

### Task 8: Services (OSRM, elevation, weather, geocode)

**Files:**
- Create: `app/services/osrm.js`, `app/services/elevation.js`, `app/services/weather.js`, `app/services/geocode.js`, `app/services/http.js`, `tests/unit/services.test.mjs`

**Interfaces:**
```js
// http.js
export function createQueue({ maxConcurrent = 4, spacingMs = 120 }) // → run(fn) → Promise
export async function getJson(url, { fetchImpl = globalThis.fetch, retries = 1 } = {})
// osrm.js
export function routeUrl(base, a, b) // `${base}/route/v1/driving/${lng},${lat};${lng},${lat}?overview=full&geometries=geojson&steps=true&annotations=true` (6 decimals)
export function tableUrl(base, from, dests) // `${base}/table/v1/driving/${coords}?sources=0&destinations=1;2;...&annotations=distance,duration`
export function createOsrm({ baseUrl, fetchImpl, queue }) // → { route(a,b) → {distance, duration, geometry, legs}, table(from, dests) → { distances:number|null[], durations } }
// elevation.js
export function createElevation({ fetchImpl, cache = new Map() }) // → { sample(points) → number[] } batches of 100, url `https://api.open-meteo.com/v1/elevation?latitude=a,b&longitude=c,d` (5 decimals)
// weather.js
export function weatherUrl({lat, lng, date /* 'YYYY-MM-DD' */, archive })
export async function weatherAt({ lat, lng, time /* ms */, override, fetchImpl, now = Date.now() })
// → { tempC, windKmh, windFromDeg, precipMm, source:'override'|'forecast'|'archive'|'default', at }
// geocode.js
export async function geocode(q, { fetchImpl }) // Photon → [{ name, lat, lng }] (max 6); falls back to Nominatim
```
- [ ] **Step 1: tests** with a fake `fetchImpl` that records URLs and returns canned JSON: `routeUrl` string exact; `table` maps `null` through; elevation batches 250 points into 3 calls and caches repeats; `weatherAt` picks forecast for `time` within 15 days of `now`, archive (date − 1 year) otherwise, override when enabled, `default` (10 °C) on fetch error; queue never exceeds `maxConcurrent`.
- [ ] **Step 2:** implement. Commit `feat: routing, elevation, weather, geocoding services`.

---

### Task 9: Planner (leg building, candidates, auto-chain)

**Files:**
- Create: `app/planner.js`, `tests/unit/planner.test.mjs`

**Interfaces:**
```js
export function createPlanner({ store, db, osrm, elevation, weatherAt })
// → { buildLeg(a, b, {force=false}) → leg, ensureLegs({onProgress}) , candidates({ from, limit=15, toward=true }) → Candidate[], autoChain({ n, targetSoc, toward=true, onProgress }) }
// Candidate = { site, roadKm, roadH, arrivalSoc, progressKm, distM }
```
`buildLeg`: `osrm.route` → `ferryIntervals` → `chunkRoute(minLen 500)` → `elevation.sample` at chunk starts + last point → `weatherAt` (leg midpoint, ETA = departure time of `a` + osrm duration/2) → store `{status:'ok', route, weather, computedAt}` under `legKey(a,b)`; on error store `{status:'failed', error}` and rethrow-free.
`candidates`: `db.nearest(from, {n:60, filter: usable && not in trip stops})` → optional toward filter (`progressKm > 0` where progress = dist(from,dest) − dist(cand,dest)) → `osrm.table` → drop nulls → `arrivalSoc = fromSoc − roadKm·quickWhKm/(usable·10)` → sort by roadKm.
`autoChain`: loop up to `n`: take candidates, try in order: append stop, `buildLeg`, `compute`; keep if arrivalSoc ≥ reserve else remove and try next (max 3 tries); stop when destination within `haversine < 30 km` or no candidate.

- [ ] **Step 1: tests** with fake osrm/elevation/weather: `buildLeg` stores chunks with elevations and weather; `candidates` excludes visited stops and nulls, sorts by road km, toward filter drops sites that move away; `autoChain(2)` appends two stops and each has an ok leg.
- [ ] **Step 2:** implement. Commit `feat: planner with candidates and auto-chain`.

---

### Task 10: UI — index.html, map, sidebar, main

**Files:**
- Create: `index.html`, `app/styles.css`, `app/ui/format.js`, `app/ui/map.js`, `app/ui/sidebar.js`, `app/main.js`

**Interfaces:**
```js
// format.js
export const fmt = { km(n), h(hours) /* '3h20' */, pct(n), kwh(n), time(ms) /* 'Tue 02.09 14:05' */, deadline(h) /* '+10h40' | '-1h05' */ }
// map.js
export function createMap({ el, tiles }) // → { map, setSites(sites, classify /* site → 'open'|'closed'|'planned'|'inTrip'|'visited' */), setRoute(legResults), setStops(start, stops, destination), fitTrip(), on(event, fn) } events: 'siteClick' {site}, 'mapClick' {lat,lng}
// sidebar.js
export function createSidebar({ el, store, planner, db, geocode, actions }) // renders on store change; actions: { addStop(site), setStart(latlng,name), setDestination, exportTrip, importFile, newTrip, recompute, autoChain(n) }
```
DOM ids used by tests: `#app`, `#counter-unique`, `#counter-streak`, `#counter-km`, `#counter-time`, `#counter-kwh`, `#counter-eta`, `#btn-export`, `#btn-import`, `#file-import`, `#btn-new`, `#btn-recompute`, `#start-search`, `#start-results`, `#start-time`, `#start-soc`, `#stops` (cards `.stop[data-id]` with `.arrival-soc`, `.deadline`, `input.charge-target`, `input.rest-hours`, `input.rest-sentry`, `.btn-remove`), `#candidates` (`.candidate[data-site]`), `#btn-autochain`, `#autochain-n`, `#tab-trip`, `#tab-settings`, settings inputs `[data-setting="rules.windowH"]` etc. (data-setting = dotted path into `trip.settings`), car fields `[data-car="usableKwh"]`, profile fields `[data-profile="offsetKmh"]`, `#toast`.

- [ ] **Step 1:** write `index.html` (header counters + buttons, `#sidebar` with two tabs, `#map`), `styles.css` (dark UI, 400 px sidebar, cards).
- [ ] **Step 2:** `map.js`: canvas renderer `L.circleMarker` per usable site (radius 4, color by class), route `L.polyline` per leg colored by arrival SoC (`> 30` green, `> 15` amber, else red), numbered `L.divIcon` stop markers, start (green) / destination (purple) markers, popup with action buttons dispatching `siteClick` with `{site, action}`.
- [ ] **Step 3:** `sidebar.js`: render function builds the whole panel from `compute(trip)`; event delegation for sliders (`change`), buttons, tabs; start search with 400 ms debounce → `geocode`; candidates panel refreshes after each stop change (`planner.candidates`) with a "toward destination" checkbox; settings tab writes `trip.settings`/`car`/`profile` by data attributes.
- [ ] **Step 4:** `main.js`: load DB → create store (load or default) → services (OSRM base from settings) → planner → map + sidebar → `planner.ensureLegs()` in background → toasts on errors.
- [ ] **Step 5:** run `python -m http.server 8080`, open with Playwright, screenshot, fix console errors. Commit `feat: planner UI`.

---

### Task 11: E2E tests (Playwright, offline fixtures)

**Files:**
- Create: `tools/capture_fixtures.py`, `tests/fixtures/*.json`, `tests/e2e/test_app.py`, `tests/e2e/server.py`

- [ ] **Step 1:** `capture_fixtures.py` calls the real OSRM route for Tromsø→Skibotn, Skibotn→Setermoen, Setermoen→Narvik and the table Tromsø→60 nearest, saving `tests/fixtures/osrm_route_<lat1>_<lng1>_<lat2>_<lng2>.json` (3-decimal keys) and `osrm_table_69.650_18.955.json`.
- [ ] **Step 2:** `test_app.py` (plain script with asserts, no pytest dependency): starts `http.server` on a free port in a thread; `page.route` handlers: OSRM route/table → fixture by rounded coords (404 if missing); elevation → `{elevation:[50,...]}`; Open-Meteo forecast/archive → canned 10 °C / 10 km/h; Photon → canned Tromsø. Scenarios:
  1. load `/` → DB loaded (`#counter-unique` visible, `window.__abtcp.db.sites.length > 8000`).
  2. set start via search "Tromsø" → click result; set `#start-time` `2026-09-01T08:00`, `#start-soc` 90.
  3. click candidate Skibotn → card appears with arrival SoC between 60 and 85; set charge target 70; add Setermoen; add rest 10 h sentry on → next deadline shows `-`/warning? (10 h + drive < 24 h → still OK) then set rest 30 h → `#counter-streak` contains "broken".
  4. export: `page.expect_download()` → save → JSON parses, `stops.length == 2`.
  5. reload → autosaved state restored (2 stops); click New → 0 stops; import file → 2 stops, same arrival SoC text.
  6. settings: set `[data-setting="rules.windowH"]` to 48 → streak OK again; reload → still 48.
- [ ] **Step 3:** run, fix, commit `test: playwright e2e with fixtures`.

---

### Task 12: README, example trip, final verification

- [ ] **Step 1:** `README.md`: what it is, contest rules summary + link, how to use, how to run locally, how to refresh the charger DB, how to run tests, GitHub Pages deploy (Settings → Pages → main / root), disclaimers (fair use of OSRM demo, rules verification).
- [ ] **Step 2:** `examples/tromso-south.json` produced by running auto-chain with the real services (live) for ~8 stops as a starter.
- [ ] **Step 3:** run `npm test` and `python tests/e2e/test_app.py`; commit `docs: readme and example trip`.

## Self-review

- Spec §5 (DB) → Task 2; §6 → Task 4 (+ §3 chunking); §7 → Task 5; §8 → Tasks 6–7; §9 → Task 9; §10 → Task 10; §11 → Task 8 (fallbacks: weather `default`, failed legs retry in UI); §12 → Tasks 1, 11.
- Names cross-checked: `legKey`, `legEnergy`, `chargeSession`, `compute`, `createPlanner`, `createStore`, `ChargerDB.nearest` used consistently.
