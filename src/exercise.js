// Exercise mode: walk part of the trip on purpose by getting off the vehicle early (near the
// destination) or boarding it a few stops later (near the origin). Leave-off points are the
// stops of the line you're already taking, so the vehicle and the rest of the trip stay the same.

import { decodePolyline, encodePolyline } from './polyline.js';
import { cumulative, haversine, nearestIndex } from './geo.js';

const placeOnly = (p) => ({ name: p.name, lat: p.lat, lon: p.lon, stopId: p.stopId ?? null, code: p.code ?? null, platform: p.platform ?? null });

/** Index of the transit leg the exercise replaces part of: first or last transit leg, or -1. */
export function exerciseLegIndex(it, where) {
  const idx = it.legs.map((l, i) => (l.transit ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return -1;
  return where === 'first' ? idx[0] : idx[idx.length - 1];
}

/**
 * Stops where you could get off ('last') or on ('first') the chosen leg, the planned one included.
 * Each: { place, time, scheduled, k (index in leg.stops) | planned: true, crow (m to target) }.
 */
export function exerciseStops(it, where) {
  const legIndex = exerciseLegIndex(it, where);
  if (legIndex < 0) return { legIndex, stops: [], target: null };
  const leg = it.legs[legIndex];
  const target = where === 'first' ? it.legs[0].from : it.legs[it.legs.length - 1].to;
  const mid = (leg.stops ?? []).map((s, k) => (where === 'first'
    ? { place: placeOnly(s), time: s.dep, scheduled: s.depScheduled, k }
    : { place: placeOnly(s), time: s.arr, scheduled: s.arrScheduled, k }));
  const planned = where === 'first'
    ? { place: placeOnly(leg.from), time: leg.start, scheduled: leg.startScheduled, planned: true }
    : { place: placeOnly(leg.to), time: leg.end, scheduled: leg.endScheduled, planned: true };
  const stops = (where === 'first' ? [planned, ...mid] : [...mid, planned])
    .map((s) => ({ ...s, crow: haversine(s.place, target) }));
  return { legIndex, stops, target };
}

/**
 * Stops worth asking walking distances for. Walking is never shorter than the straight line,
 * so stops whose straight line is already past the maximum can only be "longer" suggestions:
 * keep the two nearest of those. Within range, keep the `cap` closest to the middle of the range.
 */
export function shortlist(stops, minM, maxM, cap = 10) {
  const reachable = stops.filter((s) => s.crow <= maxM * 1.05);
  const beyond = stops.filter((s) => s.crow > maxM * 1.05).sort((a, b) => a.crow - b.crow).slice(0, 2);
  const mid = (minM + maxM) / 2;
  // Typical street detour is about 1.25 × the straight line.
  const ranked = reachable.sort((a, b) => Math.abs(a.crow * 1.25 - mid) - Math.abs(b.crow * 1.25 - mid)).slice(0, cap);
  return [...ranked, ...beyond];
}

/**
 * Picks the leave-off point for one itinerary.
 * walks(pairs) resolves to [{ distance, points } | null] for [{ from, to }].
 * Returns { status: 'ok' | 'none' | 'na', where, legIndex, target, options, chosen, shorter, longer }.
 *   ok:   chosen is the in-range stop nearest the middle of the range; options lists all in range.
 *   none: nothing in range; shorter / longer are the nearest stops on either side (either may be null).
 *   na:   the itinerary has no transit leg.
 */
export async function planExercise({ it, where, minM, maxM, walks }) {
  const { legIndex, stops, target } = exerciseStops(it, where);
  if (legIndex < 0) return { status: 'na', where };
  const cands = shortlist(stops, minM, maxM);
  const pairs = cands.map((s) => (where === 'first' ? { from: target, to: s.place } : { from: s.place, to: target }));
  const res = await walks(pairs);
  const measured = cands
    .map((stop, i) => (res[i] ? { stop, distance: res[i].distance, points: res[i].points } : null))
    .filter(Boolean)
    .map((o) => ({ ...o, inRange: o.distance >= minM && o.distance <= maxM }));
  const base = { where, legIndex, target, options: measured.filter((o) => o.inRange) };
  if (base.options.length) {
    const mid = (minM + maxM) / 2;
    const chosen = base.options.reduce((a, b) => (Math.abs(b.distance - mid) < Math.abs(a.distance - mid) ? b : a));
    base.options.sort((a, b) => a.distance - b.distance);
    return { ...base, status: 'ok', chosen };
  }
  const shorter = measured.filter((o) => o.distance < minM).sort((a, b) => b.distance - a.distance)[0] ?? null;
  const longer = measured.filter((o) => o.distance > maxM).sort((a, b) => a.distance - b.distance)[0] ?? null;
  return { ...base, status: 'none', chosen: null, shorter, longer };
}

/** Part of an encoded polyline up to ('head') or from ('tail') the vertex nearest to p. */
export function cutPolyline(points, p, part) {
  const path = points ? decodePolyline(points) : [];
  if (path.length < 2) return points;
  const i = nearestIndex(path, p);
  const at = [p.lat, p.lon];
  return encodePolyline(part === 'head' ? [...path.slice(0, i + 1), at] : [at, ...path.slice(i)]);
}

const pathLength = (points) => (points ? cumulative(decodePolyline(points)).pop() : 0);

/**
 * The itinerary with the exercise walk in it. option comes from planExercise; speedKmh is the
 * exercise walking speed (only this walk uses it); body = { weightKg, heightCm } for calories.
 */
export function buildExercise(it, plan, option, speedKmh, body = {}) {
  const leg = it.legs[plan.legIndex];
  const s = option.stop;
  const durMs = Math.round((option.distance / (speedKmh / 3.6)) * 1000);
  const walk = {
    mode: 'WALK', transit: false, exercise: true, distance: option.distance, duration: durMs / 1000,
    points: option.points, alerts: [], stops: [], route: null, trip: null, realtime: false, headsign: '',
    interlined: false, serviceDate: null,
  };
  let legs;
  let walkIndex;
  if (plan.where === 'last') {
    const cut = s.planned ? leg : {
      ...leg, to: s.place, end: s.time, endScheduled: s.scheduled, stops: leg.stops.slice(0, s.k),
      points: cutPolyline(leg.points, s.place, 'head'),
    };
    if (!s.planned) cut.distance = pathLength(cut.points) || leg.distance;
    const w = { ...walk, from: cut.to, to: plan.target, start: cut.end, end: cut.end + durMs };
    legs = [...it.legs.slice(0, plan.legIndex), cut, { ...w, startScheduled: w.start, endScheduled: w.end }];
    walkIndex = legs.length - 1;
  } else {
    const cut = s.planned ? leg : {
      ...leg, from: s.place, start: s.time, startScheduled: s.scheduled, stops: leg.stops.slice(s.k + 1),
      points: cutPolyline(leg.points, s.place, 'tail'),
    };
    if (!s.planned) cut.distance = pathLength(cut.points) || leg.distance;
    const w = { ...walk, from: plan.target, to: cut.from, start: cut.start - durMs, end: cut.start };
    legs = [{ ...w, startScheduled: w.start, endScheduled: w.end }, cut, ...it.legs.slice(plan.legIndex + 1)];
    walkIndex = 0;
  }
  const start = legs[0].start;
  const end = legs[legs.length - 1].end;
  const duration = Math.round((end - start) / 1000);
  return {
    ...it,
    key: `${it.key}#ex:${s.place.stopId ?? `${s.place.lat},${s.place.lon}`}`,
    baseKey: it.key,
    start,
    end,
    duration,
    walkDistance: legs.filter((l) => !l.transit).reduce((sum, l) => sum + (l.distance ?? 0), 0),
    legs,
    exercise: {
      where: plan.where,
      walkIndex,
      stopName: s.place.name,
      distance: option.distance,
      durationSec: durMs / 1000,
      speedKmh,
      inRange: option.inRange,
      extraSec: duration - it.duration,
      kcal: walkingKcal({ distanceM: option.distance, speedKmh, ...body }),
    },
  };
}

/**
 * Energy for a level walk, from Ludlow & Weyand (2016), J Appl Physiol 120:481–494:
 *   VO2 (ml O2 / kg / min) = VO2rest + 3.85 + 5.97 · V² / Ht      (V in m/s, Ht in m)
 * with VO2rest = 3.5 and about 5 kcal per litre of O2. Height matters: taller people walk a given
 * speed more economically. Returns { total, active } in kcal (active = above resting), or null
 * without weight and height. Treat it as an estimate (±10–15 %), not a measurement.
 */
export function walkingKcal({ distanceM, speedKmh, weightKg, heightCm }) {
  if (!weightKg || !heightCm || !distanceM || !speedKmh) return null;
  const v = speedKmh / 3.6;
  const minutes = distanceM / v / 60;
  const active = 3.85 + (5.97 * v * v) / (heightCm / 100);
  const toKcal = (vo2) => (vo2 * weightKg * minutes / 1000) * 5;
  return { total: toKcal(active + 3.5), active: toKcal(active) };
}
