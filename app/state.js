// Trip state: defaults, schema migration, (de)serialization and a tiny observable store.
import { CARS } from './model/cars.js';
import { PROFILES } from './model/profiles.js';

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'abtcp.trip';

export function defaultSettings() {
  return {
    rules: { windowH: 24, anchor: 'start', marginMin: 60, minSessionMin: 2, minSessionKwh: 1, minSessionPct: 8, periodStart: '2026-01-01T00:01', periodEnd: '2026-12-31T23:59' },
    reserveSoc: 10,
    marginPct: 5,
    defaultTargetSoc: 60,
    maxChargeSoc: 90,
    fill: { startDetourKm: 10, maxDetourKm: 60, perRun: 3 },
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
export function createStore({ storage = globalThis.localStorage ?? null, key = STORAGE_KEY, trip = null, historyLimit = 60, coalesceMs = 500, now = () => Date.now() } = {}) {
  let current = trip || defaultTrip();
  const subs = new Set();
  const emit = () => { for (const fn of subs) fn(current); };
  // History holds everything except `legs` (a coordinate-keyed route cache that is reattached
  // on undo, so stepping back never triggers a re-route).
  const undoStack = [];
  const redoStack = [];
  let lastPush = 0;
  const snap = t => JSON.stringify({ ...t, legs: undefined });
  const restore = text => {
    const legs = current.legs;
    const obj = JSON.parse(text);
    obj.legs = legs;
    return migrate(obj);
  };
  let batching = 0;
  /**
   * `force` marks a deliberate action boundary (a batch, an import, a reset): those must never
   * be merged into a neighbouring entry, otherwise one undo would jump two steps back.
   */
  const pushHistory = (force = false) => {
    if (batching > 0) return; // inside a batch the entry was taken before the first change
    const t = now();
    const coalesce = !force && undoStack.length && t - lastPush < coalesceMs;
    if (!coalesce) {
      undoStack.push(snap(current));
      if (undoStack.length > historyLimit) undoStack.shift();
    }
    lastPush = t;
    redoStack.length = 0;
  };
  const save = () => {
    if (!storage) return false;
    try { storage.setItem(key, serialize(current)); return true; } catch { return false; }
  };
  return {
    get trip() { return current; },
    update(fn) { pushHistory(); fn(current); current.meta.updatedAt = new Date().toISOString(); save(); emit(); },
    /** Mutate without touching the history — for the route cache, which is not user state. */
    updateQuiet(fn) { fn(current); save(); emit(); },
    /** Group a whole user action (auto-chain, fill gaps, add/remove stop) into one undo step. */
    async batch(fn) {
      if (batching === 0) { pushHistory(true); lastPush = now() + 1e9; } // block coalescing inside
      batching++;
      try { return await fn(); } finally { batching--; if (batching === 0) lastPush = 0; }
    },
    replace(t) { pushHistory(true); current = migrate(t); save(); emit(); },
    reset() { pushHistory(true); current = defaultTrip(); save(); emit(); },
    canUndo() { return undoStack.length > 0; },
    historyDepth() { return { undo: undoStack.length, redo: redoStack.length }; },
    canRedo() { return redoStack.length > 0; },
    undo() {
      if (!undoStack.length) return false;
      redoStack.push(snap(current));
      current = restore(undoStack.pop());
      lastPush = 0;
      save();
      emit();
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(snap(current));
      current = restore(redoStack.pop());
      lastPush = 0;
      save();
      emit();
      return true;
    },
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
