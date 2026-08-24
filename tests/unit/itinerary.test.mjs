import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvents } from '../../app/ui/itinerary.js';
import { compute, legKey } from '../../app/model/timeline.js';
import { defaultTrip, newStop } from '../../app/state.js';
import { profileById } from '../../app/model/profiles.js';

const SITE = (id, lat, lng) => ({ id, tid: `t${id}`, name: `Site ${id}`, lat, lng, kw: 250, stalls: 8, status: 'OPEN', country: 'Norway' });
const mkLeg = (from, to, km) => ({
  status: 'ok',
  route: { km, osrmH: km / 100, chunks: [[km * 1000, km * 36, 27.78, 0, 0, from.lat, from.lng, 0]], last: [to.lat, to.lng, 0], ferries: [] },
  weather: { tempC: 15, windKmh: 0, windFromDeg: 0, precipMm: 0, source: 'test' },
});

test('buildEvents produces ordered, non-overlapping drive/charge/rest blocks and the final leg', () => {
  const t = defaultTrip(new Date(2026, 8, 1));
  t.start = { ...t.start, time: '2026-09-01T08:00', soc: 90 };
  t.profile = { ...profileById('limit') };
  const A = SITE(1, 69.4, 20.3);
  const B = SITE(2, 68.9, 18.6);
  const a = newStop({ site: A, targetSoc: 80 });
  a.rest = { hours: 10, sentry: true };
  const b = newStop({ site: B, targetSoc: 80 });
  t.stops = [a, b];
  t.destination = { lat: 68.4, lng: 17.4, name: 'Home' };
  t.legs[legKey(t.start, a)] = mkLeg(t.start, a, 100);
  t.legs[legKey(a, b)] = mkLeg(a, b, 100);
  t.legs[legKey(b, t.destination)] = mkLeg(b, t.destination, 80);
  const tl = compute(t);
  const ev = buildEvents(tl, t);
  const kinds = ev.map(e => e.kind);
  assert.deepEqual(kinds, ['drive', 'charge', 'rest', 'drive', 'charge', 'drive']);
  for (const e of ev) assert.ok(e.to > e.from, `${e.kind} has duration`);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].from >= ev[i - 1].from, 'sorted by start');
  const rest = ev.find(e => e.kind === 'rest');
  assert.ok(Math.abs((rest.to - rest.from) / 36e5 - 10) < 1e-9);
  assert.ok(ev[ev.length - 1].label.includes('Home'));
  assert.equal(ev[ev.length - 1].i, -1);
  const empty = buildEvents(compute(defaultTrip(new Date(2026, 8, 1))), defaultTrip(new Date(2026, 8, 1)));
  assert.deepEqual(empty, []);
});
