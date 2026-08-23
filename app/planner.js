// Orchestrates routing + elevation + weather into stored legs, ranks candidate next chargers,
// and greedily chains stops toward a destination ("de-optimizer": most sites, short hops).
import { legKey, compute } from './model/timeline.js';
import { ferryIntervals, chunkRoute, packChunk, haversineM } from './model/geo.js';
import { quickWhKm } from './model/energy.js';
import { newStop } from './state.js';

const r5 = x => Math.round(x * 1e5) / 1e5;

export function createPlanner({ store, db, osrm, elevation, weatherAt, now = () => Date.now() }) {
  const inflight = new Map();

  /** Route a→b, sample elevation + weather, store under legKey(a,b). Never throws; failed legs are stored as such. */
  async function buildLeg(a, b, { force = false, departTime = null } = {}) {
    const key = legKey(a, b);
    const existing = store.trip.legs[key];
    if (!force && existing && existing.status === 'ok') return existing;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      let leg;
      try {
        const r = await osrm.route(a, b);
        const steps = r.legs.flatMap(l => l.steps || []);
        const ferries = ferryIntervals(steps);
        const ann = { distance: r.legs.flatMap(l => l.annotation.distance), duration: r.legs.flatMap(l => l.annotation.duration) };
        const chunks = chunkRoute(r.geometry.coordinates, ann, ferries, 500);
        if (!chunks.length) throw new Error('empty route');
        const lastC = chunks[chunks.length - 1];
        const pts = chunks.map(c => ({ lat: c.lat0, lng: c.lng0 }));
        pts.push({ lat: lastC.lat1, lng: lastC.lng1 });
        let elevs = null;
        try { elevs = await elevation.sample(pts); } catch { elevs = null; }
        const ev = elevs || pts.map(() => 0);
        chunks.forEach((c, i) => { c.elev0 = ev[i] ?? 0; c.elev1 = ev[i + 1] ?? c.elev0; });
        const mid = chunks[Math.floor(chunks.length / 2)];
        const eta = (departTime ?? now()) + r.duration * 500;
        const weather = await weatherAt({ lat: mid.lat0, lng: mid.lng0, time: eta });
        leg = {
          status: 'ok',
          route: {
            km: r.distance / 1000, osrmH: r.duration / 3600,
            chunks: chunks.map(packChunk),
            last: [r5(lastC.lat1), r5(lastC.lng1), Math.round(ev[ev.length - 1] ?? 0)],
            ferries: ferries.map(f => ({ km: (f.end - f.start) / 1000, h: f.seconds / 3600, name: f.name })),
          },
          weather,
          elevationOk: !!elevs,
          computedAt: new Date(now()).toISOString(),
        };
      } catch (e) {
        leg = { status: 'failed', error: String((e && e.message) || e), computedAt: new Date(now()).toISOString() };
      } finally {
        inflight.delete(key);
      }
      store.update(t => { t.legs[key] = leg; });
      return leg;
    })();
    inflight.set(key, p);
    return p;
  }

  /** Build every missing/failed leg in trip order (departure times feed the weather ETA). */
  async function ensureLegs({ onProgress = null, force = false } = {}) {
    let built = 0;
    const count = store.trip.stops.length;
    for (let i = 0; i < count; i++) {
      const trip = store.trip;
      const stop = trip.stops[i];
      if (!stop) break;
      const prev = i === 0 ? trip.start : trip.stops[i - 1];
      const key = legKey(prev, stop);
      const cur = trip.legs[key];
      if (force || !cur || cur.status !== 'ok') {
        const tl = compute(trip);
        const departTime = i === 0 ? tl.startTime : tl.stops[i - 1].depart;
        await buildLeg(prev, stop, { force, departTime });
        built++;
        if (onProgress) onProgress(i + 1, count);
      }
    }
    return built;
  }

  /** Drop cached legs that no consecutive stop pair uses any more. */
  function pruneLegs() {
    store.update(t => {
      const keep = new Set();
      let prev = t.start;
      for (const s of t.stops) { keep.add(legKey(prev, s)); prev = s; }
      for (const k of Object.keys(t.legs)) if (!keep.has(k)) delete t.legs[k];
    });
  }

  function averageWhKm(tl, trip) {
    let km = 0, kwh = 0;
    for (const r of tl.stops) if (r.leg.status === 'ok') { km += r.leg.km; kwh += Math.max(0, r.leg.kwh); }
    if (km > 50) return kwh * 1000 / km;
    const S = trip.settings;
    const last = tl.stops[tl.stops.length - 1];
    const tempC = S.weatherOverride.enabled ? +S.weatherOverride.tempC : (last && last.leg.temp != null ? last.leg.temp : 10);
    return quickWhKm(trip.car, tempC, S.marginPct);
  }

  /**
   * Rank unvisited usable sites near the current end of the trip by real road distance.
   * → [{ site, distM, roadKm, roadH, kwh, arrivalSoc, progressKm }]
   */
  async function candidates({ from = null, fromSoc = null, limit = null, toward = null, maxKm = null, n = 60 } = {}) {
    const trip = store.trip;
    const S = trip.settings;
    const tl = compute(trip);
    const last = tl.stops[tl.stops.length - 1];
    const origin = from || (last ? last.stop : trip.start);
    const soc = fromSoc ?? (last ? last.departSoc : +trip.start.soc);
    const dest = trip.destination;
    const useToward = (toward ?? S.candidates.toward) && !!dest;
    const inTrip = new Set(trip.stops.map(s => s.siteId).filter(x => x != null));
    const maxM = (maxKm ?? S.candidates.maxKm ?? 400) * 1000;
    const near = db.nearest(origin.lat, origin.lng, { n, maxM, filter: s => db.isUsable(s) && !inTrip.has(s.id) && s.id !== origin.siteId });
    const toDest = p => dest ? haversineM(p.lat, p.lng, dest.lat, dest.lng) : null;
    const originToDest = toDest(origin);
    let list = near.map(({ site, distM }) => ({ site, distM, progressKm: dest ? (originToDest - toDest(site)) / 1000 : null }));
    if (useToward) list = list.filter(c => c.progressKm > 0);
    if (!list.length) return [];
    const whKm = averageWhKm(tl, trip);
    const table = await osrm.table(origin, list.map(c => c.site));
    const out = [];
    list.forEach((c, i) => {
      const m = table.distances[i];
      const s = table.durations[i];
      if (m == null || s == null) return;
      const roadKm = m / 1000;
      const kwh = roadKm * whKm / 1000;
      out.push({ ...c, roadKm, roadH: s / 3600, kwh, arrivalSoc: soc - kwh / trip.car.usableKwh * 100, whKm });
    });
    out.sort((a, b) => a.roadKm - b.roadKm);
    return out.slice(0, limit ?? S.candidates.limit);
  }

  /**
   * Greedy chain: repeatedly append the nearest candidate (toward the destination when set),
   * building its real leg. If the car would arrive below reserve, the previous stop's charge
   * target is raised to what is needed (adaptive), otherwise the candidate is dropped.
   */
  async function autoChain({ n = 5, targetSoc = null, toward = null, adaptive = true, onProgress = null, shouldStop = () => false } = {}) {
    let added = 0;
    for (let k = 0; k < n; k++) {
      if (shouldStop()) break;
      const trip = store.trip;
      const S = trip.settings;
      const target = targetSoc ?? S.defaultTargetSoc;
      const dest = trip.destination;
      const tl0 = compute(trip);
      const last = tl0.stops[tl0.stops.length - 1];
      const origin = last ? last.stop : trip.start;
      if (dest && haversineM(origin.lat, origin.lng, dest.lat, dest.lng) < 30000) break;
      const cands = await candidates({ toward, limit: 6 });
      let placed = false;
      for (const c of cands.slice(0, 4)) {
        if (c.arrivalSoc < S.reserveSoc - 15) continue;
        const stop = newStop({ site: c.site, targetSoc: target });
        store.update(t => { t.stops.push(stop); });
        const tl1 = compute(store.trip);
        const departTime = tl1.stops.length > 1 ? tl1.stops[tl1.stops.length - 2].depart : tl1.startTime;
        const leg = await buildLeg(origin, stop, { departTime });
        let res = compute(store.trip).stops.at(-1);
        if (leg.status === 'ok' && res.arrivalSoc < S.reserveSoc && adaptive) {
          const idx = store.trip.stops.length - 2;
          const need = Math.min(100, Math.ceil(res.leg.kwh / store.trip.car.usableKwh * 100 + S.reserveSoc + 2));
          if (idx >= 0 && store.trip.stops[idx].charge) store.update(t => { t.stops[idx].charge.targetSoc = Math.max(t.stops[idx].charge.targetSoc, need); });
          else if (idx < 0) store.update(t => { t.start.soc = Math.max(t.start.soc, need); });
          res = compute(store.trip).stops.at(-1);
        }
        if (leg.status === 'ok' && res.arrivalSoc >= S.reserveSoc) {
          placed = true;
          added++;
          if (onProgress) onProgress(added, n, stop, res);
          break;
        }
        store.update(t => { t.stops = t.stops.filter(s => s.id !== stop.id); });
      }
      if (!placed) break;
    }
    pruneLegs();
    return added;
  }

  return { buildLeg, ensureLegs, pruneLegs, candidates, autoChain, averageWhKm };
}
