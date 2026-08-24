// Day-by-day itinerary: days as columns, events (driving, charging, rests) placed on an
// hour grid like a calendar. Pure DOM rendering from the computed timeline.
import { fmt, esc } from './format.js';

const DAY = 864e5;
const HOUR_PX = 26;

function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Flatten the timeline into [{kind: 'drive'|'charge'|'rest', from, to, label, sub, i, broken}]. */
export function buildEvents(tl, trip) {
  const ev = [];
  let prevName = trip.start.name;
  let prevDepart = tl.startTime;
  for (const r of tl.stops) {
    if (r.leg.status === 'ok' && r.arrival > prevDepart) {
      ev.push({ kind: 'drive', from: prevDepart, to: r.arrival, i: r.i, label: `→ ${r.stop.name}`, sub: `${fmt.km(r.leg.km)}${r.leg.ferries ? ' · ⛴' : ''} · ${fmt.pct(r.arrivalSoc)}` });
    }
    if (r.session && r.session.kwhStored > 0.05) {
      ev.push({ kind: 'charge', from: r.arrival, to: r.session.end, i: r.i, broken: r.session.broken, label: `⚡${Math.round(Math.max(0, r.arrivalSoc))}→${Math.round(r.session.targetSoc)}%`, sub: `${r.stop.name} · ${fmt.kwh(r.session.kwhStored)}` });
    }
    if (r.rest) {
      ev.push({ kind: 'rest', from: r.rest.start, to: r.rest.end, i: r.i, label: `😴 ${r.stop.name}`, sub: `${r.rest.hours} h${r.rest.sentry ? ' · Sentry' : ''} · −${fmt.n1(r.rest.drainPct)} %` });
    }
    prevName = r.stop.name;
    prevDepart = r.depart;
  }
  if (tl.destination && tl.destination.leg.status === 'ok' && tl.destination.arrival > prevDepart) {
    ev.push({ kind: 'drive', from: prevDepart, to: tl.destination.arrival, i: -1, label: `→ ${tl.destination.destination.name}`, sub: `${fmt.km(tl.destination.leg.km)} · ${fmt.pct(tl.destination.arrivalSoc)}` });
  }
  return ev;
}

export function renderItinerary(el, tl, trip) {
  const events = buildEvents(tl, trip);
  if (!events.length) {
    el.innerHTML = '<div class="itin-empty">Add stops to see the day-by-day itinerary. Driving, charging sessions and rests are laid out here on an hour grid, one column per day.</div>';
    return;
  }
  const t0 = dayStart(Math.min(tl.startTime, events[0].from));
  const tEnd = Math.max(tl.summary.eta, ...events.map(e => e.to));
  const days = Math.max(1, Math.min(45, Math.ceil((tEnd - t0) / DAY)));
  const colH = 24 * HOUR_PX;
  let html = '<div class="itin-grid">';
  html += `<div class="itin-gutter"><div class="itin-dayhead"></div><div class="itin-col" style="height:${colH}px">${Array.from({ length: 24 }, (_, h) => `<div class="itin-hourlbl" style="top:${h * HOUR_PX}px">${String(h).padStart(2, '0')}</div>`).join('')}</div></div>`;
  for (let d = 0; d < days; d++) {
    const ds = t0 + d * DAY;
    const de = ds + DAY;
    // Calendar-elastic layout: blocks keep their time position when possible, but every block
    // gets a readable minimum height and is pushed down (growing the day) instead of overlapping.
    const laneBottom = { left: -1e9, right: -1e9 };
    let colBottom = colH;
    let evHtml = '';
    for (const e of events) {
      const from = Math.max(e.from, ds);
      const to = Math.min(e.to, de);
      if (to <= from) continue;
      const lane = e.kind === 'charge' ? 'right' : 'left';
      const minH = e.kind === 'charge' ? 30 : 26;
      let top = (from - ds) / 36e5 * HOUR_PX;
      if (top < laneBottom[lane] + 2) top = laneBottom[lane] + 2;
      const height = Math.max(minH, (to - from) / 36e5 * HOUR_PX - 1);
      laneBottom[lane] = top + height;
      if (top + height > colBottom) colBottom = top + height;
      const cont = `${e.from < ds ? '… ' : ''}${e.to > de ? '(continues) ' : ''}`;
      evHtml += `<div class="itin-ev ${e.kind}${e.broken ? ' broken' : ''}" data-i="${e.i}" style="top:${top}px;height:${height}px" title="${esc(e.label)} · ${fmt.clock(e.from)}–${fmt.clock(e.to)} · ${esc(e.sub)}"><b>${esc(cont)}${esc(e.label)}</b>${height >= 22 ? `<small>${fmt.clock(e.from)}–${fmt.clock(e.to)} · ${esc(e.sub)}</small>` : ''}</div>`;
    }
    const dl = tl.summary.nextDeadline;
    if (dl != null && dl >= ds && dl < de) {
      evHtml += `<div class="itin-deadline" style="top:${(dl - ds) / 36e5 * HOUR_PX}px" title="The next new site's charging session must start before ${fmt.time(dl)}"><span>⏱ next site by ${fmt.clock(dl)}</span></div>`;
    }
    html += `<div class="itin-day"><div class="itin-dayhead">${fmt.day(ds)}</div><div class="itin-col" style="height:${Math.ceil(colBottom) + 10}px">`;
    for (let h = 2; h < 24; h += 2) html += `<div class="itin-line" style="top:${h * HOUR_PX}px"></div>`;
    html += evHtml + '</div></div>';
  }
  html += '</div>';
  el.innerHTML = html;
}
