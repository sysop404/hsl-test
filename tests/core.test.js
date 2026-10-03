import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtCountdown, fmtDuration, helsinkiDate, helsinkiToMs, hhmm, secToHfpStart, toOffsetDateTime } from '../src/time.js';
import { decodePolyline, encodePolyline } from '../src/polyline.js';
import { DEFAULTS, exportSettings, importSettings, loadSettings, sanitize, saveSettings } from '../src/settings.js';
import { buildPlanVariables, transferGaps, withoutAvoided } from '../src/plan.js';
import { hourlyStats, runSweep, usefulDepartures } from '../src/sweep.js';
import { pickAlternative, planB } from '../src/planb.js';
import { applyLiveTimes, tripPhase } from '../src/timer.js';
import { legTopic, parseVp, topicMatches } from '../src/live.js';
import { createApi } from '../src/api.js';
import { mockFetch } from '../src/mock.js';

const settings = (over = {}) => sanitize({ ...DEFAULTS, apiKey: 'demo', ...over });
const A = { name: 'Kamppi', lat: 60.169, lon: 24.9316 };
const B = { name: 'Itäkeskus', lat: 60.2103, lon: 25.0814 };
const api = createApi({ getKey: () => 'demo', fetchImpl: mockFetch });

// ---------- time ----------

test('Helsinki wall-clock conversion handles winter and summer time', () => {
  assert.equal(toOffsetDateTime(helsinkiToMs('2026-01-15', 8, 30)), '2026-01-15T08:30:00+02:00');
  assert.equal(toOffsetDateTime(helsinkiToMs('2026-07-15', 8, 30)), '2026-07-15T08:30:00+03:00');
  assert.equal(hhmm(helsinkiToMs('2026-07-15', 8, 5)), '08:05');
  assert.equal(helsinkiDate(helsinkiToMs('2026-10-03', 23, 59)), '2026-10-03');
  // Hour 24 rolls over to the next day.
  assert.equal(helsinkiDate(helsinkiToMs('2026-10-03', 24)), '2026-10-04');
});

test('formatting helpers', () => {
  assert.equal(fmtDuration(45 * 60), '45 min');
  assert.equal(fmtDuration(65 * 60), '1 h 05 min');
  assert.equal(fmtCountdown(65_000), '1:05');
  assert.equal(fmtCountdown(-1), 'now');
  assert.equal(secToHfpStart(8 * 3600 + 12 * 60), '08:12');
  assert.equal(secToHfpStart(25 * 3600 + 5 * 60), '01:05');
});

// ---------- polyline ----------

test('decodes the reference polyline and round-trips', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pts, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  assert.equal(encodePolyline(pts), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});

// ---------- settings ----------

test('settings persist through storage and clamp bad values', () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadSettings(store), sanitize(DEFAULTS));
  saveSettings({ ...DEFAULTS, apiKey: ' abc ', transferSlackMin: 99, avoidLines: ['550', ' m2 ', '550', ''] }, store);
  const s = loadSettings(store);
  assert.equal(s.apiKey, 'abc');
  assert.equal(s.transferSlackMin, 30);
  assert.deepEqual(s.avoidLines, ['550', 'M2']);
  assert.equal(loadSettings({ getItem: () => '{broken' }).transferSlackMin, DEFAULTS.transferSlackMin);
});

test('settings export leaves out the API key and import keeps the current one', () => {
  const enc = exportSettings(settings({ apiKey: 'secret', transferSlackMin: 7, places: [{ name: 'Koti', lat: 60.2, lon: 24.9 }] }));
  assert.ok(!Buffer.from(enc, 'base64url').toString().includes('secret'));
  const merged = importSettings(settings({ apiKey: 'mine' }), enc);
  assert.equal(merged.apiKey, 'mine');
  assert.equal(merged.transferSlackMin, 7);
  assert.equal(merged.places[0].name, 'Koti');
});

// ---------- plan ----------

test('plan variables carry transfer time, walk speed, filters and modes', () => {
  const v = buildPlanVariables(settings({ transferSlackMin: 4, walkSpeedKmh: 3.6, maxTransfers: 1, wheelchair: true, modes: ['BUS', 'TRAM'] }),
    { from: A, to: { ...B, stopId: 'HSL:1234' }, time: helsinkiToMs('2026-10-05', 8), avoidRouteIds: ['HSL:1550'] });
  assert.equal(v.preferences.transit.transfer.slack, 'PT240S');
  assert.equal(v.preferences.transit.transfer.maximumTransfers, 1);
  assert.equal(v.preferences.street.walk.speed, 1);
  assert.deepEqual(v.preferences.accessibility, { wheelchair: { enabled: true } });
  assert.deepEqual(v.preferences.transit.filters, [{ exclude: [{ routes: ['HSL:1550'] }] }]);
  assert.deepEqual(v.modes, { transit: { transit: [{ mode: 'BUS' }, { mode: 'TRAM' }] } });
  assert.deepEqual(v.origin.location, { coordinate: { latitude: A.lat, longitude: A.lon } });
  assert.deepEqual(v.destination.location, { stopLocation: { stopLocationId: 'HSL:1234' } });
  assert.deepEqual(v.dateTime, { earliestDeparture: '2026-10-05T08:00:00+03:00' });

  const all = buildPlanVariables(settings(), { from: A, to: B, time: 0, arriveBy: true });
  assert.equal(all.modes, undefined);
  assert.equal(all.preferences.transit.filters, undefined);
  assert.ok(all.dateTime.latestArrival);
});

test('itineraries respect the minimum transfer time end to end (mock backend)', async () => {
  for (const slack of [1, 6]) {
    const r = await api.plan(settings({ transferSlackMin: slack }), { from: A, to: B, time: helsinkiToMs('2026-10-05', 10) });
    assert.ok(r.itineraries.length > 0);
    for (const it of r.itineraries) {
      for (const g of transferGaps(it)) assert.ok(g.seconds >= slack * 60, `gap ${g.seconds}s < ${slack} min`);
    }
  }
});

test('avoided lines are removed client side as a safety net', async () => {
  const r = await api.plan(settings(), { from: A, to: B, time: helsinkiToMs('2026-10-05', 10) });
  const kept = withoutAvoided(r.itineraries, ['550']);
  assert.ok(kept.length < r.itineraries.length);
  assert.ok(kept.every((it) => it.legs.every((l) => l.route?.short !== '550')));
});

// ---------- sweep ----------

const fake = (start, end, key) => ({ key, start, end, legs: [{ transit: true }] });

test('dominated departures are dropped', () => {
  const m = 60000;
  const deps = usefulDepartures([
    fake(0, 40 * m, 'a'),
    fake(5 * m, 35 * m, 'b'), // leaves later, arrives earlier: dominates a
    fake(10 * m, 50 * m, 'c'),
    fake(10 * m, 50 * m, 'c'), // duplicate
    { key: 'w', start: 0, end: 90 * m, legs: [{ transit: false }] }, // walk only
  ]);
  assert.deepEqual(deps.map((d) => d.key), ['b', 'c']);
});

test('hourly stats: ride time and just-leave time', () => {
  const date = '2026-10-05';
  const t = (h, min) => helsinkiToMs(date, h, min);
  // Departures every 30 min taking 20 min, from 8:00 to 9:30.
  const its = [0, 30, 60, 90].map((k) => fake(t(8, k), t(8, k + 20), `k${k}`));
  const [h8, h9] = hourlyStats(its, date, 8, 10);
  assert.equal(h8.departures, 2);
  assert.equal(h8.rideAvg, 20);
  // Leaving at a random minute: average wait 14.5 min + 20 min ride.
  assert.equal(h8.showUpAvg, 34.5);
  // 9:31–9:59 has no later departure, so the just-leave figure is unknown.
  assert.equal(h9.showUpAvg, null);
});

test('runSweep queries every hour and aggregates (mock backend)', async () => {
  let calls = 0;
  const res = await runSweep({
    plan: (time) => { calls++; return api.plan(settings(), { from: A, to: B, time, searchWindowMin: 60, first: 30 }); },
    date: '2026-10-05', fromHour: 6, toHour: 10, delayMs: 0,
  });
  assert.equal(calls, 5); // 6,7,8,9 plus 10 for the last hour's waiting time
  assert.equal(res.rows.length, 4);
  const rush = res.rows.find((r) => r.hour === 8);
  const calm = res.rows.find((r) => r.hour === 6);
  assert.ok(rush.rideAvg > calm.rideAvg, 'mock rush hour should be slower');
  assert.ok(res.rows.every((r) => r.showUpAvg >= r.rideMin));
});

// ---------- plan B ----------

test('plan B skips the missed vehicle and reports the delay', async () => {
  const r = await api.plan(settings(), { from: A, to: B, time: helsinkiToMs('2026-10-05', 10) });
  const it = r.itineraries.find((i) => i.transfers === 1);
  const legIndex = it.legs.findIndex((l) => l.transit);
  const alt = await planB({ plan: (o) => api.plan(settings(), o), itinerary: it, legIndex, to: B });
  assert.ok(alt);
  const first = alt.itinerary.legs.find((l) => l.transit);
  assert.notEqual(first.trip.id, it.legs[legIndex].trip.id);
  assert.ok(first.start > it.legs[legIndex].start);
  assert.ok(alt.delaySec >= 0);

  assert.equal(pickAlternative([], it.legs[legIndex], it.end), null);
});

// ---------- timer ----------

test('trip phases: before, walk, wait, ride, done', () => {
  const m = 60000;
  const T = helsinkiToMs('2026-10-05', 8);
  const stop = (n) => ({ name: n, lat: 60, lon: 25, stopId: `HSL:${n}` });
  const it = {
    start: T, end: T + 40 * m,
    legs: [
      { transit: false, start: T, end: T + 5 * m, from: stop('home'), to: stop('s1') },
      { transit: true, start: T + 8 * m, end: T + 20 * m, from: stop('s1'), to: stop('x'), route: { short: '550' } },
      { transit: false, start: T + 20 * m, end: T + 22 * m, from: stop('x'), to: stop('y') },
      { transit: true, start: T + 26 * m, end: T + 36 * m, from: stop('y'), to: stop('s2'), route: { short: '4' } },
      { transit: false, start: T + 36 * m, end: T + 40 * m, from: stop('s2'), to: stop('dest') },
    ],
  };
  assert.equal(tripPhase(it, T - m).phase, 'before');
  const walk = tripPhase(it, T + 2 * m);
  assert.equal(walk.phase, 'walk');
  assert.equal(walk.target, T + 8 * m);
  assert.equal(walk.label, '550 leaves in');
  assert.equal(tripPhase(it, T + 6 * m).phase, 'wait');
  const ride = tripPhase(it, T + 10 * m);
  assert.equal(ride.phase, 'ride');
  assert.equal(ride.target, T + 20 * m);
  assert.equal(ride.transferSlackSec, 4 * 60); // 26 - 20 - 2 min walk
  const walk2 = tripPhase(it, T + 21 * m);
  assert.equal(walk2.label, '4 leaves in');
  assert.equal(tripPhase(it, T + 38 * m).label, 'Arrive in');
  assert.equal(tripPhase(it, T + 41 * m).phase, 'done');
});

test('live stop times update a leg', () => {
  const leg = { from: { stopId: 'A' }, to: { stopId: 'C' }, start: 0, end: 0, realtime: false };
  const times = [
    { stopId: 'A', arr: 100, dep: 110, realtime: true },
    { stopId: 'B', arr: 200, dep: 210, realtime: true },
    { stopId: 'C', arr: 300, dep: 310, realtime: true },
  ];
  const u = applyLiveTimes(leg, times);
  assert.equal(u.start, 110);
  assert.equal(u.end, 300);
  assert.equal(u.realtime, true);
  assert.equal(applyLiveTimes({ ...leg, from: { stopId: 'Z' } }, times).start, 0);
});

// ---------- live vehicles ----------

test('HFP topic, message parsing and wildcard matching', () => {
  const leg = { transit: true, route: { id: 'HSL:1550' }, trip: { directionId: '0', startSec: 8 * 3600 + 12 * 60 } };
  const pattern = legTopic(leg);
  assert.equal(pattern, '/hfp/v2/journey/ongoing/vp/+/+/+/1550/1/+/08:12/#');
  const topic = '/hfp/v2/journey/ongoing/vp/bus/0022/01216/1550/1/Itäkeskus(M)/08:12/1201129/5/60;24/19/73/45';
  assert.ok(topicMatches(pattern, topic));
  assert.ok(!topicMatches(pattern, topic.replace('/1550/', '/1551/')));
  const v = parseVp(topic, JSON.stringify({ VP: { lat: 60.2, long: 24.9, dl: -90, desi: '550', start: '08:12', hdg: 10, spd: 7.5 } }));
  assert.equal(v.id, '0022/01216');
  assert.equal(v.delaySec, 90);
  assert.equal(parseVp(topic, '{"VP":{"lat":null}}'), null);
  assert.equal(legTopic({ transit: false }), null);
});

// ---------- API errors ----------

test('API reports missing and rejected keys clearly', async () => {
  const noKey = createApi({ getKey: () => '', fetchImpl: mockFetch });
  await assert.rejects(noKey.autocomplete('kamppi'), /No API key/);
  const rejected = createApi({ getKey: () => 'x', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(rejected.plan(settings(), { from: A, to: B }), (e) => e.status === 401 && /rejected the API key/.test(e.message));
});
