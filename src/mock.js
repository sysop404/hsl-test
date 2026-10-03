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

function leg({ mode, from, to, start, end, route, trip, headsign, delay = 0 }) {
  const transit = mode !== 'WALK';
  const lt = (t) => ({ scheduledTime: iso(t), estimated: transit && delay ? { time: iso(t + delay * 1000), delay: `PT${delay}S` } : null });
  return {
    mode, distance: dist(from, to) * 1000, duration: (end - start) / 1000, transitLeg: transit,
    headsign: headsign ?? null, serviceDate: transit ? serviceDate(start) : null, realtimeState: delay ? 'UPDATED' : 'SCHEDULED',
    interlineWithPreviousLeg: false,
    start: lt(start), end: lt(end),
    from: { name: from.name, lat: from.lat, lon: from.lon, stop: from.stopId ? { gtfsId: from.stopId, code: from.code, platformCode: null } : null },
    to: { name: to.name, lat: to.lat, lon: to.lon, stop: to.stopId ? { gtfsId: to.stopId, code: to.code, platformCode: null } : null },
    route: route ?? null,
    trip: trip ?? null,
    legGeometry: { points: encodePolyline([[from.lat, from.lon], [(from.lat + to.lat) / 2 + 0.002, (from.lon + to.lon) / 2], [to.lat, to.lon]]) },
    alerts: [],
  };
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
  return { ...p, name, stopId: `HSL:${id}`, code: `H${id % 10000}` };
}

function buildItineraries(vars) {
  const o = vars.origin.location.coordinate ?? { latitude: 60.1711, longitude: 24.9441 };
  const d = vars.destination.location.coordinate ?? { latitude: 60.2103, longitude: 25.0814 };
  const A = { name: vars.origin.label ?? 'Origin', lat: o.latitude, lon: o.longitude };
  const B = { name: vars.destination.label ?? 'Destination', lat: d.latitude, lon: d.longitude };
  const slack = parseDuration(vars.preferences?.transit?.transfer?.slack ?? 'PT2M');
  const maxTransfers = vars.preferences?.transit?.transfer?.maximumTransfers ?? 9;
  const first = vars.first ?? 6;
  const windowSec = vars.searchWindow ? parseDuration(vars.searchWindow) : 3600;
  const t0 = Date.parse(vars.dateTime?.earliestDeparture ?? new Date().toISOString());

  const s1 = stop(lerp(A, B, 0.08), 1001, 'Lähtöpysäkki');
  const sx = stop(lerp(A, B, 0.55), 1002, 'Vaihtopysäkki');
  const sx2 = stop(lerp(A, B, 0.57), 1003, 'Vaihtopysäkki (laituri 2)');
  const s2 = stop(lerp(A, B, 0.93), 1004, 'Määräpysäkki');
  const km = Math.max(1, dist(A, B));
  const out = [];

  // Pattern 1: bus 550 then tram 4 (one transfer). Pattern 2: direct bus 52 (slower, less frequent).
  for (let k = 0; out.length < first * 2 && k < 40; k++) {
    const p = profile(t0 + k * 60000 * 5);
    const busDep = alignUp(t0 + 4 * 60000, p.headway * 60000, 2) + k * p.headway * 60000;
    if (busDep - t0 > windowSec * 1000 + 4 * 60000) break;
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
          leg({ mode: 'BUS', from: s1, to: sx, start: busDep, end: busArr, delay, headsign: 'Itäkeskus',
            route: { gtfsId: 'HSL:1550', shortName: '550', longName: 'Westendinasema - Itäkeskus', mode: 'BUS', color: '007AC9' },
            trip: { gtfsId: `HSL:1550_${busDep}`, directionId: '0', tripHeadsign: 'Itäkeskus', departureStoptime: { scheduledDeparture: secOfDay(busDep - 600000) } } }),
          leg({ mode: 'WALK', from: sx, to: sx2, start: busArr, end: busArr + walkX }),
          leg({ mode: 'TRAM', from: sx2, to: s2, start: tramDep, end: tramArr, headsign: 'Arabia',
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
          leg({ mode: 'BUS', from: s1, to: s2, start: dDep, end: dArr, headsign: 'Kontula',
            route: { gtfsId: 'HSL:1052', shortName: '52', longName: 'Kuninkaantammi - Kontula', mode: 'BUS', color: '007AC9' },
            trip: { gtfsId: `HSL:1052_${dDep}`, directionId: '0', tripHeadsign: 'Kontula', departureStoptime: { scheduledDeparture: secOfDay(dDep - 300000) } } }),
          leg({ mode: 'WALK', from: s2, to: B, start: dArr, end: dArr + 3 * 60000 }),
        ],
      });
    }
  }
  return out
    .filter((it) => Date.parse(it.legs[0].start.scheduledTime) >= t0 - 60000)
    .sort((a, b) => Date.parse(a.legs[0].start.scheduledTime) - Date.parse(b.legs[0].start.scheduledTime))
    .slice(0, first)
    .map((it) => ({
      ...it,
      start: it.legs[0].start.scheduledTime,
      end: it.legs[it.legs.length - 1].end.scheduledTime,
      duration: 0,
      walkDistance: 600,
      waitingTime: 0,
    }));
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
    if (query.includes('planConnection')) {
      return json({ data: { planConnection: { searchDateTime: null, routingErrors: [], pageInfo: { searchWindowUsed: 'PT1H' }, edges: buildItineraries(variables).map((node) => ({ cursor: 'x', node })) } } });
    }
    if (query.includes('routes(')) {
      return json({ data: { routes: [{ gtfsId: `HSL:1${variables.name}`, shortName: variables.name }] } });
    }
    if (query.includes('stoptimesForDate')) {
      return json({ data: { trip: null } });
    }
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
