// Bootstrap: load the charger DB, restore the trip, wire services, map, sidebar and settings.
import { loadChargers, applyIconic, USABLE_STATUSES, STATUS_LABEL } from './chargers.js';
import { createStore, deserialize, serialize } from './state.js';
import { compute, legKey } from './model/timeline.js';
import { routeLatLngs, haversineM } from './model/geo.js';
import { quickWhKm } from './model/energy.js';
import { createQueue } from './services/http.js';
import { createOsrm } from './services/osrm.js';
import { createElevation } from './services/elevation.js';
import { weatherAt } from './services/weather.js';
import { geocode } from './services/geocode.js';
import { createPlanner } from './planner.js';
import { createMap } from './ui/map.js';
import { createSidebar } from './ui/sidebar.js';
import { renderItinerary } from './ui/itinerary.js';
import { renderSettings, bindSettings } from './ui/settings.js';
import { createToast } from './ui/toast.js';
import { fmt, esc, slug } from './ui/format.js';

const $ = id => document.getElementById(id);

async function main() {
  const toast = createToast($('toast'));
  const setStatus = msg => { $('status').textContent = msg || ''; };
  const store = createStore();
  const restored = store.load();

  setStatus('Loading Supercharger database…');
  let db;
  try {
    db = await loadChargers('data/chargers.json');
  } catch (e) {
    toast.error(`Could not load the charger database: ${e.message}`);
    setStatus('No database');
    return;
  }
  try {
    const ir = await fetch('data/iconic.json');
    if (ir.ok) applyIconic(db, await ir.json());
  } catch { /* the iconic list is optional */ }
  setStatus('');

  const routeQueue = createQueue({ maxConcurrent: 3, spacingMs: 150 });
  const osrm = createOsrm({ baseUrl: store.trip.settings.osrmUrl, queue: routeQueue });
  const elevation = createElevation({ queue: createQueue({ maxConcurrent: 2, spacingMs: 100 }) });
  const weatherQueue = createQueue({ maxConcurrent: 2, spacingMs: 100 });
  const planner = createPlanner({ store, db, osrm, elevation, weatherAt: args => weatherAt({ ...args, queue: weatherQueue }) });

  const map = createMap({ el: $('map'), tiles: store.trip.settings.tiles });
  const sidebar = createSidebar({ el: $('panel-trip'), store, db, planner, geocode, map, toast, setStatus });

  // ---------- map filter chips ----------
  const filterBar = document.createElement('div');
  filterBar.id = 'map-filters';
  filterBar.innerHTML = '<button class="chip" id="chip-reach" title="Only sites the car can reach right now from the end of the plan (straight-line estimate, keeping the reserve)">⚡ reachable</button><button class="chip" id="chip-iconic" title="Only Iconic Charger badge sites">🏅 iconic</button>';
  $('map').appendChild(filterBar);
  ['dblclick', 'mousedown'].forEach(ev => filterBar.addEventListener(ev, e => e.stopPropagation()));
  const mapFilters = { reach: false, iconic: false };
  let filterSig = '';
  function applyMapFilters() {
    if (!mapFilters.reach && !mapFilters.iconic) { map.applyFilter(null); return; }
    const t = store.trip;
    let head = t.start;
    let soc = +t.start.soc;
    let temp = 10;
    if (lastTl && lastTl.stops.length) {
      const last = lastTl.stops[lastTl.stops.length - 1];
      head = last.stop;
      soc = last.departSoc;
      if (last.leg.temp != null) temp = last.leg.temp;
    }
    const rangeM = Math.max(0, soc - t.settings.reserveSoc) / 100 * t.car.usableKwh / (quickWhKm(t.car, temp, t.settings.marginPct) / 1000) / 1.25 * 1000;
    map.applyFilter(site => {
      if (inTrip.has(site.id)) return true;
      if (mapFilters.iconic && !site.iconic) return false;
      if (mapFilters.reach && haversineM(head.lat, head.lng, site.lat, site.lng) > rangeM) return false;
      return true;
    });
  }
  filterBar.addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('.chip');
    if (!b) return;
    const k = b.id === 'chip-reach' ? 'reach' : 'iconic';
    mapFilters[k] = !mapFilters[k];
    b.classList.toggle('active', mapFilters[k]);
    applyMapFilters();
  });

  // ---------- map sites ----------
  const classify = site => {
    const t = store.trip;
    if (inTrip.has(site.id)) return 'inTrip';
    if (visitedSet.has(site.id)) return 'visited';
    if (site.status === 'CLOSED_TEMP') return 'closed';
    if (!USABLE_STATUSES.has(site.status)) return 'planned';
    return 'open';
  };
  let inTrip = new Set();
  let visitedSet = new Set();
  const popupHtml = site => {
    const t = store.trip;
    const inStops = t.stops.map((s, i) => ({ s, i })).filter(x => x.s.siteId === site.id);
    const isIn = inStops.length > 0;
    const visited = (t.visitedBefore || []).includes(site.id);
    return `<div class="popup"><b>${site.iconic ? '🏅 ' : ''}${esc(site.name)}</b>
      <div class="meta">${esc(STATUS_LABEL[site.status] || site.status)} · ${site.stalls} stalls · ${site.kw || '?'} kW${site.gen ? ` · ${site.gen.toUpperCase()}` : ''}${site.opened ? ` · opened ${esc(site.opened)}` : ''}</div>
      ${site.iconic ? `<div class="meta">🏅 Iconic charger badge: ${esc(site.iconic)}</div>` : ''}
      ${site.tid ? `<a href="https://www.tesla.com/findus/location/supercharger/${encodeURIComponent(site.tid)}" target="_blank" rel="noopener">tesla.com ↗</a>` : ''}
      <div class="popup-actions">
        <button data-act="add" data-site="${site.id}" class="primary">${isIn ? 'Add again (repeat, for charge only)' : 'Add as next stop'}</button>
        ${inStops.map(x => `<button data-act="removeStop" data-site="${site.id}" data-stop="${esc(x.s.id)}">Remove stop #${x.i + 1}</button>`).join('')}
        <button data-act="visited" data-site="${site.id}" title="Affects the yearly unique-sites counter and suggestion order">${visited ? 'Unmark visited this year' : 'Visited earlier this year'}</button>
      </div></div>`;
  };
  function loadSites() {
    const show = new Set(store.trip.settings.showStatuses);
    map.setSites(db.sites.filter(s => show.has(s.status)), classify, popupHtml);
    if (mapFilters.reach || mapFilters.iconic) applyMapFilters();
  }
  loadSites();

  map.on('stopClick', ({ siteId }) => { if (siteId != null) map.openSite(siteId); });
  map.on('siteAction', ({ act, siteId, stopId }) => {
    const site = db.byId(siteId);
    if (!site) return;
    if (act === 'add') sidebar.addStop(site);
    else if (act === 'removeStop' && stopId) { sidebar.removeStop(stopId); map.closePopup(); }
    else if (act === 'visited') {
      store.update(t => { const set = new Set(t.visitedBefore); if (set.has(site.id)) set.delete(site.id); else set.add(site.id); t.visitedBefore = [...set]; });
      map.closePopup();
    }
  });

  // ---------- settings ----------
  const settingsEl = $('panel-settings');
  const paintSettings = () => renderSettings(settingsEl, store.trip, db);
  bindSettings(settingsEl, store, {
    onTiles: key => map.setTiles(key),
    onOsrmUrl: url => { osrm.baseUrl = url; },
    onStatuses: () => loadSites(),
    onCandidates: () => sidebar.refreshCandidates(true),
    rerender: paintSettings,
  });

  // ---------- tabs ----------
  const tabs = { trip: $('tab-trip'), settings: $('tab-settings'), help: $('tab-help') };
  const panels = { trip: $('panel-trip'), settings: settingsEl, help: $('panel-help') };
  function showTab(name) {
    for (const k of Object.keys(tabs)) {
      tabs[k].classList.toggle('active', k === name);
      tabs[k].setAttribute('aria-selected', String(k === name));
      panels[k].hidden = k !== name;
    }
    if (name === 'settings') paintSettings();
  }
  Object.entries(tabs).forEach(([k, b]) => b.addEventListener('click', () => showTab(k)));

  // ---------- itinerary ----------
  const itinEl = $('itinerary');
  let showItin = false;
  function setItinerary(on) {
    showItin = on;
    itinEl.hidden = !on;
    $('map').style.display = on ? 'none' : '';
    $('btn-itinerary').classList.toggle('primary', on);
    if (on && lastTl) renderItinerary(itinEl, lastTl, store.trip);
    if (!on) map.map.invalidateSize();
  }
  $('btn-itinerary').addEventListener('click', () => setItinerary(!showItin));
  itinEl.addEventListener('click', e => {
    const ev = e.target.closest('.itin-ev');
    if (!ev) return;
    const i = Number(ev.dataset.i);
    setItinerary(false);
    const card = document.querySelector(i >= 0 ? `.stop[data-index="${i}"]` : '#dest-card');
    if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600); }
  });

  // ---------- render ----------
  let lastTl = null;
  function render() {
    const trip = store.trip;
    const tl = compute(trip);
    lastTl = tl;
    const S = tl.summary;
    inTrip = new Set(trip.stops.map(s => s.siteId).filter(x => x != null));
    visitedSet = new Set(trip.visitedBefore || []);

    $('counter-unique').textContent = String(S.uniqueCounted) + (S.newForYear !== S.uniqueCounted ? ` (${S.newForYear} new)` : '');
    const streakEl = $('counter-streak');
    if (S.uniqueCounted === 0) { streakEl.textContent = '–'; streakEl.parentElement.className = 'counter'; }
    else if (S.firstBreakIndex >= 0) { streakEl.textContent = `broken at #${S.firstBreakIndex + 1} · best ${S.longestStreak}`; streakEl.parentElement.className = 'counter bad'; }
    else { streakEl.textContent = `${S.longestStreak} in a row ✓`; streakEl.parentElement.className = 'counter ok'; }
    const dlEl = $('counter-deadline');
    dlEl.textContent = S.nextDeadline ? fmt.time(S.nextDeadline) : '–';
    dlEl.parentElement.className = 'counter';
    $('counter-km').textContent = fmt.km(S.totalKm);
    $('counter-time').textContent = fmt.h(S.totalTimeH);
    $('counter-kwh').textContent = fmt.kwh(S.kwhBilled);
    $('counter-eta').textContent = trip.stops.length || trip.destination ? `${fmt.time(S.eta)} · ${fmt.pct(S.endSoc)}` : '–';
    if (S.minSoc < 0) dlEl.parentElement.className = 'counter';
    $('btn-export').disabled = false;

    sidebar.render(tl);

    map.restyle(classify);
    let prev = trip.start;
    const legs = tl.stops.map(r => {
      const leg = trip.legs[legKey(prev, r.stop)];
      prev = r.stop;
      const latlngs = leg && leg.status === 'ok' ? routeLatLngs(leg.route) : null;
      const color = r.arrivalSoc >= trip.settings.reserveSoc + 15 ? '#16a34a' : r.arrivalSoc >= trip.settings.reserveSoc ? '#f59e0b' : '#dc2626';
      return { latlngs, color };
    });
    if (trip.destination && tl.destination && tl.destination.leg.status === 'ok') {
      const lastStop = trip.stops.length ? trip.stops[trip.stops.length - 1] : trip.start;
      const dleg = trip.legs[legKey(lastStop, trip.destination)];
      if (dleg && dleg.status === 'ok') {
        const soc = tl.destination.arrivalSoc;
        const color = soc >= trip.settings.reserveSoc + 15 ? '#16a34a' : soc >= trip.settings.reserveSoc ? '#f59e0b' : '#dc2626';
        legs.push({ latlngs: routeLatLngs(dleg.route), color });
      }
    }
    map.setRoute(legs);
    map.setStops({
      start: trip.start,
      stops: tl.stops.map(r => ({ lat: r.stop.lat, lng: r.stop.lng, siteId: r.stop.siteId ?? null, name: r.stop.name, cls: r.stop.kind === 'point' ? 'point' : (r.session && r.session.broken) ? 'broken' : '', tooltip: `${r.i + 1}. ${r.stop.name} · arrive ${fmt.clock(r.arrival)} at ${fmt.pct(r.arrivalSoc)}` })),
      destination: trip.destination,
    });
    if (showItin) renderItinerary(itinEl, tl, trip);
    const lastStop = trip.stops[trip.stops.length - 1];
    const sig = `${trip.stops.length}|${lastStop ? lastStop.id : ''}|${Math.round(tl.stops.length ? tl.stops[tl.stops.length - 1].departSoc : trip.start.soc)}`;
    if (sig !== filterSig) { filterSig = sig; applyMapFilters(); }
    document.title = `${trip.meta.name} · ABTCP`;
  }
  store.subscribe(render);
  render();
  if (restored && store.trip.stops.length) map.fitTo(sidebar.tripPoints()); else map.fitTo([[store.trip.start.lat, store.trip.start.lng]]);

  // ---------- header buttons ----------
  $('btn-fit').addEventListener('click', () => map.fitTo(sidebar.tripPoints()));
  $('btn-recompute').addEventListener('click', async () => {
    setStatus('Re-routing…');
    try { await planner.ensureLegs({ force: true, onProgress: (i, n) => setStatus(`Re-routing ${i}/${n}…`) }); toast.success('All legs recomputed'); }
    catch (e) { toast.error(`Recompute failed: ${e.message}`); }
    setStatus('');
    sidebar.refreshCandidates(true);
  });
  $('btn-export').addEventListener('click', () => {
    planner.pruneLegs();
    const trip = store.trip;
    const blob = new Blob([serialize(trip)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `abtcp-${slug(trip.meta.name)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast.success(`Exported ${a.download}`);
  });
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const trip = deserialize(await file.text());
      store.replace(trip);
      osrm.baseUrl = store.trip.settings.osrmUrl;
      map.setTiles(store.trip.settings.tiles);
      loadSites();
      paintSettings();
      toast.success(`Imported “${trip.meta.name}” with ${trip.stops.length} stops`);
      map.fitTo(sidebar.tripPoints());
      await sidebar.buildMissing();
      sidebar.refreshCandidates(true);
    } catch (err) {
      toast.error(`Import failed: ${err.message}`);
    }
  });
  $('btn-new').addEventListener('click', () => {
    if (!window.confirm('Discard the current trip and start a new empty one?')) return;
    store.reset();
    loadSites();
    paintSettings();
    map.fitTo([[store.trip.start.lat, store.trip.start.lng]]);
    sidebar.refreshCandidates(true);
    toast.show('New trip');
  });

  // ---------- background work ----------
  window.__abtcp = { store, db, planner, compute, get timeline() { return lastTl; }, map, sidebar };
  await sidebar.buildMissing();
  sidebar.refreshCandidates(true);
}

main().catch(e => {
  console.error(e);
  const t = document.getElementById('toast');
  if (t) { t.textContent = `Startup failed: ${e.message}`; t.className = 'toast show error'; }
});
