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
import { renderItinerary, itineraryHeader } from './ui/itinerary.js';
import { renderSettings, bindSettings } from './ui/settings.js';
import { createToast } from './ui/toast.js';
import { fmt, esc, slug, socClass } from './ui/format.js';

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
  let iconicDoc = [];
  try {
    const ir = await fetch('data/iconic.json');
    if (ir.ok) { iconicDoc = await ir.json(); applyIconic(db, iconicDoc); }
  } catch { /* the iconic list is optional */ }
  setStatus('');

  const routeQueue = createQueue({ maxConcurrent: 3, spacingMs: 150 });
  const osrm = createOsrm({ baseUrl: store.trip.settings.osrmUrl, queue: routeQueue });
  const elevation = createElevation({ queue: createQueue({ maxConcurrent: 2, spacingMs: 100 }) });
  const weatherQueue = createQueue({ maxConcurrent: 2, spacingMs: 100 });
  const planner = createPlanner({ store, db, osrm, elevation, weatherAt: args => weatherAt({ ...args, queue: weatherQueue }) });

  const map = createMap({ el: $('map'), tiles: store.trip.settings.tiles });
  const sidebar = createSidebar({ el: $('panel-trip'), store, db, planner, geocode, map, toast, setStatus });

  // ---------- map filter: All | Reachable | Iconic ----------
  const filterBar = document.createElement('div');
  filterBar.id = 'map-filters';
  filterBar.innerHTML = '<button class="chip active" id="chip-all" title="Show every charger">All</button>'
    + '<button class="chip" id="chip-reach" title="Only sites the car can reach right now from the end of the plan (straight-line estimate, reserve kept). Your own stops, start, destination and route always stay visible.">⚡ Reachable</button>'
    + '<button class="chip" id="chip-iconic" title="Only Iconic Charger badge sites. Your own stops, start, destination and route always stay visible.">🏅 Iconic</button>';
  $('map').appendChild(filterBar);
  ['dblclick', 'mousedown'].forEach(ev => filterBar.addEventListener(ev, e => e.stopPropagation()));
  let mapFilterMode = 'all';
  let filterSig = '';
  function applyMapFilters() {
    if (mapFilterMode === 'all') { map.applyFilter(null); return; }
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
      if (mapFilterMode === 'iconic') return !!site.iconic;
      return haversineM(head.lat, head.lng, site.lat, site.lng) <= rangeM;
    });
  }
  filterBar.addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('.chip');
    if (!b) return;
    mapFilterMode = b.id === 'chip-reach' ? 'reach' : b.id === 'chip-iconic' ? 'iconic' : 'all';
    for (const c of filterBar.querySelectorAll('.chip')) c.classList.toggle('active', c === b);
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
    const rIdx = sidebar.replacingId ? t.stops.findIndex(x => x.id === sidebar.replacingId) : -1;
    const visited = (t.visitedBefore || []).includes(site.id);
    return `<div class="popup"><b>${site.iconic ? '🏅 ' : ''}${esc(site.name)}</b>
      <div class="meta">${esc(STATUS_LABEL[site.status] || site.status)} · ${site.stalls} stalls · ${site.kw || '?'} kW${site.gen ? ` · ${site.gen.toUpperCase()}` : ''}${site.opened ? ` · opened ${esc(site.opened)}` : ''}</div>
      ${site.iconic ? `<div class="meta">🏅 Iconic charger badge: ${esc(site.iconic)}</div>` : ''}
      ${site.tid ? `<a href="https://www.tesla.com/findus/location/supercharger/${encodeURIComponent(site.tid)}" target="_blank" rel="noopener">tesla.com ↗</a>` : ''}
      <div class="popup-actions">
        <button data-act="add" data-site="${site.id}" class="primary">${rIdx >= 0 ? `⇄ Replace stop #${rIdx + 1} with this site` : isIn ? 'Add again (repeat, for charge only)' : 'Add as next stop'}</button>
        ${inStops.map(x => `<button data-act="removeStop" data-site="${site.id}" data-stop="${esc(x.s.id)}">Remove stop #${x.i + 1}</button>`).join('')}
        <button data-act="visited" data-site="${site.id}" title="Affects the yearly unique-sites counter and suggestion order">${visited ? 'Unmark visited this year' : 'Visited earlier this year'}</button>
      </div></div>`;
  };
  function loadSites() {
    const show = new Set(store.trip.settings.showStatuses);
    map.setSites(db.sites.filter(s => show.has(s.status)), classify, popupHtml);
    if (mapFilterMode !== 'all') applyMapFilters();
  }
  loadSites();

  map.on('stopClick', ({ siteId }) => { if (siteId != null) map.openSite(siteId); });
  map.on('mapAction', ({ act, siteId, stopId, legIndex }) => {
    if (act === 'add') { const site = db.byId(siteId); if (site) sidebar.addStop(site); }
    else if (act === 'remove' && stopId) sidebar.removeStop(stopId);
    else if (act === 'replace' && stopId) sidebar.startReplace(stopId);
    else if (act === 'fill' && legIndex != null) sidebar.fillGap(legIndex);
  });
  map.on('siteClick', ({ site }) => { if (sidebar.replacingId) sidebar.replaceWith(site); });
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

  // ---------- iconic badge table (Help tab) ----------
  function renderIconicTable(el) {
    if (!el) return;
    const regions = ['Europe', 'North America', 'Asia', 'Oceania'];
    const groups = new Map();
    for (const e of iconicDoc) {
      if (!e.badge) continue;
      const k = `${e.region || 'Other'}|${e.badge}`;
      if (!groups.has(k)) groups.set(k, { badge: e.badge, region: e.region || 'Other', sites: [], guess: false, unmapped: !!e.unmapped });
      const g = groups.get(k);
      if (e.id != null) {
        const site = db.byId(e.id);
        if (site) { g.sites.push(site); if (e.guess) g.guess = true; }
      }
    }
    let html = '';
    for (const reg of regions) {
      const rows = [...groups.values()].filter(g => g.region === reg).sort((a, b) => a.badge.localeCompare(b.badge));
      if (!rows.length) continue;
      html += `<h3 style="margin-top:12px">${reg}</h3><table class="iconic-table"><tr><th>Badge</th><th>Supercharger site</th><th>On map</th></tr>`;
      for (const g of rows) {
        const sites = g.sites.length
          ? g.sites.map(site => `${esc(site.name)} <span class="muted">(${esc(site.country)})</span>`).join('<br>')
          : '<span class="muted">site not identified yet — edit data/iconic.json</span>';
        html += `<tr><td>🏅 ${esc(g.badge)}</td><td>${sites}</td><td>${g.sites.length ? (g.guess ? '✓ best guess' : '✓') : '—'}</td></tr>`;
      }
      html += '</table>';
    }
    el.innerHTML = html;
  }
  renderIconicTable($('iconic-table'));

  // ---------- settings / help dialog ----------
  const dialog = $('dialog');
  const dTabs = { settings: $('dtab-settings'), help: $('dtab-help') };
  const dPanels = { settings: settingsEl, help: $('panel-help') };
  function showDialogTab(name) {
    for (const k of Object.keys(dTabs)) {
      dTabs[k].classList.toggle('active', k === name);
      dPanels[k].hidden = k !== name;
    }
    if (name === 'settings') paintSettings();
  }
  function openDialog(name) {
    showDialogTab(name);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.dialog-body').scrollTop = 0;
  }
  Object.entries(dTabs).forEach(([k, b]) => b.addEventListener('click', () => showDialogTab(k)));
  $('btn-settings').addEventListener('click', () => openDialog('settings'));
  $('dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }); // click the backdrop

  // ---------- itinerary ----------
  const itinEl = $('itinerary');
  const itinContent = $('itin-content');
  let showItin = false;
  function paintItinerary(tl, trip) {
    const h = itineraryHeader(tl, trip);
    $('itin-title').textContent = h.title;
    $('itin-summary').textContent = h.summary;
    $('itin-print-head').textContent = h.printHead;
    renderItinerary(itinContent, tl, trip);
  }
  function setItinerary(on) {
    showItin = on;
    itinEl.hidden = !on;
    $('map').style.display = on ? 'none' : '';
    $('btn-itinerary').textContent = on ? '🗺 Back to the map' : '🗓 Itinerary view';
    if (on && lastTl) paintItinerary(lastTl, store.trip);
    if (!on) map.map.invalidateSize();
  }
  $('btn-itinerary').addEventListener('click', () => setItinerary(!showItin));
  $('itin-close').addEventListener('click', () => setItinerary(false));
  let lastPrint = 0;
  $('itin-print').addEventListener('click', () => {
    if (Date.now() - lastPrint < 700) return; // never open two print dialogs from one intent
    lastPrint = Date.now();
    window.print();
  });
  itinContent.addEventListener('click', e => {
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

    const setCounter = (id, text, title) => { const c = $(id); c.textContent = text; c.parentElement.title = title || text; };
    setCounter('counter-unique', String(S.uniqueCounted) + (S.newForYear !== S.uniqueCounted ? ` (${S.newForYear} new)` : ''), `${S.uniqueCounted} unique Supercharger sites in this trip · ${S.newForYear} new for the year`);
    const streakEl = $('counter-streak');
    if (S.uniqueCounted === 0) { setCounter('counter-streak', '–', 'No charging sessions planned yet'); streakEl.parentElement.className = 'counter wide'; }
    else if (S.firstBreakIndex >= 0) { setCounter('counter-streak', `✗ broken #${S.firstBreakIndex + 1}`, `The 24 h window is missed at stop #${S.firstBreakIndex + 1}; longest unbroken run: ${S.longestStreak} sites`); streakEl.parentElement.className = 'counter wide bad'; }
    else { setCounter('counter-streak', `${S.longestStreak} in a row ✓`, `${S.longestStreak} unique sites chained without missing the 24 h window`); streakEl.parentElement.className = 'counter wide ok'; }
    setCounter('counter-deadline', S.nextDeadline ? fmt.short(S.nextDeadline) : '–', S.nextDeadline ? `Start charging at a new site before ${fmt.time(S.nextDeadline)} to keep the streak` : 'No session yet');
    setCounter('counter-km', fmt.km(S.totalKm), `${Math.round(S.totalKm)} km of driving in this plan`);
    setCounter('counter-time', fmt.h(S.totalTimeH), `${fmt.h(S.totalDriveH)} driving · ${fmt.h(S.chargeH)} charging · ${fmt.h(S.totalTimeH)} total`);
    setCounter('counter-kwh', `${Math.round(S.kwhBilled)} kWh`, `${fmt.kwh(S.kwhBilled)} supercharged — the contest tie-breaker`);
    setCounter('counter-eta', trip.stops.length || trip.destination ? `${fmt.short(S.eta)}` : '–', trip.stops.length || trip.destination ? `Arrive ${fmt.time(S.eta)} at ${fmt.pct(S.endSoc)}` : 'Arrival time and battery at the end of the plan');
    const etaEl = $('counter-eta'); etaEl.nextElementSibling.textContent = trip.stops.length || trip.destination ? `arrive · ${Math.round(S.endSoc)}%` : 'arrive';
    $('btn-export').disabled = false;
    $('btn-undo').disabled = !store.canUndo();
    $('btn-redo').disabled = !store.canRedo();

    sidebar.render(tl);

    map.restyle(classify);
    let prev = trip.start;
    const legs = tl.stops.map(r => {
      const leg = trip.legs[legKey(prev, r.stop)];
      prev = r.stop;
      const latlngs = leg && leg.status === 'ok' ? routeLatLngs(leg.route) : null;
      const color = r.arrivalSoc >= trip.settings.reserveSoc + 15 ? '#16a34a' : r.arrivalSoc >= trip.settings.reserveSoc ? '#f59e0b' : '#dc2626';
      return { latlngs, color, index: r.i };
    });
    if (trip.destination && tl.destination && tl.destination.leg.status === 'ok') {
      const lastStop = trip.stops.length ? trip.stops[trip.stops.length - 1] : trip.start;
      const dleg = trip.legs[legKey(lastStop, trip.destination)];
      if (dleg && dleg.status === 'ok') {
        const soc = tl.destination.arrivalSoc;
        const color = soc >= trip.settings.reserveSoc + 15 ? '#16a34a' : soc >= trip.settings.reserveSoc ? '#f59e0b' : '#dc2626';
        legs.push({ latlngs: routeLatLngs(dleg.route), color, index: trip.stops.length });
      }
    }
    map.setRoute(legs);
    map.setStops({
      start: { ...trip.start, batt: { arr: +trip.start.soc, dep: +trip.start.soc, cls: socClass(+trip.start.soc, trip.settings.reserveSoc) } },
      stops: tl.stops.map(r => ({ id: r.stop.id, lat: r.stop.lat, lng: r.stop.lng, siteId: r.stop.siteId ?? null, name: r.stop.name, cls: r.stop.kind === 'point' ? 'point' : (r.session && r.session.broken) ? 'broken' : '', batt: { arr: r.arrivalSoc, dep: r.departSoc, cls: socClass(r.arrivalSoc, trip.settings.reserveSoc) }, tooltip: `${r.i + 1}. ${r.stop.name} · arrive ${fmt.clock(r.arrival)} at ${fmt.pct(r.arrivalSoc)} → leave at ${fmt.pct(r.departSoc)}` })),
      destination: trip.destination
        ? { ...trip.destination, batt: tl.destination && tl.destination.leg.status === 'ok' ? { arr: tl.destination.arrivalSoc, dep: tl.destination.arrivalSoc, cls: socClass(tl.destination.arrivalSoc, trip.settings.reserveSoc) } : null }
        : null,
    });
    if (showItin) paintItinerary(tl, trip);
    const lastStop = trip.stops[trip.stops.length - 1];
    const sig = `${trip.stops.length}|${lastStop ? lastStop.id : ''}|${Math.round(tl.stops.length ? tl.stops[tl.stops.length - 1].departSoc : trip.start.soc)}`;
    if (sig !== filterSig) { filterSig = sig; applyMapFilters(); }
    document.title = `${trip.meta.name} · ABTCP`;
  }
  store.subscribe(render);
  render();
  if (restored && store.trip.stops.length) map.fitTo(sidebar.tripPoints()); else map.fitTo([[store.trip.start.lat, store.trip.start.lng]]);

  // ---------- header buttons ----------
  // Pruning drops legs the current plan no longer uses, so a restored plan may need a few back.
  const afterHistory = label => { paintSettings(); sidebar.buildMissing().then(() => sidebar.refreshCandidates(true)); toast.show(label); };
  $('btn-undo').addEventListener('click', () => { if (store.undo()) afterHistory('Undo'); });
  $('btn-redo').addEventListener('click', () => { if (store.redo()) afterHistory('Redo'); });
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (k === 'z' && !e.shiftKey) {
      if (typing) return;
      e.preventDefault();
      if (store.undo()) afterHistory('Undo');
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      if (typing) return;
      e.preventDefault();
      if (store.redo()) afterHistory('Redo');
    }
  });
  // Drop-down menus (File, Trip)
  const menus = [['btn-file', 'file-menu'], ['btn-trip', 'trip-menu']].map(([b, m]) => ({ btn: $(b), list: $(m) }));
  const closeMenus = except => { for (const m of menus) if (m !== except) { m.list.hidden = true; m.btn.setAttribute('aria-expanded', 'false'); } };
  for (const m of menus) {
    m.btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = m.list.hidden;
      closeMenus(m);
      m.list.hidden = !open;
      m.btn.setAttribute('aria-expanded', String(open));
    });
    m.list.addEventListener('click', () => setTimeout(() => closeMenus(), 0));
  }
  document.addEventListener('click', e => { for (const m of menus) if (!m.list.hidden && !m.list.contains(e.target) && e.target !== m.btn) { m.list.hidden = true; m.btn.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

  $('btn-rename').addEventListener('click', () => {
    const name = window.prompt('Trip name', store.trip.meta.name);
    if (name == null) return;
    store.update(t => { t.meta.name = name.trim() || 'My contest trip'; });
    toast.success('Trip renamed');
  });

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
