import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../../app/planner.js';
import { createStore, defaultTrip, newStop } from '../../app/state.js';
import { ChargerDB } from '../../app/chargers.js';
import { legKey, compute } from '../../app/model/timeline.js';
import { haversineM } from '../../app/model/geo.js';

const SITES = [
  { id: 1, tid: 'a', name: 'Skibotn', status: 'OPEN', lat: 69.3924, lng: 20.2684, country: 'Norway', region: 'Europe', stalls: 6, kw: 150, plugs: ['ccs2'] },
  { id: 2, tid: 'b', name: 'Finnsnes', status: 'OPEN', lat: 69.2311, lng: 18.0032, country: 'Norway', region: 'Europe', stalls: 8, kw: 250, plugs: ['ccs2'] },
  { id: 3, tid: 'c', name: 'Setermoen', status: 'OPEN', lat: 68.8613, lng: 18.3484, country: 'Norway', region: 'Europe', stalls: 8, kw: 250, plugs: ['ccs2'] },
  { id: 4, tid: 'd', name: 'Narvik', status: 'OPEN', lat: 68.4385, lng: 17.4272, country: 'Norway', region: 'Europe', stalls: 12, kw: 250, plugs: ['ccs2'] },
  { id: 5, tid: 'e', name: 'Alta', status: 'OPEN', lat: 69.9689, lng: 23.2717, country: 'Norway', region: 'Europe', stalls: 8, kw: 250, plugs: ['ccs2'] },
  { id: 6, tid: 'f', name: 'Planned', status: 'PLAN', lat: 69.0, lng: 18.5, country: 'Norway', region: 'Europe', stalls: 8, kw: 250, plugs: ['ccs2'] },
  { id: 7, tid: 'g', name: 'Island (unroutable)', status: 'OPEN', lat: 69.5, lng: 19.5, country: 'Norway', region: 'Europe', stalls: 4, kw: 250, plugs: ['ccs2'] },
];
const db = new ChargerDB({ sites: SITES });

/** Fake OSRM: straight line, 1.3× haversine, 80 km/h, 3 coordinates, one ferry if requested. */
const fakeOsrm = (log = []) => ({
  async route(a, b) {
    log.push(['route', a.name || a.lat, b.name || b.lat]);
    const d = haversineM(a.lat, a.lng, b.lat, b.lng) * 1.3;
    const mid = [(a.lng + b.lng) / 2, (a.lat + b.lat) / 2];
    const t = d / (80 / 3.6);
    return { distance: d, duration: t, geometry: { coordinates: [[a.lng, a.lat], mid, [b.lng, b.lat]] },
      legs: [{ steps: [{ mode: 'driving', distance: d, duration: t, name: 'E8' }], annotation: { distance: [d / 2, d / 2], duration: [t / 2, t / 2], speed: [22.2, 22.2] } }] };
  },
  async table(from, dests) {
    log.push(['table', dests.length]);
    const distances = dests.map(s => (s.id === 7 ? null : haversineM(from.lat, from.lng, s.lat, s.lng) * 1.3));
    return { distances, durations: distances.map(m => (m == null ? null : m / (80 / 3.6))) };
  },
});
const fakeElevation = () => ({ async sample(pts) { return pts.map((p, i) => 100 + i * 10); } });
const fakeWeather = async ({ time }) => ({ tempC: 12, windKmh: 5, windFromDeg: 180, precipMm: 0, source: 'test', at: time });

function setup() {
  const trip = defaultTrip(new Date(2026, 8, 1));
  trip.start = { lat: 69.6496, lng: 18.9553, name: 'Tromsø', time: '2026-09-01T08:00', soc: 90 };
  const store = createStore({ storage: null, trip });
  const log = [];
  const planner = createPlanner({ store, db, osrm: fakeOsrm(log), elevation: fakeElevation(), weatherAt: fakeWeather, now: () => Date.parse('2026-08-24T12:00:00Z') });
  return { store, planner, log };
}

test('buildLeg stores a packed route with elevations and weather; cached unless forced', async () => {
  const { store, planner, log } = setup();
  const stop = newStop({ site: SITES[0], targetSoc: 70 });
  store.update(t => t.stops.push(stop));
  const leg = await planner.buildLeg(store.trip.start, stop, { departTime: Date.parse('2026-09-01T08:00') });
  assert.equal(leg.status, 'ok');
  assert.ok(leg.route.km > 70 && leg.route.km < 90, `km ${leg.route.km}`);
  assert.ok(leg.route.chunks.length >= 1);
  assert.equal(leg.route.chunks[0].length, 8);
  assert.equal(leg.route.chunks[0][7], 100);
  assert.equal(leg.route.last[2], 100 + leg.route.chunks.length * 10);
  assert.equal(leg.weather.tempC, 12);
  assert.equal(store.trip.legs[legKey(store.trip.start, stop)], leg);
  const again = await planner.buildLeg(store.trip.start, stop);
  assert.equal(again, leg);
  assert.equal(log.filter(l => l[0] === 'route').length, 1);
  await planner.buildLeg(store.trip.start, stop, { force: true });
  assert.equal(log.filter(l => l[0] === 'route').length, 2);
  const { stops } = compute(store.trip);
  assert.ok(stops[0].arrivalSoc > 70 && stops[0].arrivalSoc < 85, `arrival ${stops[0].arrivalSoc}`);
});

test('buildLeg records failures instead of throwing', async () => {
  const { store, planner } = setup();
  planner; // uses fake osrm
  const broken = createPlanner({ store, db, osrm: { async route() { throw new Error('OSRM NoRoute'); } }, elevation: fakeElevation(), weatherAt: fakeWeather });
  const stop = newStop({ site: SITES[0] });
  const leg = await broken.buildLeg(store.trip.start, stop);
  assert.equal(leg.status, 'failed');
  assert.match(leg.error, /NoRoute/);
});

test('candidates: usable only, excludes trip sites and unroutable, sorted by road km, toward filter', async () => {
  const { store, planner } = setup();
  const all = await planner.candidates({ toward: false, limit: 10 });
  const names = all.map(c => c.site.name);
  assert.ok(!names.includes('Planned'));
  assert.ok(!names.includes('Island (unroutable)'));
  assert.ok(names.includes('Skibotn') && names.includes('Alta'));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].roadKm <= all[i].roadKm);
  assert.ok(all[0].arrivalSoc < 90 && all[0].arrivalSoc > 60);
  store.update(t => { t.destination = { lat: 68.4385, lng: 17.4272, name: 'Narvik' }; t.stops.push(newStop({ site: SITES[1] })); });
  const toward = await planner.candidates({ toward: true, limit: 10 });
  const tnames = toward.map(c => c.site.name);
  assert.ok(!tnames.includes('Finnsnes'), 'already in trip');
  assert.ok(!tnames.includes('Alta'), 'moves away from Narvik');
  assert.ok(tnames.includes('Setermoen') && tnames.includes('Narvik'));
  toward.forEach(c => assert.ok(c.progressKm > 0));
});



test('ensureLegs builds only missing legs in order and pruneLegs drops orphans', async () => {
  const { store, planner, log } = setup();
  store.update(t => { t.stops.push(newStop({ site: SITES[0] }), newStop({ site: SITES[2] })); });
  const built = await planner.ensureLegs();
  assert.equal(built, 2);
  assert.equal(await planner.ensureLegs(), 0);
  assert.equal(log.filter(l => l[0] === 'route').length, 2);
  store.update(t => { t.stops.splice(0, 1); });
  assert.equal(Object.keys(store.trip.legs).length, 2);
  planner.pruneLegs();
  assert.equal(Object.keys(store.trip.legs).length, 0);
});


test('candidates prefer sites not visited this year and ensureLegs builds the destination leg', async () => {
  const { store, planner } = setup();
  store.update(t => { t.visitedBefore = [1]; });
  const cands = await planner.candidates({ toward: false, limit: 10 });
  const iSk = cands.findIndex(c => c.site.id === 1);
  const iFi = cands.findIndex(c => c.site.id === 2);
  assert.ok(iSk >= 0 && iFi >= 0 && iSk > iFi, `visited Skibotn at ${iSk}, Finnsnes at ${iFi}`);
  assert.equal(cands[iSk].visitedYear, true);
  assert.equal(cands[iFi].visitedYear, false);
  store.update(t => { t.destination = { lat: 68.4385, lng: 17.4272, name: 'Narvik town' }; });
  await planner.ensureLegs();
  const tl = compute(store.trip);
  assert.ok(tl.destination, 'destination result exists');
  assert.equal(tl.destination.leg.status, 'ok');
  assert.ok(tl.destination.arrivalSoc < 90);
  store.update(t => { t.destination = null; });
  planner.pruneLegs();
  assert.equal(Object.keys(store.trip.legs).length, 0);
});

test('fillLeg inserts near the middle of the leg, not at its start', async () => {
  const { store, planner } = setup();
  store.update(t => { t.stops.push(newStop({ site: SITES[3], targetSoc: 60 })); }); // far away: Narvik
  await planner.ensureLegs();
  const before = planner.gapKm(store.trip.start, store.trip.stops[0]);
  const added = await planner.fillLeg({ gapIndex: 0, maxAdds: 1 });
  assert.equal(added, 1);
  assert.equal(store.trip.stops.length, 2);
  const inserted = store.trip.stops[0];
  assert.equal(store.trip.stops[1].name, 'Narvik', 'the far stop stays last');
  assert.ok(['Setermoen', 'Finnsnes'].includes(inserted.name), `middle site expected, got ${inserted.name}`);
  // both halves must be shorter than the original leg — that is what "in the middle" means
  const first = planner.gapKm(store.trip.start, inserted);
  const second = planner.gapKm(inserted, store.trip.stops[1]);
  assert.ok(first < before * 0.85 && second < before * 0.85, `${first} / ${second} vs ${before}`);
  const { stops } = compute(store.trip);
  stops.forEach(r => { assert.equal(r.leg.status, 'ok'); assert.ok(r.arrivalSoc >= 10); });
});

test('each run is bounded and repeated runs split the longest remaining stretch', async () => {
  const { store, planner } = setup();
  store.update(t => { t.stops.push(newStop({ site: SITES[3], targetSoc: 60 })); t.settings.fill.perRun = 1; });
  await planner.ensureLegs();
  assert.equal(await planner.fillLeg({ gapIndex: 0 }), 1, 'perRun caps a single click');
  const longestAfterOne = Math.max(planner.gapKm(store.trip.start, store.trip.stops[0]), planner.gapKm(store.trip.stops[0], store.trip.stops[1]));
  const again = await planner.fillLeg({ gapIndex: 0, maxAdds: 1 });
  if (again) {
    const nodes = [store.trip.start, ...store.trip.stops];
    const longest = Math.max(...nodes.slice(0, -1).map((n, i) => planner.gapKm(n, nodes[i + 1])));
    assert.ok(longest <= longestAfterOne + 0.01, 'the sparsest stretch got shorter, not the first one');
  }
});

test('fillLeg widens the detour budget only when nothing fits, and gives up cleanly', async () => {
  const { store, planner } = setup();
  store.update(t => { t.stops.push(newStop({ site: SITES[3], targetSoc: 60 })); });
  await planner.ensureLegs();
  store.update(t => { t.settings.fill = { startDetourKm: 0.2, maxDetourKm: 0.4, perRun: 2 }; });
  assert.equal(await planner.fillLeg({ gapIndex: 0 }), 0, 'nothing fits in a 0.4 km detour');
  assert.equal(store.trip.stops.length, 1, 'a failed attempt leaves the plan untouched');
  store.update(t => { t.settings.fill = { startDetourKm: 0.2, maxDetourKm: 80, perRun: 2 }; });
  assert.ok(await planner.fillLeg({ gapIndex: 0 }) >= 1, 'escalating the budget finds a site');
});

test('fillLeg honours the charge cap, the reserve and the destination gap', async () => {
  const { store, planner } = setup();
  store.update(t => { t.destination = { lat: 68.4385, lng: 17.4272, name: 'Narvik town' }; });
  await planner.ensureLegs();
  const added = await planner.fillLeg({ gapIndex: 0, maxAdds: 2 }); // start → destination
  assert.ok(added >= 1, 'the start → destination leg can be filled');
  const tl = compute(store.trip);
  assert.ok(tl.destination && tl.destination.leg.status === 'ok');
  tl.stops.forEach(r => assert.ok(r.arrivalSoc >= store.trip.settings.reserveSoc, `arrival ${r.arrivalSoc}`));
  store.trip.stops.forEach(st => assert.ok(!st.charge || st.charge.targetSoc <= store.trip.settings.maxChargeSoc));
  assert.equal(Object.keys(store.trip.legs).length, store.trip.stops.length + 1, 'legs pruned to the current chain');
});

test('fillLeg rejects an out-of-range gap index without touching the trip', async () => {
  const { store, planner } = setup();
  store.update(t => { t.stops.push(newStop({ site: SITES[0], targetSoc: 60 })); });
  await planner.ensureLegs();
  assert.equal(await planner.fillLeg({ gapIndex: 7 }), 0);
  assert.equal(await planner.fillLeg({}), 0);
  assert.equal(store.trip.stops.length, 1);
});

test('a leg beyond one charge is filled at the furthest REACHABLE point, not at the midpoint', async () => {
  const { store, planner } = setup();
  // Alta is ~350 km of (fake) road away; a small pack makes the midpoint unreachable
  store.update(t => {
    t.stops.push(newStop({ site: SITES[4], targetSoc: 60 }));
    t.car.usableKwh = 20;
    t.start.soc = 100;
    t.settings.fill = { startDetourKm: 40, maxDetourKm: 120, perRun: 1 };
  });
  await planner.ensureLegs();
  const before = compute(store.trip);
  const gap = planner.gapKm(store.trip.start, store.trip.stops[0]);
  assert.ok(before.stops[0].arrivalSoc < store.trip.settings.reserveSoc, 'precondition: Alta is out of reach');
  const added = await planner.fillLeg({ gapIndex: 0 });
  assert.ok(added >= 1, 'something was inserted');
  const after = compute(store.trip);
  const first = after.stops[0];
  assert.equal(first.stop.name, 'Skibotn', 'the reachable site near the start is used, not a midpoint site');
  assert.ok(planner.gapKm(store.trip.start, first.stop) < gap / 2, 'inserted well before the midpoint');
  assert.ok(first.arrivalSoc >= store.trip.settings.reserveSoc, `the first hop is now drivable (${first.arrivalSoc})`);
  assert.equal(after.stops.at(-1).stop.name, 'Alta', 'the chosen far stop is still last');
});

test('corridor search finds on-route sites and ranks by detour then proximity to the target', async () => {
  const { store, planner } = setup();
  store.update(t => { t.stops.push(newStop({ site: SITES[3], targetSoc: 60 })); });
  await planner.ensureLegs();
  const a = store.trip.start;
  const b = store.trip.stops[0];
  const samples = planner.routeSamples(a, b);
  assert.ok(samples.length >= 2 && samples[0].km === 0, 'samples start at the leg origin');
  assert.ok(samples.at(-1).km > 100, 'samples span the leg');
  const cands = await planner.corridorCandidates(a, b, { targetKm: planner.gapKm(a, b) / 2, corridorKm: 60, maxReachKm: 1e6 });
  assert.ok(cands.length >= 1);
  cands.forEach(c => { assert.ok(c.detourKm <= 60); assert.ok(Number.isFinite(c.fromAKm)); });
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1].score <= cands[i].score, 'ranked by score');
  const unreachable = await planner.corridorCandidates(a, b, { targetKm: planner.gapKm(a, b) / 2, corridorKm: 60, maxReachKm: 1 });
  assert.equal(unreachable.length, 0, 'sites beyond the remaining range are dropped');
});
