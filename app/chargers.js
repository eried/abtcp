// Charger database: loads data/chargers.json and answers nearest/search queries.
import { haversineM } from './model/geo.js';

export const USABLE_STATUSES = new Set(['OPEN', 'EXPANDING']);
export const STATUS_LABEL = {
  OPEN: 'open', EXPANDING: 'open (expanding)', CLOSED_TEMP: 'temporarily closed', CLOSED_PERM: 'permanently closed',
  CONSTRUCTION: 'under construction', PERMIT: 'permit', PLAN: 'planned', VOTING: 'voting',
};

export class ChargerDB {
  constructor(data) {
    this.generated = data.generated;
    this.source = data.source;
    this.sites = data.sites;
    this._byId = new Map(this.sites.map(s => [s.id, s]));
  }

  byId(id) { return this._byId.get(Number(id)); }

  isUsable(site) { return USABLE_STATUSES.has(site.status); }

  /** Nearest sites by great-circle distance. filter(site) → boolean; returns [{site, distM}]. */
  nearest(lat, lng, { n = 60, filter = null, maxM = Infinity } = {}) {
    const out = [];
    const latSpan = maxM === Infinity ? Infinity : maxM / 111000;
    for (const s of this.sites) {
      if (latSpan !== Infinity && Math.abs(s.lat - lat) > latSpan) continue;
      if (filter && !filter(s)) continue;
      const distM = haversineM(lat, lng, s.lat, s.lng);
      if (distM <= maxM) out.push({ site: s, distM });
    }
    out.sort((a, b) => a.distM - b.distM);
    return out.slice(0, n);
  }

  /** Case-insensitive name/city search, usable sites first. */
  search(q, n = 10) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const hits = [];
    for (const s of this.sites) {
      const hay = `${s.name} ${s.city || ''} ${s.country}`.toLowerCase();
      if (hay.includes(needle)) hits.push(s);
    }
    hits.sort((a, b) => (this.isUsable(b) - this.isUsable(a)) || a.name.localeCompare(b.name));
    return hits.slice(0, n);
  }
}

export async function loadChargers(url = 'data/chargers.json', fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`Could not load ${url}: HTTP ${r.status}`);
  return new ChargerDB(await r.json());
}
