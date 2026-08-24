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

  let filtered = false;

  function setSites(sites, classify, popupFn) {
    popupHtml = popupFn || popupHtml;
    siteLayer.clearLayers();
    markers.clear();
    filtered = false;
    for (const s of sites) {
      const cls = classify(s);
      const m = L.circleMarker([s.lat, s.lng], { renderer, ...STYLE[cls] });
      m.setRadius(STYLE[cls].radius * radiusScale(map.getZoom()));
      m.bindPopup(() => popupHtml(s), { maxWidth: 300, autoPanPadding: [40, 40] });
      m.on('click', () => emit('siteClick', { site: s }));
      m.addTo(siteLayer);
      let pin = null;
      if (s.iconic) {
        pin = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'iconic-pin', html: '🏅', iconSize: [22, 22], iconAnchor: [11, 24] }), zIndexOffset: 800 });
        pin.bindTooltip(`🏅 ${s.iconic}`);
        pin.on('click', () => openSite(s.id));
        pin.addTo(siteLayer);
      }
      markers.set(s.id, { marker: m, pin, cls, site: s });
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

  const divIcon = (cls, label) => L.divIcon({ className: `stop-icon ${cls}`, html: `<span class="n">${label}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });

  const pct = x => Math.max(0, Math.min(100, x));

  function stopIcon(cls, label, batt, fanPx) {
    let bar = '';
    if (batt) {
      const lo = pct(Math.min(batt.arr, batt.dep));
      const w = pct(Math.abs(batt.dep - batt.arr));
      bar = `<span class="mini-batt" title="arrive ${Math.round(batt.arr)} % → leave ${Math.round(batt.dep)} %"><i class="${batt.cls || ''}" style="width:${pct(batt.arr)}%"></i><b class="${batt.dep < batt.arr ? 'd' : ''}" style="left:${lo}%;width:${w}%"></b></span>`;
    }
    return L.divIcon({ className: `stop-icon ${cls}`, html: `<span class="n">${label}</span>${bar}`, iconSize: [30, 34], iconAnchor: [15 - fanPx, 17] });
  }

  function setStops({ start, stops, destination }) {
    stopLayer.clearLayers();
    if (start) L.marker([start.lat, start.lng], { icon: divIcon('start', 'S'), zIndexOffset: 900 }).bindTooltip(start.name || 'Start').addTo(stopLayer);
    const seen = new Map();
    stops.forEach((s, i) => {
      const key = `${(+s.lat).toFixed(5)},${(+s.lng).toFixed(5)}`;
      const nth = seen.get(key) || 0;
      seen.set(key, nth + 1);
      const fanPx = [0, 1, -1, 2, -2][Math.min(nth, 4)] * 20; // repeat visits fan out sideways
      const m = L.marker([s.lat, s.lng], { icon: stopIcon(s.cls || '', String(i + 1), s.batt, fanPx), zIndexOffset: 1000 + i }).bindTooltip(s.tooltip || s.name);
      m.on('click', () => emit('stopClick', { siteId: s.siteId ?? null, index: i }));
      m.addTo(stopLayer);
    });
    if (destination) L.marker([destination.lat, destination.lng], { icon: divIcon('dest', 'D'), zIndexOffset: 950 }).bindTooltip(destination.name || 'Destination').addTo(stopLayer);
  }

  let lastCands = [];

  function setCandidates(cands) {
    lastCands = cands || [];
    candLayer.clearLayers();
    for (const c of lastCands) {
      if (currentFilter && !currentFilter(c.site)) continue; // no rings around filtered-out sites
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
    emit('siteAction', { act: b.dataset.act, siteId: Number(b.dataset.site), stopId: b.dataset.stop || null });
  });

  function panToShow(lat, lng) {
    map.setView([lat, lng], Math.max(map.getZoom(), 9));
  }

  /** Show only sites where fn(site) is true; null restores everything. Pins and candidate rings follow. */
  let currentFilter = null;
  function applyFilter(fn) {
    currentFilter = fn || null;
    if (!fn) {
      if (filtered) {
        for (const e of markers.values()) {
          if (!e.marker._map) e.marker.addTo(siteLayer);
          if (e.pin && !e.pin._map) e.pin.addTo(siteLayer);
        }
        filtered = false;
      }
      setCandidates(lastCands);
      return;
    }
    filtered = true;
    for (const e of markers.values()) {
      const show = fn(e.site);
      if (show && !e.marker._map) e.marker.addTo(siteLayer);
      else if (!show && e.marker._map) siteLayer.removeLayer(e.marker);
      if (e.pin) {
        if (show && !e.pin._map) e.pin.addTo(siteLayer);
        else if (!show && e.pin._map) siteLayer.removeLayer(e.pin);
      }
    }
    setCandidates(lastCands);
  }

  function pinsVisible() {
    let n = 0;
    for (const e of markers.values()) if (e.pin && e.pin._map) n++;
    return n;
  }

  function pinsTotal() {
    let n = 0;
    for (const e of markers.values()) if (e.pin) n++;
    return n;
  }

  function isVisible(id) {
    const e = markers.get(Number(id));
    return !!(e && e.marker._map);
  }

  function visibleCount() {
    let n = 0;
    for (const e of markers.values()) if (e.marker._map) n++;
    return n;
  }

  return { map, setTiles, setSites, restyle, setRoute, setStops, setCandidates, fitTo, openSite, panToShow, applyFilter, visibleCount, isVisible, pinsVisible, pinsTotal, on, closePopup: () => map.closePopup(), size: () => markers.size };
}
