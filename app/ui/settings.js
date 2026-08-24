// Settings panel: renders a form from the trip document and writes changes back by data attributes.
import { CARS } from '../model/cars.js';
import { PROFILES } from '../model/profiles.js';
import { TILES } from './map.js';
import { esc } from './format.js';

const STATUSES = ['OPEN', 'EXPANDING', 'CLOSED_TEMP', 'CONSTRUCTION', 'PERMIT', 'PLAN', 'VOTING', 'CLOSED_PERM'];

const num = (label, attr, value, { step = 1, min = null, max = null, unit = '' } = {}) =>
  `<label class="field">${label}${unit ? ` (${unit})` : ''}<input type="number" ${attr} value="${value}" step="${step}"${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}></label>`;
const check = (label, attr, on) => `<label class="check"><input type="checkbox" ${attr} ${on ? 'checked' : ''}> ${label}</label>`;

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[parts[parts.length - 1]] = value;
}

export function renderSettings(el, trip, db) {
  const S = trip.settings;
  const car = trip.car;
  const p = trip.profile;
  const s = path => `data-setting="${path}"`;
  const carOpts = CARS.map(c => `<option value="${c.id}" ${c.id === car.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('') + (CARS.some(c => c.id === car.id) ? '' : `<option value="custom" selected>Custom</option>`);
  const profOpts = PROFILES.map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('') + (PROFILES.some(x => x.id === p.id) ? '' : `<option value="custom" selected>Custom</option>`);
  const visited = (trip.visitedBefore || []).map(id => { const site = db && db.byId(id); return `<div><span>${esc(site ? site.name : `site #${id}`)}</span><button class="ghost" data-act="unvisit" data-site="${id}" title="Remove">✕</button></div>`; }).join('');
  el.innerHTML = `
  <div class="settings">
    <h2>Contest rules</h2>
    <div class="grid2">
      ${num('Streak window', s('rules.windowH'), S.rules.windowH, { min: 1, max: 168, unit: 'h' })}
      <label class="field">Timer anchor<select ${s('rules.anchor')}><option value="start" ${S.rules.anchor === 'start' ? 'selected' : ''}>previous session start (category text, stricter)</option><option value="end" ${S.rules.anchor === 'end' ? 'selected' : ''}>previous session end (trip text, lenient)</option></select></label>
      ${num('Warn when margin below', s('rules.marginMin'), S.rules.marginMin, { min: 0, unit: 'min' })}
      ${num('Min session', s('rules.minSessionMin'), S.rules.minSessionMin, { min: 0, unit: 'min' })}
      ${num('Min session energy', s('rules.minSessionKwh'), S.rules.minSessionKwh, { min: 0, step: 0.5, unit: 'kWh' })}
      ${num('Charge at least', s('rules.minSessionPct'), S.rules.minSessionPct, { min: 0, max: 50, unit: '% per site, so a session registers' })}
      <label class="field">Competition period start<input type="datetime-local" ${s('rules.periodStart')} value="${esc(S.rules.periodStart || '')}"></label>
      <label class="field">Competition period end<input type="datetime-local" ${s('rules.periodEnd')} value="${esc(S.rules.periodEnd || '')}"></label>
    </div>
    <p class="muted" style="margin:2px 0 0">Tesla's page says both "within 24 hours of the previous session's start time" and "within 24 hours of the end of your previous session"; plan with the stricter one.</p>

    <h2>Car</h2>
    <label class="field">Preset<select id="car-select">${carOpts}</select></label>
    <div class="grid2">
      ${num('Usable battery', 'data-car="usableKwh"', car.usableKwh, { step: 0.5, min: 10, unit: 'kWh' })}
      ${num('Max DC power', 'data-car="maxDcKw"', car.maxDcKw, { min: 10, unit: 'kW' })}
      ${num('Mass', 'data-car="massKg"', car.massKg, { min: 500, unit: 'kg' })}
      ${num('Payload (people + luggage)', 'data-car="payloadKg"', car.payloadKg, { min: 0, unit: 'kg' })}
      ${num('Drag coefficient Cd', 'data-car="cd"', car.cd, { step: 0.005, min: 0.1 })}
      ${num('Frontal area', 'data-car="areaM2"', car.areaM2, { step: 0.05, min: 1, unit: 'm²' })}
      ${num('Rolling resistance Crr', 'data-car="crr"', car.crr, { step: 0.0005, min: 0.004 })}
      ${num('Drivetrain efficiency', 'data-car="etaDrive"', car.etaDrive, { step: 0.01, min: 0.5, max: 1 })}
      ${num('Regen efficiency', 'data-car="etaRegen"', car.etaRegen, { step: 0.01, min: 0, max: 1 })}
      ${num('Reference consumption', 'data-car="refWhKm"', car.refWhKm, { min: 80, unit: 'Wh/km' })}
    </div>

    <h2>Driving style</h2>
    <label class="field">Preset<select id="profile-select">${profOpts}</select></label>
    <div class="grid2">
      ${num('Over the limit', 'data-profile="offsetKmh"', p.offsetKmh, { min: -30, max: 40, unit: 'km/h, roads ≥ 60' })}
      ${num('Speed factor', 'data-profile="speedFactor"', p.speedFactor, { step: 0.01, min: 0.5, max: 1.3 })}
      ${num('Max speed', 'data-profile="maxKmh"', p.maxKmh, { min: 50, max: 250, unit: 'km/h' })}
      ${num('Breaks per hour driven', 'data-profile="breakMinPerH"', p.breakMinPerH, { min: 0, max: 30, unit: 'min' })}
    </div>

    <h2>Battery &amp; safety</h2>
    <div class="grid2">
      ${num('Reserve at arrival', s('reserveSoc'), S.reserveSoc, { min: 0, max: 50, unit: '%' })}
      ${num('Consumption margin', s('marginPct'), S.marginPct, { min: -20, max: 50, unit: '% (car estimate is optimistic)' })}
      ${num('Default charge target', s('defaultTargetSoc'), S.defaultTargetSoc, { min: 5, max: 100, unit: '%' })}
      ${num('Never charge above', s('maxChargeSoc'), S.maxChargeSoc, { min: 50, max: 100, unit: '% (above this the curve crawls)' })}
      ${num('Plug-in overhead', s('plugOverheadMin'), S.plugOverheadMin, { min: 0, unit: 'min per stop' })}
      ${num('Ferry wait', s('ferryWaitMin'), S.ferryWaitMin, { min: 0, unit: 'min per crossing' })}
    </div>
    ${check('Assume battery preconditioning when arriving cold (navigate to the Supercharger)', s('precondition'), S.precondition)}

    <h2>Parked drain</h2>
    <div class="grid2">
      ${num('Sentry on', s('sentry.onPctH'), S.sentry.onPctH, { step: 0.01, min: 0, unit: '%/h' })}
      ${num('Sentry off', s('sentry.offPctH'), S.sentry.offPctH, { step: 0.01, min: 0, unit: '%/h' })}
      ${num('Cold factor below 0 °C', s('sentry.coldFactor'), S.sentry.coldFactor, { step: 0.1, min: 1 })}
    </div>

    <h2>Weather override</h2>
    ${check('Use fixed weather for every leg instead of forecasts', s('weatherOverride.enabled'), S.weatherOverride.enabled)}
    <div class="grid2">
      ${num('Temperature', s('weatherOverride.tempC'), S.weatherOverride.tempC, { step: 0.5, unit: '°C' })}
      ${num('Wind speed', s('weatherOverride.windKmh'), S.weatherOverride.windKmh, { min: 0, unit: 'km/h' })}
      ${num('Wind from', s('weatherOverride.windFromDeg'), S.weatherOverride.windFromDeg, { min: 0, max: 360, unit: '° (0 = north)' })}
      ${num('Precipitation', s('weatherOverride.precipMm'), S.weatherOverride.precipMm, { step: 0.1, min: 0, unit: 'mm/h' })}
    </div>

    <h2>Filling a leg</h2>
    <div class="grid2">
      ${num('Start detour budget', s('fill.startDetourKm'), S.fill.startDetourKm, { min: 1, max: 200, unit: 'km — tried first' })}
      ${num('Widen up to', s('fill.maxDetourKm'), S.fill.maxDetourKm, { min: 1, max: 400, unit: 'km when nothing fits' })}
      ${num('Sites per click', s('fill.perRun'), S.fill.perRun, { min: 1, max: 20, unit: '— click again to go deeper' })}
    </div>
    <p class="muted" style="margin:2px 0 0">Each click inserts into the longest remaining stretch first (middle, then quarters…), keeping the detour as small as possible.</p>

    <h2>Next-stop search</h2>
    <div class="grid2">
      ${num('Candidates shown', s('candidates.limit'), S.candidates.limit, { min: 3, max: 50 })}
      ${num('Search radius', s('candidates.maxKm'), S.candidates.maxKm, { min: 50, max: 1500, unit: 'km straight line' })}
    </div>
    ${check('Only sites that make progress toward the destination', s('candidates.toward'), S.candidates.toward)}

    <h2>Map</h2>
    <label class="field">Tiles<select ${s('tiles')}>${Object.entries(TILES).map(([k, t]) => `<option value="${k}" ${S.tiles === k ? 'selected' : ''}>${t.name}</option>`).join('')}</select></label>
    <div class="field">Show site statuses<div class="statuses">${STATUSES.map(st => `<label class="check"><input type="checkbox" data-status="${st}" ${S.showStatuses.includes(st) ? 'checked' : ''}> ${st.toLowerCase().replace('_', ' ')}</label>`).join('')}</div></div>

    <h2>Services</h2>
    <label class="field">OSRM server (self-host for heavy use)<input type="url" ${s('osrmUrl')} value="${esc(S.osrmUrl)}"></label>

    <h2>Visited earlier this year (${(trip.visitedBefore || []).length})</h2>
    <p class="muted" style="margin:4px 0 6px">Mark sites from the map popup. They still count in a streak but not toward the yearly "unique sites" number.</p>
    <div class="visited-list">${visited || '<span class="muted">none</span>'}</div>
    ${(trip.visitedBefore || []).length ? '<button class="ghost" data-act="clear-visited">Clear list</button>' : ''}

    <h2>Data</h2>
    <p class="muted" style="margin:4px 0">${db ? `${db.sites.length} sites from supercharge.info, generated ${esc((db.generated || '').slice(0, 10))}` : 'no database loaded'}.<br>Refresh with <code>python tools/fetch_chargers.py</code>.</p>
  </div>`;
}

const clone = o => JSON.parse(JSON.stringify(o));

/** hooks: { onTiles(key), onOsrmUrl(url), onStatuses(), onModel(), rerender() } */
export function bindSettings(el, store, hooks = {}) {
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.setting) {
      const path = t.dataset.setting;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
      if (t.type === 'number' && !Number.isFinite(v)) { t.value = getPath(store.trip.settings, path); return; }
      store.update(trip => setPath(trip.settings, path, v));
      if (path === 'tiles' && hooks.onTiles) hooks.onTiles(v);
      if (path === 'osrmUrl' && hooks.onOsrmUrl) hooks.onOsrmUrl(v);
      if (path.startsWith('candidates.') && hooks.onCandidates) hooks.onCandidates();
      return;
    }
    if (t.dataset.car) {
      const v = Number(t.value);
      if (!Number.isFinite(v)) return;
      store.update(trip => { trip.car[t.dataset.car] = v; if (CARS.some(c => c.id === trip.car.id && c[t.dataset.car] !== v)) trip.car.id = 'custom'; });
      return;
    }
    if (t.dataset.profile) {
      const v = Number(t.value);
      if (!Number.isFinite(v)) return;
      store.update(trip => { trip.profile[t.dataset.profile] = v; if (PROFILES.some(p => p.id === trip.profile.id && p[t.dataset.profile] !== v)) trip.profile.id = 'custom'; });
      return;
    }
    if (t.id === 'car-select') {
      const c = CARS.find(x => x.id === t.value);
      if (c) { store.update(trip => { trip.car = clone(c); }); if (hooks.rerender) hooks.rerender(); }
      return;
    }
    if (t.id === 'profile-select') {
      const p = PROFILES.find(x => x.id === t.value);
      if (p) { store.update(trip => { trip.profile = clone(p); }); if (hooks.rerender) hooks.rerender(); }
      return;
    }
    if (t.dataset.status) {
      const st = t.dataset.status;
      store.update(trip => {
        const set = new Set(trip.settings.showStatuses);
        if (t.checked) set.add(st); else set.delete(st);
        trip.settings.showStatuses = STATUSES.filter(x => set.has(x));
      });
      if (hooks.onStatuses) hooks.onStatuses();
    }
  });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'unvisit') store.update(trip => { trip.visitedBefore = trip.visitedBefore.filter(id => id !== Number(b.dataset.site)); });
    if (b.dataset.act === 'clear-visited') store.update(trip => { trip.visitedBefore = []; });
    if (hooks.rerender) hooks.rerender();
  });
}
