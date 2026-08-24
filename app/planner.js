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
      store.updateQuiet(t => { t.legs[key] = leg; }); // route cache: never an undo step
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
    store.updateQuiet(t => {
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
   * Try to keep an inserted stop: both legs must route, and every state of charge must stay
   * above the reserve without planning a charge above `cap` %. Returns false if it does not fit.
   */
  async function tryFit(a, b, stop, insertAt, cap, nextSocBefore = null) {
    const S = store.trip.settings;
    const usable = store.trip.car.usableKwh;
    const tl = compute(store.trip);
    const departTime = insertAt > 0 ? tl.stops[insertAt - 1].depart : tl.startTime;
    const leg1 = await buildLeg(a, stop, { departTime });
    if (leg1.status !== 'ok') return false;
    const tl2 = compute(store.trip);
    const leg2 = await buildLeg(stop, b, { departTime: tl2.stops[insertAt].depart });
    if (leg2.status !== 'ok') return false;

    let r = compute(store.trip).stops[insertAt];
    if (r.arrivalSoc < S.reserveSoc) {
      const need = Math.min(100, Math.ceil(r.leg.kwh / usable * 100 + S.reserveSoc + 2));
      if (need > cap) return false; // would need a slow, high-state-of-charge session before it
      if (insertAt >= 1 && store.trip.stops[insertAt - 1].charge) store.update(t => { t.stops[insertAt - 1].charge.targetSoc = Math.max(t.stops[insertAt - 1].charge.targetSoc, need); });
      else if (insertAt === 0) store.update(t => { t.start.soc = Math.max(+t.start.soc, need); });
      r = compute(store.trip).stops[insertAt];
      if (r.arrivalSoc < S.reserveSoc) return false;
    }

    const after = compute(store.trip);
    const next = after.stops[insertAt + 1] || after.destination;
    if (next && next.leg && next.leg.status === 'ok' && next.arrivalSoc < S.reserveSoc) {
      const needNext = Math.min(100, Math.ceil(next.leg.kwh / usable * 100 + S.reserveSoc + 2));
      if (needNext <= cap) store.update(t => { t.stops[insertAt].charge.targetSoc = Math.max(t.stops[insertAt].charge.targetSoc, needNext); });
      const check = compute(store.trip);
      const nr = check.stops[insertAt + 1] || check.destination;
      // Only reject when the insert BREAKS a hop that already worked. If the onward hop was
      // already out of reach we are mid-construction: comparing final arrivals is meaningless
      // (a 60 % top-up carries less energy than a full start), and the next rounds fill the rest.
      const nextWasFine = nextSocBefore != null && nextSocBefore >= S.reserveSoc;
      if (nr && nr.arrivalSoc < S.reserveSoc && nextWasFine) return false;
    }
    return true;
  }

  const nodesOf = trip => [trip.start, ...trip.stops, ...(trip.destination && trip.destination.lat != null ? [trip.destination] : [])];
  const nodeKeyAt = (nodes, i, trip) => (i === 0 ? 'start' : (trip.destination && i === nodes.length - 1 && nodes[i] === trip.destination) ? 'dest' : nodes[i].id);

  /** Road length of a gap; falls back to a straight-line estimate while it is unrouted. */
  function gapKm(a, b) {
    const leg = store.trip.legs[legKey(a, b)];
    if (leg && leg.status === 'ok') return leg.route.km;
    return haversineM(a.lat, a.lng, b.lat, b.lng) / 1000 * 1.25;
  }

  /** The point half way along the real route (straight-line midpoint if it is not routed yet). */
  function gapMidpoint(a, b) {
    const leg = store.trip.legs[legKey(a, b)];
    const chunks = leg && leg.status === 'ok' ? leg.route.chunks : null;
    if (chunks && chunks.length) {
      const total = chunks.reduce((sum, c) => sum + c[0], 0);
      let acc = 0;
      for (const c of chunks) {
        if (acc >= total / 2) return { lat: c[5], lng: c[6] }; // first chunk starting past halfway
        acc += c[0];
      }
      const last = leg.route.last;
      if (last) return { lat: last[0], lng: last[1] };
    }
    return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  }

  /** Points along the leg with their road distance from `a` (km). */
  function routeSamples(a, b) {
    const leg = store.trip.legs[legKey(a, b)];
    const chunks = leg && leg.status === 'ok' ? leg.route.chunks : null;
    if (!chunks || !chunks.length) {
      const straight = haversineM(a.lat, a.lng, b.lat, b.lng) / 1000 * 1.25;
      return [{ km: 0, lat: a.lat, lng: a.lng }, { km: straight / 2, lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, { km: straight, lat: b.lat, lng: b.lng }];
    }
    const out = [];
    let acc = 0;
    for (const c of chunks) {
      out.push({ km: acc / 1000, lat: c[5], lng: c[6] });
      acc += c[0];
    }
    const last = leg.route.last;
    if (last) out.push({ km: acc / 1000, lat: last[0], lng: last[1] });
    return out;
  }

  /**
   * Sites in a corridor along the route around `targetKm`, ranked by how little they lengthen
   * the leg and how close they land to the target. `maxReachKm` drops anything the car cannot
   * reach from `a` — the reason a naive midpoint search finds only unusable sites on long legs.
   */
  async function corridorCandidates(a, b, { targetKm, corridorKm, maxReachKm, limit = 6 }) {
    const trip = store.trip;
    const inTrip = new Set(trip.stops.map(x => x.siteId).filter(x => x != null));
    const visitedYear = new Set((trip.visitedBefore || []).map(Number));
    const samples = routeSamples(a, b);
    const total = samples.length ? samples[samples.length - 1].km : 0;
    const span = Math.max(90, targetKm * 0.45);
    const spacing = Math.max(12, corridorKm * 0.8);
    const picked = new Map();
    let lastKm = -1e9;
    for (const s of samples) {
      if (s.km < Math.max(8, targetKm - span) || s.km > Math.min(total - 8, targetKm + span)) continue;
      if (s.km - lastKm < spacing) continue;
      lastKm = s.km;
      for (const { site } of db.nearest(s.lat, s.lng, { n: 4, maxM: corridorKm * 1000, filter: x => db.isUsable(x) && !inTrip.has(x.id) })) {
        if (!picked.has(site.id)) picked.set(site.id, site);
      }
      if (picked.size >= 32) break;
    }
    if (!picked.size) return [];
    const sites = [...picked.values()];
    const [fromA, fromB, base] = await Promise.all([osrm.table(a, sites), osrm.table(b, sites), osrm.table(a, [b])]);
    const baseKm = base.distances[0] != null ? base.distances[0] / 1000 : null;
    if (baseKm == null) return [];
    const out = [];
    sites.forEach((site, i) => {
      const d1 = fromA.distances[i];
      const d2 = fromB.distances[i];
      if (d1 == null || d2 == null) return;
      const fromAKm = d1 / 1000;
      const detourKm = Math.max(0, (d1 + d2) / 1000 - baseKm);
      if (detourKm > corridorKm) return;
      if (maxReachKm && fromAKm > maxReachKm) return; // cannot be reached on this charge
      const offTargetKm = Math.abs(fromAKm - targetKm);
      out.push({ site, detourKm, fromAKm, offTargetKm, visitedYear: visitedYear.has(site.id), score: detourKm + offTargetKm * 0.08 });
    });
    out.sort((x, y) => (x.visitedYear - y.visitedYear) || (x.score - y.score));
    return out.slice(0, limit);
  }

  /**
   * Insert the best site into one gap. The target is the midpoint when the whole gap fits in one
   * charge, otherwise the furthest point the car can still reach — so a leg far beyond the range
   * is filled from the start outwards until it is drivable, and only then subdivided.
   */
  async function fillOneGap(insertAt, a, b, shouldStop, tl) {
    const S = store.trip.settings;
    const cap = S.maxChargeSoc ?? 90;
    const f = S.fill || {};
    const startKm = f.startDetourKm ?? 10;
    const maxKm = f.maxDetourKm ?? 60;
    const gapTotal = gapKm(a, b);
    const socA = insertAt === 0 ? +store.trip.start.soc : ((tl.stops[insertAt - 1] || {}).departSoc ?? +store.trip.start.soc);
    const whKm = averageWhKm(tl, store.trip);
    const rangeKm = Math.max(40, (socA - S.reserveSoc) / 100 * store.trip.car.usableKwh / (whKm / 1000));
    const targetKm = Math.min(gapTotal / 2, rangeKm * 0.85);
    const maxReachKm = rangeKm * 0.97;

    for (let corridor = startKm; ; corridor = Math.min(corridor * 2, maxKm)) {
      if (shouldStop()) return null;
      const cands = await corridorCandidates(a, b, { targetKm, corridorKm: corridor, maxReachKm });
      for (const c of cands) {
        if (shouldStop()) return null;
        const prevId = insertAt >= 1 ? store.trip.stops[insertAt - 1].id : null;
        const prevTarget = prevId ? (store.trip.stops[insertAt - 1].charge || {}).targetSoc ?? null : null;
        const startSoc = +store.trip.start.soc;
        const before = compute(store.trip);
        const nextSocBefore = (before.stops[insertAt] || before.destination || {}).arrivalSoc ?? null;
        const stop = newStop({ site: c.site, targetSoc: S.defaultTargetSoc });
        store.update(t => { t.stops.splice(insertAt, 0, stop); });
        if (await tryFit(a, b, stop, insertAt, cap, nextSocBefore)) return { stop, ...c };
        store.update(t => { // undo the trial, including any charge raise it applied
          t.stops = t.stops.filter(x => x.id !== stop.id);
          if (prevId && prevTarget != null) {
            const ps = t.stops.find(x => x.id === prevId);
            if (ps && ps.charge) ps.charge.targetSoc = prevTarget;
          }
          t.start.soc = startSoc;
        });
      }
      if (corridor >= maxKm) return null;
    }
  }

  /**
   * Fill ONE leg with extra Superchargers, most useful position first: each round picks the
   * longest remaining sub-gap inside the leg and inserts near its midpoint, so stops land at the
   * middle, then the quarters, then the eighths — never bunched at the start of the trip. The
   * detour budget starts small and only widens when nothing fits. Bounded per run (`maxAdds`);
   * call it again to go deeper, which is then an easier problem between two closer stops.
   */
  async function fillLeg({ gapIndex, maxAdds = null, onProgress = null, shouldStop = () => false } = {}) {
    const trip0 = store.trip;
    const nodes0 = nodesOf(trip0);
    if (gapIndex == null || gapIndex < 0 || gapIndex + 1 >= nodes0.length) return 0;
    const aKey = nodeKeyAt(nodes0, gapIndex, trip0);
    const bKey = nodeKeyAt(nodes0, gapIndex + 1, trip0);
    const perRun = maxAdds ?? (trip0.settings.fill && trip0.settings.fill.perRun) ?? 3;
    const hardCap = Math.max(perRun, 14); // a leg far beyond one charge may need several stops
    const exhausted = new Set();
    let added = 0;

    while (added < hardCap && !shouldStop()) {
      const trip = store.trip;
      const nodes = nodesOf(trip);
      const indexOfKey = key => (key === 'start' ? 0 : key === 'dest' ? nodes.length - 1 : nodes.findIndex(n => n.id === key));
      const ai = indexOfKey(aKey);
      const bi = indexOfKey(bKey);
      if (ai < 0 || bi < 0 || bi <= ai) break;

      const tl = compute(trip);
      const reserve = trip.settings.reserveSoc;
      const arrivalAt = j => (j === 0 ? +trip.start.soc : (j === nodes.length - 1 && nodes[j] === trip.destination ? (tl.destination ? tl.destination.arrivalSoc : 100) : (tl.stops[j - 1] || {}).arrivalSoc ?? 100));
      const gaps = [];
      let undrivable = false;
      for (let i = ai; i < bi; i++) {
        const reachable = arrivalAt(i + 1) >= reserve;
        if (!reachable) undrivable = true;
        const key = `${nodeKeyAt(nodes, i, trip)}>${nodeKeyAt(nodes, i + 1, trip)}`;
        if (exhausted.has(key)) continue;
        gaps.push({ insertAt: i, a: nodes[i], b: nodes[i + 1], km: gapKm(nodes[i], nodes[i + 1]), reachable, key });
      }
      // A leg the car cannot drive yet keeps being filled past the per-click budget; once every
      // hop is reachable, one click adds `perRun` extra sites and stops.
      if (added >= perRun && !undrivable) break;
      if (!gaps.length) break;
      // unreachable stretches first, then the longest ones
      gaps.sort((x, y) => (x.reachable - y.reachable) || (y.km - x.km));

      let placed = null;
      for (const g of gaps) {
        placed = await fillOneGap(g.insertAt, g.a, g.b, shouldStop, tl);
        if (placed) break;
        exhausted.add(g.key); // nothing fits here even at the widest detour
      }
      if (!placed) break;
      added++;
      if (onProgress) onProgress(added, Math.max(perRun, added), placed.stop, placed);
    }
    pruneLegs();
    return added;
  }

  return { buildLeg, ensureLegs, pruneLegs, candidates, fillLeg, gapKm, gapMidpoint, routeSamples, corridorCandidates, averageWhKm };
}
