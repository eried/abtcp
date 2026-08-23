import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, bearingDeg, ferryIntervals, chunkRoute, packChunk, unpackChunk, routeLatLngs } from '../../app/model/geo.js';

test('haversine Tromsø→Skibotn ≈ 59 km', () => {
  const m = haversineM(69.6496, 18.9553, 69.3924, 20.2684);
  assert.ok(m > 57000 && m < 61000, `got ${m}`);
});

test('bearing north is 0, east is 90', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0)) < 0.01);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.01);
});

test('ferryIntervals merges contiguous ferry steps and tracks cumulative distance', () => {
  const steps = [
    { mode: 'driving', distance: 1000, duration: 60 },
    { mode: 'ferry', distance: 2000, duration: 900, name: 'A - B' },
    { mode: 'ferry', distance: 500, duration: 100, name: 'A - B' },
    { mode: 'driving', distance: 3000, duration: 120 },
    { mode: 'ferry', distance: 6000, duration: 1500, name: 'C - D' },
  ];
  const f = ferryIntervals(steps);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { start: 1000, end: 3500, seconds: 1000, name: 'A - B' });
  assert.deepEqual(f[1], { start: 6500, end: 12500, seconds: 1500, name: 'C - D' });
});

test('chunkRoute merges short segments to ≥ minLen and preserves total distance', () => {
  const coords = Array.from({ length: 11 }, (_, i) => [10 + i * 0.001, 60]);
  const ann = { distance: Array(10).fill(55.6), duration: Array(10).fill(2), speed: Array(10).fill(27.8) };
  const chunks = chunkRoute(coords, ann, [], 200);
  const total = chunks.reduce((s, c) => s + c.d, 0);
  assert.ok(Math.abs(total - 556) < 0.01);
  assert.ok(chunks.length >= 2);
  chunks.slice(0, -1).forEach(c => assert.ok(c.d >= 200));
  chunks.forEach(c => assert.ok(Math.abs(c.v - 27.8) < 0.01));
  assert.ok(Math.abs(chunks[0].brg - 90) < 1);
});

test('chunkRoute never mixes ferry and driving in one chunk', () => {
  const coords = Array.from({ length: 11 }, (_, i) => [10 + i * 0.001, 60]);
  const ann = { distance: Array(10).fill(100), duration: Array(10).fill(4) };
  const ferries = [{ start: 300, end: 600, seconds: 900, name: 'f' }];
  const chunks = chunkRoute(coords, ann, ferries, 1000);
  assert.deepEqual(chunks.map(c => [c.mode, c.d]), [[0, 300], [1, 300], [0, 400]]);
});

test('chunkRoute caps speed artefacts from 0.1 s rounding', () => {
  const coords = [[10, 60], [10.001, 60]];
  const ann = { distance: [55.6], duration: [0.1] };
  const [c] = chunkRoute(coords, ann, [], 10);
  assert.ok(c.v <= 40.01);
});

test('pack/unpack round-trips a chunk and routeLatLngs includes the last point', () => {
  const c = { d: 512.4, t: 20.04, v: 25.57, mode: 0, brg: 91, lat0: 60.123456, lng0: 10.123456, elev0: 12.4 };
  const p = packChunk(c);
  const u = unpackChunk(p, [60.2, 10.2, 30]);
  assert.equal(u.d, 512); assert.equal(u.t, 20); assert.equal(u.v, 25.57); assert.equal(u.elev0, 12);
  assert.equal(u.lat1, 60.2); assert.equal(u.elev1, 30);
  const pts = routeLatLngs({ chunks: [p], last: [60.2, 10.2, 30] });
  assert.deepEqual(pts, [[60.12346, 10.12346], [60.2, 10.2]]);
});
