import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, getJson } from '../../app/services/http.js';
import { routeUrl, tableUrl, createOsrm } from '../../app/services/osrm.js';
import { createElevation, elevationUrl } from '../../app/services/elevation.js';
import { weatherAt, pickSource, weatherUrl } from '../../app/services/weather.js';
import { geocode } from '../../app/services/geocode.js';

/** fake fetch: handler(url) → { status, json } */
const fakeFetch = handler => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const r = await handler(url);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  f.calls = calls;
  return f;
};

test('queue never exceeds maxConcurrent and resolves everything', async () => {
  const q = createQueue({ maxConcurrent: 2, spacingMs: 0 });
  let running = 0, peak = 0;
  const job = () => new Promise(res => { running++; peak = Math.max(peak, running); setTimeout(() => { running--; res('ok'); }, 10); });
  const results = await Promise.all(Array.from({ length: 6 }, () => q.run(job)));
  assert.deepEqual(results, Array(6).fill('ok'));
  assert.equal(peak, 2);
  await assert.rejects(q.run(() => { throw new Error('boom'); }), /boom/);
});

test('getJson retries on 500 once, not on 404, and returns okStatuses bodies', async () => {
  let n = 0;
  const flaky = fakeFetch(() => (++n === 1 ? { status: 500, json: {} } : { json: { fine: true } }));
  assert.deepEqual(await getJson('https://x.test/a', { fetchImpl: flaky }), { fine: true });
  assert.equal(flaky.calls.length, 2);
  const nf = fakeFetch(() => ({ status: 404, json: {} }));
  await assert.rejects(getJson('https://x.test/a', { fetchImpl: nf }), /HTTP 404/);
  assert.equal(nf.calls.length, 1);
  const bad = fakeFetch(() => ({ status: 400, json: { code: 'NoRoute' } }));
  assert.deepEqual(await getJson('https://x.test/a', { fetchImpl: bad, okStatuses: [400] }), { code: 'NoRoute' });
});

test('OSRM urls are exact and 6-decimal', () => {
  assert.equal(routeUrl('https://r.test/', { lat: 69.6496, lng: 18.9553 }, { lat: 69.3924, lng: 20.2684 }),
    'https://r.test/route/v1/driving/18.955300,69.649600;20.268400,69.392400?overview=full&geometries=geojson&steps=true&annotations=true');
  assert.equal(tableUrl('https://r.test', { lat: 1, lng: 2 }, [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }]),
    'https://r.test/table/v1/driving/2.000000,1.000000;4.000000,3.000000;6.000000,5.000000?sources=0&destinations=1;2&annotations=distance,duration');
});

test('OSRM route returns the first route and throws on NoRoute; table passes nulls', async () => {
  const f = fakeFetch(url => url.includes('/route/') ? { json: { code: 'Ok', routes: [{ distance: 1000, duration: 60, geometry: { coordinates: [] }, legs: [] }] } } : { json: { code: 'Ok', distances: [[100, null, 300]], durations: [[10, null, 30]] } });
  const osrm = createOsrm({ baseUrl: 'https://r.test', fetchImpl: f, queue: createQueue({ spacingMs: 0 }) });
  const r = await osrm.route({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });
  assert.equal(r.distance, 1000);
  const t = await osrm.table({ lat: 1, lng: 2 }, [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }, { lat: 7, lng: 8 }]);
  assert.deepEqual(t.distances, [100, null, 300]);
  assert.deepEqual(await osrm.table({ lat: 1, lng: 2 }, []), { distances: [], durations: [] });
  const nr = createOsrm({ baseUrl: 'https://r.test', fetchImpl: fakeFetch(() => ({ status: 400, json: { code: 'NoRoute', message: 'Impossible route.' } })), queue: createQueue({ spacingMs: 0 }) });
  await assert.rejects(nr.route({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }), /OSRM NoRoute: Impossible route/);
});

test('elevation batches 250 points into 3 calls, caches, keeps order', async () => {
  const f = fakeFetch(url => {
    const lats = new URL(url).searchParams.get('latitude').split(',');
    return { json: { elevation: lats.map(l => Math.round(+l * 10)) } };
  });
  const el = createElevation({ fetchImpl: f, batch: 100 });
  const pts = Array.from({ length: 250 }, (_, i) => ({ lat: 60 + i * 0.01, lng: 10 }));
  const res = await el.sample(pts);
  assert.equal(f.calls.length, 3);
  assert.equal(res.length, 250);
  assert.equal(res[0], 600);
  assert.equal(res[249], Math.round((60 + 249 * 0.01) * 10));
  await el.sample(pts.slice(0, 50));
  assert.equal(f.calls.length, 3);
  assert.equal(el.calls, 3);
  assert.ok(elevationUrl([{ lat: 60.123456, lng: 10.1 }]).endsWith('latitude=60.12346&longitude=10.10000'));
  const broken = createElevation({ fetchImpl: fakeFetch(() => ({ json: { elevation: [1] } })) });
  await assert.rejects(broken.sample([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]), /unexpected data/);
});

test('weather picks forecast vs archive and handles override/default', async () => {
  const now = Date.parse('2026-08-24T12:00:00Z');
  const soon = now + 3 * 864e5;
  const far = now + 60 * 864e5;
  assert.equal(pickSource(soon, now).archive, false);
  const p = pickSource(far, now);
  assert.equal(p.archive, true);
  assert.ok(p.date.startsWith('2025-10-'), p.date);
  assert.ok(weatherUrl({ lat: 60, lng: 10, date: '2026-08-27' }).startsWith('https://api.open-meteo.com/v1/forecast?latitude=60.0000&longitude=10.0000&hourly='));
  assert.ok(weatherUrl({ lat: 60, lng: 10, date: '2025-10-23', archive: true }).startsWith('https://archive-api.open-meteo.com/v1/archive?'));
  const hourly = { time: Array.from({ length: 24 }, (_, h) => `2026-08-27T${String(h).padStart(2, '0')}:00`), temperature_2m: Array.from({ length: 24 }, (_, h) => h), wind_speed_10m: Array(24).fill(12), wind_direction_10m: Array(24).fill(200), precipitation: Array(24).fill(0.3) };
  const f = fakeFetch(() => ({ json: { hourly } }));
  const t = new Date(2026, 7, 27, 14, 0).getTime();
  const w = await weatherAt({ lat: 60, lng: 10, time: t, fetchImpl: f, now: new Date(2026, 7, 24, 12).getTime() });
  assert.deepEqual([w.tempC, w.windKmh, w.windFromDeg, w.precipMm, w.source], [14, 12, 200, 0.3, 'forecast']);
  const o = await weatherAt({ lat: 60, lng: 10, time: t, override: { enabled: true, tempC: -3, windKmh: 5, windFromDeg: 90 }, fetchImpl: f });
  assert.deepEqual([o.tempC, o.source], [-3, 'override']);
  const d = await weatherAt({ lat: 60, lng: 10, time: t, fetchImpl: fakeFetch(() => ({ status: 500, json: {} })) });
  assert.deepEqual([d.tempC, d.source], [10, 'default']);
  assert.ok(d.error);
});

test('geocode uses Photon and falls back to Nominatim', async () => {
  const photon = fakeFetch(url => url.includes('photon') ? { json: { features: [{ geometry: { coordinates: [18.95, 69.65] }, properties: { name: 'Tromsø', country: 'Norway' } }] } } : { json: [] });
  const r = await geocode('Tromsø', { fetchImpl: photon });
  assert.deepEqual(r, [{ name: 'Tromsø, Norway', lat: 69.65, lng: 18.95 }]);
  const fallback = fakeFetch(url => url.includes('photon') ? { status: 503, json: {} } : { json: [{ display_name: 'Tromsø, Troms, Norway', lat: '69.65', lon: '18.95' }] });
  const r2 = await geocode('Tromsø', { fetchImpl: fallback });
  assert.deepEqual(r2, [{ name: 'Tromsø, Troms, Norway', lat: 69.65, lng: 18.95 }]);
  assert.deepEqual(await geocode('   ', { fetchImpl: photon }), []);
});
