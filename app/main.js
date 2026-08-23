// Bootstrap: load the charger DB, restore the trip, wire services, map, sidebar and settings.
import { loadChargers, USABLE_STATUSES, STATUS_LABEL } from './chargers.js';
import { createStore, deserialize, serialize } from './state.js';
import { compute, legKey } from './model/timeline.js';
import { routeLatLngs } from './model/geo.js';
import { createQueue } from './services/http.js';
import { createOsrm } from './services/osrm.js';
import { createElevation } from './services/elevation.js';
import { weatherAt } from './services/weather.js';
import { geocode } from './services/geocode.js';
import { createPlanner } from './planner.js';
import { createMap } from './ui/map.js';
import { createSidebar } from './ui/sidebar.js';
import { renderSettings, bindSettings } from './ui/settings.js';
import { createToast, armConfirm } from './ui/toast.js';
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
  setStatus('');

  const routeQueue = createQueue({ maxConcurrent: 3, spacingMs: 150 });
  const osrm = createOsrm({ baseUrl: store.trip.settings.osrmUrl, queue: routeQueue });
  const elevation = createElevation({ queue: createQueue({ maxConcurrent: 2, spacingMs: 100 }) });
  const weatherQueue = createQueue({ maxConcurrent: 2, spacingMs: 100 });
  const planner = createPlanner({ store, db, osrm, elevation, weatherAt: args => weatherAt({ ...args, queue: weatherQueue }) });

  const map = createMap({ el: $('map'), tiles: store.trip.settings.tiles });
  const sidebar = createSidebar({ el: $('panel-trip'), store, db, planner, geocode, map, toast, setStatus });

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
    const isIn = t.stops.some(s => s.siteId === site.id);
    const visited = (t.visitedBefore || []).includes(site.id);
    return `<div class="popup"><b>${esc(site.name)}</b>
      <div class="meta">${esc(STATUS_LABEL[site.status] || site.status)} · ${site.stalls} stalls · ${site.kw || '?'} kW${site.gen ? ` · ${site.gen.toUpperCase()}` : ''}${site.opened ? ` · opened ${esc(site.opened)}` : ''}</div>
      ${site.tid ? `<a href="https://www.tesla.com/findus/location/supercharger/${encodeURIComponent(site.tid)}" target="_blank" rel="noopener">tesla.com ↗</a>` : ''}
      <div class="popup-actions">
        <button data-act="add" data-site="${site.id}" class="primary">${isIn ? 'Add again' : 'Add as next stop'}</button>
        <button data-act="start" data-site="${site.id}">Set as start</button>
        <button data-act="dest" data-site="${site.id}">Set as destination</button>
        <button data-act="visited" data-site="${site.id}">${visited ? 'Unmark visited' : 'Visited this year'}</button>
      </div></div>`;
  };
  function loadSites() {
    const show = new Set(store.trip.settings.showStatuses);
    map.setSites(db.sites.filter(s => show.has(s.status)), classify, popupHtml);
  }
  loadSites();

  map.on('siteAction', ({ act, siteId }) => {
    const site = db.byId(siteId);
    if (!site) return;
    if (act === 'add') sidebar.addStop(site);
    else if (act === 'start') { sidebar.setStart({ lat: site.lat, lng: site.lng, name: site.name }); map.fitTo(sidebar.tripPoints()); }
    else if (act === 'dest') { sidebar.setDestination({ lat: site.lat, lng: site.lng, name: site.name }); render(); }
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
    $('counter-eta').textContent = trip.stops.length ? `${fmt.time(S.eta)} · ${fmt.pct(S.endSoc)}` : '–';
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
    map.setRoute(legs);
    map.setStops({
      start: trip.start,
      stops: tl.stops.map(r => ({ lat: r.stop.lat, lng: r.stop.lng, name: r.stop.name, cls: r.stop.kind === 'point' ? 'point' : (r.session && r.session.broken) ? 'broken' : '', tooltip: `${r.i + 1}. ${r.stop.name} · arrive ${fmt.clock(r.arrival)} at ${fmt.pct(r.arrivalSoc)}` })),
      destination: trip.destination,
    });
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
  $('btn-new').addEventListener('click', e => armConfirm(e.currentTarget, () => {
    store.reset();
    loadSites();
    paintSettings();
    map.fitTo([[store.trip.start.lat, store.trip.start.lng]]);
    sidebar.refreshCandidates(true);
    toast.show('New trip');
  }));

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
