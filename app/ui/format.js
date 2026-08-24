// Formatting helpers for the UI.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');

export const fmt = {
  km: n => (n == null || !Number.isFinite(n) ? '–' : `${Math.round(n)} km`),
  h: hours => {
    if (hours == null || !Number.isFinite(hours)) return '–';
    const m = Math.round(Math.abs(hours) * 60);
    const h = Math.floor(m / 60);
    if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return h > 0 ? `${h}h${pad(m % 60)}` : `${m} min`;
  },
  signedH: h => (h == null ? '–' : (h < 0 ? '−' : '+') + fmt.h(Math.abs(h))),
  pct: n => (n == null || !Number.isFinite(n) ? '–' : `${Math.round(n)} %`),
  kwh: n => (n == null || !Number.isFinite(n) ? '–' : `${n.toFixed(1)} kWh`),
  time: ms => {
    if (ms == null || !Number.isFinite(ms)) return '–';
    const d = new Date(ms);
    return `${DAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  clock: ms => {
    if (ms == null || !Number.isFinite(ms)) return '–';
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  day: ms => {
    if (ms == null || !Number.isFinite(ms)) return '–';
    const d = new Date(ms);
    return `${DAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  },
  temp: t => (t == null || !Number.isFinite(t) ? '–' : `${Math.round(t)} °C`),
  whkm: n => (n == null || !Number.isFinite(n) ? '–' : `${Math.round(n)} Wh/km`),
  n1: n => (n == null || !Number.isFinite(n) ? '–' : (Math.round(n * 10) / 10).toString()),
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function socClass(soc, reserve = 10) {
  if (soc == null || !Number.isFinite(soc)) return '';
  return soc >= reserve + 15 ? 'good' : soc >= reserve ? 'low' : 'bad';
}

export function slug(s) {
  return String(s || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'trip';
}
