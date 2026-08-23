import test from 'node:test';
import assert from 'node:assert/strict';
import { compute, legKey, legTimeH, evalLeg } from '../../app/model/timeline.js';
import { defaultTrip, newStop } from '../../app/state.js';
import { profileById } from '../../app/model/profiles.js';

const H = 3600e3;
const SITE = (id, lat, lng, kw = 250) => ({ id, tid: `t${id}`, name: `Site ${id}`, lat, lng, kw, stalls: 8, status: 'OPEN', country: 'Norway' });

/** A synthetic OK leg: `km` at 100 km/h expected speed, flat, 15 °C. */
function mkLeg(from, to, km, { elev0 = 0, elev1 = 0, tempC = 15, ferryKm = 0 } = {}) {
  const chunks = [[km * 1000, km * 36, 27.78, 0, 0, from.lat, from.lng, elev0]];
  if (ferryKm) chunks.push([ferryKm * 1000, ferryKm * 200, 5, 1, 0, from.lat, from.lng, elev1]);
  return {
    status: 'ok',
    route: { km: km + ferryKm, osrmH: km / 100, chunks, last: [to.lat, to.lng, elev1], ferries: ferryKm ? [{ km: ferryKm, h: ferryKm * 200 / 3600, name: 'Test ferry' }] : [] },
    weather: { tempC, windKmh: 0, windFromDeg: 0, precipMm: 0, source: 'test' },
    computedAt: '2026-01-01T00:00:00Z',
  };
}

function trip({ stops, legs, start = {}, settings = {} }) {
  const t = defaultTrip(new Date(2026, 8, 1, 0, 0));
  t.start = { ...t.start, time: '2026-09-01T08:00', soc: 90, ...start };
  t.profile = { ...profileById('limit') };
  Object.assign(t.settings, settings);
  t.stops = stops;
  let prev = t.start;
  for (const [i, s] of stops.entries()) {
    const spec = legs[i];
    if (spec) t.legs[legKey(prev, s)] = mkLeg(prev, s, spec.km, spec);
    prev = s;
  }
  return t;
}

const A = SITE(1, 69.4, 20.3), B = SITE(2, 68.9, 18.6, 150), C = SITE(3, 68.4, 17.4);

test('two 100 km hops: realistic arrival SoC, sessions counted, streak of 2', () => {
  const t = trip({ stops: [newStop({ site: A, targetSoc: 80 }), newStop({ site: B, targetSoc: 80 })], legs: [{ km: 100 }, { km: 100 }] });
  const { stops, summary } = compute(t);
  assert.equal(stops[0].leg.status, 'ok');
  assert.ok(stops[0].arrivalSoc > 60 && stops[0].arrivalSoc < 75, `arrival ${stops[0].arrivalSoc}`);
  assert.equal(stops[0].session.counted, true);
  assert.equal(stops[0].session.deadline, null);
  assert.ok(stops[0].session.chargeMin > 3 && stops[0].session.chargeMin < 15);
  assert.equal(stops[0].departSoc, 80);
  // arrival = 08:00 + 1 h driving * (1 + 5/60) breaks
  assert.ok(Math.abs(stops[0].arrival - (Date.parse('2026-09-01T08:00') + 65 * 60e3)) < 1000);
  assert.equal(stops[1].session.isNew, true);
  assert.ok(stops[1].session.sinceLastH > 1 && stops[1].session.sinceLastH < 2);
  assert.ok(stops[1].session.deadlineInH > 22 && stops[1].session.deadlineInH < 23);
  assert.equal(summary.uniqueCounted, 2);
  assert.equal(summary.longestStreak, 2);
  assert.equal(summary.currentStreak, 2);
  assert.equal(summary.firstBreakIndex, -1);
  assert.equal(summary.newForYear, 2);
  assert.equal(summary.totalKm, 200);
  assert.ok(summary.kwhBilled > 15);
  assert.equal(summary.pendingLegs, 0);
  assert.equal(stops[0].minUsefulSoc, Math.ceil(stops[1].leg.kwh / 75 * 100 + 10));
  assert.equal(stops[1].minUsefulSoc, null);
  assert.ok(summary.nextDeadline === stops[1].session.start + 24 * H);
});

test('repeat visit does not count, does not reset the timer', () => {
  const t = trip({ stops: [newStop({ site: A, targetSoc: 80 }), newStop({ site: A, targetSoc: 85 }), newStop({ site: B, targetSoc: 80 })], legs: [{ km: 100 }, { km: 50 }, { km: 100 }] });
  const { stops, summary } = compute(t);
  assert.equal(stops[1].session.isNew, false);
  assert.equal(stops[1].session.counted, false);
  assert.equal(summary.uniqueCounted, 2);
  assert.ok(Math.abs(stops[2].session.sinceLastH - (stops[2].session.start - stops[0].session.start) / H) < 1e-9);
  assert.ok(stops[1].warnings.some(w => /Repeat site/.test(w.msg)));
});

test('a 30 h rest breaks the streak; a 10 h rest does not', () => {
  const mk = hours => {
    const a = newStop({ site: A, targetSoc: 80 }); a.rest = { hours, sentry: true };
    return trip({ stops: [a, newStop({ site: B, targetSoc: 80 })], legs: [{ km: 100 }, { km: 100 }] });
  };
  const ok = compute(mk(10));
  assert.equal(ok.stops[1].session.broken, false);
  assert.ok(ok.stops[0].rest.drainPct > 1.9 && ok.stops[0].rest.drainPct < 2.1);
  assert.ok(Math.abs(ok.stops[0].departSoc - (80 - ok.stops[0].rest.drainPct)) < 1e-9);
  const bad = compute(mk(30));
  assert.equal(bad.stops[1].session.broken, true);
  assert.equal(bad.summary.firstBreakIndex, 1);
  assert.equal(bad.summary.longestStreak, 1);
  assert.equal(bad.summary.currentStreak, 1);
  assert.equal(bad.summary.uniqueCounted, 2);
  assert.ok(bad.stops[1].warnings.some(w => w.level === 'error' && /Streak broken/.test(w.msg)));
  assert.ok(bad.summary.warnings.some(w => w.i === 1 && w.level === 'error'));
});

test('anchor "end" extends the deadline by the previous charge duration; window 48 h fixes a 30 h rest', () => {
  const build = (settings) => {
    const a = newStop({ site: A, targetSoc: 80 }); a.rest = { hours: 30, sentry: false };
    return trip({ stops: [a, newStop({ site: B, targetSoc: 80 })], legs: [{ km: 100 }, { km: 100 }], settings });
  };
  const byStart = compute(build({ rules: { windowH: 24, anchor: 'start', marginMin: 60, minSessionMin: 5, minSessionKwh: 1 } }));
  const byEnd = compute(build({ rules: { windowH: 24, anchor: 'end', marginMin: 60, minSessionMin: 5, minSessionKwh: 1 } }));
  const diffH = (byEnd.stops[1].session.deadline - byStart.stops[1].session.deadline) / H;
  assert.ok(Math.abs(diffH - byStart.stops[0].session.chargeMin / 60) < 1e-9);
  const wide = compute(build({ rules: { windowH: 48, anchor: 'start', marginMin: 60, minSessionMin: 5, minSessionKwh: 1 } }));
  assert.equal(wide.stops[1].session.broken, false);
  assert.equal(wide.summary.longestStreak, 2);
});

test('missing and failed legs are reported without breaking the walk', () => {
  const t = trip({ stops: [newStop({ site: A, targetSoc: 80 }), newStop({ site: B, targetSoc: 80 })], legs: [{ km: 100 }] });
  t.legs[legKey(A, B)] = { status: 'failed', error: 'NoRoute' };
  const { stops, summary } = compute(t);
  assert.equal(stops[1].leg.status, 'failed');
  assert.equal(summary.failedLegs, 1);
  assert.ok(stops[1].warnings.some(w => /Route failed: NoRoute/.test(w.msg)));
  delete t.legs[legKey(A, B)];
  const r2 = compute(t);
  assert.equal(r2.stops[1].leg.status, 'pending');
  assert.equal(r2.summary.pendingLegs, 1);
  assert.equal(r2.stops[1].arrival, r2.stops[0].depart);
});

test('reserve and unreachable warnings', () => {
  const t = trip({ stops: [newStop({ site: A, targetSoc: 30 }), newStop({ site: B, targetSoc: 80 })], legs: [{ km: 380 }, { km: 100 }], start: { soc: 90 } });
  const { stops } = compute(t);
  assert.ok(stops[0].arrivalSoc < 10 && stops[0].arrivalSoc > 0, `arrival ${stops[0].arrivalSoc}`);
  assert.ok(stops[0].warnings.some(w => w.level === 'warn' && /below reserve/.test(w.msg)));
  const t2 = trip({ stops: [newStop({ site: A, targetSoc: 80 })], legs: [{ km: 600 }] });
  const r2 = compute(t2);
  assert.ok(r2.stops[0].arrivalSoc < 0);
  assert.ok(r2.stops[0].warnings.some(w => w.level === 'error' && /Unreachable/.test(w.msg)));
  assert.equal(r2.stops[0].session.targetSoc, 80);
});

test('point stop with AC charge during a rest adds energy, no session counted, no extra time', () => {
  const hotel = newStop({ lat: 68.9, lng: 18.6, name: 'Hotel' });
  hotel.charge = { targetSoc: 90, kw: 11 };
  hotel.rest = { hours: 9, sentry: false };
  const t = trip({ stops: [newStop({ site: A, targetSoc: 60 }), hotel, newStop({ site: B, targetSoc: 70 })], legs: [{ km: 100 }, { km: 100 }, { km: 100 }] });
  const { stops, summary } = compute(t);
  assert.equal(stops[1].session.ac, true);
  assert.equal(stops[1].session.counted, false);
  assert.equal(summary.uniqueCounted, 2);
  assert.ok(Math.abs(stops[1].depart - (stops[1].arrival + 9 * H)) < 1000, 'charging overlaps the rest');
  assert.ok(stops[1].departSoc > 89 && stops[1].departSoc <= 90);
  assert.equal(summary.kwhBilled, stops[0].session.kwhBilled + stops[2].session.kwhBilled);
});

test('ferry legs add wait time and cold weather raises consumption', () => {
  const warm = trip({ stops: [newStop({ site: A, targetSoc: 80 })], legs: [{ km: 100, tempC: 20 }] });
  const cold = trip({ stops: [newStop({ site: A, targetSoc: 80 })], legs: [{ km: 100, tempC: -5 }] });
  const ferry = trip({ stops: [newStop({ site: A, targetSoc: 80 })], legs: [{ km: 100, tempC: 20, ferryKm: 5 }] });
  const w = compute(warm), c = compute(cold), f = compute(ferry);
  assert.ok(c.stops[0].arrivalSoc < w.stops[0].arrivalSoc - 3);
  assert.equal(f.stops[0].leg.ferries, 1);
  assert.ok(f.stops[0].arrival - w.stops[0].arrival > 30 * 60e3);
  assert.deepEqual(f.stops[0].leg.ferryNames, ['Test ferry']);
});

test('weather override replaces stored leg weather; legTimeH adds breaks', () => {
  const t = trip({ stops: [newStop({ site: A, targetSoc: 80 })], legs: [{ km: 100, tempC: 20 }], settings: { weatherOverride: { enabled: true, tempC: -10, windKmh: 20, windFromDeg: 0, precipMm: 0 } } });
  const leg = evalLeg(t.legs[legKey(t.start, t.stops[0])], t);
  assert.equal(leg.temp, -10);
  assert.equal(leg.weatherSrc, 'override');
  assert.ok(Math.abs(legTimeH({ driveH: 2, ferryH: 0.5 }, { breakMinPerH: 6 }) - 2.7) < 1e-9);
});

test('visitedBefore reduces newForYear but not the streak', () => {
  const t = trip({ stops: [newStop({ site: A, targetSoc: 80 }), newStop({ site: B, targetSoc: 80 })], legs: [{ km: 100 }, { km: 100 }] });
  t.visitedBefore = [A.id];
  const { summary } = compute(t);
  assert.equal(summary.uniqueCounted, 2);
  assert.equal(summary.longestStreak, 2);
  assert.equal(summary.newForYear, 1);
});

test('minSessionPct forces a real session when arriving above the target', () => {
  const t = trip({ stops: [newStop({ site: A, targetSoc: 30 }), newStop({ site: B, targetSoc: 30 })], legs: [{ km: 60 }, { km: 60 }] });
  const { stops } = compute(t);
  assert.ok(stops[0].arrivalSoc > 70);
  assert.ok(Math.abs(stops[0].session.targetSoc - (stops[0].arrivalSoc + 8)) < 1e-9);
  assert.ok(Math.abs(stops[0].session.kwhStored - 6) < 1e-9);
  assert.equal(stops[0].session.belowMin, false);
  t.settings.rules.minSessionPct = 0;
  const r2 = compute(t);
  assert.equal(r2.stops[0].session.kwhStored, 0);
  assert.equal(r2.stops[0].session.belowMin, true);
});

test('smoothElevations removes single-sample spikes and keeps real climbs', async () => {
  const { smoothElevations } = await import('../../app/model/timeline.js');
  const flat = Array(40).fill(10); flat[10] = 90; flat[25] = 120;
  const sm = smoothElevations(flat, 2);
  let gain = 0; for (let i = 1; i < sm.length; i++) gain += Math.max(0, sm[i] - sm[i - 1]);
  assert.ok(gain < 5, `gain ${gain}`);
  const climb = Array.from({ length: 40 }, (_, i) => i * 10);
  const sc = smoothElevations(climb, 2);
  assert.ok(Math.abs(sc[sc.length - 1] - sc[0] - 370) < 15);
});
