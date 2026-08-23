import test from 'node:test';
import assert from 'node:assert/strict';
import { curveKw, chargeSession, restDrainPctPerH, socAfterRest } from '../../app/model/charging.js';
import { CARS } from '../../app/model/cars.js';

const CAR = CARS[0];
const SENTRY = { onPctH: 0.2, offPctH: 0.04, coldFactor: 1.3 };

test('curve interpolates and clamps', () => {
  assert.equal(curveKw(CAR, 10), 250);
  assert.equal(curveKw(CAR, 25), 227.5);
  assert.equal(curveKw(CAR, 100), 15);
  assert.equal(curveKw(CAR, 150), 15);
  assert.equal(curveKw(CAR, -5), 120);
});

test('10→50 % at a 250 kW site takes ~9–13 min incl. overhead, 30 kWh stored', () => {
  const r = chargeSession({ car: CAR, siteKw: 250, fromSoc: 10, toSoc: 50 });
  assert.ok(r.minutes > 9 && r.minutes < 13, `minutes ${r.minutes}`);
  assert.ok(Math.abs(r.kwhStored - 30) < 1e-9);
  assert.ok(Math.abs(r.kwhBilled - 30 / 0.94) < 1e-9);
  assert.ok(r.avgKw > 150 && r.avgKw < 250);
});

test('a 150 kW site is slower than a 250 kW site; unknown power uses the car max', () => {
  const fast = chargeSession({ car: CAR, siteKw: 250, fromSoc: 10, toSoc: 50 });
  const slow = chargeSession({ car: CAR, siteKw: 150, fromSoc: 10, toSoc: 50 });
  const unknown = chargeSession({ car: CAR, siteKw: 0, fromSoc: 10, toSoc: 50 });
  assert.ok(slow.minutes > fast.minutes + 2);
  assert.equal(unknown.minutes, fast.minutes);
});

test('no charge when target ≤ arrival', () => {
  const r = chargeSession({ car: CAR, siteKw: 250, fromSoc: 60, toSoc: 50 });
  assert.deepEqual(r, { minutes: 0, chargeMin: 0, kwhStored: 0, kwhBilled: 0, avgKw: 0 });
});

test('cold start adds at least 2 minutes', () => {
  const warm = chargeSession({ car: CAR, siteKw: 250, fromSoc: 10, toSoc: 50 });
  const cold = chargeSession({ car: CAR, siteKw: 250, fromSoc: 10, toSoc: 50, coldStart: true });
  assert.ok(cold.minutes > warm.minutes + 2);
});

test('AC charging at 11 kW ignores the DC curve', () => {
  const r = chargeSession({ car: CAR, siteKw: 0, fromSoc: 20, toSoc: 80, acKw: 11, overheadMin: 0 });
  assert.ok(Math.abs(r.minutes - (45 / 11) * 60) < 1e-6);
});

test('rest drain rates and SoC after rest', () => {
  assert.equal(restDrainPctPerH(true, 10, SENTRY), 0.2);
  assert.ok(Math.abs(restDrainPctPerH(true, -5, SENTRY) - 0.26) < 1e-9);
  assert.equal(restDrainPctPerH(false, 10, SENTRY), 0.04);
  assert.equal(socAfterRest(50, 10, true, 10, SENTRY), 48);
  assert.equal(socAfterRest(1, 100, true, 10, SENTRY), 0);
});
