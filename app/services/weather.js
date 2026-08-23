// Open-Meteo weather for a point and time: forecast when the time is near, otherwise the
// ERA5 archive for the same date one year earlier (a climate proxy). Never throws: falls back
// to a 10 °C default and reports `source: 'default'`.
import { getJson } from './http.js';

const HOURLY = 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const DAY = 864e5;

const pad = n => String(n).padStart(2, '0');
export function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

export function weatherUrl({ lat, lng, date, archive = false }) {
  return `${archive ? ARCHIVE_URL : FORECAST_URL}?latitude=${(+lat).toFixed(4)}&longitude=${(+lng).toFixed(4)}&hourly=${HOURLY}&start_date=${date}&end_date=${date}&wind_speed_unit=kmh&timezone=auto`;
}

/** Decide which service can answer for `time` relative to `now`. */
export function pickSource(time, now) {
  const aheadDays = (time - now) / DAY;
  if (aheadDays <= 15 && aheadDays >= -5) return { archive: false, date: dateStr(new Date(time)) };
  const d = new Date(time);
  d.setFullYear(d.getFullYear() - 1);
  while (d.getTime() > now - 7 * DAY) d.setFullYear(d.getFullYear() - 1); // archive lags ~5 days
  return { archive: true, date: dateStr(d) };
}

export async function weatherAt({ lat, lng, time, override = null, fetchImpl = globalThis.fetch, now = Date.now(), queue = null }) {
  if (override && override.enabled) {
    return { tempC: +override.tempC, windKmh: +override.windKmh || 0, windFromDeg: +override.windFromDeg || 0, precipMm: +override.precipMm || 0, source: 'override', at: time };
  }
  const { archive, date } = pickSource(time, now);
  const url = weatherUrl({ lat, lng, date, archive });
  try {
    const j = await (queue ? queue.run(() => getJson(url, { fetchImpl })) : getJson(url, { fetchImpl }));
    const h = j.hourly;
    if (!h || !h.time || !h.time.length) throw new Error('empty response');
    const idx = Math.min(h.time.length - 1, Math.max(0, new Date(time).getHours()));
    const val = arr => (arr && arr[idx] != null ? +arr[idx] : null);
    const tempC = val(h.temperature_2m);
    if (tempC == null) throw new Error('no temperature');
    return { tempC, windKmh: val(h.wind_speed_10m) ?? 0, windFromDeg: val(h.wind_direction_10m) ?? 0, precipMm: val(h.precipitation) ?? 0, source: archive ? 'archive' : 'forecast', at: time, date };
  } catch (e) {
    return { tempC: 10, windKmh: 0, windFromDeg: 0, precipMm: 0, source: 'default', at: time, error: String(e && e.message || e) };
  }
}
