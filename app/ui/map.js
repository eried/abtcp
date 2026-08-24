// Leaflet map: charger dots (canvas), route lines, numbered stops, candidate rings, popups.
/* global L */

export const TILES = {
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 },
  'carto-light': { name: 'CARTO light', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 19 },
  'carto-dark': { name: 'CARTO dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 19 },
};

const STYLE = {
  open: { color: '#ffffff', fillColor: '#e82127', radius: 4.5, weight: 1.2, fillOpacity: 0.95 },
  closed: { color: '#ffffff', fillColor: '#9ca3af', radius: 4, weight: 1, fillOpacity: 0.9 },
  planned: { color: '#e82127', fillColor: '#ffffff', radius: 3.5, weight: 1, fillOpacity: 0.9 },
  inTrip: { color: '#0f172a', fillColor: '#0f172a', radius: 5, weight: 1.5, fillOpacity: 1 },
  visited: { color: '#ffffff', fillColor: '#f59e0b', radius: 4.5, weight: 1.2, fillOpacity: 0.95 },
};

export function createMap({ el, tiles = 'osm', center = [62, 14], zoom = 4 }) {
  const map = L.map(el, { preferCanvas: true, worldCopyJump: true }).setView(center, zoom);
  let tileLayer = null;
  function setTiles(key) {
    const t = TILES[key] || TILES.osm;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(t.url, { attribution: t.attribution, maxZoom: t.maxZoom }).addTo(map);
  }
  setTiles(tiles);

  const renderer = L.canvas({ padding: 0.5, tolerance: 5 });
  const siteLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const candLayer = L.layerGroup().addTo(map);
  const stopLayer = L.layerGroup().addTo(map);
  const handlers = {};
  const on = (ev, fn) => { (handlers[ev] ||= []).push(fn); };
  const emit = (ev, data) => (handlers[ev] || []).forEach(fn => fn(data));
  const markers = new Map(); // site id → { marker, cls, site }
  let popupHtml = () => '';
  const radiusScale = z => (z >= 10 ? 1.6 : z >= 8 ? 1.35 : z >= 6 ? 1.1 : 1);
  const applyStyle = entry => {
    const st = STYLE[entry.cls];
    entry.marker.setStyle(st);
    entry.marker.setRadius(st.radius * radiusScale(map.getZoom()));
  };
  map.on('zoomend', () => { for (const entry of markers.values()) applyStyle(entry); });

  function setSites(sites, classify, popupFn) {
    popupHtml = popupFn || popupHtml;
    siteLayer.clearLayers();
    markers.clear();
    for (const s of sites) {
      const cls = classify(s);
      const m = L.circleMarker([s.lat, s.lng], { renderer, ...STYLE[cls] });
      m.setRadius(STYLE[cls].radius * radiusScale(map.getZoom()));
      m.bindPopup(() => popupHtml(s), { maxWidth: 300, autoPanPadding: [40, 40] });
      m.on('click', () => emit('siteClick', { site: s }));
      m.addTo(siteLayer);
      if (s.iconic) L.circleMarker([s.lat, s.lng], { renderer, radius: 8.5, color: '#eab308', weight: 2, fill: false, opacity: 0.95, interactive: false }).addTo(siteLayer);
      markers.set(s.id, { marker: m, cls, site: s });
    }
  }

  /** Re-classify existing dots without rebuilding them. */
  function restyle(classify) {
    for (const entry of markers.values()) {
      const cls = classify(entry.site);
      if (cls !== entry.cls) { entry.cls = cls; applyStyle(entry); }
    }
  }

  function setRoute(legs) {
    routeLayer.clearLayers();
    for (const leg of legs) {
      if (!leg.latlngs || leg.latlngs.length < 2) continue;
      L.polyline(leg.latlngs, { color: leg.color, weight: 4, opacity: 0.85, renderer, interactive: false }).addTo(routeLayer);
    }
  }

  const divIcon = (cls, label) => L.divIcon({ className: `stop-icon ${cls}`, html: `<span>${label}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });

  function setStops({ start, stops, destination }) {
    stopLayer.clearLayers();
    if (start) L.marker([start.lat, start.lng], { icon: divIcon('start', 'S'), zIndexOffset: 900 }).bindTooltip(start.name || 'Start').addTo(stopLayer);
    stops.forEach((s, i) => {
      const m = L.marker([s.lat, s.lng], { icon: divIcon(s.cls || '', String(i + 1)), zIndexOffset: 1000 + i }).bindTooltip(s.tooltip || s.name);
      m.on('click', () => emit('stopClick', { siteId: s.siteId ?? null, index: i }));
      m.addTo(stopLayer);
    });
    if (destination) L.marker([destination.lat, destination.lng], { icon: divIcon('dest', 'D'), zIndexOffset: 950 }).bindTooltip(destination.name || 'Destination').addTo(stopLayer);
  }

  function setCandidates(cands) {
    candLayer.clearLayers();
    for (const c of cands) {
      L.circleMarker([c.site.lat, c.site.lng], { renderer, radius: 10, color: '#2563eb', weight: 2, fill: false, opacity: 0.9, interactive: false }).addTo(candLayer);
    }
  }

  function fitTo(points) {
    const pts = points.filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 });
    else if (pts.length === 1) map.setView(pts[0], 8);
  }

  function openSite(id) {
    const e = markers.get(Number(id));
    if (!e) return;
    const ll = e.marker.getLatLng();
    if (!map.getBounds().contains(ll)) map.setView(ll, Math.max(map.getZoom(), 9));
    e.marker.openPopup();
  }

  map.on('click', e => emit('mapClick', { lat: e.latlng.lat, lng: e.latlng.lng }));
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    emit('siteAction', { act: b.dataset.act, siteId: Number(b.dataset.site) });
  });

  return { map, setTiles, setSites, restyle, setRoute, setStops, setCandidates, fitTo, openSite, on, closePopup: () => map.closePopup(), size: () => markers.size };
}
