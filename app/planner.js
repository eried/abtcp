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
    const trip = store.trip;
    if (trip.destination && trip.destination.lat != null) {
      const prev = trip.stops.length ? trip.stops[trip.stops.length - 1] : trip.start;
      const key = legKey(prev, trip.destination);
      const cur = trip.legs[key];
      if (force || !cur || cur.status !== 'ok') {
        const tl = compute(trip);
        const departTime = tl.stops.length ? tl.stops[tl.stops.length - 1].depart : tl.startTime;
        await buildLeg(prev, trip.destination, { force, departTime });
        built++;
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
      if (t.destination && t.destination.lat != null) keep.add(legKey(prev, t.destination));
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
  async function candidates({ from = null, fromSoc = null, limit = null, toward = null, maxKm = null, n = 60, destOverride = null } = {}) {
    const trip = store.trip;
    const S = trip.settings;
    const visitedYear = new Set((trip.visitedBefore || []).map(Number));
    const tl = compute(trip);
    const last = tl.stops[tl.stops.length - 1];
    const origin = from || (last ? last.stop : trip.start);
    const soc = fromSoc ?? (last ? last.departSoc : +trip.start.soc);
    const dest = destOverride || trip.destination;
    const useToward = (toward ?? S.candidates.toward) && !!dest;
    const inTrip = new Set(trip.stops.map(s => s.siteId).filter(x => x != null));
    const maxM = (maxKm ?? S.candidates.maxKm ?? 400) * 1000;
    const near = db.nearest(origin.lat, origin.lng, { n, maxM, filter: s => db.isUsable(s) && !inTrip.has(s.id) && s.id !== origin.siteId });
    const toDest = p => dest ? haversineM(p.lat, p.lng, dest.lat, dest.lng) : null;
    const originToDest = toDest(origin);
    let list = near.map(({ site, distM }) => ({ site, distM, progressKm: dest ? (originToDest - toDest(site)) / 1000 : null, progressSrc: dest ? 'line' : null }));
    if (dest && list.length) {
      // Progress by road: one table call from the destination to origin + candidates (peninsulas and
      // fjords look close on a straight line but are dead ends by road).
      try {
        const td = await osrm.table(dest, [origin, ...list.map(c => c.site)]);
        const o = td.distances[0];
        if (o != null) list = list.map((c, i) => (td.distances[i + 1] == null ? c : { ...c, progressKm: (o - td.distances[i + 1]) / 1000, progressSrc: 'road' }));
      } catch { /* keep straight-line progress */ }
    }
    if (useToward) list = list.filter(c => c.progressKm > 5);
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
      out.push({ ...c, roadKm, roadH: s / 3600, kwh, arrivalSoc: soc - kwh / trip.car.usableKwh * 100, whKm, visitedYear: visitedYear.has(c.site.id) });
    });
    out.sort((a, b) => (a.visitedYear - b.visitedYear) || (a.roadKm - b.roadKm));
    return out.slice(0, limit ?? S.candidates.limit);
  }

  /**
   * Greedy chain. Append mode (default): repeatedly add the nearest candidate toward the
   * destination, building real legs; raises the previous stop's charge target when a hop
   * needs more (adaptive). Insert mode (`beforeId`): insert intermediate chargers before the
   * given stop until it is reachable above the reserve — "fill the gap" to a too-far charger.
   */
  async function autoChain({ n = 5, targetSoc = null, toward = null, adaptive = true, onProgress = null, shouldStop = () => false, beforeId = null } = {}) {
    let added = 0;
    for (let k = 0; k < n; k++) {
      if (shouldStop()) break;
      const trip = store.trip;
      const S = trip.settings;
      const target = targetSoc ?? S.defaultTargetSoc;
      const idxT = beforeId == null ? -1 : trip.stops.findIndex(s => s.id === beforeId);
      if (beforeId != null && idxT < 0) break;
      const targetStop = idxT >= 0 ? trip.stops[idxT] : null;
      const tl0 = compute(trip);
      const originRes = targetStop ? (idxT > 0 ? tl0.stops[idxT - 1] : null) : (tl0.stops[tl0.stops.length - 1] || null);
      const origin = originRes ? originRes.stop : trip.start;
      const originSoc = originRes ? originRes.departSoc : +trip.start.soc;
      if (targetStop) {
        const tRes = tl0.stops[idxT];
        if (tRes.leg.status === 'ok' && tRes.arrivalSoc >= S.reserveSoc) break; // gap closed
      } else {
        const dest = trip.destination;
        if (dest && haversineM(origin.lat, origin.lng, dest.lat, dest.lng) < 30000) break;
      }
      const destOverride = targetStop ? { lat: targetStop.lat, lng: targetStop.lng } : null;
      let cands = await candidates({ from: origin, fromSoc: originSoc, toward: targetStop ? true : toward, destOverride, limit: 6 });
      if (!cands.length && targetStop) cands = await candidates({ from: origin, fromSoc: originSoc, toward: false, destOverride, limit: 6 });
      else if (!cands.length && (toward ?? S.candidates.toward) && trip.destination) cands = await candidates({ from: origin, fromSoc: originSoc, toward: false, limit: 6 }); // dead end: allow any new site
      let placed = false;
      for (const c of cands.slice(0, 4)) {
        if (c.arrivalSoc < S.reserveSoc - 15) continue;
        if (targetStop && c.site.id === targetStop.siteId) continue;
        const stop = newStop({ site: c.site, targetSoc: target });
        const insertAt = idxT >= 0 ? idxT : store.trip.stops.length;
        store.update(t => { t.stops.splice(insertAt, 0, stop); });
        const tl1 = compute(store.trip);
        const departTime = insertAt > 0 ? tl1.stops[insertAt - 1].depart : tl1.startTime;
        const leg = await buildLeg(origin, stop, { departTime });
        if (targetStop && leg.status === 'ok') {
          const tl2 = compute(store.trip);
          await buildLeg(stop, targetStop, { departTime: tl2.stops[insertAt].depart });
        }
        let res = compute(store.trip).stops[insertAt];
        if (leg.status === 'ok' && res.arrivalSoc < S.reserveSoc && adaptive) {
          const need = Math.min(100, Math.ceil(res.leg.kwh / store.trip.car.usableKwh * 100 + S.reserveSoc + 2));
          if (insertAt >= 1 && store.trip.stops[insertAt - 1].charge) store.update(t => { t.stops[insertAt - 1].charge.targetSoc = Math.max(t.stops[insertAt - 1].charge.targetSoc, need); });
          else if (insertAt === 0) store.update(t => { t.start.soc = Math.max(t.start.soc, need); });
          res = compute(store.trip).stops[insertAt];
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
