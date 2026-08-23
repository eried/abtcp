// Charging curve integration and parked drain. Pure functions.

/** Car's DC charging power (kW) at a given state of charge, from a piecewise-linear curve. */
export function curveKw(car, soc) {
  const pts = car.curve;
  if (soc <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (soc <= pts[i][0]) {
      const [s0, k0] = pts[i - 1];
      const [s1, k1] = pts[i];
      return k0 + (k1 - k0) * (soc - s0) / (s1 - s0);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Simulate a charging session. Returns minutes including the plug/unplug overhead.
 * siteKw ≤ 0 means "unknown" → car maximum. coldStart derates power by 40 % for 10 minutes.
 */
export function chargeSession({ car, siteKw, fromSoc, toSoc, coldStart = false, overheadMin = 3, lossFactor = 0.94, acKw = null }) {
  const from = Math.max(0, fromSoc);
  const to = Math.min(100, toSoc);
  if (!(to > from)) return { minutes: 0, chargeMin: 0, kwhStored: 0, kwhBilled: 0, avgKw: 0 };
  const cap = acKw ? acKw : Math.min(siteKw > 0 ? siteKw : car.maxDcKw, car.maxDcKw);
  let soc = from, seconds = 0, kwh = 0;
  const step = 0.5;
  while (soc < to - 1e-9) {
    const s = Math.min(step, to - soc);
    let p = acKw ? acKw : Math.min(curveKw(car, soc + s / 2), cap);
    if (coldStart && seconds < 600) p *= 0.6;
    const e = s / 100 * car.usableKwh;
    seconds += e / p * 3600;
    kwh += e;
    soc += s;
  }
  const chargeMin = seconds / 60;
  return { minutes: chargeMin + overheadMin, chargeMin, kwhStored: kwh, kwhBilled: kwh / lossFactor, avgKw: kwh / (seconds / 3600) };
}

/** Parked drain in % per hour. s = settings.sentry { onPctH, offPctH, coldFactor }. */
export function restDrainPctPerH(sentry, tempC, s) {
  const base = sentry ? s.onPctH : s.offPctH;
  return base * (tempC < 0 ? s.coldFactor : 1);
}

export function socAfterRest(soc, hours, sentry, tempC, s) {
  return Math.max(0, soc - restDrainPctPerH(sentry, tempC, s) * hours);
}
