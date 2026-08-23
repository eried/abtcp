// OSRM routing: single route with full geometry + annotations, and distance tables.
import { createQueue, getJson } from './http.js';

const c6 = x => (+x).toFixed(6);
const trim = base => base.replace(/\/+$/, '');

export function routeUrl(base, a, b) {
  return `${trim(base)}/route/v1/driving/${c6(a.lng)},${c6(a.lat)};${c6(b.lng)},${c6(b.lat)}?overview=full&geometries=geojson&steps=true&annotations=true`;
}

export function tableUrl(base, from, dests) {
  const coords = [from, ...dests].map(p => `${c6(p.lng)},${c6(p.lat)}`).join(';');
  const di = dests.map((_, i) => i + 1).join(';');
  return `${trim(base)}/table/v1/driving/${coords}?sources=0&destinations=${di}&annotations=distance,duration`;
}

export function createOsrm({ baseUrl = 'https://router.project-osrm.org', fetchImpl = globalThis.fetch, queue = createQueue() } = {}) {
  const get = url => queue.run(() => getJson(url, { fetchImpl, okStatuses: [400] }));
  return {
    get baseUrl() { return baseUrl; },
    set baseUrl(v) { baseUrl = v; },
    /** Returns OSRM's first route: { distance, duration, geometry, legs[{steps, annotation}] }. */
    async route(a, b) {
      const j = await get(routeUrl(baseUrl, a, b));
      if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error(`OSRM ${j.code || 'error'}${j.message ? ': ' + j.message : ''}`);
      return j.routes[0];
    },
    /** Road distances (m) and durations (s) from `from` to each destination; null = unroutable. */
    async table(from, dests) {
      if (!dests.length) return { distances: [], durations: [] };
      const j = await get(tableUrl(baseUrl, from, dests));
      if (j.code !== 'Ok') throw new Error(`OSRM table ${j.code}${j.message ? ': ' + j.message : ''}`);
      return { distances: j.distances[0], durations: j.durations[0] };
    },
  };
}
