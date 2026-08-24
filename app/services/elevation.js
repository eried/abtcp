// Elevation samples along a route. Primary: Valhalla `/height` on the FOSSGIS OSM demo server
// (hundreds of points per call, CORS). Fallback: Open-Meteo elevation (100 points per call —
// note Open-Meteo weights multi-coordinate calls as many calls, so bursts hit its 600/min limit).
// Results are cached by ~10 m cell.
import { getJson } from './http.js';

export const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
export const VALHALLA_HEIGHT_URL = 'https://valhalla1.openstreetmap.de/height';

export function elevationUrl(points) {
  return `${ELEVATION_URL}?latitude=${points.map(p => (+p.lat).toFixed(5)).join(',')}&longitude=${points.map(p => (+p.lng).toFixed(5)).join(',')}`;
}

export function valhallaBody(points) {
  return JSON.stringify({ shape: points.map(p => ({ lat: +(+p.lat).toFixed(5), lon: +(+p.lng).toFixed(5) })), range: false });
}

export function createElevation({ fetchImpl = globalThis.fetch, cache = new Map(), batch = 100, valhallaBatch = 300, queue = null, valhallaUrl = VALHALLA_HEIGHT_URL, openMeteoUrl = ELEVATION_URL } = {}) {
  const key = p => `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}`;
  const run = fn => (queue ? queue.run(fn) : fn());
  let calls = 0;
  let lastProvider = null;

  async function viaValhalla(pts) {
    const out = [];
    for (let s = 0; s < pts.length; s += valhallaBatch) {
      const slice = pts.slice(s, s + valhallaBatch);
      // text/plain keeps the POST a "simple" CORS request (no preflight); Valhalla parses the body as JSON anyway.
      const j = await run(() => getJson(valhallaUrl, { fetchImpl, method: 'POST', body: valhallaBody(slice), headers: { 'Content-Type': 'text/plain' }, retries: 0 }));
      calls++;
      if (!j || !Array.isArray(j.height) || j.height.length !== slice.length) throw new Error('Valhalla height returned unexpected data');
      for (const h of j.height) out.push(h == null ? 0 : h);
    }
    return out;
  }

  async function viaOpenMeteo(pts) {
    const out = [];
    for (let s = 0; s < pts.length; s += batch) {
      const slice = pts.slice(s, s + batch);
      const j = await run(() => getJson(openMeteoUrl + elevationUrl(slice).slice(ELEVATION_URL.length), { fetchImpl }));
      calls++;
      if (!j || !Array.isArray(j.elevation) || j.elevation.length !== slice.length) throw new Error('Elevation service returned unexpected data');
      for (const h of j.elevation) out.push(h == null ? 0 : h);
    }
    return out;
  }

  return {
    cache,
    get calls() { return calls; },
    get lastProvider() { return lastProvider; },
    /** points: [{lat, lng}] → meters (same order). Throws if every provider fails. */
    async sample(points) {
      const out = new Array(points.length);
      const byKey = new Map();
      points.forEach((p, i) => {
        const k = key(p);
        if (cache.has(k)) out[i] = cache.get(k);
        else if (!byKey.has(k)) byKey.set(k, p);
      });
      const keys = [...byKey.keys()];
      if (keys.length) {
        const pts = keys.map(k => byKey.get(k));
        let heights = null;
        if (valhallaUrl) {
          try { heights = await viaValhalla(pts); lastProvider = 'valhalla'; } catch { heights = null; }
        }
        if (!heights) { heights = await viaOpenMeteo(pts); lastProvider = 'open-meteo'; }
        keys.forEach((k, i) => cache.set(k, heights[i]));
      }
      points.forEach((p, i) => { if (out[i] === undefined) out[i] = cache.get(key(p)); });
      return out;
    },
  };
}
