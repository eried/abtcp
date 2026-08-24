// Physics-based consumption model. Pure functions; every input is explicit.
//
// A "chunk" is a piece of road: { d (m), t (s, OSRM), v (m/s, OSRM expected speed), mode (0 driving,
// 1 ferry), brg (deg), elev0, elev1 (m) }. Weather: { tempC, windKmh, windFromDeg, precipMm }.

const G = 9.81;
/** Ferry crossing time model: docking + sailing (OSRM's ferry durations are ~2x too slow). */
export const FERRY_SPEED_KMH = 22;
export const FERRY_DOCK_MIN = 8;
export function ferryCrossingH(km) { return FERRY_DOCK_MIN / 60 + km / FERRY_SPEED_KMH; }

export function airDensity(tempC) {
  return 101325 / (287.05 * (tempC + 273.15));
}

/** Cabin + electronics load (heat pump, screens, pumps). kW. */
export function auxPowerKw(tempC) {
  return 0.45 + 0.10 * Math.max(0, 20 - tempC) + 0.08 * Math.max(0, tempC - 24);
}

/** Cold-battery penalty on drive energy. */
export function coldFactor(tempC) {
  return tempC <= 0 ? 1.08 : tempC < 8 ? 1.04 : 1;
}

/** Driver's actual speed for a road whose expected speed is vOsrm (m/s). */
export function drivingSpeedMs(vOsrmMs, profile) {
  const vKmh = vOsrmMs * 3.6;
  let out = vKmh * (profile.speedFactor ?? 1) + (vKmh >= 60 ? (profile.offsetKmh ?? 0) : 0);
  out = Math.min(Math.max(out, 5), profile.maxKmh ?? 150);
  return out / 3.6;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Real-world driving dynamics (accelerating, braking, curves, villages) cost energy that a
 * steady-state model misses — most on slow roads, almost nothing at steady highway speeds.
 * Calibrated against the Tesla app's own predictions on 80–90 km/h Nordic roads (which land
 * ~12–15 % above pure steady-state physics) while leaving ~120 km/h motorway cruise intact.
 */
export function dynamicsFactor(vKmh) {
  return 1 + 0.02 + 0.10 * clamp((105 - vKmh) / 45, 0, 1);
}

export function chunkEnergy(chunk, wx, car, profile, settings = {}) {
  const massKg = car.massKg + (car.payloadKg ?? 0);
  if (chunk.mode === 1) {
    const seconds = chunk.d / (FERRY_SPEED_KMH / 3.6);
    const drainPctH = settings.sentry?.offPctH ?? 0.04;
    const kwh = drainPctH / 100 * car.usableKwh * (seconds / 3600);
    return { kwh, seconds, vKmh: chunk.v * 3.6 };
  }
  const v = drivingSpeedMs(chunk.v, profile);
  const seconds = chunk.d / v;
  const rho = airDensity(wx.tempC);
  const windMs = (wx.windKmh ?? 0) / 3.6;
  const head = windMs * Math.cos(((wx.windFromDeg ?? 0) - (chunk.brg ?? 0)) * Math.PI / 180);
  const vRel = v + head;
  const fAero = 0.5 * rho * car.cd * car.areaM2 * vRel * Math.abs(vRel);
  const wet = (wx.precipMm ?? 0) > 0.1 ? 1 : 0;
  const fRoll = car.crr * massKg * G * (1 + 0.1 * wet);
  const grade = chunk.d > 0 ? clamp(((chunk.elev1 ?? chunk.elev0 ?? 0) - (chunk.elev0 ?? 0)) / chunk.d, -0.12, 0.12) : 0;
  const fGrade = massKg * G * grade;
  const eMech = (fAero + fRoll + fGrade) * chunk.d; // J
  let eBatt = eMech >= 0 ? eMech * dynamicsFactor(v * 3.6) / car.etaDrive : eMech * car.etaRegen;
  eBatt *= coldFactor(wx.tempC);
  const eAux = auxPowerKw(wx.tempC) * 1000 * seconds; // J
  let kwh = (eBatt + eAux) / 3.6e6;
  if (kwh > 0) kwh *= 1 + (settings.marginPct ?? 0) / 100;
  return { kwh, seconds, vKmh: v * 3.6 };
}

/** Sum a whole leg. Adds `ferryWaitMin` once per contiguous ferry crossing. */
export function legEnergy(chunks, wx, car, profile, settings = {}) {
  let kwh = 0, driveS = 0, ferryS = 0, ferries = 0, gain = 0, loss = 0, km = 0;
  let prevMode = 0;
  let runKm = 0;
  const closeRun = () => { if (runKm > 0) { ferryS += ferryCrossingH(runKm) * 3600 + (settings.ferryWaitMin ?? 0) * 60; runKm = 0; } };
  for (const c of chunks) {
    const r = chunkEnergy(c, wx, car, profile, settings);
    kwh += r.kwh;
    km += c.d / 1000;
    if (c.mode === 1) {
      if (prevMode !== 1) ferries++;
      runKm += c.d / 1000;
    } else {
      closeRun();
      driveS += r.seconds;
      const dz = (c.elev1 ?? c.elev0 ?? 0) - (c.elev0 ?? 0);
      if (dz > 0) gain += dz; else loss -= dz;
    }
    prevMode = c.mode;
  }
  closeRun();
  return {
    kwh, km, driveH: driveS / 3600, ferryH: ferryS / 3600, ferries,
    gainM: Math.round(gain), lossM: Math.round(loss), whKm: km > 0 ? kwh * 1000 / km : 0,
  };
}

/** Rough Wh/km for candidate ranking before a real route exists. */
export function quickWhKm(car, tempC = 15, marginPct = 0) {
  return car.refWhKm * (1 + 0.006 * Math.max(0, 15 - tempC)) * (1 + marginPct / 100);
}
