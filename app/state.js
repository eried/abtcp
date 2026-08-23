// Trip state: defaults, schema migration, (de)serialization and a tiny observable store.
import { CARS } from './model/cars.js';
import { PROFILES } from './model/profiles.js';

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'abtcp.trip';

export function defaultSettings() {
  return {
    rules: { windowH: 24, anchor: 'start', marginMin: 60, minSessionMin: 2, minSessionKwh: 1, minSessionPct: 8 },
    reserveSoc: 10,
    marginPct: 5,
    defaultTargetSoc: 60,
    sentry: { onPctH: 0.2, offPctH: 0.04, coldFactor: 1.3 },
    ferryWaitMin: 30,
    plugOverheadMin: 3,
    precondition: true,
    weatherOverride: { enabled: false, tempC: 10, windKmh: 0, windFromDeg: 0, precipMm: 0 },
    osrmUrl: 'https://router.project-osrm.org',
    tiles: 'osm',
    showStatuses: ['OPEN', 'EXPANDING', 'CLOSED_TEMP'],
    candidates: { limit: 15, toward: true, maxKm: 400 },
  };
}

const pad = n => String(n).padStart(2, '0');

/** 'YYYY-MM-DDTHH:mm' in local time (what <input type=datetime-local> uses). */
export function toLocalIso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function defaultStart(now = new Date()) {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  t.setHours(8, 0, 0, 0);
  return { lat: 69.6496, lng: 18.9553, name: 'Tromsø, Norway', time: toLocalIso(t), soc: 90 };
}

export function defaultTrip(now = new Date()) {
  const iso = new Date(now).toISOString();
  return {
    version: SCHEMA_VERSION,
    meta: { name: 'My contest trip', createdAt: iso, updatedAt: iso },
    settings: defaultSettings(),
    car: { ...CARS[0], curve: CARS[0].curve.map(p => [...p]) },
    profile: { ...PROFILES[0] },
    start: defaultStart(now),
    destination: null,
    stops: [],
    legs: {},
    visitedBefore: [],
  };
}

let seq = 0;
export function newId() {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function stopDefaults() {
  return { id: newId(), kind: 'point', siteId: null, tid: null, name: 'Waypoint', lat: 0, lng: 0, kw: 0, stalls: 0, status: null, country: '', charge: null, rest: null, note: '' };
}

/** newStop({ site, targetSoc }) for a charger, newStop({ lat, lng, name }) for a free point. */
export function newStop(arg) {
  if (arg.site) {
    const s = arg.site;
    return { ...stopDefaults(), kind: 'charger', siteId: s.id, tid: s.tid ?? null, name: s.name, lat: s.lat, lng: s.lng, kw: s.kw, stalls: s.stalls, status: s.status, country: s.country, charge: { targetSoc: arg.targetSoc ?? 60 } };
  }
  return { ...stopDefaults(), name: arg.name || 'Waypoint', lat: arg.lat, lng: arg.lng };
}

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);

/** Recursively merge `src` over `base`; arrays and primitives are replaced. */
export function deepMerge(base, src) {
  if (!isPlain(base) || !isPlain(src)) return src === undefined ? base : src;
  const out = { ...base };
  for (const [k, v] of Object.entries(src)) out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : (v === undefined ? base[k] : v);
  return out;
}

export function migrate(obj) {
  const trip = deepMerge(defaultTrip(), obj);
  trip.version = SCHEMA_VERSION;
  trip.stops = (Array.isArray(obj.stops) ? obj.stops : []).map(s => ({ ...stopDefaults(), ...s }));
  trip.legs = isPlain(obj.legs) ? obj.legs : {};
  trip.visitedBefore = Array.isArray(obj.visitedBefore) ? obj.visitedBefore : [];
  trip.destination = isPlain(obj.destination) ? obj.destination : null;
  return trip;
}

export function serialize(trip) {
  return JSON.stringify(trip);
}

export function deserialize(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('Not an ABTCP trip file (invalid JSON)'); }
  if (!isPlain(obj) || typeof obj.version !== 'number' || !Array.isArray(obj.stops)) throw new Error('Not an ABTCP trip file');
  if (obj.version > SCHEMA_VERSION) throw new Error(`Trip file version ${obj.version} is newer than this app (${SCHEMA_VERSION})`);
  return migrate(obj);
}

/** Observable store with autosave. `storage` needs getItem/setItem/removeItem (localStorage-like). */
export function createStore({ storage = globalThis.localStorage ?? null, key = STORAGE_KEY, trip = null } = {}) {
  let current = trip || defaultTrip();
  const subs = new Set();
  const emit = () => { for (const fn of subs) fn(current); };
  const save = () => {
    if (!storage) return false;
    try { storage.setItem(key, serialize(current)); return true; } catch { return false; }
  };
  return {
    get trip() { return current; },
    update(fn) { fn(current); current.meta.updatedAt = new Date().toISOString(); save(); emit(); },
    replace(t) { current = migrate(t); save(); emit(); },
    reset() { current = defaultTrip(); save(); emit(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    save,
    load() {
      if (!storage) return false;
      let text = null;
      try { text = storage.getItem(key); } catch { return false; }
      if (!text) return false;
      try { current = deserialize(text); return true; } catch { return false; }
    },
    clear() { try { storage?.removeItem(key); } catch { /* ignore */ } },
  };
}
