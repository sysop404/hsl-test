// Reittiopas Plus: UI wiring.

import { createApi } from './api.js';
import { mockFetch, mockMqtt } from './mock.js';
import { createMap, modeColor } from './map.js';
import { createLiveTracker } from './live.js';
import { planB } from './planb.js';
import { transferGaps } from './plan.js';
import { runSweep } from './sweep.js';
import { applyLiveTimes, tripPhase, withLegs } from './timer.js';
import { MODES, exportSettings, importSettings, loadSettings, saveSettings } from './settings.js';
import { fmtCountdown, fmtDuration, helsinkiDate, helsinkiParts, helsinkiToMs, hhmm } from './time.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODE_NAMES = { BUS: 'Bus', TRAM: 'Tram', SUBWAY: 'Metro', RAIL: 'Train', FERRY: 'Ferry', WALK: 'Walk' };

const state = {
  settings: loadSettings(),
  from: null,
  to: null,
  itineraries: [],
  openIndex: -1,
  lastQuery: null,
  trip: null,
  vehicles: new Map(), // legIndex -> latest vehicle info for the displayed itinerary
  displayedLegs: [],
};

const isDemo = () => state.settings.apiKey.toLowerCase() === 'demo';
const api = createApi({ getKey: () => state.settings.apiKey, fetchImpl: (...a) => (isDemo() ? mockFetch(...a) : fetch(...a)) });

const map = createMap($('#map'), { onPick: pickFromMap });

let tracker = null;
function getTracker() {
  if (!tracker) {
    tracker = createLiveTracker({
      mqttLib: isDemo() ? mockMqtt(() => state.displayedLegs) : globalThis.mqtt,
      onUpdate: onVehicle,
    });
  }
  return tracker;
}
function resetTracker() {
  tracker?.close();
  tracker = null;
  map.clearVehicles();
  state.vehicles.clear();
}

// ---------- messages ----------

function showMessage(text, kind = 'info') {
  const el = $('#message');
  el.hidden = !text;
  el.className = `message ${kind === 'error' ? 'error' : ''}`;
  el.innerHTML = text ?? '';
}

function handleError(e) {
  console.error(e);
  const needsKey = e.status === 0 || e.status === 401 || e.status === 403;
  showMessage(`${esc(e.message || 'Something went wrong.')}${needsKey ? ' <button type="button" id="msg-settings">Open settings</button>' : ''}`, 'error');
  $('#msg-settings')?.addEventListener('click', openSettings);
}

// ---------- places ----------

function setPlace(which, place) {
  state[which] = place;
  $(`#${which}`).value = place?.name ?? '';
  map.setPlaces(state.from, state.to);
  updateStars();
}

async function pickFromMap(which, lat, lon) {
  const place = { name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
  setPlace(which, place);
  try {
    const name = await api.reverse(lat, lon);
    if (name && state[which] === place) setPlace(which, { ...place, name });
  } catch { /* the coordinate label is fine */ }
  if (state.from && state.to) search();
}

function setupAutocomplete(which) {
  const input = $(`#${which}`);
  const list = $(`#${which}-suggest`);
  let timer = null;
  let items = [];
  let sel = -1;
  let seq = 0;

  const close = () => { list.innerHTML = ''; items = []; sel = -1; };
  const choose = (i) => {
    if (!items[i]) return;
    setPlace(which, items[i]);
    close();
    if (which === 'from' && !state.to) $('#to').focus();
    else if (state.from && state.to) search();
  };
  const render = () => {
    list.innerHTML = items.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}">${esc(p.name)}</li>`).join('');
  };

  input.addEventListener('input', () => {
    state[which] = null;
    updateStars();
    clearTimeout(timer);
    const text = input.value.trim();
    const saved = state.settings.places.filter((p) => p.name.toLowerCase().includes(text.toLowerCase()));
    if (text.length < 3) { items = text ? saved : []; sel = -1; render(); return; }
    timer = setTimeout(async () => {
      const mySeq = ++seq;
      try {
        const res = await api.autocomplete(text, state.from ?? state.to ?? { lat: 60.1699, lon: 24.9384 });
        if (mySeq !== seq) return;
        items = [...saved, ...res].slice(0, 10);
        sel = -1;
        render();
      } catch (e) {
        handleError(e);
      }
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel >= 0 ? sel : 0); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); choose(+li.dataset.i); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

function renderSavedPlaces() {
  const box = $('#saved-places');
  box.innerHTML = state.settings.places.map((p, i) => `<button type="button" class="chip" data-i="${i}">${esc(p.name)}</button>`).join('');
}

function updateStars() {
  for (const b of document.querySelectorAll('.star')) {
    const p = state[b.dataset.for];
    const saved = p && state.settings.places.some((q) => samePlace(q, p));
    b.classList.toggle('on', !!saved);
    b.textContent = saved ? '★' : '☆';
  }
}

const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;

function persist() {
  if (!saveSettings(state.settings)) showMessage('Could not save settings in this browser (private mode?). They will last until you close the page.');
}

// ---------- search ----------

function queryTime() {
  const mode = $('#when-mode').value;
  if (mode === 'now') return { time: Date.now(), arriveBy: false };
  const v = $('#when-time').value; // "YYYY-MM-DDTHH:mm" in Helsinki time (we treat it as such)
  if (!v) return { time: Date.now(), arriveBy: false };
  const [d, t] = v.split('T');
  const [h, m] = t.split(':').map(Number);
  return { time: helsinkiToMs(d, h, m), arriveBy: mode === 'arrive' };
}

async function search({ append = false } = {}) {
  if (!state.from || !state.to) {
    showMessage('Choose a start and a destination first. You can also tap the map.');
    return;
  }
  showMessage('');
  activateTab('results');
  const btn = $('#btn-search');
  btn.disabled = true;
  try {
    let q;
    if (append && state.lastQuery && state.itineraries.length) {
      const last = state.itineraries[state.itineraries.length - 1];
      q = { ...state.lastQuery, time: last.start + 60_000, arriveBy: false };
    } else {
      q = { from: state.from, to: state.to, first: 6, ...queryTime() };
    }
    if (!append) $('#tab-results').innerHTML = '<p class="hint">Searching…</p>';
    const res = await api.plan(state.settings, q);
    state.lastQuery = q;
    const seen = new Set(append ? state.itineraries.map((i) => i.key) : []);
    const fresh = res.itineraries.filter((i) => !seen.has(i.key));
    state.itineraries = append ? [...state.itineraries, ...fresh] : res.itineraries;
    if (!append) state.openIndex = state.itineraries.length ? 0 : -1;
    renderResults();
    if (!state.itineraries.length) {
      const why = res.errors.map((e) => e.description).join(' ');
      showMessage(`No routes found. ${esc(why)}`);
    }
  } catch (e) {
    handleError(e);
    if (!append) $('#tab-results').innerHTML = '';
  } finally {
    btn.disabled = false;
  }
}

function delayClass(leg) {
  const d = (leg.start - leg.startScheduled) / 1000;
  if (!leg.realtime) return '';
  if (d >= 60) return 'late';
  if (d <= -60) return 'early';
  return 'ontime';
}

function badge(leg) {
  if (!leg.transit) return `<span class="badge WALK">🚶${Math.max(1, Math.round((leg.end - leg.start) / 60000))}</span>`;
  const style = leg.route?.color ? ` style="background:${esc(leg.route.color)}"` : '';
  return `<span class="badge ${esc(leg.mode)}"${style}>${esc(leg.route?.short || MODE_NAMES[leg.mode] || leg.mode)}</span>`;
}

function timeCell(planned, actual, realtime) {
  const late = Math.round((actual - planned) / 60000);
  if (!realtime || late === 0) return `<b>${hhmm(actual)}</b>`;
  return `<b class="${late > 0 ? 'late' : 'early'}">${hhmm(actual)}</b><br><s class="small">${hhmm(planned)}</s>`;
}

function renderResults() {
  const box = $('#tab-results');
  if (!state.itineraries.length) { box.innerHTML = ''; map.drawItinerary(null); return; }
  const slackSec = state.settings.transferSlackMin * 60;
  box.innerHTML = state.itineraries.map((it, i) => {
    const gaps = transferGaps(it);
    const tightest = gaps.length ? gaps.reduce((a, b) => (a.seconds < b.seconds ? a : b)) : null;
    const firstTransit = it.legs.find((l) => l.transit);
    return `
    <details class="itin" data-i="${i}" ${i === state.openIndex ? 'open' : ''}>
      <summary>
        <div class="itin-head">
          <span class="itin-time">${hhmm(it.start)} – ${hhmm(it.end)}</span>
          <span class="itin-dur">${fmtDuration(it.duration)}</span>
        </div>
        <div class="legs-bar">${it.legs.map(badge).join('<span class="small">›</span>')}</div>
        <div class="itin-meta">
          ${firstTransit ? `<span class="${delayClass(firstTransit)}">${esc(firstTransit.route?.short ?? '')} from ${esc(firstTransit.from.name)} ${hhmm(firstTransit.start)}</span>` : '<span>Walk only</span>'}
          <span>${it.transfers} transfer${it.transfers === 1 ? '' : 's'}</span>
          ${tightest ? `<span class="${tightest.seconds < slackSec + 60 ? 'tight' : ''}">tightest ${Math.round(tightest.seconds / 60)} min at ${esc(tightest.at)}</span>` : ''}
          <span>walk ${Math.round(it.walkDistance)} m</span>
        </div>
      </summary>
      <div class="itin-body">${legDetails(it, i)}
        <div class="itin-actions">
          <button type="button" class="primary" data-start="${i}">Start trip</button>
        </div>
      </div>
    </details>`;
  }).join('') + '<button type="button" id="btn-later">Later departures</button>';

  for (const d of box.querySelectorAll('details.itin')) {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      for (const other of box.querySelectorAll('details.itin')) if (other !== d) other.open = false;
      state.openIndex = +d.dataset.i;
      showItinerary(state.itineraries[state.openIndex]);
    });
  }
  box.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => startTrip(state.itineraries[+b.dataset.start])));
  box.querySelectorAll('[data-planb]').forEach((b) => b.addEventListener('click', () => loadPlanB(b)));
  $('#btn-later').addEventListener('click', () => search({ append: true }));
  if (state.openIndex >= 0) showItinerary(state.itineraries[state.openIndex]);
}

function legDetails(it, itinIndex) {
  return it.legs.map((leg, li) => {
    if (!leg.transit) {
      const mins = Math.max(1, Math.round((leg.end - leg.start) / 60000));
      return `<div class="leg"><div class="t">${hhmm(leg.start)}</div><div class="what small">🚶 Walk ${mins} min (${Math.round(leg.distance)} m) to ${esc(leg.to.name)}</div></div>`;
    }
    const stopCode = leg.from.code ? ` <span class="small">${esc(leg.from.code)}${leg.from.platform ? ` · platform ${esc(leg.from.platform)}` : ''}</span>` : '';
    return `<div class="leg">
      <div class="t">${timeCell(leg.startScheduled, leg.start, leg.realtime)}</div>
      <div class="what">
        <div>${badge(leg)} ${esc(MODE_NAMES[leg.mode] ?? leg.mode)} towards ${esc(leg.headsign)}</div>
        <div class="small">from ${esc(leg.from.name)}${stopCode}</div>
        ${leg.alerts.map((a) => `<div class="alert">⚠️ ${esc(a)}</div>`).join('')}
        <div class="planb"><button type="button" data-planb="${itinIndex}:${li}">If I miss this…</button><div class="res" hidden></div></div>
      </div>
    </div>
    <div class="leg"><div class="t">${timeCell(leg.endScheduled, leg.end, leg.realtime)}</div><div class="what small">get off at ${esc(leg.to.name)}</div></div>`;
  }).join('');
}

async function loadPlanB(btn, itinOverride) {
  const [ii, li] = btn.dataset.planb.split(':').map(Number);
  const itinerary = itinOverride ?? state.itineraries[ii];
  const out = btn.nextElementSibling;
  btn.disabled = true;
  out.hidden = false;
  out.textContent = 'Looking for the next best option…';
  try {
    const r = await planB({ plan: (o) => api.plan(state.settings, o), itinerary, legIndex: li, to: state.to ?? lastPlace(itinerary) });
    out.innerHTML = describePlanB(r);
  } catch (e) {
    out.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

const lastPlace = (it) => it.legs[it.legs.length - 1].to;

function describePlanB(r) {
  if (!r) return 'No alternative found from this stop.';
  const first = r.itinerary.legs.find((l) => l.transit);
  const line = first ? `${badge(first)} at ${hhmm(first.start)}` : 'walk';
  const plus = Math.round(r.delaySec / 60);
  return `Next best: ${line}, arriving ${hhmm(r.itinerary.end)} <b class="${plus > 0 ? 'late' : 'ontime'}">${plus > 0 ? `+${plus}` : plus} min</b>`;
}

/** Show an itinerary on the map and follow its vehicles. */
function showItinerary(it, opts) {
  map.drawItinerary(it, opts);
  if (state.displayedLegs !== it.legs) {
    map.clearVehicles();
    state.vehicles.clear();
    state.displayedLegs = it.legs;
    getTracker().setLegs(it.legs.map((l) => (l.end > Date.now() - 60_000 ? l : { ...l, transit: false })));
  }
}

function onVehicle(legIndex, v) {
  const leg = state.displayedLegs[legIndex];
  if (!leg) return;
  const expected = leg.trip?.startSec !== null && leg.trip?.startSec !== undefined;
  map.setVehicle(`${legIndex}:${v.id}`, v, { mode: leg.mode, label: esc(leg.route?.short ?? ''), highlight: expected });
  state.vehicles.set(legIndex, v);
}

// ---------- sweep ----------

async function sweep() {
  if (!state.from || !state.to) {
    showMessage('Choose a start and a destination first.');
    activateTab('sweep');
    return;
  }
  showMessage('');
  activateTab('sweep');
  const date = $('#sweep-date').value || helsinkiDate(Date.now());
  const fromHour = +$('#sweep-from').value;
  const toHour = +$('#sweep-to').value;
  if (!(toHour > fromHour)) { showMessage('The sweep needs an end hour after the start hour.'); return; }
  state.settings.sweepFromHour = fromHour;
  state.settings.sweepToHour = toHour;
  persist();

  const prog = $('#sweep-progress');
  const btn = $('#btn-sweep-run');
  prog.hidden = false;
  prog.value = 0;
  btn.disabled = true;
  $('#sweep-out').innerHTML = '<p class="hint">Searching each hour…</p>';
  try {
    const from = state.from;
    const to = state.to;
    const res = await runSweep({
      plan: (time) => api.plan(state.settings, { from, to, time, searchWindowMin: 60, first: 30 }),
      date, fromHour, toHour,
      onProgress: (d, t) => { prog.max = t; prog.value = d; },
    });
    renderSweep(res.rows, date, res.errors);
  } catch (e) {
    handleError(e);
    $('#sweep-out').innerHTML = '';
  } finally {
    prog.hidden = true;
    btn.disabled = false;
  }
}

function renderSweep(rows, date, errors) {
  const valid = rows.filter((r) => r.rideAvg !== null);
  if (!valid.length) { $('#sweep-out').innerHTML = '<p class="hint">No departures found for that day.</p>'; return; }
  const W = 400;
  const H = 190;
  const pad = { l: 28, r: 6, t: 10, b: 22 };
  const maxY = Math.ceil(Math.max(...valid.map((r) => Math.max(r.rideMax, r.showUpAvg ?? 0))) / 10) * 10;
  const bw = (W - pad.l - pad.r) / rows.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);
  const best = valid.reduce((a, b) => ((b.showUpAvg ?? b.rideAvg) < (a.showUpAvg ?? a.rideAvg) ? b : a));
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average trip time by hour">`;
  for (let v = 0; v <= maxY; v += maxY > 60 ? 20 : 10) {
    svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  }
  const line = [];
  rows.forEach((r, i) => {
    const x = pad.l + i * bw;
    if (r.rideAvg !== null) {
      svg += `<rect class="bar ${r === best ? 'best' : ''}" data-hour="${r.hour}" x="${x + 2}" y="${y(r.rideAvg)}" width="${Math.max(1, bw - 4)}" height="${y(0) - y(r.rideAvg)}"><title>${r.hour}:00 · ${r.rideAvg.toFixed(0)} min avg ride · ${r.departures} departures</title></rect>`;
      svg += `<line class="whisk" x1="${x + bw / 2}" x2="${x + bw / 2}" y1="${y(r.rideMin)}" y2="${y(r.rideMax)}"/>`;
    }
    if (r.showUpAvg !== null) line.push(`${x + bw / 2},${y(r.showUpAvg)}`);
    if (r.hour % 2 === 0 || rows.length <= 12) svg += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${r.hour % 24}</text>`;
  });
  if (line.length > 1) svg += `<polyline class="showup" points="${line.join(' ')}"/>`;
  line.forEach((p) => { const [cx, cy] = p.split(','); svg += `<circle class="showup-dot" cx="${cx}" cy="${cy}" r="2.5"/>`; });
  svg += '</svg>';

  const fmt = (v) => (v === null ? '–' : Math.round(v));
  $('#sweep-out').innerHTML = `
    <p><b>Best hour: ${best.hour % 24}:00–${(best.hour + 1) % 24}:00</b>, about ${Math.round(best.showUpAvg ?? best.rideAvg)} min door to door.</p>
    ${svg}
    <div class="legend"><span><i style="background:var(--accent)"></i>Avg trip if you time your departure</span><span><i style="background:var(--warn)"></i>Avg if you just leave (incl. waiting)</span><span>| range min–max</span></div>
    <table class="sweep"><thead><tr><th>Hour</th><th>Avg</th><th>Min</th><th>Max</th><th>Just leave</th><th>Deps</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-hour="${r.hour}"><td>${String(r.hour % 24).padStart(2, '0')}:00</td><td>${fmt(r.rideAvg)}</td><td>${fmt(r.rideMin)}</td><td>${fmt(r.rideMax)}</td><td>${fmt(r.showUpAvg)}</td><td>${r.departures}</td></tr>`).join('')}
    </tbody></table>
    <p class="small">Minutes, door to door, for ${esc(date)} with your current settings (min transfer ${state.settings.transferSlackMin} min). Tap an hour to see its routes.${errors.length ? ` ${errors.length} hour(s) failed to load.` : ''}</p>`;
  $('#sweep-out').querySelectorAll('[data-hour]').forEach((el) => el.addEventListener('click', () => {
    const h = +el.dataset.hour;
    $('#when-mode').value = 'depart';
    $('#when-time').hidden = false;
    const ms = helsinkiToMs(date, h);
    $('#when-time').value = localInputValue(ms);
    search();
  }));
}

// ---------- trip timer ----------

let tickTimer = null;
let refreshTimer = null;
let wakeLock = null;

async function startTrip(it) {
  state.trip = { it, planB: new Map(), lastRefresh: 0 };
  activateTab('trip');
  showItinerary(it);
  await requestWakeLock();
  clearInterval(tickTimer);
  clearInterval(refreshTimer);
  tickTimer = setInterval(renderTrip, 1000);
  refreshTimer = setInterval(refreshTrip, 30_000);
  renderTrip();
  refreshTrip();
}

function stopTrip() {
  state.trip = null;
  clearInterval(tickTimer);
  clearInterval(refreshTimer);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  document.body.classList.remove('compact');
  $('#trip-out').innerHTML = '<p class="hint">Trip ended. Open a route and press <b>Start trip</b> to start another.</p>';
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not allowed (battery saver etc.) */ }
}
document.addEventListener('visibilitychange', () => {
  if (state.trip && document.visibilityState === 'visible') { requestWakeLock(); refreshTrip(); }
});

async function refreshTrip() {
  const trip = state.trip;
  if (!trip || isDemo()) return;
  const now = Date.now();
  const legs = trip.it.legs.slice();
  const upcoming = legs.map((l, i) => i).filter((i) => legs[i].transit && legs[i].end > now && legs[i].trip?.id && legs[i].serviceDate).slice(0, 2);
  let changed = false;
  for (const i of upcoming) {
    try {
      const times = await api.tripTimes(legs[i].trip.id, legs[i].serviceDate);
      const updated = applyLiveTimes(legs[i], times);
      if (updated.start !== legs[i].start || updated.end !== legs[i].end) { legs[i] = updated; changed = true; }
    } catch (e) {
      console.warn('live time refresh failed', e);
    }
  }
  if (changed && state.trip === trip) {
    trip.it = withLegs(trip.it, legs);
    trip.planB.clear();
    state.displayedLegs = trip.it.legs;
  }
  trip.lastRefresh = Date.now();
}

function renderTrip() {
  const trip = state.trip;
  if (!trip) return;
  const it = trip.it;
  const now = Date.now();
  const ph = tripPhase(it, now);
  const out = $('#trip-out');
  if (ph.phase === 'done') {
    out.innerHTML = `<div class="timer"><div class="count">🎉</div><div>You've arrived (${hhmm(it.end)}).</div></div><div class="itin-actions"><button type="button" id="btn-stop">Close</button></div>`;
    $('#btn-stop').onclick = stopTrip;
    clearInterval(tickTimer);
    return;
  }
  const subs = [];
  const nextLeg = ph.nextTransit >= 0 ? it.legs[ph.nextTransit] : null;
  if (ph.phase === 'before' || ph.phase === 'walk' || ph.phase === 'wait') {
    if (nextLeg) {
      subs.push(`${badge(nextLeg)} from <b>${esc(nextLeg.from.name)}</b> at ${hhmm(nextLeg.start)}${nextLeg.realtime ? ` <span class="${delayClass(nextLeg)}">(live)</span>` : ''}`);
      const v = state.vehicles.get(ph.nextTransit);
      if (v) subs.push(`<span class="live-note">Vehicle is ${km(distance(v, nextLeg.from))} away${v.delaySec !== null ? `, ${delayText(v.delaySec)}` : ''}</span>`);
      if (ph.phase === 'walk' && ph.walkLeftSec) subs.push(`<span class="small">Walking about ${Math.ceil(ph.walkLeftSec / 60)} min left</span>`);
    }
    subs.push(`<span class="small">Arrive at destination ${hhmm(it.end)}</span>`);
  } else if (ph.phase === 'ride') {
    const leg = it.legs[ph.legIndex];
    const v = state.vehicles.get(ph.legIndex);
    if (v?.delaySec !== null && v?.delaySec !== undefined) subs.push(`<span class="live-note">${badge(leg)} ${delayText(v.delaySec)}</span>`);
    if (nextLeg && ph.transferSlackSec !== null) {
      const tight = ph.transferSlackSec < state.settings.transferSlackMin * 60;
      subs.push(`<span class="${tight ? 'warnline' : ''}">Transfer to ${badge(nextLeg)} at ${hhmm(nextLeg.start)}: ${Math.round(ph.transferSlackSec / 60)} min to spare</span>`);
    }
    subs.push(`<span class="small">Arrive at destination ${hhmm(it.end)}</span>`);
  }

  const planBLeg = nextLeg && (ph.phase !== 'ride' || (ph.transferSlackSec ?? 1e9) < state.settings.transferSlackMin * 60 + 60) ? ph.nextTransit : -1;
  if (planBLeg >= 0 && !trip.planB.has(planBLeg)) {
    trip.planB.set(planBLeg, null);
    planB({ plan: (o) => api.plan(state.settings, o), itinerary: it, legIndex: planBLeg, to: lastPlace(it) })
      .then((r) => { if (state.trip === trip) trip.planB.set(planBLeg, r ?? false); })
      .catch(() => trip.planB.set(planBLeg, false));
  }
  const pb = planBLeg >= 0 ? trip.planB.get(planBLeg) : undefined;

  out.innerHTML = `
    <div class="timer ${ph.phase}">
      <div class="label">${esc(ph.label)}</div>
      <div class="count">${fmtCountdown(ph.target - now)}</div>
      <div class="sub">${subs.map((x) => `<div>${x}</div>`).join('')}</div>
    </div>
    ${pb ? `<div class="planb"><div class="res">If you miss it: ${describePlanB(pb)} <button type="button" id="btn-switch">Switch to this</button></div></div>` : ''}
    <ol class="trip-legs">${it.legs.map((l, i) => `<li class="${l.end <= now ? 'done' : (i === ph.legIndex ? 'now' : '')}">${hhmm(l.start)} ${badge(l)} ${l.transit ? `${esc(l.from.name)} → ${esc(l.to.name)}` : `walk to ${esc(l.to.name)}`}</li>`).join('')}</ol>
    <div class="itin-actions"><button type="button" id="btn-stop">End trip</button></div>
    <p class="small">${wakeLock ? 'Screen stays on during the trip.' : ''} ${isDemo() ? 'Demo data.' : 'Times refresh every 30 s.'}</p>`;
  $('#btn-stop').onclick = stopTrip;
  if (pb) $('#btn-switch').onclick = () => startTrip(joinPlanB(it, planBLeg, pb.itinerary));
}

/** Legs before the missed one, then the plan B itinerary. */
function joinPlanB(it, legIndex, alt) {
  const before = it.legs.slice(0, legIndex);
  const legs = [...before, ...alt.legs];
  return { ...alt, legs, start: legs[0].start, end: alt.end, duration: Math.round((alt.end - legs[0].start) / 1000), key: `${it.key}+${alt.key}` };
}

function distance(a, b) {
  const R = 6371e3;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const km = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
function delayText(sec) {
  const m = Math.round(sec / 60);
  if (m === 0) return 'on time';
  return m > 0 ? `${m} min late` : `${-m} min early`;
}

// ---------- settings dialog ----------

function openSettings() {
  const s = state.settings;
  $('#set-key').value = s.apiKey;
  $('#set-slack').value = s.transferSlackMin;
  $('#set-walk').value = s.walkSpeedKmh;
  $('#set-maxtr').value = s.maxTransfers === null ? '' : String(s.maxTransfers);
  $('#set-wheelchair').checked = s.wheelchair;
  $('#set-avoid').value = s.avoidLines.join(', ');
  $('#set-modes').innerHTML = MODES.map((m) => `<label><input type="checkbox" value="${m}" ${s.modes.includes(m) ? 'checked' : ''}> ${MODE_NAMES[m]}</label>`).join('');
  renderPlaceList();
  $('#settings').showModal();
}

function renderPlaceList() {
  $('#set-places').innerHTML = state.settings.places.map((p, i) => `<li><span>${esc(p.name)}</span><button type="button" data-del="${i}" aria-label="Remove ${esc(p.name)}">✕</button></li>`).join('');
  $('#set-places').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    state.settings.places.splice(+b.dataset.del, 1);
    persist();
    renderPlaceList();
    renderSavedPlaces();
    updateStars();
  }));
}

function saveFromDialog() {
  const oldKey = state.settings.apiKey;
  const oldDemo = isDemo();
  state.settings = {
    ...state.settings,
    apiKey: $('#set-key').value,
    transferSlackMin: $('#set-slack').value,
    walkSpeedKmh: $('#set-walk').value,
    maxTransfers: $('#set-maxtr').value === '' ? null : +$('#set-maxtr').value,
    wheelchair: $('#set-wheelchair').checked,
    avoidLines: $('#set-avoid').value.split(/[,\s]+/),
    modes: [...$('#set-modes').querySelectorAll('input:checked')].map((i) => i.value),
  };
  persist();
  state.settings = loadSettings();
  renderSlack();
  if (state.settings.apiKey !== oldKey) {
    map.setTiles(state.settings.apiKey);
    if (oldDemo !== isDemo()) resetTracker();
    showMessage('');
  }
}

// ---------- misc UI ----------

function activateTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  document.body.classList.toggle('compact', name === 'trip' && !!state.trip);
  if (name === 'results' && state.openIndex >= 0 && state.itineraries[state.openIndex]) showItinerary(state.itineraries[state.openIndex], { fit: false });
  if (name === 'trip' && state.trip) showItinerary(state.trip.it, { fit: false });
}

function renderSlack() {
  $('#slack-value').textContent = `${state.settings.transferSlackMin} min`;
}

function changeSlack(delta) {
  const v = Math.min(30, Math.max(0, state.settings.transferSlackMin + delta));
  if (v === state.settings.transferSlackMin) return;
  state.settings.transferSlackMin = v;
  persist();
  renderSlack();
  clearTimeout(changeSlack.t);
  if (state.itineraries.length) changeSlack.t = setTimeout(() => search(), 600);
}

function localInputValue(ms) {
  const p = helsinkiParts(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

function bind() {
  setupAutocomplete('from');
  setupAutocomplete('to');

  $('#search').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  $('#btn-sweep').addEventListener('click', sweep);
  $('#btn-sweep-run').addEventListener('click', sweep);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#slack-minus').addEventListener('click', () => changeSlack(-1));
  $('#slack-plus').addEventListener('click', () => changeSlack(1));
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));

  $('#btn-swap').addEventListener('click', () => {
    const f = state.from;
    setPlace('from', state.to);
    setPlace('to', f);
    if (state.from && state.to) search();
  });

  $('#btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) { showMessage('Location is not available in this browser.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => pickFromMap('from', pos.coords.latitude, pos.coords.longitude),
      () => showMessage('Could not get your location. Check the browser permission.'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  document.querySelectorAll('.star').forEach((b) => b.addEventListener('click', () => {
    const p = state[b.dataset.for];
    if (!p) { showMessage('Pick a place first, then save it.'); return; }
    const idx = state.settings.places.findIndex((q) => samePlace(q, p));
    if (idx >= 0) {
      state.settings.places.splice(idx, 1);
    } else {
      const name = prompt('Name for this place', p.name.split(',')[0]);
      if (!name) return;
      state.settings.places.push({ name: name.trim(), lat: p.lat, lon: p.lon });
    }
    persist();
    renderSavedPlaces();
    updateStars();
  }));

  $('#saved-places').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const p = state.settings.places[+b.dataset.i];
    const which = !state.from ? 'from' : (!state.to ? 'to' : (document.activeElement?.id === 'from' ? 'from' : 'to'));
    setPlace(which, { ...p });
    if (state.from && state.to) search();
  });

  $('#when-mode').addEventListener('change', () => {
    const now = $('#when-mode').value === 'now';
    $('#when-time').hidden = now;
    if (!now && !$('#when-time').value) $('#when-time').value = localInputValue(Date.now());
  });

  $('#set-key-show').addEventListener('change', (e) => { $('#set-key').type = e.target.checked ? 'text' : 'password'; });
  $('#settings-form').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'save') saveFromDialog();
  });
  $('#btn-export').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#s=${exportSettings(state.settings)}`;
    try {
      await navigator.clipboard.writeText(url);
      $('#btn-export').textContent = 'Link copied ✓';
    } catch {
      prompt('Copy this link', url);
    }
  });
  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('Remove your API key, settings and saved places from this browser?')) return;
    try { localStorage.clear(); } catch { /* ignore */ }
    location.reload();
  });
}

function importFromHash() {
  const m = /#s=([\w-]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const next = importSettings(state.settings, m[1]);
    if (confirm('Import settings from this link? Your API key stays as it is.')) {
      state.settings = next;
      persist();
    }
  } catch {
    showMessage('That settings link could not be read.', 'error');
  }
}

function init() {
  importFromHash();
  bind();
  renderSlack();
  renderSavedPlaces();
  map.setTiles(state.settings.apiKey);
  $('#sweep-date').value = helsinkiDate(Date.now());
  $('#sweep-from').value = state.settings.sweepFromHour;
  $('#sweep-to').value = state.settings.sweepToHour;
  if (!state.settings.apiKey) {
    showMessage('Welcome! Add your Digitransit API key in Settings to start (or type <code>demo</code> there to try it with made-up data). <button type="button" id="msg-settings">Open settings</button>');
    $('#msg-settings').addEventListener('click', openSettings);
  }
  window.addEventListener('resize', () => map.invalidate());
}

init();

// Exposed for debugging in the browser console.
globalThis.__rp = { state, modeColor };
