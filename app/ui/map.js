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
  inTrip: { color: '#ffffff', fillColor: '#16a34a', radius: 5.5, weight: 1.5, fillOpacity: 1 },
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
  const hlLayer = L.layerGroup().addTo(map);
  const hintLayer = L.layerGroup().addTo(map);
  const leaderLayer = L.layerGroup().addTo(map);
  const pendingLayer = L.layerGroup().addTo(map);
  let replaceAnchor = null;
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

  // ---- floating hover actions -------------------------------------------------------
  const actionsEl = document.createElement('div');
  actionsEl.id = 'map-actions';
  actionsEl.className = 'map-actions';
  actionsEl.hidden = true;
  el.appendChild(actionsEl);
  let hoverTimer = null;
  let actionCtx = {};

  function showActions(pt, items, ctx, kind) {
    actionsEl.innerHTML = items.map(it => `<button data-act="${it.act}" title="${it.title || ''}">${it.label}</button>`).join('');
    actionCtx = ctx || {};
    actionsEl.dataset.kind = kind;
    actionsEl.hidden = false;
    const r = el.getBoundingClientRect();
    const w = actionsEl.offsetWidth;
    const h = actionsEl.offsetHeight;
    actionsEl.style.left = `${Math.max(4, Math.min(r.width - w - 4, pt.x - w / 2))}px`;
    actionsEl.style.top = `${Math.max(4, pt.y - h - 14)}px`;
  }

  function hideActions(delay = 260) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { actionsEl.hidden = true; actionsEl.dataset.kind = ''; actionsEl.dataset.leg = ''; }, delay);
  }

  actionsEl.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  actionsEl.addEventListener('mouseleave', () => hideActions(120));
  actionsEl.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    actionsEl.hidden = true;
    emit('mapAction', { act: b.dataset.act, ...actionCtx });
  });

  const hoverActions = (latlng, items, ctx, kind) => {
    clearTimeout(hoverTimer);
    showActions(map.latLngToContainerPoint(latlng), items, ctx, kind);
  };

  // Route traces are not interactive (they would swallow clicks meant for the dots), so leg
  // hovering is done by measuring the pointer against a decimated projection of each leg.
  let legPts = [];
  let lastLegs = [];
  function rebuildLegPts() {
    legPts = [];
    for (const leg of lastLegs) {
      if (!leg.latlngs || leg.latlngs.length < 2) continue;
      const step = Math.max(1, Math.floor(leg.latlngs.length / 160));
      const pts = [];
      for (let k = 0; k < leg.latlngs.length; k += step) {
        const p = map.latLngToContainerPoint(leg.latlngs[k]);
        pts.push([p.x, p.y]);
      }
      const last = map.latLngToContainerPoint(leg.latlngs[leg.latlngs.length - 1]);
      pts.push([last.x, last.y]);
      legPts.push({ index: leg.index, pts });
    }
  }
  map.on('moveend zoomend', () => { rebuildLegPts(); declutterStops(); });

  const distToSeg = (px, py, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    let t = len ? ((px - a[0]) * dx + (py - a[1]) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  };

  map.on('mousemove', e => {
    if (!legPts.length) return;
    if (!actionsEl.hidden && actionsEl.dataset.kind !== 'leg') return; // a marker owns the bar
    const p = e.containerPoint;
    let best = null;
    for (const L of legPts) {
      for (let k = 1; k < L.pts.length; k++) {
        const d = distToSeg(p.x, p.y, L.pts[k - 1], L.pts[k]);
        if (d < 12 && (!best || d < best.d)) best = { d, index: L.index };
      }
    }
    if (best) {
      // Anchor the bar where it first appears: repositioning on every move makes it flee the pointer.
      if (actionsEl.hidden || actionsEl.dataset.kind !== 'leg' || actionsEl.dataset.leg !== String(best.index)) {
        showActions({ x: p.x, y: p.y }, [{ act: 'fill', label: '⊕ Fill this leg', title: 'Insert more Superchargers into this leg (detour and charge limits apply)' }], { legIndex: best.index }, 'leg');
        actionsEl.dataset.leg = String(best.index);
      } else {
        clearTimeout(hoverTimer); // same leg: keep it where it is
      }
    } else if (actionsEl.dataset.kind === 'leg') {
      hideActions(600); // time to travel from the trace up to the buttons
    }
  });

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
      m.on('click', () => { hideActions(0); emit('siteClick', { site: s }); });
      m.on('mouseover', () => {
        if (replaceAnchor) {
          replaceHint(m.getLatLng());
          hoverActions(m.getLatLng(), [{ act: 'replace-with', label: '⇄', title: `Replace the selected stop with ${s.name}` }], { siteId: s.id }, 'site');
          return;
        }
        if (!inTripIds.has(s.id)) hoverActions(m.getLatLng(), [{ act: 'add', label: '＋', title: `Add ${s.name} as the next stop` }], { siteId: s.id }, 'site');
      });
      m.on('mouseout', () => { if (replaceAnchor) hintLayer.clearLayers(); if (actionsEl.dataset.kind === 'site') hideActions(); });
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
    lastLegs = legs.map((leg, i) => ({ ...leg, index: leg.index ?? i }));
    for (const leg of legs) {
      if (!leg.latlngs || leg.latlngs.length < 2) continue;
      L.polyline(leg.latlngs, { color: leg.color, weight: 4, opacity: 0.85, renderer, interactive: false }).addTo(routeLayer);
    }
    rebuildLegPts();
  }

  const pct = x => Math.max(0, Math.min(100, x));

  function stopIcon(cls, label, batt, offset = [0, 0], pass = 0) {
    const [dx, dy] = Array.isArray(offset) ? offset : [offset, 0];
    let bar = '';
    if (batt) {
      const lo = pct(Math.min(batt.arr, batt.dep));
      const w = pct(Math.abs(batt.dep - batt.arr));
      bar = `<span class="mini-batt" title="arrive ${Math.round(batt.arr)} % → leave ${Math.round(batt.dep)} %"><i class="${batt.cls || ''}" style="width:${pct(batt.arr)}%"></i><b class="${batt.dep < batt.arr ? 'd' : ''}" style="left:${lo}%;width:${w}%"></b></span>`;
    }
    const chip = pass > 0 ? `<span class="pass" title="pass ${pass} at this site">${pass}</span>` : '';
    return L.divIcon({ className: `stop-icon ${cls}`, html: `<span class="n">${label}</span>${bar}${chip}`, iconSize: [38, 40], iconAnchor: [19 - dx, 14 - dy] });
  }

  const inTripIds = new Set();

  let stopMarkers = [];

  const OFFSETS = [[0, 0], [30, -4], [-30, -4], [0, -34], [30, 26], [-30, 26], [0, 38], [52, 10], [-52, 10], [52, -26], [-52, -26]];

  /** Keep badges legible when stops (or nearby chargers) crowd the same pixels. */
  function declutterStops() {
    if (!stopMarkers.length) return;
    leaderLayer.clearLayers();
    const used = [];
    for (const sm of stopMarkers) {
      const p = map.latLngToContainerPoint(sm.latlng);
      let chosen = OFFSETS[0];
      for (const off of OFFSETS) {
        const c = { x: p.x + off[0], y: p.y + off[1] };
        if (used.every(u => Math.hypot(u.x - c.x, u.y - c.y) > 36)) { chosen = off; break; }
      }
      used.push({ x: p.x + chosen[0], y: p.y + chosen[1] });
      sm.marker.setIcon(stopIcon(sm.cls, sm.label, sm.batt, chosen, sm.pass));
      if (chosen[0] || chosen[1]) { // leader line so an offset badge still points at its site
        const to = map.containerPointToLatLng([p.x + chosen[0], p.y + chosen[1] + 10]);
        L.polyline([sm.latlng, to], { color: '#94a3b8', weight: 1, opacity: 0.8, interactive: false, renderer }).addTo(leaderLayer);
      }
    }
  }

  function setStops({ start, stops, destination }) {
    stopLayer.clearLayers();
    leaderLayer.clearLayers();
    stopMarkers = [];
    inTripIds.clear();
    for (const s of stops) if (s.siteId != null) inTripIds.add(s.siteId);
    if (start) L.marker([start.lat, start.lng], { icon: stopIcon('start', 'S', start.batt, [0, 0]), zIndexOffset: 900 }).bindTooltip(start.name || 'Start').addTo(stopLayer);
    const keyOf = s => `${(+s.lat).toFixed(5)},${(+s.lng).toFixed(5)}`;
    const totals = new Map();
    for (const s of stops) totals.set(keyOf(s), (totals.get(keyOf(s)) || 0) + 1);
    const seen = new Map();
    stops.forEach((s, i) => {
      const key = keyOf(s);
      const nth = seen.get(key) || 0;
      seen.set(key, nth + 1);
      const pass = (totals.get(key) || 1) > 1 ? nth + 1 : 0;
      const m = L.marker([s.lat, s.lng], { icon: stopIcon(s.cls || '', String(i + 1), s.batt, [0, 0], pass), zIndexOffset: 1000 + i }).bindTooltip(s.tooltip || s.name);
      stopMarkers.push({ marker: m, latlng: L.latLng(s.lat, s.lng), cls: s.cls || '', label: String(i + 1), batt: s.batt, pass });
      m.on('click', () => emit('stopClick', { siteId: s.siteId ?? null, index: i }));
      m.on('mouseover', () => hoverActions(m.getLatLng(), [
        { act: 'replace', label: '⇄', title: 'Replace this charger with another site' },
        { act: 'remove', label: '✕', title: 'Remove this stop' },
      ], { stopId: s.id, index: i }, 'stop'));
      m.on('mouseout', () => { if (actionsEl.dataset.kind === 'stop') hideActions(); });
      m.addTo(stopLayer);
    });
    if (destination) L.marker([destination.lat, destination.lng], { icon: stopIcon('dest', 'D', destination.batt, [0, 0]), zIndexOffset: 950 }).bindTooltip(destination.name || 'Destination').addTo(stopLayer);
    declutterStops();
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

  /** Ring a site while the pointer hovers its row in the sidebar; null clears. */
  function highlight(id) {
    hlLayer.clearLayers();
    if (id == null) return;
    const e = markers.get(Number(id));
    if (!e) return;
    const ll = e.marker.getLatLng();
    L.circleMarker(ll, { renderer, radius: 14, color: '#facc15', weight: 3, fill: false, opacity: 1, interactive: false }).addTo(hlLayer);
    L.circleMarker(ll, { renderer, radius: 7, color: '#facc15', weight: 2, fill: false, opacity: 0.8, interactive: false }).addTo(hlLayer);
  }

  function highlightCount() { return hlLayer.getLayers().length; }

  /** While replacing a stop, hovering another site draws an animated dashed hint from it. */
  function setReplaceMode(latlng) {
    replaceAnchor = latlng || null;
    if (!replaceAnchor) hintLayer.clearLayers();
    el.classList.toggle('replacing', !!replaceAnchor);
  }

  function replaceHint(latlng) {
    hintLayer.clearLayers();
    if (!replaceAnchor || !latlng) return;
    L.polyline([[replaceAnchor.lat, replaceAnchor.lng], [latlng.lat, latlng.lng]], { color: '#3b82f6', weight: 2.5, dashArray: '8 8', className: 'replace-hint', interactive: false, renderer: L.svg() }).addTo(hintLayer);
  }

  function hintCount() { return hintLayer.getLayers().length; }

  /** Straight placeholder between two points while its road route is being fetched. */
  function setPending(items) {
    pendingLayer.clearLayers();
    for (const it of items || []) {
      const failed = it.kind === 'failed';
      L.polyline([[it.from.lat, it.from.lng], [it.to.lat, it.to.lng]], {
        color: failed ? '#dc2626' : '#60a5fa', weight: 2.5, dashArray: '10 10', opacity: 0.95,
        className: failed ? 'failed-leg' : 'pending-leg', interactive: false, renderer: L.svg(),
      }).addTo(pendingLayer);
    }
  }

  function pendingCount() { return pendingLayer.getLayers().length; }

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

  return { map, setTiles, setSites, restyle, setRoute, setStops, setCandidates, fitTo, openSite, panToShow, applyFilter, highlight, highlightCount, setReplaceMode, hintCount, setPending, pendingCount, visibleCount, isVisible, pinsVisible, pinsTotal, hideActions, on, closePopup: () => map.closePopup(), size: () => markers.size };
}
