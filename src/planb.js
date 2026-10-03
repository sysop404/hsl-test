// Plan B: if you miss a transit leg, what's the best way on from that stop?

/**
 * Finds the best alternative from the boarding stop of itinerary.legs[legIndex],
 * leaving just after the missed departure. plan(opts) returns { itineraries }.
 * Returns { itinerary, delaySec } or null.
 */
export async function planB({ plan, itinerary, legIndex, to }) {
  const leg = itinerary.legs[legIndex];
  if (!leg?.transit) return null;
  const from = { name: leg.from.name, lat: leg.from.lat, lon: leg.from.lon, stopId: leg.from.stopId };
  const r = await plan({ from, to, time: leg.start + 60_000, first: 4 });
  return pickAlternative(r.itineraries, leg, itinerary.end);
}

/** First alternative that doesn't board the missed vehicle, earliest arrival first. */
export function pickAlternative(itineraries, missedLeg, originalEnd) {
  const candidates = itineraries
    .filter((it) => {
      const first = it.legs.find((l) => l.transit);
      if (!first) return true;
      if (missedLeg.trip?.id && first.trip?.id === missedLeg.trip.id) return false;
      return first.start > missedLeg.start;
    })
    .sort((a, b) => a.end - b.end);
  const best = candidates[0];
  if (!best) return null;
  return { itinerary: best, delaySec: Math.round((best.end - originalEnd) / 1000) };
}
