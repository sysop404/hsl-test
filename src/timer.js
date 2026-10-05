// Arrival timer: where am I in the trip, and what am I counting down to?

import { transferGaps } from './plan.js';

/**
 * phase: 'before' (not left yet), 'walk' (walking to a stop), 'wait' (at the stop),
 *        'ride' (on board), 'done'.
 * target: the instant the main countdown runs to.
 */
export function tripPhase(itinerary, now) {
  const legs = itinerary.legs;
  if (!legs.length) return { phase: 'done' };
  if (now >= itinerary.end) return { phase: 'done', target: itinerary.end };

  const nextTransitFrom = (i) => {
    for (let j = i; j < legs.length; j++) if (legs[j].transit) return j;
    return -1;
  };

  if (now < legs[0].start) {
    const t = nextTransitFrom(0);
    return {
      phase: 'before',
      target: legs[0].start,
      label: 'Leave in',
      legIndex: 0,
      nextTransit: t,
    };
  }

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const nextStart = i + 1 < legs.length ? legs[i + 1].start : itinerary.end;
    const inLeg = now >= leg.start && now < leg.end;
    const inGap = now >= leg.end && now < nextStart;
    if (!inLeg && !inGap) continue;

    if (leg.transit && inLeg) {
      const t = nextTransitFrom(i + 1);
      const gap = t >= 0 ? transferGaps(itinerary).find((g) => g.toLeg === t) : null;
      return {
        phase: 'ride',
        target: leg.end,
        label: `Arrive at ${leg.to.name} in`,
        legIndex: i,
        nextTransit: t,
        transferSlackSec: gap ? gap.seconds : null,
        finalArrival: itinerary.end,
      };
    }
    // Walking, or waiting between legs: count down to the next vehicle.
    const t = nextTransitFrom(i + 1);
    if (t < 0) {
      return { phase: 'walk', target: itinerary.end, label: 'Arrive in', legIndex: i, nextTransit: -1 };
    }
    const walkingNow = !leg.transit && inLeg;
    return {
      phase: walkingNow ? 'walk' : 'wait',
      target: legs[t].start,
      label: `${legs[t].route?.short ?? 'Departure'} leaves in`,
      legIndex: i,
      nextTransit: t,
      walkLeftSec: walkingNow ? Math.round((leg.end - now) / 1000) : 0,
    };
  }
  return { phase: 'done', target: itinerary.end };
}

/**
 * Apply live stop times (from the trip-times query) to a leg's start/end.
 * times: [{ stopId, arr, dep }] in trip order.
 */
export function applyLiveTimes(leg, times) {
  const di = times.findIndex((s) => s.stopId === leg.from.stopId);
  if (di < 0) return leg;
  const ai = times.findIndex((s, k) => k > di && s.stopId === leg.to.stopId);
  return {
    ...leg,
    start: times[di].dep,
    end: ai >= 0 ? times[ai].arr : leg.end,
    realtime: times[di].realtime || leg.realtime,
  };
}

/** Rebuild an itinerary with updated legs, shifting walk legs to stay consistent. */
export function withLegs(itinerary, legs) {
  const fixed = legs.map((l) => ({ ...l }));
  // A walk leg ending at a transit leg keeps its duration and starts earlier/later as needed only
  // if it hasn't started; simplest consistent model: walk after a transit leg starts when it ends.
  for (let i = 1; i < fixed.length; i++) {
    const prev = fixed[i - 1];
    const l = fixed[i];
    if (!l.transit && prev.transit) {
      const dur = l.end - l.start;
      l.start = prev.end;
      l.end = prev.end + dur;
    }
  }
  return { ...itinerary, legs: fixed, start: fixed[0].start, end: fixed[fixed.length - 1].end, duration: Math.round((fixed[fixed.length - 1].end - fixed[0].start) / 1000) };
}

/**
 * The trip as it stands now: the itinerary as started (base) with live transit legs applied
 * (updated: Map legIndex -> leg). Walks after a vehicle move with it. The walk from the origin keeps
 * its planned leave time when the first vehicle is late (the delay becomes spare time at the stop),
 * but moves earlier when the vehicle is early, so the countdown never makes you miss it.
 */
export function liveItinerary(base, updated) {
  const it = withLegs(base, base.legs.map((l, i) => updated.get(i) ?? l));
  const first = it.legs.findIndex((l) => l.transit);
  if (first > 0) {
    const early = it.legs[first - 1].end - it.legs[first].start;
    if (early > 0) {
      for (let i = 0; i < first; i++) {
        it.legs[i] = { ...it.legs[i], start: it.legs[i].start - early, end: it.legs[i].end - early };
      }
      it.start = it.legs[0].start;
      it.duration = Math.round((it.end - it.start) / 1000);
    }
  }
  return it;
}

/**
 * What changed since the trip was started, for the banner.
 *   late / early: an upcoming departure moved by a minute or more (deltaSec vs the plan you started
 *                 with, delaySec vs the timetable). first = it's the first vehicle, so for 'early'
 *                 the leave time moved too (leaveWas -> leaveNow).
 *   tight / missed: a transfer now has less than slackSec, or less than nothing.
 *   arrival: the arrival time moved by a minute or more.
 */
export function tripNotices(base, live, now, slackSec) {
  const out = [];
  const firstTransit = live.legs.findIndex((l) => l.transit);
  live.legs.forEach((l, i) => {
    if (!l.transit || l.start <= now) return;
    const delta = l.start - base.legs[i].start;
    if (Math.abs(delta) < 60_000) return;
    out.push({
      kind: delta > 0 ? 'late' : 'early',
      legIndex: i,
      first: i === firstTransit,
      deltaSec: Math.round(delta / 1000),
      delaySec: Math.round((l.start - l.startScheduled) / 1000),
      was: base.legs[i].start,
      now: l.start,
      leaveWas: base.legs[0].start,
      leaveNow: live.legs[0].start,
    });
  });
  for (const g of transferGaps(live)) {
    if (live.legs[g.toLeg].start <= now || g.seconds >= slackSec) continue;
    out.push({ kind: g.seconds < 0 ? 'missed' : 'tight', fromLeg: g.fromLeg, toLeg: g.toLeg, at: g.at, seconds: g.seconds });
  }
  if (Math.abs(live.end - base.end) >= 60_000) {
    out.push({ kind: 'arrival', was: base.end, now: live.end, deltaSec: Math.round((live.end - base.end) / 1000) });
  }
  return out;
}
