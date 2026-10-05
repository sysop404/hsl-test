import { test } from 'node:test';
import assert from 'node:assert/strict';

import { helsinkiToMs } from '../src/time.js';
import { DEFAULTS, sanitize } from '../src/settings.js';
import { buildPlanVariables } from '../src/plan.js';
import { liveItinerary, tripNotices } from '../src/timer.js';
import { buildExercise, exerciseStops, planExercise, walkingKcal } from '../src/exercise.js';
import { createPaceTracker, pacePrior, recordPace } from '../src/pace.js';
import { cumulative, haversine, projectOnPath } from '../src/geo.js';
import { createApi } from '../src/api.js';
import { mockFetch } from '../src/mock.js';

const settings = (over = {}) => sanitize({ ...DEFAULTS, apiKey: 'demo', ...over });
const A = { name: 'Kamppi', lat: 60.169, lon: 24.9316 };
const B = { name: 'Itäkeskus', lat: 60.2103, lon: 25.0814 };
const api = createApi({ getKey: () => 'demo', fetchImpl: mockFetch });
const m = 60000;

// ---------- earlier / later ----------

test('plan variables use first/after or last/before for paging', () => {
  const later = buildPlanVariables(settings(), { from: A, to: B, time: 0, after: 'c1', searchWindowMin: 60 });
  assert.equal(later.after, 'c1');
  assert.equal(later.first, 6);
  assert.equal(later.searchWindow, undefined);
  const earlier = buildPlanVariables(settings(), { from: A, to: B, before: 'c0', first: 4 });
  assert.equal(earlier.before, 'c0');
  assert.equal(earlier.last, 4);
  assert.equal(earlier.first, undefined);
});

test('page cursors give earlier and later routes (mock backend)', async () => {
  const time = helsinkiToMs('2026-10-05', 10);
  const r = await api.plan(settings(), { from: A, to: B, time });
  const minStart = Math.min(...r.itineraries.map((i) => i.start));
  const maxStart = Math.max(...r.itineraries.map((i) => i.start));
  const later = await api.plan(settings(), { from: A, to: B, time, after: r.pageInfo.endCursor });
  assert.ok(later.itineraries.length);
  assert.ok(later.itineraries.every((i) => i.start > maxStart));
  const earlier = await api.plan(settings(), { from: A, to: B, time, before: r.pageInfo.startCursor });
  assert.ok(earlier.itineraries.length);
  assert.ok(earlier.itineraries.every((i) => i.start < minStart));
});

// ---------- exercise ----------

test('exercise near the destination: gets off the same vehicle early, within range', async () => {
  const r = await api.plan(settings(), { from: A, to: B, time: helsinkiToMs('2026-10-05', 10) });
  const it = r.itineraries.find((i) => i.transfers === 1);
  const walks = (pairs) => api.walks(pairs, 6);
  const plan = await planExercise({ it, where: 'last', minM: 800, maxM: 1500, walks });
  assert.equal(plan.status, 'ok');
  assert.ok(plan.chosen.distance >= 800 && plan.chosen.distance <= 1500);
  const x = buildExercise(it, plan, plan.chosen, 6, { weightKg: 70, heightCm: 175 });
  const tram = x.legs[plan.legIndex];
  const walk = x.legs[x.legs.length - 1];
  assert.equal(tram.trip.id, it.legs[plan.legIndex].trip.id, 'same vehicle');
  assert.equal(tram.to.stopId, plan.chosen.stop.place.stopId);
  assert.ok(tram.end < it.legs[plan.legIndex].end, 'gets off earlier');
  assert.ok(walk.exercise);
  assert.equal(walk.start, tram.end);
  assert.equal(Math.round((walk.end - walk.start) / 1000), Math.round(plan.chosen.distance / (6 / 3.6)), 'exercise speed only');
  assert.equal(x.end, walk.end);
  assert.ok(x.exercise.kcal.total > x.exercise.kcal.active);
  // Everything before the shortened leg is untouched.
  assert.deepEqual(x.legs.slice(0, plan.legIndex), it.legs.slice(0, plan.legIndex));
});

test('exercise from the start: walk to a later stop and board the same vehicle there', async () => {
  const r = await api.plan(settings(), { from: A, to: B, time: helsinkiToMs('2026-10-05', 10) });
  const it = r.itineraries.find((i) => i.transfers === 0);
  // The planned stop is about 1 km away, so ask for more than that.
  const plan = await planExercise({ it, where: 'first', minM: 1500, maxM: 2500, walks: (p) => api.walks(p, 6) });
  assert.equal(plan.status, 'ok');
  const x = buildExercise(it, plan, plan.chosen, 6);
  assert.ok(x.legs[0].exercise);
  assert.equal(x.legs[0].end, x.legs[1].start);
  assert.equal(x.legs[1].trip.id, it.legs[1].trip.id);
  assert.ok(x.legs[1].start > it.legs[1].start, 'boards later along the line');
  assert.equal(x.end, it.end, 'same arrival');
  assert.equal(x.exercise.kcal, null, 'no calories without weight and height');
});

test('no stop in range: suggests the nearest shorter and longer walks', async () => {
  const r = await api.plan(settings(), { from: A, to: B, time: helsinkiToMs('2026-10-05', 10) });
  const it = r.itineraries.find((i) => i.transfers === 1);
  // Find a gap between two consecutive walking distances and ask for a range inside it.
  const { stops } = exerciseStops(it, 'last');
  const dists = (await api.walks(stops.map((s) => ({ from: s.place, to: B })), 6)).map((w) => w.distance).sort((a, b) => a - b);
  const i = dists.findIndex((d, k) => k > 0 && d - dists[k - 1] > 60);
  const lo = dists[i - 1];
  const hi = dists[i];
  const plan = await planExercise({ it, where: 'last', minM: Math.ceil(lo + 10), maxM: Math.floor(hi - 10), walks: (p) => api.walks(p, 6) });
  assert.equal(plan.status, 'none');
  assert.ok(Math.abs(plan.shorter.distance - lo) < 1);
  assert.ok(Math.abs(plan.longer.distance - hi) < 1);
  const x = buildExercise(it, plan, plan.longer, 6);
  assert.equal(x.exercise.inRange, false);
});

test('calories follow Ludlow & Weyand: more for heavier, faster and shorter walkers', () => {
  const base = { distanceM: 1000, speedKmh: 5, weightKg: 70, heightCm: 175 };
  const k = walkingKcal(base);
  // 5 km/h, 1.75 m: VO2 = 3.5 + 3.85 + 5.97·1.389²/1.75 ≈ 13.93 ml/kg/min for 12 min.
  assert.ok(Math.abs(k.total - 13.93 * 70 * 12 / 1000 * 5) < 0.5, String(k.total));
  assert.ok(walkingKcal({ ...base, weightKg: 90 }).total > k.total);
  assert.ok(walkingKcal({ ...base, heightCm: 160 }).active > k.active);
  assert.ok(walkingKcal({ ...base, speedKmh: 6.5 }).active > k.active, 'faster costs more per km');
  assert.equal(walkingKcal({ ...base, weightKg: null }), null);
});

// ---------- live delays ----------

function trip() {
  const T = helsinkiToMs('2026-10-05', 8);
  const stop = (n) => ({ name: n, lat: 60, lon: 25, stopId: `HSL:${n}` });
  return {
    key: 'k', start: T, end: T + 40 * m, duration: 2400,
    legs: [
      { transit: false, start: T, end: T + 5 * m, from: stop('home'), to: stop('s1') },
      { transit: true, start: T + 5 * m, startScheduled: T + 5 * m, end: T + 20 * m, from: stop('s1'), to: stop('x'), route: { short: '550' } },
      { transit: false, start: T + 20 * m, end: T + 22 * m, from: stop('x'), to: stop('y') },
      { transit: true, start: T + 26 * m, startScheduled: T + 26 * m, end: T + 36 * m, from: stop('y'), to: stop('s2'), route: { short: '4' } },
      { transit: false, start: T + 36 * m, end: T + 40 * m, from: stop('s2'), to: stop('dest') },
    ],
  };
}

test('a late first bus keeps the leave time; an early one moves it earlier', () => {
  const base = trip();
  const T = base.start;
  const late = liveItinerary(base, new Map([[1, { ...base.legs[1], start: base.legs[1].start + 4 * m, end: base.legs[1].end + 4 * m }]]));
  assert.equal(late.legs[0].start, T, 'leave time unchanged');
  assert.equal(late.legs[2].start, base.legs[2].start + 4 * m, 'walk after the bus follows it');
  const n = tripNotices(base, late, T - m, 180);
  assert.equal(n.find((x) => x.kind === 'late').deltaSec, 240);
  assert.equal(n.find((x) => x.kind === 'late').first, true);
  assert.equal(n.find((x) => x.kind === 'tight').seconds, 0, '4 min late eats the 4 min transfer');
  const later = liveItinerary(base, new Map([[1, { ...base.legs[1], start: base.legs[1].start + 5 * m, end: base.legs[1].end + 5 * m }]]));
  assert.equal(tripNotices(base, later, T - m, 180).find((x) => x.kind === 'missed').seconds, -60);

  const early = liveItinerary(base, new Map([[1, { ...base.legs[1], start: base.legs[1].start - 2 * m, end: base.legs[1].end - 2 * m }]]));
  assert.equal(early.legs[0].start, T - 2 * m, 'leave 2 min earlier');
  assert.equal(early.legs[0].end, early.legs[1].start);
  assert.equal(early.start, T - 2 * m);
  const e = tripNotices(base, early, T - 5 * m, 180).find((x) => x.kind === 'early');
  assert.equal(e.leaveNow, T - 2 * m);
  assert.equal(e.leaveWas, T);
});

test('notices flag tight transfers and arrival changes, and ignore small drifts', () => {
  const base = trip();
  const T = base.start;
  assert.deepEqual(tripNotices(base, base, T, 180), []);
  const drift = liveItinerary(base, new Map([[1, { ...base.legs[1], start: base.legs[1].start + 30_000 }]]));
  assert.deepEqual(tripNotices(base, drift, T, 180), []);
  const tight = liveItinerary(base, new Map([[1, { ...base.legs[1], end: base.legs[1].end + 2 * m }]]));
  const t = tripNotices(base, tight, T, 180).find((x) => x.kind === 'tight');
  assert.equal(t.seconds, 120);
  const lateTram = liveItinerary(base, new Map([[3, { ...base.legs[3], start: base.legs[3].start + 3 * m, end: base.legs[3].end + 3 * m }]]));
  const arr = tripNotices(base, lateTram, T, 180).find((x) => x.kind === 'arrival');
  assert.equal(arr.deltaSec, 180);
});

// ---------- pace ----------

/** Deterministic pseudo-random noise. */
function rng(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; };
}

function lPath() {
  // 600 m east, then 600 m north: an L-shaped walk.
  const o = { lat: 60.17, lon: 24.93 };
  const dLon = 600 / (111320 * Math.cos((60.17 * Math.PI) / 180));
  const dLat = 600 / 110574;
  return [[o.lat, o.lon], [o.lat, o.lon + dLon], [o.lat + dLat, o.lon + dLon]];
}

test('projection gives distance along the path and ignores sideways offset', () => {
  const path = lPath();
  const len = cumulative(path).pop();
  assert.ok(Math.abs(len - 1200) < 5);
  const mid = { lat: path[1][0] + 0.0001, lon: path[1][1] };
  const pr = projectOnPath(path, mid);
  assert.ok(Math.abs(pr.s - 611) < 5, String(pr.s));
  assert.ok(Math.abs(haversine(path[0], path[1]) - 600) < 3);
});

test('live pace: noisy GPS gives an accurate speed and ETA', () => {
  const path = lPath();
  const cum = cumulative(path);
  const rand = rng(7);
  const speed = 1.6; // m/s, 5.76 km/h
  const tracker = createPaceTracker({ path, prior: pacePrior({ n: 0, mean: 0, var: 0 }, 5) });
  const t0 = 1_700_000_000_000;
  const at = (s) => {
    const i = s < cum[1] ? 0 : 1;
    const f = (s - cum[i]) / (cum[i + 1] - cum[i]);
    return [path[i][0] + (path[i + 1][0] - path[i][0]) * f, path[i][1] + (path[i + 1][1] - path[i][1]) * f];
  };
  for (let k = 0; k <= 300; k += 2) {
    const [lat, lon] = at(Math.min(1199, k * speed));
    // ±10 m noise in both directions, accuracy reported as 10 m; one wild 400 m jump to reject.
    const wild = k === 100 ? 0.004 : 0;
    tracker.addFix({ lat: lat + (rand() - 0.5) * 0.00018 + wild, lon: lon + (rand() - 0.5) * 0.00036, accuracy: 10, t: t0 + k * 1000 });
    if (k === 200) {
      const est = tracker.estimate();
      assert.ok(Math.abs(est.speed - speed) < 0.12, `speed ${est.speed}`);
      const trueEta = t0 + (1200 / speed) * 1000;
      // ~880 m to go: within half a minute.
      assert.ok(Math.abs(est.eta - trueEta) < 30_000, `eta off by ${(est.eta - trueEta) / 1000} s`);
    }
  }
  const seg = tracker.segmentSpeed();
  assert.ok(Math.abs(seg - speed) < 0.08, `segment ${seg}`);
});

test('learned pace: running average, then exponential; outliers ignored', () => {
  let stats = { walk: { n: 0, mean: 0, var: 0 }, exercise: { n: 0, mean: 0, var: 0 } };
  for (const v of [1.4, 1.5, 1.45, 1.55]) stats = recordPace(stats, 'walk', v).stats;
  assert.equal(stats.walk.n, 4);
  assert.ok(Math.abs(stats.walk.mean - 1.475) < 1e-9);
  const out = recordPace(stats, 'walk', 2.6);
  assert.equal(out.accepted, false, 'a bus ride mistaken for walking is ignored');
  assert.equal(recordPace(stats, 'walk', 0.2).accepted, false);
  assert.equal(stats.exercise.n, 0, 'kinds are kept apart');
  const prior = pacePrior(stats.walk, 5);
  assert.ok(Math.abs(prior.mean - 1.475) < 1e-9);
  assert.ok(prior.sd >= 0.08 && prior.sd <= 0.5);
  assert.equal(pacePrior({ n: 1, mean: 2, var: 0 }, 5).mean, 5 / 3.6, 'one walk is not enough to trust');
});

// ---------- settings ----------

test('exercise settings are clamped and kept consistent', () => {
  const s = sanitize({ ...DEFAULTS, exercise: { enabled: 1, where: 'x', minM: 2000, maxM: 500, speedKmh: 99 }, weightKg: '70', heightCm: '' });
  assert.equal(s.exercise.enabled, true);
  assert.equal(s.exercise.where, 'last');
  assert.equal(s.exercise.minM, 500);
  assert.equal(s.exercise.maxM, 2000);
  assert.equal(s.exercise.speedKmh, 10);
  assert.equal(s.exercise.useMeasured, true);
  assert.equal(s.weightKg, 70);
  assert.equal(s.heightCm, null);
  assert.equal(sanitize({ ...DEFAULTS, exercise: undefined }).exercise.minM, 800);
});
