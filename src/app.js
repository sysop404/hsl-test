// Reittiopas Plus: UI wiring.

import { createApi } from './api.js';
import { mockFetch, mockMqtt } from './mock.js';
import { createMap, modeColor } from './map.js';
import { createLiveTracker } from './live.js';
import { planB } from './planb.js';
import { transferGaps } from './plan.js';
import { runSweep } from './sweep.js';
import { applyLiveTimes, liveItinerary, tripNotices, tripPhase } from './timer.js';
import { MODES, exportSettings, importSettings, loadSettings, sanitize, saveSettings } from './settings.js';
import { buildExercise, planExercise, walkingKcal } from './exercise.js';
import { createPaceTracker, learnedKmh, loadPace, pacePrior, recordPace, resetPace, savePace } from './pace.js';
import { haversine } from './geo.js';
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
  drawnKey: null, // itinerary currently on the map (to fit the view only when it changes)
  page: { startCursor: null, endCursor: null }, // routing API cursors for earlier / later
  paging: false,
  pace: loadPace(), // learned walking speeds
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

const sortItins = (list) => list.slice().sort((a, b) => a.start - b.start || a.end - b.end);

async function search({ page } = {}) {
  if (!state.from || !state.to) {
    showMessage('Choose a start and a destination first. You can also tap the map.');
    return;
  }
  showMessage('');
  activateTab('results');
  const btn = $('#btn-search');
  btn.disabled = true;
  try {
    if (page && state.lastQuery && state.itineraries.length) {
      await loadPage(page);
    } else {
      const q = { from: state.from, to: state.to, first: 6, ...queryTime() };
      $('#tab-results').innerHTML = '<p class="hint">Searching…</p>';
      const res = await api.plan(state.settings, q);
      state.lastQuery = q;
      state.page = { startCursor: res.pageInfo.startCursor ?? null, endCursor: res.pageInfo.endCursor ?? null };
      state.itineraries = sortItins(res.itineraries);
      state.openIndex = state.itineraries.length ? 0 : -1;
      renderResults();
      if (!state.itineraries.length) {
        const why = res.errors.map((e) => e.description).join(' ');
        showMessage(`No routes found. ${esc(why)}`);
      }
    }
    runExercise();
  } catch (e) {
    handleError(e);
    if (!page) $('#tab-results').innerHTML = '';
  } finally {
    btn.disabled = false;
  }
}

/**
 * Earlier or later routes for the last search, added to the list. Uses the routing API's page
 * cursors; if there's no cursor or the page brings nothing new, searches again from a shifted time.
 * With "arrive by", the API's forward direction goes to earlier arrivals.
 */
async function loadPage(page) {
  if (state.paging) return;
  state.paging = true;
  renderPagingButtons();
  try {
    const q0 = state.lastQuery;
    const its = state.itineraries;
    const seen = new Set(its.map((i) => i.key));
    const forward = (page === 'later') !== !!q0.arriveBy;
    const cursor = forward ? state.page.endCursor : state.page.startCursor;
    let fresh = [];
    if (cursor) {
      try {
        const res = await api.plan(state.settings, { ...q0, after: forward ? cursor : undefined, before: forward ? undefined : cursor });
        fresh = res.itineraries.filter((i) => !seen.has(i.key));
        if (forward) state.page.endCursor = res.pageInfo.endCursor ?? null;
        else state.page.startCursor = res.pageInfo.startCursor ?? null;
      } catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 0) throw e;
        console.warn('paging failed, searching by time instead', e);
      }
    }
    if (!fresh.length) {
      const minStart = Math.min(...its.map((i) => i.start));
      const maxStart = Math.max(...its.map((i) => i.start));
      const minEnd = Math.min(...its.map((i) => i.end));
      const maxEnd = Math.max(...its.map((i) => i.end));
      let q;
      let keep;
      if (!q0.arriveBy) {
        q = page === 'later' ? { ...q0, time: maxStart + 60_000 } : { ...q0, time: minStart - 45 * 60_000 };
        keep = page === 'later' ? () => true : (i) => i.start < minStart;
      } else {
        q = page === 'earlier' ? { ...q0, time: minEnd - 60_000 } : { ...q0, time: maxEnd + 45 * 60_000 };
        keep = page === 'earlier' ? () => true : (i) => i.end > maxEnd;
      }
      const res = await api.plan(state.settings, q);
      fresh = res.itineraries.filter((i) => !seen.has(i.key) && keep(i));
    }
    if (!fresh.length) {
      showMessage(`No ${page} routes found.`);
      return;
    }
    const openKey = state.itineraries[state.openIndex]?.key;
    state.itineraries = sortItins([...its, ...fresh]);
    state.openIndex = state.itineraries.findIndex((i) => i.key === openKey);
    renderResults();
    const cards = [...document.querySelectorAll('#tab-results details.itin')];
    const firstNew = cards.find((c) => fresh.some((f) => f.key === state.itineraries[+c.dataset.i].key));
    firstNew?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    state.paging = false;
    renderPagingButtons();
  }
}

function renderPagingButtons() {
  for (const [id, label] of [['#btn-earlier', '▲ Earlier routes'], ['#btn-later', '▼ Later routes']]) {
    const b = $(id);
    if (!b) continue;
    b.disabled = state.paging;
    b.textContent = state.paging ? 'Loading…' : label;
  }
}

/** Search again from a time shifted by `min` minutes (from now when the mode is "Leave now"). */
function shiftTime(min) {
  const mode = $('#when-mode');
  let base;
  if (mode.value === 'now') {
    mode.value = 'depart';
    $('#when-time').hidden = false;
    base = Date.now();
  } else {
    base = queryTime().time;
  }
  $('#when-time').value = localInputValue(base + min * 60_000);
  if (state.from && state.to) search();
}

// ---------- exercise ----------

const ex = {
  sig: '', // where|min|max the plans below were made for
  plans: new Map(), // base itinerary key -> planExercise() result, or { status: 'pending' | 'error' }
  choice: new Map(), // base itinerary key -> option key the user picked
  built: new Map(), // memoized exercise itineraries
  walks: new Map(), // "lat,lon>lat,lon" -> walking route
  run: 0,
};

const exSig = () => { const e = state.settings.exercise; return `${e.where}|${e.minM}|${e.maxM}`; };
const optKey = (o) => o.stop.place.stopId ?? `${o.stop.place.lat},${o.stop.place.lon}`;
const exOptions = (r) => [...(r.options ?? []), r.shorter, r.longer].filter(Boolean);
const body = () => ({ weightKg: state.settings.weightKg, heightCm: state.settings.heightCm });

/** Exercise walking speed: the measured one when asked for and there are 3+ walks, else the setting. */
function exerciseSpeed() {
  const e = state.settings.exercise;
  const measured = learnedKmh(state.pace.exercise, 3);
  return e.useMeasured && measured ? +measured.toFixed(1) : e.speedKmh;
}

async function cachedWalks(pairs) {
  const key = (p) => `${p.from.lat.toFixed(5)},${p.from.lon.toFixed(5)}>${p.to.lat.toFixed(5)},${p.to.lon.toFixed(5)}`;
  const missing = [...new Map(pairs.filter((p) => !ex.walks.has(key(p))).map((p) => [key(p), p])).values()];
  if (missing.length) {
    const res = await api.walks(missing, exerciseSpeed());
    missing.forEach((p, i) => ex.walks.set(key(p), res[i]));
  }
  return pairs.map((p) => ex.walks.get(key(p)));
}

/** Finds leave-off points for every listed route that doesn't have one yet, one route at a time. */
async function runExercise() {
  if (!state.settings.exercise.enabled || !state.itineraries.length) return;
  const sig = exSig();
  if (sig !== ex.sig) {
    ex.plans.clear();
    ex.choice.clear();
    ex.built.clear();
    ex.sig = sig;
  }
  const run = ++ex.run;
  const { where, minM, maxM } = state.settings.exercise;
  for (const it of state.itineraries) {
    if (ex.plans.has(it.key)) continue;
    ex.plans.set(it.key, { status: 'pending' });
    let r;
    try {
      r = await planExercise({ it, where, minM, maxM, walks: cachedWalks });
    } catch (e) {
      r = { status: 'error', message: e.message };
    }
    if (ex.sig !== sig) return;
    ex.plans.set(it.key, r);
    if (run !== ex.run) return;
    renderResults();
  }
}

/** The itinerary as it should be shown: with the exercise walk when exercise mode has one for it. */
function shown(it) {
  if (!state.settings.exercise.enabled) return it;
  const r = ex.plans.get(it.key);
  if (!r || (r.status !== 'ok' && r.status !== 'none')) return it;
  const pick = ex.choice.get(it.key);
  const opt = pick ? exOptions(r).find((o) => optKey(o) === pick) : r.chosen;
  if (!opt) return it;
  const speed = exerciseSpeed();
  const k = `${it.key}|${optKey(opt)}|${speed}|${state.settings.weightKg}|${state.settings.heightCm}`;
  if (!ex.built.has(k)) ex.built.set(k, buildExercise(it, r, opt, speed, body()));
  return ex.built.get(k);
}

function kcalText(kcal) {
  if (!kcal) return '<span class="small">add weight and height in Settings to see calories</span>';
  return `≈ ${Math.round(kcal.total)} kcal <span class="small">(${Math.round(kcal.active)} for the walking itself)</span>`;
}

function exerciseBox(base, it, index) {
  const e = state.settings.exercise;
  if (!e.enabled) return '';
  const r = ex.plans.get(base.key);
  if (!r || r.status === 'pending') return '<div class="ex-box small">🏃 Finding a leave-off point…</div>';
  if (r.status === 'na') return '<div class="ex-box small">🏃 This route is walking only, so there is no vehicle to leave early.</div>';
  if (r.status === 'error') return `<div class="ex-box small">🏃 Could not plan the exercise walk: ${esc(r.message)}</div>`;
  const vehicle = badge(base.legs[r.legIndex]);
  const x = it.exercise;
  const used = x ? (ex.choice.get(base.key) ?? (r.chosen && optKey(r.chosen))) : null;
  const chip = (o, note) => `<button type="button" class="chip ${optKey(o) === used ? 'on' : ''}" data-ex="${index}" data-opt="${esc(optKey(o))}">${esc(o.stop.place.name)} · ${km(o.distance)}${note ? ` (${note})` : ''}</button>`;
  const parts = [];
  if (r.status === 'none') {
    const closest = [r.shorter && chip(r.shorter, 'shorter'), r.longer && chip(r.longer, 'longer')].filter(Boolean);
    parts.push(`<div>⚠️ No stop on ${vehicle} gives a walk of ${km(e.minM)}–${km(e.maxM)}.${closest.length ? ' Closest:' : ''}</div>`);
    if (closest.length) parts.push(`<div class="chips">${closest.join('')}</div>`);
    if (!x) parts.push('<div class="small">Showing the route without exercise. Pick one of the stops above to use it.</div>');
  }
  if (x) {
    const what = x.where === 'last'
      ? `Get off ${vehicle} at <b>${esc(x.stopName)}</b> and walk <b>${km(x.distance)}</b> to the destination`
      : `Walk <b>${km(x.distance)}</b> to <b>${esc(x.stopName)}</b> and get on ${vehicle} there`;
    const extra = Math.round(x.extraSec / 60);
    const cost = x.where === 'last'
      ? (extra > 0 ? `arrives ${extra} min later than riding all the way` : 'arrives no later than riding all the way')
      : (extra > 0 ? `leave ${extra} min earlier, same vehicle, same arrival` : 'same vehicle, same arrival');
    parts.push(`<div>🏃 ${what} (${fmtDuration(x.durationSec)} at ${x.speedKmh.toFixed(1)} km/h).</div>`);
    parts.push(`<div class="small">${kcalText(x.kcal)} · ${cost}</div>`);
  }
  if (r.status === 'ok' && r.options.length > 1) {
    parts.push(`<div class="small">Other stops in range:</div><div class="chips">${r.options.map((o) => chip(o)).join('')}</div>`);
  }
  return `<div class="ex-box">${parts.join('')}</div>`;
}

function renderExerciseForm() {
  const e = state.settings.exercise;
  $('#ex-on').checked = e.enabled;
  $('#ex-opts').hidden = !e.enabled;
  $('#ex-where').value = e.where;
  $('#ex-min').value = e.minM;
  $('#ex-max').value = e.maxM;
  $('#ex-speed').value = e.speedKmh;
  $('#ex-measured').checked = e.useMeasured;
  const n = state.pace.exercise.n;
  const measured = learnedKmh(state.pace.exercise, 3);
  $('#ex-measured-label').textContent = measured
    ? `Use my measured exercise pace (${measured.toFixed(1)} km/h from ${n} walks)`
    : `Use my measured exercise pace once known (${n} of 3 walks recorded)`;
  $('#ex-speed').disabled = !!(e.useMeasured && measured);
  $('#ex-summary').textContent = e.enabled
    ? `${e.where === 'last' ? 'near destination' : 'from start'} · ${km(e.minM)}–${km(e.maxM)} · ${exerciseSpeed().toFixed(1)} km/h`
    : '';
}

function onExerciseChange(e) {
  // Moving one end of the range past the other drags the other along.
  let minM = +$('#ex-min').value;
  let maxM = +$('#ex-max').value;
  if (minM > maxM) {
    if (e?.target?.id === 'ex-max') minM = maxM;
    else maxM = minM;
  }
  const before = JSON.stringify(state.settings.exercise);
  state.settings = sanitize({
    ...state.settings,
    exercise: {
      enabled: $('#ex-on').checked,
      where: $('#ex-where').value,
      minM,
      maxM,
      speedKmh: $('#ex-speed').value,
      useMeasured: $('#ex-measured').checked,
    },
  });
  renderExerciseForm();
  // A blur can fire "change" with nothing changed; re-rendering then would swallow the user's click.
  if (JSON.stringify(state.settings.exercise) === before) return;
  persist();
  ex.built.clear();
  if (!state.itineraries.length) return;
  if (state.settings.exercise.enabled) runExercise();
  renderResults();
}

function delayClass(leg) {
  const d = (leg.start - leg.startScheduled) / 1000;
  if (!leg.realtime) return '';
  if (d >= 60) return 'late';
  if (d <= -60) return 'early';
  return 'ontime';
}

function badge(leg) {
  if (!leg.transit) return `<span class="badge WALK${leg.exercise ? ' ex-tag' : ''}">${leg.exercise ? '🏃' : '🚶'}${Math.max(1, Math.round((leg.end - leg.start) / 60000))}</span>`;
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
  if (!state.itineraries.length) { box.innerHTML = ''; map.drawItinerary(null); state.drawnKey = null; return; }
  const slackSec = state.settings.transferSlackMin * 60;
  box.innerHTML = '<button type="button" id="btn-earlier" class="page-btn">▲ Earlier routes</button>' + state.itineraries.map((base, i) => {
    const it = shown(base);
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
          ${it.exercise ? `<span class="ex-tag">🏃 ${km(it.exercise.distance)}${it.exercise.kcal ? ` · ${Math.round(it.exercise.kcal.total)} kcal` : ''}</span>` : ''}
        </div>
      </summary>
      <div class="itin-body">${exerciseBox(base, it, i)}${legDetails(it, i)}
        <div class="itin-actions">
          <button type="button" class="primary" data-start="${i}">Start trip</button>
        </div>
      </div>
    </details>`;
  }).join('') + '<button type="button" id="btn-later" class="page-btn">▼ Later routes</button>';

  for (const d of box.querySelectorAll('details.itin')) {
    d.addEventListener('toggle', () => {
      // Toggle events are queued: ignore one from a card that a re-render has already replaced.
      if (!d.open || !d.isConnected) return;
      for (const other of box.querySelectorAll('details.itin')) if (other !== d) other.open = false;
      state.openIndex = +d.dataset.i;
      showItinerary(shown(state.itineraries[state.openIndex]));
    });
  }
  box.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => startTrip(shown(state.itineraries[+b.dataset.start]))));
  box.querySelectorAll('[data-planb]').forEach((b) => b.addEventListener('click', () => loadPlanB(b)));
  box.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => {
    ex.choice.set(state.itineraries[+b.dataset.ex].key, b.dataset.opt);
    renderResults();
  }));
  $('#btn-earlier').addEventListener('click', () => search({ page: 'earlier' }));
  $('#btn-later').addEventListener('click', () => search({ page: 'later' }));
  renderPagingButtons();
  if (state.openIndex >= 0) showItinerary(shown(state.itineraries[state.openIndex]));
}

function legDetails(it, itinIndex) {
  return it.legs.map((leg, li) => {
    if (!leg.transit) {
      const mins = Math.max(1, Math.round((leg.end - leg.start) / 60000));
      if (leg.exercise) return `<div class="leg"><div class="t">${hhmm(leg.start)}</div><div class="what ex">🏃 Exercise walk ${mins} min (${km(leg.distance)}) to ${esc(leg.to.name)}</div></div>`;
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
  const itinerary = itinOverride ?? shown(state.itineraries[ii]);
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
function showItinerary(it, opts = {}) {
  map.drawItinerary(it, { fit: (opts.fit ?? true) && it.key !== state.drawnKey });
  state.drawnKey = it.key;
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
  if (state.trip) stopGps(state.trip);
  state.trip = {
    base: it, // as started: what "late" and "early" are measured against
    it, // with live times applied
    updated: new Map(), // legIndex -> transit leg with live times
    planB: new Map(),
    lastRefresh: 0,
    alerted: new Set(), // notices already announced with a vibration
    gps: null, // geolocation watch id
    pace: null, // { legIndex, kind, tracker } for the walk being tracked
    paceDone: new Set(),
    paceNote: '',
  };
  activateTab('trip');
  showItinerary(it);
  await requestWakeLock();
  clearInterval(tickTimer);
  clearInterval(refreshTimer);
  tickTimer = setInterval(renderTrip, 1000);
  refreshTimer = setInterval(refreshTrip, 30_000);
  if (state.settings.trackPace || it.exercise) startGps();
  renderTrip();
  refreshTrip();
}

function stopTrip() {
  stopGps(state.trip);
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
  if (!trip) return;
  const now = Date.now();
  const legs = trip.it.legs;
  const upcoming = legs.map((l, i) => i).filter((i) => legs[i].transit && legs[i].end > now && legs[i].trip?.id && legs[i].serviceDate).slice(0, 2);
  for (const i of upcoming) {
    try {
      const times = await api.tripTimes(legs[i].trip.id, legs[i].serviceDate);
      trip.updated.set(i, applyLiveTimes(trip.base.legs[i], times));
    } catch (e) {
      console.warn('live time refresh failed', e);
    }
  }
  if (state.trip !== trip) return;
  const next = liveItinerary(trip.base, trip.updated);
  const changed = next.legs.some((l, i) => l.start !== trip.it.legs[i].start || l.end !== trip.it.legs[i].end);
  if (changed) {
    trip.it = next;
    trip.planB.clear();
    state.displayedLegs = trip.it.legs;
  }
  trip.lastRefresh = Date.now();
}

// ---------- pace (GPS) ----------

function startGps() {
  const trip = state.trip;
  if (!trip || trip.gps !== null || !navigator.geolocation) return;
  trip.gpsError = '';
  trip.gps = navigator.geolocation.watchPosition(
    (pos) => onPosition(trip, pos),
    (err) => { trip.gpsError = err.code === 1 ? 'Location permission was denied, so pace tracking is off.' : 'Waiting for GPS…'; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
}

function stopGps(trip) {
  if (!trip) return;
  if (trip.gps !== null) navigator.geolocation?.clearWatch(trip.gps);
  trip.gps = null;
  finishPace(trip);
  map.setMe(null);
}

/** Which walk to measure now: keep the current one until you reach its end or its vehicle leaves. */
function paceLegIndex(trip, now) {
  const it = trip.it;
  const cur = trip.pace;
  if (cur) {
    const next = it.legs.findIndex((l, i) => i > cur.legIndex && l.transit);
    const est = cur.tracker.estimate();
    const arrived = est && est.remaining < 25;
    const over = next >= 0 ? now > it.legs[next].start + 60_000 : now > it.end + 15 * 60_000;
    if (!arrived && !over) return cur.legIndex;
  }
  const ph = tripPhase(it, now);
  if (ph.phase === 'ride' || ph.phase === 'done') return -1;
  const i = ph.phase === 'before' ? 0 : ph.legIndex;
  const leg = it.legs[i];
  return leg && !leg.transit && leg.points && i !== cur?.legIndex && !trip.paceDone.has(i) ? i : -1;
}

function onPosition(trip, pos) {
  if (state.trip !== trip) return;
  const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, t: pos.timestamp || Date.now() };
  trip.gpsError = '';
  map.setMe(fix);
  const li = paceLegIndex(trip, Date.now());
  if (trip.pace && trip.pace.legIndex !== li) finishPace(trip);
  if (li >= 0 && !trip.pace) {
    const leg = trip.it.legs[li];
    const kind = leg.exercise ? 'exercise' : 'walk';
    const planned = kind === 'exercise' ? exerciseSpeed() : state.settings.walkSpeedKmh;
    trip.pace = { legIndex: li, kind, tracker: createPaceTracker({ path: leg.points, prior: pacePrior(state.pace[kind], planned) }) };
  }
  trip.pace?.tracker.addFix(fix);
}

/** Ends the measured walk and, if it was long and clean enough, adds its speed to the learned pace. */
function finishPace(trip) {
  const p = trip?.pace;
  if (!p) return;
  trip.pace = null;
  trip.paceDone.add(p.legIndex);
  const v = p.tracker.segmentSpeed();
  if (!v) return;
  const r = recordPace(state.pace, p.kind, v);
  if (!r.accepted) return;
  state.pace = r.stats;
  savePace(state.pace);
  renderExerciseForm();
  const leg = trip.it.legs[p.legIndex];
  const kcal = leg.exercise ? walkingKcal({ distanceM: leg.distance, speedKmh: v * 3.6, ...body() }) : null;
  trip.paceNote = `${p.kind === 'exercise' ? '🏃 Exercise walk' : '🚶 Walk'} done at ${(v * 3.6).toFixed(1)} km/h${kcal ? `, ≈ ${Math.round(kcal.total)} kcal` : ''}. Saved to your measured pace.`;
}

function paceLine(trip, now, phase) {
  if (trip.gps === null) return '';
  if (trip.gpsError) return `<span class="small">📍 ${esc(trip.gpsError)}</span>`;
  const p = trip.pace;
  if (!p) return '';
  const leg = trip.it.legs[p.legIndex];
  const est = p.tracker.estimate();
  if (!est) return `<span class="small">📍 Measuring your pace… (${p.tracker.fixes} GPS fixes)</span>`;
  const stopped = est.live < 0.3;
  if (stopped && phase === 'before') return '<span class="small">📍 GPS ready. Your pace shows once you start walking.</span>';
  // Standing still (lights, a shop door) shouldn't make the ETA explode: use your usual pace meanwhile.
  const speed = stopped ? pacePrior(state.pace[p.kind], p.kind === 'exercise' ? exerciseSpeed() : state.settings.walkSpeedKmh).mean : est.speed;
  const eta = now + (est.remaining / speed) * 1000;
  let line = `📍 ${stopped ? 'Stopped' : `Your pace <b>${(est.speed * 3.6).toFixed(1)} km/h</b>`} · at ${esc(leg.to.name)} <b>${hhmm(eta)}</b> (${km(est.remaining)} to go)`;
  const next = trip.it.legs.findIndex((l, i) => i > p.legIndex && l.transit);
  if (next >= 0) {
    const dep = trip.it.legs[next].start;
    const spare = dep - eta;
    if (spare >= 60_000) {
      line += ` · <span class="ontime">${Math.floor(spare / 60000)} min to spare</span>`;
    } else if (spare >= 0) {
      line += ' · <span class="early">under a minute to spare</span>';
    } else {
      const need = est.remaining / Math.max(1, (dep - now) / 1000);
      line += need <= 2.5
        ? ` · <span class="late">${Math.ceil(-spare / 60000)} min short: speed up to ${(need * 3.6).toFixed(1)} km/h</span>`
        : ' · <span class="late">you probably won\'t make it: see plan B</span>';
    }
  }
  if (est.offRoute) line += ' <span class="small">(you\'re off the planned path)</span>';
  return `<span class="pace">${line}</span>`;
}

// ---------- trip screen ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function noticeHtml(n, it, ph) {
  const leg = n.legIndex !== undefined ? it.legs[n.legIndex] : null;
  const mins = (sec) => Math.abs(Math.round(sec / 60));
  switch (n.kind) {
    case 'early':
      if (n.first && ph.phase === 'before' && n.leaveWas - n.leaveNow < 60_000) {
        return `<div class="notice">⚠️ <b>${badge(leg)} is running ${mins(n.deltaSec)} min early</b>: it leaves ${hhmm(n.now)} <s>${hhmm(n.was)}</s>. Leaving at ${hhmm(n.leaveNow)} as planned still gets you there.</div>`;
      }
      if (n.first && ph.phase === 'before') {
        return `<div class="notice bad">⚠️ <b>${badge(leg)} is running ${mins(n.deltaSec)} min early</b>: it leaves ${hhmm(n.now)} <s>${hhmm(n.was)}</s>. <b>Leave by ${hhmm(n.leaveNow)}</b> <s>${hhmm(n.leaveWas)}</s>.</div>`;
      }
      return `<div class="notice bad">⚠️ <b>${badge(leg)} is running ${mins(n.deltaSec)} min early</b>: it leaves ${esc(leg.from.name)} at ${hhmm(n.now)} <s>${hhmm(n.was)}</s>. Don't dawdle.</div>`;
    case 'late': {
      const spare = n.first && ph.phase === 'before'
        ? ` Your leave time stays ${hhmm(n.leaveNow)}, so you'll have ${plural(mins(n.deltaSec), 'extra minute')} at the stop.`
        : (n.first ? ` You'll have ${plural(mins(n.deltaSec), 'extra minute')} at the stop.` : '');
      return `<div class="notice">🕒 <b>${badge(leg)} is ${mins(n.deltaSec)} min late</b>: it leaves ${hhmm(n.now)} <s>${hhmm(n.was)}</s>.${spare}</div>`;
    }
    case 'tight':
      return `<div class="notice bad">⚠️ <b>Transfer at ${esc(n.at)} is down to ${mins(n.seconds)} min</b> (you wanted ${state.settings.transferSlackMin}). Plan B is below.</div>`;
    case 'missed':
      return `<div class="notice bad">❌ <b>You'll probably miss ${badge(it.legs[n.toLeg])} at ${esc(n.at)}</b>: ${mins(n.seconds)} min short. Plan B is below.</div>`;
    case 'arrival':
      return `<div class="notice ${n.deltaSec > 0 ? '' : 'good'}">Arrival now <b>${hhmm(n.now)}</b> <s>${hhmm(n.was)}</s></div>`;
    default:
      return '';
  }
}

/** Vibrates (and flashes the banner) once for each new early-vehicle or transfer problem. */
function announce(trip, notices) {
  let fresh = false;
  for (const n of notices) {
    if (n.kind !== 'early' && n.kind !== 'tight' && n.kind !== 'missed') continue;
    const key = `${n.kind}:${n.legIndex ?? n.toLeg}:${Math.round((n.deltaSec ?? n.seconds) / 60)}`;
    if (trip.alerted.has(key)) continue;
    trip.alerted.add(key);
    fresh = true;
  }
  if (fresh) {
    try { navigator.vibrate?.([250, 120, 250]); } catch { /* not supported */ }
    trip.flashUntil = Date.now() + 3000;
  }
}

function renderTrip() {
  const trip = state.trip;
  if (!trip) return;
  const it = trip.it;
  const now = Date.now();
  const ph = tripPhase(it, now);
  const out = $('#trip-out');
  if (ph.phase === 'done') {
    stopGps(trip);
    out.innerHTML = `<div class="timer"><div class="count">🎉</div><div>You've arrived (${hhmm(it.end)}).</div>${trip.paceNote ? `<div class="small">${esc(trip.paceNote)}</div>` : ''}</div><div class="itin-actions"><button type="button" id="btn-stop">Close</button></div>`;
    $('#btn-stop').onclick = stopTrip;
    clearInterval(tickTimer);
    return;
  }
  const slackSec = state.settings.transferSlackMin * 60;
  const notices = tripNotices(trip.base, it, now, slackSec);
  announce(trip, notices);

  const subs = [];
  const nextLeg = ph.nextTransit >= 0 ? it.legs[ph.nextTransit] : null;
  const pace = paceLine(trip, now, ph.phase);
  const measuring = pace.includes('class="pace"');
  if (ph.phase === 'before' || ph.phase === 'walk' || ph.phase === 'wait') {
    if (nextLeg) {
      subs.push(`${badge(nextLeg)} from <b>${esc(nextLeg.from.name)}</b> at ${hhmm(nextLeg.start)}${nextLeg.realtime ? ` <span class="${delayClass(nextLeg)}">(live)</span>` : ''}`);
      const v = state.vehicles.get(ph.nextTransit);
      if (v) subs.push(`<span class="live-note">Vehicle is ${km(haversine(v, nextLeg.from))} away${v.delaySec !== null ? `, ${delayText(v.delaySec)}` : ''}</span>`);
      if (ph.phase === 'walk' && ph.walkLeftSec && !measuring) subs.push(`<span class="small">Walking about ${Math.ceil(ph.walkLeftSec / 60)} min left</span>`);
    }
    subs.push(`<span class="small">Arrive at destination ${hhmm(it.end)}</span>`);
  } else if (ph.phase === 'ride') {
    const leg = it.legs[ph.legIndex];
    const v = state.vehicles.get(ph.legIndex);
    if (v?.delaySec !== null && v?.delaySec !== undefined) subs.push(`<span class="live-note">${badge(leg)} ${delayText(v.delaySec)}</span>`);
    if (nextLeg && ph.transferSlackSec !== null) {
      const tight = ph.transferSlackSec < slackSec;
      subs.push(`<span class="${tight ? 'warnline' : ''}">Transfer to ${badge(nextLeg)} at ${hhmm(nextLeg.start)}: ${Math.round(ph.transferSlackSec / 60)} min to spare</span>`);
    }
    subs.push(`<span class="small">Arrive at destination ${hhmm(it.end)}</span>`);
  }
  if (pace) subs.push(pace);
  if (it.exercise) subs.push(`<span class="ex-tag">🏃 ${km(it.exercise.distance)} exercise walk · ${it.exercise.kcal ? `≈ ${Math.round(it.exercise.kcal.total)} kcal` : 'add weight and height in Settings for calories'}</span>`);
  if (trip.paceNote) subs.push(`<span class="small">${esc(trip.paceNote)}</span>`);

  // Plan B: for a transfer that has become tight or impossible, else for the next vehicle.
  const risky = notices.find((n) => n.kind === 'missed' || n.kind === 'tight');
  const planBLeg = risky ? risky.toLeg
    : (nextLeg && (ph.phase !== 'ride' || (ph.transferSlackSec ?? 1e9) < slackSec + 60) ? ph.nextTransit : -1);
  if (planBLeg >= 0 && !trip.planB.has(planBLeg)) {
    trip.planB.set(planBLeg, null);
    planB({ plan: (o) => api.plan(state.settings, o), itinerary: it, legIndex: planBLeg, to: lastPlace(it) })
      .then((r) => { if (state.trip === trip) trip.planB.set(planBLeg, r ?? false); })
      .catch(() => trip.planB.set(planBLeg, false));
  }
  const pb = planBLeg >= 0 ? trip.planB.get(planBLeg) : undefined;
  const flash = (trip.flashUntil ?? 0) > now;

  const timeCol = (l, i) => {
    const was = trip.base.legs[i]?.start;
    if (was === undefined || Math.abs(l.start - was) < 60_000) return hhmm(l.start);
    return `<b class="${l.start > was ? 'late' : 'early'}">${hhmm(l.start)}</b> <s>${hhmm(was)}</s>`;
  };

  out.innerHTML = `
    ${notices.length ? `<div class="notices">${notices.map((n) => noticeHtml(n, it, ph)).join('').replace(/class="notice bad"/g, `class="notice bad${flash ? ' flash' : ''}"`)}</div>` : ''}
    <div class="timer ${ph.phase}">
      <div class="label">${esc(ph.label)}</div>
      <div class="count">${fmtCountdown(ph.target - now)}</div>
      <div class="sub">${subs.map((x) => `<div>${x}</div>`).join('')}</div>
    </div>
    ${pb ? `<div class="planb"><div class="res">If you miss it: ${describePlanB(pb)} <button type="button" id="btn-switch">Switch to this</button></div></div>` : ''}
    <ol class="trip-legs">${it.legs.map((l, i) => `<li class="${l.end <= now ? 'done' : (i === ph.legIndex ? 'now' : '')}">${timeCol(l, i)} ${badge(l)} ${l.transit ? `${esc(l.from.name)} → ${esc(l.to.name)}` : `${l.exercise ? 'exercise walk' : 'walk'} to ${esc(l.to.name)}`}</li>`).join('')}</ol>
    <div class="itin-actions">
      <button type="button" id="btn-stop">End trip</button>
      ${navigator.geolocation ? `<button type="button" id="btn-gps">${trip.gps !== null ? '📍 Stop pace tracking' : '📍 Track my pace'}</button>` : ''}
    </div>
    <p class="small">${wakeLock ? 'Screen stays on during the trip.' : ''} ${isDemo() ? 'Demo data: delays change every 45 s.' : 'Times refresh every 30 s.'}</p>`;
  $('#btn-stop').onclick = stopTrip;
  const gpsBtn = $('#btn-gps');
  if (gpsBtn) gpsBtn.onclick = () => { if (trip.gps !== null) stopGps(trip); else startGps(); renderTrip(); };
  if (pb) $('#btn-switch').onclick = () => startTrip(joinPlanB(it, planBLeg, pb.itinerary));
}

/** Legs before the missed one, then the plan B itinerary. */
function joinPlanB(it, legIndex, alt) {
  const before = it.legs.slice(0, legIndex);
  const legs = [...before, ...alt.legs];
  return { ...alt, legs, start: legs[0].start, end: alt.end, duration: Math.round((alt.end - legs[0].start) / 1000), key: `${it.key}+${alt.key}` };
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
  $('#set-weight').value = s.weightKg ?? '';
  $('#set-height').value = s.heightCm ?? '';
  $('#set-trackpace').checked = s.trackPace;
  renderPaceStats();
  $('#set-modes').innerHTML = MODES.map((m) => `<label><input type="checkbox" value="${m}" ${s.modes.includes(m) ? 'checked' : ''}> ${MODE_NAMES[m]}</label>`).join('');
  renderPlaceList();
  $('#settings').showModal();
}

function renderPaceStats() {
  const line = (label, st) => (st.n
    ? `${label}: <b>${(st.mean * 3.6).toFixed(1)} km/h</b> ± ${(Math.sqrt(st.var) * 3.6).toFixed(1)} from ${st.n} walk${st.n === 1 ? '' : 's'}`
    : `${label}: nothing measured yet`);
  $('#pace-stats').innerHTML = `${line('Measured walking pace', state.pace.walk)}<br>${line('Measured exercise pace', state.pace.exercise)}`;
  $('#btn-pace-use').disabled = !state.pace.walk.n;
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
    weightKg: $('#set-weight').value,
    heightCm: $('#set-height').value,
    trackPace: $('#set-trackpace').checked,
  };
  state.settings = sanitize(state.settings);
  persist();
  renderSlack();
  ex.built.clear();
  if (state.itineraries.length) renderResults();
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
  document.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => shiftTime(+b.dataset.shift)));
  for (const id of ['#ex-on', '#ex-where', '#ex-min', '#ex-max', '#ex-speed', '#ex-measured']) $(id).addEventListener('change', onExerciseChange);
  $('#btn-pace-use').addEventListener('click', () => {
    const v = learnedKmh(state.pace.walk);
    if (v) $('#set-walk').value = (Math.round(v * 2) / 2).toFixed(1);
  });
  $('#btn-pace-reset').addEventListener('click', () => {
    if (!confirm('Forget your measured walking and exercise pace?')) return;
    state.pace = resetPace();
    renderPaceStats();
    renderExerciseForm();
  });
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
  renderExerciseForm();
  map.setTiles(state.settings.apiKey);
  $('#sweep-date').value = helsinkiDate(Date.now());
  $('#sweep-from').value = state.settings.sweepFromHour;
  $('#sweep-to').value = state.settings.sweepToHour;
  if (!state.settings.apiKey) {
    showMessage('Welcome! Add your Digitransit API key in Settings to start (or type <code>demo</code> there to try it with made-up data). <button type="button" id="msg-settings">Open settings</button>');
    $('#msg-settings').addEventListener('click', openSettings);
  }
  window.addEventListener('resize', () => map.invalidate());
  globalThis.__rpBooted = true; // checked by index.html
}

init();

// Exposed for debugging in the browser console.
globalThis.__rp = { state, ex, modeColor };
