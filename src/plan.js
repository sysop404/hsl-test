// Building routing requests from settings, and turning API responses into a simpler model.

import { isoMinutes, toOffsetDateTime } from './time.js';
import { MODES } from './settings.js';

export const PLAN_QUERY = `
query Plan($origin: PlanLabeledLocationInput!, $destination: PlanLabeledLocationInput!,
           $dateTime: PlanDateTimeInput, $searchWindow: Duration, $first: Int, $last: Int,
           $after: String, $before: String,
           $modes: PlanModesInput, $preferences: PlanPreferencesInput) {
  planConnection(origin: $origin, destination: $destination, dateTime: $dateTime,
                 searchWindow: $searchWindow, first: $first, last: $last, after: $after, before: $before,
                 modes: $modes, preferences: $preferences) {
    searchDateTime
    routingErrors { code description }
    pageInfo { searchWindowUsed startCursor endCursor hasPreviousPage hasNextPage }
    edges { node {
      start end duration numberOfTransfers walkDistance waitingTime
      legs {
        mode distance duration transitLeg headsign serviceDate realtimeState interlineWithPreviousLeg
        start { scheduledTime estimated { time delay } }
        end { scheduledTime estimated { time delay } }
        from { name lat lon stop { gtfsId code platformCode } }
        to { name lat lon stop { gtfsId code platformCode } }
        route { gtfsId shortName longName mode color }
        trip { gtfsId directionId tripHeadsign departureStoptime { scheduledDeparture } }
        legGeometry { points }
        alerts { alertHeaderText }
        intermediatePlaces {
          name lat lon
          arrival { scheduledTime estimated { time } }
          departure { scheduledTime estimated { time } }
          stop { gtfsId code platformCode }
        }
      }
    } }
  }
}`;

/** Walking-only routes for several origin/destination pairs in one request (aliases w0, w1, ...). */
export function walkQuery(n) {
  const params = [];
  const fields = [];
  for (let i = 0; i < n; i++) {
    params.push(`$o${i}: PlanLabeledLocationInput!, $d${i}: PlanLabeledLocationInput!`);
    fields.push(`w${i}: planConnection(origin: $o${i}, destination: $d${i}, first: 1, preferences: $p,
      modes: { directOnly: true, direct: [WALK] }) { edges { node { duration legs { distance duration legGeometry { points } } } } }`);
  }
  return `query Walks(${params.join(', ')}, $p: PlanPreferencesInput) {\n  ${fields.join('\n  ')}\n}`;
}

export const ROUTES_QUERY = `
query Routes($name: String) { routes(name: $name, feeds: ["HSL"]) { gtfsId shortName } }`;

export const TRIP_TIMES_QUERY = `
query TripTimes($id: String!, $date: String!) {
  trip(id: $id) {
    stoptimesForDate(serviceDate: $date) {
      stop { gtfsId }
      scheduledArrival scheduledDeparture realtimeArrival realtimeDeparture serviceDay realtime
    }
  }
}`;

/** A location the API accepts: a coordinate, or a stop id when we have one. */
export function toLocation(place) {
  if (place.stopId) return { label: place.name, location: { stopLocation: { stopLocationId: place.stopId } } };
  return { label: place.name, location: { coordinate: { latitude: place.lat, longitude: place.lon } } };
}

/**
 * Variables for PLAN_QUERY.
 * opts: { from, to, time (ms), arriveBy, searchWindowMin, first, avoidRouteIds,
 *         after / before (page cursors from an earlier search) }
 */
export function buildPlanVariables(settings, opts) {
  const transfer = { slack: isoMinutes(settings.transferSlackMin) };
  if (settings.maxTransfers !== null) transfer.maximumTransfers = settings.maxTransfers;

  const transit = { transfer };
  if (opts.avoidRouteIds?.length) transit.filters = [{ exclude: [{ routes: opts.avoidRouteIds }] }];

  const preferences = {
    street: { walk: { speed: +(settings.walkSpeedKmh / 3.6).toFixed(3) } },
    transit,
  };
  if (settings.wheelchair) preferences.accessibility = { wheelchair: { enabled: true } };

  const vars = {
    origin: toLocation(opts.from),
    destination: toLocation(opts.to),
    preferences,
  };
  if (opts.before) {
    vars.before = opts.before;
    vars.last = opts.first ?? 6;
  } else {
    vars.first = opts.first ?? 6;
    if (opts.after) vars.after = opts.after;
  }
  if (opts.time !== undefined) {
    const t = toOffsetDateTime(opts.time);
    vars.dateTime = opts.arriveBy ? { latestArrival: t } : { earliestDeparture: t };
  }
  // A cursor already carries its search window.
  if (opts.searchWindowMin && !opts.after && !opts.before) vars.searchWindow = isoMinutes(opts.searchWindowMin);
  const modes = settings.modes.filter((m) => MODES.includes(m));
  if (modes.length && modes.length < MODES.length) {
    vars.modes = { transit: { transit: modes.map((mode) => ({ mode })) } };
  }
  return vars;
}

const timeOf = (lt) => Date.parse(lt?.estimated?.time ?? lt?.scheduledTime);

function place(p) {
  return {
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    stopId: p.stop?.gtfsId ?? null,
    code: p.stop?.code ?? null,
    platform: p.stop?.platformCode ?? null,
  };
}

export function normalizeLeg(l) {
  const transit = !!l.transitLeg;
  return {
    mode: l.mode,
    transit,
    from: place(l.from),
    to: place(l.to),
    start: timeOf(l.start),
    end: timeOf(l.end),
    startScheduled: Date.parse(l.start.scheduledTime),
    endScheduled: Date.parse(l.end.scheduledTime),
    realtime: !!(l.start.estimated || l.end.estimated),
    distance: l.distance ?? 0,
    duration: l.duration ?? 0,
    headsign: l.headsign ?? l.trip?.tripHeadsign ?? '',
    route: l.route ? {
      id: l.route.gtfsId, short: l.route.shortName ?? '', name: l.route.longName ?? '',
      mode: l.route.mode, color: l.route.color ? `#${l.route.color}` : null,
    } : null,
    trip: l.trip ? {
      id: l.trip.gtfsId,
      directionId: l.trip.directionId,
      startSec: l.trip.departureStoptime?.scheduledDeparture ?? null,
    } : null,
    serviceDate: l.serviceDate ?? null,
    interlined: !!l.interlineWithPreviousLeg,
    points: l.legGeometry?.points ?? '',
    alerts: (l.alerts ?? []).map((a) => a.alertHeaderText).filter(Boolean),
    // Stops passed on board, in order (transit legs only).
    stops: (l.intermediatePlaces ?? []).filter((p) => p?.stop).map((p) => ({
      ...place(p),
      arr: timeOf(p.arrival ?? p.departure),
      dep: timeOf(p.departure ?? p.arrival),
      arrScheduled: Date.parse((p.arrival ?? p.departure).scheduledTime),
      depScheduled: Date.parse((p.departure ?? p.arrival).scheduledTime),
    })),
  };
}

export function normalizeItinerary(it) {
  const legs = it.legs.filter(Boolean).map(normalizeLeg);
  const start = legs.length ? legs[0].start : Date.parse(it.start);
  const end = legs.length ? legs[legs.length - 1].end : Date.parse(it.end);
  return {
    key: itineraryKey(legs, start),
    start,
    end,
    duration: Math.round((end - start) / 1000),
    transfers: it.numberOfTransfers ?? 0,
    walkDistance: it.walkDistance ?? 0,
    legs,
  };
}

export function itineraryKey(legs, start) {
  const trips = legs.filter((l) => l.transit).map((l) => l.trip?.id ?? l.route?.short).join('|');
  return trips ? `${trips}@${legs.find((l) => l.transit).start}` : `walk@${start}`;
}

export function normalizePlanResponse(data) {
  const pc = data?.planConnection;
  if (!pc) return { itineraries: [], errors: [], pageInfo: {} };
  return {
    itineraries: (pc.edges ?? []).map((e) => normalizeItinerary(e.node)),
    errors: pc.routingErrors ?? [],
    pageInfo: pc.pageInfo ?? {},
  };
}

/** Client-side safety net for avoided lines (in case the server filter is ignored). */
export function withoutAvoided(itineraries, avoidLines) {
  if (!avoidLines.length) return itineraries;
  const avoid = new Set(avoidLines);
  return itineraries.filter((it) => !it.legs.some((l) => l.route && avoid.has(l.route.short.toUpperCase())));
}

/** Smallest gap between arriving and the next departure, per transfer, in seconds. */
export function transferGaps(itinerary) {
  const gaps = [];
  const legs = itinerary.legs;
  for (let i = 0; i < legs.length; i++) {
    if (!legs[i].transit) continue;
    const next = legs.slice(i + 1).findIndex((l) => l.transit);
    if (next < 0) break;
    const j = i + 1 + next;
    if (legs[j].interlined) continue;
    const walk = legs.slice(i + 1, j).reduce((s, l) => s + (l.end - l.start), 0);
    gaps.push({
      at: legs[i].to.name,
      fromLeg: i,
      toLeg: j,
      seconds: Math.round((legs[j].start - legs[i].end - walk) / 1000),
      walkSeconds: Math.round(walk / 1000),
    });
  }
  return gaps;
}
