// Scenario harness for "fill this leg" against the REAL services (OSRM, Open-Meteo, Valhalla).
//
//   node tools/fill_scenarios.mjs            run every scenario
//   node tools/fill_scenarios.mjs sparse     run scenarios whose name contains "sparse"
//
// Each scenario builds a trip, clicks "fill" once (or several times), and checks the invariants
// the feature promises: the leg becomes drivable when a solution exists, detours stay within the
// budget that was allowed, no stop is pushed above the charge cap, and the route is not inflated.
import { readFileSync } from 'node:fs';
import { createStore, defaultTrip, newStop } from '../app/state.js';
import { ChargerDB } from '../app/chargers.js';
import { createOsrm } from '../app/services/osrm.js';
import { createElevation } from '../app/services/elevation.js';
import { weatherAt } from '../app/services/weather.js';
import { createQueue } from '../app/services/http.js';
import { createPlanner } from '../app/planner.js';
import { compute } from '../app/model/timeline.js';

const db = new ChargerDB(JSON.parse(readFileSync(new URL('../data/chargers.json', import.meta.url), 'utf8')));
const site = (name, country = null) => {
  const hit = db.search(name, 8).find(s => db.isUsable(s) && (!country || s.country === country));
  if (!hit) throw new Error(`no usable site for ${name}`);
  return hit;
};

function makePlanner(trip) {
  const store = createStore({ storage: null, trip });
  const planner = createPlanner({
    store,
    db,
    osrm: createOsrm({ queue: createQueue({ maxConcurrent: 3, spacingMs: 140 }) }),
    elevation: createElevation({ queue: createQueue({ maxConcurrent: 2, spacingMs: 120 }) }),
    weatherAt,
  });
  return { store, planner };
}

function baseTrip({ from, soc = 90, when = '2026-09-05T08:00' }) {
  const trip = defaultTrip(new Date(2026, 8, 5));
  trip.start = { lat: from.lat, lng: from.lng, name: from.name, time: when, soc };
  return trip;
}

const SCENARIOS = [
  { name: 'long sparse: Skibotn (Tromsø area) → Aurland', from: site('Skibotn'), to: site('Aurland', 'Norway'), soc: 95 },
  { name: 'user case: Arvidsjaur (60 %) → Aurland', from: site('Arvidsjaur'), to: site('Aurland', 'Norway'), soc: 60 },
  { name: 'sparse north: Alta → Narvik', from: site('Alta', 'Norway'), to: site('Narvik', 'Norway'), soc: 80 },
  { name: 'sparse lapland: Rovaniemi → Vaasa', from: site('Rovaniemi'), to: site('Vaasa'), soc: 70 },
  { name: 'dense: Barcelona → Madrid', from: site('Barcelona', 'Spain'), to: site('Madrid', 'Spain'), soc: 80 },
  { name: 'dense: Berlin → München', from: site('Berlin', 'Germany'), to: site('München', 'Germany'), soc: 70 },
  { name: 'mid: Hamburg → Kolding (Denmark)', from: site('Hamburg', 'Germany'), to: site('Kolding', 'Denmark'), soc: 60 },
  { name: 'low charge start: Umeå (25 %) → Sundsvall', from: site('Umeå', 'Sweden'), to: site('Sundsvall', 'Sweden'), soc: 25 },
  { name: 'very long: Malmö → Verona', from: site('Malmö', 'Sweden'), to: site('Verona', 'Italy'), soc: 90 },
  { name: 'repeat clicks: Narvik → Trondheim ×3', from: site('Narvik', 'Norway'), to: site('Trondheim', 'Norway'), soc: 85, clicks: 3 },
];

const filter = process.argv[2];
const chosen = filter ? SCENARIOS.filter(s => s.name.toLowerCase().includes(filter.toLowerCase())) : SCENARIOS;
let failures = 0;

for (const sc of chosen) {
  const t0 = Date.now();
  const { store, planner } = makePlanner(baseTrip({ from: sc.from, soc: sc.soc }));
  store.update(t => t.stops.push(newStop({ site: sc.to, targetSoc: 60 })));
  await planner.ensureLegs();
  const S = store.trip.settings;
  const directKm = planner.gapKm(store.trip.start, store.trip.stops[0]);
  const before = compute(store.trip);
  const wasDrivable = before.stops.every(r => r.arrivalSoc >= S.reserveSoc);
  const clicks = sc.clicks || 1;
  let added = 0;
  let diag = null;
  const detours = [];
  for (let i = 0; i < clicks; i++) {
    added += await planner.fillLeg({ gapIndex: 0, onFail: d => { diag = d; }, onProgress: (n, m, stop, best) => detours.push(best.detourKm) });
  }
  const tl = compute(store.trip);
  const drivable = tl.stops.every(r => r.arrivalSoc >= S.reserveSoc);
  const maxTarget = Math.max(0, ...store.trip.stops.map(s => (s.charge ? s.charge.targetSoc : 0)));
  const maxDetour = detours.length ? Math.max(...detours) : 0;
  const inflate = (tl.summary.totalKm - directKm) / Math.max(1, directKm) * 100;

  const problems = [];
  if (!drivable && added === 0 && !diag) problems.push('failed with no explanation');
  if (!drivable && added > 0) problems.push('still not drivable after filling');
  if (wasDrivable && !drivable) problems.push('a drivable leg was broken');
  if (maxTarget > (S.maxChargeSoc ?? 90) + 0.01) problems.push(`charge cap exceeded (${maxTarget} %)`);
  if (maxDetour > 250.01) problems.push(`detour beyond the hard limit (${Math.round(maxDetour)} km)`);
  if (drivable && inflate > 35) problems.push(`route inflated by ${inflate.toFixed(0)} %`);
  if (added === 0 && !drivable && diag && !diag.rangeKm) problems.push('diagnosis without a range estimate');

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const status = problems.length ? 'FAIL' : (drivable ? 'ok  ' : 'ok* ');
  if (problems.length) failures++;
  console.log(`${status} ${sc.name}`);
  console.log(`      ${Math.round(directKm)} km direct · +${added} sites in ${clicks} click${clicks > 1 ? 's' : ''} · drivable ${wasDrivable ? 'already' : drivable ? 'now' : 'NO'} · max detour ${Math.round(maxDetour)} km · max target ${maxTarget} % · route +${inflate.toFixed(1)} % · ${secs}s`);
  if (store.trip.stops.length > 1) console.log(`      ${store.trip.stops.map(s => s.name.split(',')[0]).join(' → ')}`);
  if (!drivable && diag) console.log(`      reason: range ${Math.round(diag.rangeKm || 0)} km · nearest on-route ${diag.nearestOnRoute ? `${diag.nearestOnRoute.name} at ${Math.round(diag.nearestOnRoute.fromAKm)} km` : 'none found'}${diag.needsDetour ? ` · alternative ${diag.needsDetour.name} (+${Math.round(diag.needsDetour.detourKm)} km detour)` : ''}`);
  for (const p of problems) console.log(`      ✗ ${p}`);
}

console.log(failures ? `\n${failures}/${chosen.length} scenarios failed` : `\nall ${chosen.length} scenarios passed`);
process.exit(failures ? 1 : 0);
