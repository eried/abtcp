// Walks the trip's stops and produces times, state of charge, charging sessions, the contest
// streak status and summary counters. Pure: depends only on the trip document.
import { legEnergy } from './energy.js';
import { chargeSession, restDrainPctPerH } from './charging.js';
import { unpackChunk } from './geo.js';

const H = 3600e3;
const MIN = 60e3;
const USABLE = new Set(['OPEN', 'EXPANDING']);

export function legKey(a, b) {
  return `${(+a.lat).toFixed(5)},${(+a.lng).toFixed(5)}>${(+b.lat).toFixed(5)},${(+b.lng).toFixed(5)}`;
}

/** Median-then-mean filter over a window of 2·radius+1 samples: removes DEM spikes on fjord/cliff roads. */
export function smoothElevations(z, radius = 2) {
  const n = z.length;
  if (n < 3) return z.slice();
  const med = new Array(n);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) w.push(z[j]);
    w.sort((a, b) => a - b);
    med[i] = w[Math.floor(w.length / 2)];
  }
  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) { sum += med[j]; c++; }
    out[i] = sum / c;
  }
  return out;
}

export function legChunks(route) {
  const cs = route.chunks || [];
  if (!cs.length) return [];
  const raw = cs.map(c => c[7] ?? 0);
  raw.push(route.last && route.last[2] != null ? route.last[2] : raw[raw.length - 1]);
  const z = smoothElevations(raw, 2);
  return cs.map((c, i) => ({ ...unpackChunk(c, i + 1 < cs.length ? cs[i + 1] : (route.last || c)), elev0: z[i], elev1: z[i + 1] }));
}

export function effectiveWeather(leg, settings) {
  const o = settings.weatherOverride;
  if (o && o.enabled) return { tempC: +o.tempC, windKmh: +o.windKmh || 0, windFromDeg: +o.windFromDeg || 0, precipMm: +o.precipMm || 0, source: 'override' };
  return leg?.weather || { tempC: 10, windKmh: 0, windFromDeg: 0, precipMm: 0, source: 'default' };
}

/** Evaluate a stored leg with the current car / profile / settings. */
export function evalLeg(leg, trip) {
  if (!leg) return { status: 'pending' };
  if (leg.status !== 'ok' || !leg.route) return { status: 'failed', error: leg.error || 'unknown error' };
  const wx = effectiveWeather(leg, trip.settings);
  const e = legEnergy(legChunks(leg.route), wx, trip.car, trip.profile, trip.settings);
  return { status: 'ok', ...e, km: leg.route.km ?? e.km, osrmH: leg.route.osrmH ?? e.driveH, temp: wx.tempC, windKmh: wx.windKmh, windFromDeg: wx.windFromDeg, precipMm: wx.precipMm, weatherSrc: wx.source, ferryNames: (leg.route.ferries || []).map(f => f.name) };
}

/** Total leg time in hours including breaks and ferry waits (ferryH already includes waits). */
export function legTimeH(legEval, profile) {
  return legEval.driveH * (1 + (profile.breakMinPerH ?? 0) / 60) + legEval.ferryH;
}

export function parseLocal(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

export function compute(trip) {
  const S = trip.settings;
  const car = trip.car;
  const profile = trip.profile;
  const usable = car.usableKwh;
  const startTime = parseLocal(trip.start.time);
  const periodStart = S.rules.periodStart ? Date.parse(S.rules.periodStart) : NaN;
  const periodEnd = S.rules.periodEnd ? Date.parse(S.rules.periodEnd) : NaN;
  const inPeriod = t => (!Number.isFinite(periodStart) || t >= periodStart) && (!Number.isFinite(periodEnd) || t <= periodEnd);
  const visitedBefore = new Set((trip.visitedBefore || []).map(Number));

  let time = startTime;
  let soc = +trip.start.soc;
  let prev = trip.start;
  const counted = new Set();
  let lastStart = null, lastEnd = null;
  let currentStreak = 0, longestStreak = 0, firstBreakIndex = -1;
  let totalKm = 0, driveH = 0, ferryH = 0, chargeH = 0, kwhBilled = 0, kwhStored = 0, pendingLegs = 0, failedLegs = 0;
  let minSoc = soc;

  const results = trip.stops.map((stop, i) => {
    const warnings = [];
    const legEval = evalLeg(trip.legs[legKey(prev, stop)], trip);
    let arrival = time;
    let arrivalSoc = soc;
    if (legEval.status === 'ok') {
      arrival = time + legTimeH(legEval, profile) * H;
      arrivalSoc = soc - legEval.kwh / usable * 100;
      totalKm += legEval.km;
      driveH += legEval.driveH;
      ferryH += legEval.ferryH;
    } else if (legEval.status === 'failed') {
      failedLegs++;
      warnings.push({ level: 'error', msg: `Route failed: ${legEval.error}` });
    } else {
      pendingLegs++;
      warnings.push({ level: 'info', msg: 'Route not computed yet' });
    }
    if (legEval.status === 'ok') {
      if (arrivalSoc < 0) warnings.push({ level: 'error', msg: `Unreachable: arrives at ${arrivalSoc.toFixed(0)} %` });
      else if (arrivalSoc < S.reserveSoc) warnings.push({ level: 'warn', msg: `Arrives below reserve (${arrivalSoc.toFixed(0)} % < ${S.reserveSoc} %)` });
    }
    minSoc = Math.min(minSoc, arrivalSoc);

    let t = arrival;
    let s = Math.max(0, arrivalSoc);
    const tempC = legEval.temp ?? effectiveWeather(null, S).tempC;
    let session = null;

    if (stop.charge && stop.kind === 'charger') {
      const target = Math.max(+stop.charge.targetSoc, Math.min(100, s + (+S.rules.minSessionPct || 0)));
      const coldStart = tempC < 5 && !S.precondition;
      const sess = chargeSession({ car, siteKw: stop.kw, fromSoc: s, toSoc: target, coldStart, overheadMin: S.plugOverheadMin });
      const start = t + S.plugOverheadMin * MIN;
      const end = start + sess.chargeMin * MIN;
      const inside = inPeriod(start);
      if (!inside) warnings.push({ level: 'error', msg: 'Session outside the competition period — not counted' });
      const isNew = inside && !counted.has(stop.siteId);
      const anchorTime = lastStart == null ? null : (S.rules.anchor === 'end' ? lastEnd : lastStart);
      const deadline = anchorTime == null ? null : anchorTime + S.rules.windowH * H;
      const sinceLastH = lastStart == null ? null : (start - lastStart) / H;
      const deadlineInH = deadline == null ? null : (deadline - start) / H;
      let broken = false;
      if (!USABLE.has(stop.status)) warnings.push({ level: 'warn', msg: `Site is not open (${stop.status})` });
      const belowMin = sess.chargeMin < S.rules.minSessionMin || sess.kwhStored < S.rules.minSessionKwh;
      if (isNew) {
        broken = deadline != null && start > deadline;
        if (broken) {
          if (firstBreakIndex < 0) firstBreakIndex = i;
          currentStreak = 0;
          warnings.push({ level: 'error', msg: `Streak broken: session starts ${fmtH(-deadlineInH)} after the deadline` });
        } else if (deadlineInH != null && deadlineInH * 60 < S.rules.marginMin) {
          warnings.push({ level: 'warn', msg: `Only ${Math.round(deadlineInH * 60)} min of margin before the deadline` });
        }
        if (belowMin) warnings.push({ level: 'warn', msg: `Session below the safety minimum (${S.rules.minSessionMin} min / ${S.rules.minSessionKwh} kWh)` });
        counted.add(stop.siteId);
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
        lastStart = start;
        lastEnd = end;
      } else if (inside) {
        warnings.push({ level: 'info', msg: 'Repeat site: does not count and does not reset the timer' });
      }
      session = { start, end, minutes: sess.minutes, chargeMin: sess.chargeMin, kwhStored: sess.kwhStored, kwhBilled: sess.kwhBilled, avgKw: sess.avgKw, counted: isNew, isNew, deadline, deadlineInH, sinceLastH, broken, belowMin, targetSoc: target, ac: false };
      chargeH += sess.minutes / 60;
      kwhBilled += sess.kwhBilled;
      kwhStored += sess.kwhStored;
      t = end;
      s = target;
    } else if (stop.charge && stop.kind === 'point') {
      const target = Math.max(+stop.charge.targetSoc, s);
      const sess = chargeSession({ car, siteKw: 0, fromSoc: s, toSoc: target, acKw: +stop.charge.kw || 11, overheadMin: 0 });
      const restH = stop.rest && stop.rest.hours > 0 ? +stop.rest.hours : 0;
      const effectiveMin = Math.max(0, sess.chargeMin - restH * 60); // AC charging overlaps with a rest
      session = { start: t, end: t + sess.chargeMin * MIN, minutes: sess.chargeMin, chargeMin: sess.chargeMin, kwhStored: sess.kwhStored, kwhBilled: 0, avgKw: sess.avgKw, counted: false, isNew: false, deadline: null, deadlineInH: null, sinceLastH: lastStart == null ? null : (t - lastStart) / H, broken: false, belowMin: false, targetSoc: target, ac: true };
      t += effectiveMin * MIN;
      s = target;
    }

    let rest = null;
    if (stop.rest && +stop.rest.hours > 0) {
      const hours = +stop.rest.hours;
      const drainPct = restDrainPctPerH(!!stop.rest.sentry, tempC, S.sentry) * hours;
      rest = { start: t, end: t + hours * H, hours, drainPct, sentry: !!stop.rest.sentry };
      t = rest.end;
      s = Math.max(0, s - drainPct);
    }

    const timer = {
      sinceLastH: lastStart == null ? null : (arrival - lastStart) / H,
      deadline: lastStart == null ? null : (S.rules.anchor === 'end' ? lastEnd : lastStart) + S.rules.windowH * H,
    };
    timer.deadlineInH = timer.deadline == null ? null : (timer.deadline - t) / H; // time left when leaving this stop

    const r = { i, stop, leg: legEval, arrival, arrivalSoc, session, rest, depart: t, departSoc: s, warnings, timer, minUsefulSoc: null };
    time = t;
    soc = s;
    prev = stop;
    return r;
  });

  let destResult = null;
  if (trip.destination && trip.destination.lat != null) {
    const d = trip.destination;
    const legEval = evalLeg(trip.legs[legKey(prev, d)], trip);
    let arrival = time;
    let arrivalSoc = soc;
    const w = [];
    if (legEval.status === 'ok') {
      arrival = time + legTimeH(legEval, profile) * H;
      arrivalSoc = soc - legEval.kwh / usable * 100;
      totalKm += legEval.km;
      driveH += legEval.driveH;
      ferryH += legEval.ferryH;
      if (arrivalSoc < 0) w.push({ level: 'error', msg: `Unreachable: arrives at ${arrivalSoc.toFixed(0)} %` });
      else if (arrivalSoc < S.reserveSoc) w.push({ level: 'warn', msg: `Arrives below reserve (${arrivalSoc.toFixed(0)} % < ${S.reserveSoc} %)` });
    } else if (legEval.status === 'failed') {
      failedLegs++;
      w.push({ level: 'error', msg: `Route failed: ${legEval.error}` });
    } else {
      pendingLegs++;
      w.push({ level: 'info', msg: 'Route not computed yet' });
    }
    minSoc = Math.min(minSoc, arrivalSoc);
    const timer = { sinceLastH: lastStart == null ? null : (arrival - lastStart) / H, deadline: lastStart == null ? null : (S.rules.anchor === 'end' ? lastEnd : lastStart) + S.rules.windowH * H };
    timer.deadlineInH = timer.deadline == null ? null : (timer.deadline - arrival) / H;
    destResult = { destination: d, leg: legEval, arrival, arrivalSoc, warnings: w, timer };
    time = arrival;
    soc = Math.max(0, arrivalSoc);
  }

  results.forEach((r, i) => {
    const next = results[i + 1];
    r.minUsefulSoc = next && next.leg.status === 'ok' ? Math.min(100, Math.ceil(next.leg.kwh / usable * 100 + S.reserveSoc)) : null;
  });
  if (results.length && destResult && destResult.leg.status === 'ok') {
    const r = results[results.length - 1];
    if (r.minUsefulSoc == null) r.minUsefulSoc = Math.min(100, Math.ceil(destResult.leg.kwh / usable * 100 + S.reserveSoc));
  }

  const eta = destResult ? destResult.arrival : (results.length ? results[results.length - 1].depart : startTime);
  const nextDeadline = lastStart == null ? null : (S.rules.anchor === 'end' ? lastEnd : lastStart) + S.rules.windowH * H;
  const newForYear = [...counted].filter(id => !visitedBefore.has(Number(id))).length;
  const summary = {
    uniqueCounted: counted.size, longestStreak, currentStreak, firstBreakIndex, newForYear,
    totalKm, totalDriveH: driveH, totalFerryH: ferryH, totalTimeH: (eta - startTime) / H, chargeH, kwhBilled, kwhStored,
    eta, minSoc, pendingLegs, failedLegs, nextDeadline, endSoc: soc,
    warnings: results.flatMap(r => r.warnings.filter(w => w.level !== 'info').map(w => ({ i: r.i, ...w })))
      .concat(destResult ? destResult.warnings.filter(w => w.level !== 'info').map(w => ({ i: results.length, ...w })) : []),
  };
  return { stops: results, destination: destResult, summary, startTime };
}

function fmtH(h) {
  const m = Math.round(Math.abs(h) * 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
