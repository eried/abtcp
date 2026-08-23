// Open-Meteo elevation (Copernicus DEM 90 m), batched 100 points per call, cached by ~10 m cell.
import { getJson } from './http.js';

export const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';

export function elevationUrl(points) {
  return `${ELEVATION_URL}?latitude=${points.map(p => (+p.lat).toFixed(5)).join(',')}&longitude=${points.map(p => (+p.lng).toFixed(5)).join(',')}`;
}

export function createElevation({ fetchImpl = globalThis.fetch, cache = new Map(), batch = 100, queue = null } = {}) {
  const key = p => `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}`;
  const fetchBatch = url => queue ? queue.run(() => getJson(url, { fetchImpl })) : getJson(url, { fetchImpl });
  let calls = 0;
  return {
    cache,
    get calls() { return calls; },
    /** points: [{lat, lng}] → meters (same order). Throws if the service fails. */
    async sample(points) {
      const out = new Array(points.length);
      const byKey = new Map();
      points.forEach((p, i) => {
        const k = key(p);
        if (cache.has(k)) out[i] = cache.get(k);
        else if (!byKey.has(k)) byKey.set(k, p);
      });
      const keys = [...byKey.keys()];
      for (let s = 0; s < keys.length; s += batch) {
        const slice = keys.slice(s, s + batch);
        const j = await fetchBatch(elevationUrl(slice.map(k => byKey.get(k))));
        calls++;
        if (!j || !Array.isArray(j.elevation) || j.elevation.length !== slice.length) throw new Error('Elevation service returned unexpected data');
        slice.forEach((k, i) => cache.set(k, j.elevation[i]));
      }
      points.forEach((p, i) => { if (out[i] === undefined) out[i] = cache.get(key(p)); });
      return out;
    },
  };
}
