// Place search: Photon (komoot) first, Nominatim as fallback. Both are free and CORS-enabled;
// keep requests rare (debounce in the UI, ≤ 1 request/second).
import { getJson } from './http.js';

export const PHOTON_URL = 'https://photon.komoot.io/api/';
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export async function geocode(q, { fetchImpl = globalThis.fetch, limit = 6 } = {}) {
  const query = (q || '').trim();
  if (!query) return [];
  try {
    const j = await getJson(`${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=${limit}`, { fetchImpl, retries: 0 });
    const out = (j.features || []).filter(f => f.geometry && f.geometry.coordinates).map(f => {
      const p = f.properties || {};
      const name = [p.name, p.city && p.city !== p.name ? p.city : null, p.country].filter(Boolean).join(', ');
      return { name: name || `${f.geometry.coordinates[1]}, ${f.geometry.coordinates[0]}`, lat: +f.geometry.coordinates[1], lng: +f.geometry.coordinates[0] };
    });
    if (out.length) return out;
  } catch { /* fall back */ }
  const j = await getJson(`${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=jsonv2&limit=${limit}`, { fetchImpl, retries: 0 });
  return (Array.isArray(j) ? j : []).map(r => ({ name: r.display_name, lat: +r.lat, lng: +r.lon }));
}
