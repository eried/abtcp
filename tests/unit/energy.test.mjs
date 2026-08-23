import test from 'node:test';
import assert from 'node:assert/strict';
import { legEnergy, chunkEnergy, airDensity, auxPowerKw, drivingSpeedMs, quickWhKm } from '../../app/model/energy.js';
import { CARS } from '../../app/model/cars.js';
import { PROFILES, profileById } from '../../app/model/profiles.js';

const CAR = CARS[0];
const LIMIT = profileById('limit');
const PLUS5 = profileById('plus5');
const S = { marginPct: 5, ferryWaitMin: 30, sentry: { onPctH: 0.2, offPctH: 0.04, coldFactor: 1.3 } };
const flat = (vKmh, elev1 = 0, brg = 0) => [{ d: 10000, t: 10000 / (vKmh / 3.6), v: vKmh / 3.6, mode: 0, brg, elev0: 0, elev1 }];
const wx = (tempC, windKmh = 0, windFromDeg = 0, precipMm = 0) => ({ tempC, windKmh, windFromDeg, precipMm });

test('air density and aux power basics', () => {
  assert.ok(Math.abs(airDensity(20) - 1.204) < 0.005);
  assert.ok(airDensity(-10) > airDensity(20));
  assert.ok(Math.abs(auxPowerKw(20) - 0.35) < 1e-9);
  assert.ok(auxPowerKw(0) > 2 && auxPowerKw(0) < 2.5);
  assert.ok(auxPowerKw(32) > auxPowerKw(20));
});

test('120 km/h at 20°C ≈ 180–200 Wh/km', () => {
  const r = legEnergy(flat(120), wx(20), CAR, LIMIT, S);
  assert.ok(r.whKm > 180 && r.whKm < 200, `got ${r.whKm}`);
  assert.ok(Math.abs(r.driveH - 10 / 120) < 1e-6);
  assert.equal(r.km, 10);
});

test('90 km/h at 20°C ≈ 130–150 Wh/km', () => {
  const r = legEnergy(flat(90), wx(20), CAR, LIMIT, S);
  assert.ok(r.whKm > 130 && r.whKm < 150, `got ${r.whKm}`);
});

test('120 km/h at 0°C ≈ 215–245 Wh/km', () => {
  const r = legEnergy(flat(120), wx(0), CAR, LIMIT, S);
  assert.ok(r.whKm > 215 && r.whKm < 245, `got ${r.whKm}`);
});

test('headwind increases consumption, tailwind decreases it', () => {
  const calm = legEnergy(flat(100), wx(15), CAR, LIMIT, S).kwh;
  const head = legEnergy(flat(100, 0, 0), wx(15, 30, 0), CAR, LIMIT, S).kwh;
  const tail = legEnergy(flat(100, 0, 0), wx(15, 30, 180), CAR, LIMIT, S).kwh;
  assert.ok(head > calm && tail < calm, `${head} ${calm} ${tail}`);
});

test('rain adds rolling resistance', () => {
  const dry = legEnergy(flat(100), wx(15), CAR, LIMIT, S).kwh;
  const wet = legEnergy(flat(100, 0, 0), wx(15, 0, 0, 2), CAR, LIMIT, S).kwh;
  assert.ok(wet > dry);
});

test('climb costs more than the descent recovers', () => {
  const flatKwh = legEnergy(flat(100), wx(15), CAR, LIMIT, S).kwh;
  const up = legEnergy(flat(100, 500), wx(15), CAR, LIMIT, S);
  const down = legEnergy(flat(100, -500), wx(15), CAR, LIMIT, S);
  assert.ok(up.kwh > flatKwh);
  assert.ok(down.kwh < flatKwh);
  assert.ok(up.kwh + down.kwh > 2 * flatKwh);
  assert.equal(up.gainM, 500);
  assert.equal(down.lossM, 500);
});

test('ferry chunk consumes ~0 and adds wait time once per crossing', () => {
  const chunks = [
    { d: 2500, t: 450, v: 5.5, mode: 1, brg: 0, elev0: 0, elev1: 0 },
    { d: 2500, t: 450, v: 5.5, mode: 1, brg: 0, elev0: 0, elev1: 0 },
  ];
  const r = legEnergy(chunks, wx(10), CAR, LIMIT, S);
  assert.ok(r.kwh < 0.05, `got ${r.kwh}`);
  assert.equal(r.ferries, 1);
  assert.ok(Math.abs(r.ferryH - (900 / 3600 + 0.5)) < 1e-9);
  assert.equal(r.driveH, 0);
});

test('profile offset applies only at or above 60 km/h and is capped by maxKmh', () => {
  assert.ok(Math.abs(drivingSpeedMs(50 / 3.6, PLUS5) * 3.6 - 50) < 1e-9);
  assert.ok(Math.abs(drivingSpeedMs(100 / 3.6, PLUS5) * 3.6 - 105) < 1e-9);
  assert.ok(Math.abs(drivingSpeedMs(140 / 3.6, PLUS5) * 3.6 - 135) < 1e-9);
  const slow = chunkEnergy(flat(100)[0], wx(15), CAR, LIMIT, S);
  const fast = chunkEnergy(flat(100)[0], wx(15), CAR, PLUS5, S);
  assert.ok(fast.seconds < slow.seconds && fast.kwh > slow.kwh);
});

test('margin scales positive consumption only', () => {
  const a = legEnergy(flat(100), wx(15), CAR, LIMIT, { ...S, marginPct: 0 }).kwh;
  const b = legEnergy(flat(100), wx(15), CAR, LIMIT, { ...S, marginPct: 10 }).kwh;
  assert.ok(Math.abs(b / a - 1.10) < 1e-9);
  const down0 = legEnergy(flat(60, -1000), wx(15), CAR, LIMIT, { ...S, marginPct: 0 }).kwh;
  const down10 = legEnergy(flat(60, -1000), wx(15), CAR, LIMIT, { ...S, marginPct: 10 }).kwh;
  assert.ok(down0 < 0 && down0 === down10);
});

test('quickWhKm rises in the cold and every preset profile is well-formed', () => {
  assert.ok(quickWhKm(CAR, 0) > quickWhKm(CAR, 20));
  assert.equal(quickWhKm(CAR, 20), CAR.refWhKm);
  for (const p of PROFILES) assert.ok(p.id && p.name && p.maxKmh > 60);
});
