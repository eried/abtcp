// Trip panel: start / destination, stop cards, next-stop candidates and auto-chain.
import { fmt, esc, socClass } from './format.js';
import { newStop } from '../state.js';
import { STATUS_LABEL } from '../chargers.js';
import { haversineM } from '../model/geo.js';

const teslaUrl = tid => `https://www.tesla.com/findus/location/supercharger/${encodeURIComponent(tid)}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function createSidebar({ el, store, db, planner, geocode, map, toast, setStatus = () => {} }) {
  let tl = null;
  let cands = { key: null, list: [], loading: false, error: null };
  const search = { start: { q: '', results: [], busy: false }, dest: { q: '', results: [], busy: false } };
  let pickMode = null;
  let replaceId = null;
  let pendingRender = false;
  let deferHooked = false;
  let chaining = false;
  let stopChain = false;
  let building = false;

  // ---------- rendering ----------
  /** Fields whose value the user is actively editing must survive a re-render untouched. */
  const EDITING = new Set(['datetime-local', 'number', 'text', 'url', 'time', 'date']);

  function render(timeline) {
    tl = timeline;
    const active = document.activeElement;
    // A live re-render would destroy the node being typed into (a datetime-local loses focus
    // and the half-typed value). Defer instead, and repaint once the field is left.
    if (active && el.contains(active) && active.tagName === 'INPUT' && EDITING.has(active.type)) {
      pendingRender = true;
      if (!deferHooked) {
        deferHooked = true;
        el.addEventListener('focusout', () => {
          setTimeout(() => {
            const a = document.activeElement;
            if (a && el.contains(a) && a.tagName === 'INPUT' && EDITING.has(a.type)) return;
            deferHooked = false;
            if (pendingRender && tl) { pendingRender = false; render(tl); }
          }, 0);
        }, { once: true });
      }
      map.setCandidates(candidatesWithSoc());
      return;
    }
    pendingRender = false;
    const keep = active && el.contains(active) && active.id ? { id: active.id, value: active.value, pos: active.selectionStart } : null;
    const scrollTop = el.scrollTop;
    el.innerHTML = html();
    el.scrollTop = scrollTop;
    if (keep) {
      const again = el.querySelector(`#${keep.id}`);
      if (again) { again.focus(); if (again.type === 'text') { again.value = keep.value; try { again.setSelectionRange(keep.pos, keep.pos); } catch { /* ignore */ } } }
    }
    map.setCandidates(candidatesWithSoc());
  }

  function candidatesWithSoc() {
    if (!tl) return cands.list;
    const trip = store.trip;
    const last = tl.stops[tl.stops.length - 1];
    const soc = last ? last.departSoc : +trip.start.soc;
    return cands.list.map(c => ({ ...c, arrivalSoc: soc - c.kwh / trip.car.usableKwh * 100 }));
  }

  function resultsHtml(kind) {
    return search[kind].results.map(r => `<div data-kind="${kind}" data-lat="${r.lat}" data-lng="${r.lng}" data-name="${esc(r.name)}" ${r.siteId ? `data-site="${r.siteId}"` : ''}>${r.siteId ? '⚡ ' : ''}${esc(r.name)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}</div>`).join('');
  }

  function html() {
    const trip = store.trip;
    const dest = trip.destination;
    const straight = dest ? haversineM(trip.start.lat, trip.start.lng, dest.lat, dest.lng) / 1000 : null;
    return `
    <div class="card">
      <header><h3>Trip</h3><input type="text" id="trip-name" value="${esc(trip.meta.name)}" placeholder="Trip name" style="flex:1"></header>
    </div>
    <div class="card start">
      <header><h3>Start</h3><button class="ghost" id="btn-start-map" title="Pick the start on the map">${pickMode === 'start' ? 'click the map…' : '📍 pick on map'}</button></header>
      <div class="search"><input type="text" id="start-search" placeholder="Search a place or a Supercharger…" value="${esc(search.start.q)}" autocomplete="off"><div class="results" id="start-results">${resultsHtml('start')}</div></div>
      <div class="place"><b id="start-name">${esc(trip.start.name)}</b><small>${(+trip.start.lat).toFixed(4)}, ${(+trip.start.lng).toFixed(4)}</small></div>
      <div class="grid2">
        <label class="field">Departure<input type="datetime-local" id="start-time" value="${esc(trip.start.time)}"></label>
        <label class="field">Battery at start: <output id="start-soc-out">${trip.start.soc} %</output><input type="range" id="start-soc" min="1" max="100" value="${trip.start.soc}"></label>
      </div>
    </div>
    <div class="card dest">
      <header><h3>Destination</h3><button class="ghost" id="btn-roundtrip" title="Route back to the start as the final leg">↩ roundtrip</button><button class="ghost" id="btn-dest-map" title="Pick on the map">${pickMode === 'dest' ? 'click the map…' : '📍 pick on map'}</button>${dest ? '<button class="ghost" id="btn-dest-clear" title="Clear destination">✕</button>' : ''}</header>
      <div class="search"><input type="text" id="dest-search" placeholder="Optional: where are you heading?" value="${esc(search.dest.q)}" autocomplete="off"><div class="results" id="dest-results">${resultsHtml('dest')}</div></div>
      ${dest ? `<div class="place"><b id="dest-name">${esc(dest.name)}</b><small>${Math.round(straight)} km straight line from the start · routed as the final leg below</small></div>` : '<small>With a destination, “Next stop” prefers sites that make progress by road, and the final leg is routed and timed.</small>'}
    </div>
    <div id="stops">${stopsHtml() || '<div class="card muted">No stops yet. Pick one from “Next stop” below, or click a red dot on the map.</div>'}</div>
    ${tl.destination ? destHtml(tl.destination) : ''}
    ${candidatesHtml()}`;
  }

  const dayNo = ms => Math.floor((new Date(ms).setHours(0, 0, 0, 0) - new Date(tl.startTime).setHours(0, 0, 0, 0)) / 864e5);

  /** Stop cards with a "Day N" separator wherever the calendar day changes. */
  function stopsHtml() {
    let out = '';
    let prevDay = dayNo(tl.startTime);
    for (const r of tl.stops) {
      const d = dayNo(r.arrival);
      if (d > prevDay) {
        for (let k = prevDay + 1; k <= d; k++) {
          const at = tl.startTime + k * 864e5;
          out += `<div class="day-sep"><span>Day ${k + 1} · ${esc(fmt.day(at))}</span></div>`;
        }
        prevDay = d;
      }
      out += stopHtml(r);
      const dep = dayNo(r.depart); // a long rest can push the departure into later days
      if (dep > prevDay) prevDay = dep - 1;
    }
    if (tl.destination && tl.destination.leg.status === 'ok') {
      const d = dayNo(tl.destination.arrival);
      for (let k = prevDay + 1; k <= d; k++) {
        const at = tl.startTime + k * 864e5;
        out += `<div class="day-sep"><span>Day ${k + 1} · ${esc(fmt.day(at))}</span></div>`;
      }
    }
    return out;
  }

  function battHtml(arr, dep, reserve) {
    const a = Math.max(0, Math.min(100, arr));
    const d = Math.max(0, Math.min(100, dep));
    const lo = Math.min(a, d);
    const hi = Math.max(a, d);
    return `<div class="batt" title="Arrive at ${fmt.pct(arr)}, leave at ${fmt.pct(dep)} (tick = reserve)"><div class="batt-body"><div class="batt-fill ${socClass(arr, reserve)}" style="width:${lo}%"></div><div class="batt-fill ${d >= a ? 'gain' : 'drain'}" style="left:${lo}%;width:${hi - lo}%"></div><span class="batt-tick" style="left:${reserve}%"></span></div><span class="batt-lbl">${Math.round(arr)} → ${Math.round(dep)} %</span></div>`;
  }

  function stopHtml(r) {
    const trip = store.trip;
    const S = trip.settings;
    const stop = r.stop;
    const i = r.i;
    const isCharger = stop.kind === 'charger';
    const hasErr = r.warnings.some(w => w.level === 'error');
    const hasWarn = r.warnings.some(w => w.level === 'warn');
    const cls = ['stop', isCharger ? 'charger' : 'point', (r.session && r.session.broken) || hasErr ? 'broken' : hasWarn ? 'warn' : '', stop.id === replaceId ? 'replacing' : ''].join(' ');
    const meta = isCharger
      ? `${esc(stop.country)} · ${stop.stalls} stalls · ${stop.kw || '?'} kW · ${STATUS_LABEL[stop.status] || stop.status || ''}`
      : `${(+stop.lat).toFixed(4)}, ${(+stop.lng).toFixed(4)}`;
    const name = isCharger && stop.tid ? `<a href="${teslaUrl(stop.tid)}" target="_blank" rel="noopener">${esc(stop.name)}</a>` : esc(stop.name);
    let leg;
    if (r.leg.status === 'ok') {
      const L = r.leg;
      leg = `<b>${fmt.km(L.km)}</b> · ${fmt.h(L.driveH)} driving${L.ferries ? ` · ⛴ ${L.ferries} ferry ${fmt.h(L.ferryH)}` : ''} · ↑${L.gainM} m ↓${L.lossM} m · <b>${fmt.whkm(L.whKm)}</b> · ${fmt.temp(L.temp)}${L.windKmh ? ` · wind ${Math.round(L.windKmh)} km/h` : ''} <span class="muted">(${esc(L.weatherSrc)})</span>`;
    } else if (r.leg.status === 'failed') {
      leg = `<span class="soc bad">Route failed: ${esc(r.leg.error)}</span> <button class="ghost" data-act="retry">retry</button>`;
    } else {
      leg = '<span class="muted">Routing…</span>';
    }
    let dl = '', dlCls = 'none';
    const dlText = (since, left, suffix = '') => `⏱ ${fmt.signedH(since)} since last session · ${left >= 0 ? `${fmt.h(left)} left${suffix}` : `deadline missed by ${fmt.h(-left)}`}`;
    const dlClass = left => (left < 0 ? 'broken' : left * 60 < S.rules.marginMin ? 'warn' : 'ok');
    if (r.session && isCharger) {
      if (!r.session.isNew) dl = '↩ repeat site — does not count, timer unchanged';
      else if (r.session.deadline == null) { dl = '⏱ the streak starts with this session'; dlCls = 'ok'; }
      else { dl = dlText(r.session.sinceLastH, r.session.deadlineInH); dlCls = dlClass(r.session.deadlineInH); }
    } else if (r.timer.sinceLastH != null) {
      dl = dlText(r.timer.sinceLastH, r.timer.deadlineInH, ' at departure');
      dlCls = dlClass(r.timer.deadlineInH);
    }
    let charge;
    if (isCharger) {
      const target = stop.charge ? stop.charge.targetSoc : S.defaultTargetSoc;
      const sess = r.session;
      const info = sess && sess.kwhStored > 0 ? `+${fmt.kwh(sess.kwhStored)} · ${fmt.h(sess.minutes / 60)} · ~${Math.round(sess.avgKw)} kW${sess.targetSoc > target + 0.5 ? ` → ${Math.round(sess.targetSoc)} %` : ''}` : 'no charging';
      charge = `<div class="charge"><div class="head"><span>Charge to <output class="charge-out">${target} %</output></span><span class="muted charge-info">${info}</span></div>
        <input type="range" class="charge-target" min="0" max="100" step="1" value="${target}" aria-label="Charge target">
        <small>${r.minUsefulSoc != null ? `Minimum useful for the next hop: <b>${r.minUsefulSoc} %</b>` : 'Last stop — charge what you need after the trip'}${sess && sess.isNew && sess.kwhStored > 0 ? ` · session ${fmt.clock(sess.start)}–${fmt.clock(sess.end)}` : ''}</small></div>`;
    } else {
      const ac = stop.charge;
      charge = `<div class="row charge ac"><label><input type="checkbox" class="ac-enabled" ${ac ? 'checked' : ''}> AC charge here</label>${ac ? `<span>to <input type="number" class="ac-target" min="0" max="100" value="${ac.targetSoc}"> % at <input type="number" class="ac-kw" min="1" max="22" step="0.1" value="${ac.kw ?? 11}"> kW</span>${r.session ? `<small>+${fmt.kwh(r.session.kwhStored)} · ${fmt.h(r.session.minutes / 60)}</small>` : ''}` : ''}</div>`;
    }
    const rest = `<div class="row rest"><label>Rest <input type="number" class="rest-hours" min="0" step="0.5" value="${stop.rest ? stop.rest.hours : 0}"> h</label><label><input type="checkbox" class="rest-sentry" ${stop.rest && stop.rest.sentry ? 'checked' : ''}> Sentry on</label>${r.rest ? `<small>−${fmt.n1(r.rest.drainPct)} % · until ${fmt.time(r.rest.end)}</small>` : ''}</div>`;
    const warns = r.warnings.length ? `<ul class="warnings">${r.warnings.map(w => `<li class="${w.level}">${esc(w.msg)}</li>`).join('')}</ul>` : '';
    const needsFill = r.leg.status === 'failed' || (r.leg.status === 'ok' && r.arrivalSoc < S.reserveSoc + 3);
    const fill = needsFill ? `<div class="row"><button data-act="fill" title="Insert intermediate Superchargers before this stop until it is reachable (prefers sites you have not visited)">⛽ Insert stops before</button></div>` : '';
    return `<article class="${cls}" data-id="${esc(stop.id)}" data-index="${i}">
      <header><span class="num">${i + 1}</span><div class="title"><b>${name}</b><small>${meta}</small></div>
        <div class="tools"><button class="ghost" data-act="locate" title="Show this stop on the map">📍</button><button class="ghost" data-act="swap" title="Replace this charger: click it, then pick another site from the map or the list">⇄</button><button class="ghost" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button><button class="ghost" data-act="down" title="Move down" ${i === tl.stops.length - 1 ? 'disabled' : ''}>▼</button><button class="ghost btn-remove" data-act="remove" title="Remove stop">✕</button></div></header>
      <div class="leg">${leg}</div>
      <div class="arrive">Arrive <b>${fmt.time(r.arrival)}</b> at <b class="soc arrival-soc ${socClass(r.arrivalSoc, S.reserveSoc)}">${fmt.pct(r.arrivalSoc)}</b></div>
      ${battHtml(r.arrivalSoc, r.departSoc, S.reserveSoc)}
      <div class="deadline ${dlCls}">${dl}</div>
      ${charge}${rest}${warns}${fill}
      <div class="depart">Depart <b>${fmt.time(r.depart)}</b> at <b class="soc depart-soc">${fmt.pct(r.departSoc)}</b></div>
    </article>`;
  }

  function destHtml(dr) {
    const S = store.trip.settings;
    let leg;
    if (dr.leg.status === 'ok') {
      const L2 = dr.leg;
      leg = `<b>${fmt.km(L2.km)}</b> · ${fmt.h(L2.driveH)} driving${L2.ferries ? ` · ⛴ ${L2.ferries} ferry ${fmt.h(L2.ferryH)}` : ''} · ↑${L2.gainM} m ↓${L2.lossM} m · <b>${fmt.whkm(L2.whKm)}</b> · ${fmt.temp(L2.temp)} <span class="muted">(${esc(L2.weatherSrc)})</span>`;
    } else if (dr.leg.status === 'failed') {
      leg = `<span class="soc bad">Route failed: ${esc(dr.leg.error)}</span>`;
    } else {
      leg = '<span class="muted">Routing…</span>';
    }
    const warns = dr.warnings.length ? `<ul class="warnings">${dr.warnings.map(w => `<li class="${w.level}">${esc(w.msg)}</li>`).join('')}</ul>` : '';
    const fillDest = dr.leg.status === 'failed' || (dr.leg.status === 'ok' && dr.arrivalSoc < S.reserveSoc)
      ? `<div class="row"><button data-act="fill-dest" title="Keep adding the nearest new Superchargers toward the destination (same as Auto-chain below)">⛽ Auto-chain toward the destination</button></div>` : '';
    return `<article class="stop dest-card" id="dest-card">
      <header><span class="num" style="background:#7c3aed;color:#fff">D</span><div class="title"><b>${esc(dr.destination.name)}</b><small>destination — end of the trip</small></div></header>
      <div class="leg">${leg}</div>
      <div class="arrive">Arrive <b>${fmt.time(dr.arrival)}</b> at <b class="soc ${socClass(dr.arrivalSoc, S.reserveSoc)}">${fmt.pct(dr.arrivalSoc)}</b></div>
      ${battHtml(dr.arrivalSoc, dr.arrivalSoc, S.reserveSoc)}
      ${warns}${fillDest}
    </article>`;
  }

  function candidatesHtml() {
    const trip = store.trip;
    const last = trip.stops[trip.stops.length - 1];
    const from = last ? last.name : trip.start.name;
    return `<section class="card candidates">
      <header><h3>${replaceId ? 'Replacing a stop — pick a site' : `Next stop from ${esc(from)}`}</h3><label title="Only sites closer to the destination"><input type="checkbox" id="cand-toward" ${trip.settings.candidates.toward ? 'checked' : ''} ${trip.destination ? '' : 'disabled'}> toward</label><button class="ghost" id="btn-cand-refresh" title="Refresh">↻</button></header>
      <div id="candidates">${candidatesListHtml()}</div>
      <div class="autochain"><input type="number" id="autochain-n" value="5" min="1" max="80" aria-label="Number of stops to add">${chaining ? '<button id="btn-chain-stop" class="danger">Stop</button>' : '<button id="btn-autochain" class="primary" title="Greedily add the nearest new sites (toward the destination if set)">Auto-chain stops</button>'}<span class="status" id="autochain-status"></span></div>
      <div class="autochain densify"><label title="Extra kilometres a site may add to a leg to be worth inserting">detour ≤ <input type="number" id="densify-km" value="25" min="1" max="200"> km</label><button id="btn-densify" title="Insert every extra Supercharger that fits between the stops you already have (and before the destination) without exceeding the detour, and without forcing a charge above the maximum set in Settings — maximises unique sites">⊕ Fill gaps with more sites</button></div>
    </section>`;
  }

  function candidatesListHtml() {
    if (cands.loading) return '<div class="candidate empty">Ranking nearby sites by road distance…</div>';
    if (cands.error) return `<div class="candidate empty">Could not rank sites: ${esc(cands.error)}</div>`;
    const list = candidatesWithSoc();
    if (!list.length) return '<div class="candidate empty">No new sites within the search radius (see Settings).</div>';
    const reserve = store.trip.settings.reserveSoc;
    return list.map(c => `<div class="candidate" data-site="${c.site.id}" title="Add ${esc(c.site.name)} as the next stop">
      <b>${c.site.iconic ? '🏅 ' : ''}${esc(c.site.name)}</b><span class="dist">${fmt.km(c.roadKm)} · ${fmt.h(c.roadH)} <button class="ghost cand-locate" data-locate="${c.site.id}" title="Show on the map">📍</button></span>
      <span class="meta">${c.site.kw || '?'} kW · ${c.site.stalls} stalls${c.progressKm != null ? ` · <span class="prog" title="Road-distance progress toward the destination gained by this hop; (line) = straight-line estimate when the routing table was unavailable">${c.progressKm >= 0 ? '+' : ''}${Math.round(c.progressKm)} km toward${c.progressSrc === 'road' ? '' : ' (line)'}</span>` : ''}${c.visitedYear ? ' · <span style="color:#f59e0b">↻ visited this year</span>' : ''}</span><span class="soc ${socClass(c.arrivalSoc, reserve)}">≈ ${fmt.pct(c.arrivalSoc)}</span>
    </div>`).join('');
  }

  function renderCandidates() {
    const c = el.querySelector('#candidates');
    if (c) c.innerHTML = candidatesListHtml();
    const bar = el.querySelector('.autochain');
    if (bar) bar.innerHTML = `<input type="number" id="autochain-n" value="${el.querySelector('#autochain-n')?.value || 5}" min="1" max="80" aria-label="Number of stops to add">${chaining ? '<button id="btn-chain-stop" class="danger">Stop</button>' : '<button id="btn-autochain" class="primary">Auto-chain stops</button>'}<span class="status" id="autochain-status"></span>`;
    map.setCandidates(candidatesWithSoc());
  }

  // ---------- candidates ----------
  function candKey() {
    const t = store.trip;
    const last = t.stops[t.stops.length - 1];
    return [last ? last.id : `start:${t.start.lat},${t.start.lng}`, t.destination ? `${t.destination.lat},${t.destination.lng}` : '', t.settings.candidates.toward, t.settings.candidates.maxKm, t.settings.candidates.limit, t.settings.osrmUrl, replaceId || ''].join('|');
  }

  /** When replacing, rank sites around the replaced stop: from its predecessor, toward its successor. */
  function candArgs() {
    if (!replaceId || !tl) return {};
    const t = store.trip;
    const i = t.stops.findIndex(x => x.id === replaceId);
    if (i < 0) return {};
    const originRes = i > 0 ? tl.stops[i - 1] : null;
    const next = t.stops[i + 1] || t.destination;
    return {
      from: originRes ? originRes.stop : t.start,
      fromSoc: originRes ? originRes.departSoc : +t.start.soc,
      destOverride: next ? { lat: next.lat, lng: next.lng } : null,
      toward: next ? true : undefined,
    };
  }

  async function refreshCandidates(force = false) {
    const key = candKey();
    if (!force && key === cands.key && !cands.error && !cands.loading) { renderCandidates(); return; }
    cands = { key, list: [], loading: true, error: null };
    renderCandidates();
    try {
      const list = await planner.candidates(candArgs());
      if (candKey() !== key) return;
      cands = { key, list, loading: false, error: null };
    } catch (e) {
      if (candKey() !== key) return;
      cands = { key, list: [], loading: false, error: String((e && e.message) || e) };
    }
    renderCandidates();
  }

  // ---------- mutations ----------
  async function buildMissing() {
    if (building) return;
    building = true;
    try {
      await planner.ensureLegs({ onProgress: (i, n) => setStatus(`Routing ${i}/${n}…`) });
    } finally {
      building = false;
      setStatus('');
    }
    const t = store.trip;
    let prev = t.start, missing = false;
    for (const s of t.stops) { const k = `${(+prev.lat).toFixed(5)},${(+prev.lng).toFixed(5)}>${(+s.lat).toFixed(5)},${(+s.lng).toFixed(5)}`; if (!t.legs[k]) missing = true; prev = s; }
    if (t.destination && t.destination.lat != null) { const d = t.destination; const k = `${(+prev.lat).toFixed(5)},${(+prev.lng).toFixed(5)}>${(+d.lat).toFixed(5)},${(+d.lng).toFixed(5)}`; if (!t.legs[k]) missing = true; }
    if (missing) { buildMissing(); /* something new appeared while building; failed legs retry via Retry/Recompute */ }
  }

  function performReplace(site) {
    const rid = replaceId;
    replaceId = null;
    let idx = -1;
    store.update(t => {
      idx = t.stops.findIndex(x => x.id === rid);
      if (idx < 0) return;
      const old = t.stops[idx];
      const ns = newStop({ site, targetSoc: old.charge ? old.charge.targetSoc : t.settings.defaultTargetSoc });
      ns.rest = old.rest ? { ...old.rest } : null;
      ns.note = old.note;
      t.stops[idx] = ns;
    });
    if (idx < 0) return;
    toast.success(`Stop #${idx + 1} is now ${site.name}`);
    planner.pruneLegs();
    map.closePopup();
    buildMissing().then(() => refreshCandidates(true));
  }

  /** Replace the armed stop with `site`; false when replace mode is not armed. */
  function replaceWith(site) {
    if (!replaceId || !site) return false;
    performReplace(site);
    return true;
  }

  async function addStop(site, { targetSoc = null } = {}) {
    if (!site) return;
    if (replaceId) { performReplace(site); return; }
    const stop = newStop({ site, targetSoc: targetSoc ?? store.trip.settings.defaultTargetSoc });
    store.update(t => { t.stops.push(stop); });
    map.closePopup();
    await buildMissing();
    planner.pruneLegs();
    refreshCandidates(true);
  }

  function addPoint(lat, lng, name) {
    const stop = newStop({ lat, lng, name: name || `Waypoint ${(+lat).toFixed(3)}, ${(+lng).toFixed(3)}` });
    store.update(t => { t.stops.push(stop); });
    buildMissing().then(() => { planner.pruneLegs(); refreshCandidates(true); });
  }

  function removeStop(id) {
    if (replaceId === id) replaceId = null;
    store.update(t => { t.stops = t.stops.filter(s => s.id !== id); });
    planner.pruneLegs();
    buildMissing().then(() => refreshCandidates(true));
  }

  function moveStop(id, dir) {
    store.update(t => {
      const i = t.stops.findIndex(s => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= t.stops.length) return;
      [t.stops[i], t.stops[j]] = [t.stops[j], t.stops[i]];
    });
    buildMissing().then(() => { planner.pruneLegs(); refreshCandidates(true); });
  }

  function setStart({ lat, lng, name }) {
    store.update(t => { t.start = { ...t.start, lat, lng, name: name || `${lat.toFixed(4)}, ${lng.toFixed(4)}` }; });
    search.start = { q: '', results: [], busy: false };
    map.closePopup();
    buildMissing().then(() => { planner.pruneLegs(); refreshCandidates(true); });
    render(tl);
  }

  function setDestination(dest) {
    store.update(t => { t.destination = dest; });
    search.dest = { q: '', results: [], busy: false };
    map.closePopup();
    if (dest) buildMissing().then(() => refreshCandidates(true));
    else refreshCandidates(true);
  }

  async function retryLeg(index) {
    const t = store.trip;
    const prev = index === 0 ? t.start : t.stops[index - 1];
    const stop = t.stops[index];
    setStatus(`Routing to ${stop.name}…`);
    await planner.buildLeg(prev, stop, { force: true, departTime: index === 0 ? tl.startTime : tl.stops[index - 1].depart });
    setStatus('');
  }

  async function runDensify() {
    if (chaining) return;
    chaining = true;
    stopChain = false;
    const km = Math.max(1, Number(el.querySelector('#densify-km')?.value) || 25);
    const cap = store.trip.settings.maxChargeSoc ?? 90;
    renderCandidates();
    let added = 0;
    try {
      added = await planner.densify({
        maxDetourKm: km,
        maxAdds: 40,
        shouldStop: () => stopChain,
        onProgress: (a, max, stop, best) => setStatus(`Fill gaps ${a}: ${stop.name} (+${Math.round(best.detourKm)} km)`),
      });
      toast.success(added ? `Inserted ${added} extra site${added === 1 ? '' : 's'} (detour ≤ ${km} km, never charging above ${cap} %)` : `Nothing fits within ${km} km detour and a ${cap} % charge cap — raise either in Settings`);
    } catch (e) {
      toast.error(`Fill gaps failed: ${(e && e.message) || e}`);
    }
    chaining = false;
    setStatus('');
    refreshCandidates(true);
  }

  async function runAutoChain() {
    if (chaining) return;
    chaining = true;
    stopChain = false;
    const n = Math.max(1, Number(el.querySelector('#autochain-n')?.value) || 5);
    renderCandidates();
    let added = 0;
    try {
      added = await planner.autoChain({
        n,
        shouldStop: () => stopChain,
        onProgress: (a, total, stop) => { setStatus(`Auto-chain ${a}/${total}: ${stop.name}`); const st = el.querySelector('#autochain-status'); if (st) st.textContent = `${a}/${total} · ${stop.name}`; },
      });
      toast.success(added ? `Added ${added} stop${added === 1 ? '' : 's'}` : 'No reachable new site found — raise the charge targets or the search radius');
    } catch (e) {
      toast.error(`Auto-chain failed: ${(e && e.message) || e}`);
    }
    chaining = false;
    setStatus('');
    refreshCandidates(true);
    if (added) map.fitTo(tripPoints());
  }

  async function runGapFill(id) {
    if (chaining) return;
    chaining = true;
    stopChain = false;
    renderCandidates();
    let added = 0;
    try {
      added = await planner.autoChain({ n: 10, beforeId: id, shouldStop: () => stopChain, onProgress: (a, total, stop) => setStatus(`Inserting ${a}: ${stop.name}`) });
      if (added) toast.success(`Inserted ${added} stop${added === 1 ? '' : 's'}`);
      else toast.error('No reachable intermediate site found — raise the previous charge target or the search radius');
    } catch (e) {
      toast.error(`Insert failed: ${(e && e.message) || e}`);
    }
    chaining = false;
    setStatus('');
    refreshCandidates(true);
  }

  function tripPoints() {
    const t = store.trip;
    return [[t.start.lat, t.start.lng], ...t.stops.map(s => [s.lat, s.lng]), ...(t.destination ? [[t.destination.lat, t.destination.lng]] : [])];
  }

  // ---------- search ----------
  const runSearch = debounce(async (kind, q) => {
    const st = search[kind];
    if (!q.trim()) { st.results = []; paintResults(kind); return; }
    const local = db.search(q, 5).map(s => ({ name: s.name, sub: `${STATUS_LABEL[s.status] || s.status} · ${s.stalls} stalls · ${s.kw} kW`, lat: s.lat, lng: s.lng, siteId: s.id }));
    st.results = local;
    paintResults(kind);
    try {
      const remote = await geocode(q);
      if (search[kind].q !== q) return;
      st.results = [...local, ...remote.map(r => ({ name: r.name, lat: r.lat, lng: r.lng }))];
    } catch (e) {
      if (!local.length) st.results = [{ name: `Search failed: ${(e && e.message) || e}`, lat: NaN, lng: NaN }];
    }
    paintResults(kind);
  }, 350);

  function paintResults(kind) {
    const box = el.querySelector(`#${kind}-results`);
    if (box) box.innerHTML = resultsHtml(kind);
  }

  // ---------- events ----------
  el.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'start-search' || t.id === 'dest-search') {
      const kind = t.id === 'start-search' ? 'start' : 'dest';
      search[kind].q = t.value;
      runSearch(kind, t.value);
    } else if (t.id === 'start-soc') {
      const out = el.querySelector('#start-soc-out');
      if (out) out.textContent = `${t.value} %`;
    } else if (t.classList.contains('charge-target')) {
      const out = t.closest('.charge').querySelector('.charge-out');
      if (out) out.textContent = `${t.value} %`;
    }
  });

  el.addEventListener('change', e => {
    const t = e.target;
    const card = t.closest('.stop');
    if (t.id === 'trip-name') { store.update(tr => { tr.meta.name = t.value.trim() || 'My contest trip'; }); return; }
    if (t.id === 'start-time') { if (t.value) store.update(tr => { tr.start.time = t.value; }); return; }
    if (t.id === 'start-soc') { store.update(tr => { tr.start.soc = Number(t.value); }); refreshCandidates(); return; }
    if (t.id === 'cand-toward') { store.update(tr => { tr.settings.candidates.toward = t.checked; }); refreshCandidates(true); return; }
    if (!card) return;
    const id = card.dataset.id;
    if (t.classList.contains('charge-target')) {
      store.update(tr => { const s = tr.stops.find(x => x.id === id); if (s) s.charge = { ...(s.charge || {}), targetSoc: Number(t.value) }; });
      if (Number(card.dataset.index) === store.trip.stops.length - 1) refreshCandidates();
    } else if (t.classList.contains('rest-hours') || t.classList.contains('rest-sentry')) {
      const hours = Number(card.querySelector('.rest-hours').value) || 0;
      const sentry = card.querySelector('.rest-sentry').checked;
      store.update(tr => { const s = tr.stops.find(x => x.id === id); if (s) s.rest = { hours, sentry }; });
    } else if (t.classList.contains('ac-enabled')) {
      store.update(tr => { const s = tr.stops.find(x => x.id === id); if (s) s.charge = t.checked ? { targetSoc: 80, kw: 11 } : null; });
    } else if (t.classList.contains('ac-target') || t.classList.contains('ac-kw')) {
      const targetSoc = Number(card.querySelector('.ac-target').value);
      const kw = Number(card.querySelector('.ac-kw').value) || 11;
      store.update(tr => { const s = tr.stops.find(x => x.id === id); if (s) s.charge = { targetSoc, kw }; });
    }
  });

  el.addEventListener('click', e => {
    const res = e.target.closest('.results div');
    if (res) {
      const lat = Number(res.dataset.lat), lng = Number(res.dataset.lng);
      if (!Number.isFinite(lat)) return;
      const place = { lat, lng, name: res.dataset.name };
      if (res.dataset.kind === 'start') { setStart(place); map.fitTo(tripPoints()); }
      else { setDestination(place); render(tl); map.fitTo(tripPoints()); }
      return;
    }
    const loc = e.target.closest('[data-locate]');
    if (loc) { e.stopPropagation(); map.openSite(Number(loc.dataset.locate)); return; }
    const cand = e.target.closest('.candidate[data-site]');
    if (cand) { addStop(db.byId(cand.dataset.site)); return; }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'btn-start-map') { pickMode = pickMode === 'start' ? null : 'start'; toast.show(pickMode ? 'Click on the map to set the start' : 'Cancelled'); render(tl); return; }
    if (b.id === 'btn-dest-map') { pickMode = pickMode === 'dest' ? null : 'dest'; toast.show(pickMode ? 'Click on the map to set the destination' : 'Cancelled'); render(tl); return; }
    if (b.id === 'btn-roundtrip') { const st = store.trip.start; setDestination({ lat: st.lat, lng: st.lng, name: `Back to ${st.name}` }); render(tl); return; }
    if (b.id === 'btn-dest-clear') { setDestination(null); render(tl); return; }
    if (b.id === 'btn-cand-refresh') { refreshCandidates(true); return; }
    if (b.id === 'btn-autochain') { runAutoChain(); return; }
    if (b.id === 'btn-densify') { runDensify(); return; }
    if (b.id === 'btn-chain-stop') { stopChain = true; b.disabled = true; return; }
    if (b.dataset.act === 'fill-dest') { runAutoChain(); return; }
    const card = b.closest('.stop');
    if (!card || !b.dataset.act) return;
    const id = card.dataset.id;
    const index = Number(card.dataset.index);
    if (b.dataset.act === 'remove') removeStop(id);
    else if (b.dataset.act === 'up') moveStop(id, -1);
    else if (b.dataset.act === 'down') moveStop(id, +1);
    else if (b.dataset.act === 'retry') retryLeg(index);
    else if (b.dataset.act === 'fill') runGapFill(id);
    else if (b.dataset.act === 'locate') {
      const s = store.trip.stops.find(x => x.id === id);
      if (!s) return;
      if (s.siteId != null) map.openSite(s.siteId);
      else map.panToShow(s.lat, s.lng);
    } else if (b.dataset.act === 'swap') {
      replaceId = replaceId === id ? null : id;
      toast.show(replaceId ? `Pick a charger from the map or the list below to replace stop #${index + 1} (charge/rest settings are kept)` : 'Replace cancelled');
      render(tl);
      refreshCandidates(true);
    }
  });

  el.addEventListener('mouseover', e => {
    const c = e.target.closest('.candidate[data-site]');
    if (c) { map.highlight(Number(c.dataset.site)); return; }
    const card = e.target.closest('.stop[data-id]');
    if (card) {
      const s = store.trip.stops.find(x => x.id === card.dataset.id);
      map.highlight(s && s.siteId != null ? s.siteId : null);
      return;
    }
    map.highlight(null);
  });
  el.addEventListener('mouseleave', () => map.highlight(null));

  map.on('mapClick', ({ lat, lng }) => {
    if (!pickMode) return;
    const mode = pickMode;
    pickMode = null;
    if (mode === 'start') setStart({ lat, lng, name: `Map point ${lat.toFixed(4)}, ${lng.toFixed(4)}` });
    else { setDestination({ lat, lng, name: `Map point ${lat.toFixed(4)}, ${lng.toFixed(4)}` }); render(tl); }
    toast.success(mode === 'start' ? 'Start set' : 'Destination set');
  });

  return { render, refreshCandidates, addStop, addPoint, setStart, setDestination, removeStop, buildMissing, tripPoints, replaceWith, get replacingId() { return replaceId; }, get candidates() { return cands; } };
}
