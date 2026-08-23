// Geometry helpers: distances, bearings, OSRM route chunking. Pure, no DOM.

const R_EARTH = 6371000;
const D2R = Math.PI / 180;

export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLng = (lng2 - lng1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lng1, lat2, lng2) {
  const y = Math.sin((lng2 - lng1) * D2R) * Math.cos(lat2 * D2R);
  const x = Math.cos(lat1 * D2R) * Math.sin(lat2 * D2R) - Math.sin(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lng2 - lng1) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

/** Ferry intervals (cumulative meters along the route) from OSRM steps. */
export function ferryIntervals(steps) {
  const out = [];
  let cum = 0;
  for (const s of steps || []) {
    if (s.mode === 'ferry' && s.distance > 0) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.end - cum) < 1) { // contiguous ferry steps → one crossing
        last.end = cum + s.distance;
        last.seconds += s.duration;
      } else {
        out.push({ start: cum, end: cum + s.distance, seconds: s.duration, name: s.name || 'ferry' });
      }
    }
    cum += s.distance;
  }
  return out;
}

function ferryAt(ferries, midM) {
  for (const f of ferries) if (midM >= f.start && midM < f.end) return 1;
  return 0;
}

/**
 * Merge OSRM annotation segments into chunks of at least `minLen` meters that never mix
 * driving and ferry modes. Speeds are derived from summed distance / summed duration, which
 * removes the rounding noise of OSRM's 0.1 s durations on tiny segments.
 * coords: GeoJSON [[lng, lat], ...]; annotation: { distance[], duration[] }.
 */
export function chunkRoute(coords, annotation, ferries = [], minLen = 500) {
  const chunks = [];
  const n = Math.min(annotation.distance.length, coords.length - 1);
  let cum = 0;
  let cur = null;
  const close = () => {
    if (!cur || cur.d <= 0) { cur = null; return; }
    cur.t = Math.max(cur.t, cur.d / 40); // never faster than 144 km/h from rounding artefacts
    cur.v = cur.d / cur.t;
    cur.brg = Math.round(bearingDeg(cur.lat0, cur.lng0, cur.lat1, cur.lng1));
    chunks.push(cur);
    cur = null;
  };
  for (let i = 0; i < n; i++) {
    const d = annotation.distance[i];
    const t = annotation.duration[i];
    const mode = ferryAt(ferries, cum + d / 2);
    if (cur && cur.mode !== mode) close();
    if (!cur) cur = { d: 0, t: 0, v: 0, mode, brg: 0, lat0: coords[i][1], lng0: coords[i][0], lat1: coords[i][1], lng1: coords[i][0] };
    cur.d += d;
    cur.t += t;
    cur.lat1 = coords[i + 1][1];
    cur.lng1 = coords[i + 1][0];
    cum += d;
    if (cur.d >= minLen) close();
  }
  close();
  return chunks;
}

/** Compact array form stored in trip JSON: [d, t, v, mode, brg, lat0, lng0, elev0]. */
export function packChunk(c) {
  return [Math.round(c.d), Math.round(c.t * 10) / 10, Math.round(c.v * 100) / 100, c.mode, c.brg,
    Math.round(c.lat0 * 1e5) / 1e5, Math.round(c.lng0 * 1e5) / 1e5, Math.round(c.elev0 ?? 0)];
}

/** Inverse of packChunk; `next` is the following packed chunk or the route's `last` [lat,lng,elev]. */
export function unpackChunk(a, next) {
  return { d: a[0], t: a[1], v: a[2], mode: a[3], brg: a[4], lat0: a[5], lng0: a[6], elev0: a[7],
    lat1: next[5] ?? next[0], lng1: next[6] ?? next[1], elev1: next[7] ?? next[2] ?? a[7] };
}

/** Resolve the [lat, lng] polyline of a packed route (chunk starts + last point). */
export function routeLatLngs(route) {
  const pts = route.chunks.map(c => [c[5], c[6]]);
  if (route.last) pts.push([route.last[0], route.last[1]]);
  return pts;
}
