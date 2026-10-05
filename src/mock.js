// Demo mode: a fake Digitransit backend so the app can be tried (and tested) without a key.
// Enabled when the API key is set to "demo". Data is synthetic, not real HSL timetables.

import { encodePolyline } from './polyline.js';
import { helsinkiParts } from './time.js';

const PLACES = [
  { name: 'Rautatientori, Helsinki', lat: 60.1711, lon: 24.9441 },
  { name: 'Pasila, Helsinki', lat: 60.1987, lon: 24.9334 },
  { name: 'Itäkeskus, Helsinki', lat: 60.2103, lon: 25.0814 },
  { name: 'Tapiola, Espoo', lat: 60.1757, lon: 24.8053 },
  { name: 'Aviapolis, Vantaa', lat: 60.2933, lon: 24.9590 },
  { name: 'Kamppi, Helsinki', lat: 60.1690, lon: 24.9316 },
];

const iso = (ms) => new Date(ms).toISOString();
const lerp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
const dist = (a, b) => {
  const dx = (a.lon - b.lon) * 55.6; // km per degree at 60°N
  const dy = (a.lat - b.lat) * 111.3;
  return Math.hypot(dx, dy);
};

// Demo state shared between searches: stops by id (so stop-to-stop searches work) and each trip's
// scheduled stop times (so live time refreshes can be simulated).
const STOPS = new Map();
const TRIPS = new Map();

function legTime(t, delay, transit) {
  return { scheduledTime: iso(t), estimated: transit && delay ? { time: iso(t + delay * 1000), delay: `PT${delay}S` } : null };
}

function leg({ mode, from, to, start, end, route, trip, headsign, delay = 0, stops = [] }) {
  const transit = mode !== 'WALK';
  const lt = (t) => legTime(t, delay, transit);
  const path = transit
    ? [from, ...stops, to].map((p) => [p.lat, p.lon])
    : [[from.lat, from.lon], [(from.lat + to.lat) / 2 + 0.002, (from.lon + to.lon) / 2], [to.lat, to.lon]];
  if (trip) TRIPS.set(trip.gtfsId, [{ stopId: from.stopId, t: start }, ...stops.map((x) => ({ stopId: x.stopId, t: x.t })), { stopId: to.stopId, t: end }]);
  return {
    mode, distance: dist(from, to) * 1000, duration: (end - start) / 1000, transitLeg: transit,
    headsign: headsign ?? null, serviceDate: transit ? serviceDate(start) : null, realtimeState: delay ? 'UPDATED' : 'SCHEDULED',
    interlineWithPreviousLeg: false,
    start: lt(start), end: lt(end),
    from: { name: from.name, lat: from.lat, lon: from.lon, stop: from.stopId ? { gtfsId: from.stopId, code: from.code, platformCode: null } : null },
    to: { name: to.name, lat: to.lat, lon: to.lon, stop: to.stopId ? { gtfsId: to.stopId, code: to.code, platformCode: null } : null },
    route: route ?? null,
    trip: trip ?? null,
    legGeometry: { points: encodePolyline(path) },
    alerts: [],
    intermediatePlaces: stops.map((x) => ({
      name: x.name, lat: x.lat, lon: x.lon, arrival: lt(x.t), departure: lt(x.t),
      stop: { gtfsId: x.stopId, code: x.code, platformCode: null },
    })),
  };
}

/** Stops roughly every 450 m between two stops, with times interpolated along the ride. */
function between(from, to, start, end, line) {
  const n = Math.min(30, Math.max(0, Math.round((dist(from, to) * 1000) / 450) - 1));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const f = i / (n + 1);
    const p = stop(lerp(from, to, f), 0, `${line} pysäkki ${i}`);
    p.stopId = `HSL:${line}${String(i).padStart(2, '0')}`;
    p.code = `H${line}${i}`;
    // Stops along a line sit a little off the straight line, like real streets.
    p.lat += 0.0006 * Math.sin(i * 1.7);
    STOPS.set(p.stopId, p);
    out.push({ ...p, t: Math.round(start + (end - start) * f) });
  }
  return out;
}

function serviceDate(ms) {
  const p = helsinkiParts(ms);
  return `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`;
}

/** Rush hours are slower; nights have fewer departures. */
function profile(ms) {
  const h = helsinkiParts(ms).hour;
  const rush = (h >= 7 && h < 9) || (h >= 15 && h < 18);
  const night = h < 5 || h >= 23;
  return { speed: rush ? 17 : 23, headway: night ? 30 : rush ? 6 : 10 };
}

function stop(p, id, name) {
  const s = { ...p, name, stopId: `HSL:${id}`, code: `H${id % 10000}` };
  STOPS.set(s.stopId, s);
  return s;
}

function endpoint(loc, fallback) {
  const c = loc.location.coordinate;
  if (c) return { name: loc.label ?? fallback.name, lat: c.latitude, lon: c.longitude };
  const s = STOPS.get(loc.location.stopLocation?.stopLocationId);
  return s ? { name: loc.label ?? s.name, lat: s.lat, lon: s.lon } : fallback;
}

/** Departures from t0 onwards, for `horizonSec` (both patterns). */
function generate(vars, t0, horizonSec) {
  const A = endpoint(vars.origin, { name: 'Origin', lat: 60.1711, lon: 24.9441 });
  const B = endpoint(vars.destination, { name: 'Destination', lat: 60.2103, lon: 25.0814 });
  const slack = parseDuration(vars.preferences?.transit?.transfer?.slack ?? 'PT2M');
  const maxTransfers = vars.preferences?.transit?.transfer?.maximumTransfers ?? 9;

  const s1 = stop(lerp(A, B, 0.08), 1001, 'Lähtöpysäkki');
  const sx = stop(lerp(A, B, 0.55), 1002, 'Vaihtopysäkki');
  const sx2 = stop(lerp(A, B, 0.57), 1003, 'Vaihtopysäkki (laituri 2)');
  const s2 = stop(lerp(A, B, 0.93), 1004, 'Määräpysäkki');
  const km = Math.max(1, dist(A, B));
  const out = [];

  // Pattern 1: bus 550 then tram 4 (one transfer). Pattern 2: direct bus 52 (slower, less frequent).
  for (let k = 0; k < 60; k++) {
    const p = profile(t0 + k * 60000 * 5);
    const busDep = alignUp(t0 + 4 * 60000, p.headway * 60000, 2) + k * p.headway * 60000;
    if (busDep - t0 > horizonSec * 1000 + 4 * 60000) break;
    const walk1Start = busDep - 4 * 60000;
    const ride1 = Math.round((km * 0.55 / p.speed) * 3600000);
    const busArr = busDep + ride1;
    const walkX = 90_000;
    const tramDep = alignUp(busArr + walkX + slack * 1000, 5 * 60000, 1);
    const ride2 = Math.round((km * 0.4 / (p.speed - 3)) * 3600000);
    const tramArr = tramDep + ride2;
    const delay = k === 0 ? 75 : 0;
    if (maxTransfers >= 1) {
      out.push({
        numberOfTransfers: 1,
        legs: [
          leg({ mode: 'WALK', from: A, to: s1, start: walk1Start, end: busDep }),
          leg({ mode: 'BUS', from: s1, to: sx, start: busDep, end: busArr, delay, headsign: 'Itäkeskus', stops: between(s1, sx, busDep, busArr, '550'),
            route: { gtfsId: 'HSL:1550', shortName: '550', longName: 'Westendinasema - Itäkeskus', mode: 'BUS', color: '007AC9' },
            trip: { gtfsId: `HSL:1550_${busDep}`, directionId: '0', tripHeadsign: 'Itäkeskus', departureStoptime: { scheduledDeparture: secOfDay(busDep - 600000) } } }),
          leg({ mode: 'WALK', from: sx, to: sx2, start: busArr, end: busArr + walkX }),
          leg({ mode: 'TRAM', from: sx2, to: s2, start: tramDep, end: tramArr, headsign: 'Arabia', stops: between(sx2, s2, tramDep, tramArr, '4'),
            route: { gtfsId: 'HSL:1004', shortName: '4', longName: 'Katajanokka - Munkkiniemi', mode: 'TRAM', color: '00985F' },
            trip: { gtfsId: `HSL:1004_${tramDep}`, directionId: '1', tripHeadsign: 'Arabia', departureStoptime: { scheduledDeparture: secOfDay(tramDep - 900000) } } }),
          leg({ mode: 'WALK', from: s2, to: B, start: tramArr, end: tramArr + 3 * 60000 }),
        ],
      });
    }
    if (k % 2 === 0) {
      const dDep = busDep + 3 * 60000;
      const dArr = dDep + Math.round((km / (p.speed - 4)) * 3600000);
      out.push({
        numberOfTransfers: 0,
        legs: [
          leg({ mode: 'WALK', from: A, to: s1, start: dDep - 4 * 60000, end: dDep }),
          leg({ mode: 'BUS', from: s1, to: s2, start: dDep, end: dArr, headsign: 'Kontula', stops: between(s1, s2, dDep, dArr, '52'),
            route: { gtfsId: 'HSL:1052', shortName: '52', longName: 'Kuninkaantammi - Kontula', mode: 'BUS', color: '007AC9' },
            trip: { gtfsId: `HSL:1052_${dDep}`, directionId: '0', tripHeadsign: 'Kontula', departureStoptime: { scheduledDeparture: secOfDay(dDep - 300000) } } }),
          leg({ mode: 'WALK', from: s2, to: B, start: dArr, end: dArr + 3 * 60000 }),
        ],
      });
    }
  }
  return out
    .map((it) => ({
      ...it,
      start: it.legs[0].start.scheduledTime,
      end: it.legs[it.legs.length - 1].end.scheduledTime,
      duration: 0,
      walkDistance: 600,
      waitingTime: 0,
    }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

const HOUR = 3600_000;
const startOf = (it) => Date.parse(it.start);
const endOf = (it) => Date.parse(it.end);

/**
 * planConnection with paging. Cursors look like "mock:<kind>:<ms>":
 *   depFrom (start >= t), depBefore (start < t), arrBefore (end < t), arrAfter (end > t).
 * As in OTP, with "arrive by" forward paging (after) goes to earlier arrivals.
 */
function plan(vars) {
  const n = vars.first ?? vars.last ?? 6;
  const cursor = /^mock:(\w+):(\d+)$/.exec(vars.after ?? vars.before ?? '');
  const arriveBy = cursor ? cursor[1].startsWith('arr') : !!vars.dateTime?.latestArrival;
  let list;
  if (cursor) {
    const [, kind, tStr] = cursor;
    const t = +tStr;
    if (kind === 'depFrom') list = generate(vars, t, 3 * 3600).filter((it) => startOf(it) >= t - 60000).slice(0, n);
    else if (kind === 'depBefore') list = generate(vars, t - 2 * HOUR, 2 * 3600).filter((it) => startOf(it) < t).slice(-n);
    else if (kind === 'arrBefore') list = generate(vars, t - 4 * HOUR, 4 * 3600).filter((it) => endOf(it) < t).slice(-n);
    else list = generate(vars, t - 2 * HOUR, 4 * 3600).filter((it) => endOf(it) > t).slice(0, n);
  } else if (arriveBy) {
    const t = Date.parse(vars.dateTime.latestArrival);
    list = generate(vars, t - 4 * HOUR, 4 * 3600).filter((it) => endOf(it) <= t).slice(-n);
  } else {
    const t0 = Date.parse(vars.dateTime?.earliestDeparture ?? new Date().toISOString());
    const windowSec = vars.searchWindow ? parseDuration(vars.searchWindow) : 3600;
    list = generate(vars, t0, windowSec).filter((it) => startOf(it) >= t0 - 60000).slice(0, n);
  }
  const pageInfo = { searchWindowUsed: 'PT1H', hasNextPage: true, hasPreviousPage: true, startCursor: null, endCursor: null };
  if (list.length) {
    const starts = list.map(startOf);
    const ends = list.map(endOf);
    if (arriveBy) {
      pageInfo.endCursor = `mock:arrBefore:${Math.min(...ends)}`;
      pageInfo.startCursor = `mock:arrAfter:${Math.max(...ends)}`;
    } else {
      pageInfo.endCursor = `mock:depFrom:${Math.max(...starts) + 60000}`;
      pageInfo.startCursor = `mock:depBefore:${Math.min(...starts)}`;
    }
  }
  return { searchDateTime: null, routingErrors: [], pageInfo, edges: list.map((node) => ({ cursor: 'x', node })) };
}

/** Walking-only routes for aliased w0, w1, ... (about 1.25 × the straight line, like real streets). */
function walks(vars) {
  const data = {};
  for (let i = 0; vars[`o${i}`]; i++) {
    const a = endpoint(vars[`o${i}`], null);
    const b = endpoint(vars[`d${i}`], null);
    if (!a || !b) { data[`w${i}`] = { edges: [] }; continue; }
    const m = dist(a, b) * 1000 * 1.25;
    const speed = vars.p?.street?.walk?.speed ?? 1.33;
    const pts = [[a.lat, a.lon], [(a.lat + b.lat) / 2 + 0.001, (a.lon + b.lon) / 2 - 0.001], [b.lat, b.lon]];
    data[`w${i}`] = { edges: [{ node: { duration: Math.round(m / speed), legs: [{ distance: m, duration: Math.round(m / speed), legGeometry: { points: encodePolyline(pts) } }] } }] };
  }
  return data;
}

/**
 * Live stop times for a demo trip. The delay cycles every 45 s through on time, 2.5 and 5 min late,
 * and 2 min early, so the trip screen's late/early handling can be tried.
 */
export function demoDelaySec(now = Date.now()) {
  return [0, 150, 300, -120][Math.floor(now / 45000) % 4];
}

function tripTimes(id) {
  const stops = TRIPS.get(id);
  if (!stops) return { trip: null };
  const d = demoDelaySec() * 1000;
  return {
    trip: {
      stoptimesForDate: stops.map((x) => ({
        stop: { gtfsId: x.stopId },
        scheduledArrival: x.t / 1000, scheduledDeparture: x.t / 1000,
        realtimeArrival: (x.t + d) / 1000, realtimeDeparture: (x.t + d) / 1000,
        serviceDay: 0, realtime: true,
      })),
    },
  };
}

function alignUp(t, step, offsetMin) {
  const off = offsetMin * 60000;
  return Math.ceil((t - off) / step) * step + off;
}

function secOfDay(ms) {
  const p = helsinkiParts(ms);
  return p.hour * 3600 + p.minute * 60;
}

function parseDuration(s) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s);
  if (!m) return 120;
  return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

/** fetch() replacement. */
export async function mockFetch(url, init = {}) {
  await new Promise((r) => setTimeout(r, 120));
  const u = String(url);
  if (u.includes('/geocoding/v1/autocomplete')) {
    const text = new URL(u).searchParams.get('text').toLowerCase();
    const hits = PLACES.filter((p) => p.name.toLowerCase().includes(text));
    return json({ features: (hits.length ? hits : PLACES).map(feature) });
  }
  if (u.includes('/geocoding/v1/reverse')) {
    const q = new URL(u).searchParams;
    return json({ features: [feature({ name: `Map point ${(+q.get('point.lat')).toFixed(4)}, ${(+q.get('point.lon')).toFixed(4)}`, lat: +q.get('point.lat'), lon: +q.get('point.lon') })] });
  }
  if (u.includes('/routing/')) {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('directOnly')) return json({ data: walks(variables) });
    if (query.includes('planConnection')) return json({ data: { planConnection: plan(variables) } });
    if (query.includes('routes(')) {
      return json({ data: { routes: [{ gtfsId: `HSL:1${variables.name}`, shortName: variables.name }] } });
    }
    if (query.includes('stoptimesForDate')) return json({ data: tripTimes(variables.id) });
  }
  return json({ errors: [{ message: 'not mocked' }] }, 404);
}

function feature(p) {
  return { properties: { label: p.name, name: p.name }, geometry: { coordinates: [p.lon, p.lat] } };
}

/** Fake MQTT library: vehicles creep along a line near the first subscribed leg. */
export function mockMqtt(getLegs) {
  return {
    connect() {
      const handlers = {};
      const topics = new Set();
      const client = {
        connected: true,
        on(ev, fn) { handlers[ev] = fn; if (ev === 'connect') setTimeout(fn, 50); return client; },
        subscribe(t) { topics.add(t); },
        unsubscribe(t) { topics.delete(t); },
        end() { clearInterval(timer); },
      };
      let step = 0;
      const timer = setInterval(() => {
        step++;
        const legs = getLegs();
        legs.forEach((leg) => {
          if (!leg.transit) return;
          const f = Math.min(1, Math.max(0, (Date.now() - leg.start + 120000) / Math.max(1, leg.end - leg.start + 120000)));
          const pos = lerp(leg.from, leg.to, f);
          const route = leg.route.id.replace(/^HSL:/, '');
          const dir = Number(leg.trip.directionId) + 1;
          const hm = `${String(Math.floor(leg.trip.startSec / 3600) % 24).padStart(2, '0')}:${String(Math.floor(leg.trip.startSec / 60) % 60).padStart(2, '0')}`;
          const topic = `/hfp/v2/journey/ongoing/vp/bus/0022/0${route.slice(-3)}/${route}/${dir}/X/${hm}/1/5/60;24/x/x/x`;
          handlers.message?.(topic, JSON.stringify({ VP: { lat: pos.lat + 0.0003 * Math.sin(step), long: pos.lon, hdg: 90, spd: 8, dl: -60, desi: leg.route.short, start: hm, tst: new Date().toISOString() } }));
        });
      }, 2000);
      return client;
    },
  };
}
