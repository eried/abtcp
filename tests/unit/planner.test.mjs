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

test('autoChain appends stops with ok legs toward the destination and stops near it', async () => {
  const { store, planner } = setup();
  store.update(t => { t.destination = { lat: 68.4385, lng: 17.4272, name: 'Narvik' }; });
  const progress = [];
  const added = await planner.autoChain({ n: 5, targetSoc: 60, onProgress: (a, n, stop) => progress.push(stop.name) });
  assert.ok(added >= 2, `added ${added}`);
  assert.deepEqual(progress, store.trip.stops.map(s => s.name));
  const { stops, summary } = compute(store.trip);
  stops.forEach(r => assert.equal(r.leg.status, 'ok'));
  stops.forEach(r => assert.ok(r.arrivalSoc >= 10));
  assert.equal(summary.uniqueCounted, added);
  assert.equal(stops.at(-1).stop.name, 'Narvik');
  assert.equal(Object.keys(store.trip.legs).length, stops.length, 'pruned legs');
});

test('autoChain raises the previous target when a hop needs more charge', async () => {
  const { store, planner } = setup();
  store.update(t => { t.start.soc = 40; t.destination = { lat: 69.9689, lng: 23.2717, name: 'Alta' }; });
  const added = await planner.autoChain({ n: 2, targetSoc: 20, toward: true });
  assert.ok(added >= 1);
  const { stops } = compute(store.trip);
  if (stops.length > 1) assert.ok(stops[0].stop.charge.targetSoc > 20, 'target raised adaptively');
  stops.forEach(r => assert.ok(r.arrivalSoc >= 10, `arrival ${r.arrivalSoc}`));
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
